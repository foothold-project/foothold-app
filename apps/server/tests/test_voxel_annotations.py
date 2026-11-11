"""Local synthetic annotation/twin snapshots; no physical or browser runtime."""
import copy
from uuid import UUID, uuid4

import pytest
from sqlalchemy.orm import Session, sessionmaker

from apps.contracts import models as C
from apps.server.fh_server.models import Floor, MapVersion, Robot, Run, Upload
from apps.server.fh_server.runs import fixed_scenario, record
from apps.server.fh_server.voxel_maps import simulation_twin
from .test_maps import maps, save, tree, upload, P  # noqa: F401
from .test_terrains import put
from .test_voxel_maps import post, scenario_for, fail, Rejected


FEATURES = dict(zones=[
    dict(id='keep-out', name='금지', type='NO_GO', polygon=[[1., 1.], [2., 1.], [2., 2.], [1., 2.]]),
    dict(id='slow', name='감속', type='SLOW', polygon=[[-2., -1.], [0., -1.], [0., 1.], [-2., 1.]])],
    waypoints=[dict(id='dock', name='출발', x=-1., y=0., yaw=.25)], connectors=[], edits=[])


def edit(http, headers, original, *, base=None, features=None):
    response = save(http, headers, original['floor_id'], original['upload_id'],
        base=base or original['id'], features=features or copy.deepcopy(FEATURES))
    assert response.status_code == 201, response.text
    return response.json()


def sim_robot(db, seeded, result):
    robot = db.get(Robot, seeded['robots']['mine'])
    robot.simulation = True
    robot.sim_world_id = 'custom/' + result['terrain']['spec']['id']
    return robot


def test_annotations_pin_new_twin_features_proof_and_run_without_changing_history(maps, seeded):
    http, headers, _ = maps
    result = post(http, headers).json()
    original = result['map']
    old_scenario = scenario_for(http, headers, original['floor_id'], original['id'])
    # Read the fixed old plan before any annotation change. New starts on that
    # old map are rejected later, while this historical proof remains unchanged.
    factory = sessionmaker(http.app.state.engine, expire_on_commit=False)
    with factory.begin() as db:
        sim_robot(db, seeded, result)
    with factory() as db:
        _, old_plan = fixed_scenario(db, db.get(Robot, seeded['robots']['mine']), UUID(old_scenario['id']), 1, fail)

    old_image = http.get(P + '/map-versions/' + original['id'] + '/image', headers=headers).content
    # Connectors are copied too, without a coordinate transform or invented pairing.
    # Connectors must belong to the same building; use the source's building.
    with Session(http.app.state.engine) as db:
        building = db.get(Floor, UUID(original['floor_id'])).building_id
    other = http.post(P + f'/buildings/{building}/floors', headers=headers,
        json={'name': '2층', 'level': 2}).json()
    features = copy.deepcopy(FEATURES)
    features['connectors'] = [dict(id='stairs', kind='STAIRS', pair_floor_id=other['id'], x=-2., y=0., yaw=0.)]
    edited = edit(http, headers, original, features=features)
    assert edited['id'] != original['id'] and edited['floor_id'] == original['floor_id']
    assert edited['upload_id'] == original['upload_id']
    assert edited['voxel_map'] == {**original['voxel_map'], 'map_version_id': edited['id']}
    assert edited['image_sha256'] == original['image_sha256']
    assert http.get(P + '/map-versions/' + edited['id'] + '/image', headers=headers).content == old_image
    page = http.get(P + '/map-versions/' + edited['id'] + '/voxels?limit=1', headers=headers).json()
    assert page['summary'] == edited['voxel_map']
    current = http.get(P + '/terrains/' + result['terrain']['spec']['id'], headers=headers).json()
    assert current['version'] == result['terrain']['version']  # terrain itself was not saved
    twin = http.get(P + '/map-versions/' + current['map_version_id'], headers=headers).json()
    assert twin['features'] == edited['features'] and twin['provenance'] == 'SIMULATION'
    assert twin['terrain_spec'] == result['terrain']['spec']
    assert http.get(P + '/map-versions/' + result['terrain']['map_version_id'], headers=headers).json()['features']['zones'] == []
    assert http.get(P + '/map-versions/' + original['id'], headers=headers).json()['features']['zones'] == []
    new_scenario = scenario_for(http, headers, edited['floor_id'], edited['id'])
    factory = sessionmaker(http.app.state.engine, expire_on_commit=False)
    with factory.begin() as db:
        sim_robot(db, seeded, result)
    with factory() as db:
        robot = db.get(Robot, seeded['robots']['mine'])
        with pytest.raises(Rejected) as stale:
            fixed_scenario(db, robot, UUID(old_scenario['id']), 1, fail)
        assert stale.value.args[1] == 'MAP_UPDATE_REQUIRED'
        _, plan = fixed_scenario(db, robot, UUID(new_scenario['id']), 1, fail)
        assert old_plan.map_proofs[0].map_version_id == UUID(result['terrain']['map_version_id'])
        assert plan.waypoints[0].map_version_id == UUID(twin['id'])
        assert db.get(MapVersion, plan.waypoints[0].map_version_id).features == edited['features']
        assert plan.map_proofs[0].source_pgm_sha256 == old_plan.map_proofs[0].source_pgm_sha256
        assert plan.map_proofs[0].image_sha256 == old_plan.map_proofs[0].image_sha256
        # An explicit old UUID cannot be silently replaced by the new annotations.
        with pytest.raises(Rejected):
            fixed_scenario(db, robot, UUID(new_scenario['id']), 1, fail,
                simulation_map_version_id=UUID(result['terrain']['map_version_id']))
    data = dict(run_id=str(uuid4()), scenario_id=new_scenario['id'], scenario_version=1,
        floor_id=str(plan.waypoints[0].floor_id), map_version_id=str(plan.waypoints[0].map_version_id),
        user_id=str(seeded['users']['one']), device_id=str(uuid4()), surface='pc', screen_id=str(uuid4()),
        simulation=True, map_proof=plan.map_proofs[0].model_dump(mode='json'))
    msg = C.AgentEvent(t='event', code='RUN_STARTED', severity='INFO', robot_at=None, data=data,
        agent_instance_id=str(uuid4()), report_seq=1, monotonic_s=1.)
    assert record(factory, seeded['org'], str(seeded['robots']['mine']), msg)['t'] == 'run.recorded'
    with factory() as db:
        assert db.get(Run, UUID(data['run_id'])).plan['map_proofs'] == [plan.map_proofs[0].model_dump(mode='json')]
        anchor_upload = db.get(Upload, UUID(original['upload_id']))
        assert anchor_upload.metadata_json['voxel_map']['map_version_id'] == original['id']


def test_human_and_twin_share_no_go_goal_and_waypoint_reference_checks(maps):
    http, headers, _ = maps
    result = post(http, headers).json()
    edited = edit(http, headers, result['map'])
    terrain = http.get(P + '/terrains/' + result['terrain']['spec']['id'], headers=headers).json()
    mission = http.post(P + '/missions', headers=headers, json={'name': '대기',
        'steps': [{'action': 'WAIT', 'params': {'seconds': 1}}]}).json()
    for floor_id, map_id in ((edited['floor_id'], edited['id']), (terrain['floor_id'], terrain['map_version_id'])):
        body = dict(name='구역 검사', waypoints=[dict(floor_id=floor_id, map_version_id=map_id,
            x=1., y=1., yaw=0., mission_id=mission['id'], mission_version=1)],
            finish={'mode': 'STAY'}, notes='')
        response = http.post(P + '/scenarios/preview', headers=headers, json=body)
        assert response.status_code == 200, response.text
        assert response.json()['reachable'] is False
        assert '진입 금지 구역 안입니다.' in response.json()['points'][0]['reasons']
        assert http.post(P + '/scenarios', headers=headers, json=body).status_code == 422
        point = body['waypoints'][0]
        point.update(x=-1., y=0., waypoint_ref='dock')  # SLOW has no invented speed/ban policy.
        response = http.post(P + '/scenarios/preview', headers=headers, json=body)
        assert response.status_code == 200 and response.json()['reachable'] is True
        point['x'] = -.8
        assert http.post(P + '/scenarios/preview', headers=headers, json=body).json()['reachable'] is False


def test_rollback_publishes_matching_annotations_and_keeps_old_twins(maps, seeded):
    http, headers, _ = maps
    result = post(http, headers).json()
    first = edit(http, headers, result['map'])
    second_features = copy.deepcopy(FEATURES)
    second_features['waypoints'][0]['name'] = '고친 지점'
    second = edit(http, headers, first, features=second_features)
    restored = http.post(P + '/map-versions/' + first['id'] + '/rollback', headers=headers,
        json={'base_version_id': second['id'], 'reason': '이전 구역으로 복원'})
    assert restored.status_code == 201, restored.text
    restored = restored.json()
    assert restored['features'] == first['features']
    assert restored['voxel_map']['map_version_id'] == restored['id']
    with Session(http.app.state.engine) as db:
        robot = sim_robot(db, seeded, result)
        ids = []
        for version in (first, second, restored):
            _, twin_id = simulation_twin(db, robot, UUID(first['floor_id']), UUID(version['id']), fail)
            ids.append(twin_id)
            assert db.get(MapVersion, twin_id).features == version['features']
        assert len(set(ids)) == 3


@pytest.mark.parametrize('change', ['new-upload', 'wall', 'other-floor'])
def test_changed_geometry_or_floor_cannot_reuse_twin(maps, seeded, change):
    http, headers, _ = maps
    result = post(http, headers).json()
    original = result['map']
    image, floor, features = original['upload_id'], original['floor_id'], copy.deepcopy(FEATURES)
    if change == 'new-upload':
        # Even byte-identical image/YAML on a new Upload is a different source.
        png = http.get(P + '/map-versions/' + original['id'] + '/image', headers=headers).content
        image = upload(http, headers, image=png, kind='image/png', yaml=(
            f'image: synthetic.png\nresolution: {original["resolution"]}\norigin: {original["origin"]}\n'
            'negate: 0\noccupied_thresh: 0.65\nfree_thresh: 0.2\n').encode())
    elif change == 'wall':
        features['edits'] = [dict(op='WALL', polyline=[[-2., 0.], [-1., 0.]], width=.1)]
    else:
        floor = tree(http, headers)[2]
    response = save(http, headers, floor, image, base=None if change == 'other-floor' else original['id'], features=features)
    assert response.status_code == 201, response.text
    edited = response.json()
    assert not edited.get('voxel_map') or edited['voxel_map']['map_version_id'] != edited['id']
    with Session(http.app.state.engine) as db:
        robot = sim_robot(db, seeded, result)
        with pytest.raises(Rejected):
            simulation_twin(db, robot, UUID(floor), UUID(edited['id']), fail)


def test_each_existing_terrain_revision_gets_annotations_and_later_terrain_saves_keep_them(maps, seeded, monkeypatch):
    http, headers, _ = maps
    result = post(http, headers).json()
    spec = copy.deepcopy(result['terrain']['spec'])
    spec['items'][0]['h'] = .6
    changed_terrain = put(http, headers, spec, 1).json()
    edited = edit(http, headers, result['map'])
    scenario = scenario_for(http, headers, edited['floor_id'], edited['id'])
    current = http.get(P + '/terrains/' + spec['id'], headers=headers).json()
    assert current['version'] == 2 and current['map_version_id'] != changed_terrain['map_version_id']
    with Session(http.app.state.engine) as db:
        robot = sim_robot(db, seeded, result)
        _, default = fixed_scenario(db, robot, UUID(scenario['id']), 1, fail)
        _, explicit = fixed_scenario(db, robot, UUID(scenario['id']), 1, fail,
            simulation_map_version_id=UUID(current['map_version_id']))
        assert default.map_proofs[0].map_version_id != explicit.map_proofs[0].map_version_id
        for plan in (default, explicit):
            assert db.get(MapVersion, plan.map_proofs[0].map_version_id).features == edited['features']
    # Model the route reading an old binding before waiting for the floor lock.
    from apps.server.fh_server import terrains
    with Session(http.app.state.engine) as db:
        previous = db.get(MapVersion, UUID(changed_terrain['map_version_id']))
        stale_twin = copy.deepcopy(db.get(Upload, previous.upload_id).metadata_json['voxel_twin'])
    original_save = terrains.save_terrain
    def stale_route_read(*args, **kwargs):
        kwargs['twin'] = stale_twin
        return original_save(*args, **kwargs)
    monkeypatch.setattr(terrains, 'save_terrain', stale_route_read)
    saved = put(http, headers, spec, 2)
    assert saved.status_code == 200, saved.text
    twin = http.get(P + '/map-versions/' + saved.json()['map_version_id'], headers=headers).json()
    assert twin['features'] == edited['features']


def test_rollback_to_voxel_after_replacing_file_restores_original_link(maps, seeded):
    http, headers, _ = maps
    result = post(http, headers).json()
    original = result['map']
    replacement = save(http, headers, original['floor_id'], upload(http, headers), base=original['id'])
    assert replacement.status_code == 201, replacement.text
    assert 'voxel_map' not in replacement.json()
    restored = http.post(P + '/map-versions/' + original['id'] + '/rollback', headers=headers,
        json={'base_version_id': replacement.json()['id'], 'reason': '점 지도 복원'})
    assert restored.status_code == 201, restored.text
    restored = restored.json()
    assert restored['voxel_map']['map_version_id'] == restored['id']
    with Session(http.app.state.engine) as db:
        robot = sim_robot(db, seeded, result)
        assert simulation_twin(db, robot, UUID(original['floor_id']), UUID(restored['id']), fail)[1] != UUID(result['terrain']['map_version_id'])


def test_pgm_annotation_save_and_rollback_do_not_create_voxel_twins(maps):
    http, headers, _ = maps
    floor = tree(http, headers)[2]
    image = upload(http, headers)
    first = save(http, headers, floor, image).json()
    features = dict(zones=[], waypoints=[dict(id='p', name='지점', x=.5, y=.5, yaw=0.)], connectors=[], edits=[])
    second = save(http, headers, floor, image, base=first['id'], features=features)
    assert second.status_code == 201, second.text
    assert 'voxel_map' not in second.json()
    restored = http.post(P + '/map-versions/' + first['id'] + '/rollback', headers=headers,
        json={'base_version_id': second.json()['id'], 'reason': '합성 PGM 복원'})
    assert restored.status_code == 201 and 'voxel_map' not in restored.json()
    with Session(http.app.state.engine) as db:
        assert db.query(MapVersion).filter(MapVersion.provenance == 'SIMULATION').count() == 0
