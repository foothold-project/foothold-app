"""Late POST cancellation and compensation, with real DB locks and a fake runtime."""
from concurrent.futures import ThreadPoolExecutor
import io
import threading
from urllib.error import HTTPError, URLError
from uuid import uuid4

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from apps.server.tests.test_simulation import (simulation_context, clean_ros_environment,
    isolated_manager_startup)
from apps.server.tests.test_sim_recovery import snapshot
from apps.server.fh_server.models import Event, PhonePass, PhoneRevocation
from apps.server.fh_server.simulation import Relay, RelayError, START_REJECTIONS
from .test_api import csrf


def audits(client,code):
    with Session(client.app.state.engine) as db:
        return [e.data for e in db.scalars(select(Event).where(Event.code==code))]


@pytest.mark.parametrize('arrival',['delete_first','post_first'])
def test_delayed_post_cannot_escape_completed_delete(simulation_context,arrival):
    client,sim,cfg,rid,launcher=simulation_context;headers=csrf(client,'one')
    original=client.app.state.simmgr.request;held,resume=threading.Event(),threading.Event()
    def delayed(method,path,body=None):
        if method=='POST':
            if arrival=='post_first':result=original(method,path,body)
            held.set();assert resume.wait(10)
            if arrival=='post_first':return result
        return original(method,path,body)
    client.app.state.simmgr.request=delayed
    with ThreadPoolExecutor(max_workers=1) as executor:
        start=executor.submit(client.post,'/api/v1/simulation/robots',headers=headers,
                              json={'robot_id':rid,'world_id':'test'})
        try:
            assert held.wait(5)
            issued=client.post(f'/api/v1/robots/{rid}/phone-pass',headers=headers,
                               json={'device':str(uuid4()),'purpose':'control'})
            assert issued.status_code==200
            assert client.delete(f'/api/v1/simulation/robots/{rid}',headers=headers).status_code==204
            expected=snapshot(client,rid)
            resume.set();late=start.result(timeout=5)
            assert late.status_code==409,late.text
            assert snapshot(client,rid)==expected and expected[:3]==('IDLE',None,1)
            assert not sim.app.state.manager.robots
            if arrival=='delete_first':
                # Unlike the original review probe, do not construct a hypothetical
                # new agent: the revoked ticket has no newly launched agent to reach.
                assert not hasattr(launcher,'token')
                assert not any(e[0]=='agent' for e in launcher.events)
                assert not audits(client,'SIM_ROBOT_START_STALE')
            else:
                assert len(audits(client,'SIM_ROBOT_START_STALE'))==1
            with Session(client.app.state.engine) as db:
                passes=set(db.scalars(select(PhonePass.jti).where(PhonePass.robot_id==rid)))
                revoked=set(db.scalars(select(PhoneRevocation.jti).where(PhoneRevocation.robot_id==rid)))
                assert passes and passes<=revoked
            client.app.state.simmgr.request=original
            new=client.post('/api/v1/simulation/robots',headers=headers,json={'robot_id':rid,'world_id':'test'})
            assert new.status_code==201 and new.json()['generation']==2,new.text
            assert client.delete(f'/api/v1/simulation/robots/{rid}',headers=headers).status_code==204
            assert snapshot(client,rid)[:3]==('IDLE',None,2) and not sim.app.state.manager.robots
        finally:resume.set()


@pytest.mark.parametrize('compensation_failure',[False,True])
def test_stale_success_compensates_once_without_touching_successor(simulation_context,compensation_failure):
    client,sim,cfg,rid,launcher=simulation_context;headers=csrf(client,'one')
    original=client.app.state.simmgr.request;held,resume=threading.Event(),threading.Event()
    deletes=[];posts=[0]
    def delayed(method,path,body=None):
        if method=='POST':
            posts[0]+=1
            result=original(method,path,body)
            if posts[0]==1:held.set();assert resume.wait(10)
            return result
        if method=='DELETE':
            deletes.append(body['generation'])
            if compensation_failure and len(deletes)==2:raise RelayError('SIM_UNAVAILABLE',503)
        return original(method,path,body)
    client.app.state.simmgr.request=delayed
    with ThreadPoolExecutor(max_workers=1) as executor:
        start=executor.submit(client.post,'/api/v1/simulation/robots',headers=headers,
                              json={'robot_id':rid,'world_id':'test'})
        try:
            assert held.wait(5)
            assert client.delete(f'/api/v1/simulation/robots/{rid}',headers=headers).status_code==204
            new=client.post('/api/v1/simulation/robots',headers=headers,json={'robot_id':rid,'world_id':'test'})
            assert new.status_code==201
            issued=client.post(f'/api/v1/robots/{rid}/phone-pass',headers=headers,
                               json={'device':str(uuid4()),'purpose':'control'})
            assert issued.status_code==200
            expected=snapshot(client,rid)
            resume.set();assert start.result(timeout=5).status_code==409
            assert deletes==[1,1] and snapshot(client,rid)==expected
            assert sim.app.state.manager.robots[rid].generation==2
            with Session(client.app.state.engine) as db:
                live=set(db.scalars(select(PhonePass.jti).where(PhonePass.robot_id==rid)))
                revoked=set(db.scalars(select(PhoneRevocation.jti).where(PhoneRevocation.robot_id==rid)))
                assert live-revoked
            records=audits(client,'SIM_ROBOT_START_STALE')
            assert len(records)==1 and records[0]['generation']==1
            assert records[0]['compensation']==('SIM_UNAVAILABLE' if compensation_failure else 'SIM_GENERATION_MISMATCH')
        finally:resume.set()


def test_post_success_does_not_overwrite_stopping(simulation_context):
    client,sim,cfg,rid,launcher=simulation_context;headers=csrf(client,'one')
    original=client.app.state.simmgr.request;post_held,delete_held,resume=threading.Event(),threading.Event(),threading.Event()
    def delayed(method,path,body=None):
        if method=='POST':
            result=original(method,path,body);post_held.set();assert delete_held.wait(5)
            return result
        if method=='DELETE' and not delete_held.is_set():
            delete_held.set();assert resume.wait(10)
        return original(method,path,body)
    client.app.state.simmgr.request=delayed
    with ThreadPoolExecutor(max_workers=2) as executor:
        start=executor.submit(client.post,'/api/v1/simulation/robots',headers=headers,json={'robot_id':rid,'world_id':'test'})
        try:
            assert post_held.wait(5)
            remove=executor.submit(client.delete,f'/api/v1/simulation/robots/{rid}',headers=headers)
            assert delete_held.wait(5)
            assert start.result(timeout=5).status_code==409
            assert snapshot(client,rid)[0]=='STOPPING'
            resume.set();assert remove.result(timeout=5).status_code==204
            assert snapshot(client,rid)[:3]==('IDLE',None,1) and not sim.app.state.manager.robots
        finally:resume.set()


@pytest.mark.parametrize('interleave',['reacquire','stopping'])
def test_definite_rejection_rechecks_generation_and_state(simulation_context,interleave):
    client,sim,cfg,rid,launcher=simulation_context;headers=csrf(client,'one')
    original=client.app.state.simmgr.request;held,resume=threading.Event(),threading.Event();posts=[0]
    def delayed(method,path,body=None):
        if method=='POST':
            posts[0]+=1
            if posts[0]==1:
                held.set();assert resume.wait(10)
                raise RelayError('SIM_WORLD_NOT_FOUND',404)
        if method=='DELETE' and interleave=='stopping':raise RelayError()
        return original(method,path,body)
    client.app.state.simmgr.request=delayed
    with ThreadPoolExecutor(max_workers=1) as executor:
        start=executor.submit(client.post,'/api/v1/simulation/robots',headers=headers,json={'robot_id':rid,'world_id':'test'})
        try:
            assert held.wait(5)
            assert client.delete(f'/api/v1/simulation/robots/{rid}',headers=headers).status_code==(503 if interleave=='stopping' else 204)
            if interleave=='reacquire':
                assert client.post('/api/v1/simulation/robots',headers=headers,json={'robot_id':rid,'world_id':'test'}).status_code==201
            expected=snapshot(client,rid)
            resume.set();assert start.result(timeout=5).status_code==404
            assert snapshot(client,rid)==expected and not audits(client,'SIM_ROBOT_START_REJECTED')
        finally:resume.set()


@pytest.mark.parametrize('failure',['timeout','5xx'])
def test_transport_posts_are_never_retried(tmp_path,failure):
    private=tmp_path/'secret';private.write_text('x'*32);private.chmod(0o600)
    relay=Relay('http://127.0.0.1:9430',private);calls=[]
    def fail(request,**kwargs):
        calls.append(request.method)
        if failure=='timeout':raise URLError(TimeoutError())
        raise HTTPError(request.full_url,503,'synthetic',{},io.BytesIO(b'{"error":{"code":"SIM_UNAVAILABLE"}}'))
    relay.opener.open=fail
    with pytest.raises(RelayError):relay.request('POST','/v1/robots',{'generation':1})
    assert calls==['POST']
    assert (409,'SIM_GENERATION_STALE') not in START_REJECTIONS
