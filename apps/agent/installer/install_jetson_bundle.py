#!/usr/bin/env python3
"""Offline, stopped installation in exactly ${HOME:?}/foothold-robot.

No service manager, network request, SDK import or robot discovery is performed.
Failure preserves the new private INCOMPLETE directory for inspection.
"""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import platform
import shutil
import shlex
import subprocess
import sys
import sysconfig

# -I deliberately removes cwd/script imports. Only our resolved sibling directory
# is added, never PYTHONPATH or a user-supplied search directory.
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from jetson_bundle_common import checked_bundle, digest, unpack

BUNDLE = Path(__file__).resolve().parents[3]

LAUNCHER = '''"""Robot computer entrypoint; optional user service runs this same launcher."""
import json
import os
from pathlib import Path
root = Path(__file__).resolve().parent
if (root/'INCOMPLETE').exists():
    raise SystemExit('설치가 끝나지 않았습니다. 실행하지 마세요.')
config = json.loads((root/'connection.json').read_text())
python = str(root/'venv/bin/python')
os.environ['XDG_CACHE_HOME'] = str(root/'cache')
os.environ['FH_MAPPING_CACHE_DIR'] = str(root/'cache/mapping')
os.environ['FH_RECORD'] = '0'
args = [python, '-I', '-m', 'foothold_agent.setup', '--headless', '--onboard',
        '--config', str(root/'private/agent.json'), '--wheel-dir', str(root/'bundle/wheels'),
        '--server', config['server'], '--nic', config['nic'], '--port', str(config['port'])]
os.execv(python, args)
'''
PROTECTED = {8453, 8792, *range(5180, 5184), 5190, 5191, 5195,
             5297, 5310, 5320, 8870, 8881, 9430, 9468, 9611, 9761}


def destination():
    # Do not let Path.home silently replace unset HOME through the passwd DB.
    home_value = os.environ.get('HOME')
    if not home_value or not Path(home_value).is_absolute():
        raise ValueError('HOME must be nonempty and absolute')
    home = Path(home_value)
    root = home/'foothold-robot'
    if home != home.resolve() or not home.is_dir() or root.exists() or root.is_symlink():
        raise ValueError('new real ${HOME:?}/foothold-robot directory required; preserve existing files')
    return root


def configuration(server, nic, port):
    import re
    from urllib.parse import urlsplit
    parsed = urlsplit(server)
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
            or parsed.path not in ('', '/') or parsed.query or parsed.fragment):
        raise ValueError('HTTPS server origin without credentials required')
    if not re.fullmatch(r'[A-Za-z0-9_.:-]{1,15}', nic):
        raise ValueError('wired NIC name or auto required')
    if port in PROTECTED or not 1024 <= port <= 65535:
        raise ValueError('dedicated unprotected loopback port required')
    return dict(server=server, nic=nic, port=port)


def child_environment(root):
    # Avoid package/build config, ROS overlays, loader/compiler injection and
    # caches outside this one installation. These variables never reach runtime.
    env = dict(PATH='/usr/bin:/bin', HOME=str(root/'build/home'),
               LANG='C.UTF-8', TMPDIR=str(root/'build/tmp'),
               XDG_CACHE_HOME=str(root/'cache'), PIP_CONFIG_FILE=os.devnull,
               PIP_NO_INDEX='1', PIP_DISABLE_PIP_VERSION_CHECK='1')
    return env


def run(argv, root, env, cwd=None):
    with (root/'build/install.log').open('ab') as log:
        subprocess.run([str(a) for a in argv], cwd=cwd or root, env=env,
                       stdout=log, stderr=log, check=True)


def stage(bundle, root):
    root.mkdir(mode=0o700)
    (root/'INCOMPLETE').write_text('Installation is incomplete; do not start launch.py.\n')
    shutil.copytree(bundle, root/'bundle', symlinks=False)
    for path in (root, *root.rglob('*')):
        if path.is_dir():
            path.chmod(0o700)
        else:
            path.chmod(0o600)
    for name in ('private', 'cache', 'build', 'build/tmp', 'build/home', 'build/wheels', 'dds/bin'):
        (root/name).mkdir(parents=True, exist_ok=True, mode=0o700)


def bootstrap(root, lock, env):
    python = root/'venv/bin/python'
    run([sys.executable, '-I', '-m', 'venv', '--without-pip', root/'venv'], root, env)
    wheels = root/'bundle/wheels'
    pip_row = next(r for r in lock['wheels'] if r['name'] == 'pip')
    pip_wheel = wheels/pip_row['filename']
    # Execute the official, hash-checked pip wheel as a zip import, no ensurepip,
    # download or get-pip script. Install every official wheel with exact hashes.
    requirements = root/'build/official-requirements.txt'
    requirements.write_text(''.join(
        f"{row['name']}=={row['version']} --hash=sha256:{row['sha256']}\n" for row in lock['wheels']))
    code = 'import runpy,sys; sys.path.insert(0,sys.argv.pop(1)); runpy.run_module("pip",run_name="__main__")'
    run([python, '-I', '-c', code, pip_wheel, 'install', '--no-index', '--no-deps',
         '--no-user', '--prefix', root/'venv', '--only-binary=:all:', '--require-hashes',
         '--find-links', wheels, '-r', requirements], root, env)
    return python


def pin_dds_library(loader, library):
    loader.write_text('in_wheel = True\nlibrary_path = '+repr(str(library))+'\n')
    # pip may have compiled the old loader in the same second with the same
    # source size. Such a timestamp-based pyc still looks current to Python.
    for cached in (loader.parent/'__pycache__').glob('__library__.*.pyc'):
        cached.unlink()


def build_sources(root, python, env):
    sources = root/'bundle/sources'
    core = unpack(sources/'cyclonedds-c.tar.gz', root/'build/c-source')
    binding = unpack(sources/'cyclonedds-0.10.2.tar.gz', root/'build/python-source')
    sdk = unpack(sources/'unitree-sdk2.tar.gz', root/'build/sdk-source')
    prefix = root/'dds'
    run(['cmake', '-S', core, '-B', root/'build/cmake',
         '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_INSTALL_PREFIX='+str(prefix),
         '-DCMAKE_INSTALL_LIBDIR=lib', '-DBUILD_SHARED_LIBS=ON', '-DBUILD_IDLC=OFF',
         '-DBUILD_DDSPERF=OFF', '-DBUILD_EXAMPLES=OFF', '-DBUILD_TESTING=OFF',
         '-DBUILD_DOCS=OFF', '-DENABLE_SSL=OFF', '-DENABLE_SECURITY=OFF', '-DENABLE_SHM=OFF'], root, env)
    run(['cmake', '--build', root/'build/cmake', '--parallel', '2'], root, env)
    run(['cmake', '--install', root/'build/cmake'], root, env)
    build_env = dict(env, CYCLONEDDS_HOME=str(prefix),
                     LDFLAGS=shlex.join(['-Xlinker', '--disable-new-dtags', '-Xlinker',
                                       '-rpath', '-Xlinker', str(prefix/'lib')]))
    agent = root/'build/agent-source'
    shutil.copytree(root/'bundle/apps/agent', agent)
    for source in (binding, sdk, agent):
        run([python, '-I', '-m', 'pip', 'wheel', '--no-index', '--no-deps',
             '--no-build-isolation', '--wheel-dir', root/'build/wheels', source], root, build_env)
    wheels = sorted((root/'build/wheels').glob('*.whl'))
    if len(wheels) != 3:
        raise ValueError('exactly three source-built wheels required')
    requirements = root/'build/local-requirements.txt'
    requirements.write_text(''.join(f'{p} --hash=sha256:{digest(p)}\n' for p in wheels))
    run([python, '-I', '-m', 'pip', 'install', '--no-index', '--no-deps', '--no-user',
         '--prefix', root/'venv', '--only-binary=:all:', '--require-hashes',
         '-r', requirements], root, env)
    # Make the approved absolute local library the *first* DDS loader. No
    # CYCLONEDDS_HOME/LD_LIBRARY_PATH export, system search or patching utility.
    site = root/'venv/lib/python3.10/site-packages'
    loader = site/'cyclonedds/__library__.py'
    pin_dds_library(loader, prefix/'lib/libddsc.so')
    run([python, '-I', '-m', 'pip', 'check'], root, env)


def write_receipt(root):
    """Run inside the new venv, metadata/ELF inspection only; no DDS import."""
    sys.path.insert(0, str(root/'bundle/apps/agent'))
    from foothold_agent.go2_direct.arm_provenance import SOURCE_HASHES, aarch64_elf, installed_files
    entries = {}
    for name in installed_files(root):
        path = root/name
        record = dict(sha256=digest(path))
        if '.so' in path.name:
            if not aarch64_elf(path):
                raise ValueError('source-built shared object is not AArch64')
            record['machine'] = 'aarch64'
            record['elf'] = subprocess.check_output(['readelf', '-h', '-d', '--version-info', str(path)],
                env=child_environment(root), text=True)
        entries[name] = record
    tools = {}
    for name, args in {'gcc': ['gcc', '--version'], 'cmake': ['cmake', '--version'],
                       'python': [sys.executable, '--version'], 'readelf': ['readelf', '--version']}.items():
        tools[name] = subprocess.check_output(args, env=child_environment(root), text=True).splitlines()[0]
    import importlib.metadata
    for package in ('pip', 'setuptools', 'wheel'):
        tools[package] = importlib.metadata.version(package)
    receipt = dict(schema=1, sources=SOURCE_HASHES, machine='aarch64',
                   built_at=datetime.now(timezone.utc).isoformat(), tools=tools,
                   python_soabi=sysconfig.get_config_var('SOABI'), files=entries)
    manifest = root/'dds-build-manifest.json'
    with manifest.open('x') as target:
        target.write(json.dumps(receipt, indent=2)+'\n')
    manifest.chmod(0o600)


def install(bundle, root, lock, config):
    stage(bundle, root)
    env = child_environment(root)
    python = bootstrap(root, lock, env)
    build_sources(root, python, env)
    script = root/'bundle/apps/agent/installer/install_jetson_bundle.py'
    run([python, '-I', script, '--write-receipt', root], root, env)
    # Preflight is metadata only. Use the real installation HOME, clean loader
    # env, and do not execute setup, import the SDK or join a DDS domain.
    verify_env = dict(env, HOME=str(root.parent))
    run([python, '-I', '-m', 'foothold_agent.go2_direct.preflight'], root, verify_env)
    (root/'connection.json').write_text(json.dumps(config, indent=2)+'\n')
    (root/'launch.py').write_text(LAUNCHER)
    shutil.copyfile(bundle/'apps/agent/installer/jetson_autostart.py', root/'autostart.py')
    for action in ('enable', 'disable'):
        script = root/(action+'-autostart.sh')
        script.write_text('#!/bin/sh\nset -eu\n'
            'root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)\n'
            'exec /usr/bin/python3 -I "$root/autostart.py" '+action+'\n')
        script.chmod(0o700)
    (root/'connection.json').chmod(0o600)
    (root/'INCOMPLETE').unlink()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--install', action='store_true')
    parser.add_argument('--server', required=True)
    parser.add_argument('--nic', default='enP8p1s0')
    parser.add_argument('--port', type=int, default=9539)
    args = parser.parse_args(argv)
    try:
        root = destination()
        _, lock = checked_bundle(BUNDLE)
        config = configuration(args.server, args.nic, args.port)
        if not args.install:
            print('묶음 해시·설치 경로 확인 완료. 설치·빌드·네트워크 연결은 실행하지 않았습니다.')
            return 0
        if platform.system() != 'Linux' or platform.machine() != 'aarch64' or sys.version_info[:2] != (3, 10):
            raise ValueError('install only on reviewed Linux aarch64 CPython 3.10')
        for command in ('gcc', 'cmake', 'make', 'readelf'):
            if not shutil.which(command, path='/usr/bin:/bin'):
                raise ValueError('required existing tool missing: '+command)
        if not (Path(sysconfig.get_path('include'))/'Python.h').is_file():
            raise ValueError('existing Python 3.10 development header missing; do not install system packages')
        previous = os.umask(0o077)
        try:
            install(BUNDLE, root, lock, config)
        finally:
            os.umask(previous)
        print('설치·빌드·자동 점검 완료. 실행과 자동 시작은 꺼져 있습니다. Jetson 실기 검증은 별도입니다.')
        return 0
    except (ValueError, OSError, KeyError, subprocess.SubprocessError) as error:
        print('설치 중단: '+str(error)+'; 새 부분 설치 폴더는 보존했습니다. 실행하지 마세요.', file=sys.stderr)
        return 2


if __name__ == '__main__':
    # Internal metadata-only receipt step, not an install/architecture bypass.
    if len(sys.argv) == 3 and sys.argv[1] == '--write-receipt':
        candidate = Path(sys.argv[2])
        if (platform.system() != 'Linux' or platform.machine() != 'aarch64'
                or sys.version_info[:2] != (3, 10) or Path(sys.prefix) != candidate/'venv'
                or candidate.resolve() != candidate):
            raise SystemExit('receipt only inside the target ARM venv')
        write_receipt(candidate)
    else:
        raise SystemExit(main())
