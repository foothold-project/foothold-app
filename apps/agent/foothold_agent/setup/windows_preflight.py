"""Read pinned Windows wheel/PE metadata without importing SDK/DDS or loading DLLs."""
import hashlib
import importlib.metadata as metadata
import json
import os
from pathlib import Path
import platform
import struct
import sys
import zipfile

SDK_COMMIT = '814556d15970dd2ecf1c9984e845ca02ab07e206'
DDS_WHEEL = 'cyclonedds-0.10.2-cp310-cp310-win_amd64.whl'
# Reviewed PyPI 0.10.2 cp310 Windows x64 wheel, same SDK pin as Linux.
DDS_SHA256 = 'a5be989f69103954c6041b80e3ea1ae9973d41b1b0e437fb71b671417c450ad6'
PINNED = {'foothold-agent':'0.2.0', 'unitree-sdk2py':'1.0.1', 'cyclonedds':'0.10.2',
          'numpy':'1.26.4', 'opencv-python':'4.10.0.84', 'websockets':'15.0.1', 'zeroconf':'0.148.0'}


def pe_amd64(data):
    try:
        offset = struct.unpack_from('<I',data,60)[0]
        return (data[:2] == b'MZ' and data[offset:offset+4] == b'PE\0\0'
                and struct.unpack_from('<H',data,offset+4)[0] == 0x8664
                and struct.unpack_from('<H',data,offset+24)[0] == 0x20b)
    except (struct.error, ValueError):
        return False


def verified_dds(wheel_dir):
    wheel = Path(wheel_dir)/DDS_WHEEL
    if not wheel.is_file() or hashlib.sha256(wheel.read_bytes()).hexdigest() != DDS_SHA256:
        return False
    try:
        dist = metadata.distribution('cyclonedds')
        with zipfile.ZipFile(wheel) as archive:
            native = [n for n in archive.namelist() if n.endswith(('.pyd','.dll'))]
            if not native or 'cyclonedds/.libs/ddsc.dll' not in native:
                return False
            return all(pe_amd64(archive.read(n)) and
                       Path(dist.locate_file(n)).read_bytes() == archive.read(n) for n in native)
    except (metadata.PackageNotFoundError, OSError, zipfile.BadZipFile):
        return False


def inspect(wheel_dir):
    packages = {}
    for name in PINNED:
        try:
            packages[name] = metadata.version(name)
        except metadata.PackageNotFoundError:
            packages[name] = None
    try:
        source = json.loads(metadata.distribution('unitree-sdk2py').read_text('direct_url.json') or '{}')
        commit = source.get('vcs_info',{}).get('commit_id')
    except (metadata.PackageNotFoundError, ValueError):
        commit = None
    issues = []
    verified = verified_dds(wheel_dir)
    if platform.system() != 'Windows' or platform.machine().lower() not in ('amd64','x86_64') or sys.version_info[:2] != (3,10):
        issues.append('requires-windows-amd64-cpython-3.10-official-wheel')
    if packages != PINNED:
        issues.append('package-pin-mismatch')
    if commit != SDK_COMMIT:
        issues.append('sdk-source-commit-unverified')
    if not verified:
        issues.append('official-wheel-or-bundled-pe-unverified')
    if any(os.environ.get(k) for k in ('CYCLONEDDS_URI','CYCLONEDDS_HOME','LD_LIBRARY_PATH')):
        issues.append('inherited-dds-loader-override')
    return dict(installation_ready=not issues,issues=issues,packages=packages,
                sdk_commit_verified=commit == SDK_COMMIT,dds_wheel_sha256=DDS_SHA256,
                wheel_hash_verified=verified,bundled_x86_ddsc=verified,sdk_imported=False,
                robot_connected=False,motion_enabled=False,field_nic_serial_approval_verified=False)
