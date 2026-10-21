"""Read-only-review probes promoted to assertion regressions; fake manager only."""
from concurrent.futures import ThreadPoolExecutor
import threading
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from apps.server.tests.test_simulation import (simulation_context, start_slot, clean_ros_environment,
    isolated_manager_startup, LocalRelay, manager_app)
from apps.server.fh_server.models import Robot, Event, PhonePass, PhoneRevocation
from apps.server.fh_server.simulation import RelayError, START_REJECTIONS
from .test_api import csrf


def snapshot(client,rid):
    with Session(client.app.state.engine) as db:
        row=db.get(Robot,rid)
        return row.sim_state,row.owner_user_id,row.sim_generation,row.agent_token_hash


def assert_recovery(context,headers,generation):
    client,sim,cfg,rid,launcher=context
    assert client.delete(f'/api/v1/simulation/robots/{rid}',headers=headers).status_code==204
    expected=snapshot(client,rid)
    state,owner,gen,_=expected
    assert (state,owner,gen)==('IDLE',None,generation)
    with Session(client.app.state.engine) as db:
        audits=list(db.scalars(select(Event.id).order_by(Event.id)))
    assert client.delete(f'/api/v1/simulation/robots/{rid}',headers=headers).status_code==403
    assert snapshot(client,rid)==expected
    with Session(client.app.state.engine) as db:
        assert list(db.scalars(select(Event.id).order_by(Event.id)))==audits
    result=client.post('/api/v1/simulation/robots',headers=headers,json={'robot_id':rid,'world_id':'test'})
    assert result.status_code==201,result.text
    assert result.json()['generation']==generation+1


@pytest.mark.parametrize('failure',['before','lost','identity','invalid_body','unknown_4xx','wrong_status','5xx'])
def test_uncertain_start_can_delete_and_reacquire(simulation_context,failure):
    client,sim,cfg,rid,launcher=simulation_context
    relay=client.app.state.simmgr;original=relay.request
    def faulty(method,path,body=None):
        if method=='POST':
            if failure=='unknown_4xx':raise RelayError('SIM_SLOT_BUSY',409)
            if failure=='wrong_status':raise RelayError('SIM_WORLD_NOT_FOUND',503)
            if failure in ('before','5xx'):raise RelayError()
            result=original(method,path,body)
            if failure=='lost':raise RelayError()
            if failure=='invalid_body':return {'invalid':True}
            result['owner_id']=str(uuid4());return result
        return original(method,path,body)
    relay.request=faulty
    result,headers=start_slot(simulation_context)
    assert result.status_code in (409,503)
    assert snapshot(client,rid)[0]=='STARTING'
    assert snapshot(client,rid)[1] is not None
    assert client.post('/api/v1/simulation/robots',headers=headers,json={'robot_id':rid,'world_id':'test'}).status_code==409
    relay.request=original
    assert_recovery(simulation_context,headers,1)


@pytest.mark.parametrize('status,code',sorted(START_REJECTIONS))
def test_definite_start_rejection_releases_immediately(simulation_context,status,code):
    client,sim,cfg,rid,launcher=simulation_context
    relay=client.app.state.simmgr;original=relay.request
    def reject(method,path,body=None):
        if method=='POST':raise RelayError(code,status)
        return original(method,path,body)
    relay.request=reject
    result,headers=start_slot(simulation_context)
    assert result.status_code==status
    assert snapshot(client,rid)[:3]==('IDLE',None,1)
    with Session(client.app.state.engine) as db:
        assert len(list(db.scalars(select(Event).where(Event.code=='SIM_ROBOT_START_REJECTED'))))==1
    relay.request=original
    result=client.post('/api/v1/simulation/robots',headers=headers,json={'robot_id':rid,'world_id':'test'})
    assert result.status_code==201 and result.json()['generation']==2


def test_missing_world_rejected_without_consuming_slot(simulation_context):
    client,sim,cfg,rid,launcher=simulation_context;headers=csrf(client,'one')
    result=client.post('/api/v1/simulation/robots',headers=headers,json={'robot_id':rid,'world_id':'missing'})
    assert result.status_code==404 and not sim.app.state.manager.robots
    assert snapshot(client,rid)[:3]==('IDLE',None,1)
    assert client.post('/api/v1/simulation/robots',headers=headers,json={'robot_id':rid,'world_id':'test'}).status_code==201


@pytest.mark.parametrize('stopping',[False,True])
def test_restarted_empty_manager_releases_durable_generation(simulation_context,stopping):
    client,sim,cfg,rid,launcher=simulation_context
    result,headers=start_slot(simulation_context);assert result.status_code==201
    if stopping:
        original=client.app.state.simmgr
        class Down:
            def request(self,*args,**kwargs):raise RelayError()
        client.app.state.simmgr=Down()
        assert client.delete(f'/api/v1/simulation/robots/{rid}',headers=headers).status_code==503
        assert snapshot(client,rid)[0]=='STOPPING'
        client.app.state.simmgr=original
    # Only the process/resource absence proof permits a new service to start.
    sim.portal.call(sim.app.state.manager.remove,rid,1)
    with TestClient(manager_app(cfg),client=('127.0.0.1',9438)) as restarted:
        client.app.state.simmgr=LocalRelay(restarted,cfg.secret)
        assert_recovery(simulation_context,headers,1)


def test_duplicate_delete_same_generation_releases_only_once(simulation_context):
    client,sim,cfg,rid,launcher=simulation_context
    result,headers=start_slot(simulation_context);assert result.status_code==201
    original=client.app.state.simmgr.request;held,resume=threading.Event(),threading.Event()
    count=[0];gate=threading.Lock()
    def delayed(method,path,body=None):
        result=original(method,path,body)
        if method=='DELETE':
            with gate:count[0]+=1;first=count[0]==1
            if first:
                held.set();assert resume.wait(10)
        return result
    client.app.state.simmgr.request=delayed
    with ThreadPoolExecutor(max_workers=1) as executor:
        first=executor.submit(client.delete,f'/api/v1/simulation/robots/{rid}',headers=headers)
        try:
            assert held.wait(5)
            assert client.delete(f'/api/v1/simulation/robots/{rid}',headers=headers).status_code==204
            expected=snapshot(client,rid)
            resume.set();response=first.result(timeout=5)
            assert snapshot(client,rid)==expected
            with Session(client.app.state.engine) as db:
                assert len(list(db.scalars(select(Event).where(Event.code=='SIM_ROBOT_REMOVED'))))==1
                assert len(list(db.scalars(select(Event).where(Event.code=='SIM_ROBOT_REMOVE_STALE'))))==1
            assert response.status_code==409
        finally:resume.set()


def test_definite_rejection_revokes_pass_issued_while_starting(simulation_context):
    client,sim,cfg,rid,launcher=simulation_context;headers=csrf(client,'one')
    relay=client.app.state.simmgr;original=relay.request
    def rejected(method,path,body=None):
        if method=='POST':
            issued=client.post(f'/api/v1/robots/{rid}/phone-pass',headers=headers,
                               json={'device':str(uuid4()),'purpose':'view'})
            assert issued.status_code==200
            raise RelayError('SIM_WORLD_NOT_FOUND',404)
        return original(method,path,body)
    relay.request=rejected
    result=client.post('/api/v1/simulation/robots',headers=headers,json={'robot_id':rid,'world_id':'test'})
    assert result.status_code==404 and snapshot(client,rid)[:3]==('IDLE',None,1)
    with Session(client.app.state.engine) as db:
        passes=set(db.scalars(select(PhonePass.jti).where(PhonePass.robot_id==rid)))
        revoked=set(db.scalars(select(PhoneRevocation.jti).where(PhoneRevocation.robot_id==rid)))
        assert passes and passes<=revoked
