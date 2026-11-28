// 지도 탭 데모 현장 3D(screens/u7/site3d): 시안 카메라 값 · 재질 · 캔버스를 다시 쓰지 않음(7c07a9b7 흰 칸 되풀이 막기).
// jsdom 엔 WebGL 이 없어 렌더러 · GLB 읽기를 가짜로(그리기 자체는 headless Chrome 사진으로 확인).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { CLAY, DemoSite3D, botsOn, camOf, dress } from '../screens/u7/site3d';
import type { Robot } from '../fake';

const fake = vi.hoisted(() => ({ made: [] as { domElement: HTMLCanvasElement; lost: number; disposed: number }[], scene: null as unknown }));
vi.mock('three', async (orig) => {
  const t = await orig<typeof import('three')>();
  class GL { domElement = document.createElement('canvas'); lost = 0; disposed = 0; outputColorSpace = ''; shadowMap = { enabled: false, type: 0 };
    constructor() { fake.made.push(this); } setPixelRatio() {} setSize() {} render(sc: unknown) { fake.scene = sc; } dispose() { this.disposed++; } forceContextLoss() { this.lost++; } }
  return { ...t, WebGLRenderer: GL };
});
vi.mock('three/examples/jsm/loaders/GLTFLoader.js', async (orig) => {
  const m = await orig<typeof import('three/examples/jsm/loaders/GLTFLoader.js')>();
  const T = await import('three');
  class L extends m.GLTFLoader {
    load(...[, ok]: Parameters<InstanceType<typeof m.GLTFLoader>['load']>) {
      const g = new T.Group();
      for (const n of ['building', 'nogo_floor', 'nogo_post']) { const mat = new T.MeshStandardMaterial(); mat.name = n; g.add(new T.Mesh(new T.BoxGeometry(1, 1, 1), mat)); }
      queueMicrotask(() => ok({ scene: g } as never));
    }
  }
  return { ...m, GLTFLoader: L };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null, box: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); fake.made.length = 0; });
const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); }); };

describe('데모 현장 3D', () => {
  it('시안 카메라(build_scene.py): K-01 시점 = 대상 (1720, 976) px · 높이각 37° · 방위 -12° · 거리 330 m · 렌즈 50 mm', () => {
    const c = camOf('k01', 2576 / 1093), [tx, , tz] = c.at, [x, y, z] = c.pos;
    expect([tx, tz].map((n) => Math.round(n * 100) / 100)).toEqual([484.29, 273.14]);
    expect(Math.hypot(x - tx, y, z - tz)).toBeCloseTo(330, 6);
    expect((Math.asin(y / 330) * 180) / Math.PI).toBeCloseTo(37, 6);
    expect((Math.atan2(x - tx, z - tz) * 180) / Math.PI).toBeCloseTo(-12, 6);
    // 가로 시야 = 2 atan(18 / 50) (36 mm 가로)
    expect(2 * Math.atan(Math.tan((c.fov * Math.PI) / 360) * (2576 / 1093))).toBeCloseTo(2 * Math.atan(18 / 50), 3);   // k01 그림 2576×1093 ≈ iso 비율(소수 넷째 자리 차)    // 칸이 시안 그림보다 좁으면(세로로 긴 미리 보기 칸) 시안 그림을 cover 로 놓은 것처럼 세로 시야가 같다(옆을 자름)
    expect(camOf('iso', 0.9).fov).toBeCloseTo(camOf('iso', 6336 / 2688).fov, 9);
    expect(camOf('iso', 4).fov).toBeLessThan(camOf('iso', 6336 / 2688).fov);
  });

  it('재질 = 시안 흰 점토 색 · 금지 구역은 붉은 바닥 · 기둥', () => {
    const g = new THREE.Group();
    for (const n of ['fk_building', 'nogo_floor', 'pipe']) { const m = new THREE.MeshStandardMaterial(); m.name = n; g.add(new THREE.Mesh(new THREE.BoxGeometry(), m)); }
    dress(g);
    const [b, f, p] = g.children as THREE.Mesh[];
    expect((b.material as THREE.MeshStandardMaterial).color.getHexString()).toBe(new THREE.Color(CLAY.building).getHexString());
    expect((p.material as THREE.MeshStandardMaterial).color.getHexString()).toBe(new THREE.Color(CLAY.pipe).getHexString());
    expect([f.userData.nogo, (f.material as THREE.MeshBasicMaterial).transparent, b.userData.nogo]).toEqual([true, true, false]);
  });

  it('다시 열 때마다 새 렌더러 · 새 캔버스: 닫으면 옛 캔버스는 지워지고 문맥을 놓음, 칸에 캔버스는 늘 하나(같은 캔버스 다시 쓰기 없음)', async () => {
    box = document.createElement('div'); document.body.append(box); root = createRoot(box);
    const show = async (on: boolean) => { act(() => root!.render(on ? <DemoSite3D /> : <p />)); await flush(); };
    await show(true);
    expect(fake.made.length).toBe(1);
    const first = fake.made[0];
    expect([...box.querySelectorAll('canvas')]).toEqual([first.domElement]);
    expect(box.querySelector('[data-site3d-wait]')).toBeNull();
    await show(false);
    expect([first.lost, first.disposed, first.domElement.isConnected]).toEqual([1, 1, false]);
    await show(true);
    expect(fake.made.length).toBe(2);
    const second = fake.made[1];
    expect(second.domElement).not.toBe(first.domElement);
    expect([...box.querySelectorAll('canvas')]).toEqual([second.domElement]);
    expect(second.lost).toBe(0);
  });

  it('층 화면 3D 는 시안 u7_4 안내 줄(끌어서 회전 · 오른쪽 버튼 끌어 이동 · 휠로 확대 · 로봇 눈높이) · 작은 지도, 미리 보기엔 없음', async () => {
    box = document.createElement('div'); document.body.append(box); root = createRoot(box);
    act(() => root!.render(<DemoSite3D />)); await flush();
    expect(box.querySelector('.mp-hint3')!.textContent).toBe('끌어서 회전오른쪽 버튼 끌어 이동휠로 확대로봇 눈높이');
    expect(box.querySelector('.mp-mini3 [data-seen]')).not.toBeNull();
    act(() => root!.render(<DemoSite3D key="p" preview />)); await flush();
    expect(box.querySelector('.mp-hint3')).toBeNull(); expect(box.querySelector('.mp-mini3')).toBeNull();
    expect(box.querySelectorAll('canvas').length).toBe(1);
  });

  const bot = (id: string, l: Record<string, unknown> | null) => ({ id, name: id.toUpperCase(), location: l }) as unknown as Robot;
  it('이 층 로봇만: 층(floor_id) 또는 이 판(map_version_id) 위치 · 좌표 없음 · 다른 층은 빠짐', () => {
    const rs = [bot('k-01', { floor_id: 'f1', map_version_id: 'old', x: 1, y: 2, yaw: 0.5 }), bot('k-02', { floor_id: null, map_version_id: 'v1', x: 3, y: 4, yaw: null }),
      bot('k-03', { floor_id: 'f2', map_version_id: 'v2', x: 5, y: 6, yaw: 0 }), bot('k-04', { floor_id: 'f1', map_version_id: 'v1', x: null, y: null, yaw: null }), bot('k-05', null)];
    expect(botsOn(rs, 'f1', 'v1')).toEqual([{ id: 'k-01', name: 'K-01', x: 1, y: 2, yaw: 0.5 }, { id: 'k-02', name: 'K-02', x: 3, y: 4, yaw: null }]);
  });

  it('로봇 = 로봇 탭 · 관제와 같은 자리(sitePose: x · -y · yaw+π/2) · Go2 모형 + 바닥 고리 · 이름표, 미리 보기엔 없음', async () => {
    box = document.createElement('div'); document.body.append(box); root = createRoot(box);
    const k = bot('k-01', { floor_id: 'f1', map_version_id: 'v1', x: 484.29, y: -273.14, yaw: 0 });
    act(() => root!.render(<DemoSite3D robots={[k]} floor="f1" vid="v1" />)); await flush();
    let g: THREE.Object3D | null = null; (fake.scene as THREE.Scene).traverse((o) => { if (o.userData.bot === 'k-01') g = o; });
    if (!g) throw new Error('로봇 없음');
    const q = g as THREE.Object3D;
    expect([q.position.x, q.position.y, q.position.z]).toEqual([484.29, 0, 273.14]);
    expect(q.rotation.y).toBeCloseTo(Math.PI / 2, 9);
    expect(q.children.some((c) => (c as THREE.Line).isLine)).toBe(true);
    expect(box.querySelector('[data-bot3="k-01"]')!.textContent).toBe('K-01');
    act(() => root!.render(<DemoSite3D key="p" preview robots={[k]} floor="f1" vid="v1" />)); await flush();
    expect(box.querySelector('[data-bot3]')).toBeNull();
  });
});
