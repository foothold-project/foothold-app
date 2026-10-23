"""Approved warehouse import, server relay and observed map identity."""
from copy import copy, deepcopy
from pathlib import Path
from types import SimpleNamespace
from uuid import UUID, uuid4

from fastapi.testclient import TestClient
import pytest
from sqlalchemy.orm import Session

from apps.contracts import models as C
from apps.server.fh_server.floor_maps import approved_bindings, matches_context
from apps.server.fh_server.models import MapVersion, Upload
from apps.server.fh_server.realtime import Realtime, AgentBatch, Peer
from apps.server.fh_server.sim_maps import sync_worlds
from .test_floor_auto import context
from .test_maps import maps
from .test_sim_maps import world_folder


def test_warehouse_existing_immutable_approval_binds_without_reimport_and_rejects_changed_coordinates(maps, seeded, world_folder):
    http, _, files = maps
    # Construct a pre-fix import by omitting only its new optional metadata key.
    from apps.server.fh_server.sim_maps import load_worlds
    from unittest.mock import patch
    rows = load_worlds(world_folder)
    rows[0][1].pop('connected_gt')
    with Session(http.app.state.engine) as db, db.begin():
        with patch('apps.server.fh_server.sim_maps.load_worlds',return_value=rows):
            ids = sync_worlds(db, seeded['org'], seeded['users']['admin'], world_folder, files)
        b = approved_bindings(db, seeded['org'], 'warehouse')[0]
        assert b.ros_floor_id == 'f1' and b.world_id == 'warehouse'
        assert (b.width,b.height,b.resolution,list(b.origin)) == (300,440,.05,[-7.5,-11.,0.])
        assert b.source_pgm_sha256 == '90d1b5dced724f7b918c1977c655f8ccc3815c5f9579f8874ea76b1a5be67e8c'
        version = db.get(MapVersion,b.map_version_id)
        assert 'connected_gt' not in db.get(Upload,version.upload_id).metadata_json
        assert sync_worlds(db,seeded['org'],seeded['users']['admin'],world_folder,files) == []
        assert str(approved_bindings(db,seeded['org'],'warehouse')[0].map_version_id) == ids[0]
        with db.no_autoflush:
            version.resolution = .1
            with pytest.raises(ValueError):
                approved_bindings(db,seeded['org'],'warehouse')
            version.resolution = .05


def test_warehouse_location_is_accepted_only_for_matching_approval_and_generation():
    c = context()
    c.update(world_id='warehouse',spawn_floor_id='f1',current_floor_id='f1',floor_rev=1)
    b = C.SimMapBinding(world_id='warehouse', building_id=c['building_id'], ros_building_id='warehouse',
        ros_floor_id='f1', ros_map_version='gt-20261012', floor_id=c['floor_id'],map_version_id=c['map_version_id'],
        sha256=c['sha256'],source_pgm_sha256=c['source_pgm_sha256'],source='SIMULATION',
        resolution=.05,origin=[-7.5,-11,0],width=300,height=440)
    assert matches_context(c,[b])
    assert not matches_context({**c,'world_id':'v5_building'},[b])
    peer = Peer(None,auth_checked=0.)
    rid = c['robot_id']; batch = AgentBatch(); batch.floor_authority = {rid:(3,[b])}
    realtime = SimpleNamespace(agents={rid:peer},owner_uncertain=False,clock=lambda:0.,
        agent_pipeline=SimpleNamespace(latest=batch,stamp=0.),runs={},screens={},
        arbiter=SimpleNamespace(robot=lambda _:SimpleNamespace(transfer=None),state=lambda *args:[]),apply=lambda _:None)
    def report():
        return C.AgentState(t='state',pose=dict(floor_context=deepcopy(c),floor_id=c['floor_id'],
            map_version_id=c['map_version_id'],x=2.,y=3.,yaw=.25,confidence=None),speed=.5,
            battery=dict(soc=None),latched=True,stop_gen=1,stop_ref=0,applied=[0,0,0],mode='FREE')
    assert Realtime.accept_state(realtime,rid,peer,report())
    assert peer.state['location']['x'] == 2.
    assert peer.state['location']['floor_context']['world_id'] == 'warehouse'
    batch.floor_authority = {rid:(4,[b])}
    Realtime.accept_state(realtime,rid,peer,report())
    assert peer.state['location']['x'] is None
    assert peer.state['location']['floor_context']['reason'] == 'approval_unverified'
    assert peer.state['applied'] == [0,0,0] and peer.state['latched']


def test_server_relays_one_warehouse_binding_to_manager(maps,seeded,world_folder,monkeypatch):
    import os
    from apps.simmgr.api import create_app as manager_app
    from apps.simmgr.config import Settings, Slot, World
    from .test_simulation import LocalRelay
    from .test_api import csrf
    # Server-only pytest does not load simmgr's clean_ros_environment fixture.
    # Match the existing connected-floor relay test's isolated control plane.
    for name in tuple(os.environ):
        if name.startswith(('ROS_', 'RMW_', 'CYCLONEDDS_', 'FASTRTPS_', 'FASTDDS_')):
            monkeypatch.delenv(name)
    http,_,files = maps
    with Session(http.app.state.engine) as db,db.begin():
        sync_worlds(db,seeded['org'],seeded['users']['admin'],world_folder,files)
    rid = str(uuid4())
    slot = Slot(rid,str(seeded['org']),'unused','unused.sqlite',9433)
    config = Settings({'warehouse/f1':World('warehouse/f1',Path('unused'),Path('unused'),'Warehouse')},
                      {rid:slot},'x'*32)
    monkeypatch.setattr('apps.simmgr.api.startup_preflight',lambda *_:{'resources_ok':True})
    with TestClient(manager_app(config),client=('127.0.0.1',9710)) as sim:
        class Relay(LocalRelay):
            sent = []
            def request(self,method,path,body=None):
                if method == 'POST': self.sent.append(deepcopy(body))
                return super().request(method,path,body)
        relay = Relay(sim,config.secret);http.app.state.simmgr = relay
        http.app.state.phone_pass_issuer.keys[rid] = ('test',{'test':b'x'*32})
        headers = csrf(http,'one')
        response = http.post('/api/v1/simulation/robots',headers=headers,json=dict(world_id='warehouse/f1',robot_id=rid))
        assert response.status_code == 201,response.text
        assert len(relay.sent[0]['map_bindings']) == 1
        assert relay.sent[0]['map_bindings'][0]['ros_floor_id'] == 'f1'
        assert sim.app.state.manager.world_bindings[0]['world_id'] == 'warehouse'
        rt = copy(http.app.state.realtime)
        fake_peer = SimpleNamespace(socket=SimpleNamespace(headers={'authorization':'Bearer '+relay.sent[0]['agent_token']}))
        # Real approval loader reads the new simulation generation; v5 may be absent.
        rt.agents = {rid:fake_peer}
        batch = rt.load_agent_batch()
        assert batch.floor_authority[rid][0] == response.json()['generation']
        assert any(b.world_id == 'warehouse' for b in batch.floor_authority[rid][1])
        assert http.delete('/api/v1/simulation/robots/'+rid,headers=headers).status_code == 204
