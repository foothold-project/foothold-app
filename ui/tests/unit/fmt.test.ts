import { expect, test } from 'vitest';
import { tms } from '../../src/data/fmt';
// 서버 시각은 콜론 없는 시간대(+0900) — Safari Date.parse 가 못 읽어 모든 시각이 0(1970)이 되던 경우를 막는다
test('tms: +0900 → +09:00 으로 읽음, 못 읽으면 0', () => {
  expect(tms('2026-10-13T12:46:00+0900')).toBe(Date.UTC(2026, 9, 13, 3, 46, 0));
  expect(tms('2026-10-13T12:46:00-0130')).toBe(Date.UTC(2026, 9, 13, 14, 16, 0));
  expect(tms('')).toBe(0); expect(tms(null)).toBe(0); expect(tms('엉터리')).toBe(0);
});
