#!/usr/bin/env python3
"""Build deterministic FP32 ONNX from the verified numeric NPZ, without torch/pickle.

Run with the existing ame2-export venv's python -I (NumPy + onnx==1.20.1).
All generated artifacts stay in runs/policy-onnx/out; existing files are refused.
--observations adds NumPy references to recorded sim observations, without export.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path

import numpy as np
import onnx
from onnx import helper, numpy_helper, TensorProto

# Reuse only our numeric NPZ reader and NumPy forward, loaded by exact local path.
spec = importlib.util.spec_from_file_location("npz_to_f32", Path(__file__).with_name("npz_to_f32.py"))
numeric = importlib.util.module_from_spec(spec)
spec.loader.exec_module(numeric)
NPZ_SHA = "a162d3bff81611de0ac60cd5aeb08dea3a3d06445992137d02b75c5bf3e604b8"
F32_SHA = "da199be22d3bea64601d5237a0438ff447c85a49ce64d35bb6f486b5f0adc68c"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("npz", type=Path)
    parser.add_argument("--out", type=Path, default=Path("runs/policy-onnx/out"))
    parser.add_argument("--observations", type=Path)
    parser.add_argument("--reference-name", choices=("recorded.json", "browser-recorded.json"), default="recorded.json")
    args = parser.parse_args()
    if args.out.resolve() != Path("runs/policy-onnx/out").resolve():
        parser.error("outputs must stay in runs/policy-onnx/out")
    if hashlib.sha256(args.npz.read_bytes()).hexdigest() != NPZ_SHA:
        raise ValueError("source NPZ SHA-256 mismatch")
    layers = numeric.load_npz(args.npz)
    data = numeric.encode(layers)
    if hashlib.sha256(data).hexdigest() != F32_SHA:
        raise ValueError("f32 SHA-256 mismatch")
    args.out.mkdir(parents=True, exist_ok=True)
    if args.observations:
        cases = json.loads(args.observations.read_text())
        name = args.reference_name
    else:
        rng = np.random.default_rng(20261029)
        neutral = np.zeros(235, dtype=np.float32)
        neutral[8] = -1
        neutral[48:] = -.18
        cases = [{"name": "zero", "observation": [0.] * 235},
                 {"name": "neutral", "observation": neutral.tolist()}]
        for sigma in (1, 5):
            cases.extend({"name": f"random-s{sigma}/{i}", "observation": x.tolist()}
                         for i, x in enumerate((sigma * rng.standard_normal((64, 235))).astype(np.float32)))
        name = "fixed.json"
        nodes, initializers = [], []
        previous = "observation"
        for k, (weight, bias) in enumerate(layers):
            w, b, y = f"w{k}", f"b{k}", f"linear{k}"
            initializers.extend([numpy_helper.from_array(weight, w), numpy_helper.from_array(bias, b)])
            nodes.append(helper.make_node("Gemm", [previous, w, b], ["action" if k == 3 else y], transB=1))
            if k < 3:
                previous = f"elu{k}"
                nodes.append(helper.make_node("Elu", [y], [previous], alpha=1.0))
        graph = helper.make_graph(nodes, "foothold-v2-actor-mean",
                                  [helper.make_tensor_value_info("observation", TensorProto.FLOAT, [1, 235])],
                                  [helper.make_tensor_value_info("action", TensorProto.FLOAT, [1, 12])], initializers)
        model = helper.make_model(graph, producer_name="foothold-numeric-npz", opset_imports=[helper.make_opsetid("", 17)])
        model.ir_version = 8
        onnx.checker.check_model(model, full_check=True)
        payload = model.SerializeToString(deterministic=True)
        for filename, content in [("policy_v2.onnx", payload), ("policy_v2.f32", data)]:
            with (args.out / filename).open("xb") as output:
                output.write(content)
        print(json.dumps({"onnx_sha256": hashlib.sha256(payload).hexdigest(), "bytes": len(payload),
                          "npz_sha256": NPZ_SHA, "f32_sha256": F32_SHA, "numpy": np.__version__, "onnx": onnx.__version__}))
    inputs = np.asarray([x["observation"] for x in cases], dtype=np.float32)
    if inputs.ndim != 2 or inputs.shape[1] != 235 or not np.isfinite(inputs).all():
        raise ValueError("expected finite N x 235 observations")
    references = numeric.forward(layers, inputs)
    for case, reference in zip(cases, references):
        case["numpy_outputs"] = reference.tolist()
    if args.observations and cases and "onnx_outputs" in cases[0]:
        metrics = {key: float(np.max(np.abs(references - np.asarray([x[key] for x in cases], dtype=np.float32))))
                   for key in ("js_outputs", "onnx_outputs")}
        print(json.dumps({"count": len(cases), "numpy_max_abs": metrics, "pass": max(metrics.values()) <= 1e-4}))
        if max(metrics.values()) > 1e-4:
            raise ValueError("browser recorded parity exceeds 1e-4")
    with (args.out / name).open("x") as output:
        json.dump(cases, output, allow_nan=False)


if __name__ == "__main__":
    main()
