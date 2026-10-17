// 전송층 선택(원격 A ≠ B)과 네이티브 세대(gen) 규칙 — 가짜 FhGate(계약 v0.1 404da91 모양). 실제 플러그인·실기기 호출 아님.
import { afterEach, describe, expect, it, vi } from 'vitest';

const pick = async (origin: string, fh?: object) => {
  vi.resetModules();
  vi.stubGlobal('window', { location: { origin }, Capacitor: fh ? { isNativePlatform: () => true, Plugins: { FhGate: fh } } : { isNativePlatform: () => true } });
  vi.stubGlobal('location', { origin, protocol: origin.split(':')[0] + ':' });
  return (await import('../../src/data/transport')).T.kind;
};
afterEach(() => vi.unstubAllGlobals());

function fake(start = { gen: 1, locked: false, origin: 'https://gate.test:8453' }) {
  const s = { ...start }, L: Record<string, (v: any) => void> = {}, hold: Record<string, (v: any) => void> = {};
  const later = (k: string) => new Promise((res) => { hold[k] = res; });
  const P = {
    s, L, hold,
    state: vi.fn(async () => ({ ...s, loggedIn: true, stored: true })),
    addListener: (n: string, f: (v: any) => void) => { L[n] = f; },
    login: vi.fn(async () => ({ gen: ++s.gen, stored: true })),
    logout: vi.fn(async () => ({ gen: ++s.gen, ok: true, server: 'pending' })),
    setGate: vi.fn(async ({ origin }: { origin: string }) => { s.origin = origin; return { gen: ++s.gen }; }),
    request: vi.fn(async () => ({ gen: s.gen, status: 200, body: '{"docs":[]}' })),
    photo: vi.fn(async () => ({ gen: s.gen, status: 200, base64: btoa('jpg') })),
    wsTicket: vi.fn(async () => ({ gen: s.gen, url: 'wss://gate.test:8453/api/app/ws?t=x' })),
    later,
  };
  return P;
}
const mod = () => import('../../src/data/transport');
const mk = async (P: any) => (await mod()).nativeTransport(P);
const tick = () => new Promise((r) => setTimeout(r));

describe('선택: 연결 하나', () => {
  it('원격 A(관문 출처) 는 FhGate·isNativePlatform 이 있어도 web', async () => { expect(await pick('https://gate.test:8453', fake())).toBe('web'); });
  it('앱 출처 + FhGate 일 때만 native', async () => {
    expect(await pick('https://localhost', fake())).toBe('native');
    expect(await pick('capacitor://localhost', fake())).toBe('native');
  });
  it('앱 출처라도 FhGate 없으면 web(플러그인 없는 기본 APK)', async () => { expect(await pick('https://localhost')).toBe('web'); });
});

describe('native 세대', () => {
  it('로그인: 결과 gen 을 현재로 · stored=false 는 안내', async () => {
    const P = fake(); P.login.mockResolvedValueOnce({ gen: 2, stored: false });
    const t = await mk(P);
    const r = await t.login('u', 'p', 'l');
    expect(r.ok).toBe(true); expect((r as any).note).toMatch(/저장 안 됨/);
    await expect(t.wsUrl()).resolves.toEqual({ why: expect.stringMatching(/옛 응답/) });   // 플러그인 현재 gen 1 ≠ 화면 2 → 열지 않음
    expect((await mod()).useNote.getState().note).toMatch(/저장 안 됨/);
  });
  it('로그인 도중 로그아웃(세대 바뀜) → 옛 로그인 결과 버림', async () => {
    const P = fake(); P.login.mockImplementationOnce(() => P.later('login') as any);
    const t = await mk(P);
    const pr = t.login('u', 'p', 'l');
    await new Promise((r) => setTimeout(r));
    await t.logout();                       // gen 2
    P.hold.login({ gen: 3, stored: true }); // 늦게 온 로그인
    expect(await pr).toEqual({ ok: false, error: expect.stringMatching(/옛 응답/) });
    expect(P.request).not.toHaveBeenCalled();
  });
  it('잠김 상태면 로그아웃(디스크 폐기) 먼저, 실패면 로그인 안 함', async () => {
    const P = fake({ gen: 1, locked: true, origin: 'https://g' }); P.logout.mockResolvedValueOnce({ gen: 2, ok: false, server: 'none' });
    const t = await mk(P);
    const r = await t.login('u', 'p', 'l');
    expect(r.ok).toBe(false); expect(P.login).not.toHaveBeenCalled();
  });
  it('다른 gen 의 응답·오류는 stale', async () => {
    const P = fake(); const t = await mk(P);
    P.request.mockResolvedValueOnce({ gen: 9, status: 200, body: '{}' });
    await expect(t.get('docs')).rejects.toThrow(/옛 응답/);
    P.request.mockRejectedValueOnce({ code: 'net', data: { gen: 9 } });
    await expect(t.get('docs')).rejects.toThrow(/옛 응답/);
    P.request.mockRejectedValueOnce({ code: 'net', data: { gen: 1 } });
    await expect(t.get('docs')).rejects.toThrow(/닿지 않음/);
    await expect(t.get('media')).resolves.toEqual({ status: 200, body: '{"docs":[]}' });
    expect(P.request).toHaveBeenLastCalledWith({ op: 'media.list' });
  });
  it('sessionEnded·no_session 은 이 세대일 때만 끝 처리', async () => {
    const P = fake(); const t = await mk(P); const f = vi.fn(); t.onEnded(f);
    await t.wsUrl();
    P.L.sessionEnded({ gen: 7 }); expect(f).not.toHaveBeenCalled();
    P.L.sessionEnded({ gen: 1 }); expect(f).toHaveBeenCalledTimes(1);
    P.wsTicket.mockRejectedValueOnce({ code: 'no_session', data: { gen: 1 } });
    await expect(t.wsUrl()).resolves.toHaveProperty('why'); expect(f).toHaveBeenCalledTimes(2);
  });
  it('setGate 뒤 gen 바뀜 → 표·요청은 새 gen 만', async () => {
    const P = fake(); const t = await mk(P);
    expect(await t.setGate!('https://other:8453')).toBeNull();
    await expect(t.wsUrl()).resolves.toEqual({ url: expect.stringMatching(/^wss:/) });   // 플러그인도 gen 2
    expect(await t.where()).toContain('https://other:8453');
  });
  it('반례: 보류된 state → logout/setGate → 풀림 이면 P.login 0회', async () => {
    for (const cut of ['logout', 'setGate'] as const) {
      const P = fake(); const t = await mk(P); await t.where();
      let free!: (v: any) => void;
      P.state.mockImplementationOnce(() => new Promise((r) => { free = r; }));
      const pr = t.login('u', 'p', 'l');
      await tick();
      if (cut === 'logout') await t.logout(); else await t.setGate!('https://new:8453');
      free({ ...P.s, gen: 1, loggedIn: false, stored: null });   // 옛 state 응답이 늦게 풀림
      expect(await pr).toEqual({ ok: false, error: expect.stringMatching(/옛 응답/) });
      expect(P.login).not.toHaveBeenCalled();
    }
  });
  it('반례: 보류된 옛 logout 결과가 새 setGate·login 의 gen·안내를 덮지 않음', async () => {
    const P = fake(); const t = await mk(P); await t.where();
    P.logout.mockImplementationOnce(() => P.later('lo') as any);
    const lo = t.logout();
    await tick();
    expect(await t.setGate!('https://new:8453')).toBeNull();   // gen 2
    expect(await t.login('u', 'p', 'l')).toEqual({ ok: true });   // gen 3
    P.hold.lo({ gen: 2, ok: true, server: 'pending' });         // 옛 logout 결과가 늦게
    expect(await lo).toEqual({ ok: false, note: expect.stringMatching(/옛 응답/) });
    await expect(t.wsUrl()).resolves.toEqual({ url: expect.stringMatching(/^wss:/) });   // 화면 gen 은 3 그대로
    expect((await mod()).useNote.getState().note).toBe('');
  });
  it('보류된 요청 중 logout → 응답 채택 안 함', async () => {
    const P = fake(); const t = await mk(P); await t.where();
    P.request.mockImplementationOnce(() => P.later('rq') as any);
    const rq = t.get('docs'); await tick();
    await t.logout();
    P.hold.rq({ gen: 1, status: 200, body: '{}' });
    await expect(rq).rejects.toThrow(/옛 응답/);
  });
  it('cold start: 주소 없음(no_gate)·잠김(storage) → 로그인 화면 + 첫 안내 · tls 는 연결 표시로', async () => {
    const A = fake({ gen: 0, locked: false, origin: null as any }); const ta = await mk(A); const fa = vi.fn(); ta.onEnded(fa);
    A.wsTicket.mockRejectedValueOnce({ code: 'no_gate', data: { gen: 0 } });
    expect(await ta.wsUrl()).toEqual({ why: expect.stringMatching(/관문 주소/) }); expect(fa).toHaveBeenCalledTimes(1);
    expect(await ta.hint()).toMatch(/관문 주소/);
    const B = fake({ gen: 4, locked: true, origin: 'https://g' }); const tb = await mk(B); const fb = vi.fn(); tb.onEnded(fb);
    B.request.mockRejectedValueOnce({ code: 'storage', data: { gen: 4 } });
    await expect(tb.get('docs')).rejects.toThrow(/저장 실패/); expect(fb).toHaveBeenCalledTimes(1);
    expect(await tb.hint()).toMatch(/폐기부터/);
    const C = fake(); const tc = await mk(C); const fc = vi.fn(); tc.onEnded(fc);
    C.wsTicket.mockRejectedValueOnce({ code: 'tls', data: { gen: 1 } });
    expect(await tc.wsUrl()).toEqual({ why: '관문 인증서 확인 실패' }); expect(fc).not.toHaveBeenCalled();
  });
  it('401 sessionEnded(옛 gen) 뒤 다음 로그인: 새 gen 의 auth 는 비밀번호 안내, 옛 gen 오류는 stale', async () => {
    const P = fake(); const t = await mk(P); await t.where();
    P.s.gen = 2; P.L.sessionEnded({ gen: 1 });   // 네이티브는 이미 gen 2
    P.login.mockRejectedValueOnce({ code: 'auth', data: { gen: 2 } });
    expect(await t.login('u', 'bad', 'l')).toEqual({ ok: false, error: '계정 또는 비밀번호가 틀림' });
    P.login.mockRejectedValueOnce({ code: 'auth', data: { gen: 1 } });
    expect(await t.login('u', 'bad', 'l')).toEqual({ ok: false, error: expect.stringMatching(/옛 응답/) });
  });
  it('logoutResult 가 logout resolve 보다 먼저: failed → 확인 못 함 · ok → 안내 없음', async () => {
    for (const [sv, want] of [['failed', /확인 못 함/], ['ok', /^$/]] as const) {
      const P = fake(); const t = await mk(P); const N = (await mod()).useNote; await t.where();
      P.logout.mockImplementationOnce(async () => { P.L.logoutResult({ server: sv, gen: 2, reason: '' }); return { gen: ++P.s.gen, ok: true, server: 'pending' }; });
      expect(await t.logout()).toEqual({ ok: true });
      expect(N.getState().note).toMatch(want);
    }
  });
  it('logoutResult: 자기 세대 failed 만 «서버 종료 확인 못 함»', async () => {
    const P = fake(); const t = await mk(P); const N = (await mod()).useNote;
    await t.logout(); expect(N.getState().note).toMatch(/확인 중/);
    P.L.logoutResult({ server: 'failed', gen: 99, reason: '' }); expect(N.getState().note).toMatch(/확인 중/);
    P.L.logoutResult({ server: 'failed', gen: 2, reason: '' }); expect(N.getState().note).toMatch(/확인 못 함/);
  });
  it('logout ok=false → 저장 실패 안내(성공으로 단정 안 함)', async () => {
    const P = fake(); P.logout.mockResolvedValueOnce({ gen: 2, ok: false, server: 'none' });
    expect(await (await mk(P)).logout()).toEqual({ ok: false, note: expect.stringMatching(/저장 실패/) });
  });
});

describe('관문 검사 health (①) — 반례', () => {
  it('네이티브: sync 보류 중 주소 변경 → 풀어도 probe 0회·STALE', async () => {
    const P: any = fake(), st = P.later('state'); P.state = vi.fn(() => st.then(() => ({ ...P.s, loggedIn: false, stored: true })));
    P.probe = vi.fn(async () => ({ status: 200, compat: true, api: 1, gen: P.s.gen }));
    const t = await mk(P), { STALE } = await mod();
    const h = t.health(); const g = t.setGate!('https://other.test:8453');
    P.hold.state(null); await g;
    expect(await h).toEqual({ ok: false, step: 'none', why: STALE }); expect(P.probe).not.toHaveBeenCalled();
  });
  it('네이티브: 응답 보류 → 로그아웃 → 풀기 = 옛 안내 0(STALE)', async () => {
    const P: any = fake(); P.probe = vi.fn(() => P.later('probe'));
    const t = await mk(P), { STALE } = await mod(); await tick();
    const h = t.health(); await tick(); await t.logout(); P.hold.probe({ status: 200, compat: true, api: 1, gen: 1 });
    expect(await h).toEqual({ ok: false, step: 'none', why: STALE });
  });
  it('네이티브: 다른 gen 의 tls 오류는 인증서 칸에 안 붙음, 같은 gen 이면 붙음', async () => {
    const P: any = fake(); const t = await mk(P), { STALE } = await mod(); await tick();
    P.probe = vi.fn(async () => { throw Object.assign(new Error('x'), { code: 'tls', data: { gen: 0 } }); });
    expect(await t.health()).toEqual({ ok: false, step: 'none', why: STALE });
    P.probe = vi.fn(async () => { throw Object.assign(new Error('x'), { code: 'tls', data: { gen: 1 } }); });
    expect(await t.health()).toMatchObject({ ok: false, step: 'tls' });
  });
  const webT = async (f: any) => { await pick('https://gate.test:8453'); vi.stubGlobal('fetch', f); return (await mod()).T; };
  it('웹: 무응답이면 8 s 에 끝남(«확인 중» 영구 0)', async () => {
    vi.useFakeTimers();
    try {
      const t = await webT(vi.fn((_u: string, o: RequestInit) => new Promise((_r, rej) => o.signal!.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))))));
      const h = t.health(); await vi.advanceTimersByTimeAsync(8000);
      expect(await h).toMatchObject({ ok: false, step: 'reach', why: '관문 응답 없음(8 s)' });
    } finally { vi.useRealTimers(); }
  });
  it('웹: redirect 따라가지 않음 · 본문 4 KB 넘으면 관문 아님 · 옛 관문 HTML 200 은 관문 아님', async () => {
    const f = vi.fn(async (_u: string, _o: RequestInit) => { throw new TypeError('Failed to fetch'); });
    expect(await (await webT(f)).health()).toMatchObject({ ok: false, step: 'reach' });
    expect(f.mock.calls[0][1]).toMatchObject({ redirect: 'error', credentials: 'omit' }); expect(f.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    // 맞는 본문 + 공백 5000 B: 상한이 없으면 JSON.parse 가 통과시킴 → 상한이 막아야 함
    expect(await (await webT(async () => new Response('{"app":"foothold-gate","api":1}' + ' '.repeat(5000)))).health()).toMatchObject({ ok: false, step: 'gate', why: '관문 판 확인 못 함(응답이 너무 큼 · 다른 서버)' });
    expect(await (await webT(async () => new Response('<html>old</html>'))).health()).toMatchObject({ ok: false, step: 'gate' });
    expect(await (await webT(async () => new Response('{"app":"foothold-gate","api":1}'))).health()).toMatchObject({ ok: true });
  });
});
