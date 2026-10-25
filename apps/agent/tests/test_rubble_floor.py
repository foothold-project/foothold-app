"""Rubble f1 must keep its own immutable identity all the way to the wire."""
from copy import deepcopy

import pytest

from apps.contracts import models as C
from foothold_agent.ros_bridge.floors import FloorBindings
from foothold_agent.ros_bridge.telemetry import Telemetry
from test_warehouse_floor import launch as warehouse_launch, warehouse_status
from test_floor_telemetry import ROBOT, update
from test_ros_bridge import Clock


def launch():
    b = deepcopy(warehouse_launch().bindings['f1'])
    b.update(world_id='rubble', ros_building_id='rubble', width=400, height=400, origin=[-10.,-10.,0.])
    C.SimMapBinding.model_validate(b)
    return FloorBindings(ROBOT,3,'run',1,'f1',[b])


def status():
    raw = warehouse_status()
    raw.update(world_id='rubble', building_id='rubble', map_origin=[-10.,-10.,0.])
    raw['map'].update(width=400,height=400)
    return raw


def test_rubble_registered_grid_and_contract_reach_telemetry():
    clock = Clock(); cache = Telemetry(now=clock, floors=launch())
    update(cache,status(),clock)
    snapshot = cache.snapshot()
    c = C.FloorContext.model_validate(snapshot['floor_context'])
    assert c.world_id == 'rubble' and c.current_floor_id == 'f1' and c.floor_state == 'on_floor'
    assert snapshot['location']['map_version_id'] == launch().bindings['f1']['map_version_id']


@pytest.mark.parametrize('change', [dict(world_id='warehouse'),dict(run_id='stale'),
    dict(floor_state='transit',current_floor=None),dict(current_floor='l1')])
def test_rubble_never_accepts_other_world_or_transit(change):
    clock = Clock(); cache = Telemetry(now=clock, floors=launch())
    raw = status(); raw.update(change); update(cache,raw,clock)
    assert cache.snapshot()['floor_context'] is None and cache.snapshot()['location'] is None


@pytest.mark.parametrize('field,value', [('sha256','f'*64),('ros_floor_id','l1'),('world_id','unknown')])
def test_rubble_binding_does_not_turn_f1_into_an_arbitrary_world(field,value):
    b = deepcopy(launch().bindings['f1']); b[field] = value
    if field == 'sha256':
        # Approved PNG digest differs from status's canonical PGM digest.
        raw = status(); raw['source_pgm_sha256'] = value
        assert launch().context(raw)['map_version_id'] is None
    else:
        with pytest.raises(ValueError):
            C.SimMapBinding.model_validate(b)
        with pytest.raises(ValueError):
            FloorBindings(ROBOT,3,'run',1,'f1',[b])
