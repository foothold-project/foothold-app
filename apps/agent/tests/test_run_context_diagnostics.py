"""Offline source cadence -> real telemetry, map predicate and run failure."""
from copy import deepcopy
import json
from types import SimpleNamespace

import pytest

from test_run_integration import local_maps
from test_scenario_run import r, start, uid
from test_ros_bridge import Clock, state
from foothold_agent.ros_bridge.floors import FloorBindings
from foothold_agent.ros_bridge.run_context import RunContext
from foothold_agent.ros_bridge.run_nav import RunNav, LIFECYCLE_NODES
from foothold_agent.ros_bridge.nav_odometry import SimOdom
from foothold_agent.ros_bridge.telemetry import Telemetry
from foothold_agent.safety.core import Z


def context_fixture(tmp_path, clock, actions):
    maps, request, plan, _, grid = local_maps(tmp_path)
    registration = maps.floors.bindings['f1']
    registration.update(building_id=uid(), ros_building_id='warehouse', ros_map_version='gt-20261012')
    maps.floors = FloorBindings(uid(), 1, 'episode-owner', 1, 'f1', [registration])
    telemetry = Telemetry(now=clock, floors=maps.floors)
    nav = RunNav.__new__(RunNav)
    nav.now, nav.map_identity, nav.odom_at = clock, True, clock()
    nav.clock = nav.scan = (10., clock())
    nav.odom = SimOdom(.25, .02, .15)
    nav.lifecycle = {name: (True, clock()) for name in LIFECYCLE_NODES}
    nav.health_observation = dict(ready=True, server_ready=True, observed_monotonic_s=clock())
    nav.grid_snapshot = lambda: deepcopy(grid)
    bridge = SimpleNamespace(extension=nav, inputs=SimpleNamespace(telemetry=telemetry))
    context = RunContext(bridge, maps, SimpleNamespace(actions=actions))

    def status(stamp):
        return dict(schema='v2_map_status/1', map_frame='map', epoch=1,
            world_id='warehouse', building_id='warehouse', floor_id='f1', current_floor='f1',
            spawn_floor='f1', floor_rev=1, floor_state='on_floor', floor_reason='ok',
            floor_src='gt_geometry', floor_confirm_sim_t=0., map_version='gt-20261012',
            map_source='gt_raster', map_accepting=True, run_id='episode-owner', sim_t=stamp,
            source_pgm_sha256=registration['source_pgm_sha256'], map_origin=registration['origin'],
            map=dict(width=2, height=2, resolution=.05, epoch=1, floor_rev=1, floor_id='f1'),
            pose_map=dict(source='gt_identity', stamp_sim=stamp, x=0., y=0., yaw=0.))
    return context, telemetry, request, plan, status, nav


@pytest.mark.parametrize('period,expected', [(1., 'FAILED'), (.2, 'MOVING')])
def test_40ms_delivery_delay_reproduces_1hz_gap_but_not_5hz(tmp_path, r, caplog, period, expected):
    context, cache, request, plan, status, _ = context_fixture(tmp_path, r.clock, r.actions)
    r.runs.context = context
    r.start.update(request)
    r.data['map_proofs'] = [plan.map_proof]
    r.data['waypoints'][0].update(request)
    r.clock.t = .04
    cache.update_state(state(sim_t=10.04), r.clock())
    cache.update_map(status(10.), r.clock())
    binding = start(r)
    next_delivery = period + .04
    for i in range(3, 151):
        r.clock.t = round(i*.02, 6)
        cache.update_state(state(sim_t=10.+r.clock()), r.clock())
        if r.clock() >= next_delivery:
            cache.update_map(status(round(10.+next_delivery-.04, 6)), r.clock())
            next_delivery = round(next_delivery+period, 6)
        r.state(False)
        r.send(r.peer, 'ping', client_time_ms=int(r.clock()*1000))
        r.runs.nav.intent(binding, Z)
        r.hub.tick()
        if not r.runs.active:
            break
    assert r.runs.snapshot()['status'] == expected
    logs = [record for record in caplog.records if record.message.startswith('LOCALIZATION_LOST context=')]
    if expected == 'FAILED':
        assert r.clock() == 1.02
        assert r.runs.snapshot()['fail_code'] == 'LOCALIZATION_LOST'
        assert len(logs) == 1
        detail = r.runs.current['failure_detail']['context']
        assert detail['nav_ready'] is True and detail['maps_match'] is False
        assert 'floor_context.present' in detail['map_failures']
        assert detail['telemetry']['state_floor_sim_delta_s'] == pytest.approx(1.02)
        assert detail['telemetry']['floor_receipt_age_s'] == pytest.approx(.98)
        assert r.hub.session.core.latch and r.outputs[-1].velocity == Z
        assert binding in r.actions.cancels and r.hub.session.lease_id is None
        r.hub.tick()
        assert len([x for x in caplog.records if x.message.startswith('LOCALIZATION_LOST context=')]) == 1
    else:
        assert not logs


@pytest.mark.parametrize('fault', ['stop', 'future', 'mismatch', 'replay_frozen', 'state_frozen'])
def test_5hz_never_masks_stopped_future_or_mismatched_sources(tmp_path, r, fault):
    context, cache, request, plan, status, _ = context_fixture(tmp_path, r.clock, r.actions)
    r.runs.context = context
    r.start.update(request)
    r.data['map_proofs'] = [plan.map_proof]
    r.data['waypoints'][0].update(request)
    cache.update_state(state(sim_t=10.), r.clock())
    cache.update_map(status(10.), r.clock())
    binding = start(r)
    for i in range(1, 151):
        r.clock.t = round(i*.02, 6)
        broken = r.clock() >= 2.
        cache.update_state(state(sim_t=11.98 if broken and fault == 'state_frozen' else 10.+r.clock()), r.clock())
        if i % 10 == 0 and not (broken and fault == 'stop'):
            raw = status(11.8 if broken and fault == 'replay_frozen' else 10.+r.clock())
            if broken and fault == 'future':
                raw['sim_t'] += 5.
                raw['pose_map']['stamp_sim'] += 5.
            if broken and fault == 'mismatch':
                raw['source_pgm_sha256'] = 'f'*64
            cache.update_map(raw, r.clock())
        r.state(False)
        r.send(r.peer, 'ping', client_time_ms=int(r.clock()*1000))
        r.runs.nav.intent(binding, Z)
        r.hub.tick()
        if not r.runs.active:
            break
    assert 2. <= r.clock() <= 3.
    assert r.runs.snapshot()['status'] == 'FAILED'
    assert r.runs.snapshot()['fail_code'] == 'LOCALIZATION_LOST'
    assert r.hub.session.core.latch and r.outputs[-1].velocity == Z
    assert binding in r.actions.cancels and r.hub.session.lease_id is None


def test_diagnostics_preserve_expired_evidence_and_never_expose_payloads(tmp_path):
    clock = Clock()
    context, cache, request, plan, status, nav = context_fixture(tmp_path, clock, SimpleNamespace(ready=lambda: False))
    cache.update_state(state(sim_t=10.), clock())
    cache.update_map(status(10.), clock())
    clock.t = 1.02
    nav.lifecycle['planner_server'] = (False, 0.)
    nav.odom.reason = 'SCAN_PAIR_NOT_READY'
    assert not context(request, plan)
    detail = context.failure_diagnostics()
    assert detail['nav_ready'] is False
    assert detail['telemetry']['state_receipt_age_s'] == 1.02
    assert detail['telemetry']['state_progress_age_s'] == 1.02
    assert detail['telemetry']['pose_receipt_age_s'] == 1.02
    assert detail['nav']['odom_reason'] == 'SCAN_PAIR_NOT_READY'
    assert detail['nav']['lifecycle']['planner_server']['active'] is False
    text = json.dumps(detail, allow_nan=False)
    assert 'token' not in text and 'image_path' not in text and '"x"' not in text


def test_pending_future_diagnostic_keeps_original_receipt_and_sim_difference(tmp_path):
    clock = Clock()
    context, cache, request, plan, status, _ = context_fixture(tmp_path, clock, SimpleNamespace(ready=lambda: True))
    cache.update_state(state(sim_t=10.), clock())
    cache.update_map(status(11.), clock())
    clock.t = .2
    assert not context(request, plan)
    detail = context.failure_diagnostics()['telemetry']
    assert detail['pending_map_receipt_age_s'] == .2
    assert detail['state_pending_map_sim_delta_s'] == -1.
    assert detail['state_pending_pose_sim_delta_s'] == -1.
    assert detail['map_last_rejection'] == 'future'


def test_missing_grid_diagnostic_uses_the_exact_failed_decision_snapshot(tmp_path):
    clock = Clock()
    context, cache, request, plan, status, nav = context_fixture(tmp_path, clock, SimpleNamespace(ready=lambda: True))
    cache.update_state(state(sim_t=10.), clock())
    cache.update_map(status(10.), clock())
    real_grid, reads = nav.grid_snapshot(), []
    def changing_grid():
        reads.append(True)
        return None if len(reads) == 1 else real_grid
    nav.grid_snapshot = changing_grid
    assert not context(request, plan)
    assert 'grid.present' in context.failure_diagnostics()['map_failures']
    assert len(reads) == 1


@pytest.mark.parametrize('pending', [False, True])
def test_both_failure_paths_log_local_detail_once(r, pending, caplog):
    binding = start(r)
    class Context:
        def __call__(self, *args): return False
        def failure_diagnostics(self): return dict(nav_ready=False, map_failures=['grid.sha256'])
    r.runs.context = Context()
    r.runs.next_goal_pending = pending
    r.runs.cancel_wait_started = r.clock()
    r.hub.tick()
    r.hub.tick()
    logs = [record for record in caplog.records if record.message.startswith('LOCALIZATION_LOST context=')]
    assert len(logs) == 1 and 'grid.sha256' in logs[0].message
    assert r.runs.current['failure_detail']['context']['nav_ready'] is False
    assert r.runs.snapshot()['fail_code'] == 'LOCALIZATION_LOST'
    assert r.hub.session.core.latch and r.outputs[-1].velocity == Z
    assert binding in r.actions.cancels


@pytest.mark.parametrize('pending', [False, True])
def test_context_failure_diagnostic_exception_cannot_suppress_halt(r, pending, caplog):
    binding = start(r)
    class BrokenContext:
        def __call__(self, *args): return False
        def failure_diagnostics(self): raise RuntimeError('private payload')
    r.runs.context = BrokenContext()
    r.runs.next_goal_pending = pending
    r.runs.cancel_wait_started = r.clock()
    r.hub.tick()
    assert r.runs.snapshot()['fail_code'] == 'LOCALIZATION_LOST'
    assert r.hub.session.core.latch and r.outputs[-1].velocity == Z
    assert binding in r.actions.cancels
    assert 'private payload' not in caplog.text


@pytest.mark.parametrize('field', ['world_id','floor_id','map_version_id','image_sha256','source_pgm_sha256','origin','resolution','width','height'])
def test_map_diagnostic_names_the_same_rejected_field(tmp_path, field):
    maps, request, plan, snapshot, grid = local_maps(tmp_path)
    assert not maps.mismatch_diagnostics(request, plan, snapshot, grid)
    plan.map_proof[field] = [9.,0.,0.] if field == 'origin' else 999 if field in ('resolution','width','height') else 'different'
    assert not maps.matches(request, plan, snapshot, grid)
    assert 'plan.' + field in maps.mismatch_diagnostics(request, plan, snapshot, grid)
