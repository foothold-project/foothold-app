"""Synthetic callback-order replay; no captured maps, identities, ROS or DDS."""
from copy import deepcopy

import pytest

from foothold_agent.link.session import Session
from foothold_agent.ros_bridge.node import Inputs
from foothold_agent.ros_bridge.telemetry import Telemetry
from test_floor_telemetry import launch, status
from test_ros_bridge import Clock, Loop, binding, make_sink, state, status as single_status


def floor_status(stamp, **changes):
    raw = status(stamp=stamp)
    # One confirmed floor revision remains stable as map/pose stamps advance.
    raw['floor_confirm_sim_t'] = 1.
    raw.update(changes)
    return raw


@pytest.mark.parametrize('coalesced', [False, True])
def test_replay_31_future_maps_recovers_on_following_state_and_reaches_wire(coalesced):
    clock, loop = Clock(), Loop()
    cache, session = Telemetry(now=clock, floors=launch()), Session(now=clock)
    sink, outputs = make_sink(clock)
    inputs = Inputs(loop, sink, session.on_robot_state, telemetry=cache,
                    now=clock, on_telemetry=session.update_telemetry)
    try:
        for i in range(31):
            sim_t = 1. + i * .4
            clock.t = i * .2
            inputs.state(state(sim_t=sim_t))
            loop.drain()
            lead = .04 + (i % 7) * .04  # observed failure's .04 .. .28 s lead
            raw = floor_status(sim_t + lead)
            receipt = clock.t + .01
            clock.t = receipt
            inputs.mailbox.put(map=(raw, receipt))
            if not coalesced:
                loop.drain()
                # The future sample never becomes visible before state catches up.
                pose = session._state()['pose']
                assert pose['x'] is None or cache.location['sim_t'] <= sim_t
                if i == 0:
                    assert pose.get('floor_context') is None
            clock.t += .01
            inputs.state(state(sim_t=raw['sim_t']))
            loop.drain()
            pose = session._state()['pose']
            assert pose['floor_context']['floor_state'] == 'on_floor'
            assert pose['x'] == 2.
            assert cache.location['sim_t'] == raw['sim_t']
            assert cache.location['received_monotonic_s'] == receipt
            assert cache._floor_received_at == receipt
        assert cache.map_received == 31
        assert cache.map_retries == (0 if coalesced else 31)
        assert cache.map_rejections['future'] == (0 if coalesced else 31)
        assert not outputs  # measurement recovery has no motion/authority output
    finally:
        sink.close()


def pending():
    clock = Clock()
    cache = Telemetry(now=clock, floors=launch())
    cache.update_state(state(), clock())
    cache.update_map(floor_status(1.2), clock())
    assert cache.snapshot()['floor_context'] is None
    return clock, cache


def test_only_latest_pending_map_is_retained_and_copied():
    clock, cache = pending()
    raw = floor_status(1.3, floor_rev=3)
    raw['map']['floor_rev'] = 3
    cache.update_map(raw, clock())
    raw['pose_map']['x'] = 999.
    cache.update_state(state(sim_t=1.2), clock())
    assert cache.snapshot()['floor_context'] is None
    cache.update_state(state(sim_t=1.3), clock())
    snap = cache.snapshot()
    assert snap['floor_context']['floor_rev'] == 3
    assert snap['location']['x'] == 2.
    assert cache._pending_map is None


@pytest.mark.parametrize('age,accepted', [(1., True), (1.001, False)])
def test_pending_receipt_keeps_exact_existing_stale_limit(age, accepted):
    clock, cache = pending()
    clock.t = age
    cache.update_state(state(sim_t=1.2), clock())
    snap = cache.snapshot()
    assert (snap['floor_context'] is not None) is accepted
    assert (snap['location'] is not None) is accepted
    if accepted:
        assert cache.location['received_monotonic_s'] == 0.
    else:
        assert cache.map_last_rejection == 'stale'
    assert cache._pending_map is None


@pytest.mark.parametrize('boundary', ['reset', 'invalid', 'rewind', 'episode', 'explicit'])
def test_pending_cannot_cross_state_invalidation_or_episode(boundary):
    clock, cache = pending()
    if boundary == 'explicit':
        cache.invalidate('mailbox_stale')
    else:
        raw = dict(reset=state(sim_t=1.1, reset_in_progress=True), invalid={},
                   rewind=state(sim_t=.9), episode=state(sim_t=1.2, episode=2))[boundary]
        cache.update_state(raw, clock())
    assert cache._pending_map is None
    cache.update_state(state(sim_t=1.3, episode=2 if boundary == 'episode' else 1), clock())
    assert cache.snapshot()['floor_context'] is None
    assert cache.snapshot()['location'] is None


@pytest.mark.parametrize('change', [dict(run_id='old'), dict(epoch=2), dict(floor_rev=1),
                                  dict(map_version='unregistered')])
def test_deferred_map_still_obeys_run_epoch_revision_and_binding_checks(change):
    clock = Clock()
    cache = Telemetry(now=clock, floors=launch())
    cache.update_state(state(), clock())
    cache.update_map(floor_status(1.), clock())
    expected = deepcopy(cache.floor_context)
    cache.update_map(floor_status(1.2, **change), clock())
    cache.update_state(state(sim_t=1.2), clock())
    snap = cache.snapshot()
    if 'map_version' in change:
        assert snap['floor_context']['reason'] == 'binding_mismatch'
        assert snap['location'] is None
    else:
        assert snap['floor_context'] == expected
    assert cache.map_last_rejection == 'mismatch'
    assert cache._pending_map is None


def test_stalled_source_and_same_stamp_updates_cannot_refresh_pending_map():
    clock, cache = pending()
    clock.t = 1.001
    cache.update_state(state(vx=.4), clock())  # same sim stamp, new receipt only
    assert cache.map_last_rejection == 'stale'
    assert cache._pending_map is None
    cache.update_state(state(sim_t=1.2), clock())
    assert cache.snapshot()['floor_context'] is None


def test_new_rejected_map_supersedes_pending_and_cannot_resurrect_it():
    clock, cache = pending()
    cache.update_map(floor_status(1.1, run_id='old'), clock())
    cache.update_state(state(sim_t=1.3), clock())
    assert cache.snapshot()['floor_context'] is None
    assert cache._pending_map is None


def test_single_binding_pose_future_uses_same_deferred_coherence():
    clock = Clock()
    cache = Telemetry(now=clock, binding=binding())
    cache.update_state(state(), clock())
    raw = single_status()
    raw['pose_map']['stamp_sim'] = 1.2
    cache.update_map(raw, clock())
    assert cache.snapshot()['location'] is None
    clock.t = .1
    cache.update_state(state(sim_t=1.2), clock())
    assert cache.snapshot()['location']['received_monotonic_s'] == 0.


def test_rejection_diagnostics_count_attempts_and_only_log_reason_changes(caplog):
    clock, cache = pending()
    for _ in range(20):
        cache.update_map(floor_status(1.2), clock())
    cache.update_state(state(sim_t=1.2), clock())
    cache.update_map(floor_status(1.3), clock())
    assert cache.map_rejections == dict(future=22, stale=0, mismatch=0)
    assert cache.map_last_rejection == 'future'
    assert len(caplog.records) == 1  # success does not restart repeated warnings
    clock.t = 1.001
    cache.update_state(state(sim_t=1.3), clock())
    cache.update_map(floor_status(1.3, run_id='secret-not-for-logs'), clock())
    assert cache.map_rejections == dict(future=22, stale=1, mismatch=1)
    assert cache.map_last_rejection == 'mismatch'
    assert len(caplog.records) == 3
    assert 'secret-not-for-logs' not in caplog.text
    assert 'pose_map' not in caplog.text
