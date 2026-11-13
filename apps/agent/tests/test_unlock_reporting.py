"""Refusal diagnostics cannot grant motion or expose identity/input data."""
from types import SimpleNamespace

import pytest

from apps.contracts.models import AgentState
from foothold_agent.link.session import Session
from foothold_agent.safety.core import SCHEMA, Z
from foothold_agent.go2_direct.feedback import Feedback
from foothold_agent.go2_direct.reporting import devices
from test_go2_feedback import fixture, low, sport


def setup_session():
    session = Session(now=lambda: 0.)
    session.connect()
    session.receive(dict(t='lease', lease_id='private-lease', holder_type='USER'))
    session.on_robot_state(dict(schema=SCHEMA, episode=0, stop_requested=True,
        reset_in_progress=False, policy_running=True))
    return session


@pytest.mark.parametrize('change,reason', [
    ('lease', 'LEASE_MISMATCH'), ('unconfirmed', 'LEASE_UNCONFIRMED'),
    ('invalid', 'INVALID_GENERATION'), ('generation', 'GENERATION_MISMATCH'),
    ('held', 'OUTPUT_HELD'), ('controller', 'NO_CONTROLLER'), ('unseen', 'STATE_UNSEEN'),
    ('stale', 'STATE_STALE'), ('resetting', 'STATE_RESETTING'), ('policy', 'POLICY_NOT_RUNNING'),
    ('stop', 'STOP_UNCONFIRMED'), ('reset', 'RESET_PENDING'), ('pending', 'RESUME_PENDING'),
    ('busy', 'SIM_BUSY'), ('unlatched', 'NOT_LATCHED')])
def test_refusal_codes_preserve_gate(change, reason):
    s = setup_session()
    frame = dict(t='unlock', lease_id=s.lease_id, stop_gen=s.core.stop_gen, secret='never-forward')
    if change == 'lease': frame['lease_id'] = 'other-private-lease'
    elif change == 'unconfirmed': s.lease_confirmed = False
    elif change == 'invalid': frame['stop_gen'] = True
    elif change == 'generation': frame['stop_gen'] -= 1
    elif change == 'held': s.output_safety = lambda: (1, True)
    elif change == 'controller': s.core.controller = 'other'
    elif change == 'unseen': s.core.st = None
    elif change == 'stale': s.core.state_t = -2
    elif change == 'resetting': s.core.st['reset_in_progress'] = True
    elif change == 'policy': s.core.st['policy_running'] = False
    elif change == 'stop': s.core.st['stop_requested'] = False
    elif change == 'reset': s.core.reset_pending = .1
    elif change == 'pending': s.core.resume_pending = (.1, s.core.state_seq)
    elif change == 'busy': s.core.sim_busy = 'private-busy-input'
    elif change == 'unlatched': s.core.latch = False
    if change == 'held':
        s._sync_output_hold()
        frame['stop_gen'] = s.core.stop_gen
    result = s.receive(frame)
    refusal = s._state()['unlock_refused']
    assert refusal is not None
    assert refusal['reason'] == reason
    assert refusal['axes'] == [] and refusal['at'].endswith('+00:00')
    assert not any(m.kind == 'unlock' for m in result.motion)
    assert s.core.out == Z
    assert all(v not in str(refusal) for v in ('never-forward', 'private-lease', 'private-busy-input'))
    AgentState.model_validate(s._state())


def test_success_clears_last_refusal_and_keeps_confirmation_and_neutral_gates():
    s = setup_session()
    s.receive(dict(t='unlock', lease_id=s.lease_id, stop_gen=-1))
    assert s.unlock_refused
    result = s.receive(dict(t='unlock', lease_id=s.lease_id, stop_gen=s.core.stop_gen))
    assert s.unlock_refused is None
    assert any(m.kind == 'unlock' for m in result.motion)
    assert s.core.latch and s.core.resume_pending and s.core.need_neutral and s.core.out == Z


def test_go2_still_refusal_reports_every_failed_axis_including_vertical_and_joints():
    now, sink, old, hub, states = fixture()
    sink.select_source('server')
    feedback = Feedback('1234-5678', now=now)
    feedback.sink = sink
    s = setup_session()
    feedback.lowstate(low(gyro=(.06, 0., 0.), dq=.11))
    feedback.sportmodestate(sport(velocity=(.021, -.022, .063), yaw_speed=.031))
    feedback.consume(SimpleNamespace(on_robot_state=s.on_robot_state))
    result = s.receive(dict(t='unlock', lease_id=s.lease_id, stop_gen=s.core.stop_gen))
    refusal = s._state()['unlock_refused']
    assert refusal['reason'] == 'STILL_MOVING'
    values = {v['axis']: v for v in refusal['axes']}
    assert set(values) == {'vx', 'vy', 'vz', 'wz', 'gyro_x', *(f'joint_{i}' for i in range(12))}
    assert values['vz'] == dict(axis='vz', value=.063, limit=.06, unit='m/s')
    assert values['gyro_x']['limit'] == .05 and values['joint_11']['limit'] == .10
    assert not any(m.kind == 'unlock' for m in result.motion)
    assert s.core.latch and s.core.out == Z
    AgentState.model_validate(s._state())


@pytest.mark.parametrize('accepted,source,code,expected', [
    ((), 'server', 0, 'OK'), ((100,), 'server', 100, 'ACCEPTED'),
    ((), 'server', 100, 'ERROR'), ((100,), 'server', 101, 'ERROR'),
    ((100,), 'phone', 100, 'ERROR')])
def test_device_status_uses_exact_readiness_allowlist_and_source(accepted, source, code, expected):
    now, sink, old, hub, states = fixture()
    sink.select_source(source)
    feedback = Feedback('1234-5678', now=now, accept_error_codes=accepted)
    feedback.sink = sink
    feedback.lowstate(low()); feedback.sportmodestate(sport(error_code=code))
    ready = feedback.consume(hub)
    assert ready == (expected != 'ERROR')
    s = setup_session()
    s.now = now
    s.update_devices(devices(feedback.telemetry(), now()))
    device = s._device_snapshot()[-1]
    assert 'status_code' in device
    assert device['state'] == ('ERROR' if expected == 'ERROR' else 'OK')
    assert device['status_code'] == dict(raw=code, level=expected,
        reason='EXPLICIT_SERVER_ALLOWLIST' if expected == 'ACCEPTED' else None)
    AgentState.model_validate(s._state())
    now.value += 1.01
    assert s._device_snapshot()[-1]['state'] == 'MISSING'
    assert 'status_code' not in s._device_snapshot()[-1]
    assert 'status_code' not in devices(feedback.telemetry(), now())[-1]


def test_malformed_private_measurements_cannot_crash_or_leak():
    s = setup_session()
    for value in (True, 'secret', {}, [dict(axis=['secret']), dict(axis='serial', value=1, limit=.1, unit='m/s')]):
        s.on_robot_state(dict(schema=SCHEMA, episode=0, stop_requested=False,
            policy_running=True, reset_in_progress=False, still_violations=value))
        s.receive(dict(t='unlock', lease_id=s.lease_id, stop_gen=s.core.stop_gen))
        assert s.unlock_refused['reason'] == 'STOP_UNCONFIRMED'
        assert s.unlock_refused['axes'] == []
