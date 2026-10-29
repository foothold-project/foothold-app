"""Read root-owned immutable child environment; never add ROS to manager env."""
import json
import os
from pathlib import Path
import re
import stat

KEYS = frozenset(('PATH','LD_LIBRARY_PATH','PYTHONPATH','AMENT_PREFIX_PATH','CMAKE_PREFIX_PATH',
    'GZ_SIM_RESOURCE_PATH','GZ_SIM_SYSTEM_PLUGIN_PATH','GZ_GUI_PLUGIN_PATH','GZ_CONFIG_PATH',
    'GZ_RENDERING_ENGINE_PATH','GZ_RENDERING_RESOURCE_PATH','__EGL_VENDOR_LIBRARY_DIRS',
    'LIBGL_DRIVERS_PATH','LIBGL_ALWAYS_SOFTWARE','GALLIUM_DRIVER','MESA_LOADER_DRIVER_OVERRIDE',
    'EGL_PLATFORM','MESA_SHADER_CACHE_DISABLE','LP_NUM_THREADS','QT_QPA_PLATFORM','RUBYLIB','GEM_PATH'))
FIXED = dict(LIBGL_ALWAYS_SOFTWARE='true',GALLIUM_DRIVER='llvmpipe',MESA_LOADER_DRIVER_OVERRIDE='swrast',
             EGL_PLATFORM='surfaceless',MESA_SHADER_CACHE_DISABLE='true',LP_NUM_THREADS='2',QT_QPA_PLATFORM='offscreen')


def validate_ros_link(profile):
    parent=Path('/opt/ros');link=parent/'jazzy'
    directory=parent.lstat();alias=link.lstat()
    expected=profile.parent.parent/'opt/ros/jazzy'
    if (not stat.S_ISDIR(directory.st_mode) or directory.st_uid!=0 or stat.S_IMODE(directory.st_mode)!=0o755
            or not stat.S_ISLNK(alias.st_mode) or alias.st_uid!=0 or os.readlink(link)!=str(expected)):
        raise ValueError('ROS alias does not match the immutable private profile')


def load(env):
    value=env.get('FH_SIM_SYSROOT_PROFILE')
    if value is None: return {}
    path=Path(value)
    prefix=Path('/opt/foothold-sim/sysroot')
    if (not path.is_absolute() or not path.is_relative_to(prefix) or len(path.relative_to(prefix).parts)!=3
            or path.parts[-2:]!=('foothold-runtime','profile.json') or not re.fullmatch('[0-9a-f]{64}',path.parts[-3])):
        raise ValueError('unapproved immutable sysroot profile path')
    for parent in path.parents:
        info=parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022:
            raise ValueError('sysroot profile parent untrusted')
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
    with os.fdopen(fd) as stream:
        info=os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_mode&0o222:
            raise ValueError('sysroot profile must be root-owned read-only')
        data=json.load(stream)
    if set(data)!={'schema','lock_sha256','env'} or data['schema']!=1 or data['lock_sha256']!=path.parts[-3]:
        raise ValueError('sysroot profile binding mismatch')
    result=data['env']
    required=set(FIXED)|{'PATH','LD_LIBRARY_PATH','PYTHONPATH','AMENT_PREFIX_PATH','GZ_CONFIG_PATH','__EGL_VENDOR_LIBRARY_DIRS','LIBGL_DRIVERS_PATH'}
    if (not isinstance(result,dict) or not required<=set(result) or not set(result)<=KEYS
            or any(not result.get(key) for key in required)
            or any(result.get(key)!=value for key,value in FIXED.items())):
        raise ValueError('sysroot environment/renderer not approved')
    root=str(prefix/data['lock_sha256'])
    for key,value in result.items():
        if not isinstance(value,str) or len(value)>65536 or '\x00' in value or '\n' in value:
            raise ValueError('invalid sysroot environment value')
        if key in FIXED: continue
        for item in value.split(':'):
            if not item: raise ValueError('empty/current-directory environment component forbidden')
            if key=='PATH' and item in ('/usr/bin','/bin'): continue
            target=Path(item)
            if not target.is_absolute() or not target.is_relative_to(root) or '..' in target.parts:
                raise ValueError('sysroot environment escapes immutable prefix')
    validate_ros_link(path)
    return result


def validate_server(env):
    from .rootfs_environment import validate_server as validate_rootfs
    if validate_rootfs(env):return
    if (env.get('FH_SIM_DEPLOY_GUARD_DIR')!='/var/lib/foothold-sim/guard'
            or env.get('FH_SIM_RUN')!='1'):
        return
    value=env.get('FH_SIM_SYSROOT_PROFILE')
    if not value or env.get('SIM_ROS_SETUP')!=str(Path(value).with_name('ros-setup.bash')):
        raise ValueError('server native simulation requires matching private sysroot profile/setup')
    load(env)
