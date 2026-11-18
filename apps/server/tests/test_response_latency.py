"""Display-only RTT and slow-response relay; fake clock/peers, no robot or DB."""
from types import SimpleNamespace as NS
from uuid import UUID

from apps.contracts import models as C
from apps.server.fh_server.realtime import Peer, Realtime
from .test_leases import Clock
from .test_realtime import agent, app_token, receive, reply, rt, screen, send, state


def rig():
    clock = Clock()
    rid = str(UUID(int=1))
    peer = Peer(None, auth_checked=clock(), simulation=True)
    runtime = NS(agents={rid: peer}, clock=clock, owner_uncertain=False, runs={},
                 last_state_received={}, apply=lambda _: None,
                 arbiter=NS(robot=lambda _: NS(transfer=None), state=lambda *args: []))
    return runtime, peer, rid


def health(**kw):
    return dict(slow=True, timeout_count=3, last_timeout_at='2026-11-18T09:45:03Z',
        last_ms=101., last_timed_out=True, median_ms=100., median_timed_out=True,
        sample_count=5, **kw)


def test_echo_round_trip_uses_one_local_clock_and_expires():
    runtime, peer, rid = rig()
    challenge = Realtime.agent_ping(runtime, peer)
    assert C.AgentServerPing.model_validate(challenge).ping_id
    runtime.clock.step(.027)
    Realtime.accept_ping(runtime, peer, challenge['ping_id'])
    frame = Realtime.screen_state(runtime, rid)
    assert frame['latency_ms'] == 27
    assert peer.state == {}  # no safety state or motion evidence invented
    runtime.clock.step(1)
    Realtime.accept_ping(runtime, peer, challenge['ping_id'])  # replay cannot refresh
    assert peer.link_rtt_at == .027
    runtime.clock.step(2)
    assert Realtime.screen_state(runtime, rid)['latency_ms'] is None
    assert Realtime.screen_state(runtime, str(UUID(int=2)))['latency_ms'] is None


def test_unmatched_old_or_reconnected_echo_does_not_set_latency():
    runtime, peer, rid = rig()
    for token in (None, 'unknown'):
        Realtime.accept_ping(runtime, peer, token)
    challenge = Realtime.agent_ping(runtime, peer)
    runtime.clock.step(3)
    Realtime.accept_ping(runtime, peer, challenge['ping_id'])
    assert peer.link_rtt_ms is None
    replacement = Peer(None)
    Realtime.accept_ping(runtime, replacement, challenge['ping_id'])
    assert replacement.link_rtt_ms is None
    for _ in range(100):
        Realtime.agent_ping(runtime, peer)
        runtime.clock.step(1)
    assert len(peer.ping_challenges) <= 3


def test_validated_health_reaches_only_fresh_robot_and_legacy_state_clears_it():
    runtime, peer, rid = rig()
    action = dict(request_id='latency-with-action', action='Hello', status='FAILED',
                  code='SDK_REJECTED', sdk_code=73, mode=None, enabled=None)
    report = C.AgentState.model_validate(state(response_health=health(), action_result=action))
    assert Realtime.accept_state(runtime, rid, peer, report)
    frame = Realtime.screen_state(runtime, rid)
    assert frame['response_health'] == report.response_health.model_dump(mode='json')
    assert frame['action_result'] == action
    assert C.ScreenState.model_validate(frame).response_health.timeout_count == 3
    assert Realtime.screen_state(runtime, str(UUID(int=2)))['response_health'] is None
    assert Realtime.accept_state(runtime, rid, peer, C.AgentState.model_validate(state()))
    assert Realtime.screen_state(runtime, rid)['response_health'] is None
    assert Realtime.accept_state(runtime, rid, peer, report)
    runtime.clock.step(3.001)
    assert Realtime.screen_state(runtime, rid)['response_health'] is None
    peer.closing = True
    assert Realtime.screen_state(runtime, rid)['response_health'] is None


def test_existing_agent_socket_echo_and_health_reach_screen(client, seeded, rt):
    rid = str(seeded['robots']['mine'])
    with agent(client, seeded) as ag, screen(client, app_token(client)) as ws:
        assert reply(ws, send(ws, 'sub', robots=[rid], streams=['state']))['ok']
        challenge = receive(ag, 'ping', predicate=lambda m: bool(m.get('ping_id')))
        ag.send_json({'t': 'ping', 'ping_id': challenge['ping_id']})
        ag.send_json(state(7, response_health=health()))
        frame = receive(ws, 'state', predicate=lambda m: m['stop_gen'] == 7 and m['latency_ms'] is not None)
        assert frame['response_health']['timeout_count'] == 3
        assert 0 <= frame['latency_ms'] < 3000
        # A legacy state on this same connection clears the display warning.
        ag.send_json(state(8))
        frame = receive(ws, 'state', predicate=lambda m: m['stop_gen'] == 8)
        assert frame['response_health'] is None
