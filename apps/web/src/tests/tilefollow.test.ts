// 관제 타일 3D 따라가기: 서버 위치 · yaw 를 칸마다 부드럽게 따라감(보간) · 먼 순간 이동은 바로 · 바닥 점은 실제로 간 거리만큼 흐름
// 타일 자리는 작은 지도와 같은 규칙: 데모 현장 승인 판(map_version_id)의 위치만 현장 3D 에 놓고, 아니면 null(점 바닥 + 까닭)
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { follow, showSite, simLook } from '../proto/tileview';
import { tilePose } from '../proto/u5';

const P = (x: number, z: number, rot: number) => ({ x, z, rot });
describe('follow', () => {
  it('처음 = 그 자리 그대로 · 간 거리 0', () => {
    expect(follow(null, P(3, 4, 1), 0.05)).toEqual({ ...P(3, 4, 1), travel: 0 });
  });
  it('조금씩 다가가고(한 번에 건너뛰지 않음) 시간이 지나면 닿음', () => {
    let c = follow(null, P(0, 0, 0), 0.05);
    c = follow(c, P(1, 0, 0), 0.05);
    expect(c.x).toBeGreaterThan(0); expect(c.x).toBeLessThan(0.5);
    for (let i = 0; i < 60; i++) c = follow(c, P(1, 0, 0), 0.05);
    expect(c.x).toBeCloseTo(1, 3);
    expect(c.travel).toBeCloseTo(1, 3);   // 바닥 점은 실제로 간 1 m 만큼
  });
  it('곡선 = 시안 site3d.js 돌기(한 프레임에 남은 차 × min(1, dt × 6))', () => {
    const c = follow(follow(null, P(0, 0, 0), 0.05), P(1, 0, 1), 0.05);
    expect(c.x).toBeCloseTo(0.3, 6); expect(c.rot).toBeCloseTo(0.3, 6);
    expect(follow(follow(null, P(0, 0, 0), 0.05), P(1, 0, 0), 0.5).x).toBe(1);   // 긴 프레임은 한 번에 닿음(넘지 않음)
  });
  it('방향은 짧은 쪽으로 돈다(3.0 → -3.0 은 π 를 넘어 0.28 rad)', () => {
    let c = follow(null, P(0, 0, 3.0), 0.05);
    c = follow(c, P(0, 0, -3.0), 0.05);
    expect(c.rot).toBeGreaterThan(3.0);
  });
  it('5 m 넘는 순간 이동(다른 자리에서 다시 잡힘)은 보간 없이 바로 · 간 거리에 넣지 않음', () => {
    const c = follow(follow(null, P(0, 0, 0), 0.05), P(40, 0, 0), 0.05);
    expect(c.x).toBe(40); expect(c.travel).toBe(0);
  });
});
describe('tilePose', () => {
  const at = (map_version_id: string | null) => ({ floor_id: null, map_version_id, x: 2, y: 3, yaw: 0.5, confidence: 1, updated_at: '' });
  it('데모 현장 판의 위치 = 현장 좌표(작은 지도 sitePose 와 같음)', () => {
    expect(tilePose(at('v-demo') as never, new Set(['v-demo']))).toEqual({ x: 2, z: -3, rot: 0.5 + Math.PI / 2 });
  });
  it('다른 판 · 판 없음 · 위치 없음 = null(공장 안에 엉뚱하게 놓지 않음)', () => {
    expect(tilePose(at('v-other') as never, new Set(['v-demo']))).toBeNull();
    expect(tilePose(at(null) as never, new Set(['v-demo']))).toBeNull();
    expect(tilePose(null, new Set(['v-demo']))).toBeNull();
  });
});
// 팀장 20:4x: 시뮬은 관제에서 전처럼 파랗게. 질감판(ddd053ba) 뒤로 밝은 땅 위 더하기 섞기가 하얗게 날아갔다
describe('시뮬 칸 모습(시안 u5_1 K-08)', () => {
  it('시뮬 칸은 현장 질감판을 그리지 않음 · 실기 · 데모 칸은 자리와 현장이 있으면 그림', () => {
    expect(showSite({ x: 0 }, {}, true)).toBe(false);
    expect(showSite({ x: 0 }, {}, false)).toBe(true);
    expect(showSite(null, {}, false)).toBe(false);
    expect(showSite({ x: 0 }, null, false)).toBe(false);
  });
  it('어둠 = 더하기 섞기 파랑(시안 그대로) · 밝음 = 보통 섞기 예행 #2F6FE0(흰 바탕에서 보이게)', () => {
    expect(simLook(false)).toEqual({ blend: THREE.AdditiveBlending, col: 0x4c9bff });
    expect(simLook(true)).toEqual({ blend: THREE.NormalBlending, col: 0x2f6fe0 });
  });
});
