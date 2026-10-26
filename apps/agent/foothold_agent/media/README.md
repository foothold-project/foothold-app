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

Tokens expire after 10 seconds, are one-use and channel-specific, and inherit the
verified parent's organization/robot/permission/expiry. They cannot use camera
credentials. Parent disconnect/revocation, reset, stale state or binding changes
close the media sockets within the 50ms monitor interval. After hello any
application input, including binary/observer/drive requests, closes that socket.
Reconnect the parent for new tokens; there is no reusable token refresh endpoint.

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
stride and explicit endianness/row padding. Invalid, nonfinite or out-of-range
coordinates reject the scan. Conversion uses 0.1m voxels, at most 4,000 points,
and sets `truncated` when further voxels exist. Only `lidar_link` is emitted,
with `map_version_id=null` and `pose=null`: label it **L1 sensor frame**, not map
accumulation. No verified TF/map transform is implemented here.

External camera is enabled only when the existing simmgr bootstrap's verified
`SimulationBinding` matches the launcher-provided `FloorBindings` (robot, native
run UUID, generation, epoch and registered maps), and the world is `warehouse`
or `rubble`. No new environment switch is used; floor bindings or media flags
alone do not enable the subscription. Building/legacy/unverified launches retain
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
