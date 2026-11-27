"""Per-map-version indoor 3D model (GLB): sim-world import and the /model route.

Only a tiny synthetic GLB in a temporary folder is used; no real model file.
"""
import hashlib
import json
import shutil
import struct

import pytest
from pydantic import ValidationError
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from apps.contracts import models as C
from apps.server.fh_server.models import Event, MapVersion
from .test_maps import P, maps  # noqa: F401  (fixture)
from .test_sim_maps import SOURCE, sync

KEY = 'plant_a/l1'  # map extent x -1..37, y -1..21: asymmetric about y = 0


def make_folder(root, floor='l1'):
    (root / 'plant_a/maps').mkdir(parents=True)
    for relative in ('worlds.json', f'plant_a/scenarios-{floor}.json', f'plant_a/maps/{floor}.png',
                     f'plant_a/maps/{floor}.yaml', 'plant_a/maps/metadata.json'):
        shutil.copyfile(SOURCE / relative, root / relative)
    catalog = json.loads((root / 'worlds.json').read_text())
    entry = catalog['worlds']['plant_a/' + floor]
    entry.pop('model', None)
    entry['sha256'].pop('model', None)
    catalog['worlds'] = {'plant_a/' + floor: entry}
    (root / 'worlds.json').write_text(json.dumps(catalog))
    return root


@pytest.fixture
def world_folder(tmp_path):
    return make_folder(tmp_path / 'worlds')


def glb(tag=b'synthetic', at=(30.0, 0.0, -4.0), node='l1_floor', parent=None):
    """Tiny GLB: one asymmetric 2 x 1 x 0.5 m box node named `node`, glTF translation `at`."""
    lo, hi = [-1.0, -0.175, -0.25], [1.0, 0.0, 0.25]
    points = [(x, y, z) for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])]
    binary = b''.join(struct.pack('<3f', *p) for p in points)
    nodes = [{'name': node, 'mesh': 0, 'translation': list(at)}]
    if parent is not None:  # child at `at`, under a parent node with TRS `parent`
        nodes = [{'name': node, 'mesh': 0, 'translation': list(at)}, {'name': 'group', 'children': [0], **parent}]
    gltf = {'asset': {'version': '2.0'}, 'extras': tag.decode(), 'scenes': [{'nodes': [len(nodes) - 1]}],
            'nodes': nodes, 'meshes': [{'primitives': [{'attributes': {'POSITION': 0}}]}],
            'accessors': [{'bufferView': 0, 'componentType': 5126, 'count': 8, 'type': 'VEC3', 'min': lo, 'max': hi}],
            'bufferViews': [{'buffer': 0, 'byteLength': len(binary)}], 'buffers': [{'byteLength': len(binary)}]}
    body = json.dumps(gltf).encode()
    body += b' ' * (-len(body) % 4)
    chunks = struct.pack('<II', len(body), 0x4E4F534A) + body + struct.pack('<II', len(binary), 0x004E4942) + binary
    return b'glTF' + struct.pack('<II', 2, 12 + len(chunks)) + chunks


def declare(folder, data=None, *, digest=None, name='plant_a/models/plant_a_l1_real.glb', key=KEY):
    catalog = json.loads((folder / 'worlds.json').read_text())
    entry = catalog['worlds'][key]
    entry['model'] = name
    entry['sha256']['model'] = digest or hashlib.sha256(data).hexdigest()
    (folder / 'worlds.json').write_text(json.dumps(catalog))
    if data is not None:
        (folder / name).parent.mkdir(parents=True, exist_ok=True)
        (folder / name).write_bytes(data)


def approved(http, headers):
    building = http.get(P + '/sites', headers=headers).json()['items'][0]['buildings'][0]
    vid = building['floors'][0]['approved_version_id']
    response = http.get(P + f'/map-versions/{vid}', headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def test_contract_model_sha256_is_optional_hex():
    field = C.MapVersion.model_fields['model_sha256']
    assert field.default is None
    base = dict(upload_id='00000000-0000-0000-0000-000000000001', id='00000000-0000-0000-0000-000000000002',
        floor_id='00000000-0000-0000-0000-000000000003', number=1, base_version_id=None, status='APPROVED',
        image_sha256='ab' * 32, width=1, height=1, resolution=.05, origin=(0, 0, 0),
        features={'zones': [], 'waypoints': [], 'connectors': [], 'edits': []}, reason='r', source='IMPORT',
        created_by='00000000-0000-0000-0000-000000000004', created_at='2026-11-28T00:00:00Z')
    assert C.MapVersion(**base).model_dump(mode='json')['model_sha256'] is None
    assert C.MapVersion(**base).model_dump(mode='json')['model_floor_z'] is None
    assert C.MapVersion(**base, model_sha256='cd' * 32).model_sha256 == 'cd' * 32
    for bad in ('CD' * 32, 'cd' * 31, 'zz' * 32):
        with pytest.raises(ValidationError):
            C.MapVersion(**base, model_sha256=bad)


def test_sim_model_served_with_etag_and_no_store(maps, seeded, world_folder):
    http, headers, files = maps
    data = glb()
    declare(world_folder, data)
    sync(http, seeded, world_folder, files)
    version = approved(http, headers)
    assert version['model_sha256'] == hashlib.sha256(data).hexdigest()
    assert version['model_floor_z'] == 0.0
    response = http.get(P + f'/map-versions/{version["id"]}/model', headers=headers)
    assert response.status_code == 200, response.text
    assert response.content == data
    assert response.headers['content-type'] == 'model/gltf-binary'
    assert response.headers['cache-control'] == 'private, no-store'
    assert response.headers['etag'] == '"' + version['model_sha256'] + '"'
    # The stored copy lives under the server files root, content addressed.
    assert list(files.rglob('*.glb')) == [files / 'maps/simulation' / version['floor_id'] / (version['model_sha256'] + '.glb')]
    # Unauthenticated access is refused like the image route.
    assert http.get(P + f'/map-versions/{version["id"]}/model').status_code == 401


def test_no_model_is_null_and_404(maps, seeded, world_folder):
    http, headers, files = maps
    sync(http, seeded, world_folder, files)
    version = approved(http, headers)
    assert version['model_sha256'] is None and version['model_floor_z'] is None
    response = http.get(P + f'/map-versions/{version["id"]}/model', headers=headers)
    assert response.status_code == 404
    assert response.json()['error']['code'] == 'MODEL_NOT_FOUND'


def test_declared_but_absent_file_keeps_2d_only(maps, seeded, world_folder):
    # GLB files are not in the repository; a checkout without them still imports maps.
    http, headers, files = maps
    declare(world_folder, None, digest='ab' * 32)
    sync(http, seeded, world_folder, files)
    assert approved(http, headers)['model_sha256'] is None


HALF = 2 ** -.5


@pytest.mark.parametrize('child, parent', [
    # Child alone is glTF (-30, 0, 4) = world (-30, -4): outside. With the parent: (30, 0, -4) = world (30, 4).
    ((-30.0, 0.0, 4.0), {'translation': [60.0, 0.0, -8.0]}),
    # +90 deg about glTF +Y maps (4, 0, 30) to (30, 0, -4); child alone is world (4, -30): outside.
    ((4.0, 0.0, 30.0), {'rotation': [0.0, HALF, 0.0, HALF]}),
])
def test_parent_transform_is_applied(maps, seeded, world_folder, child, parent):
    http, headers, files = maps
    alone = glb(at=child)
    declare(world_folder, alone)
    sync(http, seeded, world_folder, files)
    assert approved(http, headers)['model_sha256'] is None  # the child alone is off the map
    data = glb(at=child, parent=parent)
    declare(world_folder, data)
    sync(http, seeded, world_folder, files)
    assert approved(http, headers)['model_sha256'] == hashlib.sha256(data).hexdigest()


def rejections(http):
    with Session(http.app.state.engine) as db:
        return list(db.scalars(select(Event).where(Event.code == 'SIM_MODEL_REJECTED').order_by(Event.at)))


def test_rejected_resync_detaches_earlier_model_and_records_once(maps, seeded, world_folder):
    # A model that no longer matches is worse than 2D only: detach it, say why, once per cause.
    http, headers, files = maps
    good = glb()
    declare(world_folder, good)
    sync(http, seeded, world_folder, files)
    assert approved(http, headers)['model_sha256'] == hashlib.sha256(good).hexdigest()
    flipped = glb(at=(30.0, 0.0, 4.0))
    declare(world_folder, flipped)
    for _ in range(2):  # the same rejection again leaves no second event
        assert sync(http, seeded, world_folder, files) == []
        version = approved(http, headers)
        assert version['model_sha256'] is None and version['model_floor_z'] is None
        assert http.get(P + f'/map-versions/{version["id"]}/model', headers=headers).status_code == 404
    event, = rejections(http)
    assert event.data['sha256'] == hashlib.sha256(flipped).hexdigest()
    assert event.data['detached_sha256'] == hashlib.sha256(good).hexdigest()
    # A different rejected file is a new cause and is recorded.
    declare(world_folder, glb(b'other', at=(30.0, 0.0, 4.0)))
    sync(http, seeded, world_folder, files)
    first, second = rejections(http)
    assert second.data['sha256'] != first.data['sha256'] and second.data['detached_sha256'] is None


def test_model_floor_z_read_by_uuid_equals_catalogue_floor_z(maps, seeded, tmp_path):
    # Producer-side check: the web reads model_floor_z off the UUID MapVersion, never node names.
    http, headers, files = maps
    folder = make_folder(tmp_path / 'worlds-l2', 'l2')
    floor_z = json.loads((SOURCE / 'worlds.json').read_text())['worlds']['plant_a/l2']['floor_z']
    declare(folder, glb(at=(30.0, floor_z, -4.0), node='l2_floor'), key='plant_a/l2',
            name='plant_a/models/plant_a_l2_real.glb')
    sync(http, seeded, folder, files)
    version = approved(http, headers)
    assert version['model_sha256'] and version['model_floor_z'] == floor_z == 3.375


@pytest.mark.parametrize('case', ['y_flipped', 'no_floor_node', 'floor_z_off', 'sha', 'magic'])
def test_failed_model_check_keeps_2d_and_records_reason(maps, seeded, world_folder, case):
    # world (30, 4, 0) is glTF (30, 0, -4); the y-flipped glTF (30, 0, 4) is world (30, -4).
    http, headers, files = maps
    if case == 'y_flipped':
        declare(world_folder, glb(at=(30.0, 0.0, 4.0)))
    elif case == 'no_floor_node':
        declare(world_folder, glb(node='l2_floor'))
    elif case == 'floor_z_off':  # top face 2 cm above floor_z 0
        declare(world_folder, glb(at=(30.0, 0.02, -4.0)))
    elif case == 'sha':
        declare(world_folder, glb())
        (world_folder / 'plant_a/models/plant_a_l1_real.glb').write_bytes(glb(b'changed'))
    else:
        declare(world_folder, b'not a glb file')
    assert len(sync(http, seeded, world_folder, files)) == 1  # 2D map still registered
    version = approved(http, headers)
    assert version['model_sha256'] is None and version['model_floor_z'] is None
    assert not list(files.rglob('*.glb'))
    with Session(http.app.state.engine) as db:
        event, = db.scalars(select(Event).where(Event.code == 'SIM_MODEL_REJECTED'))
        assert event.data['map_version_id'] == version['id'] and event.data['reason']


def test_model_path_outside_catalogue_fails_sync(maps, seeded, world_folder):
    http, headers, files = maps
    (world_folder.parent / 'outside.glb').write_bytes(glb())
    declare(world_folder, None, digest=hashlib.sha256(glb()).hexdigest(), name='../outside.glb')
    with pytest.raises(ValueError):
        sync(http, seeded, world_folder, files)
    with Session(http.app.state.engine) as db:
        assert db.scalar(select(func.count()).select_from(MapVersion)) == 0


def test_model_attaches_to_existing_version_and_follows_new_hash(maps, seeded, world_folder):
    http, headers, files = maps
    sync(http, seeded, world_folder, files)
    first = approved(http, headers)
    assert first['model_sha256'] is None
    for tag in (b'one', b'two'):
        data = glb(tag)
        declare(world_folder, data)
        assert sync(http, seeded, world_folder, files) == []  # same image: no new version
        now = approved(http, headers)
        assert now['id'] == first['id'] and now['model_sha256'] == hashlib.sha256(data).hexdigest()
        assert http.get(P + f'/map-versions/{now["id"]}/model', headers=headers).content == data


def test_model_file_missing_on_disk_is_storage_error(maps, seeded, world_folder):
    http, headers, files = maps
    declare(world_folder, glb())
    sync(http, seeded, world_folder, files)
    version = approved(http, headers)
    for path in files.rglob('*.glb'):
        path.unlink()
    response = http.get(P + f'/map-versions/{version["id"]}/model', headers=headers)
    assert response.status_code == 503
    assert response.json()['error']['code'] == 'FILE_STORAGE_ERROR'
