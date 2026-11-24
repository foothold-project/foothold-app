"""Verify kernel-observed placement and scheduling of the runner threads."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time


def check(executable, bundle):
    cpus = sorted(os.sched_getaffinity(0))
    if len(cpus) < 3:
        return 77

    roles = dict(zip(("control", "sensing", "record"), cpus[:3]))
    flags = ["--control-cpus", str(roles["control"]), "--sensing-cpus", str(roles["sensing"]),
             "--io-cpus", str(roles["record"]), "--rt-priority", "40",
             "--sensing-rt-priority", "30"]
    args = [executable, "--folder", bundle, "--benchmark", "--seconds", "6", "--status", "0"]
    with subprocess.Popen(args + flags, text=True, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE) as runner:
        observed = {}
        limit = time.monotonic() + 4
        while time.monotonic() < limit and runner.poll() is None:
            for task in Path(f"/proc/{runner.pid}/task").glob("*"):
                try:
                    name = (task / "comm").read_text().strip().removeprefix("fh-")
                    if name not in roles:
                        continue
                    tid = int(task.name)
                    affinity = os.sched_getaffinity(tid)
                    policy = os.sched_getscheduler(tid)
                    priority = os.sched_getparam(tid).sched_priority
                    if affinity == {roles[name]}:
                        observed[name] = (policy, priority)
                except (FileNotFoundError, ProcessLookupError):
                    continue
            if len(observed) == len(roles):
                break
            time.sleep(.03)
        out, err = runner.communicate(timeout=20)
        if runner.returncode != 0:
            raise ValueError(err)
    assert set(observed) == set(roles), observed
    rows = [json.loads(line) for line in out.splitlines()]
    reports = {row["role"]: row for row in rows if "role" in row}
    for role, (policy, priority) in observed.items():
        label = "SCHED_FIFO" if policy == os.SCHED_FIFO else "SCHED_OTHER"
        assert reports[role]["cpus"] == [roles[role]], reports
        assert reports[role]["policy"] == label and reports[role]["priority"] == priority, reports
    assert observed["record"] == (os.SCHED_OTHER, 0)
    assert reports["control"]["requested_priority"] == 40 and reports["sensing"]["requested_priority"] == 30
    assert rows[-1]["lowcmd_writes"] == 0 and rows[-1]["dt_n"] > 0

    duplicate = flags.copy()
    duplicate[3] = str(roles["control"])
    invalid = subprocess.run(args + duplicate, text=True, capture_output=True, timeout=10)
    assert invalid.returncode and "overlap" in invalid.stderr
    return 0


if __name__ == "__main__":
    sys.exit(check(*sys.argv[1:]))
