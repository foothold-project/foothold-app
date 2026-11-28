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
    # The checked-in policies stay out of these cases unless a test fills this folder.
    monkeypatch.setattr(prepare_sim, "REPO_POLICY", tmp_path / "repo-policy")
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
    for name in ("start-m15500_map_on.onnx", "start-m15500_map_off.onnx"):
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


REPO_NAMES = ("ame2-demo.onnx", "start-m15500_map_on.onnx", "start-m15500_map_off.onnx")


def fake_models(monkeypatch):
    models = {name: name.encode() for name in prepare_sim.ONNX_SHA}
    monkeypatch.setattr(prepare_sim, "ONNX_SHA", {
        name: hashlib.sha256(data).hexdigest() for name, data in models.items()})
    return models


def checked_in(folder, models, names=REPO_NAMES):
    """The repository folder: the three policies and their SHA256SUMS, no policy_v2."""
    folder.mkdir(exist_ok=True)
    for name in names:
        (folder / name).write_bytes(models[name])
    (folder / "SHA256SUMS").write_text("".join(
        f"{hashlib.sha256(models[name]).hexdigest()}  {name}\n" for name in names))
    return folder


def test_repo_policies_used_when_bundle_lacks_them(bundle, monkeypatch, capsys):
    source, private, dist = bundle
    models = fake_models(monkeypatch)
    checked_in(prepare_sim.REPO_POLICY, models)
    assert prepare_sim.package(*bundle)
    for name in REPO_NAMES:
        assert (dist / "sim" / name).read_bytes() == models[name]
        assert (dist / "sim" / name).stat().st_mode & 0o777 == 0o644
    # policy_v2 lives only in the bundle: just that policy is missing, with a notice.
    assert not (dist / "sim/policy_v2.onnx").exists()
    assert (dist / "sim/policy_v2.f32").read_bytes() == b"test policy"
    warning = capsys.readouterr().err
    assert "policy_v2.onnx absent" in warning and "start-m15500" not in warning and "ame2-demo" not in warning


def test_bundle_policy_used_before_repo(bundle, monkeypatch, capsys):
    source, private, dist = bundle
    models = fake_models(monkeypatch)
    checked_in(prepare_sim.REPO_POLICY, models)
    for name, data in models.items():
        (private / name).write_bytes(data)
    copied = []
    original_copy = prepare_sim.shutil.copyfile

    def recorded_copy(origin, destination, **kwargs):
        copied.append(Path(origin))
        return original_copy(origin, destination, **kwargs)

    monkeypatch.setattr(prepare_sim.shutil, "copyfile", recorded_copy)
    assert prepare_sim.package(*bundle)
    for name in models:
        assert (dist / "sim" / name).read_bytes() == models[name]
        assert private / name in copied and prepare_sim.REPO_POLICY / name not in copied
    warning = capsys.readouterr().err
    assert not any(name in warning for name in models)


def test_bundle_policy_with_wrong_sha_is_not_replaced_by_repo(bundle, monkeypatch, capsys):
    source, private, dist = bundle
    models = fake_models(monkeypatch)
    checked_in(prepare_sim.REPO_POLICY, models)
    (private / "ame2-demo.onnx").write_bytes(b"incorrect")
    assert prepare_sim.package(*bundle)
    assert not (dist / "sim/ame2-demo.onnx").exists()
    assert (dist / "sim/start-m15500_map_on.onnx").read_bytes() == models["start-m15500_map_on.onnx"]
    assert "ame2-demo.onnx absent or SHA-256 differs" in capsys.readouterr().err


@pytest.mark.parametrize("damage", ["file-changed", "sums-differs", "sums-missing", "not-listed"])
def test_repo_policy_rejected_unless_sums_and_pin_agree(bundle, monkeypatch, capsys, damage):
    source, private, dist = bundle
    models = fake_models(monkeypatch)
    folder = checked_in(prepare_sim.REPO_POLICY, models)
    target = folder / "ame2-demo.onnx"
    if damage == "file-changed":
        target.write_bytes(b"changed in the repository")
    elif damage == "sums-differs":
        # File and SHA256SUMS agree with each other but not with the provenance pin.
        target.write_bytes(b"other export")
        (folder / "SHA256SUMS").write_text((folder / "SHA256SUMS").read_text().replace(
            hashlib.sha256(models["ame2-demo.onnx"]).hexdigest(), hashlib.sha256(b"other export").hexdigest()))
    elif damage == "sums-missing":
        (folder / "SHA256SUMS").unlink()
    else:
        (folder / "SHA256SUMS").write_text("".join(
            line + "\n" for line in (folder / "SHA256SUMS").read_text().splitlines() if "ame2-demo" not in line))
    assert prepare_sim.package(*bundle)
    assert not (dist / "sim/ame2-demo.onnx").exists()
    assert ("start-m15500_map_on.onnx" in {p.name for p in (dist / "sim").iterdir()}) == (damage != "sums-missing")
    assert "ame2-demo.onnx absent or SHA-256 differs" in capsys.readouterr().err


def test_linked_repo_policy_aborts(bundle, monkeypatch):
    source, private, dist = bundle
    models = fake_models(monkeypatch)
    folder = checked_in(prepare_sim.REPO_POLICY, models)
    (folder / "ame2-demo.onnx").unlink()
    (folder / "ame2-demo.onnx").symlink_to(source / "index.html")
    with pytest.raises(ValueError, match="regular file"):
        prepare_sim.package(*bundle)


def test_repo_policies_alone_do_not_make_a_simulator(tmp_path, monkeypatch, capsys):
    """No bundle means no MuJoCo or onnxruntime: web only, /sim/ stays the guide page."""
    source, dist = tmp_path / "source", tmp_path / "dist"
    source.mkdir(), dist.mkdir()
    (source / "index.html").write_text("<html>sim</html>")
    monkeypatch.setattr(prepare_sim, "REPO_POLICY", prepare_sim.REPO_POLICY)  # the real checked-in folder
    assert not prepare_sim.package(source, tmp_path / "no-bundle", dist)
    assert not (dist / "sim").exists()
    assert "web only" in capsys.readouterr().err


def test_checked_in_policies_match_sums_and_pins():
    folder = Path(__file__).resolve().parents[2] / "assets/sim-policy"
    assert prepare_sim.REPO_POLICY == folder
    sums = dict(reversed(line.split()) for line in (folder / "SHA256SUMS").read_text().splitlines())
    assert set(sums) == set(REPO_NAMES)  # policy_v2 is not checked in
    for name in REPO_NAMES:
        assert sums[name] == prepare_sim.ONNX_SHA[name]
        assert hashlib.sha256((folder / name).read_bytes()).hexdigest() == sums[name]
    assert {p.name for p in folder.iterdir()} == {*REPO_NAMES, "SHA256SUMS", "README.md", ".gitattributes"}


def test_start_pins_are_the_robot_runner_pins():
    """Sim = robot: the browser start-demo serves the same m15500 exports the robot runner loads."""
    root = Path(__file__).resolve().parents[2]
    robot = (root / "apps/agent/foothold_agent/policy/start.py").read_text()
    runner = (root / "apps/agent/runner_cpp/src/ort_policy.cpp").read_text()
    for name in ("start-m15500_map_on.onnx", "start-m15500_map_off.onnx"):
        digest = prepare_sim.ONNX_SHA[name]
        assert f"'{name}': '{digest}'" in robot and f'"{digest}"' in runner
    assert not any("m13000" in name for name in prepare_sim.ONNX_SHA)


def test_policy_v2_is_stored_but_never_served():
    """Operating decision 2026-11-28: policy_v2 is only kept in the repository. prepare_sim,
    compose and the web never read assets/policy-v2; its SHAs are the provenance record's."""
    root = Path(__file__).resolve().parents[2]
    folder = root / "assets/policy-v2"
    record = (root / "docs/POLICY-PROVENANCE.md").read_text()
    sums = dict(reversed(line.split()) for line in (folder / "SHA256SUMS").read_text().splitlines())
    assert sums == {"policy_v2.onnx": prepare_sim.ONNX_SHA["policy_v2.onnx"], "policy_v2.f32": prepare_sim.POLICY_SHA}
    for name, digest in sums.items():
        assert digest in record
        assert hashlib.sha256((folder / name).read_bytes()).hexdigest() == digest
    assert not any((prepare_sim.REPO_POLICY / name).exists() for name in sums)
    for reader in ("compose.yaml", "deploy/prepare_sim.py", "docker/web-start.sh", "deploy/prepare-release.sh"):
        assert "policy-v2" not in (root / reader).read_text()
