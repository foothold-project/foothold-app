"""Warehouse registration uses the existing floor -> telemetry -> wire path."""
from copy import deepcopy

import pytest

from apps.contracts import models as C
from foothold_agent.ros_bridge.floors import FloorBindings
from foothold_agent.ros_bridge.telemetry import Telemetry
from foothold_agent.link.session import Session
from test_floor_telemetry import ROBOT, bindings, status, update
from test_ros_bridge import Clock, state


def launch():
    b = bindings()[0]
    b.update(world_id='warehouse', ros_building_id='warehouse', ros_floor_id='f1',
        origin=[-7.5,-11.,0.], width=300, height=440)
    return FloorBindings(ROBOT, 3, 'run', 1, 'f1', [b])


def warehouse_status(stamp=1.):
    raw = status(stamp=stamp)
    b = launch().bindings['f1']
    raw.update(world_id='warehouse', building_id='warehouse', floor_id='f1', current_floor='f1',
        spawn_floor='f1', floor_rev=1, floor_confirm_sim_t=0., map_origin=b['origin'])
    raw['map'].update(floor_id='f1', floor_rev=1, width=300, height=440)
    return raw


def test_warehouse_native_context_reaches_phone_and_survives_new_epoch_without_motion_changes():
    clock = Clock()
    cache, session = Telemetry(now=clock, floors=launch()), Session(now=clock)
    before = (session.core.latch, session.core.stop_gen, session.core.out)
    for epoch, stamp in [(1, 1.), (1, 1.2), (2, .2)]:
        raw = warehouse_status(stamp)
        raw['epoch'] = raw['map']['epoch'] = epoch
        update(cache, raw, clock)
        session.update_telemetry(cache.snapshot())
        pose = session._state()['pose']
        C.AgentPose.model_validate(pose)
        c = C.FloorContext.model_validate(pose['floor_context'])
        assert c.world_id == 'warehouse' and c.current_floor_id == 'f1'
        assert c.floor_state == 'on_floor' and c.epoch == epoch
        assert pose['x'] == 2. and pose['map_version_id'] == launch().bindings['f1']['map_version_id']
    assert (session.core.latch, session.core.stop_gen, session.core.out) == before
    clock.t = 1.001
    cache.update_state(state(sim_t=2., episode=2), clock())
    assert cache.snapshot()['location'] is None and cache.snapshot()['floor_context'] is None


@pytest.mark.parametrize('change', [dict(world_id='v5_building'), dict(run_id='old'),
    dict(floor_state='transit', current_floor=None), dict(current_floor='l1')])
def test_warehouse_rejects_other_world_run_and_transit(change):
    clock = Clock(); cache = Telemetry(now=clock, floors=launch())
    raw = warehouse_status(); raw.update(change)
    update(cache, raw, clock)
    assert cache.snapshot()['floor_context'] is None and cache.snapshot()['location'] is None


@pytest.mark.parametrize('change', [dict(source_pgm_sha256='f'*64), dict(map_origin=[0,0,0]),
    dict(map_version='wrong'), dict(map=dict(width=301,height=440,resolution=.05,epoch=1,floor_id='f1',floor_rev=1))])
def test_warehouse_coordinate_hash_and_grid_mismatches_never_paint_pose(change):
    clock = Clock(); cache = Telemetry(now=clock, floors=launch())
    raw = warehouse_status(); raw.update(change)
    update(cache, raw, clock)
    snap = cache.snapshot()
    assert snap['location'] is None and snap['floor_context']['reason'] == 'binding_mismatch'
    C.FloorContext.model_validate(snap['floor_context'])


def test_warehouse_contract_does_not_accept_connected_floor_aliases():
    b = deepcopy(launch().bindings['f1'])
    C.SimMapBinding.model_validate(b)
    for world, floor in [('warehouse','l1'), ('v5_building','f1')]:
        with pytest.raises(ValueError):
            C.SimMapBinding.model_validate({**b,'world_id':world,'ros_floor_id':floor})
