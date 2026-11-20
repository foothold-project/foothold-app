// 실기 직결 조종 화면 배치(11-20 RB-PHONE-DIRECT-LOOK · RB-PHONE-LOOK-FIX): 큰 화면 = 라이다(새 점을 받을 때만) / 카메라, 작은 창 눌러 바꿈(바꿔도 영상 연결·3D 칸 유지),
// media 주소 없음 → 카메라만 안내·교환 없음, 라이다 대기·멈춤 → 큰 화면 카메라, 안전 글·미검증은 접어도 보임, 화면 글에 media/1 없음. 연결 준비는 realconnect.test.tsx 와 같은 가짜 서버·에이전트
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { ROBOTS, USERS } from './fixtures';
import { FakeWS, type Msg } from './fakeWs';
import { sim } from '../phone';
import { media, BAD_WELCOME, NO_MEDIA, type Feed } from '../media';
import { plain } from '../realdrive';
import type { Found } from '../nearby';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 3D 칸(WebGL)은 jsdom 에 없다 — 같은 자리에 마운트 수·small 값을 세는 칸을 둔다. 마운트 1회 = WebGL 문맥 1개(RV-449 ②: 교환마다 새로 만들면 명령 주기가 끊김)
const l3 = vi.hoisted(() => ({ mounts: 0, smalls: [] as boolean[] }));
vi.mock('../lidar3d', async (orig) => {
  const { useEffect } = await import('react');
  return { ...(await orig<object>()), Lidar3D({ small }: { small: boolean }) {
    l3.smalls.push(small);
    useEffect(() => { l3.mounts++; }, [small]);   // lidar3d 는 small 이 바뀌면 WebGL 을 새로 만든다 — 같은 조건으로 센다
    return <div data-lidar3d="stub" />;
  } };
});

const RID = 'r1', HOST = '192.168.123.18', LEASE = '33333333-3333-4333-8333-333333333333';
const found: Found = { key: 'mdns:go2', via: 'mdns', name: 'GO2-friday', host: HOST, port: 8765, rid: RID, agent: `ws://${HOST}:8765/phone/ws` };
const LIMITS = { vx_min: 0, vx_max: 1.5, vy_min: 0, vy_max: 0, wz_min: -0.5, wz_max: 0.5, commands: [[0, 0, 0], [0.5, 0, 0]] };
const cap = (ch: string, on: boolean) => ({ available: on, reason: on ? 'Ready' : 'RGB source is disabled', token: on ? ch[0].repeat(43) : null });
const MEDIA = { version: 'media/1', path: '/phone/media/ws', robot: RID, epoch: 1, episode_id: null, rgb: cap('rgb', true), external: cap('ext', false), lidar: cap('lidar', true) };
const welcome = (media?: unknown) => ({ t: 'hello', id: 'p1', robot: RID, proto: 'fh-phone/1', simulation: false, camera_token: null, limits: LIMITS, media,
  policy: { name: 'go2-sport', version: 'v1' }, ping_interval_ms: 1000, link_timeout_ms: 3000, lease_timeout_ms: 15000 });
const st = (p: Record<string, unknown> = {}) => ({ t: 'state', robot: RID, robot_id: RID, pose: null, speed: 0, battery: { soc: 70 }, latched: true, stop_gen: 1, stop_ref: 0,
  applied: [0, 0, 0], mode: 'IDLE', controller: null, controller_device: null, controller_connected: false, lease_id: null, stop_requested: false,
  posture: 'STAND', velocity: [0, 0, 0], echo: null, wall_time_ms: Date.now(), simulation: false, ...p });

let root: Root | null = null, box: HTMLDivElement;
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(1); else await new Promise((r) => setTimeout(r, 0)); });
const $ = (s: string) => box.querySelector<HTMLElement>(s);
const btn = (t: string) => [...box.querySelectorAll('button')].find((b) => b.textContent === t) as HTMLButtonElement | undefined;
const click = async (el: Element | null | undefined) => { expect(el).toBeTruthy(); act(() => { (el as HTMLElement).click(); }); await flush(); };
const link = () => (window as { fhGo2Link?: { seq: string } }).fhGo2Link;

/** addr = 이 로봇의 media 주소가 있다고 둔다(지금 실기 경로는 robot_id 만 저장 — 주소 있는 경우는 앞으로의 길·시뮬 직결과 같음). exp = 출입증 남은 초 */
async function connected(media?: unknown, { addr = false, exp = 600 } = {}) {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const key = `${init.method ?? 'GET'} ${url.replace(/^\/api\/v1/, '').split('?')[0]}`;
    const body = key === `POST /robots/${RID}/phone-pass` ? { token: 'pass-secret', exp: Math.floor(Date.now() / 1000) + exp, kid: 'k1' } : { items: [] };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
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
  if (addr) (sim.get().robot as { agent_address?: string }).agent_address = `ws://${HOST}:8765`;
  act(() => { window.dispatchEvent(new CustomEvent('fh-go2-link', { detail: { seq: link()!.seq, port: 40123, nonce: '0123456789abcdef0123456789abcdef' } })); });
  await flush();
  const a = FakeWS.all.find((w) => w.url.startsWith('ws://127.0.0.1:40123/') && !w.url.includes('media'))!;
  a.auto = ((m: Msg) => (m.t === 'lease.take' ? { lease_id: LEASE } : ['hello', 'cmd', 'ping', 'stop'].includes(m.t) ? undefined : {})) as FakeWS['auto'];
  act(() => a.open()); await flush();
  act(() => a.recv(welcome(media))); await flush();
  act(() => a.recv(st())); await flush();
  return a;
}
const view = (ch: string) => $(`[data-real-view="${ch}"]`)!;
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); sim.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); l3.mounts = 0; l3.smalls = []; });
/** media 저장소의 라이다 값만 바꿔 보인다(앱 중계 media 길이 없어 실제로는 받지 못함). lidar() 값(state·at)이 바뀔 때만 새 객체 — useSyncExternalStore 가 같은 값엔 같은 객체를 요구 */
function fakeLidar(lidar: () => Partial<Feed>) {
  const get = media.get.bind(media);
  let seen: unknown = null, key = '', out: ReturnType<typeof get> | null = null;
  vi.spyOn(media, 'get').mockImplementation(() => {
    const f = get(), p = lidar(), k = `${p.state}:${p.at}`;
    if (f !== seen || k !== key) { seen = f; key = k; out = { ...f, lidar: { ...f.lidar, ...p } }; }
    return out!;
  });
}
const XYZ = new Float32Array(9);
const live = (p: Partial<Feed> = {}): Partial<Feed> => ({ state: 'live', why: '', at: Infinity, n: 3, xyz: XYZ, frame: 'lidar_link', ver: 1, ...p });
const ST = { lease_id: LEASE, controller: 'u-lee', controller_connected: true };
const ptr = (el: Element, type: string, x: number, y: number) => act(() => { el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 })); });
async function driving(a: FakeWS) {
  await click(btn('조종 시작'));
  act(() => a.recv(st(ST))); await flush();
  await click(btn('잠금 해제'));
  act(() => a.recv(st({ ...ST, latched: false }))); await flush();
}

describe('실기 직결 조종 화면 배치', () => {
  it('media 주소가 없는 실기 경로(지금 정상 연결): 큰 화면 = 카메라, 라이다 칸은 «카메라만» 안내뿐 — 3D·교환 단추 없음, 라이다를 받으려 하지 않음 (RV-449 ③)', async () => {
    const want = vi.spyOn(media, 'want');
    await connected(MEDIA);
    expect($('[data-real-drive]')?.getAttribute('data-main')).toBe('rgb');
    expect(view('lidar').className).toContain('pip');
    expect(view('lidar').hasAttribute('data-off')).toBe(true);
    expect(view('lidar').textContent).toBe('라이다 화면 없음 — 이 연결은 카메라만 보입니다');
    expect($('[data-real-swap]')).toBeNull();
    expect($('[data-lidar3d]')).toBeNull();
    expect(want.mock.calls.filter(([ch]) => ch === 'lidar')).toEqual([]);
  });

  it('새 점을 받는 중이면 큰 화면 = 라이다, 작은 창을 누르면 바뀜 — 두 칸·3D 칸은 다시 만들지 않음(1회 토큰·WebGL)', async () => {
    fakeLidar(() => live());
    await connected(MEDIA, { addr: true });
    expect($('[data-real-drive]')?.getAttribute('data-main')).toBe('lidar');
    expect(view('lidar').className).toContain('big');
    expect(view('rgb').className).toContain('pip');
    const rgb = view('rgb').firstElementChild, l3d = $('[data-lidar3d]'), want = vi.spyOn(media, 'want');
    await click($('[data-real-swap="rgb"]'));
    expect($('[data-real-drive]')?.getAttribute('data-main')).toBe('rgb');
    expect(view('rgb').className).toContain('big');
    expect(view('lidar').className).toContain('pip');
    expect(view('rgb').firstElementChild).toBe(rgb);   // 같은 칸(다시 그리지 않음)
    expect($('[data-lidar3d]')).toBe(l3d);
    expect(want).not.toHaveBeenCalled();   // 받기 해지·다시 받기 0
    await click($('[data-real-swap="lidar"]'));
    expect($('[data-real-drive]')?.getAttribute('data-main')).toBe('lidar');
    expect(l3.mounts).toBe(1);
    expect(new Set(l3.smalls)).toEqual(new Set([false]));   // 크기는 CSS 만 — small 이 바뀌면 lidar3d 가 WebGL 을 새로 만든다
  });

  it('가짜 시계: 전진 스틱을 쥔 채 큰 화면을 여러 번 바꿔도 입력이 유지되고 명령이 50 ms 마다 그대로 (RV-449 ②)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    fakeLidar(() => live());
    const a = await connected(MEDIA, { addr: true });
    await driving(a);
    const fwd = $('[aria-label="전후 조이스틱"]')!;
    fwd.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON() {} }) as DOMRect;
    ptr(fwd, 'pointerdown', 50, 0);
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(a.of('cmd').slice(-1)[0]).toMatchObject({ vx: 1.5 });
    const from = a.of('cmd').length;
    for (let i = 0; i < 6; i++) {
      await click($('[data-real-swap]'));
      await act(() => vi.advanceTimersByTimeAsync(100));
    }
    const during = a.of('cmd').slice(from);
    expect(during.length).toBeGreaterThanOrEqual(12);   // 600 ms+ ÷ 50 ms — 빠진 주기 없음
    expect(during.every((c) => c.vx === 1.5)).toBe(true);
    expect(l3.mounts).toBe(1);
    ptr(fwd, 'pointerup', 50, 0);
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(a.of('cmd').slice(-1)[0]).toMatchObject({ vx: 0, wz: 0 });
  });

  it('라이다 대기·2초 넘은 옛 점이면 큰 화면 = 카메라, 다시 와도 저절로 돌아가지 않고(깜빡임 0) 작은 창을 눌러 돌아감 (RV-449 ④)', async () => {
    let at = performance.now(), state: Feed['state'] = 'wait';
    fakeLidar(() => (state === 'wait' ? { state } : live({ at })));
    const a = await connected(MEDIA, { addr: true });
    const poke = async () => { act(() => a.recv(st())); await flush(); };   // 다시 그리기(실제로는 1초마다 useTick)
    expect($('[data-real-drive]')?.getAttribute('data-main')).toBe('rgb');
    expect(view('lidar').textContent).toContain('라이다 기다리는 중');
    expect($('[data-real-swap]')).toBeNull();
    state = 'live'; at = performance.now(); await poke();
    expect($('[data-real-drive]')?.getAttribute('data-main')).toBe('lidar');   // 처음 받으면 한 번 큰 화면으로
    at = performance.now() - 2500; await poke();
    expect($('[data-real-drive]')?.getAttribute('data-main')).toBe('rgb');
    expect(view('lidar').textContent).toContain('라이다 신호 없음');
    expect($('[data-real-swap]')).toBeNull();
    at = performance.now(); await poke();
    expect($('[data-real-drive]')?.getAttribute('data-main')).toBe('rgb');   // 새 점이 다시 와도 그대로
    await click($('[data-real-swap="lidar"]'));
    expect($('[data-real-drive]')?.getAttribute('data-main')).toBe('lidar');
    expect(l3.mounts).toBe(1);   // 대기·멈춤 동안에도 3D 칸은 그대로
  });

  it('화면 글에 내부 규약명(media/1)·영문 원문이 없음 — 라이다를 알리지 않는 로봇은 쉬운 말 (RV-449 ⑤)', async () => {
    await connected(undefined, { addr: true });
    expect($('[data-real-drive]')?.getAttribute('data-main')).toBe('rgb');
    expect(view('lidar').textContent).toBe(`라이다 신호 없음 — ${plain(NO_MEDIA)}`);
    expect(view('lidar').textContent).toContain('관측 영상을 알리지 않습니다');
    expect(box.textContent).not.toMatch(/media\/1/);
    expect(plain(BAD_WELCOME)).not.toMatch(/media/);
    expect(plain('받은 자료가 media/1 약속과 달라 연결을 닫았습니다')).toBe('받은 자료가 약속과 달라 연결을 닫았습니다');
    expect(plain('RGB 카메라가 꺼져 있습니다 (RGB source is disabled)')).toBe('RGB 카메라가 꺼져 있습니다');
    expect(plain('영상 연결 권한(10초·1회)이 끝났습니다')).toBe('영상 연결 권한(10초·1회)이 끝났습니다');
  });

  it('미검증·현장 비상 정지 수단 안내는 접힌 카드에도 보이고, 실효 상한만 접힘. 조종 시작·잠금 해제는 아래 띠 (RV-449 ①)', async () => {
    const a = await connected();
    expect($('[data-real-pill]')?.textContent).toBe('실기 · 미검증 · 정지 잠금 · GO2-friday · 배터리 70%');
    const info = $('[data-real-info]')!;
    expect(info.getAttribute('aria-expanded')).toBe('false');
    const un = $('[data-real-unverified]')!;
    expect(un.textContent).toContain('현장 비상 정지 수단');
    expect(un.closest('[hidden]')).toBeNull();
    expect($('[data-real-range]')?.textContent).toContain('후진 없음');
    expect($('[data-real-range]')!.closest('[hidden]')).not.toBeNull();
    await click(info);
    expect($('.rd-card-t')!.hidden).toBe(false);
    expect($('[data-real-band]')?.textContent).toBe('조종 시작');
    await click(btn('조종 시작'));
    act(() => a.recv(st(ST))); await flush();
    expect($('[data-real-band]')?.textContent).toBe('잠금 해제');
    expect(box.querySelectorAll('.dv-stick')).toHaveLength(2);
    act(() => a.recv(st({ ...ST, latched: false }))); await flush();
    expect($('[data-real-band]')).toBeNull();
    expect($('[data-real-pill]')?.textContent).toContain('움직일 수 있음');
  });

  it('반납 실패·출입증 만료 임박이 겹쳐도 안전 글은 카드 맨 위에 다 있고 접힌 곳에 들어가지 않음 (RV-449 ①)', async () => {
    const a = await connected(undefined, { exp: 30 });
    await driving(a);
    a.auto = ((m: Msg) => (m.t === 'lease.release' ? null : ['hello', 'cmd', 'ping', 'stop'].includes(m.t) ? undefined : {})) as FakeWS['auto'];
    await click($('[data-real-leave]'));
    await act(() => new Promise((r) => setTimeout(r, 2100)));
    await flush();
    const card = $('[data-real-card]')!, ps = [...card.children].filter((e) => e.matches('p'));
    expect(ps.map((e) => e.textContent)).toEqual([
      expect.stringContaining('조종권 반납을 확인하지 못했습니다'),
      expect.stringContaining('출입증'),
      expect.stringContaining('현장 비상 정지 수단'),
    ]);
    expect(ps.every((e) => !e.closest('[hidden]'))).toBe(true);
    expect(btn('다시 반납')).toBeTruthy();
  });
});
