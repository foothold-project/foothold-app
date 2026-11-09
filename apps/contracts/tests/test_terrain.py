import copy
import math
import pytest
from pydantic import ValidationError
from apps.contracts.models import TerrainSpec, TerrainWrite

SPEC = {'schema': 'fh_custom_terrain/1', 'id': 't-test', 'name': '합성 지형', 'size': [8, 6],
        'spawn': [-3, 0, 0], 'items': [{'kind': 'box', 'x': 1, 'y': 0, 'yaw': .5, 'sx': 1, 'sy': 1, 'h': .2}]}


def test_terrain_browser_wire_roundtrip():
    assert TerrainSpec.model_validate(SPEC).model_dump(mode='json', by_alias=True) == SPEC
    assert TerrainWrite(spec=SPEC, base_version=0).base_version == 0


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
