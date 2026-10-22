"""Unverified modes stay closed, including their exact projection boundaries."""
import math

import pytest

from foothold_agent.phone.protocol import LIMITS, project_velocity
from foothold_agent.safety.core import Z, quantize


@pytest.mark.parametrize('vx', [-.2, -.000001, 0, .2, .4, math.nextafter(.6, 0), .6, 8])
@pytest.mark.parametrize('wz', [-8, -.5, math.nextafter(-.5, 0), 0,
                                math.nextafter(.5, 0), .5, 8])
def test_projection_only_emits_existing_verified_commands(vx, wz):
    axes, clipped = project_velocity(vx, 0, wz)
    applied, reason = quantize(*axes)
    expected = (.6, 0, .5 if wz >= .5 else -.5 if wz <= -.5 else 0) if vx >= .6 else Z
    assert applied == expected
    assert list(applied) in LIMITS['commands']
    assert clipped == (expected != (vx, 0, wz))
    # Rejected movement must not become a confirmed neutral in Core.cmd.
    if expected == Z and (vx or wz):
        assert reason
    if not vx and not wz:
        assert not reason


@pytest.mark.parametrize('vy', [-1, 1])
def test_lateral_projection_is_rejected_without_confirming_neutral(vy):
    axes, clipped = project_velocity(0, vy, 0)
    applied, reason = quantize(*axes)
    assert applied == Z and reason and clipped
