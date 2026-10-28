# Development-server simulation and immutable private sysroot

API and manager code use the same release. Session creation acquires a shared
flock plus durable runtime latch; only existing full cleanup proof releases it.
Idle deployment takes the exclusive flock, stops the idle manager, switches the
API release, starts the same-release manager and checks readiness. Busy or
unproven sessions skip without poisoning the candidate SHA. A failed transition
restores the prior idle API/manager pair under that same fence. No session is
automatically started or retried. Existing STOP/zero/ownership proofs remain.

## Install boundary

**System apt installation is disabled.** The former
`install_sim_packages.py --install` command refuses before any action. Existing
untracked NVIDIA/GL files must not be replaced or adopted by dpkg. Simulation
packages use only the private sysroot workflow below. No dpkg registration,
maintainer scripts, system ldconfig, driver install, reboot, or payload writes to
/usr, /etc or /opt/ros are allowed. Separately reviewed identity/helper/unit
management remains a distinct operation; it is not package payload extraction.

The host's dpkg status is copied read-only into a private APT root. Existing
packages are reused at their actual configured version. If resolution requires
changing an existing version, stop. libc6/libc-bin/ld-linux, libstdc++6/libgcc-s1,
Python3.12, systemd and OpenSSL families cannot be extracted. NVIDIA/kernel/
DKMS/firmware/CUDA/DCGM/rpcbind and CUDA library families are also excluded;
linux-libc-dev headers alone may appear as private development data. New locked
Mesa/GLVND software-rendering dependencies are private files only.

## Prepare and approve the package lock

Run from the exact reviewed immutable release directory using system Python3.12
with `-B`; never source ROS in the manager or root shell. First atomically install
reviewed common.sh/autodeploy.sh/deploy.sh/rollback.sh/prepare-release.sh/
sim_control.py under the existing deployment lock (common.sh first). A dev merge
does not itself update the installed deploy-tools. The timer executes the fixed
installed copy, so new release code alone does not activate a deployment fence.
On an existing host, take the existing deploy.lock and, when provisioned, the
exclusive clean-session guard. Before changing tools, retain the original files
and owner/mode/SHA metadata in a new root-only backup directory; never overwrite
an earlier backup. Compare the six reviewed release files with SHA256 recorded from the
reviewed Git contents, then publish root:root 0644 sibling-temp+fsync+rename replacements,
common.sh first. Include sim_control.py even when it was previously absent.
Do not run bootstrap-autodeploy to refresh tools: it also installs packages.

Release the lock and observe one natural timer run: the same current SHA must
skip with exit0, no failed marker and unchanged deploys.log. Record unchanged
Caddy/API/PostgreSQL PID/start/NRestarts and DCGM identity. Do not restart the
services or timer to manufacture this proof. On failure, restore the saved five
files under the locks and remove a newly added helper only after checking its
exact installed SHA; retain evidence and report before proceeding. Run reviewed
`bootstrap-sim.sh --prepare` before staging/profile use so /opt/foothold-sim is
root:foothold-sim 0750. Metadata-only resolve may precede this step with a
root-private 0700 parent; it does not grant runtime traversal or activation.
Preparation installs only the new fixed-field proof socket, identity and units.

`python3 -B -m deploy.sim_sysroot resolve` prepares sources, public keys, lists,
cache, logs and a status copy exclusively under /opt/foothold-sim/apt. It uses the
official signed Noble repositories and the fixed ROS Jazzy snapshot. Host apt
configuration/hooks are not loaded; insecure metadata and authentication bypass
are disabled. APT runs in a transient unit with ProtectSystem=strict, private
home/tmp, no host credentials and one private writable prefix. The command never
invokes apt install. It records the complete host package state, exact missing
DEB version/size/SHA and signed metadata fingerprints in a private lock.

Report the lock SHA, download count and size to the coordinator **before stage**.
Unavailable approved upstream or any base/host version conflict is a stop; never
substitute latest. Gazebo sim8.15.0/transport13.6.0/msgs10.4.0/rendering8.2.3/
sensors8.2.2 and protobuf3.21.12 remain mandatory. Native policy/plugin originals
and their approved SHA stay unchanged.

## Download and stage (separate acceptance)

After the lock summary is accepted,
`python3 -B -m deploy.sim_sysroot stage FULL_LOCK_SHA` rechecks host status and
metadata, downloads exact locked versions using private APT, and verifies every
archive size/SHA. It checks tar paths, links/link parents, collisions and special
nodes before `dpkg-deb -x` into a new root-private staging directory. Extraction
also runs with the host filesystem read-only and only that staging prefix
writable. It never executes control/maintainer scripts. Ownership and modes are
normalized to root read-only with no SUID/SGID payload executables. A complete
file/link/mode/owner SHA manifest is checked before and after atomic publication
at /opt/foothold-sim/sysroot/LOCK_SHA. Archive originals are retained.

Generated private wrappers relocate GZ YAML prefixes, explicit library aliases
replace needed update-alternatives without running scripts, and a Ruby launcher
avoids host shebang assumptions. Original DEB files are not edited. The lock
binds both preparation/profile generator code. A changed generator requires a
new lock. `verify FULL_LOCK_SHA` rechecks immutable tree contents and host state.

Only the isolated child reads the root-owned profile.json; schema, lock binding,
parents, file ownership/modes and allowlisted paths are checked. A profile cannot
supply ROS/DDS identity or credentials. Domain93/LOCALHOST are applied afterwards.
PATH/LD_LIBRARY_PATH/PYTHONPATH/GZ/AMENT are private; host Python3.12 and existing
base runtime remain in use. Agent venv packages retain precedence over appended
ROS paths. Use the generated ros-setup.bash as SIM_ROS_SETUP and the profile as
FH_SIM_SYSROOT_PROFILE in private manager.env.

The profile selects only private Mesa EGL vendor/DRI paths, software rendering
and llvmpipe, with disk shader cache disabled. NVIDIA rendering is not used.
EGL renderer, OGRE2 real camera/lidar rendering, ROS extension ABI, plugin loading
and performance must still be tested on the server; generation is not proof of
execution. Resource limits/TTL/single session remain unchanged.

## Identity, credentials and resources

`bootstrap-sim.sh --prepare` creates only the nologin account, permitted groups,
private writable leaves, linger bus and root-owned user units; guard/manager are
not activated. A root system user-UID.slice drop-in enforces 4GiB/4CPU/Tasks640/
swap0 above the secondary user-manager slice, so the UID cannot raise the cap.
Do not change unrelated services or API sandbox settings.

Private catalogue/env examples use anonymous paths and UUIDs. Replace them only
in private configuration, register warehouse with existing sim_maps import, and
provide independent UID-owned 0600 service/pass credential copies. The API copy
must live in its readable private credential directory, not root-only /etc.
Native source/assets and sysroot stay read-only; only episode/replay/outbox and
the native output parent have dedicated private writes. Native trimesh5.1.0 uses
a root-owned, hash-locked private vendor; no hardware SDK or inference stack.

After package/asset/EGL/ABI/map/proxy/OS-helper review,
`bootstrap-sim.sh --activate` publishes the locked guard and starts only the
same-release idle manager. It requires private config/lock and proof socket.
It does not start Gazebo or enable session retries. HTTPS start/limited drive/
STOP/video/map/termination/restart and full absence are separate acceptance.

## HTTPS and fixed-field OS proof

Caddy forwards exactly the three original request targets under
/__fh_phone/9433/phone/{ws,camera/ws,media/ws}. Queries, encoded aliases, dot
segments, trailing slashes, adjacent ports and other phone paths never reach an
upstream. A literal route puts the decoded-but-uncleaned reserved-segment
guard before API/static matching, including aliases that cleaning would erase.
GET, one exact HTTPS Origin, a WebSocket Upgrade and a Connection
upgrade token are required. Duplicate Origin values are rejected. Native pass,
media-token and command checks remain end-to-end. site.py derives API and phone
Origins from the same private site.env, retaining private owners and modes.
Run it after creating manager.env and before activating the idle manager.

Automatic release deployment does not replace /etc/caddy/Caddyfile. The original
new-server copier is bootstrap-server.sh, which also installs system packages and
restarts PostgreSQL; **do not rerun that bootstrap on this existing host**. After
review, take the deployment/session fence, retain a private previous config, copy
only the reviewed Caddyfile to a root-owned sibling temporary file, inject the
private FH_SITE for `caddy adapt`/`caddy validate`, atomically rename the candidate
and reload only Caddy. If validation/reload fails, retain evidence and restore the
previous proxy config before releasing the fence. No package/DB/driver changes
belong in this operation. Apply the matching private Origin before manager start.
The server's Caddy v2.11.7 accepted the initial and corrected templates via adapt;
actual operational proxy replacement remains a separate installation step.

The ROS signing-key fetch is bounded to 65537 bytes and refuses empty/oversized
input. GPG parses either binary or ASCII OpenPGP, checks the existing single
primary fingerprint pin, then dearmors to a private .gpg keyring for APT. Signed
metadata verification and the fixed signing identity remain mandatory. The fixed
Jazzy snapshot uses the dedicated snapshot primary fingerprint
`4B63CF8FDE49746E98FA01DDAD19BAB3CBF125EA`, fetched from the exact HTTPS Ubuntu
keyserver lookup documented by [ROS snapshot installation](https://raw.githubusercontent.com/ros2/ros2_documentation/jazzy/source/Installation/Snapshot-Repository.rst).
The main ROS archive key is not a fallback; an unknown/missing/extra primary
still refuses the transaction and retains the package marker. Failed metadata
preparation needs the coordinator's accepted host-state audit and explicit
marker recovery/retry decision; code deployment never clears that marker. See
[APT key formats](https://manpages.ubuntu.com/manpages/noble/man8/apt-key.8.html).

The socket-activated root helper reads only /proc stat/cgroup and two environment
keys (ROS_DOMAIN_ID/GZ_PARTITION). It never exports argv, command names, full
environment or credentials. Its fixed nonce-bound protocol accepts no paths,
commands or signals; SO_PEERCRED restricts requests to root or foothold-sim.
The socket is root:foothold-sim 0660. Each request has bounded memory/CPU/time,
read-only filesystem protection and no ptrace/process_vm/signal syscalls.
CAP_SYS_PTRACE/CAP_DAC_READ_SEARCH belong only to this short-lived root reader,
never the simulation account or manager. No new TCP listener is added.

The manager's service fixes the socket path after EnvironmentFile expansion.
Native server configuration requires it; isolation.py uses the authenticated
snapshot for startup, identity and final absence. Permission denial, invalid
fields, nonce/time mismatch, changed PID identity or missing helper refuse proof;
there is no partial /proc fallback. Existing runtime/STOP/manifest/93/DDS checks
still determine cleanup. Local development without this server key retains its
existing scanner. Unit/PID/cgroup/93/DDS absence is still required before restart.

## Durable failure and audit

Three independent latches are checked at admission:
- guard/state/unproven: runtime-owned; only existing native cleanup proof clears it.
- guard/setup-unproven: root-owned activation failure, outside UID-owned state.
- /var/lib/foothold/sim-packages-unproven: root-only package/sysroot transaction.

Root records failures with validated directory fd and O_EXCL/O_NOFOLLOW, never
by opening a runtime-owned leaf. The package marker is created before staging
operations and removed only after all final proofs. Exceptions/interruption,
failed archive/tree/version/host proof or evidence writes retain it. Deployment
(even without a sim guard), bootstrap, package commands and manager/session
admission reject it.

Before/after evidence includes unchanged dpkg status/query, /usr path/content/
mode/owner digest, NVIDIA driver/device identity, active DCGM/MainPID/start time (initial observation 719) and
API/Caddy/PostgreSQL unit/PID/start timestamps. Source addresses, credentials,
raw assets and private evidence are never committed or echoed.

For manual recovery: block new starts, take deployment and simulation locks,
preserve private latch/episode/transaction evidence, audit the cause and fresh
unit/PID/start/cgroup/partition/domain93/DDS absence plus the existing STOP/zero/
manifest/source-ledger proofs. Absence of a manager row alone is insufficient.
Only after the coordinator accepts the audit may the specific audited latch be
removed and one explicit retry authorized. Unknown state stays fenced. Never
kill by name pattern, erase evidence, autoremove packages or restart a session.

Rollback restores the reviewed API/manager pair only after full cleanup. Private
sysroots are immutable and can be retained; changing profiles requires the same
idle gate and fresh evidence. No host package removal or driver rollback occurs.

References: [Mesa environment variables](https://docs.mesa3d.org/envvars.html),
[Gazebo8 EGL headless rendering](https://gazebosim.org/api/sim/8/headless_rendering.html).

### Approved ROS prefix alias (one host-path exception)

The initial read-only audit found /opt/ros absent. After staging, an explicit
`link FULL_LOCK_SHA` operation creates a root:0755 /opt/ros and one root-owned
/opt/ros/jazzy symlink to that immutable sysroot's opt/ros/jazzy. It never copies
package payload into /opt/ros. An existing foreign directory is not adopted.
Future changes require the exact recorded directory inode/entries/current link,
a verified tree, an inactive proven-clean manager and the exclusive guards.
The link changes by atomic rename and its before/after record is private proof;
its target is declared in the immutable manifest. Manager profiles check the
alias binding. This preserves the unchanged external runtime's absolute ROS
constant; no AST/source rewrite or facade is used.

For rollback, stop the proven-clean idle manager, explicitly link the retained
prior lock SHA and restore its matching private profile/setup before restarting
the paired API/manager release. Unknown ownership or failed link proof retains
the package marker and requires audit. /usr, /etc and dpkg remain unchanged.
