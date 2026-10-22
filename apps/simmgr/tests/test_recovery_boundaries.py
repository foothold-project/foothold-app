"""Startup absence proof and unit recovery boundaries, all OS calls replaced."""
import asyncio
from dataclasses import replace
import json
from pathlib import Path
import signal
import subprocess
import threading
from types import SimpleNamespace
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest

from apps.simmgr import api, preflight, agent_entry, agent_unit
from apps.simmgr.agent_unit import AgentUnit
from apps.simmgr.launcher import NativeLauncher, FakeLauncher
from apps.simmgr.service import Manager, SimError
from test_manager import settings


def test_absent_robot_delete_ignores_generation_and_restart():
    async def run():
        cfg=settings();mgr=Manager(cfg);slot=next(iter(cfg.slots.values()));owner=str(uuid4())
        await mgr.remove(slot.robot_id,6)
        await mgr.add('a',slot.robot_id,owner,slot.org_id,'x'*32,7)
        with pytest.raises(SimError):await mgr.remove(slot.robot_id,1)
        await mgr.remove(slot.robot_id,7)
        await mgr.remove(slot.robot_id,1)
        restarted=Manager(cfg)
        await restarted.remove(slot.robot_id,7)
        assert not mgr.robots and not restarted.robots
    asyncio.run(run())


def test_service_startup_requires_absence_proof_even_in_fake(monkeypatch):
    called=[]
    def blocked(*args):
        called.append(threading.get_ident())
        raise RuntimeError('synthetic remaining runtime')
    monkeypatch.setattr(api,'startup_preflight',blocked)
    refused=False
    try:
        with TestClient(api.create_app(settings()),client=('127.0.0.1',9438)):
            pass
    except RuntimeError:refused=True
    assert refused and len(called)==1


@pytest.mark.parametrize('units',['fh-rb-sim-owned.service loaded active running',
                                'fh-simmgr-agent-owned.service loaded failed failed'])
def test_startup_rejects_remaining_units_without_cleaning(tmp_path,monkeypatch,units):
    monkeypatch.setattr(preflight,'ROOT',tmp_path)
    observed=[]
    monkeypatch.setattr(preflight,'isolation_preflight',lambda folder:observed.append('isolation') or {})
    calls=[]
    def run(argv,**kwargs):
        calls.append(argv);return SimpleNamespace(stdout=units)
    monkeypatch.setattr(preflight.subprocess,'run',run)
    with pytest.raises(RuntimeError,match='units remain'):preflight.startup_preflight()
    assert observed==['isolation'] and len(calls)==1
    assert calls[0][2]=='list-units' and calls[0][-2:]==list(preflight.UNIT_PATTERNS)
    assert not any(word in ('stop','kill','reset-failed','systemd-run') for word in calls[0])


def test_startup_keeps_existing_domain93_preflight(monkeypatch,tmp_path):
    from test_review_environment import isolation
    monkeypatch.setattr(preflight,'ROOT',tmp_path)
    # Delegate to the real established checker with synthetic OS metadata only.
    monkeypatch.setattr(isolation,'processes',lambda:([{'pid':123,'domain':'93'}],0))
    monkeypatch.setattr(isolation,'domain61',lambda rows:[])
    monkeypatch.setattr(isolation,'dds_ports',lambda:([],''))
    monkeypatch.setattr(isolation,'resources',lambda:dict(mem_available_mib=8000,load1=0))
    monkeypatch.setattr(isolation,'command',lambda *args:'')
    with pytest.raises(RuntimeError,match='already in use'):preflight.startup_preflight()


def test_startup_user_bus_failure_is_not_an_empty_unit_list(monkeypatch,tmp_path):
    monkeypatch.setattr(preflight,'ROOT',tmp_path)
    monkeypatch.setattr(preflight,'isolation_preflight',lambda folder:{})
    def unavailable(*args,**kwargs):raise subprocess.CalledProcessError(1,'systemctl')
    monkeypatch.setattr(preflight.subprocess,'run',unavailable)
    with pytest.raises(RuntimeError,match='user bus unavailable'):preflight.startup_preflight()


@pytest.mark.parametrize('state',[{'LoadState':'loaded'},{}])
def test_agent_unit_reuse_and_missing_bus_are_distinct(tmp_path,monkeypatch,state):
    calls=[]
    monkeypatch.setattr(agent_unit.subprocess,'run',lambda *args,**kwargs:calls.append(args))
    monkeypatch.setattr(AgentUnit,'show',lambda self:state if state else (_ for _ in ()).throw(RuntimeError('user bus unavailable')))
    cfg=replace(settings(),run_dir=str(tmp_path/'episode/native'))
    with pytest.raises(RuntimeError,match='already exists' if state else 'user bus unavailable'):
        AgentUnit(tmp_path,cfg,{},tmp_path)
    assert not (tmp_path/'agent-env.json').exists() and not calls


def test_agent_show_empty_stdout_identifies_missing_bus(monkeypatch):
    child=AgentUnit.__new__(AgentUnit);child.unit='synthetic.service'
    monkeypatch.setattr(agent_unit.subprocess,'run',lambda *a,**kw:SimpleNamespace(stdout=''))
    with pytest.raises(RuntimeError,match='user bus unavailable'):child.show()


def test_agent_entry_unlinks_private_file_before_exec(tmp_path,monkeypatch):
    private=tmp_path/'env.json'
    private.write_text(json.dumps(dict(setup='/synthetic/setup',python='/synthetic/python',root='/synthetic',
                                     env={'FOOTHOLD_AGENT_TOKEN':'synthetic-secret'})))
    monkeypatch.setattr(agent_entry.sys,'argv',['entry',str(private)])
    calls=[]
    def execve(binary,argv,env):
        calls.append((binary,argv,env,private.exists()))
    monkeypatch.setattr(agent_entry.os,'execve',execve)
    agent_entry.main()
    assert calls and calls[0][3] is False and not private.exists()
    assert calls[0][2]=={'FOOTHOLD_AGENT_TOKEN':'synthetic-secret'}
    assert 'synthetic-secret' not in str(calls[0][:2])


def native(child):
    launcher=NativeLauncher.__new__(NativeLauncher)
    launcher.child=child;launcher.sim=None;launcher.failed=False
    return launcher


def test_health_poll_does_not_block_event_loop():
    started,release=threading.Event(),threading.Event();threads=[]
    def poll():
        threads.append(threading.get_ident());started.set();release.wait(1);return None
    launch=native(SimpleNamespace(poll=poll))
    async def run():
        main=threading.get_ident();task=asyncio.create_task(launch.check_health())
        try:
            await asyncio.sleep(.03)
            assert started.is_set() and not task.done()
        finally:release.set()
        assert await task is False and threads and all(t!=main for t in threads)
    asyncio.run(run())


def test_startup_and_stop_unit_commands_run_off_event_loop(tmp_path,monkeypatch):
    from apps.simmgr import launcher as module
    threads=[]
    class Child:
        code=None
        def poll(self):threads.append(threading.get_ident());return self.code
        def send_signal(self,sig):threads.append(threading.get_ident());assert sig==signal.SIGINT;self.code=0
        def wait(self,timeout):threads.append(threading.get_ident());return 0
    child=Child();launch=native(None)
    launch.settings=settings();launch.folder=tmp_path;launch.sim=SimpleNamespace(reason=None)
    monkeypatch.setattr(module,'load_keys',lambda path:{})
    monkeypatch.setattr(module,'AgentUnit',lambda *args:child)
    class Writer:
        def close(self):pass
        async def wait_closed(self):pass
    async def connect(*args):return None,Writer()
    monkeypatch.setattr(asyncio,'open_connection',connect)
    async def run():
        main=threading.get_ident()
        await launch.add(next(iter(launch.settings.slots.values())),{'agent_token':'x'*32})
        await launch.stop_agent(None)
        assert launch.child is None and threads and all(t!=main for t in threads)
    asyncio.run(run())


def test_status_timeout_is_failed_health_not_server_500():
    def timeout():raise subprocess.TimeoutExpired('systemctl',5)
    launch=native(SimpleNamespace(poll=timeout))
    async def run():
        mgr=Manager(settings());mgr.launcher=launch
        with pytest.raises(SimError) as error:await mgr.healthy()
        assert error.value.status==503 and launch.failed and launch.failure
    asyncio.run(run())


@pytest.mark.parametrize('operation',['signal','stop'])
def test_unit_command_error_marks_failed_and_preserves_child(operation):
    def error(*args,**kwargs):raise subprocess.CalledProcessError(1,'systemctl')
    child=SimpleNamespace(poll=lambda:None if operation=='signal' else 0,
                          send_signal=error,wait=error)
    launch=native(child)
    async def run():
        with pytest.raises(RuntimeError):await launch.stop_agent(None)
        assert launch.failed and launch.child is child
        with pytest.raises(RuntimeError):await launch.close_world()
    asyncio.run(run())


def test_absent_robot_delete_api_accepts_any_generation():
    cfg=settings();rid=next(iter(cfg.slots))
    with TestClient(api.create_app(cfg),client=('127.0.0.1',9438)) as client:
        result=client.request('DELETE','/v1/robots/'+rid,json={'generation':99},
                              headers={'Authorization':'Bearer '+cfg.secret})
        assert result.status_code==200
        assert result.json()=={'manager_instance_id':str(client.app.state.instance_id), 'absent':True, 'startup_clean':True}
