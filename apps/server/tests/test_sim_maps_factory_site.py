"""공장 터 (factory_site/f1): 서버 정적 월드 읽기 (지도판 · 프리셋 시나리오). DB 없이 load_worlds 만."""
from pathlib import Path

from apps.contracts import models as C
from apps.server.fh_server.sim_maps import check_clearance, load_worlds, supported_world_ids

SOURCE = Path(__file__).resolve().parents[2] / 'simmgr/worlds'


def factory_site():
    rows = [row for row in load_worlds(SOURCE) if row[0]['world_id'] == 'factory_site']
    assert len(rows) == 1
    return rows[0]


def test_factory_site_map_plate_reads_with_simulation_thresholds():
    entry, metadata, png, width, height, _ = factory_site()
    assert (entry['floor_id'], entry['floor_z'], width, height) == ('f1', 0.0, 1800, 1120)
    assert metadata['resolution'] == .5 and metadata['origin'] == [0.0, -560.0, 0.0]
    # 서버 run.start 지도 묶음 (계약 SIM_WORLD_FLOORS 에 factory_site 를 넣음, app-lx 11/28 14:25)
    assert metadata['connected_gt']['world_id'] == 'factory_site' and metadata['connected_gt']['ros_floor_id'] == 'f1'
    assert 'factory_site' in supported_world_ids()
    x, y, _ = entry['spawn_xyyaw']
    check_clearance(png, metadata, [{'waypoints': [{'x': x, 'y': y}]}])


def test_factory_site_presets_pass_clearance_and_server_contract():
    entry, metadata, png, _, _, presets = factory_site()
    ids = [p['id'] for p in presets]
    assert ids[:5] == ['patrol-a', 'gas-check', 'gauge-read', 'valve-3f', 'new-k08']
    assert 'battery-swap' in ids and [i for i in ids if i.startswith('charge-wait-')] == [f'charge-wait-{n}' for n in range(1, 8)]
    check_clearance(png, metadata, presets)  # load_worlds 도 같은 검사를 했음 (0.5 m)
    start = entry['spawn_xyyaw'][:2]
    for preset in presets:
        finish = C.ScenarioFinish(mode=preset['finish'])
        assert finish.mode == 'STAY'
        for point in preset['waypoints']:
            assert point['mission_name'].startswith(('factory_site-' + preset['id'] + '-p', 'factory_site-' + preset['id'] + '-v'))
            assert point['kind'] in ('design', 'via', 'return', 'place')
        if not preset['id'].startswith('charge-wait-'):
            last = preset['waypoints'][-1]
            assert [last['x'], last['y']] == start and last['kind'] == 'return' and '복귀' in last['mission_name']
    names = {p['id']: p['name'] for p in presets}
    assert names['patrol-a'] == '공정 순찰 A · 14:00' and names['patrol-b'].endswith('· 제안')
