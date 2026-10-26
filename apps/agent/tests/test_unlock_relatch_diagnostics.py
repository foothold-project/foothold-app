"""VQ-R: real Core/Session/Client/Inputs/RosSink, simulated feedback only.

No phone, ROS participant, server socket, simulation process or nonzero command.
Injected incidents demonstrate possible causes, not the cause of a past run.
"""

import logging
import subprocess
import sys
import threading
from types import SimpleNamespace

import pytest

from foothold_agent.link.client import Client, Settings
from foothold_agent.link.session import MotionCommand, Session
from foothold_agent.phone.hub import Hub
from foothold_agent.phone.observer import DiscardSink, Observer
from foothold_agent.ros_bridge.node import Inputs
from foothold_agent.ros_bridge.sink import RosSink
from foothold_agent.safety.core import Core, SCHEMA, Z


class Clock:
    t = 0.0

    def __call__(self):
        return self.t


class Loop:
    def __init__(self):
        self.pending = []

    def call_soon_threadsafe(self, callback):
        self.pending.append(callback)

    def drain(self):
        while self.pending:
            self.pending.pop(0)()


class FakeSim:
    """Only STOP/resume callbacks change the simulated physical STOP bit.

    ZERO does not imply STOP. Delayed feedback is explicitly delivered by tests;
    real sink scheduling, retry/deadline and generation checks stay in use.
    """

    def __init__(self, clock):
        self.clock = clock
        self.stopped = True
        self.outputs = []

    def velocity(self, velocity):
        assert velocity == Z
        self.outputs.append((self.clock(), 'zero'))

    def stop(self):
        self.outputs.append((self.clock(), 'stop'))
        self.stopped = True

    def resume(self):
        self.outputs.append((self.clock(), 'resume'))
        self.stopped = False

    def state(self, **changes):
        return dict(schema=SCHEMA, episode=1, sim_t=self.clock(),
                    stop_requested=self.stopped, reset_in_progress=False,
                    policy_running=True, fallen=False, cmd_applied=list(Z), **changes)


class Harness:
    def __init__(self):
        self.clock, self.loop = Clock(), Loop()
        self.sim = FakeSim(self.clock)
        self.sink = RosSink(self.sim.velocity, self.sim.stop, self.sim.resume,
                            now=self.clock, watchdog=False)
        self.session = Session(now=self.clock)
        assert isinstance(self.session.core, Core)
        self.client = Client(self.session, self.sink, Settings('ws://127.0.0.1/unused', 'test-only'))
        self.inputs = Inputs(self.loop, self.sink, self.client.on_robot_state, now=self.clock)
        self.seq = 0
        self.emit(self.session.connect())
        self.feedback()
        self.frame(t='lease', lease_id='test-lease', holder_type='USER')
        # Reach the observed baseline using real STOPs, never assigning stop_gen.
        for _ in range(4):
            self.frame(t='stop')
            self.feedback()
        assert self.session.core.stop_gen == 6

    def emit(self, effects):
        self.client._emit(effects)
        self.sink.flush()

    def frame(self, **frame):
        self.emit(self.session.receive(frame))

    def feedback(self, raw=None):
        self.clock.t += .01
        self.inputs.state(self.sim.state() if raw is None else raw)
        self.loop.drain()
        self.sink.flush()

    def unlock(self, *, confirm=True):
        self.frame(t='unlock', lease_id='test-lease', stop_gen=self.session.core.stop_gen)
        assert self.session.core.resume_pending is not None
        assert not self.sim.stopped
        if confirm:
            self.feedback()
            assert not self.session.core.latch

    def tick(self, *, zero=False):
        self.clock.t += .051
        if zero:
            self.seq += 1
            self.frame(t='cmd', lease_id='test-lease', seq=self.seq, axes=list(Z))
        else:
            self.frame(t='ping')
        self.feedback()

    def elapse_healthy(self, delay):
        target = self.clock() + delay
        while self.clock() + .05 < target:
            self.clock.t += .05
            self.frame(t='ping')
            self.inputs.state(self.sim.state())
            self.loop.drain()
            self.sink.flush()
        self.clock.t = target

    def assert_zero_authority_unchanged(self):
        assert self.session.core.out == Z
        assert self.session.lease_confirmed
        assert self.session.core.controller == self.session.lease_id == 'test-lease'
        assert self.session._state()['safety_reason'] is None


@pytest.mark.parametrize('zero', [False, True], ids=['no-control-input', 'zero-at-20hz'])
def test_unlock_and_zero_or_no_input_does_not_relatch(zero):
    h = Harness()
    h.unlock()
    h.sim.outputs.clear()
    for _ in range(70):  # crosses Core DEAD, sink retry, resume and link deadlines
        h.tick(zero=zero)
        assert not h.session.core.latch and not h.sim.stopped
        assert h.session.core.stop_gen == 6
        h.assert_zero_authority_unchanged()
    assert {kind for _, kind in h.sim.outputs} == {'zero'}


def test_external_sim_stop_then_stop_frames_can_reproduce_6_to_10(caplog):
    h = Harness()
    h.unlock()
    caplog.clear()
    h.sim.outputs.clear()
    h.sim.stopped = True  # explicitly injected external simulator STOP
    h.feedback()
    assert h.session.core.stop_gen == 7
    # Core adopted physical STOP; it did not originate a sink STOP for this edge.
    assert not any(kind == 'stop' for _, kind in h.sim.outputs)
    for delay, expected in ((.001, 8), (.603, 9), (.009, 10)):
        h.elapse_healthy(delay)
        h.frame(t='stop', by_user_id='must-not-appear-in-diagnostics')
        assert h.session.core.stop_gen == expected
        h.assert_zero_authority_unchanged()
    lines = [r.getMessage() for r in caplog.records if r.name == 'foothold_agent.safety']
    assert any('reason=sim_stop_requested' in s and 'stop_gen=7 ' in s for s in lines)
    for generation in (8, 9, 10):
        assert any('reason=session_stop_frame' in s and f'stop_gen={generation} ' in s for s in lines)
    assert any('event=stop_publish' in s and 'stop_gen=unavailable sink_generation=' in s for s in lines)
    assert all('source=' in s and 'monotonic_s=' in s for s in lines)
    assert 'must-not-appear-in-diagnostics' not in '\n'.join(lines)


def test_stop_frames_alone_increment_generation_even_with_live_lease_and_zero():
    h = Harness()
    h.unlock()
    for expected in range(7, 11):
        h.frame(t='stop')  # another device/Hub or cloud facade can call this entry
        assert h.session.core.stop_gen == expected
        h.assert_zero_authority_unchanged()
    assert h.session.core.latch and h.sim.stopped


def test_bridge_rejection_originates_sink_stop_then_core_relatches(caplog):
    h = Harness()
    h.unlock()
    h.sim.outputs.clear()
    caplog.clear()
    h.inputs.reject('invalid_measurement')  # real Inputs calls real sink.hold()
    h.loop.drain()
    assert not h.session.core.latch and not h.sim.stopped
    h.tick()
    assert h.sim.stopped and h.session.core.latch
    assert h.session.core.stop_gen == 7
    h.assert_zero_authority_unchanged()
    lines = [r.getMessage() for r in caplog.records]
    assert any('event=hold' in s and '.reject:' in s for s in lines)
    assert any('event=stop_publish reason=initial_or_new_stop' in s for s in lines)
    assert any('event=relock reason=sim_stop_requested' in s for s in lines)


def test_same_stamp_stop_measurement_during_resume_can_leave_retry_armed(caplog):
    h = Harness()
    old_stop = h.sim.state()
    h.unlock(confirm=False)
    # Still-STOP feedback at the previous sim time with a changed measurement:
    # StateGate accepts the measurement, Inputs conservatively holds the sink.
    old_stop['vx'] = .01
    caplog.clear()
    h.feedback(old_stop)
    assert h.sink._held and h.sim.stopped
    assert h.session.core.resume_pending is not None
    assert any('event=hold' in r.getMessage() and '.state:' in r.getMessage() for r in caplog.records)
    # An already-in-flight resume confirmation can clear Core before STOP echo.
    confirmation = h.sim.state()
    confirmation['stop_requested'] = False
    h.feedback(confirmation)
    assert not h.session.core.latch
    assert h.session.core.stop_gen == 6
    h.sim.outputs.clear()
    for _ in range(10):
        h.clock.t += .051
        h.frame(t='ping')
    assert any(kind == 'stop' for _, kind in h.sim.outputs)  # real 0.5 s retry
    assert any('reason=unconfirmed_retry' in r.getMessage() for r in caplog.records)
    h.feedback()
    assert h.session.core.latch and h.session.core.stop_gen == 7
    h.assert_zero_authority_unchanged()


def test_reconnect_and_state_sync_increment_once_and_remain_locked():
    h = Harness()
    h.unlock()
    h.emit(h.session.disconnect())
    assert h.session.core.stop_gen == 6
    h.emit(h.session.connect())
    assert h.session.core.stop_gen == 7
    assert not h.session.lease_confirmed  # transport must receive a fresh grant
    h.feedback()
    h.frame(t='lease', lease_id='test-lease', holder_type='USER')
    for _ in range(20):
        h.tick(zero=True)
    assert h.session.core.stop_gen == 7  # STOP echo alone adds no second lock
    assert h.session.core.latch and h.sim.stopped
    h.assert_zero_authority_unchanged()


def test_production_cloud_observer_reconnect_does_not_lock_pc_session_but_stop_does():
    clock, loop = Clock(), Loop()
    sim = FakeSim(clock)
    sink = RosSink(sim.velocity, sim.stop, sim.resume, now=clock, watchdog=False)
    hub = Hub(SimpleNamespace(robot='test-robot', check_clock=lambda: None), sink, policy_name='test',
              policy_version='1', simulation=True, now=clock)
    observer = Observer(hub)
    client = Client(observer, DiscardSink(), Settings('ws://127.0.0.1/unused', 'test-only'))
    hub.record = observer.retain

    def state(raw):
        hub.on_robot_state(raw)
        client.on_robot_state(raw)  # same order as the production bridge callback

    inputs = Inputs(loop, sink, state, now=clock)
    def feedback():
        clock.t += .01
        inputs.state(sim.state())
        loop.drain()
        sink.flush()
    def frame(**body):
        hub._emit(hub.session.receive(body))
        sink.flush()

    sink.flush()
    feedback()
    frame(t='lease', lease_id='pc-test-lease', holder_type='USER')
    for _ in range(4):
        frame(t='stop')
        feedback()
    assert hub.session.core.stop_gen == 6
    frame(t='unlock', lease_id='pc-test-lease', stop_gen=6)
    feedback()
    assert not hub.session.core.latch
    sim.outputs.clear()
    client._emit(observer.connect())
    client._emit(observer.disconnect())
    client._emit(observer.connect())
    client._emit(observer.receive(dict(t='lease', lease_id=None)))
    client._emit(observer.receive(dict(t='cmd', axes=list(Z))))
    feedback()
    assert observer.core is hub.session.core
    assert hub.session.core.stop_gen == 6 and not hub.session.core.latch
    assert hub.session.lease_confirmed and hub.session.lease_id == 'pc-test-lease'
    assert {kind for _, kind in sim.outputs} <= {'zero'}
    client._emit(observer.receive(dict(t='stop')))
    sink.flush()
    assert sim.stopped and hub.session.core.latch and hub.session.core.stop_gen == 7
    assert hub.session.lease_confirmed and hub.session.lease_id == 'pc-test-lease'
    assert hub.session._state()['safety_reason'] is None


@pytest.mark.parametrize('gap', ['apply', 'publisher'])
def test_sink_deadline_has_an_explicit_stop_origin(gap, caplog):
    h = Harness()
    h.unlock()
    caplog.clear()
    h.clock.t += .301
    if gap == 'publisher':
        h.sink.apply(MotionCommand())
    h.sink.check_watchdog()
    assert h.sim.stopped
    assert any(f'event=watchdog reason={gap}_deadline' in r.getMessage() for r in caplog.records)
    assert any('event=stop_publish reason=emergency' in r.getMessage() for r in caplog.records)


def test_stale_resume_generation_has_fixed_rejection_reason(caplog):
    h = Harness()
    caplog.clear()
    h.frame(t='unlock', lease_id='test-lease', stop_gen=5)
    assert h.session.core.resume_pending is None
    assert any('event=resume_rejected reason=generation_mismatch' in r.getMessage() for r in caplog.records)


def test_diagnostics_are_bounded_do_not_leak_payload_and_cannot_prevent_stop(caplog, monkeypatch):
    clock = Clock()
    core = Core(now=clock)
    # One caller, many STOPs: diagnostics bounded independently of CAS updates.
    for _ in range(100):
        core.stop('private-token-or-identity')
    lines = [r.getMessage() for r in caplog.records if r.name == 'foothold_agent.safety']
    assert core.stop_gen == 100 and core.latch
    assert len(lines) == 16  # eight lock + eight STOP records per source/second
    assert 'private-token-or-identity' not in '\n'.join(lines)
    clock.t = 1.01
    core.stop('private-token-or-identity')
    assert any('suppressed=92' in r.getMessage() for r in caplog.records)
    def broken(*args, **kwargs):
        raise OSError('diagnostic output unavailable')
    monkeypatch.setattr(logging.getLogger('foothold_agent.safety'), 'warning', broken)
    core.stop('another-private-value')
    assert core.stop_gen == 102 and core.latch


def test_diagnostic_output_failure_cannot_prevent_sink_zero_stop_or_resume(monkeypatch):
    def broken(*args, **kwargs):
        raise OSError('diagnostic output unavailable')
    monkeypatch.setattr(logging.getLogger('foothold_agent.safety'), 'warning', broken)
    h = Harness()
    h.unlock()
    h.frame(t='stop')
    assert h.sim.stopped and h.session.core.latch and h.session.core.stop_gen == 7


def test_emergency_publishes_and_releases_output_lock_before_blocked_log(monkeypatch):
    clock = Clock()
    clock.t = 1.0
    sim = FakeSim(clock)
    sink = RosSink(sim.velocity, sim.stop, sim.resume, now=clock, watchdog=False)
    entered, release = threading.Event(), threading.Event()

    def blocked(*args, **kwargs):
        entered.set()
        release.wait()

    monkeypatch.setattr(sink._safety_log, 'emit', blocked)
    worker = threading.Thread(target=sink._emergency, daemon=True)
    worker.start()
    try:
        assert entered.wait(1)
        assert sim.outputs == [(clock(), 'zero'), (clock(), 'stop')]
        assert sink._last_stop == clock() and not sink._stop_first
        acquired = sink._output_lock.acquire(timeout=1)
        try:
            assert acquired
        finally:
            if acquired:
                sink._output_lock.release()
    finally:
        release.set()
        worker.join(1)
    assert not worker.is_alive()


def test_unconfigured_process_writes_memory_core_diagnostics_to_agent_log(tmp_path):
    log = tmp_path / 'agent.log'
    with log.open('w') as output:
        result = subprocess.run([sys.executable, '-c',
            'from foothold_agent.link.session import Session; '
            's=Session(); s.connect(); s.receive({"t":"stop"})'],
            stdout=output, stderr=output, timeout=10, check=False)
    assert result.returncode == 0
    text = log.read_text()
    assert 'event=stop_received reason=session_stop_frame' in text
    assert 'stop_gen=3 ' in text
    assert 'source=foothold_agent.link.session.receive:' in text
