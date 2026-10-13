// B2 저장(계약 FHGATE-CONTRACT §1 저장, d4e5002): 앱에서는 saveFile 결과로만 «저장됨». 가짜 플러그인 — 실기기 아님.
import { afterEach, expect, test, vi } from 'vitest';
import { saveBlob } from '../../src/data/fmt';
afterEach(() => vi.unstubAllGlobals());
const app = (P?: object) => vi.stubGlobal('Capacitor', { isNativePlatform: () => true, Plugins: P ? { FhGate: P } : {} });
const N = 'foothold-v2-history-1760000000000.csv', B = () => new Blob(['a,b\n1,2\n']);

test('saved:true 일 때만 저장됨 · base64 는 원본 바이트', async () => {
  const saveFile = vi.fn(async () => ({ saved: true, bytes: 8, gen: 3 })); app({ saveFile });
  expect(await saveBlob(N, B())).toBe(`저장됨(${N})`);
  expect(saveFile).toHaveBeenCalledWith({ name: N, base64: btoa('a,b\n1,2\n') });
});
test('취소·쓰기 실패·플러그인 없음은 저장됨이 아님', async () => {
  app({ saveFile: async () => { throw { code: 'cancelled' }; } }); expect(await saveBlob(N, B())).toBe('저장 취소');
  app({ saveFile: async () => { throw { code: 'io' }; } }); expect(await saveBlob(N, B())).toMatch(/저장 안 됨/);
  app(); expect(await saveBlob(N, B())).toMatch(/미지원/);
});
