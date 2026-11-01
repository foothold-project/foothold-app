"""Simulation-only continuous phone velocity; no ROS or physical connection."""
import math

import pytest

from test_phone import h, physical_h
from apps.contracts.models import PhoneWelcome
from foothold_agent.phone.protocol import LIMITS, SIMULATION_LIMITS, project_velocity, simulation_velocity
from foothold_agent.safety.core import Z, quantize


@pytest.mark.parametrize('vx', [0, .0001, .1999, .2, .3999,
                                .4, .4001, .55, 1.0, 1.5, 1.5001, -1])
@pytest.mark.parametrize('vy', [-.2, 0, .2])
@pytest.mark.parametrize('wz', [-1.01, -1, -.7, -.0001, 0, .0001, .7, 1, 1.01])
def test_simulation_projection_boundaries(vx, vy, wz):
    requested = (vx, vy, wz)
    axes, clipped = project_velocity(*requested, simulation=True)
    result, reason = simulation_velocity(*axes)
    expected = requested if requested == Z or (-.3 <= vx <= 1 and -.3 <= vy <= .3 and -.5 <= wz <= .5) else Z
    assert result == expected
    assert axes == requested  # no hidden clipping or quantization before Core
    assert clipped is (expected != requested)
    assert bool(reason) is (expected == Z and requested != Z)


@pytest.mark.parametrize('vx', [0, .1999, .2, .55, .6, 1.0, 1.0001, -.2])
@pytest.mark.parametrize('wz', [-.5, 0, .5])
def test_physical_projection_is_identical_to_default(vx, wz):
    axes, clipped = project_velocity(vx, .3, wz, simulation=False)
    assert (axes, clipped) == project_velocity(vx, .3, wz)
    applied, _ = quantize(*axes)
    expected = (.6, 0, wz) if vx >= .6 else Z
    assert applied == expected and list(applied) in LIMITS['commands']


@pytest.mark.parametrize('fixture,limits', [('h', SIMULATION_LIMITS), ('physical_h', LIMITS)])
def test_welcome_limits_contract_and_mode(request, fixture, limits):
    harness = request.getfixturevalue(fixture)
    _, _, welcome = harness.connect()
    assert welcome['limits'] == limits
    parsed = PhoneWelcome.model_validate(welcome)
    assert parsed.limits.vx_mode == ('continuous' if welcome['simulation'] else 'discrete')
    if welcome['simulation']:
        assert parsed.limits.vx_min_moving == .2 and parsed.limits.vx_max == 1.0
        assert parsed.limits.policy_velocity_range is None
        assert parsed.limits.commands == []
        assert parsed.limits.policy_adapter_id == 'simulation-experimental-si/1'
        assert parsed.limits.requires_forward_motion is False
    else:
        assert parsed.limits.commands == [[0, 0, 0], [.6, 0, 0], [.6, 0, -.5], [.6, 0, .5]]
    welcome['limits']['vx_max'] = 99
    assert harness.connect()[2]['limits'] == limits  # welcome is a copy


@pytest.mark.parametrize('fixture', ['h', 'physical_h'])
@pytest.mark.parametrize('vx', [0, .1999, .2, .55, .6, 1.0, 1.0001, -.2])
@pytest.mark.parametrize('wz', [-.5, 0, .5])
def test_mode_reaches_actual_session_output(request, fixture, vx, wz):
    harness = request.getfixturevalue(fixture)
    owner, _ = harness.moving()
    ack = harness.cmd(owner, vx, vy=.8, wz=wz)
    if fixture == 'h':
        expected = Z  # vy=.8 is outside this adapter; reject the whole triple
    else:
        x = .6 if vx >= .6 else 0
        expected = (x, 0, wz if x else 0)
    assert ack['applied'] == list(expected)
    assert harness.outputs[-1].velocity == expected
    assert ack['clipped'] is (expected != (vx, .8, wz))


@pytest.mark.parametrize('velocity', [(.1999, 0, 0), (-.0499, 0, 0), (0, .0499, 0), (0, 0, .4999)])
def test_accepted_nonzero_simulation_input_cannot_create_neutral(h, velocity):
    owner, _, _ = h.connect()
    h.take(owner)
    h.unlock(owner)
    ack = h.cmd(owner, *velocity)
    assert ack['applied'] == list(Z) and ack['reason'] and not ack['clipped']
    assert h.hub.session.core.need_neutral
    assert h.cmd(owner, .4)['applied'] == list(Z)
    h.cmd(owner, 0)
    assert h.cmd(owner, .4)['applied'] == [.4, 0, 0]


def test_simulation_release_stop_and_deadman_preserve_existing_gates(h):
    owner, _ = h.moving()
    assert h.cmd(owner, 1, wz=.5)['applied'] == [1, 0, .5]
    assert h.cmd(owner, 0)['applied'] == list(Z)  # immediate ZERO, no ramp
    assert h.outputs[-1].velocity == Z
    assert h.cmd(owner, .55)['applied'] == [.55, 0, 0]
    h.clock.t = .30001
    h.hub.tick()
    assert h.outputs[-1].velocity == Z and h.hub.session.core.need_neutral
    assert h.cmd(owner, 1)['applied'] == list(Z)
    h.cmd(owner, 0)
    assert h.cmd(owner, 1)['applied'] == [1, 0, 0]
    h.send(owner, 'stop')
    assert h.cmd(owner, 1)['applied'] == list(Z)
    assert h.hub.session.core.latch
    h.unlock(owner)
    assert h.cmd(owner, 1)['applied'] == list(Z)
    h.cmd(owner, 0)
    assert h.cmd(owner, 1)['applied'] == [1, 0, 0]
