"""Run the shipped phone transform in Node, then exercise the real Hub/Session."""
import json
from pathlib import Path
import re
import subprocess

import pytest

from apps.contracts.models import PhoneLimits
from test_phone import h
from foothold_agent.safety.core import Z


@pytest.fixture(scope='module')
def phone_transform():
    source = (Path(__file__).resolve().parents[2] / 'web/src/phone.ts').read_text()
    constants = '\n'.join(re.findall(
        r'export const (?:DEAD|AXIS_LOCK|TURN_ON|NUDGE) = [^;]+;', source))
    # Use the actual functions, removing only their TS type annotations/exports.
    functions = source[source.index('export function velocity('):source.index('/** 50 ms')]
    functions = functions.replace(': Axes', '').replace(': PhoneWelcome | null', '')
    functions = functions.replace(': PhoneWelcome', '').replace(': number', '')
    script = (constants + '\n' + functions).replace('export ', '')

    def transform(welcome, axes):
        program = script + '\nconsole.log(JSON.stringify(velocity(' + json.dumps(axes)
        program += ', ' + json.dumps(welcome) + ')));'
        return json.loads(subprocess.check_output(['node', '-e', program], text=True))
    return transform


@pytest.mark.parametrize('pressed', [[.05, 0, 0], [0, .1, 0], [0, 0, .05],
                                    [-.05, 0, 0], [0, -.1, 0], [0, 0, -.05]])
def test_actual_phone_pressed_input_cannot_clear_deadman_neutral(h, phone_transform, pressed):
    owner, _, welcome = h.connect()
    assert h.take(owner)['ok']
    h.unlock(owner)
    h.cmd(owner, **phone_transform(welcome, [0, 0, 0]))
    assert h.cmd(owner, **phone_transform(welcome, [.5, 0, 0]))['applied'][0] > 0
    h.clock.t = .30001
    h.hub.tick()
    assert h.outputs[-1].velocity == Z and h.hub.session.core.need_neutral

    velocity = phone_transform(welcome, pressed)
    ack = h.cmd(owner, **velocity)
    assert h.hub.session.core.need_neutral  # catch the bypass in the actual Core
    assert ack['applied'] == list(Z) and ack['reason'] and not ack['clipped']
    assert tuple(velocity.values()) != Z  # pressed survives the phone boundary
    assert h.cmd(owner, **phone_transform(welcome, [.5, 0, 0]))['applied'] == list(Z)
    assert h.hub.session.core.need_neutral

    # Only a real release permits a later forward command.
    assert phone_transform(welcome, [0, 0, 0]) == dict(vx=0, vy=0, wz=0)
    h.cmd(owner, **phone_transform(welcome, [0, 0, 0]))
    assert not h.hub.session.core.need_neutral
    assert h.cmd(owner, **phone_transform(welcome, [.5, 0, 0]))['applied'][0] > 0


def test_legacy_input_envelope_and_additive_policy_range(h):
    limits = h.connect()[2]['limits']
    legacy = dict(vx_mode='continuous', vx_min_moving=.2, vx_min=-.3, vx_max=1.,
                  vy_min=-.3, vy_max=.3, wz_min=-.5, wz_max=.5, commands=[],
                  experimental=['reverse', 'lateral', 'turn_in_place'])
    assert {key: limits[key] for key in legacy} == legacy
    parsed = PhoneLimits.model_validate(limits)
    assert parsed.policy_velocity_range is None  # no claim that experiments were trained
    assert parsed.requires_forward_motion is False
    assert parsed.policy_adapter_id == 'simulation-experimental-si/1'
    # Older payloads still parse; new facts are optional.
    assert PhoneLimits.model_validate(legacy).policy_velocity_range is None
