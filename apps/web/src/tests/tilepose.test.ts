// @vitest-environment node
// 팀장 20:51 «발이 바닥에 묻힌다»: 타일 3D 가 선 자세 · 걷기에서 몸 높이를 흔들림 값(0.003 · 0.006 × sin)으로 덮어써 모형을 세운 높이가 사라졌다.
// 고친 뒤: 자세마다 발 끝(종아리) 가장 낮은 점이 y = 0 위(흔들림은 위로만), 엎드림 · 서버 관절은 몸 전체 최저점 y = 0
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { feetUp, poseBody } from '../proto/tileview';
import { STAND } from '../screens/u4/go2view';
import type { Body, Walk } from '../proto/site';

const LEGS = ['FR', 'FL', 'RR', 'RL'];
/** 모형 없는 Go2 꼴: 몸 상자(가운데 원점) + 다리 넷(마디마다 아래로 0.21 m). 원점이 몸 가운데라 높이 0 이면 발이 0.42 m 묻힘 */
function fake(): Body {
  const root = new THREE.Group(), joints: Body['joints'] = {};
  const box = (w: number, h: number, d: number, y = 0) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d)); m.position.y = y; return m; };
  root.add(box(0.38, 0.1, 0.2));
  LEGS.forEach((L) => {
    const hip = new THREE.Group(); hip.name = `${L}_hip`; hip.position.set(L[1] === 'R' ? -0.09 : 0.09, 0, L[0] === 'F' ? 0.19 : -0.19); root.add(hip);
    const th = new THREE.Group(); th.name = `${L}_thigh`; hip.add(th); th.add(box(0.04, 0.21, 0.04, -0.105));
    const ca = new THREE.Group(); ca.name = `${L}_calf`; ca.position.y = -0.21; th.add(ca); ca.add(box(0.03, 0.21, 0.03, -0.105));
    for (const o of [hip, th, ca]) joints[o.name] = { o, r0: o.rotation.clone() };
  });
  return { root, joints, top: 0.5 };
}
const minY = (o: THREE.Object3D) => { o.updateMatrixWorld(true); return new THREE.Box3().setFromObject(o, true).min.y; };
const feetY = (b: Body) => { b.root.updateMatrixWorld(true); const x = new THREE.Box3(); for (const L of LEGS) x.expandByObject(b.joints[`${L}_calf`].o, true); return x.min.y; };
// 걷기 기록 꼴: 12 칸(hip 4 · thigh 4 · calf 4) · 앞뒤 다리가 번갈아 들림
const WALK: Walk = { dt: 0.1, frames: [[0, 0, 0, 0, 0.3, -0.2, -0.2, 0.3, -0.4, 0, 0, -0.4], [0, 0, 0, 0, -0.2, 0.3, 0.3, -0.2, 0, -0.4, -0.4, 0]] };

describe('타일 3D 바닥 맞춤', () => {
  it('선 자세: 발 끝 최저점이 y = 0 위 · 흔들림은 3 mm 안 위로만(고치기 전: 원점 높이로 덮어써 0.42 m 묻힘)', () => {
    for (const t of [0, 0.4, 0.8, 1.6, 2.3]) {
      const b = fake(); b.root.position.y = 0.42; poseBody(b, { walk: false, down: false }, null, t);
      expect(feetY(b)).toBeGreaterThanOrEqual(-1e-6); expect(feetY(b)).toBeLessThan(0.0031);
    }
  });
  it('걷기: 매 판 발 끝 최저점이 y = 0 위 · 6 mm 안', () => {
    for (const t of [0, 0.05, 0.13, 0.27, 0.31]) {
      const b = fake(); poseBody(b, { walk: true, down: false }, WALK, t);
      expect(feetY(b)).toBeGreaterThanOrEqual(-1e-6); expect(feetY(b)).toBeLessThan(0.0061);
    }
  });
  it('엎드림 · 서버 관절: 몸 전체 최저점 y = 0', () => {
    const d = fake(); poseBody(d, { walk: false, down: true }, null, 0); expect(Math.abs(minY(d.root))).toBeLessThan(1e-6);
    const q = fake(); poseBody(q, { walk: true, down: true, q: [...STAND] }, WALK, 0); expect(Math.abs(minY(q.root))).toBeLessThan(1e-6);
    expect(q.joints.FR_thigh.o.rotation.x).toBeCloseTo(0, 6);   // 관절이 오면 걷기 기록 · 엎드림보다 관절(STAND = 모형 기본 자세)
  });
  it('feetUp = 종아리만 재어 발 끝을 y = 0 에(몸 7.5 만 꼭짓점 대신 종아리 1.4 만)', () => {
    const b = fake(); b.root.position.y = 3; const y = feetUp(b); b.root.position.y = y;
    expect(Math.abs(feetY(b))).toBeLessThan(1e-6);
  });
});
