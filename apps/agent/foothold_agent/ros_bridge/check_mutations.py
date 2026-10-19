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
    ("executor stall ignored", "sink.py", 'elif not self._expired and self.now() - self._last_flush >= DEAD:',
     'elif False:'),
    ("shutdown omits emergency output", "sink.py", '        self._emergency()\n        if self._watchdog',
     '        pass\n        if self._watchdog'),
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
    ("old episode admitted", "telemetry.py", 'ep < self.episode:', 'False:'),
    ("NaN accepted", "telemetry.py", 'not number(raw[k]) for k in NUM', 'False for k in NUM'),
    ("source rewind admitted", "telemetry.py", 'stamp <= self.sim_t:', 'False:'),
    ("stale receipt admitted", "telemetry.py", '0 <= now - received_at <= STATE_STALE', 'True'),
    ("map floor ignored", "telemetry.py", 'status.get("floor_id") != b.ros_floor_id', 'False'),
    ("fake battery", "telemetry.py", '"battery": {"soc": None}', '"battery": {"soc": 100}'),
]


def main():
    root = Path(__file__).resolve().parents[2]
    synthetic = "--synthetic" in sys.argv[1:]
    mutations = [("R4 independent watchdog absent in DDS/Core integration", "sink.py",
                  'self._closed.wait(0.005)', 'self._closed.wait(60)')] if synthetic else MUTATIONS
    targets = ["tests/test_ros_bridge_synthetic.py"] if synthetic else [
        "tests/test_ros_bridge.py", "tests/test_ros_bridge_review.py", "tests/test_ros_bridge_node.py"]
    child_env = dict(os.environ)
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
