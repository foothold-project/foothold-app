// 저장 지도(서버 관리, 읽기만) — docs/CONTRACT-maps-sim-stop.md. 보기 선택은 화면만 바꾼다: 실제 Gazebo world·조종 상태 변경 0
import type { MapInfo } from '@contracts';
import { ask } from './link';

export type Raster = { img: CanvasImageSource; res: number; ox: number; oy: number; w: number; h: number; label: string };
const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const WORLD = { v5_single: 'v5 단층', v5_building: 'v5 건물', rooms_a: '새 방 지형' } as const;
const FLOOR = { f1: '1층', l1: '1층', l2: '2층' } as const;
const WF: Record<string, readonly string[]> = { v5_single: ['f1'], v5_building: ['l1', 'l2'], rooms_a: ['f1'] };   // world 마다 층(RL worlds.json)
const BLD = { v5_single: 'v5_single', v5_building: 'v5', rooms_a: 'rooms_a' } as const;   // world 마다 건물 키 따로(서버 MAP_WORLDS)
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
