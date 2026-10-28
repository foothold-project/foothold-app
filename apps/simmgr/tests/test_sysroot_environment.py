"""Synthetic root-owned profiles; no actual sysroot/ROS/GPU or host access."""
import json
import os
from pathlib import Path
import stat
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from apps.simmgr import sysroot_environment as profile
from apps.simmgr.environment import child_environment
from deploy.sysroot_profile import KEYS

LOCK='a'*64
PREFIX='/opt/foothold-sim/sysroot/'+LOCK
PATH=Path(PREFIX+'/foothold-runtime/profile.json')


def document():
    env=dict(profile.FIXED,PATH=PREFIX+'/foothold-runtime/bin:/usr/bin:/bin',
        LD_LIBRARY_PATH=PREFIX+'/usr/lib/x86_64-linux-gnu',PYTHONPATH=PREFIX+'/usr/lib/python3/dist-packages',
        AMENT_PREFIX_PATH=PREFIX+'/opt/ros/jazzy',GZ_CONFIG_PATH=PREFIX+'/foothold-runtime/gz-config',
        __EGL_VENDOR_LIBRARY_DIRS=PREFIX+'/foothold-runtime/egl_vendor.d',
        LIBGL_DRIVERS_PATH=PREFIX+'/usr/lib/x86_64-linux-gnu/dri')
    return dict(schema=1,lock_sha256=LOCK,env=env)


def exercise(tmp_path,data):
    file=tmp_path/'profile.json';file.write_text(json.dumps(data))
    original=os.open
    def open_private(path,flags,*args,**kwargs):
        assert path==PATH and flags&os.O_NOFOLLOW
        return original(file,flags,*args,**kwargs)
    with patch.object(profile,'validate_ros_link'), patch.object(Path,'lstat',return_value=SimpleNamespace(st_uid=0,st_mode=stat.S_IFDIR|0o555)), \
            patch.object(os,'open',side_effect=open_private), \
            patch.object(os,'fstat',return_value=SimpleNamespace(st_uid=0,st_mode=stat.S_IFREG|0o444)):
        return child_environment(93,{'FH_SIM_SYSROOT_PROFILE':str(PATH),'FH_DATABASE_URL':'synthetic-secret'})


def test_private_profile_only_reaches_isolated_child(tmp_path):
    assert KEYS==profile.KEYS
    child=exercise(tmp_path,document())
    assert child['ROS_DOMAIN_ID']=='93' and child['GALLIUM_DRIVER']=='llvmpipe'
    assert 'synthetic-secret' not in str(child) and 'FH_DATABASE_URL' not in child
    assert profile.load({})=={}


@pytest.mark.parametrize('change', ['domain','outside','renderer','missing_vendor','binding'])
def test_unsafe_profile_refused(tmp_path,change):
    data=document()
    if change=='domain':data['env']['ROS_DOMAIN_ID']='61'
    if change=='outside':data['env']['LD_LIBRARY_PATH']='/usr/lib/x86_64-linux-gnu'
    if change=='renderer':data['env']['LIBGL_ALWAYS_SOFTWARE']='false'
    if change=='missing_vendor':del data['env']['__EGL_VENDOR_LIBRARY_DIRS']
    if change=='binding':data['lock_sha256']='b'*64
    with pytest.raises(ValueError):
        exercise(tmp_path,data)


def test_arbitrary_profile_path_refused_before_open():
    with pytest.raises(ValueError):
        profile.load({'FH_SIM_SYSROOT_PROFILE':'/tmp/untrusted.json'})


def test_server_native_requires_private_profile_and_matching_setup(monkeypatch):
    env=dict(FH_SIM_DEPLOY_GUARD_DIR='/var/lib/foothold-sim/guard',FH_SIM_RUN='1')
    with pytest.raises(ValueError): profile.validate_server(env)
    env['FH_SIM_SYSROOT_PROFILE']=str(PATH)
    env['SIM_ROS_SETUP']='/opt/ros/jazzy/setup.bash'
    with pytest.raises(ValueError): profile.validate_server(env)
    env['SIM_ROS_SETUP']=str(PATH.with_name('ros-setup.bash'))
    called=[]
    monkeypatch.setattr(profile,'load',lambda value:called.append(value))
    profile.validate_server(env)
    assert called==[env]
    profile.validate_server({})


def test_ros_alias_must_match_profile_and_be_root_owned():
    def info(path):
        return SimpleNamespace(st_uid=0,st_mode=(stat.S_IFLNK|0o777) if path.name=='jazzy' else (stat.S_IFDIR|0o755))
    with patch.object(Path,'lstat',info), patch.object(profile.os,'readlink',return_value=PREFIX+'/opt/ros/jazzy'):
        profile.validate_ros_link(PATH)
    with patch.object(Path,'lstat',info), patch.object(profile.os,'readlink',return_value='/foreign/prefix'):
        with pytest.raises(ValueError):profile.validate_ros_link(PATH)
