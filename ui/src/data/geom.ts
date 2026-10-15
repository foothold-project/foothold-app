// 건물 전체 GT 간략 기하(RL v2_building_geom/1 · op geom_get 읽기만) — 센서·주행 판정 아님, 정밀도 주장 0.
// 앱은 형식·결속을 다시 검사하고, 통과한 것만 그린다. 계단·경사로는 «구조상 연결»만(통과 가능 표시 0)
import { ask, useLink } from './link';

type V3 = [number, number, number];
export type GBox = { id: string; floor_id: string | null; kind: string; corners: V3[]; aabb: number[]; approximation: 'exact_box' };
export type GMesh = { id: string; floor_id: string | null; kind: string; aabb: number[]; approximation: 'aabb' };
export type GConn = { id: string; kind: 'stair' | 'ramp'; from: string; to: string; entry: V3; exit: V3 };
export type Geom = { building_id: string; label: string; sdf_sha256: Record<string, string>; floors: { floor_id: string; z: number }[]; boxes: GBox[]; meshes: GMesh[]; connectors: GConn[] };

/** 서버 sim/v2_link.py GEOM_LIM·GEOM_KINDS 와 같은 한도(pytest 가 두 곳을 대조) */
export const GEOM_LIM = { bytes: 524288, floors: 8, boxes: 2000, meshes: 64, connectors: 32, coord: 500 };
const KINDS = ['floor', 'wall', 'stair', 'ramp', 'obstacle', 'ceiling', 'other'];
const WORLD: Record<string, string> = { v5: 'v5_building' };
const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= GEOM_LIM.coord;
const v3 = (p: unknown): p is V3 => Array.isArray(p) && p.length === 3 && p.every(fin);
const ab = (a: unknown) => Array.isArray(a) && a.length === 6 && a.every(fin) && a[0] <= a[3] && a[1] <= a[4] && a[2] <= a[5];
const FL = (f: unknown, fs: Set<string>) => f === null || (typeof f === 'string' && fs.has(f));
const lst = (a: unknown, n: number) => Array.isArray(a) && a.length <= n;
const hex = (x: unknown): x is string => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x);

/** 서버 답 → Geom | 이유. 형식이 하나라도 다르면 통째로 버림(일부만 그리기 0) */
export function okGeom(g: any, building_id: string): Geom | string {
  if (!g || g.schema !== 'v2_building_geom/1') return '기하 형식 버전 다름';
  if (g.building_id !== building_id || g.world_id !== WORLD[building_id]) return '다른 건물·world 기하';
  if (g.frame !== 'world' || g.source !== 'gt_sdf' || g.sensor !== false || g.precision_claim !== false) return '기하 출처 표시 이상(GT·센서 아님·정밀도 주장 0 이어야)';
  if (!lst(g.floors, GEOM_LIM.floors) || !g.floors.length || !g.floors.every((f: any) => typeof f?.floor_id === 'string' && fin(f.z))) return '층 목록 이상';
  const fs = new Set<string>(g.floors.map((f: any) => f.floor_id));
  if (fs.size !== g.floors.length) return '층 이름 중복';
  const sh = g.sdf_sha256;
  if (!sh || typeof sh !== 'object' || Object.keys(sh).length !== fs.size || ![...fs].every((f) => hex(sh[f]))) return '원본 SDF sha 없음·층과 다름 — 결속 불가';
  if (!lst(g.boxes, GEOM_LIM.boxes) || !lst(g.meshes, GEOM_LIM.meshes) || !lst(g.connectors, GEOM_LIM.connectors)) return '기하 목록 이상·개수 한도 넘음';
  for (const b of g.boxes) if (b?.approximation !== 'exact_box' || !Array.isArray(b.corners) || b.corners.length !== 8 || !b.corners.every(v3) || !ab(b.aabb) || !FL(b.floor_id, fs) || !KINDS.includes(b.kind) || typeof b.id !== 'string') return `상자 형식 이상 · ${b?.id ?? '?'}`;
  for (const m of g.meshes) if (m?.approximation !== 'aabb' || !ab(m.aabb) || !FL(m.floor_id, fs) || !KINDS.includes(m.kind) || m.fill !== false || typeof m.id !== 'string') return `mesh 형식 이상 · ${m?.id ?? '?'}`;   // 외곽 상자는 실제 면 아님 → 채움 0
  for (const c of g.connectors) if (!['stair', 'ramp'].includes(c?.kind) || !fs.has(c.from) || !fs.has(c.to) || !v3(c.entry) || !v3(c.exit) || c.traversable_claim !== false || typeof c.id !== 'string') return `층 연결 형식 이상 · ${c?.id ?? '?'}`;
  return { building_id, label: typeof g.label === 'string' ? g.label : 'GT 간략 기하(센서·주행판정 아님)', sdf_sha256: sh, floors: g.floors, boxes: g.boxes, meshes: g.meshes, connectors: g.connectors };
}

type LvBind = { st?: string; world_id?: string | null; spawn_floor?: string | null; world_src_sha256?: string | null; geom?: { sha256?: string | null } | null } | null | undefined;
/** 지금 켜진 시뮬과 같은 world 인가. ok = 결속 · '' = 이 건물 시뮬 안 켜짐(GT 미리보기만) · 그 밖 = 그리지 않는 이유(불일치·미확인).
 *  기준 = 런 안 불변인 spawn_floor 의 원본 SDF sha(지금 floor_id 같은 동적 값으로 비교 0) · 기하 파일 sha 는 서버가 주면 같아야 함 */
export function geomBind(g: Geom, fileSha: string, runWorld: string | null | undefined, lv: LvBind, world_id: string): string {
  if (runWorld !== world_id) return '';
  if (!lv || lv.st === 'stale' || lv.st === 'unknown' || lv.world_id !== world_id) return '지금 시뮬 지도 상태 없음 — 같은 world 인지 미확인';
  const want = lv.spawn_floor ? g.sdf_sha256[lv.spawn_floor] : undefined;
  if (!want) return '서버가 기동 층(spawn_floor)을 안 줌 — 같은 world 인지 미확인';
  if (!hex(lv.world_src_sha256)) return '서버가 지금 world 원본 SDF sha 를 안 줌 — 같은 world 인지 미확인';
  if (lv.world_src_sha256 !== want) return '지금 시뮬 world 와 원본 SDF sha 다름 — 다른 기하일 수 있음';
  if (lv.geom?.sha256 && lv.geom.sha256 !== fileSha) return '받은 기하 파일이 지금 world 의 기하 파일과 다름';
  return 'ok';
}

export async function getGeom(building_id: 'v5'): Promise<{ g: Geom; sha: string } | string> {
  const r = await ask('geom_get', { building_id });
  if (!r.ok) return r.text || '기하 받기 실패';
  const sha = (r as any).geom_sha256;
  if (!hex(sha)) return '서버가 기하 파일 sha 를 안 줌';
  const g = okGeom((r as any).geom, building_id);
  return typeof g === 'string' ? g : { g, sha };
}

// ---- 계획 좌표 개정 rid(10-15 F4) — 연결 건물 = «검증된» 기하 파일 sha(g:). 단층 w: 는 run.ts gtHere ----
// 응답은 요청 때와 도착 때의 세대 키(연결 gen·provider·episode·world·live 기하 sha·live world 원본 SDF sha·spawn_floor·epoch)가 같을 때만 보관.
// 쓸 때도 지금 키와 같고 geomBind(지금 live) == ok 일 때만 — 리셋·전환·새 연결 뒤 늦게 온 옛 응답으로 rid 를 붙이지 않는다.
type RidLv = { world_id?: string | null; world_src_sha256?: string | null; spawn_floor?: string | null; epoch?: number | null; geom?: { sha256?: string | null } | null; st?: string };
type RidS = { gen: number; provider: string; st: { episode?: number | null; live_map?: unknown } | null };
export const ridKey = (s: RidS, lv: RidLv) => [s.gen, s.provider, s.st?.episode, lv.world_id, lv.geom?.sha256, lv.world_src_sha256, lv.spawn_floor, lv.epoch].join('|');
// G1(Codex P1): 빈 계획 화면도 매 그리기마다 이것을 불러(gtHere) 첫 점 전에 기하를 준비한다. 상태 = 확인됨(rid) · 받는 중(wait) · 실패/미확인(why).
// G2: gtHere 가 «실제로 관찰한» 관련 키 전환에서 옛 요청·검증본을 버린다 — 다른 키로 부름 · 기하 sha/SDF sha/기동 층 누락(아래 조기 반환) ·
// 연결 건물 아닌 world(gtHere 가 ridReset). 부르지 않은 사이의 중간 상태는 알 수 없음(보장 0) — 그래서 쓸 때마다 지금 키·sha·geomBind 를 다시 대조.
// 받는 중엔 같은 키로 다시 요청하지 않고(ask 5 s 제한이 끝을 보장), 실패 뒤 6 s 안 재요청 0. 새 타이머·구독 0.
type RidAsk = { key: string; t: number; why?: string };   // why: undefined = 받는 중 · '' = 성공 · 글 = 실패 이유
let ridG: { key: string; g: Geom; sha: string } | null = null, ridAsk: RidAsk | null = null;
export const ridDeps = { get: (b: 'v5') => getGeom(b), now: () => performance.now(), cur: (): [RidS, RidLv | null] => { const s = useLink.getState(); return [s, (s.st?.live_map as RidLv | null | undefined) ?? null]; } };
export type RidSt = { rid: string; why?: undefined; wait?: undefined } | { rid?: undefined; why: string; wait: boolean };
const WAIT: RidSt = { why: 'GT 기하 파일 받는 중', wait: true };
/** 연결 건물 rid · 받는 중 · 미확인 이유. 없으면 기하 받기를 한 번 요청 */
export function geomRid(s: RidS, lv: RidLv): RidSt {
  if (lv.world_id !== 'v5_building' || !hex(lv.geom?.sha256) || !hex(lv.world_src_sha256) || !lv.spawn_floor) { ridReset(); return { why: '서버가 기하 sha·원본 SDF sha·기동 층을 안 줌', wait: false }; }   // G2: 관찰한 누락 = 키 전환
  const key = ridKey(s, lv);
  if (ridG && ridG.key !== key) ridG = null;   // 키 전환 = 옛 검증본 폐기(되돌아와도 새로 받음)
  if (ridG) {
    const b = ridG.sha !== lv.geom!.sha256 ? '받은 기하 파일 sha ≠ 지금 기하' : geomBind(ridG.g, ridG.sha, lv.world_id, lv, lv.world_id);
    return b === 'ok' ? { rid: `g:${ridG.sha}` } : { why: b, wait: false };
  }
  const a = ridAsk && ridAsk.key === key ? ridAsk : null;
  if (a && a.why === undefined) return WAIT;
  if (a && a.why && ridDeps.now() - a.t <= 6000) return { why: a.why, wait: false };
  const q: RidAsk = { key, t: ridDeps.now() }; ridAsk = q;
  ridDeps.get('v5').then((x) => {
    if (typeof x === 'string') { q.why = x; return; }
    const [s2, lv2] = ridDeps.cur();
    if (!lv2 || ridKey(s2, lv2) !== key) { q.why = '받는 사이 시뮬·연결이 바뀜'; return; }   // 요청 뒤 세대·출처가 바뀌었으면 버림
    if (x.sha !== lv2.geom?.sha256) { q.why = '받은 기하 파일 sha ≠ 지금 기하'; return; }
    q.why = ''; if (ridAsk === q) ridG = { key, g: x.g, sha: x.sha };
  }, () => { q.why = '기하 받기 실패'; });
  return WAIT;
}
/** 보관·요청 기록 비우기 — G2 키 전환 관찰 때(geomRid 조기 반환·gtHere 비연결건물 world)와 시험. 진행 중 요청은 ridAsk!==q 로 응답 보관 0 */
export function ridReset() { ridG = null; ridAsk = null; }
