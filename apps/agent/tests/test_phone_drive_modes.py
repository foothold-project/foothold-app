"""Physical phone forward steps; unapproved movement modes stay closed."""
import math

import pytest

from foothold_agent.phone.protocol import LIMITS, project_velocity
from foothold_agent.safety.core import Z, quantize_phone


@pytest.mark.parametrize('vx,forward', [(-.2, 0), (-.000001, 0), (0, 0), (.2, 0),
    (.3, .3), (.4, .4), (.6, .6), (.75, .7), (.9, .9),
    (math.nextafter(1.5, 0), 1.4), (1.5, 1.5), (1.51, 1.5), (8, 1.5)])
@pytest.mark.parametrize('wz', [-8, -.5, math.nextafter(-.5, 0), 0,
                                math.nextafter(.5, 0), .5, 8])
def test_projection_only_emits_reviewed_phone_commands(vx, forward, wz):
    axes, clipped = project_velocity(vx, 0, wz)
    applied, reason = quantize_phone(*axes)
    turn = (.5 if wz >= .5 else -.5 if wz <= -.5 else 0) if vx >= .75 else 0
    expected = (forward, 0, turn)
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
    applied, reason = quantize_phone(*axes)
    assert applied == Z and reason and clipped
