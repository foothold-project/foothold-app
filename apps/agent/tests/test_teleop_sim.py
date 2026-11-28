"""시뮬 손 조종: 후진 · 옆 · 돌기를 조직 설정 상한까지 받는다 (팀장 11/28 23:08 「다 연다」).

정책이 못 배운 방향 (AME-2 후진 등) 은 정책이 못 하는 것이지 에이전트가 0 으로 자를 일이 아니다.
실기 LIMITS 는 실기 안전에 걸려 그대로 둔다.
"""
import pytest

from test_phone import h, physical_h
from apps.contracts import teleop
from apps.contracts.models import OrgSettings
from foothold_agent.phone import protocol
from foothold_agent.phone.protocol import LIMITS, SIMULATION_LIMITS, simulation_velocity
from foothold_agent.safety.core import Z

CAPS = teleop.teleop_caps(OrgSettings().model_dump(), simulation=True)
FULL = [(-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1), (-1, 1, -1), (1, -1, 1), (-.5, .5, .5)]


def test_simulation_envelope_is_the_org_settings_ceiling():
    c = teleop.SIM_CEILING
    assert (SIMULATION_LIMITS['vx_min'], SIMULATION_LIMITS['vx_max']) == (-c['max_vx_back'], c['max_vx'])
    assert (SIMULATION_LIMITS['vy_min'], SIMULATION_LIMITS['vy_max']) == (-c['max_vy'], c['max_vy'])
    assert (SIMULATION_LIMITS['wz_min'], SIMULATION_LIMITS['wz_max']) == (-c['max_wz'], c['max_wz'])


@pytest.mark.parametrize('stick', FULL)
def test_full_stick_back_side_turn_reach_the_simulated_robot(h, stick):
    velocity = teleop.stick_velocity(stick, CAPS, teleop.DEFAULT_DEADZONE)
    assert any(velocity)
    assert simulation_velocity(*velocity) == (velocity, '')
    owner, _ = h.moving()
    ack = h.cmd(owner, *velocity)
    assert ack['applied'] == list(velocity) and not ack['clipped']
    assert h.outputs[-1].velocity == velocity


@pytest.mark.parametrize('stick', FULL)
def test_experimental_mark_does_not_gate_input(monkeypatch, stick):
    velocity = teleop.stick_velocity(stick, CAPS, teleop.DEFAULT_DEADZONE)
    monkeypatch.setitem(protocol.SIMULATION_LIMITS, 'experimental', [])
    assert simulation_velocity(*velocity) == (velocity, '')


def test_beyond_ceiling_is_still_rejected_whole():
    for v in [(-1.500001, 0, 0), (1.500001, 0, 0), (0, .500001, 0), (0, 0, -1.200001)]:
        assert simulation_velocity(*v) == (Z, 'UNSUPPORTED_VELOCITY')


@pytest.mark.parametrize('stick', [(-1, 0, 0), (0, 1, 0), (0, -1, 0)])
def test_physical_phone_limits_unchanged(physical_h, stick):
    velocity = teleop.stick_velocity(stick, CAPS, teleop.DEFAULT_DEADZONE)
    owner, _ = physical_h.moving()
    ack = physical_h.cmd(owner, *velocity)
    assert ack['applied'] == list(Z) and ack['clipped']
    assert (LIMITS['vx_min'], LIMITS['vy_min'], LIMITS['vy_max']) == (0, 0, 0)
