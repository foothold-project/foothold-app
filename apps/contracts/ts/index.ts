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
}

export interface AgentHello {
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

export interface AgentPing {
  t: "ping";
}

export interface AgentPose {
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
  status: string;
  step: number;
  progress: Progress | null;
  path_deviation_m?: number | null;
  fail_code?: string | null;
}

export interface AgentServerPing {
  t: "ping";
  t_server: string;
}

export interface AgentState {
  t: "state";
  pose: AgentPose;
  speed: number | null;
  battery: AgentBattery;
  latched: boolean;
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
  kind: "MAP_REVISION" | "MAP_ROLLBACK";
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

export interface ApprovalDetail {
  id: string;
  kind: "MAP_REVISION" | "MAP_ROLLBACK";
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
  preview: ApprovalMapPreview;
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
  type: "map_version";
  id: string;
}

export interface ApprovalReject {
  reason: string;
}

export interface Battery {
  soc: number;
  updated_at: string;
}

export interface ConfirmParams {
  prompt?: string;
}

export interface CurrentRun {
  id: string;
  status: "QUEUED" | "PREPARING" | "MOVING" | "AT_WAYPOINT" | "PERFORMING" | "PAUSED" | "WAIT_CONFIRM" | "COMPLETED" | "FAILED" | "ABORTED";
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

export interface FloorCreate {
  name: string;
  level: number;
}

export interface FloorPatch {
  name?: string;
  level?: number;
}

export type JsonValue = unknown;

export interface Lease {
  holder_type: "USER" | "RUN";
  user: Person | null;
  since: string;
}

export interface Location {
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
  id: string;
  name: string;
  buildings: MapBuilding[];
}

export interface MapUpload {
  upload_id: string;
  sha256: string;
}

export interface MapVersion {
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
  t: "lease.take" | "lease.request" | "lease.release" | "lease.cancel" | "view" | "stop";
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
  vx_min: number;
  vx_max: number;
  vy_min: number;
  vy_max: number;
  wz_min: number;
  wz_max: number;
  commands: number[][];
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

export interface PhonePosture {
  z: number | null;
  tilt_deg: number | null;
  fallen: boolean | null;
  body_still: boolean | null;
}

export interface PhoneReply {
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

export interface PhoneState {
  t: "state";
  pose: AgentPose;
  speed: number | null;
  battery: AgentBattery;
  latched: boolean;
  stop_gen: number;
  stop_ref: number;
  applied: number[];
  mode: string;
  devices_changed?: Device[] | null;
  /** 소문자 하이픈 UUID 표준형만 허용한다. */
  robot: string;
  controller: string | null;
  controller_device: string | null;
  controller_connected: boolean;
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

export interface PhoneTicketClaims {
  iss: "fh-control";
  aud: "fh-phone/1";
  org: string;
  /** 소문자 하이픈 UUID 표준형만 허용한다. */
  robot: string;
  sub: string;
  device: string;
  purpose: "control" | "view";
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

export interface SiteTree {
  items: MapSite[];
  next_cursor: null;
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

export type ScreenMessage = ScreenSub | ScreenLease | ScreenRespond | ScreenCmd | ScreenUnlock | ScreenPing;
export type AgentMessage = AgentHello | AgentState | AgentPing | AgentEvent | AgentRunUpdate | AgentCmdAck | AgentMedia;
export type PhoneMessage = PhoneHello | PhoneLease | PhoneRespond | PhoneCommand | PhoneUnlock | PhonePing;
