"""Explicit replacements for skipped maintainer scripts, never host defaults."""
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
from .sim_sysroot import canonical,sha

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


def links(root):
    result={}
    for parent,directories,files in os.walk(root,followlinks=False):
        for leaf in directories+files:
            path=Path(parent)/leaf
            if stat.S_ISLNK(path.lstat().st_mode):result[str(path.relative_to(root))]=os.readlink(path)
    return result


def inside(root,path):
    class LocalLinks:
        def __contains__(self,key):
            try:return stat.S_ISLNK((root/key).lstat().st_mode)
            except FileNotFoundError:return False
        def __getitem__(self,key):return os.readlink(root/key)
    relative=archive.resolve(str(path).lstrip('/'),LocalLinks())
    target=root/relative
    # resolve() above is root-relative. Never Path.resolve an absolute DEB link.
    return target


def ordinary(root,path):
    try:return stat.S_ISREG(inside(root,path).lstat().st_mode)
    except FileNotFoundError:return False


def put(root,path,body,executable=False):
    target=inside(root,path)
    target.parent.mkdir(parents=True,exist_ok=True)
    if target.exists() and not stat.S_ISREG(target.lstat().st_mode):raise ValueError('generated file collision')
    target.write_bytes(body if isinstance(body,bytes) else body.encode())
    target.chmod(0o755 if executable else 0o644)


def executable_alias(root,alias,target):
    provider=inside(root,target)
    if not ordinary(root,target) or not provider.lstat().st_mode&0o111:
        raise ValueError('reviewed rootfs interpreter/provider absent')
    if ordinary(root,alias):
        if not inside(root,alias).lstat().st_mode&0o111:raise ValueError('non-executable interpreter alias')
        return
    # Follow links only through the root-relative resolver. A skipped postinst
    # may have left an /etc/alternatives target absent; fill that target.
    destination=inside(root,alias)
    destination.parent.mkdir(parents=True,exist_ok=True)
    if destination.exists() or destination.is_symlink():raise ValueError('interpreter alias collision')
    destination.symlink_to(target)


def profile(root,aliases):
    ros=root/'opt/ros/jazzy'
    if not ros.is_dir() or ros.is_symlink():raise ValueError('complete ROS prefix absent')
    prefixes=[ros]+sorted(path for path in (ros/'opt').glob('*') if stat.S_ISDIR(path.lstat().st_mode))
    existing=lambda paths:[p for p in paths if p.exists() and stat.S_ISDIR(p.lstat().st_mode)]
    absolute=lambda path:'/'+str(path.relative_to(root))
    libdirs=existing([root/'usr/lib/x86_64-linux-gnu',root/'usr/lib']+[p/'lib' for p in prefixes]+[p/'lib/x86_64-linux-gnu' for p in prefixes])
    runtime=root/'foothold-runtime';(runtime/'lib').mkdir(parents=True)
    candidates={}
    for parent,directories,files in os.walk(root,followlinks=False):
        for name in sorted(files):
            path=Path(parent)/name;info=path.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_size<64:continue
            with path.open('rb') as source:
                if source.read(4)!=b'\x7fELF':continue
                with mmap.mmap(source.fileno(),0,access=mmap.ACCESS_READ) as data:value=soname(data)
            if value is None:continue
            if '/' in value or not re.fullmatch(r'[A-Za-z0-9_.+\-]+',value):raise ValueError('unsafe SONAME')
            candidates.setdefault(value,[]).append(path)
    for name,paths in sorted(candidates.items()):
        if any(ordinary(root,absolute(directory/name)) for directory in libdirs):continue
        chosen=aliases.get(name)
        if chosen is not None:
            target=inside(root,chosen)
            if target not in paths:raise ValueError('explicit SONAME provider does not match')
        else:
            if len({sha(p) for p in paths})!=1:raise ValueError('ambiguous skipped-alternatives library; explicit recipe required')
            target=paths[0]
        (runtime/'lib'/name).symlink_to(absolute(target))
    for key in aliases:
        if key not in candidates:raise ValueError('unused/unproven library alias')
    if not ordinary(root,'/usr/lib/x86_64-linux-gnu/libEGL_mesa.so.0'):raise ValueError('software EGL absent')
    put(root,'/foothold-runtime/egl_vendor.d/50_mesa.json',canonical({
        'file_format_version':'1.0.0','ICD':{'library_path':'/usr/lib/x86_64-linux-gnu/libEGL_mesa.so.0'}}))
    config=set();systems=set();engines=set();resources=set()
    for parent,directories,files in os.walk(ros,followlinks=False):
        path=Path(parent)
        if path.name in ('media','resources','gz-rendering8','gz-sim8'):resources.add(path)
        for name in files:
            if name.endswith('.yaml') and 'gz' in path.parts:config.add(path)
            if name.startswith('libgz-sim8-'):systems.add(path)
            if name.startswith('libgz-rendering8-ogre2.so'):engines.add(path)
    if not config or not engines or not systems:raise ValueError('Gazebo vendor paths incomplete')
    python=existing([ros/'lib/python3.12/site-packages',ros/'local/lib/python3.12/dist-packages',root/'usr/lib/python3/dist-packages'])
    resources.update(existing([p/'share' for p in prefixes]))
    join=lambda paths:':'.join(absolute(p) for p in paths)
    return dict(**SOFTWARE,PATH=join(existing([p/'bin' for p in prefixes]))+':/usr/bin:/bin',
        LD_LIBRARY_PATH=join([runtime/'lib',*libdirs]),PYTHONPATH=join(python),
        AMENT_PREFIX_PATH='/opt/ros/jazzy',CMAKE_PREFIX_PATH='/opt/ros/jazzy',
        GZ_CONFIG_PATH=join(sorted(config)),GZ_SIM_RESOURCE_PATH=join(sorted(resources)),
        GZ_SIM_SYSTEM_PLUGIN_PATH=join(sorted(systems)+libdirs),GZ_RENDERING_ENGINE_PATH=join(sorted(engines)+libdirs),
        GZ_RENDERING_RESOURCE_PATH=join(sorted(resources)),__EGL_VENDOR_LIBRARY_DIRS='/foothold-runtime/egl_vendor.d',
        LIBGL_DRIVERS_PATH='/usr/lib/x86_64-linux-gnu/dri')


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
    for value in ('usr','usr/lib','usr/lib/x86_64-linux-gnu','usr/share','opt','opt/ros','opt/ros/jazzy','etc','var','run'):
        path=root/value
        if not path.exists():path.mkdir(parents=True)
        if not stat.S_ISDIR(path.lstat().st_mode):raise ValueError('generated namespace parent must be an ordinary directory')
    for alias,target in (('/usr/bin/sh','/usr/bin/dash'),('/usr/bin/python3','/usr/bin/python3.12'),
            ('/usr/bin/ruby','/usr/bin/ruby3.2'),('/usr/bin/awk','/usr/bin/gawk')):
        executable_alias(root,alias,target)
    # This list is the reviewed, deterministic replacement for postinst actions.
    put(root,'/etc/passwd',f'root:x:0:0:root:/root:/usr/sbin/nologin\nfoothold-sim:x:{uid}:{gid}:simulation:/var/lib/foothold-sim:/usr/sbin/nologin\n')
    put(root,'/etc/group',f'root:x:0:\nfoothold-sim:x:{gid}:\n')
    put(root,'/etc/nsswitch.conf','passwd: files\ngroup: files\nshadow: files\nhosts: files dns\n')
    put(root,'/etc/hosts','127.0.0.1 localhost foothold-sim\n::1 localhost\n')
    put(root,'/etc/hostname','foothold-sim\n')
    put(root,'/etc/resolv.conf','# Runtime clients use explicit loopback endpoints.\n')
    put(root,'/etc/machine-id',hashlib.sha256((recipe_sha+'machine-id').encode()).hexdigest()[:32]+'\n')
    put(root,'/etc/ld.so.conf','/usr/lib/x86_64-linux-gnu\n/usr/lib\n')
    if (root/'etc/ld.so.cache').is_symlink():raise ValueError('unexpected loader cache link')
    (root/'etc/ld.so.cache').unlink(missing_ok=True)  # no host or rootfs ldconfig
    certs=[]
    for path in sorted((root/'usr/share/ca-certificates').rglob('*.crt')):
        if stat.S_ISREG(path.lstat().st_mode):certs.append(path.read_bytes().rstrip()+b'\n')
    if not certs:raise ValueError('rootfs CA sources absent')
    put(root,'/etc/ssl/certs/ca-certificates.crt',b''.join(certs))
    put(root,'/usr/local/lib/python3.12/dist-packages/foothold-control.pth','/foothold-runtime/control\n')
    put(root,'/etc/systemd/user/foothold-simmgr.service',manager_unit(recipe_sha))
    put(root,'/etc/systemd/user/foothold-sim.slice',Path(__file__).with_name('foothold-sim.slice').read_bytes())
    socket=root/'etc/systemd/user/sockets.target.wants/dbus.socket';socket.parent.mkdir(parents=True,exist_ok=True)
    if socket.exists() or socket.is_symlink():raise ValueError('unexpected dbus socket enablement')
    socket.symlink_to('/usr/lib/systemd/user/dbus.socket')
    # Bind mount targets are explicit, not created implicitly by PID1 at launch.
    for path in (CODE+'/apps/server',CODE+'/apps/contracts',CODE+'/apps/agent',CODE+'/apps/simmgr',
            '/etc/foothold-sim','/var/lib/foothold-sim/guard','/var/lib/foothold-sim/replay',
            '/var/lib/foothold-sim/native-output',CODE+'/runs/server-sim',CODE+'/tmp/p1c/startup',
            ASSETS,STAGE,'/run/user/'+str(uid),'/proc','/sys','/dev','/tmp','/var/tmp'):
        inside(root,path).mkdir(parents=True,exist_ok=True)
    for path in [CODE+'/COMMIT','/run/foothold-sim-proof.sock',*config['mesh_targets']]:put(root,path,b'')
    environment=profile(root,config['library_aliases'])
    put(root,'/foothold-runtime/child-profile.json',canonical(dict(schema=1,env=environment)))
    setup=''.join('export '+key+'='+shlex.quote(value)+'\n' for key,value in sorted(environment.items()))
    setup+='source /opt/ros/jazzy/setup.bash\n'
    put(root,'/foothold-runtime/ros-setup.bash',setup)
    put(root,'/foothold-runtime/probe.py',Path(__file__).with_name('rootfs_probe.py').read_bytes())
