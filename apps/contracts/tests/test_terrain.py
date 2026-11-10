import copy
from datetime import datetime, timezone
import math
from uuid import uuid4
import pytest
from pydantic import ValidationError
from apps.contracts.models import MapDiff, MapVersion, MapVersionList, TerrainSpec, TerrainWrite

SPEC = {'schema': 'fh_custom_terrain/1', 'id': 't-test', 'name': '합성 지형', 'size': [8, 6],
        'spawn': [-3, 0, 0], 'items': [{'kind': 'box', 'x': 1, 'y': 0, 'yaw': .5, 'sx': 1, 'sy': 1, 'h': .2}]}


def test_terrain_browser_wire_roundtrip():
    assert TerrainSpec.model_validate(SPEC).model_dump(mode='json', by_alias=True) == SPEC
    assert TerrainWrite(spec=SPEC, base_version=0).base_version == 0


def test_map_terrain_is_optional_and_nested_wire_alias_is_preserved():
    payload = dict(upload_id=uuid4(), id=uuid4(), floor_id=uuid4(), number=1,
        base_version_id=None, status='APPROVED', image_sha256='0' * 64,
        width=160, height=120, resolution=.05, origin=(-4, -3, 0),
        features={'zones': [], 'waypoints': [], 'connectors': [], 'edits': []},
        reason='합성 지도', source='IMPORT', created_by=uuid4(), created_at=datetime.now(timezone.utc))
    for terrain_spec in (None, SPEC):
        version = MapVersion(**payload, terrain_spec=terrain_spec)
        wire = version.model_dump(mode='json')
        if terrain_spec is None:
            assert 'terrain_spec' not in wire
        else:
            assert wire['terrain_spec'] == SPEC
        assert MapVersion.model_validate(wire) == version
        assert MapVersionList(items=[version], next_cursor=None).model_dump(mode='json')['items'] == [wire]
        assert MapDiff(version=version, against=None, image_changed=False, changes=[]).model_dump(mode='json')['version'] == wire
    assert 'terrain_spec' not in MapVersion(**payload).model_dump(mode='json')
    schema = MapVersion.model_json_schema(mode='serialization')
    assert 'terrain_spec' in schema['properties'] and 'terrain_spec' not in schema['required']
    with pytest.raises(ValidationError):
        MapVersion(**payload, terrain_spec={**SPEC, 'items': SPEC['items'] * 61})


@pytest.mark.parametrize('path,value', [
    (('schema',), 'old'), (('id',), '../bad'), (('name',), ' '), (('name',), 'x\x00'),
    (('size',), [3, 12]), (('size',), [12, 31]), (('size',), [True, 12]),
    (('spawn',), [0, 0, math.inf]), (('spawn',), [-4, 0, 0]), (('spawn',), [1, 0, 0]),
    (('items',), [SPEC['items'][0]] * 61), (('items', 0, 'x'), math.nan),
    (('items', 0, 'yaw'), '0'), (('items', 0, 'sx'), -1),
    (('items', 0, 'h'), 1.01), (('items', 0, 'x'), 4),
])
def test_terrain_rejects_invalid_numeric_shape_and_geometry(path, value):
    data = copy.deepcopy(SPEC)
    cursor = data
    for key in path[:-1]:
        cursor = cursor[key]
    cursor[path[-1]] = value
    with pytest.raises(ValidationError):
        TerrainSpec.model_validate(data)


@pytest.mark.parametrize('item', [
    {'kind': 'stairs', 'width': 1, 'steps': 3.5, 'rise': .1, 'run': .3},
    {'kind': 'stairs', 'width': 1, 'steps': 5, 'rise': .25, 'run': .3},
    {'kind': 'stairs', 'width': 1, 'steps': 3, 'rise': .01, 'run': .3},
    {'kind': 'stairs', 'width': 1, 'steps': 3, 'rise': .1, 'run': .1},
    {'kind': 'ramp', 'width': 1, 'length': 1, 'h': .6},
    {'kind': 'gap', 'width': 1, 'length': 0},
])
def test_terrain_item_limits(item):
    with pytest.raises(ValidationError):
        TerrainSpec.model_validate({**SPEC, 'items': [{'x': 1, 'y': 0, 'yaw': 0, **item}]})
