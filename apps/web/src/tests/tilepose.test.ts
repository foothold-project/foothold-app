// @vitest-environment node
// 팀장 20:51 «발이 바닥에 묻힌다»: 타일 3D 가 선 자세 · 걷기에서 몸 높이를 흔들림 값(0.003 · 0.006 × sin)으로 덮어써 모형을 세운 높이가 사라졌다.
// 고친 뒤: 자세마다 발 끝(종아리) 가장 낮은 점이 y = 0 위(흔들림은 위로만), 엎드림 · 서버 관절은 몸 전체 최저점 y = 0
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { BREATH, PAD, camPull, feetUp, padGroup, poseBody } from '../proto/tileview';
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
      const b = fake(); b.root.position.y = 0.42; poseBody(b, { walk: false, down: false, breathe: true }, null, t);
      expect(feetY(b)).toBeGreaterThanOrEqual(-1e-6); expect(feetY(b)).toBeLessThan(0.0031);
    }
  });
  it('숨(임무 전 시뮬만): breathe 면 몸통이 위로만 0 ~ 3 mm 오르내림 · 아니면(실기 · 데모) 실제 자세 그대로 움직이지 않음', () => {
    const ys = (breathe: boolean) => [0, 0.4, 0.8, 1.6, 2.3].map((t) => { const b = fake(); poseBody(b, { walk: false, down: false, breathe }, null, t); return feetY(b); });
    const on = ys(true), off = ys(false);
    for (const y of on) { expect(y).toBeGreaterThanOrEqual(-1e-6); expect(y).toBeLessThanOrEqual(BREATH + 1e-6); }
    expect(Math.max(...on) - Math.min(...on)).toBeGreaterThan(0.001);
    for (const y of off) expect(Math.abs(y)).toBeLessThan(1e-6);
  });
  it('pad 모양 = 시안 u5_1 pad() 값: 충전 초록 고리 둘(r 0.34 · 0.40, 앞뒤 1.25 배) · 점검 회색 네모 둘(0.38 × 0.5, 바깥 +0.06)', () => {
    const c = padGroup('charge'), k = padGroup('check');
    const box = (o: THREE.Object3D) => new THREE.Box3().setFromObject(o);
    expect(c.children.length).toBe(3); expect(k.children.length).toBe(3);   // 바닥 꼴 둘 + 오르는 층 무리(padanim)
    expect(c.children[2].name).toBe('rise'); expect(k.children[2].name).toBe('rise');
    const [r1, r2] = c.children as THREE.LineLoop[];
    expect(box(r1).max.x).toBeCloseTo(0.34, 3); expect(box(r1).max.z).toBeCloseTo(0.34 * 1.25, 3); expect(box(r2).max.x).toBeCloseTo(0.40, 3);
    expect((r1.material as THREE.LineBasicMaterial).color.getHex()).toBe(0x00c389); expect((r1.material as THREE.LineBasicMaterial).opacity).toBe(0.85); expect((r2.material as THREE.LineBasicMaterial).opacity).toBe(0.3);
    const [s1, s2] = k.children as THREE.LineLoop[];
    expect(box(s1).max.x).toBeCloseTo(0.38, 6); expect(box(s1).max.z).toBeCloseTo(0.5, 6); expect(box(s2).max.x).toBeCloseTo(0.44, 6); expect(box(s2).max.z).toBeCloseTo(0.56, 6);
    expect((s1.material as THREE.LineBasicMaterial).color.getHex()).toBe(PAD.check.col); expect(PAD.check.col).toBe(0xa9b8c6);
    expect((s1.material as THREE.LineBasicMaterial).opacity).toBe(0.75); expect((s2.material as THREE.LineBasicMaterial).opacity).toBe(0.22);
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

// K-08 빈 판(21:06): 뒤 2.1 m 카메라가 벽 안 → 머리에서 카메라로 광선, 맞으면 그 앞으로 당김(최소 0.6 m) · 투명한 금지 구역은 막지 않음
describe('따라가기 카메라 가림', () => {
  const cam = new THREE.Vector3(0, 0.55, -2.1);   // 뒤 1 m 시점(yaw π)
  const wall = (z: number, transparent = false) => { const w = new THREE.Group(); const m = new THREE.Mesh(new THREE.BoxGeometry(4, 3, 0.2), new THREE.MeshBasicMaterial({ transparent })); m.position.set(0, 1, z); w.add(m); return w; };
  it('벽이 없으면 그대로(1)', () => { expect(camPull(new THREE.Group(), cam)).toBe(1); });
  it('로봇 뒤 1.2 m 벽 → 벽 0.15 m 앞으로 당김', () => {
    const k = camPull(wall(-1.2), cam), len = cam.clone().sub(new THREE.Vector3(0, 0.3, 0)).length();
    expect(k).toBeLessThan(1);
    const at = new THREE.Vector3(0, 0.3, 0).add(cam.clone().sub(new THREE.Vector3(0, 0.3, 0)).multiplyScalar(k));
    expect(at.z).toBeGreaterThan(-1.1); expect(at.z).toBeLessThan(-0.9);   // 벽 앞면 z = -1.1 의 안쪽
    expect(k * len).toBeGreaterThanOrEqual(0.6);
  });
  it('벽이 머리 바로 뒤(0.3 m) 여도 최소 0.6 m', () => {
    const k = camPull(wall(-0.4), cam), len = cam.clone().sub(new THREE.Vector3(0, 0.3, 0)).length();
    expect(k * len).toBeCloseTo(0.6, 6);
  });
  it('투명한 것(금지 구역)은 막지 않음', () => { expect(camPull(wall(-1.2, true), cam)).toBe(1); });
});
