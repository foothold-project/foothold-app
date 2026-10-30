// 폰 → 찾은 실기 에이전트 연결(10-30 PHONE-REAL-CONNECT): 주변 찾기 «연결» → 앱 중계(fhGo2Link ↔ 'fh-go2-link') → 출입증 → 직접 hello → 실기 조종 화면.
// fetch = 가짜 서버, WebSocket = 가짜 에이전트(FakeWS). 못 받는 출입증·Wi-Fi·옛 앱은 쉬운 말 + «상태만 보기», 끊김은 자동 다시 연결·자동 재개 없음, 서버 DELETE 0.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { ROBOTS, USERS } from './fixtures';
import { FakeWS, type Msg } from './fakeWs';
import { NO_RELAY_MS, sim } from '../phone';
import { realTarget, type Found } from '../nearby';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RID = 'r1', HOST = '192.168.123.18', LEASE = '33333333-3333-4333-8333-333333333333';
const found: Found = { key: 'mdns:go2', via: 'mdns', name: 'GO2-friday', host: HOST, port: 8765, rid: RID, agent: `ws://${HOST}:8765/phone/ws` };
const REAL_LIMITS = { vx_min: 0, vx_max: 0.6, vy_min: 0, vy_max: 0, wz_min: -0.5, wz_max: 0.5, commands: [[0, 0, 0], [0.6, 0, 0], [0.6, 0, -0.5], [0.6, 0, 0.5]] };
const welcome = { t: 'hello', id: 'p1', robot: RID, proto: 'fh-phone/1', simulation: false, camera_token: null, limits: REAL_LIMITS,
  policy: { name: 'go2-sport', version: 'v1' }, ping_interval_ms: 1000, link_timeout_ms: 3000, lease_timeout_ms: 15000 };
const st = (p: Record<string, unknown> = {}) => ({ t: 'state', robot: RID, robot_id: RID, pose: null, speed: 0, battery: { soc: 70 }, latched: true, stop_gen: 1, stop_ref: 0,
  applied: [0, 0, 0], mode: 'IDLE', controller: null, controller_device: null, controller_connected: false, lease_id: null, stop_requested: false,
  posture: 'STAND', velocity: [0, 0, 0], echo: null, wall_time_ms: Date.now(), simulation: false, ...p });

type Reply = { status: number; body?: unknown } | 'down';
let calls: string[] = [], pass: Reply = { status: 200, body: { token: 'pass-secret', exp: Math.floor(Date.now() / 1000) + 600, kid: 'k1' } };
function serve(p: Reply = { status: 200, body: { token: 'pass-secret', exp: Math.floor(Date.now() / 1000) + 600, kid: 'k1' } }) {
  calls = []; pass = p;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const key = `${init.method ?? 'GET'} ${url.replace(/^\/api\/v1/, '').split('?')[0]}`;
    calls.push(key);
    if (key === `POST /robots/${RID}/phone-pass`) {
      if (pass === 'down') throw new TypeError('Failed to fetch');
      return new Response(JSON.stringify(pass.body), { status: pass.status, headers: { 'Content-Type': 'application/json' } });
    }
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
    await click(btn('조종 시작'));
    act(() => a.recv(st({ lease_id: LEASE, controller: 'u-lee', controller_connected: true }))); await flush();
    await click(btn('잠금 해제'));
    act(() => a.recv(st({ lease_id: LEASE, controller: 'u-lee', controller_connected: true, latched: false }))); await flush();
    // 회전만(제자리) = wz 0, 앞 끝까지 = 0.6
    sim.axes([0, 1]); await wait(120);
    expect(a.of('cmd').slice(-1)[0]).toMatchObject({ vx: 0, vy: 0, wz: 0 });
    sim.axes([1, 0]); await wait(120);
    expect(a.of('cmd').slice(-1)[0]).toMatchObject({ vx: 0.6, vy: 0, wz: 0, lease_id: LEASE });
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
