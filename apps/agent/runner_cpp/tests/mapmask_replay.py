"""Compare C++ map-mask assembly and all outputs with independent Python ORT."""
import argparse
import json
from pathlib import Path
import struct
import subprocess
import tempfile

import numpy as np
import onnxruntime as ort


OUTPUTS = {"action": 12, "h_prop_out": 128, "h_terr_out": 128, "refined_map": 512, "est": 51}


def session(path):
    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    return ort.InferenceSession(str(path), options, providers=["CPUExecutionProvider"])


def reference(model, observations, depths, pose):
    missing = np.ones((60, 60), dtype=np.float32)
    available = None
    rows = []
    for obs, depth in zip(observations, depths, strict=True):
        if available != (depth is not None):
            available = depth is not None
            step = 0
            history = [obs] * 10
            frames = [depth if available else missing] * 3
            h_prop = np.zeros((1, 128), dtype=np.float32)
            h_terr = np.zeros_like(h_prop)
        else:
            history = [obs, *history[:9]]
            if available and step % 5 == 0:
                frames = [depth, *frames[:2]]
        result = model.run(list(OUTPUTS), {
            "o": obs[None], "hist": np.stack(history)[None],
            "depth2": np.stack(frames[1:])[None], "h_prop": h_prop, "h_terr": h_terr,
            "tick": np.float32([[step % 5 == 0]]), "first": np.float32([[step == 0]]),
            "pose": np.float32([pose]), "map_mask": np.float32([[not available]]),
        })
        h_prop, h_terr = result[1:3]
        rows.append(np.concatenate([tensor.ravel() for tensor in result]))
        step += 1
    return np.stack(rows)


def replay(exe, bundle, observations, depths, pose):
    data = bytearray(struct.pack("<2f", *pose))
    for obs, depth in zip(observations, depths, strict=True):
        data.append(depth is not None)
        data.extend(obs.astype("<f4", copy=False).tobytes())
        if depth is not None:
            data.extend(depth.astype("<f4", copy=False).tobytes())
    output = subprocess.run([exe, str(bundle)], input=data, stdout=subprocess.PIPE, check=True).stdout
    shape = (len(observations), sum(OUTPUTS.values()))
    values = np.frombuffer(output, dtype="<f4").reshape(shape)
    if not np.all(np.isfinite(values)):
        raise ValueError("nonfinite C++ map-mask output")
    return values


def check_contract(exe, bundle):
    contract_path = bundle / "start_onnx.json"
    manifest = json.loads(contract_path.read_text())
    with tempfile.TemporaryDirectory(prefix="foothold-mapmask-") as temp:
        fixture = Path(temp)
        (fixture / "start_step.onnx").symlink_to((bundle / "start_step.onnx").resolve())

        def rejection(needle):
            (fixture / "start_onnx.json").write_text(json.dumps(manifest))
            result = subprocess.run([exe, str(fixture)], capture_output=True, text=True)
            if result.returncode == 0 or needle not in result.stderr:
                raise ValueError(f"invalid contract accepted or wrong error: {result.stderr}")

        digest = manifest["files"]["start_step.onnx"]
        manifest["files"]["start_step.onnx"] = "0" * 64
        rejection("SHA-256 differs")
        manifest["files"]["start_step.onnx"] = digest
        manifest["step_inputs"][7]["shape"] = ["batch", 3]
        rejection("shape mismatch: pose")


def compare(exe, bundle, canon):
    vector = json.loads((canon / "test_vectors_flat20_reconstruction.json").read_text())
    observations = [np.float32(row["obs45"]).reshape(45) for row in vector["inputs"]]
    # Recover the frame captured at each policy tick from the reference model's delayed input.
    frames = [np.float32(vector["inputs"][0 if i < 5 else min(i // 5 * 5 + 5, 19)]["depth2"])
              .reshape(2, 60, 60)[0] for i in range(len(observations))]
    candidate = session(bundle / "start_step.onnx")
    expected = [np.float32(row["action"]).reshape(12) for row in vector["expected"]]
    off = json.loads((canon / "test_vectors_flat20_off.json").read_text())
    off_observations = [np.float32(row["obs45"]).reshape(45) for row in off["inputs"]]
    off_expected = [np.float32(row["action"]).reshape(12) for row in off["expected"]]
    automatic_frames = [frames[i % len(frames)] if 7 <= i < 27 or i >= 36 else None
                        for i in range(3 * len(frames))]
    for label, obs, depths, pose, canon_actions in (
        ("on", observations, frames, (0, 0), expected),
        ("off", off_observations, [None] * len(off_observations), (0, 0), off_expected),
        ("auto", observations * 3, automatic_frames, (0.03, -0.12), None),
    ):
        actual = replay(exe, bundle, obs, depths, pose)
        independent = reference(candidate, obs, depths, pose)
        error = np.abs(actual - independent)
        start = 0
        report = {}
        for name, width in OUTPUTS.items():
            report[name] = float(error[:, start:start + width].max())
            start += width
        if not all(np.isfinite(value) and value <= 1e-4 for value in report.values()):
            raise ValueError(f"{label}: C++ differs from Python ORT {report}")
        print(f"{label}: {len(obs)} steps, same-model max_abs={report}", flush=True)
        if canon_actions is not None:
            delta = np.abs(actual[:, :12] - np.stack(canon_actions))
            print(f"{label}: candidate vs canonical-3 reference actions "
                  f"max_abs={delta.max():.9g} mean_abs={delta.mean():.9g}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("executable", type=Path)
    parser.add_argument("bundle", type=Path)
    parser.add_argument("canonical", type=Path)
    args = parser.parse_args()
    check_contract(args.executable.resolve(), args.bundle)
    compare(args.executable.resolve(), args.bundle, args.canonical)
