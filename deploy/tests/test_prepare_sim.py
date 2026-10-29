"""Release content, missing optional inputs and link/hash boundaries."""
import hashlib
import json
import mimetypes
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


def test_hash_and_mujoco_version_mismatch_rejected(bundle):
    source, private, dist = bundle
    manifest = private / "mujoco/package.json"
    manifest.write_text('{"name":"@mujoco/mujoco","version":"999"}')
    with pytest.raises(ValueError, match="pinned version"):
        prepare_sim.package(*bundle)
    (private / "policy_v2.f32").write_bytes(b"changed")
    with pytest.raises(ValueError, match="SHA-256"):
        prepare_sim.package(*bundle)


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


def test_archived_map_link_rejected(bundle):
    source, private, dist = bundle
    (source / "linked-map").symlink_to(private, target_is_directory=True)
    with pytest.raises(ValueError, match="regular file"):
        prepare_sim.package(*bundle)
