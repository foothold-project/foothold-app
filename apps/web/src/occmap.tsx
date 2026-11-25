// 2D 칸 지도 색·범례(지도 만들기 screens/slammap.tsx 가 씀): 흰(빈 바닥)·검정(벽)·회색(모름). 그림 부품만 — 계산·명령 0.
// 11-25 RB-SLAM-WEB3: 조종 화면 «걸으며 만드는 지도»(OccMap·occgrid.ts 브라우저 격자 계산)는 없앰 — 지도 만들기는 지도 탭(Jetson 계산)에서만.

/** 칸 색(화소 ABGR): 모름 회색 · 빈 바닥 흰색 · 벽 검정 */
export const RGB = [[158, 158, 158], [255, 255, 255], [20, 20, 26]], COL = Uint32Array.from(RGB, ([r, g, b]) => (0xff000000 | (b << 16) | (g << 8) | r) >>> 0);
const css = (c: number[]) => `rgb(${c.join(',')})`;
/** 칸 색 범례(빈 바닥·벽·물건·아직 못 본 곳) */
export const OccLegend = () => <div className="qd-legend" aria-label="지도 범례" data-occ-legend>
  {(['빈 바닥', '벽·물건', '아직 못 본 곳'] as const).map((t, i) =>
    <span key={t} style={{ marginRight: 8, whiteSpace: 'nowrap' }}><i style={{ display: 'inline-block', width: 9, height: 9, marginRight: 3, verticalAlign: -1, background: css(RGB[(i + 1) % 3]), border: '1px solid rgba(255,255,255,.5)' }} />{t}</span>)}
</div>;
