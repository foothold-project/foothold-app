"""Local synthetic benchmark; does not connect to hardware or services.

Run from repo root: PYTHONPATH=apps/agent python apps/agent/tools/benchmark_lidar_edges.py
"""
import argparse
import json
import platform
import time

import numpy as np

from foothold_agent.media.edges import edge_bytes, MAX_EDGE_POINTS, EDGE_BUDGET_SECONDS


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--iterations', type=int, default=100)
    args = parser.parse_args()
    if args.iterations < 1:
        parser.error('iterations must be positive')
    rng = np.random.default_rng(42)
    # Dense folds and sparse scans with one occupied cell per return.
    room = np.concatenate((
        np.column_stack((rng.uniform(-2, 2, (2000, 2)), np.zeros(2000))),
        np.column_stack((np.full(2000, 2.), rng.uniform(-2, 2, 2000), rng.uniform(0, 2, 2000))),
    )).astype('<f4')
    sparse = rng.uniform(-20, 20, (MAX_EDGE_POINTS, 3)).astype('<f4')
    results = {}
    for name, xyz in (('floor_wall_4000', room), ('sparse_4000', sparse)):
        payload = xyz.tobytes()
        edge_bytes(payload)  # numpy already loaded; warm-up excluded
        elapsed, skipped = [], 0
        for _ in range(args.iterations):
            start = time.perf_counter()
            skipped += edge_bytes(payload) is None
            elapsed.append((time.perf_counter()-start)*1000)
        results[name] = dict(points=len(xyz), iterations=args.iterations, skipped=skipped,
                             p50_ms=float(np.percentile(elapsed, 50)),
                             p95_ms=float(np.percentile(elapsed, 95)), max_ms=max(elapsed))
    print(json.dumps(dict(python=platform.python_version(), architecture=platform.machine(),
                         numpy=np.__version__, budget_ms=EDGE_BUDGET_SECONDS*1000,
                         max_points=MAX_EDGE_POINTS, results=results), indent=2))


if __name__ == '__main__':
    main()
