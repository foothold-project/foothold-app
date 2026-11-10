// 설정 탭 계정 관리·내 정보(01 AU-01·02, 05 §2) — fetch 를 가짜 서버로 바꿔 총괄·운영 관리자 흐름과 409·401·403·429·네트워크 실패를 본다.
import { act } from 'react';
import { createRoot, type Root as ReactRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session, User } from '../../../contracts/ts';
import { HAS_ROBOTS, LAST_ADMIN, PW_DONE, SIM_MODELS, TAKEN, tempPassword } from '../screens/settings';
import { Root } from '../session';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KIM: User = { id: 'a1', username: 'kim', display_name: '김총괄', role: 'ORG_ADMIN', locked: false, robot_ids: [], created_at: '2026-10-19T00:00:00Z' };
const LEE: User = { ...KIM, id: 'o1', username: 'lee', display_name: '이운영', role: 'OPERATOR' };
const PARK: User = { ...KIM, id: 'o2', username: 'park', display_name: '박운영', role: 'OPERATOR', robot_ids: ['r1', 'r2'] };
const CHOI: User = { ...KIM, id: 'o3', username: 'choi', display_name: '최운영', role: 'OPERATOR', locked: true };
const LIMITS = { battery_low_pct: 20, run_min_battery_pct: 30, deviation_m: 1.5, lease_request_timeout_s: 10, link_loss_wait_s: 30 };
const later = new Date(Date.now() + 3600_000).toISOString(), past = new Date(Date.now() - 3600_000).toISOString();
const sess = (id: string, label: string, more: Partial<Session> = {}): Session => ({ id, client: 'web', device_label: label, created_at: past, last_seen_at: past, expires_at: later, revoked_at: null, ...more });
const err = (status: number, code: string, message: string) => ({ status, body: { error: { code, message, detail: {} } } });

type Reply = { status: number; body?: unknown };
type Call = { method: string; path: string; headers: Record<string, string>; body?: unknown };
let calls: Call[] = [], routes: Record<string, Reply | (() => Reply | Promise<Reply>)> = {};
/** 가짜 서버: '<METHOD> <경로(쿼리 제외)>' → 응답. 함수가 throw 하면 네트워크 실패, Promise 면 그때까지 답을 쥠(취소 신호는 무시 — 늦은 답 재현) */
function serve(r: typeof routes) {
  routes = r; calls = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET', path = url.replace(/^\/api\/v1/, '');
    calls.push({ method, path, headers: { ...(init.headers as Record<string, string>) }, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const hit = routes[`${method} ${path.split('?')[0]}`], rep = typeof hit === 'function' ? await hit() : hit ?? err(404, 'NOT_FOUND', '찾을 수 없습니다.');
    return new Response(rep.status === 204 ? null : JSON.stringify(rep.body), { status: rep.status, headers: { 'Content-Type': 'application/json' } });
  });
}
const signedIn = (me: User, more: typeof routes = {}) => ({
  'GET /auth/session': { status: 200, body: { client: 'web', csrf_token: 'csrf-1' } },
  'GET /me': { status: 200, body: me },
  'GET /robots': { status: 200, body: { items: [], next_cursor: null } },
  'GET /org/settings': { status: 200, body: LIMITS },
  'GET /users': { status: 200, body: { items: [KIM, LEE, PARK, CHOI], next_cursor: null } },
  ...more,
});
const sent = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);

let root: ReactRoot | null = null, box: HTMLDivElement;
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); });
async function open() {
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  location.hash = '#/settings';
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<Root />); });
  await flush();
}
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); vi.unstubAllGlobals(); });

const $ = <T extends Element = HTMLElement>(s: string, from: ParentNode = box) => from.querySelector<T>(s);
const btn = (t: string, from: ParentNode = box) => [...from.querySelectorAll('button')].find((b) => b.textContent === t) as HTMLButtonElement | undefined;
const card = (label: string) => $(`[aria-label="${label}"]`)!;
const setVal = (el: HTMLInputElement | HTMLSelectElement, v: string) => act(() => {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!.call(el, v);
  el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
});
const submit = async (form: Element) => { act(() => { (form as HTMLFormElement).requestSubmit(); }); await flush(); };
const click = async (b: HTMLButtonElement | undefined) => { expect(b).toBeDefined(); act(() => b!.click()); await flush(); };
/** 계정 목록에서 이름으로 골라 상세 열기 */
const pick = (name: string) => click([...card('계정').querySelectorAll('li button')].find((b) => b.textContent!.includes(name)) as HTMLButtonElement);

describe('총괄 — 계정 관리', () => {
  it('목록: 이름·아이디·역할·잠김·담당 로봇 수, 나 표시', async () => {
    serve(signedIn(KIM));
    await open();
    const rows = [...card('계정').querySelectorAll('li')].map((li) => li.textContent);
    expect(rows).toEqual(['김총괄 kim총괄 · 나로봇 0대', '이운영 lee운영 관리자로봇 0대', '박운영 park운영 관리자로봇 2대', '최운영 choi운영 관리자■잠김로봇 0대']);
    expect($('h2', card('계정'))!.textContent).toBe('계정 (4)');
  });

  it('만들기: 임시 비밀번호를 서버에 보내고 한 번만 보임(닫으면 사라짐)', async () => {
    const NEW: User = { ...LEE, id: 'o9', username: 'jung', display_name: '정운영' };
    serve(signedIn(KIM, { 'POST /users': { status: 201, body: NEW } }));
    await open();
    await click(btn('새 계정'));
    const f = card('새 계정');
    setVal($('input[name="username"]', f)!, ' jung ');
    setVal($('input[name="display_name"]', f)!, '정운영');
    await submit(f);
    const [post] = sent('POST', '/users'), body = post.body as { temp_password: string };
    expect(post.headers['X-FH-CSRF']).toBe('csrf-1');
    expect(body).toEqual({ username: 'jung', display_name: '정운영', role: 'OPERATOR', temp_password: body.temp_password });
    expect(body.temp_password).toMatch(/^[A-HJ-NP-Za-km-np-z2-9]{12}$/);
    expect($<HTMLInputElement>('input[aria-label="임시 비밀번호"]')!.value).toBe(body.temp_password);
    expect(card('계정').textContent).toContain('정운영(jung) 계정을 만들었습니다');
    expect($('h2', card('계정'))!.textContent).toBe('계정 (5)');
    expect(card('계정 상세').textContent).toContain('정운영');   // 만든 계정을 바로 고름
    await click(btn('닫기', card('임시 비밀번호')));
    expect(box.innerHTML).not.toContain(body.temp_password);
  });

  it('만들기: 빈 칸은 보내지 않음, 아이디 중복 409 는 쉬운 문구', async () => {
    serve(signedIn(KIM, { 'POST /users': err(409, 'VERSION_CONFLICT', '같은 값이 있거나 상태가 바뀌었습니다.') }));
    await open();
    await click(btn('새 계정'));
    await submit(card('새 계정'));
    expect(card('새 계정').textContent).toContain('아이디와 이름을 입력하세요.');
    expect(sent('POST', '/users')).toHaveLength(0);
    setVal($('input[name="username"]', card('새 계정'))!, 'lee');
    setVal($('input[name="display_name"]', card('새 계정'))!, '이둘');
    setVal($('select[name="role"]', card('새 계정'))!, 'ORG_ADMIN');
    await submit(card('새 계정'));
    expect((sent('POST', '/users')[0].body as { role: string }).role).toBe('ORG_ADMIN');
    expect($('[role="alert"]', card('새 계정'))!.textContent).toBe(TAKEN);
    expect($('[aria-label="임시 비밀번호"]')).toBeNull();
  });

  it('이름·역할 바꾸기: 바뀐 칸만 보냄', async () => {
    serve(signedIn(KIM, { 'PATCH /users/o1': { status: 200, body: { ...LEE, display_name: '이총괄', role: 'ORG_ADMIN' } }, 'GET /users/o1/sessions': { status: 200, body: { items: [], next_cursor: null } } }));
    await open();
    await pick('이운영');
    const d = card('계정 상세');
    await submit($('form', d)!);
    expect(d.textContent).toContain('바뀐 값이 없습니다.');
    setVal($('input[name="display_name"]', d)!, '이총괄');
    setVal($('select[name="role"]', d)!, 'ORG_ADMIN');
    await submit($('form', d)!);
    expect(sent('PATCH', '/users/o1').map((c) => c.body)).toEqual([{ display_name: '이총괄', role: 'ORG_ADMIN' }]);
    expect(card('계정').textContent).toContain('이총괄 lee총괄');
    expect(d.textContent).toContain('저장했습니다.');
  });

  it('잠그기: 확인 뒤 보냄 → 잠김 표시, 기기 목록 다시 받음 / 잠금 풀기', async () => {
    let locked = false;
    serve(signedIn(KIM, {
      'PATCH /users/o1': () => { locked = !locked; return { status: 200, body: { ...LEE, locked } }; },
      'GET /users/o1/sessions': () => ({ status: 200, body: { items: locked ? [] : [sess('s1', '웹 브라우저')], next_cursor: null } }),
    }));
    await open();
    await pick('이운영');
    expect(card('로그인 기기').textContent).toContain('로그인 기기 (1)');
    await click(btn('잠그기'));
    expect(sent('PATCH', '/users/o1')).toHaveLength(0);   // 아직 확인 전
    await click(btn('잠그기', card('확인')));
    expect(sent('PATCH', '/users/o1').map((c) => c.body)).toEqual([{ locked: true }]);
    expect(card('계정 상세').textContent).toContain('잠갔습니다.');
    expect(card('계정').textContent).toContain('이운영 lee운영 관리자■잠김');
    expect(card('로그인 기기').textContent).toContain('로그인한 기기가 없습니다.');
    await click(btn('잠금 풀기'));
    expect(sent('PATCH', '/users/o1').map((c) => c.body)).toEqual([{ locked: true }, { locked: false }]);
  });

  it('잠그기 409 LAST_ORG_ADMIN → 마지막 총괄 문구', async () => {
    const BAE: User = { ...KIM, id: 'a2', username: 'bae', display_name: '배총괄' };
    serve(signedIn(KIM, { 'GET /users': { status: 200, body: { items: [KIM, BAE], next_cursor: null } }, 'GET /users/a2/sessions': { status: 200, body: { items: [], next_cursor: null } },
      'PATCH /users/a2': err(409, 'LAST_ORG_ADMIN', '마지막 총괄 계정은 강등·잠금·삭제할 수 없습니다.') }));
    await open();
    await pick('배총괄');
    await click(btn('잠그기'));
    await click(btn('잠그기', card('확인')));
    expect($('[role="alert"]', card('계정 상세'))!.textContent).toBe(LAST_ADMIN);
    expect(card('계정').textContent).not.toContain('잠김');
  });

  it('지우기: 확인 뒤 DELETE → 목록에서 빠짐, 취소하면 안 보냄', async () => {
    serve(signedIn(KIM, { 'DELETE /users/o1': { status: 204 }, 'GET /users/o1/sessions': { status: 200, body: { items: [], next_cursor: null } } }));
    await open();
    await pick('이운영');
    await click(btn('지우기'));
    await click(btn('취소', card('확인')));
    expect($('[aria-label="확인"]')).toBeNull();
    await click(btn('지우기'));
    await click(btn('지우기', card('확인')));
    expect(sent('DELETE', '/users/o1')).toHaveLength(1);
    expect($('ul', card('계정'))!.textContent).not.toContain('이운영');
    expect(card('계정').textContent).toContain('이운영 계정을 지웠습니다.');
    expect($('[aria-label="계정 상세"]')).toBeNull();
  });

  it('지우기 409 VERSION_CONFLICT(목록이 낡아 담당 로봇을 모름) → 담당 로봇 문구', async () => {
    serve(signedIn(KIM, { 'DELETE /users/o1': err(409, 'VERSION_CONFLICT', '담당 로봇을 먼저 변경하세요.'), 'GET /users/o1/sessions': { status: 200, body: { items: [], next_cursor: null } } }));
    await open();
    await pick('이운영');
    await click(btn('지우기'));
    await click(btn('지우기', card('확인')));
    expect($('[role="alert"]', card('계정 상세'))!.textContent).toBe(HAS_ROBOTS);
    expect(card('계정').textContent).toContain('이운영');
  });

  it('담당 로봇이 있는 계정: 지우기 비활성 + 이유', async () => {
    serve(signedIn(KIM, { 'GET /users/o2/sessions': { status: 200, body: { items: [], next_cursor: null } } }));
    await open();
    await pick('박운영');
    expect(btn('지우기')!.disabled).toBe(true);
    expect($('#why-del')!.textContent).toBe(HAS_ROBOTS);
    expect(btn('잠그기')!.disabled).toBe(false);
  });

  it('내 계정: 잠그기·지우기 막힘 + 이유(두 단추 모두 why-self), 이름·역할 편집기 없음', async () => {
    serve(signedIn(KIM, { 'GET /users/a1/sessions': { status: 200, body: { items: [], next_cursor: null } } }));
    await open();
    await pick('김총괄');
    const d = card('계정 상세');
    expect([btn('잠그기', d)!.disabled, btn('지우기', d)!.disabled]).toEqual([true, true]);
    expect([$('form', d), $('select', d)]).toEqual([null, null]);
    expect(d.textContent).toContain('내 이름은 위 «내 정보»에서 바꿉니다.');
    expect($('#why-self')!.textContent).toContain('내 계정은 잠그거나 지우거나 역할을 바꿀 수 없습니다');
    expect([btn('잠그기', d)!.getAttribute('aria-describedby'), btn('지우기', d)!.getAttribute('aria-describedby')]).toEqual(['why-self', 'why-self']);
    expect($('#why-del')).toBeNull();
  });

  it('B2 내 이름은 «내 정보» 한 곳에서: 바꾸고 되돌리기 왕복 — PATCH /me 만, 바뀐 칸만, 목록·상세·머리줄 같은 값', async () => {
    serve(signedIn(KIM, { 'GET /users/a1/sessions': { status: 200, body: { items: [], next_cursor: null } },
      'PATCH /me': () => ({ status: 200, body: { ...KIM, ...(calls[calls.length - 1].body as object) } }) }));
    await open();
    await pick('김총괄');
    const f = $('form', card('내 정보'))!, name = () => $<HTMLInputElement>('input[name="display_name"]', f)!;
    for (const v of ['김대표', '김총괄']) {
      setVal(name(), v);
      await submit(f);
      expect([$('.fh-me')!.textContent, $('h2', card('계정 상세'))!.textContent, name().value]).toEqual([`${v}(총괄)`, v, v]);
      expect(card('계정').querySelector('li b')!.textContent).toBe(v);
    }
    await submit(f);   // 그대로면 안 보냄
    expect(sent('PATCH', '/me').map((c) => c.body)).toEqual([{ display_name: '김대표' }, { display_name: '김총괄' }]);
    expect(calls.filter((c) => c.method === 'PATCH' && c.path.startsWith('/users'))).toEqual([]);
  });

  it('기기 목록: 지금 쓰는 기기만, 로그아웃시키기 → 확인 → DELETE 후 다시 받음', async () => {
    let ended = false;
    serve(signedIn(KIM, {
      'GET /users/o1/sessions': () => ({ status: 200, body: { items: [sess('s1', '웹 브라우저', ended ? { revoked_at: past } : {}), sess('s2', '현장 폰', { client: 'app' }),
        sess('s3', '옛 노트북', { revoked_at: past }), sess('s4', '만료된 폰', { expires_at: past })], next_cursor: null } }),
      'DELETE /users/o1/sessions/s1': () => { ended = true; return { status: 204 }; },
    }));
    await open();
    await pick('이운영');
    const list = () => [...card('로그인 기기').querySelectorAll('li b')].map((b) => b.textContent);
    expect(list()).toEqual(['웹 브라우저', '현장 폰']);
    expect(card('로그인 기기').textContent).toContain('앱');
    await click(btn('로그아웃시키기', card('로그인 기기').querySelector('li')!));
    expect(sent('DELETE', '/users/o1/sessions/s1')).toHaveLength(0);   // 확인 전에는 보내지 않음
    expect(card('확인').textContent).toContain('이운영의 «웹 브라우저» 로그인을 끝낼까요?');
    await click(btn('취소', card('확인')));
    expect(sent('DELETE', '/users/o1/sessions/s1')).toHaveLength(0);
    await click(btn('로그아웃시키기', card('로그인 기기').querySelector('li')!));
    await click(btn('로그아웃시키기', card('확인')));
    expect(sent('DELETE', '/users/o1/sessions/s1')).toHaveLength(1);
    expect(list()).toEqual(['현장 폰']);
    expect(card('로그인 기기').textContent).toContain('웹 브라우저 로그인을 끝냈습니다.');
  });

  it('목록 403(권한이 바뀜) → 서버 문장, 401 → 로그인 화면', async () => {
    serve(signedIn(KIM, { 'GET /users': err(403, 'FORBIDDEN', '권한이 없습니다.') }));
    await open();
    expect($('[role="alert"]', card('계정'))!.textContent).toBe('권한이 없습니다.');
    act(() => root!.unmount()); box.remove();
    serve(signedIn(KIM, { 'GET /users': err(401, 'AUTH_REQUIRED', '로그인이 필요합니다.') }));
    await open();
    expect($('[aria-label="로그인"]')).not.toBeNull();
    expect(box.textContent).toContain('로그인이 끝났습니다');
  });

  it('저장 중 네트워크 실패 → 네트워크 문구, 목록은 그대로', async () => {
    serve(signedIn(KIM, { 'PATCH /users/o1': () => { throw new TypeError('Failed to fetch'); }, 'GET /users/o1/sessions': { status: 200, body: { items: [], next_cursor: null } } }));
    await open();
    await pick('이운영');
    setVal($('input[name="display_name"]', card('계정 상세'))!, '이둘');
    await submit($('form', card('계정 상세'))!);
    expect($('[role="alert"]', card('계정 상세'))!.textContent).toContain('서버에 연결하지 못했습니다');
    expect(card('계정').textContent).toContain('이운영 lee');
  });
});

describe('설정 탭 묶음(11-02 공통·실기·시뮬·계정)', () => {
  const ORG = { ...LIMITS, sim_max_vx: 0.5, sim_min_vx: 0.2, sim_max_vy: 0.3, sim_max_wz: 0.5, sim_key_vx: 0.4, stick_deadzone: 0.1, sim_runner_vx: 0.4, sim_runner_wz: 0.6, lidar_view_m: 12, real_no_fast_server_drive: false };
  const tabs = () => [...box.querySelectorAll<HTMLButtonElement>('[role="tablist"] [role="tab"]')];
  const panel = (name: string) => document.getElementById(tabs().find((t) => t.textContent === name)!.getAttribute('aria-controls')!)!;
  const key = (el: Element, k: string) => act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); });
  it('탭 4개(tablist), 처음 공통, 칸 자리: 공통=조직 기준값, 실기=조종권·서버 경유 스위치, 시뮬=시뮬 값·시뮬 로봇, 계정=내 정보·계정 — 알림 없음', async () => {
    serve(signedIn(KIM, { 'GET /org/settings': { status: 200, body: ORG } }));
    await open();
    expect(tabs().map((t) => [t.textContent, t.getAttribute('aria-selected'), t.tabIndex])).toEqual([['공통', 'true', 0], ['실기', 'false', -1], ['시뮬', 'false', -1], ['계정', 'false', -1]]);
    expect(['공통', '실기', '시뮬', '계정'].map((n) => panel(n).hidden)).toEqual([false, true, true, true]);
    const names = (n: string) => [...panel(n).querySelectorAll('input[name]')].map((i) => i.getAttribute('name'));
    expect(names('공통')).toEqual(['battery_low_pct', 'run_min_battery_pct', 'deviation_m']);
    expect(names('실기')).toEqual(['lease_request_timeout_s', 'link_loss_wait_s', 'real_max_vx', 'real_max_vx_back', 'real_max_vy', 'real_max_wz', 'real_no_fast_server_drive']);
    expect(names('시뮬')).toEqual(['sim_max_vx', 'sim_min_vx', 'sim_max_vy', 'sim_max_wz', 'sim_key_vx', 'stick_deadzone', 'sim_runner_vx', 'sim_runner_wz', 'lidar_view_m']);
    expect(panel('시뮬').querySelector('[aria-label="로봇"]')).not.toBeNull();
    expect(panel('계정').querySelector('[aria-label="내 정보"]')).not.toBeNull();
    expect(panel('계정').querySelector('[aria-label="계정"]')).not.toBeNull();
    expect($('main')!.textContent).not.toContain('알림');   // 머리줄 종은 설정 화면 밖
    expect(panel('실기').textContent).toContain('켜면 서버 경유 1.5 m/s 이동을 받지 않고 STOP');
    // 키: → 다음(초점도), End 끝, ← 끝에서 앞, Home 처음
    key(tabs()[0], 'ArrowRight');
    expect(tabs()[1].getAttribute('aria-selected')).toBe('true'); expect(document.activeElement).toBe(tabs()[1]); expect(panel('실기').hidden).toBe(false); expect(panel('공통').hidden).toBe(true);
    key(tabs()[1], 'End'); expect(tabs()[3].getAttribute('aria-selected')).toBe('true');
    key(tabs()[3], 'ArrowRight'); expect(tabs()[0].getAttribute('aria-selected')).toBe('true');
    key(tabs()[0], 'ArrowLeft'); expect(tabs()[3].getAttribute('aria-selected')).toBe('true');
    key(tabs()[3], 'Home'); expect(tabs()[0].getAttribute('aria-selected')).toBe('true');
    await click(tabs()[2]);
    expect(panel('시뮬').hidden).toBe(false);
    expect(location.hash).toBe('#/settings');   // 고른 탭은 주소가 아니라 화면 상태
  });
  it('최대·키보드·임무 실행기 전진 상한은 1.5, AME-2 속도 보장 아님을 안내', async () => {
    serve(signedIn(KIM, { 'GET /org/settings': { status: 200, body: ORG }, 'PATCH /org/settings': { status: 200, body: { ...ORG, sim_max_vx: 1.5 } } }));
    await open();
    for (const name of ['sim_max_vx', 'sim_key_vx', 'sim_runner_vx']) {
      const input = $<HTMLInputElement>(`input[name="${name}"]`)!;
      expect(input.max).toBe('1.5');
      setVal(input, '1.5');
      expect(input.validity.rangeOverflow).toBe(false);
      if (input.type === 'number') {
        setVal(input, '1.51');
        expect(input.validity.rangeOverflow).toBe(true);
      }
    }
    const cap = card('시뮬 속도 상한');
    expect(cap.textContent).toContain('AME-2는 위치 목표 정책');
    await submit($('form', cap)!);
    expect(sent('PATCH', '/org/settings')[0].body).toEqual({ sim_max_vx: 1.5 });
  });
  it('시뮬 옆 0.5·회전 1.2까지 저장하고 기존 저장값을 그대로 표시', async () => {
    serve(signedIn(KIM, { 'GET /org/settings': { status: 200, body: ORG },
      'PATCH /org/settings': { status: 200, body: { ...ORG, sim_max_vy: .5, sim_max_wz: 1.2 } } }));
    await open();
    const cap = card('시뮬 속도 상한');
    for (const [name, old, max] of [['sim_max_vy', '0.3', '0.5'], ['sim_max_wz', '0.5', '1.2']]) {
      const input = $<HTMLInputElement>(`input[name="${name}"]`, cap)!;
      expect(input.value).toBe(old); expect(input.max).toBe(max);
      setVal(input, max); expect(input.validity.valid).toBe(true);
    }
    expect(cap.textContent).toContain('기본 0.5'); expect(cap.textContent).toContain('기본 1.2');
    await submit($('form', cap)!);
    expect(sent('PATCH', '/org/settings')[0].body).toEqual({ sim_max_vy: .5, sim_max_wz: 1.2 });
  });
  it('실기 속도 4칸은 총괄이 0까지 저장', async () => {
    serve(signedIn(KIM, { 'GET /org/settings': { status: 200, body: ORG },
      'PATCH /org/settings': { status: 200, body: { ...ORG, real_max_vx: 0, real_max_vx_back: .5, real_max_vy: .2, real_max_wz: .3 } } }));
    await open();
    const cap = card('속도 제한');
    expect(cap.textContent).toContain('실기 미검증');
    expect(cap.textContent).toContain('로봇 쪽 상한보다 높게 넣어도 로봇 상한까지만');
    for (const [name, value, max] of [['real_max_vx', '0', '1.5'], ['real_max_vx_back', '.5', '1.5'], ['real_max_vy', '.2', '1'], ['real_max_wz', '.3', '4']]) {
      const input = $<HTMLInputElement>(`input[name="${name}"]`, cap)!;
      expect(input.min).toBe('0'); expect(input.max).toBe(max); expect(input.disabled).toBe(false);
      setVal(input, value);
    }
    await submit($('form', cap)!);                                              // 실기 값: 먼저 바뀌는 값을 보이고 아직 안 보냄
    expect(sent('PATCH', '/org/settings')).toEqual([]);
    expect($('[data-save-check]', cap)!.textContent).toContain('→ 0 m/s');
    expect([...cap.querySelectorAll('button')].map((x) => x.textContent)).toContain('이대로 저장');
    await submit($('form', cap)!);
    expect(sent('PATCH', '/org/settings')[0].body).toEqual({ real_max_vx: 0, real_max_vx_back: .5, real_max_vy: .2, real_max_wz: .3 });
    expect($('[data-save-check]', cap)).toBeNull();
  });
  it('실기 저장 확인: 값 바꾸면 확인 풀림·취소는 값 유지·실패 뒤 재확인·빈 칸은 칸 옆 오류·원래 값이면 안 보냄', async () => {
    const MSG = '잘못된 값입니다.';
    serve(signedIn(KIM, { 'GET /org/settings': { status: 200, body: ORG }, 'PATCH /org/settings': err(422, 'VALIDATION', MSG) }));
    await open();
    const c = card('속도 제한'), f = $('form', c)!, inp = $<HTMLInputElement>('input[name="real_max_vx"]', c)!, old = inp.value;
    const check = () => $('[data-save-check]', c)?.textContent ?? null;
    setVal(inp, '0.3'); await submit(f);
    expect(check()).toContain('→ 0.3 m/s');
    setVal(inp, '0.4');                                                         // 확인 뒤 값을 바꾸면 확인이 풀리고 다시 확인부터
    expect(check()).toBeNull();
    await submit(f); expect(check()).toContain('→ 0.4 m/s');
    act(() => [...c.querySelectorAll('button')].find((b) => b.textContent === '취소')!.click());
    expect([check(), inp.value]).toEqual([null, '0.4']);                        // 취소: 확인만 닫고 입력은 둔다
    expect(sent('PATCH', '/org/settings')).toEqual([]);
    await submit(f); await submit(f);                                           // 확인 → 보냄 → 422
    expect(sent('PATCH', '/org/settings').map((x) => x.body)).toEqual([{ real_max_vx: 0.4 }]);
    expect([check(), inp.value]).toEqual([null, '0.4']);
    await submit(f);                                                            // 다시 누르면 다시 확인부터(바로 안 보냄)
    expect(sent('PATCH', '/org/settings')).toHaveLength(1);
    expect(check()).toContain('→ 0.4 m/s');
    setVal(inp, ''); await submit(f);                                           // 빈 칸: «→ NaN» 확인 대신 칸 옆 오류
    expect(check()).toBeNull();
    expect(document.getElementById(inp.getAttribute('aria-describedby')!.split(' ')[0])!.textContent).toContain('값을 입력하세요');
    setVal(inp, old); await submit(f);                                          // 원래 값으로 되돌리면 안 보냄
    expect([check(), sent('PATCH', '/org/settings').length]).toEqual([null, 1]);
    expect(c.textContent).toContain('바뀐 값이 없습니다');
  });
  it('실기 «서버 경유 빠른 이동 끄기»: 바꾼 칸만 PATCH(true)', async () => {
    serve(signedIn(KIM, { 'GET /org/settings': { status: 200, body: ORG }, 'PATCH /org/settings': { status: 200, body: { ...ORG, real_no_fast_server_drive: true } } }));
    await open();
    const c = card('속도 제한'), sw = $<HTMLInputElement>('input[name="real_no_fast_server_drive"]', c)!;
    expect([sw.checked, sw.disabled, sw.getAttribute('role')]).toEqual([false, false, 'switch']);
    act(() => sw.click());
    await submit($('form', c)!);
    expect($('[data-save-check]', c)!.textContent).toContain('끔 → 켬');
    await submit($('form', c)!);
    expect(sent('PATCH', '/org/settings').map((x) => x.body)).toEqual([{ real_no_fast_server_drive: true }]);
    expect(sw.checked).toBe(true);
    expect($('[role="status"]', c)!.textContent).toContain('저장했습니다');
  });
  it('시뮬 값 교차 검사 422 → 서버 문구를 그 칸 옆에(aria-describedby), 다른 칸 값은 그대로', async () => {
    const MSG = '시뮬 키보드 전진 속도는 최대 전진 속도 이하여야 합니다.';
    serve(signedIn(KIM, { 'GET /org/settings': { status: 200, body: ORG }, 'PATCH /org/settings': err(422, 'VALIDATION', MSG) }));
    await open();
    const c = card('조종 입력·임무 실행기'), inp = $<HTMLInputElement>('input[name="sim_key_vx"]', c)!;
    setVal(inp, '0.9');
    await submit($('form', c)!);
    expect(sent('PATCH', '/org/settings')[0].body).toEqual({ sim_key_vx: 0.9 });
    const why = document.getElementById(inp.getAttribute('aria-describedby')!)!;
    expect([why.textContent, why.getAttribute('role'), inp.getAttribute('aria-invalid')]).toEqual([MSG, 'alert', 'true']);
    expect(inp.closest('label')!.contains(why)).toBe(true);
    // 최대 전진을 낮춰 걸린 경우는 «시뮬 속도 상한» 카드의 최대 전진 칸 옆
    const cap = card('시뮬 속도 상한'), max = $<HTMLInputElement>('input[name="sim_max_vx"]', cap)!;
    expect(max.type).toBe('range');
    setVal(max, '0.3');
    await submit($('form', cap)!);
    expect(document.getElementById(max.getAttribute('aria-describedby')!)!.textContent).toBe(MSG);
    expect(inp.value).toBe('0.9');
  });
  it('운영 관리자: 네 탭 모두 보기만(숫자 readOnly·막대·스위치 비활성·저장 비활성 + 같은 이유), PATCH 0, 계정·시뮬 로봇 숨김', async () => {
    serve(signedIn(LEE, { 'GET /org/settings': { status: 200, body: ORG } }));
    await open();
    expect(tabs().map((t) => t.textContent)).toEqual(['공통', '실기', '시뮬', '계정']);
    const inputs = [...box.querySelectorAll<HTMLInputElement>('[role="tabpanel"] form input[name]')].filter((i) => !['display_name', 'current', 'next', 'again'].includes(i.name));
    expect(inputs).toHaveLength(19);
    for (const i of inputs) expect(i.type === 'number' ? i.readOnly : i.disabled, i.name).toBe(true);
    const saves = [...box.querySelectorAll<HTMLButtonElement>('[role="tabpanel"] button')].filter((b) => b.textContent === '저장');
    expect(saves).toHaveLength(6);
    for (const b of saves) { expect(b.disabled).toBe(true); expect(document.getElementById(b.getAttribute('aria-describedby')!)!.textContent).toBe('조직 기준값은 총괄 운영 관리자만 바꿀 수 있습니다.'); }
    expect($('[aria-label="계정"]')).toBeNull();
    expect($('[aria-label="로봇"]')).toBeNull();
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });
});

describe('모델별 시뮬 값(11-04 model_overrides)', () => {
  const ORG = { ...LIMITS, sim_max_vx: 0.5, sim_min_vx: 0.2, sim_max_vy: 0.3, sim_max_wz: 0.5, sim_key_vx: 0.4, stick_deadzone: 0.1, sim_runner_vx: 0.4, sim_runner_wz: 0.6, lidar_view_m: 12, real_no_fast_server_drive: false, model_overrides: {} };
  const AME = { sim_max_vx: 0.3, sim_min_vx: 0.1 };
  const withAme = { ...ORG, model_overrides: { 'ame2-demo': AME } };
  const PATCH = 'PATCH /org/settings';
  const panel = (name: string) => document.getElementById([...box.querySelectorAll('[role="tab"]')].find((t) => t.textContent === name)!.getAttribute('aria-controls')!)!;
  const chips = () => [...box.querySelectorAll<HTMLButtonElement>('[aria-label="값을 고칠 모델"] button')];
  const chip = (name: string) => click(chips().find((b) => b.textContent === name));
  const scope = (id: string) => $<HTMLElement>(`[data-model="${id}"]`)!;
  const field = (id: string, name: string) => $<HTMLInputElement>(`input[name="${name}"]`, scope(id))!;
  const tag = (id: string, name: string) => document.getElementById(`st-o-${id}-${name}`)!.textContent;
  const form = (id: string, label: string) => $('form', $(`[aria-label="${label}"]`, scope(id))!)!;

  it('고르는 모델은 등록부(mobile/sim)의 조종 가능한 정식 id 와 같음, 보기 전용 go2-demo 는 없음', () => {
    const src = Object.values(import.meta.glob('../../../../mobile/sim/{policy-adapters,ame2-adapter,start-demo-adapter}.js', { query: '?raw', eager: true, import: 'default' })).join();
    for (const [id] of SIM_MODELS) expect(src).toContain(`id: '${id}'`);
    expect(SIM_MODELS.map(([id]) => id)).not.toContain('go2-demo');
  });
  it('시뮬 탭: 공통 + 세 모델, 처음엔 공통 화면 그대로 / 실기 탭: «공통»만 + «모델별 값 없음»', async () => {
    serve(signedIn(KIM, { 'GET /org/settings': { status: 200, body: ORG } }));
    await open();
    expect(chips().map((b) => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([['공통', 'true'], ['nvidia', 'false'], ['AME-2', 'false'], ['start', 'false']]);
    expect($('[data-model]')).toBeNull();
    expect(panel('실기').textContent).toContain('실기에서 도는 모델이 하나뿐이라 모델별 값 없음');
    expect([...panel('실기').querySelectorAll('[aria-label="실기 값을 고칠 모델"] button')].map((b) => b.textContent)).toEqual(['공통']);
    expect(panel('시뮬').textContent).not.toContain('공통 값 사용');
  });
  it('모델 고르기: 같은 9칸, 안 바꾼 칸은 «공통 값 사용(값)», 덮어쓴 칸은 그 모델 값 + 되돌리기, 모델 선택과 무관한 공통 값은 숨김', async () => {
    serve(signedIn(KIM, { 'GET /org/settings': { status: 200, body: withAme } }));
    await open();
    await chip('AME-2');
    expect(chips()[2].getAttribute('aria-pressed')).toBe('true');
    expect([...scope('ame2-demo').querySelectorAll('input[name]')].map((i) => i.getAttribute('name'))).toEqual(['sim_max_vx', 'sim_min_vx', 'sim_max_vy', 'sim_max_wz', 'sim_key_vx', 'stick_deadzone', 'sim_runner_vx', 'sim_runner_wz', 'lidar_view_m']);
    expect(field('ame2-demo', 'sim_max_vx').value).toBe('0.3');
    expect(tag('ame2-demo', 'sim_max_vx')).toBe('이 모델 값');
    expect(field('ame2-demo', 'sim_max_vy').value).toBe('0.3');
    expect(tag('ame2-demo', 'sim_max_vy')).toBe('공통 값 사용(0.3 m/s)');
    expect(tag('ame2-demo', 'lidar_view_m')).toBe('공통 값 사용(12 m)');
    expect(btn('공통으로 되돌리기', $('[aria-label="시뮬 속도 상한"]', scope('ame2-demo'))!)).toBeDefined();
    expect(btn('공통으로 되돌리기', $('[aria-label="표시"]', scope('ame2-demo'))!)).toBeUndefined();
    expect(($('.st-scope:not([data-model])') as HTMLElement).hidden).toBe(true);
    await chip('공통');
    expect(scope('ame2-demo').hidden).toBe(true);
    expect(($('input[name="sim_max_vx"]', panel('시뮬')) as HTMLInputElement).value).toBe('0.5');
  });
  it('덮어쓰기: 그 모델의 바뀐 칸만 PATCH(공통 칸 없음), 다른 모델로 갔다 와도 쓰던 칸 유지', async () => {
    const next = { ...ORG, model_overrides: { 'nvidia-demo': { sim_key_vx: 0.45 } } };
    serve(signedIn(KIM, { 'GET /org/settings': { status: 200, body: ORG }, [PATCH]: { status: 200, body: next } }));
    await open();
    await chip('nvidia');
    setVal(field('nvidia-demo', 'sim_key_vx'), '0.45');
    expect(tag('nvidia-demo', 'sim_key_vx')).toBe('이 모델 값 · 저장 전');
    await chip('start');
    expect(field('start-demo', 'sim_key_vx').value).toBe('0.4');
    await chip('nvidia');
    expect(field('nvidia-demo', 'sim_key_vx').value).toBe('0.45');
    await submit(form('nvidia-demo', '조종 입력·임무 실행기'));
    expect(sent('PATCH', '/org/settings').map((c) => c.body)).toEqual([{ model_overrides: { 'nvidia-demo': { sim_key_vx: 0.45 } } }]);
    expect(tag('nvidia-demo', 'sim_key_vx')).toBe('이 모델 값');
    expect(tag('start-demo', 'sim_key_vx')).toBe('공통 값 사용(0.4 m/s)');
  });
  it('공통 값과 같은 값을 쳐 넣으면 공통 값 사용 그대로, 보내지 않음', async () => {
    serve(signedIn(KIM, { 'GET /org/settings': { status: 200, body: ORG } }));
    await open();
    await chip('start');
    setVal(field('start-demo', 'sim_key_vx'), '0.4');
    expect(tag('start-demo', 'sim_key_vx')).toBe('공통 값 사용(0.4 m/s)');
    await submit(form('start-demo', '조종 입력·임무 실행기'));
    expect(sent('PATCH', '/org/settings')).toHaveLength(0);
  });
  it('되돌리기: 저장 전엔 공통 값이 보이고, 저장하면 null PATCH — 두 칸을 한 번에 보냄, 공통 값 사용으로 돌아감', async () => {
    serve(signedIn(KIM, { 'GET /org/settings': { status: 200, body: withAme }, [PATCH]: { status: 200, body: ORG } }));
    await open();
    await chip('AME-2');
    const c = $('[aria-label="시뮬 속도 상한"]', scope('ame2-demo'))!;
    await click(btn('공통으로 되돌리기', c));
    await click(btn('공통으로 되돌리기', c));
    expect(btn('공통으로 되돌리기', c)).toBeUndefined();
    expect(field('ame2-demo', 'sim_max_vx').value).toBe('0.5');
    expect(tag('ame2-demo', 'sim_max_vx')).toBe('공통 값 사용(0.5 m/s) · 저장 전');
    expect(sent('PATCH', '/org/settings')).toHaveLength(0);
    await submit(form('ame2-demo', '시뮬 속도 상한'));
    expect(sent('PATCH', '/org/settings').map((x) => x.body)).toEqual([{ model_overrides: { 'ame2-demo': { sim_max_vx: null, sim_min_vx: null } } }]);
    expect(tag('ame2-demo', 'sim_max_vx')).toBe('공통 값 사용(0.5 m/s)');
  });
  it('저장 안 한 새 값 되돌리기: 초안만 지우고 null 을 보내지 않음', async () => {
    serve(signedIn(KIM, { 'GET /org/settings': { status: 200, body: ORG } }));
    await open();
    await chip('start');
    setVal(field('start-demo', 'sim_key_vx'), '0.45');
    await click(btn('공통으로 되돌리기', scope('start-demo')));
    expect(field('start-demo', 'sim_key_vx').value).toBe('0.4');
    await submit(form('start-demo', '조종 입력·임무 실행기'));
    expect(sent('PATCH', '/org/settings')).toHaveLength(0);
  });
  it('모델 교차 오류: id 뗀 서버 문구를 칸 옆에 / 범위 오류: 그 칸 옆에 허용 범위 / 빈 칸: 보내지 않음(null=되돌리기로 오인 금지)', async () => {
    const MSG = '시뮬 키보드 전진 속도는 최대 전진 속도 이하여야 합니다.';
    let rep = err(422, 'VALIDATION', `start-demo: ${MSG}`);
    serve(signedIn(KIM, { 'GET /org/settings': { status: 200, body: ORG }, [PATCH]: () => rep }));
    await open();
    await chip('start');
    const key = field('start-demo', 'sim_key_vx');
    setVal(key, '0.9');
    await submit(form('start-demo', '조종 입력·임무 실행기'));
    const why = key.getAttribute('aria-describedby')!.split(' ').map((i) => document.getElementById(i)!);
    expect(why[0].textContent).toBe(MSG);
    expect(key.closest('label')!.contains(why[0])).toBe(true);
    rep = err(422, 'VALIDATION', 'start-demo: sim_key_vx 값의 형식과 범위를 확인하세요.');
    setVal(key, '9');
    await submit(form('start-demo', '조종 입력·임무 실행기'));
    expect(key.closest('label')!.textContent).toContain('허용 범위: 키보드 전진 속도 0.1~1.5 m/s');
    const n = sent('PATCH', '/org/settings').length;
    setVal(key, '');
    await submit(form('start-demo', '조종 입력·임무 실행기'));
    expect(sent('PATCH', '/org/settings')).toHaveLength(n);
    expect(key.closest('label')!.textContent).toContain('값을 입력하세요.');
  });
  it('공통 값 저장이 어떤 모델 때문에 422: 모델 이름과 함께 그 칸 옆에, 교차 문구가 아니면 카드 아래에', async () => {
    let rep = err(422, 'VALIDATION', 'ame2-demo: 시뮬 키보드 전진 속도는 최대 전진 속도 이하여야 합니다.');
    serve(signedIn(KIM, { 'GET /org/settings': { status: 200, body: ORG }, [PATCH]: () => rep }));
    await open();
    const cap = $('[aria-label="시뮬 속도 상한"]', panel('시뮬'))!, max = $<HTMLInputElement>('input[name="sim_max_vx"]', cap)!;
    setVal(max, '0.3');
    await submit($('form', cap)!);
    expect(sent('PATCH', '/org/settings')[0].body).toEqual({ sim_max_vx: 0.3 });
    expect(document.getElementById(max.getAttribute('aria-describedby')!)!.textContent).toBe('AME-2 모델 값과 맞지 않아 저장하지 못했습니다. 시뮬 키보드 전진 속도는 최대 전진 속도 이하여야 합니다.');
    rep = err(422, 'VALIDATION', 'start-demo: 시뮬 에이전트 상한을 넘습니다.');
    await submit($('form', cap)!);
    expect($('[role="alert"].fh-msg:not([id])', cap)!.textContent).toBe('start 모델 값과 맞지 않아 저장하지 못했습니다. 시뮬 에이전트 상한을 넘습니다.');
  });
  it('공통 값을 저장하면 모델 화면의 «공통 값 사용(값)» 도 바뀜', async () => {
    serve(signedIn(KIM, { 'GET /org/settings': { status: 200, body: ORG }, [PATCH]: { status: 200, body: { ...ORG, lidar_view_m: 20 } } }));
    await open();
    await chip('nvidia');
    await chip('공통');
    const c = $('[aria-label="표시"]', panel('시뮬'))!;
    setVal($<HTMLInputElement>('input[name="lidar_view_m"]', c)!, '20');
    await submit($('form', c)!);
    expect(tag('nvidia-demo', 'lidar_view_m')).toBe('공통 값 사용(20 m)');
    expect(field('nvidia-demo', 'lidar_view_m').value).toBe('20');
  });
  it('운영 관리자: 모델 값을 볼 수 있지만 고치지 못함(되돌리기 없음·저장 비활성)', async () => {
    serve(signedIn(LEE, { 'GET /org/settings': { status: 200, body: withAme } }));
    await open();
    await chip('AME-2');
    expect(field('ame2-demo', 'sim_max_vx').value).toBe('0.3');
    expect(field('ame2-demo', 'sim_max_vx').disabled).toBe(true);
    expect(field('ame2-demo', 'sim_key_vx').readOnly).toBe(true);
    expect(btn('공통으로 되돌리기', scope('ame2-demo'))).toBeUndefined();
    expect(btn('저장', scope('ame2-demo'))!.disabled).toBe(true);
  });
});

describe('운영 관리자', () => {
  it('계정 관리가 보이지 않고 /users 를 부르지 않음, 내 정보는 보임', async () => {
    serve(signedIn(LEE));
    await open();
    expect($('[aria-label="계정"]')).toBeNull();
    expect(sent('GET', '/users?limit=100')).toHaveLength(0);
    expect(calls.some((c) => c.path.startsWith('/users'))).toBe(false);
    expect($('[aria-label="내 정보"]')).not.toBeNull();
  });
});

describe('내 정보(모두)', () => {
  it('내 이름 바꾸기: PATCH /me → 머리줄 이름', async () => {
    serve(signedIn(LEE, { 'PATCH /me': { status: 200, body: { ...LEE, display_name: '이반장' } } }));
    await open();
    const f = $('form', card('내 정보'))!;
    expect($<HTMLInputElement>('input[name="display_name"]', f)!.value).toBe('이운영');
    setVal($('input[name="display_name"]', f)!, '  ');
    await submit(f);
    expect(sent('PATCH', '/me')).toHaveLength(0);
    setVal($('input[name="display_name"]', f)!, ' 이반장 ');
    await submit(f);
    expect(sent('PATCH', '/me').map((c) => c.body)).toEqual([{ display_name: '이반장' }]);
    expect($('.fh-me')!.textContent).toBe('이반장(운영 관리자)');
    expect(card('내 정보').textContent).toContain('이름을 바꿨습니다.');
  });

  const pw = async (cur: string, next: string, again = next) => {
    const f = card('비밀번호 바꾸기');
    setVal($('input[name="current"]', f)!, cur); setVal($('input[name="next"]', f)!, next); setVal($('input[name="again"]', f)!, again);
    await submit(f);
  };
  it('비밀번호: 두 칸이 다르면 안 보냄, 현재 비밀번호 틀림 403·횟수 429 는 서버 문장', async () => {
    let n = 0;
    serve(signedIn(LEE, { 'POST /me/password': () => (++n === 1 ? err(403, 'FORBIDDEN', '현재 비밀번호를 확인하세요.') : err(429, 'RATE_LIMITED', '비밀번호 확인 시도가 많습니다. 잠시 뒤 다시 시도하세요.')) }));
    await open();
    await pw('old', 'new1', 'new2');
    expect(card('내 정보').textContent).toContain('새 비밀번호 두 칸이 서로 다릅니다.');
    await pw('', 'new1');
    expect(sent('POST', '/me/password')).toHaveLength(0);
    await pw('bad', 'new1');
    expect(sent('POST', '/me/password')[0].body).toEqual({ current_password: 'bad', new_password: 'new1' });
    expect($('[role="alert"]', card('내 정보'))!.textContent).toBe('현재 비밀번호를 확인하세요.');
    await pw('bad', 'new1');
    expect($('[role="alert"]', card('내 정보'))!.textContent).toContain('시도가 많습니다');
    expect($('[aria-label="로그인"]')).toBeNull();
  });

  it('비밀번호 칸 근처에 띄어쓰기 안내(띄어쓰기=STOP — 전역 키는 그대로)', async () => {
    serve(signedIn(LEE));
    await open();
    expect(card('비밀번호 바꾸기').textContent).toContain('띄어쓰기는 입력되지 않습니다(띄어쓰기=STOP).');
  });

  it('비밀번호 바꾸기 성공(204) → 서버가 모든 세션을 끝냄 — 바로 로그인 화면 + 안내', async () => {
    serve(signedIn(LEE, { 'POST /me/password': { status: 204 } }));
    await open();
    await pw('old', 'new-pass');
    expect($('[aria-label="로그인"]')).not.toBeNull();
    expect(box.textContent).toContain(PW_DONE);
  });

  it('비밀번호 바꾸기 중 네트워크 실패 → 로그인 화면으로 가지 않음', async () => {
    serve(signedIn(LEE, { 'POST /me/password': () => { throw new TypeError('Failed to fetch'); } }));
    await open();
    await pw('old', 'new-pass');
    expect($('[role="alert"]', card('내 정보'))!.textContent).toContain('서버에 연결하지 못했습니다');
    expect($('[aria-label="로그인"]')).toBeNull();
  });
});

describe('B1 앞 세션 요청의 늦은 답 — 로그아웃 → 다른 계정 로그인 뒤에 와도 버림', () => {
  const pwForm = async () => {
    const f = card('비밀번호 바꾸기');
    for (const [n, v] of [['current', 'old'], ['next', 'new-pass'], ['again', 'new-pass']]) setVal($(`input[name="${n}"]`, f)!, v);
    await submit(f);
  };
  it.each([
    ['계정 목록 401', 'GET /users', err(401, 'AUTH_REQUIRED', '로그인이 필요합니다.'), async () => {}],
    ['로그인 기기 401', 'GET /users/o1/sessions', err(401, 'AUTH_REQUIRED', '로그인이 필요합니다.'), () => pick('이운영')],
    ['비밀번호 바꾸기(쓰기) 늦은 204', 'POST /me/password', { status: 204 }, pwForm],
  ] as [string, string, Reply, () => Promise<void>][])('%s', async (_, route, late, start) => {
    let me = KIM, give!: (r: Reply) => void;
    const held = new Promise<Reply>((r) => { give = r; });
    serve(signedIn(KIM, {
      'GET /me': () => ({ status: 200, body: me }),
      'GET /users/o1/sessions': { status: 200, body: { items: [], next_cursor: null } },
      [route]: () => held,
      'POST /auth/logout': { status: 204 },
      'POST /auth/login': () => { me = LEE; return { status: 200, body: { ...LEE, csrf_token: 'csrf-2', access_token: null, refresh_token: null } }; },
      'PATCH /me': { status: 200, body: { ...LEE, display_name: '이반장' } },
    }));
    await open();
    await start();
    expect(calls.some((c) => `${c.method} ${c.path.split('?')[0]}` === route)).toBe(true);   // 앞 세션에서 보낸 채 답을 기다림
    await click(btn('로그아웃'));
    setVal($('input[name="username"]')!, 'lee'); setVal($('input[name="password"]')!, 'pw');
    await submit($('main[aria-label="로그인"] form')!);
    expect($('.fh-me')!.textContent).toBe('이운영(운영 관리자)');

    await act(async () => give(late));
    await flush();
    expect($('.fh-me')!.textContent).toBe('이운영(운영 관리자)');
    expect(box.textContent).not.toMatch(/로그인이 끝났습니다|비밀번호를 바꿨습니다/);
    const f = $('form', card('내 정보'))!;
    setVal($('input[name="display_name"]', f)!, '이반장');
    await submit(f);
    expect(sent('PATCH', '/me').map((c) => c.headers['X-FH-CSRF'])).toEqual(['csrf-2']);
    expect($('.fh-me')!.textContent).toBe('이반장(운영 관리자)');
  });
});

it('임시 비밀번호: 12자, 헷갈리는 글자 없음, 매번 다름', () => {
  const a = tempPassword(), b = tempPassword();
  expect(a).toMatch(/^[A-HJ-NP-Za-km-np-z2-9]{12}$/);
  expect(a).not.toBe(b);
});
