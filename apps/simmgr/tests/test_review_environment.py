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
    assert own['domain'] != '93', 'the test runner must not itself be a domain 93 participant'
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
    def unit(folder,settings,env,root):
        calls.append(env);return SimpleNamespace(poll=lambda:None)
    monkeypatch.setattr(module,'AgentUnit',unit)
    class Writer:
        def close(self):pass
        async def wait_closed(self):pass
    async def connection(*args):return None,Writer()
    monkeypatch.setattr(asyncio,'open_connection',connection)
    asyncio.run(launcher.add(next(iter(launcher.settings.slots.values())),{'agent_token':'synthetic-agent-token'}))
    env=calls[0]
    assert not {'FH_DATABASE_URL','FH_PHONE_PASS_KEYS','FH_SIM_AUTH_FILE','FH_SIM_RUN'} & env.keys()
    assert env['ROS_DOMAIN_ID']=='93'


def test_programmatic_manager_also_rejects_ros_parent(monkeypatch):
    from apps.simmgr.service import Manager
    monkeypatch.setenv('ROS_DOMAIN_ID','93')
    with pytest.raises(ValueError,match='control plane'):
        Manager(settings())


def test_agent_unit_is_bounded_and_environment_is_private(tmp_path,monkeypatch):
    import json
    from apps.simmgr.agent_unit import AgentUnit
    from apps.simmgr import agent_unit
    cfg=replace(settings(),run_dir=str(tmp_path/'approved-stage1-001/native'),ros_setup='unused')
    commands=[]
    def run(args,**kwargs):
        commands.append((args,kwargs))
        if args[0]=='systemctl':return SimpleNamespace(stdout='LoadState=not-found\n')
        return SimpleNamespace(stdout='')
    monkeypatch.setattr(agent_unit.subprocess,'run',run)
    child=AgentUnit(tmp_path,cfg,{'FOOTHOLD_AGENT_TOKEN':'private-credential','ROS_DOMAIN_ID':'93'},Path('/synthetic'))
    argv,options=commands[-1]
    assert '--property=RuntimeMaxSec=240' in argv
    assert '--property=MemoryMax=512M' in argv
    assert '--property=MemorySwapMax=0' in argv
    assert '--property=TasksMax=128' in argv
    assert '--property=RemainAfterExit=yes' in argv
    assert '--property=WorkingDirectory=/synthetic' in argv
    assert '--property=KillMode=control-group' in argv
    assert '--property=SendSIGKILL=yes' in argv and '--property=TimeoutStopSec=15' in argv
    assert child.unit=='fh-simmgr-agent-approved-stage1-001.service'
    assert 'private-credential' not in str(argv)+str(options)
    assert argv[argv.index('/usr/bin/env')+1]=='-i'
    assert child.private.stat().st_mode & 0o777==0o600
    assert json.loads(child.private.read_text())['env']['ROS_DOMAIN_ID']=='93'


def test_bootstrap_venv_packages_precede_ros_dist_packages(tmp_path):
    from apps.simmgr.agent_entry import BOOTSTRAP
    # Execute only sys.path setup; the ROS application entry is deliberately omitted.
    script=BOOTSTRAP.split("runpy.run_module")[0]+"import typing_extensions; print(typing_extensions.__file__)"
    env={k:v for k,v in os.environ.items() if not k.startswith(('ROS_','RMW_','CYCLONEDDS_','FASTRTPS_'))}
    env.pop('PYTHONPATH',None)
    env['FH_AGENT_ROS_PATH']='/usr/lib/python3/dist-packages'
    output=subprocess.check_output([sys.executable,'-c',script,str(tmp_path)],env=env,text=True)
    import typing_extensions
    assert Path(output.strip()).resolve()==Path(typing_extensions.__file__).resolve()
    assert '/usr/lib/python3/dist-packages/' not in output


def test_agent_unit_keeps_normal_exit_evidence_until_reaped(tmp_path,monkeypatch):
    from apps.simmgr.agent_unit import AgentUnit
    from apps.simmgr import agent_unit
    child=AgentUnit.__new__(AgentUnit);child.unit='fh-simmgr-agent-synthetic.service'
    child.private=tmp_path/'already-unlinked'
    child.show=lambda:dict(ActiveState='active',Result='success',ExecMainCode='1',ExecMainStatus='0')
    calls=[]
    monkeypatch.setattr(agent_unit.subprocess,'run',lambda args,**kwargs:calls.append(args))
    assert child.poll()==0 and child.wait(.1)==0
    assert calls==[['systemctl','--user','stop',child.unit]]
    child.show=lambda:dict(ActiveState='failed',Result='timeout',ExecMainCode='2',ExecMainStatus='9')
    assert child.poll()!=0
