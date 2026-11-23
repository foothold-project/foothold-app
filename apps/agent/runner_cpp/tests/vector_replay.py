"""Drive the C++ policy with canonical JSON vectors and check every action."""
import argparse
import json
import math
from pathlib import Path
import struct
import subprocess


def flat(value):
    if isinstance(value, list):
        for entry in value:
            yield from flat(entry)
    else:
        yield value


def replay(executable, folder, mode, python_reference):
    document = json.loads((folder / f"test_vectors_flat20_{mode}.json").read_text())
    steps = document["inputs"]
    if len(steps) != 20 or len(document["expected"]) != len(steps):
        raise ValueError(f"{mode}: expected 20 input and output steps")

    request = bytearray()
    frames = []
    for index, step in enumerate(steps):
        request.extend(struct.pack("<45f", *flat(step["obs45"])))
        depth = None
        if mode == "reconstruction" and index % 5 == 0:
            following = steps[min(index + 5, len(steps) - 1)] if index else step
            depth = list(flat(following["depth2"]))[:3600]
            request.extend(struct.pack("<3600f", *depth))
        frames.append(depth)
        if mode == "gt":
            request.extend(struct.pack("<512f", *flat(step["gt_map"])))

    result = subprocess.run([str(executable), str(folder), mode], input=request,
                            stdout=subprocess.PIPE, check=True)
    if len(result.stdout) != 20 * 12 * 4:
        raise ValueError(f"{mode}: invalid C++ output length {len(result.stdout)}")
    actual = struct.unpack("<240f", result.stdout)
    expected = [value for step in document["expected"] for value in flat(step["action"])]
    if len(expected) != len(actual) or not all(map(math.isfinite, (*actual, *expected))):
        raise ValueError(f"{mode}: invalid action tensor")
    worst = max(abs(a - b) for a, b in zip(actual, expected))
    print(f"{mode}: 20 steps, action_max_err={worst:.9g}", flush=True)
    if worst > min(1e-4, document["tolerance"]):
        raise ValueError(f"{mode}: policy mismatch")
    if python_reference:
        from foothold_agent.policy.start import StartPolicy

        policy = StartPolicy(folder, mode)
        reference = []
        for step, depth in zip(steps, frames):
            inputs = policy.inputs(step["obs45"], depth, step["gt_map"])
            reference.extend(policy.run(inputs)["action"].ravel())
        direct = max(abs(a - float(b)) for a, b in zip(actual, reference))
        print(f"{mode}: canonical Python action_max_err={direct:.9g}", flush=True)
        if not math.isfinite(direct) or direct > 1e-4:
            raise ValueError(f"{mode}: C++ and Python differ")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("executable", type=Path)
    parser.add_argument("folder", type=Path)
    parser.add_argument("--python-reference", action="store_true")
    args = parser.parse_args()
    for current_mode in ("off", "reconstruction", "gt"):
        replay(args.executable.resolve(), args.folder, current_mode, args.python_reference)
