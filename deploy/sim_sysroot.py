"""Private, signed DEB staging. Never apt-install, register dpkg, or run scripts."""
import sys
sys.dont_write_bytecode = True
import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import tarfile
import tempfile
import time

try:
    from .install_sim_packages import (upstream, installed_versions, host_snapshot,
        verify_host_unchanged, create_install_latch, clear_install_latch, ensure_no_install_latch)
except ImportError:
    from install_sim_packages import (upstream, installed_versions, host_snapshot,
        verify_host_unchanged, create_install_latch, clear_install_latch, ensure_no_install_latch)

ROOT = Path('/opt/foothold-sim')
BASE_FORBIDDEN = re.compile(r'^(?:libc6(?:-|$)|libc-bin$|ld-linux|libstdc\+\+6(?:-|$)|libgcc-s1$|(?:lib)?python3\.12|systemd(?:-|$)|libsystemd|openssl(?:-|$)|libssl|libcrypto)')
DRIVER_FORBIDDEN = re.compile(r'nvidia|cuda|dcgm|rpcbind|dkms|firmware|^linux-(?!libc-dev$)|^glx-diversions|^lib(?:cublas|nvrtc|npp|cufft|curand|cusolver|cusparse|nvjpeg)', re.I)
NAME = re.compile(r'[a-z0-9][a-z0-9+.-]*\Z')
VERSION = re.compile(r'[0-9][a-zA-Z0-9.+:~_-]*\Z')
HASH = re.compile(r'[0-9a-f]{64}\Z')



def canonical(data):
    return json.dumps(data, sort_keys=True, separators=(',',':')).encode()


def sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda:stream.read(1024*1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def execute(args, *, env=None, cwd=None):
    return subprocess.run(args, env=env, cwd=cwd, check=True, capture_output=True, text=True).stdout


def generator_digest():
    return hashlib.sha256(canonical({name:sha(Path(__file__).with_name(name))
        for name in ('sim_sysroot.py','sysroot_profile.py')})).hexdigest()


def requirements():
    return json.loads(Path(__file__).with_name('sim-package-versions.json').read_text())


def validate_downloads(rows, installed, pins):
    locked = {}
    for row in rows:
        if set(row) != {'name','version','sha256','size','filename'}:
            raise ValueError('invalid private download lock fields')
        name, version = row['name'], row['version']
        if not NAME.fullmatch(name) or not VERSION.fullmatch(version) or not HASH.fullmatch(row['sha256']):
            raise ValueError('invalid private package identity')
        if type(row['size']) is not int or not 0 < row['size'] < 4*1024**3:
            raise ValueError('invalid package size')
        filename = PurePosixPath(row['filename'])
        if filename.is_absolute() or '..' in filename.parts or not str(filename).endswith('.deb'):
            raise ValueError('invalid archive filename')
        if name in locked or name in installed:
            raise ValueError('duplicate or already-installed package must not be extracted')
        if BASE_FORBIDDEN.search(name) or DRIVER_FORBIDDEN.search(name):
            raise ValueError('base runtime or driver package cannot enter sysroot')
        expected = pins.get(name)
        if name.startswith('ros-jazzy-nav2-'):
            expected = '1.3.13'
        if name.startswith(('libprotobuf','python3-protobuf','protobuf-')):
            expected = '3.21.12'
        if expected and upstream(version) != expected:
            raise ValueError('upstream pin differs from approved plan')
        locked[name] = row
    for name, expected in pins.items():
        version = installed.get(name, (None,None))[0] if name in installed else locked.get(name,{}).get('version')
        if version is None or upstream(version) != expected:
            raise ValueError('required pinned package unavailable in host or sysroot')
        if name in installed and installed[name][1] != 'installed':
            raise ValueError('host package not fully configured')
    return locked


def simulation_changes(text, installed):
    result = []
    for line in text.splitlines():
        if line.startswith(('Remv ','Purg ')):
            raise ValueError('private resolution requests removal')
        if not line.startswith('Inst '):
            continue
        match = re.match(r'Inst (\S+)(?: \[([^]]+)\])? \((\S+)', line)
        if not match:
            raise ValueError('unknown private apt simulation')
        name, previous, version = match.groups()
        if previous is not None or name in installed:
            raise ValueError('host version change required; private extraction forbidden')
        if BASE_FORBIDDEN.search(name) or DRIVER_FORBIDDEN.search(name):
            raise ValueError('forbidden base/driver download')
        result.append((name,version))
    return result


def tree_manifest(root):
    """Content/links/modes/owners only; no atime or mutable external symlinks."""
    rows = []
    for parent, directories, files in os.walk(root, followlinks=False):
        directories.sort(); files.sort()
        for name in sorted(directories + files):
            path = Path(parent) / name
            info = path.lstat()
            row = dict(path=str(path.relative_to(root)),mode=stat.S_IMODE(info.st_mode),uid=info.st_uid,gid=info.st_gid)
            if stat.S_ISLNK(info.st_mode):
                row.update(type='link',target=os.readlink(path))
            elif stat.S_ISREG(info.st_mode):
                row.update(type='file',sha256=sha(path),size=info.st_size)
            elif stat.S_ISDIR(info.st_mode):
                row['type'] = 'dir'
            else:
                raise ValueError('special file in read-only tree')
            rows.append(row)
    return rows


def member_name(value):
    path = PurePosixPath(value)
    if path.is_absolute() or '..' in path.parts or '\\' in value or len(value)>4096 or any(ord(c)<32 for c in value):
        raise ValueError('archive path escape')
    return str(path)


def resolve_link(parts, links):
    pending=list(parts);resolved=[];expansions=0
    while pending:
        part=pending.pop(0)
        if part in ('','.'): continue
        if part=='..':
            if not resolved: raise ValueError('nested link escapes private root')
            resolved.pop();continue
        resolved.append(part)
        name='/'.join(resolved)
        if name in links:
            target=PurePosixPath(links[name])
            if target.is_absolute(): raise ValueError('external existing link')
            expansions+=1
            if expansions>40: raise ValueError('cyclic/oversized archive link chain')
            resolved.pop()
            pending=list(target.parts)+pending
    return resolved


def validate_tar(stream, destination):
    """Reject dangerous nodes before any extraction, including link parents."""
    members, links, raw_links, hardlinks, total = {}, {}, {}, [], 0
    with tarfile.open(fileobj=stream, mode='r|') as archive:
        for item in archive:
            total += item.size
            if total > 8*1024**3 or len(members)>200000 or any('capability' in key for key in item.pax_headers):
                raise ValueError('oversized or privileged archive payload')
            name = member_name(item.name)
            if name == '.':
                if not item.isdir(): raise ValueError('invalid archive root')
                continue
            if not (item.isfile() or item.isdir() or item.issym() or item.islnk()):
                raise ValueError('special package payload forbidden')
            if name in members:
                raise ValueError('duplicate archive member')
            members[name] = item.isdir()
            if item.issym() or item.islnk():
                target = PurePosixPath(item.linkname)
                if target.is_absolute() or '\\' in item.linkname or any(ord(c)<32 for c in item.linkname):
                    raise ValueError('absolute/external link forbidden')
                base = PurePosixPath(name).parent if item.issym() else PurePosixPath('.')
                parts = []
                for part in (base / target).parts:
                    if part == '..':
                        if not parts: raise ValueError('link target escapes sysroot')
                        parts.pop()
                    elif part != '.': parts.append(part)
                links[name] = '/'.join(parts)
                if item.issym(): raw_links[name]=item.linkname
                else: hardlinks.append(item.linkname)
    # Resolve raw components after each symlink expansion: lexical '..'
    # normalization alone misses links that contract a directory depth.
    combined={}
    for parent,directories,files in os.walk(destination,followlinks=False):
        for name in directories+files:
            path=Path(parent)/name
            if path.is_symlink(): combined[str(path.relative_to(destination))]=os.readlink(path)
    combined.update(raw_links)
    for name,target in combined.items():
        resolve_link((*PurePosixPath(name).parent.parts,*PurePosixPath(target).parts),combined)
    for target in hardlinks:
        resolve_link(PurePosixPath(target).parts,combined)
    # A package may not write through any archive-provided symlink directory.
    # Legitimate library/doc leaf links remain valid; nested links are handled
    # by later explicit private compatibility generation, not extraction magic.
    for name in members:
        parents = PurePosixPath(name).parents
        if any(str(parent) in links for parent in parents):
            raise ValueError('archive writes through a link parent')
        path = destination / name
        for parent in (path.parent, *path.parent.parents):
            if parent == destination.parent: break
            if parent.is_symlink():
                raise ValueError('existing staging symlink parent')
        if path.is_symlink() or (path.exists() and not (path.is_dir() and members[name])):
            raise ValueError('package payload collision')
    return len(members)


def inspect_deb(archive, destination):
    child = subprocess.Popen(['dpkg-deb','--fsys-tarfile',str(archive)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        result = validate_tar(child.stdout,destination)
        child.stdout.close()
        error = child.stderr.read()
        if child.wait() != 0:
            raise ValueError('invalid DEB payload')
        return result
    finally:
        if child.poll() is None:
            child.kill(); child.wait()
        child.stdout.close()
        child.stderr.close()


def sandbox(args, writable, *, cwd=None, apt_config=None):
    """Kernel read-only host, no host home/credentials, write only one prefix."""
    if not writable.is_absolute() or not writable.is_relative_to(ROOT) or '..' in writable.parts:
        raise ValueError('sandbox writable prefix escapes private root')
    if cwd is not None and not cwd.is_relative_to(writable):
        raise ValueError('sandbox working directory escapes writable root')
    unit = 'foothold-sim-stage-' + str(os.getpid()) + '-' + str(time.monotonic_ns())
    command = ['systemd-run','--quiet','--wait','--collect','--pipe','--unit='+unit,
        '--property=Type=exec','--property=ProtectSystem=strict','--property=ProtectHome=yes',
        '--property=PrivateTmp=yes','--property=PrivateDevices=yes','--property=NoNewPrivileges=yes',
        '--property=ProtectKernelTunables=yes','--property=ProtectKernelModules=yes',
        '--property=ProtectControlGroups=yes','--property=RestrictSUIDSGID=yes',
        '--property=CapabilityBoundingSet=CAP_CHOWN CAP_FOWNER CAP_DAC_OVERRIDE',
        '--property=MemoryMax=2G','--property=CPUQuota=200%','--property=TasksMax=64',
        '--property=RuntimeMaxSec=3600','--property=KillMode=control-group',
        '--property=ReadWritePaths='+str(writable),
        '--property=InaccessiblePaths=-/etc/foothold -/etc/foothold-sim -/var/lib/foothold -/opt/foothold-sim/assets']
    if cwd is not None:
        command.append('--property=WorkingDirectory='+str(cwd))
    environment = dict(PATH='/usr/bin:/bin',HOME=str(writable/'home'),TMPDIR=str(writable/'tmp'),
        LC_ALL='C',PYTHONDONTWRITEBYTECODE='1')
    if apt_config is not None:
        environment['APT_CONFIG'] = str(apt_config)
    command += ['/usr/bin/env','-i',*[key+'='+value for key,value in environment.items()],*args]
    return execute(command)


def private_apt(apt):
    config = apt/'apt.conf'
    if not config.is_file():
        raise ValueError('prepare private APT first')
    return dict(PATH='/usr/bin:/bin',HOME=str(apt/'home'),TMPDIR=str(apt/'tmp'),
                LC_ALL='C',PYTHONDONTWRITEBYTECODE='1',APT_CONFIG=str(config))


def setup_apt(apt):
    for leaf in ('etc/parts','etc/sourceparts','etc/trustedparts','lists/partial','cache/archives/partial',
                 'downloads','logs','tmp','home','keyrings'):
        (apt/leaf).mkdir(parents=True, exist_ok=True, mode=0o700)
    # No host apt config/hooks or status writes. Keys are public, acquired from
    # the official source over authenticated TLS; apt still verifies signatures.
    from urllib.request import urlopen
    key = urlopen('https://raw.githubusercontent.com/ros/rosdistro/master/ros.key',timeout=30).read()
    if len(key)>65536 or b'BEGIN PGP PUBLIC KEY BLOCK' not in key:
        raise ValueError('invalid official ROS signing key')
    (apt/'keyrings/ros.asc').write_bytes(key)
    shutil.copyfile('/usr/share/keyrings/ubuntu-archive-keyring.gpg',apt/'keyrings/ubuntu.gpg')
    (apt/'etc/main.conf').write_text('')
    sources = (f'deb [arch=amd64 signed-by={apt}/keyrings/ubuntu.gpg] http://archive.ubuntu.com/ubuntu noble main universe\n'
        f'deb [arch=amd64 signed-by={apt}/keyrings/ubuntu.gpg] http://archive.ubuntu.com/ubuntu noble-updates main universe\n'
        f'deb [arch=amd64 signed-by={apt}/keyrings/ubuntu.gpg] http://security.ubuntu.com/ubuntu noble-security main universe\n'
        f'deb [arch=amd64 signed-by={apt}/keyrings/ros.asc] http://snapshots.ros.org/jazzy/2026-09-11/ubuntu noble main\n')
    (apt/'etc/sources.list').write_text(sources)
    (apt/'status').write_bytes(Path('/var/lib/dpkg/status').read_bytes())
    (apt/'apt.conf').write_text('''Dir "'''+str(apt)+'''";
Dir::Etc "etc";
Dir::Etc::main "main.conf";
Dir::Etc::parts "parts";
Dir::Etc::sourcelist "sources.list";
Dir::Etc::sourceparts "sourceparts";
Dir::Etc::trusted "keyrings/unused.gpg";
Dir::Etc::trustedparts "trustedparts";
Dir::State "state";
Dir::State::status "'''+str(apt/'status')+'''";
Dir::State::lists "'''+str(apt/'lists')+'''";
Dir::State::extended_states "'''+str(apt/'extended_states')+'''";
Dir::Cache "cache";
Dir::Cache::archives "archives";
Dir::Log "logs";
APT::Architecture "amd64";
APT::Install-Recommends "false";
APT::Install-Suggests "false";
APT::Get::AllowUnauthenticated "false";
APT::Sandbox::User "root";
Acquire::Languages "none";
Acquire::AllowInsecureRepositories "false";
Acquire::AllowDowngradeToInsecureRepositories "false";
Acquire::https::Verify-Peer "true";
Acquire::https::Verify-Host "true";
''')
    (apt/'state').mkdir(exist_ok=True,mode=0o700)
    sandbox(['/usr/bin/apt-get','update'],apt,apt_config=apt/'apt.conf')


def metadata(apt, name, version):
    text = sandbox(['/usr/bin/apt-cache','show',name+'='+version],apt,apt_config=apt/'apt.conf')
    records = []
    for block in text.strip().split('\n\n'):
        fields = dict(line.split(': ',1) for line in block.splitlines() if ': ' in line and not line.startswith(' '))
        if fields.get('Version') == version and fields.get('SHA256'):
            records.append(dict(name=name,version=version,sha256=fields['SHA256'],
                                size=int(fields['Size']),filename=fields['Filename']))
    unique = {canonical(row) for row in records}
    if len(unique)!=1:
        raise ValueError('exact signed package metadata unavailable or ambiguous')
    return records[0]


def apt_metadata_digest(apt):
    digest = hashlib.sha256()
    for root in (apt/'etc',apt/'keyrings',apt/'lists'):
        for row in tree_manifest(root):
            if row['path'] in ('lock','partial') or row['path'].startswith('partial/'):
                continue
            digest.update(canonical(row))
    return digest.hexdigest()


def resolve(apt):
    installed = installed_versions()
    pins = requirements()
    concrete = {}
    # Explicit software-rendering providers; versions are frozen in the signed
    # private lock before download, never copied over host graphics files.
    optional_software = ('libegl-mesa0','libgl1-mesa-dri')
    for name, expected in pins.items():
        if name in installed:
            version,status = installed[name]
            if status!='installed' or upstream(version)!=expected:
                raise ValueError('required host package version differs; no replacement allowed')
            concrete[name] = version
        else:
            text = sandbox(['/usr/bin/apt-cache','madison',name],apt,apt_config=apt/'apt.conf')
            versions = [line.split('|')[1].strip() for line in text.splitlines() if '|' in line]
            concrete[name] = next((v for v in versions if upstream(v)==expected),None)
            if concrete[name] is None:
                raise ValueError('approved upstream pin unavailable; no latest fallback')
    for name in optional_software:
        if name in installed:
            concrete[name] = installed[name][0]
        else:
            text = sandbox(['/usr/bin/apt-cache','madison',name],apt,apt_config=apt/'apt.conf')
            versions = [line.split('|')[1].strip() for line in text.splitlines() if '|' in line]
            if not versions: raise ValueError('software Mesa provider unavailable')
            concrete[name] = versions[0]
    specs = [name+'='+version for name,version in sorted(concrete.items())]
    simulation = sandbox(['/usr/bin/apt-get','--simulate','--no-upgrade','--no-install-recommends','install',*specs],
                         apt,apt_config=apt/'apt.conf')
    (apt/'simulation.txt').write_text(simulation)
    changes = simulation_changes(simulation,installed)
    rows = [metadata(apt,name,version) for name,version in changes]
    validate_downloads(rows,installed,pins)
    lock = dict(schema=1,generator_sha256=generator_digest(),
        host_status_sha256=sha(Path('/var/lib/dpkg/status')),apt_metadata_sha256=apt_metadata_digest(apt),
        host_versions={name:list(value) for name,value in sorted(installed.items())},
        direct=concrete,downloads=rows)
    lock_sha = hashlib.sha256(canonical(lock)).hexdigest()
    (apt/('lock-'+lock_sha+'.json')).write_bytes(canonical(lock)+b'\n')
    print('Resolved lock='+lock_sha+' downloads='+str(len(rows))+' bytes='+str(sum(row['size'] for row in rows)))
    return lock_sha


def lock_read(apt,lock_sha):
    if not HASH.fullmatch(lock_sha): raise ValueError('invalid lock SHA')
    path = apt/('lock-'+lock_sha+'.json')
    fd = os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    with os.fdopen(fd) as stream:
        info = os.fstat(stream.fileno())
        if info.st_uid!=0 or info.st_mode&0o022 or not stat.S_ISREG(info.st_mode):
            raise ValueError('untrusted sysroot lock')
        lock = json.load(stream)
    if hashlib.sha256(canonical(lock)).hexdigest()!=lock_sha or lock.get('schema')!=1:
        raise ValueError('sysroot lock digest mismatch')
    if lock['generator_sha256']!=generator_digest():
        raise ValueError('sysroot generator changed; resolve a new lock')
    if lock['host_status_sha256']!=sha(Path('/var/lib/dpkg/status')) or lock['apt_metadata_sha256']!=apt_metadata_digest(apt):
        raise ValueError('host/private metadata changed; resolve a new lock after audit')
    installed = installed_versions()
    if lock['host_versions']!={name:list(value) for name,value in sorted(installed.items())}:
        raise ValueError('host package state changed')
    validate_downloads(lock['downloads'],installed,requirements())
    return lock


def normalize(root):
    # Root-private parent blocks access until all payload ownership/SUID bits
    # are normalized. No package is allowed to introduce privileged executables.
    for parent,directories,files in os.walk(root,topdown=False,followlinks=False):
        for name in directories+files:
            path = Path(parent)/name
            info = path.lstat()
            os.chown(path,0,0,follow_symlinks=False)
            if not stat.S_ISLNK(info.st_mode):
                path.chmod(0o555 if stat.S_ISDIR(info.st_mode) or info.st_mode&0o111 else 0o444)
    root.chmod(0o555)


def verify_tree(root,lock_sha):
    info=root.lstat()
    manifest=(root/'MANIFEST.json').lstat()
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or info.st_mode&0o222
            or not stat.S_ISREG(manifest.st_mode) or manifest.st_uid!=0 or manifest.st_mode&0o222):
        raise ValueError('private sysroot is not immutable/root-owned')
    document = json.loads((root/'MANIFEST.json').read_text())
    actual = [row for row in tree_manifest(root) if row['path']!='MANIFEST.json']
    if any(row['uid']!=0 or row['gid']!=0 or (row['type']!='link' and row['mode']&0o6222) for row in actual):
        raise ValueError('mutable or privileged sysroot member')
    if document.get('lock_sha256')!=lock_sha or document.get('rows')!=actual:
        raise ValueError('private sysroot integrity proof failed')
    return True


def stage(apt,lock_sha):
    lock = lock_read(apt,lock_sha)
    final = ROOT/'sysroot'/lock_sha
    if final.exists():
        verify_tree(final,lock_sha)
        print('Existing immutable sysroot verified; no extraction')
        return
    specs=[row['name']+'='+row['version'] for row in lock['downloads']]
    sandbox(['/usr/bin/apt-get','download',*specs],apt,cwd=apt/'downloads',apt_config=apt/'apt.conf')
    archives={}
    for path in (apt/'downloads').glob('*.deb'):
        info=path.lstat()
        if not stat.S_ISREG(info.st_mode): raise ValueError('archive is not a regular file')
        name=execute(['/usr/bin/dpkg-deb','-f',str(path),'Package']).strip()
        version=execute(['/usr/bin/dpkg-deb','-f',str(path),'Version']).strip()
        for row in lock['downloads']:
            if (row['name'],row['version'])==(name,version):
                if path.stat().st_size!=row['size'] or sha(path)!=row['sha256']:
                    raise ValueError('downloaded DEB SHA/size mismatch')
                if name in archives: raise ValueError('duplicate downloaded archive')
                archives[name]=path
    if set(archives)!={row['name'] for row in lock['downloads']}:
        raise ValueError('downloaded closure incomplete')
    try:
        from .verify_gz_abi import verify
        from .sysroot_profile import generate
    except ImportError:
        from verify_gz_abi import verify
        from sysroot_profile import generate
    # Vendor archive proof is supplemented by unchanged host dpkg versions;
    # installed vendor packages would need their own cached exact archive proof.
    verify(archives)
    (ROOT/'staging').mkdir(exist_ok=True,mode=0o700)
    (ROOT/'sysroot').mkdir(exist_ok=True,mode=0o755)
    temporary=Path(tempfile.mkdtemp(prefix=lock_sha+'-',dir=ROOT/'staging'))
    for path in (temporary/'tmp',temporary/'home'):
        path.mkdir(mode=0o700)
    for row in lock['downloads']:
        archive=archives[row['name']]
        inspect_deb(archive,temporary)
        sandbox(['/usr/bin/dpkg-deb','-x',str(archive),str(temporary)],temporary)
        if sum(path.stat().st_size for path in temporary.rglob('*') if path.is_file() and not path.is_symlink())>20*1024**3:
            raise ValueError('private sysroot disk envelope exceeded')
    generate(temporary,final,lock_sha)
    normalize(temporary)
    rows=tree_manifest(temporary)
    (temporary/'MANIFEST.json').write_bytes(canonical(dict(schema=1,lock_sha256=lock_sha,rows=rows))+b'\n')
    (temporary/'MANIFEST.json').chmod(0o444)
    verify_tree(temporary,lock_sha)
    temporary.rename(final)
    verify_tree(final,lock_sha)
    print('Immutable private sysroot verified; no manager or simulation started')


def snapshot():
    return dict(host=host_snapshot(),status=sha(Path('/var/lib/dpkg/status')),
                dpkg=execute(['/usr/bin/dpkg-query','-W','-f=${binary:Package}=${Version}\n']),
                usr=hashlib.sha256(canonical(tree_manifest(Path('/usr')))).hexdigest())


def run(operation,lock_sha=None):
    import fcntl
    os.umask(0o077)
    if os.geteuid()!=0: raise ValueError('server root only')
    if execute(['/usr/bin/dpkg','--print-architecture']).strip()!='amd64': raise ValueError('amd64 required')
    version=execute(['/usr/bin/python3','-c','import sys; print(".".join(map(str,sys.version_info[:2])))']).strip()
    if version!='3.12': raise ValueError('Noble Python3.12 required')
    ensure_no_install_latch()
    with open('/var/lib/foothold/deploy.lock','a') as deployment:
        fcntl.flock(deployment,fcntl.LOCK_EX|fcntl.LOCK_NB)
        for name in ('common.sh','autodeploy.sh','deploy.sh','rollback.sh','prepare-release.sh','sim_control.py'):
            if Path(__file__).with_name(name).read_bytes()!=(Path('/opt/foothold/deploy-tools')/name).read_bytes():
                raise ValueError('install reviewed deployment fence tools first')
        guard=Path('/var/lib/foothold-sim/guard')
        guard_fd=None
        if guard.exists() or guard.is_symlink():
            guard_fd=os.open(guard/'deploy.lock',os.O_RDWR|os.O_NOFOLLOW)
            fcntl.flock(guard_fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            if any((guard/name).exists() or (guard/name).is_symlink() for name in ('state/unproven','setup-unproven')):
                raise ValueError('simulation cleanup unproven')
        ROOT.mkdir(exist_ok=True,mode=0o700)
        info=ROOT.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022:
            raise ValueError('private runtime root untrusted')
        if operation=='stage' and shutil.disk_usage(ROOT).free<20*1024**3:
            raise ValueError('private staging requires at least 20GiB free')
        journal=Path(tempfile.mkdtemp(prefix='proof-',dir=ROOT))
        before=snapshot()
        (journal/'before.json').write_bytes(canonical(before))
        pending=create_install_latch()
        # No finally clear: every exception/interruption retains the marker.
        apt=ROOT/'apt'
        apt.mkdir(exist_ok=True,mode=0o700)
        if operation=='resolve':
            setup_apt(apt)
            resolve(apt)
        elif operation=='stage':
            stage(apt,lock_sha)
        elif operation=='verify':
            lock_read(apt,lock_sha)
            verify_tree(ROOT/'sysroot'/lock_sha,lock_sha)
        else: raise ValueError('invalid private sysroot operation')
        after=snapshot()
        (journal/'after.json').write_bytes(canonical(after))
        verify_host_unchanged(before,after)
        clear_install_latch(pending)
        if guard_fd is not None: os.close(guard_fd)
        print('System package DB, /usr content, GPU/DCGM and existing service identities unchanged')


if __name__=='__main__':
    try:
        parser=argparse.ArgumentParser(description=__doc__)
        parser.add_argument('operation',choices=('resolve','stage','verify'))
        parser.add_argument('lock_sha',nargs='?')
        args=parser.parse_args()
        if args.operation!='resolve' and (args.lock_sha is None or not HASH.fullmatch(args.lock_sha)):
            raise ValueError('full lock SHA required')
        run(args.operation,args.lock_sha)
    except Exception as error:
        raise SystemExit('Private sysroot preparation refused ('+type(error).__name__+'); preserve marker/evidence and escalate') from None
