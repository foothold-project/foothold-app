// 저장 지도(서버 관리, 읽기만) — docs/CONTRACT-maps-sim-stop.md. 보기 선택은 화면만 바꾼다: 실제 Gazebo world·조종 상태 변경 0
import type { LiveMap, MapInfo } from '@contracts';
import { ask, useLink } from './link';

export type Raster = { img: CanvasImageSource; res: number; ox: number; oy: number; w: number; h: number; label: string; noGrid?: boolean };   // noGrid: 좌표가 하나가 아닌 그림(층 나란히) — 격자 안 그림
const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
export const WORLD = { v5_single: '1층 건물', v5_building: '2층 건물', rooms_a: '새 매핑 공간' } as const;   // 화면 이름만(계약 id 그대로)
export const FLOOR = { f1: '1층', l1: '1층', l2: '2층' } as const;
export const WF: Record<string, readonly string[]> = { v5_single: ['f1'], v5_building: ['l1', 'l2'], rooms_a: ['f1'] };   // world 마다 층(RL worlds.json)
export const BLD = { v5_single: 'v5_single', v5_building: 'v5', rooms_a: 'rooms_a' } as const;   // world 마다 건물 키 따로(서버 MAP_WORLDS)
/** 지형·층 화면 이름: 층이 하나뿐인 지형은 지형 이름만(«1층 건물»), 2층 건물만 «2층 건물 · 1층». 모르는 id 는 id 그대로 */
export const place = (w: string | null | undefined, f: string | null | undefined) => {
  const W = (WORLD as Record<string, string>)[w || ''], F = (FLOOR as Record<string, string>)[f || ''];
  return !W ? `${w || '?'}/${f || '?'}` : (WF[w!]?.length || 0) > 1 ? `${W} · ${F || f}` : W;
};
const SAME = ['world_id', 'building_id', 'floor_id', 'map_version', 'epoch', 'map_source'] as const;

/** 서버 답의 meta 가 화면이 쓰는 형식인지. 아니면 그 지도는 안 보여 준다 */
export function okInfo(m: any): m is MapInfo {
  return !!m && typeof m === 'object' && typeof m.world_id === 'string' && typeof m.floor_id === 'string' && Object.prototype.hasOwnProperty.call(WORLD, m.world_id) && m.building_id === BLD[m.world_id as keyof typeof WORLD] && Object.prototype.hasOwnProperty.call(FLOOR, m.floor_id) && WF[m.world_id].includes(m.floor_id)
    && typeof m.map_version === 'string' && ((m.map_source === 'slam' && Number.isInteger(m.epoch) && m.epoch >= 1) || (m.map_source === 'gt_raster' && m.epoch === null))
    && fin(m.resolution) && m.resolution > 0 && Array.isArray(m.origin) && m.origin.length === 3 && m.origin.every(fin)
    && [m.width, m.height].every((n) => Number.isInteger(n) && n >= 1 && n <= 2000);
}
/** 보기 선택 계층: 지형 → (2층 건물만) 층 → 버전. 지형 순서는 WORLD, 층은 WF, 버전은 받은 순서 */
export const groupMaps = (ms: MapInfo[]) => (Object.keys(WORLD) as (keyof typeof WORLD)[]).map((w) => ({ w, label: WORLD[w],
  items: WF[w].flatMap((f) => ms.filter((m) => m.world_id === w && m.floor_id === f)) })).filter((g) => g.items.length);
/** 건물 «층 나란히 보기»(GT 기하 2D만 · 보기 전용 · 전체 3D 아님) 선택 키. 저장본 키(건물/층/버전)와 겹치지 않게 접두 all: */
export const allKey = (w: string) => `all:${w}`;
/** 층 나란히 보기에 쓸 층별 GT 지도 — 층마다 GT 1장(목록 첫 GT), 모든 층이 같은 원점·해상도·크기일 때만. 아니면 이유.
 *  ponytail: 층마다 GT 버전이 여럿이면 첫 것만 — 버전 고르기는 GT 버전이 둘 이상 생기면 추가 */
export function gtFloors(ms: MapInfo[], w: string): MapInfo[] | string {
  const fl = WF[w] || [], gs = fl.map((f) => ms.find((m) => m.world_id === w && m.floor_id === f && m.map_source === 'gt_raster'));
  if (fl.length < 2) return '층이 하나뿐 — 층 나란히 보기 없음';
  const miss = fl.filter((_, i) => !gs[i]); if (miss.length) return `GT 기하 지도 없는 층: ${miss.map((f) => FLOOR[f as keyof typeof FLOOR] || f).join('·')}`;
  const a = gs[0]!;
  if (gs.some((m) => m!.resolution !== a.resolution || m!.width !== a.width || m!.height !== a.height || m!.origin.some((x, i) => x !== a.origin[i]))) return '층 GT 지도의 원점·해상도·크기가 달라 나란히 못 그림';
  return gs as MapInfo[];
}
export const verLabel =(m: MapInfo) => `${(WF[m.world_id]?.length || 0) > 1 ? `${FLOOR[m.floor_id as keyof typeof FLOOR]} · ` : ''}${m.map_source === 'gt_raster' ? 'GT 기하 지도(SLAM 아님)' : 'SLAM 저장 지도'} · ${m.map_version}`;
export const mapKey = (m: MapInfo) => `${m.building_id}/${m.floor_id}/${m.map_version}`;
export const mapLabel = (m: MapInfo) => `${place(m.world_id, m.floor_id)} · ${m.map_source === 'gt_raster' ? 'GT 기하 지도(SLAM 아님)' : 'SLAM 저장 지도'} · ${m.map_version}`;

/** 층별 GT 그림을 위(높은 층)→아래로 쌓은 보기 전용 그림 한 장. 층 사이 띠 + 층 이름. 좌표 하나로 못 읽음 → noGrid·위치 마커 0 */
export function stackFloors(rs: Raster[], names: string[], label: string): Raster {
  const a = rs[0], gap = Math.round(a.h * 0.06), c = document.createElement('canvas');
  c.width = a.w; c.height = rs.length * a.h + (rs.length - 1) * gap; const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, c.width, c.height);   // 띠 = 흰색(어두운 테마에선 반전돼 어둡게 — 지도 그림과 같은 처리)
  const fs = Math.max(14, Math.round(a.h * 0.045));
  [...rs].reverse().forEach((r, i) => {   // rs 는 아래층부터 → 그림은 위층이 위
    const y = i * (a.h + gap); g.drawImage(r.img, 0, y, a.w, a.h);
    const t = names[rs.length - 1 - i]; g.font = `700 ${fs}px sans-serif`;
    const tw = g.measureText(t).width; g.fillStyle = '#ffffff'; g.fillRect(4, y + 4, tw + 12, fs + 10); g.fillStyle = '#000000'; g.fillText(t, 10, y + fs + 6);
  });
  return { img: c, res: a.res, ox: a.ox, oy: a.oy, w: c.width, h: c.height, label, noGrid: true };
}

export async function listMaps(): Promise<MapInfo[] | string> {
  const r = await ask('map_list');
  if (!r.ok) return r.text || '지도 목록 실패';
  return Array.isArray(r.maps) ? r.maps.filter(okInfo) : '지도 목록 형식 이상';
}

/** 화면 한 곳의 목록 조회 순번. n: 마지막 요청 번호(부르는 쪽이 세대 변경·화면 닫힘 때 n++ 로 걸린 요청 무효) · busy: 진행 중 요청의 연결 세대 */
export type ListSeq = { n: number; busy: number | null };
/** 목록 1회 조회. 이 연결에서 유효 status 를 받기 전·같은 세대 요청이 진행 중이면 안 보냄(link 는 연결마다 지도 요청 하나 — 겹치면 «처리 중» 거절).
 *  결과는 보낼 때의 연결 세대·대상이 그대로이고 이 요청이 최신일 때만 채택 — 늦은 성공·실패 모두 새 결과를 덮지 않음. 자동 재시도 0 */
export function loadList(q: ListSeq, set: (v: MapInfo[] | string) => void, get = listMaps): boolean {
  const s = useLink.getState();
  if (!s.open || s.stGen !== s.gen || q.busy === s.gen) return false;
  const n = ++q.n, g0 = s.gen, p0 = s.provider; q.busy = g0;
  get().then((v) => { if (q.busy === g0) q.busy = null; const t = useLink.getState(); if (q.n === n && t.gen === g0 && t.provider === p0) set(v); });
  return true;
}

/** 한 장 받아 그림으로. 이름·크기·출처가 요청과 다르면 버린다(늦게 온 다른 지도 포함) */
export async function getMap(m: MapInfo): Promise<Raster | string> {
  const r = await ask('map_get', { building_id: m.building_id, floor_id: m.floor_id, map_version: m.map_version });
  if (!r.ok) return r.text || '지도 받기 실패';
  const d = r.map as any, png: unknown = d?.png;
  if (!okInfo(d) || SAME.some((k) => d[k] !== m[k]) || typeof png !== 'string') return '지도 형식 이상';
  if (d.origin[2] !== 0) return '회전된 지도 원점은 아직 그리지 않음';
  const img = new Image(); img.src = `data:image/png;base64,${png}`;
  try { await img.decode(); } catch { return 'PNG 풀기 실패'; }
  if (img.naturalWidth !== d.width || img.naturalHeight !== d.height) return 'PNG 크기가 meta 와 다름';
  return { img, res: d.resolution, ox: d.origin[0], oy: d.origin[1], w: d.width, h: d.height, label: mapLabel(d) };
}

// ── GT 높이 레이어(op height_get, RL HEIGHT-CONTRACT v2_map_height/1) — 저장 GT 지도 위에만. 센서 측정 아님·이동가능/위험 판정 아님
// PNG = RGB8 R=hi·G=lo(16비트 v), 0 = 모름, 층 기준 m = (v-1)/1000 - 1. 색 공간 변환 끔(createImageBitmap colorSpaceConversion none)
export type HeightInfo = { lo: number; hi: number; floor_z: number; unknown: number; band: [number, number] };
export const hHue = (t: number) => Math.round(220 - Math.max(0, Math.min(1, t)) * 200);   // 낮음 파랑 → 높음 빨강(범례와 같은 식)
/** 화소 하나: v(0=모름) → 층 기준 m | null */
export const relM = (hi8: number, lo8: number) => { const v = (hi8 << 8) | lo8; return v === 0 ? null : (v - 1) / 1000 - 1; };
/** still(): 디코드 뒤 «아직 같은 선택·연결 세대·시뮬 대상인가» — 아니면 그리지 않고 버림 */
export async function getHeight(m: MapInfo, base: Raster, still: () => boolean): Promise<{ r: Raster; h: HeightInfo } | string> {
  if (m.map_source !== 'gt_raster') return '높이 레이어는 GT 기하 지도에만(SLAM 저장본은 높이 없음)';
  const r = await ask('height_get', { building_id: m.building_id, floor_id: m.floor_id, map_version: m.map_version });
  if (!r.ok) return r.text || '높이 받기 실패';
  const d = (r as any).height;
  if (!d || d.building_id !== m.building_id || d.floor_id !== m.floor_id || d.map_version !== m.map_version || d.width !== base.w || d.height !== base.h
      || d.width !== m.width || d.height !== m.height || d.resolution !== m.resolution || d.resolution !== base.res || !Array.isArray(d.origin) || d.origin.length !== 3
      || d.origin.some((x: unknown, i: number) => x !== m.origin[i]) || d.origin[0] !== base.ox || d.origin[1] !== base.oy || d.height_source !== 'gt_geometry'
      || d.sensor !== false || !(d.band_rel_m?.[0] < d.band_rel_m?.[1]) || !fin(d.floor_z) || !fin(d.rel_min) || !fin(d.rel_max) || !Array.isArray(d.band_rel_m) || !d.band_rel_m.every(fin) || typeof d.png !== 'string') return '높이 형식 이상(다른 지도·크기)';
  let bm: ImageBitmap | null = null;
  try {
    try { bm = await createImageBitmap(await (await fetch(`data:image/png;base64,${d.png}`)).blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' }); } catch { return '높이 PNG 풀기 실패'; }
    if (!still()) return '선택·연결이 바뀜 — 늦은 높이 버림';
    if (bm.width !== base.w || bm.height !== base.h) return '높이 PNG 크기가 지도와 다름';
    return paint(bm, base, d);
  } finally { bm?.close(); }   // 모든 종료 경로에서 해제
}
function paint(bm: ImageBitmap, base: Raster, d: any): { r: Raster; h: HeightInfo } {
  const c = document.createElement('canvas'); c.width = base.w; c.height = base.h; const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(bm, 0, 0); const hp = g.getImageData(0, 0, base.w, base.h).data;
  g.clearRect(0, 0, base.w, base.h); g.drawImage(base.img, 0, 0); const out = g.getImageData(0, 0, base.w, base.h), o = out.data;
  const lo = Math.min(d.band_rel_m[0], d.rel_min), hi = Math.max(d.band_rel_m[1], d.rel_max) > lo ? Math.max(d.band_rel_m[1], d.rel_max) : lo + 1;
  let unknown = 0;
  for (let i = 0; i < o.length; i += 4) {
    const z = relM(hp[i], hp[i + 1]);
    if (z === null) { unknown++; continue; }                  // 모름 = 회색 지도 그대로(가짜 높이 0)
    const [R, G, B] = hsl(hHue((z - lo) / (hi - lo)) / 360, 0.75, 0.5);
    o[i] = R; o[i + 1] = G; o[i + 2] = B; o[i + 3] = 255;
  }
  g.putImageData(out, 0, 0);
  return { r: { ...base, img: c, label: `${base.label} · 높이색(GT 기하)` }, h: { lo, hi, floor_z: d.floor_z, unknown, band: [d.band_rel_m[0], d.band_rel_m[1]] } };
}
function hsl(h: number, s: number, l: number): [number, number, number] {
  const f = (n: number) => { const k = (n + h * 12) % 12, a = s * Math.min(l, 1 - l); return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
  return [f(0), f(8), f(4)];
}

// ── 실시간 지도(/v2_map/map → 서버가 status·epoch·격자형상 결속 검사 후 PNG) — 서버 view.st==='ok' 일 때만 받는다
export const liveLabel = (v: LiveMap) => v.world_id && v.floor_id   // epoch 등 기술 원값은 «지도 열기» 상태 상세·서버 상태에만
  ? `현재 열린 지도 · ${place(v.world_id, v.floor_id)} · ${v.map_source === 'gt_raster' ? 'GT 기하 지도(SLAM 아님)' : 'SLAM 실시간 매핑'}`
  : '현재 열린 지도';
/** 지금 실제로 켜진 시뮬(서버 map_start.session) 한 줄 — 지형·층·작업·상태. 고른 것과 별개 */
export type Sess = { result?: string; runner?: string; world_id?: string; floor_id?: string; map_mode?: string; remaining_s?: number } | null | undefined;
export const TASK = { slam: 'SLAM 지도 만들기', static: '저장 지도로 시뮬 열기(SLAM 생성 없음)' } as const;
export const runLine = (ss: Sess) => !ss ? '꺼짐 · 지도용 시뮬 없음(또는 상태 미확인)' : ss.runner === 'live_map'
  ? `${place(ss.world_id, ss.floor_id)} · ${ss.map_mode === 'slam' ? TASK.slam : ss.map_mode === 'static' ? TASK.static : '작업 미확인'} · ${ss.result === 'starting' ? '시작 중' : ss.result === 'running' ? '실행 중' : ss.result || '상태 미확인'}${typeof ss.remaining_s === 'number' ? ` · 남은 ${Math.max(0, Math.round(ss.remaining_s / 60))}분` : ''}`
  : ss.runner === 'ux_flat' || ss.runner === 'live_v2' ? `평지 시뮬(지도·라이다 없음) · ${ss.result || '상태 미확인'}` : `꺼짐 · ${ss.result || '상태 미확인'}`;
/** 지도 시뮬이 켜져(시작 중·실행 중) 있으면 그 [건물 키, 층], 아니면 null */
export const runAt = (ss: Sess) => ss?.runner === 'live_map' && (ss.result === 'running' || ss.result === 'starting') && ss.world_id && ss.floor_id
  ? [(BLD as Record<string, string>)[ss.world_id] || ss.world_id, ss.floor_id] as const : null;

/** 지금 보이는 격자 한 장. 답의 seq·epoch·world·floor 가 요청 때 view 와 같아야(늦게 온 옛 epoch 버림) */
export async function getLive(v: LiveMap): Promise<Raster | string> {
  const g = v.grid; if (v.st !== 'ok' || !g) return v.why || '실시간 지도 없음';
  const r = await ask('map_live_get');
  if (!r.ok) return r.text || '실시간 지도 받기 실패';
  const d = r.live as any;
  if (!d || d.seq !== g.seq || d.epoch !== v.epoch || d.world_id !== v.world_id || d.floor_id !== v.floor_id || typeof d.png !== 'string') return '실시간 지도가 그새 바뀜';
  if (!(g.res > 0) || g.origin.length < 2 || !g.origin.every(fin)) return '실시간 격자 형식 이상';
  const img = new Image(); img.src = `data:image/png;base64,${d.png}`;
  try { await img.decode(); } catch { return 'PNG 풀기 실패'; }
  if (img.naturalWidth !== g.w || img.naturalHeight !== g.h) return 'PNG 크기가 격자와 다름';
  return { img, res: g.res, ox: g.origin[0], oy: g.origin[1], w: g.w, h: g.h, label: liveLabel(v) };
}
