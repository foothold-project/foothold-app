# Go2 asset reseal for an already provisioned rootfs

This is an explicit, root-only asset transition. A code merge does not authorize
server application. Keep the existing `prepare` refusal for CONFIG/GUARD and the
initial `probe` refusal for an existing validation. Never rerun bootstrap, change
an old seal, add host-path binds, install packages or remove failure fences.

The approved inputs are the five Go2 DAE files and the two upstream license
notices pinned in `go2-mesh-pins.json`. The model's original URI copy and two Go2
workspace copies were byte-identical. Original private paths and the detailed
provenance evidence stay outside Git. The original mesh generator copies the
mesh directory before producing its absolute file URIs; this operation copies
those original DAE bytes unchanged. See the upstream
[Unitree BSD license](https://github.com/unitreerobotics/unitree_ros/blob/master/LICENSE)
and the redistribution wrapper's Apache notice; retain both notices in the seal.

## Before any server application

Have the implementation reviewed and merged. Pin the exact reviewed release and
record the current CONFIG, VALIDATION and asset manifest hashes. Audit host
services, guard/parent identities, available disk, all existing markers and fresh
native/unit/cgroup/domain93/partition/DDS absence. Stop an idle pair only through
the already authorized normal command. A failed episode first needs its existing
normal cleanup or `stop-retained`; this tool never stops or signals it for you.

In a private, root-owned 0700 input directory place exactly the filenames in
`go2-mesh-pins.json`, each a root-owned ordinary 0600 file. Place that exact pins
JSON at `INPUT.json` (0600). Verify every supplied byte and the INPUT.json SHA
against the reviewed fingerprints. No a1/b2 substitute, symlink, hardlink,
additional mesh or discovery by basename is accepted.

Run from the reviewed release, with independently recorded exact hashes:

```sh
python3 -B -m deploy.asset_reseal apply PRIVATE_INPUT INPUT_SHA CONFIG_SHA VALIDATION_SHA
```

The command takes the existing deployment and simulation EX locks. It requires
an inactive dedicated namespace and no package/setup/session/release-pending
markers. It reserves one transaction under `/var/lib/foothold/asset-reseal`,
refuses an existing transaction/candidate, and copies the verified old ordinary
tree into a new hash-named asset container. Only the approved mesh/notice closure
and its provenance record are added. All original members, modes and hashes are
rechecked; the old seal remains intact. Failed candidates are retained, never
silently reused or erased.

The candidate is checked by `mesh_resources`, then the existing rootfs probe
performs fresh CPU EGL render/readback, native ABI, Python closure and root
identity proof against its actual bindings. `probe_evidence` returns evidence
without overwriting global CONFIG or VALIDATION. Existing rootfs recipe/build
and probe protections are retained; no inherited success booleans are relabelled.

Only after these checks does the tool save exact private old/new documents and
switch CONFIG (0600) plus VALIDATION (0400) under the same locks. Only
`asset_source` and `asset_manifest_sha256` may change in CONFIG. Two atomic,
fsynced replacements are coupled by the existing validation checks: a crash
between them makes ordinary activation refuse. A synchronous failure restores
both backups. `STATE.json` records pending/switched/restored phases and hashes.
The command never activates a namespace or starts a session.

## Activation and rollback

After a successful switch, use the reviewed normal `sim_control.py start` once;
it rechecks the new seal, fresh validation, mesh closure and namespace identity.
Back up server.env with a new O_EXCL 0600 name, preserve the drive setting, add
only the three approved simulation settings, restart the API once and check
health/login/WS. Start warehouse once through the owner account, inspect actual
robot/camera output, STOP and DELETE normally. Default to restoring the API env
after verification unless the coordinator explicitly decides to keep it.

On failure, preserve all episode/audit evidence and use existing normal cleanup.
After independent proof that the dedicated namespace is inactive, restore the
asset binding with the printed transaction ID:

```sh
python3 -B -m deploy.asset_reseal restore TRANSACTION_SHA
```

Restore accepts only the transaction's exact old/new pair (including a crash
between pair writes), verifies the old seal and does not overwrite unrelated
changes. A proven inactive namespace may retain its session `state/unproven`;
restore checks and preserves that leaf rather than releasing it. Package/setup
or release-pending markers still refuse. If normal shutdown/proof is unavailable,
stop and report: rollback is not authority to clear a marker, kill survivors,
ignore a guard or hide a live namespace. Restore the API env, restart and smoke;
never retry the simulation. Retain old/new seals, backups and all audit records.
