"""Posture uses the existing owner/connection lease and field approval gates."""
from dataclasses import replace
from uuid import uuid4

import pytest

from apps.contracts import models as C
from apps.server.fh_server.leases import LeaseError
from .test_server_drive import trial
from .test_server_drive_flag_stop import relay
from .test_realtime import app_token, hello, receive, reply, screen, send, state, take


def test_authenticated_owner_posture_relay_and_measured_result(trial, seeded):
    rid = seeded['robots']['mine']
    owner = app_token(trial)
    with trial.websocket_connect('/api/v1/agent/ws', headers={
            'authorization': 'Bearer fake-test-' + str(rid)}) as ag:
        ag.send_json(hello())
        receive(ag, 'lease'); receive(ag, 'stop'); receive(ag, 'field_approval')
        with screen(trial, owner) as ws, screen(trial, owner) as second:
            lease = take(ws, ag, rid)
            ident = send(ws, 'posture', rid, lease_id=lease, action='stand_up')
            assert reply(ws, ident)['ok']
            assert receive(ag, 'posture') == dict(t='posture', request_id=ident,
                lease_id=lease, action='stand_up')
            denied = reply(second, send(second, 'posture', rid, lease_id=lease, action='stand_down'))
            assert denied['error']['code'] == 'LEASE_MISMATCH'
            request = send(ws, 'sub', robots=[str(rid)], streams=['state'])
            assert reply(ws, request)['ok']
            ag.send_json(state(3, posture=dict(state='LYING', mode=5), posture_result=dict(
                request_id=ident, action='stand_down', status='SUCCEEDED', code='CONFIRMED', sdk_code=0)))
            result = receive(ws, 'state', predicate=lambda m: m.get('posture_result') is not None)
            assert result['posture'] == dict(state='LYING', mode=5)
            assert result['posture_result']['sdk_code'] == 0


@pytest.mark.parametrize('username', ['admin', 'two'])
def test_non_owner_denied_and_admin_passes_owner_gate_for_posture(trial, seeded, username):
    # 팀장 11/28: 총괄은 소유 관문을 지나고 다음 관문(연결 없음)에 걸린다.
    rid = seeded['robots']['mine']
    headers = app_token(trial, username)
    with screen(trial, headers) as ws:
        result = reply(ws, send(ws, 'posture', rid, lease_id=str(uuid4()), action='stand_up'))
        assert result['ok'] is False
        assert result['error']['code'] == ('NOT_ROBOT_OWNER' if username == 'two' else 'ROBOT_OFFLINE'), result


def prepare(relay):
    realtime, rid, peer, actor, _ = relay
    lease = str(uuid4())
    realtime.arbiter.robot(rid).holder.lease_id = lease
    peer.state_received_at = 0
    peer.state = {'applied': [0, 0, 0]}
    peer.server_drive_axes = (0, 0, 0)
    while not peer.queue.empty(): peer.queue.get_nowait()
    msg = C.ScreenPosture(t='posture', id='request', robot=rid, lease_id=lease, action='stand_up')
    return realtime, rid, peer, actor, msg


@pytest.mark.parametrize('gate', ['other_connection', 'wrong_lease', 'approval', 'changed',
    'simulation', 'switch', 'auth', 'owner', 'stale', 'applied', 'input'])
def test_posture_rechecks_all_server_gates(relay, gate):
    realtime, rid, peer, actor, msg = prepare(relay)
    if gate == 'other_connection': actor = replace(actor, connection='other')
    if gate == 'wrong_lease': msg = msg.model_copy(update={'lease_id': uuid4()})
    if gate == 'approval': realtime.field_approved = lambda rid: False
    if gate == 'changed': realtime.robot_changes.add(rid)
    if gate == 'simulation': peer.simulation = True
    if gate == 'switch': peer.server_drive = False
    if gate == 'auth': peer.auth_checked = -1
    if gate == 'owner': realtime.owner_uncertain = True
    if gate == 'stale': peer.state_received_at = -1
    if gate == 'applied': peer.state['applied'] = [.1, 0, 0]
    if gate == 'input': peer.server_drive_axes = (1.5, 0, 0)
    with pytest.raises(LeaseError): realtime.send_posture(rid, actor, msg)
    assert peer.queue.empty()


@pytest.mark.parametrize('transition', ['stop', 'release', 'approval', 'lease'])
def test_queued_posture_cannot_survive_stop_or_authority_change(relay, transition):
    realtime, rid, peer, actor, msg = prepare(relay)
    realtime.send_posture(rid, actor, msg)
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
        assert not any(m.get('t') == 'posture' for m in peer.queue._queue)
    else:
        assert realtime.blocked_agent_control(peer, body)
