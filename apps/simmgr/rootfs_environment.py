"""Read-only rootfs identity and child-only software environment, no host aliases."""
import json
import os
from pathlib import Path
import re
import stat
from .sysroot_environment import KEYS,FIXED

IDENTITY=Path('/foothold-runtime/identity.json')
PROFILE=Path('/foothold-runtime/child-profile.json')


def readonly(path):
    for parent in path.parents:
        info=parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022:
            raise ValueError('rootfs runtime parent untrusted')
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
    with os.fdopen(fd) as stream:
        info=os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_mode&0o222 or info.st_size>1024**2:
            raise ValueError('rootfs runtime identity/profile mutable')
        return json.load(stream)


def binding(env=None):
    env=os.environ if env is None else env
    recipe=env.get('FH_SIM_ROOTFS_LOCK')
    if recipe is None:return None
    if not re.fullmatch('[0-9a-f]{64}',recipe) or 'FH_SIM_SYSROOT_PROFILE' in env:
        raise ValueError('rootfs recipe invalid or mixed with host sysroot')
    identity=readonly(IDENTITY)
    if (set(identity)!={'schema','recipe_sha256','manifest_sha256'} or identity['schema']!=1
            or identity['recipe_sha256']!=recipe or not re.fullmatch('[0-9a-f]{64}',identity['manifest_sha256'])):
        raise ValueError('rootfs identity unbound')
    return identity


def load(env):
    if binding(env) is None:return {}
    data=readonly(PROFILE)
    if set(data)!={'schema','env'} or data['schema']!=1 or not isinstance(data['env'],dict):
        raise ValueError('rootfs child profile invalid')
    result=data['env'];required=set(FIXED)|{'PATH','LD_LIBRARY_PATH','PYTHONPATH','AMENT_PREFIX_PATH',
        'GZ_CONFIG_PATH','__EGL_VENDOR_LIBRARY_DIRS','LIBGL_DRIVERS_PATH'}
    if not required<=set(result) or not set(result)<=KEYS or any(result.get(key)!=value for key,value in FIXED.items()):
        raise ValueError('rootfs child environment not pinned to software')
    for key,value in result.items():
        if not isinstance(value,str) or not value or len(value)>65536 or '\x00' in value or '\n' in value:
            raise ValueError('rootfs child environment invalid')
        if key in FIXED:continue
        for part in value.split(':'):
            path=Path(part)
            if (not path.is_absolute() or '..' in path.parts or not any(path==Path(prefix) or path.is_relative_to(prefix)
                    for prefix in ('/foothold-runtime','/opt/ros/jazzy','/usr/lib','/usr/bin','/bin'))):
                raise ValueError('rootfs child path escapes declared internal providers')
    return result


def validate_server(env):
    if binding(env) is None:return False
    if (env.get('FH_SIM_DEPLOY_GUARD_DIR')!='/var/lib/foothold-sim/guard' or env.get('FH_SIM_RUN')!='1'
            or env.get('SIM_ROS_SETUP')!='/foothold-runtime/ros-setup.bash'
            or env.get('FH_SIM_AGENT_PYTHON')!='/usr/bin/python3'
            or env.get('FH_SIM_PROC_PROOF_SOCKET')!='/run/foothold-sim-proof.sock'):
        raise ValueError('rootfs server requires fixed guard, OS proof and internal setup/Python')
    load(env)
    return True
