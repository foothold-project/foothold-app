"""Additional offline boundary checks, separate from the unchanged selftests."""

import subprocess
import sys
from pathlib import Path

import pytest

from foothold_agent.safety.core import (
    DEAD, RESET_TIMEOUT, RESUME_TIMEOUT, SCHEMA, STATE_STALE, Z,
    Core, clean_state, quantize,
)


def state(core, stop=False, **overrides):
    return core.on_state({
        "schema": SCHEMA, "episode": 0, "stop_requested": stop,
        "reset_in_progress": False, "policy_running": True,
        **overrides,
    })


@pytest.mark.parametrize("axes, expected, reason", [
    ((0.199, 0.199, 0.199), Z, ""),
    ((-0.199, 0, 0), Z, ""),
    ((0.2, 0, 0), Z, "저속 미검증 — 앞으로 끝까지 밀면 0.6 m/s"),
    ((0, 0.2, 0), Z, "저속 미검증 — 앞으로 끝까지 밀면 0.6 m/s"),
    ((0, 0, 0.2), Z, "저속 미검증 — 앞으로 끝까지 밀면 0.6 m/s"),
    ((-0.2, 0, 0), Z, "후진 미검증 — 보내지 않음"),
    ((-0.201, 0, 0), Z, "후진 미검증 — 보내지 않음"),
    ((0.499, 0, 0), Z, "저속 미검증 — 앞으로 끝까지 밀면 0.6 m/s"),
    ((0.5, 0.499, 0.499), (0.6, 0, 0), ""),
    ((0.5, 0, 0.5), (0.6, 0, 0.5), ""),
    ((0.5, 0, -0.5), (0.6, 0, -0.5), ""),
    ((0.5, 0.5, 0), Z, "옆걸음 미검증 — 보내지 않음"),
    ((0.5, -0.5, 0), Z, "옆걸음 미검증 — 보내지 않음"),
    ((0, 0, 0.5), Z, "제자리 회전 미검증 — 앞으로 밀면서 돌리세요"),
])
def test_quantize_thresholds(axes, expected, reason):
    assert quantize(*axes) == (expected, reason)


def test_deadman_boundary_discards_intent_without_setting_latch():
    clock = [0.0]
    core = Core(now=lambda: clock[0])
    state(core)
    core.take("driver")
    core.cmd("driver", Z)
    core.cmd("driver", (1, 0, 0))
    clock[0] = DEAD
    assert core.applied() == (0.6, 0, 0)
    clock[0] += 0.000001
    assert core.applied() == Z and core.need_neutral and core.intent == Z
    assert not core.latch  # SF-03: discard + fresh neutral, no latch; adding one is PRD Q7.


@pytest.mark.parametrize("axes", [(0.3, 0, 0), (-0.2, 0, 0), (0, 0.5, 0), (0, 0, 0.5)])
def test_rejected_zero_command_cannot_replace_fresh_neutral_after_deadman(axes):
    clock = [0.0]
    core = Core(now=lambda: clock[0])
    state(core)
    core.take("driver")
    core.cmd("driver", Z)
    core.cmd("driver", (1, 0, 0))
    assert core.applied() == (0.6, 0, 0)
    clock[0] = DEAD + 0.01
    assert core.applied() == Z and core.need_neutral
    assert quantize(*axes)[0] == Z and quantize(*axes)[1]
    core.cmd("driver", axes)
    assert core.need_neutral
    core.cmd("driver", (1, 0, 0))
    assert core.applied() == Z
    assert core.reason == "손을 한 번 뗀 뒤 다시 누르세요"
    core.cmd("driver", Z)
    core.cmd("driver", (1, 0, 0))
    assert core.applied() == (0.6, 0, 0)


@pytest.mark.parametrize("blocked_state, reason", [
    ({"policy_running": False}, "정책 미실행"),
    ({"reset_in_progress": True}, "시뮬 리셋 중"),
])
def test_state_block_discards_intent_before_recovery_without_commands(blocked_state, reason):
    clock = [0.0]
    core = Core(now=lambda: clock[0])
    state(core)
    core.take("driver")
    core.cmd("driver", Z)
    core.cmd("driver", (1, 0, 0))
    assert core.applied() == (0.6, 0, 0)
    clock[0] = 0.05
    state(core, **blocked_state)
    assert core.applied() == Z and core.reason == reason
    clock[0] = 0.1  # Recover before deadman could mask a missing block-time discard.
    state(core)
    assert core.applied() == Z  # No cmd between blocking and recovery.
    assert core.intent == Z and core.need_neutral and not core.latch
    core.cmd("driver", (1, 0, 0))
    assert core.applied() == Z
    assert core.reason == "손을 한 번 뗀 뒤 다시 누르세요"
    core.cmd("driver", Z)
    core.cmd("driver", (1, 0, 0))
    assert core.applied() == (0.6, 0, 0)


def test_episode_change_time_records_only_new_episode_transitions():
    clock = [1.0]
    core = Core(now=lambda: clock[0])
    assert core.ep_change_t is None
    state(core, episode=2)
    assert core.ep_change_t is None  # First state establishes the baseline.
    clock[0] = 2.0
    state(core, episode=2)
    assert core.ep_change_t is None
    clock[0] = 3.0
    state(core, episode=3)
    assert core.ep_change_t == 3.0 and core.latch
    clock[0] = 4.0
    state(core, episode=3)
    assert core.ep_change_t == 3.0
    clock[0] = 5.0
    state(core, episode=2)
    assert core.ep_change_t == 5.0


def test_state_freshness_boundary():
    clock = [0.0]
    core = Core(now=lambda: clock[0])
    state(core)
    clock[0] = STATE_STALE
    assert core.sim_block() == ""
    clock[0] += 0.000001
    assert core.sim_block() == "시뮬 상태 끊김"


@pytest.mark.parametrize("operation, timeout", [
    ("resume", RESUME_TIMEOUT), ("reset", RESET_TIMEOUT),
])
def test_pending_timeout_boundary_and_no_automatic_retry(operation, timeout):
    clock = [1.0]
    core = Core(now=lambda: clock[0])
    state(core, stop=True)
    core.take("driver")
    if operation == "resume":
        assert core.resume("driver", core.stop_gen)
    else:
        assert core.reset_begin("driver", True)
    clock[0] = 1.0 + timeout
    state(core, stop=True)
    assert core.applied() == Z
    assert getattr(core, operation + "_pending") is not None
    clock[0] += 0.000001
    assert core.applied() == Z
    assert getattr(core, operation + "_pending") is None and core.latch
    for _ in range(3):
        assert core.applied() == Z
        assert getattr(core, operation + "_pending") is None


def test_event_sink_failure_cannot_interrupt_stop():
    core = Core()

    def failed_sink(event):
        raise OSError("fake sink failure")

    core.sink = failed_sink
    core.stop("viewer")
    assert core.latch and core.stop_gen == 1 and core.applied() == Z


def test_state_display_fields_and_applied_command_sanitized():
    raw = {
        "schema": SCHEMA, "episode": 0, "stop_requested": False,
        "reset_in_progress": False, "policy_running": True,
        "x": float("inf"), "camera": 1, "fallen": 1,
        "cmd_applied": [0, True, 0],
    }
    cleaned = clean_state(raw)
    assert all(cleaned[key] is None for key in ("x", "camera", "fallen", "cmd_applied"))
    raw["cmd_applied"] = [0, 0.6, -0.5]
    assert clean_state(raw)["cmd_applied"] == [0.0, 0.6, -0.5]


def test_import_with_only_standard_library_and_no_integration_modules(tmp_path):
    package_root = str(Path(__file__).resolve().parents[1])
    code = f"""
import sys
sys.path.insert(0, {package_root!r})
from foothold_agent.safety.core import Core, Z
assert Core().applied() == Z
assert not any(name.split('.')[0] in {{'rclpy', 'tornado', 'server', 'sim', 'websocket'}}
               for name in sys.modules)
"""
    subprocess.run([sys.executable, "-I", "-S", "-c", code], cwd=tmp_path, check=True)
