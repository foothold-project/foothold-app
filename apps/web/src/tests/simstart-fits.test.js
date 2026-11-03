// 웹 시작 위치 막기(simstart.tsx blocked) = 시뮬 시작 검사(mobile/sim/astar.js fits) 대조(.js — 시뮬 모듈은 타입 없음).
// 어긋나면 웹이 통과시킨 자리를 시뮬이 «기본 위치에서 시작»으로 바꾼다
import { describe, expect, it } from 'vitest';
import { blocked } from '../simstart';
import { CLEARANCE, fits } from '../../../../mobile/sim/astar.js';
import { decodeMap } from '../../../../mobile/sim/lidar.js';
import WH from '../../../../mobile/sim/assets/warehouse/map.json';
import F2 from '../../../../mobile/sim/assets/factory-zone/map-f2.json';

describe('시작 위치 판정 = 시뮬 fits', () => {
  it('CLEARANCE 값이 같다', () => {
    expect(blocked({ ...decodeMap(WH) }, ...[0, 0])).toBe('');   // 창고 기본 시작은 됨
    expect(CLEARANCE).toBe(0.45);   // simstart.tsx 의 CLEARANCE 와 같아야 함(바뀌면 둘 다)
  });
  it.each([['warehouse', WH], ['factory-zone f2', F2]])('%s: 칸 표본마다 같은 판정', async (_n, j) => {
    const m = decodeMap(j), bad = [], seen = new Set();
    for (let i = 0; i < m.w * m.h; i += 97) {
      const x = m.origin[0] + (i % m.w + 0.5) * m.res, y = m.origin[1] + (m.h - 1 - Math.floor(i / m.w) + 0.5) * m.res, why = blocked(m, x, y);
      seen.add(why.slice(0, 6));
      if (!why !== (await fits(m, { x, y }))) bad.push([x, y]);
    }
    expect(bad).toEqual([]);
    expect([...seen].sort()).toEqual(expect.arrayContaining(['', '벽·물건에서'.slice(0, 6), '벽·장애물 '.slice(0, 6)]));   // 됨·벽 가까이·벽 표본이 다 있음
  }, 60_000);
});
