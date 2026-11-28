import { describe, expect, it } from 'vitest';
import { stageFit } from '../App';

// PC 무대 1920 × 1080 을 창에 맞춤: 비율 그대로, 남는 쪽은 가운데 정렬(바탕색), 스크롤 없음
describe('stageFit', () => {
  it('1920 × 1080 은 그대로', () => expect(stageFit(1920, 1080)).toEqual({ s: 1, x: 0, y: 0 }));
  it('1600 × 900 은 같은 비율로 줄임', () => expect(stageFit(1600, 900)).toEqual({ s: 1600 / 1920, x: 0, y: 0 }));
  it('주소창 · 북마크 줄로 높이가 줄면(1920 × 960) 높이에 맞추고 좌우는 바탕', () => {
    const f = stageFit(1920, 960);
    expect(f.s).toBeCloseTo(960 / 1080);
    expect(f.y).toBe(0);
    expect(f.x * 2 + 1920 * f.s).toBeCloseTo(1920);
  });
  it('큰 창(2560 × 1440)은 늘림', () => expect(stageFit(2560, 1440).s).toBeCloseTo(4 / 3));
});
