// 생성물 · 수정 금지 — 정본 apps/contracts/models.py, 생성 apps/contracts/generate.py
// 타입일 뿐 런타임 검증이 아니다. 의미 정의: docs/spec/05-API-SPEC.md

export const CONTRACT_VERSION = "fh-api/1";

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

export interface Battery {
  soc: number;
  updated_at: string;
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
  status: "APPROVED" | "SUPERSEDED" | "PENDING" | "REJECTED";
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

export type ScreenMessage = ScreenSub | ScreenLease | ScreenRespond | ScreenCmd | ScreenUnlock | ScreenPing;
export type AgentMessage = AgentHello | AgentState | AgentPing | AgentEvent | AgentRunUpdate | AgentCmdAck | AgentMedia;
