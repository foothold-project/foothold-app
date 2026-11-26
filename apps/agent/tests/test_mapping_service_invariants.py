"""Session ownership across link/start/stop/save transitions, using fakes only."""
import json
import threading
from collections import Counter
from types import SimpleNamespace as NS

import pytest

from test_slam_mapping import (runtime, command, pose, cloud, configure_dump,
    finish_dump, wait_for, FRONTEND, CLOUD, FINAL_POSE)


def drain(rt):
    rt.step()
    for future in (rt.report_future, rt.save_future):
        if future is not None:
            future.result(timeout=3)


def samples(rt, stamp):
    rt.receive(FRONTEND, pose(stamp=stamp))
    rt.receive(FINAL_POSE, pose(stamp=stamp))
    rt.receive(CLOUD, cloud(stamp=stamp))
    drain(rt)


@pytest.mark.parametrize('configured', [False, True], ids=['default-10s', 'dump'])
@pytest.mark.parametrize('seed_stale_cells', [False, True], ids=['input-fence', 'upload-fence'])
def test_rv504_offline_replacement_cannot_collect_or_upload_older_graph(
        tmp_path, configured, seed_stale_cells):
    clock = NS(t=0.)
    blocked, release = threading.Event(), threading.Event()
    sent = []

    def run(action, name):
        if action == 'stop':
            blocked.set()
            assert release.wait(3)
        return 3 if action == 'is-active' else 0

    rt = runtime(tmp_path, now=lambda: clock.t, service_run=run)
    rt.env['FH_MAPPING_SERVICE_CONTROL_ENABLED'] = 'true'
    rt.online = True
    if configured:
        configure_dump(rt, tmp_path)

    def request(sid, suffix, data):
        if suffix == 'bundle':
            sent.append((sid, json.loads(data)))
            return {'session_id': sid, 'status': 'RECEIVED_ONLY'}
        return {'accepted': True}

    rt.request = request
    try:
        rt.command(command()); drain(rt)
        wait_for(lambda: rt.services.status == 'STARTED' and not rt.services.starting)
        samples(rt, 1)
        assert rt.core.cells
        clock.t = 1.
        rt.online = False
        second = command(); rt.command(second); drain(rt)
        assert blocked.wait(1)  # rejection still requests cleanup of A
        assert rt.services.status != 'DISABLED'
        assert rt.core.error_code == 'MAPPING_SERVICES_FAILED'
        assert not rt.services_requested and rt.services.ready_at is None
        rt.online = True
        samples(rt, 2)
        assert not rt.core.cells and rt.last_odom is None
        assert all(not history for history in rt.pose_histories.values())
        if seed_stale_cells:
            # Independently exercise the upload guard even with a misleading
            # runtime status: only the configuration grants the exception.
            rt.services.status = 'DISABLED'
            rt.core.add_world([[1, 0, .3]], [0, 0, .3], [1, 0, 0, 0], stamp=2, frame='map')
        rt.command(command('save', second)); drain(rt)
        clock.t += 11
        for _ in range(8):
            drain(rt)
        assert not sent and rt.frozen is None and rt.save_future is None
        if not seed_stale_cells:
            assert not rt.core.cells
        assert rt.core.status != 'SAVED' and not rt.final_received
    finally:
        release.set(); rt.close()
        if rt.services.thread:
            rt.services.thread.join(3)
        rt.io.shutdown(wait=True)


@pytest.mark.parametrize('online', ['online', 'offline-request', 'offline-last-start'])
@pytest.mark.parametrize('stop', ['ok', 'fail', 'hang'])
@pytest.mark.parametrize('start', ['ok', 'fail'])
@pytest.mark.parametrize('save', ['before-ready', 'after-data'])
def test_two_session_lifecycle_invariants(tmp_path, online, stop, start, save):
    """36 schedules: RV-502/503/504 fences plus successful final/fallback saves."""
    clock = NS(t=0.)
    phase = NS(value='first')
    start_entered, start_release = threading.Event(), threading.Event()
    stop_entered, stop_release = threading.Event(), threading.Event()
    uploads, reports = [], []
    reached_started = set()
    active = set()

    def run(action, name):
        if action == 'is-active':
            return 0 if name in active else 3
        if action == 'start':
            if phase.value != 'first' and name == 'foothold-glim':
                start_entered.set()
                assert start_release.wait(3)
                if start == 'fail':
                    return 1
            active.add(name)
        if action == 'stop':
            if phase.value == 'saving':
                stop_entered.set()
                if stop == 'hang':
                    assert stop_release.wait(3)
                if stop != 'ok':
                    return 1
            active.discard(name)
        return 0

    rt = runtime(tmp_path, now=lambda: clock.t, service_run=run)
    rt.env.update(FH_MAPPING_SERVICE_CONTROL_ENABLED='true', FH_MAPPING_GLIM_DUMP_TIMEOUT_S='10')
    rt.online = True
    configure_dump(rt, tmp_path)

    def request(sid, suffix, data):
        body = json.loads(data)
        if suffix == 'bundle':
            assert sid in reached_started
            if body['slam_save'] == 'SLAM_SAVED':
                assert stop == 'ok' and not rt.services.owned
            uploads.append((sid, body))
            return {'session_id': sid, 'status': 'SAVED' if body['slam_save'] == 'SLAM_SAVED' else 'RECEIVED_ONLY'}
        if body['phase'] == 'SLAM_SAVED':
            assert sid in reached_started and stop == 'ok' and not rt.services.owned
        reports.append(body)
        return {'accepted': True}

    rt.request = request
    try:
        first = command(); rt.command(first); drain(rt)
        wait_for(lambda: rt.services.status == 'STARTED' and not rt.services.starting)
        reached_started.add(first['session_id'])
        samples(rt, 1)
        assert rt.core.cells and rt.last_odom is not None

        clock.t = 1.
        phase.value = 'saving' if online == 'offline-request' else 'replacing'
        rt.online = online != 'offline-request'
        second = command(); rt.command(second); drain(rt)
        sid = second['session_id']
        if online == 'offline-request':
            assert stop_entered.wait(1)
        else:
            assert start_entered.wait(1)  # B is blocked in its final start call
        samples(rt, 2)
        assert not rt.core.cells and rt.last_odom is None
        assert all(not history for history in rt.pose_histories.values())

        if online == 'offline-last-start':
            rt.online = False
        if save == 'before-ready':
            phase.value = 'saving'
            rt.command(command('save', second)); drain(rt)
        start_release.set()
        if stop == 'hang' and phase.value == 'saving':
            assert stop_entered.wait(1)
        else:
            wait_for(lambda: not rt.services.starting and not rt.services.pending)
        rt.online = True

        expected_started = online == 'online' and start == 'ok' and save == 'after-data'
        if expected_started:
            assert rt.services.status == 'STARTED' and rt.services.ready_at is not None
            reached_started.add(sid)
        else:
            assert rt.services.ready_at is None and not rt.session_services_ready()
        samples(rt, 3)
        assert bool(rt.core.cells) == expected_started
        if not expected_started:
            assert rt.last_odom is None
            assert all(not history for history in rt.pose_histories.values())

        if save == 'after-data':
            phase.value = 'saving'
            rt.command(command('save', second)); drain(rt)
        if expected_started:
            assert stop_entered.wait(1)
            if stop != 'hang':
                wait_for(lambda: rt.services.status == ('STOPPED' if stop == 'ok' else 'UNKNOWN'))
            # A complete receipt/files still cannot certify a hanging/failed stop.
            finish_dump(rt, [[2, 0, .3]], confirm_stopped=False)
        for second_elapsed in range(1, 32):
            clock.t = 1. + second_elapsed
            samples(rt, second_elapsed + 3)
            if not expected_started:
                assert not rt.core.cells and rt.last_odom is None
            assert all(count <= 1 for count in Counter(s for s, _ in uploads).values())
            if rt.final_received or rt.phase == 'SLAM_SAVED':
                assert expected_started and stop == 'ok' and not rt.services.owned
        assert len(uploads) == int(expected_started)
        if not expected_started:
            assert all(body['point_count'] == 0 and body['odom'] is None
                       and not body['voxels']['added'] for body in reports if body['session_id'] == sid)
        if expected_started:
            assert uploads[0][1]['slam_save'] == ('SLAM_SAVED' if stop == 'ok' else 'UNKNOWN')
        else:
            assert not rt.final_received and rt.frozen is None and rt.core.status != 'SAVED'
        # Recovery after the bound must not turn UNKNOWN into a second upload.
        phase.value = 'recovering'; stop_release.set(); rt.services.wake.set()
        wait_for(lambda: not rt.services.starting and not rt.services.owned)
        for _ in range(8):
            clock.t += 1; drain(rt)
        assert len(uploads) == int(expected_started)
    finally:
        phase.value = 'recovering'; start_release.set(); stop_release.set()
        rt.close()
        if rt.services.thread:
            rt.services.thread.join(3)
        rt.io.shutdown(wait=True)


def test_save_during_replacement_cleanup_cannot_be_cleared_by_successful_stop():
    from foothold_agent.mapping.services import Services

    entered, release = threading.Event(), threading.Event()
    calls = []

    def run(action, name):
        calls.append((action, name))
        if action == 'stop':
            entered.set()
            assert release.wait(3)
        return 3 if action == 'is-active' else 0

    services = Services({'FH_MAPPING_SERVICE_CONTROL_ENABLED': 'true'}, lambda: True, run=run)
    try:
        assert services.start()
        wait_for(lambda: services.status == 'STARTED' and not services.starting)
        assert services.start() and entered.wait(1)
        services.stop()  # successful old cleanup must not erase this cancellation
        release.set()
        wait_for(lambda: services.status == 'STOPPED' and not services.starting)
        assert services.ready_at is None and not services.owned
        assert len([call for call in calls if call[0] == 'start']) == 2
    finally:
        release.set(); services.close()
        if services.thread:
            services.thread.join(3)
