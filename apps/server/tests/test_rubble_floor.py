"""Rubble import -> approved binding -> manager -> observed pose authority."""
from copy import deepcopy
import json
import os
from pathlib import Path
import shutil
from types import SimpleNamespace
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest
from sqlalchemy.orm import Session

from apps.contracts import models as C
from apps.server.fh_server.floor_maps import approved_bindings, matches_context
from apps.server.fh_server.models import MapVersion
from apps.server.fh_server.sim_maps import load_worlds, sync_worlds
from apps.simmgr.api import create_app as manager_app
from apps.simmgr.config import Settings, Slot, World
from .test_api import csrf
from .test_floor_auto import context
from .test_maps import maps
from .test_simulation import LocalRelay

SOURCE = Path(__file__).resolve().parents[2]/'simmgr/worlds'


@pytest.fixture
def rubble_folder(tmp_path):
    root = tmp_path/'worlds'; root.mkdir()
    shutil.copytree(SOURCE/'rubble',root/'rubble')
    catalog = json.loads((SOURCE/'worlds.json').read_text())
    catalog['worlds'] = {'rubble/f1':catalog['worlds']['rubble/f1']}
    (root/'worlds.json').write_text(json.dumps(catalog))
    return root


def test_rubble_approval_manager_relay_and_realtime_registration(maps, seeded, rubble_folder, monkeypatch):
    http, _, files = maps
    row = load_worlds(rubble_folder)[0]
    assert row[1]['connected_gt']['world_id'] == 'rubble' and (row[3],row[4]) == (400,400)
    with Session(http.app.state.engine) as db, db.begin():
        ids = sync_worlds(db,seeded['org'],seeded['users']['admin'],rubble_folder,files)
        assert len(ids) == 1
        assert sync_worlds(db,seeded['org'],seeded['users']['admin'],rubble_folder,files) == []
        binding = approved_bindings(db,seeded['org'],'rubble')[0]
        assert binding.ros_floor_id == 'f1' and list(binding.origin) == [-10.,-10.,0.]
        version = db.get(MapVersion,binding.map_version_id)
        with db.no_autoflush:
            version.origin_x = -9.
            with pytest.raises(ValueError):
                approved_bindings(db,seeded['org'],'rubble')
            version.origin_x = -10.
    for name in tuple(os.environ):
        if name.startswith(('ROS_','RMW_','CYCLONEDDS_','FASTRTPS_','FASTDDS_')):
            monkeypatch.delenv(name)
    rid = str(uuid4())
    slot = Slot(rid,str(seeded['org']),'unused','unused.sqlite',9433)
    config = Settings({'rubble/f1':World('rubble/f1',Path('unused'),Path('unused'),'잔해 험지')},
        {rid:slot},'x'*32)
    monkeypatch.setattr('apps.simmgr.api.startup_preflight',lambda *_:{'resources_ok':True})
    with TestClient(manager_app(config),client=('127.0.0.1',9450)) as sim:
        class Relay(LocalRelay):
            sent = []
            def request(self,method,path,body=None):
                if method == 'POST': self.sent.append(deepcopy(body))
                return super().request(method,path,body)
        relay = Relay(sim,config.secret); http.app.state.simmgr = relay
        http.app.state.phone_pass_issuer.keys[rid] = ('test',{'test':b'x'*32})
        headers = csrf(http,'one')
        response = http.post('/api/v1/simulation/robots',headers=headers,
            json=dict(world_id='rubble/f1',robot_id=rid))
        assert response.status_code == 201,response.text
        assert len(relay.sent[0]['map_bindings']) == 1
        sent = C.SimMapBinding.model_validate(relay.sent[0]['map_bindings'][0])
        assert sent.world_id == 'rubble' and sent.ros_floor_id == 'f1'
        assert sim.app.state.manager.world_bindings[0]['world_id'] == 'rubble'
        realtime = http.app.state.realtime
        realtime.agents[rid] = SimpleNamespace(socket=SimpleNamespace(headers={
            'authorization':'Bearer '+relay.sent[0]['agent_token']}))
        try:
            batch = realtime.load_agent_batch()
            assert batch.floor_authority[rid][0] == response.json()['generation']
            assert any(b.world_id == 'rubble' for b in batch.floor_authority[rid][1])
        finally:
            realtime.agents.pop(rid)
        observed = context()
        observed.update(world_id='rubble',building_id=str(sent.building_id),floor_id=str(sent.floor_id),
            map_version_id=str(sent.map_version_id),sha256=sent.sha256,source_pgm_sha256=sent.source_pgm_sha256,
            spawn_floor_id='f1',current_floor_id='f1')
        assert matches_context(observed,[sent])
        assert not matches_context({**observed,'world_id':'warehouse'},[sent])
        assert http.delete('/api/v1/simulation/robots/'+rid,headers=headers).status_code == 204
