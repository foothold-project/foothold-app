#!/usr/bin/env python3
"""Prepare only: download ARM64 wheels and build two pure Python source wheels.

Never installs a package, imports the SDK, or contacts a robot. All build/cache
output stays under a new runs/ directory. Requires existing setuptools + wheel.
"""
import argparse
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import urllib.request
import zipfile
from email.parser import BytesParser

SDK_COMMIT = '814556d15970dd2ecf1c9984e845ca02ab07e206'
PINS = ['cyclonedds==0.10.2', 'numpy==1.26.4', 'opencv-python==4.10.0.84',
        'zeroconf==0.148.0', 'websockets==15.0.1']
ROOT = Path(__file__).resolve().parents[2]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def clean_env(output):
    env = {k: v for k, v in os.environ.items()
           if not k.upper().startswith(('PIP_', 'PYTHON'))}
    env.update(PIP_CONFIG_FILE=os.devnull, PIP_CACHE_DIR=str(output/'cache'),
               TMPDIR=str(output/'tmp'))
    return env


def run(argv, *, cwd, env):
    # Keep resolver/build diagnostics in the private bundle, not terminal output.
    with (Path(env['TMPDIR']).parent/'build.log').open('ab') as log:
        subprocess.run(argv, cwd=cwd, env=env, stdout=log, stderr=log, check=True)


def unpack_source(archive, dest):
    with tarfile.open(archive) as source:
        members = source.getmembers()
        if any(m.issym() or m.islnk() or not (m.isfile() or m.isdir())
               or Path(m.name).is_absolute() or '..' in Path(m.name).parts for m in members):
            raise ValueError('unsafe SDK source archive')
        source.extractall(dest, members=members, filter='data')
    roots = list(dest.iterdir())
    if len(roots) != 1 or not roots[0].is_dir():
        raise ValueError('unexpected SDK source layout')
    return roots[0]


def lock_wheels(wheels):
    pins = {}
    native = []
    for path in sorted(wheels.glob('*.whl')):
        with zipfile.ZipFile(path) as wheel:
            metadata = [n for n in wheel.namelist() if n.endswith('.dist-info/METADATA')]
            if len(metadata) != 1:
                raise ValueError('invalid wheel metadata')
            fields = BytesParser().parsebytes(wheel.read(metadata[0]))
            name, version = fields['Name'], fields['Version']
            canonical = re.sub(r'[-_.]+', '-', name or '').lower()
            if not name or not version or canonical in pins:
                raise ValueError('duplicate or missing package identity')
            pins[canonical] = f'{name}=={version} --hash=sha256:{digest(path)}'
            for item in wheel.namelist():
                if '.so' in Path(item).name:
                    native.append({'wheel': path.name, 'member': item})
    (wheels/'requirements.txt').write_text('\n'.join(pins[k] for k in sorted(pins))+'\n')
    return native


def target_dependencies(wheels, python_version):
    """pip cross-download does not consistently evaluate host markers as target.

    Audit wheel METADATA against Linux/aarch64/target Python explicitly, then
    fetch any conditional dependency omitted by the preparing PC's interpreter.
    """
    from pip._vendor.packaging.markers import default_environment
    from pip._vendor.packaging.requirements import Requirement
    environment = default_environment()
    environment.update(python_version=python_version, python_full_version=python_version+'.0',
        implementation_version=python_version+'.0', platform_machine='aarch64',
        platform_system='Linux', sys_platform='linux', os_name='posix', extra='')
    versions, requirements = {}, []
    for path in wheels.glob('*.whl'):
        with zipfile.ZipFile(path) as wheel:
            metadata = next(n for n in wheel.namelist() if n.endswith('.dist-info/METADATA'))
            fields = BytesParser().parsebytes(wheel.read(metadata))
            name = re.sub(r'[-_.]+', '-', fields['Name']).lower()
            versions[name] = fields['Version']
            requirements.extend(Requirement(r) for r in fields.get_all('Requires-Dist', []))
    missing = []
    for requirement in requirements:
        if requirement.marker and not requirement.marker.evaluate(environment):
            continue
        name = re.sub(r'[-_.]+', '-', requirement.name).lower()
        if requirement.url or requirement.extras:
            raise ValueError('review runtime URL/extra dependency before bundling')
        if name not in versions or not requirement.specifier.contains(versions[name]):
            missing.append(requirement.name+str(requirement.specifier))
    return sorted(set(missing))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True, help='new path inside runs/')
    parser.add_argument('--python-version', required=True, choices=('3.10', '3.11', '3.12'))
    parser.add_argument('--download', action='store_true', help='otherwise show plan only')
    args = parser.parse_args(argv)
    try:
        output = args.output.resolve()
        if 'runs' not in output.parts or args.output.is_symlink() or output.exists():
            raise ValueError('new directory under runs/ required')
        if not args.download:
            print('Plan: ARM64 binary download + pinned SDK/agent pure wheels; no installation')
            return 0
        output.mkdir(parents=True, mode=0o700)
        for name in ('tmp', 'cache', 'wheelhouse', 'source'):
            (output/name).mkdir()
        (output/'INCOMPLETE').write_text('Not installable until build/ABI checks complete.\n')
        env = clean_env(output)
        wheels = output/'wheelhouse'
        commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
        if subprocess.check_output(['git', 'status', '--porcelain', '--', 'apps/agent'], cwd=ROOT):
            raise ValueError('agent source must be committed before bundling')
        agent_archive = output/'source/agent.tar'
        with agent_archive.open('wb') as target:
            subprocess.run(['git', 'archive', '--format=tar', 'HEAD', 'apps/agent'],
                           cwd=ROOT, stdout=target, check=True)
        agent = unpack_source(agent_archive, output/'source/agent-tree')/'agent'
        archive = output/'source'/f'unitree-sdk2-{SDK_COMMIT}.tar.gz'
        url = f'https://codeload.github.com/unitreerobotics/unitree_sdk2_python/tar.gz/{SDK_COMMIT}'
        with urllib.request.urlopen(url, timeout=60) as response, archive.open('wb') as target:
            shutil.copyfileobj(response, target)
        sdk = unpack_source(archive, output/'source/sdk')
        # Existing build tools only; no pip build isolation or setup installation.
        build = 'import setuptools.build_meta as b; b.build_wheel(__import__("sys").argv[1])'
        for source in (agent, sdk):
            run([sys.executable, '-I', '-c', build, str(wheels)], cwd=source, env=env)
        if any(not p.name.endswith('-py3-none-any.whl') for p in wheels.glob('*.whl')):
            raise ValueError('source builds must be pure Python wheels')
        download = [sys.executable, '-I', '-m', 'pip', 'download', '--platform', 'manylinux2014_aarch64',
             '--python-version', args.python_version, '--implementation', 'cp',
             '--abi', 'cp'+args.python_version.replace('.', ''),
             '--only-binary=:all:', '--dest', str(wheels)]
        run([*download, *PINS, *map(str, sorted(wheels.glob('*.whl')))], cwd=output, env=env)
        for _ in range(8):
            missing = target_dependencies(wheels, args.python_version)
            if not missing:
                break
            run([*download, *missing, *map(str, sorted(wheels.glob('*.whl')))], cwd=output, env=env)
        else:
            raise ValueError('target dependency closure did not converge')
        native = lock_wheels(wheels)
        # A full ELF dependency audit is recorded without executing/loading a .so.
        audit = []
        for i, item in enumerate(native):
            with zipfile.ZipFile(wheels/item['wheel']) as wheel:
                path = output/'tmp'/f'native-{i}.so'
                path.write_bytes(wheel.read(item['member']))
            result = subprocess.check_output(['readelf', '-h', '-d', str(path)], text=True)
            if 'AArch64' not in result:
                raise ValueError('non-ARM64 native library')
            audit.append({**item, 'elf': result})
        provenance = {'agent_commit': commit, 'sdk_commit': SDK_COMMIT,
                      'agent_source_sha256': digest(agent_archive),
                      'sdk_source_sha256': digest(archive), 'platform': 'manylinux2014_aarch64',
                      'python': args.python_version, 'native_libraries': audit,
                      'dds_external_so_check': 'Review NEEDED and verify resolution on target preflight',
                      'installed': False, 'robot_tested': False}
        (wheels/'PROVENANCE.json').write_text(json.dumps(provenance, indent=2)+'\n')
        (wheels/'SHA256SUMS').write_text(''.join(
            f'{digest(p)}  {p.name}\n' for p in sorted(wheels.iterdir()) if p.is_file()))
        from install_offline import checked_inputs
        checked_inputs(wheels)
        (output/'INCOMPLETE').unlink()
        print('Bundle built; target ABI, DDS external libraries and field approval still required')
        return 0
    except (ValueError, OSError, subprocess.SubprocessError, tarfile.TarError, zipfile.BadZipFile):
        print('Bundle preparation failed; retained partial output is NOT installable', file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
