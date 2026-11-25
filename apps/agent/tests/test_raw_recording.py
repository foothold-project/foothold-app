"""Local fake process/service tests; no ROS, systemctl or robot connection."""
import asyncio
from pathlib import Path
import signal
import subprocess
import threading
import time
from types import SimpleNamespace as NS
from uuid import uuid4

import pytest

from foothold_agent.mapping.raw_recording import MAX_BYTES, MIN_FREE_BYTES, RawRecorder
from test_slam_mapping import CLOUD, FRONTEND, cloud, command, pose, runtime, wait_for


class FakeProcess:
    def __init__(self, pid):
        self.pid = pid
        self.returncode = None
        self.reaped = False
        self.release = threading.Event()

    def poll(self):
        return self.returncode

    def wait(self, timeout=None):
        if self.returncode is None:
            if not self.release.wait(.01):
                raise subprocess.TimeoutExpired('fake recorder', timeout)
            self.returncode = 0
        self.reaped = True
        return self.returncode


class ProcessLane:
    def __init__(self):
        self.processes, self.calls, self.signals = [], [], []
        self.hold_flush = False

    def popen(self, args, **kwargs):
        self.calls.append((args, kwargs))
        path = Path(args[args.index('--output')+1])
        path.mkdir()
        (path / 'sample.db3').write_bytes(b'synthetic bag')
        process = FakeProcess(10000 + len(self.processes))
        self.processes.append(process)
        return process

    def killpg(self, pid, sig):
        self.signals.append((pid, sig))
        process = next(p for p in self.processes if p.pid == pid)
        if not self.hold_flush:
            process.release.set()


@pytest.fixture
def recorder(tmp_path):
    lane = ProcessLane()
    services = NS(status='STARTED', names=('foothold-pointlio', 'foothold-glim'),
                  owned={'foothold-pointlio', 'foothold-glim'})
    allowed = NS(value=True)
    rec = RawRecorder({'FH_MAPPING_RAW_RECORD_ENABLED':'true',
                       'FH_MAPPING_RAW_RECORD_DIR':str(tmp_path)}, lambda:allowed.value,
                      services, popen=lane.popen, killpg=lane.killpg,
                      disk_usage=lambda _:NS(free=MIN_FREE_BYTES), poll_interval=.005)
    yield rec, lane, allowed
    rec.close()
    for process in lane.processes:
        process.release.set()
    if rec.thread is not None:
        rec.thread.join(2)
        assert not rec.thread.is_alive()


def test_start_and_sigint_reap_keep_files_and_log_identity(recorder, caplog):
    rec, lane, _ = recorder
    sid = str(uuid4())
    rec.start(sid)
    wait_for(lambda:rec.snapshot()['status']=='RECORDING')
    args, kwargs = lane.calls[0]
    assert args[:8] == ['taskset','--cpu-list','0-3','nice','-n','10','ros2','bag']
    assert args[-2:] == ['/utlidar/cloud', '/utlidar/imu']
    assert kwargs['start_new_session'] is True and kwargs['stdin'] == subprocess.DEVNULL
    assert kwargs['stderr'] == subprocess.STDOUT
    rec.stop('save_requested')
    wait_for(lambda:rec.snapshot()['status']=='STOPPED')
    state = rec.snapshot()
    assert lane.signals == [(lane.processes[0].pid, signal.SIGINT)]
    assert lane.processes[0].reaped and state['bytes'] > 0
    assert (Path(state['path'])/'raw/sample.db3').read_bytes() == b'synthetic bag'
    assert sid in caplog.text and state['path'] in caplog.text and 'bytes=' in caplog.text


def test_default_off_no_files_or_processes(recorder):
    rec, lane, _ = recorder
    rec.env.pop('FH_MAPPING_RAW_RECORD_ENABLED')
    rec.start(str(uuid4()))
    assert rec.snapshot()['status']=='DISABLED' and not lane.calls and rec.thread is None
    assert not list(Path(rec.env['FH_MAPPING_RAW_RECORD_DIR']).iterdir())


def test_thread_creation_failure_is_contained(recorder, monkeypatch):
    rec, lane, _ = recorder
    def fail(_):raise RuntimeError('thread unavailable')
    monkeypatch.setattr(threading.Thread, 'start', fail)
    rec.start(str(uuid4()))
    assert rec.snapshot()['status']=='FAILED' and rec.thread is None and not lane.calls


def test_low_free_space_skips_before_session_directory(recorder):
    rec, lane, _ = recorder
    rec.disk_usage = lambda _:NS(free=MIN_FREE_BYTES-1)
    rec.start(str(uuid4()))
    wait_for(lambda:rec.snapshot()['status']=='SKIPPED')
    assert rec.snapshot()['cause']=='free_space_below_10GB' and not lane.calls
    assert not list(Path(rec.env['FH_MAPPING_RAW_RECORD_DIR']).iterdir())


def test_cap_stops_only_recorder_and_does_not_restart(recorder):
    rec, lane, _ = recorder
    count = NS(value=0)
    rec.size = lambda _:count.value
    rec.start(str(uuid4()))
    wait_for(lambda:rec.snapshot()['status']=='RECORDING')
    count.value = MAX_BYTES
    wait_for(lambda:rec.snapshot()['status']=='LIMIT')
    assert rec.snapshot()['bytes']==MAX_BYTES and len(lane.signals)==1
    assert rec.services.status=='STARTED' and len(rec.services.owned)==2
    time.sleep(.03)
    assert len(lane.calls)==1


@pytest.mark.parametrize('cause', ['cancelled','save_requested','session_ended'])
def test_session_end_paths_use_only_owned_group(recorder, cause):
    rec, lane, _ = recorder
    unrelated = FakeProcess(99999)
    rec.start(str(uuid4()))
    wait_for(lambda:rec.snapshot()['status']=='RECORDING')
    rec.stop(cause)
    wait_for(lambda:rec.snapshot()['status']=='STOPPED')
    assert rec.snapshot()['cause']==cause
    assert lane.signals==[(lane.processes[0].pid, signal.SIGINT)]
    assert unrelated.poll() is None and not unrelated.reaped


def test_connection_condition_loss_stops_without_mapping_worker(recorder):
    rec, lane, allowed = recorder
    rec.start(str(uuid4()))
    wait_for(lambda:rec.snapshot()['status']=='RECORDING')
    allowed.value = False
    wait_for(lambda:rec.snapshot()['status']=='STOPPED')
    assert rec.snapshot()['cause']=='observation_unavailable' and len(lane.signals)==1


@pytest.mark.parametrize('owned', [set(), {'foothold-pointlio'}])
def test_existing_services_are_never_enough_to_start_a_bag(recorder, owned):
    rec, lane, _ = recorder
    rec.services.owned = owned
    rec.start(str(uuid4()))
    wait_for(lambda:rec.snapshot()['status']=='SKIPPED')
    assert rec.snapshot()['cause']=='services_not_owned' and not lane.calls and not lane.signals


def test_cancel_during_service_start_never_launches(recorder):
    rec, lane, _ = recorder
    rec.services.status = 'STARTING'
    rec.start(str(uuid4()))
    rec.stop('cancelled')
    rec.services.status = 'STARTED'
    time.sleep(.03)
    assert not lane.calls and rec.snapshot()['status']=='STOPPED'


def test_rejected_service_start_never_inherits_an_older_owned_graph(recorder):
    rec, lane, _ = recorder
    rec.start(str(uuid4()), services_requested=False)
    assert rec.snapshot()['status']=='SKIPPED' and rec.snapshot()['cause']=='services_unavailable'
    assert rec.thread is None and not lane.calls


@pytest.mark.parametrize('stage', ['launch','exit','size','disk'])
def test_failures_are_contained(recorder, stage):
    rec, lane, _ = recorder
    def fail(*args, **kwargs):
        raise OSError('synthetic failure')
    if stage=='launch':rec.popen = fail
    if stage=='size':rec.size = fail
    if stage=='disk':rec.disk_usage = fail
    rec.start(str(uuid4()))
    if stage=='exit':
        wait_for(lambda:bool(lane.processes))
        lane.processes[0].returncode = 1
    wait_for(lambda:rec.snapshot()['status']=='FAILED')
    assert rec.services.status=='STARTED' and len(rec.services.owned)==2
    if stage=='size':assert lane.signals


def test_old_files_preserved_and_configured_topics(recorder):
    rec, lane, _ = recorder
    sid = str(uuid4())
    folder = Path(rec.env['FH_MAPPING_RAW_RECORD_DIR'])/('map-'+sid)
    folder.mkdir()
    (folder/'prior.db3').write_bytes(b'keep')
    rec.start(sid)
    wait_for(lambda:rec.snapshot()['status']=='SKIPPED')
    assert (folder/'prior.db3').read_bytes()==b'keep' and not lane.calls
    rec.env.update(FH_MAPPING_RAW_CLOUD_TOPIC='/custom/cloud', FH_MAPPING_RAW_IMU_TOPIC='/custom/imu')
    rec.start(str(uuid4()))
    wait_for(lambda:rec.snapshot()['status']=='RECORDING')
    assert lane.calls[-1][0][-2:]==['/custom/cloud','/custom/imu']


def test_replacement_waits_for_sigint_flush_and_stop_loop_remains_responsive(recorder):
    from foothold_agent.go2_direct.server import DriveSession
    rec, lane, _ = recorder
    lane.hold_flush = True
    rec.start(str(uuid4()))
    wait_for(lambda:rec.snapshot()['status']=='RECORDING')
    second = str(uuid4())
    rec.start(second)
    wait_for(lambda:bool(lane.signals))
    feedback=NS(telemetry=lambda:{},sample=lambda:None,posture_snapshot=lambda:dict(state='UNKNOWN',mode=None))
    session=DriveSession(feedback);session.connect()
    async def check():
        before = time.monotonic()
        effects = session.receive({'t':'stop','stop_ref':1})
        rec.stop('cancelled')
        await asyncio.sleep(.01)
        assert time.monotonic()-before < .1
        assert session.core.latch and any(c.kind=='stop' for c in effects.motion)
    asyncio.run(check())
    assert len(lane.calls)==1
    lane.processes[0].release.set()
    wait_for(lambda:lane.processes[0].reaped)
    time.sleep(.03)
    assert len(lane.calls)==1


def test_new_session_starts_after_old_group_reaped_and_keeps_both_bags(recorder):
    rec, lane, _ = recorder
    first, second = str(uuid4()), str(uuid4())
    rec.start(first)
    wait_for(lambda:rec.snapshot()['status']=='RECORDING')
    first_path = rec.snapshot()['path']
    rec.stop('session_replaced')
    rec.start(second)
    wait_for(lambda:len(lane.processes)==2 and rec.snapshot()['status']=='RECORDING')
    assert lane.processes[0].reaped and lane.signals==[(lane.processes[0].pid, signal.SIGINT)]
    assert rec.snapshot()['session_id']==second and first_path!=rec.snapshot()['path']
    assert (Path(first_path)/'raw/sample.db3').exists()
    assert (Path(rec.snapshot()['path'])/'raw/sample.db3').exists()


@pytest.mark.parametrize('stage', ['disk','launch'])
def test_slow_startup_never_blocks_cancellation_or_control_loop(recorder, stage):
    from foothold_agent.go2_direct.server import DriveSession
    rec, lane, _ = recorder
    entered, release = threading.Event(), threading.Event()
    original = rec.disk_usage if stage=='disk' else rec.popen
    def slow(*args, **kwargs):
        entered.set()
        release.wait(2)
        return original(*args, **kwargs)
    if stage=='disk':rec.disk_usage = slow
    else:rec.popen = slow
    try:
        rec.start(str(uuid4()))
        assert entered.wait(1)
        feedback=NS(telemetry=lambda:{},sample=lambda:None,posture_snapshot=lambda:dict(state='UNKNOWN',mode=None))
        session=DriveSession(feedback);session.connect()
        before = time.monotonic()
        rec.stop('cancelled')
        effects = session.receive({'t':'stop','stop_ref':1})
        assert time.monotonic()-before < .1 and session.core.latch
        assert any(c.kind=='stop' for c in effects.motion)
    finally:
        release.set()
    if stage=='launch':
        wait_for(lambda:bool(lane.signals))
        wait_for(lambda:lane.processes[0].reaped)
    else:
        time.sleep(.03)
        assert not lane.calls


@pytest.mark.parametrize('operation', ['save','cancel','disconnect','close'])
def test_onboard_integration_stops_raw_and_mapping_remains_independent(tmp_path, operation):
    lane = ProcessLane()
    def service_run(action, name):
        return 3 if action=='is-active' else 0
    rt = runtime(tmp_path, service_run=service_run)
    rt.env.update(FH_MAPPING_SERVICE_CONTROL_ENABLED='true', FH_MAPPING_RAW_RECORD_ENABLED='true',
                  FH_MAPPING_RAW_RECORD_DIR=str(tmp_path/'sessions'))
    rt.raw.popen, rt.raw.killpg = lane.popen, lane.killpg
    rt.raw.disk_usage = lambda _:NS(free=MIN_FREE_BYTES)
    rt.raw.poll_interval = .005
    try:
        rt.online = True
        start = command();rt.command(start);rt.step()
        wait_for(lambda:rt.raw.snapshot()['status']=='RECORDING')
        rt.receive(FRONTEND,pose());rt.receive(CLOUD,cloud());rt.step()
        assert rt.core.status=='RUNNING' and rt.core.cells
        body = rt.report_body()[0]
        assert '원본 녹화 켜짐' in body['reason'] and 'bytes' in body['reason']
        assert not any('raw' in k for k in body)
        if operation in ('save','cancel'):
            rt.command(command(operation,start))
        elif operation=='disconnect':rt.suspend()
        else:rt.close()
        wait_for(lambda:rt.raw.snapshot()['status']=='STOPPED')
        assert len(lane.signals)==1 and rt.core.cells
        if operation=='save':assert rt.services.status=='STARTED'
    finally:
        rt.close()
        if rt.raw.thread:rt.raw.thread.join(2)
        if rt.services.thread:rt.services.thread.join(2)
        rt.io.shutdown(wait=True)


def test_agent_run_shutdown_awaits_raw_flush_without_blocking_loop(tmp_path):
    lane = ProcessLane()
    lane.hold_flush = True
    rt = runtime(tmp_path, service_run=lambda action, name:3 if action=='is-active' else 0)
    rt.env.update(FH_MAPPING_SERVICE_CONTROL_ENABLED='true', FH_MAPPING_RAW_RECORD_ENABLED='true',
                  FH_MAPPING_RAW_RECORD_DIR=str(tmp_path/'sessions'))
    rt.raw.popen, rt.raw.killpg = lane.popen, lane.killpg
    rt.raw.disk_usage = lambda _:NS(free=MIN_FREE_BYTES)
    rt.raw.poll_interval = .005
    rt.channel = NS(cloud_bus=NS(subscribe=lambda *args, **kwargs:NS(Close=lambda:None)))
    async def check():
        task = asyncio.create_task(rt.run())
        try:
            await asyncio.sleep(.03)
            rt.command(command())
            deadline = time.monotonic()+2
            while not lane.processes and time.monotonic()<deadline:
                await asyncio.sleep(.005)
            assert lane.processes
            task.cancel()
            while not lane.signals and time.monotonic()<deadline:
                await asyncio.sleep(.005)
            assert lane.signals and not task.done()
            lane.processes[0].release.set()
            with pytest.raises(asyncio.CancelledError):
                await task
            assert lane.processes[0].reaped and not rt.raw.thread.is_alive()
        finally:
            for process in lane.processes:process.release.set()
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
    try:
        asyncio.run(check())
    finally:
        rt.close()
        if rt.raw.thread:rt.raw.thread.join(2)
        if rt.thread:rt.thread.join(2)
        if rt.services.thread:rt.services.thread.join(2)
        rt.io.shutdown(wait=True)


def test_raw_switch_cannot_bypass_disabled_service_control(tmp_path):
    rt = runtime(tmp_path)
    lane = ProcessLane()
    rt.env['FH_MAPPING_RAW_RECORD_ENABLED'] = 'true'
    rt.raw.popen = lane.popen
    try:
        rt.online = True
        rt.command(command());rt.step()
        wait_for(lambda:rt.raw.snapshot()['status']=='SKIPPED')
        assert rt.services.status=='DISABLED' and rt.raw.snapshot()['cause']=='services_unavailable'
        assert not lane.calls
    finally:
        rt.close()
        if rt.raw.thread:rt.raw.thread.join(2)
        rt.io.shutdown(wait=True)


@pytest.mark.parametrize('scenario', ['launch_failure','limit','low_space'])
def test_recording_outcomes_do_not_prevent_live_mapping_and_reason_fits_contract(tmp_path, scenario):
    from apps.contracts.models import MappingProgress
    rt = runtime(tmp_path, service_run=lambda action, name:3 if action=='is-active' else 0)
    rt.env.update(FH_MAPPING_SERVICE_CONTROL_ENABLED='true', FH_MAPPING_RAW_RECORD_ENABLED='true',
                  FH_MAPPING_RAW_RECORD_DIR=str(tmp_path/'sessions'))
    rt.raw.disk_usage = lambda _:NS(free=MIN_FREE_BYTES)
    def fail(*args, **kwargs):raise OSError('missing ros2')
    lane = ProcessLane()
    rt.raw.popen, rt.raw.killpg = lane.popen, lane.killpg
    rt.raw.poll_interval = .005
    if scenario=='launch_failure':
        rt.raw.popen = fail
        expected_status, expected_reason = 'FAILED', '원본 녹화 실패'
    elif scenario=='limit':
        rt.raw.size = lambda _:MAX_BYTES
        expected_status, expected_reason = 'LIMIT', '원본 녹화 2 GB 상한 도달'
    else:
        rt.raw.disk_usage = lambda _:NS(free=MIN_FREE_BYTES-1)
        expected_status, expected_reason = 'SKIPPED', '원본 녹화 건너뜀'
    try:
        rt.online = True
        rt.command(command());rt.step()
        wait_for(lambda:rt.raw.snapshot()['status']==expected_status)
        rt.receive(FRONTEND,pose());rt.receive(CLOUD,cloud());rt.step()
        assert rt.core.status=='RUNNING' and rt.core.cells
        rt.core.reason = '가'*200
        body = rt.report_body()[0]
        assert len(body['reason'])<=200 and expected_reason in body['reason']
        MappingProgress.model_validate({k:v for k,v in body.items() if k!='t'})
    finally:
        rt.close()
        rt.raw.thread.join(2)
        rt.services.thread.join(2)
        rt.io.shutdown(wait=True)
