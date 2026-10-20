// W6a 임무 탭(01 MS-01·02·03·09, 02 F-MS-01~04·§10, 03 §5.3·U10, 05 §6 — S5a /actions·/missions·/scenarios·/scenarios/preview).
// fetch 는 상태를 가진 가짜 서버(판·If-Match·보관·권한·미리보기 흉내), WebSocket 은 FakeWS. 목록·보관 보기·더 보기, 임무 작업·인자 범위·회색 선택지·판 1→2·428·409·422,
// 옛 판 읽기 전용(옛 판 지도), 보관(확인창), 카탈로그 로봇 묶기, 시나리오 지점 찍기·끌기·순서·지도 지점·임무 고르기·갈 수 없음·연결점 없음·저장 막힘·409 STALE·422, 저장 불확실 대조,
// 운영 관리자 보는 중, 편집·미리보기·확인 중에도 STOP 이 보이고 실제로 정지 요청이 나가는지 본다.
import { act } from 'react';
import { createRoot, type Root as ReactRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Action, MapVersion, Mission, MissionWrite, RobotSummary, Scenario, ScenarioPoint, ScenarioWrite, SiteTree, User } from '../../../contracts/ts';
import { Root } from '../session';
import { clearPlans } from '../screens/missions';
import { FakeWS } from './fakeWs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KIM: User = { id: 'a1', username: 'kim', display_name: '김총괄', role: 'ORG_ADMIN', locked: false, robot_ids: [], created_at: '2026-10-19T00:00:00Z' };
const LEE: User = { ...KIM, id: 'o1', username: 'lee', display_name: '이운영', role: 'OPERATOR', robot_ids: ['r-a'] };
const PARK: User = { ...LEE, id: 'o2', username: 'park', display_name: '박운영', robot_ids: [] };
const RA: RobotSummary = { id: 'r-a', name: 'Go2-A', model: 'unitree_go2', owner: { id: LEE.id, display_name: LEE.display_name },
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
let calls: Call[] = [], db: Record<Kind, Rec[]>, approved: Record<string, string | null>, link = true, tick = 0;
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
      const tree: SiteTree = { items: [{ id: 's1', name: '본관', buildings: [{ id: 'b1', site_id: 's1', name: '본동', floors: [floor('f1', '1층', 1, approved.f1), floor('f2', '2층', 2, approved.f2), floor('f3', '3층', 3, null)] }] }], next_cursor: null };
      return { status: 200, body: tree };
    }
    let m = path.match(/^\/map-versions\/(v\d)$/);
    if (m) return { status: 200, body: MAPS[m[1]] };
    if (path === '/actions') return { status: 200, body: acts(q.get('robot_id')) };
    if (method === 'POST' && path === '/scenarios/preview') return preview(body!);
    m = path.match(/^\/(missions|scenarios)(?:\/([^/]+))?$/);
    if (!m) return err(404, 'NOT_FOUND', '찾을 수 없습니다.');
    const k = m[1] as Kind, id = m[2];
    if (!id && method === 'GET') {
      const all = db[k].filter((r) => q.get('archived') === 'true' || !r.head.archived_at).map((r) => r.head), from = Number(q.get('cursor') ?? 0), n = o.page ?? Number(q.get('limit'));
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
    if (me.role !== 'ORG_ADMIN' && r.head.created_by !== me.id) return err(403, 'FORBIDDEN', '만든 사람과 총괄만 바꿀 수 있습니다.');
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
  db = { missions: [], scenarios: [] }; approved = { f1: 'v1', f2: 'v2' }; link = true; tick = 0;
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
}
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); clearPlans(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

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
const saveBtn = () => (btn('저장') ?? btn('새 판으로 저장'))!;
const kind = (k: '임무' | '시나리오') => click(btn(k, card('종류')));
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
  it('시나리오 기본 — 이름·층·판·지점 수(배정 로봇·마지막 실행 칸 없음), 보관 제외 → «보관된 것도 보기», 임무로 바꾸기', async () => {
    seed(); serve(KIM);
    await open();
    expect($('h1')!.textContent).toBe('임무');
    const q = sent('GET', '/scenarios');
    expect(q).toHaveLength(1); expect(q[0].q.get('limit')).toBe('50'); expect(q[0].q.get('archived')).toBeNull();
    expect(rows()).toEqual(['s1']);
    expect(row('s1').textContent).toBe('1층 순찰1층판 1지점 2');
    expect(card('임무 목록').textContent).not.toContain('Go2-A');
    await click($('input[type="checkbox"]'));
    expect(last(sent('GET', '/scenarios'))!.q.get('archived')).toBe('true');
    expect(rows()).toEqual(['s1', 's2']); expect(row('s2').textContent).toContain('보관됨');
    await kind('임무');
    expect(last(sent('GET', '/missions'))!.q.get('archived')).toBe('true');
    expect(rows()).toEqual(['m1', 'm2', 'm3']);
    expect(row('m1').textContent).toBe('사진 순찰판 1작업 2');
    expect(btn('새 임무')).toBeTruthy();
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
    seed(); serve(KIM, { over: { 'GET /scenarios': [err(500, 'INTERNAL_ERROR', '서버 오류입니다.')] } });
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
    expect(text()).toContain('저장했습니다(판 1).');
    expect(rows()).toContain('m4');
    await setVal(name(), '창고 점검 2');
    await click(btn('새 판으로 저장'));
    const put = sent('PUT', '/missions/m4');
    expect(put).toHaveLength(1); expect(put[0].match).toBe('"1"');
    expect(text()).toContain('저장했습니다(판 2).');
    expect(($('select[aria-label="판"]') as HTMLSelectElement).selectedOptions[0].textContent).toBe('판 2 (최신)');
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
    expect(text()).toContain('다른 사람이 먼저 새 판을 저장했습니다. 입력은 그대로 있습니다.');
    expect(name().value).toBe('내가 고친 이름');
    await click(btn('최신 판 받기'));
    expect(name().value).toBe('내가 고친 이름');
    expect(text()).toContain('최신 판(판 2)을 받았습니다.');
    await click(saveBtn());
    expect(sent('PUT', '/missions/m1')[1].match).toBe('"2"');
    expect(text()).toContain('저장했습니다(판 3).');
    expect(rec('missions', 'm1')!.head.name).toBe('내가 고친 이름');
  });
  it('428(판 확인 없음)도 충돌과 같이 — 입력 유지, 덮어쓰지 않음', async () => {
    seed(); serve(KIM, { over: { 'PUT /missions/m1': [err(428, 'PRECONDITION_REQUIRED', 'If-Match 가 필요합니다.')] } });
    await open(); await kind('임무');
    await click(row('m1'));
    await setVal(name(), '고친 이름');
    await click(saveBtn());
    expect(text()).toContain('다른 사람이 먼저 새 판을 저장했습니다.'); expect(text()).not.toContain('If-Match');
    expect(name().value).toBe('고친 이름'); expect(btn('최신 판 받기')).toBeTruthy();
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
    await setVal($<HTMLSelectElement>('select[aria-label="판"]')!, '1');
    expect(last(sent('GET', '/missions/m1'))!.q.get('version')).toBe('1');
    expect($('[data-old]')!.textContent).toContain('옛 판(판 1)을 보는 중입니다(읽기 전용');
    expect(name().value).toBe('사진 순찰'); expect(name().readOnly).toBe(true);
    expect(btn('새 판으로 저장')).toBeUndefined(); expect(btn('보관')).toBeUndefined();
    expect(btns().some((b) => /덮어|되돌리|이 판으로/.test(b.textContent!))).toBe(false);
    expect(step(0).textContent).toContain('카메라');
    await setVal($<HTMLSelectElement>('select[aria-label="판"]')!, '2');
    expect(name().value).toBe('사진 순찰 v2'); expect(btn('새 판으로 저장')).toBeTruthy();
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
    expect(btn('새 판으로 저장')).toBeUndefined();
  });
});

describe('권한(02 §10)', () => {
  it('운영 관리자: 남의 임무·시나리오는 보는 중(편집·보관 단추 없음, 미리보기 안 부름), 내 것은 편집', async () => {
    seed(); serve(LEE);
    await open();
    await click(row('s1'));
    expect($('[data-readonly]')!.textContent).toBe('보는 중 — 만든 사람과 총괄 운영 관리자만 고칠 수 있습니다.');
    expect(btn('새 판으로 저장')).toBeUndefined(); expect(btn('보관')).toBeUndefined(); expect(name().readOnly).toBe(true);
    expect(aria('1번 지점 지우기')).toBeUndefined();
    await settle();
    expect(sent('POST', '/scenarios/preview')).toHaveLength(0);
    expect(text()).toContain('예상 거리 약 12 m');
    await kind('임무');
    await click(row('m1'));
    expect($('[data-readonly]')).toBeTruthy(); expect(btn('＋ 대기')).toBeUndefined(); expect(aria('1번 작업 지우기')).toBeUndefined();
    await click(row('m2'));
    expect($('[data-readonly]')).toBeNull(); expect(btn('새 판으로 저장')).toBeTruthy(); expect(btn('보관')).toBeTruthy();
    await stopSends();
  });
  it('총괄은 남(운영 관리자)의 것도 편집', async () => {
    seed(); serve(KIM);
    await open(); await kind('임무');
    await click(row('m2'));
    expect($('[data-readonly]')).toBeNull(); expect(btn('새 판으로 저장')).toBeTruthy();
  });
});

const floorBtn = (n: string) => btns(card('층')).find((b) => b.textContent!.startsWith(`본관 · 본동 · ${n}`))!;
describe('시나리오 편집(03 §5.3)', () => {
  it('지도 눌러 추가·지도 지점 고르기(waypoint_ref)·순서·끌어 옮기기·층 바꾸기·임무 고르기 → 미리보기(대략 거리·장치) → POST', async () => {
    seed(); serve(KIM);
    await open();
    await click(btn('새 시나리오'));
    expect(floorBtn('3층').disabled).toBe(true);                       // 승인 판 없는 층
    expect(floorBtn('1층').getAttribute('aria-pressed')).toBe('true');
    expect(map().querySelector('[data-zone="NO_GO"]')).toBeTruthy();   // 진입 금지 구역 그림
    await setVal(name(), '새 순찰');
    await tap(1, 1);
    await tap(0, 0, map().querySelector('[data-key="waypoints.0"]')!);
    expect(point(0).textContent).toContain('(1.0, 1.0) m'); expect(point(1).textContent).toContain('«입구»');
    expect($<HTMLSelectElement>('select[aria-label="1번 지점 임무"]')!.value).toBe('m1:1');   // 보관 안 된 첫 임무의 최신 판
    await click(aria('2번 지점 위로'));
    expect(point(0).textContent).toContain('«입구»');
    sized(); await ptr('pointerdown', 1, 1, map().querySelector('[data-pt="1"]')!); await ptr('pointermove', 1.5, 0.5); await ptr('pointerup', 1.5, 0.5);
    expect(point(1).textContent).toContain('(1.5, 0.5) m');
    await click(floorBtn('2층'));
    await tap(2, 0);
    await setVal($<HTMLSelectElement>('select[aria-label="3번 지점 임무"]')!, 'm2:1');
    expect(btns(card('층')).find((b) => b.textContent!.includes('1층'))!.textContent).toContain('(지점 2)');
    await settle();
    const pre = sent('POST', '/scenarios/preview');
    expect(pre.length).toBeGreaterThan(0);
    expect(last(pre)!.body).toEqual({ name: '새 순찰', notes: '', finish: { mode: 'STAY', target: null }, waypoints: [
      wp('f1', 0, 0, 'm1', 1, { yaw: 1.5, waypoint_ref: 'wp1' }), wp('f1', 1.5, 0.5), wp('f2', 2, 0, 'm2', 1)] });
    const p = card('경로 확인');
    expect(p.textContent).toContain('모든 지점에 갈 수 있습니다.');
    expect(p.textContent).toContain('예상 거리 약 12 m');
    expect(p.textContent).toContain('대략 값입니다. 실제로 걷는 길은 실행할 때 로봇이 정합니다.');
    expect(p.textContent).toContain('필요 장치: 카메라, 배터리');
    expect(p.textContent).toContain('2번 지점 → 3번 지점본동 1층 → 본동 2층 층 연결점을 거칩니다');
    expect(text()).not.toContain('Nav2');
    expect(saveBtn().disabled).toBe(false);
    await click(saveBtn());
    expect(writes()).toEqual(['POST /scenarios']);
    expect(text()).toContain('저장했습니다(판 1).');
    expect(rows()).toEqual(['s1', 's3']);
  });
  it('진입 금지 구역 안 지점 = 갈 수 없음 + 이유 + 저장 막힘(이유 보임), 지도 밖은 찍지 않음', async () => {
    seed(); serve(KIM);
    await open();
    await click(btn('새 시나리오'));
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
    expect(writes()).toEqual([]);
    await stopSends();                                               // 미리보기·막힘 중에도 STOP
  });
  it('층 연결점 짝이 없으면 구간·끝 지점에 이유, 저장 막힘', async () => {
    seed(); link = false; serve(KIM);
    await open();
    await click(btn('새 시나리오'));
    await setVal(name(), '두 층');
    await tap(1, 1);
    await click(floorBtn('2층')); await tap(1, 1);
    await settle();
    expect(card('구간').textContent).toContain('1번 지점 → 2번 지점두 층을 직접 잇는 연결점 짝이 없습니다.');
    expect(point(1).textContent).toContain('갈 수 없음: 두 층을 직접 잇는 연결점 짝이 없습니다.');
    expect(saveBtn().disabled).toBe(true);
  });
  it('끝나면 «지정 지점으로 이동» = 끝 지점을 찍어야 미리보기·저장, 끝 지점은 finish.target', async () => {
    seed(); serve(KIM);
    await open();
    await click(btn('새 시나리오'));
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
    expect(text()).toContain('저장했습니다(판 2).');
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
    sized(); await ptr('pointerdown', 0, 0, map().querySelector('[data-pt="1"]')!); await ptr('pointermove', 0.02, 0); await ptr('pointerup', 0.02, 0);
    expect(point(1).textContent).toContain('«입구»');
    sized(); await ptr('pointerdown', 0, 0, map().querySelector('[data-pt="1"]')!); await ptr('pointermove', 0.5, 0); await ptr('pointerup', 0.5, 0);
    expect(point(1).textContent).toContain('(0.5, 0.0) m');
    await settle();
    expect(last(sent('POST', '/scenarios/preview'))!.body).toMatchObject({ waypoints: [{}, { x: 0.5, y: 0, waypoint_ref: null }] });
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
    expect(text()).toContain('저장된 것을 확인했습니다(판 1).');
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
    expect(text()).toContain('저장했습니다(판 1).');
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
    expect(text()).toContain('저장된 것을 확인했습니다(판 2).');
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
    await click($('nav a[href="#/map"]'));
    await click($('nav a[href="#/mission"]'));
    expect(name().value).toBe('느린 새 임무');
    expect(saveBtn().disabled).toBe(true); expect(name().closest('fieldset')!.disabled).toBe(true);
    await click(saveBtn());
    expect(writes()).toEqual(['POST /missions']);
    expect(text()).toContain('저장이 아직 확인되지 않았습니다.');
    await act(async () => { release(); }); await flush();
    await click(btn('저장 확인'));
    expect(text()).toContain('저장된 것을 확인했습니다(판 1).');
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
    expect(text()).toContain('다른 사람이 먼저 새 판을 저장했습니다.');
    over['GET /missions/m1'].push(err(503, 'UNAVAILABLE', '잠시 뒤 다시 시도하세요.'));
    await click(btn('최신 판 받기'));
    expect(alertText()).toContain('임무를 받지 못했습니다.');
    expect(name().value).toBe('내 입력');
    await click(btn('다시 받기'));
    expect(name().value).toBe('내 입력');
    expect(text()).toContain('최신 판(판 2)을 받았습니다.');
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
    await setVal($<HTMLSelectElement>('select[aria-label="판"]')!, '1');
    expect($('[data-old]')).toBeTruthy();
    expect(sent('GET', '/map-versions/v1')).toHaveLength(1);
    expect(map().querySelector('image')!.getAttribute('href')).toContain('/map-versions/v1/image');
    expect(point(1).textContent).toContain('«입구»');
  });
  it('B6 지도를 못 받았을 때 «다시 받기»는 실제로 다시 요청한다', async () => {
    seed(); serve(KIM, { over: { 'GET /map-versions/v1': [err(503, 'UNAVAILABLE', '잠시 뒤 다시 시도하세요.')] } });
    await open();
    await click(btn('새 시나리오'));
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
    expect(text()).toContain('저장했습니다(판 2).');
  });
});

describe('저장 안 한 편집', () => {
  it('다른 탭에 갔다 와도 이어 쓰고, 목록에 «저장 안 한 편집»', async () => {
    seed(); serve(KIM);
    await open(); await kind('임무');
    await click(row('m1'));
    await setVal(name(), '쓰던 이름');
    await click($('nav a[href="#/map"]'));
    await click($('nav a[href="#/mission"]'));
    expect(row('m1').textContent).toContain('저장 안 한 편집');
    expect(name().value).toBe('쓰던 이름');
    expect(text()).toContain('저장하지 않은 편집을 이어서 씁니다.');
  });
});
