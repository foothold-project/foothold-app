"""A first delivery can cross a manager restart, even when its response is lost."""
from concurrent.futures import ThreadPoolExecutor, wait
from contextlib import contextmanager
from http.client import BadStatusLine, IncompleteRead
import io
import json
import threading
from types import SimpleNamespace
from urllib.error import HTTPError, URLError
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest

from apps.server.tests.test_simulation import (simulation_context, clean_ros_environment,
    isolated_manager_startup, manager_app)
from apps.server.tests.test_sim_delayed_start import audits
from apps.server.tests.test_sim_recovery import snapshot
from apps.server.fh_server.simulation import Relay, RelayError
from .test_api import csrf


def broken_response(original,failure):
    """Real Relay classification around a synthetic, already delivered POST."""
    transport=Relay.__new__(Relay);transport.url='http://127.0.0.1:9430';transport.secret='x'*32
    @contextmanager
    def opened(request,**kwargs):
        original(request.method,'/v1/robots',json.loads(request.data))
        if failure=='timeout':raise URLError(TimeoutError())
        if failure=='error_body':
            class PartialError(io.BytesIO):
                def read(self,*args):raise IncompleteRead(b'synthetic',20)
            raise HTTPError(request.full_url,503,'synthetic',{},PartialError())
        if failure=='5xx':raise HTTPError(request.full_url,503,'synthetic',{},io.BytesIO(b'{}'))
        if failure=='incomplete':raise IncompleteRead(b'synthetic',20)
        if failure=='bad_status':raise BadStatusLine('synthetic')
        assert failure=='parse'
        yield SimpleNamespace(read=lambda size:b'{')
    transport.opener=SimpleNamespace(open=opened)
    return transport


@pytest.mark.parametrize('lose_response',[False,True,'timeout','5xx','parse','incomplete','bad_status','error_body'])
def test_first_delivery_after_manager_restart_cannot_escape_delete(simulation_context,lose_response):
    client,old,cfg,rid,launcher=simulation_context;headers=csrf(client,'one')
    relay=client.app.state.simmgr;original=relay.request
    held,resume=threading.Event(),threading.Event();posts=[];deletes=[]
    def delayed(method,path,body=None):
        if method=='POST':
            posts.append(body['generation']);held.set();assert resume.wait(10)
            if type(lose_response) is str:
                return broken_response(original,lose_response).request(method,path,body)
            result=original(method,path,body)
            if lose_response:raise RelayError()
            return result
        if method=='DELETE':deletes.append(body['generation'])
        return original(method,path,body)
    relay.request=delayed
    with ThreadPoolExecutor(max_workers=1) as pool:
        start=pool.submit(client.post,'/api/v1/simulation/robots',headers=headers,json={'robot_id':rid,'world_id':'test'})
        try:
            assert held.wait(5)
            assert client.delete(f'/api/v1/simulation/robots/{rid}',headers=headers).status_code==204
            expected=snapshot(client,rid)
            assert old.app.state.manager.removed_generation[rid]==1 and not old.app.state.manager.robots
            old.portal.call(old.app.state.manager.close)
            with TestClient(manager_app(cfg),client=('127.0.0.1',9438)) as new:
                assert not new.app.state.manager.robots and not new.app.state.manager.removed_generation
                relay.client=new  # Receiver of the FIRST delivery changes, never a retry.
                resume.set();response=start.result(timeout=5)
                assert response.status_code==(409 if lose_response is False else 503),response.text
                assert posts==[1] and deletes==[1,1]
                assert not new.app.state.manager.robots
                assert snapshot(client,rid)==expected and expected[:3]==('IDLE',None,1)
                records=audits(client,'SIM_ROBOT_START_STALE')
                assert len(records)==1 and records[0]['compensation']=='REMOVED_OR_ABSENT'
        finally:resume.set()


@pytest.mark.parametrize('successor',[False,True])
def test_uncertain_stale_compensation_failure_never_mutates_current_database(simulation_context,successor):
    client,sim,cfg,rid,launcher=simulation_context;headers=csrf(client,'one')
    original=client.app.state.simmgr.request;held,resume=threading.Event(),threading.Event()
    posts=[];deletes=[]
    def delayed(method,path,body=None):
        if method=='POST':
            posts.append(body['generation']);result=original(method,path,body)
            if len(posts)==1:
                held.set();assert resume.wait(10);raise RelayError()
            return result
        if method=='DELETE':
            deletes.append(body['generation'])
            if len(deletes)==2:raise RelayError('SIM_UNAVAILABLE',503)
        return original(method,path,body)
    client.app.state.simmgr.request=delayed
    with ThreadPoolExecutor(max_workers=1) as pool:
        start=pool.submit(client.post,'/api/v1/simulation/robots',headers=headers,json={'robot_id':rid,'world_id':'test'})
        try:
            assert held.wait(5)
            assert client.delete(f'/api/v1/simulation/robots/{rid}',headers=headers).status_code==204
            if successor:
                result=client.post('/api/v1/simulation/robots',headers=headers,json={'robot_id':rid,'world_id':'test'})
                assert result.status_code==201 and result.json()['generation']==2
            expected=snapshot(client,rid)
            resume.set();assert start.result(timeout=5).status_code==503
            assert deletes==[1,1] and snapshot(client,rid)==expected
            if successor:assert sim.app.state.manager.robots[rid].generation==2
            records=audits(client,'SIM_ROBOT_START_STALE')
            assert len(records)==1 and records[0]['compensation']=='SIM_UNAVAILABLE'
        finally:resume.set()


def test_uncertain_current_starting_retains_runtime_without_compensation(simulation_context):
    client,sim,cfg,rid,launcher=simulation_context;headers=csrf(client,'one')
    original=client.app.state.simmgr.request;posts=[];deletes=[];before=[]
    def lost(method,path,body=None):
        result=original(method,path,body)
        if method=='POST':
            posts.append(body['generation']);before.append(snapshot(client,rid));raise RelayError()
        if method=='DELETE':deletes.append(body['generation'])
        return result
    client.app.state.simmgr.request=lost
    result=client.post('/api/v1/simulation/robots',headers=headers,json={'robot_id':rid,'world_id':'test'})
    assert result.status_code==503 and posts==[1] and not deletes
    assert snapshot(client,rid)==before[0] and snapshot(client,rid)[0]=='STARTING'
    assert rid in sim.app.state.manager.robots and not audits(client,'SIM_ROBOT_START_STALE')


def test_compensation_releases_organization_lock_before_remote_delete(simulation_context,seeded):
    client,sim,cfg,rid,launcher=simulation_context;headers=csrf(client,'one')
    original=client.app.state.simmgr.request
    post_held,resume,compensating,release=tuple(threading.Event() for _ in range(4))
    deletes=[]
    def delayed(method,path,body=None):
        if method=='POST':
            result=original(method,path,body);post_held.set();assert resume.wait(10);return result
        if method=='DELETE':
            deletes.append(body['generation'])
            if len(deletes)==2:compensating.set();assert release.wait(10)
        return original(method,path,body)
    client.app.state.simmgr.request=delayed
    other=str(seeded['robots']['mine'])
    client.app.state.phone_pass_issuer.keys[other]=('test',{'test':b'y'*32})
    with ThreadPoolExecutor(max_workers=2) as pool:
        start=pool.submit(client.post,'/api/v1/simulation/robots',headers=headers,json={'robot_id':rid,'world_id':'test'})
        try:
            assert post_held.wait(5)
            assert client.delete(f'/api/v1/simulation/robots/{rid}',headers=headers).status_code==204
            resume.set();assert compensating.wait(5)
            writer=pool.submit(client.post,f'/api/v1/robots/{other}/phone-pass',headers=headers,
                               json={'device':str(uuid4()),'purpose':'view'})
            done,_=wait([writer],timeout=1)
            assert done,'compensation held the organization write lock during remote IO'
            assert writer.result().status_code==200
            release.set();assert start.result(timeout=5).status_code==409
            assert len(audits(client,'SIM_ROBOT_START_STALE'))==1
        finally:resume.set();release.set()


@pytest.mark.parametrize('failure',['incomplete','bad_status','error_body'])
def test_http_protocol_exception_is_relay_uncertainty(failure):
    calls=[]
    transport=broken_response(lambda *args:calls.append(args),failure)
    error=None
    try:transport.request('POST','/v1/robots',{'generation':1})
    except Exception as caught:error=caught
    assert isinstance(error,RelayError),type(error).__name__
    assert error.status==503 and calls==[('POST','/v1/robots',{'generation':1})]


def test_restart_and_failed_compensation_retains_only_unlinked_orphan(simulation_context):
    from apps.server.fh_server.security import digest
    client,old,cfg,rid,launcher=simulation_context;headers=csrf(client,'one')
    relay=client.app.state.simmgr;original=relay.request
    held,resume=threading.Event(),threading.Event();deletes=[];tokens=[]
    def delayed(method,path,body=None):
        if method=='POST':
            tokens.append(body['agent_token']);held.set();assert resume.wait(10)
            original(method,path,body);raise RelayError()
        if method=='DELETE':
            deletes.append(body['generation'])
            if len(deletes)==2:raise RelayError()
        return original(method,path,body)
    relay.request=delayed
    with ThreadPoolExecutor(max_workers=1) as pool:
        start=pool.submit(client.post,'/api/v1/simulation/robots',headers=headers,json={'robot_id':rid,'world_id':'test'})
        try:
            assert held.wait(5)
            assert client.delete(f'/api/v1/simulation/robots/{rid}',headers=headers).status_code==204
            expected=snapshot(client,rid)
            old.portal.call(old.app.state.manager.close)
            with TestClient(manager_app(cfg),client=('127.0.0.1',9438)) as new:
                relay.client=new;resume.set()
                assert start.result(timeout=5).status_code==503
                assert snapshot(client,rid)==expected and expected[:3]==('IDLE',None,1)
                assert deletes==[1,1] and len(new.app.state.manager.robots)==1
                assert digest(tokens[0])!=expected[3]  # Cannot authenticate to server.
                records=audits(client,'SIM_ROBOT_START_STALE')
                assert len(records)==1 and records[0]['compensation']=='SIM_UNAVAILABLE'
                # Teardown is an OS-free double; actual expiry/STOP0 remains untested.
        finally:resume.set()
