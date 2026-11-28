"""걷기 모드 전달 (11/28): 자세 요청과 같은 관문 · 멈춰 있을 때만 · 시뮬은 받아 에이전트가 정직하게 답한다."""
from dataclasses import replace
from uuid import uuid4

import pytest

from apps.contracts import models as C
from apps.server.fh_server.leases import LeaseError
from apps.server.fh_server import event_messages
from .test_server_drive import trial  # noqa: F401
from .test_server_drive_flag_stop import relay  # noqa: F401
from .test_realtime import app_token, hello, receive, reply, screen, send, state, take


def unlatched(gen, **kw):
    return dict(state(gen, **kw), latched=False)


def test_owner_gait_relays_to_agent_and_state_carries_mode(trial, seeded):
    rid = seeded['robots']['mine']
    owner = app_token(trial)
    with trial.websocket_connect('/api/v1/agent/ws', headers={
            'authorization': 'Bearer fake-test-' + str(rid)}) as ag:
        ag.send_json(hello())
        receive(ag, 'lease'); receive(ag, 'stop'); receive(ag, 'field_approval')
        with screen(trial, owner) as ws, screen(trial, owner) as second:
            lease = take(ws, ag, rid)
            ag.send_json(unlatched(3))
            ident = send(ws, 'gait', rid, lease_id=lease, gait='classic')
            assert reply(ws, ident)['ok']
            assert receive(ag, 'gait') == dict(t='gait', request_id=ident, lease_id=lease, gait='classic')
            denied = reply(second, send(second, 'gait', rid, lease_id=lease, gait='sport'))
            assert denied['error']['code'] == 'LEASE_MISMATCH'
            assert reply(ws, send(ws, 'sub', robots=[str(rid)], streams=['state']))['ok']
            ag.send_json(unlatched(3, gait=dict(gait='start', available=['classic']),
                gait_result=dict(request_id=ident, gait='classic', status='RUNNING', code='RUNNER_SENT', sdk_code=None)))
            result = receive(ws, 'state', predicate=lambda m: m.get('gait_result') is not None)
            assert result['gait'] == dict(gait='start', available=['classic'])
            assert result['gait_result']['request_id'] == ident


def test_latched_robot_refuses_gait_with_latched_code(trial, seeded):
    rid = seeded['robots']['mine']
    owner = app_token(trial)
    with trial.websocket_connect('/api/v1/agent/ws', headers={
            'authorization': 'Bearer fake-test-' + str(rid)}) as ag:
        ag.send_json(hello())
        receive(ag, 'lease'); receive(ag, 'stop'); receive(ag, 'field_approval')
        with screen(trial, owner) as ws:
            lease = take(ws, ag, rid)   # take() 의 상태는 latched=True
            answer = reply(ws, send(ws, 'gait', rid, lease_id=lease, gait='sport'))
            assert not answer['ok'] and answer['error']['code'] == 'GAIT_LATCHED'
            with pytest.raises(pytest.fail.Exception, match='Expected gait'):
                receive(ag, 'gait', timeout=0.5)


@pytest.mark.parametrize('username', ['admin', 'two'])
def test_non_owner_and_admin_cannot_send_gait(trial, seeded, username):
    rid = seeded['robots']['mine']
    with screen(trial, app_token(trial, username)) as ws:
        result = reply(ws, send(ws, 'gait', rid, lease_id=str(uuid4()), gait='classic'))
        assert result['ok'] is False
        assert result['error']['code'] in ('ADMIN_NO_REAL_CONTROL', 'NOT_ROBOT_OWNER')


def prepare(relay, gait='sport'):
    realtime, rid, peer, actor, records = relay
    lease = str(uuid4())
    realtime.arbiter.robot(rid).holder.lease_id = lease
    peer.state_received_at = 0
    peer.state = {'applied': [0, 0, 0], 'latched': False}
    peer.server_drive_axes = (0, 0, 0)
    realtime.queue_audit = lambda effect: records.append(effect) or True
    while not peer.queue.empty(): peer.queue.get_nowait()
    msg = C.ScreenGait(t='gait', id='request', robot=rid, lease_id=lease, gait=gait)
    return realtime, rid, peer, actor, msg


@pytest.mark.parametrize('gate, code', [
    ('other_connection', 'LEASE_MISMATCH'), ('wrong_lease', 'LEASE_MISMATCH'),
    ('approval', 'GAIT_NOT_ALLOWED'), ('changed', 'GAIT_NOT_ALLOWED'), ('switch', 'GAIT_NOT_ALLOWED'),
    ('auth', 'GAIT_NOT_ALLOWED'), ('owner', 'GAIT_NOT_ALLOWED'),
    ('latched', 'GAIT_LATCHED'), ('stale', 'GAIT_MOVING'), ('applied', 'GAIT_MOVING'), ('input', 'GAIT_MOVING')])
def test_gait_rechecks_all_server_gates(relay, gate, code):
    realtime, rid, peer, actor, msg = prepare(relay)
    if gate == 'other_connection': actor = replace(actor, connection='other')
    if gate == 'wrong_lease': msg = msg.model_copy(update={'lease_id': uuid4()})
    if gate == 'approval': realtime.field_approved = lambda rid: False
    if gate == 'changed': realtime.robot_changes.add(rid)
    if gate == 'switch': peer.server_drive = False
    if gate == 'auth': peer.auth_checked = -1
    if gate == 'owner': realtime.owner_uncertain = True
    if gate == 'latched': peer.state['latched'] = True
    if gate == 'stale': peer.state_received_at = -1
    if gate == 'applied': peer.state['applied'] = [.1, 0, 0]
    if gate == 'input': peer.server_drive_axes = (1.5, 0, 0)
    with pytest.raises(LeaseError) as exc:
        realtime.send_gait(rid, actor, msg)
    assert exc.value.code == code
    assert peer.queue.empty()
    assert event_messages.TEMPLATES[code]


def test_admitted_gait_is_audited_and_queued(relay):
    realtime, rid, peer, actor, msg = prepare(relay, 'classic')
    realtime.send_gait(rid, actor, msg)
    body = peer.queue._queue[0]
    assert body == dict(t='gait', request_id='request', lease_id=str(msg.lease_id), gait='classic')
    audit = [e for e in relay[4] if getattr(e, 'body', {}).get('op') == 'GO2_GAIT']
    assert audit and audit[0].body['data'] == dict(request_id='request', action='classic')
    assert 'GO2_GAIT' in event_messages.TEMPLATES


def test_simulation_gait_is_delivered_without_field_approval_or_switch(relay):
    # 시뮬은 실기 시험 스위치 · 현장 승인 없이 받는다. 바꿀 수 없으면 에이전트가 GAIT_UNSUPPORTED 로 답한다.
    realtime, rid, peer, actor, msg = prepare(relay)
    peer.simulation, peer.server_drive = True, False
    realtime.field_approved = lambda rid: False
    realtime.send_gait(rid, actor, msg)
    assert peer.queue._queue[0]['t'] == 'gait'
    # 시뮬이라도 lease · 인증 · 주인 확인은 그대로 막는다
    realtime.owner_uncertain = True
    assert realtime.blocked_agent_control(peer, peer.queue._queue[0])


@pytest.mark.parametrize('transition', ['stop', 'release', 'approval', 'lease'])
def test_queued_gait_cannot_survive_stop_or_authority_change(relay, transition):
    realtime, rid, peer, actor, msg = prepare(relay)
    realtime.send_gait(rid, actor, msg)
    body = peer.queue._queue[0]
    assert not realtime.blocked_agent_control(peer, body)
    if transition == 'stop':
        realtime.apply(realtime.arbiter.stop(rid, actor))
    elif transition == 'release':
        realtime.apply(realtime.arbiter.release(rid, actor))
    elif transition == 'approval':
        realtime.field_approved = lambda rid: False
    else:
        realtime.arbiter.robot(rid).holder.lease_id = 'changed'
    if transition in ('stop', 'release'):
        assert not any(m.get('t') == 'gait' for m in peer.queue._queue)
    else:
        assert realtime.blocked_agent_control(peer, body)


def test_audit_refusal_rejects_and_sends_nothing(relay):
    # 검수 #550 R2 G5: 기록을 못 남기면 보내지 않는다.
    realtime, rid, peer, actor, msg = prepare(relay)
    realtime.queue_audit = lambda effect: False
    with pytest.raises(LeaseError) as exc:
        realtime.send_gait(rid, actor, msg)
    assert exc.value.code == 'SERVER_BUSY'
    assert peer.queue.empty()


def test_authority_lost_during_audit_rejects_and_sends_nothing(relay):
    # 검수 #550 R2 G10: 기록 용량 변화가 lease 를 거둘 수 있어 넣기 직전에 다시 본다.
    realtime, rid, peer, actor, msg = prepare(relay)
    def revoke(effect):
        realtime.arbiter.robot(rid).holder.lease_id = 'revoked'
        return True
    realtime.queue_audit = revoke
    with pytest.raises(LeaseError) as exc:
        realtime.send_gait(rid, actor, msg)
    assert exc.value.code == 'GAIT_NOT_ALLOWED'
    assert peer.queue.empty()
