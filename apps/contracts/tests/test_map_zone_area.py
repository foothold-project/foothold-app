"""AREA zones: a named place only. No movement rule, so no speed value (app-design-lx 11/28 14:14)."""
import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from apps.contracts import models as C

SQUARE = [(0.0, 0.0), (2.0, 0.0), (2.0, 2.0), (0.0, 2.0)]


def test_area_zone_is_a_named_polygon():
    zone = C.MapZone(id='z-area', type='AREA', name='제어실 앞 주도로', polygon=SQUARE)
    assert zone.model_dump(mode='json') == {'id': 'z-area', 'type': 'AREA', 'name': '제어실 앞 주도로',
                                            'polygon': [[0.0, 0.0], [2.0, 0.0], [2.0, 2.0], [0.0, 2.0]]}


def test_area_zone_refuses_a_speed_value():
    with pytest.raises(ValidationError):
        C.MapZone(id='z-area', type='AREA', name='구역', polygon=SQUARE, max_speed_mps=1.0)


def test_area_zone_schema_forbids_speed_too():
    schema = json.loads((Path(__file__).resolve().parents[1] / 'schema/MapZone.json').read_text())
    assert 'AREA' in schema['properties']['type']['enum']
    rules = schema['allOf'] if 'allOf' in schema else [schema]
    banned = {rule['if']['properties']['type']['const'] for rule in rules if 'if' in rule}
    assert {'NO_GO', 'AREA'} <= banned


def test_slow_and_no_go_rules_unchanged():
    assert C.MapZone(id='s', type='SLOW', name='감속', polygon=SQUARE, max_speed_mps=0.5).max_speed_mps == 0.5
    with pytest.raises(ValidationError):
        C.MapZone(id='n', type='NO_GO', name='금지', polygon=SQUARE, max_speed_mps=0.5)
