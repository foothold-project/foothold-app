#!/usr/bin/env python3
"""Convert the numeric foothold-v2 NPZ to sim.js's row-major float32 LE format.

Only NumPy and the standard library are needed. --check also invokes the local
Node executable to test the repository's actual sim.js loadPolicy (no physics).
No checkpoint, downloaded Python module, or pickle is loaded.
"""
import argparse
import base64
import hashlib
import json
import platform
from pathlib import Path
import subprocess
import sys
import zipfile

import numpy as np


SHAPES = ((512, 235), (256, 512), (128, 256), (12, 128))
FLOAT_COUNT = sum(r * c + r for r, c in SHAPES)
SEED = 20261029
RANDOM_N = 64
# Float32 BLAS and JS Number accumulation round differently, especially at sigma=5.
NUMPY_JS_ATOL = 2e-4
JS_EMULATION_ATOL = 1e-6


def load_npz(path):
    """Read eight standard ZIP/NPY numeric arrays; never permit object pickle."""
    expected = {f"{k}.{kind}.npy" for k in (0, 2, 4, 6) for kind in ("weight", "bias")}
    layers = []
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        if len(names) != len(expected) or set(names) != expected:
            raise ValueError("expected only 0/2/4/6 weight and bias NPY entries")
        for k, (r, c) in zip((0, 2, 4, 6), SHAPES):
            arrays = []
            for kind, shape in (("weight", (r, c)), ("bias", (r,))):
                with archive.open(f"{k}.{kind}.npy") as entry:
                    value = np.lib.format.read_array(entry, allow_pickle=False)
                if value.shape != shape or value.dtype.kind != "f" or value.dtype.itemsize != 4:
                    raise ValueError(f"{k}.{kind}: expected float32 {shape}")
                if not np.isfinite(value).all():
                    raise ValueError(f"{k}.{kind}: non-finite weight")
                arrays.append(np.asarray(value, dtype="<f4", order="C"))
            layers.append(tuple(arrays))
    return layers


def encode(layers):
    return b"".join(a.astype("<f4", copy=False).tobytes(order="C") for layer in layers for a in layer)


def decode(data):
    if len(data) != FLOAT_COUNT * 4:
        raise ValueError(f"expected {FLOAT_COUNT * 4} bytes, got {len(data)}")
    values = np.frombuffer(data, dtype="<f4")
    if not np.isfinite(values).all():
        raise ValueError("non-finite f32 weight")
    layers, offset = [], 0
    for r, c in SHAPES:
        layers.append((values[offset:offset + r * c].reshape(r, c),
                       values[offset + r * c:offset + r * c + r]))
        offset += r * c + r
    return layers


def forward(layers, inputs, js_numbers=False):
    h = inputs
    for k, (weight, bias) in enumerate(layers):
        if js_numbers:
            # sim.js: start with bias, multiply/add in column order as JS Number
            # (binary64), then store each layer's output in a Float32Array.
            y = np.broadcast_to(bias.astype(np.float64), (len(h), len(bias))).copy()
            for j in range(weight.shape[1]):
                y += h[:, j:j + 1].astype(np.float64) * weight[:, j].astype(np.float64)
        else:
            y = h @ weight.T + bias
        if k < len(layers) - 1:
            negative = y <= 0
            y[negative] = np.expm1(y[negative])  # ELU(alpha=1), output layer linear
        h = y.astype(np.float32)
    return h


def check(layers, data, npz_path):
    if sys.byteorder != "little":
        raise ValueError("sim.js Float32Array verification requires a little-endian host")
    assert encode(layers) == data, "rebuilt f32 differs from checked copy"
    parsed = decode(data)
    for original, recovered in zip(layers, parsed):
        for a, b in zip(original, recovered):
            np.testing.assert_array_equal(a, b)
    stand = np.zeros((1, 235), dtype=np.float32)
    stand[0, 8] = -1
    stand[0, 48:] = 0.32 - 0.5  # cpu-check/export_and_check.py stand_approx
    rng = np.random.default_rng(SEED)
    cases = {
        "zeros": np.zeros((1, 235), dtype=np.float32),
        "stand_approx": stand,
        "randn_s1": rng.standard_normal((RANDOM_N, 235)).astype(np.float32),
        "randn_s5": (5 * rng.standard_normal((RANDOM_N, 235))).astype(np.float32),
    }
    inputs = np.concatenate(list(cases.values()))
    reference = forward(layers, inputs)
    f32_numpy = forward(parsed, inputs)
    emulated = forward(parsed, inputs, js_numbers=True)
    # Import only our checked-in, side-effect-free inference module, unchanged.
    # Read weights and inputs as data; createSim/MuJoCo are never invoked.
    node_script = """
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { loadPolicy } = await import(pathToFileURL(process.argv[1]).href);
const request = JSON.parse(readFileSync(0, 'utf8'));
const bytes = Uint8Array.from(Buffer.from(request.weights, 'base64'));
const policy = loadPolicy(bytes.buffer);
const outputs = request.inputs.map(x => Array.from(policy(Float32Array.from(x))));
if (!outputs.every(y => y.every(Number.isFinite))) throw new Error('non-finite output');
console.log(JSON.stringify({ version: process.version, outputs }));
"""
    sim_path = Path(__file__).resolve().parents[1] / "sim" / "sim.js"
    result = subprocess.run(
        ["node", "--input-type=module", "-e", node_script, str(sim_path)],
        input=json.dumps({"weights": base64.b64encode(data).decode("ascii"), "inputs": inputs.tolist()}),
        text=True, capture_output=True, check=True,
    )
    node = json.loads(result.stdout)
    actual = np.asarray(node["outputs"], dtype=np.float32)
    assert actual.shape == reference.shape, "Node output shape mismatch"
    for output in (reference, f32_numpy, emulated, actual):
        assert np.isfinite(output).all(), "non-finite inference output"
    np.testing.assert_array_equal(reference, f32_numpy)
    np.testing.assert_allclose(reference, actual, atol=NUMPY_JS_ATOL, rtol=0)
    np.testing.assert_allclose(emulated, actual, atol=JS_EMULATION_ATOL, rtol=0)
    report = {
        "python": platform.python_version(), "numpy": np.__version__, "node": node["version"],
        "host_byteorder": sys.byteorder,
        "converter_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "npz_sha256": hashlib.sha256(npz_path.read_bytes()).hexdigest(),
        "f32_sha256": hashlib.sha256(data).hexdigest(), "f32_bytes": len(data),
        "sim_js_sha256": hashlib.sha256(sim_path.read_bytes()).hexdigest(),
        "byte_identical": True, "seed": SEED, "rng": "NumPy default_rng/PCG64",
        "numpy_js_atol": NUMPY_JS_ATOL, "js_emulation_atol": JS_EMULATION_ATOL,
        "cases": {}, "pass": True,
    }
    offset = 0
    for name, x in cases.items():
        sl = slice(offset, offset + len(x))
        ref, f32, emu, js = (a[sl] for a in (reference, f32_numpy, emulated, actual))
        report["cases"][name] = {
            "n": len(x), "inputs": x.tolist(),
            "npz_numpy_outputs": ref.tolist(), "f32_numpy_outputs": f32.tolist(),
            "f32_js_emulation_outputs": emu.tolist(), "sim_js_outputs": js.tolist(),
            "npz_vs_f32_numpy_max_abs": float(np.max(np.abs(ref - f32))),
            "npz_vs_f32_js_emulation_max_abs": float(np.max(np.abs(ref - emu))),
            "npz_vs_sim_js_max_abs": float(np.max(np.abs(ref - js))),
            "js_emulation_vs_sim_js_max_abs": float(np.max(np.abs(emu - js))),
        }
        offset += len(x)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("npz", type=Path)
    parser.add_argument("--output", type=Path, help="create a NEW f32 file (never overwrite)")
    parser.add_argument("--check", type=Path, help="assert bytes and inference against an existing f32")
    parser.add_argument("--report", type=Path, help="write raw JSON (requires --check; keep under runs/)")
    args = parser.parse_args()
    if not args.output and not args.check:
        parser.error("provide --output or --check")
    if args.report and not args.check:
        parser.error("--report requires --check")
    layers = load_npz(args.npz)
    data = encode(layers)
    report = check(layers, args.check.read_bytes(), args.npz) if args.check else None
    if args.output:
        with args.output.open("xb") as out:
            out.write(data)
    if args.report:
        args.report.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
    summary = {"f32_bytes": len(data), "f32_sha256": hashlib.sha256(data).hexdigest()}
    if report:
        summary.update({"pass": report["pass"], "cases": {
            name: {k: v for k, v in case.items() if k.endswith("max_abs") or k == "n"}
            for name, case in report["cases"].items()
        }})
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
