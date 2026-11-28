"""World-to-floor table: plant_a l1/l2/l3 accepted, foreign floor names refused."""
from uuid import UUID

import pytest
from pydantic import ValidationError

from apps.contracts import models as C


def context(world_id, spawn, current):
    return dict(robot_id=str(UUID(int=10)), generation=3, run_id='run', epoch=1, floor_rev=2,
        world_id=world_id, building_id=str(UUID(int=20)), spawn_floor_id=spawn,
        current_floor_id=current, floor_id=None, map_version_id=None, sha256=None,
        source_pgm_sha256=None, source='gt_geometry',
        floor_state='on_floor' if current else 'transit', reason='ok', confirmed_sim_t=1.)


def binding(world_id, floor):
    return dict(world_id=world_id, building_id=str(UUID(int=20)), ros_building_id=world_id,
        ros_floor_id=floor, ros_map_version='gt-20261128', floor_id=str(UUID(int=1)),
        map_version_id=str(UUID(int=11)), sha256='1' * 64, source_pgm_sha256='3' * 64,
        resolution=.05, origin=(0., 0., 0.), width=2, height=2, source='SIMULATION')


def test_world_floor_table_is_the_single_source():
    assert C.SIM_WORLD_FLOORS == {'v5_building': ('l1', 'l2'), 'plant_a': ('l1', 'l2', 'l3'),
                                  'warehouse': ('f1',)}


@pytest.mark.parametrize('spawn,current', [('l1', 'l1'), ('l1', 'l3'), ('l3', 'l2'), ('l2', None)])
def test_plant_a_floor_context_accepts_its_three_floors(spawn, current):
    c = C.FloorContext.model_validate(context('plant_a', spawn, current))
    assert (c.world_id, c.spawn_floor_id, c.current_floor_id) == ('plant_a', spawn, current)


@pytest.mark.parametrize('world_id,spawn,current', [
    ('plant_a', 'f1', 'f1'), ('plant_a', 'l1', 'f1'), ('warehouse', 'l3', 'l3'),
    ('warehouse', 'f1', 'l3'), ('v5_building', 'l3', 'l3'), ('v5_building', 'l1', 'l3'),
    ('v5_building', 'f1', 'f1')])
def test_floor_context_refuses_floor_names_of_other_worlds(world_id, spawn, current):
    with pytest.raises(ValidationError):
        C.FloorContext.model_validate(context(world_id, spawn, current))


def test_sim_world_lists_and_starts_l3():
    assert C.SimWorld(id='plant_a', name='공정동 A', spawn_floor_ids=['l1', 'l2', 'l3']).spawn_floor_ids[-1] == 'l3'
    assert C.SimWorldStart(world_id='plant_a/l3').model_dump() == dict(world_id='plant_a', spawn_floor_id='l3')
    assert C.SimWorldStart(world_id='plant_a').spawn_floor_id == 'l1'
    assert C.SimWorldStart(world_id='plant_a', spawn_floor_id='l2').spawn_floor_id == 'l2'
    assert C.SimWorldStart(world_id='v5_building/l2').model_dump() == dict(world_id='v5_building', spawn_floor_id='l2')
    assert C.SimWorldStart(world_id='warehouse/f1').model_dump() == dict(world_id='warehouse/f1', spawn_floor_id=None)
    for raw in [dict(world_id='v5_building', spawn_floor_id='l3'), dict(world_id='v5_building/l3'),
                dict(world_id='plant_a/l2', spawn_floor_id='l3'), dict(world_id='plant_a/l4'),
                dict(world_id='warehouse/f1', spawn_floor_id='l3')]:
        with pytest.raises(ValidationError):
            C.SimWorldStart(**raw)


def test_map_binding_and_robot_accept_plant_a_l3_only():
    assert C.SimMapBinding.model_validate(binding('plant_a', 'l3')).ros_floor_id == 'l3'
    for world_id, floor in [('plant_a', 'f1'), ('v5_building', 'l3'), ('warehouse', 'l3')]:
        with pytest.raises(ValidationError):
            C.SimMapBinding.model_validate(binding(world_id, floor))
    provision = dict(world_id='plant_a', spawn_floor_id='l3', robot_id=str(UUID(int=5)),
        map_bindings=[binding('plant_a', f) for f in ('l1', 'l2', 'l3')], generation=1,
        owner_id=str(UUID(int=6)), org_id=str(UUID(int=7)), agent_token='x' * 32)
    assert len(C.SimProvision.model_validate(provision).map_bindings) == 3
    robot = dict(spawn_floor_id='l3', generation=1, robot_id=str(UUID(int=5)), owner_id=str(UUID(int=6)),
        world_id='plant_a', simulation=True, state='RUNNING', agent_address='ws://x', namespace='n',
        tf_prefix='t', command_topic='c', launcher='fake')
    assert C.SimRobot.model_validate(robot).spawn_floor_id == 'l3'
