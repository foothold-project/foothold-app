"""Launch registration -> fake ROS -> Session/phone wire, no DDS or motion output."""
from copy import deepcopy
from uuid import UUID

import pytest

from apps.contracts.models import AgentPose, FloorContext, PhoneState
from foothold_agent.ros_bridge.floors import FloorBindings
from foothold_agent.ros_bridge.telemetry import Telemetry
from foothold_agent.link.session import Session
from test_ros_bridge import Clock, state

ROBOT = '00000000-0000-4000-8000-000000000010'
BUILDING = '00000000-0000-4000-8000-000000000020'


def bindings():
    return [dict(world_id='v5_building', building_id=BUILDING, ros_building_id='v5',
        ros_floor_id=f, ros_map_version='gt-20261012', floor_id=str(UUID(int=i)),
        map_version_id=str(UUID(int=i+10)), sha256=str(i)*64, source_pgm_sha256=str(i+2)*64,
        source='SIMULATION', resolution=.05, origin=[-20., -14., 0.], width=800, height=640)
        for f, i in [('l1', 1), ('l2', 2)]]


def launch():
    return FloorBindings(ROBOT, 3, 'run', 1, 'l1', bindings())


def status(floor='l1', rev=2, stamp=1., **kw):
    b = next((b for b in bindings() if b['ros_floor_id'] == floor), bindings()[0])
    return dict(schema='v2_map_status/1', map_frame='map', epoch=1, world_id='v5_building',
        building_id='v5', floor_id=floor, current_floor=floor, spawn_floor='l1', floor_rev=rev,
        floor_state='on_floor' if floor else 'transit', floor_reason='ok' if floor else 'connector_ramp',
        floor_src='gt_geometry', floor_confirm_sim_t=stamp, map_version='gt-20261012',
        source_pgm_sha256=b['source_pgm_sha256'], map_origin=b['origin'], run_id='run',
        map_source='gt_raster', map_accepting=True, sim_t=stamp,
        map=dict(width=800, height=640, resolution=.05, epoch=1, floor_rev=rev, floor_id=floor),
        pose_map=dict(source='gt_identity', stamp_sim=stamp, x=2., y=3., yaw=.25), **kw)


def update(cache, raw, clock):
    cache.update_state(state(sim_t=raw['sim_t'], episode=raw['epoch']), clock())
    cache.update_map(raw, clock())


def test_up_return_transit_wire_keeps_registered_version_and_no_authority_effects():
    clock = Clock()
    cache, session = Telemetry(now=clock, floors=launch()), Session(now=clock)
    before = (session.core.latch, session.core.stop_gen, session.core.state_t, session.core.out)
    for raw, floor in [(status(), 'l1'), (status(None, 3, 2.), None),
                        (status('l2', 4, 3.), 'l2'), (status(None, 5, 4.), None),
                        (status('l1', 6, 5.), 'l1')]:
        update(cache, raw, clock)
        session.update_telemetry(cache.snapshot())
        pose = session._state()['pose']
        ctx = FloorContext.model_validate(pose['floor_context'])
        assert ctx.current_floor_id == floor and ctx.floor_rev == raw['floor_rev']
        assert ctx.generation == 3 and str(ctx.robot_id) == ROBOT
        if floor:
            b = bindings()[0 if floor == 'l1' else 1]
            assert pose['map_version_id'] == b['map_version_id'] and pose['floor_id'] == b['floor_id']
            assert ctx.sha256 == b['sha256'] and ctx.source_pgm_sha256 == b['source_pgm_sha256']
        else:
            assert pose['x'] is None and pose['map_version_id'] is None
        AgentPose.model_validate(pose)
    assert (session.core.latch, session.core.stop_gen, session.core.state_t, session.core.out) == before


@pytest.mark.parametrize('change', [dict(source_pgm_sha256='f'*64), dict(map_origin=[0., 0., 0.]),
    dict(map_version='wrong'), dict(building_id='wrong'), dict(map_error='failed')])
def test_mismatched_grid_keeps_error_context_with_no_pose(change):
    clock = Clock(); cache = Telemetry(now=clock, floors=launch())
    raw = status(); raw.update(change)
    update(cache, raw, clock)
    snap = cache.snapshot()
    assert snap['location'] is None and snap['floor_context']['reason'] == 'binding_mismatch'
    assert snap['floor_context']['map_version_id'] is None and snap['speed'] == .5


def test_late_floor_and_prior_run_reset_response_cannot_replace_current_context():
    clock = Clock(); cache = Telemetry(now=clock, floors=launch())
    update(cache, status('l1', 6, 5.), clock)
    expected = cache.snapshot()['floor_context']
    for raw in [status('l2', 4, 5.), {**status('l2', 8, 5.), 'run_id': 'old'},
                {**status('l2', 6, 5.), 'floor_confirm_sim_t': 4.}]:
        cache.update_map(raw, clock())
        assert cache.snapshot()['floor_context'] == expected
    cache.update_state(state(sim_t=.1, episode=2, reset_in_progress=True), clock())
    assert cache.snapshot()['floor_context'] is None
    cache.update_map(status('l2', 6, 5.), clock())
    assert cache.snapshot()['location'] is None
    fresh = status('l1', 8, .2); fresh['epoch'] = fresh['map']['epoch'] = 2
    update(cache, fresh, clock)
    assert cache.snapshot()['floor_context']['epoch'] == 2
    assert cache.snapshot()['floor_context']['floor_rev'] == 8


@pytest.mark.parametrize('mutate', [lambda b: b.pop(), lambda b: b.append(deepcopy(b[0])),
    lambda b: b[0].update(source='REAL'), lambda b: b[1].update(building_id=str(UUID(int=9))),
    lambda b: b[0].update(source_pgm_sha256='bad')])
def test_incomplete_or_unverified_launch_registration_rejected(mutate):
    values = bindings(); mutate(values)
    with pytest.raises((ValueError, KeyError)):
        FloorBindings(ROBOT, 3, 'run', 1, 'l1', values)


def test_floor_context_expires_with_source_and_pose_independently():
    clock = Clock(); cache = Telemetry(now=clock, floors=launch()); session = Session(now=clock)
    update(cache, status(), clock)
    session.update_telemetry(cache.snapshot())
    assert session._state()['pose']['floor_context']['floor_state'] == 'on_floor'
    clock.t = 1.001
    assert all(v is None for v in session._state()['pose'].values())


def test_transit_unknown_reason_changes_with_same_revision_are_visible():
    clock = Clock(); cache = Telemetry(now=clock, floors=launch())
    update(cache, status(None, 3, 2.), clock)
    bad = status(None, 3, 2.1)
    bad.update(floor_state='unknown', floor_reason='support_nan')
    update(cache, bad, clock)
    assert cache.snapshot()['floor_context']['floor_state'] == 'unknown'
    assert cache.snapshot()['floor_context']['reason'] == 'support_nan'
    assert cache.snapshot()['location'] is None


def test_map_status_stall_expires_context_even_while_robot_state_progresses():
    clock = Clock(); cache = Telemetry(now=clock, floors=launch())
    update(cache, status(), clock)
    clock.t = 1.001
    cache.update_state(state(sim_t=2.), clock())
    snap = cache.snapshot()
    assert snap['speed'] == .5 and snap['floor_context'] is None and snap['location'] is None


def test_phone_state_context_transit_keeps_manual_motion_and_existing_stop():
    from test_phone import Harness
    h = Harness()
    peer, _ = h.moving()
    floors = FloorBindings(h.robot, 3, 'run', 1, 'l1', bindings())
    cache = Telemetry(now=h.clock, floors=floors)
    for raw in (status(), status(None, 3, 2.)):
        update(cache, raw, h.clock)
        h.hub.session.update_telemetry(cache.snapshot())
        wire = h.hub.state(peer)
        PhoneState.model_validate(wire)
        assert wire['pose']['floor_context']['floor_state'] == raw['floor_state']
        assert h.hub.session.core.out[0] > 0
    h.hub.stop()
    assert h.hub.session.core.out == (0., 0., 0.) and h.hub.session.core.latch


@pytest.mark.parametrize('field,value', [('map_version_id', None), ('map_version_id', 'invalid'),
    ('map_version_id', str(UUID(int=999))), ('floor_id', str(UUID(int=999)))])
def test_session_never_pairs_pose_with_an_absent_or_different_grid(field, value):
    clock = Clock(); cache = Telemetry(now=clock, floors=launch()); session = Session(now=clock)
    update(cache, status(), clock)
    snap = cache.snapshot(); snap['location'][field] = value
    session.update_telemetry(snap)
    assert session._state()['pose']['x'] is None
    assert session._state()['pose']['map_version_id'] is None
