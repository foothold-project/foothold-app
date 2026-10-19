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
    ("same lease holder change missed", "link/session.py",
     ' or holder != self.holder_type', ''),
    ("invalid lease ignored", "link/session.py",
     'if invalid:\n            self._event("LEASE_INVALID")',
     'if invalid:\n            return'),
    ("invalid executor axes refresh health", "link/session.py",
     'if valid is not None:', 'if True:'),
    ("unconfirmed lease cmd accepted", "link/session.py",
     'self.lease_confirmed and self.holder_type == "USER"', 'self.holder_type == "USER"'),
    ("session shutdown has no latch", "link/session.py",
     'self.core.stop("client shutdown")', 'self.core._void()'),
    ("client cancellation has no shutdown", "link/client.py",
     'self._emit(self.session.shutdown())', 'pass'),
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
]


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
                result = subprocess.run(
                    [sys.executable, "-m", "pytest",
                     ("tests/test_link_client.py::test_cancel_while_moving_requests_stop_zero_and_latch"
                      if target == "link/client.py" else "tests/test_link_session.py"),
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
