// 11-26 RB-LIDAR-RAW-MOUNT: raw 센서 좌표 판(frame lidar_link — agent 가 /utlidar/cloud 를 그대로 보낸 대체 판)만 센서→몸(base_link) 장착 변환을 정확히 1회 적용한다.
// odom·map 등 이미 그 기준인 판과 처음 보는 frame 은 받은 그대로(같은 객체). 거리 필터 없음 — 근거리 점이 몸 반사인지 바닥인지 아직 모름(RS-LIDAR-ARCH-report «(다)»).
import type { DriveFeed } from './drivemedia';

/** Go2 L1 장착(p_base = R·p_lidar + T). 출처: runs/slam-install/calib/evidence/calib-mount-summary.json results[0]
 *  (2026-11-25 Unitree /utlidar/cloud ↔ cloud_base 같은 stamp 614쌍, RMS 2.78e-7 m) — 값 그대로, 반올림·다듬기 금지. 다른 로봇 값은 추측해 넣지 않는다 */
export const R_BASE_LIDAR = [
  [0.5261139869689941, -0.8101357817649841, 0.2586197257041931],
  [-0.838668167591095, -0.5446428060531616, 1.5481723494303878e-06],
  [0.1408541053533554, -0.2168969362974167, -0.9659792184829712],
] as const;
export const T_BASE_LIDAR = [0.28215980529785156, 1.0244548320770264e-07, -2.9802322387695312e-08] as const;
export const RAW_FRAME = 'lidar_link';

/** 센서 좌표 xyz(앞 n 점) → 몸 좌표 새 배열(받은 배열은 그대로) */
export function lidarToBase(xyz: Float32Array, n: number): Float32Array {
  const [r0, r1, r2] = R_BASE_LIDAR, out = new Float32Array(n * 3);
  for (let i = 0; i < n * 3; i += 3) {
    const x = xyz[i], y = xyz[i + 1], z = xyz[i + 2];
    out[i] = r0[0] * x + r0[1] * y + r0[2] * z + T_BASE_LIDAR[0];
    out[i + 1] = r1[0] * x + r1[1] * y + r1[2] * z + T_BASE_LIDAR[1];
    out[i + 2] = r2[0] * x + r2[1] * y + r2[2] * z + T_BASE_LIDAR[2];
  }
  return out;
}

/** 같은 판은 한 번만 변환 — 열쇠는 원본 xyz 배열(RV-507: 호출부가 매 렌더 새 feed 객체를 만들어도, 3D·2D 가 같이 그려도 한 번). 바꾼 배열도 자기 자신으로 넣어 두 번 적용 없음 */
const done = new WeakMap<Float32Array, Float32Array>();
/** raw 판이면 xyz 를 몸 좌표로 바꾼 판, 그 밖은 받은 판 그대로 */
export function inBase(f: DriveFeed): DriveFeed {
  if (f.frame !== RAW_FRAME) return f;
  const m = Math.min(f.n, Math.floor(f.xyz.length / 3));
  let b = done.get(f.xyz);
  if (b === f.xyz) return f;   // 이미 바꾼 판을 다시 넣음
  if (!b || b.length !== m * 3) { b = lidarToBase(f.xyz, m); done.set(f.xyz, b); done.set(b, b); }
  return { ...f, xyz: b };
}
