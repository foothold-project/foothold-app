from dataclasses import replace
from uuid import uuid4
import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from apps.contracts import models as C
from apps.server.fh_server.models import Event
from apps.server.fh_server.leases import LeaseError
from .test_server_drive import trial
from .test_server_drive_flag_stop import relay
from .test_posture import prepare
from .test_realtime import app_token, hello, receive, reply, screen, send, state, take, drain_audit


def test_action_owner_relay_result_and_individual_audit(trial, seeded):
    rid = seeded['robots']['mine']
    with trial.websocket_connect('/api/v1/agent/ws', headers={'authorization': 'Bearer fake-test-' + str(rid)}) as ag:
        ag.send_json(hello())
        receive(ag, 'lease'); receive(ag, 'stop'); receive(ag, 'field_approval')
        with screen(trial, app_token(trial)) as ws, screen(trial, app_token(trial)) as other:
            lease = take(ws, ag, rid)
            ids = []
            for action in ('Hello', 'Sit'):
                ident = send(ws, 'action', rid, lease_id=lease, action=action)
                ids.append(ident)
                assert reply(ws, ident)['ok']
                frame = receive(ag, 'action')
                assert frame['request_id'] == ident and frame['action'] == action
            ident = send(other, 'action', rid, lease_id=lease, action='Hello')
            assert reply(other, ident)['error']['code'] == 'LEASE_MISMATCH'
            assert reply(ws, send(ws, 'sub', robots=[str(rid)], streams=['state']))['ok']
            result = dict(request_id=ids[-1], action='Sit', status='FAILED', code='SDK_REJECTED', sdk_code=73, mode=None, enabled=None)
            ag.send_json(state(3, action_result=result, control='LOWLEVEL'))
            shown = receive(ws, 'state', predicate=lambda m: m.get('action_result') is not None)
            assert shown['action_result'] == result and shown['control'] == 'LOWLEVEL'
            realtime = trial.app.state.realtime
            drain_audit(trial, realtime)
    engine = create_engine(seeded['urls']['migrate'])
    with Session(engine) as db:
        events = db.scalars(select(Event).where(Event.robot_id == rid, Event.code == 'GO2_ACTION')).all()
        assert len(events) == 2
        assert {e.data['action'] for e in events} == {'Hello', 'Sit'}
        assert all(e.user_id is not None for e in events)
        assert all(e.data['action'] in e.message and '실제 동작 완료 확인 아님' in e.message for e in events)
    engine.dispose()


@pytest.mark.parametrize('user', ['admin', 'two'])
def test_nonowner_action_rejected(trial, seeded, user):
    # 운영 결정 2026-11-28: 총괄은 소유 관문을 지나고 다음 관문(연결 없음)에 걸린다.
    with screen(trial, app_token(trial, user)) as ws:
        ident = send(ws, 'action', seeded['robots']['mine'], lease_id=str(uuid4()), action='Hello')
        code = reply(ws, ident)['error']['code']
        assert code == ('NOT_ROBOT_OWNER' if user == 'two' else 'ROBOT_OFFLINE'), code


def prepared(relay):
    realtime, rid, peer, actor, posture = prepare(relay)
    records = []
    realtime.queue_audit = lambda effect: records.append(effect) or True
    msg = C.ScreenAction(t='action', id='request', robot=rid, lease_id=posture.lease_id, action='Hello')
    return realtime, rid, peer, actor, msg, records


@pytest.mark.parametrize('gate', ['connection','lease','approval','changed','simulation','switch','auth','owner','stale','applied','input','audit'])
def test_action_server_gates(relay, gate):
    realtime, rid, peer, actor, msg, _ = prepared(relay)
    if gate == 'connection': actor = replace(actor, connection='different')
    if gate == 'lease': msg = msg.model_copy(update={'lease_id': uuid4()})
    if gate == 'approval': realtime.field_approved = lambda rid: False
    if gate == 'changed': realtime.robot_changes.add(rid)
    if gate == 'simulation': peer.simulation = True
    if gate == 'switch': peer.server_drive = False
    if gate == 'auth': peer.auth_checked = -1
    if gate == 'owner': realtime.owner_uncertain = True
    if gate == 'stale': peer.state_received_at = -1
    if gate == 'applied': peer.state['applied'] = [.1,0,0]
    if gate == 'input': peer.server_drive_axes = (1.5,0,0)
    if gate == 'audit': realtime.queue_audit = lambda effect: False
    with pytest.raises(LeaseError): realtime.send_action(rid, actor, msg)
    assert peer.queue.empty()


@pytest.mark.parametrize('transition', ['stop','release','approval','lease'])
def test_queued_action_cannot_survive_stop_or_authority_change(relay, transition):
    realtime, rid, peer, actor, msg, records = prepared(relay)
    realtime.send_action(rid, actor, msg)
    assert records[0].body['data']['action'] == 'Hello'
    body = peer.queue._queue[0]
    assert not realtime.blocked_agent_control(peer, body)
    if transition == 'stop': realtime.apply(realtime.arbiter.stop(rid, actor))
    elif transition == 'release': realtime.apply(realtime.arbiter.release(rid, actor))
    elif transition == 'approval': realtime.field_approved = lambda rid: False
    else: realtime.arbiter.robot(rid).holder.lease_id = 'changed'
    if transition in ('stop','release'):
        assert not any(m.get('t') == 'action' for m in peer.queue._queue)
    else:
        assert realtime.blocked_agent_control(peer, body)


@pytest.mark.parametrize('control', ['LOWLEVEL', 'FACTORY', None])
def test_lowlevel_control_allows_only_contract_list(relay, control):
    # 팀장 11/26 08:01: 저수준 중에는 LowlevelAction 만, 순정 (또는 옛 에이전트 · 칸 없음) 은 전부.
    from typing import get_args
    realtime, rid, peer, actor, msg, records = prepared(relay)
    peer.state['control'] = control
    allowed = set(get_args(C.LowlevelAction)) | set(get_args(C.LowlevelQuery))
    for name in ('Hello', 'Sit', 'Greet', 'Scrape', 'FrontFlip', 'CheckMode', 'AutoRecoveryGet', 'RecoveryStand'):
        while not peer.queue.empty(): peer.queue.get_nowait()
        req = C.ScreenAction(t='action', id='r-' + name, robot=rid, lease_id=msg.lease_id, action=name,
                             confirmed=name == 'FrontFlip')
        if control == 'LOWLEVEL' and name not in allowed:
            with pytest.raises(LeaseError) as e: realtime.send_action(rid, actor, req)
            assert e.value.code == 'LOWLEVEL_UNSUPPORTED' and peer.queue.empty()
        elif control != 'LOWLEVEL' and name == 'Greet':
            with pytest.raises(LeaseError) as e: realtime.send_action(rid, actor, req)
            assert e.value.code == 'FACTORY_UNSUPPORTED' and peer.queue.empty()
        else:
            realtime.send_action(rid, actor, req)
            assert peer.queue._queue[-1]['action'] == name
    for action in ('stand_up', 'stand_down'):
        while not peer.queue.empty(): peer.queue.get_nowait()
        req = C.ScreenPosture(t='posture', id='p-' + action, robot=rid, lease_id=msg.lease_id, action=action)
        if control == 'LOWLEVEL' and action == 'stand_up':
            with pytest.raises(LeaseError) as e: realtime.send_posture(rid, actor, req)
            assert e.value.code == 'LOWLEVEL_UNSUPPORTED' and peer.queue.empty()
        else:
            realtime.send_posture(rid, actor, req)
            assert peer.queue._queue[-1]['action'] == action
