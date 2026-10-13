// B2 저장(계약 FHGATE-CONTRACT §1 저장, d4e5002·af602ba): 시작 epoch·gen·화면이 그대로이고 r.gen 이 현재일 때만 «저장됨». 가짜 플러그인 — 실기기·SAF 창 아님.
import { afterEach, expect, test, vi } from 'vitest';
afterEach(() => vi.unstubAllGlobals());
const N = 'foothold-v2-history-1760000000000.csv';
const blob = (hold?: Promise<void>) => ({ size: 8, arrayBuffer: async () => { await hold; return new TextEncoder().encode('a,b\n1,2\n').buffer; } }) as unknown as Blob;
function fake() {
  const s = { gen: 1 };
  return {
    s, L: {} as Record<string, (v: any) => void>,
    state: async () => ({ ...s, origin: 'https://g', loggedIn: true, stored: true, locked: false }),
    addListener(n: string, f: any) { this.L[n] = f; },
    logout: vi.fn(async () => ({ gen: ++s.gen, ok: true, server: 'none' })),
    saveFile: vi.fn(async () => ({ saved: true, bytes: 8, gen: s.gen })),
  };
}
const mk = async (P: any) => { const t = (await import('../../src/data/transport')).nativeTransport(P); await t.where(); return t; };
const yes = () => true;

test('정상: saved + 현재 gen → 저장됨 · base64 는 원본 바이트', async () => {
  const P = fake(), t = await mk(P);
  expect(await t.saveFile!(N, blob(), yes)).toBe(`저장됨(${N})`);
  expect(P.saveFile).toHaveBeenCalledWith({ name: N, base64: btoa('a,b\n1,2\n') });
});
test('준비(바이트 읽기) 보류 중 로그아웃·화면 이탈 → 저장 창 안 엶 · 버림', async () => {
  for (const cut of ['logout', 'leave'] as const) {
    const P = fake(), t = await mk(P); let go!: () => void, here = true;
    const pr = t.saveFile!(N, blob(new Promise<void>((r) => { go = r; })), () => here);
    if (cut === 'logout') await t.logout(); else here = false;
    go();
    expect(await pr).toBeNull(); expect(P.saveFile).not.toHaveBeenCalled();
  }
});
test('옛 gen 결과·창 사이 로그아웃 → 저장됨 아님', async () => {
  const P = fake(), t = await mk(P);
  P.saveFile.mockResolvedValueOnce({ saved: true, bytes: 8, gen: 0 });
  expect(await t.saveFile!(N, blob(), yes)).toMatch(/결과 미확인/);
  let fin!: (v: any) => void;
  P.saveFile.mockImplementationOnce(() => new Promise((r) => { fin = r; }) as any);
  const pr = t.saveFile!(N, blob(), yes);
  await new Promise((r) => setTimeout(r));
  await t.logout(); fin({ saved: true, bytes: 8, gen: 1 });
  expect(await pr).toBeNull();
});
test('취소·쓰기 실패 · 5 MB 초과는 읽기 전에 거부', async () => {
  const P = fake(), t = await mk(P);
  P.saveFile.mockRejectedValueOnce({ code: 'cancelled', data: { gen: 1 } }); expect(await t.saveFile!(N, blob(), yes)).toBe('저장 취소');
  P.saveFile.mockRejectedValueOnce({ code: 'io', data: { gen: 1 } }); expect(await t.saveFile!(N, blob(), yes)).toMatch(/저장 안 됨/);
  const ab = vi.fn();
  expect(await t.saveFile!(N, { size: 5 * 1024 * 1024 + 1, arrayBuffer: ab } as unknown as Blob, yes)).toMatch(/5 MB/);
  expect(ab).not.toHaveBeenCalled();
});
test('원격 A(실제 Capacitor · 전송층 web) → 저장 미지원, a.download 를 성공으로 쓰지 않음', async () => {
  vi.resetModules();
  vi.stubGlobal('Capacitor', { isNativePlatform: () => true, Plugins: {} });
  const { saveBlob } = await import('../../src/data/fmt');
  expect(await saveBlob(N, blob())).toMatch(/미지원/);
});
