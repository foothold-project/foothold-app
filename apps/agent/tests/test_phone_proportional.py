"""Offline physical-phone steps and unchanged STOP/deadman/output boundaries."""
import math

import pytest

from foothold_agent.go2_direct.sink import PHONE_FORWARD_STEPS, DEADLINE_S, Limits, SERVER_ALLOWED, server_velocity
from foothold_agent.phone.protocol import LIMITS
from foothold_agent.safety.core import DEAD, Z, quantize_phone
from test_go2_direct import command, make_sink, unlock
from test_phone import physical_h
from test_phone_policy_compat import phone_transform


@pytest.mark.parametrize('fx,expected', [(.19, 0), (math.nextafter(.2, 0), 0),
    (.2, .3), (.26, .3), (.27, .4), (.4, .6), (.5, .7), (.6, .9),
    (.8, 1.2), (math.nextafter(1., 0), 1.4), (1., 1.5)])
def test_physical_phone_axis_steps_round_down(fx, expected):
    assert quantize_phone(fx, 0, 0)[0] == (expected, 0, 0)


@pytest.mark.parametrize('fx', [.2, math.nextafter(.5, 0), .5, .6, 1.])
@pytest.mark.parametrize('fw', [-1, -.7, -.5, -.03, 0, .05, .5, .8, 1])
def test_physical_phone_steers_proportionally_above_forward_threshold(fx, fw):
    velocity, reason = quantize_phone(fx, 0, fw)
    assert velocity[2] == (fw * 2.5 if fx >= .5 else 0)
    assert Limits().project(velocity) == velocity and not reason


@pytest.mark.parametrize('axes', [(-1, 0, 0), (-.2, 0, 1),
    (1, .5, 0), (.2, -.5, 1), (0, 0, 1), (0, 0, -.5)])
def test_reverse_lateral_and_spin_stay_zero(axes):
    velocity, reason = quantize_phone(*axes)
    assert velocity == Z and reason


def test_phone_and_server_alphabets_are_separate_and_exact():
    assert PHONE_FORWARD_STEPS == {step / 10 for step in range(3, 16)}
    for preset in LIMITS['commands']:
        assert Limits().project(preset) == tuple(preset)
    assert SERVER_ALLOWED == {Z, (1.5, 0, 0), (-1.5, 0, 0), (0, 1., 0),
        (0, -1., 0), (0, 0, .5), (0, 0, -.5), (1.5, 0, .5), (1.5, 0, -.5),
        (0, 0, 2.5), (0, 0, -2.5), (1.5, 0, 2.5), (1.5, 0, -2.5)}
    assert DEAD == DEADLINE_S == .3


@pytest.mark.parametrize('vx', [step / 10 for step in range(3, 16)])
@pytest.mark.parametrize('turn', [0, -.5, .5, -2.5, 1.234, 2.5])
def test_sink_accepts_every_explicit_phone_step(vx, turn):
    assert Limits().project((vx, 0, turn)) == (vx, 0, turn)


@pytest.mark.parametrize('velocity', [(.29, 0, 0), (.31, 0, 0), (.45, 0, .5),
    (.99, 0, 0), (math.nextafter(.9, 0), 0, 0), (.9, 0, 2.5001)])
def test_sink_rejects_values_between_explicit_steps(velocity):
    with pytest.raises(ValueError):
        Limits().project(velocity)
    with pytest.raises(ValueError):
        server_velocity(velocity)


@pytest.mark.parametrize('fx,expected', [(.19, 0), (.2, .3), (.6, .9), (1, 1.5)])
def test_shipped_web_transform_through_physical_hub(physical_h, phone_transform, fx, expected):
    h = physical_h
    peer, _, welcome = h.connect()
    assert h.take(peer)['ok']
    h.unlock(peer)
    h.cmd(peer, 0)
    velocity = phone_transform(welcome, [fx, 0, 0])
    assert velocity['vx'] == fx * 1.5  # web retains continuous stick intent
    assert h.cmd(peer, **velocity)['applied'] == [expected, 0, 0]
    h.send(peer, 'stop')
    assert h.outputs[-1].velocity == Z and h.hub.session.core.latch
    assert h.cmd(peer, **velocity)['applied'] == list(Z)


def test_low_speed_deadman_still_requires_fresh_release(physical_h):
    h = physical_h
    peer, _ = h.moving()
    assert h.cmd(peer, .3)['applied'] == [.3, 0, 0]
    h.clock.t = .30001
    h.hub.tick()
    assert h.outputs[-1].velocity == Z and h.hub.session.core.need_neutral
    assert h.cmd(peer, .15)['applied'] == list(Z)
    assert h.hub.session.core.need_neutral
    assert h.cmd(peer, .3)['applied'] == list(Z)
    h.cmd(peer, 0)
    assert h.cmd(peer, .3)['applied'] == [.3, 0, 0]
    assert h.cmd(peer, 0)['applied'] == list(Z)


@pytest.mark.parametrize('end', ['stop', 'timeout'])
def test_low_speed_sink_stop_and_watchdog_discard_pending(end):
    sink, normal, emergency, clock = make_sink()
    unlock(sink, clock)
    sink.apply(command(velocity=(.3, 0, 0)), source='phone')
    sink.drain()
    assert normal.calls[-1] == ('Move', (.3, 0, 0))
    if end == 'stop':
        sink.apply(command('stop'), source='phone')
    else:
        clock.value += .30001
    assert sink.check_watchdog()
    sink.drain()
    assert sink.latched and sink.pending == Z
    assert normal.calls[-2:] == [('Move', Z), ('StopMove', ())]
    assert emergency.calls[-2:] == [('Move', Z), ('StopMove', ())]


@pytest.mark.parametrize('sign', [-1, 1])
def test_phone_yaw_ramp_release_and_stop_on_both_lanes(sign):
    sink, normal, emergency, clock = make_sink()
    unlock(sink, clock)

    def apply(turn):
        sink.apply(command(velocity=(1.5, 0, sign * turn)), source='phone')
        sink.drain()
        method, (forward, side, yaw) = normal.calls[-1]
        assert (method, forward, side) == ('Move', 1.5, 0.)
        return sign * yaw

    assert apply(2.5) == 0
    for tick in range(1, 43):
        clock.value += .05
        assert apply(2.5) == pytest.approx(min(tick * .0625, 2.5))
    assert apply(0) == 2.5
    for tick in range(1, 7):
        clock.value += .05
        assert apply(0) == pytest.approx(2.5 * (1 - tick / 6), abs=1e-10)

    # Move the stick on every tick. Changing targets must not restart the ramp.
    apply(.5)
    for tick in range(1, 9):
        clock.value += .05
        assert apply(.5 + tick / 10) == pytest.approx(tick * .0625)
    sink.apply(command(), source='phone')
    sink.drain()
    assert normal.calls[-1] == ('Move', Z)  # no braking turn in place

    apply(2.5)
    clock.value += .1
    assert apply(2.5) == pytest.approx(.125)
    sink.apply(command('stop'), source='phone')
    assert sink.check_watchdog()
    sink.drain()
    for lane in (normal, emergency):
        assert lane.calls[-2:] == [('Move', Z), ('StopMove', ())]
