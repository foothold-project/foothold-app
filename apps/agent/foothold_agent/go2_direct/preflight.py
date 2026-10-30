"""x86 trial metadata only: never import SDK/DDS or open a robot socket."""
import importlib.metadata as metadata
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sys

SDK_COMMIT = '814556d15970dd2ecf1c9984e845ca02ab07e206'
DDS_WHEEL = 'cyclonedds-0.10.2-cp310-cp310-manylinux_2_17_x86_64.manylinux2014_x86_64.whl'
DDS_SHA256 = '1194b03377e7644c7fb7230dd19b85eb363699d179459bdc5486974ec8d0fc0e'
PINNED = {'foothold-agent':'0.2.0', 'unitree-sdk2py':'1.0.1', 'cyclonedds':'0.10.2',
          'numpy':'1.26.4', 'opencv-python':'4.10.0.84', 'websockets':'15.0.1', 'zeroconf':'0.148.0'}


def inspect(wheel_dir):
    packages = {}
    for name in PINNED:
        try:
            packages[name] = metadata.version(name)
        except metadata.PackageNotFoundError:
            packages[name] = None
    try:
        source = json.loads(metadata.distribution('unitree-sdk2py').read_text('direct_url.json') or '{}')
        commit = source.get('vcs_info', {}).get('commit_id')
    except metadata.PackageNotFoundError:
        commit = None
    wheel = Path(wheel_dir)/DDS_WHEEL
    wheel_verified = wheel.is_file() and hashlib.sha256(wheel.read_bytes()).hexdigest() == DDS_SHA256
    try:
        dist = metadata.distribution('cyclonedds')
        files = [dist.locate_file(p) for p in dist.files or [] if '.so' in Path(p).name]
        elf = [subprocess.run(['readelf', '-h', str(p)], check=True, capture_output=True,
                             text=True, timeout=3).stdout for p in files]
        dds_elf = bool(elf) and all('X86-64' in text for text in elf)
        bundled_ddsc = any('libddsc' in p.name for p in files)
    except (metadata.PackageNotFoundError, OSError, subprocess.SubprocessError):
        dds_elf = bundled_ddsc = False
    issues = []
    if platform.machine() != 'x86_64' or sys.version_info[:2] != (3,10):
        issues.append('requires-x86_64-cpython-3.10-official-wheel')
    if packages != PINNED:
        issues.append('package-pin-mismatch')
    if commit != SDK_COMMIT:
        issues.append('sdk-source-commit-unverified')
    if not wheel_verified:
        issues.append('official-wheel-hash-unverified')
    if not dds_elf or not bundled_ddsc:
        issues.append('dds-bundled-elf-metadata-unverified')
    if any(os.environ.get(k) for k in ('CYCLONEDDS_URI','CYCLONEDDS_HOME','LD_LIBRARY_PATH')):
        issues.append('inherited-dds-loader-override')
    return dict(installation_ready=not issues, issues=issues, packages=packages,
        sdk_commit_verified=commit == SDK_COMMIT, dds_wheel_sha256=DDS_SHA256,
        wheel_hash_verified=wheel_verified, bundled_x86_ddsc=bundled_ddsc and dds_elf,
        sdk_imported=False, robot_connected=False, motion_enabled=False,
        field_nic_serial_approval_verified=False)


def main(argv=None):
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--wheel-dir', default='runs/go2-x86-artifacts')
    args = parser.parse_args(argv)
    report = inspect(args.wheel_dir)
    print(json.dumps(report, indent=2))
    return 0 if report['installation_ready'] else 2


if __name__ == '__main__':
    raise SystemExit(main())
