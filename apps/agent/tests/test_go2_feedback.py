"""Sensor evidence is independent of SDK submission success."""
from types import SimpleNamespace as NS

import pytest

from foothold_agent.go2_direct.feedback import Feedback
from foothold_agent.go2_direct.phone import PhoneSink
from test_go2_direct import Clock, FakeSport, command
from foothold_agent.go2_direct.sink import Go2Sink


def low(tick=1, sn=(1234, 5678), gyro=(0., 0., 0.), dq=0.):
    return NS(sn=sn, tick=tick, imu_state=NS(rpy=[0., 0., 0.], gyroscope=gyro),
              motor_state=[NS(dq=dq) for _ in range(20)], bms_state=NS(soc=75), power_v=28.)


def sport(tick=1, velocity=(0., 0., 0.), **values):
    return NS(**dict(dict(stamp=NS(sec=1, nanosec=tick), velocity=velocity, yaw_speed=0.,
                         mode=0, error_code=0, progress=0., body_height=.30), **values))


def fixture():
    now = Clock()
    sink = Go2Sink(FakeSport(), FakeSport(), now=now, offline_test_mode=True)
    PhoneSink(sink)
    feedback = Feedback('1234-5678', now=now)
    feedback.sink = sink
    states = []
    hub = NS(on_robot_state=states.append)
    return now, sink, feedback, hub, states


def test_stop_requires_new_generation_fresh_identity_and_physical_stationary():
    now, sink, feedback, hub, states = fixture()
    feedback.lowstate(low())
    feedback.sportmodestate(sport())
    assert feedback.consume(hub) and states[-1]['stop_requested']
    sink.apply(command('stop'), source='phone')
    assert feedback.consume(hub)  # cached evidence cannot confirm a new STOP
    assert sink._confirmed_generation is None
    feedback.lowstate(low(2))
    feedback.sportmodestate(sport(2, velocity=(.6, 0., 0.)))
    feedback.consume(hub)
    assert not states[-1]['stop_requested']
    sink.apply(command('unlock'), source='phone')
    assert sink.latched
    feedback.sportmodestate(sport(3))
    feedback.consume(hub)
    assert states[-1]['stop_requested']
    sink.apply(command('unlock'), source='phone')
    assert not sink.latched
    now.value += .201
    assert not feedback.consume(hub)


@pytest.mark.parametrize('kind', ['duplicate-low', 'duplicate-sport', 'backward-sport', 'future-clock', 'stale-low'])
def test_replay_or_old_receipt_cannot_refresh_evidence(kind):
    now, sink, feedback, hub, states = fixture()
    feedback.lowstate(low())
    feedback.sportmodestate(sport(3))
    feedback.consume(hub)
    before = len(states)
    if kind == 'future-clock':
        now.value -= .1
    else:
        now.value += .201
        if kind == 'duplicate-low':
            feedback.lowstate(low())
            feedback.sportmodestate(sport(4))
        elif kind in ('duplicate-sport', 'backward-sport'):
            feedback.lowstate(low(2))
            feedback.sportmodestate(sport(3 if kind == 'duplicate-sport' else 2))
        else:
            feedback.sportmodestate(sport(4))
    assert not feedback.consume(hub) and len(states) == before


def test_competing_identity_fault_is_permanent():
    _, _, feedback, hub, _ = fixture()
    feedback.lowstate(low(sn=(9999, 9999)))
    feedback.lowstate(low(2))
    feedback.sportmodestate(sport(2))
    assert feedback.fault and not feedback.consume(hub)


@pytest.mark.parametrize('changes', [dict(mode=7), dict(error_code=1), dict(progress=1.),
                                    dict(body_height=.1), dict(velocity=(float('nan'), 0., 0.))])
def test_unknown_or_unhealthy_feedback_never_confirms_stop(changes):
    _, sink, feedback, hub, states = fixture()
    feedback.lowstate(low())
    feedback.sportmodestate(sport(**changes))
    feedback.consume(hub)
    assert sink._confirmed_generation is None
    assert not states or not states[-1]['stop_requested']


def test_lowstate_motion_and_tilt_are_required_not_only_sport_zero():
    _, sink, feedback, hub, states = fixture()
    feedback.lowstate(low(dq=.5))
    feedback.sportmodestate(sport())
    feedback.consume(hub)
    assert not states[-1]['stop_requested'] and sink._confirmed_generation is None


def test_independent_watchdog_observation_locks_core_until_fresh_stop_evidence():
    now, sink, feedback, hub, states = fixture()
    feedback.lowstate(low())
    feedback.sportmodestate(sport())
    feedback.consume(hub)
    sink.apply(command('unlock'), source='phone')
    sink.apply(command(), source='phone')
    sink.drain()
    before = sink.output_safety()[0]
    now.value += .301
    sink.check_watchdog()
    sequence, held = sink.output_safety()
    assert sequence > before and held
    feedback.lowstate(low(2))
    feedback.sportmodestate(sport(2))
    feedback.consume(hub)
    assert sink.output_safety() == (sequence, False)
    assert sink.latched  # sensor evidence never unlocks on its own


def test_periodic_core_outputs_do_not_refresh_original_phone_input_deadline():
    now = Clock()
    sink = Go2Sink(FakeSport(), FakeSport(), now=now, offline_test_mode=True, phone_watchdog=True)
    sink.select_source('phone')
    assert sink.confirm_stopped(generation=sink.generation, sequence=1, received_at=now(), stationary=True)
    sink.apply(command('unlock'), source='phone')
    original_input = now()
    sink.apply(command(), source='phone', input_received_at=original_input)
    sink.apply(command(velocity=(.6, 0., 0.)), source='phone', input_received_at=original_input)
    sink.drain()
    for _ in range(7):
        now.value += .05
        sink.apply(command(velocity=(.6, 0., 0.)), source='phone', input_received_at=original_input)
        sink.drain()
        sink.check_watchdog()
    assert sink.latched and sink.pending == (0., 0., 0.)
    assert sink.emergency_client.calls[-1][0] == 'StopMove'


def test_phone_watchdog_requires_original_input_time_for_nonzero():
    now = Clock()
    sink = Go2Sink(FakeSport(), FakeSport(), now=now, offline_test_mode=True, phone_watchdog=True)
    sink.select_source('phone')
    assert sink.confirm_stopped(generation=sink.generation, sequence=1, received_at=now(), stationary=True)
    sink.apply(command('unlock'), source='phone')
    sink.apply(command(), source='phone')
    with pytest.raises(ValueError):
        sink.apply(command(velocity=(.6, 0., 0.)), source='phone')
    assert sink.latched and sink.pending == (0., 0., 0.)
