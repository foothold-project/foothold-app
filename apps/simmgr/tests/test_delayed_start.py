"""Process-local cancellation receipts and fake/native startup boundary regressions."""
import asyncio
import json
import logging
from types import SimpleNamespace
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest

from apps.simmgr import api, preflight
from apps.simmgr.service import Manager, SimError
from test_manager import settings
from test_recovery_boundaries import native


def test_absent_delete_cancels_old_start_but_allows_successor():
    cfg=settings();rid=next(iter(cfg.slots));slot=cfg.slots[rid]
    with TestClient(api.create_app(cfg),client=('127.0.0.1',9438)) as client:
        headers={'Authorization':'Bearer '+cfg.secret}
        for generation in (7,3):
            assert client.request('DELETE','/v1/robots/'+rid,json={'generation':generation},headers=headers).status_code==200
        body=dict(world_id='a',robot_id=rid,owner_id=str(uuid4()),org_id=slot.org_id,agent_token='x'*32,generation=7)
        rejected=client.post('/v1/robots',json=body,headers=headers)
        assert rejected.status_code==409 and rejected.json()['error']['code']=='SIM_GENERATION_STALE'
        assert not client.app.state.manager.launcher.events
        body['generation']=8
        assert client.post('/v1/robots',json=body,headers=headers).status_code==200
        assert client.app.state.manager.removed_generation[rid]==7


def test_manager_not_ready_rejects_requests_before_lifespan():
    cfg=settings();app=api.create_app(cfg)
    client=TestClient(app,client=('127.0.0.1',9438))
    result=client.get('/v1/worlds',params={'org_id':next(iter(cfg.slots.values())).org_id},
                      headers={'Authorization':'Bearer '+cfg.secret})
    assert result.status_code==503 and result.json()['error']['code']=='SIM_UNAVAILABLE'
    assert not app.state.manager.launcher.events


def test_native_listing_observes_failed_child_and_latches():
    code=[1]
    launch=native(SimpleNamespace(poll=lambda:code[0]))
    async def run():
        cfg=settings();mgr=Manager(cfg);slot=next(iter(cfg.slots.values()))
        await mgr.add('a',slot.robot_id,str(uuid4()),slot.org_id,'x'*32,1)
        mgr.launcher=launch
        rows=await mgr.listing(slot.org_id)
        assert launch.failed and rows[0]['state']=='ERROR'
        code[0]=None
        assert await launch.check_health() is True and launch.failed
    asyncio.run(run())


def test_health_poll_failure_latches_even_after_poll_recovers():
    def failed():raise RuntimeError('synthetic systemctl failure')
    child=SimpleNamespace(poll=failed);launch=native(child)
    async def run():
        assert await launch.check_health() is True and launch.failed
        child.poll=lambda:None
        assert await launch.check_health() is True
    asyncio.run(run())


def test_agent_unit_creation_error_latches(tmp_path,monkeypatch):
    from apps.simmgr import launcher as module
    launch=native(None);launch.settings=settings();launch.folder=tmp_path;launch.sim=SimpleNamespace(reason=None)
    monkeypatch.setattr(module,'load_keys',lambda path:{})
    def failed(*args):raise RuntimeError('synthetic unit error')
    monkeypatch.setattr(module,'AgentUnit',failed)
    async def run():
        with pytest.raises(RuntimeError,match='startup failed'):
            await launch.add(next(iter(launch.settings.slots.values())),{'agent_token':'x'*32})
        assert launch.failed and launch.child is None
        with pytest.raises(RuntimeError,match='no automatic restart'):
            await launch.add(next(iter(launch.settings.slots.values())),{'agent_token':'x'*32})
    asyncio.run(run())


@pytest.mark.parametrize('real',[False,True])
def test_resources_warn_only_for_fake_but_isolation_still_required(tmp_path,monkeypatch,caplog,real):
    monkeypatch.setattr(preflight,'ROOT',tmp_path)
    snapshot=dict(domain93=[],dds_ports=[],mem_available_mib=100,load1=20)
    def resources(folder):
        (folder/'preflight.json').write_text(json.dumps(snapshot))
        raise RuntimeError('preflight resource gate failed; no launch')
    monkeypatch.setattr(preflight,'isolation_preflight',resources)
    monkeypatch.setattr(preflight.subprocess,'run',lambda *a,**kw:SimpleNamespace(stdout=''))
    caplog.set_level(logging.INFO,logger=preflight.LOGGER.name)
    if real:
        with pytest.raises(RuntimeError,match='resource gate'):preflight.startup_preflight(real)
        assert 'startup preflight' not in caplog.text
    else:
        assert preflight.startup_preflight(real)=={**snapshot, 'resources_ok':False}
        assert 'resource warning' in caplog.text
        lines=[r.message for r in caplog.records if r.message.startswith('startup preflight')]
        assert len(lines)==1
        assert all(word in lines[0] for word in ('utc=','sim_units=0','agent_units=0','domain93_processes=0','MemAvailableMiB=100','load1=20'))
        assert str(tmp_path) not in lines[0] and 'secret' not in lines[0]
    def occupied(folder):raise RuntimeError('domain 93 / candidate DDS UDP ports already in use')
    monkeypatch.setattr(preflight,'isolation_preflight',occupied)
    with pytest.raises(RuntimeError,match='already in use'):preflight.startup_preflight(real)
    monkeypatch.setattr(preflight,'isolation_preflight',lambda folder:snapshot)
    monkeypatch.setattr(preflight.subprocess,'run',lambda *a,**kw:SimpleNamespace(stdout='fh-simmgr-agent-synthetic.service'))
    with pytest.raises(RuntimeError,match='units remain'):preflight.startup_preflight(real)


def test_api_startup_passes_real_mode_to_preflight(monkeypatch):
    from dataclasses import replace
    from apps.simmgr.launcher import FakeLauncher
    class NativeDouble(FakeLauncher):real=True
    observed=[]
    monkeypatch.setattr(api,'startup_preflight',lambda real:observed.append(real) or {})
    cfg=replace(settings(),real=True,source='unused',ros_setup='unused',run_dir='unused')
    with TestClient(api.create_app(cfg,NativeDouble()),client=('127.0.0.1',9438)) as client:
        assert client.app.state.ready and observed==[True]


def test_existing_robot_delete_records_cancellation_receipt():
    async def run():
        cfg=settings();mgr=Manager(cfg);slot=next(iter(cfg.slots.values()));owner=str(uuid4())
        await mgr.add('a',slot.robot_id,owner,slot.org_id,'x'*32,7)
        await mgr.remove(slot.robot_id,7)
        before=list(mgr.launcher.events)
        error=None
        try:await mgr.add('a',slot.robot_id,owner,slot.org_id,'x'*32,7)
        except SimError as caught:error=caught
        assert error is not None and error.code=='SIM_GENERATION_STALE'
        assert not mgr.robots and mgr.launcher.events==before
        await mgr.add('a',slot.robot_id,owner,slot.org_id,'x'*32,8)
        await mgr.close()
    asyncio.run(run())
