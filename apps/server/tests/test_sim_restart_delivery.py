"""A first delivery can cross a manager restart, even when its response is lost."""
from concurrent.futures import ThreadPoolExecutor, wait
from asyncio import CancelledError
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
        if failure in ('error_body','error_reset','error_timeout'):
            class PartialError(io.BytesIO):
                def read(self,*args):
                    if failure=='error_reset':raise ConnectionResetError('private failure text')
                    if failure=='error_timeout':raise TimeoutError('private failure text')
                    raise IncompleteRead(b'synthetic',20)
            raise HTTPError(request.full_url,503,'synthetic',{},PartialError())
        if failure=='5xx':raise HTTPError(request.full_url,503,'synthetic',{},io.BytesIO(b'{}'))
        if failure=='incomplete':raise IncompleteRead(b'synthetic',20)
        if failure=='bad_status':raise BadStatusLine('synthetic')
        if failure in ('recursion','error_recursion'):
            payload=b'['*30000+b']'*30000
            assert len(payload)<65536
            if failure=='error_recursion':
                raise HTTPError(request.full_url,503,'synthetic',{},io.BytesIO(payload))
            yield SimpleNamespace(read=lambda size:payload)
        else:
            assert failure=='parse'
            yield SimpleNamespace(read=lambda size:b'{')
    transport.opener=SimpleNamespace(open=opened)
    return transport


@pytest.mark.parametrize('lose_response',[False,True,'timeout','5xx','parse','incomplete','bad_status','error_body','recursion','error_recursion','error_reset','error_timeout'])
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


@pytest.mark.parametrize('failure',['incomplete','bad_status','error_body','recursion','error_recursion','error_reset','error_timeout'])
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


@pytest.mark.parametrize('failure',['error_reset','error_timeout'])
def test_delete_body_failure_keeps_stopping_and_audits(simulation_context,failure):
    from apps.server.tests.test_simulation import start_slot
    client,sim,cfg,rid,launcher=simulation_context
    started,headers=start_slot(simulation_context)
    assert started.status_code==201
    original=client.app.state.simmgr.request
    def damaged(method,path,body=None):
        if method=='DELETE':
            return broken_response(lambda *args:None,failure).request(method,path,body)
        return original(method,path,body)
    client.app.state.simmgr.request=damaged
    response=client.delete(f'/api/v1/simulation/robots/{rid}',headers=headers)
    assert response.status_code==503 and response.json()['error']['code']=='SIM_UNAVAILABLE'
    assert 'private failure text' not in response.text
    current=snapshot(client,rid)
    assert current[0]=='STOPPING' and current[1] is not None and current[2]==1
    assert rid in sim.app.state.manager.robots
    records=audits(client,'SIM_ROBOT_REMOVE_FAILED')
    assert len(records)==1 and records[0]['reason']=='SIM_UNAVAILABLE'


@pytest.mark.parametrize('interrupt',[KeyboardInterrupt,SystemExit,CancelledError])
def test_relay_preserves_base_exceptions(interrupt):
    transport=Relay.__new__(Relay);transport.url='http://127.0.0.1:9430';transport.secret='x'*32
    def opened(*args,**kwargs):raise interrupt()
    transport.opener=SimpleNamespace(open=opened)
    with pytest.raises(interrupt):transport.request('POST','/v1/robots',{'generation':1})


@pytest.mark.parametrize('compensation,fragment',[
    ('NOT_CREATED','생성되지 않아 정리할 로봇이 없습니다.'),
    ('REMOVED_OR_ABSENT','이전 세대 로봇이 제거되었거나 이미 없습니다.'),
    ('SIM_UNAVAILABLE','이전 세대 로봇 정리를 확인하지 못했습니다.'),
])
def test_stale_audit_message_describes_compensation(seeded,compensation,fragment):
    from sqlalchemy import create_engine
    from sqlalchemy.orm import Session
    from apps.server.fh_server import event_messages
    from apps.server.fh_server.models import Event
    engine=create_engine(seeded['urls']['app'])
    try:
        with Session(engine) as db:
            record=Event(org_id=seeded['org'],user_id=seeded['users']['one'],
                code='SIM_ROBOT_START_STALE',data={'compensation':compensation})
            event_messages.render(db,record)
            assert fragment in record.message
    finally:engine.dispose()


@pytest.mark.parametrize('phase',['request','send','body','close'])
def test_relay_whole_request_boundary_hides_unexpected_exception(phase):
    transport=Relay.__new__(Relay);transport.url='http://127.0.0.1:9430';transport.secret='x'*32
    @contextmanager
    def opened(*args,**kwargs):
        if phase=='send':raise RuntimeError('private failure text')
        def read(size):
            if phase=='body':raise RuntimeError('private failure text')
            return b'{}'
        yield SimpleNamespace(read=read)
        if phase=='close':raise RuntimeError('private failure text')
    transport.opener=SimpleNamespace(open=opened)
    body={'unsupported':object()} if phase=='request' else {'generation':1}
    with pytest.raises(RelayError) as caught:transport.request('POST','/v1/robots',body)
    assert caught.value.code=='SIM_UNAVAILABLE' and caught.value.status==503
    assert 'private failure text' not in str(caught.value)
