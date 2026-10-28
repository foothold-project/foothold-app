"""Optional pinned geometry library path, enabled only in the isolated child."""
import importlib.util
import os
from pathlib import Path
import stat
import sys

VENDOR = Path('/opt/foothold-sim/python-vendor')


def enable():
    value = os.environ.get('FH_SIM_NATIVE_PYTHON_DIR')
    if value is None:
        return
    if Path(value) != VENDOR:
        raise ValueError('unapproved native Python vendor path')
    for path in (VENDOR, *VENDOR.parents):
        info = path.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('native Python vendor path must be root-owned read-only')
    metadata = VENDOR / 'trimesh-5.1.0.dist-info/METADATA'
    info = metadata.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise ValueError('native Python vendor metadata untrusted')
    if '\nVersion: 5.1.0\n' not in metadata.read_text():
        raise ValueError('native trimesh version differs from plan')
    if 'trimesh' in sys.modules:
        raise ValueError('native vendor must be selected before trimesh import')
    sys.path.insert(0, str(VENDOR))
    found = importlib.util.find_spec('trimesh')
    if found is None or not Path(found.origin).is_relative_to(VENDOR):
        raise ValueError('native trimesh origin unproven')
