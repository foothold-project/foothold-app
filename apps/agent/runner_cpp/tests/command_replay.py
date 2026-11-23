"""Compare command shaping and slewing against the pinned Python runner."""
import argparse
import itertools
import random
import subprocess

import numpy as np

from foothold_agent.policy import lowlevel
from foothold_agent.policy.start import DEFAULT_POSE


class Policy:
    def depth_needed(self):
        return False

    def inputs(self, *_args):
        return None

    def run(self, _):
        return {"action": np.zeros(12, dtype=np.float32)}


def cases():
    rng = random.Random(473)
    starts = (0.05, 0.1, 0.2, 0.2999, 0.3, 0.6, 0.6001, 1.2, 1.2001)
    for top, x, y, z in itertools.product((0., 0.6, 1.2, 1.5), starts, (0., .2, -.2), (0., .6, 1.4)):
        yield (top, -y, x, -z, 0., .1, -.15, x, y, z)
    for _ in range(1500):
        yield (rng.choice((0., .6, 1.2, 1.5)), *[rng.uniform(-1.5, 1.5) for _ in range(9)])


def compare(executable):
    rows = list(cases())
    data = "".join(" ".join(map(str, row)) + "\n" for row in rows)
    completed = subprocess.run([executable], input=data, capture_output=True, text=True, check=True)
    actual_rows = completed.stdout.splitlines()
    if len(actual_rows) != len(rows):
        raise ValueError(f"C++ emitted {len(actual_rows)} of {len(rows)} rows")

    runner = lowlevel.LowLevelRunner(object(), Policy(), live=False)
    worst = 0.0
    for row, line in zip(rows, actual_rows):
        top, lx, ly, rx, *values = row
        lowlevel.FWD_TOP = top
        remote = lowlevel.Remote(frozenset(), *map(float, np.float32([lx, ly, rx])))
        want = lowlevel.remote_want(remote)
        goal, mark = lowlevel.shape_command(*want)
        direct, direct_mark = lowlevel.shape_command(*values[3:])
        runner.cmd = np.float32(values[:3])
        runner.policy_step({"remote": remote, "q": DEFAULT_POSE, "dq": np.zeros(12), "gyro": np.zeros(3),
                            "grav": [0, 0, -1]}, None)
        tokens = line.split()
        error = np.max(np.abs(np.array([*want, *goal, *runner.cmd, *direct]) - np.array(tokens[:12], float)))
        worst = max(worst, float(error))
        if error > 1e-6 or tokens[12:] != [mark, direct_mark]:
            raise ValueError(f"command mismatch: input={row} error={error} marks={tokens[12:]} versus {mark}, {direct_mark}")
    print(f"{len(rows)} canonical Python command comparisons, max_abs_error={worst:.9g}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("executable")
    compare(parser.parse_args().executable)
