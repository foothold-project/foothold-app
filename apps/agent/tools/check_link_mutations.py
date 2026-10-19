"""Offline mutation probe: mutate only throwaway copies, never the worktree Core.

Run with the same Python environment as pytest, from any working directory.
A mutant is killed only by an actual test assertion failure, not collection errors.
"""

from pathlib import Path
import shutil
import json
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
MUTATIONS = [
    ("loss boundary >3s", "link/session.py",
     "self.now() - self.last_server >= LINK_TIMEOUT", "self.now() - self.last_server > LINK_TIMEOUT"),
    ("grace starts at detection", "link/session.py",
     "self.now() - self.last_server >= self.link_loss_wait_s",
     "self.now() - self.last_server - LINK_TIMEOUT >= self.link_loss_wait_s"),
    ("lease drop keeps old intent", "link/session.py",
     'self.core.drop(self.core.controller, "server lease")', 'self.core.controller = None'),
    ("RUN accepts server cmd", "link/session.py",
     'self.lease_confirmed and self.holder_type == "USER"', 'self.lease_confirmed'),
    ("same lease owner change missed", "link/session.py",
     ' or holder != self.holder_type or run_id != self.holder_run_id', ''),
    ("invalid lease ignored", "link/session.py",
     'if invalid:\n            self._event("LEASE_INVALID")',
     'if invalid:\n            return'),
    ("invalid executor axes refresh health", "link/session.py",
     'if valid is not None:', 'if True:'),
    ("unconfirmed lease cmd accepted", "link/session.py",
     'self.lease_confirmed and self.holder_type == "USER"', 'self.holder_type == "USER"'),
    ("session shutdown has no latch", "link/session.py",
     'self.core.stop("client shutdown")', 'self.core._void()'),
    ('client cancellation has no shutdown', 'link/client.py', '                    effects = self.session.shutdown()', '                    effects = Effects(())'),
    ("seq upper bound removed", "link/session.py",
     '0 <= seq <= MAX_SEQ', 'seq >= 0'),
    ("cancel output failure trace removed", "link/client.py",
     '_note_output_error(pending_error, exc, "shutdown")', 'pass'),
    ("invalid FREE lease advances generation", "link/session.py",
     'elif invalid and not self.core.latch:', 'elif invalid:'),
    ("standalone zero fallback removed", "link/client.py",
     'if not zero_attempted:', 'if False:'),
    ("bare RUN owner accepted", "link/session.py",
     'elif holder == "RUN":\n            holder = None',
     'elif holder == "RUN":\n            run_id = None'),
    ("run start binding removed", "link/session.py",
     'and self.holder_run_id == frame["run_id"]', 'and True'),
    ("run resume binding removed", "link/session.py",
     'and self.holder_run_id == self.run["run_id"]):', 'and True):'),
    ("executor command health binding removed", "link/session.py",
     'and self.holder_run_id == run_id\n                and self.run["status"]',
     'and self.run["status"]'),
    ("authorization close retried", "link/client.py",
     'FATAL_CLOSE_CODES = (4401, 4403)', 'FATAL_CLOSE_CODES = ()'),
    ("1012 incorrectly terminal", "link/client.py",
     'FATAL_CLOSE_CODES = (4401, 4403)', 'FATAL_CLOSE_CODES = (4401, 4403, 1012)'),
    ("close event removed", "link/session.py",
     'self._event("SERVER_CLOSED", close_code=close_code, retry=retry)', 'pass'),
    ("retry event removed", "link/client.py",
     'self._emit(self.session.transport_retry(wait, retry_code))', 'pass'),
    ("retry backoff fixed", "link/client.py",
     'delay = min(delay * 2, self.settings.retry_max_s)', 'delay = self.settings.retry_initial_s'),
    ("default retry interval shortened", "link/client.py",
     'retry_initial_s: float = 1.0', 'retry_initial_s: float = 0.25'),
    ("default retry cap lowered", "link/client.py",
     'retry_max_s: float = 10.0', 'retry_max_s: float = 8.0'),
    ("offline retry aggregation removed", "link/session.py",
     'if self._retry_event is None:', 'if True:'),
    ("offline retry counter frozen", "link/session.py",
     'data["attempts"] += 1', 'data["attempts"] += 0'),
    ("shutdown pause reason overwritten", "link/session.py",
     'self._pause("CLIENT_SHUTDOWN", preserve_reason=True)', 'self._pause("CLIENT_SHUTDOWN")'),
    ("reconnect pause reason overwritten", "link/session.py",
     'self._pause("RECONNECTED", preserve_reason=True)', 'self._pause("RECONNECTED")'),
    ("fatal close event marked retryable", "link/client.py",
     'retry=code not in FATAL_CLOSE_CODES', 'retry=True'),
    ("old paused run health watched under new owner", "link/session.py",
     'and self.holder_run_id == self.run["run_id"]\n                and self.run["status"]',
     'and self.run["status"]'),
    ("1013 incorrectly uses exponential backoff", "link/client.py",
     'if connected_for >= 3 or retry_code == 1013:', 'if connected_for >= 3:'),
    ("duplicate seq accepted", "link/session.py", "seq > self.last_seq", "seq >= self.last_seq"),
    ("reconnect has no STOP latch", "link/session.py",
     'self.core.stop("connection/reconnection")', 'self.core._void()'),
    ("unlock ignores generation", "link/session.py",
     "self.core.resume(self.lease_id, gen)", "self.core.resume(self.lease_id, None)"),
    ("executor watchdog disabled", "link/session.py",
     "and self.now() - self.executor_t > DEAD", "and False"),
    ("deadman lengthened", "safety/core.py", "DEAD = 0.3", "DEAD = 0.6"),
    ("fresh neutral bypassed", "safety/core.py",
     "if self.need_neutral and c != Z:", "if False:"),
    ("server axes exceed speed cap", "safety/core.py",
     "return (0.6, 0.0, wz), ''", "return (1.2, 0.0, wz), ''"),
    ('STOP reference echo removed', 'link/session.py', '                self.stop_ref = ref', '                pass'),
    ('STOP reference upper bound removed', 'link/session.py', '0 < ref <= MAX_SEQ', 'ref > 0'),
    ('STOP reference latch guard removed', 'link/session.py', 'and self.core.latch and self.core.applied() == Z', 'and self.core.applied() == Z'),
    ('reconnect retains old STOP reference', 'link/session.py', '        self.stop_ref = 0  # a new transport', '        self.stop_ref = self.stop_ref  # a new transport'),
    ('unlock generation upper bound removed', 'link/session.py', '0 <= gen <= MAX_SEQ', 'gen >= 0'),
    ('STOP reference zero-output guard removed', 'link/session.py', 'and self.core.latch and self.core.applied() == Z', 'and self.core.latch'),
    ('wire generation exceeds safe integer', 'link/session.py', 'return min(MAX_SEQ, self.core.stop_gen)', 'return self.core.stop_gen'),
    ('offline buffer unbounded', 'link/session.py', 'History(MAX_BUFFER - 1, lambda m:', 'History(100000, lambda m:'),
    ('backpressure wait reason overwritten', 'link/session.py', 'self._pause("TRANSPORT_BACKPRESSURE", preserve_reason=True)', 'self._pause("TRANSPORT_BACKPRESSURE")'),
    ('protocol wait reason overwritten', 'link/session.py', 'self._pause("PROTOCOL_MISMATCH", preserve_reason=True)', 'self._pause("PROTOCOL_MISMATCH")'),
    ('bridge integer guard removed', 'link/session.py', 'if any(type(v) is int and not -sys.float_info.max <= v <= sys.float_info.max', 'if any(False and type(v) is int and not -sys.float_info.max <= v <= sys.float_info.max'),
    ('state priority removed', 'link/client.py', 'elif self.telemetry:', 'elif self.telemetry and not self.frames:'),
    ('first replay is synchronous overflow', 'link/client.py', '                for message in messages:\n                    await queue.put(message)', '                for message in messages:\n                    queue.put_nowait(message)'),
    ('protocol slow wait removed', 'link/client.py', 'PROTOCOL_RETRY_S = 30.0', 'PROTOCOL_RETRY_S = 1.0'),
    ('event FIFO reversed', 'link/client.py', 'message = self.frames.popleft()', 'message = self.frames.pop()'),
    ('safety spill dropped', 'link/history.py', '            if not self.ordinary:\n                if not self.safety(message):', '            if not self.ordinary:\n                if True:'),
    ('ordinary evicts safety', 'link/history.py', '            if not self.ordinary:\n                if not self.safety(message):', '            if not self.ordinary:\n                self.memory.popleft()\n                self.dropped += 1\n                if not self.safety(message):'),
    ('restored retry summary detached', 'link/session.py', "self._retry_event = next((m for _, m in self._messages.memory if m.get('code') == 'SERVER_RETRY'), None)", 'self._retry_event = None'),
    ('history I/O failure skips physical stop', 'link/client.py', "                    self._emit(Effects((MotionCommand('stop'), MotionCommand(velocity=Z))))", '                    pass'),
    ('protocol stop waits behind teardown', 'link/client.py', '                                if code == PROTOCOL_CLOSE_CODE or legacy_protocol:\n                                    self._emit(self.session.protocol_mismatch())', '                                if False:\n                                    self._emit(self.session.protocol_mismatch())'),
    ('bridge safety record demoted', 'link/session.py', '"LEASE_INVALID", "BRIDGE_STATE_INVALID", "HISTORY_STORAGE_BLOCKED"}', '"LEASE_INVALID", "HISTORY_STORAGE_BLOCKED"}'),
    ('run transition record demoted', 'link/session.py', "or m.get('t') == 'run.update'", 'or False'),
    ('authorization close record demoted', 'link/session.py', "(m.get('code') == 'SERVER_CLOSED' and", "(False and m.get('code') == 'SERVER_CLOSED' and"),
    ('STOP sink prehistory callback removed', 'link/client.py', "        if self.session.core.latch:\n            self._emit(Effects((MotionCommand('stop'), MotionCommand(velocity=Z))))\n        elif self.session.core.applied() == Z:\n            self._emit(Effects((MotionCommand(velocity=Z),)))", '        pass'),
    ('file INSERT blocks watchdog', 'link/history.py', "                self.io.submit('insert', sequence, message)", "                self._disk().execute('INSERT INTO history VALUES (?, ?)', (sequence, pickle.dumps(message)))\n                self.io.submit('peek')"),
    ('storage pressure admission never stops', 'link/history.py', '    HIGH_WATER = 64', '    HIGH_WATER = 1000000'),
    ('server archive close skips immediate stop', 'link/client.py', "if code == 1013 and pending_error.rcvd.reason == 'ROBOT_ARCHIVE_LIMIT':", 'if False:'),
    ('storage safety record demoted', 'link/session.py', '"LEASE_INVALID", "BRIDGE_STATE_INVALID", "HISTORY_STORAGE_BLOCKED"}', '"LEASE_INVALID", "BRIDGE_STATE_INVALID"}'),
    ('physical file cap omitted', 'link/history.py', "self.spill.execute('PRAGMA max_page_count=2048')", "self.spill.execute('PRAGMA max_page_count=0')"),

]


# Client probes are selected by the changed policy, including Session-originated
# transport events. Assertion failures, not slow blanket runs, prove each change.
PROBE_TESTS = {
    'STOP sink prehistory callback removed': 'tests/test_link_storage.py::test_stop_and_watchdog_precede_gated_file_io',
    'file INSERT blocks watchdog': 'tests/test_link_storage.py::test_file_wait_does_not_occupy_the_watchdog_event_loop',
    'storage pressure admission never stops': 'tests/test_link_storage.py::test_storage_pressure_reserves_unsent_history_and_never_auto_unlocks',
    'server archive close skips immediate stop': 'tests/test_link_storage.py::test_server_archive_limit_stops_before_waiting_for_writer_cancellation',
    'storage safety record demoted': 'tests/test_link_followup.py::test_full_safety_buffer_rejects_ordinary_without_evicting_safety',
    'physical file cap omitted': 'tests/test_link_storage.py::test_spill_file_has_enforced_eight_mib_limit',

    'bridge safety record demoted': 'tests/test_link_followup.py::test_full_safety_buffer_rejects_ordinary_without_evicting_safety',
    'run transition record demoted': 'tests/test_link_followup.py::test_run_transitions_are_not_evicted_at_capacity',
    'authorization close record demoted': 'tests/test_link_followup.py::test_authorization_close_records_are_not_evicted_at_capacity',
    'protocol stop waits behind teardown': 'tests/test_link_followup.py::test_protocol_close_stops_before_waiting_for_writer_cancellation',
    'event FIFO reversed': 'tests/test_link_followup.py::test_outbox_coalesces_telemetry_and_preserves_event_fifo',
    'safety spill dropped': 'tests/test_link_followup.py::test_all_safety_offline_capacity_spills_without_eviction_and_keeps_fifo',
    'ordinary evicts safety': 'tests/test_link_followup.py::test_full_safety_buffer_rejects_ordinary_without_evicting_safety',
    'restored retry summary detached': 'tests/test_link_followup.py::test_retry_summary_survives_failed_write_restore',
    'history I/O failure skips physical stop': 'tests/test_link_followup.py::test_history_storage_error_cannot_skip_physical_stop_and_zero',
    "shutdown pause reason overwritten": "test_client_auth_close_preserves_paused_reason_and_nonretry_event",
    "fatal close event marked retryable": "test_client_auth_close_preserves_paused_reason_and_nonretry_event",
    "1013 incorrectly uses exponential backoff": "test_repeated_1013_close_uses_fixed_interval_and_records_each_attempt",
    "cancel output failure trace removed": "test_cancelled_error_retains_shutdown_sink_failure_trace",
    "standalone zero fallback removed": "test_nonzero_apply_failure_alone_attempts_zero_without_shutdown",
    "authorization close retried": "test_authorization_close_is_terminal_and_stops_without_reconnect",
    "1012 incorrectly terminal": "test_second_hello_1012_reconnects_and_records_close_and_backoff",
    "close event removed": "test_second_hello_1012_reconnects_and_records_close_and_backoff",
    "retry event removed": "test_repeated_1013_close_uses_fixed_interval_and_records_each_attempt",
    "retry backoff fixed": "test_exponential_backoff_against_same_process_rejecting_server",
    "default retry interval shortened": "test_default_close_backoff_matches_api_spec",
    "default retry cap lowered": "test_default_close_backoff_matches_api_spec",
    'offline buffer unbounded': 'tests/test_link_followup.py::test_offline_buffer_is_bounded_and_loss_is_counted',
    'backpressure wait reason overwritten': 'tests/test_link_followup.py::test_transport_failures_preserve_existing_wait_reason',
    'protocol wait reason overwritten': 'tests/test_link_followup.py::test_transport_failures_preserve_existing_wait_reason',
    'bridge integer guard removed': 'tests/test_link_followup.py::test_bridge_large_integers_never_enter_core_or_refresh_health',
    'state priority removed': 'tests/test_link_followup.py::test_outbox_coalesces_telemetry_and_preserves_event_fifo',
    'first replay is synchronous overflow': 'tests/test_link_followup.py::test_full_offline_buffer_recovers_on_first_connection_with_backpressure',
    'protocol slow wait removed': 'tests/test_link_followup.py::test_protocol_4406_stops_and_waits_at_least_30s_before_retry',
}


def main():
    failures = 0
    print("| Mutation | Result | Assertion-failing tests |")
    print("|---|---|---|")
    for label, target, before, after in MUTATIONS:
        with tempfile.TemporaryDirectory(prefix="agent-link-mutant-") as tmp:
            copy = Path(tmp) / "agent"
            shutil.copytree(ROOT, copy, ignore=shutil.ignore_patterns(
                "__pycache__", ".pytest_cache", "*.egg-info"))
            source = copy / "foothold_agent" / target
            text = source.read_text()
            if text.count(before) != 1:
                raise RuntimeError(f"mutation target is not unique: {label}")
            source.write_text(text.replace(before, after, 1))
            # Observe exception types inside pytest; FAILED summary text also
            # includes runtime errors and is not evidence of an assertion kill.
            shutil.copyfile(ROOT / "tools/mutation_reporter.py",
                            copy / "foothold_link_mutation_probe.py")
            report = copy / "mutation-result.json"
            try:
                probe = PROBE_TESTS.get(label)
                tests = (probe if probe and "::" in probe else "tests/test_link_client.py::" + probe if probe else
                         "tests/test_link_client.py::test_cancel_while_moving_requests_stop_zero_and_latch"
                         if target == "link/client.py" else "tests/test_link_session.py")
                selected = [tests] if probe or target == "link/client.py" else [tests, "tests/test_stop_reference.py"]
                result = subprocess.run(
                    [sys.executable, "-m", "pytest", *selected,
                     "-q", "--tb=no", "-p", "foothold_link_mutation_probe",
                     "--link-mutation-report", str(report)],
                    cwd=copy, text=True, capture_output=True, timeout=30,
                )
            except subprocess.TimeoutExpired:
                failures += 1
                print(f"| {label} | ERROR | pytest timeout |")
                continue
            try:
                data = json.loads(report.read_text())
                assertions = data["assertions"]
                errors = data["errors"]
                valid = (isinstance(assertions, list) and isinstance(errors, list)
                         and data["collected"] > 0 and data["exitstatus"] == result.returncode)
            except (OSError, ValueError, KeyError, TypeError):
                assertions, errors, valid = [], [], False
            if not valid or errors or result.returncode not in (0, 1):
                verdict = "ERROR"
            elif result.returncode == 1 and assertions:
                verdict = "KILLED"
            elif result.returncode == 0 and not assertions:
                verdict = "SURVIVED"
            else:
                verdict = "ERROR"
            names = [name.split("::", 1)[-1] for name in assertions[:3]]
            print(f"| {label} | {verdict} | {', '.join(names)} |")
            if verdict != "KILLED":
                failures += 1
                print(result.stdout + result.stderr, file=sys.stderr)
    return bool(failures)


if __name__ == "__main__":
    sys.exit(main())
