"""Fake frames, clock, NIC and SDK only: diagnostic fields cannot change gates."""
import logging
from pathlib import Path
from types import SimpleNamespace as NS

import pytest

from foothold_agent.safety.core import Core, SCHEMA, Z
from foothold_agent.safety.lock_log import LockLog, SERVER_CAUSES
from foothold_agent.link.session import Session, MotionCommand
from foothold_agent.setup.runtime import Gate, GatedSession
from foothold_agent.go2_direct.feedback import Feedback
from foothold_agent.go2_direct.sink import Go2Sink
from test_go2_direct import Clock, FakeSport, command, unlock


def records(caplog, *, kind=None):
    return [r.getMessage() for r in caplog.records if r.getMessage().startswith('GO2_LOCK ')
            and (kind is None or f'kind={kind} ' in r.getMessage())]


@pytest.mark.parametrize('cause', sorted(SERVER_CAUSES))
def test_server_stop_code_is_preserved_and_behavior_matches_legacy(cause, caplog):
    sessions = [Session(lambda: 100.), Session(lambda: 100.)]
    for session in sessions:
        session.connect()
        session.receive(dict(t='lease', lease_id='fake-lease', holder_type='USER'))
    caplog.clear()
    old = sessions[0].receive(dict(t='stop', stop_ref=12))
    caplog.clear()
    new = sessions[1].receive(dict(t='stop', stop_ref=12, cause=cause))
    assert new == old
    assert sessions[1].core.stop_gen == sessions[0].core.stop_gen
    assert sessions[1].core.latch and sessions[1].lease_confirmed
    assert any(f'kind=stop cause={cause} source=server ' in line for line in records(caplog))


@pytest.mark.parametrize('bad', [None, [], {}, 1, 'secret-value', 'user_stop\nTOKEN=x'])
def test_legacy_or_invalid_reason_is_unknown_and_still_stops(bad, caplog):
    session = Session(lambda: 100.)
    session.connect()
    caplog.clear()
    effects = session.receive(dict(t='stop', stop_ref=2, cause=bad))
    assert session.core.latch and session.stop_ref == 2
    assert all(m.velocity == Z for m in effects.motion)
    assert any('kind=stop cause=unknown source=server ' in x for x in records(caplog))
    assert all('secret' not in x and 'TOKEN' not in x for x in records(caplog))


def test_lease_null_without_second_stop_records_release_immediately(caplog):
    session = Session(lambda: 100.)
    session.connect()
    session.receive(dict(t='lease', lease_id='fake-lease', holder_type='USER'))
    caplog.clear()
    session.receive(dict(t='lease', lease_id=None, holder_type=None, cause='screen_hidden'))
    assert session.core.controller is None and session.core.latch and not session.lease_confirmed
    assert {x.split()[1] for x in records(caplog)} == {'kind=stop', 'kind=lock', 'kind=release'}
    assert all('cause=screen_hidden source=server ' in x for x in records(caplog))


def test_rolling_second_throttle_and_healthy_age(caplog):
    clock = Clock()
    log = LockLog(clock)
    log.healthy()
    for offset in (0., .05, .99, 1., 1.01, 1.99, 2.):
        clock.value = 1000.+offset
        log.emit('stop', 'input_deadman')
    assert [x.rsplit('=', 1)[-1] for x in records(caplog)] == ['0', '1000', '2000']
    log.emit('lock', 'input_deadman')
    log.emit('stop', 'feedback_lost')
    assert len(records(caplog)) == 5  # independent kind/cause keys


def test_logging_failure_never_prevents_stop_or_release(monkeypatch):
    session = Session(lambda: 100.)
    session.connect()
    session.receive(dict(t='lease', lease_id='fake-lease', holder_type='USER'))
    def fail(*args, **kwargs):
        raise OSError('fake logging failure')
    monkeypatch.setattr(logging.getLogger('foothold_agent.lock'), 'warning', fail)
    session.receive(dict(t='lease', lease_id=None, holder_type=None, cause='lease_expired'))
    session.receive(dict(t='stop', stop_ref=10, cause='lease_expired'))
    assert session.core.controller is None and session.core.latch and session.stop_ref == 10


def gated():
    clock = Clock()
    feedback = Feedback('fake', now=clock)
    inputs = NS(mac_identity=None, feedback=feedback, identity=lambda: 'fake')
    gate = Gate(NS(name='fake-nic'), 'fake', inputs, ready=True, nic_matches=lambda: True,
                now=clock, wall=clock)
    session = GatedSession(feedback, gate)
    session.now = clock
    session.core.now = clock
    session.core.lock_log.now = clock
    session.connected = True
    session.last_server = clock()
    session.lease_id = 'fake-lease'
    session.lease_confirmed = True
    session.core.take('fake-lease')
    gate.deadline = gate.last_expiry = clock()+60
    gate.active = NS(sink=NS(client=FakeSport(), emergency_client=FakeSport(),
                            apply=lambda *a, **kw: None, close=lambda: None))
    return clock, gate, session


@pytest.mark.parametrize('failure,expected', [
    ('expiry', 'approval_expired'), ('wall_expiry', 'approval_expired'),
    ('nic', 'nic_mismatch'), ('nic_delay', 'nic_check_delayed'),
    ('nic_error', 'nic_check_failed'), ('identity', 'identity_changed'),
    ('identity_error', 'identity_unavailable'), ('identity_epoch', 'identity_check_failed'),
    ('identity_conflict', 'identity_changed'), ('identity_delay', 'identity_check_delayed'),
    ('feedback', 'feedback_identity_conflict'), ('disconnect', 'connection_changed'),
    ('reconnect', 'connection_changed'), ('link', 'link_lost'), ('preflight', 'preflight_unavailable'),
])
def test_revoke_distinguishes_failed_operand(failure, expected, caplog):
    clock, gate, session = gated()
    if failure == 'expiry': gate.deadline = clock()
    elif failure == 'wall_expiry': gate.last_expiry = clock()
    elif failure.startswith('nic'):
        gate.nic_matches = lambda: False
        if failure != 'nic': gate.nic_cause = lambda: expected
    elif failure == 'identity': gate.inputs.identity = lambda: 'different'
    elif failure == 'identity_error':
        def unavailable(): raise PermissionError('private details must not be logged')
        gate.inputs.identity = unavailable
    elif failure in ('identity_epoch', 'identity_conflict', 'identity_delay'):
        gate.inputs.mac_identity = NS(failure_epoch=1, failure_cause=expected)
    elif failure == 'feedback': gate.inputs.feedback._fault = True
    elif failure == 'disconnect': session.connected = False
    elif failure == 'reconnect': session.reconnect_required = True
    elif failure == 'link': session.link_lost = True
    elif failure == 'preflight': gate.ready = False
    caplog.clear()
    assert not gate.allowed()
    assert gate.active is None and session.core.controller is None and session.core.latch
    assert session.lease_id is None and not session.lease_confirmed
    assert any(f'kind=release cause={expected} source=agent ' in x for x in records(caplog))
    assert all('private' not in x and 'fake-lease' not in x for x in records(caplog))


@pytest.mark.parametrize('failure,expected', [('apply','output_apply_stalled'),
    ('drain','output_drain_stalled'), ('input','output_input_stale')])
def test_output_watchdog_subcause_does_not_change_hold(failure, expected, caplog):
    clock = Clock()
    sink = Go2Sink(FakeSport(), FakeSport(), now=clock, offline_test_mode=True, phone_watchdog=True)
    sink.select_source('phone')
    unlock(sink, clock)
    sink.apply(command(), source='phone', input_received_at=clock())
    caplog.clear()
    clock.value += .31
    if failure != 'apply': sink._last_apply = clock()
    if failure == 'input': sink._last_drain = clock()
    assert sink.check_watchdog()
    assert sink.latched and sink.pending == Z
    assert any(f'kind=lock cause={expected} source=agent ' in x for x in records(caplog))


def test_deadman_zero_does_not_latch_or_release(caplog):
    clock = Clock()
    core = Core(clock)
    core.ev = lambda *args: None
    core.take('fake')
    core.on_state(dict(schema=SCHEMA, episode=0, stop_requested=False,
                       reset_in_progress=False, policy_running=True))
    core.cmd('fake', Z)
    core.cmd('fake', (1., 0., 0.))
    assert core.applied() != Z
    clock.value += .301
    caplog.clear()
    assert core.applied() == Z
    assert not core.latch and core.controller == 'fake'
    assert len(records(caplog)) == 1 and 'kind=stop cause=input_deadman' in records(caplog)[0]


def test_idle_already_held_watchdog_is_not_a_new_output_incident(caplog):
    clock = Clock()
    sink = Go2Sink(FakeSport(), FakeSport(), now=clock, offline_test_mode=True)
    caplog.clear()
    for _ in range(3):
        clock.value += 1.
        sink.check_watchdog()
    assert sink.latched and sink._stall_sequence == 0
    assert not records(caplog)


def test_local_phone_envelopes_do_not_claim_server_provenance(caplog):
    session = Session(lambda: 100., server_link=False)
    session.connect()
    caplog.clear()
    session.receive(dict(t='stop'))
    assert any('cause=other_stop source=agent ' in x for x in records(caplog))
    assert all('source=server' not in x for x in records(caplog))


@pytest.mark.parametrize('failure,expected', [('query','identity_check_failed'),
    ('slow','identity_check_delayed'), ('conflict','identity_changed')])
def test_identity_check_records_safe_failure_category(failure, expected):
    from foothold_agent.setup.identity import MacIdentity
    clock = Clock()
    inputs = NS(zero_identity_changed=lambda: False, observed_identity=lambda: '0-0')
    mac = '02:00:00:00:00:11'
    def query(_):
        if failure == 'query': raise PermissionError('private neighbor query failure')
        if failure == 'slow': clock.value += .201
        return ('02:00:00:00:00:12' if failure == 'conflict' else mac), []
    identity = MacIdentity('fake-nic', mac, inputs, query=query, now=clock)
    with pytest.raises(PermissionError): identity.check()
    assert identity.failure_cause == expected and identity.failure_epoch == 1
    assert identity.fault is (failure == 'conflict')
