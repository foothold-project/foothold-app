"""Test entry-point arming, periodic measurements and dry-run trace schema."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile


def check(executable, bundle):
    with tempfile.TemporaryDirectory(prefix="foothold-start-") as tmp:
        result = subprocess.run([executable, "--folder", bundle, "--benchmark", "--seconds", "5.5",
                                 "--cpu-range", "0-1023", "--status", "0", "--trace-dir", tmp],
                                capture_output=True, text=True, check=True, timeout=20)
        bad_model = Path(tmp) / "start-m15500_map_off.onnx"
        bad_model.write_bytes(b"not the canonical model")
        rejection = subprocess.run([executable, "--folder", tmp, "--benchmark", "--seconds", "1",
                                    "--cpu-range", "0-1023"], capture_output=True, text=True, timeout=10)
        if rejection.returncode == 0 or "SHA-256 differs" not in rejection.stderr:
            raise ValueError("corrupt model was accepted")
        messages = [json.loads(line) for line in result.stdout.splitlines()]
        status = messages[-1]
        if status["status"] != "high" or status["lowcmd_writes"] != 0 or status["trace_drops"] != 0:
            raise ValueError(f"invalid dry-run completion: {status}")
        if status["dt_n"] < 50 or not 15 <= status["policy_period_p99_ms"] <= 30:
            raise ValueError(f"invalid policy cadence: {status}")
        if status["control_period_count"] < 4 * status["dt_n"]:
            raise ValueError(f"command loop did not run 4x policy loop: {status}")
        records = [json.loads(line)
                   for path in Path(tmp).glob("*.jsonl") for line in path.read_text().splitlines()]
        events = [row["event"] for row in records if "event" in row]
        expected = ["MODE_LOW", "POLICY_START", "EXIT_SIT_DOWN", "SIT_DOWN", "DAMPING", "MODE_HIGH"]
        if events != expected:
            raise ValueError(f"unexpected recorded events: {events}")
        samples = [row for row in records if row.get("phase") == "policy"]
        keys = set("t wall phase stick keys want shape goal cmd target q dq tau temp foot gyro grav est_vx est_v h_kin bat".split())
        if len(samples) < 50 or any(row.keys() != keys for row in samples):
            raise ValueError("incomplete policy trace")
        if any(row["est_v"] is not None or row["est_vx"] != [None, None] or
               row["bat"] is not None or not 0.2 < row["h_kin"] < 0.5 for row in samples):
            raise ValueError("invalid synthetic telemetry or canonical model estimates")
        if status["bat"] is not None or (status["jetson_c"] is not None and
                                          not -40 < status["jetson_c"] < 150):
            raise ValueError(f"invalid status telemetry: {status}")
        transitions = [row for row in records if row.get("phase") == "standing_up"]
        if not 250 <= len(transitions) <= 280 or any(
            row.keys() != keys or row["est_vx"] is not None or row["est_v"] is not None or
            row["cmd"] is not None or len(row["target"]) != 12 for row in transitions
        ):
            raise ValueError("invalid transition trace")


if __name__ == "__main__":
    check(*sys.argv[1:])
