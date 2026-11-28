import { afterEach, describe, expect, it } from 'vitest';
import { setStage, spx, stageRect, sx, sy, vh, vw } from '../stage';

describe('무대 좌표 도우미', () => {
  afterEach(() => setStage(null));
  it('무대 없음(폰 틀) = 화면 좌표 그대로', () => {
    expect([sx({ clientX: 100 }), sy({ clientY: 50 }), spx(30), vw(), vh()]).toEqual([100, 50, 30, innerWidth, innerHeight]);
  });
  it('1600 × 900 창(배율 5/6): 화면 100 px 끌기 = 무대 120 px, 창 크기 = 무대 1920 × 1080', () => {
    setStage({ s: 1600 / 1920, x: 0, y: 0 });
    expect(spx(100)).toBeCloseTo(120);
    expect([vw(), vh()]).toEqual([1920, 1080]);
  });
  it('좌우 여백(가운데 정렬)이 있으면 빼고 나눔 · 요소 상자도 무대 좌표', () => {
    setStage({ s: 0.5, x: 100, y: 0 });
    expect(sx({ clientX: 600 })).toBe(1000);
    const el = document.createElement('div');
    el.getBoundingClientRect = () => ({ left: 200, top: 40, right: 300, bottom: 90, width: 100, height: 50, x: 200, y: 40, toJSON: () => ({}) });
    expect(stageRect(el)).toEqual({ left: 200, top: 80, right: 400, bottom: 180, width: 200, height: 100 });
  });
});
