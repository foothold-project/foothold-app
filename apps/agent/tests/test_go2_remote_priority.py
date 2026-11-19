"""Fake Go2 DDS packets and SDK calls, on the same Session and Gate used in setup."""
import logging
import struct

import pytest

from foothold_agent.go2_direct.remote import RemoteActivity
from foothold_agent.go2_direct.sink import ZERO
from test_go2_direct import Clock
from test_go2_feedback import low, sport
from test_go2_server_drive import rig as drive_rig
from test_setup_pairing import rig as setup_rig
from test_phone import physical_h


def packet(*, lx=0., rx=0., ry=0., ly=0., keys=0):
    value = bytearray(40)
    struct.pack_into('<Hfff4xf', value, 2, keys, lx, rx, ry, ly)
    return value


def sample(feedback, seq, data, *, moving=False):
    msg = low(seq)
    msg.wireless_remote = data
    feedback.lowstate(msg)
    feedback.sportmodestate(sport(seq, velocity=(.4 if moving else 0., 0., 0.)))


@pytest.mark.parametrize('data', [packet(lx=-.3), packet(rx=.3), packet(ry=-.3),
                                  packet(ly=.3), packet(keys=1), packet(keys=1 << 15)])
def test_remote_activity_parses_official_layout_and_expires(data):
    now = Clock()
    remote = RemoteActivity(now, deadband=.25, hold_s=.5)
    for invalid in (None, b'', [999]*40, packet(ly=float('nan'))):
        remote.observe(invalid, now())
        assert remote.snapshot()[0] is None
    remote.observe(packet(lx=.25), now())
    assert remote.snapshot()[0] is False
    remote.observe(list(data), now())
    assert remote.snapshot()[0] is True
    now.value += .4
    remote.observe(packet(), now())
    assert remote.snapshot()[0] is True
    now.value += .11
    assert remote.snapshot()[0] is False
    now.value += .5
    assert remote.snapshot()[0] is None


def test_remote_takes_over_running_web_without_lease_change_or_cached_resume():
    now, sink, normal, emergency, session, client, _, frame = drive_rig()
    def cmd(seq, value):
        frame('cmd', seq=seq, lease_id='fake-lease', axes=list(value))
    forward = (1.5, 0., 0.)
    cmd(1, forward)
    now.value += .05
    sink.drain()
    assert normal.calls[-1][1][0] > 0
    normal.calls.clear()
    emergency.calls.clear()
    for seq in range(10, 30):
        now.value += .05
        sample(session.feedback, seq, packet(keys=1))
        assert session.feedback.consume(client)
        cmd(seq, forward if seq % 2 else ZERO)
        sink.drain()
        sink.check_watchdog()
        assert sink.pending == sink._ramp_velocity == ZERO
    assert session.connected and session.lease_confirmed and session.core.controller == 'fake-lease'
    assert not session.core.latch and not sink.latched and not normal.calls and not emergency.calls
    assert '리모컨' in session.core.reason and any('리모컨' in d['label'] for d in session._state()['devices_changed'])
    for seq in range(30, 42):
        now.value += .05
        sample(session.feedback, seq, packet())
        assert session.feedback.consume(client)
        cmd(seq, forward)
        sink.check_watchdog()
        sink.drain()
    assert not normal.calls and not emergency.calls and '손을' in session.core.reason
    # A duplicate seq, foreign lease, tick and simulated executor zero cannot re-arm.
    cmd(41, ZERO)
    frame('cmd', seq=450, lease_id='wrong', axes=list(ZERO))
    client._emit(session.executor_command('unbound', ZERO))
    client._emit(session.tick())
    cmd(42, forward)
    sink.drain()
    assert not normal.calls
    cmd(43, ZERO)
    cmd(44, forward)
    now.value += .05
    sink.drain()
    assert normal.calls[-1][1][0] > 0 and not sink.latched


def test_setup_idle_and_web_watchdog_yield_but_operator_stop_persists_until_unlock():
    gate, session, client, inputs, wall, _, _, _, activate = setup_rig()
    session.receive(dict(t='field_approval', expires_at=wall()+600))
    activate()
    epoch, active = gate.epoch, gate.active
    sink = active.sink
    def frame(kind, **values):
        client._emit(session.receive(dict(t=kind, **values)))
    frame('lease', lease_id='fake-lease', holder_type='USER')
    sample(inputs.feedback, 100, packet(ly=.8), moving=True)
    inputs.feedback.consume(client)
    frame('stop', cause='screen_hidden')
    sink.drain()
    sink.check_watchdog()
    assert sink.latched and not sink.client.calls and not sink.emergency_client.calls
    frame('stop', cause='user_stop')
    sink.check_watchdog()
    sink.drain()
    assert sink.client.calls == sink.emergency_client.calls == [('Move', ZERO), ('StopMove', ())]
    frame('stop', cause='lease_take')  # a later routine stop cannot demote the emergency
    sink.client.calls.clear()
    sink.emergency_client.calls.clear()
    sink.check_watchdog()
    sink.drain()
    assert ('StopMove', ()) in sink.emergency_client.calls and ('StopMove', ()) in sink.client.calls
    assert session.connected and session.core.controller == 'fake-lease' and session.lease_confirmed
    assert gate.allowed() and gate.active is active and gate.epoch == epoch
    assert session._state()['battery']['soc'] == 75


def test_confirmed_ordinary_hold_quiets_both_lanes_and_new_requests_send_immediately():
    _, sink, normal, emergency, session, client, _, frame = drive_rig()
    frame('stop', cause='lease_take')
    for seq in range(100, 110):
        sample(session.feedback, seq, packet())
        session.feedback.consume(client)
        if seq == 100:
            sink.drain()
            sink.check_watchdog()
            normal.calls.clear()
            emergency.calls.clear()
        else:
            sink.drain()
            sink.check_watchdog()
    assert not normal.calls and not emergency.calls
    frame('stop', cause='lease_take')
    sink.drain()
    sink.check_watchdog()
    assert normal.calls == emergency.calls == [('Move', ZERO), ('StopMove', ())]


def test_remote_arrives_during_ordinary_stop_rejection_keeps_output_workers_healthy(caplog):
    _, sink, normal, _, session, _, _, frame = drive_rig()
    frame('stop', cause='screen_hidden')
    def reject():
        sample(session.feedback, 100, packet(ry=.5))
        return -1
    normal.StopMove = reject
    sink.drain()
    assert sink.error is None and session.connected and session.lease_confirmed
    assert 'GO2_REMOTE_OUTPUT_REJECTED method=StopMove code=-1' in caplog.text
    assert sink.pending == ZERO


def test_emergency_remote_failure_reported_and_retried_on_independent_lane(caplog):
    now, sink, _, emergency, session, client, _, frame = drive_rig()
    frame('stop', cause='user_stop')
    emergency.calls.clear()
    def reject():
        emergency.calls.append(('StopMove', ()))
        return -1
    emergency.StopMove = reject
    for seq in range(100, 103):
        now.value += .21
        sample(session.feedback, seq, packet(keys=1), moving=True)
        session.feedback.consume(client)
        sink.check_watchdog()
    assert emergency.calls.count(('StopMove', ())) == 3 and sink.latched and sink.error is None
    assert any(row.levelno == logging.CRITICAL and 'GO2_EMERGENCY_OUTPUT_FAILED' in row.message
               for row in caplog.records)
    assert session.connected and session.core.controller == 'fake-lease'


def test_absent_remote_field_preserves_drive_and_wrong_robot_cannot_claim_remote():
    now, sink, normal, _, session, _, _, frame = drive_rig()
    assert session.feedback.remote.snapshot()[0] is None
    frame('cmd', seq=1, lease_id=session.lease_id, axes=[1.5, 0., 0.])
    now.value += .05
    sink.drain()
    assert normal.calls[-1][1][0] > 0
    other = low(999, sn=(9, 9))
    other.wireless_remote = packet(keys=65535)
    session.feedback.lowstate(other)
    assert session.feedback.fault and session.feedback.remote.snapshot()[0] is None


def test_authorized_executor_zero_after_remote_release_cannot_restart_a_run():
    now, sink, normal, emergency, session, client, _, _ = drive_rig()
    session.holder_type, session.holder_run_id = 'RUN', 'run'
    session.run = dict(run_id='run', status='RUNNING', step=0)
    session.executor_t = now()
    normal.calls.clear()
    emergency.calls.clear()
    for seq in range(10, 25):
        now.value += .05
        sample(session.feedback, seq, packet(keys=int(seq == 10)))
        session.feedback.consume(client)
        client._emit(session.executor_command('run', ZERO))
        client._emit(session.executor_command('run', (1.5, 0., 0.)))
        sink.drain()
        sink.check_watchdog()
    assert not normal.calls and not emergency.calls
    assert sink.pending == session.core.out == ZERO and session.lease_confirmed
    assert session.holder_run_id == 'run' and not sink.latched


@pytest.mark.parametrize('origin', ['phone', 'cloud'])
def test_direct_phone_and_cloud_stop_keep_the_same_operator_and_observations(physical_h, origin):
    from foothold_agent.go2_direct.feedback import Feedback
    from foothold_agent.go2_direct.phone import Go2Hub, PhoneSink
    from foothold_agent.go2_direct.sink import Go2Sink
    from foothold_agent.phone.observer import Observer
    from test_go2_direct import FakeSport

    h = physical_h
    sink = Go2Sink(FakeSport(), FakeSport(), now=h.clock, offline_test_mode=True, phone_watchdog=True)
    feedback = Feedback('1234-5678', now=h.clock)
    feedback.sink = sink
    adapter = PhoneSink(sink)
    hub = Go2Hub(h.verifier, adapter, feedback=feedback, policy_name='test', policy_version='1',
                 simulation=False, now=h.clock, wall=h.clock.wall)
    adapter.hub = h.hub = hub
    peer, _, _ = h.connect()
    assert h.take(peer)['ok']
    lease = hub.session.lease_id
    sample(feedback, 1, packet(keys=1))
    feedback.consume(hub)
    observer = Observer(hub)
    observer.receive(dict(t='stop', cause='screen_hidden', stop_ref=1))
    sink.check_watchdog()
    sink.drain()
    assert not sink.emergency_client.calls and not sink.client.calls
    assert '리모컨' in h.cmd(peer)['reason']
    if origin == 'phone':
        assert h.send(peer, 'stop')['ok']
    else:
        observer.receive(dict(t='stop', cause='user_stop', stop_ref=2))
    sink.check_watchdog()
    assert ('StopMove', ()) in sink.emergency_client.calls
    assert hub.owner is peer and hub.session.lease_id == lease and hub.session.connected
    assert hub.state(peer)['battery']['soc'] == 75
    # Unlock during handset activity still yields to the handset. The later
    # neutral must be received from this phone after the activity tail.
    sample(feedback, 2, packet(keys=1))
    feedback.consume(hub)
    assert h.send(peer, 'unlock', lease_id=lease, stop_gen=hub.session.core.stop_gen)['ok']
    sample(feedback, 3, packet(keys=1))
    feedback.consume(hub)
    assert h.cmd(peer, 0)['applied'] == list(ZERO)
    for seq in range(4, 16):
        h.clock.t += .05
        sample(feedback, seq, packet())
        feedback.consume(hub)
        assert h.cmd(peer)['applied'] == list(ZERO)
        sink.drain()
    assert not sink.latched and h.cmd(peer, 0)['applied'] == list(ZERO)
    assert h.cmd(peer)['applied'] == [1.5, 0., 0.]
