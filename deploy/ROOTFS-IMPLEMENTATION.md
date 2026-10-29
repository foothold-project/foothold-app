# Full rootfs implementation — review and execution gates

This code is for review. A merge does not authorize download, extraction,
account preparation, probe, socket activation or a session. Do not rerun
bootstrap-sim.sh, the legacy sysroot installer or host apt/dpkg installation.
The initial metadata-only plan stays runnable=false.

## Recipe and actual manifest

rootfs_build.py takes an approved root-owned 0600 JSON recipe and its exact
SHA256. The recipe has schema: 1, the complete apt_plan object returned by
the empty-status planner, an entire hash-pinned wheels list, explicit config
and generators returned by rootfs_build.generators(). validate_recipe()
returns the SHA to review before execution. No new solver is called.

Each wheel row has exactly name, version, filename, url, sha256, size.
Only exact HTTPS files.pythonhosted.org artifacts for Python 3.12/Linux amd64
are accepted; no source build, dependency auto-resolution or latest substitution.
All server requirements retain their pins and native trimesh stays 5.1.0.
Transitive wheel rows also need exact versions/hashes before this operation.
The later namespace probe rejects an incomplete/conflicting Python closure.

config has numeric uid/gid reserved for the new dedicated account, exactly
two mesh_targets (private original absolute file URIs), and library_aliases
(explicit SONAME-to-internal-library paths, normally empty). Name/UID/GID
collisions stop; no existing identity is adopted or modified.

All downloads, checks, retained archives and extraction scratch stay under
/opt/foothold-sim/rootfs/<recipe-sha>/. The path never changes. A pre-existing
recipe directory is not a download retry target. Retrying a failed recipe needs
an accepted audit and a separately approved literal removal/restart, never a
fallback version or an increased envelope.

The download operation re-verifies retained official InRelease signatures,
authenticated Package hashes, expiry and every selected package version/size/SHA.
Its only APT mutation verb is isolated download; host status/config/hooks are
not used. build rechecks archive identities and Gazebo ABI versions,
inspects the complete archive/link graph, then writes ordinary bytes
through no-follow directory fds. Absolute/usrmerge links mean the future root,
never the host. Links publish after byte writes; hardlinks become copies.
Special/capability nodes, cycles, escapes and differing file collisions refuse;
SUID/SGID/write bits are stripped. No package scripts, wheel installation hooks,
ldconfig, ldd or rootfs executable runs on the host.

Bounds: 20GiB initially free; DEBs <=2GiB, payload <=8GiB; wheel archives <=1GiB,
expanded wheels <=2GiB; inspector address space <=2GiB/CPU time <=3600s without
increasing any lower inherited limit. Metadata mismatch, missing exact archive,
unsupported wheel layout, ambiguity or exhaustion stops the operation.

After the final host audit, actual files/links/modes/owners (including retained
private archives) become MANIFEST.json, root:root 0400. COMPLETE.json (0400)
binds its digest, the recipe and a read-only public namespace identity.
Completion-control files are excluded from the payload manifest to avoid a hash
cycle; their mode/ownership/hash links are checked separately. No manifest,
digest mismatch or mutable/foreign-owned payload means incomplete. The path SHA
is the recipe SHA, not a claim that the actual manifest existed before extraction.

Every write starts with the existing root package latch under the deployment
lock. Before/after dpkg/status/query, /usr bytes/modes/owners and protected
GPU/DCGM/API/Caddy/PostgreSQL identities persist, including on refusal.
A failure keeps its latch/evidence and prevents automatic retry.

## Generated state instead of postinst

rootfs_config.py generates only passwd/group UID entries, nsswitch/loopback
hosts/hostname, isolated machine-id, no-external-DNS resolver, standard loader
configuration, deterministic CA bundle, control Python path, user dbus socket
dependency, manager/slice files and bind placeholders. No host passwd,
machine-id, CA bundle, loader cache or venv is copied. Gazebo/protobuf/Python/
loader/base libraries all come from the recipe.

The software child profile keeps /opt/ros/jazzy prefixes inside the root.
It generates Mesa-only vendor selection and unambiguous internal SONAME
aliases for skipped alternatives; ambiguity needs a new reviewed recipe.
Original ROS/Gazebo source and external runtime AST stay intact.

## Namespace lifecycle and deployment pairing

rootfs_runtime.py prepare --input <private-runtime-json> checks the full
actual rootfs and sealed assets. Input has schema/recipe and manifest SHA,
sealed asset source/container manifest SHA, plugin/policy relative paths.
The asset container has source/, meshes/0, meshes/1 and root-only MANIFEST.json;
bytes/modes/owners are rechecked, policy/plugin pins unchanged.
Paths and real assets never enter Git or PR text.

Preparation creates only the new nologin UID/GID, state leaves, guard,
root-only setup latch, namespace-aware deployment helpers and proof/slice
definitions. No linger, global user@ change, enable/start, Caddy change or sim
start. Both success and refusal save host audits. Independent manager/pass
credential files and a warehouse-only catalogue must be provisioned privately
before probe; API DB credentials are never bound.

The instance-only user@<uid>.service.d/foothold-rootfs.conf uses RootDirectory,
MountAPIVFS, PrivateUsers/Devices/Tmp, ProtectSystem=strict, NoNewPrivileges and
empty capabilities. PID1 sets up the namespace. Bindings contain only four
read-only app directories and COMMIT (never .venv), sealed source/two mesh
files, independent simulation config, the fixed proof socket, dedicated
runtime/bus and declared guard/replay/episode/startup/native-output writes.
The read-only source stage overlays the writable native-output parent.
No host /usr, /lib*, /bin, /opt/ros, GPU device, driver or system bus bind.
The API stays on the host. Child and aggregate 4GiB/CPU400%/Tasks640/swap0
limits and native TTL remain; no automatic native start/restart.

Fixed-field OS proof v2 binds recipe/actual-manifest digests and requires
the host package fence and software EGL/ABI seal, even when the host pathname
is hidden inside the root. Failure never falls back to partial namespace /proc.
Session admission repeats proof across shared guard acquisition.
Legacy PC callers retain v1. Only the verified software namespace skips the
host-GPU diagnostic; no nvidia-smi shim or GPU access is provided.

Idle stop proves manager exit, all four child unit families, native/93/DDS
absence, then stops only this user manager and proves PID/cgroup exit.
Idle start re-verifies payload/assets, creates a setup latch, binds current
release in a fresh namespace and attests /proc/<pid>/root, UID, COMMIT and each
app inode for user manager and manager. Failure retains the setup latch;
success clears its own inode after readiness. Existing exclusive deployment
and rollback guards cover the pair.

## Separate first-execution gate

After review/merge and explicit execution confirmation only:

1. python3 -B -m deploy.rootfs_build download <private-recipe> <recipe-sha>;
   report exact archives/bytes and host audit, then build with the same input.
   Never repair a failed recipe in place.
2. Prepare sealed assets/private config; explicitly run rootfs_runtime prepare.
   Record new UID, manifest and retained setup latch for review.
3. Obtain stage-3 confirmation before probe/session. probe runs one bounded
   unprivileged unit inside the same RootDirectory/bind plan, checking root
   inode, CPU llvmpipe EGL context, real clear/readback pixels, complete Python
   dependencies/imports and native plugin/policy ABI. No ROS node, Gazebo or
   robot command. Failure remains fenced, no automatic retry.
4. Its root-owned validation seal alone permits activate to start the dedicated
   user manager and same-release idle simmgr. No default-target enablement;
   bootstrap is not part of this path.
5. Apply only separately reviewed proxy/private API settings and warehouse map
   binding under explicit authority. HTTPS headless start, limited drive,
   STOP/deadman, image/map, end/restart and final unit/PID/cgroup/93/DDS absence
   remain acceptance. Factory, real hardware and domain61 remain outside scope.

No server download/extraction/RootDirectory/EGL/session result is implied by
these offline tests or this PR. A failed setup needs audited literal recovery,
never autoremove, bootstrap, restart or force-unlock.
