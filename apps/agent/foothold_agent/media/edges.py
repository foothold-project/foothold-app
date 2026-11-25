"""Optional, bounded local surface variation on the transmitted scan only."""
import base64
from itertools import product
import os
import time

MAX_EDGE_POINTS = 4000
EDGE_BUDGET_SECONDS = .030
CELL_METRES = .2
MIN_NEIGHBORS = 8
CURVATURE_THRESHOLD = .02
# Coordinates are bounded to +/-10 km: 100,001 cells per axis at 20 cm.
# Padding prevents +/-1 neighbor lookup from wrapping into another axis.
_STRIDE = 100_005
_OFFSETS = tuple(x * _STRIDE**2 + y * _STRIDE + z
                 for x, y, z in product((-1, 0, 1), repeat=3))


def enabled(env=None):
    return (os.environ if env is None else env).get('FH_LIDAR_EDGE_ENABLED', '0') == '1'


def edge_bytes(payload, *, now=time.perf_counter):
    """One uint8 per XYZ, or None when unavailable/over budget.

    Sum cell moments over 27 adjacent 20 cm cells, then use the smallest
    covariance eigenvalue / trace. Flat surfaces have zero variation; two
    intersecting faces have volume near their seam. No all-pairs search, scan
    ordering assumption, plane fitting loop, or persistent map is needed.
    """
    if len(payload) % 12 or not 0 < len(payload) // 12 <= MAX_EDGE_POINTS:
        return None
    # Optional installations without numpy keep their old lidar path. The
    # one-time import is outside the per-scan compute budget and off by default.
    try:
        import numpy as np
    except ImportError:
        return None
    start = now()
    xyz = np.frombuffer(payload, dtype='<f4').reshape(-1, 3).astype(np.float64)
    if not np.isfinite(xyz).all() or (np.abs(xyz) > 10000).any():
        return None
    cells = np.floor(xyz / CELL_METRES).astype(np.int64) + 50_001
    keys = cells @ np.array((_STRIDE**2, _STRIDE, 1), dtype=np.int64)
    unique, inverse = np.unique(keys, return_inverse=True)
    # Center first to keep moment subtraction accurate even far from origin.
    xyz -= xyz[0]
    x, y, z = xyz.T
    terms = (np.ones(len(x)), x, y, z, x*x, x*y, x*z, y*y, y*z, z*z)
    moments = np.stack([np.bincount(inverse, weights=v, minlength=len(unique))
                        for v in terms], axis=1)
    totals = np.zeros_like(moments)
    for offset in _OFFSETS:
        if now() - start > EDGE_BUDGET_SECONDS:
            return None
        neighbor = unique + offset
        at = np.searchsorted(unique, neighbor)
        valid = at < len(unique)
        at = np.minimum(at, len(unique)-1)
        valid &= unique[at] == neighbor
        totals[valid] += moments[at[valid]]
    count = totals[:, 0]
    mean = totals[:, 1:4] / count[:, None]
    covariance = np.empty((len(unique), 3, 3))
    for column, (i, j) in enumerate(((0, 0), (0, 1), (0, 2), (1, 1), (1, 2), (2, 2)), 4):
        covariance[:, i, j] = covariance[:, j, i] = totals[:, column]/count - mean[:, i]*mean[:, j]
    eigen = np.maximum(np.linalg.eigvalsh(covariance), 0)
    trace = eigen.sum(axis=1)
    curved = ((count >= MIN_NEIGHBORS) & (eigen[:, 1] > .0001)
              & (eigen[:, 0] > CURVATURE_THRESHOLD * trace))
    result = (curved[inverse].astype(np.uint8) * 255).tobytes()
    return result if now() - start <= EDGE_BUDGET_SECONDS else None


def annotate(header, payload, *, edge_enabled=None):
    active = enabled() if edge_enabled is None else edge_enabled
    if active:
        try:
            values = edge_bytes(payload)
        except (ValueError, ArithmeticError, MemoryError):
            values = None  # optional display work must not suppress the scan
        if values is not None:
            header['edge_u8'] = base64.b64encode(values).decode('ascii')
    return header, payload
