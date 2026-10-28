// 시뮬 월드 «실제 모습»(mapframe topOf·보기 단추): 사진 자리 계산, 연결 없는 지도는 사진 없이, 보기 기억·사진 실패. 연결 대조(파일 읽기)는 maptop-link.test.js
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MapFrame, setLook, topOf } from '../mapframe';
import { toPixel } from '../screens/maps';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null, box: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); setLook('photo'); vi.restoreAllMocks(); });

const ver = (image_sha256: string, origin: [number, number, number], width: number, height: number, resolution = 0.05, provenance: 'HUMAN' | 'SIMULATION' = 'SIMULATION') => ({ provenance, image_sha256, origin, resolution, width, height });
const WAREHOUSE = 'ce79faafe42fbe7c3239699802c6422701e760d98edc96e8b980f7f322c3480b';
const draw = (el: JSX.Element) => { box = document.createElement('div'); document.body.append(box); root = createRoot(box); act(() => root!.render(el)); };

describe('사진 자리', () => {
  it('창고: 사진 범위 [-7.8,-11.3]~[7.8,11.3] m → 판 그림 픽셀, 로봇 좌표가 사진의 같은 자리에 온다', () => {
    const v = ver(WAREHOUSE, [-7.5, -11, 0], 300, 440), t = topOf(v)!;
    expect([t.x, t.y, t.width, t.height].map((n) => Math.round(n * 1e6) / 1e6)).toEqual([-6, -6, 312, 452]);
    for (const [wx, wy] of [[0, 0], [3.2, -8.5], [-7, 10]]) {   // 판 그림 픽셀 → 사진 안 비율 = 지도 좌표 → 사진 범위 비율
      const [px, py] = toPixel(v, wx, wy);
      expect((px - t.x) / t.width).toBeCloseTo((wx + 7.8) / 15.6, 9);
      expect((py - t.y) / t.height).toBeCloseTo((11.3 - wy) / 22.6, 9);
    }
  });
  it('연결 없는 지도(다른 sha·같은 sha 라도 판 좌표가 다름)는 null', () => {
    expect(topOf(ver('ab'.repeat(32), [-7.5, -11, 0], 300, 440))).toBeNull();
    expect(topOf(ver(WAREHOUSE, [-7.5, -11, 0.1], 300, 440))).toBeNull();
    expect(topOf(ver(WAREHOUSE, [-7.5, -11, 0], 300, 440, 0.1))).toBeNull();
    expect(topOf(ver(WAREHOUSE, [-7.5, -11, 0], 301, 440))).toBeNull();
    expect(topOf(ver('__proto__', [-7.5, -11, 0], 300, 440))).toBeNull();
    expect(topOf(null)).toBeNull();
  });
  it('같은 창고 PNG·YAML 이라도 사람이 올린 판(HUMAN·provenance 없음)은 사진 없음', () => {
    expect(topOf(ver(WAREHOUSE, [-7.5, -11, 0], 300, 440, 0.05, 'HUMAN'))).toBeNull();
    expect(topOf({ ...ver(WAREHOUSE, [-7.5, -11, 0], 300, 440), provenance: undefined })).toBeNull();
    draw(<MapFrame full={[0, 0, 300, 440]} res={0.05} photo={ver(WAREHOUSE, [-7.5, -11, 0], 300, 440, 0.05, 'HUMAN')}><rect /></MapFrame>);
    expect(box.querySelector('[data-map-top]')).toBeNull();
    expect(box.querySelector('[data-look-btn]')).toBeNull();
  });
});

describe('보기', () => {
  const frame = (v: ReturnType<typeof ver>) => <MapFrame full={[0, 0, v.width, v.height]} res={0.05} photo={v} data-t><rect data-child /></MapFrame>;
  it('연결 없는 지도 = 사진·보기 단추 없이 지금처럼', () => {
    draw(frame(ver('ab'.repeat(32), [-7.5, -11, 0], 300, 440)));
    expect(box.querySelector('[data-map-top]')).toBeNull();
    expect(box.querySelector('[data-look-btn]')).toBeNull();
    expect(box.querySelector('svg')!.getAttribute('data-look')).toBeNull();
  });
  it('기본 = 실제 모습(사진 밑 + 장애물 지도 반투명), «장애물 지도» 누르면 사진 없이·기억, 저장 실패해도 동작', () => {
    draw(frame(ver(WAREHOUSE, [-7.5, -11, 0], 300, 440)));
    const svg = box.querySelector('svg')!, img = svg.querySelector('[data-map-top]')!;
    expect(svg.firstElementChild).toBe(img);   // 다른 그림 밑
    expect(svg.style.getPropertyValue('--fh-map-a')).toBe('0.45');
    expect(box.querySelector('[data-look-btn="photo"]')!.getAttribute('aria-pressed')).toBe('true');
    act(() => (box.querySelector('[data-look-btn="map"]') as HTMLButtonElement).click());
    expect(svg.querySelector('[data-map-top]')).toBeNull();
    expect(svg.style.getPropertyValue('--fh-map-a')).toBe('');
    expect(localStorage.getItem('fh.mapLook')).toBe('map');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    act(() => (box.querySelector('[data-look-btn="photo"]') as HTMLButtonElement).click());
    expect(svg.querySelector('[data-map-top]')).not.toBeNull();
  });
  it('사진을 못 불러오면 장애물 지도만 + 작은 안내', () => {
    draw(frame(ver(WAREHOUSE, [-7.5, -11, 0], 300, 440)));
    act(() => { box.querySelector('[data-map-top]')!.dispatchEvent(new Event('error')); });
    expect(box.querySelector('[data-map-top]')).toBeNull();
    expect(box.querySelector('svg')!.style.getPropertyValue('--fh-map-a')).toBe('');
    expect(box.querySelector('[data-top-bad]')!.textContent).toContain('장애물 지도만');
  });
});
