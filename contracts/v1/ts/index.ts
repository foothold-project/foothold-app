// 생성물 · 수정 금지 — 정본 contracts/v1/models.py, 생성 tools/generate_contracts.py
// 타입일 뿐 런타임 검증이 아니다. 의미 정의: contracts/v1/CONTRACT.md

export const CONTRACT_VERSION = "fh-app/1";

export interface ApiError {
  error: string;
  cur?: ZoneEnv | TmplEnv | MissionEnv | RunEnv | NoteEnv | null;
}

export interface DocDel {
  op: "del";
  id: string;
  rev: number;
}

export interface DocDelOk {
  ok: true;
  id: string;
  kind: "zone" | "tmpl" | "mission" | "run" | "note";
  name: string;
}

export interface DocPut {
  op: "put";
  kind?: "zone" | "tmpl" | "mission" | "run" | "note" | null;
  id?: string | null;
  rev?: number | null;
  doc: Zone | Tmpl | Mission | Run | Note;
}

export interface DocPutOk {
  ok: true;
  id: string;
  rev: number;
  kind: "zone" | "tmpl" | "mission" | "run" | "note";
  name: string;
  new: boolean;
}

export interface DocsList {
  docs: (ZoneEnv | TmplEnv | MissionEnv | RunEnv | NoteEnv)[];
  rev: number;
  broken: string | null;
}

export interface Event {
  t: string;
  st: "ok" | "warn" | "bad";
  text: string;
}

export interface LiveGrid {
  seq: number;
  w: number;
  h: number;
  res: number;
  origin: number[];
}

export interface LiveMap {
  st: "off" | "stale" | "unknown" | "reset" | "wait" | "bad" | "ok";
  why: string;
  age_s?: number | null;
  world_id?: "v5_single" | "v5_building" | "rooms_a" | null;
  building_id?: "v5" | "v5_single" | "rooms_a" | null;
  floor_id?: "f1" | "l1" | "l2" | null;
  mode?: "slam" | "static" | null;
  map_source?: "slam" | "gt_raster" | null;
  map_version?: string | null;
  epoch?: number | null;
  sim_t?: number | null;
  scan?: Record<string, unknown> | null;
  slam?: string | null;
  last_save?: LiveSave | null;
  grid?: LiveGrid | null;
  pose?: LivePose | null;
  pose_why?: string | null;
}

export interface LivePose {
  x: number;
  y: number;
  yaw: number;
  source: "slam_tf" | "gt_identity";
}

export interface LiveSave {
  ok: boolean;
  map_version: string | null;
  reason: string;
  epoch: number | null;
}

export interface MapData {
  world_id: "v5_single" | "v5_building" | "rooms_a";
  building_id: "v5" | "v5_single" | "rooms_a";
  floor_id: "f1" | "l1" | "l2";
  map_version: string;
  map_source: "slam" | "gt_raster";
  epoch: number | null;
  resolution: number;
  origin: number[];
  width: number;
  height: number;
  saved_sim_t: number | null;
  png: string;
}

export interface MapInfo {
  world_id: "v5_single" | "v5_building" | "rooms_a";
  building_id: "v5" | "v5_single" | "rooms_a";
  floor_id: "f1" | "l1" | "l2";
  map_version: string;
  map_source: "slam" | "gt_raster";
  epoch: number | null;
  resolution: number;
  origin: number[];
  width: number;
  height: number;
  saved_sim_t: number | null;
}

export interface MapLedger {
  used: number;
  max: number;
  keys: string[];
}

export interface MapSaveState {
  ok: boolean;
  why: string;
  busy: boolean;
}

export interface MapStartState {
  ok: boolean;
  why: string;
  busy: boolean;
  ledger: MapLedger | null;
  session: Record<string, unknown> | null;
  last: SimStopLast | null;
}

export interface MediaEvent {
  t: string;
  st: "ok" | "warn" | "bad";
  text: string;
  at: string;
}

export interface MediaList {
  photos: PhotoMeta[];
  events: MediaEvent[];
  ver: string;
}

export interface Mission {
  name: string;
  tmpl: string;
  memo: string;
  wps: Waypoint[];
}

export interface MissionEnv {
  id: string;
  rev: number;
  by: string;
  at: string;
  kind: "mission";
  doc: Mission;
}

export interface Note {
  photo: string;
  cls: "확인" | "보류" | "제외";
  memo: string;
}

export interface NoteEnv {
  id: string;
  rev: number;
  by: string;
  at: string;
  kind: "note";
  doc: Note;
}

export interface OpCmd {
  op: "cmd";
  fx: number;
  fy: number;
  fw: number;
}

export interface OpMapGet {
  op: "map_get";
  rid?: number | null;
  building_id: "v5" | "v5_single" | "rooms_a";
  floor_id: "f1" | "l1" | "l2";
  map_version: string;
}

export interface OpMapStart {
  op: "map_start";
  rid?: number | null;
  world_id: "v5_single" | "v5_building" | "rooms_a";
  floor_id: "f1" | "l1" | "l2";
  mode: "slam" | "static";
  map_version?: string | null;
}

export interface OpRid {
  op: "photo" | "sim_start" | "sim_stop" | "map_list" | "map_live_get" | "map_save";
  rid?: number | null;
}

export interface OpSimple {
  op: "take" | "release" | "stop" | "resume" | "reset" | "hidden";
}

export interface PhotoMeta {
  frame_at: string;
  frame_stamp_sim_s: number | null;
  episode: number | null;
  by: string;
  source: string | null;
  x: number | null;
  y: number | null;
  yaw: number | null;
  gt_note: string;
  gt_age_s: number;
  camera: string;
  saved_at: string;
  bytes: number;
  url: string;
}

export interface Reply {
  op: "reply";
  rid: number | null;
  ok: boolean;
  text: string;
  photo?: PhotoMeta | null;
  maps?: MapInfo[] | null;
  map?: MapData | null;
  live?: Record<string, unknown> | null;
}

export interface Run {
  mode: "수동";
  mission: string;
  tmpl: string;
  name: string;
  status: "진행" | "완료" | "실패" | "중단";
  started: string;
  ended: string;
  memo: string;
  wps: RunWaypoint[];
}

export interface RunEnv {
  id: string;
  rev: number;
  by: string;
  at: string;
  kind: "run";
  doc: Run;
}

export interface RunWaypoint {
  x: number;
  y: number;
  name: string;
  mods: ("사진" | "운영자 확인" | "대기")[];
  st: "대기" | "방문" | "미방문";
  at: string;
  why: string;
  chk: "" | "확인" | "보류" | "제외";
  photos: string[];
}

export interface SimSession {
  result: "running" | "starting" | "idle" | null;
  reason: string | null;
  started_at: string | null;
  ends_at: string | null;
  remaining_s: number | null;
}

export interface SimStartLast {
  t: string;
  st: "ok" | "bad";
  text: string;
}

export interface SimStartLedger {
  used: number;
  max: number;
}

export interface SimStartState {
  ok: boolean;
  why: string;
  busy: boolean;
  session: SimSession | null;
  ledger?: SimStartLedger | null;
  last?: SimStartLast | null;
}

export interface SimState {
  episode: number;
  stop_requested: boolean;
  reset_in_progress: boolean;
  policy_running: boolean;
  sim_t: number | null;
  x: number | null;
  y: number | null;
  z: number | null;
  yaw: number | null;
  vx: number | null;
  vy: number | null;
  wz: number | null;
  tilt_deg: number | null;
  rtf: number | null;
  cmd_age_s: number | null;
  ttl_s: number | null;
  fallen: boolean | null;
  body_still: boolean | null;
  resume_wait: boolean | null;
  ttl_expired: boolean | null;
  cmd_tested: boolean | null;
  fallback_active: boolean | null;
  online_ready: boolean | null;
  safe_fallback_verified: boolean | null;
  source: string | null;
  terrain_input: string | null;
  camera: string | null;
  plugin_mode: string | null;
  cmd_applied: number[] | null;
}

export interface SimStopLast {
  t: string;
  st: "ok" | "bad";
  text: string;
}

export interface SimStopState {
  ok: boolean;
  why: string;
  busy: boolean;
  on: boolean;
  ledger_left: number | null;
  ledger_kind?: "online" | "map" | null;
  last: SimStopLast | null;
}

export interface Status {
  op: "status";
  role: "control" | "view_other" | "view";
  latch: boolean;
  applied: number[];
  reason: string;
  sim_block: string;
  resume_pending: boolean;
  reset_pending: boolean;
  episode: number | null;
  ros_domain: string | null;
  state_age: number | null;
  cam_age: number | null;
  sim: SimState | null;
  events: Event[];
  note: string;
  me: string;
  holder: string | null;
  ver: string;
  sim_start: SimStartState;
  docs_rev: number;
  sim_stop?: SimStopState | null;
  live_map?: LiveMap | null;
  map_start?: MapStartState | null;
  map_save?: MapSaveState | null;
}

export interface Tmpl {
  name: string;
  desc: string;
  mods: TmplMod[];
}

export interface TmplEnv {
  id: string;
  rev: number;
  by: string;
  at: string;
  kind: "tmpl";
  doc: Tmpl;
}

export interface TmplMod {
  type: "사진" | "운영자 확인" | "대기";
  detail: string;
}

export interface Waypoint {
  x: number;
  y: number;
  name: string;
  mods: ("사진" | "운영자 확인" | "대기")[];
}

export interface Zone {
  name: string;
  type: "금지" | "감속";
  pts: number[][];
}

export interface ZoneEnv {
  id: string;
  rev: number;
  by: string;
  at: string;
  kind: "zone";
  doc: Zone;
}

export type ClientOp = OpSimple | OpCmd | OpRid | OpMapGet | OpMapStart;
export type ServerMsg = Status | Reply;
export type DocEnvelope = ZoneEnv | TmplEnv | MissionEnv | RunEnv | NoteEnv;
export type DocWrite = DocPut | DocDel;
