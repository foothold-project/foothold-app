// 지형 만들기 3D(TERRAIN-3D): 끌기·돌리기·높이 변환 · buildTerrain 과 같은 모양 · terrain.tsx 와 같은 상태·검사·저장 연결.
// jsdom 엔 WebGL 이 없어 화면 연결은 3D 컴포넌트를 받은 props 를 기록하는 가짜로 바꿔 본다(그리기는 headless Chrome 스크린샷).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildTerrain, type TerrainItem as Item, type TerrainSpec as Spec } from '../../../../mobile/sim/terrain/index.js';
import { Terrain } from '../screens/terrain';
import { dragTo, liftTo, shapeOf, turn, yawOf, type Props } from '../screens/terrain3d';

let last: Props | null = null;
vi.mock('../screens/terrain3d', async (orig) => ({ ...(await orig<object>()), default: (p: Props) => { last = p; return <div data-fake3d />; } }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null, box: HTMLDivElement;
beforeEach(() => { localStorage.clear(); last = null; });
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); localStorage.clear(); });
const $ = (s: string) => box.querySelector<HTMLElement>(s);
const click = (s: string) => act(() => { $(s)!.click(); });
const stored = (): Spec => { const k = Object.keys(localStorage).find((x) => x.startsWith('fh.customTerrain.'))!; return JSON.parse(localStorage.getItem(k)!); };
const base = (items: Item[]): Spec => ({ schema: 'fh_custom_terrain/1', id: 't-a', name: '시험', size: [12, 12], spawn: [-5, 0, 0], items });

describe('3D 조작 → 약속 값', () => {
  it('끌기: 바닥 점 + 잡은 어긋남 → 5 cm 맞춤, 바닥 안에 가둠', () => {
    expect(dragTo([1.02, -2.31], [0.5, 0], [12, 12])).toEqual({ x: 1.5, y: -2.3 });
    expect(dragTo([9, -9], [0, 0], [12, 8])).toEqual({ x: 6, y: -4 });
  });
  it('돌리기: 5° 맞춤·−180~180°, R = 15°(Shift 반대)', () => {
    expect(yawOf(0.79)).toBeCloseTo(Math.PI / 4, 3);
    expect(yawOf((370 * Math.PI) / 180)).toBeCloseTo((10 * Math.PI) / 180, 3);
    expect(turn(0)).toBeCloseTo((15 * Math.PI) / 180, 3);
    expect(turn(0, true)).toBeCloseTo((-15 * Math.PI) / 180, 3);
    expect(turn(Math.PI)).toBeCloseTo((-165 * Math.PI) / 180, 3);
  });
  it('높이 손잡이: 상자·경사 h, 계단 단 높이, 틈 없음', () => {
    const at = { x: 0, y: 0, yaw: 0 };
    expect(liftTo({ ...at, kind: 'box', sx: 1, sy: 1, h: 0.2 }, 0.43)).toEqual({ h: 0.45 });
    expect(liftTo({ ...at, kind: 'ramp', length: 2, width: 1, h: 0.3 }, -1)).toEqual({ h: 0.05 });
    expect(liftTo({ ...at, kind: 'stairs', width: 1, steps: 5, rise: 0.12, run: 0.3 }, 0.8)).toEqual({ rise: 0.16 });
    expect(liftTo({ ...at, kind: 'gap', length: 0.4, width: 1 }, 1)).toBeNull();
  });
});

describe('3D 모양 = buildTerrain 덩어리', () => {
  // buildTerrain 덩어리 순서: 바닥 밑판 1 · 바닥 1(틈 없을 때) · 턱 4 · 물체(상자 1, 계단 단 수 + 층계참 1, 경사 1)
  const items: Item[] = [
    { kind: 'box', x: 2, y: 3, yaw: 0.5, sx: 1, sy: 0.6, h: 0.3 },
    { kind: 'stairs', x: -1, y: -2, yaw: -1.2, width: 1.2, steps: 4, rise: 0.12, run: 0.3 },
    { kind: 'ramp', x: 2, y: -3, yaw: 2, length: 2, width: 1, h: 0.4 },
  ];
  const built = buildTerrain(base(items)).scene;
  const pieces = [1, 5, 1];
  const aabb = (pts: number[][]) => [0, 1, 2].flatMap((k) => [Math.min(...pts.map((p) => p[k])), Math.max(...pts.map((p) => p[k]))]);
  items.forEach((o, i) => {
    it(`${o.kind}: 바닥 면적·윗면 높이가 같다`, () => {
      const start = 6 + pieces.slice(0, i).reduce((a, b) => a + b, 0);
      const theirs = built.models.slice(start, start + pieces[i]).flatMap((md) => {
        const p = built.meshes[md.mesh].p, yaw = 2 * Math.atan2(md.quat[3], md.quat[0]), c = Math.cos(yaw), s = Math.sin(yaw), out: number[][] = [];
        for (let k = 0; k < p.length; k += 3) out.push([md.pos[0] + c * p[k] - s * p[k + 1], md.pos[1] + s * p[k] + c * p[k + 1], md.pos[2] + p[k + 2]]);
        return out;
      });
      const g = new THREE.Group();
      g.position.set(o.x, o.y, 0); g.rotation.z = o.yaw;
      shapeOf(o).forEach((geo) => g.add(new THREE.Mesh(geo)));
      g.updateMatrixWorld(true);
      const b = new THREE.Box3().setFromObject(g), mine = [b.min.x, b.max.x, b.min.y, b.max.y, b.min.z, b.max.z], ref = aabb(theirs);
      if (o.kind === 'ramp') { ref[4] = 0; }   // 경사 밑의 묻힌 2 cm 받침은 그리지 않는다
      mine.forEach((v, k) => expect(v).toBeCloseTo(ref[k], 5));
    });
  });
});

describe('terrain.tsx [위에서 | 3D]', () => {
  const show3d = async () => {
    box = document.createElement('div'); document.body.append(box);
    act(() => { root = createRoot(box); root.render(<Terrain />); });
    click('[data-terrain-view="3d"]');
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect($('[data-fake3d]')).not.toBeNull();
  };

  it('3D 놓기·끌기·높이·시작 위치가 같은 상태·검사·저장으로 간다', async () => {
    await show3d();
    expect($('[data-terrain-board]')).toBeNull();
    expect($('[data-terrain-view="3d"]')!.getAttribute('aria-pressed')).toBe('true');
    click('[data-terrain-tool="box"]');
    expect(last!.tool).toBe('box');
    act(() => last!.onFloor(2.03, 1));   // 2D 판 누름과 같은 맞춤·놓기
    expect(stored().items).toEqual([{ kind: 'box', x: 2.05, y: 1, yaw: 0, sx: 1, sy: 1, h: 0.2 }]);
    expect(last!.sel).toBe(0);
    expect(last!.tool).toBe('select');
    expect(last!.state).toEqual([undefined]);

    act(() => last!.onPose(0, { x: 5.9 }));   // 바닥 밖으로 걸침 → 같은 validate 오류, 3D 에 bad 로 감
    expect(stored().items[0].x).toBe(5.9);
    expect(last!.state).toEqual(['bad']);
    expect($('[data-terrain-count]')!.textContent).toContain('오류 1');
    act(() => last!.onPose(0, { x: 1, yaw: turn(0) }));
    act(() => last!.onPose(0, liftTo(last!.spec.items[0], 0.5)!));
    expect(stored().items[0]).toMatchObject({ x: 1, h: 0.5 });
    expect(stored().items[0].yaw).toBeCloseTo(0.2618, 4);
    expect(last!.state).toEqual([undefined]);

    act(() => last!.onSel('spawn'));
    expect(box.textContent).toContain('시작 위치');
    act(() => last!.onPose('spawn', { x: -3, yaw: 1 }));
    expect(stored().spawn).toEqual([-3, 0, 1]);
    act(() => last!.onFloor(0, 0));   // 고르기 도구로 빈 곳 = 고른 것 풀기
    expect(last!.sel).toBeNull();

    click('[data-terrain-view="top"]');
    expect($('[data-fake3d]')).toBeNull();
    expect($('[data-terrain-board]')).not.toBeNull();
    expect(box.querySelector('[data-terrain-item="0"]')).not.toBeNull();
  });
});

describe('WebGL 없는 브라우저', () => {
  it('3D 를 못 그리면 깨지지 않고 알린다', async () => {
    const Real = (await vi.importActual<typeof import('../screens/terrain3d')>('../screens/terrain3d')).default;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    box = document.createElement('div'); document.body.append(box);
    act(() => { root = createRoot(box); root.render(<Real spec={base([])} sel={null} tool="select" state={[]} onSel={() => {}} onPose={() => {}} onFloor={() => {}} onKeyDown={() => {}} />); });
    expect($('[data-terrain-3d-failed]')).not.toBeNull();
  });
});
