"""Dedicated-UID RootDirectory pairing. No global template or GPU/library bind.

prepare/probe/activate are explicit, reviewed server-root operations, never invoked
by bootstrap. Ordinary deploy/rollback only rebind an already validated idle pair.
"""
import sys
sys.dont_write_bytecode=True
import argparse
import fcntl
import json
import os
from pathlib import Path, PurePosixPath
import pwd
import grp
import re
import shutil
import stat
import subprocess
import time

from . import rootfs_build as build, rootfs_config as config, sim_sysroot as shared
from .install_sim_packages import create_install_latch,clear_install_latch

CONFIG=Path('/etc/foothold-sim/rootfs-runtime.json')
GUARD=Path('/var/lib/foothold-sim/guard')
VALIDATION=Path('/var/lib/foothold-sim/rootfs-validation.json')
CURRENT=Path('/opt/foothold/current')
FAMILIES=('fh-rb-sim-*.service','fh-simmgr-agent-*.service','fh-simmgr-nav2-*.service','fh-simmgr-observer-*.service')


def run(args):return subprocess.run(args,check=True,capture_output=True,text=True,timeout=200).stdout


def unit_state(unit):
    return dict(line.split('=',1) for line in run(['systemctl','show',unit,
        '--property=LoadState,ActiveState,MainPID,ControlGroup']).splitlines() if '=' in line)


def rootfs(data):
    value=data['recipe_sha256']
    if not isinstance(value,str) or not shared.HASH.fullmatch(value):raise ValueError('explicit rootfs recipe SHA required')
    return build.ROOT/value


def load():
    data=build.private_json(CONFIG)
    if set(data)!={'schema','recipe_sha256','manifest_sha256','asset_source','asset_manifest_sha256',
            'plugin_rel','policy_rel','setup_identity'} or data['schema']!=1:
        raise ValueError('rootfs runtime configuration invalid')
    for key in ('recipe_sha256','manifest_sha256','asset_manifest_sha256'):
        if not shared.HASH.fullmatch(data[key]):raise ValueError('rootfs runtime hash invalid')
    complete=build.completion(rootfs(data),data['recipe_sha256'])
    if complete['manifest_sha256']!=data['manifest_sha256']:raise ValueError('rootfs completion differs from runtime')
    recipe=build.private_json(rootfs(data)/'RECIPE.json',0o400)
    config.validate_config(recipe['config'])
    data['identity']=recipe['config']
    return data


def identity(data):
    user=pwd.getpwnam('foothold-sim');group=grp.getgrnam('foothold-sim')
    expected=data['identity']
    if (user.pw_uid!=expected['uid'] or user.pw_gid!=expected['gid'] or group.gr_gid!=expected['gid']
            or user.pw_shell!='/usr/sbin/nologin' or user.pw_dir!='/var/lib/foothold-sim'
            or os.getgrouplist(user.pw_name,user.pw_gid)!=[user.pw_gid]):
        raise ValueError('dedicated identity or groups differ; no privilege repair')
    return user.pw_uid,user.pw_gid


def assets(data):
    source=Path(data['asset_source']);prefix=shared.ROOT/'assets'
    if (not source.is_relative_to(prefix) or len(source.relative_to(prefix).parts)!=2
            or source.name!='source' or not shared.HASH.fullmatch(source.parent.name)):
        raise ValueError('asset source must be sealed private container')
    manifest=source.parent/'MANIFEST.json'
    document=build.private_json(manifest,0o400)
    if shared.sha(manifest)!=data['asset_manifest_sha256']:raise ValueError('asset manifest changed')
    actual=[row for row in shared.tree_manifest(source.parent) if row['path']!='MANIFEST.json']
    if document!={'schema':1,'rows':actual}:raise ValueError('actual sealed asset tree differs')
    for row in actual:
        if row['uid']!=0 or row['gid']!=0 or row['mode']&0o222 or row['mode']&0o7000 or row['type']=='link':
            raise ValueError('assets must be root-owned immutable ordinary paths')
    for key,expected in (('plugin_rel','cf8365adce9108fff7e6541b8f109756b48475afddb7bca42df37f42f9877a70'),
                         ('policy_rel','a162d3bff81611de0ac60cd5aeb08dea3a3d06445992137d02b75c5bf3e604b8')):
        relative=build.archive.name(data[key])
        if relative.startswith('/') or shared.sha(source/relative)!=expected:raise ValueError('native asset pin differs')
    for index in range(2):
        mesh=source.parent/'meshes'/str(index)
        if not stat.S_ISREG(mesh.lstat().st_mode):raise ValueError('two sealed mesh files required')
    return source


def private_settings(data):
    # Do not source arbitrary configuration as a root shell.
    import shlex
    env=dict(word.split('=',1) for word in shlex.split(private_text(Path('/etc/foothold-sim/manager.env'),0,(0o640,))))
    required=dict(FH_SIM_RUN='1',FH_SIM_DOMAIN='93',FH_SIM_MAX_ROBOTS='1',FH_SIM_PORT='9430',
        FH_SIM_AGENT_HOST='127.0.0.1',FH_SIM_AGENT_WS_URL='ws://127.0.0.1:8810/api/v1/agent/ws',
        SIM_SOURCE=config.STAGE+'/sensor-runtime-r1',SIM_ROS_SETUP='/foothold-runtime/ros-setup.bash',
        SIM_RUN_DIR=config.CODE+'/runs/server-sim',FH_SIM_AGENT_PYTHON='/usr/bin/python3',
        FH_SIM_NATIVE_PYTHON_DIR='/opt/foothold-sim/python-vendor',FH_SIM_RUNTIME_SECONDS='1800')
    if any(env.get(key)!=value for key,value in required.items()) or 'FH_SIM_SYSROOT_PROFILE' in env:
        raise ValueError('rootfs manager settings differ from reviewed namespace')
    if any(key.startswith('ROS_') or key in ('LD_LIBRARY_PATH','PYTHONPATH','AMENT_PREFIX_PATH') for key in env):
        raise ValueError('manager environment must stay ROS-free')
    catalogue=Path(env['FH_SIM_CATALOG'])
    if catalogue!=Path('/etc/foothold-sim/catalogue.json'):raise ValueError('fixed private catalogue required')
    raw=private_text(catalogue,0,(0o640,0o600));body=json.loads(raw)
    if [w['id'] for w in body['worlds']]!=['warehouse/f1'] or len(body['slots'])!=1:
        raise ValueError('only the first warehouse slot is authorized')


def private_text(path,owner,modes):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
    with os.fdopen(fd) as stream:
        info=os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=owner or stat.S_IMODE(info.st_mode) not in modes or info.st_size>1024**2:
            raise ValueError('private runtime file invalid')
        return stream.read()


def bindings(data,release,*,proof=True):
    uid=data['identity']['uid'];source=Path(data['asset_source'])
    readonly=[(release/'apps'/name,config.CODE+'/apps/'+name) for name in ('server','contracts','agent','simmgr')]
    readonly += [(release/'COMMIT',config.CODE+'/COMMIT'),(Path('/etc/foothold-sim'),'/etc/foothold-sim'),
        (source,config.ASSETS),(source/'sensor-spec-20261016/stage',config.STAGE)]
    readonly += [(source.parent/'meshes'/str(index),target) for index,target in enumerate(data['identity']['mesh_targets'])]
    readonly += [(Path('/run/systemd/journal/socket'),'/run/systemd/journal/socket'),
        (Path('/run/systemd/journal/stdout'),'/run/systemd/journal/stdout'),
        (Path('/run/systemd/journal/dev-log'),'/dev/log')]
    if proof:readonly.append((Path('/run/foothold-sim-proof.sock'),'/run/foothold-sim-proof.sock'))
    writable=[(Path('/run/user')/str(uid),'/run/user/'+str(uid))]
    for leaf,target in (('guard','/var/lib/foothold-sim/guard'),('replay','/var/lib/foothold-sim/replay'),
            ('native-output',config.SPEC),('episodes',config.CODE+'/runs/server-sim'),('startup',config.CODE+'/tmp/p1c/startup')):
        writable.append((Path('/var/lib/foothold-sim')/leaf,target))
    for source,target in readonly+writable:
        if any(c in str(source)+target for c in (' ','\n','\r','\t',':','%','\\')) or '..' in Path(target).parts:
            raise ValueError('binding contains systemd specifier/escape')
    # Parent output overlay must precede its read-only stage child.
    readonly.sort(key=lambda pair:(len(Path(pair[1]).parts),pair[1]))
    return readonly,writable


def properties(data,release,*,proof=True):
    readonly,writable=bindings(data,release,proof=proof)
    return dict(RootDirectory=str(rootfs(data)),MountAPIVFS='yes',PrivateUsers='yes',PrivateTmp='yes',
        PrivateDevices='yes',ProtectHome='tmpfs',ProtectSystem='strict',NoNewPrivileges='yes',
        CapabilityBoundingSet='',AmbientCapabilities='',RestrictSUIDSGID='yes',Restart='no',
        BindReadOnlyPaths=' '.join(str(source)+':'+target for source,target in readonly),
        BindPaths=' '.join(str(source)+':'+target for source,target in writable),
        ReadWritePaths=' '.join(target for _,target in writable),
        Environment='HOME=/var/lib/foothold-sim XDG_RUNTIME_DIR=/run/user/'+str(data['identity']['uid'])+
            ' XDG_CACHE_HOME=/run/user/'+str(data['identity']['uid'])+'/cache PYTHONDONTWRITEBYTECODE=1')


def dropin(data,release):
    values=properties(data,release)
    # Reset inherited namespace bindings; only this UID instance is touched.
    text='[Service]\nBindPaths=\nBindReadOnlyPaths=\nReadWritePaths=\n'
    text+=''.join(key+'='+value+'\n' for key,value in values.items())
    text+='ExecStart=\nExecStart=/usr/lib/systemd/systemd --user\nPAMName=\nWorkingDirectory=/var/lib/foothold-sim\n'
    return text


def dedicated_pids(uid):
    result=[]
    for path in Path('/proc').iterdir():
        if not path.name.isdigit():continue
        try:
            fields=(path/'status').read_text().splitlines()
            values=next(line.split()[1:] for line in fields if line.startswith('Uid:'))
            if str(uid) in values:result.append(int(path.name))
        except (FileNotFoundError,ProcessLookupError):pass
    return result


def no_dds_or_native():
    from .proc_proof_server import process_rows
    rows,denied=process_rows()
    if denied or any(r['domain']=='93' or r['partition'].startswith('fh-srv-') for r in rows):
        raise ValueError('native/domain93 process absence unproven')
    for line in run(['ss','-H','-lun']).splitlines():
        if 30650<=int(line.split()[3].rsplit(':',1)[-1])<=30899:raise ValueError('domain93 DDS ports remain')


def inactive_namespace(data):
    uid,_=identity(data);state=unit_state('user@'+str(uid)+'.service')
    if state.get('ActiveState')!='inactive' or state.get('MainPID')!='0' or dedicated_pids(uid):
        raise ValueError('dedicated namespace/PID absence unproven')
    group=state.get('ControlGroup')
    if group:
        events=Path('/sys/fs/cgroup')/group.lstrip('/')/'cgroup.events'
        if events.exists() and dict(line.split() for line in events.read_text().splitlines()).get('populated')!='0':
            raise ValueError('dedicated namespace cgroup populated')
    no_dds_or_native()


def stop_pair(stop_manager,userctl):
    data=load();uid,_=identity(data)
    try:
        state=unit_state('user@'+str(uid)+'.service')
        if state.get('ActiveState')=='inactive':inactive_namespace(data);return
        stop_manager()
        if userctl('list-units','--all','--plain','--no-legend','--no-pager',*FAMILIES).strip():
            raise ValueError('owned child units remain')
        no_dds_or_native()
        run(['systemctl','stop','user@'+str(uid)+'.service'])
        inactive_namespace(data)
    except BaseException:
        if not (GUARD/'setup-unproven').exists():create_install_latch(GUARD/'setup-unproven')
        raise


def validated(data):
    value=build.private_json(VALIDATION,0o400)
    if (value.get('recipe_sha256')!=data['recipe_sha256'] or value.get('manifest_sha256')!=data['manifest_sha256']
            or value.get('asset_manifest_sha256')!=data['asset_manifest_sha256']
            or any(value.get(k) is not True for k in ('llvmpipe','egl_render_readback','python_closure','native_abi','root_attested'))):
        raise ValueError('rootfs EGL/ABI validation absent or differs')
    return value


def attest(pid,data):
    uid,_=identity(data);root=rootfs(data);release=CURRENT.resolve(strict=True)
    before=Path('/proc/'+str(pid)+'/stat').read_text().rsplit(')',1)[1].split()[19]
    actual=Path('/proc/'+str(pid)+'/root')
    if (actual.stat().st_dev,actual.stat().st_ino)!=(root.stat().st_dev,root.stat().st_ino):
        raise ValueError('manager RootDirectory differs')
    values=next(line.split()[1:] for line in Path('/proc/'+str(pid)+'/status').read_text().splitlines() if line.startswith('Uid:'))
    if values!=[str(uid)]*4:raise ValueError('manager UID differs')
    if (actual/(config.CODE+'/COMMIT').lstrip('/')).read_text()!=(release/'COMMIT').read_text():
        raise ValueError('namespace code SHA differs')
    for name in ('server','contracts','agent','simmgr'):
        one=(actual/(config.CODE+'/apps/'+name).lstrip('/')).stat();two=(release/'apps'/name).stat()
        if (one.st_dev,one.st_ino)!=(two.st_dev,two.st_ino):raise ValueError('namespace app bind inode differs')
    if Path('/proc/'+str(pid)+'/stat').read_text().rsplit(')',1)[1].split()[19]!=before:
        raise ValueError('manager PID identity changed')
    validated(data);build.completion(root,data['recipe_sha256'])
    return True


def start_pair(start_manager,*,setup_identity=None):
    data=load();uid,_=identity(data);inactive_namespace(data)
    build.verify(rootfs(data),data['recipe_sha256']);assets(data);private_settings(data);validated(data)
    release=CURRENT.resolve(strict=True)
    if release.parent!=Path('/opt/foothold/releases') or (release/'COMMIT').read_text().strip()!=release.name:
        raise ValueError('exact release binding required')
    marker=GUARD/'setup-unproven'
    if setup_identity is None:setup_identity=create_install_latch(marker)
    else:
        info=marker.lstat()
        if (info.st_dev,info.st_ino)!=tuple(setup_identity):raise ValueError('setup marker changed')
    bind_namespace(data,release)
    run(['systemctl','start','foothold-sim-proof.socket'])
    run(['systemctl','start','user@'+str(uid)+'.service'])
    parent=unit_state('user@'+str(uid)+'.service')
    attest(int(parent['MainPID']),data)
    start_manager()
    clear_install_latch(tuple(setup_identity),marker)


def bind_namespace(data,release):
    uid=data['identity']['uid']
    path=Path('/etc/systemd/system/user@'+str(uid)+'.service.d/foothold-rootfs.conf')
    path.parent.mkdir(mode=0o755,parents=True,exist_ok=True)
    atomic(path,dropin(data,release),0o644)
    run(['systemctl','daemon-reload'])


def atomic(path,body,mode):
    temporary=path.with_name(path.name+'.next')
    fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,mode)
    with os.fdopen(fd,'w') as stream:
        stream.write(body);stream.flush();os.fsync(stream.fileno());os.fchmod(stream.fileno(),mode)
    os.replace(temporary,path)
    fd=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:os.fsync(fd)
    finally:os.close(fd)


def prepare_contents(input_path):
    if CONFIG.exists() or CONFIG.is_symlink() or GUARD.exists():raise ValueError('runtime already provisioned; no bootstrap/retry')
    data=build.private_json(input_path)
    if set(data)!={'schema','recipe_sha256','manifest_sha256','asset_source','asset_manifest_sha256','plugin_rel','policy_rel'}:
        raise ValueError('explicit private runtime input required')
    complete=build.verify(rootfs(data),data['recipe_sha256'])
    if complete['manifest_sha256']!=data['manifest_sha256']:raise ValueError('runtime manifest differs')
    recipe=build.private_json(rootfs(data)/'RECIPE.json',0o400);data['identity']=recipe['config'];assets(data)
    uid,gid=data['identity']['uid'],data['identity']['gid']
    for get,key in ((pwd.getpwnam,'foothold-sim'),(grp.getgrnam,'foothold-sim'),(pwd.getpwuid,uid),(grp.getgrgid,gid)):
        try:get(key)
        except KeyError:continue
        raise ValueError('dedicated name/UID/GID already exists; audit instead of adoption')
    run(['groupadd','--gid',str(gid),'foothold-sim'])
    run(['useradd','--system','--uid',str(uid),'--gid',str(gid),'--no-create-home','--home-dir','/var/lib/foothold-sim',
         '--shell','/usr/sbin/nologin','foothold-sim'])
    identity(data)
    for path in (Path('/var/lib/foothold-sim'),Path('/etc/foothold-sim')):
        path.mkdir(mode=0o750,exist_ok=True);os.chown(path,0,gid);path.chmod(0o750)
    for leaf in ('episodes','startup','native-output','replay'):
        path=Path('/var/lib/foothold-sim')/leaf;path.mkdir(mode=0o700);os.chown(path,uid,gid)
    stage=Path('/var/lib/foothold-sim/native-output/stage');stage.mkdir(mode=0o555)
    GUARD.mkdir(mode=0o755);os.chown(GUARD,0,0)
    state=GUARD/'state';state.mkdir(mode=0o700);os.chown(state,uid,gid)
    lock=GUARD/'deploy.lock';lock.touch(mode=0o660);os.chown(lock,0,gid);lock.chmod(0o660)
    setup=create_install_latch(GUARD/'setup-unproven')
    data.pop('identity');data['setup_identity']=list(setup)
    atomic(CONFIG,json.dumps(data,sort_keys=True)+'\n',0o600)
    # Future idle deploy/rollback must use the namespace-aware root helper.
    # The deployment lock and package latch prevent partial helper adoption.
    tool_names=('sim_control.py','rootfs_runtime.py','rootfs_build.py','rootfs_config.py',
        'rootfs_archive.py','rootfs_plan.py','sim_sysroot.py','install_sim_packages.py',
        'sysroot_profile.py','sysroot_link.py','sysroot_elf.py','verify_gz_abi.py','sim-package-versions.json')
    for name in tool_names:
        atomic(Path('/opt/foothold/deploy-tools')/name,Path(__file__).with_name(name).read_text(),0o644)
    # Copy only reviewed proof code/units; no Caddy, global user@ or bootstrap.
    for name in ('foothold-sim-proof.socket','foothold-sim-proof@.service'):
        atomic(Path('/etc/systemd/system')/name,Path(__file__).with_name(name).read_text(),0o644)
    atomic(Path('/opt/foothold/deploy-tools/proc_proof_server.py'),Path(__file__).with_name('proc_proof_server.py').read_text(),0o644)
    slice_path=Path('/etc/systemd/system/user-'+str(uid)+'.slice.d/foothold-sim.conf')
    slice_path.parent.mkdir(parents=True,mode=0o755)
    atomic(slice_path,Path(__file__).with_name('foothold-sim-user-slice.conf').read_text(),0o644)
    # No linger, enable, namespace, socket or manager start here.


def prepare(input_path):
    def persist(before,after,error,pending):
        details=dict(before=before,after=after)
        if error is None:
            try:shared.verify_host_unchanged(before,after)
            except ValueError as audit_error:error=audit_error
        if error is not None:
            details.update(error_type=type(error).__name__,latch_device=pending[0],latch_inode=pending[1])
            if type(error) is ValueError:details['reason']=str(error)
        path=Path('/var/lib/foothold/rootfs-prepare-audit.json')
        if path.exists() or path.is_symlink():raise ValueError('prior prepare audit exists; no automatic retry')
        atomic(path,json.dumps(details,sort_keys=True)+'\n',0o400)
    build.audited(lambda before:prepare_contents(input_path),persist)
    print('Dedicated rootfs account/definitions prepared; setup remains fenced; no runtime started')


def probe():
    data=load();uid,gid=identity(data);inactive_namespace(data)
    build.verify(rootfs(data),data['recipe_sha256']);assets(data);private_settings(data)
    if VALIDATION.exists() or VALIDATION.is_symlink():raise ValueError('validation already exists; no automatic probe retry')
    run(['systemctl','daemon-reload'])
    props=properties(data,CURRENT.resolve(strict=True),proof=False)
    for key in ('Restart','Environment'):props.pop(key)
    props.update(User='foothold-sim',Group='foothold-sim',Slice='user-'+str(uid)+'.slice',
        MemoryMax='1500M',MemorySwapMax='0',CPUQuota='200%',TasksMax='256',RuntimeMaxSec='120',
        KillMode='control-group',TimeoutStopSec='15',
        Requires='user-runtime-dir@'+str(uid)+'.service',After='user-runtime-dir@'+str(uid)+'.service')
    command=['systemd-run','--quiet','--wait','--collect','--pipe','--unit=foothold-rootfs-probe-'+data['recipe_sha256'][:16]]
    command += ['--property='+key+'='+value for key,value in props.items()]
    source=config.ASSETS+'/'
    root_stat=rootfs(data).stat()
    command += ['/usr/bin/env','-i','PATH=/usr/bin:/bin','HOME=/var/lib/foothold-sim','PYTHONDONTWRITEBYTECODE=1',
        'FH_SIM_ROOTFS_LOCK='+data['recipe_sha256'],'FH_SIM_PROBE_PLUGIN='+source+data['plugin_rel'],
        'FH_SIM_EXPECT_ROOT_DEV='+str(root_stat.st_dev),'FH_SIM_EXPECT_ROOT_INO='+str(root_stat.st_ino),
        'FH_SIM_PROBE_POLICY='+source+data['policy_rel'],'/bin/bash','-c',
        'set -e; source /foothold-runtime/ros-setup.bash; export ROS_DOMAIN_ID=93 ROS_AUTOMATIC_DISCOVERY_RANGE=LOCALHOST ROS_LOCALHOST_ONLY=1 GZ_IP=127.0.0.1; exec /usr/bin/python3 /foothold-runtime/probe.py']
    output=run(command)
    inactive_namespace(data)
    value=json.loads(output)
    if value.get('recipe_sha256')!=data['recipe_sha256'] or value.get('manifest_sha256')!=data['manifest_sha256']:
        raise ValueError('EGL/ABI probe result unbound')
    for key in ('llvmpipe','egl_render_readback','python_closure','native_abi','root_attested'):
        if value.get(key) is not True:raise ValueError('incomplete EGL/ABI result')
    value['asset_manifest_sha256']=data['asset_manifest_sha256']
    atomic(VALIDATION,json.dumps(value,sort_keys=True)+'\n',0o400)
    print('Rootfs CPU EGL render/readback and ABI passed; namespace/session not activated')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation',choices=('prepare','probe','activate'))
    parser.add_argument('--input',type=Path)
    args=parser.parse_args()
    os.umask(0o077)
    if os.geteuid()!=0:raise ValueError('server root only')
    shared.ensure_no_install_latch()
    with Path('/var/lib/foothold/deploy.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        if args.operation=='prepare':
            if args.input is None:raise ValueError('private runtime input required')
            prepare(args.input);return
        fd=os.open(GUARD/'deploy.lock',os.O_RDWR|os.O_NOFOLLOW|os.O_CLOEXEC)
        try:
            fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            state=GUARD/'state/unproven'
            if state.exists() or state.is_symlink():raise ValueError('session cleanup unproven')
            data=load();marker=GUARD/'setup-unproven';info=marker.lstat()
            if (info.st_dev,info.st_ino)!=tuple(data['setup_identity']):raise ValueError('setup marker not owned by initial preparation')
            if args.operation=='probe':probe()
            else:
                from .sim_control import start_manager
                start_pair(start_manager,setup_identity=data['setup_identity'])
                print('Same-release rootfs manager ready; no simulation session started')
        finally:os.close(fd)


if __name__=='__main__':
    try:main()
    except BaseException as error:
        if isinstance(error,SystemExit) and error.code in (None,0):raise
        raise SystemExit('Rootfs runtime refused; preserve setup/package latch and escalate') from None
