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
    for i in range(10):
        assert issue(pc, seeded, robot=('mine','theirs')[i%2], device=device, purpose='view').status_code == 200
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
    def mint(robot='mine'):
        with DBSession(engine) as db:
            lock_organization(db,seeded['org'])
            result=issuer.issue(db,db.get(User,seeded['users']['admin']),db.get(Robot,seeded['robots'][robot]),
                                PhonePassRequest(device=device,purpose='view'))
            db.commit()
            return result
    try:
        for i in range(10): mint(('mine','theirs')[i%2])
        current[0]+=59
        with pytest.raises(APIError) as error: mint()
        assert error.value.status==429 and error.value.detail['retry_after']==1
        current[0]+=1
        assert mint()
        current[0]+=600
        assert mint()
        assert len(rows(seeded,PhonePass))==2  # expiry+60s retention; authority already expired
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


def issue_metadata(db,seeded,*,robot='mine',count=1,device=None,start=None,user='admin'):
    current=int(time.time()) if start is None else start
    created=[]
    for index in range(count):
        row=PhonePass(org_id=seeded['org'],user_id=seeded['users'][user],device=device or uuid4(),
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
    with factory.begin() as db:issue_metadata(db,seeded,count=4096,user='one')
    result=issue(pc,seeded)
    assert result.status_code==503 and result.json()['error']['code']=='PASS_REVOCATION_CAPACITY'
    pc.pass_headers=csrf(pc,'one')  # legacy overfull owner can still revoke everything
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
    assert pending(factory,seeded['org'],rid,0,lambda:current[0])
    current[0]+=60
    assert not pending(factory,seeded['org'],rid,0,lambda:current[0])
    engine.dispose()


def test_batch_packing_limits_distinct_expiry_items():
    from types import SimpleNamespace
    from apps.server.fh_server.phone_pass import pack
    records=[SimpleNamespace(jti=uuid4(),exp=1800000000+i) for i in range(33)]
    batches=list(pack(records))
    assert len(batches)==3 and sum(len(members) for _,members in batches)==33
    assert all(1<=len(items)<=16 for items,_ in batches)


def ack_harness():
    """Real ACK queue/writer with a socket recording transport decisions."""
    from types import SimpleNamespace
    from apps.server.fh_server.realtime import Realtime
    class Socket:
        def __init__(self): self.closed=[]
        async def close(self,code,reason=''): self.closed.append((code,reason))
    def peer():
        return SimpleNamespace(phone_revoke_sent=1000,phone_revoke_retry=None,
            phone_ack_queue=asyncio.Queue(128),phone_ack_pending=set(),closing=False,socket=Socket())
    rt=Realtime.__new__(Realtime)
    rt.settings=SimpleNamespace(org_id='test');rt.phone_pass_factory=None;rt.phone_ack_stores={}
    rt.agents={'r':peer()}
    rt.retire_agent=lambda rid,p:setattr(p,'closing',True)
    return rt,peer


def test_full_ack_queue_retries_lowest_unconfirmed_and_deduplicates(monkeypatch):
    from apps.server.fh_server import phone_pass
    saved=[]
    monkeypatch.setattr(phone_pass,'acknowledge',lambda *args:saved.append(args[-1]))
    async def run():
        rt,_=ack_harness();peer=rt.agents['r']
        peer.phone_revoke_sent=130
        for seq in range(1,131):rt.queue_phone_ack('r',peer,seq)
        assert peer.phone_ack_queue.qsize()==128
        assert peer.phone_revoke_sent==128 and peer.phone_revoke_retry==128
        for _ in range(20):rt.queue_phone_ack('r',peer,1)
        assert peer.phone_ack_queue.qsize()==128
        writer=asyncio.create_task(rt.phone_ack_writer('r',peer))
        try:
            await asyncio.wait_for(peer.phone_ack_queue.join(),2)
            # Next pending read starts before the lowest unconfirmed seq.
            peer.phone_revoke_sent=130
            for seq in (129,130):rt.queue_phone_ack('r',peer,seq)
            await asyncio.wait_for(peer.phone_ack_queue.join(),2)
            assert saved==list(range(1,131)) and not peer.closing
        finally:writer.cancel();await asyncio.gather(writer,return_exceptions=True)
    asyncio.run(run())


def test_ack_deduplicates_while_saving_and_ignores_old_peer(monkeypatch):
    import threading
    from apps.server.fh_server import phone_pass
    entered,release=threading.Event(),threading.Event();saved=[]
    def save(*args):
        saved.append(args[-1]);entered.set();release.wait(3)
    monkeypatch.setattr(phone_pass,'acknowledge',save)
    async def run():
        rt,new_peer=ack_harness();peer=rt.agents['r']
        rt.queue_phone_ack('r',peer,1)
        writer=asyncio.create_task(rt.phone_ack_writer('r',peer))
        try:
            assert await asyncio.to_thread(entered.wait,1)
            for _ in range(20):rt.queue_phone_ack('r',peer,1)
            assert peer.phone_ack_queue.empty() and peer.phone_ack_pending=={1}
            rt.agents['r']=new_peer()
            rt.queue_phone_ack('r',peer,2)
            assert peer.phone_ack_queue.empty()
            release.set();await asyncio.wait_for(peer.phone_ack_queue.join(),2)
            assert saved==[1]
        finally:release.set();writer.cancel();await asyncio.gather(writer,return_exceptions=True)
    asyncio.run(run())


def test_ack_storage_error_closes_1013_without_confirmation(monkeypatch):
    from apps.server.fh_server import phone_pass
    def broken(*args):raise OSError('synthetic storage failure')
    monkeypatch.setattr(phone_pass,'acknowledge',broken)
    async def run():
        rt,_=ack_harness();peer=rt.agents['r'];rt.queue_phone_ack('r',peer,1)
        await asyncio.wait_for(rt.phone_ack_writer('r',peer),1)
        assert peer.closing and peer.socket.closed==[(1013,'REVOCATION_ACK_STORAGE_UNAVAILABLE')]
    asyncio.run(run())


def test_ack_timeout_late_commit_and_reconnect_are_bounded_and_idempotent(pc,seeded,monkeypatch):
    import threading
    from apps.server.fh_server import phone_pass,realtime
    engine=create_engine(seeded['urls']['app']);factory=sessionmaker(engine)
    device=uuid4()
    assert issue(pc,seeded,device=device).status_code==200
    assert issue(pc,seeded,device=device).status_code==200
    assert issue(pc,seeded,robot='theirs',device=device,switch=True).status_code==409
    batch=rows(seeded,PhoneRevocationBatch)[0].id
    entered,release=threading.Event(),threading.Event();calls=[]
    original=phone_pass.acknowledge
    def blocked(*args):
        calls.append(args[-1]);entered.set();assert release.wait(4);original(*args)
    monkeypatch.setattr(phone_pass,'acknowledge',blocked)
    monkeypatch.setattr(realtime,'PHONE_ACK_STORAGE_TIMEOUT',.15)
    async def run():
        rt,new_peer=ack_harness();old=rt.agents['r']
        rt.settings.org_id=seeded['org'];rt.phone_pass_factory=factory
        rid=str(seeded['robots']['mine']);rt.agents={rid:old}
        rt.queue_phone_ack(rid,old,batch)
        first=asyncio.create_task(rt.phone_ack_writer(rid,old))
        await asyncio.wait_for(first,1)
        assert old.socket.closed==[(1013,'REVOCATION_ACK_STORAGE_TIMEOUT')]
        assert entered.is_set() and len(calls)==1 and len(rt.phone_ack_stores)==1
        assert all(r.acked_at is None for r in rows(seeded,PhoneRevocation))
        assert issue(pc,seeded,robot='theirs',device=device).status_code==409
        snapshot=(old.phone_revoke_sent,set(old.phone_ack_pending),old.phone_ack_queue.qsize(),list(old.socket.closed))
        new=new_peer();rt.agents[rid]=new
        rt.queue_phone_ack(rid,new,batch)
        second=asyncio.create_task(rt.phone_ack_writer(rid,new))
        await asyncio.sleep(.04)
        assert len(calls)==1  # no second thread while the old robot slot is occupied
        release.set();await asyncio.wait_for(new.phone_ack_queue.join(),2)
        second.cancel();await asyncio.gather(second,return_exceptions=True)
        stamps={r.acked_at for r in rows(seeded,PhoneRevocation)}
        assert len(stamps)==1 and None not in stamps and len(calls)==2
        assert snapshot==(old.phone_revoke_sent,set(old.phone_ack_pending),old.phone_ack_queue.qsize(),list(old.socket.closed))
        # Both the new connection and a late duplicate preserve the first commit.
        original(factory,seeded['org'],rid,batch)
        assert {r.acked_at for r in rows(seeded,PhoneRevocation)}==stamps
        assert issue(pc,seeded,robot='theirs',device=device).status_code==200
    try:asyncio.run(run())
    finally:release.set();engine.dispose()


def retained_batches(db,seeded,count,*,until=None):
    """Legacy one-JTI ACKed history, still occupying the agent's journal."""
    from apps.server.fh_server.models import now
    expiry=int(time.time())+600 if until is None else until
    for _ in range(count):
        jti=uuid4()
        batch=PhoneRevocationBatch(org_id=seeded['org'],robot_id=seeded['robots']['mine'],
            items=[dict(jtis=[str(jti)],until=expiry)],until=expiry)
        db.add(batch);db.flush()
        db.add(PhoneRevocation(org_id=seeded['org'],robot_id=seeded['robots']['mine'],
            jti=jti,until=expiry,batch_id=batch.id,acked_at=now()))
    db.flush()


def test_acked_batches_still_reserve_agent_rows(pc,seeded):
    from apps.server.fh_server.phone_pass import reserved_usage
    engine=create_engine(seeded['urls']['app'])
    try:
        with DBSession(engine) as db:
            retained_batches(db,seeded,4097);db.commit()
            count,size=reserved_usage(db,seeded['org'],seeded['robots']['mine'],int(time.time()))
            assert count==4097 and 0<size<1024*1024
        result=issue(pc,seeded)
        assert result.status_code==503 and result.json()['error']['code']=='PASS_REVOCATION_CAPACITY'
        assert pc.post('/api/v1/auth/logout',headers=pc.pass_headers).status_code==204
    finally:engine.dispose()


def test_revocation_byte_reservation_is_independent_of_rows(pc,seeded):
    from apps.server.fh_server.phone_pass import reserved_usage
    engine=create_engine(seeded['urls']['app'])
    try:
        with DBSession(engine) as db:
            issue_metadata(db,seeded,count=255,user='one');db.commit()
            assert reserved_usage(db,seeded['org'],seeded['robots']['mine'],int(time.time()))==(255,255*4096)
        assert issue(pc,seeded,purpose='view').status_code==200
        result=issue(pc,seeded,purpose='view')
        assert result.status_code==503 and result.json()['error']['code']=='PASS_REVOCATION_CAPACITY'
        assert pc.post('/api/v1/auth/logout',headers=pc.pass_headers).status_code==204
    finally:engine.dispose()


@pytest.mark.parametrize('delta,kept',[(0,True),(59,True),(60,False),(61,False)])
def test_reservation_expiry_includes_robot_clock_grace(pc,seeded,delta,kept):
    from apps.server.fh_server.phone_pass import reserved_usage
    expiry=1800000000
    engine=create_engine(seeded['urls']['app']);factory=sessionmaker(engine)
    try:
        with factory.begin() as db:
            retained_batches(db,seeded,1,until=expiry)
            issue_metadata(db,seeded,start=expiry-600)
        current=expiry+delta
        with DBSession(engine) as db:
            count,size=reserved_usage(db,seeded['org'],seeded['robots']['mine'],current)
            batch=db.scalar(select(PhoneRevocationBatch))
            exact=len(json.dumps(dict(t='phone.revoke',seq=batch.id,items=batch.items),sort_keys=True,separators=(',',':')).encode())
            assert (count,size)==((2,4096+exact) if kept else (0,0))
        assert bool(pending(factory,seeded['org'],str(seeded['robots']['mine']),0,lambda:current))==kept
        with factory.begin() as db:
            revoke(db,seeded['org'],robot_id=seeded['robots']['mine'],clock=lambda:current)
        assert len(rows(seeded,PhoneRevocation))==(2 if kept else 1)
    finally:engine.dispose()


def test_last_retained_row_slot_is_serialized(pc,seeded):
    import threading
    from apps.server.fh_server.api import fail,lock_organization,APIError
    from apps.server.fh_server.phone_pass import Issuer
    from apps.contracts.models import PhonePassRequest
    engine=create_engine(seeded['urls']['app']);barrier=threading.Barrier(2);results=[]
    try:
        with DBSession(engine) as db:retained_batches(db,seeded,4095);db.commit()
        def mint():
            with DBSession(engine) as db:
                barrier.wait()
                lock_organization(db,seeded['org'])
                try:
                    Issuer(pc.keys,fail).issue(db,db.get(User,seeded['users']['admin']),db.get(Robot,seeded['robots']['mine']),
                        PhonePassRequest(device=uuid4(),purpose='control'))
                    db.commit();results.append(200)
                except APIError as error:results.append(error.status)
        threads=[threading.Thread(target=mint) for _ in range(2)]
        for thread in threads:thread.start()
        for thread in threads:thread.join(10)
        assert all(not t.is_alive() for t in threads) and sorted(results)==[200,503]
    finally:engine.dispose()


def test_pending_does_not_repeat_sent_sequence_and_switch_preserves_view(pc,seeded):
    device=uuid4()
    assert issue(pc,seeded,device=device,purpose='control').status_code==200
    assert issue(pc,seeded,device=device,purpose='view').status_code==200
    assert issue(pc,seeded,robot='theirs',device=device,switch=True).status_code==409
    records=rows(seeded,PhonePass)
    view=next(p for p in records if p.purpose=='view')
    assert view.jti not in {r.jti for r in rows(seeded,PhoneRevocation)}
    engine=create_engine(seeded['urls']['app']);factory=sessionmaker(engine)
    try:
        rid=str(seeded['robots']['mine']);frames=pending(factory,seeded['org'],rid,0)
        assert len(frames)==1
        assert not pending(factory,seeded['org'],rid,frames[-1]['seq'])
    finally:engine.dispose()


def test_denial_audit_keeps_top_eight_users_and_quiet_background_flush(pc,seeded):
    from apps.server.fh_server.api import APIError
    issuer=pc.app.state.phone_pass_issuer
    clock=[time.time()];issuer.clock=lambda:clock[0]
    engine=create_engine(seeded['urls']['app'])
    try:
        with DBSession(engine) as db:
            identities=[]
            for n in range(10):
                user=User(org_id=seeded['org'],username='synthetic-denial-'+str(n),display_name='synthetic',
                    password_hash='unused',role='OPERATOR')
                db.add(user);db.flush();identities.append(user.id)
            db.commit()
            for count,identity in enumerate(identities,1):
                for _ in range(count):
                    with pytest.raises(APIError):issuer.deny(db,db.get(User,identity),429,'PASS_RATE_LIMIT')
        assert not [e for e in rows(seeded,Event) if e.code=='PHONE_PASS_DENIED']
        clock[0]+=1.01
        deadline=time.monotonic()+2.5
        events=[]
        while time.monotonic()<deadline:
            events=[e for e in rows(seeded,Event) if e.code=='PHONE_PASS_DENIED']
            if events:break
            time.sleep(.02)
        assert len(events)==1 and events[0].data['count']==55
        assert events[0].data['users']==[{'user_id':str(identities[i]),'count':i+1} for i in range(9,1,-1)]
        assert events[0].data['other_count']==3
        time.sleep(1.05)
        assert len([e for e in rows(seeded,Event) if e.code=='PHONE_PASS_DENIED'])==1
    finally:engine.dispose()


def test_real_ws_full_ack_queue_replays_and_switch_opens_only_after_atomic_commit(pc,seeded,monkeypatch):
    import threading
    from apps.server.fh_server import phone_pass,realtime
    from apps.server.fh_server.security import digest
    from .test_realtime import state
    device=uuid4()
    assert issue(pc,seeded,device=device).status_code==200
    assert issue(pc,seeded,device=device).status_code==200
    engine=create_engine(seeded['urls']['app']);factory=sessionmaker(engine)
    with factory.begin() as db:
        db.get(Robot,seeded['robots']['mine']).agent_token_hash=digest('synthetic-overflow-agent')
        for _ in range(129):
            issue_metadata(db,seeded,user='one')
            revoke(db,seeded['org'],user_id=seeded['users']['one'])
    assert issue(pc,seeded,robot='theirs',device=device,switch=True).status_code==409
    frames=rows(seeded,PhoneRevocationBatch);last=max(b.id for b in frames)
    assert len(frames)==130
    entered,release=threading.Event(),threading.Event()
    original=phone_pass.acknowledge
    def blocked(*args):
        entered.set();assert release.wait(12);original(*args)
    monkeypatch.setattr(phone_pass,'acknowledge',blocked)
    monkeypatch.setattr(realtime,'PHONE_ACK_STORAGE_TIMEOUT',15)
    rid=str(seeded['robots']['mine'])
    try:
        with pc.websocket_connect('/api/v1/agent/ws',headers={'authorization':'Bearer synthetic-overflow-agent'}) as ws:
            ws.send_json(agent_hello())
            seen=[]
            for _ in range(130):
                frame=receive(ws,'phone.revoke');seen.append(frame['seq'])
                ws.send_json({'t':'phone.revoke.ack','seq':frame['seq']});ws.send_json(state())
            assert entered.is_set() and len(set(seen))==130
            # A full ACK queue must recover on this same connection, without a new hello.
            repeated=receive(ws,'phone.revoke',timeout=2)
            assert repeated['seq']==last
            ws.send_json({'t':'phone.revoke.ack','seq':last});ws.send_json(state())
            assert issue(pc,seeded,robot='theirs',device=device).status_code==409
            assert all(r.acked_at is None for r in rows(seeded,PhoneRevocation))
            release.set()
            peer=pc.app.state.realtime.agents[rid]
            pc.portal.call(asyncio.wait_for,peer.phone_ack_queue.join(),2)
            # The agent ACKs every replay; the ACK sent while full also needed replay.
            replay=receive(ws,'phone.revoke',timeout=2)
            assert replay['seq']==last
            ws.send_json({'t':'phone.revoke.ack','seq':last});ws.send_json(state())
            deadline=time.monotonic()+3
            confirmed=[]
            while time.monotonic()<deadline:
                confirmed=[r for r in rows(seeded,PhoneRevocation) if r.batch_id==last]
                assert len({r.acked_at is None for r in confirmed})==1
                if confirmed and confirmed[0].acked_at is not None:break
                ws.send_json(state());time.sleep(.02)
            assert len(confirmed)==2 and len({r.acked_at for r in confirmed})==1 and confirmed[0].acked_at is not None
            assert issue(pc,seeded,robot='theirs',device=device).status_code==200
            peer=pc.app.state.realtime.agents[rid]
            assert not peer.closing
            ws.send_json({'t':'phone.revoke.ack','seq':last});ws.send_json(state())
            pc.portal.call(asyncio.sleep,.05)
            pc.portal.call(asyncio.wait_for,peer.phone_ack_queue.join(),2)
            assert {r.acked_at for r in rows(seeded,PhoneRevocation) if r.batch_id==last}=={confirmed[0].acked_at}
    finally:release.set();engine.dispose()


def test_real_ws_ack_storage_failure_closes_with_exact_reason_and_replays(pc,seeded,monkeypatch):
    from starlette.websockets import WebSocketDisconnect
    from apps.server.fh_server import phone_pass
    from apps.server.fh_server.security import digest
    from .test_realtime import state
    assert issue(pc,seeded).status_code==200
    engine=create_engine(seeded['urls']['app']);factory=sessionmaker(engine)
    with factory.begin() as db:
        revoke(db,seeded['org'],user_id=seeded['users']['admin'])
        db.get(Robot,seeded['robots']['mine']).agent_token_hash=digest('synthetic-failure-agent')
    original=phone_pass.acknowledge
    def broken(*args):raise OSError('synthetic storage failure')
    monkeypatch.setattr(phone_pass,'acknowledge',broken)
    connect=lambda:pc.websocket_connect('/api/v1/agent/ws',headers={'authorization':'Bearer synthetic-failure-agent'})
    try:
        with connect() as ws:
            ws.send_json(agent_hello());packet=receive(ws,'phone.revoke')
            ws.send_json({'t':'phone.revoke.ack','seq':packet['seq']})
            with pytest.raises(WebSocketDisconnect) as closed:receive(ws,'never',timeout=2)
            assert (closed.value.code,closed.value.reason)==(1013,'REVOCATION_ACK_STORAGE_UNAVAILABLE')
        assert all(r.acked_at is None for r in rows(seeded,PhoneRevocation))
        monkeypatch.setattr(phone_pass,'acknowledge',original)
        with connect() as ws:
            ws.send_json(agent_hello());again=receive(ws,'phone.revoke')
            assert again==packet
            ws.send_json({'t':'phone.revoke.ack','seq':again['seq']});ws.send_json(state())
            deadline=time.monotonic()+1
            while time.monotonic()<deadline and any(r.acked_at is None for r in rows(seeded,PhoneRevocation)):time.sleep(.01)
            assert all(r.acked_at is not None for r in rows(seeded,PhoneRevocation))
    finally:engine.dispose()


def test_active_pass_limit_is_per_user_robot_across_devices_and_purposes(pc,seeded):
    current=[int(time.time())];pc.app.state.phone_pass_issuer.clock=lambda:current[0]
    devices=[uuid4() for _ in range(4)]
    for i in range(8):
        assert issue(pc,seeded,device=devices[i%4],purpose=('control','view')[i%2]).status_code==200
        current[0]+=1
    # Fresh session and a different declared device cannot reset the robot cap.
    pc.pass_headers=csrf(pc)
    limited=issue(pc,seeded,device=devices[1])
    assert limited.status_code==429 and limited.json()['error']['code']=='PASS_ACTIVE_LIMIT'
    assert limited.json()['error']['detail']=={'retry_after':652,'limit':'active'}
    assert issue(pc,seeded,robot='theirs',device=devices[0],purpose='view').status_code==200
    pc.pass_headers=csrf(pc,'one')
    assert issue(pc,seeded,purpose='view').status_code==200
    pc.pass_headers=csrf(pc)
    current[0]+=652
    assert issue(pc,seeded,device=devices[1]).status_code==200
    limited=issue(pc,seeded,device=devices[1])
    assert limited.status_code==429 and limited.json()['error']['detail']['retry_after']==1


def test_retry_floor_survives_inflight_pending_overwrite(monkeypatch):
    async def run():
        rt,_=ack_harness();peer=rt.agents['r'];rt.factory=None;rt.phone_pass_clock=time.time
        entered,release=asyncio.Event(),asyncio.Event();afters=[]
        for seq in range(1,129):
            peer.phone_ack_queue.put_nowait(seq);peer.phone_ack_pending.add(seq)
        async def read(fn,factory,org,rid,after,clock):
            afters.append(after)
            if len(afters)==1:return [dict(t='phone.revoke',seq=129),dict(t='phone.revoke',seq=130)]
            if len(afters)==2:
                entered.set();await release.wait()
                return [dict(t='phone.revoke',seq=200)]
            peer.closing=True
            return []
        rt.read=read;rt.put=lambda *args:None
        task=asyncio.create_task(rt.phone_revocations('r',peer))
        try:
            await asyncio.wait_for(entered.wait(),1)
            rt.queue_phone_ack('r',peer,129)
            assert peer.phone_revoke_sent==128 and peer.phone_revoke_retry==128
            release.set();await asyncio.wait_for(task,1)
            assert afters==[0,130,128]  # returned seq200 must not erase the floor
        finally:release.set();task.cancel();await asyncio.gather(task,return_exceptions=True)
    asyncio.run(run())


def test_denial_users_reset_between_batches(pc,seeded):
    from apps.server.fh_server.api import APIError
    clock=[time.time()];issuer=pc.app.state.phone_pass_issuer;issuer.clock=lambda:clock[0]
    engine=create_engine(seeded['urls']['app']);factory=sessionmaker(engine)
    try:
        for user,count in [('admin',5),('one',1)]:
            with DBSession(engine) as db:
                for _ in range(count):
                    with pytest.raises(APIError):issuer.deny(db,db.get(User,seeded['users'][user]),429,'PASS_RATE_LIMIT')
            clock[0]+=1.01;issuer.flush_denials(factory,seeded['org'])
        events=sorted((e for e in rows(seeded,Event) if e.code=='PHONE_PASS_DENIED'),key=lambda e:e.id)
        assert [e.data['users'] for e in events]==[
            [{'user_id':str(seeded['users']['admin']),'count':5}],
            [{'user_id':str(seeded['users']['one']),'count':1}]]
        assert [e.data['other_count'] for e in events]==[0,0]
        assert rows(seeded,PhonePassDenials)[0].users=={}
    finally:engine.dispose()


@pytest.mark.parametrize('failure',['statement','lock'])
def test_ack_database_timeouts_release_robot_slot(pc,seeded,monkeypatch,failure):
    from sqlalchemy import text
    from starlette.websockets import WebSocketDisconnect
    from apps.server.fh_server import phone_pass
    from apps.server.fh_server.security import digest
    from .test_realtime import state
    assert issue(pc,seeded).status_code==200
    engine=create_engine(seeded['urls']['app']);factory=sessionmaker(engine)
    with factory.begin() as db:
        revoke(db,seeded['org'],user_id=seeded['users']['admin'])
        db.get(Robot,seeded['robots']['mine']).agent_token_hash=digest('synthetic-db-timeout-agent')
    rt=pc.app.state.realtime
    with rt.phone_pass_factory() as db:
        assert db.scalar(text('SHOW statement_timeout'))=='2s'
        assert db.scalar(text('SHOW lock_timeout'))=='1s'
    original=phone_pass.acknowledge;lock=None
    if failure=='statement':
        def slow(factory,*args):
            with factory.begin() as db:db.execute(text('SELECT pg_sleep(4)'))
            original(factory,*args)
        monkeypatch.setattr(phone_pass,'acknowledge',slow)
    else:
        lock=engine.connect();lock.begin()
        lock.execute(update(PhoneRevocation).values(acked_at=None))
    connect=lambda:pc.websocket_connect('/api/v1/agent/ws',headers={'authorization':'Bearer synthetic-db-timeout-agent'})
    rid=str(seeded['robots']['mine'])
    try:
        with connect() as ws:
            ws.send_json(agent_hello());packet=receive(ws,'phone.revoke')
            ws.send_json(state());start=time.monotonic()
            ws.send_json({'t':'phone.revoke.ack','seq':packet['seq']})
            with pytest.raises(WebSocketDisconnect) as closed:receive(ws,'never',timeout=2.8)
            assert (closed.value.code,closed.value.reason)==(1013,'REVOCATION_ACK_STORAGE_UNAVAILABLE')
            assert time.monotonic()-start<2.8
        deadline=time.monotonic()+1
        while rid in rt.phone_ack_stores and time.monotonic()<deadline:time.sleep(.01)
        assert rid not in rt.phone_ack_stores
        assert all(r.acked_at is None for r in rows(seeded,PhoneRevocation))
        if lock is not None:lock.rollback();lock.close();lock=None
        monkeypatch.setattr(phone_pass,'acknowledge',original)
        with connect() as ws:
            ws.send_json(agent_hello());assert receive(ws,'phone.revoke')==packet
            ws.send_json({'t':'phone.revoke.ack','seq':packet['seq']});ws.send_json(state())
            deadline=time.monotonic()+1
            while time.monotonic()<deadline and any(r.acked_at is None for r in rows(seeded,PhoneRevocation)):time.sleep(.01)
            assert all(r.acked_at is not None for r in rows(seeded,PhoneRevocation))
    finally:
        if lock is not None:lock.rollback();lock.close()
        engine.dispose()


def test_revoked_passes_do_not_block_eight_pass_limit_after_logout(pc,seeded):
    device=uuid4()
    for _ in range(8):assert issue(pc,seeded,device=device,purpose='view').status_code==200
    assert issue(pc,seeded,device=device,purpose='view').json()['error']['code']=='PASS_ACTIVE_LIMIT'
    assert pc.post('/api/v1/auth/logout',headers=pc.pass_headers).status_code==204
    assert len(rows(seeded,PhoneRevocation))==8
    pc.pass_headers=csrf(pc)
    assert issue(pc,seeded,device=device,purpose='view').status_code==200
    assert all(r.acked_at is None for r in rows(seeded,PhoneRevocation))


def test_retained_budget_bounds_logout_churn_and_leaves_other_user_capacity(pc,seeded):
    from apps.server.fh_server.phone_pass import reserved_usage
    current=[int(time.time())];start=current[0]
    pc.app.state.phone_pass_issuer.clock=lambda:current[0]
    devices=[uuid4() for _ in range(4)]
    accepted=limited=0
    for window in range(10):
        current[0]=start+60*window
        for _ in range(5):
            pc.pass_headers=csrf(pc)
            for i in range(8):
                result=issue(pc,seeded,device=devices[i%4],purpose='view')
                if result.status_code==200:accepted+=1
                else:
                    assert result.status_code==429 and result.json()['error']['code']=='PASS_ACTIVE_LIMIT'
                    assert result.json()['error']['detail']['retry_after']==660-60*window
                    limited+=1
            assert pc.post('/api/v1/auth/logout',headers=pc.pass_headers).status_code==204
    assert (accepted,limited)==(32,368)
    assert len(rows(seeded,PhonePass))==len(rows(seeded,PhoneRevocation))==32
    engine=create_engine(seeded['urls']['app'])
    try:
        with DBSession(engine) as db:
            count,size=reserved_usage(db,seeded['org'],seeded['robots']['mine'],current[0])
            assert count==4 and size<2048
    finally:engine.dispose()
    pc.pass_headers=csrf(pc,'one')
    assert issue(pc,seeded,purpose='view').status_code==200


def test_three_robot_ack_pool_contention_keeps_links_and_eventually_confirms(pc,seeded,monkeypatch):
    import threading
    from contextlib import ExitStack
    from sqlalchemy import text
    from sqlalchemy.exc import TimeoutError as PoolTimeout
    from starlette.websockets import WebSocketDisconnect
    from apps.server.fh_server import phone_pass
    from apps.server.fh_server.security import digest
    from .test_realtime import state
    engine=create_engine(seeded['urls']['app']);factory=sessionmaker(engine)
    with factory.begin() as db:
        third=Robot(org_id=seeded['org'],name='synthetic-third',model='test',owner_user_id=seeded['users']['one'],
                    agent_token_hash=digest('synthetic-pool-third'))
        db.add(third);db.flush();seeded['robots']['third']=third.id
        for name in ('mine','theirs','third'):
            db.get(Robot,seeded['robots'][name]).agent_token_hash=digest('synthetic-pool-'+name)
            issue_metadata(db,seeded,robot=name)
        revoke(db,seeded['org'],user_id=seeded['users']['admin'])
    rt=pc.app.state.realtime;barrier=threading.Barrier(3)
    attempts={};contended=[];original=phone_pass.acknowledge
    timeline={str(seeded['robots'][name]):[] for name in ('mine','theirs','third')}
    diagnostic_lock=threading.Lock()
    def stamp(rid,stage):
        with diagnostic_lock:timeline[str(rid)].append((stage,time.monotonic()))
    def diagnostic():
        with diagnostic_lock:return repr({rid:list(events) for rid,events in timeline.items()})
    queue_ack=rt.queue_phone_ack
    def traced_queue(rid,peer,seq):
        stamp(rid,'ack_received')
        return queue_ack(rid,peer,seq)
    monkeypatch.setattr(rt,'queue_phone_ack',traced_queue)
    def slow(factory,org,rid,seq):
        stamp(rid,'ack_worker_begin')
        attempts[rid]=attempts.get(rid,0)+1
        if attempts[rid]==1:barrier.wait(2)
        try:
            with factory.begin() as db:db.execute(text('SELECT pg_sleep(0.8)'))
        except PoolTimeout:
            stamp(rid,'pool_timeout')
            contended.append(rid)
            raise
        stamp(rid,'store_begin')
        original(factory,org,rid,seq)
        stamp(rid,'stored')
    monkeypatch.setattr(phone_pass,'acknowledge',slow)
    try:
        with ExitStack() as stack:
            sockets={}
            for name in ('mine','theirs','third'):
                ws=stack.enter_context(pc.websocket_connect('/api/v1/agent/ws',headers={
                    'authorization':'Bearer synthetic-pool-'+name}))
                ws.send_json(agent_hello());packet=receive(ws,'phone.revoke')
                rid=str(seeded['robots'][name]);stamp(rid,'revoke_received')
                sockets[rid]=(ws,packet)
            for rid,(ws,packet) in sockets.items():
                stamp(rid,'ack_sent')
                ws.send_json(state());ws.send_json({'t':'phone.revoke.ack','seq':packet['seq']})
            deadline=time.monotonic()+1.5
            while not contended and time.monotonic()<deadline:time.sleep(.01)
            assert contended,'three concurrent 0.8s writes must exercise the 0.5s pool wait: '+diagnostic()
            rid=contended[0];ws,packet=sockets[rid]
            try:replay=receive(ws,'phone.revoke',timeout=1)
            except WebSocketDisconnect as error:pytest.fail(f'pool wait closed live agent: {error.code}; '+diagnostic())
            stamp(rid,'replay_received')
            assert replay==packet,diagnostic()
            stamp(rid,'retry_ack_sent')
            ws.send_json({'t':'phone.revoke.ack','seq':replay['seq']})
            deadline=time.monotonic()+2
            while time.monotonic()<deadline and any(r.acked_at is None for r in rows(seeded,PhoneRevocation)):
                for item,_ in sockets.values():item.send_json(state())
                time.sleep(.05)
            assert all(r.acked_at is not None for r in rows(seeded,PhoneRevocation)),diagnostic()
            assert all(not rt.agents[rid].closing for rid in sockets),diagnostic()
            assert attempts[rid]>=2,diagnostic()
    finally:engine.dispose()


def test_ack_pool_wait_and_driver_tcp_bounds(pc):
    from concurrent.futures import ThreadPoolExecutor,wait
    from sqlalchemy.exc import TimeoutError as PoolTimeout
    engine=pc.app.state.realtime.phone_ack_engine
    first,second=engine.connect(),engine.connect()
    def acquire():
        try:
            with engine.connect():return 'acquired'
        except PoolTimeout:return 'pool_timeout'
    executor=ThreadPoolExecutor(max_workers=1)
    try:
        params=first.connection.driver_connection.info.get_parameters()
        assert params.get('tcp_user_timeout')=='2000'
        started=time.monotonic();future=executor.submit(acquire)
        done,_=wait([future],timeout=1.2)
        assert done and future.result()=='pool_timeout'
        assert .4<=time.monotonic()-started<1.2
    finally:
        first.close();second.close();executor.shutdown(wait=True)


def test_retained_pass_limit_includes_revocations_and_clock_grace(pc,seeded):
    current=[int(time.time())];start=current[0]
    issuer=pc.app.state.phone_pass_issuer;issuer.clock=lambda:current[0]
    engine=create_engine(seeded['urls']['app']);factory=sessionmaker(engine)
    devices=[uuid4() for _ in range(4)]
    try:
        for index in range(32):
            current[0]=start+index
            assert issue(pc,seeded,device=devices[index%4],purpose='view').status_code==200
            with factory.begin() as db:revoke(db,seeded['org'],user_id=seeded['users']['admin'],clock=issuer.clock)
        assert all(r.acked_at is None for r in rows(seeded,PhoneRevocation))
        for elapsed,retry in [(32,628),(600,60),(659,1)]:
            current[0]=start+elapsed
            denied=issue(pc,seeded,device=devices[0],purpose='view')
            assert denied.status_code==429 and denied.json()['error']['code']=='PASS_ACTIVE_LIMIT'
            assert denied.json()['error']['detail']=={'retry_after':retry,'limit':'retained'}
        # Same user/other robot is a separate budget, even before oldest expiry.
        assert issue(pc,seeded,robot='theirs',device=devices[0],purpose='view').status_code==200
        current[0]=start+660
        assert issue(pc,seeded,device=devices[0],purpose='view').status_code==200
        denied=issue(pc,seeded,device=devices[0],purpose='view')
        assert denied.status_code==429 and denied.json()['error']['detail']['retry_after']==1
        current[0]+=1
        assert issue(pc,seeded,device=devices[0],purpose='view').status_code==200
    finally:engine.dispose()


def test_eight_pass_logout_relogin_remains_available_for_three_cycles(pc,seeded):
    devices=[uuid4() for _ in range(4)]
    for _ in range(3):
        for index in range(8):
            assert issue(pc,seeded,device=devices[index%4],purpose='view').status_code==200
        assert pc.post('/api/v1/auth/logout',headers=pc.pass_headers).status_code==204
        pc.pass_headers=csrf(pc)
    assert len(rows(seeded,PhonePass))==24
    assert issue(pc,seeded,device=devices[0],purpose='view').status_code==200


def test_twelve_users_single_pass_revocation_churn_is_bounded(pc,seeded):
    from apps.server.fh_server.api import APIError,lock_organization
    from apps.server.fh_server.phone_pass import reserved_usage
    from apps.contracts.models import PhonePassRequest
    current=[int(time.time())];start=current[0]
    issuer=pc.app.state.phone_pass_issuer;issuer.clock=lambda:current[0]
    engine=create_engine(seeded['urls']['app']);factory=sessionmaker(engine)
    try:
        with factory.begin() as db:
            admin=db.get(User,seeded['users']['admin']);identities=[admin.id]
            for index in range(11):
                user=User(org_id=seeded['org'],username='retained-churn-'+str(index),display_name='synthetic',
                    role='ORG_ADMIN',password_hash=admin.password_hash)
                db.add(user);db.flush();identities.append(user.id)
        devices={user:[uuid4() for _ in range(4)] for user in identities}
        results={user:{200:0,429:0} for user in identities}
        for window in range(2):
            current[0]=start+60*window
            for identity in identities:
                for index in range(40):
                    with factory() as db:
                        lock_organization(db,seeded['org'])
                        try:
                            issuer.issue(db,db.get(User,identity),db.get(Robot,seeded['robots']['mine']),
                                PhonePassRequest(device=devices[identity][index%4],purpose='view'))
                            db.commit();status=200
                        except APIError as error:
                            assert error.status==429 and error.code=='PASS_ACTIVE_LIMIT'
                            assert error.detail['retry_after']==660-60*window
                            db.rollback();status=429
                    results[identity][status]+=1
                    if status==200:
                        with factory.begin() as db:
                            lock_organization(db,seeded['org'])
                            revoke(db,seeded['org'],user_id=identity,clock=issuer.clock)
        assert all(result=={200:32,429:48} for result in results.values())
        with factory() as db:
            count,size=reserved_usage(db,seeded['org'],seeded['robots']['mine'],current[0])
        assert count==384 and size<64*1024
        print('TWELVE_USER_CHURN',count,'rows',size,'wire bytes')
        pc.pass_headers=csrf(pc,'one')
        assert issue(pc,seeded,purpose='view').status_code==200
    finally:engine.dispose()


def test_ack_pool_warning_counts_throttles_and_resets_without_secrets(monkeypatch,caplog):
    from apps.server.fh_server import phone_pass
    from sqlalchemy.exc import TimeoutError as PoolTimeout
    mode={'fail':True}
    def store(*args):
        if mode['fail']:raise PoolTimeout('MUST_NOT_LOG_TOKEN_OR_JTI')
    monkeypatch.setattr(phone_pass,'acknowledge',store)
    async def run():
        rt,new_peer=ack_harness();now=[0.];rt.clock=lambda:now[0]
        peer=rt.agents['r'];other=new_peer();rt.agents['other']=other
        writers=[asyncio.create_task(rt.phone_ack_writer(rid,p)) for rid,p in rt.agents.items()]
        async def attempt(rid,seq,at):
            now[0]=at;p=rt.agents[rid];p.phone_revoke_sent=1000
            rt.queue_phone_ack(rid,p,seq);await asyncio.wait_for(p.phone_ack_queue.join(),1)
        def warnings():return [r.getMessage() for r in caplog.records if 'ACK pool contention' in r.getMessage()]
        try:
            rt.queue_phone_ack('r',peer,10);rt.queue_phone_ack('r',peer,11)
            await asyncio.wait_for(peer.phone_ack_queue.join(),1)
            assert rt.phone_ack_contention['r']['failures']==2
            assert len(warnings())==1 and 'consecutive=1 pending_seq=10..11' in warnings()[0]
            await attempt('r',12,29.999);assert len(warnings())==1
            await attempt('r',13,30);assert len(warnings())==2 and 'consecutive=4' in warnings()[1]
            mode['fail']=False;await attempt('r',14,31)
            assert rt.phone_ack_contention['r']['failures']==0
            mode['fail']=True;await attempt('r',15,32)
            assert len(warnings())==2 and rt.phone_ack_contention['r']['failures']==1
            await attempt('r',16,60)
            assert len(warnings())==3 and 'consecutive=2 pending_seq=16..16' in warnings()[2]
            await attempt('other',20,60)
            assert len(warnings())==4 and 'robot=other' in warnings()[3]
            assert all('cause=POOL_TIMEOUT' in message for message in warnings())
            assert 'MUST_NOT_LOG_TOKEN_OR_JTI' not in caplog.text
            assert not peer.closing and not other.closing
        finally:
            for writer in writers:writer.cancel()
            await asyncio.gather(*writers,return_exceptions=True)
    asyncio.run(run())


def test_expired_unrevoked_passes_keep_active_slots_through_robot_grace(pc,seeded):
    from apps.server.fh_server.api import APIError,lock_organization
    from apps.server.fh_server.phone_pass import reserved_usage
    from apps.contracts.models import PhonePassRequest
    current=[int(time.time())];start=current[0]
    issuer=pc.app.state.phone_pass_issuer;issuer.clock=lambda:current[0]
    engine=create_engine(seeded['urls']['app']);factory=sessionmaker(engine)
    try:
        with factory.begin() as db:
            admin=db.get(User,seeded['users']['admin']);identities=[admin.id]
            for index in range(15):
                user=User(org_id=seeded['org'],username='grace-budget-'+str(index),display_name='synthetic',
                    role='ORG_ADMIN',password_hash=admin.password_hash)
                db.add(user);db.flush();identities.append(user.id)
        devices={user:[uuid4() for _ in range(4)] for user in identities}
        def attempt(identity,index):
            with factory() as db:
                lock_organization(db,seeded['org'])
                try:
                    issuer.issue(db,db.get(User,identity),db.get(Robot,seeded['robots']['mine']),
                        PhonePassRequest(device=devices[identity][index%4],purpose='view'))
                    db.commit();return 200,None
                except APIError as error:
                    db.rollback();return error.status,(error.code,error.detail)
        for identity in identities:
            assert [attempt(identity,i)[0] for i in range(8)]==[200]*8
        current[0]=start+600
        for identity in identities:
            for i in range(8):
                assert attempt(identity,i)==(429,('PASS_ACTIVE_LIMIT',{'retry_after':60,'limit':'active'}))
        with factory() as db:
            assert reserved_usage(db,seeded['org'],seeded['robots']['mine'],current[0])==(128,128*4096)
        pc.pass_headers=csrf(pc,'one')
        assert issue(pc,seeded,purpose='view').status_code==200
        current[0]=start+659
        assert attempt(identities[0],0)==(429,('PASS_ACTIVE_LIMIT',{'retry_after':1,'limit':'active'}))
        current[0]=start+660
        assert attempt(identities[0],0)[0]==200
    finally:engine.dispose()


def test_one_pass_per_device_renewal_at_expiry_stays_available(pc,seeded):
    current=[int(time.time())];start=current[0]
    pc.app.state.phone_pass_issuer.clock=lambda:current[0]
    devices=[uuid4() for _ in range(4)]
    for elapsed in [0,600,1200]:
        current[0]=start+elapsed
        for device in devices:
            assert issue(pc,seeded,device=device,purpose='view').status_code==200


@pytest.mark.parametrize('state',['closing','replaced'])
def test_ack_pool_failure_from_retired_peer_does_not_warn_or_count(monkeypatch,caplog,state):
    from apps.server.fh_server import phone_pass
    from sqlalchemy.exc import TimeoutError as PoolTimeout
    import threading
    entered=threading.Event();release=threading.Event()
    def store(*args):
        entered.set();assert release.wait(2)
        raise PoolTimeout('MUST_NOT_LOG_RETIRED_PEER')
    monkeypatch.setattr(phone_pass,'acknowledge',store)
    async def run():
        rt,new_peer=ack_harness();rt.clock=lambda:0.
        peer=rt.agents['r'];writer=asyncio.create_task(rt.phone_ack_writer('r',peer))
        try:
            rt.queue_phone_ack('r',peer,10)
            assert await asyncio.to_thread(entered.wait,1)
            if state=='closing':peer.closing=True
            else:rt.agents['r']=new_peer()
            release.set();await asyncio.wait_for(peer.phone_ack_queue.join(),1)
            assert not rt.__dict__.get('phone_ack_contention')
            assert peer.phone_revoke_retry is None
            assert 'ACK pool contention' not in caplog.text
            assert 'MUST_NOT_LOG_RETIRED_PEER' not in caplog.text
        finally:
            release.set();writer.cancel();await asyncio.gather(writer,return_exceptions=True)
    asyncio.run(run())


def test_robot_deletion_discards_ack_contention_and_cannot_recreate_it(pc,seeded):
    from types import SimpleNamespace
    rt=pc.app.state.realtime;rid=str(seeded['robots']['mine'])
    def run():
        peer=SimpleNamespace(phone_ack_pending={1})
        rt.note_phone_ack_contention(rid,peer,1)
        assert rid in rt.phone_ack_contention
        rt.robot_changed(rid,deleted=True)
        assert rid not in rt.phone_ack_contention
        rt.note_phone_ack_contention(rid,peer,1)  # late failure must not recreate deleted state
        assert rid not in rt.phone_ack_contention
    pc.portal.call(run)
