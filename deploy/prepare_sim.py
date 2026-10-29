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
        raise ValueError("Simulator policy SHA-256 differs from provenance")


def package(source, private, dist):
    target = dist / "sim"
    # Never retain an unverified simulator produced by npm or an older build.
    if target.is_symlink() or target.exists():
        if target.is_symlink() or not target.is_dir():
            raise ValueError("Invalid simulator output directory")
        shutil.rmtree(target)
    policy = private / "policy_v2.f32"
    if not policy.exists() and not policy.is_symlink():
        print("WARNING: foothold-v2 policy absent; preparing web only (no /sim/).", file=sys.stderr)
        return False
    if private.is_symlink() or not private.is_dir():
        raise ValueError("Invalid private simulator directory")
    if os.geteuid() == 0:
        for directory in (private, *private.parents):
            info = directory.lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
                raise ValueError("Private simulator ancestors must be root-owned and not writable by others")
    verify(policy, POLICY_SHA)
    files = [(policy, Path("policy_v2.f32"))]
    # Same external runtime allowlist as mobile/scripts/sync-web.mjs.
    runtime = ["vendor/three.module.js", "vendor/three.core.js", "vendor/LICENSE",
               "mujoco/mujoco.js", "mujoco/mujoco.wasm", "mujoco/package.json",
               "assets/unitree_go2/go2.xml", "assets/unitree_go2/LICENSE"]
    for name in runtime:
        files.append((regular(private / name), Path(name)))
    manifest = json.loads((private / "mujoco/package.json").read_text())
    if manifest.get("name") != "@mujoco/mujoco" or manifest.get("version") != MUJOCO_VERSION:
        raise ValueError("MuJoCo must retain the existing pinned version")
    xml = (private / "assets/unitree_go2/go2.xml").read_text()
    for mesh in re.findall(r'<mesh file="([\w.]+)"', xml):
        if mesh in (".", ".."):
            raise ValueError("Invalid Go2 mesh name")
        name = Path("assets/unitree_go2/assets") / mesh
        files.append((regular(private / name), name))
    if all((private / name).exists() for name in AME2_SHA):
        for name, digest in AME2_SHA.items():
            verify(private / name, digest)
            files.append((private / name, Path(name)))
    else:
        print("WARNING: AME-2 assets absent/incomplete; its existing selector stays disabled.", file=sys.stderr)
    # Validate every archived map, top-view and script before copying any bytes.
    for path in source.rglob("*"):
        if path.is_symlink() or not path.is_dir():
            regular(path)
    regular(source / "index.html")
    shutil.copytree(source, target)
    for origin, relative in files:
        destination = target / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(origin, destination)
        destination.chmod(0o644)
    print("Prepared /sim/index.html?from=web (existing MuJoCo runtime and verified policies).")
    return True


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit("Usage: prepare_sim.py <archived-mobile-sim> <private-assets> <dist>")
    package(*(Path(arg) for arg in sys.argv[1:]))
