// RB-LIDAR-RAW-MOUNT: raw(lidar_link) 판만 장착 변환 1회, odom·모르는 frame 은 그대로.
// 고정 자료 출처 = runs/specs/RS-LIDAR-ARCH-evidence.json live_points_function_replay(11-26 실제 raw 한 판, 근거리 1583점):
// 보정 전 z 중앙값 +0.19558, 보정 후 −0.18660, 거리 중앙값 0.22422 m. 원시 점군은 커밋하지 않아 그 분위수에 맞춘 대표 점 5개만 둔다
// (가운데 점 = 거리 0.22422·raw z +0.19558 에서 base z −0.18660 이 되게 푼 점, 나머지는 raw z p5·p95 쪽 센서 바로 위 점).
import { describe, expect, it } from 'vitest';
import type { DriveFeed } from '../drivemedia';
import { R_BASE_LIDAR, T_BASE_LIDAR, inBase, lidarToBase } from '../lidarmount';

const NEAR = [
  0, 0, 0.08509309366345406,
  0, 0, 0.15,
  0.0965357094093689, 0.05196953845138149, 0.19558416306972504,
  0, 0, 0.21,
  0, 0, 0.2269909679889679,
];
const med = (a: number[]) => a.slice().sort((p, q) => p - q)[a.length >> 1];
const zs = (x: Float32Array) => Array.from({ length: x.length / 3 }, (_, i) => x[i * 3 + 2]);
const feed = (frame: string, xyz: number[]): DriveFeed => ({ state: 'live', why: '', at: 0, seq: 1, img: '', xyz: new Float32Array(xyz), n: xyz.length / 3, frame, truncated: false, ver: 1, range: null,
  pose: frame === 'odom' ? { x: 1, y: 2, z: 0.05, yaw: 0.3 } : null } as DriveFeed);

describe('lidarmount', () => {
  it('실제 raw 한 판 근거리 점: z 중앙값 +0.196 → 약 −0.187 m(아래쪽), 모두 센서 0.25 m 안', () => {
    const f = feed('lidar_link', NEAR);
    for (let i = 0; i < 5; i++) expect(Math.hypot(NEAR[i * 3], NEAR[i * 3 + 1], NEAR[i * 3 + 2])).toBeLessThan(0.25);
    expect(med(zs(f.xyz))).toBeCloseTo(0.196, 3);
    const b = inBase(f);
    expect(med(zs(b.xyz))).toBeCloseTo(-0.1866, 3);
    expect(b.xyz[6]).toBeCloseTo(0.3414, 3);   // 앞쪽(센서가 몸 앞 0.28 m) — evidence mount_corrected x 중앙값 0.345 쪽
  });

  it('센서 원점 → T, 축 → R 의 열(p_base = R·p + T)', () => {
    const o = lidarToBase(new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]), 3);
    [0, 1, 2].forEach((a) => {
      expect(o[a]).toBeCloseTo(T_BASE_LIDAR[a], 6);
      expect(o[3 + a]).toBeCloseTo(R_BASE_LIDAR[a][0] + T_BASE_LIDAR[a], 6);
      expect(o[6 + a]).toBeCloseTo(R_BASE_LIDAR[a][2] + T_BASE_LIDAR[a], 6);
    });
  });

  it('같은 raw 판은 한 번만 변환(두 번 적용 없음), 받은 배열은 그대로', () => {
    const f = feed('lidar_link', NEAR), before = f.xyz.slice();
    const a = inBase(f), b = inBase(f);
    expect(b.xyz).toBe(a.xyz);
    expect(inBase(a)).toBe(a);   // 바꾼 판(frame 은 여전히 lidar_link)을 다시 넣어도 그대로
    expect(f.xyz).toEqual(before);
  });

  it('RV-507: 같은 xyz 를 가진 새 feed 객체를 여러 번 넣어도 변환 1회 — 같은 결과 배열, 같은 바이트', () => {
    const xyz = new Float32Array(NEAR), first = inBase({ ...feed('lidar_link', []), xyz, n: 5 });
    const bytes = new Uint8Array(lidarToBase(xyz, 5).buffer);
    for (let i = 0; i < 5; i++) {
      const g = inBase({ ...feed('lidar_link', []), xyz, n: 5, ver: 1 });   // realdrive.tsx 처럼 매 렌더 { ...lf } 새 객체
      expect(g.xyz).toBe(first.xyz);
      expect(new Uint8Array(g.xyz.buffer)).toEqual(bytes);
    }
    expect(Array.from(xyz)).toEqual(Array.from(new Float32Array(NEAR)));   // 받은 배열은 그대로
  });

  it('odom·map·처음 보는 frame 은 받은 판 그대로(같은 객체·같은 바이트)', () => {
    for (const fr of ['odom', 'map', 'utlidar_lidar', '']) {
      const f = feed(fr, NEAR), bytes = new Uint8Array(f.xyz.buffer).slice();
      expect(inBase(f)).toBe(f);
      expect(new Uint8Array(inBase(f).xyz.buffer)).toEqual(bytes);
    }
  });
});
