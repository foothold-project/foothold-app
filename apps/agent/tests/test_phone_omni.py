"""Simulation experiments, physical isolation and ROS-free SI output evidence."""
import math
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from test_phone import h, physical_h
from apps.contracts.models import PhoneLimits, PhoneWelcome
from foothold_agent.phone.protocol import LIMITS, SIMULATION_LIMITS, project_velocity, simulation_velocity
from foothold_agent.ros_bridge.sink import RosSink, twist_message
from foothold_agent.safety.core import Z, quantize


@pytest.mark.parametrize('axis,value', [(0, math.nextafter(-.3, -1)), (0, math.nextafter(1, 2)),
    (1, math.nextafter(-.3, -1)), (1, math.nextafter(.3, 1)),
    (2, math.nextafter(-.5, -1)), (2, math.nextafter(.5, 1))])
def test_outside_adapter_range_rejects_entire_command(axis, value):
    requested = [.6, 0, 0]
    requested[axis] = value
    axes, clipped = project_velocity(*requested, simulation=True)
    assert axes == tuple(requested) and clipped
    result, reason = simulation_velocity(*axes)
    assert result == Z and reason


EXPERIMENTS = [(-.3, 0, 0), (0, -.3, 0), (0, .3, 0), (0, 0, -.5),
               (0, 0, .5), (.2, .3, .5), (-.3, -.3, -.5)]


@pytest.mark.parametrize('velocity', EXPERIMENTS + [(.4, 0, -.123), (1, 0, .5), (.8, 0, -.5)])
def test_omni_session_zero_stop_and_deadman(h, velocity):
    owner, _ = h.moving()
    assert h.cmd(owner, *velocity)['applied'] == list(velocity)
    assert h.outputs[-1].velocity == velocity
    assert h.cmd(owner, 0)['applied'] == list(Z)
    assert h.outputs[-1].velocity == Z
    h.cmd(owner, *velocity)
    h.clock.t = .30001
    h.hub.tick()
    assert h.outputs[-1].velocity == Z and h.hub.session.core.need_neutral
    assert h.cmd(owner, *velocity)['applied'] == list(Z)
    h.cmd(owner, 0)
    assert h.cmd(owner, *velocity)['applied'] == list(velocity)
    h.send(owner, 'stop')
    assert h.outputs[-1].velocity == Z and h.hub.session.core.latch
    assert h.cmd(owner, *velocity)['applied'] == list(Z)
    h.unlock(owner)
    assert h.cmd(owner, *velocity)['applied'] == list(Z)
    h.cmd(owner, 0)
    assert h.cmd(owner, *velocity)['applied'] == list(velocity)


@pytest.mark.parametrize('velocity', EXPERIMENTS)
def test_physical_hub_keeps_experiments_closed(physical_h, velocity):
    owner, _ = physical_h.moving()
    ack = physical_h.cmd(owner, *velocity)
    assert ack['applied'] == list(Z) and ack['clipped']
    assert physical_h.outputs[-1].velocity == Z
    assert physical_h.hub.session.core.velocity_projection is quantize
    assert physical_h.connect()[2]['limits'] == LIMITS
    assert 'experimental' not in LIMITS


def test_experimental_limits_are_optional_and_welcome_is_deep_copied(h):
    assert PhoneLimits.model_validate(LIMITS).experimental == []
    welcome = h.connect()[2]
    assert welcome['limits'] == SIMULATION_LIMITS
    parsed = PhoneWelcome.model_validate(welcome)
    assert (parsed.limits.vx_min, parsed.limits.vx_max) == (-.3, 1)
    assert (parsed.limits.vy_min, parsed.limits.vy_max) == (-.3, .3)
    assert (parsed.limits.wz_min, parsed.limits.wz_max) == (-.5, .5)
    assert parsed.limits.experimental == ['reverse', 'lateral', 'turn_in_place']
    welcome['limits']['experimental'].clear()
    assert h.connect()[2]['limits']['experimental'] == ['reverse', 'lateral', 'turn_in_place']
    with pytest.raises(ValidationError):
        PhoneLimits.model_validate({**SIMULATION_LIMITS, 'experimental': ['unknown']})


@pytest.mark.parametrize('velocity', EXPERIMENTS + [(.4, 0, -.123), (1, 0, .5), (.8, 0, -.5)])
def test_omni_core_to_ros_sink_to_twist_without_ros(h, velocity):
    messages = []
    def factory():
        return SimpleNamespace(linear=SimpleNamespace(x=0., y=0., z=0.),
                               angular=SimpleNamespace(x=0., y=0., z=0.))
    sink = RosSink(lambda v: messages.append(twist_message(v, factory)),
                   lambda: None, lambda: None, now=h.clock, watchdog=False)
    original_sink = h.hub.sink
    try:
        h.hub.sink = sink
        h.hub.session.output_safety = sink.output_safety
        owner, _ = h.moving()
        sink.flush()  # Dispatch the explicit unlock before fresh movement.
        ack = h.cmd(owner, *velocity)
        h.clock.t = .05
        sink.flush()
        message = messages[-1]
        assert ack['applied'] == list(velocity) and not ack['clipped']
        assert (message.linear.x, message.linear.y, message.angular.z) == velocity
        assert (message.linear.z, message.angular.x, message.angular.y) == Z
        h.send(owner, 'stop')
        sink.flush()
        message = messages[-1]
        assert (message.linear.x, message.linear.y, message.angular.z) == Z
    finally:
        h.hub.sink = original_sink
        h.hub.session.output_safety = None
        sink.close()
