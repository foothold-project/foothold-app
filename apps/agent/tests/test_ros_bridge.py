"""ROS-free adapter contract tests: no DDS participant or network is created."""

import asyncio
from copy import deepcopy
import threading
import time
from types import SimpleNamespace

import pytest

from foothold_agent.link.session import MotionCommand, Session
from foothold_agent.ros_bridge.config import Config, DDS_OVERRIDES, REQUIRED_ENV, validate_isolation
from foothold_agent.ros_bridge.node import Inputs, LatestMailbox, RosNode
from foothold_agent.ros_bridge.sink import RosSink, twist_message
from foothold_agent.ros_bridge.telemetry import MapBinding, StateGate, Telemetry
from foothold_agent.safety.core import Z


class Clock:
    t = 0.0

    def __call__(self):
        return self.t


class Loop:
    def __init__(self):
        self.calls = []

    def call_soon_threadsafe(self, f):
        self.calls.append(f)

    def drain(self):
        while self.calls:
            self.calls.pop(0)()


def state(**changes):
    return {"schema": "v2_live/state/1", "episode": 1, "stop_requested": True,
            "reset_in_progress": False, "policy_running": True,
            "sim_t": 1.0, "vx": 0.3, "vy": 0.4, "source": "gz_gt", **changes}


def make_sink(clock=None, *, watchdog=False):
    outputs = []
    sink = RosSink(lambda v: outputs.append(("velocity", v)),
                   lambda: outputs.append(("stop",)), lambda: outputs.append(("resume",)),
                   now=clock or time.monotonic, watchdog=watchdog)
    return sink, outputs


def activate(sink, outputs):
    sink.apply(MotionCommand("unlock"))
    sink.flush()
    outputs.clear()


@pytest.mark.parametrize("domain", [None, "61", "57", "0", "", "093", 93])
def test_reject_domain(domain):
    env = {**REQUIRED_ENV, "ROS_DOMAIN_ID": domain}
    with pytest.raises(ValueError, match="ROS_DOMAIN_ID"):
        validate_isolation(env)


@pytest.mark.parametrize("key,value", [("ROS_LOCALHOST_ONLY", None),
    ("ROS_LOCALHOST_ONLY", "0"), ("ROS_AUTOMATIC_DISCOVERY_RANGE", "SUBNET"),
    ("ROS_AUTOMATIC_DISCOVERY_RANGE", None)])
def test_reject_nonlocal_discovery(key, value):
    with pytest.raises(ValueError):
        validate_isolation({**REQUIRED_ENV, key: value})


@pytest.mark.parametrize("key", DDS_OVERRIDES)
def test_reject_dds_overrides(key):
    with pytest.raises(ValueError, match="overrides"):
        validate_isolation({**REQUIRED_ENV, key: "custom-profile"})


def test_config_requires_explicit_identity_credentials_and_hides_them():
    env = {**REQUIRED_ENV, "FOOTHOLD_ROBOT_ID": "00000000-0000-4000-8000-000000000001",
           "FOOTHOLD_AGENT_WS_URL": "ws://127.0.0.1/api/v1/agent/ws", "FOOTHOLD_AGENT_TOKEN": "stub-only"}
    config = Config.from_env(env)
    assert config.robot_id == env["FOOTHOLD_ROBOT_ID"]
    assert "stub-only" not in repr(config) and "127.0.0.1" not in repr(config)
    for key in ("FOOTHOLD_ROBOT_ID", "FOOTHOLD_AGENT_WS_URL", "FOOTHOLD_AGENT_TOKEN"):
        missing = dict(env)
        missing.pop(key)
        with pytest.raises(ValueError):
            Config.from_env(missing)
    assert Session().core.latch and Session().core.resume_pending is None


def test_twist_si_mapping():
    def factory():
        return SimpleNamespace(linear=SimpleNamespace(x=0.0, y=0.0, z=0.0),
                               angular=SimpleNamespace(x=0.0, y=0.0, z=0.0))
    m = twist_message((0.6, -0.12, 0.5), factory)
    assert (m.linear.x, m.linear.y, m.angular.z) == (0.6, -0.12, 0.5)
    assert (m.linear.z, m.angular.x, m.angular.y) == Z


def test_latest_only_and_stop_discards_nonzero():
    clock = Clock()
    sink, outputs = make_sink(clock)
    activate(sink, outputs)
    for i in range(1000):
        sink.apply(MotionCommand(velocity=(i / 1000, 0, 0.5)))
    clock.t = 0.05
    sink.flush()
    assert outputs == [("velocity", (0.999, 0.0, 0.5))]
    sink.apply(MotionCommand(velocity=(0.6, 0, -0.5)))
    sink.apply(MotionCommand("stop"))
    outputs.clear()
    sink.flush()
    assert ("velocity", Z) in outputs and ("stop",) in outputs
    assert not any(v[0] == "velocity" and v[1] != Z for v in outputs)
    sink.apply(MotionCommand(velocity=(0.6, 0, 0)))
    clock.t += 0.05
    sink.flush()
    assert outputs[-1] == ("velocity", Z)


def test_unlock_once_never_retried_and_stop_cancels_pending_unlock():
    clock = Clock()
    sink, outputs = make_sink(clock)
    sink.apply(MotionCommand("unlock"))
    sink.apply(MotionCommand("unlock"))
    sink.flush()
    for i in range(1, 5):
        clock.t = i * 0.05
        sink.apply(MotionCommand())
        sink.flush()
    assert outputs.count(("resume",)) == 1
    sink.apply(MotionCommand("stop"))
    sink.apply(MotionCommand("unlock"))
    sink.apply(MotionCommand("stop"))
    sink.flush()
    assert outputs.count(("resume",)) == 1


@pytest.mark.parametrize("action", ["stop", "unlock"])
def test_watchdog_exact_deadline_stop_unlock_cannot_extend(action):
    clock = Clock()
    sink, outputs = make_sink(clock)
    activate(sink, outputs)
    sink.apply(MotionCommand(velocity=(0.6, 0, 0)))
    for stamp in (0.1, 0.2, 0.299):
        clock.t = stamp
        sink.apply(MotionCommand(action))
        sink.flush()
    outputs.clear()
    clock.t = 0.3
    sink.check_watchdog()
    assert outputs == [("velocity", Z), ("stop",)]
    sink.observe_stop()
    sink.apply(MotionCommand("unlock"))
    sink.flush()
    assert ("resume",) not in outputs  # no apply heartbeat after watchdog expiry


def test_watchdog_runs_when_asyncio_loop_is_blocked():
    async def blocked():
        sink, outputs = make_sink(watchdog=True)
        try:
            activate(sink, outputs)
            sink.apply(MotionCommand(velocity=(0.6, 0, 0)))
            sink.flush()  # real clock: flush at next 20 Hz tick not required for deadline
            outputs.clear()
            time.sleep(0.37)  # deliberately block the owning asyncio loop
            assert ("velocity", Z) in outputs and ("stop",) in outputs
            assert sink._watchdog.is_alive()
        finally:
            sink.close()
        assert not sink._watchdog.is_alive()
    asyncio.run(blocked())


def test_watchdog_detects_executor_stall_despite_fresh_apply():
    clock = Clock()
    sink, outputs = make_sink(clock)
    activate(sink, outputs)
    clock.t = 0.299
    sink.apply(MotionCommand(velocity=(0.6, 0, 0)))
    clock.t = 0.301
    sink.check_watchdog()
    assert outputs[-2:] == [("velocity", Z), ("stop",)]
    with pytest.raises(RuntimeError, match="output failed"):
        sink.check_health()


def test_error_and_shutdown_zero_stop_no_resume_or_nonzero_after_error():
    sink, outputs = make_sink()
    activate(sink, outputs)
    sink.apply(MotionCommand(velocity=(0.6, 0, 0)))
    sink.fail(RuntimeError("executor failed"))
    assert outputs[-2:] == [("velocity", Z), ("stop",)]
    with pytest.raises(RuntimeError):
        sink.apply(MotionCommand("unlock"))
    outputs.clear()
    sink.close()
    assert outputs == [("velocity", Z), ("stop",)]
    sink.close()
    assert len(outputs) == 2
    with pytest.raises(RuntimeError):
        sink.apply(MotionCommand())


def test_zero_failure_still_attempts_stop_and_resume_failure_never_retries():
    calls = []
    def broken_velocity(v):
        calls.append(v)
        raise RuntimeError("publisher failed")
    sink = RosSink(broken_velocity, lambda: calls.append("STOP"), lambda: None, watchdog=False)
    sink.fail(ValueError("first"))
    assert calls == [Z, "STOP"] and isinstance(sink.error, ValueError)
    calls.clear()
    def broken_resume():
        calls.append("RESUME")
        raise RuntimeError("resume failed")
    sink = RosSink(lambda v: calls.append(v), lambda: calls.append("STOP"), broken_resume, watchdog=False)
    sink.apply(MotionCommand("unlock"))
    with pytest.raises(RuntimeError):
        sink.flush()
    assert calls.count("RESUME") == 1 and calls[-2:] == [Z, "STOP"]
    with pytest.raises(RuntimeError):
        sink.flush()
    assert calls.count("RESUME") == 1


@pytest.mark.parametrize("velocity", [(float("nan"), 0, 0), (0, float("inf"), 0),
                                       (True, 0, 0), (10**400, 0, 0), {0.6: 1, 0.2: 1, 0.5: 1}, None])
def test_invalid_output_held(velocity):
    sink, outputs = make_sink()
    activate(sink, outputs)
    with pytest.raises(ValueError):
        sink.apply(MotionCommand(velocity=velocity))
    sink.flush()
    assert outputs[-2:] == [("velocity", Z), ("stop",)]


def test_mailbox_one_callback_latest_bundle_sticky_rejection_and_close():
    loop, received = Loop(), []
    mailbox = LatestMailbox(loop, received.append)
    mailbox.put(invalid="bad", state=None)
    for i in range(1000):
        mailbox.put(state={"episode": i})
    assert len(loop.calls) == 1
    loop.drain()
    assert received == [{"invalid": "bad", "state": {"episode": 999}}]
    mailbox.put(state="discarded")
    mailbox.close()
    loop.drain()
    mailbox.put(state="closed")
    assert len(received) == 1 and not loop.calls


@pytest.mark.parametrize("changes", [{"episode": True}, {"episode": -1},
    {"stop_requested": 1}, {"policy_running": "true"}, {"schema": "wrong"},
    {"sim_t": float("nan")}, {"vx": float("inf")}, {"cmd_applied": [0, 0, float("nan")]},
    {"sim_t": 10**400}])
def test_reject_invalid_safety_state(changes):
    gate = StateGate()
    assert gate.accept(state(**changes), 0, 0) is None


def test_episode_rewind_stale_duplicate_and_sim_time_rewind():
    gate = StateGate()
    assert gate.accept(state(), 0, 0)
    assert gate.accept(state(episode=0, sim_t=2), 0, 0) is None
    assert gate.accept(state(sim_t=2), 0, 1.001) is None
    assert gate.accept(state(sim_t=2), 1, 0) is None
    assert gate.accept(state(), 0, 0) is None  # replay doesn't refresh safety
    assert gate.accept(state(sim_t=0.5), 0, 0) is None
    assert gate.accept(state(sim_t=3), 0, 0) is None  # episode quarantined
    assert gate.accept(state(episode=2, sim_t=0), 0, 0)


def test_feedback_only_on_owner_latest_validated_and_delayed_state_rejected():
    clock, loop = Clock(), Loop()
    sink, outputs = make_sink(clock)
    session = Session(now=clock)
    owner = threading.get_ident()
    calls = []
    def on_state(raw):
        calls.append(threading.get_ident())
        session.on_robot_state(raw)
    inputs = Inputs(loop, sink, on_state, now=clock)
    producer = threading.Thread(target=lambda: [inputs.state(state(sim_t=i)) for i in range(1, 100)])
    producer.start()
    producer.join()
    assert calls == [] and len(loop.calls) == 1
    loop.drain()
    assert calls == [owner] and session.core.st["sim_t"] == 99
    inputs.state(state(sim_t=100))
    clock.t = 1.001
    loop.drain()
    assert len(calls) == 1 and inputs.telemetry.snapshot()["speed"] is None
    sink.flush()
    assert ("velocity", Z) in outputs and ("stop",) in outputs
    assert not any(v[0] == "velocity" and v[1] != Z for v in outputs)


def test_invalid_state_immediate_hold_then_real_stop_and_approved_unlock_required():
    clock, loop = Clock(), Loop()
    sink, outputs = make_sink(clock)
    activate(sink, outputs)
    inputs = Inputs(loop, sink, lambda raw: None, now=clock)
    sink.apply(MotionCommand(velocity=(0.6, 0, 0)))
    inputs.state(state(vx=float("nan")))
    sink.flush()  # ROS thread does not wait for asyncio to notice the invalid frame
    assert outputs[-2:] == [("velocity", Z), ("stop",)]
    inputs.state(state(stop_requested=False))
    loop.drain()
    sink.apply(MotionCommand("unlock"))
    sink.flush()
    assert ("resume",) not in outputs
    inputs.state(state(sim_t=2, stop_requested=True))
    loop.drain()
    sink.apply(MotionCommand("unlock"))
    sink.flush()
    assert outputs.count(("resume",)) == 1


def test_inputs_reset_stale_and_callback_failure():
    clock, loop = Clock(), Loop()
    sink, outputs = make_sink(clock)
    inputs = Inputs(loop, sink, lambda raw: None, now=clock)
    inputs.state(state())
    loop.drain()
    assert inputs.telemetry.snapshot()["speed"] == 0.5
    inputs.state(state(sim_t=2, reset_in_progress=True))
    loop.drain()
    assert inputs.telemetry.snapshot()["speed"] is None
    clock.t = 1.01
    inputs.stale()
    loop.drain()
    assert inputs.telemetry.events[-1]["reason"] == "stale"
    failures = []
    def fail(raw):
        raise RuntimeError("callback failure")
    inputs = Inputs(loop, sink, fail, now=clock, on_error=failures.append)
    inputs.state(state())
    loop.drain()
    assert failures and sink.error is failures[0]
    assert outputs[-2:] == [("velocity", Z), ("stop",)]


def binding():
    return MapBinding("test_world", "f1", "registered-v1",
                      "00000000-0000-4000-8000-000000000001",
                      "00000000-0000-4000-8000-000000000002", "a" * 64, 1, "test-run")


def status(**changes):
    return {"schema": "v2_map_status/1", "world_id": "test_world", "floor_id": "f1",
            "map_version": "registered-v1", "map_frame": "map", "map_accepting": True,
            "epoch": 1, "run_id": "test-run", "sim_t": 1.0,
            "pose_map": {"x": 3.0, "y": 4.0, "yaw": 0.5, "stamp_sim": 1.0, "source": "gt_identity"},
            **changes}


def test_measured_telemetry_no_fabricated_values_odom_never_map():
    clock = Clock()
    telemetry = Telemetry(now=clock)
    assert telemetry.snapshot() == {"speed": None, "speed_source": None,
        "battery": {"soc": None}, "location": None, "observation": None}
    telemetry.update_state(state(), 0)
    telemetry.update_odom({"frame_id": "odom", "child_frame_id": "base", "sim_t": 1,
        "received_monotonic_s": 0, "x": 50, "y": 60, "vx": 10, "vy": 10, "wz": 1})
    telemetry.update_map(status(), 0)  # no explicitly verified binding
    snap = telemetry.snapshot()
    assert snap["speed"] == 0.5 and snap["speed_source"] == "state_com"
    assert snap["battery"]["soc"] is None and snap["location"] is None
    assert telemetry.odom["episode"] == 1
    clock.t = 1.001
    assert telemetry.snapshot()["speed"] is None and telemetry.odom is None


def test_valid_map_binding_and_time_reset_null():
    clock = Clock()
    telemetry = Telemetry(now=clock, binding=binding())
    telemetry.update_state(state(), 0)
    telemetry.update_map(status(), 0)
    location = telemetry.snapshot()["location"]
    assert location["x"] == 3 and location["confidence"] is None
    assert location["sha256"] == "a" * 64 and location["map_version_id"] == binding().map_version_id
    telemetry.update_state(state(sim_t=0.5), 0)
    assert telemetry.snapshot()["location"] is None and telemetry.snapshot()["speed"] is None
    telemetry.update_state(state(episode=2, sim_t=0, reset_in_progress=True), 0)
    assert telemetry.snapshot()["observation"] is None
    telemetry.update_state(state(episode=2, sim_t=1, vx=None), 0)
    assert telemetry.snapshot()["speed"] is None
    telemetry.update_map(status(epoch=2), 0)
    assert telemetry.snapshot()["location"] is None  # old binding is unusable after RESET


@pytest.mark.parametrize("changes", [{"world_id": "other"}, {"floor_id": "other"},
    {"map_version": "other"}, {"epoch": 0}, {"epoch": True}, {"run_id": "old-run"},
    {"sim_t": -1}, {"sim_t": 2}, {"map_accepting": False}, {"map_frame": "odom"},
    {"pose_map": {"x": 0, "y": 0, "yaw": 0, "stamp_sim": 1, "source": "odom"}},
    {"pose_map": {"x": float("nan"), "y": 0, "yaw": 0, "stamp_sim": 1, "source": "gt_identity"}}])
def test_bad_map_binding_yields_null(changes):
    telemetry = Telemetry(now=Clock(), binding=binding())
    telemetry.update_state(state(), 0)
    telemetry.update_map(status(**changes), 0)
    assert telemetry.snapshot()["location"] is None


def test_map_and_odom_source_time_rewind_quarantines_display():
    telemetry = Telemetry(now=Clock(), binding=binding())
    telemetry.update_state(state(), 0)
    telemetry.update_map(status(), 0)
    assert telemetry.snapshot()["location"] is not None
    rewind = status(sim_t=0.9)
    rewind["pose_map"]["stamp_sim"] = 0.9
    telemetry.update_map(rewind, 0)
    assert telemetry.snapshot()["location"] is None
    telemetry.update_map(status(), 0)
    assert telemetry.snapshot()["location"] is None
    odom = {"frame_id": "odom", "child_frame_id": "base", "sim_t": 1,
        "received_monotonic_s": 0, "x": 5, "y": 6, "vx": 1, "vy": 1, "wz": 0}
    telemetry.update_odom(odom)
    assert telemetry.odom is not None
    telemetry.update_odom({**odom, "sim_t": 0.9})
    assert telemetry.odom is None
    telemetry.update_odom(odom)
    assert telemetry.odom is None


def test_speed_overflow_stays_unknown():
    telemetry = Telemetry(now=Clock())
    telemetry.update_state(state(vx=1.7e308, vy=1.7e308), 0)
    assert telemetry.snapshot()["speed"] is None


def test_apply_stop_does_not_wait_for_publisher_and_supersedes_inflight_motion():
    clock = Clock()
    entered, release = threading.Event(), threading.Event()
    outputs = []
    def publish(v):
        if v != Z:
            entered.set()
            assert release.wait(1)
        outputs.append(("velocity", v))
    sink = RosSink(publish, lambda: outputs.append(("stop",)), lambda: None,
                   now=clock, watchdog=False)
    activate(sink, outputs)
    sink.apply(MotionCommand(velocity=(0.6, 0, 0)))
    clock.t = 0.05
    thread = threading.Thread(target=sink.flush)
    thread.start()
    assert entered.wait(1)
    try:
        before = time.monotonic()
        sink.apply(MotionCommand("stop"))
        assert time.monotonic() - before < 0.05
    finally:
        release.set()
        thread.join(timeout=1)
    assert not thread.is_alive()
    assert outputs[-2:] == [("velocity", Z), ("stop",)]
