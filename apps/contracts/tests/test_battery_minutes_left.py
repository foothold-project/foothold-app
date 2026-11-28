"""배터리 남은 분 (11/28): 정수 분 · 모르면 null. 옛 에이전트 · 옛 클라이언트는 그대로 통과."""
import json
from pathlib import Path

import pytest

from apps.contracts.models import AgentBattery, AgentState, Battery

SCHEMAS = Path(__file__).resolve().parents[1] / 'schema'
AT = '2026-11-28T00:00:00Z'


def legacy_state(battery):
    return dict(t='state', pose=dict(floor_id=None, x=None, y=None, yaw=None, confidence=None),
                speed=None, battery=battery, latched=True, stop_gen=0, stop_ref=0, applied=[0, 0, 0], mode='FREE')


def test_schema_adds_minutes_left_as_optional_everywhere():
    for name in ('RobotSummary', 'ScreenState', 'PhoneRelayState'):
        battery = json.loads((SCHEMAS / f'{name}.json').read_text())['$defs']['Battery']
        assert 'minutes_left' in battery['properties'] and 'minutes_left' not in battery['required']
        assert battery['required'] == ['soc', 'updated_at']  # 옛 클라이언트가 요구하던 칸 그대로
    agent = json.loads((SCHEMAS / 'AgentState.json').read_text())['$defs']['AgentBattery']
    assert 'minutes_left' in agent['properties'] and agent['required'] == ['soc']


def test_old_agent_without_minutes_left_still_validates_and_reads_null():
    state = AgentState(**legacy_state({'soc': 50}))
    assert state.battery.minutes_left is None
    assert Battery(soc=50, updated_at=AT).model_dump(mode='json') == {'soc': 50, 'updated_at': AT, 'minutes_left': None}


@pytest.mark.parametrize('value', [0, 41, 1440])
def test_integer_minutes_survive(value):
    assert AgentBattery(soc=50, minutes_left=value).minutes_left == value
    assert Battery(soc=50, updated_at=AT, minutes_left=value).minutes_left == value


@pytest.mark.parametrize('value', [-1, 1441, 1.5, 41.0, True, '41', float('nan'), [], {}])
def test_bad_display_value_is_null_and_does_not_drop_the_state(value):
    state = AgentState(**legacy_state({'soc': 50, 'minutes_left': value}))
    assert state.battery.soc == 50 and state.battery.minutes_left is None
