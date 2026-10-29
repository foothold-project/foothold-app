"""Validated agent reasons reach only the corresponding fresh screen state."""
from types import SimpleNamespace
from uuid import UUID

import pytest
from pydantic import ValidationError

from apps.contracts import models as C
from apps.server.fh_server.realtime import AGENT, Peer, Realtime
from .test_leases import Clock
from .test_realtime import agent, app_token, receive, reply, rt, screen, send, state


@pytest.mark.parametrize('value', ['OUTPUT_STALLED', None])
def test_agent_and_screen_contracts_accept_same_safety_reason(value):
    report = AGENT.validate_python(state(safety_reason=value))
    payload = dict(robot=UUID(int=1), connection='ONLINE', status='STOP_LATCHED',
        battery=None, location=None, devices=[], speed=None, latency_ms=None,
        latched=True, stop_gen=2, applied=[0, 0, 0])
    assert report.safety_reason == value
    assert C.ScreenState(**payload, safety_reason=value).model_dump(mode='json')['safety_reason'] == value
    assert C.ScreenState(**payload).safety_reason is None
    assert AGENT.validate_python(state()).safety_reason is None


@pytest.mark.parametrize('value', ['UNKNOWN_REASON', '', 1, True, [], {}])
def test_invalid_agent_safety_reason_rejected_by_wire_contract(value):
    with pytest.raises(ValidationError):
        AGENT.validate_python(state(safety_reason=value))


@pytest.fixture
def runtime():
    clock = Clock()
    rid, other_rid = str(UUID(int=1)), str(UUID(int=2))
    peers = {key: Peer(None, auth_checked=clock(), simulation=True) for key in (rid, other_rid)}
    arbiter = SimpleNamespace(robot=lambda _: SimpleNamespace(transfer=None), state=lambda *args: [])
    return SimpleNamespace(agents=peers, clock=clock, arbiter=arbiter, owner_uncertain=False,
        runs={}, last_state_received={}, apply=lambda _: None), rid, other_rid


def test_reason_is_robot_local_and_expires_with_telemetry(runtime):
    realtime, rid, other_rid = runtime
    peer = realtime.agents[rid]
    assert Realtime.screen_state(realtime, rid)['safety_reason'] is None
    assert Realtime.accept_state(realtime, rid, peer,
        C.AgentState.model_validate(state(safety_reason='OUTPUT_STALLED')))
    assert Realtime.screen_state(realtime, rid)['safety_reason'] == 'OUTPUT_STALLED'
    assert Realtime.screen_state(realtime, other_rid)['safety_reason'] is None
    realtime.clock.step(3.001)
    assert Realtime.screen_state(realtime, rid)['safety_reason'] is None
    realtime.clock.at = 0
    peer.closing = True
    frame = Realtime.screen_state(realtime, rid)
    assert frame['connection'] == 'OFFLINE' and frame['safety_reason'] is None
    realtime.agents[rid] = Peer(None, auth_checked=0, simulation=True)
    assert Realtime.screen_state(realtime, rid)['safety_reason'] is None


@pytest.mark.parametrize('blocked', ['replaced', 'other_robot', 'closing', 'owner_uncertain', 'stale_auth'])
def test_rejected_state_cannot_overwrite_safety_reason(runtime, blocked):
    realtime, rid, other_rid = runtime
    current = realtime.agents[rid]
    current.state['safety_reason'] = 'OUTPUT_STALLED'
    peer = current
    if blocked == 'replaced':
        peer = Peer(None, auth_checked=0, simulation=True)
    elif blocked == 'other_robot':
        peer = realtime.agents[other_rid]
    elif blocked == 'closing':
        peer.closing = True
    elif blocked == 'owner_uncertain':
        realtime.owner_uncertain = True
    else:
        realtime.clock.step(.501)
    assert Realtime.accept_state(realtime, rid, peer, C.AgentState.model_validate(state())) is False
    assert current.state['safety_reason'] == 'OUTPUT_STALLED'
    assert realtime.agents[other_rid].state == {}


def test_screen_websocket_reason_legacy_clear_and_invalid_input(client, seeded, rt, monkeypatch):
    rid = str(seeded['robots']['mine'])
    accepted = []
    original = rt.accept_state

    def observe(robot, peer, msg):
        result = original(robot, peer, msg)
        if result:
            accepted.append((msg.stop_gen, msg.safety_reason))
        return result

    monkeypatch.setattr(rt, 'accept_state', observe)
    with agent(client, seeded) as ag, screen(client, app_token(client)) as ws:
        assert reply(ws, send(ws, 'sub', robots=[rid], streams=['state']))['ok']
        assert receive(ws, 'state')['safety_reason'] is None
        reports = [dict(safety_reason='OUTPUT_STALLED'), dict(safety_reason=None),
                   dict(safety_reason='OUTPUT_STALLED'), {}]
        for gen, fields in enumerate(reports, 2):
            ag.send_json(state(gen, **fields))
            frame = receive(ws, 'state', predicate=lambda body: body['stop_gen'] == gen)
            assert frame['robot'] == rid
            assert frame['safety_reason'] == fields.get('safety_reason')
            assert C.ScreenState.model_validate(frame).safety_reason == fields.get('safety_reason')
        ag.send_json(state(99, safety_reason='UNKNOWN_REASON'))
        ag.send_json(state(6, safety_reason='OUTPUT_STALLED'))
        frame = receive(ws, 'state', predicate=lambda body: body['stop_gen'] == 6)
        assert frame['safety_reason'] == 'OUTPUT_STALLED'
        assert accepted == [(2, 'OUTPUT_STALLED'), (3, None), (4, 'OUTPUT_STALLED'),
                            (5, None), (6, 'OUTPUT_STALLED')]
