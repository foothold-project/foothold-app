// 지형에서 나온 시뮬 판의 «실제 모습»: 판에 실린 지형 모양(terrain_spec)을 위에서 본 SVG 로 바로 그린다(사진 굽기·저장 없음).
// 자리 = 서버 terrain_grid 와 같은 기준(res·origin [-sx/2, -sy/2, 0]·크기 ceil(s/res), 위쪽 = +y). 판 좌표가 지형과 다르면 null(장애물 지도만).
// 모양·색은 지형 편집 위에서 보기(screens/terrain.tsx Shape)와 같다: 높을수록 진한 accent, 계단은 단마다, 경사로는 낮은 쪽→높은 쪽, 틈은 어두운 구멍.
import type { MapVersion, TerrainSpec } from '../../contracts/ts';

type Ver = Pick<Partial<MapVersion>, 'provenance' | 'terrain_spec'> & Pick<MapVersion, 'origin' | 'resolution' | 'width' | 'height'>;
type Item = TerrainSpec['items'][number];
const tone = (k: number) => `color-mix(in srgb, var(--accent) ${Math.round(14 + 66 * Math.max(0, Math.min(1, k)))}%, var(--panel2))`;   // terrain.tsx 와 같은 값(높이 1 m = 가장 진함)
const HOLE = '#14171C';   // terrain.tsx 틈 색
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
const num = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
/** 종류마다 있어야 할 숫자(x·y·yaw 말고). 모르는 종류·빠진 값·NaN/Infinity 면 그림 전체를 접는다(장애물 지도만) */
const NEED = new Map([['box', ['sx', 'sy', 'h']], ['gap', ['length', 'width']], ['ramp', ['length', 'width', 'h']], ['stairs', ['width', 'steps', 'rise', 'run']]]);
const okItem = (it: unknown) => {
  const o = it as Record<string, unknown> | null, need = NEED.get(o?.kind as string);
  return !!need && ['x', 'y', 'yaw', ...need].every((k) => num(o![k]));
};

/** 판 그림 픽셀 위의 지형 그림. 시뮬 판(SIMULATION)의 지형 모양이 아니거나 판 격자가 지형 크기와 다르면 null. gid = 그러데이션 id 앞말(틀마다 달라야 함) */
export function terrainTop(v: Ver | null | undefined, gid: string): JSX.Element | null {
  const s = v?.terrain_spec, r = v?.resolution ?? 0, o = v?.origin ?? [];
  if (!v || v.provenance !== 'SIMULATION' || !s || !Array.isArray(s.size) || !Array.isArray(s.items) || !num(r) || !(r > 0)) return null;
  const [sx, sy] = s.size;
  if (s.size.length !== 2 || !num(sx) || !num(sy) || !(sx > 0) || !(sy > 0) || !s.items.every(okItem)) return null;
  if (v.width !== Math.ceil(sx / r) || v.height !== Math.ceil(sy / r) || o.length !== 3 || !near(o[0], -sx / 2) || !near(o[1], -sy / 2) || !near(o[2], 0)) return null;
  const px = (x: number, y: number) => [(x - o[0]) / r, v.height - (y - o[1]) / r];
  /** 물체 몸 기준(+x = 길이 쪽) 점 → 그림 픽셀 */
  const at = (it: Item, u: number, w: number) => px(it.x + Math.cos(it.yaw) * u - Math.sin(it.yaw) * w, it.y + Math.sin(it.yaw) * u + Math.cos(it.yaw) * w);
  /** 몸 기준 길이 [u0, u1] × 폭 b 사각형 */
  const quad = (it: Item, u0: number, u1: number, b: number) => [[u0, -b / 2], [u1, -b / 2], [u1, b / 2], [u0, b / 2]].map(([u, w]) => at(it, u, w).map((n) => +n.toFixed(3)).join(',')).join(' ');
  const shape = (it: Item, i: number) => {
    if (it.kind === 'box') return <polygon key={i} points={quad(it, -it.sx / 2, it.sx / 2, it.sy)} fill={tone(it.h)} data-kind="box" />;
    if (it.kind === 'gap') return <polygon key={i} points={quad(it, -it.length / 2, it.length / 2, it.width)} fill={HOLE} data-kind="gap" />;
    if (it.kind === 'ramp') {
      const [x1, y1] = at(it, -it.length / 2, 0), [x2, y2] = at(it, it.length / 2, 0), g = `${gid}-r${i}`;
      return <g key={i} data-kind="ramp">
        <linearGradient id={g} gradientUnits="userSpaceOnUse" x1={x1} y1={y1} x2={x2} y2={y2}><stop offset="0" stopColor="var(--panel2)" /><stop offset="1" stopColor={tone(it.h)} /></linearGradient>
        <polygon points={quad(it, -it.length / 2, it.length / 2, it.width)} fill={`url(#${g})`} /></g>;
    }
    const n = Math.max(0, Math.min(Math.floor(it.steps), 200)), u0 = -(n * it.run + 1) / 2;   // 계단 발자국 = 단 + 1 m 층계참(buildTerrain 과 같음)
    return <g key={i} data-kind="stairs" stroke="var(--panel)" strokeWidth={1} vectorEffect="non-scaling-stroke">
      {Array.from({ length: n }, (_, k) => <polygon key={k} points={quad(it, u0 + k * it.run, u0 + (k + 1) * it.run, it.width)} fill={tone((k + 1) * it.rise)} />)}
      <polygon points={quad(it, u0 + n * it.run, -u0, it.width)} fill={tone(n * it.rise)} /></g>;
  };
  const [fx, fy] = px(-sx / 2, sy / 2);
  // 틈 먼저(바닥 구멍), 그 위에 다른 물체
  return <g data-map-top data-terrain-top style={{ pointerEvents: 'none' }}>
    <rect x={fx} y={fy} width={sx / r} height={sy / r} fill="var(--panel)" />
    {s.items.map((it, i) => it.kind === 'gap' && shape(it, i))}
    {s.items.map((it, i) => it.kind !== 'gap' && shape(it, i))}
  </g>;
}
