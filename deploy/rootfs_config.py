"""Explicit replacements for skipped maintainer scripts, never host defaults."""
from contextlib import contextmanager
import hashlib
import json
import mmap
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import stat

from . import rootfs_archive as archive
from .sysroot_elf import soname
from .sim_sysroot import canonical

CODE='/opt/foothold/current'
ASSETS='/opt/foothold-sim/assets/source'
SPEC=ASSETS+'/sensor-spec-20261016'
STAGE=SPEC+'/stage'
IDENTITY=Path('/foothold-runtime/identity.json')
SOFTWARE=dict(LIBGL_ALWAYS_SOFTWARE='true',GALLIUM_DRIVER='llvmpipe',MESA_LOADER_DRIVER_OVERRIDE='swrast',
    EGL_PLATFORM='surfaceless',MESA_SHADER_CACHE_DISABLE='true',LP_NUM_THREADS='2',QT_QPA_PLATFORM='offscreen')


def validate_config(config):
    if (set(config)!={'uid','gid','mesh_targets','library_aliases'}
            or any(type(config[key]) is not int or not 100<=config[key]<=65533 for key in ('uid','gid'))
            or not isinstance(config['mesh_targets'],list) or len(config['mesh_targets'])!=2
            or len(set(config['mesh_targets']))!=2 or not isinstance(config['library_aliases'],dict)):
        raise ValueError('explicit dedicated identity/two mesh targets required')
    for value in config['mesh_targets']:
        path=PurePosixPath(value)
        archive.name(value,target=True)
        if not path.is_absolute() or '..' in path.parts or not value.startswith('/home/') or value.endswith('/'):
            raise ValueError('mesh binding must be one absolute private file')
    for key,value in config['library_aliases'].items():
        if not re.fullmatch(r'lib[A-Za-z0-9_.+\-]+\.so(?:\.[0-9]+)*',key):raise ValueError('invalid library alias')
        if not value.startswith(('/usr/lib/','/opt/ros/jazzy/')) or '..' in PurePosixPath(value).parts:
            raise ValueError('library alias must stay inside rootfs libraries')
    return config


class RootTree:
    """Anchor every payload read/write to an opened root and no-follow parents."""
    def __init__(self,root):
        self.root=Path(root)
        self.fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)

    def __enter__(self):return self
    def __exit__(self,*args):os.close(self.fd)

    def relative(self,value,*,follow_final=True):
        value=archive.name(str(value),target=True)
        tree=self
        class LocalLinks:
            def __contains__(self,key):
                try:return stat.S_ISLNK(tree.raw_stat(key).st_mode)
                except FileNotFoundError:return False
            def __getitem__(self,key):
                parent,_,leaf=key.rpartition('/')
                fd=archive.directory(tree.fd,parent)
                try:return os.readlink(leaf,dir_fd=fd)
                finally:os.close(fd)
        if follow_final:return archive.resolve(value,LocalLinks())
        path=PurePosixPath(value)
        if path.name in ('','/','.','..'):
            return archive.resolve(value,LocalLinks())
        parent=archive.resolve(str(path.parent),LocalLinks())
        return '/'.join(filter(None,(parent,path.name)))

    def raw_stat(self,relative):
        if not relative:return os.fstat(self.fd)
        archive.name(relative)  # canonical root-relative paths only
        if relative in ('.','..'):raise ValueError('invalid generator leaf')
        parent,_,leaf=relative.rpartition('/')
        fd=archive.directory(self.fd,parent)
        try:return os.stat(leaf,dir_fd=fd,follow_symlinks=False)
        finally:os.close(fd)

    def info(self,value,*,follow_final=True):
        return self.raw_stat(self.relative(value,follow_final=follow_final))

    def exists(self,value,*,follow_final=False):
        try:self.info(value,follow_final=follow_final);return True
        except FileNotFoundError:return False

    def ordinary(self,value):
        try:return stat.S_ISREG(self.info(value).st_mode)
        except FileNotFoundError:return False

    def real_directory(self,value):
        try:return stat.S_ISDIR(self.info(value,follow_final=False).st_mode)
        except FileNotFoundError:return False

    def mkdir(self,value):
        fd=archive.directory(self.fd,self.relative(value),create=True)
        os.close(fd)

    @contextmanager
    def reader(self,value):
        relative=self.relative(value);parent,_,leaf=relative.rpartition('/')
        fd=archive.directory(self.fd,parent)
        try:
            source=os.open(leaf,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,dir_fd=fd)
        finally:os.close(fd)
        with os.fdopen(source,'rb') as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):raise ValueError('non-regular generator input')
            yield stream

    def read(self,value):
        with self.reader(value) as stream:return stream.read()

    def sha(self,value):
        digest=hashlib.sha256()
        with self.reader(value) as stream:
            for chunk in iter(lambda:stream.read(1024*1024),b''):digest.update(chunk)
        return digest.hexdigest()

    def write(self,value,body,executable=False):
        relative=self.relative(value);parent,_,leaf=relative.rpartition('/')
        fd=archive.directory(self.fd,parent,create=True)
        try:
            output=os.open(leaf,os.O_WRONLY|os.O_CREAT|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,0o600,dir_fd=fd)
        finally:os.close(fd)
        with os.fdopen(output,'wb') as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):raise ValueError('non-regular generated file')
            stream.truncate(0)
            stream.write(body if isinstance(body,bytes) else body.encode())
            stream.flush();os.fchmod(stream.fileno(),0o755 if executable else 0o644)

    def symlink(self,value,target):
        relative=self.relative(value,follow_final=False);parent,_,leaf=relative.rpartition('/')
        fd=archive.directory(self.fd,parent,create=True)
        try:os.symlink(target,leaf,dir_fd=fd)
        finally:os.close(fd)

    def remove_regular(self,value):
        relative=self.relative(value,follow_final=False);parent,_,leaf=relative.rpartition('/')
        fd=archive.directory(self.fd,parent)
        try:
            try:info=os.stat(leaf,dir_fd=fd,follow_symlinks=False)
            except FileNotFoundError:return
            if not stat.S_ISREG(info.st_mode):raise ValueError('unexpected loader cache node')
            os.unlink(leaf,dir_fd=fd)
        finally:os.close(fd)

    def entries(self,value):
        relative=self.relative(value)
        fd=archive.directory(self.fd,relative)
        try:
            return [(PurePosixPath('/')/relative/name,os.stat(name,dir_fd=fd,follow_symlinks=False))
                    for name in sorted(os.listdir(fd))]
        finally:os.close(fd)

    def walk(self,value='/'):
        for path,info in self.entries(value):
            yield path,info
            if stat.S_ISDIR(info.st_mode):yield from self.walk(path)


def inside(root,path):
    with RootTree(root) as tree:return Path(root)/tree.relative(path)


def ordinary(root,path):
    with RootTree(root) as tree:return tree.ordinary(path)


def put(root,path,body,executable=False):
    with RootTree(root) as tree:tree.write(path,body,executable)


def _executable_alias(tree,alias,target):
    if not tree.ordinary(target) or not tree.info(target).st_mode&0o111:
        raise ValueError('reviewed rootfs interpreter/provider absent')
    if tree.ordinary(alias):
        if not tree.info(alias).st_mode&0o111:raise ValueError('non-executable interpreter alias')
        return
    destination=tree.relative(alias)
    if tree.exists(destination):raise ValueError('interpreter alias collision')
    tree.symlink(destination,target)


def executable_alias(root,alias,target):
    with RootTree(root) as tree:_executable_alias(tree,alias,target)


def generator_source(name):
    # These two reviewed generator inputs are intentionally outside the payload.
    if name not in ('foothold-sim.slice','rootfs_probe.py'):raise ValueError('unapproved generator source')
    fd=os.open(Path(__file__).resolve(strict=True).parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:source=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,dir_fd=fd)
    finally:os.close(fd)
    with os.fdopen(source,'rb') as stream:
        info=os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size>1024**2:raise ValueError('invalid generator source')
        return stream.read()


def _profile(tree,aliases):
    ros=PurePosixPath('/opt/ros/jazzy')
    if not tree.real_directory(ros):raise ValueError('complete ROS prefix absent')
    prefixes=[ros]+[path for path,info in tree.entries(ros/'opt') if stat.S_ISDIR(info.st_mode)]
    existing=lambda paths:[p for p in paths if tree.real_directory(p)]
    libdirs=existing([PurePosixPath('/usr/lib/x86_64-linux-gnu'),PurePosixPath('/usr/lib')]+
        [p/'lib' for p in prefixes]+[p/'lib/x86_64-linux-gnu' for p in prefixes])
    runtime=PurePosixPath('/foothold-runtime');tree.mkdir(runtime/'lib')
    candidates={}
    for path,info in tree.walk():
        if not stat.S_ISREG(info.st_mode) or info.st_size<64:continue
        with tree.reader(path) as source:
            if source.read(4)!=b'\x7fELF':continue
            with mmap.mmap(source.fileno(),0,access=mmap.ACCESS_READ) as data:value=soname(data)
        if value is None:continue
        if '/' in value or not re.fullmatch(r'[A-Za-z0-9_.+\-]+',value):raise ValueError('unsafe SONAME')
        candidates.setdefault(value,[]).append(path)
    for name,paths in sorted(candidates.items()):
        if any(tree.ordinary(directory/name) for directory in libdirs):continue
        chosen=aliases.get(name)
        if chosen is not None:
            target=PurePosixPath('/')/tree.relative(chosen)
            if target not in paths:raise ValueError('explicit SONAME provider does not match')
        else:
            if len({tree.sha(p) for p in paths})!=1:raise ValueError('ambiguous skipped-alternatives library; explicit recipe required')
            target=paths[0]
        tree.symlink(runtime/'lib'/name,str(target))
    for key in aliases:
        if key not in candidates:raise ValueError('unused/unproven library alias')
    if not tree.ordinary('/usr/lib/x86_64-linux-gnu/libEGL_mesa.so.0'):raise ValueError('software EGL absent')
    tree.write('/foothold-runtime/egl_vendor.d/50_mesa.json',canonical({
        'file_format_version':'1.0.0','ICD':{'library_path':'/usr/lib/x86_64-linux-gnu/libEGL_mesa.so.0'}}))
    config=set();systems=set();engines=set();resources=set()
    for path,info in tree.walk(ros):
        if stat.S_ISDIR(info.st_mode):
            if path.name in ('media','resources','gz-rendering8','gz-sim8'):resources.add(path)
            continue
        if path.name.endswith('.yaml') and 'gz' in path.parent.parts:config.add(path.parent)
        if path.name.startswith('libgz-sim8-'):systems.add(path.parent)
        if path.name.startswith('libgz-rendering8-ogre2.so'):engines.add(path.parent)
    if not config or not engines or not systems:raise ValueError('Gazebo vendor paths incomplete')
    python=existing([ros/'lib/python3.12/site-packages',ros/'local/lib/python3.12/dist-packages',PurePosixPath('/usr/lib/python3/dist-packages')])
    resources.update(existing([p/'share' for p in prefixes]))
    join=lambda paths:':'.join(map(str,paths))
    return dict(**SOFTWARE,PATH=join(existing([p/'bin' for p in prefixes]))+':/usr/bin:/bin',
        LD_LIBRARY_PATH=join([runtime/'lib',*libdirs]),PYTHONPATH=join(python),
        AMENT_PREFIX_PATH='/opt/ros/jazzy',CMAKE_PREFIX_PATH='/opt/ros/jazzy',
        GZ_CONFIG_PATH=join(sorted(config)),GZ_SIM_RESOURCE_PATH=join(sorted(resources)),
        GZ_SIM_SYSTEM_PLUGIN_PATH=join(sorted(systems)+libdirs),GZ_RENDERING_ENGINE_PATH=join(sorted(engines)+libdirs),
        GZ_RENDERING_RESOURCE_PATH=join(sorted(resources)),__EGL_VENDOR_LIBRARY_DIRS='/foothold-runtime/egl_vendor.d',
        LIBGL_DRIVERS_PATH='/usr/lib/x86_64-linux-gnu/dri')


def profile(root,aliases):
    with RootTree(root) as tree:return _profile(tree,aliases)


def manager_unit(recipe_sha):
    return f'''[Unit]
Description=Foothold rootfs simulation manager (explicit start only)

[Service]
Type=exec
Slice=foothold-sim.slice
WorkingDirectory={CODE}
EnvironmentFile=/etc/foothold-sim/manager.env
ExecStart=/usr/bin/env FH_SIM_ROOTFS_LOCK={recipe_sha} FH_SIM_DEPLOY_GUARD_DIR=/var/lib/foothold-sim/guard FH_SIM_PROC_PROOF_SOCKET=/run/foothold-sim-proof.sock PYTHONPATH={CODE}/apps/agent:{CODE} PYTHONDONTWRITEBYTECODE=1 /usr/bin/python3 -m apps.simmgr
Restart=no
KillMode=process
KillSignal=SIGTERM
SendSIGKILL=no
TimeoutStopSec=180
UMask=0077
NoNewPrivileges=yes
'''


def generate(root,config,recipe_sha):
    validate_config(config)
    if not re.fullmatch('[0-9a-f]{64}',recipe_sha):raise ValueError('recipe SHA required')
    uid,gid=config['uid'],config['gid']
    with RootTree(root) as tree:
        for value in ('usr','usr/lib','usr/lib/x86_64-linux-gnu','usr/share','opt','opt/ros','opt/ros/jazzy','etc','var','run'):
            if not tree.exists(value):tree.mkdir(value)
            if not tree.real_directory(value):raise ValueError('generated namespace parent must be an ordinary directory')
        for alias,target in (('/usr/bin/sh','/usr/bin/dash'),('/usr/bin/python3','/usr/bin/python3.12'),
                ('/usr/bin/ruby','/usr/bin/ruby3.2'),('/usr/bin/awk','/usr/bin/gawk')):
            _executable_alias(tree,alias,target)
        # Deterministic replacements for skipped scripts, all anchored to root.
        tree.write('/etc/passwd',f'root:x:0:0:root:/root:/usr/sbin/nologin\nfoothold-sim:x:{uid}:{gid}:simulation:/var/lib/foothold-sim:/usr/sbin/nologin\n')
        tree.write('/etc/group',f'root:x:0:\nfoothold-sim:x:{gid}:\n')
        tree.write('/etc/nsswitch.conf','passwd: files\ngroup: files\nshadow: files\nhosts: files dns\n')
        tree.write('/etc/hosts','127.0.0.1 localhost foothold-sim\n::1 localhost\n')
        tree.write('/etc/hostname','foothold-sim\n')
        tree.write('/etc/resolv.conf','# Runtime clients use explicit loopback endpoints.\n')
        tree.write('/etc/machine-id',hashlib.sha256((recipe_sha+'machine-id').encode()).hexdigest()[:32]+'\n')
        tree.write('/etc/ld.so.conf','/usr/lib/x86_64-linux-gnu\n/usr/lib\n')
        tree.remove_regular('/etc/ld.so.cache')  # never run host/rootfs ldconfig
        certs=[tree.read(path).rstrip()+b'\n' for path,info in tree.walk('/usr/share/ca-certificates')
               if path.suffix=='.crt' and stat.S_ISREG(info.st_mode)]
        if not certs:raise ValueError('rootfs CA sources absent')
        tree.write('/etc/ssl/certs/ca-certificates.crt',b''.join(certs))
        tree.write('/usr/local/lib/python3.12/dist-packages/foothold-control.pth','/foothold-runtime/control\n')
        tree.write('/etc/systemd/user/foothold-simmgr.service',manager_unit(recipe_sha))
        tree.write('/etc/systemd/user/foothold-sim.slice',generator_source('foothold-sim.slice'))
        tree.symlink('/etc/systemd/user/sockets.target.wants/dbus.socket','/usr/lib/systemd/user/dbus.socket')
        for path in (CODE+'/apps/server',CODE+'/apps/contracts',CODE+'/apps/agent',CODE+'/apps/simmgr',
                '/etc/foothold-sim','/var/lib/foothold-sim/guard','/var/lib/foothold-sim/replay',
                '/var/lib/foothold-sim/native-output',CODE+'/runs/server-sim',CODE+'/tmp/p1c/startup',
                ASSETS,STAGE,'/run/user/'+str(uid),'/proc','/sys','/dev','/tmp','/var/tmp'):
            tree.mkdir(path)
        for path in [CODE+'/COMMIT','/run/foothold-sim-proof.sock','/run/systemd/notify',
                '/run/host/os-release','/run/systemd/journal/socket','/run/systemd/journal/stdout',
                '/dev/log',*config['mesh_targets']]:tree.write(path,b'')
        environment=_profile(tree,config['library_aliases'])
        tree.write('/foothold-runtime/child-profile.json',canonical(dict(schema=1,env=environment)))
        setup=''.join('export '+key+'='+shlex.quote(value)+'\n' for key,value in sorted(environment.items()))
        setup+='source /opt/ros/jazzy/setup.bash\n'
        tree.write('/foothold-runtime/ros-setup.bash',setup)
        tree.write('/foothold-runtime/probe.py',generator_source('rootfs_probe.py'))
