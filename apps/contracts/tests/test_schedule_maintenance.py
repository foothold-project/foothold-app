"""정비 칸 · 칸 표시 이름 · 장비 등급 (11/28 15:04): 더한 값은 모두 선택 칸, 옛 클라이언트 required 그대로."""
import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from apps.contracts.models import RobotAvailability, RobotPatch, RobotSummary, ScheduleSlotCreate, ScheduleSlotPatch

SCHEMAS = Path(__file__).resolve().parents[1] / 'schema'
RID = '00000000-0000-0000-0000-000000000001'
SID = '00000000-0000-0000-0000-000000000002'
SPAN = dict(start='2026-12-01T01:00:00Z', end='2026-12-01T02:00:00Z')


def schema(name):
    return json.loads((SCHEMAS / f'{name}.json').read_text())


def test_maintenance_slot_needs_no_scenario_like_battery_swap_and_carries_a_label():
    slot = ScheduleSlotCreate(robot_id=RID, kind='MAINTENANCE', busy_label='정기 점검 · 다리 관절', **SPAN)
    assert slot.scenario_id is None and slot.busy_label == '정기 점검 · 다리 관절'
    assert ScheduleSlotCreate(robot_id=RID, kind='BATTERY_SWAP', **SPAN).busy_label is None
    with pytest.raises(ValidationError):
        ScheduleSlotCreate(robot_id=RID, kind='CONFIRMED', **SPAN)
    for bad in ('', 'x' * 65):
        with pytest.raises(ValidationError):
            ScheduleSlotCreate(robot_id=RID, kind='MAINTENANCE', busy_label=bad, **SPAN)
    assert ScheduleSlotPatch(busy_label='점검').busy_label == '점검'
    assert ScheduleSlotPatch(busy_label=None).model_dump(exclude_unset=True) == {'busy_label': None}  # null = 지움


def test_availability_state_has_maintenance():
    item = RobotAvailability(robot_id=RID, robot_name='r', state='MAINTENANCE', busy_until=SPAN['end'], busy_slot_id=SID,
                             busy_label='정기 점검', battery_pct=None, demo=False, sim=False, location_label=None)
    assert item.state == 'MAINTENANCE'
    enum = schema('RobotAvailabilityList')['$defs']['RobotAvailability']['properties']['state']['enum']
    assert enum == ['FREE', 'BUSY', 'CHARGING', 'OFFLINE', 'MAINTENANCE']  # 새 값은 뒤에만 붙는다


def test_schema_additions_are_optional_for_old_clients():
    slot = schema('ScheduleSlot')
    assert 'MAINTENANCE' in slot['properties']['kind']['enum'] and 'busy_label' not in slot['required']
    summary = schema('RobotSummary')
    assert 'equipment_tier' in summary['properties'] and 'equipment_tier' not in summary['required']
    assert schema('ScheduleSlotCreate')['required'] == ['robot_id', 'start', 'end', 'kind']


def test_equipment_tier_default_null_and_values():
    patch = RobotPatch(equipment_tier='UPPER')
    assert patch.model_dump(exclude_unset=True) == {'equipment_tier': 'UPPER'}
    assert RobotPatch(equipment_tier=None).model_dump(exclude_unset=True) == {'equipment_tier': None}
    assert RobotPatch().model_dump(exclude_unset=True) == {}
    with pytest.raises(ValidationError):
        RobotPatch(equipment_tier='PREMIUM')
    tiers = summary_tier_enum()
    assert tiers == ['STANDARD', 'UPPER']


def summary_tier_enum():
    prop = schema('RobotSummary')['properties']['equipment_tier']
    return next(s['enum'] for s in prop['anyOf'] if 'enum' in s)


def test_old_summary_without_tier_reads_null():
    fields = RobotSummary.model_fields
    assert fields['equipment_tier'].default is None
