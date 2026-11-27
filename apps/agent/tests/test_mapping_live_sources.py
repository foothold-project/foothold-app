"""Synthetic source diagnostics and bounded GLIM observation, no ROS/service access."""
import json
from types import SimpleNamespace as NS

import pytest

from apps.contracts import models as C
from foothold_agent.mapping.health import PointLioHealth
from foothold_agent.slam_source import Source
from test_slam_mapping import runtime, command, cloud, pose, own_services, FRONTEND, CLOUD, MAP, FINAL_POSE
from test_mapping_service_invariants import always_on_runtime, close_runtime, drain, wait_for


@pytest.mark.parametrize('failure,code', [
    ('range', 'POSITION_OUT_OF_RANGE'), ('jump', 'POSITION_JUMP'),
    ('stamp', 'STAMP_REGRESSION'), ('frame', 'FRAME_MISMATCH'),
    ('cloud_frame', 'FRAME_MISMATCH'), ('nan', 'INVALID_DATA'), ('stale', 'STALE')])
def test_precise_pointlio_fault(failure, code):
    clock = NS(t=0.)
    health = PointLioHealth(Source({'FH_MAPPING_POINT_LIO_FRAME': 'map'}), lambda: clock.t)
    health.update({FRONTEND: (0., pose()), CLOUD: (0., cloud())})
    assert health.fresh()
    sample = pose(stamp=2)
    topic = FRONTEND
    if failure == 'range': sample.pose.pose.position.x = 30000.
    if failure == 'jump': sample.pose.pose.position.x = 2.01
    if failure == 'stamp': sample.header.stamp.sec, sample.header.stamp.nanosec = 0, 1
    if failure == 'frame': sample.header.frame_id = 'wrong'
    if failure == 'cloud_frame': topic, sample = CLOUD, cloud(stamp=2, frame='wrong')
    if failure == 'nan': sample.pose.pose.position.x = float('nan')
    if failure == 'stale': clock.t = 1.
    health.update({topic: (0., sample)})
    status = health.snapshot(True, 10, 10)
    assert status['reason_code'] == code and status['reason'] and not status['fresh']
    if failure == 'range': assert status['position_m'][0] == 30000
    assert C.MappingPointLioStatus.model_validate(status)


def test_age_rate_and_position_rounding_even_without_service_control(tmp_path):
    clock = NS(t=0.)
    rt = runtime(tmp_path, now=lambda: clock.t)
    try:
        rt.command(command())
        rt.step()
        sample = pose()
        sample.pose.pose.position.x = 1.23456
        for _ in range(20):
            rt.receive(FRONTEND, sample)
            rt.receive(CLOUD, cloud())
        rt.step()
        status = rt.sources_body()['point_lio']
        assert status['active'] is None and status['fresh']
        assert status['position_m'] == (1.23, 0., .3)
        assert status['pose_hz'] == status['cloud_hz'] == 20  # callback counts, not drained samples
        clock.t = .6
        status = rt.sources_body()['point_lio']
        assert not status['fresh'] and status['reason_code'] == 'STALE'
        assert status['pose_age_s'] == status['cloud_age_s'] == .6
        clock.t = 1.1
        assert rt.sources_body()['point_lio']['pose_hz'] == 0
    finally:
        close_runtime(rt)


@pytest.mark.parametrize('failure,code', [('range', 'POSITION_OUT_OF_RANGE'), ('missing', 'MISSING_DATA'),
                                       ('stale', 'STALE'), ('off', None)])
def test_start_refusal_report_contains_sources(tmp_path, failure, code):
    rt, clock, active, _ = always_on_runtime(tmp_path)
    try:
        sample = pose()
        if failure == 'range': sample.pose.pose.position.x = 40000.
        if failure != 'missing':
            rt.receive(FRONTEND, sample)
            rt.receive(CLOUD, cloud())
        drain(rt)
        if failure == 'stale': clock.t = 1.
        if failure == 'off': active.clear()
        rt.command(command())
        drain(rt)
        wait_for(lambda: rt.services.status == 'STOPPED' and not rt.services.starting)
        drain(rt)
        body = rt.report_body()[0]
        status = body['sources']['point_lio']
        assert body['status'] == 'UNKNOWN' and status['reason_code'] == code
        assert status['active'] == (failure != 'off')
        assert body['sources']['glim']['stage'] == 'UNKNOWN'
        assert C.AgentMappingUpdate.model_validate_json(json.dumps(body))
    finally:
        close_runtime(rt)


def test_glim_preview_subscription_stages_and_isolation(tmp_path):
    clock = NS(t=0.)
    rt = runtime(tmp_path, now=lambda: clock.t)
    subscribed = []
    rt.channel = NS(cloud_bus=NS(subscribe=lambda topic, *a, **k:
        subscribed.append(topic) or NS(Close=lambda: None)))
    try:
        rt.acquire()
        assert MAP in subscribed and FINAL_POSE in subscribed
        rt.command(command())
        rt.step()
        assert rt.sources_body()['glim']['stage'] == 'OFF'
        rt.services.status = 'STARTING'
        assert rt.sources_body()['glim']['stage'] == 'STARTING'
        own_services(rt)
        rt.receive(FRONTEND, pose())
        rt.receive(CLOUD, cloud())
        # Distinct frame/coordinates are a separate preview, never the live pair.
        rt.receive(MAP, cloud([[-1.01, 4.2, .3]], frame='map'))
        rt.step()
        body = rt.report_body()[0]
        assert body['sources']['glim']['stage'] == 'RECEIVING'
        assert body['glim_preview']['cells'] == [(-5, 16, 1)]
        assert body['source'] == 'point_lio' and body['revision'] == 1
        assert not rt.final_received and rt.frozen is None
        assert (-21, 84, 6) not in rt.core.cells
        assert C.AgentMappingUpdate.model_validate_json(json.dumps(body))
        rt.save_requested = 0.
        assert rt.sources_body()['glim']['stage'] == 'SAVING'
        rt.core.status = 'SAVED'
        rt.services.owned.clear()
        rt.services.status = 'STOPPED'
        assert rt.sources_body()['glim']['stage'] == 'OFF'
    finally:
        close_runtime(rt)


def test_glim_decode_and_send_once_a_second_report_budget_and_failed_retry(tmp_path):
    clock = NS(t=0.)
    sent = []
    def request(sid, op, data):
        body = json.loads(data)
        sent.append((clock.t, body, len(data)))
        if len(sent) == 1: raise OSError('synthetic failed delivery')
        return {'accepted': True}
    rt = runtime(tmp_path, now=lambda: clock.t)
    rt.request = request
    try:
        rt.command(command())
        rt.step()
        own_services(rt)
        rt.online = True
        for tick in range(9):
            clock.t = tick*.25
            rt.receive(FRONTEND, pose(stamp=tick+1))
            rt.receive(CLOUD, cloud(stamp=tick+1))
            rt.receive(MAP, cloud([[i*9., i*9., i*9.] for i in range(1024)], stamp=tick+1))
            rt.step()
            try:
                rt.report_future.result(timeout=3)
            except OSError:
                pass  # runtime must regenerate the next bounded report
            rt.step()  # acknowledge completed report
        previews = [(at, body['glim_preview']) for at, body, _ in sent if body.get('glim_preview')]
        assert [at for at, _ in previews] == [0., 1., 2.]
        assert rt.glim_live.seq == 3
        assert all(size <= 65536 for _, _, size in sent)
        assert len(sent) == 9  # ordinary progress keeps its 0.25 second cadence
        assert all(len(preview['cells']) <= 1024 for _, preview in previews)
        assert previews[-1][1]['seq'] == 3  # failed first delivery does not stall latest snapshot
    finally:
        close_runtime(rt)


def test_invalid_glim_and_prestart_samples_do_not_claim_receiving(tmp_path):
    clock = NS(t=0.)
    rt = runtime(tmp_path, now=lambda: clock.t)
    try:
        rt.command(command())
        rt.step()
        own_services(rt)
        rt.glim_live.update({MAP: (-1., cloud())}, 0.)
        rt.receive(MAP, cloud(frame='wrong'))
        rt.step()
        assert rt.glim_live.preview is None
        assert rt.sources_body()['glim']['stage'] == 'STARTING'
        assert rt.source is rt.live and not rt.final_received
    finally:
        close_runtime(rt)


def test_large_report_defers_existing_cells_without_losing_glim_or_diagnostics(tmp_path):
    from collections import OrderedDict
    rt = runtime(tmp_path, now=lambda: 0.)
    delivered = []
    rt.request = lambda sid, op, data: delivered.append(data) or {'accepted': True}
    try:
        rt.command(command())
        rt.step()
        own_services(rt)
        rt.receive(FRONTEND, pose())
        rt.receive(CLOUD, cloud())
        rt.receive(MAP, cloud([[i*9., i*9., i*9.] for i in range(1024)]))
        rt.step()
        rt.changes = OrderedDict(((190000+i, -190000, 190000), (True, 1)) for i in range(2000))
        rt.online = True
        rt.step()
        rt.report_future.result(timeout=3)
        body = json.loads(delivered[0])
        assert len(delivered[0]) <= 65536
        assert body['sources'] and len(body['glim_preview']['cells']) == 1024
        assert len(body['voxels']['added']) < 2000
        rt.step()  # only the transmitted delta is acknowledged
        assert len(rt.changes) == 2000-len(body['voxels']['added'])
    finally:
        close_runtime(rt)
