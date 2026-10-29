"""Simulation adapter ranges and immutable physical-policy evidence (no ROS)."""
import math

import pytest

from test_phone import h, physical_h
from test_nav2_simulation import physical
from foothold_agent.policy_ranges import FOOTHOLD_V2, velocity_input
from foothold_agent.phone.protocol import LIMITS, project_velocity, simulation_velocity
from foothold_agent.safety.core import Z, quantize


@pytest.mark.parametrize('velocity', [(.4, 0, -1), (1.5, 0, 1), (.6789, 0, .0123),
    (.4, 0, math.nextafter(0, 1)), (1.2345, 0, -.9876), Z])
def test_shared_adapter_preserves_all_accepted_si_values(h, velocity):
    owner, _ = h.moving()
    assert FOOTHOLD_V2.validate(velocity)[0] == velocity
    assert simulation_velocity(*velocity) == (velocity, '')
    ack = h.cmd(owner, *velocity)
    assert ack['applied'] == list(velocity) and not ack['clipped']
    assert h.outputs[-1].velocity == velocity


@pytest.mark.parametrize('velocity', [(math.nextafter(.4, 0), 0, 0),
    (math.nextafter(1.5, 2), 0, 0), (.6, math.nextafter(0, 1), 0),
    (.6, 0, math.nextafter(1, 2)), (.6, 0, math.nextafter(-1, -2)),
    (-.2, 0, 0), (.3, 0, 0), (0, 0, .5), (.6, .2, 0), (.001, 0, 0)])
def test_outside_range_is_zero_with_reason_not_clipped_or_neutral(h, velocity):
    owner, _, _ = h.connect()
    h.take(owner)
    h.unlock(owner)
    ack = h.cmd(owner, *velocity)
    assert ack['applied'] == list(Z) and ack['reason'] and ack['clipped']
    assert h.hub.session.core.need_neutral
    assert h.cmd(owner, .4)['applied'] == list(Z)
    h.cmd(owner, 0)
    assert h.cmd(owner, .4)['applied'] == [.4, 0, 0]


@pytest.mark.parametrize('velocity', [(float('nan'), 0, 0), (float('inf'), 0, 0),
    (.6, -float('inf'), 0), (.6, 0, True), ('0.6', 0, 0), (None, 0, 0),
    (10**1000, 0, 0), None, {}, [.6], [.6, 0, 0, 0], '.6,0,0'])
def test_malformed_and_nonfinite_adapter_inputs_are_zero_with_reason(velocity):
    assert FOOTHOLD_V2.validate(velocity) == (Z, 'INVALID_VELOCITY')
    assert velocity_input(velocity, local=True) is None


@pytest.mark.parametrize('velocity', [(.3, 0, 0), (.6, .2, 0), (0, 0, .5)])
def test_physical_nav2_keeps_requested_unverified_commands_closed(velocity):
    axes, reason = physical().adapt(velocity)
    assert axes == Z and reason == 'UNSUPPORTED_VELOCITY'


@pytest.mark.parametrize('simulation', [False, None, 0, 1, 'true'])
def test_only_exact_true_selects_simulation_projection(simulation):
    for velocity in [(.3, 0, 0), (.6, .2, 0), (0, 0, .5), (1.5, 0, 1)]:
        assert project_velocity(*velocity, simulation=simulation) == project_velocity(*velocity)


@pytest.mark.parametrize('velocity,expected', [((.3, 0, 0), Z),
    ((.6, .2, 0), (.6, 0, 0)), ((.55, 0, 0), Z), ((0, 0, .5), Z)])
def test_physical_hub_existing_projection_is_unchanged(physical_h, velocity, expected):
    owner, _ = physical_h.moving()
    ack = physical_h.cmd(owner, *velocity)
    assert ack['applied'] == list(expected) and ack['clipped']
    assert physical_h.hub.session.core.velocity_projection is quantize
    if expected == Z:
        assert ack['reason']
    assert physical_h.connect()[2]['limits'] == LIMITS


def test_simulation_state_authority_and_reset_gates_still_block(h):
    owner, _ = h.moving()
    velocity = (1.5, 0, .777)
    h.cmd(owner, *velocity)
    h.state(policy_running=False)
    assert h.outputs[-1].velocity == Z
    h.state()
    assert h.cmd(owner, *velocity)['applied'] == list(Z)
    h.cmd(owner, 0)
    assert h.cmd(owner, *velocity)['applied'] == list(velocity)
    h.clock.t = .1
    h.hub.session.core.reset_pending = h.clock()
    assert h.cmd(owner, *velocity)['applied'] == list(Z)
    h.hub.session.core.reset_pending = None
    h.send(owner, 'lease.release')
    assert h.outputs[-1].velocity == Z and h.hub.session.core.latch
