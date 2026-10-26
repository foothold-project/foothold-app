# External episode camera (observer/1)

Warehouse and rubble episode SDFs gain one independent `fh_external_camera`
model after the established sensor-profile transform. It is static, has gravity
disabled, has no collision/joint, and renders RGB 320×240 at 5 simulated Hz.
The robot include, sensor model/profile and source assets are untouched;
`sensor_isolation` still rejects `follow_cam`.

Connected building assets were checked through the existing `connected_assets`
catalogue paths. Their original SDFs have no UserCommands system, and this change
does not adapt their generation pipeline. Building and legacy worlds therefore
have **no external camera**; requests return `SIM_OBSERVER_UNAVAILABLE`.

The independent observer unit joins the verified domain 93 / episode partition,
reads `/v2_live/state` for robot XYZ and `/v2_map/status` for run nonce and epoch,
and only sends `gz.msgs.Pose` for `fh_external_camera` to the fixed
`/world/fh_v2_live/set_pose` service. Orbit yaw is in world axes; positive pitch
places the camera above the robot. The initial shared view is yaw π, pitch .45,
radius 3 m. State must be ≤.5 s old and status ≤1 s old. A RESET invalidates
pending work and images and restores the default on the new epoch.

The image bridge uses the same RGB→BGR→JPEG quality-70 conversion as the native
RGB bridge, in its own process. It accepts only RGB8 320×240/960-byte stride,
keeps one image, rejects stale/out-of-order sim stamps, caps output at
5 wall-clock Hz / 65,536 JPEG bytes, and publishes **sensor_msgs/CompressedImage**
on `/v2_live/external_cam/compressed`. State and render delivery are independent:
an image up to one simulated second ahead waits for state to catch up, using its
original arrival time and a one-wall-second deadline. It is never published while
future, replayed or restamped; epoch reset clears the slot. This avoids losing
every frame when render delivery consistently leads the state callback by a few
milliseconds. It never publishes the older follow JSON.

## Server relay API

All endpoints use the existing manager's loopback-only service Bearer secret and
4096-byte body limit. They are private control-server relay endpoints, not phone
endpoints. The server must authenticate the viewing user, check current robot /
organization view permission for each call, and relay cancel on drag release,
view disconnect or permission revocation. Possession of a phone media token does
not authorize these endpoints. No server/web transport is added in this PR.

| POST path under `/v1/robots/{robot_id}/external-camera/` | Behavior |
| --- | --- |
| `view` | Replace the single pending shared view |
| `reset` | Queue the shared default view |
| `cancel` | Drop pending work, retain the applied shared view |

Every body is exactly `ExternalCameraViewRequest`, including for reset/cancel
(their yaw/pitch/radius are validated but unused). `robot` must match the route
and registered running slot. `episode_id` is the native run nonce represented as
a UUID; `epoch` must match fresh native state/status. The relay must allocate a
strictly increasing `seq` shared across viewers of that robot/episode/epoch;
cancel/reset consume a sequence too. The observer repeats contract and binding
validation at the IPC boundary. A successful response is
`{"accepted":true,"shared":true,"seq":n,"operation":"view"}`: queued acceptance,
not proof of a rendered frame or successful Gazebo service execution.

Unknown fields (entity/service/world/robot pose included), bounds violations or
invalid IDs produce 400; wrong route binding, unsupported world, missing/failing
observer, stale identity, repeated sequence or a busy relay produce 409.
Requests use a private user-runtime Unix socket, one relay at a time, .3 s ACK
timeout. An unacknowledged relay attempts to discard only its matching pending
sequence within .05 s. This leaves scheduling/HTTP headroom below the server's
.5 s deadline so observer unavailability remains a 409 instead of a relay 503. The observer retains one pending view for at most .3 s;
service calls are capped at 10 wall-clock Hz with an 80 ms Gazebo timeout.

## Lifetime and verification limits

The observer and encoder share one transient `fh-simmgr-observer-<episode>` unit:
MemoryMax 256M, MemorySwapMax 0, CPUQuota 50%, TasksMax 64, existing episode TTL.
No existing unit limit or resource gate is increased. Manager STOP/removal,
deadline, startup failure and peer failure stop the observer and prove its owned
invocation/cgroup absent before native world cleanup. Failure latches ownership;
startup also refuses leftover observer units. A manager crash remains bounded by
the independent unit TTL. Measured memory/CPU fields are deliberately null.

Offline tests cover generated world/source SHA invariants, camera-only fixed
service requests, limits/sequence/freshness/latest/timeout/cancel/epoch behavior,
authenticated relay rejection and unit ownership/cleanup. No Gazebo/ROS runtime,
GPU render, phone, robot, WS bandwidth or STOP latency measurement was performed.
An approved isolated run must confirm static-model set_pose support, the initial
framing and drag direction, reset image provenance, actual JPEG output and B's
external media channel, and compare RSS/VRAM/CPU/RTF/STOP latency to baseline.

Transport request signature follows the [Gazebo Transport 13 Python API](https://gazebosim.org/api/transport/13/python.html).
