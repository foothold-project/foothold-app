// MuJoCo 시뮬 띄우기 칸(11-03 사용자): 지도 카드 고르기 → (여러 층이면) 층 고르기, 기본은 첫 층 → 위에서 본 사진을 눌러 시작 위치(안 누르면 기본 시작 지점) → «시뮬 열기».
// 열기 주소 약속(시뮬 쪽 SIM-START-POINT 와 같음): simUrl(지도) + 여러 층이면 &floor=<층 id> + 골랐으면 &start=<x>,<y>(m, 소수 2자리).
import { useEffect, useState, type MouseEvent } from 'react';
import SIM_MAPS from '../../../mobile/sim/maps.json';
import { simUrl } from './simdrive';
import type { MapFloor, MapVersion } from '../../contracts/ts';
import { SIM_TOP, topOf } from './mapframe';
import { oldMissions } from './screens/btedit';

type Floor = { id: string; name: string; top: string; map_file: string; image_sha256?: string };
/** top.json(mobile/scripts/make-top.mjs): 사진이 덮는 지도 좌표 [x0, y0, x1, y1] m — 층마다 사진만 다르고 범위는 같다 */
type TopMeta = { bounds: [number, number, number, number]; floors?: Floor[] };
type Grid = { origin: number[]; res: number; w: number; h: number; spawn_xyyaw: number[]; px: Uint8Array };
const dir = (id: string, f: string) => `../../../mobile/sim/assets/${id}/${f}`;
const PNG = import.meta.glob<string>('../../../mobile/sim/assets/*/top*.png', { eager: true, query: '?url', import: 'default' });
const META = import.meta.glob<TopMeta>('../../../mobile/sim/assets/*/top.json', { eager: true, import: 'default' });
/** 장애물 지도(ROS 3값 0 벽·205 모름·254 빈 곳, px = base64) — 커서(최대 1.3 MB) 고른 층 것만 그때 읽는다 */
const GRID = import.meta.glob<Omit<Grid, 'px'> & { px: string }>('../../../mobile/sim/assets/*/map*.json', { import: 'default' });
const ONE: Floor = { id: '', name: '', top: 'top.png', map_file: 'map.json' };   // 한 층 지도 = top.png·map.json, 주소에 floor 없음
const floorsOf = (id: string) => META[dir(id, 'top.json')]?.floors ?? [ONE];

/** 고른 지도 기억(저장 실패해도 동작). 옛 공장 층별 값은 한 지도로 */
const MAP_KEY = 'fh.simMap';
const savedMap = () => { try { return (localStorage.getItem(MAP_KEY) ?? '').replace(/^factory-zone-f[12]$/, 'factory-zone'); } catch { return ''; } };

/** 화면 점 → 지도 좌표(m). 사진은 svg viewBox 안에 비율 유지(meet)로 그려져 위아래·양옆 여백이 생길 수 있다. 화면 아래쪽 = −y */
export function toWorld(r: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>, [x0, y0, x1, y1]: TopMeta['bounds'], cx: number, cy: number): [number, number] {
  const w = x1 - x0, h = y1 - y0, s = Math.min(r.width / w, r.height / h);
  return [x0 + (cx - r.left - (r.width - w * s) / 2) / s, y1 - (cy - r.top - (r.height - h * s) / 2) / s];
}
/** 시뮬이 시작 위치로 받는 벽·물건과의 거리(mobile/sim/astar.js CLEARANCE — 시뮬은 이 안이면 기본 위치로 돌아간다) */
const CLEARANCE = 0.45;
/** 시작할 수 없는 자리면 이유, 되면 ''. 시뮬 main.js 시작 검사와 같은 순서: 지도 밖 → 빈 곳(254) 아님 → 둘레 CLEARANCE 안에 빈 곳 아닌 칸(astar.js fits).
 *  칸 계산은 mobile/sim/lidar.js cell 과 같다(행 0 = 위쪽) */
export function blocked(g: Grid, x: number, y: number) {
  const c = Math.floor((x - g.origin[0]) / g.res), r = g.h - 1 - Math.floor((y - g.origin[1]) / g.res);
  if (c < 0 || r < 0 || c >= g.w || r >= g.h) return '지도 밖입니다 — 지도 안을 눌러 주세요.';
  const v = g.px[r * g.w + c];
  if (v !== 254) return v === 205 ? '지도에 없는(모르는) 곳이라 시작할 수 없습니다.' : '벽·장애물 자리라 시작할 수 없습니다.';
  const k = Math.ceil(CLEARANCE / g.res);
  for (let dr = -k; dr <= k; dr++) for (let dc = -k; dc <= k; dc++) {
    const rr = r + dr, cc = c + dc;
    if (rr >= 0 && cc >= 0 && rr < g.h && cc < g.w && Math.hypot(dr, dc) * g.res <= CLEARANCE + 1e-9 && g.px[rr * g.w + cc] !== 254)
      return `벽·물건에서 ${CLEARANCE} m 안이라 시작할 수 없습니다 — 조금 떨어진 곳을 눌러 주세요.`;
  }
  return '';
}
/** 지형 저장(서버 terrains.py)이 만든 판인지 — 판에 지형 표시가 따로 없어 그 저장이 남기는 값 전부로 본다:
 *  SIMULATION·IMPORT·회전 0·해상도 0.05·그 저장의 reason 글. ponytail: reason 은 사람이 올릴 때 같은 글을 쓰면 속는다 — 서버가 판에 terrain_version 을 내주면 그걸로 바꿈 */
export const TERRAIN_REASON = '지형 저장으로 위에서 본 지도 자동 생성';
const terrainMade = (v: MapVersion) => v.provenance === 'SIMULATION' && v.source === 'IMPORT' && v.origin[2] === 0 && v.resolution === 0.05 && v.reason === TERRAIN_REASON;
/** 층(서버 지도) → 시뮬 어디서 열지(SIM-REAL-SPLIT «시뮬에서 실행»). 좌표가 같은 경우만 — 아니면 이유.
 *  · 지형 층(terrain_id): 시뮬 map=custom&terrain=<id>. 서버 terrain_grid = mobile/sim/terrain buildTerrain 격자(해상도 0.05·원점 −가로/2,−세로/2) — 실행 때 지형 크기로 다시 맞춘다
 *  · 시뮬 세계 층: topOf(v) = 판 사진 sha 가 시뮬 자산 사진이고 판 격자(원점·해상도·크기)가 그 자산 top.json 격자와 같을 때만(top.json 격자 = 시뮬 map.json 격자) */
export function simAt(f: MapFloor, v: MapVersion): { map: string; floor: string; terrain?: string } | string {
  if (f.terrain_id) return !/^[a-z0-9-]{1,32}$/.test(f.terrain_id) ? '지형 id 형식이 시뮬과 맞지 않습니다.'
    : terrainMade(v) ? { map: 'custom', floor: '', terrain: f.terrain_id }
    : '이 지도 판은 «지형 만들기» 저장으로 만든 판이 아닙니다(사람이 올리거나 고친 판) — 시뮬과 좌표가 같은지 알 수 없어 실행하지 않습니다. «지형 만들기»에서 다시 저장하세요.';
  const map = topOf(v) && SIM_TOP.get(v.image_sha256);
  if (!map) return '이 층은 시뮬 세계·지형과 이어져 있지 않아 시뮬에서 실행할 수 없습니다(지도 좌표가 시뮬과 같은지 확인되지 않음).';
  const fl = META[dir(map, 'top.json')]?.floors;
  return { map, floor: fl ? fl.find((x) => x.image_sha256 === v.image_sha256)?.id ?? '' : '' };
}
/** 열기 주소 — 위 약속 그대로 */
export const openUrl = (map: string, floor: string, start: [number, number] | null) =>
  simUrl(map) + (floor ? `&floor=${floor}` : '') + (start ? `&start=${start[0].toFixed(2)},${start[1].toFixed(2)}` : '');

function useGrid(key: string) {
  const [g, setG] = useState<{ key: string; grid: Grid } | null>(null);
  useEffect(() => {
    let live = true;
    GRID[key]?.().then((j) => { if (live) setG({ key, grid: { ...j, px: Uint8Array.from(atob(j.px), (c) => c.charCodeAt(0)) } }); }).catch(() => { /* 못 읽으면 누름만 막힘 */ });
    return () => { live = false; };
  }, [key]);
  return g?.key === key ? g.grid : null;
}

/** 시작 표시: 기본 = 빈 고리, 고른 곳 = 강조색 점. 화살 = 바라보는 방향(기본 시작 방향). 크기는 지도 크기에 비례 */
function Mark({ x, y, yaw, k, pick }: { x: number; y: number; yaw: number; k: number; pick?: boolean }) {
  const r = k * (pick ? 1 : 1.25), L = r * 2.6;
  return <g data-sim-mark={pick ? 'pick' : 'home'} pointerEvents="none">
    <line x1={x} y1={-y} x2={x + L * Math.cos(yaw)} y2={-(y + L * Math.sin(yaw))} stroke={pick ? 'var(--accent)' : '#FFFFFF'} strokeWidth={3} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    <circle cx={x} cy={-y} r={r} fill={pick ? 'var(--accent)' : 'rgba(8,11,14,.55)'} stroke={pick ? 'var(--on-accent)' : '#FFFFFF'} strokeWidth={pick ? 2 : 3} vectorEffect="non-scaling-stroke" />
  </g>;
}

/** 내장 시뮬 지도 카드(위에서 본 그림 + 이름) — 폰 앱 안 SimPick 만 쓴다(PC 시뮬 탭은 서버 SIM 장소만, 11-09). on = 고른 카드 */
function BuiltinCards({ open, on }: { open: (id: string) => void; on: string }) {
  return <ul className="dv-maps" aria-label="시뮬 지도">{SIM_MAPS.map((m) => {
    const src = PNG[dir(m.id, floorsOf(m.id)[0].top)];
    return <li key={m.id}><button type="button" className="dv-map-card" aria-pressed={m.id === on} onClick={() => open(m.id)} data-sim-card={m.id}>
      {src ? <img src={src} alt="" loading="lazy" draggable={false} /> : <i />}<span>{m.name}</span></button></li>;
  })}</ul>;
}

/** make = PC «시뮬» 탭: «지형 만들기» 입구를 보인다(폰 틀·앱 안은 숨김 — 저장본을 시뮬과 나눌 수 있는 곳만).
 *  옛 «임무 편집»은 아래 시뮬 시나리오(노드 보기)로 합쳤다 — 이 브라우저에 남은 옛 저장본은 수만 알린다 */
export function SimPick({ make }: { make?: boolean }) {
  const [old] = useState(() => (make ? oldMissions() : 0));
  const [want, setWant] = useState(savedMap), map = SIM_MAPS.find((m) => m.id === want) ?? SIM_MAPS[0];
  const meta = META[dir(map.id, 'top.json')], floors = floorsOf(map.id), [fid, setFid] = useState(''), floor = floors.find((f) => f.id === fid) ?? floors[0];
  const [start, setStart] = useState<[number, number] | null>(null), [why, setWhy] = useState('');
  const grid = useGrid(dir(map.id, floor.map_file)), top = PNG[dir(map.id, floor.top)], home = grid?.spawn_xyyaw;
  const reset = () => { setStart(null); setWhy(''); };
  const pickMap = (id: string) => { setWant(id); setFid(''); reset(); try { localStorage.setItem(MAP_KEY, id); } catch { /* 기억만 못 함 */ } };
  const press = (e: MouseEvent<SVGSVGElement>) => {
    if (!meta) return;
    // 주소에 실리는 값(소수 2자리)으로 먼저 확정 — 검사·표시·주소가 모두 시뮬이 받는 그 점(REVIEW-265 B1: 반올림 전 통과·후 벽 0.45 m 안)
    const p = toWorld(e.currentTarget.getBoundingClientRect(), meta.bounds, e.clientX, e.clientY).map((v) => +v.toFixed(2)) as [number, number];
    const no = grid ? blocked(grid, ...p) : '지도를 읽는 중입니다 — 잠시 뒤 다시 눌러 주세요.';
    setWhy(no);
    if (!no) setStart(p);
  };
  const [x0, y0, x1, y1] = meta?.bounds ?? [0, 0, 1, 1], k = Math.max(x1 - x0, y1 - y0) * 0.016;
  const acts = <>
    <button type="button" className="btn" disabled={!start} onClick={reset} data-sim-home>기본 위치로</button>
    {make && <a className="btn" href="#/terrain" style={{ textDecoration: 'none', color: 'var(--text)' }} data-terrain-enter>지형 만들기</a>}
    <a className="btn pri dv-grow" href={openUrl(map.id, floors.length > 1 ? floor.id : '', start)} style={{ textDecoration: 'none' }} data-sim-app>시뮬 열기</a>
  </>;
  return <>
    <BuiltinCards open={pickMap} on={map.id} />
    {floors.length > 1 && <div className="fh-row dv-floors" role="group" aria-label="층" data-sim-floor>{floors.map((f) =>
      <button key={f.id} type="button" className="btn" aria-pressed={f === floor} data-floor={f.id} onClick={() => { setFid(f.id); reset(); }}>{f.name}</button>)}</div>}
    {meta && top && <svg className="dv-start-map"viewBox={`${x0} ${-y1} ${x1 - x0} ${y1 - y0}`} role="img" aria-label={`${map.name}${floor.name && ` ${floor.name}`} 위에서 본 모습 — 눌러 시작 위치 고르기`} onClick={press} data-sim-top={floor.top}>
      <image href={top} x={x0} y={-y1} width={x1 - x0} height={y1 - y0} preserveAspectRatio="none" />
      {home && <Mark x={home[0]} y={home[1]} yaw={home[2]} k={k} />}
      {start && <Mark x={start[0]} y={start[1]} yaw={home?.[2] ?? 0} k={k} pick />}
    </svg>}
    <p className="lv-note" data-sim-start>{start ? `시작 위치: 고른 곳 (x ${start[0].toFixed(2)} m, y ${start[1].toFixed(2)} m) · 흰 고리 = 기본 시작 지점` : '시작 위치: 기본 시작 지점(흰 고리) — 지도를 눌러 바꿀 수 있습니다'}</p>
    {why && <p className="fh-why" role="status" data-sim-why>{why}</p>}
    <div className="fh-row">{acts}</div>
    {old > 0 && <p className="lv-note" data-old-bt>이 브라우저에만 있는 옛 임무 {old}개</p>}
  </>;
}
