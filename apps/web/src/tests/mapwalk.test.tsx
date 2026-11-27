// U7-06 지도 만들기 로봇 진행 줄: 걸은 시간 · 걸은 거리 · 로봇이 모은 점 수를 서버 진행(MappingProgress elapsed_s · distance_m · point_count) 그대로. 값이 없으면 그 칸은 비움(지어내지 않음)
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { MappingProgress } from '../../../contracts/ts';
import { MapBox } from '../screens/mapmake';

const prog = (p: Partial<MappingProgress> = {}): MappingProgress => ({ session_id: 's1', floor_id: 'f1', status: 'RUNNING', source: 'point_lio', ...p });
const html = (p: Partial<MappingProgress>) => { const box = document.createElement('div'); box.innerHTML = renderToStaticMarkup(<MapBox robot="r-a" p={prog(p)} link={0} />); return box; };
/** 로봇 진행 줄(걸은 시간 · 거리 · 점)의 칸 */
const cells = (p: Partial<MappingProgress>) => [...html(p).querySelectorAll('[aria-label="로봇 진행"] > span')].map((s) => [s.getAttribute('data-walk'), s.textContent]);

describe('지도 만들기 진행: 걸은 시간 · 거리 · 점 수(U7-06)', () => {
  it('셋 다 오면 받은 칸 · 조각 뒤에 그대로, 시간은 분:초 · 거리는 m · 점은 만 단위', () => {
    expect(cells({ elapsed_s: 402, distance_m: 182.4, point_count: 4_120_000 }).filter(([k]) => k)).toEqual([
      ['time', '06:42걸은 시간'], ['dist', '182 m걸은 거리'], ['points', '412 만로봇이 모은 점']]);
  });
  it('한 시간이 넘으면 시:분:초, 10 m 아래 거리는 소수 한 자리, 1 만 아래 점 수는 그대로 · 1 억 넘으면 억', () => {
    expect(cells({ elapsed_s: 3725, distance_m: 7.25, point_count: 9_876 }).filter(([k]) => k).map(([, t]) => t)).toEqual(['1:02:05걸은 시간', '7.3 m걸은 거리', '9,876로봇이 모은 점']);
    expect(cells({ point_count: 960_000_000 }).filter(([k]) => k).map(([, t]) => t)).toEqual(['9.6 억로봇이 모은 점']);
    expect(cells({ point_count: 15_500 }).filter(([k]) => k).map(([, t]) => t)).toEqual(['1.6 만로봇이 모은 점']);
  });
  it('값이 없으면(없음 · null · 음수 · NaN · 무한) 그 칸을 보이지 않음, 0 은 0 으로', () => {
    expect(cells({}).filter(([k]) => k)).toEqual([]);
    expect(cells({ elapsed_s: null as unknown as number, distance_m: -1, point_count: NaN }).filter(([k]) => k)).toEqual([]);
    expect(cells({ distance_m: Infinity }).filter(([k]) => k)).toEqual([]);
    expect(cells({ elapsed_s: 0, distance_m: 0, point_count: 0 }).filter(([k]) => k).map(([, t]) => t)).toEqual(['00:00걸은 시간', '0.0 m걸은 거리', '0로봇이 모은 점']);
  });
  it('줄 둘로 나눔: 위 = 받은 3D 칸 · 2D 조각(이 화면이 받은 것), 아래 = 로봇 진행(값이 하나도 없으면 줄째 없음)', () => {
    const b = html({ elapsed_s: 5 });
    expect([...b.querySelectorAll('[aria-label="진행"] > span')].map((x) => x.textContent)).toEqual(['0받은 3D 칸', '0받은 2D 조각']);
    expect(b.querySelectorAll('[aria-label="로봇 진행"] > span')).toHaveLength(1);
    expect(html({}).querySelector('[aria-label="로봇 진행"]')).toBeNull();
  });
  it('받은 칸이 없을 때 빈 지도 글: 로봇 진행 값이 0 보다 크면 «로봇은 지도를 만드는 중», 아니면 그대로', () => {
    expect(html({ point_count: 4_120_000 }).textContent).toContain('로봇은 지도를 만드는 중 · 화면에 아직 받은 칸이 없습니다.');
    expect(html({ distance_m: 3 }).textContent).toContain('로봇은 지도를 만드는 중');
    for (const p of [{}, { elapsed_s: 0, distance_m: 0, point_count: 0 }, { point_count: -5 }]) {
      const t = html(p).textContent!;
      expect(t).toContain('아직 받은 지도가 없습니다.');
      expect(t).not.toContain('로봇은 지도를 만드는 중');
    }
  });
});
