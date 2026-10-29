// 생성물 · 수정 금지 — 정본 apps/contracts/models.py, 생성 apps/contracts/generate.py
// 타입일 뿐 런타임 검증이 아니다. 의미 정의: docs/spec/05-API-SPEC.md

export const CONTRACT_VERSION = "fh-api/1";

export interface Action {
  key: "PHOTO" | "WAIT" | "OPERATOR_CONFIRM" | "SENSOR_LOG";
  label: string;
  params: Record<string, JsonValue>;
  requires: string[];
  available: boolean;
  why_unavailable: string | null;
  options: ActionOption[];
}

export interface ActionOption {
  param: "camera" | "device";
  value: "rgb" | "depth" | "lidar" | "battery";
  requires: string[];
  available: boolean;
  why_unavailable: string | null;
}

export interface AgentBattery {
  soc: number | null;
  voltage?: number | null;
}

export interface AgentCmdAck {
  t: "cmd.ack";
  seq: number;
  applied: number[];
  reason?: string | null;
}

export interface AgentCommand {
  t: "cmd";
  lease_id: string;
  seq: number;
  axes: number[];
  t_server: string;
}

export interface AgentEvent {
  t: "event";
  code: string;
  severity: "INFO" | "WARN" | "ERROR" | "info" | "warn" | "error";
  robot_at: string | null;
  data: Record<string, JsonValue>;
  agent_instance_id?: string;
  report_seq?: number;
  monotonic_s?: number;
}

export interface AgentHello {
  execution_capabilities?: ExecutionCapabilities;
  t: "hello";
  proto: "fh-agent/2";
  agent_version: string;
  robot_model: string | null;
  firmware: string | null;
  devices: Device[];
  map_versions: string[];
  last_floor_id: string | null;
  latched: boolean;
  stop_gen: number;
  lease_id: string | null;
  run: RunCopy | null;
}

export interface AgentInput {
}

export interface AgentLease {
  t: "lease";
  lease_id: string | null;
  holder_type: "USER" | string | null;
}

export interface AgentMedia {
  t: "media";
  kind: "photo";
  run_id?: string | null;
  step?: number | null;
  upload_id: string;
}

export interface AgentPhoneRevoke {
  t: "phone.revoke";
  seq: number;
  items: PhoneRevocationItem[];
}

export interface AgentPhoneRevokeAck {
  t: "phone.revoke.ack";
  seq: number;
}

export interface AgentPing {
  t: "ping";
}

export interface AgentPose {
  floor_context?: FloorContext | null;
  map_version_id?: string | null;
  floor_id: string | null;
  x: number | null;
  y: number | null;
  yaw: number | null;
  confidence: number | null;
}

export interface AgentRunUpdate {
  t: "run.update";
  run_id: string;
  status: "QUEUED" | "PREPARING" | "MOVING" | "AT_WAYPOINT" | "PERFORMING" | "WAIT_CONFIRM" | "PAUSED" | "COMPLETED" | "FAILED" | "CANCELED" | "RUNNING" | "ABORTED";
  step: number;
  progress: Progress | null;
  path_deviation_m?: number | null;
  fail_code?: string | null;
  wait_reason?: "LINK_LOST" | "STOPPED_BY_USER" | "RECORDING_UNAVAILABLE" | null;
  agent_instance_id?: string;
  report_seq?: number;
  monotonic_s?: number;
}

export interface AgentScenario {
  id: string;
  number: number;
  waypoints: AgentScenarioWaypoint[];
  finish: ScenarioFinish;
  map_proofs?: RunMapProof[] | null;
}

export interface AgentScenarioWaypoint {
  floor_id: string;
  map_version_id: string;
  x: number;
  y: number;
  yaw?: number;
  waypoint_ref?: string | null;
  mission_id: string;
  mission_version: number;
  mission_name: string;
  mission_steps?: MissionStep[];
  required_capabilities?: ("wait" | "photo.rgb" | "photo.depth" | "operator_confirm" | "sensor_log.rgb" | "sensor_log.depth" | "sensor_log.lidar" | "sensor_log.battery")[];
}

export interface AgentServerPing {
  t: "ping";
  t_server: string;
}

export interface AgentState {
  controller?: string | null;
  controller_device?: string | null;
  controller_connected?: boolean;
  controller_since?: string | null;
  reported_run?: RunSnapshot | null;
  t: "state";
  pose: AgentPose;
  speed: number | null;
  battery: AgentBattery;
  latched: boolean;
  safety_reason?: "OUTPUT_STALLED" | null;
  stop_gen: number;
  stop_ref: number;
  applied: number[];
  mode: string;
  devices_changed?: Device[] | null;
}

export interface AgentStop {
  t: "stop";
  by_user_id: string | null;
  stop_ref: number;
}

export interface AgentStreams {
  t: "streams";
  rgb: boolean;
  depth: boolean;
  lidar: boolean;
  map: boolean;
}

export interface AgentTokenResponse {
  agent_token: string;
}

export interface AgentUnlock {
  t: "unlock";
  lease_id: string;
  stop_gen: number;
}

export interface ApiError {
  error: ErrorBody;
}

export interface Approval {
  id: string;
  kind: "MAP_REVISION" | "MAP_ROLLBACK" | "SCENARIO_ASSIGNMENT";
  status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELED" | "STALE";
  requester: Person;
  decider: Person | null;
  reason: string;
  decision_comment: string | null;
  target: ApprovalRef;
  base_ref: ApprovalRef | null;
  emergency: boolean;
  created_at: string;
  decided_at: string | null;
}

export interface ApprovalApprove {
  comment?: string | null;
}

export interface ApprovalAssignmentPreview {
  scenario_id: string;
  scenario_name: string;
  scenario_version: number;
  robot_id: string;
  robot_name: string;
}

export interface ApprovalDetail {
  id: string;
  kind: "MAP_REVISION" | "MAP_ROLLBACK" | "SCENARIO_ASSIGNMENT";
  status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELED" | "STALE";
  requester: Person;
  decider: Person | null;
  reason: string;
  decision_comment: string | null;
  target: ApprovalRef;
  base_ref: ApprovalRef | null;
  emergency: boolean;
  created_at: string;
  decided_at: string | null;
  preview: ApprovalMapPreview | ApprovalAssignmentPreview;
}

export interface ApprovalList {
  items: Approval[];
  next_cursor: string | null;
}

export interface ApprovalMapPreview {
  floor_id: string;
  floor_name: string;
  target_version_number: number;
  base_version_number: number | null;
}

export interface ApprovalRef {
  type: "map_version" | "assignment";
  id: string;
}

export interface ApprovalReject {
  reason: string;
}

export interface Assignment {
  scenario_id: string;
  scenario_version: number;
  robot_id: string;
  memo: string;
  id: string;
  scenario_name: string;
  robot_name: string;
  status: "PENDING" | "ACTIVE" | "REJECTED" | "REMOVED";
  approval_id: string | null;
  created_by: string;
  created_at: string;
  removed_at: string | null;
}

export interface AssignmentCreate {
  scenario_id: string;
  scenario_version: number;
  robot_id: string;
  memo?: string;
}

export interface AssignmentList {
  items: Assignment[];
  next_cursor: string | null;
}

export interface Battery {
  soc: number;
  updated_at: string;
}

export interface CameraFrame {
  t: "camera.frame";
  /** 소문자 하이픈 UUID 표준형만 허용한다. */
  robot: string;
  seq: number;
  mime: "image/jpeg";
  width: number;
  height: number;
  jpeg: string;
}

export interface CameraHello {
  t: "camera.hello";
  /** 소문자 하이픈 UUID 표준형만 허용한다. */
  robot: string;
  token: string;
}

export interface CameraStatus {
  t: "camera.status";
  /** 소문자 하이픈 UUID 표준형만 허용한다. */
  robot: string;
  state: "NO_VIDEO";
}

export interface ConfirmParams {
  prompt?: string;
}

export interface CurrentRun {
  id: string;
  status: "QUEUED" | "PREPARING" | "MOVING" | "AT_WAYPOINT" | "PERFORMING" | "WAIT_CONFIRM" | "PAUSED" | "COMPLETED" | "FAILED" | "CANCELED" | "ABORTED";
  scenario_name: string;
  progress: Progress;
}

export interface Dashboard {
  robots_total: number;
  robots_online: number;
  robots_attention: number;
  robots_running: number;
  approvals_pending: number;
  operators: OperatorCount[];
}

export interface Device {
  key: string;
  kind: "CAMERA_RGB" | "CAMERA_DEPTH" | "LIDAR" | "BATTERY" | "OTHER";
  label: string;
  state: "OK" | "MISSING" | "ERROR";
}

export interface DurableAgentEvent {
  t: "event";
  code: string;
  severity: "INFO" | "WARN" | "ERROR" | "info" | "warn" | "error";
  robot_at: string | null;
  data: Record<string, JsonValue>;
  agent_instance_id: string;
  report_seq: number;
  monotonic_s: number;
}

export interface DurableAgentRunUpdate {
  t: "run.update";
  run_id: string;
  status: "QUEUED" | "PREPARING" | "MOVING" | "AT_WAYPOINT" | "PERFORMING" | "WAIT_CONFIRM" | "PAUSED" | "COMPLETED" | "FAILED" | "CANCELED";
  step: number;
  progress: Progress | null;
  path_deviation_m?: number | null;
  fail_code?: string | null;
  wait_reason?: "LINK_LOST" | "STOPPED_BY_USER" | "RECORDING_UNAVAILABLE" | null;
  agent_instance_id: string;
  report_seq: number;
  monotonic_s: number;
}

export interface ErrorBody {
  code: string;
  message: string;
  detail: Record<string, unknown>;
}

export interface Event {
  id: string;
  at: string;
  robot_at: string | null;
  category: "RUN" | "ROUTE" | "LINK" | "LEASE" | "APPROVAL" | "SAFETY" | "ACCOUNT";
  code: string;
  severity: "INFO" | "WARN" | "ERROR";
  message: string;
  robot_id: string | null;
  user_id: string | null;
  run_id: string | null;
  data: Record<string, unknown>;
}

export interface EventList {
  items: Event[];
  next_cursor: string | null;
}

export interface ExecutableAgentScenario {
  id: string;
  number: number;
  waypoints: ExecutableAgentScenarioWaypoint[];
  finish: ScenarioFinish;
  map_proofs: RunMapProof[];
  run_contract: "scenario/2";
  execution_capability_revision: number;
}

export interface ExecutableAgentScenarioWaypoint {
  floor_id: string;
  map_version_id: string;
  x: number;
  y: number;
  yaw?: number;
  waypoint_ref?: string | null;
  mission_id: string;
  mission_version: number;
  mission_name: string;
  mission_steps: MissionStep[];
  required_capabilities: ("wait" | "photo.rgb" | "photo.depth" | "operator_confirm" | "sensor_log.rgb" | "sensor_log.depth" | "sensor_log.lidar" | "sensor_log.battery")[];
}

export interface ExecutableRunGoal {
  mission_steps: MissionStep[];
  required_capabilities: ("wait" | "photo.rgb" | "photo.depth" | "operator_confirm" | "sensor_log.rgb" | "sensor_log.depth" | "sensor_log.lidar" | "sensor_log.battery")[];
  idx: number;
  waypoint_ref: string | null;
  x: number;
  y: number;
  yaw: number;
  mission_id: string;
  mission_version: number;
  mission_name: string;
}

export interface ExecutableRunPlan {
  segments: ExecutableRunSegment[];
  run_contract: "scenario/2";
  execution_capability_revision: number;
}

export interface ExecutableRunSegment {
  floor_id: string;
  map_version_id: string;
  goals: ExecutableRunGoal[];
}

export interface ExecutableRunStarted {
  run_contract: "scenario/2";
  execution_capability_revision: number;
  run_id: string;
  scenario_id: string;
  scenario_version: number;
  floor_id: string;
  map_version_id: string;
  user_id: string;
  device_id: string;
  surface: "phone" | "pc";
  screen_id: string;
  simulation: boolean;
  map_proof: RunMapProof;
}

export interface ExecutionCapabilities {
  contract: "scenario/2";
  revision: number;
  actions: ExecutionCapability[];
}

export interface ExecutionCapability {
  key: "wait" | "photo.rgb" | "photo.depth" | "operator_confirm" | "sensor_log.rgb" | "sensor_log.depth" | "sensor_log.lidar" | "sensor_log.battery";
  state: "SUPPORTED" | "UNAVAILABLE" | "UNSUPPORTED";
  reason: string | null;
}

export interface ExternalCameraViewRequest {
  /** 소문자 하이픈 UUID 표준형만 허용한다. */
  robot: string;
  epoch: number;
  episode_id: string;
  t: "external.view";
  version: "observer/1";
  seq: number;
  /** Orbit yaw in radians. */
  yaw: number;
  /** Orbit pitch in radians. */
  pitch: number;
  /** Orbit radius in metres. */
  radius: number;
}

export interface FloorConnector {
  id: string;
  building_id: string;
  kind: "STAIRS" | "ELEVATOR";
  floor_a_id: string;
  floor_b_id: string;
  a_pose: Record<string, number>;
  b_pose: Record<string, number> | null;
  map_version_a_id: string;
  map_version_b_id: string | null;
  active: boolean;
}

export interface FloorConnectorList {
  items: FloorConnector[];
  next_cursor: null;
}

export interface FloorContext {
  robot_id: string;
  generation: number;
  run_id: string;
  epoch: number;
  floor_rev: number;
  world_id: "v5_building" | "warehouse";
  building_id: string;
  spawn_floor_id: "l1" | "l2" | "f1";
  current_floor_id: "l1" | "l2" | "f1" | null;
  floor_id: string | null;
  map_version_id: string | null;
  sha256: string | null;
  source_pgm_sha256: string | null;
  source: "gt_geometry";
  floor_state: "on_floor" | "transit" | "unknown";
  reason: string;
  confirmed_sim_t: number | null;
}

export interface FloorCreate {
  name: string;
  level: number;
}

export interface FloorPatch {
  name?: string;
  level?: number;
}

export interface IdempotencyHeaders {
  /** Idempotency-Key header; same user/key replays the first successful response for 24 hours. */
  idempotency_key?: string | null;
}

export type JsonValue = unknown;

export interface Lease {
  holder_type: "USER" | "RUN";
  user: Person | null;
  since: string;
}

export interface Location {
  floor_context?: FloorContext | null;
  floor_id: string | null;
  map_version_id: string | null;
  x: number | null;
  y: number | null;
  yaw: number | null;
  confidence: number | null;
  updated_at: string;
}

export interface LoginRequest {
  username: string;
  password: string;
  client?: "web" | "app";
  device_label?: string;
}

export interface LoginResponse {
  id: string;
  username: string;
  display_name: string;
  role: "ORG_ADMIN" | "OPERATOR";
  locked: boolean;
  robot_ids: string[];
  created_at: string;
  csrf_token: string | null;
  access_token: string | null;
  refresh_token: string | null;
}

export interface MapBuilding {
  archived_at?: string | null;
  sim_world_id?: string | null;
  id: string;
  site_id: string;
  name: string;
  floors: MapFloor[];
}

export interface MapConnector {
  id: string;
  kind: "STAIRS" | "ELEVATOR";
  pair_floor_id: string;
  x: number;
  y: number;
  yaw: number;
}

export interface MapDiff {
  version: MapVersion;
  against: MapVersion | null;
  image_changed: boolean;
  changes: MapFeatureChange[];
}

export interface MapEdit {
  id?: string | null;
  op: "ERASE" | "WALL";
  polyline: [number, number][];
  width: number;
}

export interface MapFeatureChange {
  kind: "zones" | "waypoints" | "connectors" | "edits";
  key: string;
  change: "added" | "removed" | "changed";
  before: MapZone | MapWaypoint | MapConnector | MapEdit | null;
  after: MapZone | MapWaypoint | MapConnector | MapEdit | null;
  before_index: number | null;
  after_index: number | null;
}

export interface MapFeatures {
  zones: MapZone[];
  waypoints: MapWaypoint[];
  connectors: MapConnector[];
  edits: MapEdit[];
}

export interface MapFloor {
  archived_at?: string | null;
  provenance?: "HUMAN" | "SIMULATION";
  floor_z?: number | null;
  id: string;
  building_id: string;
  name: string;
  level: number;
  approved_version_id: string | null;
  pending_count: number;
}

export interface MapName {
  name: string;
}

export interface MapRollback {
  base_version_id: string;
  reason: string;
}

export interface MapSite {
  archived_at?: string | null;
  id: string;
  name: string;
  buildings: MapBuilding[];
}

export interface MapUpload {
  upload_id: string;
  sha256: string;
}

export interface MapVersion {
  provenance?: "HUMAN" | "SIMULATION";
  upload_id: string;
  id: string;
  floor_id: string;
  number: number;
  base_version_id: string | null;
  copied_from_id: string | null;
  status: "APPROVED" | "SUPERSEDED" | "PENDING" | "REJECTED" | "CANCELED";
  image_sha256: string;
  width: number;
  height: number;
  resolution: number;
  origin: [number, number, number];
  features: MapFeatures;
  reason: string;
  source: "IMPORT" | "EDIT" | "ROLLBACK" | "SLAM";
  created_by: string;
  created_at: string;
}

export interface MapVersionCreate {
  base_version_id: string | null;
  image: string;
  features: MapFeatures;
  reason: string;
}

export interface MapVersionList {
  items: MapVersion[];
  next_cursor: string | null;
}

export interface MapWaypoint {
  id: string;
  name: string;
  x: number;
  y: number;
  yaw: number;
}

export interface MapZone {
  id: string;
  type: "NO_GO" | "SLOW";
  name: string;
  polygon: [number, number][];
}

export interface MePatch {
  display_name?: string;
  notify_prefs?: Record<string, boolean>;
}

export interface MediaBinding {
  /** 소문자 하이픈 UUID 표준형만 허용한다. */
  robot: string;
  epoch: number;
  episode_id: string | null;
}

export interface MediaHeader {
  /** 소문자 하이픈 UUID 표준형만 허용한다. */
  robot: string;
  epoch: number;
  episode_id: string | null;
  version: "media/1";
  channel: "rgb" | "external" | "lidar";
  source: "d435i_rgb" | "go2_front" | "gazebo_external" | "l1";
  seq: number;
  captured_at: string;
  frame: string;
}

export interface MediaHello {
  /** 소문자 하이픈 UUID 표준형만 허용한다. */
  robot: string;
  epoch: number;
  episode_id: string | null;
  t: "media.hello";
  version: "media/1";
  channel: "rgb" | "external" | "lidar";
  token: string;
}

export interface MediaLimits {
  jpeg_max_bytes: 65536;
  jpeg_max_width: 640;
  jpeg_max_height: 360;
  jpeg_max_hz: 5;
  point_max_count: 4000;
  point_max_hz: 2;
  point_max_abs_m: 10000;
  external_view_max_hz: 10;
  latest_queue_size: 1;
}

export interface MediaPointCloudHeader {
  /** 소문자 하이픈 UUID 표준형만 허용한다. */
  robot: string;
  epoch: number;
  episode_id: string | null;
  version: "media/1";
  channel: "lidar";
  source: "l1";
  seq: number;
  captured_at: string;
  frame: "map" | "lidar_link";
  t: "media.points";
  map_version_id: string | null;
  pose: MediaPose | null;
  count: number;
  truncated: boolean;
  encoding: "xyz_f32le";
  byte_length: number;
}

export interface MediaPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

export interface MediaStatus {
  /** 소문자 하이픈 UUID 표준형만 허용한다. */
  robot: string;
  epoch: number;
  episode_id: string | null;
  t: "media.status";
  version: "media/1";
  channel: "rgb" | "external" | "lidar";
  state: "NO_VIDEO" | "NO_POINTS" | "UNAVAILABLE";
  reason: string;
}

export interface MediaVideoFrame {
  /** 소문자 하이픈 UUID 표준형만 허용한다. */
  robot: string;
  epoch: number;
  episode_id: string | null;
  version: "media/1";
  channel: "rgb" | "external";
  source: "d435i_rgb" | "go2_front" | "gazebo_external" | "l1";
  seq: number;
  captured_at: string;
  frame: string;
  t: "media.video";
  mime: "image/jpeg";
  width: number;
  height: number;
  jpeg: string;
}

export interface Mission {
  name: string;
  steps: MissionStep[];
  id: string;
  number: number;
  latest_version: number;
  version: number;
  required_devices: string[];
  created_by: string;
  created_at: string;
  version_created_by: string;
  version_created_at: string;
  archived_at: string | null;
}

export interface MissionList {
  items: Mission[];
  next_cursor: string | null;
}

export interface MissionStep {
  action: "PHOTO" | "WAIT" | "OPERATOR_CONFIRM" | "SENSOR_LOG";
  params?: Record<string, JsonValue>;
}

export interface MissionWrite {
  name: string;
  steps: MissionStep[];
}

export interface Notification {
  id: string;
  event_id: string | null;
  kind: string;
  title: string;
  body: string;
  link: string;
  read_at: string | null;
  created_at: string;
}

export interface NotificationList {
  items: Notification[];
  next_cursor: string | null;
  unread_count: number;
}

export interface NotificationsRead {
  ids?: string[];
  all?: true;
}

export interface OperatorCount {
  user_id: string;
  display_name: string;
  robot_count: number;
}

export interface OrgSettings {
  battery_low_pct: number;
  run_min_battery_pct: number;
  deviation_m: number;
  lease_request_timeout_s: number;
  link_loss_wait_s: number;
}

export interface OrgSettingsPatch {
  battery_low_pct?: number;
  run_min_battery_pct?: number;
  deviation_m?: number;
  lease_request_timeout_s?: number;
  link_loss_wait_s?: number;
}

export interface PasswordChange {
  current_password: string;
  new_password: string;
}

export interface Person {
  id: string;
  display_name: string;
}

export interface PhoneCapabilities {
  run_contract: "scenario/1";
  execution?: ExecutionCapabilities;
}

export interface PhoneCmdAck {
  t: "cmd.ack";
  id: string;
  seq: number;
  applied: number[];
  clipped: boolean;
  reason: string | null;
}

export interface PhoneCommand {
  id: string;
  /** 소문자 하이픈 UUID 표준형만 허용한다. */
  robot: string;
  proto?: "fh-phone/1";
  t: "cmd";
  lease_id: string;
  seq: number;
  vx: number;
  vy: number;
  wz: number;
}

export interface PhoneEcho {
  id: string;
  client_time_ms: number;
  agent_time_ms: number;
}

export interface PhoneEnvelope {
  id: string;
  /** 소문자 하이픈 UUID 표준형만 허용한다. */
  robot: string;
  proto?: "fh-phone/1";
}

export interface PhoneHello {
  id: string;
  /** 소문자 하이픈 UUID 표준형만 허용한다. */
  robot: string;
  proto: "fh-phone/1";
  t: "hello";
  ticket: string;
  device: string;
}

export interface PhoneLease {
  id: string;
  /** 소문자 하이픈 UUID 표준형만 허용한다. */
  robot: string;
  proto?: "fh-phone/1";
  t: "lease.take" | "lease.request" | "lease.release" | "lease.cancel" | "view";
}

export interface PhoneLeaseRequested {
  t: "lease.requested";
  /** 소문자 하이픈 UUID 표준형만 허용한다. */
  robot: string;
  request_id: string;
  requester: PhoneRequester;
  expires_at: string;
}

export interface PhoneLeaseResult {
  t: "lease.result";
  /** 소문자 하이픈 UUID 표준형만 허용한다. */
  robot: string;
  request_id: string;
  result: "ACCEPTED" | "DECLINED" | "TIMEOUT" | "CANCELED";
  error: string | null;
}

export interface PhoneLimits {
  policy_adapter_id?: string | null;
  requires_forward_motion?: boolean;
  policy_velocity_range?: PhonePolicyVelocityRange | null;
  vx_mode?: "discrete" | "continuous";
  vx_min_moving?: number | null;
  experimental?: ("reverse" | "lateral" | "turn_in_place")[];
  vx_min: number;
  vx_max: number;
  vy_min: number;
  vy_max: number;
  wz_min: number;
  wz_max: number;
  commands: number[][];
}

export interface PhoneMediaChannelCapability {
  available: boolean;
  reason: string;
  token: string | null;
}

export interface PhoneMediaUpdate {
  t: "media.update";
  /** 소문자 하이픈 UUID 표준형만 허용한다. */
  robot: string;
  media: PhoneMediaWelcome | null;
}

export interface PhoneMediaWelcome {
  version: "media/1";
  path: "/phone/media/ws";
  /** 소문자 하이픈 UUID 표준형만 허용한다. */
  robot: string;
  epoch: number;
  episode_id: string | null;
  rgb: PhoneMediaChannelCapability;
  external: PhoneMediaChannelCapability;
  lidar: PhoneMediaChannelCapability;
}

export interface PhonePassRequest {
  device: string;
  purpose: "control" | "view";
  surface?: "phone" | "pc";
  /** 앞 로봇 반납 확인 뒤에만 명시 true */
  switch?: boolean;
}

export interface PhonePassResponse {
  token: string;
  exp: number;
  kid: string;
}

export interface PhonePing {
  id: string;
  /** 소문자 하이픈 UUID 표준형만 허용한다. */
  robot: string;
  proto?: "fh-phone/1";
  t: "ping";
  client_time_ms: number;
}

export interface PhonePolicy {
  name: string;
  version: string;
}

export interface PhonePolicyVelocityRange {
  vx_min_moving: number;
  vx_max: number;
  vy_min: number;
  vy_max: number;
  wz_min: number;
  wz_max: number;
}

export interface PhonePosture {
  z: number | null;
  tilt_deg: number | null;
  fallen: boolean | null;
  body_still: boolean | null;
}

export interface PhoneReply {
  detail?: RunResumeDetail | null;
  t: "reply";
  id: string;
  ok: boolean;
  error: ErrorBody | null;
  lease_id: string | null;
  request_id: string | null;
}

export interface PhoneRequester {
  user_id: string;
  device_id: string;
}

export interface PhoneRespond {
  id: string;
  /** 소문자 하이픈 UUID 표준형만 허용한다. */
  robot: string;
  proto?: "fh-phone/1";
  t: "lease.respond";
  request_id: string;
  accept: boolean;
}

export interface PhoneRevocationItem {
  jtis: string[] | null;
  sub: string | null;
  device: string | null;
  until: number;
}

export interface PhoneRunConfirm {
  id: string;
  /** 소문자 하이픈 UUID 표준형만 허용한다. */
  robot: string;
  proto?: "fh-phone/1";
  t: "run.confirm";
  lease_id: string;
  run_id: string;
  kind: "FLOOR" | "OPERATOR";
  data: Record<string, JsonValue>;
}

export interface PhoneRunControl {
  id: string;
  /** 소문자 하이픈 UUID 표준형만 허용한다. */
  robot: string;
  proto?: "fh-phone/1";
  t: "run.control";
  run_id: string;
  /** return은 예약된 요청이며 항상 UNSUPPORTED_OPERATION으로 거부한다. */
  op: "pause" | "resume" | "abort" | "return";
  lease_id?: string;
  screen_id?: string;
  /** 같은 화면 재개의 비밀 증명. 에이전트는 해시만 보관하고 재바인딩 때 회전한다. */
  resume_token?: string;
}

export interface PhoneRunStart {
  id: string;
  /** 소문자 하이픈 UUID 표준형만 허용한다. */
  robot: string;
  proto?: "fh-phone/1";
  t: "run.start";
  lease_id: string;
  run_id: string;
  screen_id: string;
  scenario_id: string;
  scenario_version: number;
  floor_id: string;
  map_version_id: string;
  /** 시뮬은 생략, 실기는 필수. 인증된 simulation으로 실행기가 판정한다. */
  assignment_id?: string;
}

export interface PhoneRunStartV2 {
  id: string;
  /** 소문자 하이픈 UUID 표준형만 허용한다. */
  robot: string;
  proto?: "fh-phone/1";
  t: "run.start.v2";
  run_contract: "scenario/2";
  execution_capability_revision: number;
  lease_id: string;
  run_id: string;
  screen_id: string;
  scenario_id: string;
  scenario_version: number;
  floor_id: string;
  map_version_id: string;
  assignment_id?: string;
}

export interface PhoneRunUpdate {
  run_id: string;
  status: "QUEUED" | "PREPARING" | "MOVING" | "AT_WAYPOINT" | "PERFORMING" | "WAIT_CONFIRM" | "PAUSED" | "COMPLETED" | "FAILED" | "CANCELED";
  step: number;
  progress: Progress;
  wait_reason: "LINK_LOST" | "STOPPED_BY_USER" | "RECORDING_UNAVAILABLE" | null;
  fail_code: string | null;
  t: "run.update";
}

export interface PhoneState {
  controller: string | null;
  controller_device: string | null;
  controller_connected: boolean;
  controller_since?: string | null;
  reported_run?: RunSnapshot | null;
  t: "state";
  pose: AgentPose;
  speed: number | null;
  battery: AgentBattery;
  latched: boolean;
  safety_reason?: "OUTPUT_STALLED" | null;
  stop_gen: number;
  stop_ref: number;
  applied: number[];
  mode: string;
  devices_changed?: Device[] | null;
  run?: RunSnapshot | null;
  /** 소문자 하이픈 UUID 표준형만 허용한다. */
  robot: string;
  lease_id: string | null;
  stop_requested: boolean | null;
  posture: PhonePosture;
  velocity: [number | null, number | null, number | null];
  echo: PhoneEcho | null;
  wall_time_ms: number;
  sim_time_s: number | null;
  sim_wall_delta_s: number | null;
  simulation: boolean;
}

export interface PhoneStop {
  id: string;
  /** 소문자 하이픈 UUID 표준형만 허용한다. */
  robot: string;
  proto?: "fh-phone/1";
  t: "stop";
  request_id?: string;
}

export interface PhoneTicketClaims {
  iss: "fh-control";
  aud: "fh-phone/1";
  org: string;
  /** 소문자 하이픈 UUID 표준형만 허용한다. */
  robot: string;
  sub: string;
  device: string;
  purpose: "control" | "view";
  surface: "phone" | "pc";
  /** 서버 서명 PAUSED 취소 권한만. 생략=false; 조종·해제·재개 권한을 주지 않는다. */
  run_cancel?: boolean;
  iat: number;
  exp: number;
  jti: string;
}

export interface PhoneUnlock {
  id: string;
  /** 소문자 하이픈 UUID 표준형만 허용한다. */
  robot: string;
  proto?: "fh-phone/1";
  t: "unlock";
  lease_id: string;
  stop_gen: number;
}

export interface PhoneWelcome {
  media?: PhoneMediaWelcome;
  capabilities?: PhoneCapabilities | null;
  /** 10초·1회용 영상 연결 토큰; 부모 연결에 종속 */
  camera_token: string | null;
  t: "hello";
  id: string;
  /** 소문자 하이픈 UUID 표준형만 허용한다. */
  robot: string;
  proto: "fh-phone/1";
  limits: PhoneLimits;
  policy: PhonePolicy;
  simulation: boolean;
  ping_interval_ms: 1000;
  link_timeout_ms: 3000;
  lease_timeout_ms: 15000;
}

export interface PhotoParams {
  camera?: "rgb" | "depth";
}

export interface PhotoUploadMetadata {
  org_id: string;
  robot_id: string;
  run_id: string;
  waypoint_idx: number;
  step_idx: number;
  source: "rgb";
  captured_at: string;
  mime: "image/jpeg";
  byte_length: number;
  sha256: string;
  idempotency_key: string;
}

export interface PhotoUploadReceipt {
  org_id: string;
  robot_id: string;
  run_id: string;
  waypoint_idx: number;
  step_idx: number;
  source: "rgb";
  captured_at: string;
  mime: "image/jpeg";
  byte_length: number;
  sha256: string;
  idempotency_key: string;
  photo_id: string;
  stored_at: string;
}

export interface PreviewPoint {
  element: string;
  reachable: boolean;
  reasons: string[];
}

export interface PreviewSegment {
  start: string;
  end: string;
  reachable: boolean;
  reason: string | null;
  connector_id: string | null;
  distance_m: number | null;
  via: ScenarioPoint[];
}

export interface Progress {
  done: number;
  total: number;
}

export interface ProvenAgentScenario {
  id: string;
  number: number;
  waypoints: AgentScenarioWaypoint[];
  finish: ScenarioFinish;
  map_proofs: RunMapProof[];
}

export interface ProvenRunStarted {
  run_contract?: "scenario/2";
  execution_capability_revision?: number;
  run_id: string;
  scenario_id: string;
  scenario_version: number;
  floor_id: string;
  map_version_id: string;
  user_id: string;
  device_id: string;
  surface: "phone" | "pc";
  screen_id: string;
  simulation: boolean;
  map_proof: RunMapProof;
}

export interface RefreshRequest {
  refresh_token: string;
}

export interface RobotCreate {
  name: string;
  owner_user_id?: string | null;
}

export interface RobotCreated {
  robot: RobotSummary;
  agent_token: string;
}

export interface RobotList {
  items: RobotSummary[];
  next_cursor: string | null;
}

export interface RobotPatch {
  name?: string;
  owner_user_id?: string | null;
}

export interface RobotSummary {
  last_state_received_at?: string | null;
  state_stale?: boolean | null;
  controller?: Person | null;
  controller_device?: string | null;
  controller_connected?: boolean | null;
  simulation: boolean;
  id: string;
  name: string;
  model: string;
  owner: Person | null;
  connection: "ONLINE" | "OFFLINE" | "UNKNOWN";
  status: "IDLE" | "TELEOP" | "RUNNING" | "PAUSED" | "STOP_LATCHED" | "ERROR" | null;
  battery: Battery | null;
  location: Location | null;
  lease: Lease | null;
  current_run: CurrentRun | null;
  devices: Device[];
  attention: string[];
}

export interface RunCopy {
  run_id: string;
  status: string;
  step: number;
  wait_reason?: string | null;
}

export interface RunDisplayResults {
  mode?: "DISPLAY_ONLY";
}

export interface RunExecutedResults {
  mode: "EXECUTED";
  run_contract: "scenario/2";
  execution_capability_revision: number;
  steps: RunStepResult[];
}

export interface RunGoal {
  mission_steps?: MissionStep[];
  required_capabilities?: ("wait" | "photo.rgb" | "photo.depth" | "operator_confirm" | "sensor_log.rgb" | "sensor_log.depth" | "sensor_log.lidar" | "sensor_log.battery")[];
  idx: number;
  waypoint_ref: string | null;
  x: number;
  y: number;
  yaw: number;
  mission_id: string;
  mission_version: number;
  mission_name: string;
}

export interface RunMapProof {
  floor_id: string;
  map_version_id: string;
  image_sha256: string;
  source_pgm_sha256: string;
  origin: [number, number, number];
  resolution: number;
  width: number;
  height: number;
  source: "HUMAN" | "SIMULATION";
  world_id: string | null;
  ros_floor_id: string | null;
}

export interface RunPhotoReference {
  photo_id: string;
  source: "rgb";
  captured_at: string;
  sha256: string;
}

export interface RunPlan {
  segments: RunSegment[];
}

export interface RunRecorded {
  t: "run.recorded";
  agent_instance_id: string;
  report_seq: number;
}

export interface RunReportRejected {
  t?: "run.report_rejected";
  agent_instance_id: string;
  report_seq: number;
  run_id: string | null;
  disposition: "RETRY" | "QUARANTINE";
  code: "RUN_REPORT_SEQUENCE" | "RUN_REPORT_STORAGE" | "RUN_REPORT_OWNER" | "RUN_REPORT_MAP" | "RUN_REPORT_PLAN" | "RUN_REPORT_STATE" | "RUN_REPORT_STEP" | "RUN_REPORT_PROVENANCE" | "RUN_REPORT_CONFLICT" | "RUN_REPORT_INSTANCE" | "RUN_REPORT_ROBOT" | "RUN_REPORT_NOT_FOUND" | "RUN_REPORT_INVALID";
  expected_report_seq?: number;
}

export interface RunResumeDetail {
  run_id: string;
  screen_id: string;
  /** 256 bit 이상 난수. 원래/재바인딩된 실행 연결에만 반환하며 기록·보기 연결에는 금지한다. */
  resume_token: string;
}

export interface RunSegment {
  floor_id: string;
  map_version_id: string;
  goals: RunGoal[];
}

export interface RunSnapshot {
  run_id: string;
  status: "QUEUED" | "PREPARING" | "MOVING" | "AT_WAYPOINT" | "PERFORMING" | "WAIT_CONFIRM" | "PAUSED" | "COMPLETED" | "FAILED" | "CANCELED";
  step: number;
  progress: Progress;
  wait_reason: "LINK_LOST" | "STOPPED_BY_USER" | "RECORDING_UNAVAILABLE" | null;
  fail_code: string | null;
}

export interface RunStarted {
  run_contract?: "scenario/2";
  execution_capability_revision?: number;
  run_id: string;
  scenario_id: string;
  scenario_version: number;
  floor_id: string;
  map_version_id: string;
  user_id: string;
  device_id: string;
  surface: "phone" | "pc";
  screen_id: string;
  simulation: boolean;
  map_proof?: RunMapProof;
}

export interface RunStepResult {
  step_idx: number;
  action: "PHOTO" | "WAIT" | "OPERATOR_CONFIRM" | "SENSOR_LOG";
  source: "rgb" | "depth" | "lidar" | "battery" | null;
  status: "SUCCEEDED" | "FAILED";
  failure_code: "UNSUPPORTED" | "CAPABILITY_CHANGED" | "DEVICE_UNAVAILABLE" | "NO_FRESH_FRAME" | "CAPTURE_TIMEOUT" | "UPLOAD_FAILED" | "STORAGE_UNAVAILABLE" | "INTERRUPTED" | "ACTION_FAILED" | null;
  failure_reason: string | null;
  photo: RunPhotoReference | null;
}

export interface RunWaypointArrived {
  run_id: string;
  idx: number;
  waypoint_ref: string | null;
  mission_id: string;
  mission_version: number;
  mission_name: string;
  floor_id: string;
  map_version_id: string;
  pose: AgentPose;
  agent_instance_id: string;
  report_seq: number;
  monotonic_s: number;
}

export interface RunWaypointRecorded {
  run_id: string;
  idx: number;
  waypoint_ref: string | null;
  mission_id: string;
  mission_version: number;
  mission_name: string;
  floor_id: string;
  map_version_id: string;
  pose: AgentPose;
  agent_instance_id: string;
  report_seq: number;
  monotonic_s: number;
  results: RunDisplayResults | RunExecutedResults;
}

export interface Scenario {
  name: string;
  waypoints: ScenarioWaypoint[];
  finish: ScenarioFinish;
  notes: string;
  id: string;
  number: number;
  latest_version: number;
  version: number;
  floor_ids: string[];
  map_version_ids: string[];
  required_devices: string[];
  est_distance_m: number;
  created_by: string;
  created_at: string;
  version_created_by: string;
  version_created_at: string;
  archived_at: string | null;
}

export interface ScenarioFinish {
  mode?: "STAY" | "RETURN_TO_START" | "GO_TO";
  target?: ScenarioPoint | null;
}

export interface ScenarioList {
  items: Scenario[];
  next_cursor: string | null;
}

export interface ScenarioPoint {
  floor_id: string;
  map_version_id: string;
  x: number;
  y: number;
  yaw?: number;
  waypoint_ref?: string | null;
}

export interface ScenarioPreview {
  reachable: boolean;
  points: PreviewPoint[];
  segments: PreviewSegment[];
  floor_ids: string[];
  map_version_ids: string[];
  required_devices: string[];
  est_distance_m: number;
  distance_note: string;
}

export interface ScenarioWaypoint {
  floor_id: string;
  map_version_id: string;
  x: number;
  y: number;
  yaw?: number;
  waypoint_ref?: string | null;
  mission_id: string;
  mission_version: number;
}

export interface ScenarioWrite {
  name: string;
  waypoints: ScenarioWaypoint[];
  finish?: ScenarioFinish;
  notes?: string;
}

export interface ScreenCmd {
  id: string;
  /** 첫 메시지는 필수, 후속은 생략 가능; null은 거부한다. */
  proto?: "fh-rt/1";
  robot: string;
  t: "cmd";
  lease_id: string;
  seq: number;
  axes: number[];
}

export interface ScreenEnvelope {
  id: string;
  /** 첫 메시지는 필수, 후속은 생략 가능; null은 거부한다. */
  proto?: "fh-rt/1";
}

export interface ScreenLease {
  id: string;
  /** 첫 메시지는 필수, 후속은 생략 가능; null은 거부한다. */
  proto?: "fh-rt/1";
  robot: string;
  t: "lease.take" | "lease.request" | "lease.release" | "lease.cancel" | "hidden" | "stop";
}

export interface ScreenLeaseRequested {
  t: "lease.requested";
  robot: string;
  request_id: string;
  requester: Record<string, string>;
  expires_at: string;
}

export interface ScreenLeaseResult {
  t: "lease.result";
  robot: string;
  request_id: string | null;
  result: "ACCEPTED" | "DECLINED" | "TIMEOUT" | "CANCELED";
  error?: string | null;
}

export interface ScreenLeaseUpdate {
  t: "lease";
  robot: string;
  holder: Record<string, unknown> | null;
  lease_id?: string | null;
  since: string | null;
}

export interface ScreenPing {
  id: string;
  /** 첫 메시지는 필수, 후속은 생략 가능; null은 거부한다. */
  proto?: "fh-rt/1";
  t: "ping";
}

export interface ScreenReply {
  t: "reply";
  id: string;
  ok: boolean;
  error?: ErrorBody | null;
}

export interface ScreenRespond {
  id: string;
  /** 첫 메시지는 필수, 후속은 생략 가능; null은 거부한다. */
  proto?: "fh-rt/1";
  robot: string;
  t: "lease.respond";
  request_id: string;
  accept: boolean;
}

export interface ScreenRobot {
  id: string;
  /** 첫 메시지는 필수, 후속은 생략 가능; null은 거부한다. */
  proto?: "fh-rt/1";
  robot: string;
}

export interface ScreenServerPing {
  t: "ping";
  t_server: string;
}

export interface ScreenState {
  t: "state";
  robot: string;
  connection: "ONLINE" | "OFFLINE";
  status: "IDLE" | "TELEOP" | "RUNNING" | "PAUSED" | "STOP_LATCHED" | "ERROR" | null;
  battery: Battery | null;
  location: Location | null;
  devices: Device[];
  speed: number | null;
  latency_ms: number | null;
  latched: boolean | null;
  safety_reason?: "OUTPUT_STALLED" | null;
  stop_gen: number | null;
  applied: number[] | null;
}

export interface ScreenSub {
  id: string;
  /** 첫 메시지는 필수, 후속은 생략 가능; null은 거부한다. */
  proto?: "fh-rt/1";
  t: "sub";
  robots: string[];
  streams: ("state" | "rgb" | "depth" | "lidar" | "map")[];
}

export interface ScreenSubscriptionRevoked {
  t: "subscription.revoked";
  robot: string;
  reason: "ACCESS_REVOKED" | "ROBOT_DELETED";
}

export interface ScreenUnlock {
  id: string;
  /** 첫 메시지는 필수, 후속은 생략 가능; null은 거부한다. */
  proto?: "fh-rt/1";
  robot: string;
  t: "unlock";
  lease_id: string;
  stop_gen: number;
}

export interface SensorLogParams {
  device?: "rgb" | "depth" | "lidar" | "battery";
  seconds?: number;
}

export interface Session {
  id: string;
  client: "web" | "app";
  device_label: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  revoked_at: string | null;
}

export interface SessionInfo {
  client: "web" | "app";
  csrf_token: string | null;
}

export interface SessionList {
  items: Session[];
  next_cursor: string | null;
}

export interface SimCatalog {
  worlds: SimWorld[];
  slots: string[];
  max_robots: number;
  launcher: "fake" | "native-single";
  manager_instance_id: string | null;
}

export interface SimCleanupSlot {
  robot_id: string;
  owner_id: string;
  generation: number;
  can_recover: boolean;
}

export interface SimExpired {
  robot_id: string;
  owner_id: string;
  generation: number;
  reason: "time_limit";
}

export interface SimFailureDetail {
  reason: "resources_low" | "manager_unreachable" | "slot_busy" | "unknown";
  start_not_created?: boolean;
  mem_available_mib?: number | null;
  load1?: number | null;
  min_mem_available_mib?: number | null;
  max_load1?: number | null;
}

export interface SimMapBinding {
  world_id: "v5_building" | "warehouse";
  building_id: string;
  ros_building_id: string;
  ros_floor_id: "l1" | "l2" | "f1";
  ros_map_version: string;
  floor_id: string;
  map_version_id: string;
  sha256: string;
  source_pgm_sha256: string;
  resolution: number;
  origin: [number, number, number];
  width: number;
  height: number;
  source: "SIMULATION";
}

export interface SimProvision {
  world_id: string;
  spawn_floor_id?: "l1" | "l2" | null;
  robot_id: string;
  map_bindings?: SimMapBinding[];
  generation: number;
  owner_id: string;
  org_id: string;
  agent_token: string;
}

export interface SimRemoval {
  robot_id: string;
  generation: number;
  request_nonce: string;
  manager_instance_id: string;
  absent: boolean;
  startup_clean: boolean;
}

export interface SimRemove {
  generation: number;
  request_nonce: string;
}

export interface SimRobot {
  spawn_floor_id?: "l1" | "l2" | null;
  generation: number;
  robot_id: string;
  owner_id: string;
  world_id: string;
  simulation: true;
  state: "STARTING" | "PREPARED" | "RUNNING" | "STOPPING" | "ERROR";
  agent_address: string;
  namespace: string;
  tf_prefix: string;
  command_topic: string;
  launcher: "fake" | "native-single";
  expires_at: string | null;
  /** Manager monotonic runtime remaining at this response, in seconds. */
  remaining_s: number | null;
}

export interface SimRobotList {
  items: SimRobot[];
  expired: SimExpired[];
  cleanup: SimCleanupSlot[];
  manager_error: "SIM_DISABLED" | "SIM_UNAVAILABLE" | null;
}

export interface SimStartRequest {
  world_id: string;
  spawn_floor_id?: "l1" | "l2" | null;
  robot_id: string;
}

export interface SimWorld {
  map_id?: string | null;
  floors?: SimWorldFloor[];
  spawn_floor_ids?: ("l1" | "l2")[];
  id: string;
  name: string;
  description: string;
}

export interface SimWorldFloor {
  floor_id: string;
  name: string;
  floor_z: number;
  map_version_id: string;
  ros_floor_id?: string | null;
}

export interface SimWorldStart {
  world_id: string;
  spawn_floor_id?: "l1" | "l2" | null;
}

export interface SiteTree {
  items: MapSite[];
  next_cursor: null;
}

export interface StopRequest {
  request_id: string;
}

export interface StopRequestAck {
  stage: "PHONE_RECEIVED" | "HUMAN_CONFIRMED";
}

export interface StopRequestStatus {
  request_id: string;
  robot_id: string;
  status: "REQUESTED" | "PHONE_RECEIVED" | "HUMAN_CONFIRMED" | "STOP_CONFIRMED";
  message: string;
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
}

export interface User {
  id: string;
  username: string;
  display_name: string;
  role: "ORG_ADMIN" | "OPERATOR";
  locked: boolean;
  robot_ids: string[];
  created_at: string;
}

export interface UserCreate {
  username: string;
  display_name: string;
  role: "ORG_ADMIN" | "OPERATOR";
  temp_password: string;
}

export interface UserList {
  items: User[];
  next_cursor: string | null;
}

export interface UserPatch {
  display_name?: string;
  role?: "ORG_ADMIN" | "OPERATOR";
  locked?: boolean;
}

export interface WaitParams {
  seconds?: number;
}

export type ScenarioTargetErrorCode = "SIM_MAP_REQUIRES_SIM_ROBOT";
export type RunStatus = "QUEUED" | "PREPARING" | "MOVING" | "AT_WAYPOINT" | "PERFORMING" | "WAIT_CONFIRM" | "PAUSED" | "COMPLETED" | "FAILED" | "CANCELED";
export type RunRecordStatus = "QUEUED" | "PREPARING" | "MOVING" | "AT_WAYPOINT" | "PERFORMING" | "WAIT_CONFIRM" | "PAUSED" | "COMPLETED" | "FAILED" | "CANCELED" | "ABORTED";
export type RunWaitReason = "LINK_LOST" | "STOPPED_BY_USER" | "RECORDING_UNAVAILABLE";
export type RunFailCode = "NAV_GOAL_REJECTED" | "NAV_TIMEOUT" | "LOCALIZATION_LOST" | "BATTERY_LOW" | "DEVICE_MISSING" | "OPERATOR_ABORT" | "PAUSE_TIMEOUT" | "FLOOR_TRANSITION_FAILED" | "NAV_UNAVAILABLE" | "MAP_VERSION_MISMATCH" | "FLOOR_TRANSITION_UNSUPPORTED" | "PLAN_UNAVAILABLE" | "RECORDING_REJECTED";
export type RunRejectCode = "NOT_CONTROLLER" | "FORBIDDEN" | "RUN_ACTIVE" | "RUN_CONFLICT" | "RUN_NOT_FOUND" | "RUN_STATE_CONFLICT" | "RUN_OWNER_MISMATCH" | "RESUME_REJECTED" | "UNSUPPORTED_OPERATION" | "RECORDING_UNAVAILABLE" | "NAV_UNAVAILABLE" | "MAP_VERSION_MISMATCH" | "FLOOR_TRANSITION_UNSUPPORTED" | "PLAN_UNAVAILABLE";
export type RunReportTransientCode = "RUN_REPORT_SEQUENCE" | "RUN_REPORT_STORAGE";
export type RunReportPermanentCode = "RUN_REPORT_OWNER" | "RUN_REPORT_MAP" | "RUN_REPORT_PLAN" | "RUN_REPORT_STATE" | "RUN_REPORT_STEP" | "RUN_REPORT_PROVENANCE" | "RUN_REPORT_CONFLICT" | "RUN_REPORT_INSTANCE" | "RUN_REPORT_ROBOT" | "RUN_REPORT_NOT_FOUND" | "RUN_REPORT_INVALID";
export type ScreenMessage = ScreenSub | ScreenLease | ScreenRespond | ScreenCmd | ScreenUnlock | ScreenPing;
export type AgentMessage = AgentHello | AgentState | AgentPing | AgentEvent | AgentRunUpdate | AgentCmdAck | AgentMedia | AgentPhoneRevokeAck;
export type PhoneMessage = PhoneHello | PhoneLease | PhoneStop | PhoneRespond | PhoneCommand | PhoneUnlock | PhonePing | PhoneRunStart | PhoneRunStartV2 | PhoneRunControl | PhoneRunConfirm;
export type ServerAgentMessage = AgentLease | AgentCommand | AgentStop | AgentUnlock | AgentServerPing | AgentStreams | AgentPhoneRevoke | RunRecorded | RunReportRejected;
export type MediaMessage = MediaVideoFrame | MediaPointCloudHeader | MediaStatus;
export type MediaChannel = "rgb" | "external" | "lidar";
export type MediaSource = "d435i_rgb" | "go2_front" | "gazebo_external" | "l1";
export type ExecutionCapabilityKey = "wait" | "photo.rgb" | "photo.depth" | "operator_confirm" | "sensor_log.rgb" | "sensor_log.depth" | "sensor_log.lidar" | "sensor_log.battery";
