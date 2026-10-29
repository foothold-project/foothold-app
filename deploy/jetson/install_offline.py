#!/usr/bin/env python3
"""Plan by default; explicit --install installs an offline, private venv only."""
import argparse
import hashlib
import os
from pathlib import Path
import subprocess
import sys

REQUIRED = {'foothold-agent': '0.2.0', 'unitree-sdk2py': '1.0.1',
            'cyclonedds': '0.10.2', 'numpy': '1.26.4',
            'opencv-python': '4.10.0.84', 'zeroconf': '0.148.0', 'websockets': '15.0.1'}


def checked_inputs(directory):
    """Verify every file referenced by pip, with no symlinks or unlisted wheels."""
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError('real wheelhouse directory required')
    manifest = directory/'SHA256SUMS'
    requirements = directory/'requirements.txt'
    if manifest.is_symlink() or requirements.is_symlink():
        raise ValueError('symlinked manifest or requirements')
    entries = {}
    for line in manifest.read_text().splitlines():
        digest, name = line.split(maxsplit=1)
        name = name.lstrip('*')
        if (len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest) or
                '/' in name or '\\' in name or name in ('.','..') or name in entries):
            raise ValueError('invalid checksum manifest')
        p = directory/name
        if p.is_symlink() or not p.is_file() or hashlib.sha256(p.read_bytes()).hexdigest() != digest:
            raise ValueError('wheelhouse checksum mismatch')
        entries[name] = digest
    if 'requirements.txt' not in entries or not list(directory.glob('*.whl')):
        raise ValueError('hashed locked requirements and wheels required')
    if any(p.name not in entries for p in directory.glob('*.whl')):
        raise ValueError('unlisted wheel')
    # Locked distribution pins only. URLs, editable packages, nested requirement
    # files and pip options would escape this local offline installation boundary.
    import re
    lines = requirements.read_text().splitlines()
    pins = {}
    for line in lines:
        match = re.fullmatch(r'([A-Za-z0-9_.-]+)==([A-Za-z0-9_.+!-]+) --hash=sha256:([0-9a-f]{64})', line)
        if not match:
            raise ValueError('requirements must contain only hashed exact pins')
        name = re.sub(r'[-_.]+', '-', match[1]).lower()
        if name in pins or match[3] not in {v for k, v in entries.items() if k.endswith('.whl')}:
            raise ValueError('duplicate pin or missing wheel hash')
        pins[name] = match[2]
    if any(pins.get(name) != pin for name, pin in REQUIRED.items()):
        raise ValueError('missing or different required package pins')
    return requirements


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--wheelhouse', type=Path, required=True)
    parser.add_argument('--dest', type=Path, required=True)
    parser.add_argument('--install', action='store_true')
    args = parser.parse_args(argv)
    try:
        if sys.version_info < (3, 10):
            raise ValueError('run with dedicated Python >=3.10; do not replace JetPack Python')
        if args.dest.exists() or args.dest.is_symlink():
            raise ValueError('destination must not already exist')
        dest = args.dest.resolve()
        wheelhouse = args.wheelhouse.absolute()
        requirements = checked_inputs(wheelhouse)
        print('Offline venv only; SDK connection, service enable/start and robot commands: NONE')
        if not args.install:
            print('Plan verified. Re-run with --install after target ABI/wheels are reviewed.')
            return 0
        # Python -I does not isolate pip's own configuration. Disable all config
        # files and remove every inherited PIP_* option for ALL child processes.
        child_env = {key: value for key, value in os.environ.items()
                     if not key.upper().startswith('PIP_')}
        child_env['PIP_CONFIG_FILE'] = os.devnull
        subprocess.run([sys.executable, '-I', '-m', 'venv', str(dest)],
                       check=True, env=child_env)
        python = dest/'bin/python'
        subprocess.run([str(python), '-I', '-m', 'pip', 'install', '--no-index', '--require-hashes',
                        '--no-user', '--prefix', str(dest), '--only-binary=:all:',
                        '--find-links', str(wheelhouse), '-r', str(requirements)],
                       check=True, env=child_env)
        subprocess.run([str(python), '-I', '-m', 'pip', 'check'], check=True, env=child_env)
        print('Installed only. No process/service started; Go2 motion remains disabled.')
        return 0
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print('Preparation failed: '+type(error).__name__, file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
