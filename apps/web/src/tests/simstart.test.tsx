// MuJoCo 시뮬 띄우기 칸(simstart.tsx, 11-03): 지도 카드 · 층 기본 1층 · 사진 누름 → 열기 주소(&floor·&start 약속) · 벽·지도 밖 누름 막힘
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SimPick, blocked, toWorld } from '../simstart';
// map.json 은 배포 빌드 묶음(prepare-release.sh)에 없음 → 정적 import 면 tsc TS2307. glob 은 없으면 빈 객체라 타입 검사 통과, 시험 때만 읽음
const WH = Object.values(import.meta.glob<{ origin: number[]; res: number; w: number; h: number; spawn_xyyaw: number[]; px: string }>(
  '../../../../mobile/sim/assets/warehouse/map.json', { eager: true, import: 'default' }))[0];
import TOP from '../../../../mobile/sim/assets/warehouse/top.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null, box: HTMLDivElement;
const mount = () => { box = document.createElement('div'); document.body.append(box); act(() => { root = createRoot(box); root.render(<SimPick />); }); };
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); vi.restoreAllMocks(); localStorage.clear(); });
const $ = (s: string) => box.querySelector<HTMLElement>(s);
const click = (s: string) => act(() => { $(s)!.click(); });
const href = () => $('[data-sim-app]')!.getAttribute('href');
/** 고른 층 장애물 지도(늦게 읽음)가 와서 기본 시작 표시가 뜰 때까지 */
async function loaded() {   // act 한 번 안에서 기다리면 그리기가 act 끝까지 미뤄지므로 짧은 act 를 되풀이
  for (let i = 0; i < 400 && !$('[data-sim-mark="home"]'); i++) await act(() => new Promise((r) => setTimeout(r, 25)));
  expect($('[data-sim-mark="home"]')).toBeTruthy();
}

/** 창고 칸 값 v 인 칸 하나의 중심(m) — 시험이 지도 파일에서 직접 찾음 */
const px = Uint8Array.from(atob(WH.px), (c) => c.charCodeAt(0)), grid = { ...WH, px };
const at = (i: number): [number, number] => [WH.origin[0] + (i % WH.w + 0.5) * WH.res, WH.origin[1] + (WH.h - 1 - Math.floor(i / WH.w) + 0.5) * WH.res];
const cellOf = (v: number) => at(px.indexOf(v, px.length >> 1));
/** 빈 칸인데 바로 오른쪽이 벽인 칸(시뮬은 벽에서 0.45 m 안 시작을 거절) */
const nearWall = () => at(px.findIndex((v, i) => v === 254 && px[i + 1] === 0 && (i + 1) % WH.w !== 0));
/** 벽에서 넉넉히 떨어진 빈 칸 하나(가운데부터) */
function clear(): [number, number] {
  for (let i = px.length >> 1; i < px.length; i += 7) { const p = at(i); if (!blocked(grid, ...p)) return p; }
  throw new Error('빈 칸 없음');
}
/** 사진 칸을 1 m = 10px, 가로 여백 양쪽 72px 로 두고 지도 좌표 (x, y) 를 누름(b = 그 지도 top.json 범위) */
const [x0, , , y1] = TOP.bounds, FZ = [-5.35, -19.35, 35.35, 25.35];   // factory-zone/top.json
function press(x: number, y: number, [b0, b1, b2, b3] = TOP.bounds) {
  const svg = $('[data-sim-top]')!;
  vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: (b2 - b0) * 10 + 144, height: (b3 - b1) * 10 } as DOMRect);
  act(() => { svg.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 72 + (x - b0) * 10, clientY: (b3 - y) * 10 })); });
}

describe('MuJoCo 시뮬 띄우기 칸', { timeout: 30_000 }, () => {
  it('toWorld: 비율 유지 여백을 빼고 화면 아래 = −y', () => {
    expect(toWorld({ left: 10, top: 20, width: 300, height: 226 }, [-7.8, -11.3, 7.8, 11.3], 10 + 72, 20)).toEqual([-7.8, 11.3]);
    const [x, y] = toWorld({ left: 0, top: 0, width: 156, height: 400 }, [-7.8, -11.3, 7.8, 11.3], 78, 200);
    expect([x, y].map((v) => +v.toFixed(6))).toEqual([0, 0]);   // 세로 여백(위아래 87px)
  });

  it('카드 고르기: 고른 카드 표시·기억, 한 층 지도는 floor 없음', () => {
    mount();
    expect($('[data-sim-card][aria-pressed="true"]')!.dataset.simCard).toBe('warehouse');
    expect($('[data-sim-card="element-course"] img')).toBeTruthy();
    click('[data-sim-card="element-course"]');
    expect($('[data-sim-card][aria-pressed="true"]')!.dataset.simCard).toBe('element-course');
    expect(localStorage.getItem('fh.simMap')).toBe('element-course');
    expect($('[data-sim-floor]')).toBeNull();
    expect(href()).toBe('/sim/index.html?from=web&map=element-course');
  });

  it('여러 층 지도는 1층 먼저, 층 고르기 → 그 층 사진·주소, 시작 위치 초기화', async () => {
    mount();
    click('[data-sim-card="factory-zone"]');
    expect([...box.querySelectorAll('[data-sim-floor] button')].map((b) => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([['1층', 'true'], ['2층', 'false']]);
    expect($('[data-sim-top] image')!.getAttribute('href')).toContain('/factory-zone/top-f1.png');
    expect(href()).toBe('/sim/index.html?from=web&map=factory-zone&floor=f1');
    expect($('[data-sim-card="factory-zone"]')!.textContent).toBe('2층 공장 · 초안');   // 카드에 층 따로 늘어놓지 않음
    await loaded();
    press(2, 4, FZ);   // 1층 기본 시작 지점 = 빈 곳
    expect(href()).toBe('/sim/index.html?from=web&map=factory-zone&floor=f1&start=2.00,4.00');
    click('[data-floor="f2"]');
    expect($('[data-sim-top] image')!.getAttribute('href')).toContain('/factory-zone/top-f2.png');
    expect(href()).toBe('/sim/index.html?from=web&map=factory-zone&floor=f2');
    expect($('[data-sim-mark="pick"]')).toBeNull();
  });

  it('사진 누름 → 시작 표시·&start=x,y(소수 2자리), «기본 위치로» → start 없음', async () => {
    mount(); await loaded();
    expect(($('[data-sim-home]') as HTMLButtonElement).disabled).toBe(true);
    const [x, y] = clear();
    press(x, y);
    expect($('[data-sim-mark="pick"]')).toBeTruthy();
    const m = href()!.match(/^\/sim\/index\.html\?from=web&map=warehouse&start=(-?\d+\.\d\d),(-?\d+\.\d\d)$/)!;
    expect(Math.abs(+m[1] - x)).toBeLessThan(0.011);
    expect(Math.abs(+m[2] - y)).toBeLessThan(0.011);
    expect(blocked(grid, +m[1], +m[2])).toBe('');   // 주소에 실린 점 그대로가 통과한 점
    expect($('[data-sim-start]')!.textContent).toContain(`x ${m[1]} m, y ${m[2]} m`);
    click('[data-sim-home]');
    expect(href()).toBe('/sim/index.html?from=web&map=warehouse');
    expect($('[data-sim-mark="pick"]')).toBeNull();
  });

  it('벽·벽 가까이(0.45 m)·지도 밖 누름은 막고 이유 한 줄, 고른 위치는 그대로', async () => {
    mount(); await loaded();
    press(...clear());
    const ok = href();
    expect(ok).toContain('&start=');
    press(...cellOf(0));
    expect($('[data-sim-why]')!.textContent).toBe('벽·장애물 자리라 시작할 수 없습니다.');
    expect(href()).toBe(ok);
    press(...nearWall());
    expect($('[data-sim-why]')!.textContent).toBe('벽·물건에서 0.45 m 안이라 시작할 수 없습니다 — 조금 떨어진 곳을 눌러 주세요.');
    expect(href()).toBe(ok);
    // REVIEW-265 B1 실제 창고 사례: 반올림 전 (2.0134, 9.4509) 는 통과지만 주소 값 (2.01, 9.45) 는 시뮬이 «0.45 m 안»으로 거절 → 웹도 막음
    expect(blocked(grid, 2.0134, 9.4509)).toBe('');
    expect(blocked(grid, 2.01, 9.45)).toMatch(/^벽·물건에서 0\.45 m 안/);
    press(2.0134, 9.4509);
    expect($('[data-sim-why]')!.textContent).toBe('벽·물건에서 0.45 m 안이라 시작할 수 없습니다 — 조금 떨어진 곳을 눌러 주세요.');
    expect(href()).toBe(ok);
    press(x0 + 0.1, y1 - 0.1);   // 사진 둘레(지도 판 밖 0.3 m)
    expect($('[data-sim-why]')!.textContent).toBe('지도 밖입니다 — 지도 안을 눌러 주세요.');
    expect(href()).toBe(ok);
  });
});
