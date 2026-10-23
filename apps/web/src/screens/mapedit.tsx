// 지도 편집(01 MP-03·05·06·AP-01, 02 F-MP-03, 03 §5.6, 05 §5 — S3a features·S4a). 편집 시작 때 승인 판 위에서 고쳐 새 판으로 저장한다 — 총괄은 바로 승인 판, 운영 관리자는 결재 요청(PENDING 판).
// 화면 검사는 서버(apps/server/fh_server/maps.py validate_features)와 같은 규칙 — 그래도 422 가 오면 그 요소를 고르고 쉬운 말로 알린다.
// 캔버스는 자기 svg 의 포인터만 쓴다(창 전체 키·포인터를 잡지 않음) — STOP 단추·Space = STOP 은 App 그대로. 판 비교·되돌리기는 screens/mapdiff.tsx, 결재 처리는 screens/approvals.tsx.
import { useEffect, useRef, useState, type FormEvent, type PointerEvent } from 'react';
import type { MapConnector, MapEdit, MapFeatures, MapVersion, MapWaypoint, MapZone } from '../../../contracts/ts';
import { ApiFail, api } from '../api';
import { leaving } from '../menu';
import { EDIT, KIND, Note, Shapes, ZONE, fillOf, isVersion, reasonBad, shape, toPixel, UnsureBar, canon, pendingIds, preFail, useUnsure, type Msg, type Place } from './maps';

type P = [number, number];
type Geo = Pick<MapVersion, 'origin' | 'resolution' | 'width' | 'height'>;
/** 판 + 그 판의 업로드 ID(판 저장의 image). S3b 가 판 응답에 읽기 전용으로 더한다 — 지금 dev 계약에는 없어 선택 필드로 읽는다 */

/** 그림 픽셀 → 지도 좌표(m). maps.toPixel 의 역(y 뒤집힘·origin 방향 포함) */
export function toMap(v: Geo, px: number, py: number): P {
  const [ox, oy, yaw] = v.origin, c = Math.cos(yaw), s = Math.sin(yaw), u = px * v.resolution, w = (v.height - py) * v.resolution;
  return [ox + c * u - s * w, oy + s * u + c * w];
}
/** 화면 좌표 → 지도 좌표: svg 는 viewBox 를 가운데 맞춤으로 늘린다(preserveAspectRatio 기본값). 시나리오 지점 찍기(screens/missions.tsx)도 쓴다 */
export function fromScreen(svg: Element, v: Geo, cx: number, cy: number): P {
  const b = svg.getBoundingClientRect(), k = Math.min(b.width / v.width, b.height / v.height);
  return toMap(v, (cx - b.left - (b.width - v.width * k) / 2) / k, (cy - b.top - (b.height - v.height * k) / 2) / k);
}
/** 서버와 같은 범위: 회전 원점 기준 그림 안(경계 포함, 같은 허용 오차) */
export function inside(v: Geo, x: number, y: number) {
  const [px, py] = toPixel(v, x, y), e = 1e-9 / v.resolution;
  return Number.isFinite(px) && Number.isFinite(py) && px >= -e && px <= v.width + e && py >= -e && py <= v.height + e;
}

export const VERTEX_MAX = 4096;
const CAP = { zones: 256, waypoints: 1000, connectors: 256, edits: 256 } as const;   // 계약(apps/contracts MapFeatures) 상한
const WHAT = { zones: '구역', waypoints: '지점', connectors: '연결점', edits: '지우개·벽 선' } as const;
type Group = keyof typeof CAP;
type Item = MapZone | MapWaypoint | MapConnector | MapEdit;
/** 검사에 걸린 요소: path 는 서버 detail.element 와 같은 모양(features.zones.0.polygon …) */
export type Bad = { path: string; text: string };

const orient = (a: P, b: P, c: P) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
function cross(a: P, b: P, c: P, d: P) {   // maps.intersects 그대로
  const on = (p: P, q: P, r: P) => Math.abs(orient(p, q, r)) <= 1e-10 && Math.min(p[0], q[0]) <= r[0] && r[0] <= Math.max(p[0], q[0]) && Math.min(p[1], q[1]) <= r[1] && r[1] <= Math.max(p[1], q[1]);
  const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
  return (o1 * o2 < 0 && o3 * o4 < 0) || on(a, b, c) || on(a, b, d) || on(c, d, a) || on(c, d, b);
}
export const nameBad = (s: string) => (!/\S/.test(s) ? '이름을 입력하세요.' : [...s].length > 128 ? '이름은 128자까지 쓸 수 있습니다.'
  : /[\p{Cc}\p{Cf}]/u.test(s) ? '이름에 줄바꿈·탭 같은 보이지 않는 글자는 쓸 수 없습니다.' : null);
const OUT = '지도 범위 밖에 있습니다. 지도 그림 안으로 옮기세요.', DUP = '같은 요소가 두 번 들어 있습니다. 하나를 지우세요.';
const distinct = (pts: P[]) => new Set(pts.map((q) => q.join())).size;

/** 저장 전 검사 — 처음 걸린 하나. pairs = 짝 층으로 고를 수 있는 층(같은 건물의 다른 층) */
export function check(f: MapFeatures, v: Geo, pairs?: string[]): Bad | null {
  const n = f.zones.reduce((a, z) => a + z.polygon.length, 0) + f.edits.reduce((a, e) => a + e.polyline.length, 0) + f.waypoints.length + f.connectors.length;
  if (n > VERTEX_MAX) return { path: 'features', text: `구역·선의 점과 지점·연결점이 모두 ${n}개입니다. ${VERTEX_MAX}개 이하로 줄이세요.` };
  for (const g of Object.keys(CAP) as Group[]) if (f[g].length > CAP[g]) return { path: `features.${g}`, text: `${WHAT[g]}은 ${CAP[g]}개까지 둘 수 있습니다. 몇 개를 지우세요.` };
  const out = (pts: P[], at: string): Bad | null => { const k = pts.findIndex(([x, y]) => !inside(v, x, y)); return k < 0 ? null : { path: `${at}.${k}`, text: OUT }; };
  const dup = (g: Group) => { const k = f[g].findIndex((x, i) => x.id != null && f[g].findIndex((y) => y.id === x.id) !== i); return k < 0 ? null : { path: `features.${g}.${k}.id`, text: DUP }; };   // 지우개·벽은 id 없는 옛 선이 있을 수 있음
  for (const [i, z] of f.zones.entries()) {
    const at = `features.zones.${i}`, pg = z.polygon as P[], nb = nameBad(z.name);
    if (nb) return { path: `${at}.name`, text: nb };
    if (pg.length < 3) return { path: `${at}.polygon`, text: '구역은 점이 3개 이상이어야 합니다.' };
    if (pg.length > 256) return { path: `${at}.polygon`, text: '구역 하나의 점은 256개까지입니다. 나눠서 그리세요.' };
    if (distinct(pg) !== pg.length) return { path: `${at}.polygon`, text: '같은 자리에 점이 두 번 찍혔습니다. 구역을 지우고 다시 그리세요.' };
    const o = out(pg, `${at}.polygon`); if (o) return o;
    if (Math.abs(pg.reduce((a, q, k) => a + orient([0, 0], q, pg[(k + 1) % pg.length]), 0)) < 1e-10) return { path: `${at}.polygon`, text: '구역 넓이가 0입니다(점이 한 줄). 다시 그리세요.' };
    for (let a = 0; a < pg.length; a++) for (let b = a + 2; b < pg.length; b++) {
      if (a === 0 && b === pg.length - 1) continue;   // 이웃 변
      if (cross(pg[a], pg[(a + 1) % pg.length], pg[b], pg[(b + 1) % pg.length])) return { path: `${at}.polygon`, text: '구역의 변이 서로 엇갈립니다. 둘레를 따라 차례로 찍어 다시 그리세요.' };
    }
  }
  for (const [i, w] of f.waypoints.entries()) {
    const at = `features.waypoints.${i}`, nb = nameBad(w.name);
    if (nb) return { path: `${at}.name`, text: nb };
    if (!Number.isFinite(w.yaw)) return { path: `${at}.yaw`, text: '방향을 숫자(도)로 입력하세요.' };
    if (!inside(v, w.x, w.y)) return { path: at, text: OUT };
  }
  for (const [i, c] of f.connectors.entries()) {
    const at = `features.connectors.${i}`;
    if (!c.pair_floor_id || (pairs && !pairs.includes(c.pair_floor_id))) return { path: `${at}.pair_floor_id`, text: '짝 층을 같은 건물의 다른 층으로 고르세요.' };
    if (!Number.isFinite(c.yaw)) return { path: `${at}.yaw`, text: '방향을 숫자(도)로 입력하세요.' };
    if (!inside(v, c.x, c.y)) return { path: at, text: OUT };
  }
  for (const [i, e] of f.edits.entries()) {
    const at = `features.edits.${i}`, pl = e.polyline as P[];
    if (!(Number.isFinite(e.width) && e.width > 0 && e.width <= 100)) return { path: `${at}.width`, text: '굵기는 0보다 크고 100 m 이하로 입력하세요.' };
    if (pl.length > 256) return { path: `${at}.polyline`, text: '선 하나의 점은 256개까지입니다. 나눠서 그리세요.' };
    if (distinct(pl) < 2) return { path: `${at}.polyline`, text: '서로 다른 점이 2개 이상 있어야 선이 됩니다.' };
    const o = out(pl, `${at}.polyline`); if (o) return o;
  }
  return dup('zones') ?? dup('waypoints') ?? dup('connectors') ?? dup('edits');
}

/** path → 고를 요소 키(«무리.번호»), 없으면 '' */
const keyOf = (path: string) => /^features\.(zones|waypoints|connectors|edits)\.(\d+)/.exec(path)?.slice(1).join('.') ?? '';
const split = (k: string) => { const [g, i] = k.split('.'); return [g as Group, Number(i)] as const; };
/** 사람이 알아볼 요소 이름 — 오류 문구 앞에 */
function label(f: MapFeatures, k: string) {
  if (!k) return '';
  const [g, i] = split(k), x = f[g][i] as Item | undefined;
  if (!x) return '';
  if (g === 'zones') return `${ZONE[(x as MapZone).type]?.text ?? ''} 구역 «${(x as MapZone).name}»: `;
  if (g === 'waypoints') return `지점 «${(x as MapWaypoint).name}»: `;
  if (g === 'connectors') return `${KIND[(x as MapConnector).kind] ?? ''} 연결점: `;
  return `${EDIT[(x as MapEdit).op]?.text ?? ''} 선: `;
}
/** 서버 422 INVALID_FEATURES → 걸린 요소 + 쉬운 말. 서버 문구는 대부분 그대로 쓰되 ID·형식 같은 말은 바꾼다 */
export function serverBad(e: ApiFail): Bad {
  const d = e.detail, list = Array.isArray(d?.elements) ? d.elements : [], path = typeof d?.element === 'string' ? d.element : typeof list[0] === 'string' ? list[0] as string : 'features';
  const text = /\.id$/.test(path) ? DUP : /\.pair_floor_id$/.test(path) ? '짝 층을 같은 건물의 다른 층으로 다시 고르세요.'
    : path === 'image' ? '이 판의 지도 정보를 확인할 수 없습니다. 새로 불러온 뒤 다시 편집하세요.'
    : list.length ? '저장할 수 있는 모양이 아닙니다. 이름·점 개수·굵기를 확인하세요.' : `${e.message} 고친 뒤 다시 저장하세요.`;
  return { path, text };
}
/** 저장 실패(422 밖) = 무엇이 + 어떻게. 403 등은 서버 문구 그대로 */
function saveFail(e: ApiFail) {
  if (e.status === 404) return '이 층이나 판을 찾을 수 없습니다. 지워졌을 수 있어 새로 불러오세요.';
  if (e.code === 'SERVER_BUSY') return '서버가 지금 다른 지도를 처리하고 있습니다. 잠시 뒤 다시 저장하세요.';
  if (e.code === 'TIMEOUT') return '서버가 제시간에 답하지 않았습니다. 네트워크를 확인한 뒤 다시 저장하세요.';
  return e.message;
}

type Tool = 'pick' | 'NO_GO' | 'SLOW' | 'waypoint' | 'connector' | 'ERASE' | 'WALL';
const TOOLS: [Tool, string][] = [['pick', '고르기'], ['NO_GO', '진입 금지'], ['SLOW', '감속'], ['waypoint', '지점'], ['connector', '연결점'], ['ERASE', '지우개'], ['WALL', '벽']];
const EMPTY: MapFeatures = { zones: [], waypoints: [], connectors: [], edits: [] };
const MIN_BOX = 8;   // 화면 px — 이보다 작은 끌기(그냥 누름 포함)는 구역을 만들지 않는다
const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;   // 같은 무리 안에서만 달라야 함(서버 검사)
const deg = (r: number) => Math.round((r * 180) / Math.PI), rad = (d: number) => (d * Math.PI) / 180;
const pointsOf = (x: Item): P[] => ('polygon' in x ? x.polygon : 'polyline' in x ? x.polyline : [[x.x, x.y]]) as P[];
/** 저장하지 않은 편집 — 폰 틀로 바뀌어 지도 탭이 내려가도 남겨 PC 로 돌아오면 이어 쓴다(B3). 나가기 확인·저장·로그아웃 때 비운다 */
type Draft = { floor: string; base: MapVersion; f: MapFeatures; dirty: boolean; pts: P[]; tool: Tool; dots: boolean; width: number; reason: string; unsure: string[] | null };   // unsure = 결재 요청 답이 끊겨 확인 전(보내기 전 내 대기 요청 ID)
/** 보낸 저장 요청(B5) — 기다리는 사이 폰 틀로 내려갔다 돌아와도 같은 층·같은 기준 판 편집이 잠금·결과를 이어받는다 */
type Job = { floor: string; base: string; wait: Promise<void>; known?: string[]; done?: { ok: MapVersion } | { fail: ApiFail } };   // known = 결재 요청 전 내 대기 요청 ID(받은 뒤에야 보냄)
export const kept: { d: Draft | null; job: Job | null } = { d: null, job: null };
addEventListener('beforeunload', (e) => { if (kept.d) { e.preventDefault(); e.returnValue = ''; } });
const STALE = '다른 사람이 먼저 이 층의 지도를 바꿨습니다. 편집 내용은 그대로 있습니다. «새로 불러오기»를 누르면 지금 편집 내용을 잃습니다.';

/** 편집. v = 편집 시작 때 승인 판(저장 기준·그림), p = 그 층. saved = 새 판(운영 관리자면 PENDING), quit = 보기로, recheck = 판 목록·나무 다시 받기
 *  moved = 남겨 둔 편집을 이어 쓰는데 그 사이 승인 판이 바뀜 → STALE 과 같은 안내. request = 운영 관리자(저장 = 결재 요청 — 문구만 다르고 같은 요청) */
export function Editor({ v, p, cancel, saved, quit, recheck, moved, request }: { v: MapVersion; p: Place; cancel?: AbortSignal; saved: (v: MapVersion) => void; quit: () => void; recheck: () => void; moved?: boolean; request?: boolean }) {
  const [k] = useState(() => (kept.d?.floor === p.floor.id && kept.d.base.id === v.id ? kept.d : null));
  const [f, setF] = useState<MapFeatures>(() => k?.f ?? JSON.parse(JSON.stringify({ ...v.features, edits: v.features.edits ?? [] })));
  const [dirty, setDirty] = useState(k?.dirty ?? false), [tool, setTool] = useState<Tool>(k?.tool ?? 'pick'), [pts, setPts] = useState<P[]>(k?.pts ?? []), [sel, setSel] = useState(''), [width, setWidth] = useState(k?.width ?? 0.1);
  // 구역 도구: 기본은 끌어서 사각형(box = 끄는 중인 두 화면 좌표), dots = «점으로 그리기»(둘레를 찍고 «닫기»)
  const [dots, setDots] = useState(k?.dots ?? false), [box, setBox] = useState<[P, P] | null>(null), rect = useRef<P | null>(null);
  const mine = (j: Job | null): j is Job => !!j && j.floor === p.floor.id && j.base === v.id;
  const [reason, setReason] = useState(k?.reason ?? ''), [busy, setBusy] = useState(() => mine(kept.job)), [msg, setMsg] = useState<Msg>(null), [bad, setBad] = useState<Bad | null>(null), [stale, setStale] = useState(false);
  const [ask, setAsk] = useState<{ text: string; yes: string; go: () => void } | null>(null);
  // 결재 요청 답이 끊김 — 내 대기 요청과 대조하기 전에는 다시 보내지 않고 편집도 잠근다(초안은 그대로). 찾으면 그 판으로 저장된 것처럼 끝낸다
  const u = useUnsure({ kind: 'MAP_REVISION', base: v.id, reason: reason.trim(), same: (x) => x.upload_id === v.upload_id && canon(x.features) === canon(f) },
    (x) => { leaving.ask = null; left.current = true; saved(x); }, setMsg, cancel, k?.unsure ?? null);
  // 저장 중·결재 요청 확인 전에는 편집을 모두 막는다 — 캔버스 누름·끌기·그리기와 모든 고치기(보낸 내용과 초안이 달라지지 않게). STOP 은 App 머리줄 그대로
  const lock = busy || u.unsure;
  useEffect(() => { if (lock) { drag.current = null; rect.current = null; setBox(null); } }, [lock]);
  const others = p.building.floors.filter((x) => x.id !== p.floor.id), svg = useRef<SVGSVGElement>(null), drag = useRef<{ key: string; from: P; orig: MapFeatures } | null>(null);
  const r = Math.max(v.width, v.height) / 100, zone = tool === 'NO_GO' || tool === 'SLOW', line = tool === 'ERASE' || tool === 'WALL';

  // 저장하지 않은 편집(그리던 점 포함): 탭 이동·층 바꾸기·보기 전환은 이 칸의 확인으로, 새로고침·창 닫기는 브라우저 확인으로
  const unsaved = dirty || pts.length > 0;
  // 내려갈 때 남긴다 — 나가기 확인·저장·새로 불러오기로 내려가면(left) 비운다
  const snap = useRef<Draft | null>(null), left = useRef(false);
  snap.current = unsaved ? { floor: p.floor.id, base: v, f, dirty, pts, tool, dots, width, reason, unsure: u.known } : null;
  useEffect(() => { kept.d = null; return () => { kept.d = left.current ? null : snap.current; }; }, []);
  useEffect(() => { if (moved && !busy) { setStale(true); setMsg({ text: STALE }); } }, [moved]);   // 저장을 기다리는 중이면 그 결과가 알린다

  // 저장 결과는 지금 올라와 있는 편집이 받는다(내려가 있던 사이 끝났으면 돌아올 때) — 결과를 받은 뒤에야 보관처를 비운다
  const settle = useRef((_: Job) => {}), alive = useRef(false);
  const follow = (j: Job) => j.wait.then(() => { if (alive.current) settle.current(j); });
  useEffect(() => { alive.current = true; if (mine(kept.job)) follow(kept.job); return () => { alive.current = false; if (left.current) kept.job = null; }; }, []);
  settle.current = (j) => {
    if (kept.job === j) kept.job = null;
    setBusy(false);
    const d = j.done!;
    if ('ok' in d) { leaving.ask = null; left.current = true; saved(d.ok); return; }
    const x = d.fail;
    if (x.code === 'CANCELED') return;
    // 저장 요청을 보낸 뒤 답이 끊기면 저장됐을 수도 있다 — 편집 내용은 그대로 둔다. 총괄은 목록을 다시 받아 보인다(다시 저장하면 승인 판이 바뀌어 STALE 로 막힘).
    // 운영 관리자는 승인 판이 그대로라 막히지 않는다 — 이번 요청을 확정하기 전에는 다시 보내지 않는다(useUnsure)
    if (request && !j.known) { setMsg(preFail(x)); return; }   // 요청 전 확인 실패 — 보내지 않음
    if (x.status === 0 && request) { setMsg({ text: '결재 요청 응답을 받지 못했습니다. 요청됐을 수 있어 내 대기 요청을 확인합니다.' }); recheck(); u.check(j.known); return; }
    if (x.status === 0) { setMsg({ text: '저장 응답을 받지 못했습니다. 저장됐을 수 있어 판 목록을 다시 받습니다. 새 판이 보이면 다시 저장하지 마세요.' }); recheck(); return; }
    if (x.code === 'STALE') { setStale(true); setMsg({ text: STALE }); return; }
    if (x.code === 'INVALID_FEATURES') { const b = serverBad(x); setBad(b); setSel(keyOf(b.path)); return; }
    setMsg({ text: `${request ? '결재를 요청하지 못했습니다.' : '저장하지 못했습니다.'} ${saveFail(x)}` });
  };
  useEffect(() => {
    if (!unsaved) return;
    leaving.ask = (go) => setAsk({ text: '저장하지 않은 편집이 있습니다. 나가면 편집 내용을 잃습니다.', yes: '나가기', go: () => { leaving.ask = null; left.current = true; go(); } });
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    addEventListener('beforeunload', h);
    return () => { leaving.ask = null; removeEventListener('beforeunload', h); };
  }, [unsaved]);

  // 연결점 짝: 짝 층 승인 판의 연결점 중 이 층을 짝으로 둔 것 — 같은 id·종류를 쓰면 서버가 두 층을 잇는다
  const [pairs, setPairs] = useState<Record<string, MapConnector[]>>({});
  const [sg, si] = sel ? split(sel) : ['', -1] as const, cur = sg ? (f[sg][si] as Item | undefined) : undefined;
  const pairFloor = sg === 'connectors' && cur ? (cur as MapConnector).pair_floor_id : '';
  useEffect(() => {
    const fl = others.find((x) => x.id === pairFloor);
    if (!fl?.approved_version_id || pairs[fl.id]) return;
    api.version(fl.approved_version_id, cancel).then(shape(isVersion)).then((x) => setPairs((o) => ({ ...o, [fl.id]: x.features.connectors.filter((k) => k.pair_floor_id === p.floor.id) })), () => {});
  }, [pairFloor]);

  const put = (n: MapFeatures) => { if (lock) return; setF(n); setDirty(true); setBad(null); setMsg(null); setStale(false); };
  const swap = (g: Group, i: number, x: Item) => put({ ...f, [g]: (f[g] as Item[]).map((o, k) => (k === i ? x : o)) });
  const add = (g: Group, x: Item) => { put({ ...f, [g]: [...f[g], x] }); setSel(`${g}.${f[g].length}`); };
  const drop = (k: string) => { const [g, i] = split(k); put({ ...f, [g]: (f[g] as Item[]).filter((_, j) => j !== i) }); setSel(''); };
  // 같은 도구는 그대로, 같은 갈래(구역↔구역·선↔선)는 그리던 점을 이어 쓰고, 그 밖은 점을 지울지 묻는다
  const pick = (t: Tool) => {
    if (lock) return;
    const same = (zone && (t === 'NO_GO' || t === 'SLOW')) || (line && (t === 'ERASE' || t === 'WALL')), go = () => { setTool(t); if (!same) setPts([]); setMsg(null); rect.current = null; setBox(null); };
    if (pts.length && !same) setAsk({ text: `그리던 점 ${pts.length}개를 지우고 도구를 바꿀까요?`, yes: '바꾸기', go }); else go();
  };
  const dotMode = (d: boolean) => {
    if (lock) return;
    const go = () => { setDots(d); setPts([]); setMsg(null); };
    if (pts.length && !d) setAsk({ text: `그리던 점 ${pts.length}개를 지우고 끌어서 그리기로 바꿀까요?`, yes: '바꾸기', go }); else go();
  };

  const at = (e: PointerEvent): P => fromScreen(svg.current!, v, e.clientX, e.clientY);
  const down = (e: PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 || lock) return;
    const q = at(e);
    if (tool === 'pick') {
      const k = (e.target as Element).closest('[data-key]')?.getAttribute('data-key') ?? '';
      setSel(k); setBad(null); setMsg(null);
      if (k) { drag.current = { key: k, from: q, orig: f }; svg.current!.setPointerCapture?.(e.pointerId); }
      return;
    }
    if (!inside(v, q[0], q[1])) return setMsg({ text: '지도 범위 밖은 찍을 수 없습니다. 지도 그림 안을 누르세요.' });
    setMsg(null);
    if (zone && !dots) { rect.current = [e.clientX, e.clientY]; setBox([rect.current, rect.current]); svg.current!.setPointerCapture?.(e.pointerId); return; }
    if (tool === 'waypoint') add('waypoints', { id: newId(), name: `지점 ${f.waypoints.length + 1}`, x: q[0], y: q[1], yaw: 0 });
    else if (tool === 'connector') {
      if (!others.length) return setMsg({ text: '같은 건물에 다른 층이 없어 연결점을 놓을 수 없습니다. 장소 «고치기»에서 층을 먼저 만드세요.' });
      add('connectors', { id: newId(), kind: 'STAIRS', pair_floor_id: others[0].id, x: q[0], y: q[1], yaw: 0 });
    } else setPts([...pts, q]);
  };
  const move = (e: PointerEvent<SVGSVGElement>) => {
    if (rect.current) { if (!lock) setBox([rect.current, [e.clientX, e.clientY]]); return; }
    const d = drag.current;
    if (!d || lock) return;
    const q = at(e), dx = q[0] - d.from[0], dy = q[1] - d.from[1], [g, i] = split(d.key), x = d.orig[g][i] as Item, sh = ([a, b]: P): P => [a + dx, b + dy];
    if (!dx && !dy) return;
    const n: Item = 'polygon' in x ? { ...x, polygon: (x.polygon as P[]).map(sh) } : 'polyline' in x ? { ...x, polyline: (x.polyline as P[]).map(sh) } : { ...x, x: x.x + dx, y: x.y + dy };
    if (!pointsOf(n).every(([a, b]) => inside(v, a, b))) return;   // 범위 밖으로는 옮기지 않는다(마지막 자리에 둠)
    put({ ...d.orig, [g]: (d.orig[g] as Item[]).map((o, k) => (k === i ? n : o)) });
  };
  /** 화면 사각형(두 모서리) → 지도 좌표 네 꼭짓점. 화면 축 사각형이라 origin 이 돌아 있어도 보이는 그대로 */
  const corners = ([a, b]: [P, P]): P[] => ([[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]] as P[]).map(([x, y]) => fromScreen(svg.current!, v, x, y));
  const end = (e: PointerEvent<SVGSVGElement>) => {
    drag.current = null;
    const a = rect.current;
    rect.current = null; setBox(null);
    if (!a || lock || e.type !== 'pointerup' || Math.abs(e.clientX - a[0]) < MIN_BOX || Math.abs(e.clientY - a[1]) < MIN_BOX) return;   // 취소·작은 끌기는 무시
    const c = corners([a, [e.clientX, e.clientY]]);
    if (!c.every(([x, y]) => inside(v, x, y))) return setMsg({ text: '사각형이 지도 범위 밖으로 나갔습니다. 지도 그림 안에서 끌어 그리세요.' });
    addZone(c);
  };

  /** 구역 하나 더하기 — 그 하나를 바로 검사해 걸리면 더하지 않고 알린다(더하면 true) */
  const addZone = (polygon: P[]) => {
    const t = tool as MapZone['type'], z: MapZone = { id: newId(), type: t, name: `${ZONE[t].text} ${f.zones.filter((x) => x.type === t).length + 1}`, polygon };
    const b = check({ ...EMPTY, zones: [z] }, v);
    if (b) { setMsg({ text: b.text }); return false; }
    add('zones', z);
    return true;
  };

  /** 그리던 구역·선 마치기 — 그 하나를 바로 검사해 걸리면 점을 그대로 두고 알린다 */
  const finish = () => {
    if (lock) return;
    if (zone) {
      if (pts.length < 3) return setMsg({ text: '점을 3개 이상 찍어야 구역을 닫을 수 있습니다.' });
      if (!addZone(pts)) return;
    } else if (line) {
      const x: MapEdit = { id: newId(), op: tool as MapEdit['op'], polyline: pts, width };
      const b = check({ ...EMPTY, edits: [x] }, v);
      if (b) return setMsg({ text: b.text });
      add('edits', x);
    }
    setPts([]);
  };

  const save = (e: FormEvent) => {
    e.preventDefault();
    if (lock || mine(kept.job) || !v.upload_id) return;   // 다른 층·기준 판의 옛 요청은 막지 않음(새 요청이 그 자리를 차지)
    if (pts.length) return setMsg({ text: '그리던 구역·선을 먼저 닫거나 지우세요.' });
    if (!dirty) return setMsg({ text: '바꾼 것이 없습니다. 도구로 지도를 고친 뒤 저장하세요.' });
    const b = check(f, v, others.map((x) => x.id));
    if (b) { setBad(b); setSel(keyOf(b.path)); setMsg(null); return; }
    const why = reasonBad(reason, '바꾼 이유');
    if (why) return setMsg({ text: why });
    send();
  };
  /** 보내기(저장·결재 요청). 다시 요청(UnsureBar 확인창)도 여기로 — 확인 전엔 편집이 잠겨 있어 보낸 내용 그대로 */
  const send = () => {
    setBusy(true); setMsg(null); setBad(null); setStale(false);
    const j: Job = { floor: p.floor.id, base: v.id, wait: Promise.resolve() };
    j.wait = (request ? pendingIds(cancel).then((k) => { j.known = k; }) : Promise.resolve())
      .then(() => api.saveVersion(p.floor.id, { base_version_id: v.id, image: v.upload_id, features: f, reason: reason.trim() }, cancel)).then(shape(isVersion))   // 빈·어긋난 201 = 저장 불확실(status 0)
      .then((x) => { j.done = { ok: x }; }, (y) => { j.done = { fail: y as ApiFail }; });
    kept.job = j;
    follow(j);
  };

  const hint = zone && !dots ? '지도에서 누른 채 끌면 사각형 구역이 생깁니다. 연달아 여러 개 그릴 수 있고, 다른 모양은 «점으로 그리기»를 누르세요.'
    : zone ? `점 ${pts.length}개 — 지도를 눌러 구역 둘레를 차례로 찍고, 3개 이상이면 «닫기»를 누르세요.`
    : line ? `점 ${pts.length}개 — 지도를 눌러 선을 찍고, 2개 이상이면 «끝내기»를 누르세요.`
    : tool === 'waypoint' ? '지도를 누르면 지점을 놓습니다. 놓은 뒤 이름과 방향을 고치세요.'
    : tool === 'connector' ? (others.length ? '지도를 누르면 계단·엘리베이터 연결점을 놓습니다. 놓은 뒤 짝 층을 고르세요.' : '같은 건물에 다른 층이 없어 연결점을 놓을 수 없습니다. 장소 «고치기»에서 층을 먼저 만드세요.')
    : '요소를 눌러 고르고, 끌어서 옮기세요.';
  const color = zone ? fillOf(f.zones.length) : line ? EDIT[tool as 'WALL'].color : 'var(--accent)';
  const num = (s: string) => (s.trim() === '' ? NaN : Number(s));

  return <div className="fh-form" aria-label="지도 편집">
    {ask && <div className="fh-row" role="group" aria-label="확인" ref={(e) => e?.scrollIntoView?.({ block: 'nearest' })}><span>{ask.text}</span>
      <button type="button" className="btn pri" onClick={() => { const a = ask; setAsk(null); a.go(); }}>{ask.yes}</button>
      <button type="button" className="btn" onClick={() => setAsk(null)}>계속 편집</button></div>}
    {!v.upload_id && <p className="fh-msg" role="alert">이 판은 아직 편집 저장을 지원하지 않습니다. 도구는 써 볼 수 있지만 새 판으로 저장할 수는 없습니다.</p>}
    {/* 저장 중엔 편집 입력을 모두 막는다(요청 뒤 바꾼 것이 201 뒤 사라지지 않게) — STOP 은 App 머리줄이라 그대로 */}
    <fieldset disabled={lock} style={{ display: 'contents' }}>
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
      <div role="toolbar" aria-label="편집 도구" aria-orientation="vertical" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {TOOLS.map(([t, text]) => <button key={t} type="button" className="btn" aria-pressed={tool === t} disabled={lock} onClick={() => pick(t)}>{text}</button>)}
      </div>
      <svg ref={svg} viewBox={`0 0 ${v.width} ${v.height}`} role="img" aria-label={`판 ${v.number} 편집`} data-map data-edit onPointerDown={down} onPointerMove={move} onPointerUp={end} onPointerCancel={end}
        style={{ display: 'block', flex: 1, minWidth: 0, maxHeight: '60vh', background: 'var(--panel2)', borderRadius: 8, touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none', cursor: tool === 'pick' ? 'default' : 'crosshair' }}>
        <image href={api.imageUrl(v.id)} width={v.width} height={v.height} style={{ imageRendering: 'pixelated' }} onError={() => setMsg({ text: '지도 그림을 불러오지 못했습니다. 보기로 돌아가 다시 불러오세요.' })} />
        <Shapes v={v} f={f} sel={sel} bad={bad ? keyOf(bad.path) : undefined} />
        {pts.length > 0 && <g data-drawing>
          <polyline points={pts.map(([x, y]) => toPixel(v, x, y).join(',')).join(' ')} style={{ fill: 'none', stroke: color, strokeWidth: 2, strokeDasharray: '4 3' }} vectorEffect="non-scaling-stroke" />
          {pts.map(([x, y], k) => { const [a, b] = toPixel(v, x, y); return <circle key={k} cx={a} cy={b} r={r * 0.6} style={{ fill: color }} />; })}
        </g>}
        {box && <polygon data-box points={corners(box).map(([x, y]) => toPixel(v, x, y).join(',')).join(' ')} style={{ fill: color, fillOpacity: 0.2, stroke: color, strokeWidth: 2, strokeDasharray: '4 3', pointerEvents: 'none' }} vectorEffect="non-scaling-stroke" />}
      </svg>
    </div>
    <p className="lv-note" role="status">{hint}</p>
    {(zone || line) && <div className="fh-row" role="group" aria-label="그리기">
      {zone && <button type="button" className="btn" aria-pressed={dots} disabled={lock} onClick={() => dotMode(!dots)}>점으로 그리기</button>}
      {(line || dots) && <>
        <button type="button" className="btn" disabled={lock || !pts.length} onClick={finish}>{zone ? '닫기' : '끝내기'}</button>
        <button type="button" className="btn" disabled={lock || !pts.length} onClick={() => setPts(pts.slice(0, -1))}>되돌리기</button>
        <button type="button" className="btn" disabled={lock || !pts.length} onClick={() => setPts([])}>지우기</button>
      </>}
      {line && <label className="fh-row"><span>굵기(m)</span><input className="inp" type="number" min={0.01} max={100} step={0.05} style={{ width: 96 }} value={Number.isFinite(width) ? width : ''} onChange={(e) => lock || setWidth(num(e.target.value))} /></label>}
    </div>}
    {cur && <div className="fh-form" role="group" aria-label="고른 요소">
      <b>{label(f, sel).replace(/: $/, '')}</b>
      {sg === 'zones' && <>
        <label className="fh-field"><span>이름</span><input className="inp" maxLength={128} value={(cur as MapZone).name} onChange={(e) => swap('zones', si, { ...(cur as MapZone), name: e.target.value })} /></label>
        <label className="fh-field"><span>종류</span><select className="inp" value={(cur as MapZone).type} onChange={(e) => swap('zones', si, { ...(cur as MapZone), type: e.target.value as MapZone['type'] })}>
          <option value="NO_GO">진입 금지</option><option value="SLOW">감속</option></select></label>
      </>}
      {sg === 'waypoints' && <>
        <label className="fh-field"><span>이름</span><input className="inp" maxLength={128} value={(cur as MapWaypoint).name} onChange={(e) => swap('waypoints', si, { ...(cur as MapWaypoint), name: e.target.value })} /></label>
        <label className="fh-field"><span>방향(도, 오른쪽 = 0, 반시계 +)</span><input className="inp" type="number" step={15} value={Number.isFinite((cur as MapWaypoint).yaw) ? deg((cur as MapWaypoint).yaw) : ''}
          onChange={(e) => swap('waypoints', si, { ...(cur as MapWaypoint), yaw: rad(num(e.target.value)) })} /></label>
      </>}
      {sg === 'connectors' && (() => { const c = cur as MapConnector, cands = (pairs[c.pair_floor_id] ?? []).filter((k) => k.id === c.id || !f.connectors.some((o) => o.id === k.id));
        return <>
          <label className="fh-field"><span>종류</span><select className="inp" value={c.kind} onChange={(e) => swap('connectors', si, { ...c, kind: e.target.value as MapConnector['kind'] })}>
            <option value="STAIRS">계단</option><option value="ELEVATOR">엘리베이터</option></select></label>
          <label className="fh-field"><span>짝 층(같은 건물)</span><select className="inp" value={c.pair_floor_id} onChange={(e) => swap('connectors', si, { ...c, pair_floor_id: e.target.value, id: newId() })}>
            {others.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label>
          <label className="fh-field"><span>짝 연결점</span><select className="inp" value={cands.some((k) => k.id === c.id) ? c.id : ''}
            onChange={(e) => { const k = cands.find((x) => x.id === e.target.value); swap('connectors', si, k ? { ...c, id: k.id, kind: k.kind } : { ...c, id: newId() }); }}>
            <option value="">새 연결점(짝 층에도 같은 짝을 놓아야 이어짐)</option>
            {cands.map((k) => <option key={k.id} value={k.id}>{`짝 층의 ${KIND[k.kind] ?? ''} 연결점 (${k.x.toFixed(1)}, ${k.y.toFixed(1)})`}</option>)}</select></label>
        </>; })()}
      {sg === 'edits' && <label className="fh-field"><span>굵기(m)</span><input className="inp" type="number" min={0.01} max={100} step={0.05} value={Number.isFinite((cur as MapEdit).width) ? (cur as MapEdit).width : ''}
        onChange={(e) => swap('edits', si, { ...(cur as MapEdit), width: num(e.target.value) })} /></label>}
      <div className="fh-row"><button type="button" className="btn" disabled={lock} onClick={() => drop(sel)}>이 요소 지우기</button></div>
    </div>}
    {bad && <p className="fh-msg" role="alert" data-bad>{label(f, keyOf(bad.path))}{bad.text}</p>}
    <form className="fh-form" onSubmit={save} noValidate aria-label={request ? '결재 요청' : '새 판으로 저장'}>
      <label className="fh-field"><span>바꾼 이유</span><input className="inp" maxLength={2000} value={reason} onChange={(e) => lock || setReason(e.target.value)} /></label>
      <div className="fh-row"><button type="submit" className="btn pri" disabled={lock || !v.upload_id}>{request ? '결재 요청' : '새 판으로 저장'}</button>
        {stale && <button type="button" className="btn" onClick={() => setAsk({ text: '새로 불러오면 지금 편집 내용을 잃습니다. 새로 불러올까요?', yes: '새로 불러오기', go: () => { leaving.ask = null; left.current = true; quit(); recheck(); } })}>새로 불러오기</button>}</div>
      {busy && <p className="lv-note" role="status">{request ? '결재를 요청하는 중…' : '새 판으로 저장하는 중…'}</p>}
      <Note m={msg} />
    </form>
    </fieldset>
    <UnsureBar u={u} resend={send} />
  </div>;
}
