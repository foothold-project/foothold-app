// 리허설 설계도(scene) — API.md `/api/rehearsal` R1 의 형·상한·호출. 계획 작성·2D 기하 검토·파일 생성만(Gazebo·ROS·로봇 명령 0).
// 서버 검증이 정본이다. 여기 checkScene 은 «화면 계산» 편의 검사(서버가 저장·분석 때 다시 검사).
import { T, type Res } from './transport';
import { httpTxt } from './shared';
import { saveBlob } from './fmt';

// ---- 형 (API.md 3절 그대로 — 키를 더하거나 빼지 않는다: 서버가 모르는 키·빠진 키를 거부) ----
export type Vec2 = [number, number];
export type Pose2 = [number, number, number];
export interface Floor { id: string; name: string; z: number; height: number }
export interface Wall { id: string; type: 'wall'; floor: string; a: Vec2; b: Vec2; thickness: number; height: number }
export interface Box { id: string; type: 'box'; floor: string; center: Vec2; size: [number, number, number]; yaw: number }
export interface Stairs { id: string; type: 'stairs'; floor: string; to_floor: string; start: Vec2; yaw: number; steps: number; riser: number; tread: number; width: number }
export type Element = Wall | Box | Stairs;
export type SensorKind = 'lidar_l1' | 'lidar_l2' | 'lidar_unknown' | 'camera' | 'depth';
export interface Sensor { id: string; kind: SensorKind; mount: [number, number, number, number] }
export interface Robot { id: string; name: string; model: 'go2_proxy'; floor: string; pose: Pose2; sensors: Sensor[] }
export type EquipKind = 'camera_fixed' | 'relay' | 'marker' | 'other';
export interface Equip { id: string; kind: EquipKind; floor: string; pose: Pose2; label: string }
export interface Route { id: string; robot: string; floor: string; points: Vec2[] }
export interface Scenario { id: string; name: string; robots: string[]; routes: string[] }
export interface Background { mime: 'image/png' | 'image/jpeg'; data_b64: string; floor: string; ref_px: [Vec2, Vec2]; ref_m: [Vec2, Vec2] }
export interface Scene {
  schema: 'fh_rehearsal_scene/1'; name: string;
  world: { origin: Vec2; size: Vec2; resolution: 0.05; background: Background | null };
  floors: Floor[]; elements: Element[]; robots: Robot[]; equipment: Equip[]; routes: Route[]; scenarios: Scenario[];
}
export interface ProjectMeta { id: string; name: string; rev: number; sha256: string; at: string; by: string; bytes: number; counts: { floors: number; elements: number; robots: number; routes: number; scenarios: number } }
export interface Issue { level: 'error' | 'warn'; code: string; path: string; msg: string; at?: Vec2; floor?: string }
export interface Analysis {
  ok: boolean; issues: Issue[]; truncated: boolean;
  floors: { id: string; free: number; blocked: number; no_floor: number }[];
  routes: { id: string; robot: string; length_m: number; blocked_segments: number[]; unreachable_points: number[] }[];
  crossings: { scenario: string; a: string; b: string; at: Vec2 }[];
  note: string;
}
export type Exported = { filename: string; mime: 'application/zip'; base64: string; sha256: string; bytes: number; project: ProjectMeta };

// ---- 상한 (API.md 1절 · root 최종 용량 기준) ----
export const RLIM = { req: 262144, scene: 245760, bg: 131072, cells: 8_000_000, stairsPerFloor: 16, routePtsTotal: 2000, bgPx: 4096, zip: 655360, floors: 8, elements: 1500, robots: 12, sensors: 6, equip: 200,
  routes: 48, routePts: 200, scenarios: 12, worldMin: 2, worldMax: 100, name: 60 } as const;
export const ID_RE = /^[a-z][a-z0-9_]{0,31}$/;
export const RES = 0.05;
export const STAIRS_TAG = 'Gazebo 에서 계단 오르기는 확인됨 · 이 치수는 미검증';
export const SENSOR_TAG = '라이다 종류(L1/L2) 미정 · 사양 미확인';
export const MODEL_TAG = '배치용 로봇 모형 · 보행 미검증';
export const EXPORT_NOTE = '이 묶음은 파일입니다 · Gazebo 기동은 사용자가 합니다 · 계단 치수·모형 보행은 미검증';
export const PLAN_NOTE = '계획 · 2D 기하 검토 — 물리·넘어짐·실제 도달 판정 아님';
export const SENSOR_KO: Record<SensorKind, string> = { lidar_l1: '라이다 L1', lidar_l2: '라이다 L2', lidar_unknown: '라이다(미정)', camera: '카메라', depth: '깊이 카메라' };
export const EQUIP_KO: Record<EquipKind, string> = { camera_fixed: '고정 카메라', relay: '통신 중계기', marker: '표지', other: '기타' };

const enc = new TextEncoder();
export const bytesOf = (v: unknown) => enc.encode(JSON.stringify(v)).length;
export const kib = (n: number) => (n / 1024).toFixed(1);
/** JSON 파일 내보내기 = 들여쓰기 없는 JSON(바이트 = bytesOf). scene ≤240 KiB 면 파일도 ≤240 KiB → 가져오기 256 KiB 안 왕복 보장(root 10-18) */
export const sceneJson = (s: Scene) => JSON.stringify(s);

// ---- 호출 (Transport 경유 — 웹 fetch / 앱 rehearsal.get·post. 자동 재시도 0) ----
export type RRes<D> = { ok: true; data: D } | { ok: false; code: number; error: string; issues: Issue[]; cur?: { rev: number; sha256: string } };
export function parseRes<D>(r: Res): RRes<D> {
  let j: any = null;
  try { j = JSON.parse(r.body); } catch { return { ok: false, code: r.status, error: `응답을 읽지 못함 (HTTP ${r.status})`, issues: [] }; }
  if (r.status === 200 && j && typeof j === 'object' && !Array.isArray(j) && !('error' in j)) return { ok: true, data: j as D };
  return { ok: false, code: r.status, error: typeof j?.error === 'string' && j.error ? `${j.error} (HTTP ${r.status})` : httpTxt(r.status),
    issues: Array.isArray(j?.issues) ? j.issues : [], cur: j?.cur && typeof j.cur.rev === 'number' ? j.cur : undefined };
}
// root 10-18: 보낸 뒤 시간 초과·수신 실패는 «실제로는 저장됐을 수 있음» — 안 보냈다고 단정 0. «보내지 않음»은 용량 사전 거부처럼 호출 0이 확실할 때만
export const UNSURE = '요청 결과를 확인하지 못함 · 초안은 유지됩니다. 서버의 최신 판을 확인하세요';
const failed = (e: unknown): RRes<never> => ({ ok: false, code: 0, error: `${UNSURE} · ${(e as any)?.message || e}`, issues: [] });
/** 200 이어도 모양이 다르면 쓰지 않음(그리다 죽거나 잘못 저장 0). 결과 = 이유 또는 null */
export type Shape = (d: any) => string | null;
const withShape = <D,>(r: RRes<D>, sh?: Shape): RRes<D> => { if (!r.ok || !sh) return r; const w = sh(r.data); return w ? { ok: false, code: 200, error: `서버 응답 모양이 맞지 않아 쓰지 않음 · ${w} · ${UNSURE}`, issues: [] } : r; };
export async function rcall<D>(body: Record<string, unknown>, sh?: Shape, t: Pick<typeof T, 'postRehearsal'> = T): Promise<RRes<D>> {
  const n = bytesOf(body);
  if (n > RLIM.req) return { ok: false, code: 413, error: `요청이 256 KiB 를 넘어 보내지 않았습니다(${kib(n)} KiB) · 도면 배경을 줄이세요`, issues: [] };
  try { return withShape(parseRes<D>(await t.postRehearsal(body)), sh); } catch (e) { return failed(e); }
}
export type Listing = { projects: ProjectMeta[]; damaged?: string[]; broken?: string };
// 목록은 HTTP 200 이어도 저장소 이상(broken) · 일부 손상(damaged)일 수 있음 — 빈 목록·503 과 따로 보임(root 10-18)
export const brokenTxt = (d: Listing) => (d.broken !== undefined ? `리허설 저장소 이상 · 목록을 읽지 못했고 저장·지우기도 되지 않습니다(서버 응답 200 · 저장소 상태) · 원문: ${d.broken}` : null);
export const damagedTxt = (d: Listing) => (d.damaged?.length ? `손상된 프로젝트 ${d.damaged.length}개는 열 수 없어 목록에서 빠졌습니다(${d.damaged.join(', ')}) · 나머지 ${d.projects.length}개는 정상` : null);
export async function listProjects(t: Pick<typeof T, 'get'> = T): Promise<RRes<Listing>> {
  try { return withShape(parseRes<Listing>(await t.get('rehearsal')), SH.list); } catch (e) { return failed(e); }
}

// ---- 응답·파일 모양 검사(최소 — 타입·필수 배열·sha 형식. 값 범위 정본은 서버 · 화면 편의 검사는 checkScene) ----
const isS = (v: unknown) => typeof v === 'string', isN = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const isV = (v: any, n = 2) => Array.isArray(v) && v.length === n && v.every(isN);
const isSA = (v: unknown) => Array.isArray(v) && v.every(isS), isNA = (v: unknown) => Array.isArray(v) && v.every(isN);
const SHA = /^[0-9a-f]{64}$/;
const bad = (what: string, i: number, k: string) => `${what}[${i}] ${k} 형식 아님`;
function eachOk(a: any[], what: string, f: (x: any) => string | null): string | null {
  for (let i = 0; i < a.length; i++) { const x = a[i]; if (!x || typeof x !== 'object' || Array.isArray(x)) return `${what}[${i}] 객체 아님`; const w = f(x); if (w) return bad(what, i, w); }
  return null;
}
const SK = ['lidar_l1', 'lidar_l2', 'lidar_unknown', 'camera', 'depth'], EK = ['camera_fixed', 'relay', 'marker', 'other'];
/** 장면 모양(엄격 9키 + 항목별 필드 타입). 통과해야 그림·검사 함수가 안전 */
export function sceneShape(j: any): string | null {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return '최상위가 객체가 아닙니다';
  if (j.schema !== 'fh_rehearsal_scene/1') return `알 수 없는 형식 «${String(j.schema).slice(0, 40)}» — fh_rehearsal_scene/1 만`;
  const miss = KEYS.filter((k) => !(k in j)), extra = Object.keys(j).filter((k) => !KEYS.includes(k));
  if (miss.length || extra.length) return `키가 맞지 않음${miss.length ? ` · 빠짐: ${miss.join(', ')}` : ''}${extra.length ? ` · 모르는 키: ${extra.slice(0, 5).join(', ')}` : ''}`;
  for (const k of KEYS.slice(3)) if (!Array.isArray(j[k])) return `«${k}» 가 목록이 아닙니다`;
  const w = j.world;
  if (!isS(j.name) || !w || typeof w !== 'object' || !isV(w.origin) || !isV(w.size) || w.resolution !== RES) return '«world» 모양이 맞지 않습니다(origin·size·resolution 0.05·background)';
  const b = w.background;
  if (b !== null && (!b || typeof b !== 'object' || !['image/png', 'image/jpeg'].includes(b.mime) || !isS(b.data_b64) || !isS(b.floor) || !Array.isArray(b.ref_px) || !Array.isArray(b.ref_m)
    || b.ref_px.length !== 2 || b.ref_m.length !== 2 || ![...b.ref_px, ...b.ref_m].every((v: any) => isV(v)))) return '«world.background» 모양이 맞지 않습니다';
  if (!j.floors.length) return '«floors» 가 비었습니다(1층 이상)';
  return eachOk(j.floors, 'floors', (x) => (!isS(x.id) || !isS(x.name) ? 'id·name' : !isN(x.z) || !isN(x.height) ? 'z·height' : null))
    || eachOk(j.elements, 'elements', (x) => !isS(x.id) || !isS(x.floor) ? 'id·floor'
      : x.type === 'wall' ? (isV(x.a) && isV(x.b) && isN(x.thickness) && isN(x.height) ? null : 'wall')
      : x.type === 'box' ? (isV(x.center) && isV(x.size, 3) && isN(x.yaw) ? null : 'box')
      : x.type === 'stairs' ? (isS(x.to_floor) && isV(x.start) && [x.yaw, x.steps, x.riser, x.tread, x.width].every(isN) ? null : 'stairs') : 'type')
    || eachOk(j.robots, 'robots', (x) => !isS(x.id) || !isS(x.name) || !isS(x.floor) || x.model !== 'go2_proxy' || !isV(x.pose, 3) ? 'id·name·floor·model·pose'
      : !Array.isArray(x.sensors) ? 'sensors' : eachOk(x.sensors, 'sensors', (q) => (isS(q.id) && SK.includes(q.kind) && isV(q.mount, 4) ? null : 'id·kind·mount')))
    || eachOk(j.equipment, 'equipment', (x) => (isS(x.id) && EK.includes(x.kind) && isS(x.floor) && isV(x.pose, 3) && isS(x.label) ? null : 'id·kind·floor·pose·label'))
    || eachOk(j.routes, 'routes', (x) => (isS(x.id) && isS(x.robot) && isS(x.floor) && Array.isArray(x.points) && x.points.every((p: any) => isV(p)) ? null : 'id·robot·floor·points'))
    || eachOk(j.scenarios, 'scenarios', (x) => (isS(x.id) && isS(x.name) && isSA(x.robots) && isSA(x.routes) ? null : 'id·name·robots·routes'))
    || drawBounds(j);
}
// ---- 그리기 유한 실행 범위(715 U1): 유한수·256 KiB 만으로는 Canvas 반복이 끝난다는 보장이 없음(origin 1e20 → x+step===x 무한 반복, 큰 steps → 긴 정지).
//   서버 validate 범위(원점 ±10000 · 세계 2–100 m · 개수 상한 · 계단 단 정수 2–40 · 상자 0.05–50 m) 밖은 가져오기·불러오기 모두 채택 0 → 지금 초안 유지. 정본 검사는 그대로 서버.
const inR = (v: unknown, lo: number, hi: number) => isN(v) && (v as number) >= lo && (v as number) <= hi;
const CO = 20000, inC = (q: number[]) => q.every((v) => Math.abs(v) <= CO);   // 좌표 절댓값(원점 ±10000 + 세계 100 m 를 넉넉히 덮음)
function drawBounds(j: any): string | null {
  const w = j.world;
  if (!w.origin.every((v: number) => Math.abs(v) <= 10000) || !w.size.every((v: number) => inR(v, RLIM.worldMin, RLIM.worldMax))) return '«world» 원점(±10000 m)·크기(가로·세로 2–100 m) 범위 밖';
  const lim: [string, number][] = [['floors', RLIM.floors], ['elements', RLIM.elements], ['robots', RLIM.robots], ['equipment', RLIM.equip], ['routes', RLIM.routes], ['scenarios', RLIM.scenarios]];
  for (const [k, n] of lim) if (j[k].length > n) return `«${k}» ${j[k].length}개 — ${n}개까지`;
  const nm = (x: any) => String(x.id).slice(0, 32);
  for (const e of j.elements) {
    if (e.type === 'stairs' && !(Number.isInteger(e.steps) && inR(e.steps, 2, 40) && inR(e.tread, 0.15, 0.6) && inR(e.width, 0.5, 4))) return `계단 «${nm(e)}»: 단 수(정수 2–40)·단 너비(0.15–0.6 m)·폭(0.5–4 m) 범위 밖`;
    if (e.type === 'box' && !e.size.every((v: number) => inR(v, 0.05, 50))) return `상자 «${nm(e)}»: 크기(0.05–50 m) 범위 밖`;
    if (!inC(e.type === 'wall' ? [...e.a, ...e.b] : e.type === 'box' ? e.center : e.start)) return `요소 «${nm(e)}»: 좌표가 ±${CO} m 밖`;
  }
  for (const r of j.robots) { if (r.sensors.length > RLIM.sensors) return `로봇 «${nm(r)}»: 센서 ${r.sensors.length}개 — ${RLIM.sensors}개까지`; if (!inC(r.pose.slice(0, 2))) return `로봇 «${nm(r)}»: 좌표가 ±${CO} m 밖`; }
  for (const e of j.equipment) if (!inC(e.pose.slice(0, 2))) return `장비 «${nm(e)}»: 좌표가 ±${CO} m 밖`;
  for (const r of j.routes) if (r.points.length > RLIM.routePts || !r.points.every(inC)) return `경로 «${nm(r)}»: 점 ${RLIM.routePts}개까지 · 좌표 ±${CO} m 안`;
  return null;
}
const metaShape = (m: any) => !m || typeof m !== 'object' ? 'project 없음' : !isS(m.id) || !isS(m.name) ? 'project id·name' : !(Number.isInteger(m.rev) && m.rev >= 1) ? 'project rev'
  : !SHA.test(String(m.sha256)) ? 'project sha256' : !isN(m.bytes) || !m.counts || typeof m.counts !== 'object' ? 'project bytes·counts' : null;
const issuesShape = (a: any, k: string) => !Array.isArray(a) ? `${k} 가 목록이 아님` : eachOk(a, k, (x) => (['error', 'warn'].includes(x.level) && isS(x.msg) && isS(x.code) ? null : 'level·code·msg'));
export const SH: Record<'list' | 'get' | 'put' | 'del' | 'analyze' | 'export', Shape> = {
  list: (d) => !Array.isArray(d.projects) ? 'projects 가 목록이 아님' : d.projects.map(metaShape).find(Boolean) || (d.damaged !== undefined && !isSA(d.damaged) ? 'damaged' : null) || (d.broken !== undefined && !isS(d.broken) ? 'broken' : null),
  get: (d) => metaShape(d.project) || sceneShape(d.scene),
  put: (d) => metaShape(d.project) || (typeof d.new !== 'boolean' ? 'new' : issuesShape(d.warnings, 'warnings')),
  del: (d) => (isS(d.id) && d.deleted === true ? null : 'id·deleted'),
  analyze: (d) => typeof d.ok !== 'boolean' || typeof d.truncated !== 'boolean' || !isS(d.note) ? 'ok·truncated·note' : issuesShape(d.issues, 'issues')
    || (!Array.isArray(d.floors) ? 'floors' : null)
    || (!Array.isArray(d.routes) ? 'routes' : eachOk(d.routes, 'routes', (x) => (isS(x.id) && isS(x.robot) && isN(x.length_m) && isNA(x.blocked_segments) && isNA(x.unreachable_points) ? null : 'id·robot·length_m·blocked·unreachable')))
    || (!Array.isArray(d.crossings) ? 'crossings' : eachOk(d.crossings, 'crossings', (x) => (isS(x.scenario) && isS(x.a) && isS(x.b) && isV(x.at) ? null : 'scenario·a·b·at'))),
  export: (d) => !isS(d.filename) || d.mime !== 'application/zip' || !isS(d.base64) ? 'filename·mime·base64' : !SHA.test(String(d.sha256)) ? 'sha256' : !(Number.isInteger(d.bytes) && d.bytes > 0) ? 'bytes' : metaShape(d.project),
};

// ---- 새 설계도 (예시 값 0 — 빈 1층 20×20 m) ----
export const blankScene = (name = '새 설계도'): Scene => ({
  schema: 'fh_rehearsal_scene/1', name, world: { origin: [0, 0], size: [20, 20], resolution: RES, background: null },
  floors: [{ id: 'f1', name: '1층', z: 0, height: 3 }], elements: [], robots: [], equipment: [], routes: [], scenarios: [],
});
/** 고칠 사본 — 배경(큰 base64)은 같은 객체를 공유(되돌리기 기록이 사본마다 수백 KiB 를 늘리지 않게) */
export function edit(s: Scene, f: (c: Scene) => void): Scene {
  const bg = s.world.background, c = structuredClone({ ...s, world: { ...s.world, background: null } }) as Scene;
  c.world.background = bg; f(c); return c;
}

// ---- ID: 문서 전체에서 하나 ----
export function allIds(s: Scene): string[] {
  return [...s.floors.map((x) => x.id), ...s.elements.map((x) => x.id), ...s.robots.flatMap((r) => [r.id, ...r.sensors.map((x) => x.id)]),
    ...s.equipment.map((x) => x.id), ...s.routes.map((x) => x.id), ...s.scenarios.map((x) => x.id)];
}
export function newId(s: Scene, prefix: string): string {
  const used = new Set(allIds(s));
  for (let i = 1; ; i++) if (!used.has(`${prefix}${i}`)) return `${prefix}${i}`;
}

// ---- 지우기 정책(참조) ----
// 층: 무엇이든 그 층을 가리키면(요소·로봇·장비·경로·배경·계단 도착) 지우지 않는다 + 첫 층은 지우지 않는다 → 거부 글
// 로봇: 그 로봇의 경로를 함께 지우고, 배치안에서 로봇·그 경로를 뺀다 · 경로: 배치안에서 뺀다 · 그 밖: 참조 없음
export type Sel = { k: 'el' | 'robot' | 'equip' | 'route' | 'floor' | 'scenario' | 'sensor'; id: string; of?: string } | null;
export function removeSel(s: Scene, sel: NonNullable<Sel>): { s: Scene; note: string } | string {
  const id = sel.id;
  if (sel.k === 'floor') {
    if (s.floors[0]?.id === id) return '첫 층은 지우지 않습니다(바닥 기준 z = 0)';
    const refs = [s.elements.filter((e) => e.floor === id || (e.type === 'stairs' && e.to_floor === id)).length, s.robots.filter((r) => r.floor === id).length,
      s.equipment.filter((e) => e.floor === id).length, s.routes.filter((r) => r.floor === id).length, s.world.background?.floor === id ? 1 : 0];
    const n = refs.reduce((a, b) => a + b, 0);
    if (n) return `이 층을 쓰는 것이 ${n}개 있어 지우지 않습니다(요소·계단 ${refs[0]} · 로봇 ${refs[1]} · 장비 ${refs[2]} · 경로 ${refs[3]} · 도면 ${refs[4]}) — 먼저 옮기거나 지우세요`;
    return { s: edit(s, (c) => { c.floors = c.floors.filter((f) => f.id !== id); }), note: '층 지움' };
  }
  if (sel.k === 'robot') {
    const rts = s.routes.filter((r) => r.robot === id).map((r) => r.id), sc = s.scenarios.filter((x) => x.robots.includes(id) || x.routes.some((r) => rts.includes(r))).length;
    return { s: edit(s, (c) => {
      c.robots = c.robots.filter((r) => r.id !== id); c.routes = c.routes.filter((r) => r.robot !== id);
      for (const x of c.scenarios) { x.robots = x.robots.filter((r) => r !== id); x.routes = x.routes.filter((r) => !rts.includes(r)); }
    }), note: `로봇 지움${rts.length ? ` · 그 로봇 경로 ${rts.length}개 함께 지움` : ''}${sc ? ` · 배치안 ${sc}곳에서 뺌` : ''}` };
  }
  if (sel.k === 'route') {
    const sc = s.scenarios.filter((x) => x.routes.includes(id)).length;
    return { s: edit(s, (c) => { c.routes = c.routes.filter((r) => r.id !== id); for (const x of c.scenarios) x.routes = x.routes.filter((r) => r !== id); }), note: `경로 지움${sc ? ` · 배치안 ${sc}곳에서 뺌` : ''}` };
  }
  if (sel.k === 'sensor') return { s: edit(s, (c) => { const r = c.robots.find((x) => x.id === sel.of); if (r) r.sensors = r.sensors.filter((x) => x.id !== id); }), note: '센서 지움' };
  if (sel.k === 'el') return { s: edit(s, (c) => { c.elements = c.elements.filter((e) => e.id !== id); }), note: '지움' };
  if (sel.k === 'equip') return { s: edit(s, (c) => { c.equipment = c.equipment.filter((e) => e.id !== id); }), note: '장비 지움' };
  return { s: edit(s, (c) => { c.scenarios = c.scenarios.filter((x) => x.id !== id); }), note: '배치안 지움' };
}
/** 배치안 칸 켜고 끄기 — 경로를 넣으면 그 로봇도 넣고, 로봇을 빼면 그 로봇 경로도 뺀다(서버 규칙: 경로의 로봇은 배치안 로봇에 있어야 함) */
export function toggleIn(s: Scene, scId: string, k: 'robots' | 'routes', id: string): Scene {
  return edit(s, (c) => {
    const x = c.scenarios.find((q) => q.id === scId); if (!x) return;
    const on = x[k].includes(id);
    if (k === 'robots') { if (on) { x.robots = x.robots.filter((r) => r !== id); x.routes = x.routes.filter((r) => c.routes.find((q) => q.id === r)?.robot !== id); } else x.robots.push(id); }
    else if (on) x.routes = x.routes.filter((r) => r !== id);
    else { x.routes.push(id); const rb = c.routes.find((q) => q.id === id)?.robot; if (rb && !x.robots.includes(rb)) x.robots.push(rb); }
  });
}

// ---- 기하 ----
export const stairsLen = (e: Stairs) => e.steps * e.tread;
/** 회전 사각형 꼭짓점(중심·가로·세로·yaw) */
export function rect(c: Vec2, w: number, h: number, yaw: number): Vec2[] {
  const co = Math.cos(yaw), si = Math.sin(yaw);
  return ([[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]] as Vec2[]).map(([x, y]) => [c[0] + x * co - y * si, c[1] + x * si + y * co]);
}
export function outline(e: Element): Vec2[] {
  if (e.type === 'box') return rect(e.center, e.size[0], e.size[1], e.yaw);
  if (e.type === 'wall') { const dx = e.b[0] - e.a[0], dy = e.b[1] - e.a[1]; return rect([(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2], Math.hypot(dx, dy), e.thickness, Math.atan2(dy, dx)); }
  const L = stairsLen(e); return rect([e.start[0] + Math.cos(e.yaw) * L / 2, e.start[1] + Math.sin(e.yaw) * L / 2], L, e.width, e.yaw);
}
export function inPoly(p: Vec2, q: Vec2[]): boolean {
  let o = false;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) if ((q[i][1] > p[1]) !== (q[j][1] > p[1]) && p[0] < ((q[j][0] - q[i][0]) * (p[1] - q[i][1])) / (q[j][1] - q[i][1]) + q[i][0]) o = !o;
  return o;
}
export const segDist = (p: Vec2, a: Vec2, b: Vec2) => {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy, t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
};
export const pathLen = (pts: Vec2[]) => pts.reduce((a, p, i) => (i ? a + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);
export const snap = (v: number) => Math.round(v / RES) * RES;
export const r3 = (v: number) => Math.round(v * 1000) / 1000;
/** 요소·로봇·장비·경로 전체 평행 이동(끌기) */
export function moveSel(s: Scene, sel: NonNullable<Sel>, dx: number, dy: number): Scene {
  const m = (p: Vec2): Vec2 => [r3(p[0] + dx), r3(p[1] + dy)];
  return edit(s, (c) => {
    if (sel.k === 'el') { const e = c.elements.find((x) => x.id === sel.id); if (!e) return; if (e.type === 'wall') { e.a = m(e.a); e.b = m(e.b); } else if (e.type === 'box') e.center = m(e.center); else e.start = m(e.start); }
    else if (sel.k === 'robot' || sel.k === 'equip') { const r = (sel.k === 'robot' ? c.robots : c.equipment).find((x) => x.id === sel.id); if (r) { const [x, y] = m([r.pose[0], r.pose[1]]); r.pose = [x, y, r.pose[2]]; } }
    else if (sel.k === 'route') { const r = c.routes.find((x) => x.id === sel.id); if (r) r.points = r.points.map(m); }
  });
}

/** 계단 새로: 지금 층 → 바로 위층. 단 높이는 층 높이 차를 단 수로 나눈 값(steps × riser = 높이 차 — 서버 0.005 m 규칙) */
export function newStairs(s: Scene, floor: string, start: Vec2, yaw: number): Stairs | string {
  const i = s.floors.findIndex((f) => f.id === floor), up = s.floors[i + 1];
  if (i < 0 || !up) return '위층이 없습니다 — 먼저 «+층»으로 위층을 만드세요(계단은 바로 위층으로만)';
  const dz = up.z - s.floors[i].z, steps = Math.max(2, Math.min(40, Math.round(dz / 0.17)));
  return { id: newId(s, 's'), type: 'stairs', floor, to_floor: up.id, start, yaw: r3(yaw), steps, riser: Math.round((dz / steps) * 10000) / 10000, tread: 0.28, width: 1 };
}

// ---- 화면 계산 검사(편의 — 정본은 서버) ----
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
export function checkScene(s: Scene): Issue[] {
  const out: Issue[] = [], E = (code: string, path: string, msg: string, at?: Vec2, floor?: string) => out.push({ level: 'error', code, path, msg, at, floor });
  const W = (code: string, path: string, msg: string, at?: Vec2, floor?: string) => out.push({ level: 'warn', code, path, msg, at, floor });
  const n = bytesOf(s); if (n > RLIM.scene) E('too_big', '', `설계도가 240 KiB 를 넘습니다(${kib(n)} KiB) — 도면 배경을 줄이세요`);
  const [ox, oy] = s.world.origin, [sx, sy] = s.world.size;
  if (!(num(sx) && num(sy) && sx >= RLIM.worldMin && sx <= RLIM.worldMax && sy >= RLIM.worldMin && sy <= RLIM.worldMax)) E('world_size', 'world.size', '세계 크기는 가로·세로 각 2–100 m');
  const inW = (p: Vec2) => num(p[0]) && num(p[1]) && p[0] >= ox - 1e-6 && p[0] <= ox + sx + 1e-6 && p[1] >= oy - 1e-6 && p[1] <= oy + sy + 1e-6;   // 서버 in_world 와 같은 허용오차(회전 꼭짓점 -3.6e-16 같은 부동소수 오차)
  const seen = new Set<string>();
  for (const id of allIds(s)) { if (!ID_RE.test(id)) E('bad_id', id, `ID «${id}» 형식 아님(영소문자로 시작 · 영소문자·숫자·_ · 32자 이하)`); if (seen.has(id)) E('dup_id', id, `ID «${id}» 가 겹칩니다(문서 전체에서 하나)`); seen.add(id); }
  const fl = new Map(s.floors.map((f, i) => [f.id, i]));
  if (s.floors.length < 1 || s.floors.length > RLIM.floors) E('floors', 'floors', '층은 1–8개');
  if (s.floors[0] && s.floors[0].z !== 0) E('floor_z', 'floors[0].z', '첫 층 z 는 0');
  s.floors.forEach((f, i) => { if (!(num(f.height) && f.height >= 1 && f.height <= 10)) E('floor_h', `floors[${i}].height`, `«${f.name}» 층 높이 1–10 m`); if (!(num(f.z) && f.z >= 0 && f.z <= 200)) E('floor_z', `floors[${i}].z`, `«${f.name}» z 0–200 m`); if (i && !(f.z - s.floors[i - 1].z >= 1 - 1e-9)) E('floor_order', `floors[${i}].z`, `«${f.name}» 은 아래층보다 1 m 이상 위`); });
  if (s.elements.length > RLIM.elements) E('elements', 'elements', `요소 ${s.elements.length}개 — 1500개까지`);
  { const cells = Math.ceil(sx / RES - 1e-9) * Math.ceil(sy / RES - 1e-9) * Math.max(s.floors.length, 1);   // 서버와 같은 식
    if (cells > RLIM.cells) E('too_large', 'world.size', `층 지도 칸 합 ${cells.toLocaleString()} > 8,000,000 — 세계를 줄이거나 층 수를 줄이세요`); }
  { const per = new Map<string, number>(); for (const e of s.elements) if (e.type === 'stairs') per.set(e.to_floor, (per.get(e.to_floor) || 0) + 1);
    for (const [f, n] of per) if (n > RLIM.stairsPerFloor) E('count', 'elements', `«${f}» 층에 도착하는 계단 ${n}개 — 16개까지`); }
  s.elements.forEach((e, i) => {
    const p = `elements[${i}]`, at = outline(e)[0];
    if (!fl.has(e.floor)) return E('floor_ref', p, `${e.id}: 없는 층 «${e.floor}»`);
    if (!outline(e).every(inW)) E('outside', p, `${e.id}: 세계 사각형 밖`, at, e.floor);
    if (e.type === 'wall') { const L = Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]); if (L < 0.05) E('wall_len', p, `${e.id}: 벽 길이 0.05 m 이상`, at, e.floor); if (!(e.thickness >= 0.05 && e.thickness <= 1)) E('wall_t', p, `${e.id}: 두께 0.05–1.0 m`, at, e.floor); if (!(e.height >= 0.05 && e.height <= 10)) E('wall_h', p, `${e.id}: 높이 0.05–10 m`, at, e.floor); }
    if (e.type === 'box' && !e.size.every((v) => v >= 0.05 && v <= 50)) E('box_size', p, `${e.id}: 각 변 0.05–50 m`, at, e.floor);
    if (e.type === 'stairs') {
      const i0 = fl.get(e.floor)!, up = s.floors[i0 + 1];
      if (!up || up.id !== e.to_floor) E('stairs_to', p, `${e.id}: 도착 층은 바로 위층이어야 합니다`, at, e.floor);
      else if (Math.abs(e.steps * e.riser - (up.z - s.floors[i0].z)) > 0.005) E('stairs_rise', p, `${e.id}: 단 수 × 단 높이(${r3(e.steps * e.riser)} m) ≠ 층 높이 차(${r3(up.z - s.floors[i0].z)} m)`, at, e.floor);
      if (!(Number.isInteger(e.steps) && e.steps >= 2 && e.steps <= 40)) E('stairs_n', p, `${e.id}: 단 수 2–40`, at, e.floor);
      if (!(e.riser >= 0.05 && e.riser <= 0.25)) E('stairs_riser', p, `${e.id}: 단 높이 0.05–0.25 m(형식 상한)`, at, e.floor);
      if (!(e.tread >= 0.15 && e.tread <= 0.6)) E('stairs_tread', p, `${e.id}: 디딤 0.15–0.60 m`, at, e.floor);
      if (!(e.width >= 0.5 && e.width <= 4)) E('stairs_w', p, `${e.id}: 폭 0.5–4.0 m`, at, e.floor);
      W('stairs_range_unverified', p, `${e.id}: ${STAIRS_TAG}`, at, e.floor);
    }
  });
  if (s.robots.length > RLIM.robots) E('robots', 'robots', '로봇은 12대까지');
  s.robots.forEach((r, i) => {
    const p = `robots[${i}]`, at: Vec2 = [r.pose[0], r.pose[1]];
    if (r.id.length > 24) E('robot_id', p, `${r.id}: 로봇 ID 는 24자 이하(ROS 이름공간)`);
    if (!fl.has(r.floor)) E('floor_ref', p, `${r.id}: 없는 층`); else if (!inW(at)) E('outside', p, `${r.name}: 세계 사각형 밖`, at, r.floor);
    if (r.sensors.length > RLIM.sensors) E('sensors', p, `${r.name}: 센서는 6개까지`, at, r.floor);
    if (r.sensors.some((x) => x.kind.startsWith('lidar'))) W('lidar_spec_unconfirmed', p, `${r.name}: ${SENSOR_TAG}`, at, r.floor);
  });
  if (s.equipment.length > RLIM.equip) E('equipment', 'equipment', '장비는 200개까지');
  s.equipment.forEach((e, i) => { if (!fl.has(e.floor)) E('floor_ref', `equipment[${i}]`, `${e.id}: 없는 층`); else if (!inW([e.pose[0], e.pose[1]])) E('outside', `equipment[${i}]`, `${e.label || e.id}: 세계 사각형 밖`, [e.pose[0], e.pose[1]], e.floor); });
  if (s.routes.length > RLIM.routes) E('routes', 'routes', '경로는 48개까지');
  const rb = new Set(s.robots.map((r) => r.id));
  s.routes.forEach((r, i) => {
    const p = `routes[${i}]`;
    if (!rb.has(r.robot)) E('robot_ref', p, `${r.id}: 없는 로봇 «${r.robot}»`);
    if (!fl.has(r.floor)) E('floor_ref', p, `${r.id}: 없는 층`);
    if (r.points.length < 2 || r.points.length > RLIM.routePts) E('route_pts', p, `${r.id}: 점 2–200개`);
    if (!r.points.every(inW)) E('outside', p, `${r.id}: 점이 세계 사각형 밖`, r.points.find((q) => !inW(q)), r.floor);
  });
  { const t = s.routes.reduce((a, r) => a + r.points.length, 0); if (t > RLIM.routePtsTotal) E('count', 'routes', `경로 점 합계 ${t} — 2000개까지`); }
  if (s.scenarios.length > RLIM.scenarios) E('scenarios', 'scenarios', '배치안은 12개까지');
  s.scenarios.forEach((x, i) => {
    for (const r of x.robots) if (!rb.has(r)) E('robot_ref', `scenarios[${i}]`, `배치안 «${x.name}»: 없는 로봇 «${r}»`);
    for (const r of x.routes) { const q = s.routes.find((y) => y.id === r); if (!q) E('route_ref', `scenarios[${i}]`, `배치안 «${x.name}»: 없는 경로 «${r}»`); else if (!x.robots.includes(q.robot)) E('route_robot', `scenarios[${i}]`, `배치안 «${x.name}»: 경로 ${r} 의 로봇이 배치안에 없음`); }
  });
  const ln = (v: string, p: string) => { if (v.length > RLIM.name || /[\u0000-\u001f\u007f]/.test(v)) E('name', p, `이름 «${v.slice(0, 20)}…»: 60자 이하 · 제어문자 금지`); };
  ln(s.name, 'name'); s.floors.forEach((f, i) => ln(f.name, `floors[${i}].name`)); s.robots.forEach((r, i) => ln(r.name, `robots[${i}].name`));
  s.equipment.forEach((e, i) => ln(e.label, `equipment[${i}].label`)); s.scenarios.forEach((x, i) => ln(x.name, `scenarios[${i}].name`));
  return out;
}

// ---- JSON 가져오기: 모양만 확인(정본 검증은 저장 때 서버). 실패 = 이유, 현재 편집은 그대로 ----
const KEYS = ['schema', 'name', 'world', 'floors', 'elements', 'robots', 'equipment', 'routes', 'scenarios'];
export function parseScene(text: string): Scene | string {
  { const n = enc.encode(text).length; if (n > RLIM.req) return `파일이 256 KiB 를 넘습니다(${kib(n)} KiB)`; }
  let j: any; try { j = JSON.parse(text); } catch (e: any) { return `JSON 문법 오류 · ${e?.message || e}`; }
  const d = dupKey(text); if (d) return `중복 키 «${d}» — 같은 객체에 같은 이름이 두 번(뒤 값이 앞 값을 조용히 덮으므로 거부)`;
  return sceneShape(j) || (j as Scene);
}
/** 유효 JSON 원문에서 같은 객체 안 중복 키(이스케이프로 쓴 같은 이름 포함)를 찾음 — JSON.parse 는 뒤 값으로 덮어 버려 알 수 없음. 없으면 null */
export function dupKey(text: string): string | null {
  const st: ({ keys: Set<string>; key: boolean } | null)[] = [];   // null = 배열
  for (let i = 0; i < text.length; i++) {
    const c = text[i], top = st[st.length - 1];
    if (c === '{') st.push({ keys: new Set(), key: true });
    else if (c === '[') st.push(null);
    else if (c === '}' || c === ']') st.pop();
    else if (c === ',') { if (top) top.key = true; }
    else if (c === ':') { if (top) top.key = false; }
    else if (c === '"') {
      let j = i + 1; while (text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      if (top && top.key) { const k = JSON.parse(text.slice(i, j + 1)) as string; if (top.keys.has(k)) return k; top.keys.add(k); }
      i = j;
    }
  }
  return null;
}

// ---- 도면 배경: 브라우저 안에서 줄이고 JPEG 로 눌러 scene 240 KiB(배경 128 KiB — API 개정2) 안에. 다 해도 넘으면 넣지 않음(기존 배경·내용 그대로) ----
export const b64Bytes = (b: string) => Math.floor((b.length * 3) / 4) - (b.endsWith('==') ? 2 : b.endsWith('=') ? 1 : 0);
export type Shrink = (side: number, q: number) => Promise<{ b64: string; w: number; h: number }>;
export async function fitBackground(s: Scene, floor: string, shrink: Shrink): Promise<{ bg: Background; w: number; h: number; note: string } | string> {
  for (const side of [1600, 1200, 800, 600]) for (const q of [0.8, 0.6, 0.45]) {
    const { b64, w, h } = await shrink(side, q);
    if (b64Bytes(b64) > RLIM.bg) continue;
    const bg: Background = { mime: 'image/jpeg', data_b64: b64, floor, ref_px: [[0, 0], [w, 0]], ref_m: [[s.world.origin[0], s.world.origin[1] + s.world.size[1]], [s.world.origin[0] + s.world.size[0], s.world.origin[1] + s.world.size[1]]] };
    const n = bytesOf({ ...s, world: { ...s.world, background: bg } });
    if (n <= RLIM.scene) return { bg, w, h, note: `도면 ${w}×${h} px · JPEG 품질 ${q} · ${kib(b64Bytes(b64))} KiB · 설계도 ${kib(n)} KiB — 축척은 «축척» 도구로 맞추세요` };
  }
  return '도면을 600 px · 품질 0.45 까지 줄여도 설계도 240 KiB(도면 128 KiB) 안에 들지 않아 넣지 않았습니다 — 도면을 잘라 내거나 요소 수를 줄이세요';
}
/** 기본 맞춤(가져온 직후: 이미지 윗변 = 세계 윗변) 그대로인가 = 축척 안 맞춤 */
export const autoFit = (s: Scene) => { const b = s.world.background; if (!b) return false; const o = s.world.origin, z = s.world.size;
  return b.ref_px[0][0] === 0 && b.ref_px[0][1] === 0 && b.ref_px[1][1] === 0 && b.ref_m[0][0] === o[0] && b.ref_m[0][1] === o[1] + z[1] && b.ref_m[1][0] === o[0] + z[0] && b.ref_m[1][1] === o[1] + z[1]; };
/** 두 점 대응 → 닮음 변환 계수(픽셀 u 오른쪽·v 아래 → 세계 m). 세계 = a·(u − i v) + b (복소수) */
export function bgXf(b: Background): { ar: number; ai: number; br: number; bi: number } | null {
  const [p1, p2] = b.ref_px, [m1, m2] = b.ref_m, q1 = [p1[0], -p1[1]], q2 = [p2[0], -p2[1]];
  const dq = [q2[0] - q1[0], q2[1] - q1[1]], dm = [m2[0] - m1[0], m2[1] - m1[1]], d = dq[0] * dq[0] + dq[1] * dq[1];
  if (!(d > 0)) return null;
  const ar = (dm[0] * dq[0] + dm[1] * dq[1]) / d, ai = (dm[1] * dq[0] - dm[0] * dq[1]) / d;
  return { ar, ai, br: m1[0] - (ar * q1[0] - ai * q1[1]), bi: m1[1] - (ai * q1[0] + ar * q1[1]) };
}
export const pxToM = (x: NonNullable<ReturnType<typeof bgXf>>, u: number, v: number): Vec2 => [x.ar * u + x.ai * v + x.br, x.ai * u - x.ar * v + x.bi];
export function mToPx(x: NonNullable<ReturnType<typeof bgXf>>, m: Vec2): Vec2 {
  const d = x.ar * x.ar + x.ai * x.ai, X = m[0] - x.br, Y = m[1] - x.bi;   // a⁻¹·(m − b), 그리고 v = −허수
  return [(X * x.ar + Y * x.ai) / d, -((Y * x.ar - X * x.ai) / d)];
}
/** 축척 맞추기: 도면 위 두 점(세계 좌표 a,b — 지금 변환 기준)과 실제 거리 d(m). 첫 점 자리·방향은 그대로, 길이만 d 로 */
export function rescale(b: Background, a: Vec2, c: Vec2, d: number): Background | string {
  const x = bgXf(b); if (!x) return '도면 기준점이 망가졌습니다 — 도면을 다시 넣으세요';
  if (!(Number.isFinite(d) && d >= 0.05 && d <= 1000)) return '실제 거리는 0.05–1000 m';
  const L = Math.hypot(c[0] - a[0], c[1] - a[1]); if (!(L > 0)) return '두 점이 같습니다 — 떨어진 두 점을 누르세요';
  const pa = mToPx(x, a), pc = mToPx(x, c), px = Math.hypot(pc[0] - pa[0], pc[1] - pa[1]);
  if (!(px >= 5)) return '두 점이 도면에서 5 px 보다 가깝습니다 — 더 떨어진 두 점을 누르세요';
  const mpp = d / px; if (!(mpp >= 0.0005 && mpp <= 2)) return `축척 ${mpp.toExponential(2)} m/px 는 범위 밖(0.0005–2)`;
  const u: Vec2 = [(c[0] - a[0]) / L, (c[1] - a[1]) / L], r = (v: number) => Math.round(v * 1e4) / 1e4;
  return { ...b, ref_px: [[r(pa[0]), r(pa[1])], [r(pc[0]), r(pc[1])]], ref_m: [[r(a[0]), r(a[1])], [r(a[0] + u[0] * d), r(a[1] + u[1] * d)]] };
}

// ---- 내보내기 묶음(ZIP base64) 저장: 디코드 → 크기·sha 확인(가능할 때) → saveBlob(앱 = T.saveFile 세대/화면 확인 · 웹 = 내려받기) ----
export async function saveExport(x: Exported, still: () => boolean, save: typeof saveBlob = saveBlob): Promise<string | null> {
  let bin: Uint8Array;
  try { const s = atob(x.base64); bin = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) bin[i] = s.charCodeAt(i); } catch { return '내보내기 파일을 해독하지 못해 저장하지 않음'; }
  if (bin.length > RLIM.zip) return `내보내기 파일이 640 KiB 를 넘어 저장하지 않음(${kib(bin.length)} KiB)`;
  if (bin.length !== x.bytes) return `내보내기 크기 불일치(받음 ${bin.length} B · 서버 ${x.bytes} B) — 저장하지 않음`;
  const sub = (globalThis.crypto as Crypto | undefined)?.subtle;
  let shaNote = ' · sha256 확인됨';
  if (sub) { const h = [...new Uint8Array(await sub.digest('SHA-256', bin))].map((b) => b.toString(16).padStart(2, '0')).join(''); if (h !== x.sha256) return 'sha256 불일치 — 저장하지 않음'; }
  else shaNote = ' · sha256 미확인(이 주소는 보안 문맥 아님)';
  if (!still()) return null;
  const name = /^[A-Za-z0-9._-]{1,80}\.zip$/.test(x.filename) ? x.filename : `rehearsal-${x.project.id}-r${x.project.rev}.zip`;
  const r = await save(name, new Blob([bin], { type: 'application/zip' }));
  return r && `${r}${shaNote} · 계획 파일(Gazebo 실행 0)`;
}

// ---- 예시 계획(10-18 root «기본 예시 project 한 개로 핵심 동작 end-to-end»): 사용자가 «예시 계획 불러오기»를 눌렀을 때만 초안으로 — 새 설계도 기본값으로 흘리지 않음.
//   이름에 «예시 계획»을 넣어 저장본 목록에서도 구별. 치수·배치는 가상(실제 건물·로봇 측정 0)
export const EXAMPLE_NAME = '예시 계획 · 2층 창고(가상)';
export function exampleScene(): Scene {
  const w = (id: string, a: Vec2, b: Vec2): Wall => ({ id, type: 'wall', floor: 'f1', a, b, thickness: 0.15, height: 2.4 });
  return {
    schema: 'fh_rehearsal_scene/1', name: EXAMPLE_NAME, world: { origin: [0, 0], size: [20, 14], resolution: RES, background: null },
    floors: [{ id: 'f1', name: '1층', z: 0, height: 3 }, { id: 'f2', name: '2층', z: 3, height: 3 }],
    elements: [
      w('w1', [0.5, 0.5], [19.5, 0.5]), w('w2', [19.5, 0.5], [19.5, 13.5]), w('w3', [19.5, 13.5], [0.5, 13.5]), w('w4', [0.5, 13.5], [0.5, 0.5]),
      w('w5', [8, 0.5], [8, 8]),   // 가운데 칸막이 — 위쪽 8–13.5 m 가 통로
      { id: 'b1', type: 'box', floor: 'f1', center: [4, 10], size: [1.5, 1, 1], yaw: 0 },
      { id: 's1', type: 'stairs', floor: 'f1', to_floor: 'f2', start: [15, 2], yaw: Math.PI / 2, steps: 18, riser: 0.1667, tread: 0.28, width: 1 },
    ],
    robots: [
      { id: 'go2_a', name: '예시 로봇 A', model: 'go2_proxy', floor: 'f1', pose: [2, 2, 0], sensors: [{ id: 'go2_a_lidar', kind: 'lidar_unknown', mount: [0.25, 0, 0.1, 0] }, { id: 'go2_a_cam', kind: 'camera', mount: [0.3, 0, 0.05, 0] }] },
      { id: 'go2_b', name: '예시 로봇 B', model: 'go2_proxy', floor: 'f1', pose: [2, 12, 0], sensors: [{ id: 'go2_b_cam', kind: 'camera', mount: [0.3, 0, 0.05, 0] }] },
    ],
    equipment: [{ id: 'eq1', kind: 'relay', floor: 'f1', pose: [8, 11, 0], label: '중계기(예시)' }],
    routes: [
      { id: 'p1', robot: 'go2_a', floor: 'f1', points: [[2, 2], [6, 4], [6, 10], [11, 11], [14, 9]] },
      { id: 'p2', robot: 'go2_b', floor: 'f1', points: [[2, 12], [10, 12], [11, 4]] },
    ],
    scenarios: [{ id: 'sc1', name: 'A안 · 1대', robots: ['go2_a'], routes: ['p1'] }, { id: 'sc2', name: 'B안 · 2대', robots: ['go2_a', 'go2_b'], routes: ['p1', 'p2'] }],
  };
}
