# Development-server simulation deployment fence

The API and simulation manager use the same release. A dev merge remains eligible
for automatic deployment within the timer interval when there is no simulation
session and no unproven cleanup. The manager acquires a shared flock and durable
`state/unproven` latch before creating a world. Only the existing full cleanup
proof removes the latch. A crash or unproven cleanup blocks deployment and next
start pending manual evidence audit. Never remove the latch to pass a test.
A proven pre-creation world/resource rejection clears its lease; it created no
session. An idle manager holds no session lease and does not block deployment.

Automatic/manual deploy and rollback hold the exclusive flock from candidate
admission through build, activation, manager readiness, API smoke and recovery.
This blocks concurrent session creation, including during manager restart.
After preparing the candidate they stop the idle manager, prove its unit/PID/
cgroup exit, switch the release and start a new manager using the same `current`
path as the API. They verify native-single readiness and the new manager's real
working directory. A failed transition stops the candidate manager and restores
the prior API/manager pair under the same fence; failed SHA recording retains the
existing autodeploy rules. A busy session/latch is a skip, never a failed SHA.
There is no human SHA-pin step and no simulator session is automatically started.

Before provisioning simulation, install reviewed `common.sh`, `autodeploy.sh`,
`deploy.sh`, `rollback.sh`, `prepare-release.sh`, and `sim_control.py` into existing
root-owned deploy-tools while holding the existing deployment lock. Atomically
replace files, common.sh first; merging a PR does not update installed tools.
Keep the automatic deployment timer enabled. Provision
`/var/lib/foothold-sim/guard` root-owned 0755, `deploy.lock` root:foothold-sim 0660,
and `state` foothold-sim:foothold-sim 0700. Never replace the lock inode in use.
Install `foothold-simmgr.service` into the dedicated user's manager. Its fixed
`FH_SIM_DEPLOY_GUARD_DIR` overrides private env, and `Restart=no` prevents retries.
The private `/etc/foothold-sim/manager.env` and catalogue are root:foothold-sim 0640;
its referenced service credential is an independent foothold-sim-owned 0600 file.

The release includes apps/simmgr and apps/agent with tools/sim and tools/nav2.
External source, model/policy, private maps and credentials are not archived.
Offline checks cover actual temporary flock contention, lifecycle failure
latches, bundle isolation and mocked manager transitions. Live installation,
EGL, Gazebo/ROS, HTTPS, driving and live rollback are separate acceptance steps.

## Dedicated installation (server root, separate approval from Git merge)

1. Record package and service baseline privately. Add the official ROS Noble
   source and verified signing key, update apt lists only, and resolve a full
   private JSON closure: `[{"name":"package","version":"exact-deb-version",
   "sha256":"64-hex"}]`. Keep it root:0600 outside Git. Each SHA must come from
   signature-verified apt metadata. `sim-package-versions.json` fixes upstream
   versions; only distro security suffixes and ROS build timestamps may differ.
   Never choose newer upstream or omit an unavailable dependency from the lock.
2. Run `python3 deploy/install_sim_packages.py --check PRIVATE_LOCK` first.
   It refuses any removal/purge, existing package change or unlocked dependency.
   New GL/Mesa/GLVND user-space libraries are allowed at locked version/SHA;
   new NVIDIA/kernel/DKMS/firmware/CUDA/DCGM/rpcbind packages are forbidden. With an accepted simulation, `--install` uses
   `--no-upgrade --no-install-recommends`, verifies downloaded SHA and all five
   embedded Gazebo ABI versions, then repeats simulation before installation.
   GPU driver/device identity, DCGM PID719/start ticks, API/Caddy/PostgreSQL
   unit state/PID/start timestamps must remain equal before/after.
   Archives and the lock remain private for rollback/evidence. Missing version,
   metadata, archive or ABI is a stop/escalation, never a latest fallback.
3. Prepare root-owned offline wheel caches and hash-locked requirements for the
   release's exact server requirements. For native `/usr/bin/python3`, vendor
   only `trimesh==5.1.0` using `pip --no-deps --no-index --require-hashes --target
   /opt/foothold-sim/python-vendor` from its private wheel cache/lock; NumPy and
   geometry/image dependencies use the pinned OS packages. Chown the vendor
   tree root:root and remove group/other writes. Only the isolated native child
   enables this path; the manager does not import it. No Torch/ONNX/Isaac/CUDA
   inference packages or agent hardware extras are needed.
4. Install reviewed deploy-tools atomically under the deploy lock (common.sh
   first), then run `bootstrap-sim.sh --prepare`. This prepares only the nologin
   account, existing render/video groups, linger bus and root-owned user units;
   it does not activate the guard or manager. Existing groups beyond the three
   allowlisted groups require an audit. API service sandbox remains unchanged.
5. Copy sealed external assets without editing originals, preserve required
   source/mesh layout, and grant the simulation UID read-only access. Give only
   native output parents, replay and release episode/startup evidence leaves
   private write access. Verify EGL on the dedicated UID using the existing
   NVIDIA driver. Provision the catalogue/env from the examples privately;
   replace placeholder UUIDs and paths with actual registered warehouse binding.
   Catalogue/env are root:foothold-sim 0640; credentials/pass keys are separate
   UID-owned 0600 copies. Register warehouse with the existing sim_maps import.
6. Install/review the OS proof helper and exact HTTPS proxy separately. Then
   `bootstrap-sim.sh --activate` publishes the guard with its exclusive flock
   already held and starts the same-release idle manager. A failed activation
   leaves a durable latch. Do not enable the user service at boot or auto-retry
   failed simulation sessions. Subsequent idle dev deployment updates API and
   manager together. First warehouse/ROS93 and HTTPS tests require their own
   recorded acceptance; preparation/manager readiness is not a simulation pass.

Rollback preserves lock/latch/evidence and database. Stop starts, prove normal
STOP/zero and all native absence, then use the paired release rollback. Disable
only the new manager/linger after full absence proof. Compare the private package
baseline before selectively removing newly installed simulation packages; never
use autoremove or remove/update existing graphics/DCGM/rpcbind services.

### Failure-latch audit (manual, never automatic reset)

There are two independent latches: runtime `guard/state/unproven`, and root-only
`guard/setup-unproven` for failed initial activation. Root never opens a leaf in
the runtime-owned state directory to record failure. The root activation latch
uses a validated root-owned directory fd with exclusive/no-follow creation.
Deployment, package setup and manager transitions reject either latch.

To consider recovery, first block new starts and take the deploy and exclusive
simulation locks. Preserve the old latch and episode/manifests/log/package state
in private evidence. Check fresh helper proof, exact unit/PID/start/cgroup/
partition identity, domain93/DDS absence and the existing STOP/zero/child exit/
manifest/source-ledger proofs for every possible episode. A missing process or
manager row alone is insufficient. Record the failure cause and evidence, ask
the coordinator to accept the audit, and only then remove the audited latch
entry and explicitly authorize one retry. If anything is unknown, retain both
slot and deployment fence; do not kill by a name pattern or restart a session.
An activation failure under the exclusive pre-creation guard still needs fresh
unit/process/DDS absence and a recorded setup audit before clearing its latch.

The user-manager slice is a secondary budget. Root installs the same limits in
system `user-<dedicated-uid>.slice.d/foothold-sim.conf` and applies them to that
parent slice. Thus changing a user unit/slice cannot raise the server's ceiling;
the parent also contains the dedicated user's bus and all descendant cgroups.

### Package transaction and existing graphics ownership

Before any apt installation, install the reviewed deploy-tools (including the
new common.sh fence) under the deployment lock. The package command verifies
those exact tool bytes. Existing NVIDIA EGL/GLX and any present GLVND libraries
must resolve to dpkg-owned real files; unknown ownership or an NVIDIA .run
installer indicator is a stop/escalation. New libraries must not silently replace
an untracked host installation. Do not proceed on that server by ignoring dpkg
ownership or forcing package dependencies.

Immediately before the actual apt install command, create root-only
`/var/lib/foothold/sim-packages-unproven` with directory-fd, O_EXCL and O_NOFOLLOW.
Any apt error, installed-version mismatch, host/GPU/service identity change,
ownership failure, evidence write error or interruption leaves this marker.
Only completion of all final proofs removes that same inode durably. The next
package command, deployment (even before a sim guard exists), bootstrap, manager
transition and session admission reject a remaining marker. This is the third
independent audit latch; preserve its private transaction evidence and use the
manual audit/authorization process above. Never clear it merely to retry apt.

New NVIDIA packages are forbidden regardless of where `nvidia` appears in the
name, as are glx-diversions and CUDA library families whose name lacks cuda
(cublas, nvrtc, npp, cufft, curand, cusolver, cusparse, nvjpeg). Existing package
changes, including same-version reinstalls, remain forbidden.
