"""Simulation-only continuous phone velocity; no ROS or physical connection."""
import math

import pytest

from test_phone import h, physical_h
from apps.contracts.models import PhoneWelcome
from foothold_agent.phone.protocol import LIMITS, SIMULATION_LIMITS, project_velocity, simulation_velocity
from foothold_agent.safety.core import Z, quantize


@pytest.mark.parametrize('vx', [0, .0001, .1999, math.nextafter(.2, 0), .2,
                                .2001, .55, 1.0, 1.0001, -1, -.0001])
@pytest.mark.parametrize('vy', [-1, 0, 1])
@pytest.mark.parametrize('wz', [-1, -.5, -.4999, 0, .4999, .5, 1])
def test_simulation_projection_boundaries(vx, vy, wz):
    axes, clipped = project_velocity(vx, vy, wz, simulation=True)
    result, reason = simulation_velocity(*axes)
    x = min(vx, 1.0) if vx >= .2 else max(vx, -.3) if vx <= -.05 else 0.0
    y = max(-.3, min(vy, .3)) if abs(vy) >= .05 else 0
    expected = (x, y, .5 if wz >= .5 else -.5 if wz <= -.5 else 0)
    assert result == expected
    assert clipped is (expected != (vx, vy, wz))
    assert bool(reason) is (expected == Z and (vx, vy, wz) != Z)
    assert all(-1 <= axis <= 1 for axis in axes)


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
        assert parsed.limits.commands == []
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
        x = min(vx, 1) if vx >= .2 else max(vx, -.3) if vx <= -.05 else 0
        expected = (x, .3, wz)
    else:
        x = .6 if vx >= .6 else 0
        expected = (x, 0, wz if x else 0)
    assert ack['applied'] == list(expected)
    assert harness.outputs[-1].velocity == expected
    assert ack['clipped'] is (expected != (vx, .8, wz))


@pytest.mark.parametrize('velocity', [(.1999, 0, 0), (-.0499, 0, 0), (0, .0499, 0), (0, 0, .4999)])
def test_rejected_simulation_input_cannot_create_neutral(h, velocity):
    owner, _, _ = h.connect()
    h.take(owner)
    h.unlock(owner)
    ack = h.cmd(owner, *velocity)
    assert ack['applied'] == list(Z) and ack['reason'] and ack['clipped']
    assert h.hub.session.core.need_neutral
    assert h.cmd(owner, .2)['applied'] == list(Z)
    h.cmd(owner, 0)
    assert h.cmd(owner, .2)['applied'] == [.2, 0, 0]


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
