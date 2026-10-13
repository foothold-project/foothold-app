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
    state: async () => ({ ...s }),
    addListener: (n: string, f: (v: any) => void) => { L[n] = f; },
    login: vi.fn(async () => ({ gen: ++s.gen, stored: true })),
    logout: vi.fn(async () => ({ gen: ++s.gen, ok: true })),
    setGate: vi.fn(async ({ origin }: { origin: string }) => { s.origin = origin; return { gen: ++s.gen }; }),
    request: vi.fn(async () => ({ gen: s.gen, status: 200, body: '{"docs":[]}' })),
    photo: vi.fn(async () => ({ gen: s.gen, status: 200, base64: btoa('jpg') })),
    wsTicket: vi.fn(async () => ({ gen: s.gen, url: 'wss://gate.test:8453/api/app/ws?t=x' })),
    later,
  };
  return P;
}
const mk = async (P: any) => (await import('../../src/data/transport')).nativeTransport(P);

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
    await expect(t.wsUrl()).resolves.toBeNull();   // 플러그인 현재 gen 은 1 → 표 gen 1 ≠ 화면 2 → 열지 않음
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
    const P = fake({ gen: 1, locked: true, origin: 'https://g' }); P.logout.mockResolvedValueOnce({ gen: 2, ok: false });
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
    await expect(t.wsUrl()).resolves.toBeNull(); expect(f).toHaveBeenCalledTimes(2);
  });
  it('setGate 뒤 gen 바뀜 → 표·요청은 새 gen 만', async () => {
    const P = fake(); const t = await mk(P);
    expect(await t.setGate!('https://other:8453')).toBeNull();
    await expect(t.wsUrl()).resolves.toMatch(/^wss:/);   // 플러그인도 gen 2
    expect(await t.where()).toContain('https://other:8453');
  });
  it('logout ok=false → 저장 실패 안내(성공으로 단정 안 함)', async () => {
    const P = fake(); P.logout.mockResolvedValueOnce({ gen: 2, ok: false });
    expect(await (await mk(P)).logout()).toEqual({ ok: false, note: expect.stringMatching(/저장 실패/) });
  });
});
