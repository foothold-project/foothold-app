// 폰 → 찾은 실기 에이전트 연결(10-30 PHONE-REAL-CONNECT): 주변 찾기 «연결» → 앱 중계(fhGo2Link ↔ 'fh-go2-link') → 출입증 → 직접 hello → 실기 조종 화면.
// fetch = 가짜 서버, WebSocket = 가짜 에이전트(FakeWS). 못 받는 출입증·Wi-Fi·옛 앱은 쉬운 말 + «상태만 보기», 끊김은 자동 다시 연결·자동 재개 없음, 서버 DELETE 0.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { ROBOTS, USERS } from './fixtures';
import { FakeWS, state, type Msg } from './fakeWs';
import { NO_RELAY_MS, sim } from '../phone';
import { rt } from '../rt';
import { realTarget, type Found } from '../nearby';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RID = 'r1', HOST = '192.168.123.18', LEASE = '33333333-3333-4333-8333-333333333333';
const found: Found = { key: 'mdns:go2', via: 'mdns', name: 'GO2-friday', host: HOST, port: 8765, rid: RID, agent: `ws://${HOST}:8765/phone/ws` };
const REAL_LIMITS = { vx_min: 0, vx_max: 1.5, vy_min: 0, vy_max: 0, wz_min: -0.5, wz_max: 0.5, commands: [[0, 0, 0], ...Array.from({ length: 13 }, (_, i) => [0, -0.5, 0.5].map((wz) => [(i + 3) / 10, 0, wz])).flat()] };
const welcome = { t: 'hello', id: 'p1', robot: RID, proto: 'fh-phone/1', simulation: false, camera_token: null, limits: REAL_LIMITS,
  policy: { name: 'go2-sport', version: 'v1' }, ping_interval_ms: 1000, link_timeout_ms: 3000, lease_timeout_ms: 15000 };
const st = (p: Record<string, unknown> = {}) => ({ t: 'state', robot: RID, robot_id: RID, pose: null, speed: 0, battery: { soc: 70 }, latched: true, stop_gen: 1, stop_ref: 0,
  applied: [0, 0, 0], mode: 'IDLE', controller: null, controller_device: null, controller_connected: false, lease_id: null, stop_requested: false,
  posture: 'STAND', velocity: [0, 0, 0], echo: null, wall_time_ms: Date.now(), simulation: false, ...p });

type Reply = { status: number; body?: unknown } | 'down';
type StopReply = 'down' | 'hang' | 'held' | { status: number; message: string };
let held: Record<string, () => void> = {};   // 'held' = 시험이 held[id]() 로 202 를 낼 때까지 답 없음
let stopDown: boolean | string[] = false;   // HTTP 대체 정지도 닿지 않음(true = 서버 전체가 꺼짐, 배열 = 그 로봇들만)
let stopReply: Record<string, StopReply> = {};   // 로봇마다 HTTP 대체 정지 답(있으면 stopDown 보다 먼저)
let calls: string[] = [], pass: Reply = { status: 200, body: { token: 'pass-secret', exp: Math.floor(Date.now() / 1000) + 600, kid: 'k1' } };
function serve(p: Reply = { status: 200, body: { token: 'pass-secret', exp: Math.floor(Date.now() / 1000) + 600, kid: 'k1' } }) {
  calls = []; pass = p; stopDown = false; stopReply = {}; held = {};
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const key = `${init.method ?? 'GET'} ${url.replace(/^\/api\/v1/, '').split('?')[0]}`;
    calls.push(key);
    if (key === `POST /robots/${RID}/phone-pass`) {
      if (pass === 'down') throw new TypeError('Failed to fetch');
      return new Response(JSON.stringify(pass.body), { status: pass.status, headers: { 'Content-Type': 'application/json' } });
    }
    const sr = key.match(/^POST \/robots\/([^/]+)\/stop$/)?.[1], how = sr ? stopReply[sr] : undefined;
    if (how === 'down') throw new TypeError('Failed to fetch');
    if (how === 'hang') return new Promise<Response>(() => {});
    if (how === 'held') return new Promise<Response>((ok) => { held[sr!] = () => ok(new Response('{}', { status: 202, headers: { 'Content-Type': 'application/json' } })); });
    if (how) return new Response(JSON.stringify({ error: { code: 'FORBIDDEN', message: how.message, detail: {} } }), { status: how.status, headers: { 'Content-Type': 'application/json' } });
    if (/^POST \/robots\/[^/]+\/stop$/.test(key) && (stopDown === true || (Array.isArray(stopDown) && stopDown.some((id) => key === `POST /robots/${id}/stop`)))) throw new TypeError('Failed to fetch');
    if (/^POST \/robots\/[^/]+\/stop$/.test(key)) return new Response('{}', { status: 202, headers: { 'Content-Type': 'application/json' } });   // HTTP 대체 정지(실시간만 끊긴 경우)
    if (key === 'GET /simulation/robots') return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: '없음', detail: {} } }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  });
}
const err = (status: number, code: string) => ({ status, body: { error: { code, message: '폰 출입증을 발급하지 못했습니다.', detail: {} } } });

let root: Root | null = null, box: HTMLDivElement;
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); });
const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));
const $ = (s: string) => box.querySelector<HTMLElement>(s);
const btn = (t: string) => [...box.querySelectorAll('button')].find((b) => b.textContent === t) as HTMLButtonElement | undefined;
const click = async (el: Element | null | undefined) => { expect(el).toBeTruthy(); act(() => { (el as HTMLElement).click(); }); await flush(); };
const link = () => (window as { fhGo2Link?: { seq: string; host: string; port: number } }).fhGo2Link;
const NONCE = '0123456789abcdef0123456789abcdef';
const fire = (d: Record<string, unknown>) => window.dispatchEvent(new CustomEvent('fh-go2-link', { detail: { seq: link()!.seq, ...(d.port ? { nonce: NONCE } : {}), ...d } }));
const relay = async (d: Record<string, unknown>) => { act(() => { fire(d); }); await flush(); };
const hide = () => { vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden'); document.dispatchEvent(new Event('visibilitychange')); };
const agents = () => FakeWS.all.filter((w) => w.url.startsWith('ws://127.0.0.1:40123/'));
const auto = ((m: Msg) => (m.t === 'lease.take' ? { lease_id: LEASE } : ['hello', 'cmd', 'ping', 'stop'].includes(m.t) ? undefined : {})) as FakeWS['auto'];

/** 앱 안 폰 → 로봇 연결 → «+ 로봇 연결하기» → 찾기 결과 → 항목 펼침 → «연결» */
async function pick() {
  window.matchMedia = ((q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Linux; Android 14; wv) FootholdApp/1.2.5-dev');
  location.hash = '#/drive';
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<App user={USERS.find((u) => u.id === 'u-lee')} robots={ROBOTS} />); });
  await flush();
  await click(btn('+ 로봇 연결하기'));
  await click(btn('주변 로봇 찾기'));
  const seq = $('[data-nearby-scan]')!.getAttribute('data-nearby-scan');
  act(() => { window.dispatchEvent(new CustomEvent('fh-nearby', { detail: { seq, scanning: false, items: [found], problems: [] } })); });
  await flush();
  await click([...box.querySelectorAll('.dv-card button')].find((b) => b.textContent?.includes('GO2-friday')));
  await click($('[data-real-connect]'));
}
async function connected() {
  await pick();
  await relay({ port: 40123 });
  const a = agents()[0]; a.auto = auto;
  act(() => a.open()); await flush();
  act(() => a.recv(welcome)); await flush();
  return a;
}
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); sim.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('realTarget', () => {
  it('로봇 ID 를 알린 인증 WS 에이전트만, agent 주소의 호스트 = 찾은 주소', () => {
    expect(realTarget(found)).toEqual({ host: HOST, port: 8765, name: 'GO2-friday' });
    expect(realTarget({ ...found, rid: undefined })).toBeNull();
    expect(realTarget({ ...found, mode: 'go2-readonly' })).toBeNull();
    expect(realTarget({ ...found, agent: 'ws://10.0.0.9:8765/phone/ws' })).toBeNull();
    expect(realTarget({ ...found, agent: `wss://${HOST}:8765/phone/ws` })).toBeNull();
    expect(realTarget({ ...found, agent: `ws://${HOST}:8765/other` })).toBeNull();
    expect(realTarget({ ...found, via: 'ble' })).toBeNull();
  });
});

describe('실기 연결 흐름', () => {
  it('연결 → 중계 포트 → 출입증 → hello → 실기 조종 화면(미검증 표시) → 조종 → STOP → 끊김(자동 재연결 0) → 나가기(중계 닫힘, DELETE 0)', async () => {
    serve();
    await pick();
    expect(link()).toMatchObject({ host: HOST, port: 8765 });
    expect($('[data-real-link]')?.textContent).toContain('연결 길을 여는 중');
    expect(calls).not.toContain(`POST /robots/${RID}/phone-pass`);   // 중계 전에는 출입증도 받지 않음
    await relay({ port: 40123 });
    expect(calls).toContain(`POST /robots/${RID}/phone-pass`);
    const a = agents()[0]; a.auto = auto;
    expect(a.url).toBe(`ws://127.0.0.1:40123/phone/ws?fh=${NONCE}`);
    act(() => a.open()); await flush();
    expect(a.sent[0]).toMatchObject({ t: 'hello', robot: RID, proto: 'fh-phone/1', ticket: 'pass-secret' });
    act(() => a.recv(welcome)); await flush();
    expect($('[data-real-drive]')).toBeTruthy();
    expect($('[data-sim-drive]')).toBeNull();
    expect($('[data-real-pill]')?.textContent).toContain('실기 · 미검증');
    expect($('[data-real-unverified]')?.textContent).toContain('미검증');
    expect($('[data-real-range]')?.textContent).toContain('후진 없음');
    expect($('[data-stop]')).toBeTruthy();   // STOP 늘 보임
    act(() => a.recv(st())); await flush();
    await click(btn('조종'));
    act(() => a.recv(st({ lease_id: LEASE, controller: 'u-lee', controller_connected: true }))); await flush();
    await click(btn('다시 시작')); await click($('[data-restart-go]'));
    act(() => a.recv(st({ lease_id: LEASE, controller: 'u-lee', controller_connected: true, latched: false }))); await flush();
    // 회전만(제자리) = wz 0, 앞 끝까지 = 1.5
    sim.axes([0, 1]); await wait(120);
    expect(a.of('cmd').slice(-1)[0]).toMatchObject({ vx: 0, vy: 0, wz: 0 });
    sim.axes([1, 0]); await wait(120);
    expect(a.of('cmd').slice(-1)[0]).toMatchObject({ vx: 1.5, vy: 0, wz: 0, lease_id: LEASE });
    await click($('[data-stop]'));
    expect(a.of('stop')).toHaveLength(1);
    expect(sim.get().stop?.via).toBe('agent');
    const sent = a.sent.length, n = FakeWS.all.length;
    act(() => a.drop(1006)); await flush();
    await wait(200);
    expect(FakeWS.all.length).toBe(n);   // 자동 다시 연결 0
    expect(a.sent.length).toBe(sent);
    expect(box.textContent).toContain('로봇은 입력이 끊기면 스스로 멈춥니다');
    expect(btn('다시 연결')).toBeTruthy();
    await click($('[data-real-leave]'));
    expect(link()).toBeUndefined();
    expect($('[data-real-drive]')).toBeNull();
    expect(calls.filter((c) => c.startsWith('DELETE'))).toEqual([]);
  });

  it('출입증 404(미등록·담당 아님) → 쉬운 말 + «상태만 보기»(상태 전용 화면, 중계 닫힘)', async () => {
    serve(err(404, 'NOT_FOUND'));
    await pick();
    await relay({ port: 40123 });
    expect(agents()).toHaveLength(0);
    expect($('[data-real-why]')?.textContent).toContain('등록되어 있지 않거나 내 담당 로봇이 아닙니다');
    await click($('[data-real-status]'));
    expect(link()).toBeUndefined();
    expect($('[data-go2-view]')?.getAttribute('data-go2-view')).toBe('code');
    expect(box.textContent).toContain(`${HOST}:9610`);
  });

  it('서버에 닿지 않음 → LTE 안내, 열쇠 없음 → 관리자 설정 안내', async () => {
    serve('down');
    await pick();
    await relay({ port: 40123 });
    expect($('[data-real-why]')?.textContent).toContain('모바일 데이터(LTE)');
    act(() => root?.unmount()); root = null; box.remove(); sim.clear();
    serve(err(503, 'PASS_KEY_MISSING'));
    await pick();
    await relay({ port: 40123 });
    expect($('[data-real-why]')?.textContent).toContain('출입증 열쇠');
    act(() => root?.unmount()); root = null; box.remove(); sim.clear();
    serve({ status: 429, body: { error: { code: 'PASS_RATE_LIMIT', message: '요청이 많습니다.', detail: { retry_after: 30 } } } });   // 429 = retry_after 초 안내
    await pick();
    await relay({ port: 40123 });
    expect($('[data-real-why]')?.textContent).toBe('요청이 많습니다. 30초 뒤 다시 연결하세요.');
  });

  it('앱이 Wi-Fi 문제를 알리면 그 이유, 연결 전 STOP 은 «보낼 길 없음»(정리 DELETE 0)', async () => {
    serve();
    await pick();
    await relay({ why: 'wifi-off' });
    expect($('[data-real-why]')?.textContent).toContain('로봇 Wi-Fi 에 연결되어 있지 않습니다');
    await click($('[data-stop]'));
    expect(sim.get().stop?.via).toBe('none');
    expect(calls.filter((c) => c.startsWith('DELETE'))).toEqual([]);
    expect(calls).not.toContain(`POST /robots/${RID}/phone-pass`);
  });

  it('옛 앱(중계 답 없음) → 업데이트 안내', async () => {
    serve();
    await pick();
    await wait(NO_RELAY_MS + 100);
    expect($('[data-real-why]')?.textContent).toContain('이 앱 판은 실기 직접 연결을 지원하지 않습니다');
  }, 10_000);

  it('앱 복귀 뒤 다시 열린 중계(늦은 포트)는 버리고, «다시 연결»은 새 포트·nonce 를 받아서만', async () => {
    serve();
    const a = await connected();
    const seq = link()!.seq;
    act(() => a.drop(1006)); await flush();
    await relay({ port: 40124 });
    expect(FakeWS.all.some((w) => w.url.startsWith('ws://127.0.0.1:40124/'))).toBe(false);   // 자동 연결 0
    const n = FakeWS.all.length;
    await click(btn('다시 연결'));
    expect(FakeWS.all.length).toBe(n);   // 한 번 쓴 포트(40123)로 다시 붙지 않음
    expect(link()!.seq).not.toBe(seq);
    await relay({ port: 40125, nonce: 'fedcba9876543210fedcba9876543210' });
    expect(FakeWS.last.url).toBe('ws://127.0.0.1:40125/phone/ws?fh=fedcba9876543210fedcba9876543210');
  });

  it('nonce 없거나 모양이 틀린 포트 알림은 쓰지 않음', async () => {
    serve();
    await pick();
    await relay({ port: 40123, nonce: 'short' });
    expect(agents()).toHaveLength(0);
    expect(calls).not.toContain(`POST /robots/${RID}/phone-pass`);
    expect($('[data-real-why]')).toBeTruthy();
  });

  it('중계 답 전에 앱이 가려지면 늦은 포트 알림이 와도 WebSocket 0, 복귀 뒤 자동 연결 0', async () => {
    serve();
    await pick();
    act(() => hide()); await flush();
    expect($('[data-real-why]')?.textContent).toContain('앱이 가려져');
    await relay({ port: 40123 });
    vi.restoreAllMocks();   // 다시 보임
    await relay({ port: 40124 });
    expect(FakeWS.all.filter((w) => w.url.startsWith('ws://127.0.0.1:'))).toHaveLength(0);
    expect(calls).not.toContain(`POST /robots/${RID}/phone-pass`);
  });

  it('출입증을 받는 중에 앱이 중계 닫힘(wifi-off)을 알리면 늦게 받은 출입증으로 옛 포트에 붙지 않음(WS 0·hello 0)', async () => {
    serve();
    await pick();
    act(() => { fire({ port: 40123 }); fire({ why: 'wifi-off' }); });   // 출입증 답 전에 중계 닫힘
    await flush();
    expect(calls).toContain(`POST /robots/${RID}/phone-pass`);
    expect(agents()).toHaveLength(0);
    expect($('[data-real-why]')?.textContent).toContain('로봇 Wi-Fi 에 연결되어 있지 않습니다');
  });

  it('WS 가 열리기 전 중계 실패 알림 → 그 WS 는 버리고 hello 0', async () => {
    serve();
    await pick();
    await relay({ port: 40123 });
    const a = agents()[0];
    await relay({ why: 'relay-fail' });
    act(() => a.open()); await flush();
    expect(a.sent).toEqual([]);
    expect($('[data-real-why]')?.textContent).toContain('연결을 준비하지 못했습니다');
  });

  it('출입증을 받는 중에 앱이 가려지면 그 출입증으로 연결하지 않음', async () => {
    serve();
    await pick();
    act(() => { fire({ port: 40123 }); hide(); });   // 출입증 요청이 끝나기 전에 숨김
    await flush();
    expect(calls).toContain(`POST /robots/${RID}/phone-pass`);
    expect(FakeWS.all.filter((w) => w.url.startsWith('ws://127.0.0.1:'))).toHaveLength(0);
    expect($('[data-real-why]')?.textContent).toContain('앱이 가려져');
  });

  it('실기는 카메라 토큰이 와도 두 번째 연결(옛 카메라 경로)을 열지 않음 — 앱 중계는 연결 1개만', async () => {
    serve();
    await pick();
    await relay({ port: 40123 });
    const a = agents()[0]; a.auto = auto;
    act(() => a.open()); await flush();
    act(() => a.recv({ ...welcome, camera_token: 'cam-t' })); await flush();
    expect(agents()).toHaveLength(1);
    expect(sim.get().link?.cam).toBe('off');
  });

  it('조종 중 앱이 Wi-Fi 끊김을 알리면 이유 표시, «다시 연결»은 중계부터 새로(새 seq)', async () => {
    serve();
    const a = await connected();
    const seq = link()!.seq;
    act(() => a.drop(1006)); await flush();
    await relay({ why: 'wifi-off' });
    expect(box.textContent).toContain('로봇 Wi-Fi 에 연결되어 있지 않습니다');
    const n = FakeWS.all.length;
    await click(btn('다시 연결'));
    expect(FakeWS.all.length).toBe(n);   // 죽은 포트로 붙지 않음
    expect(link()!.seq).not.toBe(seq);
    await relay({ port: 40125 });
    expect(FakeWS.last.url).toBe(`ws://127.0.0.1:40125/phone/ws?fh=${NONCE}`);
  });
});

// RB-SIMTAB-FRESH-PRESS: 폰 실기 직결 스틱도 drive.tsx·simdrive.tsx 와 같은 입력 세대(rt inputGen) — 앞 세대 손가락이 남아 있으면 0
describe('실기 직결 조종 — 새로 누른 입력만', () => {
  const ST = { lease_id: LEASE, controller: 'u-lee', controller_connected: true };
  const stick = (label: string) => {
    const el = $(`[aria-label="${label} 조이스틱"]`)!;
    el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON() {} }) as DOMRect;
    return el;
  };
  const ptr = (el: Element, type: string, x: number, y: number) => act(() => { el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 })); });
  const cmd = async (a: FakeWS) => { await wait(70); return a.of('cmd').slice(-1)[0]; };
  async function drive() {
    serve();
    const a = await connected();
    act(() => a.recv(st())); await flush();
    await click(btn('조종'));
    act(() => a.recv(st(ST))); await flush();
    await click(btn('다시 시작')); await click($('[data-restart-go]'));
    act(() => a.recv(st({ ...ST, latched: false }))); await flush();
    return a;
  }
  it('정상: 새로 누르면 값, 놓으면 0, STOP 즉시', async () => {
    const a = await drive(), fwd = stick('전후');
    ptr(fwd, 'pointerdown', 50, 0); expect(await cmd(a)).toMatchObject({ vx: 1.5 });
    ptr(fwd, 'pointerup', 50, 0); expect(await cmd(a)).toMatchObject({ vx: 0, wz: 0 });
    ptr(fwd, 'pointerdown', 50, 0); expect(await cmd(a)).toMatchObject({ vx: 1.5 });
    await click($('[data-stop]'));
    expect(a.of('stop')).toHaveLength(1);
    expect(await cmd(a)).toMatchObject({ vx: 0, wz: 0 });
    ptr(fwd, 'pointerup', 50, 0);
  });
  for (const how of ['stop_gen 1→2(잠금 해제 그대로)', '창 초점 잃음'] as const) it(`${how} → 0, 같은 손가락을 움직여도 0 — 떼었다가 새로 누르면 다시`, async () => {
    const a = await drive(), fwd = stick('전후');
    ptr(fwd, 'pointerdown', 50, 0); expect(await cmd(a)).toMatchObject({ vx: 1.5 });
    if (how === '창 초점 잃음') act(() => { window.dispatchEvent(new Event('blur')); });
    else { act(() => a.recv(st({ ...ST, latched: false, stop_gen: 2 }))); await flush(); }
    expect(await cmd(a)).toMatchObject({ vx: 0, wz: 0 });
    ptr(fwd, 'pointermove', 50, 0); ptr(fwd, 'pointermove', 50, 5);
    expect(await cmd(a)).toMatchObject({ vx: 0, wz: 0 });   // 고치기 전: vx 1.5
    ptr(fwd, 'pointerup', 50, 0); ptr(fwd, 'pointerdown', 50, 0);
    expect(await cmd(a)).toMatchObject({ vx: 1.5 });
    ptr(fwd, 'pointerup', 50, 0);
  });
  it('RV-429 ① 명령 틱이 300 ms 넘게 멈춘 뒤 같은 손가락으로 1.5 를 다시 보내지 않음 — 떼었다가 새로 누르면 다시', async () => {
    const a = await drive(), fwd = stick('전후');
    ptr(fwd, 'pointerdown', 50, 0); expect(await cmd(a)).toMatchObject({ vx: 1.5 });
    const real = performance.now.bind(performance), gap = vi.spyOn(performance, 'now').mockImplementation(() => real() + 400);
    expect(await cmd(a)).toMatchObject({ vx: 0, wz: 0 });   // 고치기 전: vx 1.5
    ptr(fwd, 'pointermove', 50, 5);
    expect(await cmd(a)).toMatchObject({ vx: 0, wz: 0 });
    ptr(fwd, 'pointerup', 50, 0); ptr(fwd, 'pointerdown', 50, 0);
    expect(await cmd(a)).toMatchObject({ vx: 1.5 });
    ptr(fwd, 'pointerup', 50, 0); expect(await cmd(a)).toMatchObject({ vx: 0, wz: 0 });
    gap.mockRestore();
  });
});

// 결정 d2(11-28): 서버가 끊긴 폰의 STOP. 정지 단추는 회색이 아니다. 직결(welcome)이 살아 있으면 직결로 바로(via agent),
// 직결도 없으면 눌리되 «로봇에 닿을 길 없음 · 현장에서 멈추세요» 한 줄(성공처럼 보이지 않게). 서버가 살아 있으면 그대로
describe('서버 끊긴 폰의 STOP(d2)', () => {
  const server = () => FakeWS.all.filter((w) => !w.url.startsWith('ws://127.0.0.1:40123/'));
  /** 서버 실시간을 열었다가 끊음(연결 끊김 띠까지) */
  const cut = async () => { for (const w of server()) { act(() => w.open()); } await flush(); for (const w of server()) act(() => w.drop(1006)); await flush();
    expect($('[data-link-band]')).toBeTruthy(); };
  const greyStops = () => [...box.querySelectorAll<HTMLButtonElement>('.fh-stop')].filter((b) => b.disabled);
  /** 직결 없이 폰 로봇 연결 화면 */
  async function home(robots = ROBOTS, hash = '#/drive') {
    window.matchMedia = ((q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Linux; Android 14; wv) FootholdApp/1.2.5-dev');
    location.hash = hash;
    box = document.createElement('div'); document.body.append(box);
    act(() => { root = createRoot(box); root.render(<App user={USERS.find((u) => u.id === 'u-lee')} robots={robots} />); });
    await flush();
  }

  it('서버 끊김 + 실기 직결 있음 → STOP 은 직결 {t:stop} 한 번(via agent), 띠는 직결로 보냈다고 알림', async () => {
    serve();
    const a = await connected();
    await cut();
    expect($('[data-stop]')).toBeTruthy();
    expect(greyStops()).toEqual([]);
    const before = server().reduce((n, w) => n + w.of('stop').length, 0);
    await click($('[data-stop]'));
    expect(a.of('stop')).toHaveLength(1);
    expect(sim.get().stop?.via).toBe('agent');
    expect(server().reduce((n, w) => n + w.of('stop').length, 0)).toBe(before);
    expect(box.textContent).toContain('직결');
    expect(calls.filter((c) => c.includes('/stop'))).toEqual([]);
  });

  it('서버 끊김 + 직결 없음 + 정지할 로봇도 없음 → STOP 은 눌리고(회색 아님) «로봇에 닿을 길 없음 · 현장에서 멈추세요» 한 줄, 성공 문구 없음', async () => {
    serve();
    await home([]);
    await cut();
    const stop = $('[data-stop]') as HTMLButtonElement;
    expect(stop).toBeTruthy(); expect(stop.disabled).toBe(false);
    await click(stop);
    expect(greyStops()).toEqual([]);   // 고를 수 없는 회색 «정지» 창이 뜨지 않는다
    const line = $('[data-stop-none]');
    expect(line?.textContent).toContain('로봇에 닿을 길 없음');
    expect(line?.textContent).toContain('현장에서 멈추세요');
    expect(box.textContent).not.toMatch(/보냈습니다|정지 요청됨|정지 잠금/);
  });

  it('서버 전체가 꺼짐(WS · HTTP 모두) + 대상 없음 → 로봇마다 정지를 시도하고 결과는 로봇마다 «현장에서 … 멈추세요» 한 줄, 성공 문구 없음', async () => {
    serve();
    await home();
    await cut();
    stopDown = true;
    await click($('[data-stop]'));
    await wait(50);
    expect(calls.filter((c) => /^POST \/robots\/[^/]+\/stop$/.test(c)).sort()).toEqual(['POST /robots/r1/stop', 'POST /robots/r3/stop']);
    // 폰 말풍선 줄이기: 같은 결과는 로봇 이름만 나열해 한 줄
    const bands = [...box.querySelectorAll('[data-stop-band]')].map((x) => x.textContent ?? '');
    // 사유가 같으면 한 번만 짧게 뒤에
    expect(bands).toHaveLength(1);
    expect(bands[0]).toMatch(/^▲ Go2-3 · Go2-1 정지 요청을 보냈지만 서버 접수를 확인하지 못했습니다\. 현장에서 직접 멈추세요\. 사유: [^·]+$/);
    expect(box.textContent).not.toMatch(/서버가 받았습니다|정지 잠금|정지 요청됨/);
  });

  it('서버 끊김 + 대상 없음, 한 대만 HTTP 로 접수 → 접수 안 된 로봇들은 한 줄, 접수된 로봇은 따로 짧게', async () => {
    serve();
    await home();
    await cut();
    stopDown = ['r1'];
    await click($('[data-stop]'));
    await wait(50);
    const bands = [...box.querySelectorAll('[data-stop-band]')].map((x) => x.textContent ?? '');
    expect(bands).toHaveLength(2);
    expect(bands.some((t) => t.startsWith('▲ Go2-1 정지 요청을 보냈지만 서버 접수를 확인하지 못했습니다. 현장에서 직접 멈추세요.'))).toBe(true);
    // 접수된 Go2-3 은 따로 짧게. 서버가 끊겨 보낼 때 상태를 모르던 로봇이라 관제와 같은 «상태 모름 · 정지가 닿지 않을 수 있음»
    const ok = bands.find((t) => t.includes('Go2-3'))!;
    expect(ok).toBe('▲ Go2-3 서버 접수 · 로봇 상태 모름 · 정지가 닿지 않을 수 있음 · 현장에서 확인하세요.');
    expect(ok).not.toContain('Go2-1');
  });

  it('S1: 서버 끊김 + 대체 경로 거절(403) → «보내지 못했습니다 · 현장에서 직접 멈추세요» 묶음 줄(failed), 사유가 로봇마다 다르면 로봇별로 짧게', async () => {
    serve();
    await home();
    await cut();
    stopReply = { r3: { status: 403, message: '권한 없음' }, r1: { status: 404, message: '로봇 없음' } };
    await click($('[data-stop]'));
    await wait(50);
    const g = $('[data-stop-group="failed"]')!;
    expect(g.textContent).toBe('▲ Go2-3 · Go2-1 정지 요청을 보내지 못했습니다. 현장에서 직접 멈추세요. 사유: Go2-3 권한 없음 · Go2-1 로봇 없음');
    expect([...box.querySelectorAll('[data-stop-band]')]).toHaveLength(1);
  });

  it('보내는 중(대체 경로 답 전) → «■ Go2-3 · Go2-1 정지 요청을 보내는 중입니다.» 한 줄', async () => {
    serve();
    await home();
    await cut();
    stopReply = { r3: 'hang', r1: 'hang' };
    await click($('[data-stop]'));
    expect($('[data-stop-group="sending"]')!.textContent).toBe('■ Go2-3 · Go2-1 정지 요청을 보내는 중입니다.');
    expect([...box.querySelectorAll('[data-stop-band]')]).toHaveLength(1);
  });

  it('Sonnet 중간 1: 보낼 때 끊겨 있던 로봇이 대체 경로로 접수되면 «대체 경로» 대신 관제와 같은 «아직 닿지 않음» 줄, 긴 줄표 없음', async () => {
    serve();
    await home();
    await cut();
    stopReply = { r3: 'down' };   // r1(연결 끊김)만 대체 경로로 접수
    await click($('[data-stop]'));
    await wait(50);
    const bands = [...box.querySelectorAll('[data-stop-band]')].map((x) => x.textContent ?? '');
    const r1 = bands.find((t) => t.includes('Go2-1'))!;
    expect(r1).toBe('▲ Go2-1 서버 접수 · 로봇 상태 모름 · 정지가 닿지 않을 수 있음 · 현장에서 확인하세요.');
    expect(r1).not.toContain('대체 경로');
    for (const t of bands) expect(t).not.toContain('—');
  });

  /** 서버 끊김 STOP(대체 경로 답 보류) → 다시 연결 → 새 서버 소켓 열고 그 위에 state → 202. 접수 시각이 state 보다 뒤라 «로봇 확인 전» 묶음으로 */
  async function acceptAfterReconnect(states: Parameters<typeof state>[]) {
    serve();
    await home();
    await cut();
    stopReply = { r3: 'held', r1: 'held' };
    await click($('[data-stop]'));
    await click([...box.querySelectorAll('button')].find((b) => b.textContent === '다시 연결')!);
    const w = server().filter((x) => x.readyState === 0).pop()!;
    act(() => w.open()); await flush();
    for (const s of states) act(() => w.recv(state(...s)));
    await flush();
    await wait(5);
    act(() => { held.r3(); held.r1(); }); await flush();
    return [...box.querySelectorAll('[data-stop-band]')].map((x) => x.textContent ?? '');
  }

  it('보낼 때 끊겨 있던 로봇 · 접수 전에 «연결 끊김»(lost) 으로 확인된 로봇과 상태를 모르는 로봇은 줄을 따로, 글 전체', async () => {
    const bands = await acceptAfterReconnect([['r1', { connection: 'OFFLINE', status: 'STOP_LATCHED' }]]);   // r3 은 state 없음(wait)
    expect($('[data-stop-group="lost"]')!.getAttribute('data-stop-lost')).toBe('r1');
    expect($('[data-stop-group="lost"]')!.textContent).toBe('▲ Go2-1 연결이 끊겨 정지를 보내지 못했습니다. 다시 연결되면 로봇은 잠긴 상태로 시작합니다. 지금 멈춰야 하면 리모컨이나 현장에서 멈추세요.');
    expect($('[data-stop-group="unknown"]')!.getAttribute('data-stop-unsure')).toBe('r3');
    expect($('[data-stop-group="unknown"]')!.textContent).toBe('▲ Go2-3 서버 접수 · 로봇 상태 모름 · 정지가 닿지 않을 수 있음 · 현장에서 확인하세요.');
    expect(bands).toHaveLength(2);
  });

  it('접수 전에 다시 연결돼 온라인으로 확인된 로봇은 «정지 요청됨(대체 경로)» 줄(fbOk), 긴 줄표 없음', async () => {
    const bands = await acceptAfterReconnect([['r3', { connection: 'ONLINE', status: 'RUNNING' }]]);   // r1 은 state 없음
    expect($('[data-stop-group="fallback"]')!.textContent).toBe('■ Go2-3 정지 요청됨(대체 경로) · 다시 연결됨 · 로봇의 정지 확인을 기다리는 중. 현장을 확인하세요.');
    expect($('[data-stop-group="unknown"]')!.textContent).toBe('▲ Go2-1 서버 접수 · 로봇 상태 모름 · 정지가 닿지 않을 수 있음 · 현장에서 확인하세요.');
    expect(bands).toHaveLength(2);
  });

  it('Q1 안전: sim.stop 이 던져도 실기 정지(r1 · r3)는 나간다', async () => {
    serve();
    vi.spyOn(sim, 'live').mockReturnValue({ robot_id: 'sim-x' } as ReturnType<typeof sim.live>);
    vi.spyOn(sim, 'stop').mockImplementation(() => { throw new Error('sim boom'); });
    const swallow = (e: ErrorEvent) => { if (e.error?.message === 'sim boom') e.preventDefault(); };
    window.addEventListener('error', swallow);
    try {
      await home();
      await cut();
      await click($('[data-stop]'));
      await wait(50);
    } finally { window.removeEventListener('error', swallow); }
    expect(calls.filter((c) => /^POST \/robots\/[^/]+\/stop$/.test(c)).sort()).toEqual(['POST /robots/r1/stop', 'POST /robots/r3/stop']);
  });

  it('C6 (권한 검토): 폰 · 서버 끊김 · 시뮬 떠 있음 STOP 은 실기를 먼저 보내고 그다음 내 시뮬', async () => {
    serve();
    const order: string[] = [], real = rt.stop.bind(rt);
    vi.spyOn(sim, 'live').mockReturnValue({ robot_id: 'sim-x' } as ReturnType<typeof sim.live>);
    vi.spyOn(sim, 'stop').mockImplementation(() => { order.push('sim'); });
    vi.spyOn(rt, 'stop').mockImplementation((id: string) => { order.push(id); return real(id); });
    await home();
    await cut();
    await click($('[data-stop]'));
    await wait(50);
    expect(order.indexOf('sim')).toBe(order.length - 1);
    expect(order.slice(0, -1).sort()).toEqual(['r1', 'r3']);
  });

  it('C6 (권한 검토): 실기 정지가 던져도 내 시뮬 정지는 나간다', async () => {
    serve();
    vi.spyOn(sim, 'live').mockReturnValue({ robot_id: 'sim-x' } as ReturnType<typeof sim.live>);
    const simStop = vi.spyOn(sim, 'stop').mockImplementation(() => undefined);
    vi.spyOn(rt, 'stop').mockImplementation(() => { throw new Error('real boom'); });
    const swallow = (e: ErrorEvent) => { if (e.error?.message === 'real boom') e.preventDefault(); };
    window.addEventListener('error', swallow);
    try {
      await home();
      await cut();
      await click($('[data-stop]'));
      await wait(50);
    } finally { window.removeEventListener('error', swallow); }
    expect(simStop).toHaveBeenCalledTimes(1);
  });

  it('S2: 0 대에서 «닿을 길 없음» 뒤 로봇이 생겨 STOP 하면 그 줄은 없어진다', async () => {
    serve();
    await home([]);
    await cut();
    await click($('[data-stop]'));
    expect($('[data-stop-none]')).toBeTruthy();
    act(() => { root!.render(<App user={USERS.find((u) => u.id === 'u-lee')} robots={ROBOTS} />); });
    await flush();
    await click($('[data-stop]'));
    await wait(50);
    expect($('[data-stop-none]')).toBeNull();
    expect(calls.filter((c) => /^POST \/robots\/[^/]+\/stop$/.test(c)).length).toBe(2);
  });

  it('M6: 총괄 폰 · 남의 시뮬이 섞인 목록 → 서버 끊김 STOP 은 정지 가능한(내) 로봇에만', async () => {
    serve();
    const mine = { id: 'sa', name: '시뮬 A', owner: 'u-kim', ownerName: '김OO', battery: null, online: true, seenAt: '', status: 'IDLE', sim: true } as unknown as (typeof ROBOTS)[number];
    const other = { ...mine, id: 'sb', name: '시뮬 B', owner: 'u-lee', ownerName: '이OO', demo: false };   // 사용자 시뮬(데모 아님 · 22:04)
    window.matchMedia = ((q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Linux; Android 14; wv) FootholdApp/1.2.5-dev');
    location.hash = '#/drive';
    box = document.createElement('div'); document.body.append(box);
    act(() => { root = createRoot(box); root.render(<App user={USERS.find((u) => u.id === 'u-kim')} robots={[mine, other]} />); });
    await flush();
    await cut();
    await click($('[data-stop]'));
    await wait(50);
    expect(calls.filter((c) => /^POST \/robots\/[^/]+\/stop$/.test(c))).toEqual(['POST /robots/sa/stop']);
  });

  it('Q1: 폰에서 내 시뮬이 떠 있고 서버가 끊긴 채 대상 없이 STOP → 내 시뮬(sim.stop)과 정지 가능한 실기(대체 경로) 둘 다', async () => {
    serve();
    vi.spyOn(sim, 'live').mockReturnValue({ robot_id: 'sim-x' } as ReturnType<typeof sim.live>);
    const simStop = vi.spyOn(sim, 'stop').mockImplementation(() => undefined);
    await home();
    await cut();
    await click($('[data-stop]'));
    await wait(50);
    expect(simStop).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => /^POST \/robots\/[^/]+\/stop$/.test(c)).sort()).toEqual(['POST /robots/r1/stop', 'POST /robots/r3/stop']);
  });

  it('H1 (Codex #535): 폰 목록에 실기가 한 대뿐이어도(대상 자동) 시뮬 화면 밖 · 서버 끊김 STOP 은 내 시뮬과 그 실기 둘 다', async () => {
    serve();
    vi.spyOn(sim, 'live').mockReturnValue({ robot_id: 'sim-x' } as ReturnType<typeof sim.live>);
    const simStop = vi.spyOn(sim, 'stop').mockImplementation(() => undefined);
    await home(ROBOTS.filter((r) => r.id === 'r3'), '#/history');
    await cut();
    await click($('[data-stop]'));
    await wait(50);
    expect(simStop).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => /^POST \/robots\/[^/]+\/stop$/.test(c))).toEqual(['POST /robots/r3/stop']);
  });

  it('M3 (Codex #535): 실기와 시뮬을 함께 멈추면 시뮬 쪽 결과(정리 확인 못 함)도 띠에 남는다', async () => {
    serve();
    vi.spyOn(sim, 'live').mockReturnValue({ robot_id: 'sim-x' } as ReturnType<typeof sim.live>);
    vi.spyOn(sim, 'stop').mockImplementation(() => undefined);
    const real = sim.get();
    vi.spyOn(sim, 'get').mockReturnValue({ ...real, step: 'checking', slotBusy: false, stop: { at: 1, via: 'cleanup' } } as ReturnType<typeof sim.get>);
    await home();
    await cut();
    await click($('[data-stop]'));
    await wait(50);
    expect(calls.filter((c) => /^POST \/robots\/[^/]+\/stop$/.test(c)).sort()).toEqual(['POST /robots/r1/stop', 'POST /robots/r3/stop']);
    expect($('[data-sim-stop-band]')?.textContent).toContain('정리를 확인하지 못했습니다');
  });

  it('Q1: 시뮬 조종 화면 안(대상 = 시뮬)의 STOP 은 서버가 끊겨도 시뮬만', async () => {
    serve();
    const a = await connected();   // 직결 조종 화면(머리 = STOP 만)
    await cut();
    await click($('[data-stop]'));
    await wait(50);
    expect(a.of('stop')).toHaveLength(1);
    expect(calls.filter((c) => /^POST \/robots\/[^/]+\/stop$/.test(c))).toEqual([]);
  });

  it('조종 화면(STOP 이 떠 있는 머리)에서 띠 글이 STOP 아래로 가리지 않게 오른쪽 여백', async () => {
    const css = (await import('../drive.css?raw')).default;
    expect(css).toMatch(/\.fh\.phone \.fh-head\[data-bare\] ~ \.fh-band\{[^}]*padding-right/);
  });

  it('B2 · B3: 닿을 길 없음 뒤 서버가 다시 붙으면 «보내지 못했음» 으로 바꿔 닫을 때까지 두고, 직결 정지를 보내면 그 줄을 거둔다', async () => {
    serve();
    await home([]);
    await cut();
    await click($('[data-stop]'));
    expect($('[data-stop-none]')!.textContent).toContain('로봇에 닿을 길 없음');
    // 다시 연결 → 새 서버 소켓 열림
    await click([...box.querySelectorAll('button')].find((b) => b.textContent === '다시 연결')!);
    const w = server().filter((x) => x.readyState === 0).pop()!;
    act(() => w.open()); await flush();
    expect($('[data-link-band]')).toBeNull();
    const back = $('[data-stop-none]')!;
    expect(back.textContent).toContain('서버 다시 연결됨 · 앞선 정지는 보내지 못했음 · 로봇 상태를 확인하세요');
    await click(back.querySelector('button'));
    expect($('[data-stop-none]')).toBeNull();
  });

  it('B2: 닿을 길 없음 줄이 있어도 직결로 정지(toSim)를 보내면 그 줄을 거둔다', async () => {
    serve();
    await home([]);
    await cut();
    await click($('[data-stop]'));
    expect($('[data-stop-none]')).toBeTruthy();
    // 같은 화면에서 주변 로봇 직결(로봇 0대 폰 = 시안 u13_4 «로봇 연결», 같은 data-robot-connect · 같은 길)
    await click($('[data-robot-connect]'));
    await click(btn('주변 로봇 찾기'));
    const seq = $('[data-nearby-scan]')!.getAttribute('data-nearby-scan');
    act(() => { window.dispatchEvent(new CustomEvent('fh-nearby', { detail: { seq, scanning: false, items: [found], problems: [] } })); });
    await flush();
    await click([...box.querySelectorAll('.dv-card button')].find((b) => b.textContent?.includes('GO2-friday')));
    await click($('[data-real-connect]'));
    await relay({ port: 40123 });
    const a = agents()[0]; a.auto = auto;
    act(() => a.open()); await flush();
    act(() => a.recv(welcome)); await flush();
    await click($('[data-stop]'));
    expect(a.of('stop')).toHaveLength(1);
    expect($('[data-stop-none]')).toBeNull();
  });

  it('실시간(WS)만 끊기고 HTTP 는 살아 있음 + 대상 없음 → 정지 가능한 로봇마다 HTTP 대체 정지(api.stop), «닿을 길 없음» 은 쓰지 않음(B1)', async () => {
    serve();
    await home();
    await cut();
    await click($('[data-stop]'));
    await wait(50);
    const stops = calls.filter((c) => /^POST \/robots\/[^/]+\/stop$/.test(c)).sort();
    expect(stops).toEqual(['POST /robots/r1/stop', 'POST /robots/r3/stop']);
    expect($('[data-stop-none]')).toBeNull();
  });

  it('서버 끊김 + 대상이 정해진 화면(그 로봇 조종 화면) → 그 로봇에만 기존 정지(rt.stop · HTTP 대체), 다른 로봇으로 새지 않음', async () => {
    serve();
    await home(ROBOTS, '#/drive/r3');
    await cut();
    await click($('[data-stop]'));
    await wait(50);
    expect(calls.filter((c) => /^POST \/robots\/[^/]+\/stop$/.test(c))).toEqual(['POST /robots/r3/stop']);
  });

  it('서버 살아 있음 + 직결 없음 → 지금 그대로(정지할 로봇 고르기)', async () => {
    serve();
    await home();
    for (const w of server()) act(() => w.open());
    await flush();
    await click($('[data-stop]'));
    expect($('[aria-label="정지할 로봇 고르기"]')).toBeTruthy();
    expect($('[data-stop-none]')).toBeNull();
  });
});
