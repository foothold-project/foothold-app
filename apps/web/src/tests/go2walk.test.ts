// @vitest-environment node
// 로봇 탭 큰 무대 걷기 꼴(검토 L2): 걷기 기록을 놓은 뒤 종아리 가장 낮은 점이 바닥 y=0 (엎드림 높이에서 바뀌어도 발이 묻히거나 뜨지 않음)
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { mapShadow, stageLook, walkPose } from '../screens/u4/go2view';
import { REAR_DIST, SHADOW } from '../proto/tileview';

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

describe('stageLook (큰 무대 카메라 · 그림자)', () => {
  it('현장 꼴 = 로봇 뒤 · 카메라 거리 = 관제 타일 「뒤」 값(REAR_DIST) · 무대 그림자 끔, 아니면 처음 자리 · 무대 그림자', () => {
    expect(stageLook(true, { yaw: 0, dist: 1.3 })).toEqual({ yaw: Math.PI, dist: REAR_DIST, stageShadow: false });
    expect(stageLook(false, { yaw: 0, dist: 1.3 })).toEqual({ yaw: 0, dist: 1.3, stageShadow: true });
  });
  it('현장 꼴 그림자 = 관제 타일 SHADOW(반지름 · 길이 배 · 진하기) · 로봇 자리 바닥 · 긴 쪽 = 로봇 앞', () => {
    expect(mapShadow({ x: 3, y: -2, yaw: 0.7 }, 0.4)).toEqual({ r: SHADOW.r, x: 3, y: -2, z: 0.401, rotZ: 0.7, sx: SHADOW.sy, sy: 1, opacity: SHADOW.opacity });
  });
});
