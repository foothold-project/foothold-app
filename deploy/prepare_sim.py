"""Package the existing offline simulator; never download or execute private assets."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys


# Public provenance records identify the approved exports, not local filenames.
POLICY_SHA = "da199be22d3bea64601d5237a0438ff447c85a49ce64d35bb6f486b5f0adc68c"
AME2_SHA = {
    "ame2_actor.f32": "28edbc05169b817044c600d90cc081bb797ae56c5b8400b8ffebf648410d26a0",
    "ame2_actor.json": "92ddf3db0b36582b72d9e136e2749a2edf21dbc4156875ecf603c36dc3711fe7",
}
MUJOCO_VERSION = "3.17.0"


class SimulatorUnavailable(ValueError):
    """Optional simulator content is missing or differs from the approved export."""


def regular(path):
    """Reject linked parents as well as linked leaves and special files."""
    for parent in reversed(path.parents):
        if parent.is_symlink():
            raise ValueError("Simulator input contains a linked parent")
    if not stat.S_ISREG(path.lstat().st_mode):
        raise ValueError("Simulator input is not a regular file")
    return path


def verify(path, expected):
    if hashlib.sha256(regular(path).read_bytes()).hexdigest() != expected:
        raise SimulatorUnavailable("Simulator policy SHA-256 differs from provenance")


def validate_tree(root, private=False):
    """Check security boundaries before any content error can trigger fallback."""
    for directory in (*reversed(root.parents), root):
        if directory.is_symlink():
            raise ValueError("Simulator input contains a linked parent")
        try:
            info = directory.lstat()
        except FileNotFoundError:
            continue
        if not stat.S_ISDIR(info.st_mode):
            raise ValueError("Invalid simulator input directory")
        if private and os.geteuid() == 0 and (info.st_uid != 0 or info.st_mode & 0o022):
            raise ValueError("Private simulator ancestors must be root-owned and not writable by others")
    for path in root.rglob("*"):
        info = path.lstat()
        if stat.S_ISDIR(info.st_mode):
            if private and os.geteuid() == 0 and (info.st_uid != 0 or info.st_mode & 0o022):
                raise ValueError("Private simulator directories must be root-owned and not writable by others")
        else:
            regular(path)


def package(source, private, dist):
    target = dist / "sim"
    # Never retain an unverified simulator produced by npm or an older build.
    if target.is_symlink() or target.exists():
        if target.is_symlink() or not target.is_dir():
            raise ValueError("Invalid simulator output directory")
        shutil.rmtree(target)
    validate_tree(source)
    validate_tree(private, private=True)
    try:
        return copy_simulator(source, private, target)
    except (SimulatorUnavailable, FileNotFoundError, json.JSONDecodeError):
        # A failed copy must not leave a partial simulator in an otherwise valid web release.
        if target.exists():
            shutil.rmtree(target)
        print("WARNING: simulator assets missing or invalid; preparing web only (no /sim/).", file=sys.stderr)
        return False


def copy_simulator(source, private, target):
    policy = private / "policy_v2.f32"
    verify(policy, POLICY_SHA)
    files = [(policy, Path("policy_v2.f32"))]
    # Same external runtime allowlist as mobile/scripts/sync-web.mjs.
    runtime = ["vendor/three.module.js", "vendor/three.core.js", "vendor/LICENSE",
               "mujoco/mujoco.js", "mujoco/mujoco.wasm", "mujoco/package.json",
               "assets/unitree_go2/go2.xml", "assets/unitree_go2/LICENSE"]
    for name in runtime:
        files.append((regular(private / name), Path(name)))
    manifest = json.loads((private / "mujoco/package.json").read_text())
    if not isinstance(manifest, dict) or manifest.get("name") != "@mujoco/mujoco" or manifest.get("version") != MUJOCO_VERSION:
        raise SimulatorUnavailable("MuJoCo must retain the existing pinned version")
    xml = (private / "assets/unitree_go2/go2.xml").read_text()
    for mesh in re.findall(r'<mesh file="([^"]+)"', xml):
        if not re.fullmatch(r"[\w.]+", mesh) or mesh in (".", ".."):
            raise ValueError("Invalid Go2 mesh name")
        name = Path("assets/unitree_go2/assets") / mesh
        files.append((regular(private / name), name))
    ame2_present = all((private / name).exists() for name in AME2_SHA)
    if ame2_present:
        for name, digest in AME2_SHA.items():
            verify(private / name, digest)
            files.append((private / name, Path(name)))
    regular(source / "index.html")
    shutil.copytree(source, target)
    for origin, relative in files:
        destination = target / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(origin, destination)
        destination.chmod(0o644)
    if not ame2_present:
        print("WARNING: AME-2 assets absent/incomplete; its existing selector stays disabled.", file=sys.stderr)
    print("Prepared /sim/index.html?from=web (existing MuJoCo runtime and verified policies).")
    return True


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit("Usage: prepare_sim.py <archived-mobile-sim> <private-assets> <dist>")
    package(*(Path(arg) for arg in sys.argv[1:]))
