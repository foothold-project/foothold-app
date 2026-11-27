"""Asymmetric Point-LIO rates with fake clocks and observation-only services."""
from types import SimpleNamespace as NS

import pytest

from foothold_agent.mapping.health import CLOUD_FRESH_SECONDS, PointLioHealth
from foothold_agent.slam_source import Source
from test_mapping_service_invariants import always_on_runtime, close_runtime, drain, prime, wait_for
from test_slam_mapping import CLOUD, FRONTEND, cloud, command, pose


def stamped(factory, seconds):
    message = factory()
    ns = 100_000_000_000+round(seconds*1_000_000_000)
    message.header.stamp.sec, message.header.stamp.nanosec = divmod(ns, 1_000_000_000)
    return message


@pytest.mark.parametrize('value,expected', [
    ('0.3', .3), ('5', 5.), ('2.1', 2.1), ('0.299', CLOUD_FRESH_SECONDS),
    ('5.001', CLOUD_FRESH_SECONDS), ('nan', CLOUD_FRESH_SECONDS),
    ('inf', CLOUD_FRESH_SECONDS), ('invalid', CLOUD_FRESH_SECONDS), (None, CLOUD_FRESH_SECONDS),
])
def test_cloud_freshness_configuration(value, expected, tmp_path):
    rt, _, _, _ = always_on_runtime(tmp_path)
    try:
        health = PointLioHealth(rt.live, rt.now, {'FH_MAPPING_POINTLIO_CLOUD_FRESH_S': value})
        assert health.cloud_fresh_seconds == expected
    finally:
        close_runtime(rt)


def test_cloud_uses_historical_pose_and_keeps_pair_as_latest_pose_advances():
    clock = NS(t=0.)
    health = PointLioHealth(Source({'FH_MAPPING_POINT_LIO_FRAME': 'map'}), lambda: clock.t)
    health.update({FRONTEND: (0., stamped(pose, 0.))})
    clock.t = .8
    health.update({FRONTEND: (.8, stamped(pose, .8)), CLOUD: (.8, stamped(cloud, 0.))})
    assert health.fresh()  # Latest pose is 800 ms ahead of this delayed cloud.
    for tick in range(2161, 4051):
        clock.t = tick/2700
        health.update({FRONTEND: (clock.t, stamped(pose, clock.t))})
    status = health.snapshot(True, 2700, 3)
    assert status['fresh'] and status['reason_code'] is None
    clock.t += .501
    assert not health.fresh()  # Pose still has its original 500 ms limit.
    assert health.snapshot(True, 0, 0)['reason_code'] == 'STALE'


def test_no_pose_within_300ms_reports_skew_then_recovers_with_matching_pose():
    clock = NS(t=0.)
    health = PointLioHealth(Source({'FH_MAPPING_POINT_LIO_FRAME': 'map'}), lambda: clock.t)
    health.update({FRONTEND: (0., stamped(pose, 0.)), CLOUD: (0., stamped(cloud, .3))})
    assert not health.fresh()
    assert health.snapshot(True, 2700, 3)['reason_code'] == 'STAMP_SKEW'
    clock.t = .1
    health.update({FRONTEND: (.1, stamped(pose, .3))})
    assert health.fresh()


def test_cloud_expiry_reason_uses_unrounded_age_and_rejects_future_receipt():
    clock = NS(t=0.)
    health = PointLioHealth(Source({'FH_MAPPING_POINT_LIO_FRAME': 'map'}), lambda: clock.t)
    health.update({FRONTEND: (0., stamped(pose, 0.)), CLOUD: (0., stamped(cloud, 0.))})
    clock.t = 1.5
    health.update({FRONTEND: (1.5, stamped(pose, 1.5))})
    assert health.fresh()
    clock.t += .0001
    status = health.snapshot(True, 2700, 3)
    assert status['cloud_age_s'] == 1.5 and status['reason_code'] == 'STALE'
    health.update({CLOUD: (clock.t+.1, stamped(cloud, 2.))})
    assert health.error and not health.fresh()
    assert health.snapshot(True, 2700, 3)['reason_code'] == 'STALE'


def test_three_hz_cloud_with_1200ms_gap_and_2700hz_pose_starts_and_waits_after_loss(tmp_path):
    rt, clock, _, _ = always_on_runtime(tmp_path)
    # Nominal 3 Hz, with one 1.2 s interval matching the requested slow burst.
    cloud_ticks = {0, 900, 1800, 5040, 5940, 6840, 7740, 8640, 9540, 10440}
    try:
        for tick in range(16201):
            clock.t = tick/2700
            rt.receive(FRONTEND, stamped(pose, clock.t))
            if tick in cloud_ticks:
                rt.receive(CLOUD, stamped(cloud, clock.t))
            if tick % 135:
                continue  # Same latest-only callback mailbox, drained at 20 Hz.
            drain(rt)
            status = rt.sources_body()['point_lio']
            if tick <= 10440:
                assert status['fresh'] and status['reason_code'] is None
                assert rt.input_wait_since is None
            if tick == 4050:  # Latest cloud already 833 ms old at start.
                rt.command(command())
                drain(rt)
                wait_for(lambda: rt.services.status == 'STARTED' and not rt.services.starting)
                assert rt.services.ready_at is not None
            if 5400 <= tick <= 10440:
                assert rt.core.status == 'RUNNING'
        assert clock.t-10440/2700 > 2
        assert status['reason_code'] == 'STALE' and not status['fresh']
        assert rt.core.error_code == 'MAPPING_INPUT_WAITING'
        assert rt.input_wait_since == pytest.approx(10440/2700+1.5)
        assert rt.services_fault is None and rt.core.cells
    finally:
        close_runtime(rt)


def test_world_accumulator_uses_pose_nearest_cloud_instead_of_latest(tmp_path):
    rt, clock, _, _ = always_on_runtime(tmp_path)
    try:
        prime(rt)
        rt.command(command())
        drain(rt)
        wait_for(lambda: rt.services.status == 'STARTED' and not rt.services.starting)
        clock.t = .1
        old = stamped(pose, .1)
        old.pose.pose.position.x = .1
        rt.receive(FRONTEND, old)
        drain(rt)
        clock.t = .8
        latest = stamped(pose, .8)
        latest.pose.pose.position.x = .8
        rt.receive(FRONTEND, latest)
        rt.receive(CLOUD, stamped(cloud, .1))
        drain(rt)
        assert rt.pointlio.fresh() and rt.core.error_code is None
        assert rt.core.last_pose == (.1, 0., .3)
        assert rt.last_odom['x'] == .8
    finally:
        close_runtime(rt)
