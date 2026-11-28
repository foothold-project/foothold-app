// 로봇 탭 시뮬 시점 · 경로 계산(simcam.ts · route.ts): 좌표계 판정 · 카메라 자리 · 남은 직선 거리 · 다음 지점
import { describe, expect, it } from 'vitest';
import { CAM_H, camPose, factoryFrame } from '../screens/u4/simcam';
import { nextIdx, remaining, ro, runOf } from '../screens/u4/route';
import type { Robot } from '../fake';

const F = { width: 3200, height: 2000, resolution: 1 / 3.5, origin: [-25 / 3.5, -1980 / 3.5, 0] as [number, number, number] };
const wp = (x: number, y: number, map_version_id = 'v1') => ({ floor_id: 'f', map_version_id, x, y, mission_id: 'm', mission_version: 1 });

describe('simcam · route', () => {
  it('시안 공장 터 좌표계 = 3200 × 2000 · 3.5 px/m · 원점 (25, 20) px 일 때만. 시뮬 월드 판(0.05 m/px)은 아님', () => {
    expect(factoryFrame(F)).toBe(true);
    expect(factoryFrame({ ...F, resolution: 0.05 })).toBe(false);
    expect(factoryFrame({ ...F, origin: [-1, -1, 0] })).toBe(false);
    expect(factoryFrame({ ...F, origin: [F.origin[0], F.origin[1], 0.3] })).toBe(false);
    expect(factoryFrame({ width: 760, height: 440, resolution: 0.05, origin: [-1, -1, 0] })).toBe(false);   // plant_a l1
  });
  it('카메라 = 서버 위치 · 바닥 + CAM_H · yaw 쪽으로 조금 숙여 봄', () => {
    const p = camPose({ x: 3, y: 4, yaw: Math.PI / 2 }, 1.5);
    expect(p.at).toEqual([3, 4, 1.5 + CAM_H]);
    expect(p.look[0]).toBeCloseTo(3); expect(p.look[1]).toBeCloseTo(14); expect(p.look[2]).toBeLessThan(p.at[2]);
    expect(CAM_H).toBeGreaterThan(0.25); expect(CAM_H).toBeLessThan(0.45);
  });
  it('남은 직선 거리: 지금 자리 → 다음 지점 → 끝(이 판만) · 다른 판 지점은 more', () => {
    expect(remaining({ x: 0, y: 0 }, [wp(-5, 0), wp(3, 4), wp(3, 10)], 1, 'v1')).toEqual({ m: 11, more: false });
    expect(remaining({ x: 0, y: 0 }, [wp(3, 4), wp(9, 9, 'v2')], 0, 'v1')).toEqual({ m: 5, more: true });
  });
  it('다음 지점 = 끝낸 수 · 진행 총수와 지점 수가 다르면 모름 · 다 끝났으면 없음', () => {
    expect(nextIdx({ done: 1, total: 4 }, 4)).toBe(1);
    expect(nextIdx({ done: 1, total: 5 }, 4)).toBeNull();
    expect(nextIdx({ done: 4, total: 4 }, 4)).toBeNull();
  });
  it('받침 (으)로 · 끝난 임무는 없음 · 진행은 실시간 값이 먼저', () => {
    expect(ro('게이지 읽기')).toBe('로'); expect(ro('출구')).toBe('로'); expect(ro('탱크 밸브')).toBe('로'); expect(ro('정문')).toBe('으로'); expect(ro('A')).toBe('로');
    const r = { run: { id: 'x', status: 'MOVING', scenario_name: '순찰', progress: { done: 0, total: 2 } } } as Robot;
    expect(runOf(r, null)).toEqual({ name: '순찰', status: 'MOVING', progress: { done: 0, total: 2 } });
    expect(runOf(r, { run_id: 'x', status: 'PAUSED', step: 1, progress: { done: 1, total: 2 }, wait_reason: null, fail_code: null })).toEqual({ name: '순찰', status: 'PAUSED', progress: { done: 1, total: 2 } });
    expect(runOf(r, { run_id: 'x', status: 'COMPLETED', step: 2, progress: { done: 2, total: 2 }, wait_reason: null, fail_code: null })).toBeNull();
    expect(runOf({ run: null } as Robot, null)).toBeNull();
  });
});
