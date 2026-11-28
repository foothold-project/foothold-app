// 관제 타일 3D 따라가기: 서버 위치 · yaw 를 칸마다 부드럽게 따라감(보간) · 먼 순간 이동은 바로 · 바닥 점은 실제로 간 거리만큼 흐름
// 타일 자리는 작은 지도와 같은 규칙: 데모 현장 승인 판(map_version_id)의 위치만 현장 3D 에 놓고, 아니면 null(점 바닥 + 까닭)
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { BODY_AIM, FRONT_DIST, REAR_DIST, SITE_AIM, aimY, follow, layers, simLook } from '../proto/tileview';
import { tileBreathe, tilePad, tilePose } from '../proto/u5';

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
// 팀장 20:4x: 시뮬은 관제에서 전처럼 파랗게. 질감판(ddd053ba) 뒤로 밝은 땅 위 더하기 섞기가 하얗게 날아갔다 · 땅은 지우지 않음(팀장 20:49)
describe('시뮬 칸 모습(시안 u5_1 K-08)', () => {
  it('어둠 = 더하기 섞기 파랑(시안 그대로) · 밝음 = 보통 섞기 예행 #2F6FE0(흰 바탕에서 보이게)', () => {
    expect(simLook(false)).toEqual({ blend: THREE.AdditiveBlending, col: 0x4c9bff });
    expect(simLook(true)).toEqual({ blend: THREE.NormalBlending, col: 0x2f6fe0 });
  });
});

describe('layers', () => {
  it('임무 중 현장(자리 + glb) = 현장만 · 점 바닥 끔, 그 밖 = 점 바닥만', () => {
    expect(layers(true, true)).toEqual({ world: true, dots: false });
    expect(layers(false, true)).toEqual({ world: false, dots: true });
    expect(layers(true, false)).toEqual({ world: false, dots: true });   // glb 를 아직 못 받음
    // 현장 위 뒤 1 m 는 지평선이 들어오게 높이 봄(00:53 흰 판 사진) · 시뮬 · 데모 · 실기 같음(팀장 01:04: 시뮬도 임무 중 = 그 판 공간) · 정면 · 점 바닥은 몸통
    const P = { x: 1, z: 1, rot: 0 };
    expect(aimY({ pose: P, front: false })).toBe(SITE_AIM);
    expect([aimY({ pose: null, front: false }), aimY({ pose: P, front: true })]).toEqual([BODY_AIM, BODY_AIM]);
    expect(Math.atan((0.55 - SITE_AIM) / REAR_DIST) * 180 / Math.PI).toBeLessThan(15);   // 아래로 15° 안 = 시야 30° 위 끝이 지평선 위
    expect([REAR_DIST, FRONT_DIST]).toEqual([1.0, 1.25]);   // 임무 중 뒤 1 m(팀장 23:48) · 정면 1.25 m
  });
});

describe('타일 바닥 표시 · 숨 (팀장 23:48)', () => {
  it('어느 로봇이 숨 쉬나: 시뮬 · 임무 전 · 걷지 않음 · 엎드리지 않음일 때만', () => {
    expect(tileBreathe({ sim: true, onRun: false, walk: false }, false)).toBe(true);
    expect(tileBreathe({ sim: false, onRun: false, walk: false }, false)).toBe(false);   // 실기 · 데모
    expect(tileBreathe({ sim: true, onRun: true, walk: false }, false)).toBe(false);
    expect(tileBreathe({ sim: true, onRun: false, walk: true }, false)).toBe(false);
    expect(tileBreathe({ sim: true, onRun: false, walk: false }, true)).toBe(false);
  });
  it('바닥 표시(시안 pad): 충전 = 가용 CHARGING · 점검 = 가용 MAINTENANCE(job maint) · 배터리 교체 · 시뮬은 없음', () => {
    expect(tilePad({ sim: false, charging: true, job: null })).toBe('charge');
    expect(tilePad({ sim: false, charging: false, job: { kind: 'maint', text: '점검 중' } })).toBe('check');
    expect(tilePad({ sim: false, charging: false, job: { kind: 'swap', text: '배터리 교체' } })).toBeNull();
    expect(tilePad({ sim: true, charging: true, job: null })).toBeNull();
    expect(tilePad({ sim: false, charging: false, job: null })).toBeNull();
  });
});
