"""plant_a three-floor launch registration follows the contract world-to-floor table."""
from uuid import UUID

import pytest

from apps.contracts.models import SIM_WORLD_FLOORS, FloorContext
from foothold_agent.ros_bridge import floors
from foothold_agent.ros_bridge.floors import FloorBindings

ROBOT = '00000000-0000-4000-8000-000000000010'
BUILDING = '00000000-0000-4000-8000-000000000020'


def bindings(world='plant_a', names=('l1', 'l2', 'l3')):
    return [dict(world_id=world, building_id=BUILDING, ros_building_id=world,
        ros_floor_id=f, ros_map_version='gt-20261128', floor_id=str(UUID(int=i)),
        map_version_id=str(UUID(int=i+10)), sha256=str(i)*64, source_pgm_sha256=str(i+3)*64,
        source='SIMULATION', resolution=.05, origin=[0., 0., 0.], width=800, height=640)
        for i, f in enumerate(names, 1)]


def status(floor, spawn='l3', stamp=1.):
    b = next(b for b in bindings() if b['ros_floor_id'] == floor)
    return dict(schema='v2_map_status/1', map_frame='map', epoch=1, world_id='plant_a',
        building_id='plant_a', floor_id=floor, current_floor=floor, spawn_floor=spawn, floor_rev=2,
        floor_state='on_floor', floor_reason='ok', floor_src='gt_geometry', floor_confirm_sim_t=stamp,
        map_version='gt-20261128', source_pgm_sha256=b['source_pgm_sha256'], map_origin=b['origin'],
        run_id='run', map_source='gt_raster', map_accepting=True, sim_t=stamp,
        map=dict(width=800, height=640, resolution=.05, epoch=1, floor_rev=2, floor_id=floor))


def test_agent_floor_table_mirrors_the_contract():
    assert floors.WORLD_FLOORS == SIM_WORLD_FLOORS


@pytest.mark.parametrize('floor', ['l1', 'l2', 'l3'])
def test_plant_a_registration_yields_contract_valid_context_on_each_floor(floor):
    launch = FloorBindings(ROBOT, 3, 'run', 1, 'l3', bindings())
    context = launch.context(status(floor))
    assert context['world_id'] == 'plant_a' and context['current_floor_id'] == floor
    assert context['map_version_id'] == bindings()[int(floor[1]) - 1]['map_version_id']
    FloorContext.model_validate(context)


@pytest.mark.parametrize('spawn,values', [
    ('l1', bindings(names=('l1', 'l2'))),            # plant_a needs all three floors
    ('l1', bindings(names=('l1', 'l2', 'f1'))),      # foreign floor name
    ('f1', bindings()),                              # spawn floor not in plant_a
    ('l3', bindings('v5_building')),                 # v5_building has no l3
    ('l1', bindings('unknown_world')),
    ('l1', []),
])
def test_foreign_floor_registrations_are_refused(spawn, values):
    with pytest.raises(ValueError):
        FloorBindings(ROBOT, 3, 'run', 1, spawn, values)
