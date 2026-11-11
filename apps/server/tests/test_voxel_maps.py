"""Synthetic room/box/steps only; no robot, simulator or production files."""
import copy
import hashlib
import struct
from uuid import UUID, uuid4

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from apps.contracts import models as C
from apps.server.fh_server import voxel_files as V
from apps.server.fh_server.map_files import gray_pixels
from apps.server.fh_server.models import Floor, MapVersion, Robot, Upload, Run, ScenarioVersion
from apps.server.fh_server.runs import fixed_scenario, map_proof, record, ReportRejected
from apps.server.fh_server.voxel_maps import simulation_twin
from .test_maps import maps, auth, tree, save, P  # noqa: F401
from .test_terrains import put


def room():
    points = [(x / 10 + 100, y / 10 - 20, 2.) for x in range(-30, 31) for y in range(-30, 31)]
    # Box and two step tops, with floor still sampled beneath them.
    for x in range(8, 17):
        for y in range(8, 17):
            points.append((x / 10 + 100, y / 10 - 20, 2.5))
    for x in range(-20, -10):
        for y in range(8, 16):
            points.append((x / 10 + 100, y / 10 - 20, 2.2 if x < -15 else 2.4))
    return points


def pcd(points, binary=False):
    head = (f'VERSION .7\nFIELDS x y z intensity\nSIZE 4 4 4 4\nTYPE F F F F\nCOUNT 1 1 1 1\n'
            f'WIDTH {len(points)}\nHEIGHT 1\nPOINTS {len(points)}\nDATA {"binary" if binary else "ascii"}\n').encode()
    body = b''.join(struct.pack('<ffff', *p, 1.) for p in points) if binary else ''.join(' '.join(map(str, (*p, 1))) + '\n' for p in points).encode()
    return head + body


def ply(points, mode='ascii'):
    head = (f'ply\nformat {mode} 1.0\nelement vertex {len(points)}\n'
            'property float x\nproperty float y\nproperty float z\nend_header\n').encode()
    if mode == 'ascii':
        return head + ''.join(' '.join(map(str, p)) + '\n' for p in points).encode()
    return head + b''.join(struct.pack(('>' if mode.endswith('big_endian') else '<') + 'fff', *p) for p in points)


def post(http, headers, floor_id=None, data=None, **params):
    if floor_id is None:
        floor_id = tree(http, headers)[2]
    return http.post(P + f'/floors/{floor_id}/voxel-maps', headers={**headers, 'content-type': 'application/octet-stream'},
        params={'name': '합성 방', 'format': 'pcd', **params}, content=pcd(room()) if data is None else data)


def fail(status, code, message, *args):
    raise Rejected(status, code, message)


class Rejected(Exception):
    pass


@pytest.mark.parametrize('kind,encode', [('pcd', pcd), ('pcd', lambda p: pcd(p, True)),
    ('ply', ply), ('ply', lambda p: ply(p, 'binary_little_endian')), ('ply', lambda p: ply(p, 'binary_big_endian'))])
def test_xyz_formats_and_same_coordinates(kind, encode):
    result = V.convert(encode(room()), kind, 'vox-test', '합성 방')
    assert result['point_count'] == len(room())
    assert result['floor_z'] == 2
    assert result['source_translation'] == [-100., 20., -2.]
    assert 3 <= len(result['spec'].items) <= 60
    assert len(result['spec'].items) <= 60
    w, h, pixels = gray_pixels(result['png'])
    assert result['origin'] == [-result['spec'].size[0] / 2, -result['spec'].size[1] / 2, 0]
    def pixel(x, y):
        col = int(round((x - result['origin'][0]) / .1))
        row = h - 1 - int(round((y - result['origin'][1]) / .1))
        return pixels[row * w + col]
    assert pixel(1., 1.) == 0
    assert pixel(0., 0.) == 254
    assert pixel(-3.1, -3.1) == 205
    assert all(0 < box.h <= 1 for box in result['spec'].items)


def test_coarsens_to_sixty_and_reports_crop_and_clamp():
    points = [(x / 10, y / 10, 0.) for x in range(-60, 61) for y in range(-60, 61)]
    points += [(x / 10, y / 10, 2.) for x in range(0, 50, 3) for y in range(0, 50, 3)]
    points += [(-40., 0., 0.), (40., 0., 0.)]
    result = V.convert(pcd(points), 'pcd', 'vox-test', '범위')
    assert len(result['spec'].items) <= 60
    assert result['spec'].size[0] == 30
    assert len(result['warnings']) == 3
    C.TerrainSpec.model_validate(result['spec'])  # Includes spawn clearance and all footprints.


@pytest.mark.parametrize('data', [b'', b'not a point cloud', pcd([(float('nan'), 0, 0)]),
    pcd([(float('inf'), 0, 0)]), pcd([(10001, 0, 0)]), pcd(room())[:-8],
    pcd(room()).replace(b'DATA ascii', b'DATA binary_compressed'),
    pcd(room()).replace(b'FIELDS x y z', b'FIELDS x x z')])
def test_bad_files_are_korean_and_atomic(maps, data):
    http, headers, root = maps
    response = post(http, headers, data=data)
    assert response.status_code == 422, response.text
    assert any('\uac00' <= c <= '\ud7a3' for c in response.json()['error']['message'])
    assert not list(root.rglob('source.*'))
    assert http.get(P + '/terrains', headers=headers).json()['items'] == []


def test_limits(maps, monkeypatch):
    http, headers, _ = maps
    floor = tree(http, headers)[2]
    response = http.post(P + f'/floors/{floor}/voxel-maps?name=test&format=pcd',
        headers={**headers, 'content-length': str(V.MAX_BYTES + 1)}, content=b'x')
    assert response.status_code == 413
    assert post(http, headers, floor, b'x' * 100, format='ply').status_code == 422
    too_many = pcd([(0, 0, 0)]).replace(b'POINTS 1', b'POINTS 5000001')
    assert post(http, headers, floor, too_many).status_code == 422
    monkeypatch.setattr(V, 'MAX_VOXELS', 20)
    assert post(http, headers, floor).status_code == 422


def test_publish_read_pages_and_stale_role_guards(maps):
    http, headers, root = maps
    floor = tree(http, headers)[2]
    response = post(http, headers, floor)
    assert response.status_code == 201, response.text
    result = C.VoxelMapImport.model_validate(response.json())
    assert result.map.provenance == 'HUMAN' and result.map.source == 'SLAM'
    assert result.voxels == result.map.voxel_map
    twin = http.get(P + '/map-versions/' + str(result.terrain.map_version_id), headers=headers).json()
    assert twin['origin'] == list(result.map.origin)
    assert twin['width'] * twin['resolution'] == result.map.width * result.map.resolution
    assert list(root.rglob('source.pcd'))[0].read_bytes() == pcd(room())
    cells, cursor = [], 0
    while cursor is not None:
        page = http.get(P + f'/map-versions/{result.map.id}/voxels', headers=headers, params={'limit': 2000, 'cursor': cursor})
        assert page.status_code == 200, page.text
        page = page.json()
        cells.extend(page['cells'])
        cursor = page['next_cursor']
    assert len(cells) == result.voxels.voxel_count
    packed = b''.join(struct.pack('<iii', *cell) for cell in cells)
    assert hashlib.sha256(packed).hexdigest() == result.voxels.cells_sha256
    assert post(http, headers, floor).status_code == 409
    assert post(http, auth(http, 'one'), floor).status_code == 403
    assert http.get(P + f'/map-versions/{result.map.id}/voxels?limit=20001', headers=headers).status_code == 400
    # HUMAN uploads cannot accidentally claim simulation source proof.
    with Session(http.app.state.engine) as db:
        upload = db.get(Upload, result.map.upload_id)
        assert upload.provenance == 'HUMAN'
        assert 'connected_gt' not in upload.metadata_json
    # An ordinary edit reusing the upload cannot forge a twin for a new map UUID.
    copied = save(http, headers, floor, str(result.map.upload_id), base=str(result.map.id)).json()
    with Session(http.app.state.engine) as db:
        robot = db.scalar(select(Robot).where(Robot.name == 'mine'))
        robot.simulation = True
        robot.sim_world_id = 'custom/' + result.terrain.spec.id
        with pytest.raises(Rejected):
            simulation_twin(db, robot, UUID(floor), UUID(copied['id']), fail)


def scenario_for(http, headers, floor, version):
    mission = http.post(P + '/missions', headers=headers, json={'name': '대기',
        'steps': [{'action': 'WAIT', 'params': {'seconds': 1}}]}).json()
    points = [dict(floor_id=str(floor), map_version_id=str(version), x=x, y=0., yaw=0.,
        mission_id=mission['id'], mission_version=1) for x in (-1., 0.)]
    response = http.post(P + '/scenarios', headers=headers, json=dict(name='같은 시나리오', waypoints=points,
        finish={'mode': 'RETURN_TO_START'}, notes=''))
    assert response.status_code == 201, response.text
    return response.json()


def test_same_fixed_scenario_proof_and_recording_and_terrain_edit(maps, seeded):
    http, headers, root = maps
    result = post(http, headers).json()
    scenario = scenario_for(http, headers, result['map']['floor_id'], result['map']['id'])
    factory = sessionmaker(http.app.state.engine, expire_on_commit=False)
    with factory.begin() as db:
        robot = db.get(Robot, seeded['robots']['mine'])
        robot.simulation = True
        robot.sim_world_id = 'custom/' + result['terrain']['spec']['id']
    with factory() as db:
        robot = db.get(Robot, seeded['robots']['mine'])
        stored, plan = fixed_scenario(db, robot, UUID(scenario['id']), 1, fail)
        assert plan.waypoints[0].map_version_id == UUID(result['terrain']['map_version_id'])
        assert plan.waypoints[0].x == -1.
        assert stored.waypoints[0]['map_version_id'] == result['map']['id']
        assert plan.map_proofs[0].source == 'SIMULATION'
        with pytest.raises(Rejected):
            map_proof(db, robot, UUID(result['map']['floor_id']), UUID(result['map']['id']), fail)
        version = db.get(MapVersion, plan.map_proofs[0].map_version_id)
        assert hashlib.sha256((root / version.image_path).with_suffix('.pgm').read_bytes()).hexdigest() == plan.map_proofs[0].source_pgm_sha256
    started = dict(run_id=str(uuid4()), scenario_id=scenario['id'], scenario_version=1,
        floor_id=str(plan.waypoints[0].floor_id), map_version_id=str(plan.waypoints[0].map_version_id),
        user_id=str(seeded['users']['one']), device_id=str(uuid4()), surface='pc', screen_id=str(uuid4()),
        simulation=True, map_proof=plan.map_proofs[0].model_dump(mode='json'))
    msg = C.AgentEvent(t='event', code='RUN_STARTED', severity='INFO', robot_at=None, data=started,
        agent_instance_id=str(uuid4()), report_seq=1, monotonic_s=1.)
    assert record(factory, seeded['org'], str(seeded['robots']['mine']), msg)['t'] == 'run.recorded'
    with factory() as db:
        run = db.get(Run, UUID(started['run_id']))
        assert run.scenario_version_id == stored.id
        assert run.map_version_id == plan.map_proofs[0].map_version_id
    # Editor saves use the same library route; fixed original remains default.
    spec = copy.deepcopy(result['terrain']['spec'])
    spec['items'][0]['h'] = .6
    updated = put(http, headers, spec, 1)
    assert updated.status_code == 200, updated.text
    updated = updated.json()
    with factory() as db:
        robot = db.get(Robot, seeded['robots']['mine'])
        _, original = fixed_scenario(db, robot, UUID(scenario['id']), 1, fail)
        assert original.map_proofs == plan.map_proofs
        _, edited = fixed_scenario(db, robot, UUID(scenario['id']), 1, fail,
            simulation_map_version_id=UUID(updated['map_version_id']))
        assert edited.map_proofs[0].map_version_id == UUID(updated['map_version_id'])
    assert put(http, headers, {**spec, 'size': [8., 8.]}, 2).status_code == 422


def test_twin_proof_tampering_and_sim_only_real_rejection(maps, seeded):
    http, headers, _ = maps
    result = post(http, headers).json()
    source_scenario = scenario_for(http, headers, result['map']['floor_id'], result['map']['id'])
    sim_scenario = scenario_for(http, headers, result['terrain']['floor_id'], result['terrain']['map_version_id'])
    with Session(http.app.state.engine) as db:
        robot = db.get(Robot, seeded['robots']['mine'])
        with pytest.raises(Rejected) as denied:
            fixed_scenario(db, robot, UUID(sim_scenario['id']), 1, fail)
        assert denied.value.args[0:2] == (422, 'PRECHECK_FAILED')
        robot.simulation = True
        robot.sim_world_id = 'other-world'
        with pytest.raises(Rejected):
            fixed_scenario(db, robot, UUID(source_scenario['id']), 1, fail)
        db.rollback()
    # Only migration-role mutation can tamper with immutable records.
    engine = create_engine(seeded['urls']['migrate'])
    with Session(engine) as db:
        version = db.get(MapVersion, UUID(result['terrain']['map_version_id']))
        image = db.get(Upload, version.upload_id)
        image.metadata_json = {**image.metadata_json, 'voxel_twin': {**image.metadata_json['voxel_twin'], 'image_sha256': '0' * 64}}
        db.commit()
    engine.dispose()
    with Session(http.app.state.engine) as db:
        robot = db.get(Robot, seeded['robots']['mine'])
        robot.simulation = True
        robot.sim_world_id = 'custom/' + result['terrain']['spec']['id']
        with pytest.raises(Rejected):
            fixed_scenario(db, robot, UUID(source_scenario['id']), 1, fail)


def test_stream_size_and_failed_pair_save_roll_back_every_file(maps, monkeypatch):
    from apps.server.fh_server import voxel_maps as module
    http, headers, root = maps
    floor = tree(http, headers)[2]
    monkeypatch.setattr(module, 'MAX_BYTES', 80)
    response = http.post(P + f'/floors/{floor}/voxel-maps?name=test&format=pcd',
        headers=headers, content=iter([b'x' * 60, b'x' * 60]))
    assert response.status_code == 413
    monkeypatch.setattr(module, 'MAX_BYTES', V.MAX_BYTES)
    def unavailable(*args, **kwargs):
        raise OSError('synthetic disk failure')
    monkeypatch.setattr(module, 'save_terrain', unavailable)
    response = post(http, headers, floor)
    assert response.status_code == 503
    assert not [path for path in root.rglob('*') if path.is_file()]
    with Session(http.app.state.engine) as db:
        assert db.get(Floor, UUID(floor)).approved_version_id is None
        assert list(db.scalars(select(MapVersion))) == []
        assert list(db.scalars(select(Upload))) == []


def test_other_organization_cannot_read_or_import(maps, seeded):
    from fastapi.testclient import TestClient
    from apps.server.fh_server.api import create_app, Settings
    from apps.server.fh_server.models import User
    http, headers, root = maps
    result = post(http, headers).json()
    with Session(http.app.state.engine) as db:
        other_org = db.get(User, seeded['users']['foreign']).org_id
    app = create_app(Settings(seeded['urls']['app'], other_org, files_root=str(root)))
    with TestClient(app, base_url='https://testserver') as other:
        foreign = auth(other, 'foreign')
        response = other.get(P + '/map-versions/' + result['map']['id'] + '/voxels', headers=foreign)
        assert response.status_code == 404
        assert post(other, foreign, result['map']['floor_id']).status_code == 404
    app.state.engine.dispose()
