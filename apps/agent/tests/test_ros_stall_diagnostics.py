"""ROS-free stall instrumentation; no DDS participant or socket is created."""

import asyncio
import json
import threading

import pytest

from foothold_agent.link.session import MotionCommand
from foothold_agent.ros_bridge.diagnostics import StallDiagnostics, thread_stacks
from foothold_agent.ros_bridge.node import RosNode
from foothold_agent.ros_bridge.sink import RosSink
from foothold_agent.safety.core import Z
from test_ros_bridge import Clock
from test_ros_bridge_node import config, ros


def test_stall_stamps_are_detection_snapshot_and_dump_is_once_off_watchdog():
    clock, logs = Clock(), []
    entered, release = threading.Event(), threading.Event()
    def write(message):
        entered.set()
        assert release.wait(2)
        logs.append((threading.current_thread().name, message))
    diagnostic = StallDiagnostics(now=clock, write=write, dump=lambda: "stub stack\n")
    diagnostic.start()
    outputs = []
    sink = RosSink(outputs.append, lambda: outputs.append('STOP'), lambda: None,
                   now=clock, watchdog=False, diagnostics=diagnostic)
    try:
        sink.flush()
        clock.t = .301
        sink.apply(MotionCommand(velocity=Z))
        diagnostic.mark('spin', 'start')
        sink.check_watchdog()
        assert entered.wait(1)
        # Even a blocked diagnostic log cannot delay the original emergency.
        assert outputs[-2:] == [Z, 'STOP']
        assert str(sink.error) == 'ROS publisher loop stalled'
        with pytest.raises(RuntimeError, match='ROS output failed'):
            sink.check_health()
        clock.t = 10
        diagnostic.mark('spin', 'end')
        sink.check_watchdog()
    finally:
        release.set()
        sink.close()
        diagnostic.close()
    assert len(logs) == 1
    name, text = logs[0]
    assert name == 'ros-stall-diagnostics'
    data = json.loads(text.splitlines()[0].removeprefix('ROS publisher stall diagnostics '))
    assert data['detected_monotonic_s'] == .301
    assert data['last_apply_monotonic_s'] == .301
    assert data['last_flush_monotonic_s'] == 0
    assert data['phases']['flush_start'] == data['phases']['flush_end'] == 0
    assert data['phases']['spin_start'] == .301 and 'spin_end' not in data['phases']
    assert not diagnostic._thread.is_alive()


def test_blocked_publisher_still_requests_diagnostic_before_emergency_lock_wait():
    clock, outputs = Clock(), []
    publishing, release, captured = (threading.Event() for _ in range(3))
    diagnostic = StallDiagnostics(now=clock, write=lambda text: captured.set(), dump=lambda: 'stub stack')
    diagnostic.start()
    def velocity(v):
        publishing.set()
        assert release.wait(2)
        outputs.append(v)
    sink = RosSink(diagnostic.wrap('publish_velocity', velocity), lambda: outputs.append('STOP'),
                   lambda: None, now=clock, watchdog=False, diagnostics=diagnostic)
    errors = []
    def flush():
        try:
            sink.flush()
        except BaseException as exc:
            errors.append(exc)
    publisher = threading.Thread(target=flush)
    watchdog = threading.Thread(target=sink.check_watchdog)
    try:
        publisher.start()
        assert publishing.wait(1)
        clock.t = .301
        sink.apply(MotionCommand(velocity=Z))
        watchdog.start()
        assert captured.wait(1), 'diagnostic blocked behind the publisher output lock'
        assert watchdog.is_alive()  # emergency still awaits the existing output lock
        assert diagnostic._incident['phases']['publish_velocity_start'] == 0
        assert 'publish_velocity_end' not in diagnostic._incident['phases']
    finally:
        release.set()
        publisher.join(2)
        if watchdog.ident is not None:
            watchdog.join(2)
        sink.close()
        diagnostic.close()
    assert not publisher.is_alive() and not watchdog.is_alive() and not errors
    assert outputs[-2:] == [Z, 'STOP']


def test_deadman_expiry_is_unchanged_and_does_not_request_stall_dump():
    clock, logs, outputs = Clock(), [], []
    diagnostic = StallDiagnostics(now=clock, write=logs.append)
    diagnostic.start()
    sink = RosSink(outputs.append, lambda: outputs.append('STOP'), lambda: None,
                   now=clock, watchdog=False, diagnostics=diagnostic)
    try:
        sink.flush()
        clock.t = .301
        sink.check_watchdog()
        assert outputs[-2:] == [Z, 'STOP']
        sink.check_health()
        assert diagnostic._incident is None
    finally:
        sink.close()
        diagnostic.close()
    assert not logs


def test_dump_failure_cannot_change_sink_error_or_emergency():
    clock, logs, outputs = Clock(), [], []
    def broken_dump():
        raise RuntimeError('private exception text must not be logged')
    diagnostic = StallDiagnostics(now=clock, write=logs.append, dump=broken_dump)
    diagnostic.start()
    sink = RosSink(outputs.append, lambda: outputs.append('STOP'), lambda: None,
                   now=clock, watchdog=False, diagnostics=diagnostic)
    try:
        clock.t = .301
        sink.apply(MotionCommand(velocity=Z))
        sink.check_watchdog()
        assert outputs[-2:] == [Z, 'STOP']
        assert str(sink.error) == 'ROS publisher loop stalled'
    finally:
        sink.close()
        diagnostic.close()
    assert logs == ['ROS stall diagnostics unavailable: RuntimeError\n']


def test_real_faulthandler_dump_strips_paths_and_never_prints_source_or_locals():
    entered, release = threading.Event(), threading.Event()
    namespace = dict(entered=entered, release=release)
    exec(compile('def waiting():\n credential = "private-local-sentinel"\n entered.set()\n release.wait(2)\n',
                 '/private/diagnostic/stack_probe.py', 'exec'), namespace)
    worker = threading.Thread(target=namespace['waiting'])
    worker.start()
    try:
        assert entered.wait(1)
        text = thread_stacks()
    finally:
        release.set()
        worker.join(2)
    assert 'File "stack_probe.py", line 4 in waiting' in text
    assert '/private/diagnostic' not in text and 'private-local-sentinel' not in text
    assert 'File "/' not in text


def test_node_records_ros_phases_and_stops_idle_diagnostic_thread(ros):
    async def run():
        node = RosNode(config())
        await node.start(lambda raw: None)
        try:
            ros.subscriptions['/v2_live/sensor/d435i/depth/image_mm'](object())
            phases = node.diagnostics._phases
            for phase in ('spin', 'discovery', 'flush', 'publish_velocity', 'publish_stop', 'callback_sensor'):
                assert phase + '_start' in phases and phase + '_end' in phases
            assert node.diagnostics._incident is None
        finally:
            node.close()
        assert not node.diagnostics._thread.is_alive()
    asyncio.run(run())
