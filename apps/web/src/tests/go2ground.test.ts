// @vitest-environment node
// 팀장 11-28 18:47: 실기 로봇이 엎드리면 공중에 떠서 앉음 → 자세마다 몸 · 발 가장 낮은 점이 바닥 y=0
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { DOWN, STAND, applyQ, ground, poseQ } from '../screens/u4/go2view';

const LEGS = ['FR', 'FL', 'RR', 'RL'];
// go2model JOINTS 순서(FR FL RR RL × hip thigh calf)
const q = (f: [number, number, number], r: [number, number, number], hipR = 0) => LEGS.flatMap((l) => (l[0] === 'F' ? f : r).map((x, i) => (i === 0 ? x + (l[1] === 'R' ? -hipR : hipR) : x)));
const POSES: Record<string, number[]> = {
  서기: q([0.1, 0.8, -1.5], [0.1, 1, -1.5]).map((x, i) => (i % 3 === 0 ? (LEGS[Math.floor(i / 3)][1] === 'R' ? -0.1 : 0.1) : x)),
  엎드림: q([0, 1.36, -2.78], [0, 1.36, -2.78]),
  앉기: q([0, 0.5, -1.2], [0, 1.4, -2.7]),
  넘어짐: q([0.8, 0.3, -0.9], [-0.6, 2.0, -1.0], 0.5),
};
const minY = (o: THREE.Object3D) => { o.updateMatrixWorld(true); return new THREE.Box3().setFromObject(o, true).min.y; };

/** 모형 없는 시험용 Go2 꼴: 몸 상자 + 다리 넷(hip → thigh → calf, 각 마디 아래로 0.21 m) */
function fake() {
  const root = new THREE.Group(), joints: Record<string, { o: THREE.Object3D; r0: THREE.Euler }> = {};
  const box = (w: number, h: number, d: number, y = 0) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d)); m.position.y = y; return m; };
  root.add(box(0.38, 0.1, 0.2));
  LEGS.forEach((L) => {
    const hip = new THREE.Group(); hip.name = `${L}_hip`; hip.position.set(L[1] === 'R' ? -0.09 : 0.09, 0, L[0] === 'F' ? 0.19 : -0.19); root.add(hip);
    const th = new THREE.Group(); th.name = `${L}_thigh`; hip.add(th); th.add(box(0.04, 0.21, 0.04, -0.105));
    const ca = new THREE.Group(); ca.name = `${L}_calf`; ca.position.y = -0.21; th.add(ca); ca.add(box(0.03, 0.21, 0.03, -0.105));
    for (const o of [hip, th, ca]) joints[o.name] = { o, r0: o.rotation.clone() };
  });
  root.position.y = 0.4;   // 서 있을 때 높이(모형을 받은 뒤 한 번 맞춘 값이 남아 있는 상태)
  return { root, joints };
}

describe('Go2 3D · 자세별 바닥 맞춤', () => {
  for (const [name, v] of Object.entries(POSES)) it(`${name}: 가장 낮은 점 y ≈ 0`, () => {
    const { root, joints } = fake();
    applyQ(root, joints, v);
    expect(Math.abs(minY(root))).toBeLessThan(1e-6);
  });

  it('관절값 없음 + posture LYING → 시안 엎드림 자세 · 바닥 y=0 · 관절값이 오면 관절값이 이김 · posture 없으면 서기', () => {
    expect(poseQ(null, true)).toBe(DOWN);
    // 엎드림 = 관절 한계 안(종아리 하한 -2.72 · 넘으면 종아리가 들림): thigh 1.36 · calf -2.72 · hip 은 서기 값
    expect(DOWN.filter((_, i) => i % 3 === 1)).toEqual([1.36, 1.36, 1.36, 1.36]);
    expect(DOWN.filter((_, i) => i % 3 === 2)).toEqual([-2.72, -2.72, -2.72, -2.72]);
    expect(DOWN.every((x, i) => i % 3 !== 2 || x >= -2.72)).toBe(true);
    expect(poseQ(null, false)).toBe(STAND);
    const got = POSES['앉기']; expect(poseQ(got, true)).toBe(got);
    const a = fake(); applyQ(a.root, a.joints, poseQ(null, false)); const stand = a.root.position.y;
    const b = fake(); applyQ(b.root, b.joints, poseQ(null, true));
    expect(Math.abs(minY(b.root))).toBeLessThan(1e-6);
    expect(b.root.position.y).toBeLessThan(stand - 0.05);
  });

  it('엎드리면 몸이 서 있을 때보다 내려온다(관절만 접고 높이를 그대로 두면 뜬다)', () => {
    const a = fake(); applyQ(a.root, a.joints, POSES['서기']); const stand = a.root.position.y;
    const b = fake(); applyQ(b.root, b.joints, POSES['서기']);
    // 고치기 전 동작: 서기 높이 그대로 관절만 엎드림 → 바닥에서 뜸
    for (const j of Object.values(b.joints)) j.o.rotation.copy(j.r0);
    ['FR', 'FL', 'RR', 'RL'].forEach((L) => { b.joints[`${L}_thigh`].o.rotation.x += 1.36 - (L[0] === 'F' ? 0.8 : 1); b.joints[`${L}_calf`].o.rotation.x += -2.78 + 1.5; });
    expect(minY(b.root)).toBeGreaterThan(0.02);
    ground(b.root);
    expect(Math.abs(minY(b.root))).toBeLessThan(1e-6);
    expect(b.root.position.y).toBeLessThan(stand - 0.05);
  });

  // 실제 자산(저장소 밖 · 있을 때만): 시안 go2_isaac.glb 로 같은 규칙
  // 자산 폴더 = FH_ASSET_DIR (/proto-assets/ 로 나가는 폴더). 없으면 건너뜀
  const DIR = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.FH_ASSET_DIR;
  it.skipIf(!DIR)('실제 Go2 모형(go2_isaac.glb): 네 자세 모두 가장 낮은 점 y ≈ 0', async () => {
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
    const fs = await import(/* @vite-ignore */ 'node:fs' as string) as { readFileSync: (p: string) => Uint8Array };
    const buf = fs.readFileSync(`${DIR}/shared/go2_isaac.glb`), ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const g = await new Promise<{ scene: THREE.Group }>((ok, no) => new GLTFLoader().parse(ab, '', ok as never, no));
    const root = g.scene, joints: Record<string, { o: THREE.Object3D; r0: THREE.Euler }> = {};
    root.traverse((o) => { if (/^(FL|FR|RL|RR)_(hip|thigh|calf)$/.test(o.name)) joints[o.name] = { o, r0: o.rotation.clone() }; });
    expect(Object.keys(joints)).toHaveLength(12);
    const ys: Record<string, number> = {};
    for (const [name, v] of Object.entries(POSES)) { applyQ(root, joints, v); expect(Math.abs(minY(root)), name).toBeLessThan(1e-5); ys[name] = root.position.y; }
    expect(ys['엎드림']).toBeLessThan(ys['서기']);
    expect(ys['서기'] - ys['엎드림']).toBeGreaterThan(0.1);   // 고치기 전에는 이만큼 떠 있었다(모형 단위)
  });
});
