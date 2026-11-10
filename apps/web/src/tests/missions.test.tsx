// W6a 임무 탭(01 MS-01·02·03·09, 02 F-MS-01~04·§10, 03 §5.3·U10, 05 §6 — S5a /actions·/missions·/scenarios·/scenarios/preview).
// fetch 는 상태를 가진 가짜 서버(판·If-Match·보관·권한·미리보기 흉내), WebSocket 은 FakeWS. 목록·보관 보기·더 보기, 임무 작업·인자 범위·회색 선택지·판 1→2·428·409·422,
// 옛 판 읽기 전용(옛 판 지도), 보관(확인창), 카탈로그 로봇 묶기, 시나리오 지점 찍기·끌기·순서·지도 지점·임무 고르기·갈 수 없음·연결점 없음·저장 막힘·409 STALE·422, 저장 불확실 대조,
// 운영 관리자 보는 중, 편집·미리보기·확인 중에도 STOP 이 보이고 실제로 정지 요청이 나가는지 본다.
import { act } from 'react';
import { createRoot, type Root as ReactRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Action, Assignment, MapVersion, Mission, MissionWrite, RobotSummary, Scenario, ScenarioPoint, ScenarioWrite, SiteTree, User } from '../../../contracts/ts';
import { Root } from '../session';
import { clearPlans, simNav } from '../screens/missions';
import { check, type BtNode } from '../screens/btedit';
import { TERRAIN_REASON } from '../simstart';
import { FakeWS } from './fakeWs';
import { adminNoStop } from './adminStop';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KIM: User = { id: 'a1', username: 'kim', display_name: '김총괄', role: 'ORG_ADMIN', locked: false, robot_ids: [], created_at: '2026-10-19T00:00:00Z' };
const LEE: User = { ...KIM, id: 'o1', username: 'lee', display_name: '이운영', role: 'OPERATOR', robot_ids: ['r-a'] };
const PARK: User = { ...LEE, id: 'o2', username: 'park', display_name: '박운영', robot_ids: [] };
const RA: RobotSummary = { id: 'r-a', name: 'Go2-A', model: 'unitree_go2', owner: { id: LEE.id, display_name: LEE.display_name },
  simulation: false, server_drive_allowed: false,
  connection: 'OFFLINE', status: null, battery: null, location: null, lease: null, current_run: null, devices: [], attention: [] };
// 지도 100×80 칸, 0.05 m, origin (-1, -2) → x -1~4 m, y -2~2 m. 1층: 진입 금지 x 3~4, 이름 붙은 지점 «입구»(0, 0), 2층 계단 연결점
const ver = (id: string, floor_id: string, features: MapVersion['features']): MapVersion => ({ upload_id: `up-${id}`, id, floor_id, number: 1, base_version_id: null, copied_from_id: null, status: 'APPROVED',
  image_sha256: 'ab'.repeat(32), width: 100, height: 80, resolution: 0.05, origin: [-1, -2, 0], features, reason: '처음', source: 'IMPORT', created_by: KIM.id, created_at: '2026-10-19T00:00:00Z' });
const F1 = { zones: [{ id: 'z1', type: 'NO_GO' as const, name: '공사', polygon: [[3, -2], [4, -2], [4, 2], [3, 2]] as [number, number][] }],
  waypoints: [{ id: 'wp1', name: '입구', x: 0, y: 0, yaw: 1.5 }], connectors: [{ id: 'c1', kind: 'STAIRS' as const, pair_floor_id: 'f2', x: 2, y: 1, yaw: 0 }], edits: [] };
const F2 = { zones: [], waypoints: [], connectors: [{ id: 'c2', kind: 'STAIRS' as const, pair_floor_id: 'f1', x: 2, y: 1, yaw: 0 }], edits: [] };
const MAPS: Record<string, MapVersion> = { v1: ver('v1', 'f1', F1), v2: ver('v2', 'f2', F2), v3: ver('v3', 'f1', F1) };
const floor = (id: string, name: string, level: number, approved: string | null) => ({ id, building_id: 'b1', name, level, approved_version_id: approved, pending_count: 0 });
const DEV: Record<string, string> = { rgb: 'CAMERA_RGB', depth: 'CAMERA_DEPTH', lidar: 'LIDAR', battery: 'BATTERY' };
/** 작업 카탈로그. robot = r-a 이면 배터리만 있는 로봇(카메라 없음) */
function acts(robot: string | null): Action[] {
  const has = (k: string) => !robot || k === 'BATTERY', why = (k: string) => (has(k) ? null : `필요한 장치가 없거나 정상 상태가 아닙니다: ${k}`);
  const opt = (param: 'camera' | 'device', value: 'rgb' | 'depth' | 'lidar' | 'battery') => ({ param, value, requires: [DEV[value]], available: has(DEV[value]), why_unavailable: why(DEV[value]) });
  return [
    { key: 'PHOTO', label: '사진 찍기', params: { camera: 'rgb' }, requires: ['CAMERA_RGB'], available: has('CAMERA_RGB'), why_unavailable: why('CAMERA_RGB'), options: [opt('camera', 'rgb'), opt('camera', 'depth')] },
    { key: 'WAIT', label: '대기', params: { seconds: 5 }, requires: [], available: true, why_unavailable: null, options: [] },
    { key: 'OPERATOR_CONFIRM', label: '운영자 확인', params: { prompt: '계속할까요?' }, requires: [], available: true, why_unavailable: null, options: [] },
    { key: 'SENSOR_LOG', label: '센서 값 기록', params: { device: 'rgb', seconds: 10 }, requires: [], available: true, why_unavailable: null, options: (['rgb', 'depth', 'lidar', 'battery'] as const).map((v) => opt('device', v)) },
  ];
}
const err = (status: number, code: string, message: string, detail = {}) => ({ status, body: { error: { code, message, detail } } });

type Kind = 'missions' | 'scenarios';
type Rec = { head: Mission | Scenario; snaps: (Mission | Scenario)[] };
type Reply = { status: number; body?: unknown };
type Call = { method: string; path: string; q: URLSearchParams; body?: unknown; match?: string };
let f1Extra: Record<string, unknown> = {}, sitePurpose = 'REAL', calls: Call[] = [], assigns: Assignment[] = [], db: Record<Kind, Rec[]>, approved: Record<string, string | null>, link = true, tick = 0;
const stamp = () => new Date(Date.UTC(2026, 9, 20, 1, tick++)).toISOString();
const reqOf = (steps: MissionWrite['steps']) => [...new Set(steps.flatMap((s) => (s.action === 'PHOTO' ? [DEV[String(s.params?.camera)]] : s.action === 'SENSOR_LOG' ? [DEV[String(s.params?.device)]] : [])))];
const rec = (k: Kind, id: string) => db[k].find((r) => r.head.id === id);
/** 본문에서 서버가 붙이는 값 */
function derive(k: Kind, b: MissionWrite | ScenarioWrite) {
  if (k === 'missions') return { ...b, required_devices: reqOf((b as MissionWrite).steps) };
  const s = b as ScenarioWrite;
  return { notes: '', finish: { mode: 'STAY', target: null }, ...s, floor_ids: [...new Set(s.waypoints.map((w) => w.floor_id))], map_version_ids: [...new Set(s.waypoints.map((w) => w.map_version_id))],
    required_devices: [...new Set(s.waypoints.flatMap((w) => rec('missions', w.mission_id)?.snaps[w.mission_version - 1]?.required_devices ?? []))], est_distance_m: 12.3 };
}
/** 항목 하나 만들기(판 1) — 시험 준비와 POST 가 같이 쓴다 */
function make(k: Kind, b: MissionWrite | ScenarioWrite, by: User, archived = false) {
  const at = stamp(), id = `${k[0]}${db[k].length + 1}`;
  const head = { ...derive(k, b), id, number: 1, latest_version: 1, version: archived ? 2 : 1, created_by: by.id, created_at: at, version_created_by: by.id, version_created_at: at, archived_at: archived ? at : null } as Mission | Scenario;
  db[k].push({ head, snaps: [{ ...head }] });
  return head;
}
/** 새 판(PUT 이 성공한 것과 같음) */
function bump(k: Kind, id: string, b: MissionWrite | ScenarioWrite, by: User) {
  const r = rec(k, id)!, at = stamp(), n = r.head.latest_version + 1;
  r.head = { ...r.head, ...derive(k, b), number: n, latest_version: n, version: r.head.version + 1, version_created_by: by.id, version_created_at: at } as Mission | Scenario;
  r.snaps.push({ ...r.head });
  return r.head;
}
const M1: MissionWrite = { name: '사진 순찰', steps: [{ action: 'PHOTO', params: { camera: 'rgb' } }, { action: 'WAIT', params: { seconds: 5 } }] };
const M2: MissionWrite = { name: '센서 기록', steps: [{ action: 'SENSOR_LOG', params: { device: 'battery', seconds: 10 } }] };
const pt = (floor_id: string, x: number, y: number, p: Partial<ScenarioPoint> = {}) => ({ floor_id, map_version_id: approved[floor_id]!, x, y, yaw: 0, waypoint_ref: null, ...p });
const wp = (floor_id: string, x: number, y: number, mission_id = 'm1', mission_version = 1, p: Partial<ScenarioPoint> = {}) => ({ ...pt(floor_id, x, y, p), mission_id, mission_version });

/** 미리보기 흉내: 판이 승인 판이 아니면 409 STALE, 고른 임무 판이 없으면 422, 지도 밖·진입 금지(x ≥ 3)·참조 어긋남 = 갈 수 없음, 층이 바뀌는데 연결점 짝이 없으면(link=false) 구간 갈 수 없음 */
function preview(b: ScenarioWrite): Reply {
  const all: [string, ScenarioPoint][] = [...b.waypoints.map((w, i) => [`waypoints.${i}`, w] as [string, ScenarioPoint]), ...(b.finish?.mode === 'GO_TO' && b.finish.target ? [['finish.target', b.finish.target] as [string, ScenarioPoint]] : [])];
  const stale = all.filter(([, p]) => approved[p.floor_id] !== p.map_version_id).map(([e]) => e);
  if (stale.length) return err(409, 'STALE', '지도가 바뀌었습니다. 새 승인 판으로 다시 확인하세요.', { elements: stale, approved_version_id: approved.f1 });
  const lost = b.waypoints.findIndex((w) => !rec('missions', w.mission_id)?.snaps[w.mission_version - 1]);
  if (lost >= 0) return err(422, 'PRECHECK_FAILED', '임무 판을 찾을 수 없습니다.', { elements: [`waypoints.${lost}.mission_version`] });
  const points = all.map(([element, p]) => {
    const reasons: string[] = [], ref = p.waypoint_ref ? MAPS[p.map_version_id].features.waypoints.find((w) => w.id === p.waypoint_ref) : null;
    if (p.x < -1 || p.x > 4 || p.y < -2 || p.y > 2) reasons.push('지도 범위 밖입니다.'); else if (p.floor_id === 'f1' && p.x >= 3) reasons.push('진입 금지 구역 안입니다.');
    if (p.waypoint_ref && !ref) reasons.push('지도 판의 지점 ID와 일치하지 않습니다.'); else if (ref && Math.hypot(ref.x - p.x, ref.y - p.y) > 0.05) reasons.push('참조 지점 좌표에서 0.05 m 넘게 벗어났습니다.');
    return { element, reasons };
  });
  const segments = all.slice(1).map(([end, q], i) => {
    const [start, p] = all[i], cross = p.floor_id !== q.floor_id;
    if (cross && !link) { points[i + 1].reasons.push('두 층을 직접 잇는 연결점 짝이 없습니다.'); return { start, end, reachable: false, reason: '두 층을 직접 잇는 연결점 짝이 없습니다.', connector_id: null, distance_m: null, via: [] }; }
    return { start, end, reachable: true, reason: null, connector_id: cross ? 'c1' : null, distance_m: 3, via: cross ? [pt(p.floor_id, 2, 1), pt(q.floor_id, 2, 1)] : [] };
  });
  const d = derive('scenarios', b) as Scenario;
  return { status: 200, body: { reachable: points.every((p) => !p.reasons.length) && segments.every((s) => s.reachable), points: points.map((p) => ({ ...p, reachable: !p.reasons.length })), segments,
    floor_ids: d.floor_ids, map_version_ids: d.map_version_ids, required_devices: d.required_devices, est_distance_m: 12.3, distance_note: '직선 거리 근사이며 Nav2 경로가 아닙니다.' } };
}

/** 가짜 서버. page = 한 번에 줄 수, over = 경로별 덮어쓰기(앞에서부터 하나씩 꺼냄 — 함수면 real() 로 진짜 처리를 부를 수 있다) */
function serve(me: User, o: { page?: number; over?: Record<string, (Reply | ((real: () => Reply) => Reply | Promise<Reply>))[]> } = {}) {
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET', [path, qs = ''] = url.replace(/^\/api\/v1/, '').split('?'), q = new URLSearchParams(qs);
    const body = init.body ? JSON.parse(String(init.body)) : undefined, match = (init.headers as Record<string, string> | undefined)?.['If-Match'], key = `${method} ${path}`;
    calls.push({ method, path, q, body, match });
    const real = () => route(method, path, q, body, match), queued = o.over?.[key]?.shift();
    return json(queued ? (typeof queued === 'function' ? await queued(real) : queued) : real());
  });
  const json = (r: Reply) => new Response(r.status === 204 ? null : JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
  function route(method: string, path: string, q: URLSearchParams, body?: never, match?: string): Reply {
    if (path === '/auth/session') return { status: 200, body: { client: 'web', csrf_token: 'csrf-1' } };
    if (path === '/me') return { status: 200, body: me };
    if (path === '/robots') return { status: 200, body: { items: [RA], next_cursor: null } };
    if (path === '/robots/r-a') return { status: 200, body: RA };
    if (path === '/dashboard') return { status: 200, body: { robots_total: 1, robots_online: 0, robots_attention: 0, robots_running: 0, approvals_pending: 0, operators: [] } };
    if (path === '/notifications') return { status: 200, body: { items: [], next_cursor: null, unread_count: 0 } };
    if (path === '/sites') {
      const tree = { items: [{ id: 's1', name: '본관', purpose: sitePurpose, buildings: [{ id: 'b1', site_id: 's1', name: '본동', floors: [{ ...floor('f1', '1층', 1, approved.f1), ...f1Extra }, floor('f2', '2층', 2, approved.f2), floor('f3', '3층', 3, null)] }] }], next_cursor: null } as unknown as SiteTree;
      return { status: 200, body: tree };
    }
    let m = path.match(/^\/map-versions\/(v\d)$/);
    if (m) return { status: 200, body: MAPS[m[1]] };
    if ((m = path.match(/^\/floors\/(f\d)\/map-versions$/))) { const v = approved[m[1]]; return { status: 200, body: { items: v && MAPS[v] ? [MAPS[v]] : [], next_cursor: null } }; }   // 지도 탭 판 목록(MAP-TAB-MERGE)
    if (path === '/actions') return { status: 200, body: acts(q.get('robot_id')) };
    if (path === '/assignments') return { status: 200, body: { items: assigns, next_cursor: null } };
    if (method === 'POST' && path === '/scenarios/preview') return preview(body!);
    if (method === 'POST' && (m = path.match(/^\/trash\/scenario\/([^/]+)\/restore$/))) {   // 휴지통에서 꺼내기(§5.1 — 본체 version 증가)
      const r = rec('scenarios', m[1]); if (!r) return err(404, 'NOT_FOUND', '휴지통 항목을 찾을 수 없습니다.');
      if (r.head.archived_at) r.head = { ...r.head, archived_at: null, version: r.head.version + 1 }; return { status: 204 };
    }
    if (method === 'DELETE' && path === '/scenarios/s9') return err(409, 'RESOURCE_IN_USE', '사용 중이거나 결재 대기 중인 로봇 배정이 있어 휴지통 이동 또는 완전 삭제를 할 수 없습니다. 배정을 먼저 해제하세요.');
    m = path.match(/^\/(missions|scenarios)(?:\/([^/]+))?$/);
    if (!m) return err(404, 'NOT_FOUND', '찾을 수 없습니다.');
    const k = m[1] as Kind, id = m[2];
    if (!id && method === 'GET') {
      const all = db[k].filter((r) => (q.get('archived') === 'true' || !r.head.archived_at) && (q.get('mine') !== 'true' || r.head.created_by === me.id)
        && (!q.get('floor_id') || (r.head as Scenario).floor_ids.includes(q.get('floor_id')!))).map((r) => r.head), from = Number(q.get('cursor') ?? 0), n = o.page ?? Number(q.get('limit'));
      return { status: 200, body: { items: all.slice(from, from + n), next_cursor: from + n < all.length ? String(from + n) : null } };
    }
    if (!id && method === 'POST') {
      if (k === 'scenarios') { const p = preview(body!); if (p.status !== 200) return p; if (!(p.body as { reachable: boolean }).reachable) return err(422, 'PRECHECK_FAILED', '갈 수 없는 지점이 있습니다.', { elements: [], preview: p.body }); }
      return { status: 201, body: make(k, body!, me) };
    }
    const r = rec(k, id);
    if (!r) return err(404, 'NOT_FOUND', '찾을 수 없습니다.');
    if (method === 'GET') {
      const n = q.get('version');
      if (!n) return { status: 200, body: r.head };
      const s = r.snaps[Number(n) - 1];
      return s ? { status: 200, body: { ...s, version: r.head.version, latest_version: r.head.latest_version, archived_at: r.head.archived_at } } : err(404, 'NOT_FOUND', '판을 찾을 수 없습니다.');
    }
    if (method === 'DELETE') { if (!r.head.archived_at) r.head = { ...r.head, archived_at: stamp(), version: r.head.version + 1 }; return { status: 204 }; }
    if (!match) return err(428, 'PRECONDITION_REQUIRED', 'If-Match 가 필요합니다.');
    if (r.head.archived_at) return err(409, 'VERSION_CONFLICT', '보관된 항목은 변경할 수 없습니다.', { version: r.head.version });
    if (match !== `"${r.head.version}"`) return err(409, 'VERSION_CONFLICT', '다른 사용자가 먼저 변경했습니다.', { version: r.head.version });
    if (k === 'scenarios') { const p = preview(body!); if (p.status !== 200) return p; if (!(p.body as { reachable: boolean }).reachable) return err(422, 'PRECHECK_FAILED', '갈 수 없는 지점이 있습니다.', { elements: [], preview: p.body }); }
    return { status: 200, body: bump(k, id, body!, me) };
  }
}
/** 기본 자료: 임무 m1(김총괄)·m2(이운영)·m3(보관), 시나리오 s1(김총괄, 1층 지점 2개)·s2(보관) */
function seed() {
  db = { missions: [], scenarios: [] }; approved = { f1: 'v1', f2: 'v2' }; sitePurpose = 'REAL'; f1Extra = {}; MAPS.v1 = ver('v1', 'f1', F1); link = true; tick = 0; assigns = [];
  make('missions', M1, KIM); make('missions', M2, LEE); make('missions', { name: '옛 임무', steps: [{ action: 'WAIT', params: { seconds: 1 } }] }, KIM, true);
  make('scenarios', { name: '1층 순찰', waypoints: [wp('f1', 1, 1), wp('f1', 0, 0, 'm1', 1, { yaw: 1.5, waypoint_ref: 'wp1' })], finish: { mode: 'STAY', target: null }, notes: '' }, KIM);
  make('scenarios', { name: '지난 시나리오', waypoints: [wp('f1', 1, 0)] }, KIM, true);
}
const sent = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);
const last = <T,>(l: T[]) => l[l.length - 1];
const writes = () => calls.filter((c) => c.method !== 'GET' && c.path !== '/scenarios/preview').map((c) => `${c.method} ${c.path}`);

let root: ReactRoot | null = null, box: HTMLDivElement;
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); });
/** 미리보기는 입력을 멈추고 0.4초 뒤 — 그만큼 기다린다 */
const settle = async () => { await act(() => new Promise((r) => setTimeout(r, 450))); await flush(); };
async function open(hash = '#/mission') {
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  location.hash = hash;
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<Root />); });
  await flush();
  // 옛 #/mission 주소 → 지도 탭 «시나리오» 창(MAP-TAB-MERGE) — 지도 고르기 화면이면 첫 건물 1층
  const ch = box.querySelector<HTMLButtonElement>('[data-building]');
  if (ch) { act(() => ch.click()); await flush(); }
}
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); clearPlans(); localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const $ = <T extends Element = HTMLElement>(s: string, from: ParentNode = box) => from.querySelector<T>(s);
const btns = (from: ParentNode = box) => [...from.querySelectorAll('button')];
const btn = (t: string, from: ParentNode = box) => btns(from).find((b) => b.textContent === t) as HTMLButtonElement | undefined;
const aria = (l: string) => $<HTMLButtonElement>(`button[aria-label="${l}"]`) ?? undefined;
const card = (label: string) => $(`[aria-label="${label}"]`)!;
const click = async (b: Element | undefined | null) => { expect(b).toBeTruthy(); act(() => (b as HTMLElement).click()); await flush(); };
const setVal = async (el: HTMLInputElement | HTMLSelectElement, v: string) => {
  act(() => { Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!.call(el, v); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); });
  await flush();
};
const field = (label: string, from: ParentNode = box) => [...from.querySelectorAll('label')].find((l) => l.textContent!.startsWith(label))!.querySelector('input, select') as HTMLInputElement;
const alertText = () => [...box.querySelectorAll('[role="alert"]')].map((a) => a.textContent).join(' ');
const text = () => box.textContent!;
const row = (id: string) => $<HTMLButtonElement>(`[data-plan="${id}"]`)!;
const rows = () => [...box.querySelectorAll<HTMLButtonElement>('[data-plan]')].map((b) => b.getAttribute('data-plan'));
const name = () => field('이름');
const step = (i: number) => $(`[data-step="${i}"]`)!;
const point = (i: number) => $(`[data-wp="${i}"]`)!;
const saveBtn = () => btn('저장')!;
/** 종류 바꾸기 = 시나리오 창 «임무 관리…» ↔ 임무 관리 단추 줄 «‹ 지도·시나리오»(MAP-TAB-MERGE). 이미 그 종류면 그대로 */
const kind = async (k: '임무' | '시나리오') => {
  if (k === '시나리오') { const b = btn('‹ 지도·시나리오'); if (b) await click(b); return; }
  if (btn('‹ 지도·시나리오')) return;
  if (!btn('임무 관리…')) await click($('[data-back]') ?? $('[data-side="scen"]'));   // 열린 시나리오는 닫고(편집은 남음) 시나리오 창으로
  await click(btn('임무 관리…'));
};
/** 시나리오 지도 — 100×80 칸을 400×320 으로 그린다고 치고 지도 좌표(m)로 누른다: 화면 x = (x + 1)·80, y = (2 - y)·80 */
const map = () => $<SVGSVGElement>('svg[data-scenario-map]')!;
const sized = () => { map().getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 320, right: 400, bottom: 320, x: 0, y: 0, toJSON() {} }) as DOMRect; };
const ptr = async (type: string, x: number, y: number, on: Element = map()) => {
  act(() => { on.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: (x + 1) * 80, clientY: (2 - y) * 80, button: 0 })); });
  await flush();
};
const tap = async (x: number, y: number, on?: Element) => { sized(); await ptr('pointerdown', x, y, on); await ptr('pointerup', x, y, on); };
/** STOP 이 머리줄 맨 끝에 있고 누를 수 있다 + 실제로 눌러 정지 요청이 실시간 연결로 나간다 */
const stopSends = async () => {
  if (adminNoStop(box)) return;
  const s = $<HTMLButtonElement>('[data-stop]')!;
  expect(s.disabled).toBe(false);
  expect($('header')!.lastElementChild).toBe(s);
  act(() => FakeWS.last.open());
  await click(s);
  const sel = $<HTMLSelectElement>('[aria-label="정지할 로봇"]');
  if (sel) { await setVal(sel, 'r-a'); await click(btn('정지', $('[aria-label="정지할 로봇 고르기"]')!)); }
  expect(FakeWS.last.of('stop').map((m) => m.robot)).toEqual(['r-a']);
};

describe('목록 [임무 | 시나리오]', () => {
  it('시나리오 창 기본(MAP-TAB-MERGE) — 고른 층 것만(floor_id)·휴지통 제외, 이름·판·지점 수, 휴지통 링크·«다른 지도는 지도를 바꿔서», «임무 관리…»', async () => {
    seed(); serve(KIM);
    await open();
    const q = sent('GET', '/scenarios');
    expect(last(q)!.q.get('limit')).toBe('50'); expect(last(q)!.q.get('archived')).toBeNull(); expect(last(q)!.q.get('floor_id')).toBe('f1');
    expect(rows()).toEqual(['s1']);
    expect(row('s1').textContent).toBe('1층 순찰지점 2 · 약 12 m');
    expect(card('시나리오 목록 창').textContent).not.toContain('Go2-A');
    expect(card('시나리오 목록 창').textContent).toContain('다른 지도의 시나리오는 지도를 바꿔서 봅니다.'); expect($('[data-trash-link]')!.getAttribute('href')).toBe('#/trash');
    await kind('임무');
    expect(card('임무 편집')).toBeTruthy();
    expect(rows()).toEqual(['m1', 'm2']);
    expect(row('m1').textContent).toBe('사진 순찰작업 2');
    expect(btn('새 임무')).toBeTruthy();
    await click(field('보관된 것도 보기'));
    expect(last(sent('GET', '/missions'))!.q.get('archived')).toBe('true');
    expect(rows()).toEqual(['m1', 'm2', 'm3']);
    await stopSends();
  });
  it('배정된 로봇 열: ACTIVE·결재 대기만(해제·반려 빼고, 같은 로봇 한 번), 서버 값이 없는 마지막 실행 줄은 없음 / 배정 목록 실패 → «?» + 안내', async () => {
    seed();
    const a = (id: string, robot: string, status: Assignment['status'], scenario_version = 1): Assignment => ({ id, scenario_id: 's1', scenario_version, robot_id: `r-${robot}`, memo: '', scenario_name: '1층 순찰', scenario_name_snapshot: null,
      robot_name: `Go2-${robot}`, status, approval_id: null, created_by: KIM.id, created_at: '2026-10-20T00:00:00Z', removed_at: null });
    assigns = [a('a1', 'A', 'ACTIVE'), a('a2', 'A', 'ACTIVE', 2), a('a3', 'B', 'PENDING'), a('a4', 'C', 'REMOVED'), a('a5', 'D', 'REJECTED')];
    serve(KIM);
    await open();
    expect(row('s1').querySelector('[data-col="robots"]')!.textContent).toBe('로봇 Go2-A, Go2-B(결재 대기)');
    expect(row('s1').querySelector('[data-col="last-run"]')).toBeNull();
    expect(sent('GET', '/assignments')[0].q.get('robot_id')).toBeNull();                 // 조직 전체
    act(() => root?.unmount()); box.remove(); clearPlans();
    serve(KIM, { over: { 'GET /assignments': [err(500, 'INTERNAL_ERROR', '서버 오류입니다.')] } });
    await open();
    expect(row('s1').querySelector('[data-col="robots"]')!.textContent).toBe('로봇 ?');
    expect(card('시나리오 목록 창').textContent).toContain('배정된 로봇을 받지 못했습니다');
    await kind('임무');
    expect(row('m1').querySelector('[data-col]')).toBeNull();                            // 임무에는 배정·실행 열 없음
    await stopSends();
  });
  it('거르기 «내 것만» = 서버 mine, 층은 지도 탭에서 고른 층(floor_id) — 맞는 것이 없으면 안내, 임무에는 거르기 없음', async () => {
    seed();
    make('scenarios', { name: '2층 점검', waypoints: [wp('f2', 1, 1)] }, LEE);
    serve(LEE);
    await open();
    expect(rows()).toEqual(['s1']);
    const pane = card('시나리오 목록 창');
    await click(field('내 것만', pane));
    expect(last(sent('GET', '/scenarios'))!.q.get('mine')).toBe('true'); expect(last(sent('GET', '/scenarios'))!.q.get('floor_id')).toBe('f1');
    expect(rows()).toEqual([]);
    expect(card('시나리오 목록 창').textContent).toContain('이 지도에 내 시나리오가 없습니다.');
    await click(field('내 것만', card('시나리오 목록 창')));
    expect(last(sent('GET', '/scenarios'))!.q.get('mine')).toBeNull();
    expect(rows()).toEqual(['s1']);
    await kind('임무');
    expect([...box.querySelectorAll('label')].some((l) => l.textContent === '내 것만')).toBe(false);
    expect(last(sent('GET', '/missions'))!.q.get('mine')).toBeNull(); expect(last(sent('GET', '/missions'))!.q.get('floor_id')).toBeNull();
    await stopSends();
  });
  it('«더 보기» = next_cursor 로 이어 받기(앞 것 유지)', async () => {
    seed(); serve(KIM, { page: 1 });
    await open();
    await kind('임무');
    expect(rows()).toEqual(['m1']);
    await click(btn('더 보기'));
    expect(last(sent('GET', '/missions'))!.q.get('cursor')).toBe('1');
    expect(rows()).toEqual(['m1', 'm2']);
    expect(btn('더 보기')).toBeUndefined();
  });
  it('목록을 못 받으면 오류 + 다시 시도', async () => {
    seed(); serve(KIM, { over: { 'GET /scenarios': [err(500, 'INTERNAL_ERROR', '서버 오류입니다.'), err(500, 'INTERNAL_ERROR', '서버 오류입니다.')] } });   // 지도 고르기의 시나리오 수·시나리오 창 목록
    await open();
    expect(alertText()).toContain('시나리오 목록을 받지 못했습니다. 서버 오류입니다.');
    await click(btn('다시 시도'));
    expect(rows()).toEqual(['s1']);
  });
});

describe('임무 편집', () => {
  it('새 임무: 카탈로그에서 작업 추가·인자 범위 검사(1~3600초) → POST 판 1 → 고쳐 PUT If-Match "1" → 판 2', async () => {
    seed(); serve(KIM);
    await open(); await kind('임무');
    await click(btn('새 임무'));
    expect(sent('GET', '/actions')[0].q.get('robot_id')).toBeNull();
    await setVal(name(), '창고 점검');
    await click(btn('＋ 대기')); await click(btn('＋ 운영자 확인'));
    const sec = field('기다릴 시간', step(0));
    expect(sec.value).toBe('5'); expect(sec.min).toBe('1'); expect(sec.max).toBe('3600');
    await setVal(sec, '0');
    await click(saveBtn());
    expect(alertText()).toContain('1번 작업: 시간은 1~3600초 사이 정수로 입력하세요.');
    expect(step(0).hasAttribute('data-bad')).toBe(true); expect(step(1).hasAttribute('data-bad')).toBe(false);
    await setVal(sec, '3601'); await click(saveBtn());
    expect(writes()).toEqual([]);
    await setVal(field('기다릴 시간', step(0)), '30');
    await setVal(field('확인 문구', step(1)), '   ');
    await click(saveBtn());
    expect(alertText()).toContain('2번 작업:'); expect(writes()).toEqual([]);
    await setVal(field('확인 문구', step(1)), '문 닫혔나요?');
    await click(saveBtn());
    expect(writes()).toEqual(['POST /missions']);
    expect(sent('POST', '/missions')[0].body).toEqual({ name: '창고 점검', steps: [{ action: 'WAIT', params: { seconds: 30 } }, { action: 'OPERATOR_CONFIRM', params: { prompt: '문 닫혔나요?' } }] });
    expect(text()).toContain('저장했습니다.');
    expect(rows()).toContain('m4');
    await setVal(name(), '창고 점검 2');
    await click(btn('저장'));
    const put = sent('PUT', '/missions/m4');
    expect(put).toHaveLength(1); expect(put[0].match).toBe('"1"');
    expect(text()).toContain('저장했습니다.');
    expect(($('select[aria-label="저장 기록"]') as HTMLSelectElement).selectedOptions[0].textContent).toBe('2번째 저장 (최신)');
  });
  it('작업 순서 바꾸기·지우기, 작업이 없으면 저장 안 됨', async () => {
    seed(); serve(KIM);
    await open(); await kind('임무');
    await click(row('m1'));
    await click(aria('2번 작업 위로'));
    expect(step(0).textContent).toContain('대기'); expect(step(1).textContent).toContain('사진 찍기');
    await click(aria('1번 작업 지우기')); await click(aria('1번 작업 지우기'));
    await click(saveBtn());
    expect(alertText()).toContain('작업을 하나 이상 추가하세요.'); expect(writes()).toEqual([]);
  });
  it('로봇을 고르면 그 로봇이 못 하는 작업·선택지는 회색 + 이유(장치 이름은 우리말), 고를 수 없다', async () => {
    seed(); serve(KIM);
    await open(); await kind('임무');
    await click(btn('새 임무'));
    await setVal(field('장치 확인할 로봇'), 'r-a');
    expect(last(sent('GET', '/actions'))!.q.get('robot_id')).toBe('r-a');
    const photo = btn('＋ 사진 찍기')!;
    expect(photo.disabled).toBe(true);
    expect(document.getElementById(photo.getAttribute('aria-describedby')!)!.textContent).toBe('필요한 장치가 없거나 정상 상태가 아닙니다: 카메라');
    expect(text()).not.toContain('CAMERA_RGB');
    await click(btn('＋ 센서 값 기록'));
    const dev = field('장치', step(0)) as unknown as HTMLSelectElement;
    expect(dev.value).toBe('battery');                     // 기본(rgb)을 이 로봇이 못 해서 할 수 있는 것으로
    expect([...dev.options].map((o) => [o.value, o.disabled])).toEqual([['rgb', true], ['depth', true], ['lidar', true], ['battery', false]]);
    expect(step(0).querySelectorAll('[data-why]')).toHaveLength(3);
    expect(step(0).textContent).toContain('라이다: 필요한 장치가 없거나 정상 상태가 아닙니다: 라이다');
  });
  it('409 VERSION_CONFLICT(남이 먼저 저장) = 입력 그대로 + «최신 판 받기» 뒤 다음 판으로 저장', async () => {
    seed(); serve(KIM);
    await open(); await kind('임무');
    await click(row('m1'));
    await setVal(name(), '내가 고친 이름');
    bump('missions', 'm1', { ...M1, name: '남이 고친 이름' }, PARK);
    await click(saveBtn());
    expect(sent('PUT', '/missions/m1')[0].match).toBe('"1"');
    expect(text()).toContain('다른 사람이 먼저 저장했습니다. 입력은 그대로 있습니다.');
    expect(name().value).toBe('내가 고친 이름');
    await click(btn('최신 내용 받기'));
    expect(name().value).toBe('내가 고친 이름');
    expect(text()).toContain('최신 내용을 받았습니다.');
    await click(saveBtn());
    expect(sent('PUT', '/missions/m1')[1].match).toBe('"2"');
    expect(text()).toContain('저장했습니다.');
    expect(rec('missions', 'm1')!.head.name).toBe('내가 고친 이름');
  });
  it('428(판 확인 없음)도 충돌과 같이 — 입력 유지, 덮어쓰지 않음', async () => {
    seed(); serve(KIM, { over: { 'PUT /missions/m1': [err(428, 'PRECONDITION_REQUIRED', 'If-Match 가 필요합니다.')] } });
    await open(); await kind('임무');
    await click(row('m1'));
    await setVal(name(), '고친 이름');
    await click(saveBtn());
    expect(text()).toContain('다른 사람이 먼저 저장했습니다.'); expect(text()).not.toContain('If-Match');
    expect(name().value).toBe('고친 이름'); expect(btn('최신 내용 받기')).toBeTruthy();
    expect(rec('missions', 'm1')!.head.latest_version).toBe(1);
  });
  it('422 elements = 걸린 작업 줄 표시', async () => {
    seed(); serve(KIM, { over: { 'PUT /missions/m1': [err(422, 'PRECHECK_FAILED', '입력 값을 확인하세요.', { elements: ['steps.1.params.seconds'] })] } });
    await open(); await kind('임무');
    await click(row('m1'));
    await setVal(name(), '고친 이름');
    await click(saveBtn());
    expect(step(1).hasAttribute('data-bad')).toBe(true); expect(step(0).hasAttribute('data-bad')).toBe(false);
    expect(step(1).textContent).toContain('이 작업의 값을 확인하세요.');
    expect(text()).toContain('입력 값을 확인하세요. 표시한 곳을 고친 뒤 다시 저장하세요.');
  });
  it('판 목록 → 옛 판은 읽기 전용(덮어쓰기·되돌리기 단추 없음), 최신 판으로 돌아오면 다시 편집', async () => {
    seed(); bump('missions', 'm1', { ...M1, name: '사진 순찰 v2' }, KIM); serve(KIM);
    await open(); await kind('임무');
    await click(row('m1'));
    expect(name().value).toBe('사진 순찰 v2');
    await setVal($<HTMLSelectElement>('select[aria-label="저장 기록"]')!, '1');
    expect(last(sent('GET', '/missions/m1'))!.q.get('version')).toBe('1');
    expect($('[data-old]')!.textContent).toContain('옛 기록(1번째 저장)을 보는 중입니다(읽기 전용');
    expect(name().value).toBe('사진 순찰'); expect(name().readOnly).toBe(true);
    expect(btn('저장')).toBeUndefined(); expect(btn('보관')).toBeUndefined();
    expect(btns().some((b) => /덮어|되돌리|이 기록으로/.test(b.textContent!))).toBe(false);
    expect(step(0).textContent).toContain('카메라');
    await setVal($<HTMLSelectElement>('select[aria-label="저장 기록"]')!, '2');
    expect(name().value).toBe('사진 순찰 v2'); expect(btn('저장')).toBeTruthy();
  });
  it('보관 = 화면 안 확인창(되돌릴 수 없음)을 거쳐 DELETE — 취소면 안 보냄, 목록에서 빠지고 «보관된 것도 보기»에서 읽기 전용', async () => {
    seed(); serve(KIM);
    const confirm = vi.spyOn(window, 'confirm');
    await open(); await kind('임무');
    await click(row('m1'));
    await click(btn('보관'));
    expect(writes()).toEqual([]);
    expect(card('보관 확인').textContent).toContain('보관하면 되돌릴 수 없습니다');
    await click(btn('취소'));
    expect(writes()).toEqual([]); expect($('[aria-label="보관 확인"]')).toBeNull();
    await click(btn('보관'));
    await stopSends();                                               // 확인창이 떠 있어도 STOP
    await click(btn('보관하기'));
    expect(confirm).not.toHaveBeenCalled();
    expect(writes()).toEqual(['DELETE /missions/m1']);
    expect(text()).toContain('보관했습니다.');
    expect(rows()).toEqual(['m2']);
    expect($('[data-readonly]')!.textContent).toContain('보관된 임무입니다.');
    expect(btn('저장')).toBeUndefined();
  });
});

describe('시나리오 휴지통(05 §5.1, 11-02)', () => {
  it('삭제 = 화면 안 확인창 → DELETE(휴지통으로) → «휴지통으로 옮겼습니다 · 되돌리기» = 복원, 휴지통 보기에서 읽기 전용 + 복원', async () => {
    seed(); serve(LEE);   // 운영 관리자도 같은 기능(10-25)
    const confirm = vi.spyOn(window, 'confirm');
    await open();
    await click(row('s1'));
    await click(btn('삭제'));
    expect(writes()).toEqual([]);
    expect(card('삭제 확인').textContent).toContain('휴지통으로 옮길까요?');
    await click(btn('휴지통으로'));
    expect(confirm).not.toHaveBeenCalled();
    expect(writes()).toEqual(['DELETE /scenarios/s1']);
    expect(text()).toContain('휴지통으로 옮겼습니다.');
    expect($('[data-readonly]')!.textContent).toContain('휴지통에 있는 시나리오입니다.');
    await click(btn('되돌리기'));
    expect(writes()).toEqual(['DELETE /scenarios/s1', 'POST /trash/scenario/s1/restore']);
    expect(text()).toContain('시나리오를 되돌렸습니다.');
    expect($('[data-readonly]')).toBeNull(); expect(btn('저장')).toBeTruthy();
    await click(btn('삭제')); await click(btn('휴지통으로'));
    await click($('[data-back]'));
    expect(rows()).toEqual([]);                                      // 시나리오 창 목록엔 휴지통 것 없음(MAP-TAB-MERGE)
    // 휴지통 것은 옛 주소·알림 링크(#/mission/<id>)로 열면 읽기 전용 + «복원»
    act(() => root?.unmount()); box.remove(); clearPlans();
    await open('#/mission/s2');
    expect($('[data-readonly]')!.textContent).toContain('휴지통에 있는 시나리오입니다.');
    await click(btn('복원'));
    expect(last(writes())).toBe('POST /trash/scenario/s2/restore');
    expect($('[data-readonly]')).toBeNull();
    await stopSends();
  });
  it('쓰는 중이면 409 RESOURCE_IN_USE = 쉬운 문구 + 서버가 알려 준 무엇', async () => {
    seed(); serve(KIM);
    await open();
    db.scenarios.push({ ...db.scenarios[0], head: { ...db.scenarios[0].head, id: 's9', name: '배정된 순찰' } });
    await kind('임무'); await kind('시나리오');
    await click(row('s9'));
    await click(btn('삭제')); await click(btn('휴지통으로'));
    expect(text()).toContain('삭제하지 못했습니다. 실행 중이거나 배정된 곳에서 쓰는 중입니다. 사용 중이거나 결재 대기 중인 로봇 배정이 있어');
    expect($('[data-readonly]')).toBeNull();
  });
});

describe('권한(02 §10)', () => {
  it('운영 관리자도 남의 임무·시나리오를 편집(10-27 — 결재·소유 제한 없음), 저장은 바로 새 판', async () => {
    seed(); serve(LEE);
    await open();
    await click(row('s1'));
    expect($('[data-readonly]')).toBeNull(); expect(text()).not.toContain('보는 중');
    expect(btn('저장')).toBeTruthy(); expect(btn('삭제')).toBeTruthy(); expect(name().readOnly).toBe(false);
    expect(aria('1번 지점 지우기')).toBeTruthy(); expect(btn('결재 요청')).toBeUndefined();
    await setVal(name(), '1층 순찰 고침');
    await settle();
    await click(saveBtn());
    expect(sent('PUT', '/scenarios/s1')).toHaveLength(1);
    expect(text()).toContain('저장했습니다.');
    await kind('임무');
    await click(row('m1'));
    expect($('[data-readonly]')).toBeNull(); expect(btn('＋ 대기')).toBeTruthy(); expect(aria('1번 작업 지우기')).toBeTruthy();
    await stopSends();
  });
  it('총괄은 남(운영 관리자)의 것도 편집', async () => {
    seed(); serve(KIM);
    await open(); await kind('임무');
    await click(row('m2'));
    expect($('[data-readonly]')).toBeNull(); expect(btn('저장')).toBeTruthy();
  });
});

/** 지도 고르기(장소 › 건물 › 층 드롭다운 하나) */
const floorSel = () => $<HTMLSelectElement>('select[aria-label="지도"]')!;
const floorOpt = (n: string) => [...floorSel().options].find((o) => o.textContent!.startsWith(`본관 › 본동 › ${n}`))!;
const pickFloor = (n: string) => setVal(floorSel(), floorOpt(n).value);
describe('시나리오 편집(03 §5.3)', () => {
  it('임무가 0개여도 안내 없이 지점을 찍을 수 있다 — 기본 «이동» 임무(steps 없음)를 만들어 잇는다(11-04)', async () => {
    seed(); db.missions = []; serve(KIM);
    await open();
    await click(btn('+ 이 지도에 새 시나리오'));
    expect($('[data-no-mission]')).toBeNull();
    expect(sent('POST', '/missions')).toHaveLength(0);                 // 지점을 찍기 전엔 만들지 않음
    await tap(1, 1);
    expect(sent('POST', '/missions').map((c) => c.body)).toEqual([{ name: '이동', steps: [] }]);
    expect($<HTMLSelectElement>('select[aria-label="1번 지점 할 일"]')!.value).toBe('MOVE');
    expect(point(0).querySelector('[data-do]')!.textContent).toBe('할 일: 이동 — 멈추지 않고 지나감');
    await tap(1, 0);
    expect(sent('POST', '/missions')).toHaveLength(1);                 // 둘째 지점은 같은 이동 임무를 다시 쓴다
  });
  it('SCEN-SAVE-FIX: 노드 보기(기본)에서 새 시나리오 → 지점 → 저장: 이름이 비면 [목록]·지점 상세를 풀어 이름 칸을 보이고 초점, 이름 넣고 저장 = POST', async () => {
    seed(); serve(KIM);
    await open();
    await click(btn('+ 이 지도에 새 시나리오'));
    expect($('[data-look="node"]')!.getAttribute('aria-pressed')).toBe('true');   // 기본 노드 보기
    await tap(1, 1); await settle();
    expect(name().closest('[hidden]')).not.toBeNull();                         // 노드 보기·1번 지점 상세에 가려 있음
    await click(saveBtn());
    expect(writes()).toEqual(['POST /missions']);                               // 이름 검사에서 막힘(시나리오 POST 없음)
    expect(alertText()).toContain('이름을 입력하세요.');
    expect($('[data-look="list"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(name().closest('[hidden]')).toBeNull();
    expect(document.activeElement).toBe(name());
    await setVal(name(), '새 순찰'); await settle();
    await click(saveBtn());
    expect(writes()).toEqual(['POST /missions', 'POST /scenarios']);
    expect(last(sent('POST', '/scenarios'))!.body).toMatchObject({ name: '새 순찰' });
  });
  it('SCEN-LIFECYCLE-EDITOR: 지도 탭 노드 보기 = 운영 흐름(real 판정) — 연결 단계 8개 «됨», 다른 단계는 읽기만, «시뮬에서 실행 못 함» 없음', async () => {
    seed(); serve(KIM);
    await open(); await click(row('s1')); await settle();
    expect($('button[data-stage="임무"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(box.querySelectorAll('.react-flow__node .sn-num')).toHaveLength(2);
    expect($('[data-st="no"]')).toBeNull();
    await click($('button[data-stage="연결"]'));
    expect($('.react-flow__node[data-id="robot"]')).toBeNull();                       // R3: 고정 절차는 처음 접힘(요약 카드)
    await click($('.react-flow__node[data-id="s:연결"]')); await click($('[data-support-toggle]'));   // 펼치고 지원 현황 켜면 판정 배지
    expect(['robot', 'request', 'auth', 'response', 'media', 'connected', 'retry', 'connection_failed'].map((id) => $(`.react-flow__node[data-id="${id}"] .sn-badge`)!.textContent)).toEqual(Array(8).fill('됨'));
    expect(box.querySelectorAll('.react-flow__node.draggable')).toHaveLength(0);
    expect($('.sn-hint')!.textContent).toContain('실기체 검증과 다름');
    expect(writes()).toEqual([]);
  });
  it('REVIEW-302: 노드 보기(기본)에서도 저장을 막는 이유(지점 없음·진입 금지)와 경로 확인 실패 «다시 확인»이 지도 위에 보인다(hidden 조상 없음)', async () => {
    seed();
    const over: Record<string, ((real: () => Reply) => Reply | Promise<Reply>)[]> = { 'POST /scenarios/preview': [] };
    serve(KIM, { over });
    await open();
    await click(btn('+ 이 지도에 새 시나리오'));
    expect($('[data-look="node"]')!.getAttribute('aria-pressed')).toBe('true');
    const why = () => $('[data-block]')!;
    expect(why().textContent).toBe('지도를 눌러 지점을 하나 이상 찍으세요.');
    expect(why().closest('[hidden]')).toBeNull();
    expect(saveBtn().disabled).toBe(true);
    await tap(3.5, 0); await settle();                                     // 진입 금지 구역 안
    expect(why().textContent).toBe('갈 수 없는 지점이 있어 저장할 수 없습니다. 빨간 지점을 옮기거나 지우세요.');
    expect(why().closest('[hidden]')).toBeNull();
    over['POST /scenarios/preview'].push(() => { throw new TypeError('끊김'); });
    await tap(1, 1); await settle();                                       // 경로 확인 실패
    const again = btn('다시 확인')!;
    expect(again.closest('[hidden]')).toBeNull();
    expect(again.parentElement!.textContent).toContain('경로를 확인하지 못했습니다.');
    expect($('[data-block]')).toBeNull();                                  // 같은 이유를 두 번 쓰지 않음
    await click(again); await settle();
    expect(btn('다시 확인')).toBeUndefined();
    expect(why().textContent).toBe('갈 수 없는 지점이 있어 저장할 수 없습니다. 빨간 지점을 옮기거나 지우세요.');
  });
  it('SCEN-ONE-FLOW-R2: 크게 보기(기본) = 지도는 떠 있는 창(Float) 안 — 창을 옮기고 접었다 펴도 지도 눌러 지점 추가 그대로, 저장 막는 이유는 창 밖(접어도 보임)', async () => {
    seed(); serve(KIM);
    await open();
    await click(btn('+ 이 지도에 새 시나리오'));
    expect($('[data-scen-nodes]')!.hasAttribute('data-big')).toBe(true);
    const win = () => map().closest<HTMLElement>('[data-win]')!;
    expect(win()).toBeTruthy();
    expect($('[data-block]')!.closest('[data-win]')).toBeNull();
    const head = win().querySelector('.mx-win-head')!;
    act(() => { for (const [t, x] of [['pointerdown', 500], ['pointermove', 400], ['pointerup', 300]] as const) head.dispatchEvent(new MouseEvent(t, { bubbles: true, clientX: x, clientY: 300, button: 0 })); });
    await flush();
    expect(JSON.parse(localStorage.getItem('fh.scen.mapwin')!)).toMatchObject({ x: 0, y: 0, fold: false });   // jsdom 본문 0×0 → 가둔 값으로 기억
    await click(aria('지도 창 접기')); expect(win().hasAttribute('data-fold')).toBe(true);
    await click(aria('지도 창 펼치기')); expect(win().hasAttribute('data-fold')).toBe(false);
    await tap(1, 1); await settle();
    expect(writes()).toEqual(['POST /missions']);                              // 새 지점의 이동 임무(지점 추가 그대로)
    expect(box.querySelectorAll('.react-flow__node .sn-num')).toHaveLength(1);
    expect(map().querySelector('[data-pt="0"]')).toBeTruthy();
    await click($('[data-big-toggle]'));                                       // 원래 크기 = 같은 지도(창 줄·칩은 CSS 로 숨김)
    expect([$('[data-scen-nodes]')!.hasAttribute('data-big'), !!map().closest('[data-win]')]).toEqual([false, true]);
  });
  it('SCEN-ONE-FLOW-R3: 지점 편집 창(할 일·X/Y·뒤로) 저장 본문 = 목록 편집(할 일·지도 끌기·↓)과 같은 값, 노드 ↔ 지도 선택 연동, 지도 범위 밖은 막음', async () => {
    const save = async () => { await settle(); expect(saveBtn().disabled).toBe(false); await click(saveBtn()); return last(sent('PUT', '/scenarios/s1'))!.body; };
    // ① 편집 창
    seed(); serve(KIM);
    await open(); await click(row('s1')); await settle();
    expect($('[data-point-edit]')).toBeNull();
    await click($('.react-flow__node[data-id="w0"]'));
    const ed = () => $('[data-point-edit]')!;
    expect([ed().getAttribute('data-point-edit'), map().querySelector('[data-pt="0"] circle')!.getAttribute('r')]).toEqual(['0', String(Math.max(100, 80) / 60 * 1.3)]);   // 노드 → 지도 강조
    expect(ed().textContent).toContain('이동·할 일만 편집됩니다. 안전 절차는 고정입니다.'); expect(ed().textContent).toContain('위치 변경 뒤에는 실제 경로 검사가 필요합니다.');
    expect($('[data-win-foot]')!.textContent).toBe('1번 지점 · 사진 순찰');
    await setVal($<HTMLSelectElement>('[data-edit-kind]', ed())!, 'PHOTO');
    const X = () => $<HTMLInputElement>('input[aria-label="1번 지점 X(m)"]')!, Y = () => $<HTMLInputElement>('input[aria-label="1번 지점 Y(m)"]')!;
    await setVal(X(), '9');
    expect(ed().textContent).toContain('지도 범위 밖입니다.');                             // 막음 — 좌표 그대로
    await setVal(X(), '2'); await setVal(Y(), '0.5');
    expect(ed().textContent).not.toContain('지도 범위 밖입니다.');
    expect($('[data-edit-up]', ed())!.hasAttribute('disabled')).toBe(true);
    await click($('[data-edit-down]', ed()));
    expect(ed().getAttribute('data-point-edit')).toBe('1');                               // 옮긴 지점을 따라감
    const a = await save();
    // ② 목록(같은 편집)
    act(() => root?.unmount()); root = null; box.remove(); clearPlans(); localStorage.clear(); calls = [];
    seed(); serve(KIM);
    await open(); await click(row('s1')); await settle(); await click($('[data-look="list"]'));
    await setVal($<HTMLSelectElement>('select[aria-label="1번 지점 할 일"]')!, 'PHOTO');
    sized(); await ptr('pointerdown', 1, 1, map().querySelector('[data-pt="0"]')!); await ptr('pointermove', 2, 0.5); await ptr('pointerup', 2, 0.5);
    await click(aria('1번 지점 아래로'));
    const b = await save();
    expect(a).toEqual(b);
    expect((a as ScenarioWrite).waypoints.map((w) => [w.x, w.y, w.waypoint_ref])).toEqual([[0, 0, 'wp1'], [2, 0.5, null]]);
    // ③ 지도에서 고르면 편집 창도 그 지점(노드 보기로 돌아가서)
    await click($('[data-look="node"]'));
    sized(); await ptr('pointerdown', 0, 0, map().querySelector('[data-pt="0"]')!); await ptr('pointerup', 0, 0, map().querySelector('[data-pt="0"]')!);
    expect([ed().getAttribute('data-point-edit'), $('.react-flow__node[data-id="w0"] .sn-card')!.hasAttribute('data-on')]).toEqual(['0', true]);
    expect($('[data-win-foot]')!.textContent).toContain('1번 지점 · 입구');
  });
  it('지도 눌러 추가·지도 지점 고르기(waypoint_ref)·순서·끌어 옮기기·층 바꾸기·임무 고르기 → 미리보기(대략 거리·장치) → POST', async () => {
    seed(); serve(KIM);
    await open();
    await click(btn('+ 이 지도에 새 시나리오'));
    expect(floorSel().className).toBe('fh-user fh-sel');               // 앱 공용 고르기 모양(PR #114)
    expect([...floorSel().options].map((o) => o.textContent)).toEqual(['본관 › 본동 › 1층', '본관 › 본동 › 2층', '본관 › 본동 › 3층 — 승인된 지도 없음']);
    expect(floorOpt('3층').disabled).toBe(true);                       // 승인 판 없는 층
    expect(floorSel().value).toBe('f1');
    expect(map().querySelector('[data-zone="NO_GO"]')).toBeTruthy();   // 진입 금지 구역 그림
    await setVal(name(), '새 순찰');
    await tap(1, 1);
    await tap(0, 0, map().querySelector('[data-key="waypoints.0"]')!);
    expect(point(0).textContent).toContain('(1.0, 1.0) m'); expect(point(1).textContent).toContain('«입구»');
    expect($<HTMLSelectElement>('select[aria-label="1번 지점 할 일"]')!.value).toBe('MOVE');   // 기본 = 이동(11-04)
    await click(aria('2번 지점 위로'));
    expect(point(0).textContent).toContain('«입구»');
    sized(); await ptr('pointerdown', 1, 1, map().querySelector('[data-pt="1"]')!); await ptr('pointermove', 1.5, 0.5); await ptr('pointerup', 1.5, 0.5);
    expect(point(1).textContent).toContain('(1.5, 0.5) m');
    await pickFloor('2층');
    await tap(2, 0);
    await setVal($<HTMLSelectElement>('select[aria-label="3번 지점 할 일"]')!, 'PHOTO');
    expect(floorOpt('1층').textContent).toBe('본관 › 본동 › 1층 (지점 2)');
    expect(point(0).textContent).toContain('본동 1층 · «입구»'); expect(point(2).querySelector('.mx-name')!.textContent).not.toContain('본동');   // 층 이름은 지금 보는 지도와 다른 층 지점에만
    await settle();
    const pre = sent('POST', '/scenarios/preview');
    expect(pre.length).toBeGreaterThan(0);
    expect(last(pre)!.body).toEqual({ name: '새 순찰', notes: '', finish: { mode: 'STAY', target: null }, waypoints: [
      wp('f1', 0, 0, 'm4', 1, { yaw: 1.5, waypoint_ref: 'wp1' }), wp('f1', 1.5, 0.5, 'm4'), wp('f2', 2, 0, 'm5', 1)] });
    const p = card('경로 확인');
    expect(p.textContent).toContain('모든 지점에 갈 수 있습니다.');
    expect(p.textContent).toContain('예상 거리 약 12 m');
    expect(p.textContent).toContain('대략 값입니다. 실제로 걷는 길은 실행할 때 로봇이 정합니다.');
    expect(p.textContent).toContain('필요 장치: 카메라');
    expect(p.textContent).toContain('2번 지점 → 3번 지점본동 1층 → 본동 2층 층 연결점을 거칩니다');
    expect(text()).not.toContain('Nav2 경로가 아닙니다');   // 서버 distance_note 를 그대로 안 보임(운영 흐름 노드 처리 주체 «…+Nav2» 는 별개)
    expect(saveBtn().disabled).toBe(false);
    await click(saveBtn());
    expect(writes()).toEqual(['POST /missions', 'POST /missions', 'POST /scenarios']);   // 이동·사진 임무 → 시나리오
    expect(text()).toContain('저장했습니다.');
    await click($('[data-back]'));                                   // 저장해도 열린 채 — «‹ 목록»으로 이 지도 목록
    expect(rows()).toEqual(['s1', 's3']);
  });
  it('두 손가락 집기(확대)만 하면 지점이 생기지 않고, 뒤의 한 손가락 누름은 뗄 때 하나(PR #119 r1)', async () => {
    seed(); serve(KIM);
    await open();
    await click(btn('+ 이 지도에 새 시나리오'));
    sized();
    const touch = async (type: string, x: number, y: number, id: number) => {
      act(() => {
        const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: (x + 1) * 80, clientY: (2 - y) * 80, button: 0 });
        Object.defineProperties(e, { pointerId: { value: id }, pointerType: { value: 'touch' } }); map().dispatchEvent(e);
      });
      await flush();
    };
    await touch('pointerdown', 0.25, 0, 1); await touch('pointerdown', 2.75, 0, 2);
    await touch('pointermove', -1, 0, 1); await touch('pointerup', -1, 0, 1); await touch('pointerup', 2.75, 0, 2);
    expect($('[data-wp="0"]')).toBeNull();
    await touch('pointerdown', 1, 1, 3);
    expect($('[data-wp="0"]')).toBeNull();                              // 누르는 동안은 아직(집기일 수 있다)
    await touch('pointerup', 1, 1, 3);
    expect(point(0)).toBeTruthy(); expect($('[data-wp="1"]')).toBeNull();
  });
  it('진입 금지 구역 안 지점 = 갈 수 없음 + 이유 + 저장 막힘(이유 보임), 지도 밖은 찍지 않음', async () => {
    seed(); serve(KIM);
    await open();
    await click(btn('+ 이 지도에 새 시나리오'));
    await setVal(name(), '금지 시험');
    await tap(4.5, 0);
    expect(alertText()).toContain('지도 범위 밖은 찍을 수 없습니다.'); expect($('[data-wp="0"]')).toBeNull();
    await tap(3.5, 0);
    expect(saveBtn().disabled).toBe(true);
    expect($('[data-block]')!.textContent).toBe('경로를 확인하는 중입니다.');
    await settle();
    expect(point(0).hasAttribute('data-bad')).toBe(true);
    expect(point(0).textContent).toContain('갈 수 없음: 진입 금지 구역 안입니다.');
    expect(map().querySelector('[data-pt="0"]')!.hasAttribute('data-bad')).toBe(true);
    expect(saveBtn().disabled).toBe(true);
    expect($('[data-block]')!.textContent).toBe('갈 수 없는 지점이 있어 저장할 수 없습니다. 빨간 지점을 옮기거나 지우세요.');
    await click(saveBtn());
    expect(writes()).toEqual(['POST /missions']);                    // 기본 이동 임무만 — 시나리오는 저장 안 됨
    await stopSends();                                               // 미리보기·막힘 중에도 STOP
  });
  it('층 연결점 짝이 없으면 구간·끝 지점에 이유, 저장 막힘', async () => {
    seed(); link = false; serve(KIM);
    await open();
    await click(btn('+ 이 지도에 새 시나리오'));
    await setVal(name(), '두 층');
    await tap(1, 1);
    await pickFloor('2층'); await tap(1, 1);
    await settle();
    expect(card('구간').textContent).toContain('1번 지점 → 2번 지점두 층을 직접 잇는 연결점 짝이 없습니다.');
    expect(point(1).textContent).toContain('갈 수 없음: 두 층을 직접 잇는 연결점 짝이 없습니다.');
    expect(saveBtn().disabled).toBe(true);
  });
  it('끝나면 «지정 지점으로 이동» = 끝 지점을 찍어야 미리보기·저장, 끝 지점은 finish.target', async () => {
    seed(); serve(KIM);
    await open();
    await click(btn('+ 이 지도에 새 시나리오'));
    await setVal(name(), '돌아가기');
    await tap(1, 1);
    await setVal(field('끝나면'), 'GO_TO');
    expect($('[data-block]')!.textContent).toBe('끝나고 갈 지점을 지도에서 찍으세요.');
    await tap(-0.5, -1);
    await settle();
    expect(last(sent('POST', '/scenarios/preview'))!.body).toMatchObject({ finish: { mode: 'GO_TO', target: { floor_id: 'f1', map_version_id: 'v1', x: -0.5, y: -1, waypoint_ref: null } } });
    expect(map().querySelector('[data-pt="T"]')).toBeTruthy();
    expect(saveBtn().disabled).toBe(false);
    await setVal(field('끝나면'), 'RETURN_TO_START');
    await settle();
    expect(last(sent('POST', '/scenarios/preview'))!.body).toMatchObject({ finish: { mode: 'RETURN_TO_START', target: null } });
  });
  it('저장이 409 STALE(지도가 바뀜) = 지점 그대로 + «새 지도로 다시 확인» → 새 승인 판으로 다시 미리보기 → 저장', async () => {
    seed(); serve(KIM);
    await open();
    await click(row('s1'));
    await setVal(name(), '1층 순찰 고침');
    await settle();
    expect(saveBtn().disabled).toBe(false);
    approved.f1 = 'v3';                                              // 그사이 1층 지도가 새로 승인됨
    await click(saveBtn());
    expect(sent('PUT', '/scenarios/s1')).toHaveLength(1);
    expect(text()).toContain('지도가 바뀌었습니다. 지점은 그대로 두었습니다.');
    expect([0, 1].map((i) => point(i).textContent)).toEqual([expect.stringContaining('(1.0, 1.0) m'), expect.stringContaining('«입구»')]);
    await settle();
    await click(btn('새 지도로 다시 확인'));
    await settle();
    expect(last(sent('POST', '/scenarios/preview'))!.body).toMatchObject({ waypoints: [{ map_version_id: 'v3', x: 1, y: 1 }, { map_version_id: 'v3', waypoint_ref: 'wp1' }] });
    expect(card('경로 확인').textContent).toContain('모든 지점에 갈 수 있습니다.');
    await click(saveBtn());
    expect(sent('PUT', '/scenarios/s1')).toHaveLength(2);
    expect(text()).toContain('저장했습니다.');
    expect(rec('scenarios', 's1')!.head).toMatchObject({ name: '1층 순찰 고침', map_version_ids: ['v3'] });
  });
  it('422 elements = 걸린 지점 표시', async () => {
    seed(); serve(KIM, { over: { 'PUT /scenarios/s1': [err(422, 'PRECHECK_FAILED', '입력 값을 확인하세요.', { elements: ['waypoints.1.mission_version'] })] } });
    await open();
    await click(row('s1'));
    await setVal(name(), '고침');
    await settle();
    await click(saveBtn());
    expect(point(1).hasAttribute('data-bad')).toBe(true); expect(point(0).hasAttribute('data-bad')).toBe(false);
    expect(point(1).textContent).toContain('이 지점을 확인하세요.');
    expect(saveBtn().disabled).toBe(true);                             // 앞 미리보기는 버리고 다시 확인할 때까지 저장 막힘(B4)
    expect($('[data-block]')!.textContent).toBe('경로를 확인하는 중입니다.');
  });
  it('지도 지점에 붙은 지점을 0.05 m 넘게 끌면 참조를 뗀다', async () => {
    seed(); serve(KIM);
    await open();
    await click(row('s1'));
    // 끌다가 0.05 m 안으로 돌아오면 그대로(누름 판정 8px 을 넘긴 끌기)
    sized(); await ptr('pointerdown', 0, 0, map().querySelector('[data-pt="1"]')!); await ptr('pointermove', 0.5, 0); await ptr('pointermove', 0.02, 0); await ptr('pointerup', 0.02, 0);
    expect(point(1).textContent).toContain('«입구»');
    sized(); await ptr('pointerdown', 0, 0, map().querySelector('[data-pt="1"]')!); await ptr('pointermove', 0.5, 0); await ptr('pointerup', 0.5, 0);
    expect(point(1).textContent).toContain('(0.5, 0.0) m');
    await settle();
    expect(last(sent('POST', '/scenarios/preview'))!.body).toMatchObject({ waypoints: [{}, { x: 0.5, y: 0, waypoint_ref: null }] });
  });
  it('지점 누름 = 고르기만(단계 창 그 줄 강조·굴림), 지우기는 고른 지점 오른쪽 위 X — 확인창 없이 «되돌리기» 한 번, 끌면 옮김 — 단계 창 «지우기»도 같음', async () => {
    seed(); serve(KIM);
    await open();
    await click(btn('+ 이 지도에 새 시나리오'));
    await tap(1, 1); await tap(2, 0); await tap(0, 1);
    expect([0, 1, 2].map((i) => point(i).textContent)).toEqual([expect.stringContaining('(1.0, 1.0) m'), expect.stringContaining('(2.0, 0.0) m'), expect.stringContaining('(0.0, 1.0) m')]);
    const confirm = vi.spyOn(window, 'confirm'), seen = vi.fn(); Element.prototype.scrollIntoView = seen;   // jsdom 에는 없음
    const pressed = () => [0, 1, 2].map((i) => point(i).querySelector('.mx-name')!.getAttribute('aria-pressed'));
    sized(); await ptr('pointerdown', 2, 0, map().querySelector('[data-pt="1"]')!); await ptr('pointermove', 2.05, 0); await ptr('pointerup', 2.05, 0);   // 4px 흔들림 = 누름
    expect(point(2)).toBeTruthy(); expect($('[data-undo]')).toBeNull();                 // 다시 눌러도 지우지 않음
    expect(pressed()).toEqual(['false', 'true', 'false']); expect(seen.mock.contexts).toContain(point(1));
    const xs = map().querySelectorAll('[data-del]');
    expect(xs).toHaveLength(1); expect(xs[0].getAttribute('data-del')).toBe('1'); expect(xs[0].getAttribute('aria-label')).toBe('2번 지점 지우기');
    await ptr('pointerdown', 2, 0, xs[0]); await ptr('pointerup', 2, 0, xs[0]);
    expect(confirm).not.toHaveBeenCalled();
    expect($('[data-wp="2"]')).toBeNull(); expect(point(1).textContent).toContain('(0.0, 1.0) m'); expect(map().querySelector('[data-del]')).toBeNull();
    expect($('[data-undo]')!.textContent).toBe('지점 2 지움되돌리기');
    await click(btn('되돌리기', $('[data-undo]')!));
    expect(point(1).textContent).toContain('(2.0, 0.0) m'); expect(point(2)).toBeTruthy(); expect($('[data-undo]')).toBeNull();
    // 끌기는 지우지 않고 옮김
    sized(); await ptr('pointerdown', 2, 0, map().querySelector('[data-pt="1"]')!); await ptr('pointermove', 2.5, 0); await ptr('pointerup', 2.5, 0);
    expect(point(1).textContent).toContain('(2.5, 0.0) m'); expect($('[data-undo]')).toBeNull();
    // 단계 창 «지우기»도 되돌리기, 그 뒤 다른 편집을 하면 되돌리기는 사라진다(나중 편집을 덮지 않게)
    await click(aria('1번 지점 지우기'));
    expect($('[data-undo]')!.textContent).toContain('지점 1 지움');
    await tap(-0.5, -1);
    expect($('[data-undo]')).toBeNull();
    expect([0, 1, 2].map((i) => point(i).textContent)).toEqual([expect.stringContaining('(2.5, 0.0) m'), expect.stringContaining('(0.0, 1.0) m'), expect.stringContaining('(-0.5, -1.0) m')]);
    delete (Element.prototype as Partial<Element>).scrollIntoView;
  });
  it('터치: 지점 한 손가락 누름 = 고르기만, X 한 손가락 누름 = 지움, 지점 위에서 시작한 두 손가락 집기는 지우지 않음', async () => {
    seed(); serve(KIM);
    await open();
    await click(btn('+ 이 지도에 새 시나리오'));
    await tap(1, 1); await tap(2, 0);
    sized();
    const touch = async (type: string, x: number, y: number, id: number, on: Element = map()) => {
      act(() => {
        const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: (x + 1) * 80, clientY: (2 - y) * 80, button: 0 });
        Object.defineProperties(e, { pointerId: { value: id }, pointerType: { value: 'touch' } }); on.dispatchEvent(e);
      });
      await flush();
    };
    const pt = () => map().querySelector('[data-pt="1"]')!;
    await touch('pointerdown', 2, 0, 1, pt()); await touch('pointerdown', 3, 0, 2);
    await touch('pointermove', 1.5, 0, 1); await touch('pointerup', 1.5, 0, 1); await touch('pointerup', 3, 0, 2);
    expect(point(1).textContent).toContain('(2.0, 0.0) m'); expect($('[data-undo]')).toBeNull();
    await touch('pointerdown', 2, 0, 3, pt()); await touch('pointerup', 2, 0, 3, pt());
    expect(point(1)).toBeTruthy(); expect($('[data-undo]')).toBeNull();
    const x = map().querySelector('[data-del="1"]')!;
    await touch('pointerdown', 2, 0, 4, x); await touch('pointerup', 2, 0, 4, x);
    expect($('[data-wp="1"]')).toBeNull(); expect($('[data-undo]')!.textContent).toContain('지점 2 지움');
  });
  it('끝 지점도 X 로 지움 — 누름은 고르기만(끝나면 «지정 지점으로 이동»은 그대로, 다시 찍어야 저장) + 되돌리기', async () => {
    seed(); serve(KIM);
    await open();
    await click(btn('+ 이 지도에 새 시나리오'));
    await tap(1, 1);
    await setVal(field('끝나면'), 'GO_TO');
    await tap(-0.5, -1);
    expect(map().querySelector('[data-pt="T"]')).toBeTruthy();
    await tap(-0.5, -1, map().querySelector('[data-pt="T"]')!);
    expect(map().querySelector('[data-pt="T"]')).toBeTruthy();
    const x = map().querySelector('[data-del="T"]')!;
    expect(x.getAttribute('aria-label')).toBe('끝 지점 지우기');
    await tap(-0.5, -1, x);
    expect(map().querySelector('[data-pt="T"]')).toBeNull(); expect(point(0)).toBeTruthy();
    expect(field('끝나면').value).toBe('GO_TO');
    expect($('[data-block]')!.textContent).toBe('끝나고 갈 지점을 지도에서 찍으세요.');
    await click(btn('되돌리기', $('[data-undo]')!));
    expect(map().querySelector('[data-pt="T"]')).toBeTruthy();
  });
  it('단계 창: 지도 오른쪽에서 ▸ 로 접고 ◂ 로 펼친다(접으면 단계 목록 숨김), 다른 시나리오를 열어도 고른 그대로', async () => {
    seed(); serve(KIM);
    await open();
    await click(row('s1'));
    const pane = card('단계 창'), fold = () => $<HTMLButtonElement>('.mx-fold')!;
    expect(pane.tagName).toBe('ASIDE');
    expect(map().compareDocumentPosition(pane) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(fold().getAttribute('aria-expanded')).toBe('true'); expect(fold().getAttribute('aria-label')).toBe('단계 2 창 접기');
    expect(point(1)).toBeTruthy();
    await click(fold());
    expect(fold().getAttribute('aria-expanded')).toBe('false'); expect(fold().textContent).toBe('◂ 단계 2 · 1층 순찰 · 1층');   // 접혀도 무엇을 보는지 — 이름·층 한 줄(SCENARIO-TAB-PICKER)
    expect(point(0).closest('[hidden]')).toBeTruthy(); expect(card('단계 창').hasAttribute('data-fold')).toBe(true);   // 접기 = 숨김(unmount 아님, #235 B2)
    await click($('nav a[href="#/fleet"]')); await click($('nav a[href="#/map"]'));   // 다른 탭에 갔다 와도(같은 시나리오가 다시 열림) 접은 그대로
    expect(fold().getAttribute('aria-expanded')).toBe('false');
    await click(fold());
    expect(fold().getAttribute('aria-expanded')).toBe('true');
  });
});

describe('저장 응답 끊김(불확실)', () => {
  const cut = (real: () => Reply) => { real(); throw new TypeError('끊김'); };
  it('POST 가 서버에선 됐는데 응답이 끊김 → 내 새 항목·같은 내용이 정확히 하나면 성공(다시 보내지 않음)', async () => {
    seed(); serve(KIM, { over: { 'POST /missions': [cut] } });
    await open(); await kind('임무');
    await click(btn('새 임무'));
    await setVal(name(), '끊김 임무'); await click(btn('＋ 대기'));
    await click(saveBtn());
    expect(writes()).toEqual(['POST /missions']);
    expect(text()).toContain('저장된 것을 확인했습니다.');
    expect(db.missions.filter((r) => r.head.name === '끊김 임무')).toHaveLength(1);
  });
  it('아무것도 안 생겼으면 확정하지 않고 초안 유지(입력 잠김) — «다시 저장»은 확인창에서 고른 뒤에만 보낸다', async () => {
    seed(); serve(KIM, { over: { 'POST /missions': [() => { throw new TypeError('끊김'); }] } });
    await open(); await kind('임무');
    await click(btn('새 임무'));
    await setVal(name(), '두 번째'); await click(btn('＋ 대기'));
    await click(saveBtn());
    expect(text()).toContain('저장이 아직 확인되지 않았습니다.');
    expect(name().value).toBe('두 번째'); expect(name().closest('fieldset')!.disabled).toBe(true);
    await click(btn('저장 확인'));
    expect(text()).toContain('저장이 아직 확인되지 않았습니다.'); expect(writes()).toEqual(['POST /missions']);
    await click(btn('다시 저장'));
    expect(writes()).toEqual(['POST /missions']);
    expect(card('다시 저장 확인').textContent).toContain('같은 임무가 두 번 생길 수 있어요');
    await stopSends();                                               // 확인창이 떠 있어도 STOP
    await click(btn('그래도 다시 저장'));
    expect(writes()).toEqual(['POST /missions', 'POST /missions']);
    expect(text()).toContain('저장했습니다.');
  });
  it('POST 전에 목록(대조 기준)을 못 받으면 보내지 않는다 — 나중에 대조할 수 없는 저장은 하지 않음', async () => {
    seed();
    const over: Record<string, (() => Reply)[]> = { 'GET /missions': [] };
    serve(KIM, { over });
    await open(); await kind('임무');
    await click(btn('새 임무'));
    await setVal(name(), '기준 없음'); await click(btn('＋ 대기'));
    over['GET /missions'].push(() => { throw new TypeError('끊김'); });
    await click(saveBtn());
    expect(writes()).toEqual([]);
    expect(text()).toContain('저장 전에 목록을 확인하지 못해 보내지 않았습니다.');
    expect(btn('저장 확인')).toBeUndefined(); expect(name().value).toBe('기준 없음');
    await click(saveBtn());
    expect(writes()).toEqual(['POST /missions']);
  });
  it('같은 내용 내 새 항목이 둘이면 정하지 않는다', async () => {
    seed(); serve(KIM, { over: { 'POST /missions': [(real) => { real(); real(); throw new TypeError('끊김'); }] } });
    await open(); await kind('임무');
    await click(btn('새 임무'));
    await setVal(name(), '쌍둥이'); await click(btn('＋ 대기'));
    await click(saveBtn());
    expect(text()).toContain('같은 내용의 새 항목이 여러 개 보여 이번 저장을 정할 수 없습니다.');
    expect(btn('저장 확인')).toBeTruthy();
  });
  it('PUT 끊김: 내가 만든 다음 판(판 2)이 같은 내용이면 성공, 남이 만든 판이면 확정하지 않음', async () => {
    seed(); serve(KIM, { over: { 'PUT /missions/m1': [cut, () => { bump('missions', 'm1', { ...M1, name: '남의 판' }, PARK); throw new TypeError('끊김'); }] } });
    await open(); await kind('임무');
    await click(row('m1'));
    await setVal(name(), '내 판');
    await click(saveBtn());
    expect(sent('GET', '/missions/m1').some((c) => c.q.get('version') === '2')).toBe(true);
    expect(text()).toContain('저장된 것을 확인했습니다.');
    await setVal(name(), '내 판 다시');
    await click(saveBtn());
    expect(text()).toContain('저장이 아직 확인되지 않았습니다.');
    expect(name().value).toBe('내 판 다시');
  });
});

describe('검토 반영(PR #38 B1~B6)', () => {
  it('B1 저장 응답을 기다리는 중 탭을 오가도 다시 열면 잠김 — 결과 대조·명시 재전송 전에는 다시 보내지 않는다', async () => {
    seed();
    let release = () => {};
    serve(KIM, { over: { 'POST /missions': [(real) => new Promise<Reply>((r) => { release = () => r(real()); })] } });
    await open(); await kind('임무');
    await click(btn('새 임무'));
    await setVal(name(), '느린 새 임무'); await click(btn('＋ 대기'));
    await click(saveBtn());
    expect(writes()).toEqual(['POST /missions']);
    await click($('nav a[href="#/fleet"]'));
    await click($('nav a[href="#/map"]'));
    expect(name().value).toBe('느린 새 임무');
    expect(saveBtn().disabled).toBe(true); expect(name().closest('fieldset')!.disabled).toBe(true);
    await click(saveBtn());
    expect(writes()).toEqual(['POST /missions']);
    expect(text()).toContain('저장이 아직 확인되지 않았습니다.');
    await act(async () => { release(); }); await flush();
    await click(btn('저장 확인'));
    expect(text()).toContain('저장된 것을 확인했습니다.');
    expect(writes()).toEqual(['POST /missions']);
    expect(db.missions.filter((r) => r.head.name === '느린 새 임무')).toHaveLength(1);
  });
  it('B2 409 뒤 «최신 판 받기»가 실패해도 «다시 받기»는 기준 판만 갱신 — 내 입력을 덮지 않는다', async () => {
    seed();
    const over: Record<string, Reply[]> = { 'GET /missions/m1': [] };
    serve(KIM, { over });
    await open(); await kind('임무');
    await click(row('m1'));
    await setVal(name(), '내 입력');
    bump('missions', 'm1', { ...M1, name: '남이 고친 이름' }, PARK);
    await click(saveBtn());
    expect(text()).toContain('다른 사람이 먼저 저장했습니다.');
    over['GET /missions/m1'].push(err(503, 'UNAVAILABLE', '잠시 뒤 다시 시도하세요.'));
    await click(btn('최신 내용 받기'));
    expect(alertText()).toContain('임무를 받지 못했습니다.');
    expect(name().value).toBe('내 입력');
    await click(btn('다시 받기'));
    expect(name().value).toBe('내 입력');
    expect(text()).toContain('최신 내용을 받았습니다.');
    await click(saveBtn());
    expect(last(sent('PUT', '/missions/m1'))!.match).toBe('"2"');
    expect(rec('missions', 'm1')!.head.name).toBe('내 입력');
  });
  it('B3 로봇을 바꾼 뒤 카탈로그를 못 받거나 기다리는 동안 추가·선택지 잠금 — 앞 카탈로그로 못 하는 작업을 고르지 않음', async () => {
    seed();
    let release = () => {};
    serve(KIM, { over: { 'GET /actions': [(real) => real(), err(503, 'UNAVAILABLE', '잠시 뒤 다시 시도하세요.'), (real) => new Promise<Reply>((r) => { release = () => r(real()); })] } });
    await open(); await kind('임무');
    await click(btn('새 임무'));
    await click(btn('＋ 사진 찍기'));                                  // 로봇을 고르지 않은 카탈로그
    await setVal(field('장치 확인할 로봇'), 'r-a');
    expect(alertText()).toContain('작업 목록을 받지 못했습니다.');
    expect(btn('＋ 사진 찍기')).toBeUndefined(); expect(btn('＋ 대기')).toBeUndefined();
    expect((field('카메라', step(0)) as unknown as HTMLSelectElement).disabled).toBe(true);
    await click(btn('다시 받기'));                                       // 이번 답은 늦게 온다
    expect(btn('＋ 사진 찍기')).toBeUndefined(); expect(text()).toContain('작업 목록을 불러오는 중…');
    expect((field('카메라', step(0)) as unknown as HTMLSelectElement).disabled).toBe(true);
    await act(async () => { release(); }); await flush();
    expect(last(sent('GET', '/actions'))!.q.get('robot_id')).toBe('r-a');
    expect(btn('＋ 사진 찍기')!.disabled).toBe(true);
    expect(step(0).textContent).toContain('고른 카메라는 이 로봇으로 할 수 없습니다.');
  });
  it('계약에 없는 작업 key 는 추가 단추 없이 «지원 전 작업» 안내', async () => {
    seed();
    const dance = { key: 'DANCE', label: '춤추기', params: {}, requires: [], available: true, why_unavailable: null, options: [] } as unknown as Action;
    serve(KIM, { over: { 'GET /actions': [(real) => { const r = real(); return { ...r, body: [...(r.body as Action[]), dance] }; }] } });
    await open(); await kind('임무');
    await click(btn('새 임무'));
    expect(btn('＋ 춤추기')).toBeUndefined();
    expect(card('작업 추가').textContent).toContain('춤추기: 지원 전 작업입니다.');
    expect(btn('＋ 대기')).toBeTruthy();
  });
  it('B4 저장 422 에 실린 서버 미리보기(갈 수 없음)가 앞의 «모두 갈 수 있음»을 대신 — 저장 막힘', async () => {
    seed();
    const no = { reachable: false, points: [{ element: 'waypoints.0', reachable: true, reasons: [] }, { element: 'waypoints.1', reachable: false, reasons: ['층 연결점이 꺼졌습니다.'] }],
      segments: [], floor_ids: ['f1'], map_version_ids: ['v1'], required_devices: [], est_distance_m: 5, distance_note: '' };
    serve(KIM, { over: { 'PUT /scenarios/s1': [err(422, 'PRECHECK_FAILED', '갈 수 없는 지점이 있습니다.', { elements: ['waypoints.1'], preview: no })] } });
    await open();
    await click(row('s1'));
    await setVal(name(), '고침');
    await settle();
    expect(card('경로 확인').textContent).toContain('모든 지점에 갈 수 있습니다.');
    await click(saveBtn());
    expect(card('경로 확인').textContent).not.toContain('모든 지점에 갈 수 있습니다.');
    expect(card('경로 확인').textContent).toContain('갈 수 없는 지점이 있습니다.');
    expect(point(1).textContent).toContain('갈 수 없음: 층 연결점이 꺼졌습니다.');
    expect(saveBtn().disabled).toBe(true);
    await settle();
    expect(saveBtn().disabled).toBe(true); expect(sent('PUT', '/scenarios/s1')).toHaveLength(1);
  });
  it('B5 옛 판은 그 판 지점이 가리키는 지도 판으로 그린다 — 지금 승인 지도 위에 그리지 않음', async () => {
    seed(); approved.f1 = 'v3';
    bump('scenarios', 's1', { name: '1층 순찰', waypoints: [wp('f1', 1, 1)], finish: { mode: 'STAY', target: null }, notes: '' }, KIM);   // 판 2 = v3 위
    serve(KIM);
    await open();
    await click(row('s1'));
    expect(map().querySelector('image')!.getAttribute('href')).toContain('/map-versions/v3/image');
    await setVal($<HTMLSelectElement>('select[aria-label="저장 기록"]')!, '1');
    expect($('[data-old]')).toBeTruthy();
    expect(sent('GET', '/map-versions/v1')).toHaveLength(1);
    expect(map().querySelector('image')!.getAttribute('href')).toContain('/map-versions/v1/image');
    expect(point(1).textContent).toContain('«입구»');
  });
  it('B6 지도를 못 받았을 때 «다시 받기»는 실제로 다시 요청한다', async () => {
    seed(); serve(KIM);
    await open();
    serve(KIM, { over: { 'GET /map-versions/v1': [err(503, 'UNAVAILABLE', '잠시 뒤 다시 시도하세요.')] } });   // 지도 탭이 먼저 받은 판 다음 — 시나리오 지도부터 실패
    await click(btn('+ 이 지도에 새 시나리오'));
    expect(alertText()).toContain('지도를 받지 못했습니다.');
    expect($('svg[data-scenario-map]')).toBeNull();
    await click(btn('다시 받기'));
    expect(sent('GET', '/map-versions/v1')).toHaveLength(2);
    expect(map()).toBeTruthy(); expect(alertText()).not.toContain('지도를 받지 못했습니다.');
    await stopSends();
  });
});

describe('STOP·Space', () => {
  it('이름·확인 문구 칸에서 Space 는 띄어쓰기(정지 안 보냄), 편집 중에도 STOP 단추는 보이고 정지가 나간다', async () => {
    seed(); serve(KIM);
    await open(); await kind('임무');
    await click(btn('새 임무')); await click(btn('＋ 운영자 확인'));
    act(() => FakeWS.last.open());
    for (const el of [name(), field('확인 문구', step(0))]) {
      const d = new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, cancelable: true });
      act(() => { el.focus(); el.dispatchEvent(d); });
      expect(d.defaultPrevented).toBe(false);
    }
    expect(FakeWS.last.of('stop')).toEqual([]);
    await stopSends();
  });
  it('저장 중(응답 대기)에도 STOP', async () => {
    seed();
    let release = () => {};
    serve(KIM, { over: { 'PUT /missions/m1': [(real) => new Promise<Reply>((r) => { release = () => r(real()); })] } });
    await open(); await kind('임무');
    await click(row('m1'));
    await setVal(name(), '느린 저장');
    await click(saveBtn());
    expect(text()).toContain('저장하는 중…');
    await stopSends();
    await act(async () => { release(); }); await flush();
    expect(text()).toContain('저장했습니다.');
  });
});

describe('저장 안 한 편집', () => {
  it('다른 탭에 갔다 와도 이어 쓰고, 목록에 «저장 안 한 편집»', async () => {
    seed(); serve(KIM);
    await open(); await kind('임무');
    await click(row('m1'));
    await setVal(name(), '쓰던 이름');
    await click($('nav a[href="#/fleet"]'));
    await click($('nav a[href="#/map"]'));
    expect(row('m1').textContent).toContain('저장 안 한 편집');
    expect(name().value).toBe('쓰던 이름');
    expect(text()).toContain('저장하지 않은 편집을 이어서 씁니다.');
  });
});

describe('지점에서 사진·대기 바로 고르기(VQ-F1)', () => {
  const pick = (i: number) => $<HTMLSelectElement>(`select[aria-label="${i}번 지점 할 일"]`)!;
  const missionPosts = () => sent('POST', '/missions').map((c) => c.body);
  /** 기본 이동 임무가 이미 있는 서버(id m4) — POST /missions 를 사진·대기 시험만 세게 */
  const seedMove = () => { seed(); make('missions', { name: '이동', steps: [] }, KIM); };
  it('할 일은 이동·사진 찍기·대기 셋, 기본 이동 — 고르면 한 단계 임무를 만들어 잇고, 다른 지점에서 다시 고르면 같은 임무를 다시 쓴다 · 대기 30초 → 초 바꾸기(적용) · 저장 본문', async () => {
    seed(); serve(KIM);
    await open();
    await click(btn('+ 이 지도에 새 시나리오'));
    await setVal(name(), '사진 순회');
    await tap(1, 1); await tap(1, 0); await tap(0, 1);
    expect([...pick(1).options].map((o) => o.value)).toEqual(['MOVE', 'PHOTO', 'WAIT']);
    expect([...pick(1).options].map((o) => o.textContent)).toEqual(['이동', '사진 찍기', '대기']);
    expect([pick(1).value, pick(2).value, pick(3).value]).toEqual(['MOVE', 'MOVE', 'MOVE']);
    expect(missionPosts()).toEqual([{ name: '이동', steps: [] }]);     // 세 지점에 이동 임무 하나
    await setVal(pick(1), 'PHOTO');
    expect(last(missionPosts())).toEqual({ name: '사진 찍기(RGB)', steps: [{ action: 'PHOTO', params: { camera: 'rgb' } }] });
    expect(pick(1).value).toBe('PHOTO');
    expect(point(0).querySelector('[data-do]')!.textContent).toBe('할 일: 사진');
    await setVal(pick(2), 'PHOTO');                                    // 같은 내용 = 다시 쓰기(새로 만들지 않음)
    expect(missionPosts()).toHaveLength(2);
    expect(pick(2).value).toBe('PHOTO');
    await setVal(pick(3), 'WAIT');
    expect(last(missionPosts())).toEqual({ name: '대기 30초', steps: [{ action: 'WAIT', params: { seconds: 30 } }] });
    expect(pick(3).value).toBe('WAIT');
    expect(point(2).querySelector('[data-do]')!.textContent).toBe('할 일: 대기 30초');
    const secs = $<HTMLInputElement>('input[aria-label="3번 지점 대기 초"]')!;
    await setVal(secs, '0');
    expect(btn('적용', point(2))!.disabled).toBe(true);                // 1~3600 밖은 적용 안 됨
    await setVal(secs, '60');
    expect(missionPosts()).toHaveLength(3);                             // 글자마다 만들지 않음
    await click(btn('적용', point(2)));
    expect(last(missionPosts())).toEqual({ name: '대기 60초', steps: [{ action: 'WAIT', params: { seconds: 60 } }] });
    expect(point(2).querySelector('[data-do]')!.textContent).toBe('할 일: 대기 60초');
    await setVal($<HTMLInputElement>('input[aria-label="3번 지점 대기 초"]')!, '30');
    await click(btn('적용', point(2)));
    expect(missionPosts()).toHaveLength(4);                             // 30초는 이미 있음 → 다시 씀
    expect(pick(3).value).toBe('WAIT');
    expect(point(2).querySelector('[data-do]')!.textContent).toBe('할 일: 대기 30초');
    await settle();
    expect(saveBtn().disabled).toBe(false);
    await click(saveBtn());
    expect(last(sent('POST', '/scenarios'))!.body).toMatchObject({ waypoints: [{ mission_id: 'm5', mission_version: 1 }, { mission_id: 'm5', mission_version: 1 }, { mission_id: 'm6', mission_version: 1 }] });
    expect(text()).toContain('저장했습니다.');
    await stopSends();
  });
  it('이동 임무가 이미 있으면 새로 만들지 않고 그것을 쓴다(보관된 이동 임무는 쓰지 않음)', async () => {
    seedMove(); serve(KIM);
    await open();
    await click(btn('+ 이 지도에 새 시나리오'));
    await tap(1, 1);
    expect(missionPosts()).toEqual([]);
    expect(pick(1).value).toBe('MOVE');
    act(() => root?.unmount()); root = null; box.remove(); clearPlans();
    seed(); make('missions', { name: '이동', steps: [] }, KIM, true); serve(KIM);
    await open();
    await click(btn('+ 이 지도에 새 시나리오'));
    await tap(1, 1);
    expect(missionPosts()).toEqual([{ name: '이동', steps: [] }]);
  });
  it('서버가 이동 임무를 거절(422) = «이동 임무를 만들지 못했습니다» 한 줄, 또 보내지 않음 · «다시 시도»로 다시 만들어 잇는다', async () => {
    seed(); serve(KIM, { over: { 'POST /missions': [err(422, 'VALIDATION_ERROR', 'steps 는 한 개 이상')] } });
    await open();
    await click(btn('+ 이 지도에 새 시나리오'));
    await setVal(name(), '거절');
    await tap(1, 1);
    expect(alertText()).toContain('이동 임무를 만들지 못했습니다');
    expect(alertText()).not.toContain('steps');
    expect(missionPosts()).toHaveLength(1);
    await tap(1, 0);
    expect(missionPosts()).toHaveLength(1);                             // 실패 뒤 저절로 다시 보내지 않음
    await settle();
    expect(saveBtn().disabled).toBe(true);                              // 할 일이 빈 지점이 있으면 저장 막힘
    expect($('[data-block]')!.textContent).toBe('모든 지점에 할 일을 고르세요.');
    await click(btn('다시 시도'));
    expect(missionPosts()).toHaveLength(2);
    expect([pick(1).value, pick(2).value]).toEqual(['MOVE', 'MOVE']);
    expect(alertText()).not.toContain('이동 임무를 만들지 못했습니다');
    await settle();
    expect(saveBtn().disabled).toBe(false);
  });
  it('다른 임무가 묶인 옛 지점 = 지우지 않고 이름을 읽기 전용 한 줄로, 그대로 저장하면 그 임무 유지 · 셋 중 하나로 바꿀 수 있다', async () => {
    seedMove(); serve(KIM);
    await open();
    await click(row('s1'));
    await click(point(0).querySelector('.mx-name'));
    expect(pick(1).value).toBe('');
    expect(pick(1).selectedOptions[0].textContent).toBe('다른 임무');
    expect(pick(1).selectedOptions[0].hidden).toBe(true);               // 목록엔 셋만 보인다
    expect($('[data-other]', point(0))!.textContent).toBe('지금 임무: 사진 순찰');
    expect(missionPosts()).toEqual([]);                                 // 열기만 해서는 안 바뀐다
    await setVal(name(), '이름만 고침');
    await settle();
    await click(saveBtn());
    expect((last(sent('PUT', '/scenarios/s1'))!.body as ScenarioWrite).waypoints[0].mission_id).toBe('m1');
    await setVal(pick(1), 'MOVE');
    expect(pick(1).value).toBe('MOVE');
    expect($('[data-other]', point(0))).toBeNull();
    expect(missionPosts()).toEqual([]);                                 // 이미 있는 이동 임무를 잇는다
  });
  it('실행 불가 정직 표시: 로봇을 고르지 않으면 표시 없음(MAPSCEN-UI), 고른 로봇이 장치 없음(카탈로그 why_unavailable) = 그 단계 줄 ⚠ + «저장은 되지만 지금은 실행 불가 — 이유», 할 수 있는 대기는 문구 없음, 저장은 막지 않음', async () => {
    seed(); serve(KIM);
    await open();
    await click(btn('+ 이 지도에 새 시나리오'));
    await setVal(name(), '정직');
    await tap(1, 1); await tap(1, 0);
    await setVal(pick(1), 'PHOTO'); await setVal(pick(2), 'WAIT');
    expect(point(0).querySelector('[data-cannot]')).toBeNull(); expect(point(1).querySelector('[data-cannot]')).toBeNull();   // 로봇을 안 고르면 «실행 불가» 문구·⚠ 없음
    expect(point(0).querySelector('.mx-warn')).toBeNull();
    await setVal(field('실행 확인할 로봇'), 'r-a');                     // r-a = 카메라 없음
    expect(last(sent('GET', '/actions'))!.q.get('robot_id')).toBe('r-a');
    expect(point(0).querySelector('[data-cannot]')!.textContent).toBe('저장은 되지만 지금은 실행 불가 — 필요한 장치가 없거나 정상 상태가 아닙니다: 카메라');
    expect(point(1).querySelector('[data-cannot]')).toBeNull();
    expect(point(0).querySelector('.mx-warn')!.getAttribute('title')).toBe('실행 불가 — 필요한 장치가 없거나 정상 상태가 아닙니다: 카메라'); expect(point(1).querySelector('.mx-warn')).toBeNull();   // 목록 줄에서도 보이게
    await settle();
    expect(saveBtn().disabled).toBe(false);
  });
  it('실행기 미광고(서버 이유)도 그대로, 카탈로그를 못 받으면 «확인하지 못했습니다» + 다시 받기', async () => {
    seed();
    serve(KIM, { over: { 'GET /actions': [{ status: 200, body: acts('r-a').map((a) => a.key === 'WAIT' ? { ...a, available: false, why_unavailable: '실행기가 해당 기능을 아직 광고하지 않았습니다' } : a) }, err(503, 'UNAVAILABLE', '잠시 뒤 다시 시도하세요.')] } });
    await open();
    await click(btn('+ 이 지도에 새 시나리오'));
    await tap(1, 1);
    await setVal(pick(1), 'WAIT');
    await setVal(field('실행 확인할 로봇'), 'r-a');
    expect(point(0).querySelector('[data-cannot]')!.textContent).toBe('저장은 되지만 지금은 실행 불가 — 실행기가 해당 기능을 아직 광고하지 않았습니다');
    await setVal(field('실행 확인할 로봇'), '');
    await setVal(field('실행 확인할 로봇'), 'r-a');
    expect(alertText()).toContain('실행할 수 있는지 확인하지 못했습니다. 잠시 뒤 다시 시도하세요.');
    await click(btn('다시 받기', card('단계 창')));
    expect(alertText()).not.toContain('실행할 수 있는지 확인하지 못했습니다');
  });
  it('임무 만들기 응답이 끊기면 목록을 다시 받고, 다시 고르면 만들어진 같은 임무를 쓴다(두 번 만들지 않음) · 만드는 중엔 저장 막힘', async () => {
    seedMove();
    let hold: (() => void) | null = null;
    serve(KIM, { over: { 'POST /missions': [(real) => new Promise((ok) => { hold = () => { real(); ok({ status: 0 } as Reply); }; })] } });
    vi.stubGlobal('fetch', ((f: typeof fetch) => async (u: string, i?: RequestInit) => { const r = await f(u, i); if (r.status === 0) throw new TypeError('끊김'); return r; })(fetch));
    await open();
    await click(btn('+ 이 지도에 새 시나리오'));
    await setVal(name(), '끊김');
    await tap(1, 1);
    await setVal(pick(1), 'PHOTO');
    expect(text()).toContain('임무를 만드는 중…');
    expect(pick(1).matches(':disabled')).toBe(true);                   // 단계 창 전체가 잠김(지점 번호가 바뀌지 않게)
    expect($('[data-block]')!.textContent).toBe('지점 임무를 만드는 중입니다.');
    await act(async () => { hold!(); }); await flush();
    expect(alertText()).toContain('임무를 만들었는지 확인하지 못했습니다.');
    expect(pick(1).value).toBe('MOVE');                                  // 확정 전엔 잇지 않음
    await setVal(pick(1), 'PHOTO');
    expect(sent('POST', '/missions')).toHaveLength(1);
    expect(pick(1).value).toBe('PHOTO');
  });
  it('생성 응답이 끊긴 뒤 목록 확인이 끝나기 전(실패·재시도 중)엔 다시 골라도 만들지 않고, 확인되면 만들어진 임무를 다시 쓴다(PR #128 검토)', async () => {
    seedMove();
    const over: Record<string, ((real: () => Reply) => Reply | Promise<Reply>)[]> = { 'POST /missions': [(real) => { real(); throw new TypeError('끊김'); }], 'GET /missions': [] };
    serve(KIM, { over });
    await open(); await click(btn('+ 이 지도에 새 시나리오')); await setVal(name(), '불확실'); await tap(1, 1);
    let release: (() => void) | null = null;
    over['GET /missions'].push(() => { throw new TypeError('끊김'); }, (real) => new Promise<Reply>((ok) => { release = () => ok(real()); }));
    await setVal(pick(1), 'PHOTO');                                      // 서버엔 생김 · 응답 끊김 → 다시 받기도 실패
    expect($('[data-unsure]')!.textContent).toContain('아직 확인하지 못했습니다');
    await setVal(pick(1), 'PHOTO');
    expect(sent('POST', '/missions')).toHaveLength(1);                   // 실패해도 잠금 유지
    await click(btn('다시 확인'));                                       // 다시 받는 중(멈춰 둠)
    expect($('[data-unsure]')!.textContent).toContain('확인하는 중…');
    await setVal(pick(1), 'PHOTO');
    expect(sent('POST', '/missions')).toHaveLength(1);
    await act(async () => { release!(); }); await flush();
    expect($('[data-unsure]')).toBeNull();
    await setVal(pick(1), 'PHOTO');
    expect(sent('POST', '/missions')).toHaveLength(1);
    expect(pick(1).value).toBe('PHOTO');
    expect(db.missions.filter((m) => m.head.name === '사진 찍기(RGB)')).toHaveLength(1);
  });
});

describe('시나리오 탭 — 단추 줄·[단계 | 배정] 창(MAPSCEN-UI 11-02)', () => {
  /** jsdom 에는 DataTransfer 가 없어 끌기 사건에 흉내를 붙인다 */
  const drag = (type: string, el: Element) => act(() => {
    const e = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'dataTransfer', { value: { setData() {}, effectAllowed: '', dropEffect: '' } }); el.dispatchEvent(e);
  });
  it('단계 줄 손잡이를 끌어 다른 줄에 놓으면 순서가 바뀐다(키보드는 «더 보기» ↑↓) · 줄 누름 = 그 단계만 보이고 «‹» 로 목록', async () => {
    seed(); serve(KIM);
    await open();
    await click(btn('+ 이 지도에 새 시나리오'));
    await tap(1, 1); await tap(2, 0); await tap(0, 1);
    if (aria('단계 목록으로')) await click(aria('단계 목록으로'));
    expect([0, 1, 2].every((i) => !point(i).hidden)).toBe(true);
    drag('dragstart', point(2).querySelector('.mx-grip')!); drag('dragover', point(0)); drag('drop', point(0)); await flush();
    expect([0, 1, 2].map((i) => point(i).querySelector('.mx-name')!.textContent)).toEqual([expect.stringContaining('(0.0, 1.0) m'), expect.stringContaining('(1.0, 1.0) m'), expect.stringContaining('(2.0, 0.0) m')]);
    expect($('[data-undo]')).toBeNull();                                  // 순서 바꾸기는 지우기가 아님
    await click(point(1).querySelector('.mx-name'));
    expect(point(0).hidden).toBe(true); expect(point(2).hidden).toBe(true); expect(point(1).hidden).toBe(false);
    expect(card('단계 창').textContent).toContain('2번 지점');
    expect(point(1).querySelector('.mx-grip')).toBeNull();                // 고른 단계 보기에선 손잡이 없음(↑↓ 는 «더 보기»)
    await click(aria('2번 지점 아래로'));
    expect(point(2).querySelector('.mx-name')!.textContent).toContain('(1.0, 1.0) m');
    await click(aria('단계 목록으로'));
    expect([0, 1, 2].every((i) => !point(i).hidden)).toBe(true);
  });
  it('[단계 N | 배정 N] 탭: 저장된 시나리오에서 «배정»을 누르면 배정 창, 단계 목록은 숨김 · 경로는 한 줄(✓ 모두 갈 수 있음 · 약 N m) + «경로 더 보기»', async () => {
    seed(); serve(KIM);
    await open();
    await click(row('s1'));
    await click($('[data-look="list"]'));   // SCEN-NODE-PREVIEW: 기본 노드 보기 → 목록
    const tabs = [...card('단계 창').querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs.map((t) => t.textContent)).toEqual(['단계 2', '배정 0']);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    await settle();
    const p = card('경로 확인');
    expect(p.querySelector('[role="status"]')!.textContent).toBe('✓ 모두 갈 수 있음 · 약 12 m ⓘ');
    expect(p.querySelector('details')!.hasAttribute('open')).toBe(false); expect(p.querySelector('summary')!.textContent).toBe('경로 더 보기');
    await click(tabs[1]);
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');
    expect((point(0).closest('.mx-tab') as HTMLElement).hidden).toBe(true);
    expect($('[data-assign]')!.closest('[hidden]')).toBeNull();
    await click(tabs[0]);
    expect((point(0).closest('.mx-tab') as HTMLElement).hidden).toBe(false);
    await stopSends();
  });
  it('#235 B1 임무 만드는 중엔 손잡이 끌기·놓기를 막고, 늦게 온 새 임무는 처음 고른 지점에 잇는다(순번 아닌 그 지점)', async () => {
    seed(); let release!: () => void;
    serve(KIM, { over: { 'POST /missions': [async (real) => { await new Promise<void>((r) => { release = r; }); return real(); }] } });
    await open(); await click(row('s1')); await click(point(0).querySelector('.mx-name'));
    await setVal($<HTMLSelectElement>('select[aria-label="1번 지점 할 일"]')!, 'PHOTO');
    expect(release).toBeTypeOf('function');
    await click(aria('단계 목록으로'));
    const grip = point(1).querySelector<HTMLElement>('.mx-grip')!;
    expect(grip.getAttribute('draggable')).toBe('false'); expect(grip.getAttribute('aria-disabled')).toBe('true');
    drag('dragstart', grip); drag('dragover', point(0)); drag('drop', point(0)); await flush();
    release(); await flush(); await settle();
    await click(saveBtn());
    const w = (last(sent('PUT', '/scenarios/s1'))!.body as ScenarioWrite).waypoints;
    expect(w.map((p) => ({ x: p.x, y: p.y, m: p.mission_id }))).toEqual([{ x: 1, y: 1, m: 'm4' }, { x: 0, y: 0, m: 'm1' }]);
  });
  it('#235 B2 창을 접었다 펴도 배정 창 입력(메모)이 남는다 — 접기는 숨김, 배정 창은 unmount 되지 않음', async () => {
    seed(); serve(KIM);
    await open(); await click(row('s1')); await click($('[data-look="list"]'));   // SCEN-NODE-PREVIEW: 기본 노드 보기 → 목록
    await click(card('단계 창').querySelectorAll<HTMLButtonElement>('[role="tab"]')[1]);
    const sec = $('[data-assign]')!;
    await click(btn('로봇에 배정', sec));
    await setVal(field('메모', sec), '야간 순찰');
    await click($<HTMLButtonElement>('.mx-fold')!);
    expect(sec.isConnected).toBe(true); expect(sec.closest('[hidden]')).toBeTruthy();
    await click($<HTMLButtonElement>('.mx-fold')!);
    expect($('[data-assign]')).toBe(sec); expect(sec.closest('[hidden]')).toBeNull();
    expect(field('메모', sec).value).toBe('야간 순찰');
    await stopSends();
  });
  it('#235 B3 [단계|배정] 탭: ←→·Home·End 로 옮기며 고름(roving tabIndex) · aria-controls ↔ tabpanel aria-labelledby', async () => {
    seed(); serve(KIM);
    await open(); await click(row('s1'));
    const tabs = [...card('단계 창').querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const key = (k: string) => act(() => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); });
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1]);
    for (const t of tabs) { const pnl = document.getElementById(t.getAttribute('aria-controls')!)!;
      expect(pnl.getAttribute('role')).toBe('tabpanel'); expect(pnl.getAttribute('aria-labelledby')).toBe(t.id); }
    tabs[0].focus(); key('ArrowRight');
    expect(document.activeElement).toBe(tabs[1]); expect(tabs[1].getAttribute('aria-selected')).toBe('true'); expect(tabs.map((t) => t.tabIndex)).toEqual([-1, 0]);
    expect(document.getElementById(tabs[1].getAttribute('aria-controls')!)!.hidden).toBe(false);
    key('ArrowRight'); expect(document.activeElement).toBe(tabs[0]); expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    key('End'); expect(document.activeElement).toBe(tabs[1]);
    key('Home'); expect(document.activeElement).toBe(tabs[0]);
    key('ArrowLeft'); expect(document.activeElement).toBe(tabs[1]);
  });
  it('#235 B4 끌기 손잡이는 화면 읽기에 «N번 단계 끌어 옮기기»로 보이고, 키보드 대체는 «더 보기»의 ↑↓', async () => {
    seed(); serve(KIM);
    await open(); await click(row('s1'));
    const grip = point(0).querySelector('.mx-grip')!;
    expect(grip.hasAttribute('aria-hidden')).toBe(false); expect(grip.getAttribute('aria-label')).toBe('1번 단계 끌어 옮기기');
    expect(point(1).querySelector('.mx-grip')!.getAttribute('aria-label')).toBe('2번 단계 끌어 옮기기');
    await click(point(0).querySelector('.mx-name'));
    expect(aria('1번 지점 아래로')).toBeTruthy();
  });
  it('새 시나리오(저장 전)는 배정 탭 없음 · 저장은 단추 줄, 이름은 창 맨 위(사진 ④ — MAP-TAB-MERGE), 삭제는 «···» 안, 위 줄 지도는 잠김', async () => {
    seed(); serve(KIM);
    await open();
    await click(btn('+ 이 지도에 새 시나리오'));
    expect([...card('단계 창').querySelectorAll('[role="tab"]')].map((t) => t.textContent)).toEqual(['단계 0']);
    expect(saveBtn().closest('.mx-bar')).toBeTruthy();
    expect(card('단계 창').querySelector('.mx-pick [aria-label="오른쪽 창"]')).toBeTruthy();                       // 창 맨 위 [지도 요소 | 시나리오] 탭
    expect($('.mx-bar [data-locked]')!.getAttribute('aria-label')).toBe('지도: 본관 › 본동 › 1층 (잠김 — 시나리오를 닫으면 지도를 바꿀 수 있습니다)');
    expect(card('단계 창').contains(name())).toBe(true);
    await click($('[data-back]'));
    await click(row('s1'));
    expect(name().value).toBe('1층 순찰'); expect(card('단계 창').contains(name())).toBe(true);
    expect(btn('삭제')!.closest('details.mx-menu')).toBeTruthy();
    expect(btn('저장')!.closest('.mx-bar')).toBeTruthy();
    await click($('[data-back]'));
    await click(btn('임무 관리…'));                                                                                    // 창이 없는 임무 관리는 메뉴가 위 단추 줄
    expect($('.mx-bar [aria-label="임무 목록"]')).toBeTruthy(); expect($('.mx-pick')).toBeNull();
    await stopSends();
  });
});

// SIM-REAL-SPLIT(11-09): 시뮬 탭 시나리오 = 지도 탭과 같은 편집기, 배정·결재 대신 «시뮬에서 실행»(시나리오 → bt.js 나무 → fh.btMission.<id> → 시뮬 ?bt=<id>)
describe('시뮬 시나리오', () => {
  /** factory-inspection 시뮬 자산과 같은 사진·격자(mapframe SIM_TOP·top.json) — 지도 좌표 = 시뮬 좌표 */
  const SIMV = { provenance: 'SIMULATION' as const, image_sha256: '8669ef9e9300c7a6372d02b230aaee98f984337bac9cebe5b1316be1e7d61721', origin: [-0.05, -0.05, 0] as [number, number, number], resolution: 0.05, width: 1002, height: 1002 };
  const scen = async () => { const b = $('[data-side="scen"]'); if (b) await click(b); };
  const assigned = () => { assigns = [{ id: 'a1', scenario_id: 's1', scenario_version: 1, robot_id: 'r-a', memo: '', scenario_name: '1층 순찰', scenario_name_snapshot: null,
    robot_name: 'Go2-A', status: 'ACTIVE', approval_id: null, created_by: KIM.id, created_at: '2026-10-20T00:00:00Z', removed_at: null } as Assignment]; };
  it('시뮬 탭: 로봇·배정 칸 없음, «시뮬에서 실행» = validateTree 통과 나무를 저장하고 시뮬 ?bt= 주소로', async () => {
    seed(); sitePurpose = 'SIM'; MAPS.v1 = { ...MAPS.v1, ...SIMV }; assigned();
    serve(KIM);
    const go = vi.spyOn(simNav, 'go').mockImplementation(() => {});
    await open('#/sim'); await scen();
    expect(rows()).toEqual(['s1']);
    expect(card('시나리오 목록 창').textContent).not.toContain('Go2-A');   // 배정된 로봇 칸 없음
    expect(sent('GET', '/assignments')).toHaveLength(0);
    await click(row('s1')); await settle();
    expect(btns().some((b) => b.textContent!.startsWith('배정'))).toBe(false);   // [단계 | 배정] 의 배정 탭 없음
    expect($('[data-sim-run-why]')).toBeNull();
    await click(btn('시뮬에서 실행'));
    expect(go).toHaveBeenCalledWith('/sim/index.html?from=web&map=factory-inspection&bt=ss1');
    const m = JSON.parse(localStorage.getItem('fh.btMission.ss1')!);
    expect(m).toMatchObject({ id: 'ss1', name: '1층 순찰', map: 'factory-inspection', floor: '', scenario_id: 's1' });
    expect(check(m.tree)).toBe('');
    expect(m.tree.root.children.map((n: BtNode) => n.type)).toEqual(['goto', 'photo', 'wait', 'goto', 'photo', 'wait']);   // m1 = 사진 → 대기 5초
    expect(writes()).toEqual([]);   // 서버에는 아무것도 안 보냄(배정 없음)
  });
  it('SCEN-LIFECYCLE-EDITOR: 시뮬 탭 노드 보기 = 운영 흐름(websim 판정), 시뮬이 못 하는 지점(센서 기록)은 «시뮬에서 실행 못 함», «목록에서 이 지점 편집» = 목록·그 지점', async () => {
    seed(); sitePurpose = 'SIM'; MAPS.v1 = { ...MAPS.v1, ...SIMV };
    make('scenarios', { name: '센서 순찰', waypoints: [wp('f1', 1, 1), wp('f1', 0, 0, 'm2')], finish: { mode: 'STAY', target: null }, notes: '' }, KIM);
    serve(KIM);
    await open('#/sim'); await scen(); await click(row('s3')); await settle();
    expect($('[data-look="node"]')!.getAttribute('aria-pressed')).toBe('true');
    expect($('button[data-stage="임무"]')!.getAttribute('aria-pressed')).toBe('true');   // 기본 = 임무 단계
    expect($('button[data-stage="연결"]')!.textContent).toContain('됨 0 · 일부 0 · 아직 없음 8');   // websim
    expect(box.querySelectorAll('.react-flow__node .sn-num')).toHaveLength(2);             // 임무 노드 = 지점 수
    const nd = (id: string) => $(`.react-flow__node[data-id="${id}"]`)!;
    expect(nd('w0').querySelector('[data-st="no"]')).toBeNull();
    expect(nd('w1').querySelector('[data-st="no"]')!.textContent).toBe('시뮬에서 실행 못 함');
    await click(nd('w1'));
    expect($('[data-miss]')!.textContent).toContain('«센서 값 기록»은 시뮬에서 실행할 수 없습니다.');
    await click($('[data-edit-point="1"]'));
    expect($('[data-look="list"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(text()).toContain('2번 지점');
    expect(writes()).toEqual([]);
  });
  it('시뮬과 좌표가 같다고 확인되지 않는 층(사람이 올린 지도) = «시뮬에서 실행» 회색 + 이유', async () => {
    seed(); sitePurpose = 'SIM';
    serve(KIM);
    const go = vi.spyOn(simNav, 'go').mockImplementation(() => {});
    await open('#/sim'); await scen();
    await click(row('s1')); await settle();
    expect(btn('시뮬에서 실행')!.disabled).toBe(true);
    expect($('[data-sim-run-why]')!.textContent).toContain('시뮬 세계·지형과 이어져 있지 않아');
    expect(go).not.toHaveBeenCalled();
  });
  it('지형 층: 서버 지형을 받아 격자가 맞으면 이 브라우저에 지형을 두고 map=custom&terrain= 로, 다른 편집본이 있으면 덮지 않고 회색', async () => {
    const spec = { schema: 'fh_custom_terrain/1', id: 'hill', name: '언덕', size: [5, 4], spawn: [0, 0, 0], items: [] };
    const T = { status: 200, body: { spec, version: 3, floor_id: 'f1', map_version_id: 'v1', archived_at: null, updated_at: '2026-11-09T00:00:00Z' } };
    seed(); sitePurpose = 'SIM'; f1Extra = { terrain_id: 'hill' }; MAPS.v1 = { ...MAPS.v1, ...TERRAIN_V };   // 5×4 m 지형 = 100×80 칸, 원점 (-2.5, -2)
    serve(KIM, { over: { 'GET /terrains/hill': [T, T, T, T] } });   // 층 위 «시뮬 열기» + «시뮬에서 실행» 이 한 번씩 받는다 × 두 번 열기
    const go = vi.spyOn(simNav, 'go').mockImplementation(() => {});
    localStorage.setItem('fh.customTerrain.hill', JSON.stringify({ ...spec, name: '고치던 언덕' }));
    await open('#/sim'); await scen();
    await click(row('s1')); await settle();
    expect(btn('시뮬에서 실행')!.disabled).toBe(true);
    expect($('[data-sim-run-why]')!.textContent).toContain('다른 편집본이 있어 덮지 않습니다');
    expect(JSON.parse(localStorage.getItem('fh.customTerrain.hill')!).name).toBe('고치던 언덕');
    act(() => root?.unmount()); root = null; localStorage.clear(); clearPlans();
    await open('#/sim'); await scen();
    await click(row('s1')); await settle();
    await click(btn('시뮬에서 실행'));
    expect(go).toHaveBeenCalledWith('/sim/index.html?from=web&map=custom&terrain=hill&bt=ss1');
    expect(JSON.parse(localStorage.getItem('fh.customTerrain.hill')!)).toEqual(spec);
    expect(localStorage.getItem('fh.customTerrain.hill:base')).toBe('3');
    expect(JSON.parse(localStorage.getItem('fh.btMission.ss1')!)).toMatchObject({ map: 'custom', floor: '' });
  });
  // SIM-TAB-CHOOSER(11-09): 층 화면 위 띠 «시뮬 열기» — simAt 규칙 그대로(세계 층 = map·floor, 지형 층 = custom&terrain, 그 밖 = 꺼짐 + 이유)
  it('층 위 «시뮬 열기»: 세계 층 = 그 지도, 지형 층 = custom&terrain(사본 씀·다른 편집본이면 멈춤), 이어지지 않은 층 = 꺼짐 + 이유', async () => {
    const go = vi.spyOn(simNav, 'go').mockImplementation(() => {});
    const openBtn = () => $('.mx-bar [data-sim-open]') as HTMLButtonElement;
    seed(); sitePurpose = 'SIM'; MAPS.v1 = { ...MAPS.v1, ...SIMV };
    serve(KIM); await open('#/sim'); await settle();
    expect(openBtn().disabled).toBe(false);
    await click(openBtn());
    expect(go).toHaveBeenLastCalledWith('/sim/index.html?from=web&map=factory-inspection');
    act(() => root?.unmount()); root = null; localStorage.clear(); clearPlans();
    seed(); sitePurpose = 'SIM';   // 사람이 올린 지도
    serve(KIM); await open('#/sim'); await settle();
    expect(openBtn().disabled).toBe(true);
    expect($('[data-sim-open-why]')!.textContent).toContain('시뮬 세계·지형과 이어져 있지 않아');
    act(() => root?.unmount()); root = null; localStorage.clear(); clearPlans();
    seed(); sitePurpose = 'SIM'; f1Extra = { terrain_id: 'hill' }; MAPS.v1 = { ...MAPS.v1, ...TERRAIN_V };
    serve(KIM, { over: { 'GET /terrains/hill': [hill(), hill()] } }); await open('#/sim'); await settle();
    localStorage.setItem('fh.customTerrain.hill:base', '2');   // 화면을 연 뒤 다른 탭이 남긴 :base — 누를 때 다시 읽고 멈춤
    await click(openBtn());
    expect($('[data-sim-open-why]')!.textContent).toContain('덮지 않고 멈췄습니다');
    localStorage.clear(); go.mockClear();
    await click(openBtn());
    expect(go).toHaveBeenCalledWith('/sim/index.html?from=web&map=custom&terrain=hill');
    expect(JSON.parse(localStorage.getItem('fh.customTerrain.hill')!)).toEqual(HILL);
    act(() => root?.unmount()); root = null; localStorage.clear(); clearPlans();
    seed();   // 지도 탭(REAL) 층에는 «시뮬 열기» 없음
    serve(KIM); await open('#/map'); await settle();
    expect($('[data-sim-open]')).toBeNull();
  });
  /** 지형 저장(terrains.py)이 만든 판과 같은 값 */
  const TERRAIN_V = { provenance: 'SIMULATION' as const, source: 'IMPORT' as const, reason: TERRAIN_REASON, origin: [-2.5, -2, 0] as [number, number, number] };
  const HILL = { schema: 'fh_custom_terrain/1', id: 'hill', name: '언덕', size: [5, 4], spawn: [0, 0, 0], items: [] };
  const hill = (map_version_id = 'v1') => ({ status: 200, body: { spec: HILL, version: 3, floor_id: 'f1', map_version_id, archived_at: null, updated_at: '2026-11-09T00:00:00Z' } });
  const openHill = async (v: Partial<MapVersion>, t = hill()) => {
    seed(); sitePurpose = 'SIM'; f1Extra = { terrain_id: 'hill' }; MAPS.v1 = { ...MAPS.v1, ...TERRAIN_V, ...v };
    serve(KIM, { over: { 'GET /terrains/hill': [t, t] } });
    await open('#/sim'); await scen(); await click(row('s1')); await settle();
  };
  it('지형 층 판 확인(REVIEW-306 ①): 원점 회전이 0 이 아니거나·지형 저장이 만든 판이 아니거나·지형의 서버 판이 아니면 회색 + 이유', async () => {
    const go = vi.spyOn(simNav, 'go').mockImplementation(() => {});
    await openHill({ origin: [-2.5, -2, Math.PI / 2] });   // x·y·해상도·크기는 맞고 회전만 다름
    expect(btn('시뮬에서 실행')!.disabled).toBe(true);
    expect($('[data-sim-run-why]')!.textContent).toContain('«지형 만들기» 저장으로 만든 판이 아닙니다');
    act(() => root?.unmount()); root = null; clearPlans();
    await openHill({ reason: '현장 도면으로 바꿈' });   // 같은 층에 사람이 올린 판(지형 id 는 그대로)
    expect(btn('시뮬에서 실행')!.disabled).toBe(true);
    expect($('[data-sim-run-why]')!.textContent).toContain('만든 판이 아닙니다');
    act(() => root?.unmount()); root = null; clearPlans();
    await openHill({}, hill('v9'));   // 지형이 가리키는 층 판 ≠ 이 시나리오의 판
    expect(btn('시뮬에서 실행')!.disabled).toBe(true);
    expect($('[data-sim-run-why]')!.textContent).toContain('지금 판이 아닙니다');
    expect(go).not.toHaveBeenCalled();
  });
  it('지형 층 누를 때 다시 읽기(REVIEW-306 ②): 화면을 연 뒤 다른 탭이 만든 편집본·:base 는 덮지 않고 이동도 멈춤', async () => {
    const go = vi.spyOn(simNav, 'go').mockImplementation(() => {});
    await openHill({});
    expect(btn('시뮬에서 실행')!.disabled).toBe(false);   // 열 때는 저장소가 비어 있음
    localStorage.setItem('fh.customTerrain.hill', JSON.stringify({ ...HILL, name: '다른 탭 편집본' })); localStorage.setItem('fh.customTerrain.hill:base', '2');
    await click(btn('시뮬에서 실행'));
    expect(go).not.toHaveBeenCalled();
    expect(box.querySelector('[role="alert"]')?.textContent).toContain('다른 편집본이 생겼습니다');
    expect(JSON.parse(localStorage.getItem('fh.customTerrain.hill')!).name).toBe('다른 탭 편집본');
    expect(localStorage.getItem('fh.customTerrain.hill:base')).toBe('2');
    expect(localStorage.getItem('fh.btMission.ss1')).toBeNull();
    localStorage.clear(); localStorage.setItem('fh.customTerrain.hill:base', '2');   // 편집본 없이 기준 판만 있어도 덮지 않음
    await click(btn('시뮬에서 실행'));
    expect(go).not.toHaveBeenCalled();
    expect(localStorage.getItem('fh.customTerrain.hill:base')).toBe('2');
    expect(localStorage.getItem('fh.customTerrain.hill')).toBeNull();
    act(() => root?.unmount()); root = null; clearPlans();
    localStorage.clear(); localStorage.setItem('fh.customTerrain.hill', JSON.stringify(HILL)); localStorage.setItem('fh.customTerrain.hill:base', '3');   // 서버와 같은 편집본 = 그대로 두고 실행
    await openHill({});
    await click(btn('시뮬에서 실행'));
    expect(localStorage.getItem('fh.customTerrain.hill:base')).toBe('3');
    expect(go).toHaveBeenCalledWith('/sim/index.html?from=web&map=custom&terrain=hill&bt=ss1');
  });
  it('시뮬이 못 하는 일(센서 기록) = 회색 + 그 지점 이유', async () => {
    seed(); sitePurpose = 'SIM'; MAPS.v1 = { ...MAPS.v1, ...SIMV };
    make('scenarios', { name: '센서 순찰', waypoints: [wp('f1', 1, 1, 'm2')], finish: { mode: 'STAY', target: null }, notes: '' }, KIM);
    serve(KIM);
    await open('#/sim'); await scen();
    await click(row('s3')); await settle();
    expect(btn('시뮬에서 실행')!.disabled).toBe(true);
    expect($('[data-sim-run-why]')!.textContent).toBe('1번 지점: «센서 값 기록»은 시뮬에서 실행할 수 없습니다.');
  });
  it('지도 탭: 시뮬 장소는 보이지 않고, 실기 장소의 시나리오는 배정 탭 그대로·«시뮬에서 실행» 없음', async () => {
    seed(); sitePurpose = 'SIM';
    serve(KIM);
    await open('#/map');
    expect($('[data-building]')).toBeNull();
    expect(text()).toContain('실기 로봇이 SLAM 으로 만든 지도를 올리면 여기에 보입니다.');
    act(() => root?.unmount()); root = null;
    seed(); serve(KIM);
    await open('#/map'); await scen();
    await click(row('s1')); await settle();
    expect(btns().some((b) => b.textContent!.startsWith('배정'))).toBe(true);
    expect(btn('시뮬에서 실행')).toBeUndefined();
  });
});
