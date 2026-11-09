"""Offline continuous Go2 phone range; unchanged stop and deadman boundaries."""
import math

import pytest

from foothold_agent.go2_direct.sink import DEADLINE_S, Limits, SERVER_ALLOWED, server_velocity
from foothold_agent.phone.protocol import LIMITS, phone_velocity
from foothold_agent.safety.core import DEAD, Z, quantize_phone
from test_go2_direct import command, make_sink, unlock
from test_phone import physical_h
from test_phone_policy_compat import phone_transform


@pytest.mark.parametrize('fx', [.2, .26, .27, .4, .5, .6, .8, math.nextafter(1., 0), 1.])
def test_physical_phone_axes_are_proportional(fx):
    assert quantize_phone(fx, 0, 0)[0] == (fx * 1.5, 0, 0)


@pytest.mark.parametrize('axes', [(-1, 0, 0), (-.2, 0, 1), (1, .5, 0),
                                (.2, -.5, 1), (0, 0, 1), (0, 0, -.5)])
def test_reverse_lateral_and_spin_are_continuous(axes):
    velocity, reason = quantize_phone(*axes)
    assert velocity == tuple(v * m for v, m in zip(axes, (1.5, 1, 4)))
    assert not reason and Limits().project(velocity) == velocity


def test_continuous_phone_metadata_and_unchanged_server_alphabet():
    assert LIMITS['commands'] == [] and LIMITS['vx_mode'] == 'continuous'
    assert SERVER_ALLOWED == {Z, (1.5, 0, 0), (-1.5, 0, 0), (0, 1.5, 0),
        (0, -1.5, 0), (0, 0, .5), (0, 0, -.5), (1.5, 0, .5), (1.5, 0, -.5)}
    assert DEAD == DEADLINE_S == .3


@pytest.mark.parametrize('velocity', [(.31, -.27, .99), (-1.5, 1, -4),
    (1.5, -1, 4), (.45, 0, .8), (.99, .2, 0)])
def test_hub_si_and_sink_preserve_continuous_values(velocity):
    assert phone_velocity(*velocity) == (velocity, '')
    assert Limits().project(velocity) == velocity
    with pytest.raises(ValueError):
        server_velocity(velocity)


@pytest.mark.parametrize('axis', range(3))
@pytest.mark.parametrize('sign', [-1, 1])
def test_outside_each_axis_is_rejected_not_clamped(axis, sign, physical_h):
    maxima = (1.5, 1, 4)
    velocity = [0., 0., 0.]
    velocity[axis] = sign * math.nextafter(maxima[axis], math.inf)
    assert phone_velocity(*velocity) == (Z, 'UNSUPPORTED_VELOCITY')
    with pytest.raises(ValueError):
        Limits().project(velocity)
    owner, _ = physical_h.moving()
    ack = physical_h.cmd(owner, *velocity)
    assert ack['applied'] == list(Z) and ack['clipped'] and ack['reason']
    assert physical_h.cmd(owner, .6)['applied'] == [.6, 0, 0]


@pytest.mark.parametrize('axis', range(3))
@pytest.mark.parametrize('bad', [float('nan'), float('inf'), -float('inf'), True])
def test_nonfinite_and_bool_are_rejected_on_every_axis(axis, bad):
    velocity = [0., 0., 0.]; velocity[axis] = bad
    assert phone_velocity(*velocity) == (Z, 'INVALID_VELOCITY')
    with pytest.raises(ValueError):
        Limits().project(velocity)


@pytest.mark.parametrize('fx', [.19, .2, .26, .6, 1, -1])
def test_shipped_web_transform_through_physical_hub(physical_h, phone_transform, fx):
    h = physical_h
    peer, _, welcome = h.connect()
    assert h.take(peer)['ok']
    h.unlock(peer); h.cmd(peer, 0)
    velocity = phone_transform(welcome, [fx, 0, 0])
    assert velocity['vx'] == fx * 1.5
    expected = fx * 1.5 if abs(fx) >= .2 else 0
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


@pytest.mark.parametrize('pressed', [[.05, 0, 0], [0, .1, 0], [0, 0, .05],
                                    [-.05, 0, 0], [0, -.1, 0], [0, 0, -.05]])
def test_physical_held_deadzone_cannot_clear_fresh_neutral(physical_h, phone_transform, pressed):
    h = physical_h
    owner, _ = h.moving()
    welcome = h.connect()[2]
    h.clock.t = .30001; h.hub.tick()
    assert h.outputs[-1].velocity == Z and h.hub.session.core.need_neutral
    velocity = phone_transform(welcome, pressed)
    assert tuple(velocity.values()) != Z
    ack = h.cmd(owner, **velocity)
    assert ack['applied'] == list(Z) and ack['reason'] and ack['clipped']
    assert h.hub.session.core.need_neutral
    assert h.cmd(owner, -1.5, 1, -4)['applied'] == list(Z)
    h.cmd(owner, 0)
    assert h.cmd(owner, -1.5, 1, -4)['applied'] == [-1.5, 1, -4]


@pytest.mark.parametrize('stick', [[-.73, .43, -.37], [0, -1, 0], [0, 0, 1], [1, 1, 1]])
def test_browser_to_physical_hub_to_sdk_preserves_all_axes(physical_h, phone_transform, stick):
    h = physical_h
    owner, _ = h.moving()
    request = phone_transform(h.connect()[2], stick)
    ack = h.cmd(owner, **request)
    expected = [stick[0] * 1.5, stick[2], stick[1] * 4]
    assert ack['applied'] == expected and not ack['clipped']
    sink, normal, _, clock = make_sink(); unlock(sink, clock)
    sink.apply(command(velocity=ack['applied']), source='phone'); sink.drain()
    assert normal.calls[-1] == ('Move', tuple(expected))
