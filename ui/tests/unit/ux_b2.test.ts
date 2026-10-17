// UX B2(10-15): R31 facts 한 출처 · A2 쉬운 말. 화면 흐름은 runs/ux-fix-20261015 헤드리스 원물
import { expect, test } from 'vitest';
const mem = new Map<string, string>();
(globalThis as any).localStorage ??= { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
const { UNSUP, WHY, STOP_SUB, STOP_TIP } = await import('../../src/data/facts');
const { httpTxt } = await import('../../src/data/shared');

// 소스 원문(vite glob ?raw — node 타입 없이)
const SRC = import.meta.glob<string>('../../src/**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true });

test('R31 화면이 쓰는 WHY[키]는 모두 facts 에 있음(Record 라 tsc 가 못 잡음)', () => {
  expect(Object.keys(SRC).length).toBeGreaterThan(40);
  const used = Object.values(SRC).flatMap((t) => [...t.matchAll(/WHY\['([^']+)'\]/g)].map((m) => m[1]));
  expect(used.length).toBeGreaterThan(5);
  expect(used.filter((k) => !(k in WHY))).toEqual([]);
});
test('R31 이 빌드에 입구가 있는 기능을 «안 함»으로 부정하지 않음 · 미확인은 «서버가 허용할 때만»', () => {
  const t = Object.fromEntries(UNSUP);
  expect(t['시뮬 끄기·연장']).not.toContain('앱에서 안 함');
  expect(t['시뮬 끄기·연장']).toContain('서버가 허용할 때만');
  expect(t['뎁스 영상·3D 점군']).toContain('3D 점군은 관제의 시뮬 보조 뷰');
  expect(t['저장 SLAM 지도 위치 맞추기']).toContain('미지원');
  expect(t['저장 SLAM 지도 위치 맞추기']).toContain('실시간 SLAM 지도는 서버가 그 지도 상태에 묶어 보낸 위치만');
});
test('R05 STOP 보조 문구 = 명령 0·잠금, 몸 정지는 화면 확인 · 화면 틀에 «전체 정지» 0', () => {
  expect(STOP_SUB).toBe('명령 0·잠금'); expect(STOP_TIP).toContain('몸이 멈췄는지는 화면에서 확인');
  expect(Object.entries(SRC).filter(([, t]) => t.includes('전체 정지')).map(([f]) => f)).toEqual([]);
});
test('A2 HTTP 상태는 쉬운 말 + 원래 코드 괄호', () => {
  expect(httpTxt(404)).toBe('서버에 없음 (HTTP 404)');
  expect(httpTxt(403)).toContain('권한 없음'); expect(httpTxt(503)).toContain('서버 오류'); expect(httpTxt(418)).toContain('요청 실패');
});
