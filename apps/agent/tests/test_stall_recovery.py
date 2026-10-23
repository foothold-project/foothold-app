"""Recoverable publisher STOPs through the real sink, Session and phone authority.

All output callbacks are local lists; no ROS participant or robot is started.
"""
import asyncio
import json
import threading
import time
from uuid import uuid4

import pytest

from apps.contracts.models import PhoneState
from foothold_agent.link.session import MotionCommand
from foothold_agent.phone.hub import Hub
from foothold_agent.phone.observer import Observer
from foothold_agent.ros_bridge.diagnostics import StallDiagnostics
from foothold_agent.ros_bridge.node import Inputs, RosNode
from foothold_agent.ros_bridge.sink import RosSink, STALL_LIMIT, STALL_RECOVERY_TIMEOUT
from foothold_agent.safety.core import Z
from test_phone import Harness
from test_ros_bridge import Clock, Loop, activate, make_sink, state
from test_ros_bridge_review import Harness as LinkHarness
from test_ros_bridge_node import config, ros


def trip(sink, clock):
    clock.t += .301
    sink.apply(MotionCommand())  # owning loop healthy, ROS publisher silent
    sink.check_watchdog()


def test_apply_cannot_rearm_a_stall_but_completed_flush_can():
    clock = Clock()
    sink, outputs = make_sink(clock)
    activate(sink, outputs)
    trip(sink, clock)
    for _ in range(10):
        clock.t += .05  # repeated apply during the allowed recovery window
        sink.apply(MotionCommand())
        sink.check_watchdog()
        sink.check_health()
    assert sink.output_safety() == (1, True)
    assert outputs[-2:] == [('velocity', Z), ('stop',)]
    sink.flush()
    assert not sink._publisher_expired and sink._held
    trip(sink, clock)
    assert sink.output_safety() == (2, True)
    sink.check_health()


def test_unrecovered_stall_deadline_is_not_extended_by_apply():
    assert STALL_RECOVERY_TIMEOUT == 2.0
    clock = Clock()
    sink, _ = make_sink(clock)
    trip(sink, clock)
    detected = clock.t
    clock.t = detected + STALL_RECOVERY_TIMEOUT - .001
    sink.apply(MotionCommand())
    sink.check_watchdog()
    sink.check_health()
    clock.t = detected + STALL_RECOVERY_TIMEOUT
    sink.check_watchdog()
    with pytest.raises(RuntimeError, match='ROS output failed'):
        sink.check_health()
    assert 'recovery timed out' in str(sink.error)
    assert sink.output_safety() == (1, True)


@pytest.mark.parametrize('blocked', ['spin', 'flush', 'emergency', 'emergency_failure'])
def test_watchdog_reports_unrecovered_stall_without_apply_or_flush(ros, monkeypatch, blocked):
    """Bridge failure reaches the entrypoint's waiter while ROS remains blocked."""
    from rclpy.executors import SingleThreadedExecutor
    clock = Clock()
    pause, entered, release = (threading.Event() for _ in range(3))
    original = SingleThreadedExecutor.spin_once
    def spin(executor, **kwargs):
        if pause.is_set() and blocked != 'flush':
            entered.set()
            release.wait()
        original(executor, **kwargs)
    monkeypatch.setattr(SingleThreadedExecutor, 'spin_once', spin)

    async def until(predicate):
        async def poll():
            while not predicate():
                await asyncio.sleep(.005)
        await asyncio.wait_for(poll(), 1)

    async def run():
        node = RosNode(config(), now=clock)
        sink = await node.start(lambda raw: None)
        failure = asyncio.create_task(node.wait_failure())
        async def failed():
            done, _ = await asyncio.wait({failure}, timeout=1)
            assert failure in done, 'watchdog did not notify bridge failure while ROS was blocked'
            return await failure
        original_velocity, original_stop = sink._velocity, sink._stop
        emergency_entered = threading.Event()
        def velocity(v):
            if blocked == 'emergency_failure' and threading.current_thread().name == 'ros-output-emergency':
                raise ValueError('stub emergency failure')
            if pause.is_set() and blocked == 'flush' and threading.current_thread().name == 'agent-rclpy':
                entered.set()
                release.wait()
            original_velocity(v)
        def stop():
            if blocked == 'emergency' and threading.current_thread().name == 'ros-output-emergency':
                emergency_entered.set()
                release.wait()
            original_stop()
        sink._velocity, sink._stop = velocity, stop
        try:
            ros.events.clear()
            pause.set()
            clock.t = .05  # make the next flush publish in the flush case
            await until(entered.is_set)
            with sink._lock:
                clock.t = detected = sink._last_flush + .301
                sink.apply(MotionCommand())
            await until(lambda: sink.output_safety()[0] == 1)
            if blocked == 'emergency_failure':
                with pytest.raises(RuntimeError, match='ROS bridge failed') as caught:
                    await failed()
                assert isinstance(caught.value.__cause__, ValueError)
                assert node._thread.is_alive() and not release.is_set()
                assert any(e[0] == '/v2_live/stop' for e in ros.events)
                return
            if blocked == 'emergency':
                await until(emergency_entered.is_set)
            elif blocked == 'flush':
                await until(lambda: sink._emergency_thread is not None and sink._emergency_thread.is_alive())
                assert not ros.events  # flush owns the output lock; ZERO/STOP cannot pass
            else:
                await until(lambda: any(e[0] == '/v2_live/stop' for e in ros.events))
            assert sink._watchdog.is_alive() and not failure.done()
            clock.t = detected + STALL_RECOVERY_TIMEOUT - .001
            await asyncio.sleep(.02)
            assert not failure.done()
            clock.t = detected + STALL_RECOVERY_TIMEOUT
            # No apply, flush, or release is needed for the bridge failure signal.
            with pytest.raises(RuntimeError, match='ROS bridge failed') as caught:
                await failed()
            assert caught.value.__cause__ is sink.error
            assert 'recovery timed out' in str(sink.error)
            assert node._thread.is_alive() and not release.is_set()
        finally:
            release.set()
            with pytest.raises(RuntimeError):
                node.close()
            failure.cancel()
            await asyncio.gather(failure, return_exceptions=True)
        assert not node._thread.is_alive() and not sink._watchdog.is_alive()
        assert not sink._emergency_thread.is_alive()
    asyncio.run(run())


def test_entrypoint_exits_after_stall_timeout_with_executor_still_blocked(ros, monkeypatch):
    """The production runner cancels its client and exits before ROS recovers."""
    from foothold_agent.ros_bridge import __main__ as runner
    from rclpy.executors import SingleThreadedExecutor
    clock = Clock()
    pause, entered, release, cancelled = (threading.Event() for _ in range(4))
    node = RosNode(config(), now=clock)
    original = SingleThreadedExecutor.spin_once
    def spin(executor, **kwargs):
        if pause.is_set():
            entered.set()
            release.wait()
        original(executor, **kwargs)
    class Client:
        def __init__(self, *args):
            pass
        def update_telemetry(self, value):
            pass
        def update_devices(self, value):
            pass
        async def run(self):
            try:
                await asyncio.Future()
            finally:
                cancelled.set()
    monkeypatch.setattr(SingleThreadedExecutor, 'spin_once', spin)
    monkeypatch.setattr(runner, 'RosNode', lambda config: node)
    monkeypatch.setattr(runner, 'Client', Client)
    monkeypatch.delenv('FOOTHOLD_CAMERA_ENABLED', raising=False)
    async def until(predicate):
        async def poll():
            while not predicate():
                await asyncio.sleep(.005)
        await asyncio.wait_for(poll(), 2)
    async def run():
        task = asyncio.create_task(runner.run(config()))
        try:
            await until(lambda: node._ready is not None and node._ready.done())
            pause.set()
            await until(entered.is_set)
            sink = node.sink
            with sink._lock:
                clock.t = sink._last_flush + .301
                sink.apply(MotionCommand())
            await until(lambda: sink.output_safety()[0] == 1)
            clock.t += STALL_RECOVERY_TIMEOUT
            done, _ = await asyncio.wait({task}, timeout=3)
            assert task in done, 'runner did not exit on the independent watchdog failure'
            with pytest.raises(RuntimeError):
                await task
            assert cancelled.is_set() and node._thread.is_alive() and not release.is_set()
            assert 'recovery timed out' in str(sink.error)
        finally:
            release.set()
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            if node.sink is not None:
                with pytest.raises(RuntimeError):
                    node.close()
        assert not node._thread.is_alive()
    asyncio.run(run())


@pytest.mark.parametrize('gap,fatal', [(1, True), (30, True), (30.01, False), (61, False)])
def test_repeat_limit_uses_rolling_monotonic_window(gap, fatal):
    assert STALL_LIMIT == (3, 60.0)
    clock = Clock()
    sink, _ = make_sink(clock)
    for index in range(3):
        if index:
            # Keep the publisher healthy while advancing to the next incident.
            sink.flush()  # recover this incident BEFORE advancing beyond its bound
            target = .301 + index * gap - .301
            while clock.t < target:
                clock.t = min(clock.t + .1, target)
                sink.apply(MotionCommand())
                sink.flush()
        trip(sink, clock)
        if index < 2 or not fatal:
            sink.check_health()
    assert sink.output_safety()[0] == 3
    if fatal:
        with pytest.raises(RuntimeError, match='ROS output failed'):
            sink.check_health()
        assert 'repeatedly stalled' in str(sink.error)


@pytest.mark.parametrize('failed', ['velocity', 'stop'])
def test_emergency_output_failure_remains_fatal_and_attempts_both(failed):
    clock, outputs = Clock(), []
    def publish(name, value):
        outputs.append(value)
        if name == failed:
            raise ValueError('stub output failure')
    sink = RosSink(lambda v: publish('velocity', v), lambda: publish('stop', 'STOP'),
                   lambda: None, now=clock, watchdog=False)
    trip(sink, clock)
    assert outputs == [Z, 'STOP']
    with pytest.raises(RuntimeError, match='ROS output failed'):
        sink.check_health()


@pytest.mark.parametrize('simulation', [True, False])
def test_phone_stall_requires_new_stop_feedback_unlock_and_neutral(simulation):
    h, loop, outputs = Harness(simulation=simulation), Loop(), []
    sink = RosSink(outputs.append, lambda: outputs.append('STOP'), lambda: outputs.append('RESUME'),
                   now=h.clock, watchdog=False)
    h.hub = Hub(h.verifier, sink, policy_name='test', policy_version='1', simulation=simulation,
                now=h.clock, wall=h.clock.wall)
    inputs = Inputs(loop, sink, h.hub.on_robot_state, now=h.clock)
    def feedback(stopped):
        h.clock.t += .01
        inputs.state(state(sim_t=h.clock.t, stop_requested=stopped))
        loop.drain()
        sink.flush()
    def unlock(gen=None, lease=None):
        return h.send(peer, 'unlock', lease_id=lease or h.hub.session.lease_id,
                      stop_gen=h.hub.session.core.stop_gen if gen is None else gen)
    try:
        peer, _, _ = h.connect()
        assert h.take(peer)['ok']
        sink.flush()
        feedback(True)
        assert unlock()['ok']
        sink.flush()
        feedback(False)
        h.cmd(peer, 0)
        h.clock.t += .06
        h.cmd(peer)
        sink.flush()
        assert outputs[-1] == (.6, 0, 0)
        lease, old_gen = h.hub.session.lease_id, h.hub.session.core.stop_gen
        outputs.clear()
        trip(sink, h.clock)
        assert outputs == [Z, 'STOP']
        sink.check_health()  # the process health monitor must keep all services alive
        snapshot = h.hub.state(peer)
        assert snapshot['latched'] and snapshot['applied'] == list(Z)
        assert snapshot['safety_reason'] == 'OUTPUT_STALLED'
        assert PhoneState.model_validate(snapshot).safety_reason == 'OUTPUT_STALLED'
        assert Observer(h.hub)._state()['safety_reason'] == 'OUTPUT_STALLED'
        assert h.hub.session.lease_id == lease  # no authority transfer
        assert not unlock()['ok']  # old physical STOP feedback cannot release this hold
        assert h.cmd(peer)['applied'] == list(Z)
        sink.flush()  # recover publisher; still no unlock
        assert outputs[-1] == Z and 'RESUME' not in outputs
        feedback(True)
        assert not unlock(gen=old_gen)['ok']
        assert not unlock(lease=str(uuid4()))['ok']
        assert unlock()['ok']
        sink.flush()
        assert outputs.count('RESUME') == 1
        assert h.cmd(peer)['applied'] == list(Z)
        feedback(False)
        assert h.hub.state(peer)['safety_reason'] is None
        assert h.cmd(peer)['applied'] == list(Z)  # unlock does not replay old intent
        h.cmd(peer, 0)
        h.clock.t += .06
        assert h.cmd(peer)['applied'] == [.6, 0, 0]
        sink.flush()
        assert outputs[-1] == (.6, 0, 0)
    finally:
        h.hub.close()
        sink.close()
        h.verifier.close()


def test_cloud_client_syncs_stall_before_accepting_old_unlock():
    h = LinkHarness()
    h.moving()
    trip(h.sink, h.clock)
    h.unlock()
    assert h.session.core.latch and h.session.core.resume_pending is None
    assert h.session._state()['safety_reason'] == 'OUTPUT_STALLED'
    h.feedback(True)
    h.unlock()
    h.feedback(False)
    h.cmd([0, 0, 0])
    h.clock.t += .06
    h.cmd([1, 0, 0])
    assert h.out[-1] == ('velocity', (.6, 0, 0))


def test_stall_during_resume_rejects_cached_pre_stall_stop_feedback():
    h = LinkHarness()  # cached, valid physical STOP from before this incident
    h.unlock()
    assert h.session.core.resume_pending is not None
    trip(h.sink, h.clock)
    assert h.session._state()['safety_reason'] == 'OUTPUT_STALLED'
    h.unlock()  # current CAS generation still cannot substitute for new STOP feedback
    assert h.session.core.latch and h.session.core.resume_pending is None
    h.feedback(False)  # late confirmation of the PRE-stall resume cannot unlock
    assert h.session.core.latch
    h.feedback(True)
    h.unlock()
    assert h.session.core.resume_pending is not None
    h.feedback(False)
    assert not h.session.core.latch


def test_every_stall_records_its_own_diagnostic_including_fatal_third():
    clock, logs, done = Clock(), [], threading.Event()
    def write(text):
        logs.append(text)
        if len(logs) == 3:
            done.set()
    diagnostic = StallDiagnostics(now=clock, write=write, dump=lambda: 'stub stack\n')
    diagnostic.start()
    sink = RosSink(lambda v: None, lambda: None, lambda: None,
                   now=clock, watchdog=False, diagnostics=diagnostic)
    try:
        for index in range(3):
            trip(sink, clock)
            if index < 2:
                sink.flush()
        assert done.wait(1)
        stamps = [json.loads(text.splitlines()[0].removeprefix('ROS publisher stall diagnostics '))
                  ['detected_monotonic_s'] for text in logs]
        assert stamps == [.301, .602, .903]
        assert sink.error is not None
    finally:
        sink.close()
        diagnostic.close()


def test_independent_watchdog_stall_keeps_bridge_failure_wait_pending(ros, monkeypatch):
    """Real bridge threads, stub rclpy: the entrypoint's failure task stays alive."""
    from rclpy.executors import SingleThreadedExecutor
    pause, entered, release = (threading.Event() for _ in range(3))
    original = SingleThreadedExecutor.spin_once
    def spin(executor, **kwargs):
        if pause.is_set():
            entered.set()
            assert release.wait(2)
        original(executor, **kwargs)
    monkeypatch.setattr(SingleThreadedExecutor, 'spin_once', spin)
    async def run():
        node = RosNode(config())
        sink = await node.start(lambda raw: None)
        failure = asyncio.create_task(node.wait_failure())
        try:
            ros.events.clear()
            pause.set()
            assert await asyncio.to_thread(entered.wait, 1)
            deadline = time.monotonic() + 1
            while (sink.output_safety()[0] == 0 or not any(e[0] == '/v2_live/stop' for e in ros.events)) and time.monotonic() < deadline:
                sink.apply(MotionCommand())
                await asyncio.sleep(.01)
            assert sink.output_safety() == (1, True)
            sink.check_health()
            assert not failure.done() and node._thread.is_alive() and sink._watchdog.is_alive()
            assert any(e[0] == '/v2_live/cmd_vel' and e[2] == Z for e in ros.events)
            assert any(e[0] == '/v2_live/stop' for e in ros.events)
            release.set()
            while sink._publisher_expired and time.monotonic() < deadline:
                sink.apply(MotionCommand())
                await asyncio.sleep(.01)
            assert not sink._publisher_expired and sink._held and not failure.done()
        finally:
            release.set()
            node.close()
            failure.cancel()
            await asyncio.gather(failure, return_exceptions=True)
    asyncio.run(run())
