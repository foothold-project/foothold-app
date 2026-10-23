"""Canonical GT import, approved binding and read-only Location propagation."""
from copy import deepcopy
import json
from types import SimpleNamespace
from uuid import UUID

import pytest
from sqlalchemy.orm import Session

from apps.contracts import models as C
from apps.server.fh_server.floor_maps import approved_bindings, matches_context
from apps.server.fh_server.models import Floor, MapVersion
from apps.server.fh_server.map_files import sha256
from apps.server.fh_server.sim_maps import load_worlds, sync_worlds
from apps.server.fh_server.realtime import Realtime, AgentBatch, Peer
from .test_maps import maps


@pytest.fixture
def connected_folder(tmp_path):
    entries = {}
    for floor, z in [('l1', 0.), ('l2', 2.4)]:
        folder = tmp_path / floor; folder.mkdir()
        pgm = b'P5\n2 2\n255\n' + bytes([254, 254, 254, 0])
        (folder/'map.pgm').write_bytes(pgm)
        (folder/'map.yaml').write_text('image: map.pgm\nresolution: 0.05\norigin: [-20, -14, 0]\nnegate: 0\noccupied_thresh: 0.65\nfree_thresh: 0.196\nmode: trinary\n')
        meta = dict(world_id='v5_building', building_id='v5', floor_id=floor, map_source='gt_raster',
            map_frame='map', epoch=None, sha256_pgm=sha256(pgm).hex(), source_sha256=sha256(pgm).hex(),
            resolution=.05, origin=[-20, -14, 0], width=2, height=2, map_version='gt-20261012')
        (folder/'meta.json').write_text(json.dumps(meta))
        entries['v5_building/'+floor] = dict(world_id='v5_building', floor_id=floor,
            building_id='v5', floor_z=z, gt_map=floor+'/map.yaml')
    (tmp_path/'worlds.json').write_text(json.dumps(dict(schema='v2_map_worlds/1',
        worlds=entries, check=dict(l1_bytes_match=True, l2_bytes_match=True))))
    return tmp_path


def test_canonical_import_registers_both_floors_and_distinct_raw_png_hashes(maps, seeded, connected_folder):
    http, _, files = maps
    with Session(http.app.state.engine) as db, db.begin():
        assert len(sync_worlds(db, seeded['org'], seeded['users']['admin'], connected_folder, files)) == 2
        bindings = approved_bindings(db, seeded['org'])
        assert [b.ros_floor_id for b in bindings] == ['l1', 'l2']
        assert len({b.floor_id for b in bindings}) == 2
        assert all(b.source_pgm_sha256 != b.sha256 for b in bindings)
        assert sync_worlds(db, seeded['org'], seeded['users']['admin'], connected_folder, files) == []
        with pytest.raises(ValueError):
            approved_bindings(db, UUID(int=99))
        # A new approved edited version must not inherit the old GT registration.
        v = db.get(MapVersion, bindings[0].map_version_id)
        with db.no_autoflush:
            v.resolution = .1
            with pytest.raises(ValueError, match='registration changed'):
                approved_bindings(db, seeded['org'])
            v.resolution = .05


@pytest.mark.parametrize('field,value', [('source_sha256', 'f'*64), ('origin', [0, 0, 0]),
    ('floor_id', 'l1'), ('width', 3), ('map_source', 'slam')])
def test_canonical_import_rejects_any_bad_floor_before_writes(connected_folder, field, value):
    path = connected_folder/'l2/meta.json'
    meta = json.loads(path.read_text()); meta[field] = value; path.write_text(json.dumps(meta))
    with pytest.raises(ValueError):
        load_worlds(connected_folder)


def context(rev=2, floor='l1'):
    return dict(robot_id=str(UUID(int=10)), generation=3, run_id='run', epoch=1, floor_rev=rev,
        world_id='v5_building', building_id=str(UUID(int=20)), spawn_floor_id='l1',
        current_floor_id=floor, floor_id=str(UUID(int=1)) if floor else None,
        map_version_id=str(UUID(int=11)) if floor else None, sha256='1'*64 if floor else None,
        source_pgm_sha256='3'*64 if floor else None, source='gt_geometry',
        floor_state='on_floor' if floor else 'transit', reason='ok' if floor else 'connector_ramp', confirmed_sim_t=1.)


def test_server_location_carries_context_and_rejects_late_revision_without_motion_changes():
    c = context()
    b = C.SimMapBinding(world_id='v5_building', building_id=c['building_id'], ros_building_id='v5',
        ros_floor_id='l1', ros_map_version='gt-20261012', floor_id=c['floor_id'], map_version_id=c['map_version_id'],
        sha256=c['sha256'], source_pgm_sha256=c['source_pgm_sha256'], source='SIMULATION',
        resolution=.05, origin=[-20, -14, 0], width=2, height=2)
    peer = Peer(None, auth_checked=0.)
    rid = c['robot_id']
    batch = AgentBatch(); batch.floor_authority = {rid: (3, [b])}
    effects = []
    realtime = SimpleNamespace(agents={rid: peer}, owner_uncertain=False, clock=lambda: 0.,
        agent_pipeline=SimpleNamespace(latest=batch, stamp=0.), runs={}, screens={},
        arbiter=SimpleNamespace(robot=lambda _: SimpleNamespace(transfer=None),
            state=lambda *args: effects.append(args) or []), apply=lambda _: None)
    def report(ctx):
        pose = dict(floor_context=ctx, floor_id=ctx['floor_id'], map_version_id=ctx['map_version_id'],
            x=2. if ctx['floor_id'] else None, y=3. if ctx['floor_id'] else None,
            yaw=.25 if ctx['floor_id'] else None, confidence=None)
        return C.AgentState(t='state', pose=pose, speed=.5, battery=dict(soc=None), latched=False,
            stop_gen=1, stop_ref=0, applied=[.6, 0, 0], mode='USER')
    assert Realtime.accept_state(realtime, rid, peer, report(c))
    loc = C.Location.model_validate(peer.state['location'])
    assert loc.map_version_id == b.map_version_id and loc.floor_context.floor_rev == 2
    assert peer.state['applied'] == [.6, 0., 0.] and len(effects) == 1
    transit = context(3, None)
    Realtime.accept_state(realtime, rid, peer, report(transit))
    assert peer.state['location']['x'] is None and peer.state['location']['floor_context']['floor_state'] == 'transit'
    Realtime.accept_state(realtime, rid, peer, report(c))
    assert peer.state['location']['floor_context']['floor_rev'] == 3
    assert peer.state['applied'] == [.6, 0., 0.] and len(effects) == 3
    batch.floor_authority = {rid: (3, [])}  # approval changed or no registered grid
    Realtime.accept_state(realtime, rid, peer, report(context(4)))
    assert peer.state['location']['floor_context']['reason'] == 'approval_unverified'
    assert peer.state['location']['x'] is None


def test_request_aliases_normalize_to_execution_identity():
    assert C.SimWorldStart(world_id='v5_building/l2').model_dump() == dict(world_id='v5_building', spawn_floor_id='l2')
    assert C.SimWorldStart(world_id='v5_building').spawn_floor_id == 'l1'
    for raw in [dict(world_id='v5_building/l1', spawn_floor_id='l2'), dict(world_id='other', spawn_floor_id='l1')]:
        with pytest.raises(ValueError):
            C.SimWorldStart(**raw)


def test_server_relay_supplies_both_bindings_and_canonical_start_identity(maps, seeded, connected_folder, monkeypatch):
    from pathlib import Path
    from uuid import uuid4
    from fastapi.testclient import TestClient
    from apps.simmgr.api import create_app as manager_app
    from apps.simmgr.config import Settings as ManagerSettings, Slot, World
    from .test_simulation import LocalRelay
    from .test_api import csrf
    http, _, files = maps
    import os
    for name in tuple(os.environ):
        if name.startswith(('ROS_', 'RMW_', 'CYCLONEDDS_', 'FASTRTPS_', 'FASTDDS_')):
            monkeypatch.delenv(name)
    with Session(http.app.state.engine) as db, db.begin():
        sync_worlds(db, seeded['org'], seeded['users']['admin'], connected_folder, files)
    rid = str(uuid4())
    slot = Slot(rid, str(seeded['org']), 'unused', 'unused.sqlite', 9433)
    worlds = {f'v5_building/{f}': World(f'v5_building/{f}', Path('unused'), Path('unused'), '연결 건물')
              for f in ('l1', 'l2')}
    config = ManagerSettings(worlds, {rid: slot}, 'x'*32)
    monkeypatch.setattr('apps.simmgr.api.startup_preflight', lambda *_: {'resources_ok': True})
    with TestClient(manager_app(config), client=('127.0.0.1', 9651)) as sim:
        class Relay(LocalRelay):
            sent = []
            def request(self, method, path, body=None):
                if method == 'POST':
                    self.sent.append(deepcopy(body))
                return super().request(method, path, body)
        relay = Relay(sim, config.secret)
        http.app.state.simmgr = relay
        http.app.state.phone_pass_issuer.keys[rid] = ('test', {'test': b'x'*32})
        headers = csrf(http, 'one')
        catalog = http.get('/api/v1/simulation/worlds').json()['worlds']
        assert len(catalog) == 1 and catalog[0]['id'] == 'v5_building'
        assert catalog[0]['spawn_floor_ids'] == ['l1', 'l2']
        assert {f['ros_floor_id'] for f in catalog[0]['floors']} == {'l1', 'l2'}
        result = http.post('/api/v1/simulation/robots', headers=headers,
            json=dict(world_id='v5_building/l2', robot_id=rid))
        assert result.status_code == 201, result.text
        assert result.json()['world_id'] == 'v5_building' and result.json()['spawn_floor_id'] == 'l2'
        assert len(relay.sent[0]['map_bindings']) == 2
        assert relay.sent[0]['spawn_floor_id'] == 'l2'
        assert relay.sent[0]['world_id'] == 'v5_building'
        manager = sim.app.state.manager
        before = list(manager.launcher.events)
        conflict = http.post('/api/v1/simulation/robots', headers=headers,
            json=dict(world_id='v5_building', spawn_floor_id='l1', robot_id=rid))
        assert conflict.status_code == 409
        assert manager.launcher.events == before and manager.world == 'v5_building'
        assert http.delete('/api/v1/simulation/robots/'+rid, headers=headers).status_code == 204
