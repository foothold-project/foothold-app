// @vitest-environment node
// 로봇 탭 큰 무대 걷기 꼴(검토 L2): 걷기 기록을 놓은 뒤 종아리 가장 낮은 점이 바닥 y=0 (엎드림 높이에서 바뀌어도 발이 묻히거나 뜨지 않음)
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { walkPose } from '../screens/u4/go2view';

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
      expect(Math.abs(calfLow(root))).toBeLessThan(1e-6);
    }
  });
});
