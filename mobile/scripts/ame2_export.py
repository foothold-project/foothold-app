#!/usr/bin/env python3
"""Reconstruct AME2 teacher on CPU; never import the supplied training code."""
import argparse
import hashlib
import json
import platform
import sys
from pathlib import Path

import numpy as np
import torch
from torch import nn
from torch.nn.attention import SDPBackend, sdpa_kernel


SEED = 20261029
ATOL = 1e-4
SOURCE_FILES = (
    "rsl_rl/rsl_rl/models/AME2_models.py",
    "rsl_rl/rsl_rl/modules/ame2_modules.py",
    "rsl_rl/rsl_rl/algorithms/ppo.py",
    "go2/ame2_go2/tasks/mdp/observations.py",
    "go2/ame2_go2/tasks/mdp/actions.py",
    "go2/ame2_go2/tasks/go2_env_cfg.py",
)


def sha(data):
    return hashlib.sha256(data).hexdigest()


class MLP(nn.Module):
    def __init__(self, inputs, outputs):
        super().__init__()
        self.net = nn.Sequential(nn.Linear(inputs, 512), nn.ELU(),
                                 nn.Linear(512, 512), nn.ELU(), nn.Linear(512, outputs))

    def forward(self, x):
        return self.net(x)


def torch_offsets(centers):
    return torch.round(centers - centers.new_tensor([5.5, 4.5])).long().clamp(
        min=centers.new_tensor([0, 0], dtype=torch.long),
        max=centers.new_tensor([17, 3], dtype=torch.long))


class Actor(nn.Module):
    """Independent reconstruction from training source text, deterministic mean."""
    def __init__(self):
        super().__init__()
        self.log_std = nn.Parameter(torch.zeros(12))  # strict-load fidelity; unused by mean
        self.fc_part = nn.Sequential(nn.Linear(3, 16), nn.ELU())
        self.cnn_part = nn.Sequential(nn.Conv2d(1, 8, 5, padding=2), nn.ELU(),
                                      nn.Conv2d(8, 48, 5, padding=2), nn.ELU())
        self.local_proj = nn.Sequential(nn.Linear(64, 96), nn.ELU())
        self.prop_encoder = MLP(49, 128)
        self.global_cnn = nn.Sequential(nn.Conv2d(3, 8, 3), nn.ELU(),
                                       nn.Conv2d(8, 32, 3, dilation=2), nn.ELU())
        self.global_proj = nn.Sequential(nn.Linear(32, 64), nn.ELU())
        self.gaze_head = nn.Sequential(nn.Linear(192, 64), nn.ELU(), nn.Linear(64, 2))
        self.query_mlp = MLP(192, 96)
        self.mha = nn.MultiheadAttention(96, 32, batch_first=True)
        self.output_mlp = MLP(288, 12)

    def forward(self, prop, mapping, centers=None):
        batch = len(prop)
        global_feat = self.global_proj(self.global_cnn(mapping.permute(0, 3, 1, 2))
                                       .flatten(2).max(dim=2).values)
        proprio = self.prop_encoder(prop)
        gaze_logits = self.gaze_head(torch.cat((global_feat, proprio), dim=-1))
        if centers is None:
            r = torch.sigmoid(gaze_logits)
            centers = r * r.new_tensor([17, 3]) + r.new_tensor([5.5, 4.5])
        offsets = torch_offsets(centers)
        rows = offsets[:, :1] + torch.arange(12)
        cols = offsets[:, 1:] + torch.arange(10)
        idx = (rows[:, :, None] * 13 + cols[:, None, :]).reshape(batch, 120)
        patch = mapping.reshape(batch, 377, 3).gather(1, idx[..., None].expand(-1, -1, 3))
        patch = patch.reshape(batch, 12, 10, 3)
        spatial = self.cnn_part(patch[..., 2:].permute(0, 3, 1, 2)).permute(0, 2, 3, 1)
        local = self.local_proj(torch.cat((self.fc_part(patch), spatial), -1)).reshape(batch, 120, 96)
        query = self.query_mlp(torch.cat((proprio, global_feat), -1))[:, None, :]
        with sdpa_kernel(SDPBackend.MATH):
            attended, _ = self.mha(query, local, local, need_weights=False)
        output = self.output_mlp(torch.cat((attended[:, 0], proprio, global_feat), -1))
        return output, offsets, gaze_logits


def elu(x):
    out = x.copy()
    negative = x < 0
    out[negative] = np.expm1(x[negative])
    return out


def numpy_offsets(centers):
    return np.clip(np.rint(centers - np.array([5.5, 4.5], dtype=np.float32)),
                   [0, 0], [17, 3]).astype(np.int64)


def numpy_forward(weights, prop, mapping, centers=None):
    """NumPy only: NHWC cross-correlation, explicit attention, float32 throughout."""
    def linear(x, prefix):
        return x @ weights[prefix + ".weight"].T + weights[prefix + ".bias"]

    def mlp(x, prefix):
        for index in (0, 2, 4):
            x = linear(x, f"{prefix}.net.{index}")
            if index != 4:
                x = elu(x)
        return x

    def conv(x, prefix, padding=0, dilation=1):
        w, b = weights[prefix + ".weight"], weights[prefix + ".bias"]
        kernel = w.shape[2]
        if padding:
            x = np.pad(x, ((0, 0), (padding, padding), (padding, padding), (0, 0)))
        extent = dilation * (kernel - 1) + 1
        windows = np.lib.stride_tricks.sliding_window_view(x, (extent, extent), axis=(1, 2))
        # windows B,H,W,C,Kx,Ky -> B,H,W,C*Kx*Ky, matching OIHW weights
        windows = windows[..., ::dilation, ::dilation]
        flat = np.ascontiguousarray(windows).reshape(*windows.shape[:3], -1)
        return flat @ w.reshape(len(b), -1).T + b

    batch = len(prop)
    g = elu(conv(mapping, "global_cnn.0"))
    g = elu(conv(g, "global_cnn.2", dilation=2)).max(axis=(1, 2))
    global_feat = elu(linear(g, "global_proj.0"))
    proprio = mlp(prop, "prop_encoder")
    logits = linear(elu(linear(np.concatenate((global_feat, proprio), -1), "gaze_head.0")),
                    "gaze_head.2")
    if centers is None:
        # Stable sigmoid; ELU and exp operate on float32 arrays.
        exp = np.exp(-np.abs(logits))
        r = np.where(logits >= 0, 1 / (1 + exp), exp / (1 + exp))
        centers = r * np.array([17, 3], np.float32) + np.array([5.5, 4.5], np.float32)
    offsets = numpy_offsets(centers)
    rows = offsets[:, 0, None] + np.arange(12)
    cols = offsets[:, 1, None] + np.arange(10)
    patch = mapping[np.arange(batch)[:, None, None], rows[:, :, None], cols[:, None, :]]
    spatial = elu(conv(elu(conv(patch[..., 2:], "cnn_part.0", padding=2)),
                       "cnn_part.2", padding=2))
    local = elu(linear(np.concatenate((elu(linear(patch, "fc_part.0")), spatial), -1),
                       "local_proj.0")).reshape(batch, 120, 96)
    query = mlp(np.concatenate((proprio, global_feat), -1), "query_mlp")[:, None, :]
    w, b = weights["mha.in_proj_weight"], weights["mha.in_proj_bias"]
    q = query @ w[:96].T + b[:96]
    k = local @ w[96:192].T + b[96:192]
    v = local @ w[192:].T + b[192:]
    q = q.reshape(batch, 1, 32, 3).transpose(0, 2, 1, 3)
    k = k.reshape(batch, 120, 32, 3).transpose(0, 2, 1, 3)
    v = v.reshape(batch, 120, 32, 3).transpose(0, 2, 1, 3)
    scores = (q @ k.swapaxes(-1, -2)) * np.float32(3 ** -0.5)
    probs = np.exp(scores - scores.max(axis=-1, keepdims=True))
    probs /= probs.sum(axis=-1, keepdims=True)
    attended = (probs @ v).transpose(0, 2, 1, 3).reshape(batch, 96)
    attended = linear(attended, "mha.out_proj")
    return mlp(np.concatenate((attended, proprio, global_feat), -1), "output_mlp"), offsets, logits


def finite_tree(value):
    """Count/check every checkpoint tensor, including critic/optimizer; no execution."""
    count = 0
    if isinstance(value, torch.Tensor):
        if not torch.isfinite(value).all():
            raise ValueError("checkpoint contains a non-finite tensor")
        return 1
    if isinstance(value, dict):
        for child in value.values():
            count += finite_tree(child)
    elif isinstance(value, (list, tuple)):
        for child in value:
            count += finite_tree(child)
    elif isinstance(value, float) and not np.isfinite(value):
        raise ValueError("checkpoint contains a non-finite scalar")
    return count


def load_checkpoint(path):
    # Deliberately no fallback, custom safe globals, or downloaded module imports.
    checkpoint = torch.load(path, map_location="cpu", weights_only=True)
    finite_tree(checkpoint)
    state = checkpoint["actor_state_dict"]
    for name, value in state.items():
        if not isinstance(value, torch.Tensor) or value.dtype != torch.float32:
            raise ValueError(f"{name}: expected float32 tensor")
        if not torch.isfinite(value).all():
            raise ValueError(f"{name}: non-finite tensor")
    return checkpoint, state


def encode(state):
    chunks, table, offset = [], [], 0
    for name, tensor in state.items():
        a = np.asarray(tensor.detach().numpy(), dtype="<f4", order="C")
        data = a.tobytes(order="C")
        table.append({"name": name, "shape": list(a.shape), "dtype": "float32-le",
                      "offset_bytes": offset, "nbytes": len(data), "sha256": sha(data),
                      "used_by_mean": name != "log_std"})
        offset += len(data)
        chunks.append(data)
    return b"".join(chunks), table


def decode(data, table):
    weights, offset = {}, 0
    for entry in table:
        assert entry["offset_bytes"] == offset
        block = data[offset:offset + entry["nbytes"]]
        assert len(block) == entry["nbytes"] and sha(block) == entry["sha256"]
        weights[entry["name"]] = np.frombuffer(block, dtype="<f4").reshape(entry["shape"])
        assert np.isfinite(weights[entry["name"]]).all()
        offset += entry["nbytes"]
    assert offset == len(data)
    return weights


def input_contract():
    return {
        "teacher_prop": {"shape": ["B", 49], "dtype": "float32", "history": 0,
            "fields": [
                {"indices": [0, 3], "name": "body_linear_velocity_xyz", "unit": "m/s"},
                {"indices": [3, 6], "name": "body_angular_velocity_xyz", "unit": "rad/s"},
                {"indices": [6, 9], "name": "projected_gravity_xyz", "unit": "unit_vector"},
                {"indices": [9, 21], "name": "joint_position_minus_default", "unit": "rad"},
                {"indices": [21, 33], "name": "joint_velocity", "unit": "rad/s"},
                {"indices": [33, 45], "name": "previous_raw_action_clip_50", "unit": "raw"},
                {"indices": [45, 49], "name": "goal_x_y_sin_yaw_cos_yaw", "units": ["m", "m", "1", "1"]}],
            "index_intervals": "start-inclusive,end-exclusive", "neutral_goal": [0, 0, 0, 1],
            "goal_distance_clip_m": 2, "far_goal_yaw": "random each policy step",
            "extra_scale": 1, "normalization": "none",
            "evidence": "params/env.yaml:1320-1409; observations.py:40-81,276-340"},
        "teacher_mapping": {"shape": ["B", 29, 13, 3], "dtype": "float32",
            "order": "NHWC row-major; x outer, y inner; channels x,y,z in meters",
            "x": "-0.42+0.06*i, i=0..28", "y": "-0.36+0.06*j, j=0..12",
            "z": "clip(hit_world_z-body_sensor_z+0.27,-1.5,1.5), then training noise",
            "rotation": "yaw only", "evidence": "observations.py:160-222; params/env.yaml:584-627"},
        "output": {"shape": ["B", 12], "kind": "deterministic raw mean, no sampling or clipping",
            "scale": 0.25, "target": "default_joint_angle + 0.25*raw_action",
            "evidence": "AME2_models.py:102-139; params/env.yaml:1583-1600",
            "source_excerpt": "scale: 0.25\nuse_default_offset: true", "joint_names": None},
        "unknown": ["joint name order from unavailable USD asset", "time input remains unconfirmed",
                    "training runtime/version and original actor execution parity",
                    "redistribution license", "phone inference performance", "sensor map adapter"],
        "restriction": "실기 불가: 교사가 참 높이지도를 읽음",
    }


def check(actor, weights):
    rng = np.random.default_rng(SEED)
    zeros_p = np.zeros((1, 49), np.float32)
    zeros_m = np.zeros((1, 29, 13, 3), np.float32)
    neutral = zeros_p.copy()
    neutral[:, 8], neutral[:, 48] = -1, 1
    grid = np.stack(list(np.meshgrid(np.arange(29, dtype=np.float32) * .06 - .42,
                                    np.arange(13, dtype=np.float32) * .06 - .36, indexing="ij")) +
                    [np.zeros((29, 13), np.float32)], -1)[None]
    random_p = rng.standard_normal((64, 49)).astype(np.float32)
    random_m = np.repeat(grid, 64, axis=0)
    random_m[..., 2] = rng.uniform(-1.5, 1.5, (64, 29, 13)).astype(np.float32)
    # Inject continuous centers to isolate rounding/gather at both ends and ties.
    # Neighboring representable float32 centers test either side of each half tie.
    axes = []
    for half, limit in ((5.5, 17), (4.5, 3)):
        values = [np.float32(half - 1), np.float32(half), np.float32(half + limit),
                  np.float32(half + limit + 1)]
        for tie in (.5, 1.5, 2.5, limit - .5):
            center = np.float32(half + tie)
            values.extend((np.nextafter(center, np.float32(-np.inf)), center,
                           np.nextafter(center, np.float32(np.inf))))
        axes.append(np.unique(values))
    centers = np.stack(np.meshgrid(*axes, indexing="ij"), -1).reshape(-1, 2).astype(np.float32)
    # Independent expected ties-to-even examples ensure two wrong rounders cannot agree.
    ties = np.array([[6, 5], [7, 6], [8, 7], [22, 7]], np.float32)
    expected = np.array([[0, 0], [2, 2], [2, 2], [16, 2]])
    np.testing.assert_array_equal(numpy_offsets(ties), expected)
    np.testing.assert_array_equal(torch_offsets(torch.from_numpy(ties)).numpy(), expected)
    cases = {
        "zeros": (zeros_p, zeros_m, None),
        "neutral_goal_flat": (neutral, grid, None),
        "random64": (random_p, random_m, None),
        "crop_edges_and_half_ties": (np.repeat(neutral, len(centers), axis=0),
                                     np.repeat(random_m[:1], len(centers), axis=0), centers),
    }
    results = {}
    for name, (prop, mapping, override) in cases.items():
        with torch.inference_mode():
            reference = actor(torch.from_numpy(prop), torch.from_numpy(mapping),
                              None if override is None else torch.from_numpy(override))
        actual = numpy_forward(weights, prop, mapping, override)
        ref = [a.numpy() for a in reference]
        for a in (*ref, *actual):
            assert np.isfinite(a).all(), f"{name}: non-finite inference"
        np.testing.assert_array_equal(ref[1], actual[1], err_msg=f"{name}: crop mismatch")
        np.testing.assert_allclose(ref[0], actual[0], atol=ATOL, rtol=0, err_msg=name)
        assert ref[0].shape == (len(prop), 12) and actual[0].dtype == np.float32
        results[name] = {"n": len(prop), "max_abs": float(np.abs(ref[0] - actual[0]).max()),
                         "gaze_logits_max_abs": float(np.abs(ref[2] - actual[2]).max()),
                         "prop": prop.tolist(), "mapping": mapping.tolist(),
                         "forced_centers": None if override is None else override.tolist(),
                         "torch_outputs": ref[0].tolist(), "numpy_outputs": actual[0].tolist(),
                         "crop_offsets": actual[1].tolist()}
    return {"pass": True, "atol": ATOL, "rtol": 0, "seed": SEED,
            "rng": "NumPy default_rng/PCG64", "boundary_mode": "forced centers, unchanged learned weights",
            "max_abs": max(r["max_abs"] for r in results.values()), "cases": results}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("checkpoint", type=Path)
    parser.add_argument("--source-root", type=Path, required=True, help="read/hash source TEXT only")
    parser.add_argument("--params", type=Path, required=True, help="directory containing agent.yaml/env.yaml")
    parser.add_argument("--out", type=Path, required=True, help="runs/ame2-export/out directory")
    parser.add_argument("--check", action="store_true", help="assert torch vs NumPy and saved-byte parity")
    args = parser.parse_args()
    if not sys.flags.isolated:
        parser.error("run with python -I")
    if torch.version.cuda is not None or "+cpu" not in torch.__version__:
        parser.error("CPU-only torch required")
    if not __debug__:
        parser.error("assertions must be enabled; do not use -O")
    if args.out.resolve().parts[-3:] != ("runs", "ame2-export", "out"):
        parser.error("output must end in runs/ame2-export/out")
    torch.set_num_threads(1)
    checkpoint, state = load_checkpoint(args.checkpoint)
    torch.manual_seed(SEED)
    actor = Actor().cpu().float().eval()
    incompatible = actor.load_state_dict(state, strict=True)
    assert not incompatible.missing_keys and not incompatible.unexpected_keys
    data, table = encode(state)
    weights = decode(data, table)
    for name, value in state.items():
        np.testing.assert_array_equal(value.numpy(), weights[name])
    source_hashes = {name: sha((args.source_root / name).read_bytes()) for name in SOURCE_FILES}
    param_hashes = {name: sha((args.params / name).read_bytes()) for name in ("agent.yaml", "env.yaml")}
    report = check(actor, weights) if args.check else None
    manifest = {"schema": "ame2-f32-v1", "checkpoint_sha256": sha(args.checkpoint.read_bytes()),
                "checkpoint_bytes": args.checkpoint.stat().st_size, "iteration": checkpoint.get("iter"),
                "converter_sha256": sha(Path(__file__).read_bytes()),
                "source_text_sha256": source_hashes, "params_sha256": param_hashes,
                "tools": {"python": platform.python_version(), "torch": torch.__version__,
                          "numpy": np.__version__, "cuda": torch.version.cuda},
                "checkpoint_finite_tensor_count": finite_tree(checkpoint), "all_values_finite": True,
                "strict_missing_keys": [], "strict_unexpected_keys": [],
                "file": "ame2_actor.f32", "sha256": sha(data), "bytes": len(data),
                "layout": "C row-major float32 little-endian; offsets and lengths in bytes",
                "tensors": table, "contract": input_contract(),
                "check": None if report is None else {k: v for k, v in report.items() if k != "cases"}}
    args.out.mkdir(parents=True, exist_ok=True)
    payloads = {"ame2_actor.f32": data,
                "ame2_actor.json": (json.dumps(manifest, indent=2, ensure_ascii=False, allow_nan=False) + "\n").encode()}
    if report:
        payloads["check.json"] = (json.dumps(report, ensure_ascii=False, allow_nan=False) + "\n").encode()
    # Never replace an existing export; preflight every path before creating any file.
    for name in payloads:
        if (args.out / name).exists():
            raise FileExistsError(f"existing export: {name}; select another runs/ame2-export/out directory")
    for name, payload in payloads.items():
        with (args.out / name).open("xb") as stream:
            stream.write(payload)
    saved = decode((args.out / "ame2_actor.f32").read_bytes(), table)
    for name in weights:
        np.testing.assert_array_equal(weights[name], saved[name])
    assert (args.out / "ame2_actor.f32").read_bytes() == data
    print(json.dumps({"actor_tensors": len(table), "float_count": len(data) // 4,
                      "bytes": len(data), "sha256": sha(data),
                      "check": None if report is None else {name: {"n": r["n"], "max_abs": r["max_abs"]}
                                                             for name, r in report["cases"].items()}}, indent=2))


if __name__ == "__main__":
    main()
