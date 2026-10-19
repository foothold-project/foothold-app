// W2 로봇 화면(05 §3·§4·§9) — 관제 요약(GET /dashboard)·상세(GET /robots/{id})·설정 › 로봇(등록·바꾸기·지우기·토큰)·subscription.revoked.
// fetch 는 가짜 서버, WebSocket 은 FakeWS. 401·403·404·409·503·네트워크 실패, 두 revoke 이유, 모르는 t, null 표시, STOP 상시 표시를 본다.
import { act } from 'react';
import { createRoot, type Root as ReactRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Dashboard, RobotSummary, User } from '../../../contracts/ts';
import { now, rt } from '../rt';
import { Root } from '../session';
import { ROBOT_BUSY, ROBOT_GONE, ROBOT_IN_USE } from '../screens/settings';
import { FakeWS, lease, state, type Msg } from './fakeWs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KIM: User = { id: 'a1', username: 'kim', display_name: '김총괄', role: 'ORG_ADMIN', locked: false, robot_ids: [], created_at: '2026-10-19T00:00:00Z' };
const LEE: User = { ...KIM, id: 'o1', username: 'lee', display_name: '이운영', role: 'OPERATOR', robot_ids: ['r-a'] };
const PARK: User = { ...KIM, id: 'o2', username: 'park', display_name: '박운영', role: 'OPERATOR', robot_ids: ['r-b'] };
const CHOI: User = { ...KIM, id: 'o3', username: 'choi', display_name: '최운영', role: 'OPERATOR', locked: true };
const LIMITS = { battery_low_pct: 20, run_min_battery_pct: 30, deviation_m: 1.5, lease_request_timeout_s: 10, link_loss_wait_s: 30 };
const AT = '2026-10-20T05:06:07Z';
const robot = (id: string, name: string, owner: User | null, p: Partial<RobotSummary> = {}): RobotSummary => ({ id, name, model: 'unitree_go2',
  owner: owner && { id: owner.id, display_name: owner.display_name }, connection: 'OFFLINE', status: null, battery: null, location: null, lease: null,
  current_run: null, devices: [], attention: [], ...p });
const RA = robot('r-a', 'Go2-A', LEE, { connection: 'ONLINE', status: 'IDLE', battery: { soc: 64, updated_at: AT },
  location: { floor_id: null, map_version_id: null, x: 1.25, y: -3, yaw: 0, confidence: null, updated_at: AT },
  devices: [{ key: 'cam', kind: 'CAMERA_RGB', label: '앞 카메라', state: 'OK' }, { key: 'lidar', kind: 'LIDAR', label: '라이다', state: 'MISSING' }] });
// 남의 로봇(운영 관리자 시점): 서버가 UNKNOWN + 값 감춤
const RB_HIDDEN = robot('r-b', 'Go2-B', PARK, { connection: 'UNKNOWN' });
const RB = robot('r-b', 'Go2-B', PARK);
const DASH: Dashboard = { robots_total: 2, robots_online: 1, robots_attention: 1, robots_running: 0, approvals_pending: 0,
  operators: [{ user_id: 'o1', display_name: '이운영', robot_count: 1 }, { user_id: 'o2', display_name: '박운영', robot_count: 1 }] };
const err = (status: number, code: string, message: string) => ({ status, body: { error: { code, message, detail: {} } } });

type Reply = { status: number; body?: unknown };
type Call = { method: string; path: string; body?: unknown };
let calls: Call[] = [], routes: Record<string, Reply | (() => Reply)> = {};
function serve(r: typeof routes) {
  routes = r; calls = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET', path = url.replace(/^\/api\/v1/, '');
    calls.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const hit = routes[`${method} ${path.split('?')[0]}`], rep = typeof hit === 'function' ? hit() : hit ?? err(404, 'NOT_FOUND', '찾을 수 없습니다.');
    return new Response(rep.status === 204 ? null : JSON.stringify(rep.body), { status: rep.status, headers: { 'Content-Type': 'application/json' } });
  });
}
const signedIn = (me: User, robots: RobotSummary[], more: typeof routes = {}) => ({
  'GET /auth/session': { status: 200, body: { client: 'web', csrf_token: 'csrf-1' } },
  'GET /me': { status: 200, body: me },
  'GET /robots': { status: 200, body: { items: robots, next_cursor: null } },
  'GET /org/settings': { status: 200, body: LIMITS },
  'GET /users': { status: 200, body: { items: [KIM, LEE, PARK, CHOI], next_cursor: null } },
  'GET /dashboard': { status: 200, body: DASH },
  ...Object.fromEntries(robots.map((r) => [`GET /robots/${r.id}`, { status: 200, body: r }])),
  ...more,
});
const sent = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);
const lists = () => calls.filter((c) => c.method === 'GET' && c.path.startsWith('/robots?')).length;

let root: ReactRoot | null = null, box: HTMLDivElement;
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); });
async function open(hash: string, phone = false) {
  window.matchMedia = ((q: string) => ({ matches: phone, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  location.hash = hash;
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<Root />); });
  await flush();
}
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const $ = <T extends Element = HTMLElement>(s: string, from: ParentNode = box) => from.querySelector<T>(s);
const btn = (t: string, from: ParentNode = box) => [...from.querySelectorAll('button')].find((b) => b.textContent === t) as HTMLButtonElement | undefined;
const card = (label: string) => $(`[aria-label="${label}"]`)!;
const click = async (b: Element | undefined | null) => { expect(b).toBeTruthy(); act(() => (b as HTMLElement).click()); await flush(); };
const setVal = (el: HTMLInputElement | HTMLSelectElement, v: string) => act(() => {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!.call(el, v);
  el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
});
const submit = async (form: Element) => { act(() => { (form as HTMLFormElement).requestSubmit(); }); await flush(); };
const kpi = () => Object.fromEntries([...card('요약').querySelectorAll('div')].map((d) => [d.firstElementChild!.textContent, d.querySelector('b')!.textContent]));
const line = (k: string) => [...card('로봇 상세').querySelectorAll('.fh-row')].find((d) => d.firstElementChild?.textContent === k)!.lastElementChild!.textContent;
const row = (name: string) => [...card('로봇 목록').querySelectorAll('button')].find((b) => b.textContent!.includes(name))!;
const subs = (w: FakeWS) => w.of('sub').map((m) => m.robots);
const stopOk = () => { const s = $<HTMLButtonElement>('[data-stop]')!; expect(s).not.toBeNull(); expect(s.disabled).toBe(false); expect(s.hidden).toBe(false); };

/** 실시간 서버: 열고, 받은 sub 에 state 를 보내고, lease.take 에 조종권을 준다 */
function live(me: User) {
  const w = FakeWS.last;
  w.auto = (m: Msg) => {
    if (m.t === 'lease.take') { setTimeout(() => { w.recv(lease(m.robot!, { id: me.id, name: me.display_name }, 'L1')); w.recv({ t: 'lease.result', robot: m.robot, request_id: null, result: 'ACCEPTED' }); }); }
    return { ok: true };
  };
  act(() => { w.open(); });
  for (const id of (subs(w).pop() as string[]) ?? []) act(() => w.recv(state(id)));
  return w;
}

describe('관제 요약 = GET /dashboard(05 §4)', () => {
  it('총괄: 서버 수치 그대로, 주의 필요는 강조, 운영 관리자 표', async () => {
    serve(signedIn(KIM, [RA, RB]));
    await open('#/fleet');
    expect(kpi()).toEqual({ 전체: '2', 연결: '1', '임무 중': '0', '주의 필요': '1', '결재 대기': '0' });
    expect(card('요약').querySelector('.bad')!.textContent).toContain('주의 필요');
    expect(card('운영 관리자').textContent).toBe('운영 관리자 2명이운영로봇 1대박운영로봇 1대');
    stopOk();
  });
  it('운영 관리자: 서버가 센 담당 범위(내 로봇·내 요청), 운영 관리자 표 없음, 목록은 전체', async () => {
    serve(signedIn(LEE, [RA, RB_HIDDEN], { 'GET /dashboard': { status: 200, body: { ...DASH, robots_total: 1, robots_attention: 0, operators: [] } } }));
    await open('#/fleet');
    expect(kpi()).toEqual({ '내 로봇': '1', 연결: '1', '임무 중': '0', '주의 필요': '0', '내 요청': '0' });
    expect($('[aria-label="운영 관리자"]')).toBeNull();
    expect(row('Go2-B').textContent).toContain('박운영 · 보기 전용');
  });
  it('요약 실패(403·500·네트워크·형식 틀림) → 숫자를 지어내지 않고 «—» + 이유', async () => {
    for (const [rep, says] of [[err(403, 'FORBIDDEN', '권한이 없습니다.'), '권한이 없습니다.'], [err(500, 'INTERNAL', '서버 오류'), ''],
      [() => { throw new TypeError('Failed to fetch'); }, '서버에 연결하지 못했습니다'], [{ status: 200, body: {} }, '요약 형식이 맞지 않습니다'],
      [{ status: 200, body: { ...DASH, robots_total: '2' } }, '요약 형식이 맞지 않습니다'], [{ status: 200, body: { ...DASH, robots_online: null } }, '요약 형식이 맞지 않습니다']] as const) {
      serve(signedIn(KIM, [RA], { 'GET /dashboard': rep as Reply }));
      await open('#/fleet');
      expect(Object.values(kpi())).toEqual(['—', '—', '—', '—', '—']);
      expect(card('요약').querySelector('[role="alert"]')!.textContent).toContain(`요약을 받지 못했습니다. ${says}`);
      act(() => root!.unmount()); box.remove();
    }
  });
  it('로봇 0대: 선택 로봇 없이도 GET /dashboard·요약·운영 관리자 표, «로봇 없음»', async () => {
    serve(signedIn(KIM, [], { 'GET /dashboard': { status: 200, body: { ...DASH, robots_total: 0, robots_online: 0, robots_attention: 0 } } }));
    await open('#/fleet');
    expect(sent('GET', '/dashboard')).toHaveLength(1);
    expect(kpi()).toEqual({ 전체: '0', 연결: '0', '임무 중': '0', '주의 필요': '0', '결재 대기': '0' });
    expect(card('운영 관리자').textContent).toContain('운영 관리자 2명');
    expect(card('로봇 없음').textContent).toContain('로봇이 없습니다');
    act(() => root!.unmount()); box.remove();
    serve(signedIn(LEE, [], { 'GET /dashboard': { status: 200, body: { ...DASH, robots_total: 0, robots_online: 0, robots_attention: 0, operators: [] } } }));
    await open('#/fleet');
    expect(kpi()['내 로봇']).toBe('0');
    expect($('[aria-label="운영 관리자"]')).toBeNull();
  });
  it('요약을 10 s 마다 다시 받는다(화면 WS 에 요약 없음)', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    serve(signedIn(KIM, [RA]));
    await open('#/fleet');
    const n = sent('GET', '/dashboard').length;
    routes['GET /dashboard'] = { status: 200, body: { ...DASH, robots_online: 2 } };
    act(() => { vi.advanceTimersByTime(10_000); });
    await flush();
    expect(sent('GET', '/dashboard').length).toBe(n + 1);
    expect(kpi()['연결']).toBe('2');
  });
});

describe('상세 서랍 = GET /robots/{id}', () => {
  it('총괄: 담당·배터리·위치·장치(이름·종류·상태), 층·임무는 지어내지 않음', async () => {
    serve(signedIn(KIM, [RA, RB]));
    await open('#/fleet');
    expect(sent('GET', '/robots/r-a')).toHaveLength(1);
    expect(line('담당')).toBe('이운영');
    expect(line('배터리')).toBe('64%');
    expect(line('위치')).toMatch(/^x 1\.3 m · y -3\.0 m \(\d\d:\d\d:\d\d\)$/);
    expect([...card('장치').querySelectorAll('li')].map((li) => li.textContent)).toEqual(['앞 카메라카메라●정상', '라이다라이다▲끊김']);
    expect(card('로봇 상세').textContent).not.toMatch(/임무|층/);
  });
  it('null 은 null 대로: 배터리 «측정 안 됨», 위치 «위치 없음», 장치 «장치 정보 없음», 담당 없음', async () => {
    const bare = robot('r-n', 'Go2-N', null, { connection: 'ONLINE' });
    serve(signedIn(KIM, [bare]));
    await open('#/fleet');
    live(KIM);
    act(() => FakeWS.last.recv(state('r-n', { battery: null, location: null, devices: [] })));
    expect([line('담당'), line('배터리'), line('위치'), line('장치')]).toEqual(['담당 없음', '측정 안 됨', '위치 없음', '장치 정보 없음']);
    expect(row('Go2-N').textContent).toContain('—');   // 목록 배터리도 «—», 0% 아님
  });
  it('운영 관리자가 남의 로봇(UNKNOWN): 상태·배터리·위치·장치 «확인 안 됨», 조종 비활성 + STOP 은 됨', async () => {
    serve(signedIn(LEE, [RA, RB_HIDDEN]));
    await open('#/fleet');
    await click(row('Go2-B'));
    expect(sent('GET', '/robots/r-b')).toHaveLength(1);
    expect([line('배터리'), line('위치'), line('장치')]).toEqual(['확인 안 됨', '확인 안 됨', '확인 안 됨']);
    expect(card('로봇 상세').querySelector('h2 + *')!.textContent).toBe('○확인 안 됨');
    expect(btn('조종하기', card('로봇 상세'))!.disabled).toBe(true);
    stopOk();
  });
  it('위치·장치만 바뀐 state 도 상세를 다시 그린다', async () => {
    serve(signedIn(KIM, [RA]));
    await open('#/fleet');
    const w = live(KIM);
    act(() => w.recv(state('r-a', { location: RA.location, devices: RA.devices })));
    await click(row('Go2-A'));
    act(() => w.recv(state('r-a', { location: { ...RA.location!, x: 9 }, devices: [{ ...RA.devices[0], state: 'ERROR' }] })));
    expect(line('위치')).toContain('x 9.0 m');
    expect(line('장치')).toContain('오류');
  });
  it('열린 상세의 담당이 바뀌면 다시 받아 조종 가능, 옛 요청의 늦은 답은 버린다', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    serve(signedIn(LEE, [RA, RB_HIDDEN]));
    const served = globalThis.fetch;
    let late!: () => void, held = false;
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      if (held || !url.endsWith('/robots/r-b')) return served(url, init);
      held = true;
      return new Promise<Response>((ok) => { late = () => ok(served(url, init) as unknown as Response); });
    });
    await open('#/fleet');
    const w = live(LEE);
    await click(row('Go2-B'));
    expect(line('담당')).toBe('박운영');
    const mine = { ...RB, owner: RA.owner, connection: 'ONLINE' as const };
    routes['GET /robots'] = { status: 200, body: { items: [RA, mine], next_cursor: null } };
    routes['GET /robots/r-b'] = { status: 200, body: mine };
    act(() => { vi.advanceTimersByTime(10_000); });
    await flush();
    act(() => w.recv(state('r-b')));
    routes['GET /robots/r-b'] = { status: 200, body: RB_HIDDEN };
    await act(async () => late());
    await flush();
    expect(sent('GET', '/robots/r-b')).toHaveLength(2);
    expect(line('담당')).toBe('이운영');
    expect(btn('조종하기', card('로봇 상세'))!.disabled).toBe(false);
  });
  it('상세 404 → «찾을 수 없음» + 목록 다시 받기, 그 밖 실패는 이유', async () => {
    serve(signedIn(KIM, [RA], { 'GET /robots/r-a': err(404, 'NOT_FOUND', '로봇을 찾을 수 없습니다.') }));
    await open('#/fleet');
    expect(card('로봇 상세').querySelector('[role="alert"]')!.textContent).toContain('찾을 수 없습니다');
    expect(lists()).toBe(2);
    act(() => root!.unmount()); box.remove();
    serve(signedIn(KIM, [RA], { 'GET /robots/r-a': () => { throw new TypeError('Failed to fetch'); } }));
    await open('#/fleet');
    expect(card('로봇 상세').querySelector('[role="alert"]')!.textContent).toContain('상세를 받지 못했습니다. 서버에 연결하지 못했습니다');
    expect(lists()).toBe(1);
  });
});

describe('설정 › 로봇(총괄, 05 §3)', () => {
  const pickRobot = (name: string) => click([...card('로봇').querySelectorAll('li button')].find((b) => b.textContent!.includes(name)));
  it('운영 관리자에게는 없음(권한 없는 기능 숨김)', async () => {
    serve(signedIn(LEE, [RA]));
    await open('#/settings');
    expect($('[aria-label="로봇"]')).toBeNull();
    expect(btn('로봇 등록')).toBeUndefined();
  });
  it('등록: 이름·담당(잠기지 않은 운영 관리자) → 토큰은 응답 화면에서 한 번만, 닫으면 어디에도 없음', async () => {
    const TOKEN = 'fh_agent_secret_123';
    serve(signedIn(KIM, [RA], { 'POST /robots': { status: 201, body: { robot: robot('r-n', 'Go2-N', LEE), agent_token: TOKEN } } }));
    await open('#/settings');
    expect(card('로봇').textContent).toContain('Go2-A이운영');
    await click(btn('로봇 등록'));
    const form = $('form[aria-label="로봇 등록"]')!;
    expect([...form.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['담당 없음', '이운영', '박운영']);   // 잠긴 최운영·총괄 제외
    await submit(form);
    expect(form.querySelector('[role="alert"]')!.textContent).toBe('로봇 이름을 입력하세요.');
    expect(sent('POST', '/robots')).toHaveLength(0);
    setVal(form.querySelector('input[name="name"]')!, ' Go2-N ');
    setVal(form.querySelector('select')!, 'o1');
    const before = lists();
    await submit(form);
    expect(sent('POST', '/robots')[0].body).toEqual({ name: 'Go2-N', owner_user_id: 'o1' });
    expect($<HTMLInputElement>('input[aria-label="로봇 토큰"]')!.value).toBe(TOKEN);
    expect(card('로봇 토큰').textContent).toContain('닫으면 다시 볼 수 없습니다.');
    expect(lists()).toBeGreaterThanOrEqual(before + 2);   // 설정 목록 + 관제·조종 목록(App)
    const write = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: write } });
    await click(btn('복사', card('로봇 토큰')));
    expect(write).toHaveBeenCalledWith(TOKEN);
    await click(btn('닫기', card('로봇 토큰')));
    expect($('[aria-label="로봇 토큰"]')).toBeNull();
    expect(box.innerHTML).not.toContain(TOKEN);
    expect(JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage })).not.toContain(TOKEN);
  });
  it('로봇 0대에서 첫 등록: 목록이 바뀌어도 토큰 칸이 그대로 남는다', async () => {
    serve(signedIn(KIM, [], { 'POST /robots': { status: 201, body: { robot: RA, agent_token: 'fh_first_789' } } }));
    await open('#/settings');
    routes['GET /robots'] = { status: 200, body: { items: [RA], next_cursor: null } };
    await click(btn('로봇 등록'));
    setVal($<HTMLInputElement>('form[aria-label="로봇 등록"] input[name="name"]')!, 'Go2-A');
    await submit($('form[aria-label="로봇 등록"]')!);
    await flush();
    expect($<HTMLInputElement>('input[aria-label="로봇 토큰"]')!.value).toBe('fh_first_789');
    expect(card('로봇').textContent).toContain('로봇 (1)');
  });
  it('등록 실패: 400 은 서버 문장, 403 은 서버 문장, 네트워크는 연결 문구 — 토큰 칸 없음', async () => {
    for (const [rep, says] of [[err(400, 'VALIDATION', '담당 운영 관리자를 확인하세요.'), '담당 운영 관리자를 확인하세요.'],
      [err(403, 'FORBIDDEN', '권한이 없습니다.'), '권한이 없습니다.'], [() => { throw new TypeError('Failed to fetch'); }, '서버에 연결하지 못했습니다']] as const) {
      serve(signedIn(KIM, [RA], { 'POST /robots': rep as Reply }));
      await open('#/settings');
      await click(btn('로봇 등록'));
      setVal($<HTMLInputElement>('form[aria-label="로봇 등록"] input[name="name"]')!, 'Go2-N');
      await submit($('form[aria-label="로봇 등록"]')!);
      expect($('form[aria-label="로봇 등록"] [role="alert"]')!.textContent).toContain(says);
      expect($('[aria-label="로봇 토큰"]')).toBeNull();
      act(() => root!.unmount()); box.remove();
    }
  });
  it('등록 401 → 로그인 화면', async () => {
    serve(signedIn(KIM, [RA], { 'POST /robots': err(401, 'AUTH_REQUIRED', '로그인이 필요합니다.') }));
    await open('#/settings');
    await click(btn('로봇 등록'));
    setVal($<HTMLInputElement>('form[aria-label="로봇 등록"] input[name="name"]')!, 'Go2-N');
    await submit($('form[aria-label="로봇 등록"]')!);
    expect($('[aria-label="로그인"]')).not.toBeNull();
  });
  it('바꾸기: 바뀐 칸만 PATCH, 담당 없애기 = owner_user_id null, 담당 바꾸면 조종이 끝난다는 안내', async () => {
    serve(signedIn(KIM, [RA], { 'PATCH /robots/r-a': { status: 200, body: { ...RA, owner: null } } }));
    await open('#/settings');
    await pickRobot('Go2-A');
    const box2 = card('로봇 설정');
    expect(box2.textContent).toContain('예전 담당자의 조종이 끝나고 로봇이 정지합니다');
    await submit(box2.querySelector('form')!);
    expect(box2.querySelector('[role="status"],[role="alert"]')!.textContent).toBe('바뀐 값이 없습니다.');
    expect(sent('PATCH', '/robots/r-a')).toHaveLength(0);
    setVal(box2.querySelector('select')!, '');
    await submit(box2.querySelector('form')!);
    expect(sent('PATCH', '/robots/r-a')[0].body).toEqual({ owner_user_id: null });
    setVal(box2.querySelector('input[name="name"]')!, 'Go2-AA');
    setVal(box2.querySelector('select')!, 'o1');
    await submit(box2.querySelector('form')!);
    expect(sent('PATCH', '/robots/r-a')[1].body).toEqual({ name: 'Go2-AA' });
  });
  it('바꾸기 503(다른 변경 처리 중) → 잠시 뒤 다시', async () => {
    serve(signedIn(KIM, [RA], { 'PATCH /robots/r-a': err(503, 'SERVER_BUSY', 'busy') }));
    await open('#/settings');
    await pickRobot('Go2-A');
    setVal(card('로봇 설정').querySelector('select')!, 'o2');
    await submit(card('로봇 설정').querySelector('form')!);
    expect(card('로봇 설정').querySelector('[role="alert"]')!.textContent).toBe(ROBOT_BUSY);
  });
  it('지우기: 확인 뒤 DELETE. 409 = 조종·실행 중 문구, 503 = 다시, 404 = 이미 지워짐 + 목록 다시, 204 = 목록에서 빠짐', async () => {
    let rep: Reply = err(409, 'VERSION_CONFLICT', '실행·조종을 끝낸 뒤 해제하세요.');
    serve(signedIn(KIM, [RA, RB], { 'DELETE /robots/r-a': () => rep }));
    await open('#/settings');
    await pickRobot('Go2-A');
    const del = async () => { await click(btn('로봇 지우기', card('로봇 설정'))); await click(btn('지우기', card('확인'))); };
    await click(btn('로봇 지우기', card('로봇 설정')));
    expect(card('확인').textContent).toContain('되돌릴 수 없습니다');
    await click(btn('취소', card('확인')));
    expect(sent('DELETE', '/robots/r-a')).toHaveLength(0);
    await del();
    expect(card('로봇 설정').querySelector('[role="alert"]')!.textContent).toBe(ROBOT_IN_USE);
    rep = err(503, 'SERVER_BUSY', 'busy');
    await del();
    expect(card('로봇 설정').querySelector('[role="alert"]')!.textContent).toBe(ROBOT_BUSY);
    rep = err(404, 'NOT_FOUND', '로봇을 찾을 수 없습니다.');
    routes['GET /robots'] = { status: 200, body: { items: [RB], next_cursor: null } };
    let n = lists();
    await del();
    expect($('[aria-label="로봇 설정"]')).toBeNull();
    expect(card('로봇').textContent).toContain(ROBOT_GONE);
    expect(card('로봇').textContent).not.toContain('Go2-A');
    expect(lists()).toBeGreaterThanOrEqual(n + 2);
    // 다시 생긴 것처럼 꾸며 204 경로
    routes['GET /robots'] = { status: 200, body: { items: [RA, RB], next_cursor: null } };
    await click(btn('닫기') ?? btn('로봇 등록')); await click(btn('취소'));
    serve({ ...routes, 'DELETE /robots/r-a': { status: 204 } });
    act(() => root!.unmount()); box.remove();
    await open('#/settings');
    await pickRobot('Go2-A');
    routes['GET /robots'] = { status: 200, body: { items: [RB], next_cursor: null } };
    n = lists();
    await del();
    expect(card('로봇').textContent).toContain('Go2-A 로봇을 지웠습니다.');
    expect([...card('로봇').querySelectorAll('li')].map((li) => li.textContent)).toEqual(['Go2-B박운영']);
    expect(lists()).toBeGreaterThanOrEqual(n + 2);
  });
  it('토큰 다시 받기: 확인 뒤 POST agent-token → 새 토큰 한 번, 실패는 이유', async () => {
    let rep: Reply = err(403, 'FORBIDDEN', '권한이 없습니다.');
    serve(signedIn(KIM, [RA], { 'POST /robots/r-a/agent-token': () => rep }));
    await open('#/settings');
    await pickRobot('Go2-A');
    await click(btn('토큰 다시 받기', card('로봇 설정')));
    expect(card('확인').textContent).toContain('예전 토큰은 바로 못 쓰게');
    await click(btn('토큰 다시 받기', card('확인')));
    expect(card('로봇 설정').querySelector('[role="alert"]')!.textContent).toBe('권한이 없습니다.');
    rep = { status: 200, body: { agent_token: 'fh_new_456' } };
    await click(btn('토큰 다시 받기', card('로봇 설정')));
    await click(btn('토큰 다시 받기', card('확인')));
    expect(sent('POST', '/robots/r-a/agent-token')).toHaveLength(2);
    expect($<HTMLInputElement>('input[aria-label="로봇 토큰"]')!.value).toBe('fh_new_456');
    await click(btn('닫기', card('로봇 토큰')));
    expect(box.innerHTML).not.toContain('fh_new_456');
  });
});

describe('subscription.revoked(05 §9)', () => {
  async function driving() {
    serve(signedIn(LEE, [RA, RB_HIDDEN]));
    await open('#/drive/r-a');
    const w = live(LEE);
    expect(subs(w).pop()).toEqual(['r-a']);
    await click(btn('조종 시작'));
    await flush();
    expect(rt.get('r-a').lease).toBe('L1');
    expect(location.hash).toBe('#/drive/r-a');
    return w;
  }
  it('ACCESS_REVOKED: 조종 화면을 닫고 이유, 조종 중 표시 즉시 사라짐, 목록 다시 받기, STOP 은 그대로', async () => {
    const w = await driving();
    const n = lists(), k = subs(w).length;
    routes['GET /robots'] = { status: 200, body: { items: [{ ...RA, owner: { id: 'o2', display_name: '박운영' }, connection: 'UNKNOWN' }, RB_HIDDEN], next_cursor: null } };
    act(() => { w.recv(lease('r-a', null)); w.recv({ t: 'subscription.revoked', robot: 'r-a', reason: 'ACCESS_REVOKED' }); });
    await flush();
    expect(rt.get('r-a').lease).toBeNull();
    expect(location.hash).toBe('#/drive');
    expect($('[data-revoked]')!.textContent).toContain('Go2-A 로봇의 담당이 바뀌어 이제 조종할 수 없습니다. 조종 화면을 닫았습니다.');
    expect(box.textContent).not.toContain('조종 중(나)');
    expect(lists()).toBe(n + 1);
    stopOk();
    // 새 목록에서 r-a 는 남의 로봇 → 다시 구독하지 않음(서버 4403 방지)
    expect(subs(w)).toHaveLength(k);
  });
  it('ROBOT_DELETED: 지워졌다는 문구, 닫기 단추로 띠에서 내림', async () => {
    const w = await driving();
    routes['GET /robots'] = { status: 200, body: { items: [RB_HIDDEN], next_cursor: null } };
    act(() => { w.recv({ t: 'subscription.revoked', robot: 'r-a', reason: 'ROBOT_DELETED' }); });
    await flush();
    expect($('[data-revoked]')!.textContent).toContain('Go2-A 로봇이 지워져 목록에서 뺍니다. 조종 화면을 닫았습니다.');
    stopOk();
    await click(btn('닫기', $('[data-revoked]')!));
    expect($('[data-revoked]')).toBeNull();
  });
  it('revoke 전에 요청한 목록이 늦게 와도 그 로봇을 다시 구독하지 않음, 뒤에 요청한 목록이 담당이면 다시 구독', async () => {
    const w = await driving();
    const before = now(), k = subs(w).length;
    routes['GET /robots'] = { status: 200, body: { items: [RA, RB_HIDDEN], next_cursor: null } };   // 다시 이운영에게 배정된 것처럼
    act(() => { w.recv({ t: 'subscription.revoked', robot: 'r-a', reason: 'ACCESS_REVOKED' }); });
    act(() => rt.follow(['r-a'], before));   // revoke 전에 요청한 목록
    expect(subs(w)).toHaveLength(k);
    await flush();   // revoke 뒤 App 이 다시 받은 목록은 따른다
    expect(subs(w).slice(k)).toEqual([['r-a']]);
  });
  it('모르는 t·형식 틀린 revoke 는 무시(상태·조종권 그대로)', async () => {
    const w = await driving();
    const n = lists();
    act(() => { w.recv({ t: 'robot.teleported', robot: 'r-a' }); w.recv({ t: 'subscription.revoked', robot: 7, reason: 'ACCESS_REVOKED' }); });
    await flush();
    expect(rt.get('r-a').lease).toBe('L1');
    expect(location.hash).toBe('#/drive/r-a');
    expect($('[data-revoked]')).toBeNull();
    expect(lists()).toBe(n);
  });
  it('폰 320 폭: revoke 뒤에도 STOP 은 머리줄 맨 오른쪽', async () => {
    serve(signedIn(LEE, [RA, RB_HIDDEN]));
    await open('#/drive', true);
    const w = live(LEE);
    act(() => { w.recv({ t: 'subscription.revoked', robot: 'r-a', reason: 'ROBOT_DELETED' }); });
    await flush();
    expect($('header')!.lastElementChild).toBe($('[data-stop]'));
    stopOk();
  });
});
