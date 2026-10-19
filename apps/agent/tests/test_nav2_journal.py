"""Offline go-03 auto3 startup replay: real runner/Owner, no ROS or processes."""
import asyncio
from concurrent.futures import Future
import json
import queue
import sys
from types import SimpleNamespace as N

import pytest

from test_nav2_tools import C
from foothold_agent.safety.core import SCHEMA
import journal
import runner


class ManualWriter:
    """Deterministic disk scheduling: consume only at an owning-loop yield."""
    def __init__(self, *, target, **kwargs):
        self.target = target

    def start(self):
        pass

    def join(self, timeout):
        self.target()

    def is_alive(self):
        return False


@pytest.fixture
def controlled_journal(monkeypatch):
    monkeypatch.setattr(journal, 'threading', N(Thread=ManualWriter))

    def drain(log):
        while not log.queue.empty():
            log.file.write(log.queue.get_nowait())
        log.file.flush()
    return drain


@pytest.mark.parametrize('phase,check_each_tick', [
    pytest.param('preflight', True, id='preflight-drain-regression'),
    pytest.param('resume', True, id='resume-drain-regression'),
    pytest.param('preflight', False, id='go03-auto3-first-loop-capacity-reproduction'),
])
def test_auto3_startup_records_are_drained_before_first_goal_loop(
        tmp_path, monkeypatch, controlled_journal, phase, check_each_tick):
    # go-03 auto3 failed at its first running-loop drain after accumulating
    # preflight sink/session events (>256 submissions including trial events).
    # Reproduce that scheduling shape with real Owner/Session and Journal(256):
    # disk runs between ticks, never inside a tick. Also cover RESUME waiting.
    clock = N(t=0.)
    logs, owners, goals, batches, produced = [], [], [], [], []
    real_owner, real_session, real_executor = runner.Owner, runner.Session, runner.NavExecutor

    class Evidence(list):
        def append(self, record):
            produced.append(record)
            super().append(record)

    def make_log(path):
        log = journal.Journal(path)
        assert log.queue.maxsize == 256
        logs.append(log)
        return log

    def make_owner(*args, **kwargs):
        owner = real_owner(*args, **kwargs, now=lambda: clock.t)
        owner.journal = Evidence()
        owners.append(owner)
        return owner

    class Sink:
        stopped = True
        resume_requested = False

        def apply(self, command):
            if command.kind == 'unlock':
                self.resume_requested = True
            elif command.kind == 'stop':
                self.stopped = True

    sink = Sink()

    class Bridge:
        error = None

        def __init__(self, *args, **kwargs):
            self.inputs = N(telemetry=N(state={}))
            self.extension = N(snapshot=self.snapshot, silenced=False)

        async def start(self, callback):
            self.callback = callback
            return sink

        def state(self):
            if sink.resume_requested and (phase == 'preflight' or clock.t >= 2.5):
                sink.stopped = False
            raw = dict(schema=SCHEMA, episode=1, sim_t=clock.t+1,
                policy_running=True, reset_in_progress=False, fallen=False,
                plugin_mode='LOCKSTEP', stop_requested=sink.stopped,
                cmd_applied=[0, 0, 0], body_still=True, tilt_deg=0,
                x=-12., y=-9., z=.4, yaw=0., vx=0., vy=0., wz=0.)
            self.inputs.telemetry.state = dict(received_monotonic_s=clock.t,
                                               progress_monotonic_s=clock.t)
            self.callback(raw)
            return raw

        def snapshot(self):
            return dict(state=(self.state(), clock.t),
                frames_ready=phase == 'resume' or clock.t >= 3.,
                map_ready=True, lifecycle_ready=True)

        def close(self):
            pass

    bridge = Bridge()

    class Pool:
        def __init__(self, **kwargs):
            pass

        def submit(self, fn, *args, **kwargs):
            future = Future()
            future.set_result(fn(*args, **kwargs))
            return future

        def shutdown(self, **kwargs):
            pass

    class Actions:
        def submit(self, binding, point):
            goals.append(binding)

        def cancel(self, binding):
            pass

    async def yield_tick(delay):
        # A removed/misplaced drain fails here before reaching the first goal;
        # unlike a helper-only test this exercises _execute's actual call sites.
        batches.append(logs[0].queue.qsize())
        if check_each_tick:
            assert not owners[0].journal, 'startup evidence was not submitted at this tick'
        controlled_journal(logs[0])
        if check_each_tick:
            rows = [json.loads(line) for line in (tmp_path/'events.jsonl').read_text().splitlines()]
            owner_rows = [{k: v for k, v in row.items() if k != 'schema'}
                          for row in rows if row['event'] in {p['event'] for p in produced}]
            assert owner_rows == json.loads(json.dumps(produced))
        clock.t += delay
        bridge.state()
        if goals:
            bridge.error = RuntimeError('end of offline replay')

    monkeypatch.setenv('FH_NAV2_EXECUTE', '1')
    monkeypatch.setattr('foothold_agent.ros_bridge.config.validate_isolation', lambda: None)
    monkeypatch.setitem(sys.modules, 'foothold_agent.ros_bridge.node', N(RosNode=lambda *a, **k: bridge))
    monkeypatch.setattr(runner, 'time', N(monotonic=lambda: clock.t))
    monkeypatch.setattr(runner, 'asyncio', N(wait_for=asyncio.wait_for,
        get_running_loop=asyncio.get_running_loop, sleep=yield_tick))
    monkeypatch.setattr(runner, 'ThreadPoolExecutor', Pool)
    monkeypatch.setattr(runner, 'Journal', make_log)
    monkeypatch.setattr(runner, 'Owner', make_owner)
    monkeypatch.setattr(runner, 'Session', lambda: real_session(lambda: clock.t))
    monkeypatch.setattr(runner, 'NavExecutor', lambda *a, **k:
        real_executor(*a, **k, now=lambda: clock.t))
    monkeypatch.setattr(runner, 'ActionMailbox', Actions)
    monkeypatch.setattr(runner, 'scope_limits', lambda c: 'offline-fake-scope')
    monkeypatch.setattr(runner, 'map_manifest', lambda p: {})
    monkeypatch.setattr(runner, 'GTWorld', lambda p: N(
        path=lambda *a, **k: {'pass': True}, pose=lambda *a: {'pass': True}))
    monkeypatch.setattr(runner, 'snapshot', lambda *a, **k: dict(
        available_mib=10000, load1=0, gpu_free_mib=10000, swap_in_kib_s=0, rtf=1))
    args = N(output=tmp_path, map_source=None, world=None, trial=3,
        isolated_start_id='pure-go03-auto3', seed=0, operator_confirmation='offline-only')
    with pytest.raises(RuntimeError, match='bridge failure'):
        asyncio.run(runner._execute(args, C, runner.load('policy.json')))
    rows = [json.loads(line) for line in (tmp_path/'events.jsonl').read_text().splitlines()]
    assert len(rows) > 256  # would overflow if retained for one first-loop burst
    assert 0 < max(batches) < 256
    assert len(goals) == 1
    assert any(row['event'] == 'sink_apply' for row in rows)
    assert any(row['event'] == 'session_effect' for row in rows)
    assert not any(row.get('type') == 'Full' for row in rows)
    assert json.loads((tmp_path/'result.json').read_text())['status'] == 'FAILED'


def test_full_startup_batch_still_raises_without_silent_loss(tmp_path, controlled_journal):
    log = journal.Journal(tmp_path/'events.jsonl')
    assert log.queue.maxsize == 256
    records = [dict(event='sink_apply', sequence=i) for i in range(257)]
    try:
        for record in records[:256]:
            log.emit(record)
        with pytest.raises(queue.Full):
            log.emit(records[256])
    finally:
        controlled_journal(log)
        log.close()
    rows = [json.loads(line) for line in (tmp_path/'events.jsonl').read_text().splitlines()]
    assert rows == records[:256]
