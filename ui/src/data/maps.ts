// 저장 지도(서버 관리, 읽기만) — docs/CONTRACT-maps-sim-stop.md. 보기 선택은 화면만 바꾼다: 실제 Gazebo world·조종 상태 변경 0
import type { LiveMap, MapInfo } from '@contracts';
import { ask } from './link';

export type Raster = { img: CanvasImageSource; res: number; ox: number; oy: number; w: number; h: number; label: string };
const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
export const WORLD = { v5_single: 'v5 단층', v5_building: 'v5 건물', rooms_a: '새 방 지형' } as const;
export const FLOOR = { f1: '1층', l1: '1층', l2: '2층' } as const;
export const WF: Record<string, readonly string[]> = { v5_single: ['f1'], v5_building: ['l1', 'l2'], rooms_a: ['f1'] };   // world 마다 층(RL worlds.json)
export const BLD = { v5_single: 'v5_single', v5_building: 'v5', rooms_a: 'rooms_a' } as const;   // world 마다 건물 키 따로(서버 MAP_WORLDS)
const SAME = ['world_id', 'building_id', 'floor_id', 'map_version', 'epoch', 'map_source'] as const;

/** 서버 답의 meta 가 화면이 쓰는 형식인지. 아니면 그 지도는 안 보여 준다 */
export function okInfo(m: any): m is MapInfo {
  return !!m && typeof m === 'object' && typeof m.world_id === 'string' && typeof m.floor_id === 'string' && Object.prototype.hasOwnProperty.call(WORLD, m.world_id) && m.building_id === BLD[m.world_id as keyof typeof WORLD] && Object.prototype.hasOwnProperty.call(FLOOR, m.floor_id) && WF[m.world_id].includes(m.floor_id)
    && typeof m.map_version === 'string' && ((m.map_source === 'slam' && Number.isInteger(m.epoch) && m.epoch >= 1) || (m.map_source === 'gt_raster' && m.epoch === null))
    && fin(m.resolution) && m.resolution > 0 && Array.isArray(m.origin) && m.origin.length === 3 && m.origin.every(fin)
    && [m.width, m.height].every((n) => Number.isInteger(n) && n >= 1 && n <= 2000);
}
export const mapKey = (m: MapInfo) => `${m.building_id}/${m.floor_id}/${m.map_version}`;
export const mapLabel = (m: MapInfo) => `${WORLD[m.world_id]} ${FLOOR[m.floor_id]} · ${m.map_source === 'gt_raster' ? 'GT 기하 지도(SLAM 아님)' : 'SLAM 저장 지도'} · ${m.map_version}`;

export async function listMaps(): Promise<MapInfo[] | string> {
  const r = await ask('map_list');
  if (!r.ok) return r.text || '지도 목록 실패';
  return Array.isArray(r.maps) ? r.maps.filter(okInfo) : '지도 목록 형식 이상';
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

// ── 실시간 지도(/v2_map/map → 서버가 status·epoch·격자형상 결속 검사 후 PNG) — 서버 view.st==='ok' 일 때만 받는다
export const liveLabel = (v: LiveMap) => v.world_id && v.floor_id
  ? `실시간 · ${WORLD[v.world_id]} ${FLOOR[v.floor_id]} · ${v.map_source === 'gt_raster' ? 'GT 기하 지도(SLAM 아님)' : 'SLAM 지도'} · epoch ${v.epoch}`
  : '실시간 지도';

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
