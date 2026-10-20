// W4a 지도 탭·관제 층 고르기(01 MP-01·02·04·06·FL-03, 02 F-MP, 03 §5.6·§5.1, 05 §5 — S3a /sites·/map-versions·/uploads).
// fetch 는 가짜 서버, WebSocket 은 FakeWS. 나무·권한별 단추, 409/403/404/422/413/네트워크 실패, 좌표 변환·y 뒤집힘,
// 두 단계 올리기 순서·실패 중단, STALE, 판 전환, 승인 판 없음, 로봇 점 없음, 어떤 실패에도 STOP 이 보이고 실제로 정지 요청이 나가는지 본다.
import { act } from 'react';
import { createRoot, type Root as ReactRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MapFeatures, MapVersion, RobotSummary, SiteTree, User } from '../../../contracts/ts';
import { Root } from '../session';
import { toPixel } from '../screens/maps';
import { kept } from '../screens/mapedit';
import raw from './mapcases.json?raw';
import { FakeWS } from './fakeWs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KIM: User = { id: 'a1', username: 'kim', display_name: '김총괄', role: 'ORG_ADMIN', locked: false, robot_ids: [], created_at: '2026-10-19T00:00:00Z' };
const LEE: User = { ...KIM, id: 'o1', username: 'lee', display_name: '이운영', role: 'OPERATOR', robot_ids: ['r-a'] };
const RA: RobotSummary = { id: 'r-a', name: 'Go2-A', model: 'unitree_go2', owner: { id: LEE.id, display_name: LEE.display_name },
  connection: 'OFFLINE', status: null, battery: null, location: null, lease: null, current_run: null, devices: [], attention: [] };
const floor = (id: string, name: string, level: number, approved: string | null, building = 'b1') => ({ id, building_id: building, name, level, approved_version_id: approved, pending_count: 0 });
/** 본관(본동 1층 판 2 승인·2층 지도 없음) */
const TREE: SiteTree = { items: [{ id: 's1', name: '본관', buildings: [{ id: 'b1', site_id: 's1', name: '본동', floors: [floor('f1', '1층', 1, 'v2'), floor('f2', '2층', 2, null)] }] }], next_cursor: null };
const EMPTY = { zones: [], waypoints: [], connectors: [], edits: [] };
/** 100×80 칸, 0.05 m/칸, origin (-1, -2, 0) — 지도 범위 x -1~4 m, y -2~2 m */
const ver = (id: string, number: number, p: Partial<MapVersion> = {}): MapVersion => ({ upload_id: `up-${id}`, id, floor_id: 'f1', number, base_version_id: null, copied_from_id: null, status: 'APPROVED', image_sha256: 'ab'.repeat(32),
  width: 100, height: 80, resolution: 0.05, origin: [-1, -2, 0], features: EMPTY, reason: `판 ${number} 이유`, source: 'IMPORT', created_by: KIM.id, created_at: '2026-10-20T05:00:00Z', ...p });
const FEAT = { zones: [{ id: 'z1', type: 'NO_GO' as const, name: '공사', polygon: [[-1, -2], [0, -2], [0, -1]] as [number, number][] }],
  waypoints: [{ id: 'w1', name: '계기판 A', x: 1.5, y: 0, yaw: 0 }], connectors: [{ id: 'c1', kind: 'STAIRS' as const, pair_floor_id: 'f2', x: 0, y: 0, yaw: 0 }],
  edits: [{ op: 'WALL' as const, polyline: [[0, 0], [1, 0]] as [number, number][], width: 0.1 }] };
const V2 = ver('v2', 2, { features: FEAT, base_version_id: 'v1', source: 'EDIT' }), V1 = ver('v1', 1, { status: 'SUPERSEDED', reason: '처음 올림' });
const err = (status: number, code: string, message: string) => ({ status, body: { error: { code, message, detail: {} } } });

type Reply = { status: number; body?: unknown };
type Route = Reply | ((q: URLSearchParams, body?: unknown) => Reply | Promise<Reply>);
type Call = { method: string; path: string; q: URLSearchParams; body?: unknown; type?: string };
let calls: Call[] = [];
function serve(routes: Record<string, Route>) {
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET', [path, qs = ''] = url.replace(/^\/api\/v1/, '').split('?'), q = new URLSearchParams(qs);
    const raw = init.body instanceof Blob, body = raw ? init.body : init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, q, body, type: (init.headers as Record<string, string> | undefined)?.['Content-Type'] });
    const hit = routes[`${method} ${path}`];
    const rep = typeof hit === 'function' ? await hit(q, body) : hit ?? err(404, 'NOT_FOUND', '장소·지도 자료를 찾을 수 없습니다.');
    return new Response(rep.status === 204 ? null : JSON.stringify(rep.body), { status: rep.status, headers: { 'Content-Type': 'application/json' } });
  });
}
const signedIn = (me: User, more: Record<string, Route> = {}) => ({
  'GET /auth/session': { status: 200, body: { client: 'web', csrf_token: 'csrf-1' } },
  'GET /me': { status: 200, body: me },
  'GET /robots': { status: 200, body: { items: [RA], next_cursor: null } },
  'GET /robots/r-a': { status: 200, body: RA },
  'GET /dashboard': { status: 200, body: { robots_total: 1, robots_online: 0, robots_attention: 0, robots_running: 0, approvals_pending: 0, operators: [] } },
  'GET /notifications': { status: 200, body: { items: [], next_cursor: null, unread_count: 0 } },
  'GET /events': { status: 200, body: { items: [], next_cursor: null } },
  'GET /users': { status: 200, body: { items: [KIM, LEE], next_cursor: null } },
  'GET /sites': { status: 200, body: TREE },
  'GET /map-versions/v2': { status: 200, body: V2 }, 'GET /map-versions/v1': { status: 200, body: V1 },
  'GET /floors/f1/map-versions': { status: 200, body: { items: [V2, V1], next_cursor: null } },
  'GET /floors/f2/map-versions': { status: 200, body: { items: [], next_cursor: null } },
  ...more,
});
const sent = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);
const writes = () => calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}${c.q.toString() ? `?${c.q}` : ''}`);

let root: ReactRoot | null = null, box: HTMLDivElement;
/** 화면 틀: frame(true) = 폰 폭으로 줄어듦(matchMedia change) */
const wide = { phone: false, fs: new Set<() => void>() };
const frame = async (phone: boolean) => { wide.phone = phone; act(() => wide.fs.forEach((f) => f())); await flush(); };
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); });
async function open(hash: string) {
  wide.phone = false; wide.fs.clear();
  window.matchMedia = ((q: string) => ({ get matches() { return wide.phone && q.includes('767'); }, media: q,
    addEventListener: (_: string, f: () => void) => wide.fs.add(f), removeEventListener: (_: string, f: () => void) => wide.fs.delete(f) })) as unknown as typeof window.matchMedia;
  location.hash = hash;
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<Root />); });
  await flush();
}
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); kept.d = null; vi.unstubAllGlobals(); vi.restoreAllMocks(); });   // 내려가며 남긴 편집은 시험마다 버림

const $ = <T extends Element = HTMLElement>(s: string, from: ParentNode = box) => from.querySelector<T>(s);
const btns = (from: ParentNode = box) => [...from.querySelectorAll('button')];
const btn = (t: string, from: ParentNode = box) => btns(from).find((b) => b.textContent === t) as HTMLButtonElement | undefined;
const card = (label: string) => $(`[aria-label="${label}"]`)!;
const click = async (b: Element | undefined | null) => { expect(b).toBeTruthy(); act(() => (b as HTMLElement).click()); await flush(); };
const setVal = async (el: HTMLInputElement | HTMLSelectElement, v: string) => {
  act(() => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!.call(el, v);
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  });
  await flush();
};
const field = (label: string, from: ParentNode = box) => [...from.querySelectorAll('label')].find((l) => l.textContent!.startsWith(label))!.querySelector('input') as HTMLInputElement;
const pickFile = async (label: string, f: File) => {
  const el = field(label, card('새 지도 올리기'));
  act(() => { Object.defineProperty(el, 'files', { value: [f], configurable: true }); el.dispatchEvent(new Event('change', { bubbles: true })); });
  await flush();
};
const PGM = () => new File(['P5 100 80 255\n'], 'floor.pgm'), YAML = () => new File(['resolution: 0.05\n'], 'floor.yaml');
const fillUpload = async (reason = '새로 스캔') => { await pickFile('지도 그림', PGM()); await pickFile('지도 설정', YAML()); await setVal(field('바꾼 이유', card('새 지도 올리기')), reason); };
const alertText = () => [...box.querySelectorAll('[role="alert"]')].map((a) => a.textContent).join(' ');
const img = () => $<SVGImageElement>('[aria-label="지도 보기"] svg image');
const floorBtn = (name: string) => btns(card('장소')).find((b) => b.textContent!.startsWith(name))!;

/** STOP 이 머리줄 맨 끝에 있고 누를 수 있다 + 실제로 눌러 정지 요청이 실시간 연결로 나간다(대상이 없으면 로봇 고르기에서 골라) */
const stopSends = async () => {
  const s = $<HTMLButtonElement>('[data-stop]')!;
  expect(s.disabled).toBe(false);
  expect($('header')!.lastElementChild).toBe(s);
  act(() => FakeWS.last.open());
  await click(s);
  const pick = $<HTMLSelectElement>('[aria-label="정지할 로봇"]');
  if (pick) { await setVal(pick, pick.options[pick.options.length - 1].value); await click(btn('정지', $('[aria-label="정지할 로봇 고르기"]')!)); }
  expect(FakeWS.last.of('stop').map((m) => m.robot)).toEqual(['r-a']);
};

describe('좌표 → 그림 픽셀', () => {
  const v = { origin: [-1, -2, 0] as [number, number, number], resolution: 0.05, height: 80 };
  it('origin = 그림 왼쪽 아래, 위로 갈수록 픽셀 y 가 작아짐(y 뒤집힘)', () => {
    expect(toPixel(v, -1, -2)).toEqual([0, 80]);         // origin → 왼쪽 아래 모서리
    expect(toPixel(v, 4, 2)).toEqual([100, 0]);           // 범위 끝 → 오른쪽 위 모서리
    const [x, y] = toPixel(v, -0.5, -1);                  // 0.5 m 오른쪽·1 m 위 → 10칸·20칸
    expect(x).toBeCloseTo(10); expect(y).toBeCloseTo(60);
  });
  it('origin 방향(yaw)도 서버 검사와 같은 회전', () => {
    const r = { ...v, origin: [0, 0, Math.PI / 2] as [number, number, number] };
    const [x, y] = toPixel(r, 0, 1);                      // 지도 +y 1 m = 그림의 +x 방향 1 m(20칸)
    expect(x).toBeCloseTo(20); expect(y).toBeCloseTo(80);
    const [x2, y2] = toPixel(r, -1, 0);                   // 지도 -x 1 m = 그림 위로 20칸
    expect(x2).toBeCloseTo(0); expect(y2).toBeCloseTo(60);
  });
});

describe('지도 탭 — 장소 나무', () => {
  it('장소 → 건물 → 층, 층마다 승인 판 번호(없으면 «지도 없음»), 처음 층의 승인 판을 보인다', async () => {
    serve(signedIn(KIM));
    await open('#/map');
    expect(card('장소 본관').textContent).toContain('본동');
    expect([...card('본동 층').querySelectorAll('li button')].map((b) => b.textContent)).toEqual(['1층판 2', '2층지도 없음']);
    expect(floorBtn('1층').getAttribute('aria-pressed')).toBe('true');
    expect(card('지도 보기').querySelector('h2')!.textContent).toBe('본관 본동 1층 · 승인 판 2');
    expect(img()!.getAttribute('href')).toBe('/api/v1/map-versions/v2/image');
    expect($('[data-stop]')).toBeTruthy();
  });
  it('총괄: 고치기 — 장소·건물·층 만들기, 이름 바꾸기 요청 모양', async () => {
    serve(signedIn(KIM, { 'POST /sites': { status: 201, body: { id: 's2', name: '별관', buildings: [] } },
      'POST /sites/s1/buildings': { status: 201, body: { id: 'b2', site_id: 's1', name: '신동', floors: [] } },
      'POST /buildings/b1/floors': { status: 201, body: floor('f3', '지하 1층', -1, null) },
      'PATCH /floors/f2': { status: 200, body: floor('f2', '2층 동쪽', 2, null) } }));
    await open('#/map');
    expect(btn('이름 바꾸기')).toBeUndefined();
    await click(btn('고치기'));
    await click(btn('+ 장소'));
    await setVal(field('이름', card('새 장소')), '별관​');                          // 보이지 않는 글자(서버 422) — 보내지 않음
    await click(btn('저장', card('새 장소')));
    expect(alertText()).toContain('보이지 않는 글자는 쓸 수 없습니다.');
    expect(writes()).toEqual([]);
    await setVal(field('이름', card('새 장소')), '  별관 ');
    await click(btn('저장', card('새 장소')));
    await click(btn('+ 건물'));
    await setVal(field('이름', card('본관 에 새 건물')), '신동');
    await click(btn('저장', card('본관 에 새 건물')));
    await click(btn('+ 층'));
    const f = card('본관 본동 에 새 층');
    await setVal(field('이름', f), '지하 1층');
    await setVal(field('층 번호', f), '1.5');
    await click(btn('저장', f));
    expect(alertText()).toContain('층 번호는 -1000~1000 사이 정수');                // 보내지 않음
    await setVal(field('층 번호', f), '-1');
    await click(btn('저장', f));
    const row2 = floorBtn('2층').parentElement!;
    await click(btn('이름 바꾸기', row2));
    await setVal(field('이름', card('층 이름 바꾸기 — 2층')), '2층 동쪽');
    await click(btn('저장', card('층 이름 바꾸기 — 2층')));
    expect(writes()).toEqual(['POST /sites', 'POST /sites/s1/buildings', 'POST /buildings/b1/floors', 'PATCH /floors/f2']);
    expect(calls.filter((c) => c.method !== 'GET').map((c) => c.body)).toEqual([{ name: '별관' }, { name: '신동' }, { name: '지하 1층', level: -1 }, { name: '2층 동쪽', level: 2 }]);
    expect(sent('GET', '/sites')).toHaveLength(5);                                     // 바꿀 때마다 나무를 다시 받음
    expect(card('장소').textContent).toContain('이름을 바꿨습니다.');
    await click(floorBtn('1층'));                                                     // 다른 층을 고르면 지난 알림은 지움
    expect(card('장소').textContent).not.toContain('이름을 바꿨습니다.');
  });
  it('지우기: 확인 뒤 DELETE, 409 RESOURCE_IN_USE·403·404·네트워크 실패를 쉬운 문구로', async () => {
    const replies: Route[] = [err(409, 'RESOURCE_IN_USE', '하위 자료나 사용 중인 지도가 있어 지울 수 없습니다.'), err(403, 'FORBIDDEN', '총괄 운영 관리자만 할 수 있습니다.'),
      err(404, 'NOT_FOUND', '장소·지도 자료를 찾을 수 없습니다.'), () => { throw new TypeError('Failed to fetch'); }, { status: 204 }];
    serve(signedIn(KIM, { 'DELETE /floors/f1': () => { const r = replies.shift()!; return typeof r === 'function' ? r(new URLSearchParams()) : r; },
      'DELETE /sites/s1': err(409, 'RESOURCE_IN_USE', '하위 자료나 사용 중인 지도가 있어 지울 수 없습니다.') }));
    await open('#/map');
    await click(btn('고치기'));
    const del = async () => { await click(btn('지우기', floorBtn('1층').parentElement!)); expect(card('확인').textContent).toContain('«1층» 층을 지울까요?'); await click(btn('지우기', card('확인'))); };
    await del();
    expect(alertText()).toContain('쓰는 지도 판이 있어 지울 수 없습니다');
    await del();
    expect(alertText()).toContain('총괄 운영 관리자만 할 수 있습니다.');
    const before = sent('GET', '/sites').length;
    await del();
    expect(alertText()).toContain('이 층을 찾을 수 없습니다. 지워졌을 수 있어 목록을 다시 받습니다.');
    expect(sent('GET', '/sites').length).toBe(before + 1);
    await del();
    expect(alertText()).toContain('서버에 연결하지 못했습니다');
    await del();
    expect(card('장소').textContent).toContain('«1층» 층을 지웠습니다.');
    await click(btn('지우기', card('장소 본관').querySelector('.fh-row')!));
    await click(btn('지우기', card('확인')));
    expect(alertText()).toContain('건물이 있는 장소는 지울 수 없습니다. 안의 건물을 먼저 지우세요.');
    expect(sent('DELETE', '/floors/f1')).toHaveLength(5);
    await stopSends();
  });
  it('운영 관리자: 보기만 — 고치기·이름 바꾸기·지우기·올리기 단추 없음', async () => {
    serve(signedIn(LEE));
    await open('#/map');
    expect(img()!.getAttribute('href')).toBe('/api/v1/map-versions/v2/image');
    const words = btns().map((b) => b.textContent);
    for (const w of ['고치기', '이름 바꾸기', '지우기', '+ 장소', '올리기']) expect(words, w).not.toContain(w);
    expect($('[aria-label="새 지도 올리기"]')).toBeNull();
    expect(sent('GET', '/users')).toHaveLength(0);                                     // 계정 목록은 총괄만
    await stopSends();
  });
  it('장소 목록 실패(네트워크·어긋난 응답) — 칸 안 글 + 다시 시도, STOP 은 그대로', async () => {
    let n = 0;
    serve(signedIn(KIM, { 'GET /sites': () => (++n === 1 ? { status: 200, body: { items: [{ id: 's1' }] } } : n === 2 ? (() => { throw new TypeError('x'); })() : { status: 200, body: TREE }) }));
    await open('#/map');
    expect(alertText()).toContain('장소 목록을 받지 못했습니다. 받은 지도 형식이 맞지 않습니다.');
    await click(btn('다시 시도', card('장소')));
    expect(alertText()).toContain('서버에 연결하지 못했습니다');
    await click(btn('다시 시도', card('장소')));
    expect(alertText()).toBe('');
    expect(floorBtn('1층')).toBeTruthy();
    await stopSends();
  });
  it('장소가 없으면 안내(총괄은 고치기로 만들기)', async () => {
    serve(signedIn(KIM, { 'GET /sites': { status: 200, body: { items: [], next_cursor: null } } }));
    await open('#/map');
    expect(card('장소').textContent).toContain('등록된 장소가 없습니다. «고치기»에서 장소·건물·층을 만드세요.');
  });
});

describe('지도 탭 — 보기', () => {
  it('판 정보(번호·이유·만든 사람·시각·요소 수)와 요소를 판의 해상도·origin 으로 겹쳐 그림', async () => {
    serve(signedIn(KIM));
    await open('#/map');
    const view = card('지도 보기');
    expect(view.textContent).toContain('판 2');
    expect(view.textContent).toContain('판 2 이유');
    expect(view.textContent).toContain('만든 사람김총괄');
    expect(view.textContent).toContain(new Date('2026-10-20T05:00:00Z').toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }));
    expect(view.textContent).toContain('구역 1 · 지점 1 · 연결점 1');
    expect(view.textContent).not.toMatch(/[0-9a-f]{7,}/);                                // 해시 등 16진 문자열 0(금지어)
    const svg = view.querySelector('svg')!;
    expect(svg.getAttribute('viewBox')).toBe('0 0 100 80');
    expect(svg.querySelector('[data-zone="NO_GO"]')!.getAttribute('points')).toBe('0,80 20,80 20,60');   // (-1,-2)(0,-2)(0,-1) → y 뒤집힘
    const wp = svg.querySelector('[data-waypoint="계기판 A"] circle')!;
    expect([wp.getAttribute('cx'), wp.getAttribute('cy')]).toEqual(['50', '40']);          // (1.5, 0) → 2.5 m/0.05, 80 - 2 m/0.05
    const k = svg.querySelector('[data-connector="STAIRS"]')!;
    expect([Number(k.getAttribute('x')) + 1, Number(k.getAttribute('y')) + 1]).toEqual([20, 40]);   // (0,0) 중심, 반지름 = 100/100
    expect(svg.querySelector('[data-robot]')).toBeNull();                                // 로봇 점은 그리지 않음(D5 전)
  });
  it('판 목록에서 옛 판 보기 — 그림·정보가 그 판으로, «지난 판» 표시', async () => {
    serve(signedIn(KIM));
    await open('#/map');
    const sel = $<HTMLSelectElement>('select[aria-label="판"]')!;
    expect([...sel.options].map((o) => o.textContent)).toEqual(['판 2 · 승인', '판 1']);
    await setVal(sel, 'v1');
    expect(img()!.getAttribute('href')).toBe('/api/v1/map-versions/v1/image');
    expect(card('지도 보기').textContent).toContain('지난 판을 보는 중입니다. 지금 승인 판은 판 2입니다.');
    expect(card('지도 보기').textContent).toContain('처음 올림');
    expect(card('지도 보기').textContent).toContain('구역 0 · 지점 0 · 연결점 0');
  });
  it('승인 판이 없는 층 → «아직 지도가 없습니다»(그림 요청 없음)', async () => {
    serve(signedIn(LEE));
    await open('#/map');
    await click(floorBtn('2층'));
    expect(card('지도 보기').textContent).toContain('아직 지도가 없습니다.');
    expect(card('지도 보기').textContent).not.toContain('올리세요');
    expect(img()).toBeNull();
  });
  it('그림을 못 받으면 칸 안 글 + 다시 불러오기(새 요청), STOP 은 그대로', async () => {
    serve(signedIn(KIM));
    await open('#/map');
    expect(card('지도 보기').textContent).toContain('지도 그림을 불러오는 중…');
    const first = img()!;
    act(() => { first.dispatchEvent(new Event('error')); });
    expect(alertText()).toContain('지도 그림을 불러오지 못했습니다. 네트워크를 확인한 뒤 다시 불러오세요.');
    await click(btn('다시 불러오기'));
    expect(img()).not.toBe(first);                                                        // 새 <image> = 새 요청
    act(() => { img()!.dispatchEvent(new Event('load')); });
    expect(alertText()).toBe('');
    expect(card('지도 보기').textContent).not.toContain('불러오는 중');
    await stopSends();
  });
  it('판 목록 404(지워진 층) → 안내 + 나무 다시 받기, 네트워크 실패 → 다시 시도', async () => {
    let n = 0;
    serve(signedIn(KIM, { 'GET /floors/f1/map-versions': () => (++n === 1 ? err(404, 'NOT_FOUND', '장소·지도 자료를 찾을 수 없습니다.') : n === 2 ? (() => { throw new TypeError('x'); })() : { status: 200, body: { items: [V2], next_cursor: null } }) }));
    await open('#/map');
    expect(alertText()).toContain('이 층을 찾을 수 없습니다. 지워졌을 수 있어 장소 목록을 다시 받습니다.');
    expect(sent('GET', '/sites')).toHaveLength(2);
    await click(btn('다시 시도', card('지도 보기')));
    expect(alertText()).toContain('판 목록을 받지 못했습니다. 서버에 연결하지 못했습니다');
    await click(btn('다시 시도', card('지도 보기')));
    expect(img()).toBeTruthy();
  });
});

describe('지도 탭 — 새 지도 올리기(총괄)', () => {
  const ok = (more: Record<string, Route> = {}) => signedIn(KIM, {
    'POST /uploads': (q) => ({ status: 201, body: { upload_id: q.get('image') ? 'up-yaml' : 'up-img', sha256: 'cd'.repeat(32) } }),
    'POST /floors/f1/map-versions': { status: 201, body: ver('v3', 3, { base_version_id: 'v2' }) },
    'POST /floors/f2/map-versions': { status: 201, body: ver('v9', 1, { floor_id: 'f2' }) },
    ...more });
  it('그림 → ?image=그림ID 로 yaml → 판 저장 순서, 본문·Content-Type·base(지금 승인 판)·지금 판 요소(벽 고침 선 빼고)', async () => {
    serve(ok());
    await open('#/map');
    await fillUpload('  새로 스캔 ');
    await click(btn('올리기'));
    expect(writes()).toEqual(['POST /uploads', 'POST /uploads?image=up-img', 'POST /floors/f1/map-versions']);
    const [a, b, save] = calls.filter((c) => c.method === 'POST');
    expect([a.type, b.type]).toEqual(['image/x-portable-graymap', 'text/yaml']);
    expect([(a.body as File).name, (b.body as File).name]).toEqual(['floor.pgm', 'floor.yaml']);   // 고른 파일 그대로(원시 본문)
    expect(save.body).toEqual({ base_version_id: 'v2', image: 'up-yaml', reason: '새로 스캔', features: { zones: FEAT.zones, waypoints: FEAT.waypoints, connectors: FEAT.connectors, edits: [] } });
    expect(card('지도 보기').textContent).toContain('새 판을 저장했습니다(판 3).');
    expect(sent('GET', '/floors/f1/map-versions').length).toBeGreaterThan(1);              // 판 목록·나무 다시 받기
    expect(sent('GET', '/sites').length).toBeGreaterThan(1);
  });
  it('«그대로 두기»를 끄면 빈 요소, 승인 판 없는 층은 base null + 빈 요소', async () => {
    serve(ok());
    await open('#/map');
    await fillUpload();
    const keep = [...card('새 지도 올리기').querySelectorAll('input[type=checkbox]')][0] as HTMLInputElement;
    act(() => keep.click()); await flush();
    await click(btn('올리기'));
    expect(sent('POST', '/floors/f1/map-versions')[0].body).toMatchObject({ base_version_id: 'v2', features: EMPTY });
    await click(floorBtn('2층'));
    expect(card('새 지도 올리기').querySelector('input[type=checkbox]')).toBeNull();
    await fillUpload('첫 지도');
    await click(btn('올리기'));
    expect(sent('POST', '/floors/f2/map-versions')[0].body).toEqual({ base_version_id: null, image: 'up-yaml', features: EMPTY, reason: '첫 지도' });
  });
  it('보내기 전 검사: 파일 빠짐·확장자·크기 초과·이유 없음이면 요청 0', async () => {
    serve(ok());
    await open('#/map');
    await click(btn('올리기'));
    expect(alertText()).toContain('지도 그림(pgm·png)과 지도 설정(yaml) 파일을 모두 고르세요.');
    await pickFile('지도 그림', new File(['x'], 'floor.jpg')); await pickFile('지도 설정', YAML());
    await click(btn('올리기'));
    expect(alertText()).toContain('지도 그림은 pgm 또는 png 파일이어야 합니다.');
    await pickFile('지도 그림', new File([new Uint8Array(8 * 1024 * 1024 + 1)], 'big.png'));
    await click(btn('올리기'));
    expect(alertText()).toContain('파일이 너무 큽니다.');
    await pickFile('지도 그림', PGM());
    await click(btn('올리기'));
    expect(alertText()).toContain('바꾼 이유를 입력하세요.');
    expect(writes()).toEqual([]);
  });
  it('앞 단계가 실패하면 다음 단계를 보내지 않음 — 그림 422·yaml 413·저장 422 INVALID_FEATURES·403, 쉬운 문구', async () => {
    const step1: Reply[] = [err(422, 'INVALID_UPLOAD', 'PNG CRC가 올바르지 않습니다.')], step2: Reply[] = [err(413, 'UPLOAD_TOO_LARGE', '올릴 수 있는 파일 크기를 넘었습니다.')];
    const saves: Reply[] = [err(422, 'INVALID_FEATURES', '지도 범위 안의 좌표를 입력하세요.'), err(403, 'APPROVAL_REQUIRED', '운영 관리자 지도 저장은 결재 기능이 열린 뒤 사용할 수 있습니다.')];
    serve(ok({ 'POST /uploads': (q) => (q.get('image') ? step2.shift() : step1.shift()) ?? { status: 201, body: { upload_id: q.get('image') ? 'up-yaml' : 'up-img', sha256: '' } },
      'POST /floors/f1/map-versions': () => saves.shift()! }));
    await open('#/map');
    await fillUpload();
    await click(btn('올리기'));
    expect(writes()).toEqual(['POST /uploads']);
    expect(alertText()).toContain('올리지 못했습니다. 지도 그림 파일을 읽을 수 없습니다.');
    expect(alertText()).not.toContain('CRC');                                              // 서버의 파일 내부 용어는 보이지 않음
    await click(btn('올리기'));
    expect(writes()).toEqual(['POST /uploads', 'POST /uploads', 'POST /uploads?image=up-img']);
    expect(alertText()).toContain('파일이 너무 큽니다. 지도 그림은 8 MB, 지도 설정(yaml)은 16 KB 까지');
    await click(btn('올리기'));
    expect(alertText()).toContain('새 지도 범위 밖에 있는 것이 있습니다.');
    await click(btn('올리기'));
    expect(alertText()).toContain('운영 관리자 지도 저장은 결재 기능이 열린 뒤 사용할 수 있습니다.');
    expect(sent('POST', '/floors/f1/map-versions')).toHaveLength(2);
    expect(btn('올리기')!.disabled).toBe(false);
    await stopSends();
  });
  it('409 STALE → «다른 사람이 먼저 바꿨습니다» + 새로 불러오기 → 새 승인 판을 base 로 다시 올림', async () => {
    let tree = TREE;
    const moved: SiteTree = { items: [{ ...TREE.items[0], buildings: [{ ...TREE.items[0].buildings[0], floors: [floor('f1', '1층', 1, 'v3'), floor('f2', '2층', 2, null)] }] }], next_cursor: null };
    const V3 = ver('v3', 3, { reason: '다른 사람 판' });
    serve(ok({ 'GET /sites': () => ({ status: 200, body: tree }), 'GET /map-versions/v3': { status: 200, body: V3 },
      'GET /floors/f1/map-versions': () => ({ status: 200, body: { items: tree === TREE ? [V2, V1] : [V3, V2, V1], next_cursor: null } }),
      'POST /floors/f1/map-versions': (_q, b) => ((b as { base_version_id: string }).base_version_id === 'v3' ? { status: 201, body: ver('v4', 4) }
        : { status: 409, body: { error: { code: 'STALE', message: '승인된 지도 판이 바뀌었습니다.', detail: { approved_version_id: 'v3' } } } }) }));
    await open('#/map');
    await fillUpload();
    tree = moved;                                                                           // 그 사이 다른 총괄이 판 3 승인
    await click(btn('올리기'));
    expect(alertText()).toContain('다른 사람이 먼저 이 층의 지도를 바꿨습니다. 새로 불러온 뒤 다시 올리세요.');
    await click(btn('새로 불러오기'));
    expect(card('지도 보기').querySelector('h2')!.textContent).toBe('본관 본동 1층 · 승인 판 3');
    await click(btn('올리기'));                                                            // 고른 파일·이유는 그대로
    expect(sent('POST', '/floors/f1/map-versions').map((c) => (c.body as { base_version_id: string }).base_version_id)).toEqual(['v2', 'v3']);
    expect(card('지도 보기').textContent).toContain('새 판을 저장했습니다(판 4).');
  });
  it('검토 B1: 승인 판이 있는데 판 목록이 503·네트워크 실패면 올리기 막힘(빈 요소로 새 승인 판 금지) → 받은 뒤에는 그 판 요소를 그대로 보냄', async () => {
    const lists: Route[] = [err(503, 'SERVICE_UNAVAILABLE', '잠시 뒤 다시 시도하세요.'), () => { throw new TypeError('Failed to fetch'); }];
    serve(ok({ 'GET /floors/f1/map-versions': (q) => { const r = lists.shift(); return !r ? { status: 200, body: { items: [V2, V1], next_cursor: null } } : typeof r === 'function' ? r(q) : r; } }));
    await open('#/map');
    expect(alertText()).toContain('판 목록을 받지 못했습니다.');
    await fillUpload();
    expect(btn('올리기')!.disabled).toBe(true);
    expect(card('새 지도 올리기').querySelector('input[type=checkbox]')).toBeNull();
    expect(card('새 지도 올리기').textContent).toContain('지금 승인 판의 구역·지점·연결점을 받은 뒤에 올릴 수 있습니다.');
    act(() => (card('새 지도 올리기') as HTMLFormElement).requestSubmit()); await flush();   // 단추를 우회해 보내도
    await click(btn('다시 시도', card('지도 보기')));
    expect(btn('올리기')!.disabled).toBe(true);                                               // 네트워크 실패도 같음
    expect(writes()).toEqual([]);
    await click(btn('다시 시도', card('지도 보기')));
    await fillUpload();
    await click(btn('올리기'));
    expect(sent('POST', '/floors/f1/map-versions')[0].body).toMatchObject({ base_version_id: 'v2', features: { zones: FEAT.zones, waypoints: FEAT.waypoints, connectors: FEAT.connectors, edits: [] } });
  });
  it('검토 B1: 빈 요소로 바꾸기는 «그대로 두기»를 끄는 명시적 선택 + 경고', async () => {
    serve(ok());
    await open('#/map');
    expect(alertText()).not.toContain('모두 빠진 새 판');
    act(() => (card('새 지도 올리기').querySelector('input[type=checkbox]') as HTMLInputElement).click()); await flush();
    expect(alertText()).toContain('끄면 진입 금지·감속 구역, 지점, 연결점이 모두 빠진 새 판이 됩니다.');
  });
  it('검토 B2: STALE 새로 불러오기에서 옛 기준 판 목록이 늦게 와도 최신 목록(판 3)을 덮지 않음, 새 판 자료 전엔 올리기 막힘', async () => {
    let tree = TREE, n = 0, late: (r: Reply) => void = () => {};
    const moved: SiteTree = { items: [{ ...TREE.items[0], buildings: [{ ...TREE.items[0].buildings[0], floors: [floor('f1', '1층', 1, 'v3'), floor('f2', '2층', 2, null)] }] }], next_cursor: null };
    const V3 = ver('v3', 3, { features: { ...FEAT, zones: [{ ...FEAT.zones[0], id: 'z3' }] } });
    serve(ok({ 'GET /sites': () => ({ status: 200, body: tree }), 'GET /map-versions/v3': { status: 200, body: V3 },
      'GET /floors/f1/map-versions': () => (++n === 2 ? new Promise<Reply>((r) => { late = r; }) : { status: 200, body: { items: n === 1 ? [V2, V1] : [V3, V2, V1], next_cursor: null } }),
      'POST /floors/f1/map-versions': (_q, b) => ((b as { base_version_id: string }).base_version_id === 'v3' ? { status: 201, body: ver('v4', 4) }
        : { status: 409, body: { error: { code: 'STALE', message: '승인된 지도 판이 바뀌었습니다.', detail: { approved_version_id: 'v3' } } } }) }));
    await open('#/map');
    await fillUpload();
    tree = moved;
    await click(btn('올리기'));
    await click(btn('새로 불러오기'));                       // 목록 A(옛 기준 v2)는 매달림, 나무가 v3 로 바뀌며 목록 B 는 바로 옴
    expect(n).toBe(3);
    expect(card('지도 보기').querySelector('h2')!.textContent).toBe('본관 본동 1층 · 승인 판 3');
    await act(async () => late({ status: 200, body: { items: [V2, V1], next_cursor: null } })); await flush();   // A 가 늦게 끝남
    expect(card('지도 보기').querySelector('h2')!.textContent).toBe('본관 본동 1층 · 승인 판 3');
    expect(card('지도 보기').textContent).not.toContain('아직 지도가 없습니다');
    await click(btn('올리기'));
    expect(sent('POST', '/floors/f1/map-versions')[1].body).toMatchObject({ base_version_id: 'v3', features: { zones: V3.features.zones } });
  });
  it('검토 B2: 기준 판이 바뀐 뒤 새 목록이 오기 전에는 올리기 막힘', async () => {
    let tree = TREE, n = 0, late: (r: Reply) => void = () => {};
    const moved: SiteTree = { items: [{ ...TREE.items[0], buildings: [{ ...TREE.items[0].buildings[0], floors: [floor('f1', '1층', 1, 'v3'), floor('f2', '2층', 2, null)] }] }], next_cursor: null };
    serve(ok({ 'GET /sites': () => ({ status: 200, body: tree }),
      'GET /floors/f1/map-versions': () => (++n === 1 ? { status: 200, body: { items: [V2, V1], next_cursor: null } } : new Promise<Reply>((r) => { late = r; })),
      'POST /floors/f1/map-versions': err(409, 'STALE', '승인된 지도 판이 바뀌었습니다.') }));
    await open('#/map');
    await fillUpload();
    tree = moved;
    await click(btn('올리기'));
    await click(btn('새로 불러오기'));
    expect(btn('올리기')!.disabled).toBe(true);
    expect(card('지도 보기').textContent).not.toContain('승인 판 2');                     // 옛 판을 지금 판처럼 보이지 않음
    expect(card('지도 보기').textContent).toContain('판 목록을 불러오는 중…');            // 옛 기준 목록으로 «지도 없음»이라 하지 않음
    expect(card('지도 보기').textContent).not.toContain('아직 지도가 없습니다');
    await act(async () => late({ status: 200, body: { items: [ver('v3', 3), V2, V1], next_cursor: null } })); await flush();
    expect(sent('POST', '/floors/f1/map-versions')).toHaveLength(1);
  });
  it('저장 응답이 끊기면 다시 올리라 하지 않고 판 목록·나무를 다시 받음, 408 은 쉬운 문구, 503 은 SERVER_BUSY 만 바쁨 문구', async () => {
    const ups: Reply[] = [err(408, 'UPLOAD_TIMEOUT', 'request body timeout'), err(503, 'FILE_STORAGE_ERROR', '지도 파일을 확인할 수 없습니다.'),
      err(503, 'SERVER_BUSY', 'map conversion slots full')];
    serve(ok({ 'POST /uploads': (q) => ups.shift() ?? { status: 201, body: { upload_id: q.get('image') ? 'up-yaml' : 'up-img', sha256: '' } },
      'POST /floors/f1/map-versions': () => { throw new TypeError('Failed to fetch'); } }));
    await open('#/map');
    await fillUpload();
    await click(btn('올리기'));
    expect(alertText()).toContain('파일을 보내는 데 시간이 너무 오래 걸렸습니다.');
    await click(btn('올리기'));
    expect(alertText()).toContain('올리지 못했습니다. 지도 파일을 확인할 수 없습니다.');      // 검토 r2 권고: 모든 503 을 «바쁨»으로 덮지 않음
    expect(alertText()).not.toMatch(/timeout|다른 지도를 처리/);
    await click(btn('올리기'));
    expect(alertText()).toContain('올리지 못했습니다. 서버가 지금 다른 지도를 처리하고 있습니다. 잠시 뒤 다시 올리세요.');
    expect(alertText()).not.toContain('map conversion');
    const lists = sent('GET', '/floors/f1/map-versions').length, trees = sent('GET', '/sites').length;
    await click(btn('올리기'));
    expect(alertText()).toContain('저장 응답을 받지 못했습니다. 저장됐을 수 있어 판 목록을 다시 받습니다.');
    expect(sent('GET', '/floors/f1/map-versions').length).toBe(lists + 1);
    expect(sent('GET', '/sites').length).toBe(trees + 1);
    expect(btn('새로 불러오기')).toBeUndefined();
    await stopSends();
  });
});

describe('검토 B3 — 저장 201 헤더 뒤 본문이 끊기거나 깨지면 저장 불확실로 재조회', () => {
  const saveOk = () => signedIn(KIM, { 'POST /uploads': (q) => ({ status: 201, body: { upload_id: q.get('image') ? 'up-yaml' : 'up-img', sha256: '' } }),
    'POST /floors/f1/map-versions': { status: 201, body: ver('v3', 3) } });
  /** 판 저장 요청만 바꿔 치기 — 나머지는 가짜 서버 그대로 */
  const onSave = (make: (signal: AbortSignal) => Response) => {
    const fetcher = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      const r = await fetcher(url, init);
      return init.method === 'POST' && url.endsWith('/floors/f1/map-versions') ? make(init.signal!) : r;
    });
  };
  const uncertain = async (make: (signal: AbortSignal) => Response) => {
    serve(saveOk()); onSave(make);
    await open('#/map');
    await fillUpload();
    const lists = sent('GET', '/floors/f1/map-versions').length, trees = sent('GET', '/sites').length;
    await click(btn('올리기'));
    expect(alertText()).toContain('저장 응답을 받지 못했습니다. 저장됐을 수 있어 판 목록을 다시 받습니다.');
    expect(alertText()).not.toMatch(/Cannot read|null/);
    expect(sent('GET', '/floors/f1/map-versions').length).toBe(lists + 1);
    expect(sent('GET', '/sites').length).toBe(trees + 1);
    await stopSends();
  };
  it('201 헤더 뒤 본문 단절(스트림 오류)', () => uncertain(() => new Response(new ReadableStream({ start(c) { c.error(new TypeError('stream interrupted')); } }), { status: 201 })));
  it('201 인데 본문이 깨진 JSON', () => uncertain(() => new Response('{"id": "v3", "numb', { status: 201 })));
  it('201 인데 본문이 비었음(판 모양 아님)', () => uncertain(() => new Response(null, { status: 201 })));
  it('api: 헤더 뒤 본문을 받는 중 60 s 마감이면 TIMEOUT(성공 null 아님), 빈 성공 본문은 그대로 null', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => new Response(new ReadableStream({
        start(c) { c.enqueue(new TextEncoder().encode('{"id":')); init.signal!.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError'))); } }), { status: 201 }));
      const { api } = await import('../api');
      const save = api.saveVersion('f1', { base_version_id: null, image: 'u', features: EMPTY, reason: 'r' }).then(() => 'ok', (e) => [e.status, e.code]);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await save).toEqual([0, 'TIMEOUT']);
      vi.stubGlobal('fetch', async () => new Response('', { status: 202 }));
      expect(await api.stop('r-a')).toBeNull();
    } finally { vi.useRealTimers(); }
  });
});

describe('지도 요청 제한시간', () => {
  afterEach(() => { vi.useRealTimers(); });
  it('올리기·판 저장은 60 s, 지도 읽기는 20 s 넘게 답이 없으면 끊고 TIMEOUT', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', (_u: string, init: RequestInit) => new Promise((_ok, no) => init.signal!.addEventListener('abort', () => no(new DOMException('aborted', 'AbortError')))));
    const { api } = await import('../api');
    const up = api.upload(new Blob(['x']), 'image/png').catch((e) => e), save = api.saveVersion('f1', { base_version_id: null, image: 'u', features: EMPTY, reason: 'r' }).catch((e) => e);
    const list = api.versions('f1').catch((e) => e), done: unknown[] = [];
    up.then((e) => done.push(['up', e.code])); list.then((e) => done.push(['list', e.code])); save.then((e) => done.push(['save', e.code]));
    await vi.advanceTimersByTimeAsync(19_999);
    expect(done).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toEqual([['list', 'TIMEOUT']]);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(done).toEqual([['list', 'TIMEOUT'], ['up', 'TIMEOUT'], ['save', 'TIMEOUT']]);
  });
});

describe('관제 지도 칸 — 층 고르기(FL-03)', () => {
  it('층 단추 + 승인 판 그림, 지도 없는 층은 안내, 로봇 점 없음, 로봇을 골라도 층·그림 유지', async () => {
    serve(signedIn(KIM, { 'GET /robots': { status: 200, body: { items: [RA, { ...RA, id: 'r-b', name: 'Go2-B' }], next_cursor: null } }, 'GET /robots/r-b': { status: 200, body: { ...RA, id: 'r-b', name: 'Go2-B' } } }));
    await open('#/fleet');
    const map = card('지도');
    expect([...map.querySelectorAll('[aria-label="층"] button')].map((b) => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([['1층', 'true'], ['2층', 'false']]);
    expect(map.querySelector('svg image')!.getAttribute('href')).toBe('/api/v1/map-versions/v2/image');
    expect(map.querySelector('[data-robot]')).toBeNull();
    await click(btn('2층', map));
    expect(map.textContent).toContain('아직 지도가 없습니다.');
    expect(map.querySelector('svg')).toBeNull();
    await click(btn('1층', map));
    const shown = map.querySelector('svg image'), got = sent('GET', '/map-versions/v2').length;
    await click([...card('로봇 목록').querySelectorAll('button')].find((b) => b.textContent!.includes('Go2-B')));
    expect(card('로봇 상세').textContent).toContain('Go2-B');
    expect(card('지도').querySelector('svg image')).toBe(shown);                            // 다시 그리지 않음(그림 다시 받지 않음)
    expect(sent('GET', '/map-versions/v2')).toHaveLength(got);
  });
  it('층 목록·판 정보 실패, 그림 실패 — 칸 안 글만, 로봇 목록·STOP 은 그대로', async () => {
    serve(signedIn(KIM, { 'GET /map-versions/v2': () => { throw new TypeError('x'); } }));
    await open('#/fleet');
    expect(card('지도').textContent).toContain('지도를 받지 못했습니다. 서버에 연결하지 못했습니다');
    expect(card('로봇 목록').textContent).toContain('Go2-A');
    await stopSends();
  });
  it('로봇 0대 관제에도 층·지도 칸(검토 권고)', async () => {
    serve(signedIn(KIM, { 'GET /robots': { status: 200, body: { items: [], next_cursor: null } } }));
    await open('#/fleet');
    expect([...card('지도').querySelectorAll('[aria-label="층"] button')].map((b) => b.textContent)).toEqual(['1층', '2층']);
    expect(card('지도').querySelector('svg image')!.getAttribute('href')).toBe('/api/v1/map-versions/v2/image');
    expect($('[data-stop]')).toBeTruthy();
  });
  it('층이 없으면 안내', async () => {
    serve(signedIn(LEE, { 'GET /sites': { status: 200, body: { items: [], next_cursor: null } } }));
    await open('#/fleet');
    expect(card('지도').textContent).toContain('등록된 층이 없습니다.');
  });
  it('여러 건물이면 단추에 건물 이름도', async () => {
    const two: SiteTree = { items: [{ ...TREE.items[0], buildings: [TREE.items[0].buildings[0], { id: 'b2', site_id: 's1', name: '신동', floors: [floor('f9', '1층', 1, null, 'b2')] }] }], next_cursor: null };
    serve(signedIn(KIM, { 'GET /sites': { status: 200, body: two } }));
    await open('#/fleet');
    expect([...card('층').querySelectorAll('button')].map((b) => b.textContent)).toEqual(['본동 1층', '본동 2층', '신동 1층']);
  });
});

// ── W4b 지도 편집(01 MP-03·05·06, 02 F-MP-03, 03 §5.6, 05 §5 features) ──
// 화면 100×80 칸을 400×320 으로(4배) 그린다고 치고 지도 좌표(m)로 누른다. origin (-1, -2) → 화면 x = (x + 1)·80, y = (2 - y)·80
const UP = { ...V2, upload_id: 'up-2' };
const editSrv = (more: Record<string, Route> = {}, me = KIM, base: MapVersion = UP) => signedIn(me, { 'GET /floors/f1/map-versions': { status: 200, body: { items: [base, V1], next_cursor: null } }, ...more });
const canvas = () => $<SVGSVGElement>('svg[data-edit]')!;
const startEdit = async () => {
  await open('#/map');
  await click(btn('편집', card('보기·편집')));
  canvas().getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 320, right: 400, bottom: 320, x: 0, y: 0, toJSON() {} }) as DOMRect;
};
const ptr = async (type: string, x: number, y: number, on: Element = canvas()) => {
  act(() => { on.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: (x + 1) * 80, clientY: (2 - y) * 80, button: 0 })); });
  await flush();
};
const tap = async (x: number, y: number, on?: Element) => { await ptr('pointerdown', x, y, on); await ptr('pointerup', x, y, on); };
const tool = (t: string) => click(btn(t, card('편집 도구')));
/** jsdom 은 주소 바꿈(hashchange)을 몇 틱 뒤에 알린다 */
const hashed = () => act(() => new Promise((r) => setTimeout(r, 30)));
const choose = (label: string, from: ParentNode = box) => [...from.querySelectorAll('label')].find((l) => l.textContent!.startsWith(label))!.querySelector('select') as HTMLSelectElement;
const save = async (reason = '구역 추가') => { await setVal(field('바꾼 이유', card('새 판으로 저장')), reason); await click(btn('새 판으로 저장')); };
const body = () => sent('POST', '/floors/f1/map-versions').slice(-1)[0].body as { base_version_id: string; image: string; features: typeof FEAT; reason: string };
const near = (pts: number[][]) => pts.map((p) => p.map((v) => Math.round(v * 1000) / 1000));
const saved201 = { 'POST /floors/f1/map-versions': { status: 201, body: ver('v3', 3, { base_version_id: 'v2', source: 'EDIT' as const }) } };

describe('지도 편집 — 좌표·미리 검사(서버 validate_features 와 같은 규칙)', () => {
  const g = { origin: [-1, -2, 0] as [number, number, number], resolution: 0.05, width: 100, height: 80 };
  it('toMap 은 toPixel 의 역(y 뒤집힘·origin 방향 포함), 범위는 그림 안·경계 포함', async () => {
    const { toMap, inside } = await import('../screens/mapedit');
    for (const o of [g, { ...g, origin: [0.5, -1, 0.7] as [number, number, number] }]) for (const [x, y] of [[0, 0], [1.2, -0.3], [-0.5, 1.5]]) {
      const [px, py] = toPixel(o, x, y), [mx, my] = toMap(o, px, py);
      expect(mx).toBeCloseTo(x); expect(my).toBeCloseTo(y);
    }
    expect(toMap(g, 0, 80)).toEqual([-1, -2]);                    // 그림 왼쪽 아래 = origin
    expect(inside(g, -1, -2)).toBe(true); expect(inside(g, 4, 2)).toBe(true);
    expect(inside(g, 4.01, 0)).toBe(false); expect(inside(g, 0, -2.01)).toBe(false); expect(inside(g, NaN, 0)).toBe(false);
  });
  it('구역 3점 이상·중복 점·넓이 0·변 교차·범위 밖, 이름 빈칸·Cc/Cf, 선 굵기·서로 다른 2점, 연결점 짝 층, 꼭짓점 4096', async () => {
    const { check } = await import('../screens/mapedit');
    const E = { zones: [], waypoints: [], connectors: [], edits: [] };
    const z = (polygon: number[][], name = '공사') => ({ ...E, zones: [{ id: 'z', type: 'NO_GO' as const, name, polygon: polygon as [number, number][] }] });
    expect(check(z([[0, 0], [1, 0], [1, 1]]), g)).toBeNull();
    expect(check(z([[0, 0], [1, 0]]), g)?.text).toContain('3개 이상');
    expect(check(z([[0, 0], [1, 0], [0, 0]]), g)?.text).toContain('두 번 찍혔습니다');
    expect(check(z([[0, 0], [1, 0], [2, 0]]), g)?.text).toContain('넓이가 0');
    expect(check(z([[0, 0], [2, 2], [2, 0], [0, 1]]), g)).toEqual({ path: 'features.zones.0.polygon', text: expect.stringContaining('엇갈립니다') });
    expect(check(z([[0, 0], [9, 0], [0, 1]]), g)).toEqual({ path: 'features.zones.0.polygon.1', text: expect.stringContaining('범위 밖') });
    expect(check(z([[0, 0], [1, 0], [1, 1]], ' '), g)?.text).toBe('이름을 입력하세요.');
    expect(check(z([[0, 0], [1, 0], [1, 1]], '공사​'), g)?.text).toContain('보이지 않는 글자');
    expect(check({ ...E, waypoints: [{ id: 'w', name: '줄\n바꿈', x: 0, y: 0, yaw: 0 }] }, g)?.path).toBe('features.waypoints.0.name');
    expect(check({ ...E, waypoints: [{ id: 'w', name: 'A', x: 0, y: 0, yaw: NaN }] }, g)?.path).toBe('features.waypoints.0.yaw');
    const line = (polyline: number[][], width = 0.1) => ({ ...E, edits: [{ op: 'WALL' as const, polyline: polyline as [number, number][], width }] });
    expect(check(line([[0, 0], [1, 0]]), g)).toBeNull();
    expect(check(line([[0, 0], [0, 0]]), g)?.text).toContain('2개 이상');
    expect(check(line([[0, 0], [1, 0]], 0), g)?.path).toBe('features.edits.0.width');
    expect(check(line([[0, 0], [1, 0]], 101), g)?.path).toBe('features.edits.0.width');
    const two = (a?: string, b?: string) => ({ ...E, edits: [{ id: a, op: 'WALL' as const, polyline: [[0, 0], [1, 0]] as [number, number][], width: 0.1 }, { id: b, op: 'ERASE' as const, polyline: [[0, 1], [1, 1]] as [number, number][], width: 0.1 }] });
    expect(check(two('e1', 'e1'), g)?.path).toBe('features.edits.1.id');   // S3b: 선 id 도 무리 안에서 하나
    expect(check(two(), g)).toBeNull();   // id 없는 옛 선끼리는 중복 아님
    const c = { ...E, connectors: [{ id: 'c', kind: 'STAIRS' as const, pair_floor_id: 'f9', x: 0, y: 0, yaw: 0 }] };
    expect(check(c, g, ['f2'])?.path).toBe('features.connectors.0.pair_floor_id');
    expect(check(c, g, ['f9'])).toBeNull();
    expect(check({ ...E, waypoints: [{ id: 'w', name: 'A', x: 0, y: 0, yaw: 0 }, { id: 'w', name: 'B', x: 1, y: 0, yaw: 0 }] }, g)?.path).toBe('features.waypoints.1.id');
    const many = { ...E, waypoints: Array.from({ length: 1000 }, (_, i) => ({ id: `w${i}`, name: 'A', x: 0, y: 0, yaw: 0 })),
      edits: Array.from({ length: 13 }, () => ({ op: 'ERASE' as const, polyline: Array.from({ length: 256 }, (_, k) => [k / 100, 0]) as [number, number][], width: 0.1 })) };
    expect(check(many, g)).toEqual({ path: 'features', text: expect.stringContaining('4096') });   // 1000 + 13·256 = 4328
  });
});

describe('지도 편집 — 보기/편집 토글·권한', () => {
  it('총괄 + 승인 판 = 보기/편집 토글. 편집 중엔 판 고르기·올리기 숨김, 보기로 돌아가면(바꾼 것 없음) 바로', async () => {
    serve(editSrv());
    await startEdit();
    expect(btn('편집', card('보기·편집'))!.getAttribute('aria-pressed')).toBe('true');
    expect(card('지도 보기').querySelector('h2')!.textContent).toBe('본관 본동 1층 · 판 2 편집 중');
    expect($('[aria-label="판"]')).toBeNull(); expect($('[aria-label="새 지도 올리기"]')).toBeNull();
    expect([...card('편집 도구').querySelectorAll('button')].map((b) => b.textContent)).toEqual(['고르기', '진입 금지', '감속', '지점', '연결점', '지우개', '벽']);
    expect(canvas().querySelectorAll('[data-zone], [data-waypoint], [data-connector], [data-edit]')).toHaveLength(4);   // 지금 판 요소 그대로(벽 선 포함)
    await click(btn('보기', card('보기·편집')));
    expect(canvas()).toBeNull(); expect($('[aria-label="새 지도 올리기"]')).toBeTruthy();
  });
  it('운영 관리자: 편집 단추·자리 표시 없음(S4 결재 전) / 총괄도 승인 판 없는 층은 토글 없음', async () => {
    serve(editSrv({}, LEE));
    await open('#/map');
    expect(card('지도 보기').querySelector('svg')).toBeTruthy();
    expect(btn('편집')).toBeUndefined(); expect($('[aria-label="보기·편집"]')).toBeNull();
    expect(card('지도 보기').querySelector('[aria-describedby="fh-soon"]')).toBeNull();
    act(() => root?.unmount()); box.remove();
    serve(editSrv());
    await open('#/map');
    await click(floorBtn('2층'));
    expect($('[aria-label="보기·편집"]')).toBeNull();
  });
  it('판 응답에 upload_id 가 없으면(S3b 전 서버) 저장 막고 쉬운 문구 — 다시 올리기 우회 없음', async () => {
    serve(editSrv({}, KIM, { ...V2, upload_id: undefined as unknown as string }));   // 계약상 필수지만 S3b 전 서버·어긋난 응답 대비 막음은 남김
    await startEdit();
    expect(alertText()).toContain('이 판은 아직 편집 저장을 지원하지 않습니다.');
    expect(btn('새 판으로 저장')!.disabled).toBe(true);
    await tool('지점'); await tap(1, 1);
    act(() => { (card('새 판으로 저장') as HTMLFormElement).requestSubmit(); }); await flush();
    expect(writes()).toEqual([]);
  });
});

describe('지도 편집 — 도구', () => {
  it('진입 금지 구역: 점 찍기·되돌리기·지우기·범위 밖 막음·교차 막음 → 닫기 → 저장 요청 모양(base·image=upload_id·reason)', async () => {
    serve(editSrv(saved201));
    await startEdit();
    await tool('진입 금지');
    await tap(1, 1); await tap(2, 1);
    await tap(5, 0);                                                  // 지도 범위 밖(x 는 4 m 까지)
    expect(alertText()).toContain('지도 범위 밖은 찍을 수 없습니다.');
    expect($('[data-drawing]')!.querySelectorAll('circle')).toHaveLength(2);
    await tap(2, 0); await tap(3, 1.5);
    await click(btn('되돌리기', card('그리기')));
    expect($('[data-drawing]')!.querySelectorAll('circle')).toHaveLength(3);
    await click(btn('닫기', card('그리기')));
    expect($('[data-drawing]')).toBeNull();
    expect(canvas().querySelectorAll('[data-zone="NO_GO"]')).toHaveLength(2);
    expect(field('이름', card('고른 요소')).value).toBe('진입 금지 2');          // 새 구역이 골라짐
    await tool('감속');                                                 // 엇갈린 사각형은 닫지 않음(점 그대로)
    await tap(0, 0); await tap(2, 2); await tap(2, 0); await tap(0, 1);
    await click(btn('닫기', card('그리기')));
    expect(alertText()).toContain('구역의 변이 서로 엇갈립니다.');
    expect($('[data-drawing]')!.querySelectorAll('circle')).toHaveLength(4);
    await click(btn('지우기', card('그리기')));
    expect($('[data-drawing]')).toBeNull();
    await save('공사 구역 추가');
    expect(writes()).toEqual(['POST /floors/f1/map-versions']);
    const b = body();
    expect([b.base_version_id, b.image, b.reason]).toEqual(['v2', 'up-2', '공사 구역 추가']);
    expect(b.features.zones).toHaveLength(2);
    expect(b.features.zones[0]).toEqual(FEAT.zones[0]);
    expect({ ...b.features.zones[1], id: '' }).toEqual({ id: '', type: 'NO_GO', name: '진입 금지 2', polygon: expect.anything() });
    expect(near(b.features.zones[1].polygon)).toEqual([[1, 1], [2, 1], [2, 0]]);
    expect(b.features.waypoints).toEqual(FEAT.waypoints); expect(b.features.connectors).toEqual(FEAT.connectors); expect(b.features.edits).toEqual(FEAT.edits);
    expect(canvas()).toBeNull();                                        // 저장되면 보기로
    expect(card('지도 보기').textContent).toContain('새 판을 저장했습니다(판 3). 다음 실행부터 이 판을 씁니다.');
  });
  it('지점: 놓고 이름·방향(도 → 라디안) / 지우개·벽: 굵기, 서로 다른 2점 이상', async () => {
    serve(editSrv(saved201));
    await startEdit();
    await tool('지점'); await tap(1, 1);
    await setVal(field('이름', card('고른 요소')), '충전소');
    await setVal(field('방향', card('고른 요소')), '90');
    await tool('벽');
    await setVal(field('굵기', card('그리기')), '0.2');
    await tap(0, 1); await tap(0, 1);
    await click(btn('끝내기', card('그리기')));
    expect(alertText()).toContain('서로 다른 점이 2개 이상');
    await tap(1.5, 1);
    await click(btn('끝내기', card('그리기')));
    await tool('지우개'); await tap(-0.5, -1); await tap(0.5, -1);
    await click(btn('끝내기', card('그리기')));
    expect(canvas().querySelectorAll('[data-edit]')).toHaveLength(3);
    await save();
    const b = body();
    expect(b.features.waypoints).toHaveLength(2);
    expect({ ...b.features.waypoints[1], id: '', x: 0, y: 0 }).toEqual({ id: '', name: '충전소', x: 0, y: 0, yaw: Math.PI / 2 });
    expect(near([[b.features.waypoints[1].x, b.features.waypoints[1].y]])).toEqual([[1, 1]]);
    expect(b.features.edits.slice(1).map((e) => [e.op, e.width, near(e.polyline)])).toEqual([['WALL', 0.2, [[0, 1], [0, 1], [1.5, 1]]], ['ERASE', 0.2, [[-0.5, -1], [0.5, -1]]]]);   // 굵기는 도구 사이에 그대로
    const es = b.features.edits as { id?: string | null }[]; expect(es[0].id).toBeUndefined();   // 원래 있던 id 없는 선은 그대로(비교 열쇠 유지)
    const ids = es.slice(1).map((e) => e.id); expect(ids.every((x) => typeof x === 'string' && x.length > 0) && new Set(ids).size === 2).toBe(true);   // 새 선은 id 를 붙여 S3b 비교가 같은 선으로 따라감
  });
  it('연결점: 같은 건물 다른 층만 짝 층, 짝 층 승인 판의 «이 층 짝» 연결점을 고르면 같은 id·종류', async () => {
    const tree: SiteTree = { items: [{ id: 's1', name: '본관', buildings: [
      { id: 'b1', site_id: 's1', name: '본동', floors: [floor('f1', '1층', 1, 'v2'), floor('f2', '2층', 2, 'v9'), floor('f3', '3층', 3, null)] },
      { id: 'b2', site_id: 's1', name: '별동', floors: [floor('f8', '별동 1층', 1, null, 'b2')] }] }], next_cursor: null };
    const V9 = ver('v9', 1, { floor_id: 'f2', features: { ...EMPTY, connectors: [{ id: 'c-up', kind: 'ELEVATOR', pair_floor_id: 'f1', x: 1, y: 1, yaw: 0 }, { id: 'c-x', kind: 'STAIRS', pair_floor_id: 'f3', x: 0, y: 0, yaw: 0 }] } });
    serve(editSrv({ 'GET /sites': { status: 200, body: tree }, 'GET /map-versions/v9': { status: 200, body: V9 }, ...saved201 }));
    await startEdit();
    await tool('연결점'); await tap(2, 1);
    expect([...choose('짝 층', card('고른 요소')).options].map((o) => o.textContent)).toEqual(['2층', '3층']);   // 다른 건물·이 층 없음
    const pair = choose('짝 연결점', card('고른 요소'));
    expect([...pair.options].map((o) => o.textContent)).toEqual(['새 연결점(짝 층에도 같은 짝을 놓아야 이어짐)', '짝 층의 엘리베이터 연결점 (1.0, 1.0)']);
    await setVal(pair, 'c-up');
    await save();
    const c = body().features.connectors[1];
    expect([c.id, c.kind, c.pair_floor_id]).toEqual(['c-up', 'ELEVATOR', 'f2']);
  });
  it('연결점: 같은 건물에 다른 층이 없으면 놓지 않고 이유', async () => {
    const tree: SiteTree = { items: [{ id: 's1', name: '본관', buildings: [{ id: 'b1', site_id: 's1', name: '본동', floors: [floor('f1', '1층', 1, 'v2')] }] }], next_cursor: null };
    serve(editSrv({ 'GET /sites': { status: 200, body: tree } }));
    await startEdit();
    await tool('연결점'); await tap(2, 1);
    expect(box.textContent).toContain('같은 건물에 다른 층이 없어 연결점을 놓을 수 없습니다.');
    expect(canvas().querySelectorAll('[data-connector]')).toHaveLength(1);
  });
  it('고르기: 요소를 눌러 고르고 끌어 옮김(범위 밖으로는 안 감), 고른 요소 지우기', async () => {
    serve(editSrv(saved201));
    await startEdit();
    const wp = () => canvas().querySelector('[data-waypoint] circle')!;
    await ptr('pointerdown', 1.5, 0, wp());
    expect(field('이름', card('고른 요소')).value).toBe('계기판 A');
    await ptr('pointermove', 2, 0.5); await ptr('pointermove', 9, 0.5);     // 두 번째는 지도 밖 — 마지막 자리에 둠
    await ptr('pointerup', 9, 0.5);
    await ptr('pointerdown', 0, 0, canvas().querySelector('[data-connector]')!);
    await click(btn('이 요소 지우기', card('고른 요소')));
    expect(canvas().querySelectorAll('[data-connector]')).toHaveLength(0);
    await ptr('pointerdown', -0.8, -1.9, canvas().querySelector('[data-zone]')!);   // 구역 통째로 옮김
    await ptr('pointermove', -0.3, -1.4); await ptr('pointerup', -0.3, -1.4);
    await save();
    const b = body();
    expect(near([[b.features.waypoints[0].x, b.features.waypoints[0].y]])).toEqual([[2, 0.5]]);
    expect(b.features.connectors).toEqual([]);
    expect(near(b.features.zones[0].polygon)).toEqual([[-0.5, -1.5], [0.5, -1.5], [0.5, -0.5]]);
  });
});

describe('지도 편집 — 저장', () => {
  it('미리 검사에 걸리면 보내지 않고 그 요소를 표시, 바꾼 것 없음·이유 빈칸도 막음', async () => {
    serve(editSrv(saved201));
    await startEdit();
    await save();
    expect(alertText()).toContain('바꾼 것이 없습니다.');
    await ptr('pointerdown', -0.8, -1.9, canvas().querySelector('[data-zone]')!);
    await setVal(field('이름', card('고른 요소')), '공사\u0007');
    await save();
    expect($('[data-bad]')!.textContent).toBe('진입 금지 구역 «공사\u0007»: 이름에 줄바꿈·탭 같은 보이지 않는 글자는 쓸 수 없습니다.');
    expect((canvas().querySelector('[data-zone]') as SVGElement).style.strokeDasharray).toBe('6 4');
    await setVal(field('이름', card('고른 요소')), '공사 구역');
    await save('  ');
    expect(alertText()).toContain('바꾼 이유를 입력하세요.');
    expect(writes()).toEqual([]);
  });
  it('서버 422 INVALID_FEATURES — detail.element 요소를 고르고 쉬운 말, pydantic 모양(elements)도', async () => {
    const replies = [
      { status: 422, body: { error: { code: 'INVALID_FEATURES', message: '다각형 변이 서로 교차합니다.', detail: { element: 'features.zones.0.polygon' } } } },
      { status: 422, body: { error: { code: 'INVALID_FEATURES', message: '지도 요소 형식을 확인하세요.', detail: { elements: ['features.waypoints.1.name'] } } } },
      { status: 422, body: { error: { code: 'INVALID_FEATURES', message: '같은 건물의 다른 층을 선택하세요.', detail: { element: 'features.connectors.0.pair_floor_id' } } } }];
    serve(editSrv({ 'POST /floors/f1/map-versions': () => replies.shift()! }));
    await startEdit();
    await tool('지점'); await tap(1, 1);
    await save();
    expect($('[data-bad]')!.textContent).toBe('진입 금지 구역 «공사»: 다각형 변이 서로 교차합니다. 고친 뒤 다시 저장하세요.');
    expect(field('이름', card('고른 요소')).value).toBe('공사');
    await save();
    expect($('[data-bad]')!.textContent).toBe('지점 «지점 2»: 저장할 수 있는 모양이 아닙니다. 이름·점 개수·굵기를 확인하세요.');
    await save();
    expect($('[data-bad]')!.textContent).toBe('계단 연결점: 짝 층을 같은 건물의 다른 층으로 다시 고르세요.');
    expect(canvas().querySelectorAll('[data-waypoint]')).toHaveLength(2);       // 편집 내용 그대로
  });
  it('409 STALE: 편집 내용 유지 + «다른 사람이 먼저 바꿨습니다», 새로 불러오기는 잃는다는 확인 뒤에만', async () => {
    serve(editSrv({ 'POST /floors/f1/map-versions': { status: 409, body: { error: { code: 'STALE', message: '승인된 지도 판이 바뀌었습니다.', detail: { approved_version_id: 'v5' } } } } }));
    await startEdit();
    await tool('지점'); await tap(1, 1);
    await save();
    expect(alertText()).toContain('다른 사람이 먼저 이 층의 지도를 바꿨습니다. 편집 내용은 그대로 있습니다.');
    expect(canvas().querySelectorAll('[data-waypoint]')).toHaveLength(2);
    expect(field('바꾼 이유', card('새 판으로 저장')).value).toBe('구역 추가');
    const lists = sent('GET', '/floors/f1/map-versions').length, trees = sent('GET', '/sites').length;
    const seen = vi.fn(); Element.prototype.scrollIntoView = seen;   // jsdom 에는 없음
    await click(btn('새로 불러오기'));
    expect(card('확인').textContent).toContain('새로 불러오면 지금 편집 내용을 잃습니다.');
    expect(seen.mock.contexts).toContain(card('확인'));   // 확인 줄은 편집 칸 위쪽 — 아래 단추로 띄워도 화면에 들어오게
    await click(btn('계속 편집', card('확인')));
    expect(canvas()).toBeTruthy(); expect(sent('GET', '/sites').length).toBe(trees);
    await click(btn('새로 불러오기'));
    await click(btn('새로 불러오기', card('확인')));
    expect(canvas()).toBeNull();
    expect(sent('GET', '/floors/f1/map-versions').length).toBe(lists + 1); expect(sent('GET', '/sites').length).toBe(trees + 1);
    delete (Element.prototype as Partial<Element>).scrollIntoView;
    await stopSends();
  });
  const uncertainEdit = async (make: () => Response | Promise<Response>) => {
    serve(editSrv());
    const fetcher = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => (init.method === 'POST' && url.endsWith('/floors/f1/map-versions') ? (await fetcher(url, init), make()) : fetcher(url, init)));
    await startEdit();
    await tool('지점'); await tap(1, 1);
    const lists = sent('GET', '/floors/f1/map-versions').length, trees = sent('GET', '/sites').length;
    await save();
    expect(alertText()).toContain('저장 응답을 받지 못했습니다. 저장됐을 수 있어 판 목록을 다시 받습니다. 새 판이 보이면 다시 저장하지 마세요.');
    expect(sent('GET', '/floors/f1/map-versions').length).toBe(lists + 1); expect(sent('GET', '/sites').length).toBe(trees + 1);
    expect(canvas().querySelectorAll('[data-waypoint]')).toHaveLength(2);       // 편집 내용은 그대로
    await stopSends();
  };
  it('저장 중 끊김 → 저장 불확실 재조회, 편집 유지', () => uncertainEdit(() => { throw new TypeError('Failed to fetch'); }));
  it('201 본문 끊김 → 저장 불확실 재조회, 편집 유지', () => uncertainEdit(() => new Response(new ReadableStream({ start(c) { c.error(new TypeError('stream interrupted')); } }), { status: 201 })));
  it('503 SERVER_BUSY·403 은 쉬운 문구/서버 문구', async () => {
    const replies = [err(503, 'SERVER_BUSY', '지도 파일 처리 중입니다.'), err(403, 'APPROVAL_REQUIRED', '운영 관리자 지도 저장은 결재 기능이 열린 뒤 사용할 수 있습니다.')];
    serve(editSrv({ 'POST /floors/f1/map-versions': () => replies.shift()! }));
    await startEdit();
    await tool('지점'); await tap(1, 1);
    await save();
    expect(alertText()).toContain('서버가 지금 다른 지도를 처리하고 있습니다. 잠시 뒤 다시 저장하세요.');
    await save();
    expect(alertText()).toContain('운영 관리자 지도 저장은 결재 기능이 열린 뒤 사용할 수 있습니다.');
  });
});

describe('지도 편집 — 나가기 확인·STOP', () => {
  it('저장 안 한 편집: 다른 탭·층 바꾸기·보기 전환은 칸 안 확인, 새로고침은 브라우저 확인', async () => {
    serve(editSrv());
    await startEdit();
    const unload = () => { const e = new Event('beforeunload', { cancelable: true }); dispatchEvent(e); return e.defaultPrevented; };
    expect(unload()).toBe(false);                                       // 바꾼 것 없으면 묻지 않음
    await tool('지점'); await tap(1, 1);
    expect(unload()).toBe(true);
    await click($('nav a[href="#/fleet"]'));
    await hashed();
    expect(location.hash).toBe('#/map');
    expect(card('확인').textContent).toContain('저장하지 않은 편집이 있습니다. 나가면 편집 내용을 잃습니다.');
    await click(btn('계속 편집', card('확인')));
    expect(canvas().querySelectorAll('[data-waypoint]')).toHaveLength(2);
    await click(floorBtn('2층'));
    expect(floorBtn('1층').getAttribute('aria-pressed')).toBe('true');
    await click(btn('계속 편집', card('확인')));
    await click(btn('보기', card('보기·편집')));
    expect(card('확인')).toBeTruthy();
    await click(btn('계속 편집', card('확인')));
    act(() => { location.hash = '#/history'; }); await hashed();      // 주소 바꿈(뒤로 가기 등)도
    expect(location.hash).toBe('#/map'); expect($('main')!.getAttribute('aria-label')).toBe('지도');
    await click(btn('나가기', card('확인'))); await hashed();
    expect($('main')!.getAttribute('aria-label')).toBe('기록');
    expect(unload()).toBe(false);
  });
  it('그리던 점만 있어도 묻는다, 층 바꾸기 확인에서 나가기 → 그 층으로', async () => {
    serve(editSrv());
    await startEdit();
    await tool('진입 금지'); await tap(1, 1);
    await click(floorBtn('2층'));
    await click(btn('나가기', card('확인')));
    expect(floorBtn('2층').getAttribute('aria-pressed')).toBe('true');
    expect(canvas()).toBeNull();
  });
  it('STOP: 편집 중·확인창이 떠 있을 때 늘 보이고 실제로 정지 요청', async () => {
    serve(editSrv());
    await startEdit();
    await click($('nav a[href="#/fleet"]')); await hashed();         // 바꾼 것 없으면 바로 떠남 — 다시 들어옴
    expect($('main')!.getAttribute('aria-label')).toBe('관제');
    await click($('nav a[href="#/map"]')); await hashed();
    await click(btn('편집', card('보기·편집')));
    canvas().getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 320, right: 400, bottom: 320, x: 0, y: 0, toJSON() {} }) as DOMRect;
    await tool('지점'); await tap(1, 1);
    await click(floorBtn('2층'));
    expect(card('확인')).toBeTruthy();
    await stopSends();
    expect(canvas()).toBeTruthy();                                     // STOP 이 편집을 건드리지 않음
  });
  it('STOP: 저장 중(답 대기)에도 보이고 실제로 정지 요청', async () => {
    serve(editSrv({ 'POST /floors/f1/map-versions': () => new Promise<Reply>(() => {}) }));
    await startEdit();
    await tool('지점'); await tap(1, 1);
    await save();
    expect(box.textContent).toContain('새 판으로 저장하는 중…');
    expect(btn('새 판으로 저장')!.disabled).toBe(true);
    await stopSends();
  });
});

describe('지도 편집 — PR #30 검토(B1~B4)', () => {
  const unload = () => { const e = new Event('beforeunload', { cancelable: true }); dispatchEvent(e); return e.defaultPrevented; };
  const dots = () => canvas().querySelectorAll('[data-drawing] circle').length;
  const pressed = (t: string) => btn(t, card('편집 도구'))!.getAttribute('aria-pressed');
  it('B1 저장 중: 고른 요소·이유·굵기·도구 입력이 모두 막혀 바꿔도 그대로, STOP 은 실제로 정지 요청, 201 뒤 새 판', async () => {
    let done!: (r: Reply) => void;
    serve(editSrv({ 'POST /floors/f1/map-versions': () => new Promise<Reply>((r) => { done = r; }) }));
    await startEdit();
    await tool('지점'); await tap(1, 1);
    await save('지점 추가');
    expect(box.textContent).toContain('새 판으로 저장하는 중…');
    const name = field('이름', card('고른 요소')), why = field('바꾼 이유', card('새 판으로 저장'));
    for (const el of [name, why, ...btns(card('편집 도구')), btn('이 요소 지우기')!]) expect(el.matches(':disabled')).toBe(true);
    await setVal(name, '바뀐이름'); await setVal(why, '바뀐이유');
    expect(name.value).toBe('지점 2'); expect(why.value).toBe('지점 추가');
    await tap(2, 1);
    expect(canvas().querySelectorAll('[data-waypoint]')).toHaveLength(2);
    await stopSends();
    act(() => done(saved201['POST /floors/f1/map-versions'])); await flush();
    expect(body().features.waypoints.map((w) => w.name)).toEqual(['계기판 A', '지점 2']);
    expect(box.textContent).toContain('새 판을 저장했습니다(판 3)');
  });
  it('B2 편집 중 «+ 층»: 만든 뒤 지금 층·편집 그대로(새 층은 목록에), 나가기 확인도 그대로', async () => {
    let made = false;
    const T3: SiteTree = { ...TREE, items: [{ ...TREE.items[0], buildings: [{ ...TREE.items[0].buildings[0], floors: [...TREE.items[0].buildings[0].floors, floor('f3', '3층', 3, null)] }] }] };
    serve(editSrv({ 'POST /buildings/b1/floors': () => { made = true; return { status: 201, body: floor('f3', '3층', 3, null) }; },
      'GET /sites': () => ({ status: 200, body: made ? T3 : TREE }), 'GET /floors/f3/map-versions': { status: 200, body: { items: [], next_cursor: null } } }));
    await startEdit();
    await tool('지점'); await tap(1, 1);
    await click(btn('고치기')); await click(btn('+ 층'));
    const f = card('본관 본동 에 새 층');
    await setVal(field('이름', f), '3층'); await setVal(field('층 번호', f), '3');
    await click(btn('저장', f));
    expect(writes()).toEqual(['POST /buildings/b1/floors']);
    expect(floorBtn('3층')).toBeTruthy();
    expect(floorBtn('1층').getAttribute('aria-pressed')).toBe('true');
    expect(canvas().querySelectorAll('[data-waypoint]')).toHaveLength(2);
    await click(floorBtn('3층'));
    expect(card('확인').textContent).toContain('저장하지 않은 편집이 있습니다.');
  });
  it('B3 폰 틀로 바뀌어 지도 탭이 내려가도 층·기준 판·요소·그리던 점·도구·이유를 남겨 PC 로 돌아오면 이어 씀, 그동안 새로고침은 묻는다', async () => {
    serve(editSrv());
    await startEdit();
    await tool('지점'); await tap(1, 1);
    await setVal(field('바꾼 이유', card('새 판으로 저장')), '지점 추가');
    await tool('벽'); await tap(0, 0);
    await frame(true); await hashed();
    expect($('svg[data-edit]')).toBeNull(); expect($('[data-layout="phone"]')).toBeTruthy();
    expect(unload()).toBe(true);
    await frame(false); await hashed();
    expect($('main')!.getAttribute('aria-label')).toBe('지도');
    expect(card('지도 보기').querySelector('h2')!.textContent).toBe('본관 본동 1층 · 판 2 편집 중');
    expect(canvas().querySelectorAll('[data-waypoint]')).toHaveLength(2);
    expect(dots()).toBe(1); expect(pressed('벽')).toBe('true');
    expect(field('바꾼 이유', card('새 판으로 저장')).value).toBe('지점 추가');
    expect(alertText()).not.toContain('다른 사람이 먼저');
    await click($('nav a[href="#/fleet"]')); await hashed();
    expect(card('확인').textContent).toContain('저장하지 않은 편집이 있습니다.');
    await click(btn('나가기', card('확인'))); await hashed();
    expect($('main')!.getAttribute('aria-label')).toBe('관제');
    expect(unload()).toBe(false);                                        // 나가기로 버린 편집은 남기지 않음
  });
  it('B3 남긴 편집은 로그아웃하면 버림(다음 사람에게 넘기지 않음)', async () => {
    serve(editSrv({ 'POST /auth/logout': { status: 204 } }));
    await startEdit();
    await tool('지점'); await tap(1, 1);
    await frame(true); await hashed();
    expect(unload()).toBe(true);
    act(() => { location.hash = '#/history'; }); await hashed();        // 폰 로그아웃은 기록 탭 «더 보기»
    await click(btn('로그아웃'));
    expect(kept.d).toBeNull(); expect(unload()).toBe(false);
  });
  it('B3 돌아왔는데 그 사이 승인 판이 바뀜 → STALE 과 같은 안내, 편집은 그대로', async () => {
    let ap = 'v2';
    const V3 = ver('v3', 3, { base_version_id: 'v2', source: 'EDIT' });
    const tree = (): SiteTree => ({ ...TREE, items: [{ ...TREE.items[0], buildings: [{ ...TREE.items[0].buildings[0], floors: [floor('f1', '1층', 1, ap), floor('f2', '2층', 2, null)] }] }] });
    serve(editSrv({ 'GET /sites': () => ({ status: 200, body: tree() }), 'GET /map-versions/v3': { status: 200, body: V3 },
      'GET /floors/f1/map-versions': () => ({ status: 200, body: { items: ap === 'v3' ? [V3, UP, V1] : [UP, V1], next_cursor: null } }) }));
    await startEdit();
    await tool('지점'); await tap(1, 1);
    await frame(true); await hashed();
    ap = 'v3';
    await frame(false); await hashed();
    expect(card('지도 보기').querySelector('h2')!.textContent).toBe('본관 본동 1층 · 판 2 편집 중');
    expect(alertText()).toContain('다른 사람이 먼저 이 층의 지도를 바꿨습니다. 편집 내용은 그대로 있습니다.');
    expect(canvas().querySelectorAll('[data-waypoint]')).toHaveLength(2);
    expect(btn('새로 불러오기')).toBeTruthy();
  });
  it('B4 도구: 같은 도구 다시 = 그대로, 구역↔구역·선↔선은 점 이어 씀, 다른 갈래는 확인 뒤에만 지우고 나가기 확인은 남음', async () => {
    serve(editSrv());
    await startEdit();
    await tool('지점'); await tap(1, 1);
    await tool('진입 금지'); await tap(1, 1); await tap(2, 1);
    await tool('진입 금지'); expect(dots()).toBe(2);
    await tool('감속'); expect(dots()).toBe(2); expect(pressed('감속')).toBe('true');
    await tool('벽');
    expect(card('확인').textContent).toContain('그리던 점 2개를 지우고 도구를 바꿀까요?');
    await click(btn('계속 편집', card('확인')));
    expect(dots()).toBe(2); expect(pressed('감속')).toBe('true');
    await tool('지우개'); await click(btn('바꾸기', card('확인')));
    expect($('[data-drawing]')).toBeNull(); expect(pressed('지우개')).toBe('true');
    await tap(0, 0); await tap(1, 0);
    await tool('벽'); expect(dots()).toBe(2); expect(pressed('벽')).toBe('true');
    await click(btn('끝내기'));
    expect(canvas().querySelectorAll('[data-edit]')).toHaveLength(2);                 // 지금 판 벽 1 + 그린 벽 1
    await click($('nav a[href="#/fleet"]')); await hashed();
    expect(card('확인').textContent).toContain('저장하지 않은 편집이 있습니다.');   // 도구 바꾸기 확인이 나가기 확인을 지우지 않음
  });
});

describe('지도 편집 — 서버와 같은 경계 사례 표(mapcases.json — 서버 쪽은 계약 MapFeatures + validate_features 로 같은 표 확인)', () => {
  type Case = { name: string; ok: boolean; client?: boolean; f?: Partial<MapFeatures>; gen?: { circle?: number; zones?: number; edits?: [number, number]; waypoints?: number } };
  const T = JSON.parse(raw) as { map: { width: number; height: number; resolution: number; origin: [number, number, number]; pairs: string[] }; cases: Case[] };
  /** 파이썬 쪽 gen 과 같은 모양 */
  const gen = (g: NonNullable<Case['gen']>): Partial<MapFeatures> => ({
    zones: [...(g.circle ? [{ id: 'z', type: 'NO_GO' as const, name: '원', polygon: Array.from({ length: g.circle }, (_, k) => [1.5 + 1.5 * Math.cos((2 * Math.PI * k) / g.circle!), 1.5 * Math.sin((2 * Math.PI * k) / g.circle!)] as [number, number]) }] : []),
      ...Array.from({ length: g.zones ?? 0 }, (_, i) => ({ id: `z${i}`, type: 'SLOW' as const, name: '세모', polygon: [[0, 0], [1, 0], [0, 1]] as [number, number][] }))],
    edits: g.edits ? Array.from({ length: g.edits[0] }, (_, i) => ({ op: 'WALL' as const, polyline: Array.from({ length: g.edits![1] }, (_, k) => [k * 0.01, i * 0.1 - 1.9] as [number, number]), width: 0.1 })) : [],
    waypoints: Array.from({ length: g.waypoints ?? 0 }, (_, i) => ({ id: `w${i}`, name: '지점', x: 0, y: 0, yaw: 0 })),
  });
  it.each(T.cases.map((c) => [c.name, c] as const))('%s', async (_, c) => {
    const { check } = await import('../screens/mapedit');
    const f: MapFeatures = { zones: [], waypoints: [], connectors: [], edits: [], ...(c.gen ? gen(c.gen) : c.f) };
    expect(check(f, T.map, T.map.pairs) === null).toBe(c.client ?? c.ok);
  });
});
