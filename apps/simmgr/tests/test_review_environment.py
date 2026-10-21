"""Reviewer B1 reproductions: real own /proc metadata, never a ROS participant."""
import asyncio
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
from types import SimpleNamespace
from dataclasses import replace
from unittest.mock import Mock

import pytest

from apps.simmgr.environment import child_environment, validate_control_environment
from apps.simmgr.config import Settings
from apps.simmgr.launcher import NativeLauncher
from test_manager import settings
from foothold_agent.ros_bridge.config import DDS_OVERRIDES

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'agent/tools/sim'))
import isolation


def own_environment(monkeypatch):
    rows,_=isolation.processes()
    own=next(row for row in rows if row['pid']==os.getpid())
    assert own['domain']=='', 'run this control-plane test with ROS environment absent'
    monkeypatch.setattr(isolation,'processes',lambda:([own],0))
    monkeypatch.setattr(isolation,'dds_ports',lambda:([],''))
    monkeypatch.setattr(isolation,'command',lambda *args:'')
    monkeypatch.setattr(isolation,'resources',lambda:dict(mem_available_mib=8000,load1=0))
    return own


def test_own_control_plane_pid_passes_preflight(tmp_path,monkeypatch):
    own_environment(monkeypatch)
    isolation.preflight(tmp_path)


def test_own_control_plane_pid_passes_close(tmp_path,monkeypatch):
    own_environment(monkeypatch)
    sim=isolation.Simulation.__new__(isolation.Simulation)
    sim.folder=sim.source=sim.out=tmp_path
    sim.unit='synthetic-not-launched';sim.cg='/not-owned'
    sim.done=threading.Event();sim.thread=None;sim.identity=None
    sim.hashes={};sim.before={'domain61':[]}
    sim.interrupt=lambda why:None;sim.show=lambda:{'MainPID':'0'}
    monkeypatch.setattr(isolation,'source_hashes',lambda source:{})
    sim.close()


@pytest.mark.parametrize('key',['ROS_DOMAIN_ID','ROS_LOCALHOST_ONLY','ROS_AUTOMATIC_DISCOVERY_RANGE',
                                'ROS_DISTRO','RMW_IMPLEMENTATION',*DDS_OVERRIDES])
def test_manager_rejects_any_ros_environment_before_reading_files(key):
    with pytest.raises(ValueError,match='control plane'):
        validate_control_environment({key:''})


def test_child_environment_does_not_inherit_secrets():
    supplied={k:'not-for-child' for k in ('FH_DATABASE_URL','FH_PHONE_PASS_KEYS','FH_SIM_AUTH_FILE','FH_SIM_RUN','PYTHONPATH')}
    child=child_environment(93,{**supplied,'PATH':'/usr/bin','HOME':'/private/home'})
    assert not set(supplied) & child.keys()
    assert child['ROS_DOMAIN_ID']=='93' and child['ROS_LOCALHOST_ONLY']=='1'
    with pytest.raises(ValueError):
        child_environment(61,{})


def test_unit_clears_user_manager_environment_before_setup(tmp_path,monkeypatch):
    source=tmp_path/'sensor-spec-20261016/stage/sensor-runtime-r1'
    source.mkdir(parents=True);(source/'live_map.py').touch()
    child=child_environment(93,{})
    sim=isolation.Simulation(tmp_path,source,tmp_path/'setup',launch_env=child)
    monkeypatch.setattr(isolation,'preflight',lambda _:dict(domain61=[]))
    monkeypatch.setattr(isolation,'source_hashes',lambda _: {})
    monkeypatch.setattr(isolation.threading,'Thread',Mock())
    monkeypatch.setattr(sim,'show',lambda:dict(MainPID='123',ControlGroup='/owned'))
    monkeypatch.setattr(isolation,'processes',lambda:([dict(pid=123,start_ticks=1)],0))
    launch=Mock(return_value='');monkeypatch.setattr(isolation.subprocess,'check_output',launch)
    sim.start()
    argv=launch.call_args.args[0]
    assert launch.call_args.kwargs['env']==child
    assert '/usr/bin/env' in argv
    unit_payload=argv[argv.index('/usr/bin/env'):]
    assert unit_payload[:2]==['/usr/bin/env','-i']
    assert unit_payload.index('/bin/bash')>unit_payload.index('ROS_DOMAIN_ID=93')
    assert not any(arg.startswith(('FH_DATABASE_URL=','FH_PHONE_PASS_KEYS=','FH_SIM_AUTH_FILE=','FH_SIM_RUN=')) for arg in unit_payload)


def test_agent_timeout_escalates_owned_group_and_preserves_world(monkeypatch):
    launch=NativeLauncher.__new__(NativeLauncher)
    launch.failed=False
    calls=[];waits=iter([True,True,False])
    class Child:
        pid=123456
        code=None
        def poll(self):return self.code
        def send_signal(self,sig):calls.append(sig)
        def wait(self,timeout):
            if next(waits):raise subprocess.TimeoutExpired('synthetic',timeout)
            self.code=-9;return self.code
    launch.child=Child();launch.sim=SimpleNamespace(close=lambda:pytest.fail('world must remain'))
    monkeypatch.setattr(os,'getpgid',lambda pid:pid)
    monkeypatch.setattr(os,'killpg',lambda pid,sig:calls.append(sig))
    async def run():
        with pytest.raises(RuntimeError,match='timeout'):
            await launch.stop_agent(None)
        assert launch.failed and launch.child is not None
        assert calls==[signal.SIGINT,signal.SIGTERM,signal.SIGKILL]
        with pytest.raises(RuntimeError):await launch.close_world()
    asyncio.run(run())


@pytest.mark.parametrize('path',['/agent/ws','/api/v1/agent/ws/','/wrong'])
def test_manager_rejects_wrong_server_ws_path(path):
    with pytest.raises(ValueError):
        replace(settings(),agent_ws_url='ws://127.0.0.1:9431'+path)


def test_manager_checks_ros_environment_before_files():
    with pytest.raises(ValueError,match='control plane'):
        Settings.from_env({'ROS_DOMAIN_ID':'93'})


def test_agent_gets_only_allowlisted_env_and_own_process_group(tmp_path,monkeypatch):
    from apps.simmgr import launcher as module
    for key in ('FH_DATABASE_URL','FH_PHONE_PASS_KEYS','FH_SIM_AUTH_FILE','FH_SIM_RUN'):
        monkeypatch.setenv(key,'private-not-for-child')
    launcher=NativeLauncher.__new__(NativeLauncher)
    launcher.settings=replace(settings(),ros_setup='existing-setup')
    launcher.folder=tmp_path;launcher.child=None;launcher.failed=False;launcher.sim=SimpleNamespace(reason=None)
    monkeypatch.setattr(module,'load_keys',lambda _: {})
    calls=[]
    def popen(argv,**kwargs):
        calls.append((argv,kwargs));return SimpleNamespace(poll=lambda:None)
    monkeypatch.setattr(module.subprocess,'Popen',popen)
    class Writer:
        def close(self):pass
        async def wait_closed(self):pass
    async def connection(*args):return None,Writer()
    monkeypatch.setattr(asyncio,'open_connection',connection)
    asyncio.run(launcher.add(next(iter(launcher.settings.slots.values())),{'agent_token':'synthetic-agent-token'}))
    argv,options=calls[0]
    assert options['start_new_session'] is True
    assert not {'FH_DATABASE_URL','FH_PHONE_PASS_KEYS','FH_SIM_AUTH_FILE','FH_SIM_RUN'} & options['env'].keys()
    assert options['env']['ROS_DOMAIN_ID']=='93'
    assert argv[:2]==['/bin/bash','-c'] and 'source "$1"' in argv[2]
    assert '/usr/lib/python3/dist-packages' in argv[2]


def test_programmatic_manager_also_rejects_ros_parent(monkeypatch):
    from apps.simmgr.service import Manager
    monkeypatch.setenv('ROS_DOMAIN_ID','93')
    with pytest.raises(ValueError,match='control plane'):
        Manager(settings())
