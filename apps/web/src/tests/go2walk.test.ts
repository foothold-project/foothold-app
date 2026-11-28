// @vitest-environment node
// 로봇 탭 큰 무대 걷기 꼴(검토 L2): 걷기 기록을 놓은 뒤 종아리 가장 낮은 점이 바닥 y=0 (엎드림 높이에서 바뀌어도 발이 묻히거나 뜨지 않음)
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { GRID_SPAN, UNIT, flow, padMesh, walkPose } from '../screens/u4/go2view';

/** 다리 넷(hip → thigh → calf · 종아리 끝 상자)만 있는 작은 모형. 몸 아래 0.3 m 에 발 */
function body() {
  const root = new THREE.Group(), joints: Record<string, { o: THREE.Object3D; r0: THREE.Euler }> = {};
  [['FR', 0.2, -0.1], ['FL', 0.2, 0.1], ['RR', -0.2, -0.1], ['RL', -0.2, 0.1]].forEach(([L, z, x]) => {
    const hip = new THREE.Group(); hip.name = `${L}_hip`; hip.position.set(x as number, 0.35, z as number); root.add(hip);
    const thigh = new THREE.Group(); thigh.name = `${L}_thigh`; hip.add(thigh);
    const calf = new THREE.Group(); calf.name = `${L}_calf`; calf.position.y = -0.15; thigh.add(calf);
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.15, 0.02)); foot.position.y = -0.075; calf.add(foot);
    for (const o of [hip, thigh, calf]) joints[o.name] = { o, r0: o.rotation.clone() };
  });
  return { root, joints };
}
const calfLow = (root: THREE.Object3D) => {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  root.traverse((o) => { if (/_calf$/.test(o.name)) box.expandByObject(o, true); });
  return box.min.y;
};

describe('walkPose', () => {
  // 걷기 기록 한 판 = hip 넷 · thigh 넷 · calf 넷(site.ts applyWalk 의 [ji * 4 + li])
  const gait = { dt: 0.1, frames: [[0, 0, 0, 0, 0.5, -0.3, 0.2, 0.4, -0.6, -0.2, -0.9, -0.4], [0, 0, 0, 0, -0.2, 0.4, -0.3, 0.1, -0.3, -0.8, -0.1, -0.7]] };
  it('엎드림 높이(몸이 내려가 있던 자리)에서 걷기로 바뀌어도 종아리 가장 낮은 점 = 0 · 걷는 동안 판마다 0', () => {
    const { root, joints } = body();
    root.position.y = -0.2;   // 엎드림 맞춤으로 내려가 있던 몸
    for (const t of [0, 0.05, 0.13, 0.27]) {
      walkPose(root, joints, gait, t);
      const low = calfLow(root);   // walkPose 를 거친 그 판
      expect(low).toBeGreaterThanOrEqual(-1e-9); expect(low).toBeLessThan(1e-6);
    }
  });
});

// 팀장 23:48: 큰 로봇 바닥 점 = 로봇 기준으로 흐름(무대 앞 +z · 왼 +x). 점의 무대 자리 = 판을 th 돌린 뒤의 (x, z)
describe('flow (바닥 점 흐름 · 서버 applied vx · vy · wz)', () => {
  const at = (g: { x: number; z: number; th: number }) => ({ x: g.x * Math.cos(g.th) + g.z * Math.sin(g.th), z: -g.x * Math.sin(g.th) + g.z * Math.cos(g.th) });   // 판 → 무대(y 축 th 돌림)
  const z0 = { x: 0, z: 0, th: 0 };
  it('직진 = 점이 뒤로(-z) · 옆걸음(왼) = 오른쪽으로(-x) · 0.5 m/s 1 초 = 0.5 m × 모형 단위', () => {
    const f = flow(z0, { v: 0.5, side: 0, turn: 0 }, 1);
    expect(f.th).toBe(0); expect(f.x).toBeCloseTo(0, 9); expect(f.z).toBeCloseTo(-0.5 * UNIT, 9);
    const s = flow(z0, { v: 0, side: 0.3, turn: 0 }, 1);
    expect(s.x).toBeCloseTo(-0.3 * UNIT, 9); expect(s.z).toBeCloseTo(0, 9);
  });
  it('왼쪽으로 돌면(wz > 0) 점 판은 반대로 돎 · 돈 뒤에도 직진 흐름은 무대 -z(로봇 기준)', () => {
    let g = flow(z0, { v: 0, side: 0, turn: 0.8 }, 1);
    expect(g.th).toBeCloseTo(-0.8, 9);
    const before = at(g); g = flow(g, { v: 0.4, side: 0, turn: 0 }, 0.5); const after = at(g);
    expect(after.z - before.z).toBeCloseTo(-0.2 * UNIT, 9); expect(after.x - before.x).toBeCloseTo(0, 9);
  });
  it('판 안 좌표는 판 한 칸 안으로 감김(오래 걸어도 점이 사라지지 않음)', () => {
    let g = z0; for (let i = 0; i < 400; i++) g = flow(g, { v: 1.2, side: 0.4, turn: 0.3 }, 0.05);
    expect(Math.abs(g.x)).toBeLessThanOrEqual(GRID_SPAN / 2); expect(Math.abs(g.z)).toBeLessThanOrEqual(GRID_SPAN / 2);
  });
});

// 시안 u5_1_tiles.html pad(): 충전 = 초록 고리 두 겹(0.34 · 0.40, 앞뒤 1.25 배) · 점검 = 회색 네모 두 겹(0.38 × 0.5 · 0.06 바깥)
describe('padMesh (충전 · 점검 바닥 표시)', () => {
  const lines = (g: THREE.Group) => g.children as THREE.LineLoop[];
  const col = (l: THREE.LineLoop) => (l.material as THREE.LineBasicMaterial).color.getHex(), op = (l: THREE.LineLoop) => (l.material as THREE.LineBasicMaterial).opacity;
  it('충전: 고리 둘 · 시안 색 · 진하기 · 반지름, 밝은 판 = 밝음 1 초록', () => {
    const c = lines(padMesh('charge'));
    expect(c.map(col)).toEqual([0x00c389, 0x00c389]); expect(c.map(op)).toEqual([0.85, 0.3]);
    const p = c[0].geometry.getAttribute('position'); expect(p.getX(0)).toBeCloseTo(0.34, 6); expect(p.count).toBe(96);
    expect(Math.max(...Array.from({ length: p.count }, (_, i) => p.getZ(i)))).toBeCloseTo(0.34 * 1.25, 3);
    expect(lines(padMesh('charge', true)).map(col)).toEqual([0x18a07e, 0x18a07e]);
  });
  it('점검: 네모 둘 · 회색 · 안 0.38 × 0.5 · 밝은 판 = 흐린 글자색', () => {
    const m = lines(padMesh('maint'));
    expect(m.map(col)).toEqual([0xa9b8c6, 0xa9b8c6]); expect(m.map(op)).toEqual([0.75, 0.22]);
    const p = m[0].geometry.getAttribute('position'); expect(p.getX(1)).toBeCloseTo(0.38, 6); expect(p.getZ(2)).toBeCloseTo(0.5, 6);
    expect(lines(padMesh('maint', true)).map(col)).toEqual([0x5e6662, 0x5e6662]);
  });
});
