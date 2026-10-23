"""Run safety mutations in disposable copies; never alter Core or the worktree.

python3 -m foothold_agent.ros_bridge.check_mutations
Only structured assertion failures count as killed; import/runtime errors fail
this tool. The existing link mutation observer supplies exception classification.
"""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

MUTATIONS = [
    ("PR17 incomplete close destroys publishers", "node.py", 'return  # incomplete output: never ACK/destroy live publishers', 'pass'),
    ("PR17 thread creation skips emergency", "sink.py", '                self._finish_close()\n', '                pass\n'),
    ("PR17 device receipts refreshed by display", "node.py", '"received_monotonic_s": self.devices[device["key"]]', '"received_monotonic_s": self.now()'),
    ("PR17 stale sensor accepted", "node.py", 'if 0 <= self.now() - receipt <= STATE_STALE:', 'if True:'),
    ("PR17 stale sensor display stays OK", "node.py", '"OK" if 0 <= self.now() - receipt <= STATE_STALE else "MISSING"', '"OK"'),
    ("PR17 startup devices discarded", "__main__.py", 'client.update_devices(bridge.inputs.device_observations())', 'client.update_devices([])'),
    ("PR17 same stamp fall invisible", "node.py", 'gates += (bool(raw.get("fallen")),)', 'pass'),
    ("PR17 same stamp fall recovery refreshes Core", "telemetry.py", 'if self._conservative.get("fallen"):', 'if False:'),

    ("domain61 permitted", "config.py", '"ROS_DOMAIN_ID": "93"', '"ROS_DOMAIN_ID": "61"'),
    ("Twist SI scaling", "sink.py", 'message.angular.z = velocity',
     'message.angular.z = tuple(x * 2 for x in velocity)'),
    ("latest output lost", "sink.py", 'self._velocity(velocity)',
     'self._velocity(Z)'),
    ("STOP retains motion", "sink.py", 'self._hold_locked(held=False)', 'self._urgent = True'),
    ("RESUME retried", "sink.py", 'resume, self._resume_pending = self._resume_pending, False',
     'resume = self._resume_pending'),
    ("watchdog deadline doubled", "sink.py", 'self.now() - self._last_apply >= DEAD',
     'self.now() - self._last_apply >= DEAD * 2'),
    ("STOP refreshes watchdog", "sink.py", 'elif command.kind == "stop":',
     'elif command.kind == "stop":\n                self._last_apply = self.now()'),
    ("unlock refreshes watchdog", "sink.py", 'elif command.kind == "unlock":',
     'elif command.kind == "unlock":\n                self._last_apply = self.now()'),
    ("independent watchdog delayed", "sink.py", 'self._closed.wait(0.005)', 'self._closed.wait(1)'),
    ("executor stall ignored", "sink.py", 'elif not self._expired and not self._publisher_expired and self.now() - self._last_flush >= DEAD:',
     'elif False:'),
    ("shutdown omits emergency output", "sink.py", '            self._emergency()\n            if self._watchdog',
     '            pass\n            if self._watchdog'),
    ("thread failure omits emergency output", "sink.py", '        self._emergency()\n\n    def _watch',
     '        pass\n\n    def _watch'),
    ("B1 new STOP throttled", "sink.py", 'self._stop_first or (', 'False or ('),
    ("B2 external STOP unlock discarded", "sink.py", 'if not self._held:', 'if not self._held and self._stopped:'),
    ("R1 duplicate stamp latches STOP", "node.py", 'if self.gate.reason == "duplicate_stamp":', 'if False:'),
    ("R3 writer conflict admitted", "node.py", 'if any(count != 1 for count in counts.values()):', 'if False:'),
    ("R5 stale STOP feedback clears hold", "sink.py", 'if generation is not None and generation != self._generation:', 'if False:'),
    ("R8 shutdown ACK ignored", "node.py", 'if not publisher.wait_for_all_acked(duration(seconds=remaining)):', 'if False:'),
    ("R9 automatic DDS profile admitted", "config.py", 'if any(Path(name).exists() for name in ("DEFAULT_FASTDDS_PROFILES.xml", "DEFAULT_FASTRTPS_PROFILES.xml")):', 'if False:'),
    ("R7 unverified odom clock mislabeled", "telemetry.py", 'if sample.get("clock") != "simulation":', 'if False:'),
    ("R8 node omits ACK wait", "node.py", 'wait_for_stop_acks(stop_publishers, Duration)', 'pass'),
    ("B3 same-stamp safety discarded", "telemetry.py", 'if cleaned == self._last_input:', 'if True:'),
    ("B3 same-stamp policy recovery admitted", "telemetry.py", 'cleaned["policy_running"] &= self._conservative["policy_running"]', 'cleaned["policy_running"] = cleaned["policy_running"]'),
    ("B3 same-stamp STOP recovery admitted", "telemetry.py", 'cleaned["stop_requested"] |= self._conservative["stop_requested"]', 'cleaned["stop_requested"] = cleaned["stop_requested"]'),
    ("B3 same-stamp RESET recovery admitted", "telemetry.py", 'cleaned["reset_in_progress"] |= self._conservative["reset_in_progress"]', 'cleaned["reset_in_progress"] = cleaned["reset_in_progress"]'),
    ("B3 same-stamp extends source freshness", "node.py", 'if self.gate.advanced:', 'if True:'),
    ("R5 generation captured after validation", "node.py", 'frame = (accepted, received_at, generation, self.gate.progress_at)', 'frame = (accepted, received_at, self.sink.feedback_generation(), self.gate.progress_at)'),
    ("B3 mailbox loses pending safety edge", "node.py", 'self.mailbox.put(safety=frame)', 'pass'),
    ("B3 telemetry source freshness extended", "telemetry.py", 'and 0 <= self.now() - s["progress_monotonic_s"] <= STATE_STALE', 'and True'),
    ("N1 second close skips emergency completion", "sink.py", 'if not self._close_complete.wait(timeout=1.0):', 'if False:'),
    ("R3-1 same stamp refreshes Core", "node.py", 'if stamp != self._core_stamp or gates != self._core_gates:', 'if True:'),
    ("R3-2 watchdog join unbounded", "sink.py", 'self._watchdog.join(timeout=0.5)', 'self._watchdog.join()'),
    ("R3-2 concurrent close unbounded", "sink.py", 'self._close_complete.wait(timeout=1.0)', 'self._close_complete.wait(timeout=10.0)'),
    ("telemetry not delivered to Client", "node.py", 'self.on_telemetry(self.telemetry.snapshot())', 'pass'),
    ("sensor receipts discarded", "node.py", 'self.devices[key] = receipt', 'pass'),
    ("old episode admitted", "telemetry.py", 'ep < self.episode:', 'False:'),
    ("NaN accepted", "telemetry.py", 'not number(raw[k]) for k in NUM', 'False for k in NUM'),
    ("source rewind admitted", "telemetry.py", 'stamp < self.sim_t:', 'False:'),
    ("stale receipt admitted", "telemetry.py", '0 <= now - received_at <= STATE_STALE', 'True'),
    ("map floor ignored", "telemetry.py", 'status.get("floor_id") != b.ros_floor_id', 'False'),
    ("fake battery", "telemetry.py", '"battery": {"soc": None}', '"battery": {"soc": 100}'),
]


def main():
    root = Path(__file__).resolve().parents[2]
    synthetic = "--synthetic" in sys.argv[1:]
    recovery = "--stall-recovery" in sys.argv[1:]
    if recovery and synthetic:
        raise SystemExit('--stall-recovery cannot be combined with --synthetic')
    if recovery:
        available = next(int(line.split()[1]) for line in Path('/proc/meminfo').read_text().splitlines()
                         if line.startswith('MemAvailable:'))
        if available < 2500000:
            raise SystemExit('MemAvailable below 2.5 GB; mutation checks not started')
    mutations = [
        ("stall skips fresh STOP feedback gate", "../link/session.py",
         'and not (self._output_stall_locked and self._output_feedback_held)', 'and True'),
        ("repeated publisher stall never fatal", "sink.py",
         'if len(self._stalls) == count and detected - self._stalls[0] <= window:', 'if False:'),
    ] if recovery else [("R4 independent watchdog absent in DDS/Core integration", "sink.py",
                  'self._closed.wait(0.005)', 'self._closed.wait(60)')] if synthetic else MUTATIONS
    targets = ["tests/test_stall_recovery.py"] if recovery else ["tests/test_ros_bridge_synthetic.py"] if synthetic else [
        "tests/test_ros_bridge.py", "tests/test_ros_bridge_review.py", "tests/test_ros_bridge_node.py",
        "tests/test_agent_telemetry.py"]
    # These two loopback acceptance tests run in the full suite. They cannot
    # distinguish ROS stub mutants and need not allocate ports for every copy.
    selection = [] if synthetic else ["-k", "not client_fake_server and not reserved_socket"]
    child_env = dict(os.environ)
    if recovery:
        # The focused tests validate the shared Pydantic wire contract too.
        child_env['PYTHONPATH'] = str(root.parents[1]) + os.pathsep + child_env.get('PYTHONPATH', '')
    if synthetic:
        # The observer parent is not a DDS participant and must not look like a
        # pre-existing domain93 owner to the child's /proc safety preflight.
        child_env.update(ROS_DOMAIN_ID="93", ROS_AUTOMATIC_DISCOVERY_RANGE="LOCALHOST",
                         ROS_LOCALHOST_ONLY="1", FOOTHOLD_ROS_SYNTHETIC="1")
    survived = False
    for name, filename, before, after in mutations:
        with tempfile.TemporaryDirectory(prefix="ros-bridge-mutation-") as tmp:
            dest = Path(tmp)
            shutil.copytree(root / "foothold_agent", dest / "foothold_agent", ignore=shutil.ignore_patterns("__pycache__"))
            shutil.copytree(root / "tests", dest / "tests", ignore=shutil.ignore_patterns("__pycache__"))
            shutil.copyfile(root / "tools/mutation_reporter.py", dest / "foothold_link_mutation_probe.py")
            target = dest / "foothold_agent/ros_bridge" / filename
            original = target.read_text()
            if original.count(before) != 1:
                raise RuntimeError(f"mutation anchor not unique: {name}")
            target.write_text(original.replace(before, after))
            report = dest / "report.json"
            result = subprocess.run([sys.executable, "-m", "pytest", *targets,
                *selection,
                "-q", "--tb=short", "-p", "foothold_link_mutation_probe", "--link-mutation-report", str(report)],
                cwd=dest, env=child_env, capture_output=True, text=True, timeout=25)
            data = json.loads(report.read_text()) if report.exists() else {}
            killed = (result.returncode == 1 and data.get("collected", 0) > 0
                      and bool(data.get("assertions")) and not data.get("errors"))
            if synthetic:
                killed = killed and "independent watchdog did not stop active motion" in result.stdout
            print(f"{'KILLED' if killed else 'SURVIVED/ERROR'} | {name} | assertions={len(data.get('assertions', []))}", flush=True)
            if not killed:
                print(json.dumps(data.get("errors", [])))
                print(result.stdout[-1500:] + result.stderr[-500:])
                survived = True
    return int(survived)


if __name__ == "__main__":
    raise SystemExit(main())
