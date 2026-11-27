"""Old HTTP contract and spawned GLIM load; no real DDS/services or robot access."""
import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib
import json
import os
from pathlib import Path
import struct
import subprocess
import threading
import time
from types import SimpleNamespace as NS

import pytest
from pydantic import ValidationError

from foothold_agent.mapping.glim_preview import GlimPreviewProcess, MAX_PACKET
from foothold_agent.mapping.live import GlimLive
from foothold_agent.mapping.runtime import TransferError
from foothold_agent.slam_source import Source
from test_slam_mapping import runtime, command, pose, cloud, own_services, FRONTEND, CLOUD
from test_mapping_service_invariants import close_runtime, drain


@pytest.fixture
def old_contract(tmp_path, monkeypatch):
    """Load the actual pre-#517 contracts, rather than a permissive mock."""
    package = tmp_path/'rb517_old_contract'
    package.mkdir()
    (package/'__init__.py').write_text('')
    for name in ('models.py', 'mapping_sources.py', 'server_drive.py'):
        result = subprocess.run(['git', 'show', f'1de74ed1:apps/contracts/{name}'],
                                cwd=Path(__file__).resolve().parents[3], capture_output=True)
        if result.returncode:
            pytest.skip('historical contract commit 1de74ed1 unavailable in this checkout')
        (package/name).write_bytes(result.stdout)
    monkeypatch.syspath_prepend(str(tmp_path))
    return importlib.import_module('rb517_old_contract.models')


def test_old_http_contract_retries_422_and_completes_save(tmp_path, old_contract, caplog):
    attempts, bundles = [], []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            data = self.rfile.read(int(self.headers['Content-Length']))
            body = json.loads(data)
            status = 200
            if self.path.endswith('/progress'):
                attempts.append(body)
                try:
                    old_contract.AgentMappingUpdate.model_validate_json(data)
                    response = {'accepted': True}
                except ValidationError:
                    status, response = 422, {'detail': 'extra fields forbidden'}
            else:
                old_contract.MappingBundle.model_validate_json(data)
                bundles.append(body)
                response = {'session_id': body['session_id'], 'status': 'RECEIVED_ONLY'}
            payload = json.dumps(response).encode()
            self.send_response(status)
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    clock = NS(t=0.)
    rt = runtime(tmp_path, now=lambda: clock.t)
    rt.base = f'http://127.0.0.1:{server.server_port}/'
    rt.request = rt.http
    rt.online = True
    def flush():
        rt.step()
        for future in (rt.report_future, rt.save_future):
            if future is not None:
                future.result(timeout=10)
    try:
        start = command()
        rt.command(start)
        flush()
        assert len(attempts) == 2
        assert 'sources' in attempts[0] and 'glim_preview' not in attempts[0]
        assert 'sources' not in attempts[1] and 'glim_preview' not in attempts[1]
        assert attempts[0]['update_seq'] == attempts[1]['update_seq']
        rt.receive(FRONTEND, pose())
        rt.receive(CLOUD, cloud())
        clock.t = .25
        flush()
        rt.command(command('save', start))
        flush()
        clock.t = 11.
        for _ in range(12):
            flush()
        assert rt.core.status == 'SAVED' and len(bundles) == 1
        assert all('sources' not in body and 'glim_preview' not in body for body in attempts[1:])
        assert not rt.changes and not rt.tiles.pending
        assert len([r for r in caplog.records if 'progress rejected status=422' in r.message]) == 1
        # Capability fallback belongs to the session, never to all future ones.
        rt.command(command())
        flush()
        assert 'sources' in attempts[-2] and 'sources' not in attempts[-1]
        assert attempts[-2]['session_id'] != start['session_id']
    finally:
        close_runtime(rt)
        server.shutdown()
        server.server_close()
        server_thread.join(2)


@pytest.mark.parametrize('status', [400, 401, 403, 409, 500, None])
def test_only_422_enables_compatibility(tmp_path, status):
    rt = runtime(tmp_path)
    attempts = []
    def request(*args):
        attempts.append(args)
        raise TransferError('MAPPING_FAILED', '시험 실패', status=status)
    rt.request = request
    try:
        with pytest.raises(TransferError):
            rt.report_progress('session', b'{"sources":{}}')
        assert len(attempts) == 1 and not rt.legacy_report_sessions
    finally:
        close_runtime(rt)


def test_422_retry_failure_stays_legacy_without_repeated_downgrade(tmp_path, caplog):
    rt = runtime(tmp_path)
    attempts = []
    def request(sid, op, data):
        attempts.append(json.loads(data))
        raise TransferError('MAPPING_FAILED', '시험 실패', status=422)
    rt.request = request
    try:
        for _ in range(2):
            with pytest.raises(TransferError):
                rt.report_progress('session', b'{"sources":{},"glim_preview":{}}')
        assert attempts == [{'sources': {}, 'glim_preview': {}}, {}, {}]
        assert len([r for r in caplog.records if 'progress rejected status=422' in r.message]) == 1
    finally:
        close_runtime(rt)


def test_new_session_clears_diagnostic_receipts_position_and_rates(tmp_path):
    clock = NS(t=0.)
    rt = runtime(tmp_path, now=lambda: clock.t)
    try:
        rt.command(command())
        rt.step()
        rt.receive(FRONTEND, pose())
        rt.receive(CLOUD, cloud())
        rt.step()
        assert rt.sources_body()['point_lio']['position_valid']
        rt.command(command())
        rt.step()
        status = rt.sources_body()['point_lio']
        assert status['reason_code'] == 'MISSING_DATA' and not status['fresh']
        assert status['position_m'] is status['position_valid'] is None
        assert status['pose_age_s'] is status['cloud_age_s'] is None
        assert status['pose_hz'] == status['cloud_hz'] == 0
        rt.receive(FRONTEND, pose(stamp=2))
        rt.receive(CLOUD, cloud(stamp=2))
        rt.step()
        assert rt.sources_body()['point_lio']['fresh']
    finally:
        close_runtime(rt)


def large_fake_subscription(source, nic, callback):
    """Simulate Cyclone's sequence[uint8] C unpack/list conversion in child."""
    stop = threading.Event()
    def emit():
        raw = struct.pack('<fff', 1., 0., .3)*1_333_333  # 15,999,996 bytes
        while not stop.is_set():
            message = NS(data=list(struct.unpack(f'{len(raw)}B', raw)), width=1_333_333,
                         height=1, point_step=12, row_step=len(raw), is_bigendian=False,
                         fields=[NS(name=k, offset=i*4, datatype=7, count=1) for i, k in enumerate('xyz')],
                         header=NS(frame_id=source.frame, stamp=NS(sec=os.getpid(), nanosec=0)))
            callback(message)
            stop.wait(.1)
    threading.Thread(target=emit, daemon=True).start()
    return stop.set


def silent_subscription(source, nic, callback):
    return lambda: None


def test_spawned_16mb_decode_keeps_control_cadence_and_child_death_does_not_stop_map(tmp_path):
    rt = runtime(tmp_path)
    rt.online = True
    rt.command(command())
    drain(rt)
    own_services(rt)
    # The fake child opens no DDS participant and uses no real network NIC.
    child = rt.glim_preview
    child.start('synthetic', subscribe=large_fake_subscription)
    process = child.process
    assert process is not None and process.pid != os.getpid()
    ticks, previews, reports = [], [], []
    rt.request = lambda sid, op, data: reports.append(time.monotonic()) or {'accepted': True}

    async def control():
        deadline = time.monotonic()
        for _ in range(16):
            await asyncio.sleep(max(0, deadline-time.monotonic()))
            ticks.append(time.monotonic())
            deadline += .25

    async def observation():
        stamp = 1
        while len(ticks) < 16:
            rt.receive(FRONTEND, pose(stamp=stamp))
            rt.receive(CLOUD, cloud(stamp=stamp))
            stamp += 1
            await asyncio.to_thread(rt.step)
            if rt.glim_live.preview is not None:
                previews.append((time.monotonic(), rt.glim_live.preview.copy()))
            await asyncio.sleep(.02)

    async def exercise():
        await asyncio.gather(control(), observation())

    try:
        asyncio.run(exercise())
        assert previews and previews[-1][1]['stamp']['sec'] == process.pid
        assert max(abs(at-(ticks[0]+i*.25)) for i, at in enumerate(ticks)) < .075
        assert max(b-a for a, b in zip(ticks, ticks[1:])) < .325
        snapshots = {p['seq']: (at, p) for at, p in reversed(previews)}
        ordered = sorted(snapshots.values())
        # Arrival gaps can compress when the parent scheduler is delayed;
        # sequence counts bound output to <=1 Hz over the 3.75 s exercise.
        assert 2 <= len(ordered) <= 4 and max(snapshots) <= 4
        assert all(len(p['cells']) <= 1024 and len(json.dumps(p).encode()) < MAX_PACKET for _, p in previews)
        assert len(reports) >= 12 and max(b-a for a, b in zip(reports, reports[1:])) < .4
        assert rt.core.cells
        process.kill()
        process.join(3)
        child.poll(rt.glim_live, rt.not_before)
        assert '종료' in child.reason
        before = rt.core.session_id
        rt.receive(FRONTEND, pose(stamp=1000))
        rt.receive(CLOUD, cloud(points=((2., 0., .3),), stamp=1000))
        drain(rt)
        assert (40, 0, 6) in rt.core.cells and rt.core.session_id == before
        assert rt.sources_body()['glim']['reason'] == child.reason
        rt.command(command('save', {'session_id': before, 'floor_id': rt.core.floor_id}))
        drain(rt)
        rt.save_requested -= 11  # existing bounded UNKNOWN fallback, no service restart
        rt.request = lambda sid, op, data: {'session_id': sid, 'status': 'RECEIVED_ONLY'} if op == 'bundle' else {'accepted': True}
        for _ in range(12):
            drain(rt)
        assert rt.core.status == 'SAVED'
    finally:
        close_runtime(rt)


def test_preview_disabled_by_default_and_silent_child_reason():
    disabled = GlimPreviewProcess({})
    disabled.start('synthetic', subscribe=silent_subscription)
    assert disabled.process is None and disabled.reason is None
    clock = NS(t=time.monotonic())
    env = {'FH_MAPPING_GLIM_CLOUD_TOPIC': '/glim/map', 'FH_MAPPING_GLIM_ODOM_TOPIC': '/glim/pose', 'FH_MAPPING_GLIM_FRAME': 'map'}
    child = GlimPreviewProcess(env, lambda: clock.t)
    try:
        child.start('synthetic', subscribe=silent_subscription)
        clock.t += 4
        child.poll(GlimLive(Source(env, 'glim'), lambda: clock.t), 0.)
        assert '늦어' in child.reason
    finally:
        child.close()
