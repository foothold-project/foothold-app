"""Issuer/auth/outbox regressions use the existing isolated PostgreSQL fixture."""
import asyncio
import base64
import json
import os
from pathlib import Path
import sys
import time
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select, update
from sqlalchemy.orm import Session as DBSession, sessionmaker

from apps.server.fh_server.api import Settings, create_app
from apps.server.fh_server.models import Event, PhonePass, PhoneRevocation, PhoneRevocationBatch, PhonePassDenials, Robot, User
from apps.server.fh_server.phone_pass import acknowledge, b64, load_keys, pending, revoke
from .test_api import csrf
from .test_realtime import hello as agent_hello, receive

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'agent'))
from foothold_agent.phone.tickets import Verifier, TicketError
from foothold_agent.phone.hub import Hub
from foothold_agent.phone.observer import Observer
from foothold_agent.phone.server import Server, Settings as PhoneSettings


@pytest.fixture
def pc(seeded, tmp_path):
    rings = {str(r): {'active': 'test', 'keys': {'test': b64(os.urandom(32))}}
             for k, r in seeded['robots'].items() if k != 'foreign'}
    keyfile = tmp_path / 'issuer-keys.json'
    keyfile.write_text(json.dumps(rings)); keyfile.chmod(0o600)
    app = create_app(Settings(seeded['urls']['app'], seeded['org'], phone_pass_keys=str(keyfile)))
    with TestClient(app, base_url='https://testserver') as client:
        client.keys = load_keys(keyfile)
        client.pass_headers = csrf(client)
        yield client
    app.state.engine.dispose()


def issue(pc, seeded, *, robot='mine', device=None, purpose='control', switch=False):
    return pc.post('/api/v1/robots/' + str(seeded['robots'].get(robot, robot)) + '/phone-pass',
                   headers=pc.pass_headers, json=dict(device=str(device or uuid4()), purpose=purpose, switch=switch))


def rows(seeded, model):
    engine = create_engine(seeded['urls']['app'])
    try:
        with DBSession(engine) as db:
            return list(db.scalars(select(model)))
    finally:
        engine.dispose()


def test_issuer_claims_scope_lifetime_csrf_and_no_token_persistence(pc, seeded, caplog):
    rid = seeded['robots']['mine']; device = uuid4()
    denied = pc.post(f'/api/v1/robots/{rid}/phone-pass', json={'device': str(device), 'purpose': 'control'})
    assert denied.status_code == 403
    result = issue(pc, seeded, device=device)
    assert result.status_code == 200 and result.headers['cache-control'] == 'no-store'
    token = result.json()['token']
    claims = json.loads(base64.urlsafe_b64decode(token.split('.')[1] + '=='))
    assert set(claims) == {'iss','aud','org','robot','sub','device','purpose','iat','exp','jti'}
    assert claims['exp'] - claims['iat'] == 600 and abs(claims['iat'] - time.time()) < 3
    assert claims['iss'] == 'fh-control' and claims['aud'] == 'fh-phone/1'
    assert claims['sub'] == str(seeded['users']['admin']) and claims['org'] == str(seeded['org'])
    assert claims['device'] == str(device) and result.json()['exp'] == claims['exp']
    record = rows(seeded, PhonePass)[0]
    assert str(record.jti) == claims['jti'] and record.purpose == 'control'
    serialized = json.dumps([dict(code=e.code, data=e.data, message=e.message) for e in rows(seeded, Event)])
    assert 'PHONE_PASS_ISSUED' in serialized and token not in serialized and token not in caplog.text
    assert token not in str(result.request.url) and token not in str(result.headers)
    assert not {'token', 'signature'} & set(PhonePass.__table__.columns.keys())


@pytest.mark.parametrize('purpose', ['control', 'view'])
def test_issue_permission_hidden_other_org_and_missing_robot(pc, seeded, purpose):
    pc.pass_headers = csrf(pc, 'one')
    for rid in (seeded['robots']['theirs'], seeded['robots']['foreign'], uuid4()):
        result = issue(pc, seeded, robot=rid, purpose=purpose)
        assert result.status_code == 404 and result.json()['error']['code'] == 'NOT_FOUND'
    assert issue(pc, seeded, purpose=purpose).status_code == 200


def test_locked_account_and_missing_key(pc, seeded):
    rid = seeded['robots']['mine']
    engine = create_engine(seeded['urls']['migrate'])
    with DBSession(engine) as db:
        db.get(User, seeded['users']['admin']).locked = True
        db.commit()
    assert issue(pc, seeded).status_code == 401
    pc.pass_headers = csrf(pc, 'one')
    with DBSession(engine) as db:
        db.add(Robot(org_id=seeded['org'], name='no-key', model='test',
                     owner_user_id=seeded['users']['one'], agent_token_hash=os.urandom(32)))
        db.commit()
        rid = db.scalar(select(Robot.id).where(Robot.name == 'no-key'))
    result = issue(pc, seeded, robot=rid)
    assert result.status_code == 503 and result.json()['error']['code'] == 'PASS_KEY_MISSING'
    engine.dispose()


def test_one_phone_one_robot_requires_explicit_switch_and_every_ack(pc, seeded):
    device = uuid4()
    assert issue(pc, seeded, device=device).status_code == 200
    assert issue(pc, seeded, device=device).status_code == 200
    assert issue(pc, seeded, robot='theirs', device=device, purpose='view').status_code == 200
    denied = issue(pc, seeded, robot='theirs', device=device)
    assert denied.status_code == 409 and denied.json()['error']['code'] == 'PASS_OTHER_ROBOT'
    assert 0 < denied.json()['error']['detail']['retry_after'] <= 600
    assert not rows(seeded, PhoneRevocation)
    denied = issue(pc, seeded, robot='theirs', device=device, switch=True)
    assert denied.status_code == 409 and denied.json()['error']['code'] == 'PASS_SWITCH_PENDING'
    # A later same-robot renewal gets a separate immutable batch on re-switch.
    assert issue(pc,seeded,device=device).status_code==200
    assert issue(pc,seeded,robot='theirs',device=device,switch=True).status_code==409
    revoked = rows(seeded, PhoneRevocation)
    assert len(revoked) == 3
    batches=sorted({r.batch_id for r in revoked})
    assert len(batches)==2
    engine = create_engine(seeded['urls']['app']); factory = sessionmaker(engine)
    acknowledge(factory, seeded['org'], str(seeded['robots']['mine']), batches[0])
    assert issue(pc, seeded, robot='theirs', device=device).status_code == 409
    acknowledge(factory, seeded['org'], str(seeded['robots']['mine']), batches[1])
    assert issue(pc, seeded, robot='theirs', device=device).status_code == 200
    engine.dispose()


def test_issuer_limits_persist_across_sessions_and_device_slots(pc, seeded):
    device = uuid4()
    for _ in range(10):
        assert issue(pc, seeded, device=device).status_code == 200
    pc.pass_headers = csrf(pc)
    result = issue(pc, seeded, device=device)
    assert result.status_code == 429 and result.json()['error']['code'] == 'PASS_RATE_LIMIT'
    assert 0 < result.json()['error']['detail']['retry_after'] <= 60
    for _ in range(3):
        assert issue(pc, seeded, purpose='view').status_code == 200
    result = issue(pc, seeded, purpose='view')
    assert result.status_code == 429 and result.json()['error']['code'] == 'PASS_DEVICE_LIMIT'


@pytest.mark.parametrize('action', ['logout', 'lock', 'role', 'owner', 'forced'])
def test_account_and_assignment_writes_create_durable_revocations(pc, seeded, action):
    assert issue(pc, seeded).status_code == 200
    if action == 'logout':
        result = pc.post('/api/v1/auth/logout', headers=pc.pass_headers)
    elif action == 'owner':
        result = pc.patch('/api/v1/robots/' + str(seeded['robots']['mine']), headers=pc.pass_headers,
                          json={'owner_user_id': str(seeded['users']['two'])})
        # Admin passes survive removal of an operator's assignment.
        assert result.status_code == 200 and not rows(seeded, PhoneRevocation)
        pc.pass_headers = csrf(pc, 'two')
        assert issue(pc, seeded).status_code == 200
        pc.pass_headers = csrf(pc)
        result = pc.patch('/api/v1/robots/' + str(seeded['robots']['mine']), headers=pc.pass_headers,
                          json={'owner_user_id': str(seeded['users']['one'])})
    elif action == 'forced':
        session = pc.get('/api/v1/users/' + str(seeded['users']['admin']) + '/sessions').json()['items'][0]
        result = pc.delete('/api/v1/users/' + str(seeded['users']['admin']) + '/sessions/' + session['id'], headers=pc.pass_headers)
    else:
        # Avoid last-admin protection while testing revoke on demotion/locking.
        pc.pass_headers = csrf(pc, 'one')
        assert issue(pc, seeded).status_code == 200
        pc.pass_headers = csrf(pc)
        result = pc.patch('/api/v1/users/' + str(seeded['users']['one']), headers=pc.pass_headers,
                          json={'locked': True} if action == 'lock' else {'role': 'ORG_ADMIN'})
    assert result.status_code in (200,204), result.text
    assert rows(seeded, PhoneRevocation)


def test_authenticated_agent_receives_revocation_replay_and_ack(pc, seeded):
    assert issue(pc, seeded).status_code == 200
    engine = create_engine(seeded['urls']['app']); factory = sessionmaker(engine)
    with factory.begin() as db:
        revoke(db, seeded['org'], user_id=seeded['users']['admin'])
    rid = str(seeded['robots']['mine'])
    from apps.server.fh_server.security import digest
    with factory.begin() as db:
        db.get(Robot, seeded['robots']['mine']).agent_token_hash = digest('fake-unique-phone-agent')
    packets = []
    for _ in range(2):
        with pc.websocket_connect('/api/v1/agent/ws', headers={'authorization': 'Bearer fake-unique-phone-agent'}) as ws:
            ws.send_json(agent_hello())
            frame = receive(ws, 'phone.revoke')
            packets.append(frame)
            ws.send_json({'t':'phone.revoke.ack','seq':frame['seq']})
            for _ in range(100):
                if rows(seeded, PhoneRevocation)[0].acked_at is not None:
                    break
                time.sleep(.01)
            assert rows(seeded, PhoneRevocation)[0].acked_at is not None
    assert packets[0] == packets[1] and pending(factory, seeded['org'], rid, 0) == [packets[0]]
    engine.dispose()


@pytest.mark.parametrize('purpose', ['control', 'view'])
def test_server_issued_pass_round_trip_actual_agent_websocket(pc, seeded, tmp_path, purpose):
    issued = issue(pc, seeded, purpose=purpose)
    assert issued.status_code == 200
    compact = issued.json()['token']
    claims = json.loads(base64.urlsafe_b64decode(compact.split('.')[1]+'=='))
    rid = claims['robot']; outputs = []
    verifier = Verifier(rid, pc.keys[rid][1], org=str(seeded['org']),
                        replay_path=str(tmp_path/'replay.sqlite'), clock_trusted=True)
    sink = type('Sink', (), {'apply': lambda _, c: outputs.append(c)})()
    hub = Hub(verifier, sink, policy_name='test', policy_version='1', simulation=True)
    async def run():
        import socket
        from websockets.asyncio.client import connect
        sock = socket.socket()
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
        server = Server(hub, PhoneSettings('127.0.0.1',port,'unused','test','1',str(seeded['org']),
                                          'unused',True,True), sock=sock)
        task = asyncio.create_task(server.run())
        await asyncio.wait_for(server.ready.wait(),2)
        try:
            async with connect(f'ws://127.0.0.1:{port}/phone/ws',proxy=None) as ws:
                async def rpc(t, **fields):
                    ident=str(uuid4())
                    await ws.send(json.dumps(dict(t=t,id=ident,robot=rid,**fields)))
                    async def read():
                        while True:
                            packet=json.loads(await ws.recv())
                            if packet.get('id')==ident:
                                return packet
                    return await asyncio.wait_for(read(),2)
                assert (await rpc('hello',proto='fh-phone/1',device=claims['device'],ticket=compact))['t']=='hello'
                take = await rpc('lease.take')
                assert take['ok'] is (purpose=='control')
                if purpose=='view':
                    assert take['error']['code']=='FORBIDDEN'
                assert (await rpc('stop'))['ok']
        finally:
            server.stopping.set()
            await asyncio.wait_for(task,2)
            sock.close()
    try:
        asyncio.run(run())
    finally:
        verifier.close()


@pytest.mark.parametrize('case', ['mode','uid','symlink','directory','active-missing','active-unknown','short','padded'])
def test_server_key_file_rejects_unsafe_files_and_key_rings(tmp_path,monkeypatch,case):
    from apps.server.fh_server import phone_pass
    path=tmp_path/'keys.json'
    rid=str(uuid4()); entry={'active':'test','keys':{'test':b64(os.urandom(32))}}
    path.write_text(json.dumps({rid:entry})); path.chmod(0o600)
    if case=='mode': path.chmod(0o640)
    elif case=='uid': monkeypatch.setattr(phone_pass.os,'geteuid',lambda:os.stat(path).st_uid+1)
    elif case=='symlink':
        link=tmp_path/'link'; link.symlink_to(path); path=link
    elif case=='directory': path=tmp_path
    else:
        if case=='active-missing': del entry['active']
        elif case=='active-unknown': entry['active']='absent'
        elif case=='short': entry['keys']['test']=b64(os.urandom(16))
        elif case=='padded': entry['keys']['test']+='='
        path.write_text(json.dumps({rid:entry}))
    with pytest.raises((ValueError,OSError)):
        load_keys(path)


def test_key_rotation_selects_explicit_active_and_old_agent_key_still_verifies(pc,seeded,tmp_path):
    from apps.server.fh_server.phone_pass import Issuer
    from apps.contracts.models import PhonePassRequest
    rid=str(seeded['robots']['mine']); old=pc.keys[rid][1]['test']; new=os.urandom(32)
    keyfile=tmp_path/'rotated.json'
    keyfile.write_text(json.dumps({rid:{'active':'next','keys':{'test':b64(old),'next':b64(new)}}}))
    keyfile.chmod(0o600)
    issuer=Issuer(load_keys(keyfile),lambda *args:pytest.fail('unexpected issuance denial'))
    engine=create_engine(seeded['urls']['app'])
    with DBSession(engine) as db:
        user=db.get(User,seeded['users']['admin']); robot=db.get(Robot,seeded['robots']['mine'])
        issued=issuer.issue(db,user,robot,PhonePassRequest(device=uuid4(),purpose='view'))
        assert issued['kid']=='next'
        verifier=Verifier(rid,{'test':old,'next':new},org=str(seeded['org']),replay_path=':memory:',clock_trusted=True)
        try: assert verifier.verify(issued['token'])['purpose']=='view'
        finally: verifier.close()
    engine.dispose()


def test_key_generator_forbids_repo_outputs_without_creating_files(tmp_path,monkeypatch):
    from apps.server.tools.generate_phone_keys import generate
    repo=Path(__file__).resolve().parents[3]
    for first,second in ((repo/'tmp'/'phone-pass'/'must-not-create',tmp_path/'agent'),
                         (tmp_path/'same',tmp_path/'same')):
        with pytest.raises(ValueError):
            generate(str(uuid4()),'test',first,second)
        assert not first.exists() and not second.exists()
    # Keep test material inside the worktree; exercise creation using an injected
    # synthetic repository root, never write credentials elsewhere during tests.
    import apps.server.tools.generate_phone_keys as tool
    fake=tmp_path/'synthetic'/'repo'/'apps'/'server'/'tools'/'generate_phone_keys.py'
    monkeypatch.setattr(tool,'__file__',str(fake))
    generate(str(uuid4()),'test',tmp_path/'server.json',tmp_path/'agent.json')
    assert (tmp_path/'server.json').stat().st_mode & 0o777==0o600
    server=json.loads((tmp_path/'server.json').read_text()); agent=json.loads((tmp_path/'agent.json').read_text())
    assert next(iter(server.values()))['keys']==agent


def test_robot_keys_cannot_be_shared(tmp_path):
    secret=b64(os.urandom(32)); entry={'active':'test','keys':{'test':secret}}
    path=tmp_path/'shared.json'; path.write_text(json.dumps({str(uuid4()):entry,str(uuid4()):entry}));path.chmod(0o600)
    with pytest.raises(ValueError): load_keys(path)


def test_issue_budgets_expire_and_expired_metadata_is_cleaned(pc,seeded,monkeypatch):
    from apps.server.fh_server.phone_pass import Issuer
    from apps.contracts.models import PhonePassRequest
    from apps.server.fh_server.api import fail,lock_organization,APIError
    current=[int(time.time())]
    issuer=Issuer(pc.keys,fail,clock=lambda:current[0])
    pc.app.state.phone_pass_issuer.clock=lambda:current[0]
    engine=create_engine(seeded['urls']['app'])
    device=uuid4()
    def mint():
        with DBSession(engine) as db:
            lock_organization(db,seeded['org'])
            result=issuer.issue(db,db.get(User,seeded['users']['admin']),db.get(Robot,seeded['robots']['mine']),
                                PhonePassRequest(device=device,purpose='control'))
            db.commit()
            return result
    try:
        for _ in range(10): mint()
        current[0]+=59
        with pytest.raises(APIError) as error: mint()
        assert error.value.status==429 and error.value.detail['retry_after']==1
        current[0]+=1
        assert mint()
        current[0]+=600
        assert mint()
        assert len(rows(seeded,PhonePass))==1
    finally: engine.dispose()


@pytest.mark.parametrize('action',['archive-user','archive-robot','logout-all'])
def test_delete_and_logout_revoke_all_issued_metadata(pc,seeded,action):
    engine=create_engine(seeded['urls']['migrate'])
    try:
        if action=='archive-user':
            pc.pass_headers=csrf(pc,'one')
            assert issue(pc,seeded).status_code==200
            # Isolate the deletion hook from the already-covered assignment hook.
            with DBSession(engine) as db:
                db.get(Robot,seeded['robots']['mine']).owner_user_id=None
                db.commit()
            pc.pass_headers=csrf(pc)
            response=pc.delete('/api/v1/users/'+str(seeded['users']['one']),headers=pc.pass_headers)
        elif action=='archive-robot':
            assert issue(pc,seeded).status_code==200
            response=pc.delete('/api/v1/robots/'+str(seeded['robots']['mine']),headers=pc.pass_headers)
        else:
            assert issue(pc,seeded).status_code==200
            assert issue(pc,seeded,robot='theirs',purpose='view').status_code==200
            response=pc.post('/api/v1/auth/logout',headers=pc.pass_headers)
        assert response.status_code==204,response.text
        assert {p.jti for p in rows(seeded,PhonePass)}=={r.jti for r in rows(seeded,PhoneRevocation)}
    finally: engine.dispose()


def issue_metadata(db,seeded,*,robot='mine',count=1,device=None,start=None):
    current=int(time.time()) if start is None else start
    created=[]
    for index in range(count):
        row=PhonePass(org_id=seeded['org'],user_id=seeded['users']['admin'],device=device or uuid4(),
                      robot_id=seeded['robots'][robot],purpose='control',jti=uuid4(),iat=current,exp=current+600)
        db.add(row);created.append(row)
    db.flush()
    return created


def test_ack_rejects_other_robot_and_unsent_sequence(pc,seeded,monkeypatch):
    from apps.server.fh_server import phone_pass
    from apps.server.fh_server.security import digest
    engine=create_engine(seeded['urls']['app']);factory=sessionmaker(engine)
    with factory.begin() as db:
        issue_metadata(db,seeded,robot='theirs')
        revoke(db,seeded['org'],robot_id=seeded['robots']['theirs'])
        issue_metadata(db,seeded)
        revoke(db,seeded['org'],robot_id=seeded['robots']['mine'])
        issue_metadata(db,seeded)
        revoke(db,seeded['org'],robot_id=seeded['robots']['mine'])
        db.get(Robot,seeded['robots']['mine']).agent_token_hash=digest('fake-ack-peer')
    batches=sorted(rows(seeded,PhoneRevocationBatch),key=lambda r:r.id)
    other,sent,unsent=[b.id for b in batches]
    original=phone_pass.pending
    def only_sent(*args,**kwargs):
        return [f for f in original(*args,**kwargs) if f['seq']==sent]
    monkeypatch.setattr(phone_pass,'pending',only_sent)
    rid=str(seeded['robots']['mine'])
    with pc.websocket_connect('/api/v1/agent/ws',headers={'authorization':'Bearer fake-ack-peer'}) as ws:
        ws.send_json(agent_hello())
        assert receive(ws,'phone.revoke')['seq']==sent
        ws.send_json({'t':'phone.revoke.ack','seq':other})
        ws.send_json({'t':'phone.revoke.ack','seq':unsent})
        # Reader barrier, then writer barrier: assertions cannot race the queue.
        from .test_realtime import state
        ws.send_json(state())
        time.sleep(.1)
        peer=pc.app.state.realtime.agents[rid]
        pc.portal.call(asyncio.wait_for,peer.phone_ack_queue.join(),2)
        assert all(r.acked_at is None for r in rows(seeded,PhoneRevocation))
        ws.send_json({'t':'phone.revoke.ack','seq':sent})
        for _ in range(100):
            if any(r.acked_at is not None for r in rows(seeded,PhoneRevocation)):break
            time.sleep(.01)
        records=rows(seeded,PhoneRevocation)
        assert {r.batch_id for r in records if r.acked_at is not None}=={sent}
    engine.dispose()


def test_slow_ack_storage_keeps_agent_reader_alive_and_switch_blocked(pc,seeded,monkeypatch):
    import threading
    from apps.server.fh_server import phone_pass
    from apps.server.fh_server.security import digest
    from .test_realtime import state
    engine=create_engine(seeded['urls']['app']);factory=sessionmaker(engine)
    device=uuid4()
    assert issue(pc,seeded,device=device).status_code==200
    assert issue(pc,seeded,robot='theirs',device=device,switch=True).status_code==409
    with factory.begin() as db:db.get(Robot,seeded['robots']['mine']).agent_token_hash=digest('fake-slow-ack')
    entered,release=threading.Event(),threading.Event()
    original=phone_pass.acknowledge
    def slow(*args):
        entered.set()
        assert release.wait(6)
        original(*args)
    monkeypatch.setattr(phone_pass,'acknowledge',slow)
    rid=str(seeded['robots']['mine'])
    try:
        with pc.websocket_connect('/api/v1/agent/ws',headers={'authorization':'Bearer fake-slow-ack'}) as ws:
            ws.send_json(agent_hello());packet=receive(ws,'phone.revoke')
            ws.send_json({'t':'phone.revoke.ack','seq':packet['seq']})
            assert entered.wait(2)
            for _ in range(15):
                ws.send_json(state())
                time.sleep(.2)
            assert not rows(seeded,PhoneRevocation)[0].acked_at
            assert issue(pc,seeded,robot='theirs',device=device).status_code==409
            peer=pc.app.state.realtime.agents[rid]
            assert not peer.closing and peer.state_received_at>pc.app.state.realtime.clock()-.5
            release.set()
            pc.portal.call(asyncio.wait_for,peer.phone_ack_queue.join(),2)
            assert rows(seeded,PhoneRevocation)[0].acked_at is not None
            assert issue(pc,seeded,robot='theirs',device=device).status_code==200
    finally:release.set();engine.dispose()


def test_batches_are_wire_bounded_stable_and_ack_all_contained_jtis(pc,seeded):
    engine=create_engine(seeded['urls']['app']);factory=sessionmaker(engine)
    with factory.begin() as db:
        issue_metadata(db,seeded,count=150)
        revoke(db,seeded['org'],robot_id=seeded['robots']['mine'])
    rid=str(seeded['robots']['mine'])
    frames=pending(factory,seeded['org'],rid,0)
    assert len(frames)==2 and frames==pending(factory,seeded['org'],rid,0)
    assert sum(len(i['jtis']) for f in frames for i in f['items'])==150
    for frame in frames:
        assert len(frame['items'])<=16 and all(len(i['jtis'])<=64 for i in frame['items'])
        assert len(json.dumps(frame,separators=(',',':')).encode())<=4096
    acknowledge(factory,seeded['org'],rid,frames[0]['seq'])
    records=rows(seeded,PhoneRevocation)
    assert sum(r.acked_at is not None for r in records)==sum(len(i['jtis']) for i in frames[0]['items'])
    assert any(r.acked_at is None for r in records)
    engine.dispose()


def test_revocation_capacity_reserves_at_issue_but_never_blocks_logout(pc,seeded):
    engine=create_engine(seeded['urls']['app']);factory=sessionmaker(engine)
    with factory.begin() as db:issue_metadata(db,seeded,count=4096)
    result=issue(pc,seeded)
    assert result.status_code==503 and result.json()['error']['code']=='PASS_REVOCATION_CAPACITY'
    assert pc.post('/api/v1/auth/logout',headers=pc.pass_headers).status_code==204
    assert len(rows(seeded,PhoneRevocation))==4096
    assert len(rows(seeded,PhoneRevocationBatch))<4096
    engine.dispose()


def test_denial_audits_are_globally_batched_and_counter_survives_issuer_restart(pc,seeded):
    from apps.server.fh_server.phone_pass import Issuer
    from apps.server.fh_server.api import APIError,fail,lock_organization
    current=[float(int(time.time()))]
    issuer=Issuer(pc.keys,fail,clock=lambda:current[0])
    pc.app.state.phone_pass_issuer.clock=lambda:current[0]
    engine=create_engine(seeded['urls']['app']);factory=sessionmaker(engine)
    def deny():
        with DBSession(engine) as db:
            lock_organization(db,seeded['org'])
            with pytest.raises(APIError):issuer.deny(db,db.get(User,seeded['users']['admin']),429,'PASS_RATE_LIMIT')
    for i in range(100):
        current[0]+=0.005
        deny()
    assert not [e for e in rows(seeded,Event) if e.code=='PHONE_PASS_DENIED']
    # Fresh issuer and time source drain durable pending counts, including quiet time.
    current[0]+=1
    restarted=Issuer(pc.keys,fail,clock=lambda:current[0])
    restarted.flush_denials(factory,seeded['org'])
    events=[e for e in rows(seeded,Event) if e.code=='PHONE_PASS_DENIED']
    assert len(events)==1 and events[0].data['count']==100
    current[0]+=5;restarted.flush_denials(factory,seeded['org'])
    assert len([e for e in rows(seeded,Event) if e.code=='PHONE_PASS_DENIED'])==1
    assert rows(seeded,PhonePassDenials)[0].count==0
    engine.dispose()


def test_revocation_and_pending_use_injected_issuer_utc(pc,seeded):
    current=[1600000000]
    pc.app.state.phone_pass_issuer.clock=lambda:current[0]
    assert issue(pc,seeded).status_code==200
    assert pc.post('/api/v1/auth/logout',headers=pc.pass_headers).status_code==204
    engine=create_engine(seeded['urls']['app']);factory=sessionmaker(engine)
    rid=str(seeded['robots']['mine'])
    assert pending(factory,seeded['org'],rid,0,lambda:current[0])
    current[0]+=600
    assert not pending(factory,seeded['org'],rid,0,lambda:current[0])
    engine.dispose()


def test_batch_packing_limits_distinct_expiry_items():
    from types import SimpleNamespace
    from apps.server.fh_server.phone_pass import pack
    records=[SimpleNamespace(jti=uuid4(),exp=1800000000+i) for i in range(33)]
    batches=list(pack(records))
    assert len(batches)==3 and sum(len(members) for _,members in batches)==33
    assert all(1<=len(items)<=16 for items,_ in batches)
