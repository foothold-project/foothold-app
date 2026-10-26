# scenario/2 PHOTO and WAIT

`Observer` advertises a hello snapshot of `ExecutionCapabilities`. WAIT is supported;
RGB PHOTO is supported only while an existing camera/media source has a frame received
within one monotonic second and the photo REST client is configured. Depth is omitted.
A readiness change requests a reconnect with a new capability revision. The scenario
source negotiates that exact revision; a 422 `EXECUTION_UNAVAILABLE` becomes an event
with `requested_run_id` and `reason`, without inventing a server run.

The executor preserves scenario/1's movement and `DISPLAY_ONLY` results. For scenario/2
it validates fixed steps and exact requirements before submitting a navigation goal.
After measured arrival it revokes the goal, confirms cancellation and local ZERO
command output, and waits for durable server `run.recorded` ACKs for RUN_STARTED and
RUN_WAYPOINT_ARRIVED. This confirms local command output, not physical standstill.

`StepRunner` runs on the Hub loop without waiting for I/O. WAIT uses a monotonic
deadline (1–3600 seconds). Pause freezes the remaining time and explicit resume
continues the same waypoint without another navigation goal. The normal context,
controller, ping, lease and Core gates remain in force. Existing STOP output runs
before the executor invalidates its step generation; no HTTP worker is joined.

PHOTO uses the existing media latest frame, or the already subscribed camera's
latest frame. Reception must be strictly after the step's capture request and no
older than one second. Capture times out after three seconds. It adds no ROS camera
subscription and does not call a decoder on the Hub loop. JPEG bytes and metadata
stay in bounded process memory; they never enter the run journal or safety socket.

The upload worker sends raw JPEG with `PhotoUploadMetadata` to the authenticated
agent photo REST endpoint. The idempotency key is `run_id:waypoint_idx:step_idx`.
At most three attempts use the identical first key, capture time, metadata and bytes.
503/507 and transport errors are retryable; the retry delay is 200 ms. Each receipt
has a four-second deadline. A still-running timed-out worker is given at most another
four seconds, then the step fails; no new work is queued behind that worker. The HTTP
socket timeout is three seconds. Redirects and responses other than 200 are rejected.

A successful PHOTO result copies its reference only from a validated commit receipt.
All other terminal step failures record FAILED and prevent later steps. The executor
waits for the waypoint-result server ACK before advancing. Pause, STOP, cancel or link
loss invalidates in-flight work. Resume resends the same captured packet, if any,
without accepting the preceding generation's receipt; a changed capability revision
fails the step. Agent restart closes old runs and never resumes process-memory work.

The UI can consume RUN_WAYPOINT_RECORDED `RunExecutedResults`, generic
EXECUTION_UNAVAILABLE events, and server-generated PHOTO_STORED/PHOTO_STORE_FAILED
events. Photo download URLs and access rules are described in the server's PHOTOS.md.
Mock and loopback tests do not establish real-camera, physical-stop or robot behavior.
