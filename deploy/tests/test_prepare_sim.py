"""Release content, missing optional inputs and link/hash boundaries."""
import hashlib
import json
import mimetypes
import os
from pathlib import Path

import pytest

from deploy import prepare_sim


@pytest.fixture
def bundle(tmp_path, monkeypatch):
    source, private, dist = (tmp_path / name for name in ("source", "private", "dist"))
    for path in (source, private, dist):
        path.mkdir()
    (source / "index.html").write_text("<html>sim</html>")
    (source / "maps.json").write_text("[]")
    for name, content in {
        "policy_v2.f32": b"test policy",
        "vendor/three.module.js": b"three", "vendor/three.core.js": b"core",
        "vendor/LICENSE": b"license", "mujoco/mujoco.js": b"js",
        "mujoco/mujoco.wasm": b"\x00asm",
        "mujoco/package.json": json.dumps({"name": "@mujoco/mujoco", "version": "3.17.0"}).encode(),
        "assets/unitree_go2/go2.xml": b'<mujoco><mesh file="body.obj"/></mujoco>',
        "assets/unitree_go2/LICENSE": b"license",
        "assets/unitree_go2/assets/body.obj": b"mesh",
    }.items():
        path = private / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
    monkeypatch.setattr(prepare_sim, "POLICY_SHA", hashlib.sha256(b"test policy").hexdigest())
    return source, private, dist


def test_release_contains_sim_runtime_policy_and_wasm_mime(bundle):
    source, private, dist = bundle
    assert prepare_sim.package(*bundle)
    assert all((dist / "sim" / name).is_file() for name in (
        "index.html", "mujoco/mujoco.wasm", "policy_v2.f32", "maps.json",
        "assets/unitree_go2/assets/body.obj", "vendor/three.module.js")) and (
        mimetypes.guess_type(str(dist / "sim/mujoco/mujoco.wasm"))[0] == "application/wasm")
    assert not (dist / "sim/ame2_actor.f32").exists()


def test_missing_policy_keeps_web_and_warns(bundle, capsys):
    source, private, dist = bundle
    (dist / "index.html").write_text("web")
    (private / "policy_v2.f32").unlink()
    assert not prepare_sim.package(*bundle)
    assert (dist / "index.html").read_text() == "web"
    assert not (dist / "sim").exists()
    assert "web only" in capsys.readouterr().err


@pytest.mark.parametrize("name", ["policy_v2.f32", "vendor/three.module.js"])
def test_linked_private_input_rejected(bundle, name):
    source, private, dist = bundle
    path = private / name
    path.unlink()
    path.symlink_to(source / "index.html")
    with pytest.raises(ValueError, match="regular file"):
        prepare_sim.package(*bundle)


@pytest.mark.parametrize("name,content", [
    ("mujoco/package.json", b'{"name":"@mujoco/mujoco","version":"999"}'),
    ("policy_v2.f32", b"changed"),
])
def test_hash_and_mujoco_version_mismatch_keep_web(bundle, capsys, name, content):
    source, private, dist = bundle
    (private / name).write_bytes(content)
    assert not prepare_sim.package(*bundle)
    assert not (dist / "sim").exists()
    assert capsys.readouterr().err.count("WARNING:") == 1


@pytest.mark.parametrize("name", ["ame2_actor.f32", "ame2_actor.json"])
def test_wrong_ame2_sha_omits_entire_simulator(bundle, monkeypatch, capsys, name):
    source, private, dist = bundle
    digest = hashlib.sha256(b"fixture actor").hexdigest()
    monkeypatch.setattr(prepare_sim, "AME2_SHA", {file: digest for file in prepare_sim.AME2_SHA})
    for file in prepare_sim.AME2_SHA:
        (private / file).write_bytes(b"fixture actor")
    (private / name).write_bytes(b"different incorrect content")
    assert not prepare_sim.package(*bundle)
    assert not (dist / "sim").exists()
    assert capsys.readouterr().err.count("WARNING:") == 1


def test_complete_ame2_pair_verified_and_incomplete_pair_omitted(bundle, monkeypatch):
    source, private, dist = bundle
    names = {"ame2_actor.f32": b"actor", "ame2_actor.json": b"{}"}
    monkeypatch.setattr(prepare_sim, "AME2_SHA", {n: hashlib.sha256(v).hexdigest() for n, v in names.items()})
    for name, value in names.items():
        (private / name).write_bytes(value)
    prepare_sim.package(*bundle)
    assert (dist / "sim/ame2_actor.f32").read_bytes() == b"actor"
    (private / "ame2_actor.json").unlink()
    prepare_sim.package(*bundle)
    assert not (dist / "sim/ame2_actor.f32").exists()


def test_onnx_hashes_match_provenance_and_browser_contract():
    root = Path(__file__).resolve().parents[2]
    adapters = (root / "mobile/sim/policy-adapters.js").read_text()
    for name, document in (("ame2-demo.onnx", "AME2-PROVENANCE.md"),
                           ("policy_v2.onnx", "POLICY-PROVENANCE.md")):
        digest = prepare_sim.ONNX_SHA[name]
        assert digest in (root / "docs" / document).read_text()
        assert digest in adapters
    start = (root / "mobile/sim/start-demo-adapter.js").read_text()
    for name in ("start-demo_map_on.onnx", "start-demo_map_off.onnx"):
        assert prepare_sim.ONNX_SHA[name] in start
        assert prepare_sim.ONNX_SHA[name] in (root / "docs/POLICY-PROVENANCE.md").read_text()
    lock = json.loads((root / "mobile/package-lock.json").read_text())
    assert lock["packages"]["node_modules/onnxruntime-web"]["version"] == "1.31.1"
    for digest in prepare_sim.ORT_SHA.values():
        assert digest in (root / "docs/POLICY-PROVENANCE.md").read_text()


@pytest.mark.parametrize("state", ["valid", "missing", "wrong-sha"])
def test_optional_onnx_preserves_f32_simulator(bundle, monkeypatch, capsys, state):
    source, private, dist = bundle
    models = {name: name.encode() for name in prepare_sim.ONNX_SHA}
    monkeypatch.setattr(prepare_sim, "ONNX_SHA", {
        name: hashlib.sha256(data).hexdigest() for name, data in models.items()
    })
    # An old build and archived unverified model cannot bypass private SHA checks.
    (dist / "sim").mkdir()
    (dist / "sim/policy_v2.onnx").write_bytes(b"stale")
    for name, data in models.items():
        (source / name).write_bytes(b"unverified archived model")
        if state != "missing":
            (private / name).write_bytes(data if state == "valid" else b"incorrect")
    (private / "ame2_actor_crop_test.onnx").write_bytes(b"never publish")
    assert prepare_sim.package(*bundle)
    assert (dist / "sim/policy_v2.f32").read_bytes() == b"test policy"
    assert (dist / "sim/mujoco/mujoco.wasm").is_file()
    for name, data in models.items():
        path = dist / "sim" / name
        if state == "valid":
            assert path.read_bytes() == data
            assert path.stat().st_mode & 0o777 == 0o644
        else:
            assert not path.exists()
    assert not (dist / "sim/ame2_actor_crop_test.onnx").exists()
    warning = capsys.readouterr().err
    assert ("policy_v2.onnx absent" in warning) == (state != "valid")


@pytest.mark.parametrize("state", ["valid", "missing", "wrong-sha", "copy-missing"])
def test_optional_ort_is_complete_or_omitted_and_preserves_f32(bundle, monkeypatch, capsys, state):
    source, private, dist = bundle
    (private / "ort").mkdir()
    (source / "ort").mkdir()
    (source / "ort/unverified.mjs").write_bytes(b"stale")
    contents = {name: name.encode() for name in prepare_sim.ORT_SHA}
    monkeypatch.setattr(prepare_sim, "ORT_SHA", {
        name: hashlib.sha256(data).hexdigest() for name, data in contents.items()
    })
    for name, data in contents.items():
        (private / "ort" / name).write_bytes(data)
    wasm = private / "ort/ort-wasm-simd-threaded.wasm"
    if state == "missing":
        wasm.unlink()
    elif state == "wrong-sha":
        wasm.write_bytes(b"wrong")
    elif state == "copy-missing":
        original_copy = prepare_sim.shutil.copyfile

        def interrupted_copy(origin, destination, **kwargs):
            if Path(origin) == wasm:
                raise FileNotFoundError("runtime disappeared")
            return original_copy(origin, destination, **kwargs)

        monkeypatch.setattr(prepare_sim.shutil, "copyfile", interrupted_copy)
    assert prepare_sim.package(*bundle)
    assert (dist / "sim/policy_v2.f32").read_bytes() == b"test policy"
    if state == "valid":
        assert {p.name for p in (dist / "sim/ort").iterdir()} == set(contents)
        for name, data in contents.items():
            assert (dist / "sim/ort" / name).read_bytes() == data
            assert (dist / "sim/ort" / name).stat().st_mode & 0o777 == 0o644
    else:
        assert not (dist / "sim/ort").exists()
    assert ("ONNX runtime absent" in capsys.readouterr().err) == (state != "valid")


def test_linked_ort_still_aborts(bundle):
    source, private, dist = bundle
    (private / "ort").mkdir()
    (private / "ort/ort.wasm.min.mjs").symlink_to(source / "index.html")
    with pytest.raises(ValueError, match="regular file"):
        prepare_sim.package(*bundle)


@pytest.mark.parametrize("name", list(prepare_sim.ONNX_SHA))
def test_linked_onnx_still_aborts(bundle, name):
    source, private, dist = bundle
    (private / name).symlink_to(source / "index.html")
    with pytest.raises(ValueError, match="regular file"):
        prepare_sim.package(*bundle)


def test_archived_map_link_rejected(bundle):
    source, private, dist = bundle
    (source / "linked-map").symlink_to(private, target_is_directory=True)
    with pytest.raises(ValueError, match="regular file"):
        prepare_sim.package(*bundle)


@pytest.mark.parametrize("violation", ["fifo", "linked-parent", "mesh-traversal", "output-link", "ownership"])
def test_security_violations_still_abort(bundle, monkeypatch, violation):
    source, private, dist = bundle
    if violation == "fifo":
        path = private / "mujoco/mujoco.wasm"
        path.unlink()
        os.mkfifo(path)
    elif violation == "linked-parent":
        (private / "vendor").rename(private / "actual-vendor")
        (private / "vendor").symlink_to(private / "actual-vendor", target_is_directory=True)
    elif violation == "mesh-traversal":
        (private / "assets/unitree_go2/go2.xml").write_text('<mesh file="../outside.obj"/>')
    elif violation == "output-link":
        (dist / "sim").symlink_to(source, target_is_directory=True)
    else:
        monkeypatch.setattr(prepare_sim.os, "geteuid", lambda: 0)
    with pytest.raises(ValueError):
        prepare_sim.package(*bundle)


@pytest.mark.parametrize("violation", ["fifo", "mesh-traversal"])
def test_content_error_cannot_mask_security_violation(bundle, violation):
    source, private, dist = bundle
    (private / "policy_v2.f32").write_bytes(b"wrong SHA")
    if violation == "fifo":
        os.mkfifo(private / "unexpected-fifo")
    else:
        (private / "assets/unitree_go2/go2.xml").write_text('<mesh file="../outside.obj"/>')
    with pytest.raises(ValueError) as error:
        prepare_sim.package(*bundle)
    assert not isinstance(error.value, prepare_sim.SimulatorUnavailable)


def test_missing_asset_during_copy_removes_partial_simulator(bundle, monkeypatch, capsys):
    source, private, dist = bundle
    original_copy = prepare_sim.shutil.copyfile

    def interrupted_copy(origin, destination, **kwargs):
        if Path(origin).name == "mujoco.wasm":
            raise FileNotFoundError("asset disappeared")
        return original_copy(origin, destination, **kwargs)

    monkeypatch.setattr(prepare_sim.shutil, "copyfile", interrupted_copy)
    assert not prepare_sim.package(*bundle)
    assert not (dist / "sim").exists()
    assert capsys.readouterr().err.count("WARNING:") == 1
