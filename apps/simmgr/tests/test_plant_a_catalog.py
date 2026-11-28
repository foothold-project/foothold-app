"""Connected multi-floor worlds are listed once with their spawn floors."""
from pathlib import Path
from uuid import uuid4

from fastapi.testclient import TestClient

from apps.simmgr.api import create_app
from apps.simmgr.config import Settings, Slot, World
from apps.simmgr.launcher import FakeLauncher


def catalog(keys):
    org = str(uuid4())
    slot = Slot(str(uuid4()), org, '/private/key', '/private/replay-0', 9433)
    worlds = {k: World(k, Path('/private/w.sdf'), Path('/private/w.yaml'), 'W', 'd') for k in keys}
    cfg = Settings(worlds, {slot.robot_id: slot}, 'x' * 32)
    with TestClient(create_app(cfg, FakeLauncher()), client=('127.0.0.1', 9438)) as client:
        response = client.get('/v1/worlds', params={'org_id': org},
                              headers={'Authorization': 'Bearer ' + cfg.secret})
        assert response.status_code == 200, response.text
        return response.json()['worlds']


def test_plant_a_is_listed_as_one_world_with_three_spawn_floors():
    items = catalog(['plant_a/l1', 'plant_a/l2', 'plant_a/l3', 'warehouse/f1', 'v5_building/l1', 'v5_building/l2'])
    by_id = {i['id']: i for i in items}
    assert sorted(by_id) == ['plant_a', 'v5_building', 'warehouse/f1']
    assert by_id['plant_a']['spawn_floor_ids'] == ['l1', 'l2', 'l3']
    assert by_id['v5_building']['spawn_floor_ids'] == ['l1', 'l2']
    assert by_id['v5_building']['name'] == '연결 건물'
    assert by_id['warehouse/f1']['spawn_floor_ids'] == []


def test_partial_plant_a_lists_only_present_floors():
    items = catalog(['plant_a/l3', 'plant_a/l1'])
    assert [(i['id'], i['spawn_floor_ids']) for i in items] == [('plant_a', ['l1', 'l3'])]
