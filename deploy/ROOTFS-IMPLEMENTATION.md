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
(explicit SONAME-to-provider objects with `path` and `sha256`, normally empty). Name/UID/GID
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

Literal systemd unit-name escapes such as `system-systemd\x2dcryptsetup.slice`
are valid POSIX filenames ([systemd unit-name escaping](https://www.freedesktop.org/software/systemd/man/257/systemd.unit.html#String%20Escaping%20for%20Inclusion%20in%20Unit%20Names)).
Only complete literal `\xHH` sequences are accepted in place of the former blanket
backslash refusal. They are preserved byte-for-byte, never decoded to a slash,
dot, NUL or other character. Actual absolute members, parent traversal, malformed
backslashes, control bytes and special nodes still refuse. Scan failures identify
the package/archive basename, original member and original link target with
escaped diagnostics. Provenance stays out of payload/manifest fields and follows
canonicalization through graph, collision, escape and reserved-namespace checks.
The private failure JSON retains those fields and the CLI prints the context.

Both archive passes use the same lexical link-target normalization before
comparing metadata. For example, gzip 1.12-1ubuntu3.2 stores hardlink member
`./usr/bin/uncompress` with target `./usr/bin/gunzip`; inspection records
`usr/bin/gunzip`. Comparing that normalized value to the raw second-pass target
incorrectly refused unchanged bytes. Changed normalized modes/targets/types/sizes and
changed file digests still refuse, with archive/member/original-target context.
Both passes apply the same mode policy: directories or executable members become
0555, other members become 0444; an execution-bit change that changes this
normalized mode refuses, while stripped write/SUID/SGID bits do not affect the
output mode. Invalid mode bits and capability metadata refuse in both passes.
Absolute hardlink targets and parent traversal remain invalid; absolute symbolic
links continue to describe the future root. Normalization never decodes escapes.

## Mandatory offline complete-build evidence

A scan/graph pass does not exercise the second extraction pass, wheel merge,
configuration generation or sealing. Before seeking another server build, run
the entire offline build with retained exact archives and the current recipe:

```sh
fakeroot -- python3 -B -m deploy.rootfs_preflight PRIVATE_RECIPE EXACT_SHA \
  --debs LOCAL_DEBS --wheels LOCAL_WHEELS \
  --work-parent PRIVATE_LOCAL_SCRATCH --report LOCAL_RESULT_JSON
```

Use an already available fakeroot; this check authorizes no installation. The
scratch parent must satisfy the production trusted-parent checks and have 6GiB
free. This is an initial check, not a disk reservation: monitor the shared disk
throughout and interrupt the check if free space falls below 2GiB. Kernel root
and an unwrapped user are refused. The checker revalidates the
recipe/generator hashes, every DEB identity and wheel hash, copies into a private
recipe-named tree and calls the production build, seal and verify functions.
It runs under the same non-increasing 2GiB address-space/3600s CPU limits.
The temporary tree is removed; JSON retains completion/manifest hashes and row
count. No payload, maintainer script, download, host audit, latch, unit or runtime
probe runs. fakeroot emulates ownership and permission metadata; file extraction,
generated bytes, hashes and build/seal logic are real. This proves offline
assembly only, never server ownership, namespace isolation or EGL/runtime health.

With the retained 1358-package closure, gz-gui ships two different plugin files
with SONAME `libGridConfig.so`: `libGrid3D.so` and `libGridConfig.so`. Keep the
ambiguity refusal. The proposed recipe explicitly selects the matching provider:

```json
{"library_aliases":{"libGridConfig.so":{
  "path":"/opt/ros/jazzy/opt/gz_gui_vendor/lib/gz-gui-8/plugins/libGridConfig.so",
  "sha256":"e286fc02e5bef4b832980c3d724283dcb4dc9c79b580fb9f373d2b6b48f29b5b"
}}}
```

The selected file matches the SONAME filename and exports the
`gz::gui::GridConfig` plugin registration; this is an explicit canonical-provider
choice, not a claim that both candidates have equal bytes. Each alias binds its
literal canonical regular provider path and SHA256; a missing/different provider
or changed bytes refuse before publishing that alias. This also applies when an
ordinary search directory already contains that SONAME. Path-only aliases refuse.
This is one config field, not a complete recipe. Review it with the newly hashed
recipe; do not change the failed recipe or select a provider automatically.
All package/wheel pins stay unchanged. A different ambiguity must stop and show
the SONAME/candidate paths; do not apply a general first-provider fallback.

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

## Explicit recovery of a failed installation latch

There is no automatic failure unlock. After review and separate execution
confirmation, recover-latch can release one explicitly approved retained latch:

```sh
python3 -B -m deploy.rootfs_build recover-latch <old-private-recipe> <old-recipe-sha> \
  --failed-operation build --latch-device <approved-device> \
  --latch-inode <approved-inode> --audit-sha256 <approved-host-audit-sha>
```

The command requires root, the existing nonblocking exclusive deployment lock,
no activated guard, an unsealed recipe and matching private recipe/failure files.
It checks the literal root-owned 0600 latch content and exact device/inode both
before observing the host and before release. The saved before/after audits must
equal the explicitly supplied audit digest, and a fresh full dpkg/status/query,
/usr content/mode/owner and GPU/DCGM/API/Caddy/PostgreSQL audit must match them.
A root-only recovery observation is flushed to the failed recipe's evidence
directory before the identity-checked release. A changed audit, inode, missing
evidence, busy lock, active guard or write failure keeps admission blocked.
Completed/partly sealed recipes refuse before any audit/evidence write.

All root-owned install/setup latch name changes use the same exclusive parent
directory flock. Release first hard-links a release-pending barrier and syncs its
directory while the original name still blocks. It atomically captures the
original name into a unique retained receipt, validates the captured inode and
syncs again. A replacement is restored without overwriting any newer name and is
never unlinked as the old transaction. Any capture/sync failure keeps the barrier;
restoring the original name is best-effort and never overwrites another inode.
Deployment, manager transitions, session admission and host proof all refuse
either the original marker or its .release-pending companion, including when
only that companion remains.

Only after all durable evidence/capture syncs succeed is the companion unlinked
as the final namespace change. There is deliberately no later directory fsync
that could report failure after admission opens. A crash may resurrect the
companion and conservatively block again; it cannot make an unverified release
valid. Retired receipts are kept root-only. A failed/interrupted release with a
remaining companion needs a new explicit recovery review, never an automatic
retry, forced cleanup or manual receipt/companion removal.

Before changing a system install/setup marker, the helper verifies that installed
common.sh and sim_control.py (and proc_proof_server.py when present) match the
reviewed tool source. A private recovery tool copy alone is insufficient if
installed readers still use the old protocol. Deliver those exact fence tools
under separate execution approval before recovering; do not rerun bootstrap or
force deployment. The updated session reader must also accompany the paired
runtime release before activation.

The approval values come from unchanged root-private evidence, for example:

```sh
recipe_root="/opt/foothold-sim/rootfs/OLD_RECIPE_SHA"
sha256sum "$recipe_root/.archives/audit/build-before.json" \
  "$recipe_root/.archives/build-after.json"
stat -c '%d %i' /var/lib/foothold/sim-packages-unproven
```

Builder audit files contain canonical JSON, so the two raw SHA256 values must
match; obtain coordinator acceptance of that audit and the reported device/inode
before invoking recovery. For a download failure, use .stage/before.json and
download-after.json in .archives (or the recipe root when no archive directory
was created). Do not reformat or rewrite evidence. New failure JSON also records
latch_device/latch_inode and recovery checks that binding; older failures still
require explicit approved values. Recovery ValueError refusals print their safe
specific reason, such as stored recipe, audit, inode or fence-version mismatch.

Recovery preserves all failed archives/staging/evidence and never downloads,
extracts, resumes a build, activates a unit or changes the deployment timer.
Historical generator digests are accepted only to identify this old failed
recipe; download/build continue to require the exact current generator hashes.
New recipes also pin install_sim_packages.py, including its release protocol;
the older recipe shape remains accepted only for historical recovery identity.
The fix therefore needs a new reviewed recipe SHA and separate execution
confirmation; the failed path is not an automatic retry target.

A retained latch also blocks automatic delivery of the recovery fix. Separately
approve staging the exact reviewed tool source privately and invoking this
command from it; never clear the latch or force deployment to obtain the tool.
After a successful explicit recovery the unchanged timer may deploy pending dev
commits, so coordinate that window. If recovery refuses, retain its observation
and escalate; do not remove the latch, failed recipe or lock file by hand.

## Generated state instead of postinst

rootfs_config.py generates only passwd/group UID entries, nsswitch/loopback
hosts/hostname, isolated machine-id, no-external-DNS resolver, standard loader
configuration, deterministic CA bundle, control Python path, user dbus socket
dependency, explicit sh/Python3.12/Ruby3.2/gawk alternatives, manager/slice files
and bind placeholders. No host passwd,
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

Preparation starts a deliberate web auto-deployment pause: from creation of
guard/setup-unproven until successful probe and activate clear that exact marker,
common.sh's take_sim_deploy_guard refuses new deployments. The two-minute timer
keeps running and skips candidates; the existing deployed API/web keeps serving.
There is no fixed timeout or automatic marker expiry. Review/approval waits and
any probe/activation failure extend the pause until audited recovery succeeds.
Have the sealed assets, private settings/catalogue, validation window and stage-3
confirmation process ready before prepare. After prepare, report its UID/marker
and audit promptly, obtain stage-3 confirmation, then probe/activate in that
window. Do not disable the timer, rerun bootstrap or clear the marker merely to
resume web updates; on failure preserve evidence and escalate for literal recovery.

The instance-only user@<uid>.service.d/foothold-rootfs.conf uses RootDirectory,
MountAPIVFS, PrivateUsers/Devices/Tmp, ProtectSystem=strict, NoNewPrivileges and
empty capabilities. PID1 sets up the namespace. Bindings contain only four
read-only app directories and COMMIT (never .venv), sealed source/two mesh
files, independent simulation config, the fixed proof socket, dedicated
runtime/bus and declared guard/replay/episode/startup/native-output writes.
Only the fixed journal stdout/datagram sockets are additionally mounted for
user-manager/dbus logging; global journal files and the system bus are absent.
Notify and host os-release mount placeholders are pre-created for PID1 so its
automatic mounts cannot add underlying paths after the actual manifest seal.
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
