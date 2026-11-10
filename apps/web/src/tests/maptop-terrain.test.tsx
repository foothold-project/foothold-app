// 지형 판 «실제 모습»(terraintop + MapFrame): 지형 모양 SVG 의 도형 수·자리(서버 terrain_grid 와 같은 칸)·보기 단추·기본 월드 사진 우선·격자 다르면 그림 없음
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { TerrainSpec } from '../../../contracts/ts';
import { MapFrame, setLook } from '../mapframe';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null, box: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); setLook('photo'); });
const draw = (el: JSX.Element) => { box = document.createElement('div'); document.body.append(box); root = createRoot(box); act(() => root!.render(el)); };

const SPEC: TerrainSpec = {
  schema: 'fh_custom_terrain/1', id: 't1', name: '시험', size: [8, 6.3], spawn: [-3, -2.5, 0], items: [
    { kind: 'box', x: -2, y: 1.2, yaw: 0.5, sx: 1.2, sy: 0.6, h: 0.3 },
    { kind: 'stairs', x: 1.5, y: 1, yaw: 1.2, width: 1, steps: 4, rise: 0.15, run: 0.3 },
    { kind: 'ramp', x: 1, y: -1.8, yaw: -0.3, length: 2, width: 1, h: 0.4 },
    { kind: 'gap', x: -1, y: -1, yaw: 0.9, length: 0.5, width: 1.2 },
  ] };
const RES = 0.05, W = Math.ceil(8 / RES), H = Math.ceil(6.3 / RES);
const ver = (o: Partial<{ origin: [number, number, number]; width: number; height: number; provenance: 'SIMULATION' | 'HUMAN'; image_sha256: string; terrain_spec: TerrainSpec | null }> = {}) =>
  ({ provenance: 'SIMULATION' as const, image_sha256: 'ab'.repeat(32), origin: [-4, -3.15, 0] as [number, number, number], resolution: RES, width: W, height: H, terrain_spec: SPEC, ...o });
const frame = (v: ReturnType<typeof ver>) => <MapFrame full={[0, 0, v.width, v.height]} res={RES} photo={v}><rect data-child /></MapFrame>;

/** apps/server/fh_server/terrains.py terrain_grid 를 그대로 옮긴 것(0 = 막힘, 254 = 빈 곳, 205 = 테두리) */
function grid(spec: TerrainSpec) {
  const [sx, sy] = spec.size, w = Math.ceil(sx / RES), h = Math.ceil(sy / RES), o = [-sx / 2, -sy / 2], pad2 = (RES * Math.SQRT2 / 2) ** 2;
  const obj = spec.items.map((it) => {
    const L = it.kind === 'box' ? it.sx : it.kind === 'stairs' ? it.steps * it.run + 1 : it.length, B = it.kind === 'box' ? it.sy : it.width;
    return [it.x, it.y, Math.cos(it.yaw), Math.sin(it.yaw), L / 2, B / 2];
  });
  const px = new Uint8Array(w * h);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    const y = o[1] + (h - r - 0.5) * RES, x = o[0] + (c + 0.5) * RES;
    px[r * w + c] = r === 0 || c === 0 || r === h - 1 || c === w - 1 || x + RES / 2 > sx / 2 + 1e-9 || y + RES / 2 > sy / 2 + 1e-9 ? 205
      : obj.some(([ox, oy, cs, sn, hx, hy]) => { const dx = x - ox, dy = y - oy, u = Math.max(0, Math.abs(cs * dx + sn * dy) - hx), v = Math.max(0, Math.abs(-sn * dx + cs * dy) - hy); return u * u + v * v <= pad2; }) ? 0 : 254;
  }
  return px;
}
const pts = (el: Element) => el.getAttribute('points')!.split(' ').map((p) => p.split(',').map(Number));
const inside = (poly: number[][], x: number, y: number) => {   // 짝홀 규칙
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};

describe('지형 모양 그림', () => {
  it('도형 수: 바닥 1·상자 1·계단 단 4 + 층계참 1·경사로 1(그러데이션 낮은 쪽→높은 쪽)·틈 1, 틈이 먼저(바닥 구멍), 장애물 지도 밑', () => {
    draw(frame(ver()));
    const svg = box.querySelector('svg')!, g = svg.querySelector('[data-terrain-top]')!;
    expect(svg.firstElementChild).toBe(g);
    expect(g.querySelectorAll('rect')).toHaveLength(1);
    expect([...g.children].slice(1).map((c) => c.getAttribute('data-kind'))).toEqual(['gap', 'box', 'stairs', 'ramp']);
    expect(g.querySelectorAll('[data-kind="stairs"] polygon')).toHaveLength(5);
    const steps = [...g.querySelectorAll('[data-kind="stairs"] polygon')].map((p) => Number(/(\d+)%/.exec(p.getAttribute('fill')!)![1]));
    expect(steps).toEqual([...steps].sort((a, b) => a - b));   // 높을수록 진하게
    expect(new Set(steps).size).toBe(4);   // 단마다 다른 색, 층계참 = 맨 위 단
    const lg = g.querySelector('[data-kind="ramp"] linearGradient')!, ramp = g.querySelector('[data-kind="ramp"] polygon')!;
    expect(ramp.getAttribute('fill')).toBe(`url(#${lg.id})`);
    // 낮은 쪽(x1) = 몸 기준 -length/2 = 지도 (1 - cos(-0.3), -1.8 - sin(-0.3)) → 그림 픽셀
    expect(+lg.getAttribute('x1')!).toBeCloseTo((1 - Math.cos(-0.3) + 4) / RES, 6);
    expect(+lg.getAttribute('y1')!).toBeCloseTo(H - (-1.8 - Math.sin(-0.3) + 3.15) / RES, 6);
    expect(g.querySelector('[data-kind="gap"]')!.getAttribute('fill')).toBe('#14171C');
    expect(svg.querySelector('[data-child]')).not.toBeNull();
    expect(svg.style.getPropertyValue('--fh-map-a')).toBe('0.45');
  });

  it('자리: 서버 terrain_grid 와 같다 — 꼭짓점·가운데 칸은 막힘, 빈 칸 가운데는 어떤 도형 안에도 없음, 바닥 = 판 전체', () => {
    draw(frame(ver()));
    const g = box.querySelector('[data-terrain-top]')!, px = grid(SPEC), polys = [...g.querySelectorAll('polygon')].map(pts);
    const floor = g.querySelector('rect')!;
    expect([floor.getAttribute('x'), floor.getAttribute('y'), floor.getAttribute('width'), floor.getAttribute('height')].map(Number)).toEqual([0, H - 6.3 / RES, 8 / RES, 6.3 / RES]);
    for (const poly of polys) {
      for (const [x, y] of poly) expect(px[Math.min(H - 1, Math.floor(y)) * W + Math.min(W - 1, Math.floor(x))]).toBe(0);
      const cx = poly.reduce((a, p) => a + p[0], 0) / 4, cy = poly.reduce((a, p) => a + p[1], 0) / 4;
      expect(px[Math.floor(cy) * W + Math.floor(cx)]).toBe(0);
    }
    let free = 0, hit = 0;
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
      if (px[r * W + c] !== 254) continue;
      free++;
      if (polys.some((p) => inside(p, c + 0.5, r + 0.5))) hit++;
    }
    expect(free).toBeGreaterThan(W * H * 0.5);
    expect(hit).toBe(0);
    // 반대로: 도형 안 칸 가운데는 막힘(위아래·회전이 뒤집히면 여기서 걸린다)
    let inner = 0;
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) if (polys.some((p) => inside(p, c + 0.5, r + 0.5))) { inner++; expect(px[r * W + c]).toBe(0); }
    expect(inner).toBeGreaterThan(500);
  });

  it('보기 단추: «장애물 지도» 누르면 그림 없이, «실제 모습» 누르면 다시', () => {
    draw(frame(ver()));
    const svg = box.querySelector('svg')!;
    expect(svg.getAttribute('data-look')).toBe('photo');
    expect(box.querySelector('[data-look-btn="photo"]')!.getAttribute('aria-pressed')).toBe('true');
    act(() => (box.querySelector('[data-look-btn="map"]') as HTMLButtonElement).click());
    expect(svg.querySelector('[data-terrain-top]')).toBeNull();
    expect(svg.getAttribute('data-look')).toBe('map');
    expect(svg.style.getPropertyValue('--fh-map-a')).toBe('');
    act(() => (box.querySelector('[data-look-btn="photo"]') as HTMLButtonElement).click());
    expect(svg.querySelector('[data-terrain-top]')).not.toBeNull();
  });

  it('기본 월드 사진이 있으면 사진이 우선(지형 그림 없음)', () => {
    draw(frame(ver({ image_sha256: 'ce79faafe42fbe7c3239699802c6422701e760d98edc96e8b980f7f322c3480b', origin: [-7.5, -11, 0], width: 300, height: 440 })));
    expect(box.querySelector('image[data-map-top]')).not.toBeNull();
    expect(box.querySelector('[data-terrain-top]')).toBeNull();
  });

  it('그림 없음: 지형 모양 없음·사람이 올린 판·판 격자가 지형 크기와 다름 → 장애물 지도만, 보기 단추 없음', () => {
    for (const v of [ver({ terrain_spec: null }), ver({ terrain_spec: undefined }), ver({ provenance: 'HUMAN' }), ver({ width: W + 1 }), ver({ height: H - 1 }), ver({ origin: [-4, -3, 0] }), ver({ origin: [-4, -3.15, 0.2] })]) {
      draw(frame(v));
      expect(box.querySelector('[data-map-top]')).toBeNull();
      expect(box.querySelector('[data-look-btn]')).toBeNull();
      expect(box.querySelector('svg')!.getAttribute('data-look')).toBeNull();
      act(() => root?.unmount()); root = null; box.remove();
    }
  });
});
