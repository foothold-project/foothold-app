// ROBOT-PAIRING C 화면(05 §3.1) — 운영 관리자 새 로봇 추가(QR·6자리 → 기체번호 → 이름)·현장 안전 확인·내 로봇 관리, 총괄 읽기 전용 대시보드·담당 지정.
// fetch 는 가짜 서버, WebSocket 은 FakeWS. 연결 키는 화면에 오지 않는다(서버 confirm 답에도 없음).
import { act } from 'react';
import { createRoot, type Root as ReactRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RobotSummary, User } from '../../../contracts/ts';
import { LIST_MS, Root } from '../session';
import { ROBOT_IN_USE } from '../screens/settings';
import { CHECKS } from '../pairing';
import { FakeWS, state } from './fakeWs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KIM: User = { id: 'a1', username: 'kim', display_name: '김총괄', role: 'ORG_ADMIN', locked: false, robot_ids: [], created_at: '2026-10-19T00:00:00Z' };
const LEE: User = { ...KIM, id: 'o1', username: 'lee', display_name: '이운영', role: 'OPERATOR' };
const PARK: User = { ...KIM, id: 'o2', username: 'park', display_name: '박운영', role: 'OPERATOR' };
const robot = (id: string, name: string, owner: User | null, p: Partial<RobotSummary> = {}): RobotSummary => ({ id, name, model: 'unitree_go2',
  simulation: false, server_drive_allowed: false, owner: owner && { id: owner.id, display_name: owner.display_name }, connection: 'OFFLINE', status: null,
  battery: null, location: null, lease: null, current_run: null, devices: [], attention: [], ...p });
const SERIAL = '1234-56785678';
const RA = robot('r-a', 'Go2-A', LEE, { robot_serial: SERIAL });
const err = (status: number, code: string, message: string) => ({ status, body: { error: { code, message, detail: {} } } });
const inMin = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

type Reply = { status: number; body?: unknown };
type Call = { method: string; path: string; body?: unknown };
let calls: Call[] = [], routes: Record<string, Reply | (() => Reply | Promise<Reply>)> = {};
function serve(r: typeof routes) {
  routes = r; calls = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET', path = url.replace(/^\/api\/v1/, '');
    calls.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const hit = routes[`${method} ${path.split('?')[0]}`], rep = await (typeof hit === 'function' ? hit() : hit ?? err(404, 'NOT_FOUND', '찾을 수 없습니다.'));
    return new Response(rep.status === 204 ? null : JSON.stringify(rep.body), { status: rep.status, headers: { 'Content-Type': 'application/json' } });
  });
}
const signedIn = (me: User, robots: RobotSummary[], more: typeof routes = {}) => ({
  'GET /auth/session': { status: 200, body: { client: 'web', csrf_token: 'csrf-1' } },
  'GET /me': { status: 200, body: me },
  'GET /robots': { status: 200, body: { items: robots, next_cursor: null } },
  'GET /users': { status: 200, body: { items: [KIM, LEE, PARK, { ...PARK, id: 'o3', display_name: '최운영', locked: true }], next_cursor: null } },
  'GET /dashboard': { status: 200, body: { robots_total: robots.length, robots_online: 0, robots_attention: 0, robots_running: 0, approvals_pending: 0, operators: [] } },
  ...Object.fromEntries(robots.map((r) => [`GET /robots/${r.id}`, { status: 200, body: r }])),
  ...more,
});
const sent = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);

let root: ReactRoot | null = null, box: HTMLDivElement;
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); });
async function open(hash: string, phone: boolean) {
  window.matchMedia = ((q: string) => ({ matches: phone, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  location.hash = hash;
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<Root />); });
  await flush();
}
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); vi.unstubAllGlobals(); });

const $ = <T extends Element = HTMLElement>(s: string, from: ParentNode = box) => from.querySelector<T>(s);
const btn = (t: string, from: ParentNode = box) => [...from.querySelectorAll('button')].find((b) => b.textContent === t) as HTMLButtonElement | undefined;
const card = (label: string) => $(`[aria-label="${label}"]`)!;
const click = async (b: Element | undefined | null) => { expect(b).toBeTruthy(); act(() => (b as HTMLElement).click()); await flush(); };
const setVal = (el: HTMLInputElement, v: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
const submit = async (form: Element) => { act(() => { (form as HTMLFormElement).requestSubmit(); }); await flush(); };
/** 실시간 연결을 열고 r-a 를 ONLINE 으로 */
const online = (id = 'r-a') => act(() => { FakeWS.last.open(); FakeWS.last.recv(state(id)); });
const unfold = async (label: string) => {
  const d = [...box.querySelectorAll('details.dv-fold')].find((x) => x.querySelector('summary')!.textContent === label) as HTMLDetailsElement;
  act(() => { d.open = true; d.dispatchEvent(new Event('toggle')); }); await flush();
};
const startPair = async () => { await click(btn('+ 로봇 연결하기')); await click(btn('새 로봇 추가')); };

describe('폰 운영 관리자 — 새 로봇 추가', () => {
  it('6자리 → claim → 기체번호 확인 «이 로봇 맞음» → 기본 이름 Go2-끝4자리 → confirm → 목록 다시 받기, 연결 키는 어디에도 없음', async () => {
    serve(signedIn(LEE, [], {
      'POST /pairing/claim': { status: 200, body: { pairing_id: 'p1', robot_serial: SERIAL, expires_at: inMin(9) } },
      'POST /pairing/p1/confirm': { status: 200, body: RA },
    }));
    await open('#/drive', true);
    expect(btn('+ 로봇 연결하기')!.className).toBe('btn pri');   // 연결된 실기 0 → 목록 위 큰 단추
    await startPair();
    expect(card('새 로봇 추가').dataset.pair).toBe('code');
    const code = $<HTMLInputElement>('[data-pair-code]')!;
    setVal(code, '12a34');
    expect(code.value).toBe('1234');   // 숫자만
    expect(btn('다음')!.disabled).toBe(true);
    setVal(code, '123456');
    await submit(code.form!);
    expect(sent('POST', '/pairing/claim')[0].body).toEqual({ code: '123456' });
    expect($('[data-pair-serial]')!.textContent).toBe(SERIAL);
    await click(btn('이 로봇 맞음'));
    const name = $<HTMLInputElement>('[aria-label="새 로봇 추가"] input[name="name"]')!;
    expect(name.value).toBe('Go2-5678');
    const lists = calls.filter((c) => c.path.startsWith('/robots?')).length;
    routes['GET /robots'] = { status: 200, body: { items: [RA], next_cursor: null } };
    await submit(name.form!);
    expect(sent('POST', '/pairing/p1/confirm')[0].body).toEqual({ name: 'Go2-5678' });
    expect($('[data-pair-done]')!.textContent).toContain('Go2-A 로봇을 등록했습니다.');
    expect($('[data-pair-done]')!.textContent).toContain('현장 안전 확인');
    expect(calls.filter((c) => c.path.startsWith('/robots?')).length).toBe(lists);   // 안내가 보이는 동안은 안 바꿈
    await click(btn('내 로봇으로'));
    expect(calls.filter((c) => c.path.startsWith('/robots?')).length).toBeGreaterThan(lists);
    expect(card('내 로봇').textContent).toContain('Go2-A');
    expect(box.innerHTML).not.toMatch(/agent_token|poll_secret/);
  });

  it('오류 문구: 코드 404(만료·틀림·사용됨) · 429 서버 문장 · 다른 담당 409 · confirm 404 는 처음으로', async () => {
    let claim: Reply = err(404, 'PAIRING_NOT_FOUND', '연결 코드를 확인하거나 새로 발급하세요.'), confirm: Reply = err(409, 'ROBOT_ALREADY_PAIRED', '담당 운영에게 넘겨받기 또는 삭제를 요청하세요.');
    serve(signedIn(LEE, [], { 'POST /pairing/claim': () => claim, 'POST /pairing/p1/confirm': () => confirm }));
    await open('#/drive', true);
    await startPair();
    const go = async () => { setVal($<HTMLInputElement>('[data-pair-code]')!, '654321'); await submit($<HTMLInputElement>('[data-pair-code]')!.form!); };
    const alert = () => $('[aria-label="새 로봇 추가"] [role="alert"]')!.textContent;
    await go();
    expect(alert()).toContain('10분이 지났거나, 이미 쓴 코드');
    claim = err(429, 'PAIRING_RATE_LIMIT', '연결 시도가 많습니다. 잠시 뒤 다시 시도하세요.');
    await go();
    expect(alert()).toBe('연결 시도가 많습니다. 잠시 뒤 다시 시도하세요.');
    claim = { status: 200, body: { pairing_id: 'p1', robot_serial: SERIAL, expires_at: inMin(9) } };
    await go();
    await click(btn('이 로봇 맞음'));
    await submit($('[aria-label="새 로봇 추가"] form')!);
    expect(alert()).toContain('다른 운영 관리자가 담당');
    expect(alert()).toContain('넘겨받기 또는 삭제');
    confirm = err(404, 'PAIRING_NOT_FOUND', 'x');
    await submit($('[aria-label="새 로봇 추가"] form')!);
    expect(card('새 로봇 추가').dataset.pair).toBe('code');
    expect(alert()).toContain('새 코드로 다시');
  });

  it('재연결: confirm 이 내 기존 로봇 id 를 주면 «기존 로봇에 다시 연결 · 옛 연결 키 폐기» 안내', async () => {
    serve(signedIn(LEE, [RA], {
      'POST /pairing/claim': { status: 200, body: { pairing_id: 'p2', robot_serial: SERIAL, expires_at: inMin(9) } },
      'POST /pairing/p2/confirm': { status: 200, body: RA },
    }));
    await open('#/drive', true);
    await startPair();
    setVal($<HTMLInputElement>('[data-pair-code]')!, '111222');
    await submit($<HTMLInputElement>('[data-pair-code]')!.form!);
    await click(btn('이 로봇 맞음'));
    await submit($('[aria-label="새 로봇 추가"] form')!);
    expect($('[data-pair-done]')!.textContent).toContain('기존 로봇에 다시 연결했습니다. 옛 연결 키는 폐기');
  });

  it('QR 스캔: 내장 BarcodeDetector 가 foothold-pair:<6자리> 를 읽으면 그 코드로 claim 하고 카메라를 끈다. 다른 QR 은 무시', async () => {
    const stop = vi.fn(), reads = [[{ rawValue: 'https://evil.example/' }], [{ rawValue: 'foothold-pair:987654' }]];
    vi.stubGlobal('BarcodeDetector', class { detect = async () => reads.shift() ?? []; });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ stop }] }) } });
    HTMLMediaElement.prototype.play = async () => {};
    serve(signedIn(LEE, [], { 'POST /pairing/claim': { status: 200, body: { pairing_id: 'p3', robot_serial: SERIAL, expires_at: inMin(9) } } }));
    await open('#/drive', true);
    await startPair();
    await click(btn('QR 스캔'));
    expect($('video[aria-label="QR 카메라"]')).not.toBeNull();
    await act(async () => { await new Promise((r) => setTimeout(r, 700)); });
    await flush();
    expect(sent('POST', '/pairing/claim').map((c) => c.body)).toEqual([{ code: '987654' }]);
    expect(stop).toHaveBeenCalled();
    expect($('[data-pair-serial]')!.textContent).toBe(SERIAL);
    Reflect.deleteProperty(navigator, 'mediaDevices');
  });

  it('QR 읽기를 못 하는 브라우저 → 이유 + 6자리 입력은 그대로', async () => {
    serve(signedIn(LEE, []));
    await open('#/drive', true);
    await startPair();
    await click(btn('QR 스캔'));
    expect($('[data-scan-why]')!.textContent).toContain('6자리 코드를 아래에');
    expect($('[data-pair-code]')).not.toBeNull();
  });

  it('총괄 폰: «새 로봇 추가» 없음(실기 연결은 운영 관리자)', async () => {
    serve(signedIn(KIM, [RA]));
    await open('#/drive', true);
    expect(btn('+ 로봇 연결하기')).toBeUndefined();
    expect(btn('새 로봇 추가')).toBeUndefined();
  });
});

describe('폰 운영 관리자 — 현장 안전 확인', () => {
  it('끊긴 로봇은 체크 막힘 + 이유. 연결되면 세 항목 모두 체크해야 POST, 남은 시간 표시 → 해제 DELETE', async () => {
    const until = inMin(30);
    serve(signedIn(LEE, [RA], { 'POST /robots/r-a/field-approval': { status: 200, body: { expires_at: until } }, 'DELETE /robots/r-a/field-approval': { status: 204 } }));
    await open('#/drive', true);
    expect($('[data-approval]')!.textContent).toContain('현장 확인 필요');
    await unfold('현장 안전 확인');
    const g = card('현장 안전 확인'), ok = () => btn('현장 승인(30분)', g)!;
    expect(ok().disabled).toBe(true);
    expect($('[data-field-why]', g)!.textContent).toContain('연결된 뒤에');
    online();
    expect($('[data-field-why]', g)).toBeNull();
    const boxes = [...g.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(boxes.map((b) => b.name)).toEqual(['space_clear', 'emergency_stop_ready', 'robot_verified']);
    act(() => { boxes[0].click(); boxes[1].click(); });
    expect(ok().disabled).toBe(true);
    act(() => boxes[2].click());
    expect(ok().disabled).toBe(false);
    await submit(g.querySelector('form')!);
    expect(sent('POST', '/robots/r-a/field-approval')[0].body).toEqual({ checks: CHECKS.map((c) => c.id) });
    expect(g.textContent).toMatch(/현장 승인 (29|30)분 \d+초 남음/);
    await click(btn('해제', g));
    expect(sent('DELETE', '/robots/r-a/field-approval')).toHaveLength(1);
    expect(g.textContent).toContain('해제했습니다');
    expect(g.textContent).toContain('현장 확인 다시 필요');
  });

  it('목록에 승인이 있다가 비면(만료·해제·노트북 재연결) «현장 확인 다시 필요»', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      serve(signedIn(LEE, [{ ...RA, field_approval_expires_at: inMin(12) }]));
      await open('#/drive', true);
      expect($('[data-approval]')!.textContent).toMatch(/현장 승인 1[12]분 \d+초 남음/);
      routes['GET /robots'] = { status: 200, body: { items: [{ ...RA, field_approval_expires_at: null }], next_cursor: null } };
      act(() => { vi.advanceTimersByTime(LIST_MS); });   // 운영 관리자 목록 10초 갱신
      await flush();
      expect($('[data-approval]')!.textContent).toContain('현장 확인 다시 필요');
    } finally { vi.useRealTimers(); }
  });
});

describe('폰 운영 관리자 — 내 로봇 관리', () => {
  it('이름 바꾸기 PATCH {name}, 연결 끊기 = 확인 뒤 DELETE connection, 지우기 409 = 조종·실행 중 문구, 담당 넘기기는 접힘', async () => {
    serve(signedIn(LEE, [RA], {
      'PATCH /robots/r-a': { status: 200, body: { ...RA, name: 'Go2-새' } },
      'DELETE /robots/r-a/connection': { status: 204 },
      'DELETE /robots/r-a': err(409, 'VERSION_CONFLICT', '실행·조종을 끝낸 뒤 해제하세요.'),
    }));
    await open('#/drive', true);
    await unfold('관리');
    const g = card('내 로봇 관리');
    expect(g.textContent).toContain(SERIAL);
    expect(g.querySelector('select')).toBeNull();   // 담당 넘기기는 접혀 있음(펼치면 라디오 — PC 웹 운영 관리자 담당 넘기기 시험)
    setVal($<HTMLInputElement>('input[name="name"]', g)!, ' Go2-새 ');
    await submit(g.querySelector('form')!);
    expect(sent('PATCH', '/robots/r-a')[0].body).toEqual({ name: 'Go2-새' });
    await click(btn('연결 끊기', g));
    expect(card('확인').textContent).toContain('연결 키가 폐기되고 진행 중인 조종은 정지·잠금');
    expect(sent('DELETE', '/robots/r-a/connection')).toHaveLength(0);
    await click(btn('연결 끊기', card('확인')));
    expect(sent('DELETE', '/robots/r-a/connection')).toHaveLength(1);
    expect(g.textContent).toContain('연결을 끊었습니다');
    await click(btn('로봇 지우기', g));
    await click(btn('지우기', card('확인')));
    expect(g.querySelector('[role="alert"]')!.textContent).toBe(ROBOT_IN_USE);
  });
});

describe('PC 총괄 — 로봇 탭 읽기 전용 대시보드', () => {
  const RB = robot('r-b', 'Go2-B', null, { robot_serial: '9-1', attention: ['OFFLINE'] });
  const RAX = { ...RA, field_approval_expires_at: inMin(20), attention: ['BATTERY_LOW'], battery: { soc: 12, updated_at: '2026-11-02T00:00:00Z' } };
  it('목록: 담당·연결·현장 승인 남은 시간·주의. 상세: 기체번호·현장 승인 읽기만, 실기 쓰기·연결·현장 확인 화면 없음', async () => {
    serve(signedIn(KIM, [RAX, RB]));
    await open('#/fleet', false);
    expect($('[aria-label="로봇 상세"]')).toBeNull();   // 총괄 상세는 행을 눌러 여는 서랍(#216)
    const list = card('로봇 목록').textContent!;
    expect(list).toMatch(/Go2-A.*이운영.*현장 승인 (19|20)분/);
    expect(list).toContain('배터리 낮음');
    expect(list).toMatch(/Go2-B.*담당 없음.*현장 확인 필요.*▲ 연결 끊김/);
    await click([...card('로봇 목록').querySelectorAll('button')].find((b) => b.textContent!.includes('Go2-A')));
    const d = card('로봇 상세');
    expect(d.textContent).toContain(SERIAL);
    expect($('[data-field-check]')).toBeNull();
    expect($('[data-manage]')).toBeNull();
    expect($('[data-assign-owner]')).toBeNull();   // 담당 있는 실기는 지정 없음
    expect(btn('+ 새 로봇 추가')).toBeUndefined();
    expect($('[data-stop]')).toBeNull();   // 총괄 실기 STOP 없음
  });

  it('담당 없는 실기만 «담당 지정»: 잠기지 않은 운영 관리자 → 확인 → PATCH {owner_user_id} 한 필드', async () => {
    serve(signedIn(KIM, [RA, RB], { 'PATCH /robots/r-b': { status: 200, body: { ...RB, owner: { id: 'o2', display_name: '박운영' } } } }));
    await open('#/fleet', false);
    await click([...card('로봇 목록').querySelectorAll('button')].find((b) => b.textContent!.includes('Go2-B')));
    const g = card('담당 지정'), sel = g.querySelector('select')!;
    expect([...sel.options].map((o) => o.textContent)).toEqual(['담당 없음', '이운영', '박운영']);
    expect(btn('담당 지정', g)!.disabled).toBe(true);
    act(() => { sel.value = 'o2'; sel.dispatchEvent(new Event('change', { bubbles: true })); });
    await click(btn('담당 지정', g));
    expect(card('확인').textContent).toContain('Go2-B 담당을 박운영(으)로 지정할까요?');
    await click(btn('지정', card('확인')));
    expect(sent('PATCH', '/robots/r-b')[0].body).toEqual({ owner_user_id: 'o2' });
    expect(g.textContent).toContain('담당을 박운영(으)로 지정했습니다.');
  });
});

describe('PC 웹 운영 관리자', () => {
  it('내 실기 상세에 현장 안전 확인·내 로봇 관리, 목록 위 «+ 새 로봇 추가» → 같은 추가 화면', async () => {
    serve(signedIn(LEE, [RA]));
    await open('#/fleet', false);
    expect($('[aria-label="로봇 상세"] [data-field-check]')).not.toBeNull();
    expect($('[aria-label="로봇 상세"] [data-manage]')).not.toBeNull();
    await click(btn('+ 새 로봇 추가'));
    expect(card('새 로봇 추가').dataset.pair).toBe('code');
    await click(btn('닫기', card('새 로봇 추가')));
    expect($('[aria-label="로봇 상태"]')).not.toBeNull();
  });
});

describe('r1 — PC 서버 경유 조종 패널은 목록 최신 허용 값 + 현장 승인 만료를 따른다(첫 GET 고정 아님)', () => {
  const ON = (until: string) => ({ ...RA, server_drive_allowed: true, field_approval_expires_at: until });
  const panel = () => $('[data-server-drive]');
  it('승인 전 진입 → 세 항목 승인 POST → 목록이 허용 true 를 주면 패널과 «조종 시작»이 생긴다', async () => {
    const until = inMin(30);
    serve(signedIn(LEE, [RA], { 'POST /robots/r-a/field-approval': { status: 200, body: { expires_at: until } } }));
    await open('#/fleet', false);
    online();
    expect(panel()).toBeNull();
    const g = card('현장 안전 확인');
    act(() => g.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((b) => b.click()));
    routes['GET /robots'] = { status: 200, body: { items: [ON(until)], next_cursor: null } };
    await submit(g.querySelector('form')!);
    expect(panel()).not.toBeNull();
    expect(panel()!.textContent).toContain('조종 시작');
  });

  it('승인 상태 진입 → 해제 DELETE → 목록이 허용 false 를 주면 패널과 «조종 시작»이 닫힌다', async () => {
    serve(signedIn(LEE, [ON(inMin(30))], { 'DELETE /robots/r-a/field-approval': { status: 204 } }));
    await open('#/fleet', false);
    online();
    expect(panel()!.textContent).toContain('조종 시작');
    routes['GET /robots'] = { status: 200, body: { items: [RA], next_cursor: null } };
    await click(btn('해제', card('현장 안전 확인')));
    expect(sent('DELETE', '/robots/r-a/field-approval')).toHaveLength(1);
    expect(panel()).toBeNull();
    expect(btn('조종 시작')).toBeUndefined();
  });

  it('목록을 다시 받기 전이라도 현장 승인이 만료되면 패널을 닫는다', async () => {
    serve(signedIn(LEE, [ON(new Date(Date.now() + 400).toISOString())]));
    await open('#/fleet', false);
    online();
    expect(panel()).not.toBeNull();
    await act(async () => { await new Promise((r) => setTimeout(r, 600)); });
    expect(panel()).toBeNull();
    expect($('[aria-label="로봇 상세"] [data-field-check]')!.textContent).toContain('현장 확인 다시 필요');   // 담당 운영 상세: 승인 칩은 현장 안전 확인 머리에 한 번
  });
});

describe('r1 — 총괄 실기 상세에는 «배정» 없음(시뮬은 로봇 탭에 없음 — TAB-SPLIT)', () => {
  it('실기 상세 «배정» 숨김, 시뮬 행은 목록에 없음', async () => {
    const SIM = robot('s-1', '창고 시뮬', LEE, { simulation: true });
    serve(signedIn(KIM, [RA, SIM]));
    await open('#/fleet', false);
    await click([...card('로봇 목록').querySelectorAll('button')].find((b) => b.textContent!.includes('Go2-A')));
    expect(card('로봇 상세').textContent).toContain('Go2-A');
    expect($('[aria-label="로봇 상세"] [data-assign-robot]')).toBeNull();
    expect(card('로봇 목록').textContent).not.toContain('창고 시뮬');
  });
});

describe('PC 웹 운영 관리자 — 담당 넘기기', () => {
  const CAND = 'GET /robots/r-a/owner-candidates';
  const cands = (items: { user_id: string; display_name: string }[]) => ({ status: 200, body: { items, next_cursor: null } });
  const transfer = () => card('내 로봇 관리').querySelector<HTMLElement>('[data-transfer]')!;
  const pick = (name: string) => act(() => { [...transfer().querySelectorAll<HTMLLabelElement>('label')].find((l) => l.textContent === name)!.querySelector('input')!.click(); });

  it('펼치면 후보 목록(라디오) → 고르기 → 같은 화면 확인(포커스 이동·취소) → 넘기기 PATCH {owner_user_id} 한 번 → 목록 다시 받아 «다른 로봇»으로', async () => {
    let moved = false;
    serve(signedIn(LEE, [RA], {
      [CAND]: cands([{ user_id: 'o2', display_name: '박운영' }, { user_id: 'o4', display_name: '정운영' }]),
      'PATCH /robots/r-a': () => { moved = true; return { status: 200, body: { ...RA, owner: { id: 'o2', display_name: '박운영' } } }; },
      'GET /robots': () => ({ status: 200, body: { items: [moved ? { ...RA, owner: { id: 'o2', display_name: '박운영' } } : RA], next_cursor: null } }),
    }));
    await open('#/fleet', false);
    expect(sent('GET', '/robots/r-a/owner-candidates?limit=100')).toHaveLength(0);   // 펼치기 전엔 부르지 않음
    const open1 = btn('담당 넘기기', transfer())!;
    expect(open1.getAttribute('aria-expanded')).toBe('false');
    await click(open1);
    expect(open1.getAttribute('aria-expanded')).toBe('true');
    expect(sent('GET', '/robots/r-a/owner-candidates?limit=100')).toHaveLength(1);
    const radios = [...transfer().querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios.map((x) => x.parentElement!.textContent)).toEqual(['박운영', '정운영']);
    expect(transfer().querySelector('legend')!.textContent).toBe('넘겨받을 운영 관리자');
    expect(btn('넘기기…', transfer())!.disabled).toBe(true);
    pick('박운영'); await flush();
    await click(btn('넘기기…', transfer()));
    const ask = card('담당 넘기기 확인');
    expect(document.activeElement).toBe(ask);
    expect(ask.textContent).toContain('Go2-A 담당을 박운영(으)로 넘길까요?');
    expect(ask.textContent).toContain('넘기면 이 로봇의 폰 출입증과 현장 승인이 풀리고, 조종·배정은 새 담당만 할 수 있습니다');
    await click(btn('취소', ask));
    expect($('[aria-label="담당 넘기기 확인"]')).toBeNull();
    expect(sent('PATCH', '/robots/r-a')).toHaveLength(0);
    await click(btn('넘기기…', transfer()));
    const go = btn('넘기기', card('담당 넘기기 확인'))!;
    const before = sent('GET', '/robots?scope=mine&limit=100').length;
    act(() => { go.click(); go.click(); });   // 같은 틱 두 번 누름
    await flush();
    expect(sent('PATCH', '/robots/r-a')).toHaveLength(1);
    expect(sent('PATCH', '/robots/r-a')[0].body).toEqual({ owner_user_id: 'o2' });
    expect(sent('GET', '/robots?scope=mine&limit=100').length).toBeGreaterThan(before);   // refresh
    expect($('[data-manage]')).toBeNull();   // 이제 담당 아님 — 관리·넘기기 사라짐
    expect($('[data-transfer]')).toBeNull();
  });

  it('후보 0명 = 안내, 목록 실패 = 서버 문구 + 다시 불러오기, 넘기기 실패 = 서버 문구 그대로', async () => {
    let list: Reply = cands([]);
    serve(signedIn(LEE, [RA], {
      [CAND]: () => list,
      'PATCH /robots/r-a': err(409, 'VERSION_CONFLICT', '조종 중인 로봇은 담당을 넘길 수 없습니다.'),
    }));
    await open('#/fleet', false);
    await click(btn('담당 넘기기', transfer()));
    expect(transfer().textContent).toContain('넘길 수 있는 운영 관리자가 없습니다');
    expect(transfer().querySelector('input[type="radio"]')).toBeNull();
    await click(btn('담당 넘기기', transfer()));   // 접기
    list = err(403, 'NOT_ROBOT_OWNER', '담당 로봇만 바꿀 수 있습니다.');
    await click(btn('담당 넘기기', transfer()));
    expect(transfer().querySelector('[role="alert"]')!.textContent).toBe('넘길 수 있는 운영 관리자 목록을 받지 못했습니다. 담당 로봇만 바꿀 수 있습니다.');
    list = cands([{ user_id: 'o2', display_name: '박운영' }]);
    await click(btn('다시 불러오기', transfer()));
    expect(transfer().querySelector('[role="alert"]')).toBeNull();
    pick('박운영'); await flush();
    await click(btn('넘기기…', transfer()));
    await click(btn('넘기기', card('담당 넘기기 확인')));
    expect(transfer().querySelector('[role="alert"]')!.textContent).toBe('조종 중인 로봇은 담당을 넘길 수 없습니다.');   // robotFail 의 지우기 문구로 바꾸지 않음
    expect(btn('넘기기', card('담당 넘기기 확인'))!.disabled).toBe(false);   // 다시 누를 수 있음
  });

  it('넘기기 응답 대기 중 내 로봇 A→B→A 로 다시 들어와도 «넘기는 중» 잠금 — 같은 로봇 두 번째 PATCH 0, 끝나면 풀림', async () => {
    const RB = robot('r-b', 'Go2-B', LEE);
    let answer = (_: Reply) => {};
    serve(signedIn(LEE, [RA, RB], {
      [CAND]: cands([{ user_id: 'o2', display_name: '박운영' }, { user_id: 'o4', display_name: '정운영' }]),
      'PATCH /robots/r-a': () => new Promise<Reply>((res) => { answer = res; }),
    }));
    await open('#/fleet', false);
    const pickRobot = (n: string) => click([...card('내 로봇 고르기').querySelectorAll('button')].find((b) => b.textContent!.includes(n)));
    await pickRobot('Go2-A');
    await click(btn('담당 넘기기', transfer()));
    pick('박운영'); await flush();
    await click(btn('넘기기…', transfer()));
    await click(btn('넘기기', card('담당 넘기기 확인')));
    expect(sent('PATCH', '/robots/r-a')).toHaveLength(1);
    await pickRobot('Go2-B');
    expect(card('로봇 상태').textContent).toContain('Go2-B');   // 집중 화면: 이름은 상태 한 줄(상세 제목은 «상세»)
    expect($('[data-transferring]')).toBeNull();   // 다른 로봇은 잠그지 않음
    expect(btn('담당 넘기기', transfer())!.disabled).toBe(false);
    await pickRobot('Go2-A');
    expect($('[data-transferring]')!.textContent).toBe('담당을 넘기는 중…');
    expect(btn('담당 넘기기', transfer())!.disabled).toBe(true);
    act(() => btn('담당 넘기기', transfer())!.click()); await flush();   // 꺼진 단추 — 아무 일 없음
    expect(sent('PATCH', '/robots/r-a')).toHaveLength(1);
    answer({ status: 409, body: { error: { code: 'VERSION_CONFLICT', message: '조종 중인 로봇은 담당을 넘길 수 없습니다.', detail: {} } } }); await flush();
    expect($('[data-transferring]')).toBeNull();
    expect(btn('담당 넘기기', transfer())!.disabled).toBe(false);
    await click(btn('담당 넘기기', transfer()));
    pick('정운영'); await flush();
    await click(btn('넘기기…', transfer()));
    await click(btn('넘기기', card('담당 넘기기 확인')));
    expect(sent('PATCH', '/robots/r-a')).toHaveLength(2);   // 앞 요청이 끝난 뒤엔 다시 넘길 수 있음
    answer({ status: 409, body: { error: { code: 'VERSION_CONFLICT', message: '-', detail: {} } } }); await flush();
  });

  it('시뮬 로봇·담당 아닌 실기·총괄에는 담당 넘기기 없음', async () => {
    const SIM = robot('s-1', '창고 시뮬', LEE, { simulation: true }), RP = robot('r-p', 'Go2-P', PARK);
    serve(signedIn(LEE, [SIM, RP]));
    await open('#/fleet', false);
    for (const n of ['창고 시뮬', 'Go2-P']) {
      const row = [...box.querySelectorAll('button')].find((b) => b.textContent!.includes(n));
      if (row) await click(row);
      expect($('[data-transfer]')).toBeNull();
      expect(btn('담당 넘기기')).toBeUndefined();
    }
    act(() => root?.unmount()); box.remove();
    serve(signedIn(KIM, [RA]));
    await open('#/fleet', false);
    await click([...card('로봇 목록').querySelectorAll('button')].find((b) => b.textContent!.includes('Go2-A')));
    expect(card('로봇 상세').textContent).toContain('Go2-A');
    expect($('[data-transfer]')).toBeNull();
    expect(btn('담당 넘기기')).toBeUndefined();
    expect(calls.some((c) => c.path.includes('owner-candidates'))).toBe(false);
  });
});
