// 실기 직결 조종 화면 배치(11-20 RB-PHONE-DIRECT-LOOK): 큰 화면 = 라이다(받을 때) / 카메라, 작은 창 눌러 바꿈(바꿔도 영상 연결 유지),
// 라이다 없음 → 큰 화면 카메라 + 작은 창 이유, 미검증·실효 상한은 접히는 카드(늘 DOM 에), 조종 시작·잠금 해제는 아래 띠. 연결 준비는 realconnect.test.tsx 와 같은 가짜 서버·에이전트
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { ROBOTS, USERS } from './fixtures';
import { FakeWS, type Msg } from './fakeWs';
import { sim } from '../phone';
import { media } from '../media';
import type { Found } from '../nearby';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); });
const $ = (s: string) => box.querySelector<HTMLElement>(s);
const btn = (t: string) => [...box.querySelectorAll('button')].find((b) => b.textContent === t) as HTMLButtonElement | undefined;
const click = async (el: Element | null | undefined) => { expect(el).toBeTruthy(); act(() => { (el as HTMLElement).click(); }); await flush(); };
const link = () => (window as { fhGo2Link?: { seq: string } }).fhGo2Link;

async function connected(media?: unknown) {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const key = `${init.method ?? 'GET'} ${url.replace(/^\/api\/v1/, '').split('?')[0]}`;
    const body = key === `POST /robots/${RID}/phone-pass` ? { token: 'pass-secret', exp: Math.floor(Date.now() / 1000) + 600, kid: 'k1' } : { items: [] };
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
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); sim.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('실기 직결 조종 화면 배치', () => {
  it('라이다를 받는 중이면 큰 화면 = 라이다, 작은 창(카메라)을 누르면 바뀜 — 두 칸은 다시 그리지 않아 영상 연결을 닫지 않음(1회 토큰)', async () => {
    // 실기 직결은 앱 중계가 연결 1개만이라 media 칸이 지금은 «끊김»이 된다 — 받는 중 상태는 저장소 값을 바꿔 본다
    const get = media.get.bind(media);
    let seen: ReturnType<typeof get> | null = null, out: ReturnType<typeof get> | null = null;
    vi.spyOn(media, 'get').mockImplementation(() => { const f = get(); if (f !== seen) { seen = f; out = { ...f, lidar: { ...f.lidar, state: 'wait' } }; } return out!; });
    await connected(MEDIA);
    expect($('[data-real-drive]')?.getAttribute('data-main')).toBe('lidar');
    expect(view('lidar').className).toContain('big');
    expect(view('rgb').className).toContain('pip');
    const rgb = view('rgb').firstElementChild, want = vi.spyOn(media, 'want');
    await click($('[data-real-swap="rgb"]'));
    expect($('[data-real-drive]')?.getAttribute('data-main')).toBe('rgb');
    expect(view('rgb').className).toContain('big');
    expect(view('lidar').className).toContain('pip');
    expect(view('rgb').firstElementChild).toBe(rgb);   // 같은 칸(다시 그리지 않음)
    expect(want).not.toHaveBeenCalled();   // 받기 해지·다시 받기 0
    await click($('[data-real-swap="lidar"]'));
    expect($('[data-real-drive]')?.getAttribute('data-main')).toBe('lidar');
  });

  it('라이다를 알려도 받지 못하면(끊김) 큰 화면 = 카메라, 작은 창은 이유 글, 바꾸기 단추 없음', async () => {
    await connected(MEDIA);
    expect($('[data-real-drive]')?.getAttribute('data-main')).toBe('rgb');
    expect(view('lidar').textContent).toContain('끊겼습니다');
    expect($('[data-real-swap]')).toBeNull();
  });

  it('라이다를 못 받으면 큰 화면 = 카메라, 작은 창은 이유 글, 바꾸기 단추 없음', async () => {
    await connected();
    expect($('[data-real-drive]')?.getAttribute('data-main')).toBe('rgb');
    expect(view('lidar').className).toContain('pip');
    expect(view('lidar').textContent).toContain('관측 영상');
    expect($('[data-real-swap]')).toBeNull();
  });

  it('상태 알약(미검증·잠금·배터리), 접힌 카드에도 미검증·실효 상한, 조종 시작·잠금 해제는 아래 띠', async () => {
    const a = await connected();
    expect($('[data-real-pill]')?.textContent).toBe('실기 · 미검증 · 정지 잠금 · GO2-friday · 배터리 70%');
    const info = $('[data-real-info]')!;
    expect(info.getAttribute('aria-expanded')).toBe('false');
    expect($('[data-real-unverified]')?.textContent).toContain('미검증');
    expect($('[data-real-range]')?.textContent).toContain('후진 없음');
    expect($('.rd-card-t')!.hidden).toBe(true);
    await click(info);
    expect($('.rd-card-t')!.hidden).toBe(false);
    expect($('[data-real-band]')?.textContent).toBe('조종 시작');
    await click(btn('조종 시작'));
    act(() => a.recv(st({ lease_id: LEASE, controller: 'u-lee', controller_connected: true }))); await flush();
    expect($('[data-real-band]')?.textContent).toBe('잠금 해제');
    expect(box.querySelectorAll('.dv-stick')).toHaveLength(2);
    act(() => a.recv(st({ lease_id: LEASE, controller: 'u-lee', controller_connected: true, latched: false }))); await flush();
    expect($('[data-real-band]')).toBeNull();
    expect($('[data-real-pill]')?.textContent).toContain('움직일 수 있음');
  });
});
