"""Offline acceptance tests. Fresh local bridge feedback is explicit, never forged by WS."""

import json
import random
import subprocess
import sys
from pathlib import Path

import pytest

from foothold_agent.link.session import Session
from foothold_agent.safety.core import SCHEMA, Z

F = [1, 0, 0]
N = [0, 0, 0]


class Harness:
    def __init__(self, holder="USER", wait=30):
        self.t = 0.0
        self.s = Session(lambda: self.t)
        self.s.connect()
        self.seq = 0
        self.lease("lease-a", holder)
        self.unlock()
        if holder == "RUN":
            self.s.receive({"t": "run.start", "run_id": "run-a",
                            "plan": {"segments": []}, "missions": {},
                            "policy": {"link_loss_wait_s": wait}})
            self.s.executor_command("run-a", N)
            self.s.executor_command("run-a", F)
        else:
            self.cmd(N)
            self.cmd(F)
        assert self.s.tick().motion[-1].velocity == (0.6, 0, 0)

    def state(self, stop=False, **kw):
        return self.s.on_robot_state({"schema": SCHEMA, "episode": 0,
            "stop_requested": stop, "reset_in_progress": False,
            "policy_running": True, **kw})

    def lease(self, lease, holder="USER"):
        return self.s.receive({"t": "lease", "lease_id": lease,
                               "holder_type": "RUN:run-a" if holder == "RUN" else holder})

    def unlock(self):
        self.state(True)
        result = self.s.receive({"t": "unlock", "lease_id": self.s.lease_id,
                                 "stop_gen": self.s.core.stop_gen})
        assert any(m.kind == "unlock" for m in result.motion)
        self.state(False)
        assert not self.s.core.latch

    def cmd(self, axes, **kw):
        self.seq += 1
        return self.s.receive({"t": "cmd", "lease_id": self.s.lease_id,
                               "seq": self.seq, "axes": axes, "t_server": "ignored", **kw})

    def advance_run(self, end, *, server=False):
        start = round(self.t * 20)
        for i in range(start + 1, round(end * 20) + 1):
            self.t = i / 20
            self.state()
            if server:
                self.s.receive({"t": "ping", "t_server": "arbitrary remote clock"})
            self.s.executor_command("run-a", F)
        return self.s.tick()


def zero(effects):
    return effects.motion[-1].velocity == Z


def test_startup_stdlib_import_and_sans_io(tmp_path, capsys):
    s = Session(lambda: 0)
    assert s.core.latch and zero(s.tick())
    e = s.connect()
    assert e.motion[0].kind == "stop" and zero(e)
    assert e.messages[0]["t"] == "hello" and e.messages[0]["latched"]
    assert e.messages[0]["lease_id"] is None and e.messages[0]["run"] is None
    assert capsys.readouterr().out == ""
    root = str(Path(__file__).resolve().parents[1])
    code = f"""
import sys
sys.path.insert(0, {root!r})
from foothold_agent.link.client import Client
from foothold_agent.link.session import Session
assert Session(lambda: 0).tick().motion[-1].velocity == (0, 0, 0)
assert not any(x in sys.modules for x in ('websockets', 'rclpy', 'sim', 'server'))
"""
    subprocess.run([sys.executable, "-I", "-S", "-c", code], cwd=tmp_path, check=True)


def test_lease_null_is_immediate_even_if_stop_never_arrives():
    h = Harness()
    gen = h.s.core.stop_gen
    assert zero(h.lease(None))
    assert h.s.core.need_neutral and h.s.core.intent == Z
    h.t = 0.01  # two messages of the handoff separated by a broken connection
    h.s.disconnect()
    assert zero(h.cmd(F, lease_id="lease-a"))
    assert h.s.core.stop_gen > gen


def test_handoff_state_ack_then_new_lease_locked_and_new_neutral():
    h = Harness()
    h.lease(None)
    gen = h.s.core.stop_gen
    t_stop = h.t
    effects = h.s.receive({"t": "stop", "by_user_id": "any-viewer"})
    ack = next(m for m in effects.messages if m["t"] == "state")
    assert h.t - t_stop < 2
    assert ack["latched"] and ack["applied"] == [0, 0, 0] and ack["stop_gen"] > gen
    assert effects.motion[0].kind == "stop"
    assert zero(h.lease("lease-b")) and h.s.core.latch
    assert zero(h.cmd(N)) and zero(h.cmd(F))
    h.unlock()
    assert zero(h.cmd(F))  # neutral before unlock didn't count
    assert zero(h.cmd(N))
    assert h.cmd(F).motion[-1].velocity == (0.6, 0, 0)
    assert zero(h.cmd(F, lease_id="lease-a"))
    assert zero(h.cmd(F))  # wrong lease also invalidated intent


def test_changed_lease_without_null_stops_and_locks():
    h = Harness()
    assert zero(h.lease("lease-b"))
    assert h.s.core.latch and h.s.core.need_neutral
    h.unlock()
    assert zero(h.cmd(F))
    h.cmd(N)
    assert not zero(h.cmd(F))


def test_deadman_exact_boundary_no_new_lock_and_cannot_bypass_with_late_cmd():
    h = Harness()
    gen = h.s.core.stop_gen
    h.t = 0.3
    assert not zero(h.s.tick())
    h.t += 0.000001
    assert zero(h.cmd(F))  # must evaluate expiry before accepting fresh F
    assert not h.s.core.latch and h.s.core.stop_gen == gen
    assert h.s.core.need_neutral
    h.cmd(N)
    assert not zero(h.cmd(F))


@pytest.mark.parametrize("wait", [0, 3, 30])
def test_loss_detection_3s_and_grace_from_last_frame_boundary(wait):
    h = Harness("RUN", wait)
    h.advance_run(2.95)
    assert not h.s.link_lost and not h.s.core.latch
    h.advance_run(3)
    assert h.s.link_lost
    if wait <= 3:
        assert h.s.core.latch and h.s.run["status"] == "PAUSED"
        assert h.s.run["wait_reason"] == "LINK_LOSS_TIMEOUT"
    else:
        assert not h.s.core.latch and h.s.run["status"] == "RUNNING"
        assert not zero(h.advance_run(29.95))
        assert zero(h.advance_run(30))
        assert h.s.core.latch and h.s.run["wait_reason"] == "LINK_LOSS_TIMEOUT"


def test_last_any_frame_not_remote_timestamp_drives_loss_and_grace():
    h = Harness("RUN", 3)
    h.advance_run(2, server=True)
    h.s.receive({"t": "unknown", "t_server": -1e99})
    h.advance_run(4.95)
    assert not h.s.link_lost
    h.advance_run(5)
    assert h.s.link_lost and h.s.core.latch


def test_next_waypoint_wait_wins_before_grace_and_cannot_auto_resume():
    h = Harness("RUN")
    h.advance_run(3.5)
    assert zero(h.s.waypoint_reached("run-a"))
    assert h.s.run["status"] == "PAUSED"
    assert h.s.run["wait_reason"] == "LINK_LOSS_WAYPOINT"
    assert zero(h.advance_run(31))
    assert not h.s.core.latch  # waypoint wait wins, no later timeout lock
    e = h.s.connect()
    hello = e.messages[0]
    assert zero(e) and hello["run"]["status"] == "PAUSED" and hello["latched"]
    assert zero(h.s.executor_command("run-a", F))


def test_reconnect_stops_before_hello_with_lease_run_copy_and_events_in_order():
    h = Harness("RUN")
    h.s.disconnect()
    h.advance_run(3.5)
    assert h.s.run["status"] == "RUNNING" and not zero(h.s.tick())
    effects = h.s.connect()
    assert effects.motion[0].kind == "stop" and zero(effects)
    hello = effects.messages[0]
    assert hello["t"] == "hello" and hello["latched"] and hello["lease_id"] == "lease-a"
    assert hello["run"]["run_id"] == "run-a" and hello["run"]["status"] == "PAUSED"
    assert hello["run"]["wait_reason"] == "RECONNECTED"
    assert [m["code"] for m in effects.messages if m["t"] == "event"] == ["SERVER_LINK_LOST"]
    # Server has to reconcile/reassert lease; receiving a resume alone isn't authority.
    assert zero(h.s.receive({"t": "run.control", "run_id": "run-a", "op": "resume"}))
    assert h.s.run["status"] == "PAUSED"
    hello["run"]["status"] = "RUNNING"
    assert h.s.run["status"] == "PAUSED"  # outbound snapshots cannot mutate authority


def test_half_open_link_resuming_also_stops_and_hello():
    h = Harness("RUN")
    h.advance_run(3.5)
    e = h.s.receive({"t": "run.control", "run_id": "run-a", "op": "resume"})
    assert zero(e) and e.messages[0]["t"] == "hello"
    assert h.s.core.latch and h.s.run["status"] == "PAUSED"


def test_executor_watchdog_uses_local_commands_even_when_server_pings_and_cmds():
    h = Harness("RUN")
    h.t = 0.3
    assert not zero(h.s.tick())
    h.t += 0.000001
    h.s.receive({"t": "ping"})
    h.cmd(F)
    assert zero(h.s.tick()) and h.s.run["status"] == "FAILED"
    assert h.s.run["wait_reason"] == "EXECUTOR_STALLED"
    assert zero(h.s.executor_command("run-a", F))
    assert not h.s.core.latch  # executor failure isn't a new STOP policy


def test_executor_zero_heartbeat_in_pause_is_alive_and_manual_is_separate():
    h = Harness("RUN")
    h.s.receive({"t": "run.control", "run_id": "run-a", "op": "pause"})
    for i in range(1, 41):
        h.t = i / 20
        h.state()
        h.s.receive({"t": "ping"})
        assert zero(h.s.executor_command("run-a", N))
    assert h.s.run["status"] == "PAUSED"
    h.s.receive({"t": "run.control", "run_id": "run-a", "op": "resume"})
    assert zero(h.s.executor_command("run-a", F))
    h.s.executor_command("run-a", N)
    assert not zero(h.s.executor_command("run-a", F))
    h.lease("manual", "USER")
    assert h.s.run["status"] == "PAUSED" and zero(h.s.executor_command("run-a", F))


@pytest.mark.parametrize("bad", [-1, 30.01, True, None, "30", float("nan"), float("inf")])
def test_server_cannot_extend_grace_or_invent_policy(bad):
    h = Harness()
    h.lease("run-lease", "RUN:r")
    h.s.receive({"t": "run.start", "run_id": "r", "plan": {"segments": []},
                 "missions": {}, "policy": {"link_loss_wait_s": bad}})
    assert h.s.run is None and zero(h.s.tick())


@pytest.mark.parametrize("bad_seq", [True, -1, 1, 2, "3", None, 3.5])
def test_non_increasing_and_malformed_seq_discard_input(bad_seq):
    h = Harness()
    assert zero(h.cmd(F, seq=bad_seq))
    assert h.s.core.need_neutral


def test_unlock_requires_current_lease_integer_generation_and_local_confirmation():
    h = Harness()
    h.s.receive({"t": "stop"})
    h.state(True)
    for extra in ({}, {"stop_gen": None}, {"stop_gen": True},
                  {"stop_gen": h.s.core.stop_gen - 1},
                  {"stop_gen": h.s.core.stop_gen, "lease_id": "other"}):
        e = h.s.receive({"t": "unlock", "lease_id": "lease-a", **extra})
        assert zero(e) and all(x.kind != "unlock" for x in e.motion)
    e = h.s.receive({"t": "unlock", "lease_id": "lease-a", "stop_gen": h.s.core.stop_gen})
    assert any(x.kind == "unlock" for x in e.motion) and h.s.core.latch
    assert zero(h.cmd(N)) and zero(h.cmd(F))
    h.state(False)
    assert zero(h.cmd(F))
    h.cmd(N)
    assert not zero(h.cmd(F))


def test_speed_caps_invalid_axes_and_stale_robot_state_cannot_be_bypassed():
    h = Harness()
    assert h.cmd([1, 0, 1]).motion[-1].velocity == (0.6, 0, 0.5)
    for axes in ([100, 0, 0], [True, 0, 0], [float("nan"), 0, 0],
                 [0, 0], {}, None, [0, 1, 0], [-1, 0, 0]):
        assert zero(h.cmd(axes))
    h.t = 1.01
    h.s.receive({"t": "ping", "policy_running": True, "state": {"stop_requested": False}})
    h.cmd(N)
    assert zero(h.cmd(F))
    h.state()
    assert zero(h.cmd(F))


def test_ack_is_batched_to_10hz_last_seq():
    h = Harness()
    h.t = 0.05
    assert not any(m["t"] == "cmd.ack" for m in h.cmd(N).messages)
    h.cmd(F)
    h.t = 0.1
    acks = [m for m in h.s.tick().messages if m["t"] == "cmd.ack"]
    assert len(acks) == 1 and acks[0]["seq"] == h.seq
    assert acks[0]["applied"] == [0.6, 0, 0]


def test_unknown_malformed_messages_never_grant_motion_or_crash():
    s = Session(lambda: 0)
    s.connect()
    messages = [None, [], True, 1, "{", b"\xff", {"t": []},
                {"t": "lease", "lease_id": []},
                {"t": "lease", "lease_id": "x", "holder_type": {}},
                {"t": "run.control", "op": []},
                {"t": "state", "latched": False, "applied": [9, 0, 0]},
                {"t": "map.sync"}, {"t": "floor.set"}, {"t": "slam"},
                {"t": "streams"}, {"t": "run.confirm"}, {"t": "mystery"}]
    rng = random.Random(21)
    values = [None, True, [], {}, 9, "x"]
    messages += [{"t": rng.choice(["lease", "unlock", "run.start", "run.control", "cmd"]),
                  "lease_id": rng.choice(values), "holder_type": rng.choice(values),
                  "seq": rng.choice(values), "axes": rng.choice(values),
                  "policy": rng.choice(values), "op": rng.choice(values)} for _ in range(200)]
    for frame in messages:
        assert zero(s.receive(frame))
    assert s.core.latch


def test_any_server_operations_during_stop_do_not_bypass_core():
    h = Harness("RUN")
    h.s.receive({"t": "stop", "by_user_id": "non-holder"})
    gen = h.s.core.stop_gen
    for msg in [
        {"t": "run.start", "run_id": "new", "plan": {"segments": []}, "missions": {}},
        {"t": "run.control", "run_id": "run-a", "op": "resume"},
        {"t": "run.control", "run_id": "run-a", "op": []},
        {"t": "run.confirm", "run_id": "run-a", "kind": "OPERATOR", "data": {}},
        {"t": "unlock", "lease_id": "lease-a", "stop_gen": gen - 1},
        {"t": "cmd", "lease_id": "lease-a", "seq": 500, "axes": F},
    ]:
        assert zero(h.s.receive(msg))
        assert zero(h.s.executor_command("run-a", F))
    assert h.s.core.latch


def test_protocol_mismatch_stops_latches_and_rejects_authority():
    h = Harness()
    e = h.s.receive({"t": "ping", "proto": "fh-agent/2"})
    assert zero(e) and h.s.core.latch and h.s.reconnect_required
    assert not h.s.lease_confirmed
    assert zero(h.cmd(N)) and zero(h.cmd(F))


def test_invalid_active_run_control_fields_do_not_crash_or_change_status():
    h = Harness("RUN")
    for op in ([], {}, True, None, "unknown"):
        e = h.s.receive({"t": "run.control", "run_id": "run-a", "op": op})
        assert not zero(e) and h.s.run["status"] == "RUNNING"
    # A server cmd cannot keep the local executor alive in any run state.
    h.s.receive({"t": "run.control", "run_id": "run-a", "op": "pause"})
    h.t = 0.300001
    h.cmd(N)
    assert h.s.run["status"] == "FAILED"


def test_protocol_rejection_cannot_be_undone_by_queued_lease_unlock():
    h = Harness()
    h.s.receive({"proto": "fh-agent/2"})
    h.lease("lease-a")
    h.state(True)
    e = h.s.receive({"t": "unlock", "lease_id": "lease-a", "stop_gen": h.s.core.stop_gen})
    h.state(False)
    assert all(c.kind != "unlock" for c in e.motion)
    assert h.s.core.latch and not h.s.lease_confirmed
    assert zero(h.cmd(N)) and zero(h.cmd(F))


def test_healthy_executor_stays_paused_while_waiting_for_lease_reconciliation():
    h = Harness("RUN")
    h.s.connect()
    for i in range(1, 21):
        h.t = i / 20
        h.state()
        assert zero(h.s.executor_command("run-a", N))
    assert h.s.run["status"] == "PAUSED" and h.s.core.latch
    assert not h.s.lease_confirmed


@pytest.mark.parametrize("frame", [
    {"lease_id": "lease-b", "holder_type": "FREE"},
    {"lease_id": "lease-b", "holder_type": None},
    {"lease_id": "lease-b", "holder_type": []},
    {"lease_id": "lease-b", "holder_type": "RUN:"},
    {"lease_id": "lease-b", "holder_type": "RUN:   "},
    {"lease_id": "", "holder_type": "USER"},
    {"lease_id": "   ", "holder_type": "USER"},
    {"lease_id": 7, "holder_type": "USER"},
    {"lease_id": True, "holder_type": "USER"},
    {"lease_id": [], "holder_type": "USER"},
    {"lease_id": "lease-b"},
    {"holder_type": None},
    {},
])
@pytest.mark.parametrize("holder", ["USER", "RUN"])
def test_invalid_lease_revokes_authority_immediately(frame, holder):
    h = Harness(holder)
    effects = h.s.receive({"t": "lease", **frame})
    assert zero(effects)
    assert h.s.core.latch and h.s.core.need_neutral and h.s.core.intent == Z
    assert h.s.lease_id is None and h.s.holder_type is None
    assert h.s.core.controller is None and not h.s.lease_confirmed
    assert h.s.last_seq == -1
    assert any(m.get("code") == "LEASE_INVALID" for m in effects.messages)
    assert zero(h.cmd(N, lease_id="lease-a"))
    assert zero(h.cmd(F, lease_id="lease-a"))
    if holder == "RUN":
        assert h.s.run["status"] == "PAUSED"
        assert zero(h.s.executor_command("run-a", F))


def test_qualified_run_holder_is_normalized_bound_and_switch_discards_input():
    h = Harness()
    assert zero(h.lease("run-lease", "RUN:run-a"))
    assert h.s.core.latch and h.s.core.need_neutral
    assert h.s.holder_type == "RUN" and h.s.holder_run_id == "run-a"
    assert zero(h.cmd(N, lease_id="lease-a")) and zero(h.cmd(F, lease_id="lease-a"))
    h.unlock()
    for run_id in ("other-run", "run-a"):
        h.s.receive({"t": "run.start", "run_id": run_id,
                     "plan": {"segments": []}, "missions": {}})
        if run_id == "other-run":
            assert h.s.run is None
    h.s.executor_command("run-a", N)
    assert not zero(h.s.executor_command("run-a", F))
    assert zero(h.lease("run-lease", "RUN:run-b"))
    assert h.s.holder_run_id == "run-b"
    assert h.s.core.latch and h.s.core.need_neutral
    assert h.s.run["status"] == "PAUSED"
    h.unlock()
    h.s.receive({"t": "run.control", "run_id": "run-a", "op": "resume"})
    assert h.s.run["status"] == "PAUSED"  # run-a no longer owns this qualified lease
    assert zero(h.s.executor_command("run-a", N))
    assert zero(h.s.executor_command("run-a", F))


@pytest.mark.parametrize("holder,new_holder", [("USER", "RUN"), ("RUN", "USER")])
def test_same_lease_holder_change_immediately_zero_latches_discards(holder, new_holder):
    h = Harness(holder)
    assert zero(h.lease("lease-a", new_holder))
    assert h.s.core.latch and h.s.core.need_neutral and h.s.core.intent == Z
    assert h.s.last_seq == -1 and h.s.holder_type == new_holder
    if holder == "RUN":
        assert h.s.run["status"] == "PAUSED"


def test_run_server_cmd_cannot_create_movement_between_executor_ticks():
    h = Harness("RUN")
    h.s.executor_command("run-a", N)
    assert zero(h.cmd(N))
    assert zero(h.cmd(F))
    assert h.s.core.intent == Z
    assert h.s.last_seq == -1


def test_run_server_cmd_leaves_executor_intent_and_neutral_gate_untouched():
    h = Harness("RUN")
    before = (h.s.core.intent, h.s.core.intent_t, h.s.core.need_neutral)
    events = []
    for axes in (N, F, [float("nan"), 0, 0]):
        effects = h.cmd(axes)
        assert not zero(effects)
        assert (h.s.core.intent, h.s.core.intent_t, h.s.core.need_neutral) == before
        events += [m for m in effects.messages if m.get("code") == "RUN_SERVER_CMD_IGNORED"]
    assert len(events) == 1
    assert not zero(h.s.executor_command("run-a", F))


def test_invalid_executor_axes_at_20hz_do_not_refresh_watchdog():
    h = Harness("RUN")
    for i in range(1, 7):
        h.t = i / 20
        h.state()
        assert zero(h.s.executor_command("run-a", [float("nan"), 0, 0]))
    assert h.s.run["status"] == "RUNNING"  # exactly .3 keeps original strict >
    h.t = 0.300001
    assert zero(h.s.executor_command("run-a", [float("nan"), 0, 0]))
    assert h.s.run["status"] == "FAILED" and h.s.run["wait_reason"] == "EXECUTOR_STALLED"


def test_unconfirmed_lease_cmd_never_reaches_core_even_with_other_gates_open(monkeypatch):
    h = Harness()
    h.s.connect()
    # Open the independent Core latch gate to isolate lease-confirmation defense.
    h.state(True)
    assert h.s.core.resume("lease-a", h.s.core.stop_gen)
    h.state(False)
    assert not h.s.core.latch and not h.s.lease_confirmed
    calls = []
    original = h.s.core.cmd

    def spy(cid, axes):
        calls.append((cid, axes))
        return original(cid, axes)

    monkeypatch.setattr(h.s.core, "cmd", spy)
    assert zero(h.cmd(N)) and zero(h.cmd(F))
    assert not calls and h.s.core.intent == Z and h.s.core.need_neutral


def test_shutdown_from_moving_state_outputs_stop_zero_and_latch():
    h = Harness()
    effects = h.s.shutdown()
    assert any(c.kind == "stop" for c in effects.motion)
    assert zero(effects) and h.s.core.latch
    assert not h.s.connected and h.s.core.need_neutral


def test_session_uses_monotonic_default_but_allows_injected_clock():
    import time

    s = Session()
    assert s.now is time.monotonic and s.core.now is time.monotonic
    assert s.core.latch and zero(s.tick())


@pytest.mark.parametrize("axis", [10**400, -(10**400)], ids=["huge-positive", "huge-negative"])
def test_huge_integer_server_axes_are_invalid_without_stopping_session(axis):
    h = Harness()
    frame = {"t": "cmd", "lease_id": "lease-a", "seq": 3, "axes": [axis, 0, 0]}
    wire = json.dumps(frame)
    assert len(wire.encode()) < 4096
    assert zero(h.s.receive(wire))
    assert not h.s.core.latch and h.s.core.need_neutral
    h.seq = 3
    h.cmd(N)
    assert not zero(h.cmd(F))


@pytest.mark.parametrize("wait", [10**400, -(10**400)], ids=["huge-positive", "huge-negative"])
def test_huge_integer_run_policy_is_rejected_without_raising(wait):
    h = Harness()
    h.lease("run-lease", "RUN:r")
    assert zero(h.s.receive({"t": "run.start", "run_id": "r",
        "plan": {"segments": []}, "missions": {}, "policy": {"link_loss_wait_s": wait}}))
    assert h.s.run is None
    h.s.receive({"t": "run.start", "run_id": "r", "plan": {"segments": []}, "missions": {}})
    assert h.s.run["run_id"] == "r"


@pytest.mark.parametrize("axis", [10**400, -(10**400)], ids=["huge-positive", "huge-negative"])
def test_huge_integer_executor_axes_are_invalid_without_stopping_session(axis):
    h = Harness("RUN")
    assert zero(h.s.executor_command("run-a", [axis, 0, 0]))
    assert h.s.run["status"] == "RUNNING"
    h.s.executor_command("run-a", N)
    assert not zero(h.s.executor_command("run-a", F))


@pytest.mark.parametrize("frame", ["{", b"\xff", "[]", "true", {},
                                   {"t": []}, {"t": ""}, {"t": None}])
def test_unparseable_or_missing_envelope_does_not_refresh_link_clock(frame):
    h = Harness("RUN", wait=0)
    for i in range(1, 81):
        h.t = i / 20
        h.state()
        h.s.executor_command("run-a", F)
        h.s.receive(frame)
    assert h.s.last_server == 0
    assert h.s.link_lost and h.s.core.latch
    assert h.s.run["status"] == "PAUSED" and h.s.run["wait_reason"] == "LINK_LOSS_TIMEOUT"


def test_valid_unknown_envelope_uses_original_receive_time(monkeypatch):
    import foothold_agent.link.session as session_module

    h = Harness("RUN")
    h.t = 0.1
    original = json.loads

    def slower_parse(raw):
        result = original(raw)
        h.t = 0.2
        return result

    monkeypatch.setattr(session_module.json, "loads", slower_parse)
    h.s.receive('{"t":"future.message"}')
    assert h.s.last_server == 0.1


@pytest.mark.parametrize("seq", [2**53, 10**400], ids=["past-json-safe", "huge"])
def test_seq_upper_bound_cannot_poison_lease(seq):
    h = Harness()
    previous = h.s.last_seq
    assert zero(h.cmd(N, seq=seq))
    assert h.s.last_seq == previous
    h.cmd(N)
    assert not zero(h.cmd(F))


def test_seq_json_safe_boundary_is_accepted():
    h = Harness()
    assert not zero(h.cmd(F, seq=2**53 - 1))
    assert h.s.last_seq == 2**53 - 1


def test_invalid_free_lease_does_not_increment_an_already_locked_generation():
    s = Session(lambda: 0)
    s.connect()
    gen = s.core.stop_gen
    for _ in range(3):
        e = s.receive({"t": "lease", "lease_id": "bad", "holder_type": "FREE"})
        assert zero(e) and s.core.latch and s.core.need_neutral
        assert s.core.stop_gen == gen
        assert any(m.get("code") == "LEASE_INVALID" for m in e.messages)


@pytest.mark.parametrize("holder", ["RUN", "RUN:", "RUN:   "])
def test_run_owner_without_nonempty_qualified_id_revokes_authority(holder):
    h = Harness()
    assert zero(h.s.receive({"t": "lease", "lease_id": "run-lease", "holder_type": holder}))
    assert h.s.lease_id is None and h.s.holder_run_id is None and not h.s.lease_confirmed
    assert h.s.core.latch and h.s.core.need_neutral
    h.s.receive({"t": "run.start", "run_id": "arbitrary", "plan": {"segments": []}, "missions": {}})
    assert h.s.run is None
    assert zero(h.s.executor_command("arbitrary", F))


def test_run_start_requires_matching_bound_owner_even_with_other_gates_open():
    h = Harness()
    h.lease("run-lease", "RUN:run-a")
    h.unlock()
    h.s.holder_run_id = None  # isolate binding from the lease parser's defense
    h.s.receive({"t": "run.start", "run_id": "run-a", "plan": {"segments": []}, "missions": {}})
    assert h.s.run is None


def test_run_resume_requires_matching_bound_owner_even_with_other_gates_open():
    h = Harness("RUN")
    h.s.receive({"t": "run.control", "run_id": "run-a", "op": "pause"})
    h.s.holder_run_id = None
    h.s.receive({"t": "run.control", "run_id": "run-a", "op": "resume"})
    assert h.s.run["status"] == "PAUSED"


@pytest.mark.parametrize("bound", [None, "other-run"])
def test_executor_requires_exact_owner_for_commands_and_health(monkeypatch, bound):
    h = Harness("RUN")
    h.s.holder_run_id = bound
    before = h.s.executor_t
    h.t = 0.05
    calls = []
    monkeypatch.setattr(h.s.core, "cmd", lambda *args: calls.append(args))
    h.s.executor_command("run-a", N)
    assert not calls and h.s.executor_t == before
