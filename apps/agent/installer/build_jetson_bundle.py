#!/usr/bin/env python3
"""Produce one offline ARM64/cp310 archive; never install or load DDS here."""
import argparse
from email.parser import BytesParser
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import urllib.request
import zipfile

from jetson_bundle_common import checked_bundle, digest, provenance

REPO = Path(__file__).resolve().parents[3]
INSTALL_SH = '''#!/bin/sh
set -eu
: "${HOME:?HOME must be set}"
cd -- "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
if ! /usr/bin/python3 -I -c 'import sys; sys.exit(0 if sys.version_info[:2] == (3, 10) else 1)'; then
    printf '%s\\n' '설치 중단: /usr/bin/python3의 판이 3.10이어야 합니다. 시스템 Python을 바꾸지 말고 담당자에게 확인하세요.' >&2
    exit 2
fi
exec /usr/bin/python3 -I apps/agent/installer/install_jetson_bundle.py "$@"
'''


def download(url, target, expected):
    if not url.startswith(('https://files.pythonhosted.org/', 'https://codeload.github.com/')):
        raise ValueError('official HTTPS source required')
    with urllib.request.urlopen(url, timeout=60) as source, target.open('xb') as output:
        while block := source.read(1024 * 1024):
            output.write(block)
    if digest(target) != expected:
        raise ValueError('upstream input SHA256 mismatch')


def audit_wheels(wheels, lock, scratch):
    """Check cp310 target dependency closure and ELF, without loading a .so."""
    from pip._vendor.packaging.markers import default_environment
    from pip._vendor.packaging.requirements import Requirement
    from pip._vendor.packaging.utils import canonicalize_name
    from pip._vendor.packaging.version import Version
    env = default_environment()
    env.update(python_version='3.10', python_full_version='3.10.12',
        implementation_version='3.10.12', platform_machine='aarch64',
        platform_system='Linux', sys_platform='linux', os_name='posix', extra='')
    versions = {canonicalize_name(r['name']): r['version'] for r in lock['wheels']}
    requirements = [Requirement('rich-click')]  # CycloneDDS source runtime dependency
    audit = []
    for row in lock['wheels']:
        with zipfile.ZipFile(wheels/row['filename']) as wheel:
            records = [n for n in wheel.namelist() if n.count('/') == 1 and n.endswith('.dist-info/METADATA')]
            if len(records) != 1:
                raise ValueError('invalid wheel metadata')
            fields = BytesParser().parsebytes(wheel.read(records[0]))
            if (canonicalize_name(fields['Name']) != canonicalize_name(row['name'])
                    or fields['Version'] != row['version']):
                raise ValueError('wheel identity differs from lock')
            if fields['Requires-Python']:
                from pip._vendor.packaging.specifiers import SpecifierSet
                if Version('3.10.12') not in SpecifierSet(fields['Requires-Python']):
                    raise ValueError('wheel requires another Python')
            requirements.extend(Requirement(r) for r in fields.get_all('Requires-Dist', []))
            for name in wheel.namelist():
                if '.so' not in Path(name).name:
                    continue
                scratch.write_bytes(wheel.read(name))
                report = subprocess.check_output(['readelf', '-h', '-d', '--version-info', str(scratch)], text=True)
                if 'AArch64' not in report:
                    raise ValueError('native wheel is not AArch64')
                audit.append(dict(wheel=row['filename'], member=name, elf=report))
    for req in requirements:
        if req.marker and not req.marker.evaluate(env):
            continue
        name = canonicalize_name(req.name)
        if req.url or req.extras or name not in versions or Version(versions[name]) not in req.specifier:
            raise ValueError('incomplete cp310 dependency lock: '+str(req))
    scratch.unlink(missing_ok=True)
    return audit


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True, help='new ignored directory under runs/')
    parser.add_argument('--build', action='store_true')
    args = parser.parse_args(argv)
    try:
        output = args.output.absolute()
        if output != output.resolve() or not output.is_relative_to(REPO/'runs') or output.exists():
            raise ValueError('new real directory under this checkout runs/ required')
        if not args.build:
            print('Plan: pinned official ARM64/cp310 wheels + three pinned DDS/SDK sources + tracked agent source; no install.')
            return 0
        if subprocess.check_output(['git', 'status', '--porcelain', '--', 'apps/agent'], cwd=REPO):
            raise ValueError('commit agent changes before creating the source bundle')
        commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=REPO, text=True).strip()
        os.umask(0o077)
        output.mkdir(parents=True, mode=0o700)
        (output/'INCOMPLETE').write_text('Preparation not complete.\n')
        bundle = output/'foothold-jetson'
        bundle.mkdir()
        with (output/'agent.tar').open('wb') as target:
            subprocess.run(['git', 'archive', 'HEAD', 'apps/agent'], cwd=REPO, stdout=target, check=True)
        # git archive contains tracked regular agent source; reuse safe extraction.
        with tarfile.open(output/'agent.tar') as source:
            members = source.getmembers()
            if any(m.issym() or m.islnk() or not (m.isfile() or m.isdir())
                   or Path(m.name).is_absolute() or '..' in Path(m.name).parts for m in members):
                raise ValueError('unsafe agent source')
            source.extractall(bundle, members=members)
        for name in ('wheels', 'sources'):
            (bundle/name).mkdir()
        agent = bundle/'apps/agent'
        arm = provenance(agent)
        lock = json.loads((agent/'installer/jetson-wheels.lock.json').read_text())
        for row in lock['wheels']:
            download(row['url'], bundle/'wheels'/row['filename'], row['sha256'])
        for name, row in arm.SOURCES.items():
            download(row['url'], bundle/'sources'/name, row['sha256'])
        audit = audit_wheels(bundle/'wheels', lock, output/'elf-audit.so')
        (bundle/'PROVENANCE.json').write_text(json.dumps(dict(agent_commit=commit,
            agent_source_sha256=digest(output/'agent.tar'), sources=arm.SOURCES,
            target='Linux aarch64 CPython 3.10', native_wheel_audit=audit,
            jetson_built=False, installed=False, robot_connected=False), indent=2)+'\n')
        (bundle/'install.sh').write_text(INSTALL_SH)
        (bundle/'install.sh').chmod(0o700)
        (bundle/'SHA256SUMS').write_text(''.join(
            f'{digest(p)}  {p.relative_to(bundle)}\n'
            for p in sorted(bundle.rglob('*')) if p.is_file()))
        checked_bundle(bundle)
        archive = output/'foothold-jetson-aarch64-cp310.tar.gz'
        with tarfile.open(archive, 'w:gz') as target:
            target.add(bundle, arcname=bundle.name)
        checksum = digest(archive)
        (output/(archive.name+'.sha256')).write_text(f'{checksum}  {archive.name}\n')
        (output/'INCOMPLETE').unlink()
        print(json.dumps(dict(file=str(archive), bytes=archive.stat().st_size, sha256=checksum,
                              jetson_build_verified=False)))
        return 0
    except (ValueError, OSError, subprocess.SubprocessError, tarfile.TarError, zipfile.BadZipFile) as error:
        print('Bundle failed: '+str(error)+'; partial output is not installable.', file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
