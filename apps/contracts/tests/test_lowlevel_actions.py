"""저수준 (START · AME-2) 에서 켜는 동작 목록이 동작표 「저수준」 열과 같은지 (팀장 11/26 08:01)."""
import json
import re
from pathlib import Path
from typing import get_args
import pytest
from apps.contracts import models as C

LOWLEVEL = set(get_args(C.LowlevelAction))
# 동작표 action-table-1126 1 절에서 「저수준」 열이 「켬」 인 줄의 SDK 이름 + Greet (SDK 번호 없음 · 팀장 11/26 10:17)
TABLE_ON = {'Sit', 'RiseSit', 'StandDown', 'Stretch', 'Hello', 'Heart', 'Damp', 'Greet'}
TABLE = Path('/home/jay/data/overnight-1122/briefs/action-table-1126.md')


def test_list_matches_table_and_is_closed_action_subset():
    assert LOWLEVEL == TABLE_ON
    assert LOWLEVEL <= set(get_args(C.Go2ActionName))
    # 회색 줄: 넘어진 뒤 서기 (자동) · 발 긁기 · 뒤집기 · 두 발 걷기 · 물구나무 · 교차 걸음
    assert not LOWLEVEL & {'RecoveryStand', 'Scrape', 'FrontFlip', 'BackFlip', 'LeftFlip',
                           'WalkUpright', 'HandStand', 'CrossStep', 'StandUp'}


def test_generated_schema_is_the_same_list():
    schema = json.loads((Path(C.__file__).parent / 'schema' / 'LowlevelAction.json').read_text())
    assert set(schema['enum']) == LOWLEVEL
    off = json.loads((Path(C.__file__).parent / 'schema' / 'FactoryUnsupportedAction.json').read_text())
    assert off.get('enum', [off.get('const')]) == ['Greet'] and 'Greet' in LOWLEVEL   # 값 하나는 const
    query = json.loads((Path(C.__file__).parent / 'schema' / 'LowlevelQuery.json').read_text())
    assert query['enum'] == ['CheckMode', 'AutoRecoveryGet'] and not set(query['enum']) & LOWLEVEL
    control = json.loads((Path(C.__file__).parent / 'schema' / 'ControlMode.json').read_text())
    assert control['enum'] == ['FACTORY', 'LOWLEVEL']


@pytest.mark.skipif(not TABLE.is_file(), reason='동작표 원본은 이 기기에만 있음')
def test_list_matches_table_file():
    names = set(get_args(C.Go2ActionName))
    on, unnamed = set(), []
    for line in TABLE.read_text(encoding='utf-8').splitlines():
        cells = [c.strip() for c in line.strip().strip('|').split('|')]
        if len(cells) != 9 or cells[-1] != '켬':
            continue
        sdk = re.findall(r'[A-Za-z]+', cells[6])
        hit = [w for w in sdk if w in names]
        (on.update(hit) if hit else unnamed.append(cells[0]))
    # SDK 번호가 없는 켬 줄은 인사 하나 = Greet (순정에서 안 됨)
    assert unnamed == ['Greet (인사)']
    assert on | {'Greet'} == LOWLEVEL and set(get_args(C.FactoryUnsupportedAction)) == {'Greet'}


def test_state_carries_optional_control():
    assert 'control' in C.ScreenState.model_fields and 'control' in C.AgentState.model_fields
    schema = json.loads((Path(C.__file__).parent / 'schema' / 'ScreenState.json').read_text())
    assert 'control' not in schema.get('required', [])


def test_agent_mirror_matches_contract():
    from apps.agent.foothold_agent.go2_direct import actions
    assert set(actions.LOWLEVEL) == LOWLEVEL and LOWLEVEL <= actions.ACTIONS
    assert actions.NO_FACTORY == set(get_args(C.FactoryUnsupportedAction)) and actions.LOWLEVEL['Greet'] == 'L1+A'
    assert actions.LOWLEVEL_QUERY == set(get_args(C.LowlevelQuery))
