# Full rootfs: design and metadata-only planning

Status: **design + planner only**. This PR cannot download, extract, publish or
activate a runtime. A plan has `runnable=false`; a later implementation PR and
Claude/Codex review must precede every installation/runtime step.

The approved direction is a complete Noble userland + fixed ROS Jazzy snapshot
+ Mesa llvmpipe under `/opt/foothold-sim/rootfs/<complete-lock-sha>`. Host package
versions are neither reused nor held/upgraded. libc/loader/libstdc++/Python and
other base runtime packages may exist **inside this rootfs only**. Host package
DB, `/usr`, GPU/driver/DCGM/rpcbind and existing unrelated services stay unchanged.
No systemd-nspawn, debootstrap, bwrap, container daemon or host package install.

## Planner delivered here

`python3 -B -m deploy.rootfs_plan` is a server-root, fixed-path operation requiring
the existing reviewed deployment lock, no activated sim guard and no pending
package marker. It reads the retained private signed metadata; it has no update,
download, extraction, maintainer-script, library-load or service-start command.

A separate private APT configuration has an **empty status**, no host config
parts/hooks/preferences, no pkgcache and only the explicit amd64 sources. It
uses the cached Noble/main/universe, Noble updates/security and the fixed
`2026-09-11` Jazzy snapshot. Ubuntu signed-by uses only its archive keyring;
snapshot signed-by uses only the pinned snapshot primary
`4B63CF8FDE49746E98FA01DDAD19BAB3CBF125EA`. There is no main-ROS fallback.

Before solving, strict clear-signed armor framing rejects unsigned prefix/trailer
data. GPG verifies each retained InRelease and writes authenticated cleartext to
a new private output file; only that cleartext is parsed. Validity dates are checked,
and cached uncompressed Packages sizes/SHA256 are compared with its signed
SHA256 entries. Unsupported compressed cache representations refuse rather than
silently trusting different bytes. Metadata refresh is a separate future step.
Exactly one `apt-get --simulate --no-upgrade --no-remove` is allowed in one plan;
APT's configuration also forces simulation. Direct ROS/Gazebo/Python upstream
pins are preserved. Necessary userland/systemd/dbus/CPU-Mesa roots are selected
from the signed cache, then every resulting DEB version/SHA/size is recorded.
NVIDIA/CUDA/DCGM/rpcbind/kernel payload candidates remain forbidden.

The planner creates the root package pending marker before preparation. It saves
host dpkg/status/query, `/usr` content/mode/owner and GPU/service identities before
and after, including on rejected solves; after-evidence is saved before comparing.
Only a successful plan plus identical host proof clears that same inode marker.
Errors retain marker and root-only diagnostics, with no automatic retry. Output
is a private `foothold-rootfs-apt-plan/1` artifact, package count, DEB download
bytes, Installed-Size bytes and disk free. It is **not** a complete runtime lock:
control Python wheels, generated config, extraction and namespace execution
remain separate gates. No server planning attempt was made for this PR yet.

## Runtime architecture proposed for the next implementation

Keep the API on the host. Put the dedicated `foothold-sim` **user manager and all
its children** inside the rootfs using an instance-only system service drop-in
for `user@<dedicated-uid>.service`, with RootDirectory, MountAPIVFS,
PrivateUsers, PrivateTmp, PrivateDevices, NoNewPrivileges and no capabilities.
PID1 creates the namespace, so the design does not depend on granting the sim UID
privileged chroot/mount access. No global user@ template or other UID is changed.
RootImage/loop devices are unnecessary. No GPU device/node or render/video group
is granted for llvmpipe. Kernel/user-namespace/cgroup/PAM/dbus behavior must be
proved before activation; unsupported behavior is a stop, not a mixed-library
fallback. RootDirectory and logging socket behavior follow the
[systemd 255 execution specification](https://www.freedesktop.org/software/systemd/man/255/systemd.exec.html).

All manager/agent/native/Nav2/observer executables, loader, Python stdlib, ROS,
Ruby, renderer and Python wheels come from the complete rootfs. Host API venv,
`/usr`, `/lib*`, `/bin`, `/opt/ros` and any host library directory are never bound
into it. Rootfs library paths are never added to host process environments.
Host preparation tools may inspect bytes, but never import/load rootfs code.
The source runtime's existing `/opt/ros/jazzy` constant is satisfied naturally
inside RootDirectory; there is no host ROS alias or source/AST rewrite.

| Binding into the namespace | Access / purpose |
| --- | --- |
| Current release's four apps code directories and COMMIT | Read-only code, individually bound; host `.venv` excluded |
| Sealed policy/plugin/model/sensor/map assets | Read-only, exact SHA; approved plugin is an asset, not host system libraries |
| Two original absolute mesh URI targets | Explicit read-only file mappings inside rootfs; no host home-tree mirror |
| Private catalogue/service/pass-key files | Read-only, independent owner-0600 copies; host DB credentials excluded |
| Fixed OS-proof socket | Connect only, existing root/UID and nonce checks; no broad root RPC |
| Dedicated user runtime/bus and guard state | Only declared state/bus writes; shared lock inode remains visible to root deployer |
| Episode/replay/outbox and required native output leaves | UID-owned private writes only; original source stays read-only |
| Necessary notify/journal sockets | Explicit sockets only; no host root/system bus or global journal files |

The fixed root proof service remains outside RootDirectory. Before returning a
complete snapshot it must also refuse if the **host** package marker exists;
inside the namespace, a missing host pathname alone must never count as a clear
fence. This requires a separately reviewed fail-closed change, not a new mutable
RPC or broad directory bind. Native launch must obtain that proof before any
owned unit starts. Existing STOP/zero, PID/start/cgroup/domain93/partition/DDS,
source-ledger/manifest and durable lease checks remain mandatory.

The system user-UID slice retains MemoryMax4GiB, CPU400%, Tasks640 and swap0.
Existing individual world/agent/Nav2/observer limits and TTL remain. Use private
per-unit episode logs for unprivileged reads; do not add journal/DB privileges.
No native session or manager is enabled/restarted automatically after failure.

## Deployment pairing

Idle deployment must take the existing exclusive simulation guard, stop the
manager and prove all four owned child families absent. It can then stop only
the dedicated namespaced user manager, switch the API release, and start a fresh
namespace/code binding plus the same-release manager. The namespace must never
be rebound during a live or unproven session. Restart=no and no default-target
native auto-start remain explicit. Failure retains the root setup latch and
restores only the audited prior idle pair.

Readiness must attest `/proc/<pid>/root` against the selected immutable rootfs,
and compare COMMIT plus each bound apps-directory inode against current release.
The rootfs code parent is a namespace directory, so the old host-cwd string test
alone is insufficient. Package rootfs lock and API/manager code SHA are distinct:
an idle code update can rebind code without rebuilding package libraries.

## Builder and generated-config gate, not implemented here

The final lock must include DEBs, hash-pinned control wheels/trimesh, generator
code, UID/config/bind declarations and the complete file/link/mode/owner manifest.
After approval, download exact archives only into private storage. Never run
maintainer scripts, register host dpkg state, call host ldconfig over rootfs or
use host Python/ldd to execute rootfs binaries.

Extraction must account for complete-rootfs absolute and usrmerge links. Precheck
the entire archive graph, extract each checked package to an empty private stage,
and merge only through canonical root-relative paths using no-follow directory
fds. Do not extract through absolute/symlink parents into the host. Publish links
only after file merging; reject escape/cycles/special nodes and unapproved file
collisions. Ownership normalizes to root read-only with no SUID/SGID/capability
payload. Absolute links are meaningful only under RootDirectory. Existing
sysroot extraction/BASE_FORBIDDEN/profile/host-link code is not this builder.

Report and review all generated replacements for skipped scripts: passwd/group
UID entries, nsswitch/hosts, machine-id/logging decision, runtime tmp directories,
CA bundle if needed, alternatives/library aliases and loader configuration,
dbus/user units and rootfs provenance marker. No implicit postinst defaults.
Only after complete immutable verification may dedicated account/bus/socket/unit
configuration be applied, followed by a real software EGL render and ABI checks
**inside** RootDirectory. No hardware EGL, new tools, reboot or host driver change.

The first accepted session remains warehouse/f1 on domain93, HTTPS/headless test
account start, limited drive, STOP/deadman, live image/map, end and explicit
restart, then complete owned-unit/PID/cgroup/93/DDS absence. Factory maps require
the coordinator's separate instruction. Unknown cleanup stays locked.
