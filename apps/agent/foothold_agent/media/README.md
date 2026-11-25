# Observation media/1

`/phone/media/ws` is a separate, receive-only WebSocket on the existing phone
listener (same origin allowlist). `/phone/camera/ws` and `camera_token` retain
all existing meanings. The simulation runner enables media with
`FOOTHOLD_CAMERA_ENABLED=1` or explicit `FOOTHOLD_MEDIA_ENABLED=1`; neither flag
starts a simulation. RGB requires an installed Pillow JPEG decoder; if absent,
the capability reports unavailable rather than forwarding undecoded images.

First authenticate a normal `/phone/ws` view/control connection. Its welcome may
contain optional `media`: `version`, `path`, `robot`, `epoch`, `episode_id` and
`rgb`, `external`, `lidar` capabilities. Each capability contains `available`,
`reason`, and `token` (null when unavailable). Open one socket for each available
channel and send:

```json
{"t":"media.hello","version":"media/1","robot":"00000000-0000-0000-0000-000000000001","epoch":1,"episode_id":null,"channel":"lidar","token":"<43-character channel token from phone hello>"}
```

Hello never waits for sensor readiness. If the binding changes after hello, the
authenticated parent receives `{"t":"media.update","robot":"...","media":...}`
with the same welcome payload and fresh one-use channel tokens. A null `media`
revokes the offer. Updates occur once per binding generation on the independent
state writer; they never wait in the command reader or safety tick. Clients may
replace their media offer on this notification without reconnecting control.

Tokens expire after 10 seconds, are one-use and channel-specific, and inherit the
verified parent's organization/robot/permission/expiry. They cannot use camera
credentials. Parent disconnect/revocation, reset, stale state or binding changes
close the media sockets within the 50ms monitor interval. After hello any
application input, including binary/observer/drive requests, closes that socket.
Binding updates supply new tokens; otherwise reconnect the parent for new tokens.
There is no reusable token refresh endpoint.

`media.video` is bounded canonical base64 JPEG with actual decoded dimensions,
UTC capture time and the advertised binding. `media.points` JSON is followed by
exactly one binary message (`count*12` bytes, LE float32 XYZ); no frame may be
inserted between them. Video sends are at least 200ms apart; points 500ms. A send
pair has a 200ms total timeout. Slow consumers only retain the newest pending
item; a blocked consumer loses that socket without disconnecting control.
No fresh sample within one second produces `NO_VIDEO`/`NO_POINTS`. Frames older
than one second or over one second in the future are rejected. Sequence numbers
increase per channel across subscriptions and binding changes.

The simulation binding uses the UUID-normalized native run nonce in the trusted
`FOOTHOLD_FLOOR_BINDINGS.run_id` as media `episode_id`, and accepted state
`episode` as `epoch`. This is the native sensor session identity, not a server
simulation database ID. Missing/non-UUID launch identity means no media welcome;
clients use exactly the binding returned by hello, not an inferred ID. Hardware
adapters use `episode_id=null`; this simulation runner is not a hardware adapter.

A separate ROS context/executor thread subscribes depth-one best-effort to
`/v2_live/camera/compressed`, `/v2_map/points`, and (when enabled below)
`/v2_live/external_cam/compressed`. ROS stamps must advance per channel and be
within one second of fresh accepted simulation state. Capture UTC is the local
receipt time; it is not a conversion of simulation time. Independent child
processes fully decode JPEG and convert PointCloud2, respectively. Shared-memory
overwrite slots have one pending item, bounded bytes and nonblocking admission;
per-viewer asyncio queues also have size one. No media operation acquires a
control/STOP lock, shares a command queue, or accesses DB/journal/executor.

PointCloud2 permits at most 100,000 input points / 2MB, float32 XYZ fields, bounded
stride and explicit endianness/row padding. Nonfinite XYZ returns (NaN/Inf, as
preserved by the native sensor adapter) are skipped individually; malformed
layouts and finite out-of-range coordinates still reject the scan. A fresh scan
with no finite returns emits count zero and an empty binary payload, clearing
the previous sensor-frame scan. Conversion uses 0.1m voxels, at most 4,000 points,
and sets `truncated` when further voxels exist. Only `lidar_link` is emitted,
with `map_version_id=null` and `pose=null`: label it **L1 sensor frame**, not map
accumulation. No verified TF/map transform is implemented here.

## Optional lidar edge strengths

`FH_LIDAR_EDGE_ENABLED=1` opts in; **default is `0` (off)**. Set it in the
connection program's launch environment (hardware uses its supplied environment;
ROS conversion children inherit the launch environment), then restart through
the normal authorized procedure. There are no new package dependencies: this
uses the already supported NumPy, and omits the extension if NumPy is absent.
It does not run in the control/safety loop: hardware uses the existing lidar
observation worker; ROS uses its existing lidar conversion child.

Deploy the server with the updated `MediaPointCloudHeader` contract **before**
enabling this flag on any agent. Older servers reject unknown fields and would
reject the whole scan. Keep agents off during server rollout or rollback. The
old web accepts headers without the field, and ignores the optional field when
present; drawing edge strengths is a subsequent web task.

Both server upload and direct `/phone/media/ws` use the same optional JSON
header field, without changing `version=media/1`, `encoding=xyz_f32le`, the XYZ
binary message, message ordering, frame, or point count:

```json
{"count":2,"byte_length":24,"encoding":"xyz_f32le","edge_u8":"AP8="}
```

This is a header fragment; all existing required binding/frame fields still
apply. `edge_u8` is canonical standard base64 of **exactly `count` uint8 bytes**,
in the order of the XYZ triples in the following binary message. Byte 0 means
unmarked; byte 255 means edge. This implementation emits only 0/255; consumers
may treat any positive value as a strength. It describes only that scan and must
be cleared with it. Absent means no edge information; it is not an all-zero
classification. Null, malformed/noncanonical base64 and decoded lengths unequal
to `count` are rejected by the server contract. Maximum encoded length is 5,336
characters for 4,000 points. Empty scans omit the field (the contract also accepts
an empty string with `count=0`). No second binary message or extra bytes are added.

The calculation uses **the emitted points after the existing filtering and
sampling**, including the odom path and raw sensor fallback. It quantizes them
into 0.2 m cells and sums count, coordinate and quadratic moments from 27
neighbor cells. The smallest covariance eigenvalue divided by its trace exceeds
0.02 near folds where two faces meet. It requires eight neighbors and a second
eigenvalue greater than 0.0001 m² to avoid calling single points/lines edges.
This detects floor–wall seams, box face joins and tabletop rims while leaving
single planar floors, walls and ramps unmarked, including their sampled outer
boundaries. Sorting cell keys and a fixed 27 lookups avoid an all-pairs neighbor
search, scan-order assumptions and any map accumulation. Working arrays are
bounded by 4,000 points/cells (O(n) memory, O(n log n) work).
Recording and mapping callers of the shared XYZ converter remain unannotated;
only the media publication opts in, so those callers do not spend this budget.

This is local surface variation for display, not object recognition. Marks form
a band up to 0.4 m around a seam, and depend on sampling/cell alignment. Sparse
or single-face silhouettes can remain unmarked; noise, curved surfaces or nearby
separate faces can produce marks. No missing geometry is reconstructed.

**Budget:** at most 4,000 emitted points and 30 ms of edge work per scan at the
existing maximum 2 Hz. An empty/oversized input, missing NumPy, failed computation
or exceeded budget omits `edge_u8` and sends the original header/XYZ. Time is
checked between neighbor steps and after eigensolving, so an individual NumPy
operation or OS descheduling can exceed 30 ms before the result is discarded;
this is not a real-time CPU reservation. The first optional NumPy import is
outside the per-scan timer and happens only in the observation worker. Nothing
changes the original PointCloud2 admission or existing conversion bounds.

Local measurement (Intel i7-10750H, x86_64, Python 3.12.3, NumPy 1.26.4;
100 synthetic scans per case, other tests running concurrently): floor+wall
4,000 points p50/p95/max **2.233/3.142/3.936 ms**, 0 skipped; sparse 4,000 points
**9.252/24.256/33.717 ms**, 1 skipped. These measure edge work only, excluding
original cloud conversion, network and the first import. Reproduce from repo root:

```sh
PYTHONPATH=apps/agent python apps/agent/tools/benchmark_lidar_edges.py --iterations 100
```

These are PC measurements, not Orin NX or concurrent walking-runner validation.
Jetson, physical robot, ROS/Gazebo and real phone display remain untested.
Disable with `FH_LIDAR_EDGE_ENABLED=0` to restore identical headers and XYZ; for
code rollback revert the feature commit and keep the flag off before rolling
the server back. No deploy/restart or hardware connection is part of these tests.

## External camera

External camera is enabled only when the existing simmgr bootstrap's verified
`SimulationBinding` matches the launcher-provided `FloorBindings` (robot, native
run UUID, generation, epoch and registered maps), and the world is `warehouse`.
No new environment switch is used; floor bindings or media flags alone do not
enable the subscription. Building/legacy/unverified launches retain
`available=false`, token null, and `External camera source is not connected`.
When its decoder is alive and the media binding is valid, welcome advertises
`external: {available: true, reason: "Ready", token: "..."}`. The explicit
`gazebo_external` adapter receives `sensor_msgs/CompressedImage` from
`/v2_live/external_cam/compressed` and emits `media.video`, `channel=external`,
`source=gazebo_external`, `frame=fh_external_camera` with the current episode UUID
and epoch. Simmgr produces 320×240 images; admission enforces the same JPEG
limits as RGB (65,536 bytes, at most 640×360, 5 wall-clock Hz, one-second
freshness). External uses its own decode child, overwrite mailbox, sequence and
viewer queues; it reuses the existing media DDS context/executor thread and
worker implementation. A stalled RGB decoder/viewer does not block external,
or conversely. An enabled source with no fresh frame reports `NO_VIDEO`.

Tests use synthetic in-memory rasters/scans, owned conversion children and
loopback sockets in the assigned test port fence. ROS, Gazebo, hardware, phone,
GPU load and production networking require separate authorized validation.
