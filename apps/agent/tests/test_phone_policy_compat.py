"""Run the shipped phone transform in Node, then exercise the real Hub/Session."""
import json
from pathlib import Path
import re
import subprocess

import pytest

from apps.contracts.models import PhoneLimits
from test_phone import h, physical_h
from foothold_agent.safety.core import Z


@pytest.fixture(scope='module')
def phone_transform():
    source = (Path(__file__).resolve().parents[2] / 'web/src/phone.ts').read_text()
    constants = '\n'.join(re.findall(
        r'export const (?:DEAD|AXIS_LOCK|TURN_ON|NUDGE) = [^;]+;', source))
    # Include velocity's tuning dependencies; keep the shipped default state and
    # validation instead of stubbing tuned() or copying the velocity formula.
    functions = source[source.index('const TUNE ='):source.index('/** 50 ms')]
    functions = re.sub(r'^export type Axes = [^;]+;\n', '', functions, flags=re.MULTILINE)
    # Remove only TS annotations/assertions from the extracted source.
    for annotation in (': Partial<Record<keyof typeof TUNE, number>>',
                       ': Partial<OrgSettings> | null', ': typeof tune', ': unknown',
                       ': Axes', ': PhoneWelcome | null', ': PhoneWelcome', ': number',
                       ' as const', ' as (keyof typeof TUNE)[]'):
        functions = functions.replace(annotation, '')
    script = (constants + '\n' + functions).replace('export ', '')

    def transform(welcome, axes, settings=None):
        program = script + '\nsimTune(' + json.dumps(settings) + ');'
        program += '\nconsole.log(JSON.stringify(velocity(' + json.dumps(axes)
        program += ', ' + json.dumps(welcome) + ')));'
        return json.loads(subprocess.check_output(['node', '-e', program], text=True))
    return transform


def test_actual_phone_transform_uses_validated_sim_tuning(h, phone_transform):
    welcome = h.connect()[2]
    axes = [1, 1, 0]
    assert phone_transform(welcome, axes) == dict(vx=1.5, vy=0, wz=.5)
    assert phone_transform(welcome, axes, dict(sim_max_vx=.4, sim_max_wz=.2)) == dict(vx=.4, vy=0, wz=.2)
    # Invalid settings fall back to the agent limits, as in the shipped simTune.
    assert phone_transform(welcome, axes, dict(sim_max_vx=-1, sim_max_wz=1)) == dict(vx=1.5, vy=0, wz=.5)
    assert phone_transform(welcome, axes) == dict(vx=1.5, vy=0, wz=.5)


@pytest.mark.parametrize('axes,expected', [([0, 0, 0], dict(vx=0, vy=0, wz=0)),
    ([1, 1, 1], dict(vx=1.5, vy=0, wz=.5)),
    ([-1, -1, -1], dict(vx=0, vy=0, wz=0)),
    ([.5, -1, 1], dict(vx=.75, vy=0, wz=-.5))])
def test_actual_phone_physical_velocity_ignores_sim_tuning(physical_h, phone_transform, axes, expected):
    welcome = physical_h.connect()[2]
    settings = dict(sim_max_vx=.2, sim_min_vx=.1, sim_max_vy=0, sim_max_wz=0,
                    sim_key_vx=.1, stick_deadzone=.5)
    assert phone_transform(welcome, axes) == expected
    assert phone_transform(welcome, axes, settings) == expected


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
    assert {key: limits[key] for key in legacy} == {**legacy, 'vx_max': 1.5}
    parsed = PhoneLimits.model_validate(limits)
    assert parsed.policy_velocity_range is None  # no claim that experiments were trained
    assert parsed.requires_forward_motion is False
    assert parsed.policy_adapter_id == 'simulation-experimental-si/1'
    # Older payloads still parse; new facts are optional.
    assert PhoneLimits.model_validate(legacy).policy_velocity_range is None
