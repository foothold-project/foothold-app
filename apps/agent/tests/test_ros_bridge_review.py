"""PR15 regressions using the real unchanged Session/Core and local Client port."""

import pytest

from test_ros_bridge import Clock, Loop, state, make_sink, activate
from foothold_agent.link.client import Client, Settings
from foothold_agent.link.session import MotionCommand, Session
from foothold_agent.ros_bridge.config import validate_isolation, REQUIRED_ENV
from foothold_agent.ros_bridge.node import Inputs, require_single_writer, wait_for_stop_acks
from foothold_agent.ros_bridge.telemetry import Telemetry
from foothold_agent.safety.core import Z
from types import SimpleNamespace


class Harness:
    def __init__(self):
        self.clock, self.loop = Clock(), Loop()
        self.sink, self.out = make_sink(self.clock)
        self.session = Session(now=self.clock)
        self.client = Client(self.session, self.sink, Settings("ws://127.0.0.1/agent", "stub-only"))
        self.inputs = Inputs(self.loop, self.sink, self.client.on_robot_state, now=self.clock)
        self.seq = 0
        self.client._emit(self.session.connect())
        self.sink.flush()
        self.feedback(True)
        self.frame(t="lease", lease_id="L", holder_type="USER")

    def frame(self, **frame):
        self.client._emit(self.session.receive(frame))
        self.sink.flush()

    def feedback(self, stopped, *, stamp=None):
        self.clock.t += 0.01
        self.inputs.state(state(sim_t=self.clock.t if stamp is None else stamp, stop_requested=stopped))
        self.loop.drain()
        self.sink.flush()

    def unlock(self):
        self.frame(t="unlock", lease_id="L", stop_gen=self.session.core.stop_gen)

    def moving(self):
        self.unlock()
        self.feedback(False)
        self.cmd([0, 0, 0])
        self.clock.t += .06
        self.cmd([1, 0, 0])
        assert ("velocity", (.6, 0, 0)) in self.out

    def cmd(self, axes):
        self.seq += 1
        self.frame(t="cmd", lease_id="L", seq=self.seq, axes=axes)


def test_new_stop_bypasses_previous_stop_retry_limit():
    h = Harness()
    h.moving()
    assert h.clock.t < .5
    h.out.clear()
    h.frame(t="stop")
    assert h.out[-2:] == [("velocity", Z), ("stop",)]
    h.out.clear()
    for _ in range(3):
        h.clock.t += .05
        h.client._emit(h.session.tick())
        h.sink.flush()
    assert ("stop",) not in h.out  # only this same unconfirmed STOP is throttled


def test_external_stop_allows_second_core_approved_resume_and_late_true_does_not_retry():
    h = Harness()
    h.moving()
    h.feedback(True)  # autonomous simulator STOP: Core emits no stop action
    assert h.session.core.latch
    h.unlock()
    assert h.session.core.resume_pending is not None
    assert h.out.count(("resume",)) == 2
    h.feedback(True)  # late feedback after the request is not another unlock
    assert h.out.count(("resume",)) == 2
    h.feedback(False)
    assert not h.session.core.latch and h.session.core.resume_pending is None
    h.cmd([1, 0, 0])
    assert h.session.core.out == Z  # still requires fresh neutral
    h.cmd([0, 0, 0])
    h.clock.t += .06
    h.cmd([1, 0, 0])
    assert h.out[-1] == ("velocity", (.6, 0, 0))


def test_duplicate_sim_stamp_does_not_stop_or_extend_state_freshness():
    h = Harness()
    h.moving()
    stamp = h.session.core.st["sim_t"]
    received = h.session.core.state_t
    h.out.clear()
    h.feedback(False, stamp=stamp)
    assert not h.sink._held and not h.session.core.latch
    assert h.session.core.state_t == received
    assert ("stop",) not in h.out
    h.clock.t = received + 1.001
    h.inputs.state(state(sim_t=stamp, stop_requested=False))
    h.inputs.stale()
    h.loop.drain()
    assert h.sink._held
    assert h.inputs.telemetry.snapshot()["speed"] is None


def test_old_stop_confirmation_cannot_release_newer_hold():
    clock, loop = Clock(), Loop()
    sink, _ = make_sink(clock)
    inputs = Inputs(loop, sink, lambda raw: None, now=clock)
    inputs.state(state())
    # Simulate S1 removed from mailbox, then S2 invalid hold before observe_stop.
    consume = inputs.mailbox.consume
    def interleave(bundle):
        sink.hold()
        consume(bundle)
    inputs.mailbox.consume = interleave
    loop.drain()
    assert sink._held
    sink.apply(MotionCommand("unlock"))
    assert not sink._resume_pending


@pytest.mark.parametrize("topic", ["/v2_live/cmd_vel", "/v2_live/stop", "/v2_live/resume"])
def test_writer_conflict_is_rejected_for_every_command_topic(topic):
    with pytest.raises(RuntimeError, match="writer conflict"):
        require_single_writer(SimpleNamespace(count_publishers=lambda t: 2 if t == topic else 1))


@pytest.mark.parametrize("name", ["DEFAULT_FASTDDS_PROFILES.xml", "DEFAULT_FASTRTPS_PROFILES.xml"])
def test_automatic_cwd_dds_profile_rejected(tmp_path, monkeypatch, name):
    monkeypatch.chdir(tmp_path)
    (tmp_path / name).write_text("<profiles/>")
    with pytest.raises(ValueError, match="automatic DDS profiles"):
        validate_isolation(REQUIRED_ENV)


def test_unverified_odometry_header_clock_is_explicitly_unknown():
    t = Telemetry(now=Clock())
    t.update_state(state(), 0)
    t.update_odom({"header_stamp": 1792420000, "clock": "unverified", "frame_id": "odom",
                   "child_frame_id": "base", "received_monotonic_s": 0,
                   "x": 0, "y": 0, "vx": 0, "vy": 0, "wz": 0})
    assert t.odom is None and t.odom_reason == "clock_unverified"


def test_shutdown_ack_timeout_is_visible_and_budget_is_shared():
    calls = []
    clock = Clock()
    def first(duration):
        calls.append(duration)
        clock.t += .75
        return True
    def second(duration):
        calls.append(duration)
        return False
    with pytest.raises(RuntimeError, match="acknowledgement timed out"):
        wait_for_stop_acks([SimpleNamespace(wait_for_all_acked=first), SimpleNamespace(wait_for_all_acked=second)],
                           lambda **kw: kw["seconds"], now=clock)
    assert calls == [1, .25]


def test_approved_unlock_discards_old_local_velocity_before_resume():
    sink, out = make_sink(Clock())
    activate(sink, out)
    sink.apply(MotionCommand(velocity=(.6, 0, 0)))
    sink.apply(MotionCommand("unlock"))
    sink.flush()
    assert ("resume",) in out
    assert all(value == Z for kind, *rest in out if kind == "velocity" for value in rest)
