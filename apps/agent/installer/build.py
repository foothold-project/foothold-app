#!/usr/bin/env python3
"""Build offline Ubuntu amd64 deb or Windows x64 ZIP; all fetched inputs are hashed."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import stat
import subprocess
import tarfile
from urllib.parse import urlsplit
from urllib.request import urlopen

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
SDK_COMMIT = '814556d15970dd2ecf1c9984e845ca02ab07e206'


def run(*args, **kwargs):
    subprocess.run([str(a) for a in args], check=True, **kwargs)


def fetch(asset, cache):
    path = cache / asset['name']
    if not path.exists():
        with urlopen(asset['url'], timeout=120) as source, path.with_suffix('.part').open('wb') as dest:
            shutil.copyfileobj(source, dest)
        path.with_suffix('.part').replace(path)
    if hashlib.sha256(path.read_bytes()).hexdigest() != asset['sha256']:
        raise ValueError('input hash mismatch: '+path.name)
    return path


def unpack(path, target):
    with tarfile.open(path) as archive:
        # Python 3.10 build hosts do not have tarfile's newer data filter.
        for member in archive.getmembers():
            dest = (target/member.name).resolve()
            if not dest.is_relative_to(target.resolve()) or member.isdev():
                raise ValueError('unsafe archive member')
            if member.issym() or member.islnk():
                link = ((dest.parent if member.issym() else target)/member.linkname).resolve()
                if not link.is_relative_to(target.resolve()):
                    raise ValueError('unsafe archive link')
        archive.extractall(target)


def project_groups(python, path):
    # pip's vendored TOML reader also works on the private CPython 3.10.
    script = ("import json,sys; from pip._vendor import tomli; "
              "p=tomli.load(open(sys.argv[1],'rb'))['project']['optional-dependencies']; "
              "print(json.dumps({k:p[k] for k in ('setup','go2-readonly','slam') if k in p}))")
    result = subprocess.run([str(python), '-I', '-c', script, str(path)],
                            check=True, capture_output=True, text=True)
    return json.loads(result.stdout)


def group_pins(groups):
    pins = {}
    for requirements in groups.values():
        for requirement in requirements:
            if requirement == ('unitree_sdk2py @ git+https://github.com/'
                               'unitreerobotics/unitree_sdk2_python.git@'+SDK_COMMIT):
                continue  # built from the hash-verified archive below
            match = re.fullmatch(r'([A-Za-z0-9_.-]+)==([A-Za-z0-9_.+!-]+)', requirement)
            if match is None:
                raise ValueError('installer extras require exact wheel pins: '+requirement)
            name, version = match.groups()
            name = re.sub(r'[-_.]+', '-', name).lower()
            if name in pins and pins[name] != version:
                raise ValueError('conflicting extra pins: '+name)
            pins[name] = version
    return pins


def extra_wheels(python, groups, lock, cache, env):
    existing = {re.sub(r'[-_.]+', '-', a['name'].split('-')[0]).lower():a['name'].split('-')[1]
                for a in lock if a['name'].endswith('.whl')}
    resolved = []
    for name, version in group_pins(groups).items():
        if existing.get(name) == version:
            continue
        if name in existing:
            raise ValueError('pyproject pin differs from reviewed installer lock: '+name)
        # Future slam pins are optional until the group exists. Every wheel is
        # verified against PyPI's SHA256 before pip may install it. No source
        # builds or unpinned dependency resolution on the operator's laptop.
        with urlopen(f'https://pypi.org/pypi/{name}/{version}/json', timeout=30) as response:
            files = json.load(response)['urls']
        wheels = [f for f in files if f['packagetype'] == 'bdist_wheel']
        requirements = cache/'extra-requirement.txt'
        requirements.write_text(name+'=='+version+' '+ ' '.join(
            '--hash=sha256:'+f['digests']['sha256'] for f in wheels)+'\n')
        download = cache/'extra-wheels'/name
        download.mkdir(parents=True, exist_ok=True)
        run(python, '-I', '-m', 'pip', 'download', '--only-binary=:all:', '--no-deps',
            '--require-hashes', '--index-url', 'https://pypi.org/simple',
            '--dest', download, '-r', requirements, env=env)
        paths = list(download.glob('*.whl'))
        if len(paths) != 1:
            raise ValueError('one compatible extra wheel required: '+name)
        wheel = paths[0]
        info = next(f for f in wheels if f['filename'] == wheel.name)
        asset = dict(name=wheel.name, url=info['url'], sha256=info['digests']['sha256'])
        if hashlib.sha256(wheel.read_bytes()).hexdigest() != asset['sha256']:
            raise ValueError('extra wheel hash mismatch')
        resolved.append((wheel, asset))
    return resolved


def normalize_stage_permissions(stage):
    # The API runs with UMask=0077; copy2 also retains private cache/source modes.
    # Only the package payload becomes public, never the builder's workspace.
    for path in (stage, *stage.rglob('*')):
        mode = path.lstat().st_mode
        if stat.S_ISDIR(mode):
            path.chmod(0o755)
        elif stat.S_ISREG(mode):
            path.chmod(0o755 if mode & 0o111 else 0o644)


def build(server, output, version, target_platform="linux"):
    if target_platform not in ("linux", "windows"):
        raise ValueError("unsupported installer platform")
    parsed = urlsplit(server)
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
            or parsed.path not in ('', '/') or parsed.query or parsed.fragment
            or any(c.isspace() for c in server)):
        raise ValueError('--server must be an HTTPS origin without credentials/path/query')
    if platform.machine() != 'x86_64':
        raise ValueError('build requires x86_64 Linux')
    # Never let the output directory capture source, credentials, or other worktrees.
    output = output.resolve()
    if not any(output.is_relative_to(ROOT/name) for name in ('output', 'runs')):
        raise ValueError('--output must be inside this checkout output/ or runs/')
    if target_platform == 'windows':
        from build_windows import build as build_windows
        return build_windows(server, output, version)
    output.mkdir(parents=True, exist_ok=True)
    cache = output/'cache'
    cache.mkdir(exist_ok=True)
    lock = json.loads((HERE/'inputs.lock.json').read_text())
    assets = {a['name']: fetch(a, cache) for a in lock}
    stage = output/'stage'
    if stage.exists():
        shutil.rmtree(stage)
    opt = stage/'opt/foothold-robot'
    opt.mkdir(parents=True)
    unpack(assets['python.tar.gz'], opt)
    native = output/'native-source'
    if native.exists():
        shutil.rmtree(native)
    native.mkdir()
    for name in ('binutils-x86-64-linux-gnu.deb', 'libctf-nobfd0.deb'):
        run('dpkg-deb', '--extract', assets[name], native)
    tools = opt/'tools'
    tools.mkdir()
    shutil.copy2(native/'usr/bin/x86_64-linux-gnu-readelf', tools/'readelf.bin')
    libs = tools/'libs'
    libs.mkdir()
    for lib in (native/'usr/lib/x86_64-linux-gnu').glob('libctf-nobfd.so*'):
        shutil.copy2(lib, libs/lib.name)
    wrapper = tools/'readelf'
    wrapper.write_text('#!/bin/sh\nbase=$(dirname "$(readlink -f "$0")")\n'
                       'exec /lib64/ld-linux-x86-64.so.2 --library-path "$base/libs" "$base/readelf.bin" "$@"\n')
    wrapper.chmod(0o755)
    source_license = opt/'licenses/binutils'
    source_license.mkdir(parents=True)
    for name, path in assets.items():
        if name.startswith('binutils_'):
            shutil.copy2(path, source_license/name)
    shutil.copy2(native/'usr/share/doc/libctf-nobfd0/copyright', source_license/'copyright')
    python = opt/'python/bin/python3'
    wheels = opt/'wheels'
    wheels.mkdir()
    for name, source in assets.items():
        if name.endswith('.whl'):
            shutil.copy2(source, wheels/name)
    env = {k:v for k,v in os.environ.items() if not k.startswith(('PYTHON', 'PIP_', 'CYCLONEDDS_', 'LD_'))}
    env.update(PYTHONNOUSERSITE='1', PIP_CONFIG_FILE='/dev/null', SOURCE_DATE_EPOCH='1794355200')
    groups = project_groups(python, ROOT/'apps/agent/pyproject.toml')
    for wheel, asset in extra_wheels(python, groups, lock, cache, env):
        shutil.copy2(wheel, wheels/wheel.name)
        lock.append(asset)
    (opt/'inputs.lock.json').write_text(json.dumps(lock, indent=2)+'\n')
    (opt/'extras.json').write_text(json.dumps(groups, indent=2)+'\n')
    run(python, '-I', '-m', 'pip', 'install', '--no-index', '--no-deps', *sorted(wheels.glob('*.whl')), env=env)
    source = output/'sdk-source'
    if source.exists():
        shutil.rmtree(source)
    source.mkdir()
    unpack(assets['sdk.tar.gz'], source)
    sdk = next(source.iterdir())
    run(python, '-I', '-m', 'pip', 'wheel', '--no-index', '--no-deps', '--no-build-isolation',
        '--wheel-dir', wheels, sdk, env=env)
    run(python, '-I', '-m', 'pip', 'install', '--no-index', '--no-deps', *wheels.glob('unitree_sdk2py-*.whl'), env=env)
    # Preserve verified VCS provenance required by the existing preflight.
    site = opt/'python/lib/python3.10/site-packages'
    dist = next(site.glob('unitree_sdk2py-*.dist-info'))
    (dist/'direct_url.json').write_text(json.dumps(dict(
        url='https://github.com/unitreerobotics/unitree_sdk2_python.git',
        vcs_info=dict(vcs='git', commit_id=SDK_COMMIT, requested_revision=SDK_COMMIT))))
    # Build from a clean copy: setuptools must not write egg-info into the checkout.
    agent = output/'agent-source'
    if agent.exists():
        shutil.rmtree(agent)
    shutil.copytree(ROOT/'apps/agent', agent, ignore=shutil.ignore_patterns(
        'installer', 'tests', '__pycache__', '*.egg-info', 'build', '*.pyc'))
    run(python, '-I', '-m', 'pip', 'wheel', '--no-index', '--no-deps', '--no-build-isolation',
        '--wheel-dir', wheels, agent, env=env)
    run(python, '-I', '-m', 'pip', 'install', '--no-index', '--no-deps', *wheels.glob('foothold_agent-*.whl'), env=env)
    (opt/'server.json').write_text(json.dumps({'server':server.rstrip('/')})+'\n')
    run(python, '-I', '-m', 'pip', 'check', env=env)
    shutil.copy2(HERE/'foothold.svg', opt/'foothold.svg')
    launcher = opt/'launch'
    launcher.write_text('#!/bin/sh\nexec "$(dirname "$(readlink -f "$0")")/python/bin/python3" -I -m foothold_agent.desktop "$@"\n')
    launcher.chmod(0o755)
    for rel in ('usr/share/applications', 'etc/xdg/autostart'):
        dest = stage/rel
        dest.mkdir(parents=True, exist_ok=True)
        shutil.copy2(HERE/'foothold-robot.desktop', dest/'foothold-robot.desktop')
    auto = stage/'etc/xdg/autostart/foothold-robot.desktop'
    auto.write_text(auto.read_text().replace('Exec=/opt/foothold-robot/launch', 'Exec=/opt/foothold-robot/launch --autostart'))
    metainfo = stage/'usr/share/metainfo'
    metainfo.mkdir(parents=True)
    shutil.copy2(HERE/'org.foothold.Robot.metainfo.xml', metainfo/'org.foothold.Robot.metainfo.xml')
    units = stage/'usr/lib/systemd/user'
    units.mkdir(parents=True)
    shutil.copy2(HERE/'foothold-robot.service', units/'foothold-robot.service')
    meta = stage/'DEBIAN'
    meta.mkdir()
    (meta/'control').write_text(f'''Package: foothold-robot
Version: {version}
Architecture: amd64
Maintainer: FOOTHOLD <noreply@foothold.invalid>
Depends: libc6 (>= 2.35), libstdc++6, zlib1g, iproute2, libgl1, libglib2.0-0 | libglib2.0-0t64
Section: utils
Priority: optional
Installed-Size: {sum(p.stat().st_size for p in stage.rglob('*') if p.is_file())//1024}
Description: FOOTHOLD robot laptop connection
 Private CPython 3.10 and pinned wheels; no apt or pip downloads at install time.
''')
    for name in ('postinst', 'prerm'):
        shutil.copy2(HERE/name, meta/name)
        (meta/name).chmod(0o755)
    normalize_stage_permissions(stage)
    result = output/f'foothold-robot_{version}_amd64.deb'
    run('dpkg-deb', '--root-owner-group', '-Zxz', '-z3', '--threads-max=2', '--build', stage, result)
    checksum = hashlib.sha256(result.read_bytes()).hexdigest()
    (output/(result.name+'.sha256')).write_text(checksum+'  '+result.name+'\n')
    print(json.dumps(dict(artifact=str(result), bytes=result.stat().st_size, sha256=checksum)))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--server', required=True)
    parser.add_argument('--platform', choices=('linux','windows'), default='linux')
    parser.add_argument('--output', type=Path, default=ROOT/'output/easy-install')
    parser.add_argument('--version', default='0.2.0-1')
    args = parser.parse_args()
    import re
    if not re.fullmatch(r'[0-9]+[a-zA-Z0-9.+~-]*', args.version):
        parser.error('invalid Debian version')
    build(args.server, args.output, args.version, args.platform)


if __name__ == '__main__':
    main()
