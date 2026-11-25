// 높이 색표 하나(11-25 RB-LIDAR-COLOR): 조종 화면 라이다 3D 점·상자·위에서 본 그림, 저장 지도 3D(screens/voxel3d), 범례 막대가 모두 이 표.
// 바닥 띠는 채도 낮은 회남색, 0.1~1.2 m 는 15~20 cm 마다 색상이 크게 바뀌고, 그 위는 느슨하게. 이웃 단계는 밝기(L*)도 17 이상 다르게(색각 이상·다크/라이트 배경).
// three 를 가져오지 않는다 — voxelmap.tsx(지도 탭 첫 화면)가 three 없이 범례를 그린다. 이 화면 전용 값(디자인 토큰 아님).
/** [이 높이(바닥 위 m) 미만, 색] — 위로 갈수록. 경계는 STEP 의 배수(한 단계가 두 띠에 걸치지 않게)
 *  ponytail: 경계·색은 책상(0.75 m)·벽 가짜 판으로 맞춤 — 실기 화면을 나란히 보고 조정 */
export const BANDS: readonly (readonly [number, string])[] = [
  [0.1, '#6b7894'],   // 바닥 (±0.1 m — 아래로 꺼진 점도)
  [0.25, '#17c3a6'], [0.4, '#2e8f3a'], [0.55, '#d4c814'], [0.7, '#e8710f'], [0.85, '#c8202c'], [1.0, '#ff7eb6'], [1.2, '#7d3cc8'],
  [1.6, '#63a6ff'], [Infinity, '#b8137f'],
];
/** 범례 끝(m) — 넘으면 맨 끝 색 */
export const TOP_M = 2.0;
/** 높이 단계 크기(m)·수 — 점마다 levelOf 로 표 찾기만 */
export const STEP = 0.025, N = Math.round(TOP_M / STEP) + 1;
/** 바닥(floor)부터 높이 z → 단계 0..N-1 */
export const levelOf = (z: number, floor: number) => Math.max(0, Math.min(N - 1, Math.floor((z - floor) / STEP)));
/** 바닥 위 높이 h(m) 의 색 */
export const hexAt = (h: number) => BANDS.find(([top]) => h < top)![1];
/** 단계별 색(#rrggbb) — 단계 가운데 높이로 고른다 */
export const HEX = Array.from({ length: N }, (_, k) => hexAt((k + 0.5) * STEP));
/** 범례 막대(0 ~ TOP_M, 띠 경계 그대로 끊어서) */
export const LEGEND_BG = `linear-gradient(to right, ${BANDS.map(([top, c], i) => {
  const a = i ? BANDS[i - 1][0] / TOP_M * 100 : 0, b = Math.min(top, TOP_M) / TOP_M * 100;
  return `${c} ${+a.toFixed(2)}% ${+b.toFixed(2)}%`;
}).join(', ')})`;
