// 지도 보기 선택(저장 지도) — 화면만 바뀐다. 실제 Gazebo world·조종 상태 변경 0. op 는 map_list/map_get(읽기)뿐
// 저장 지도를 보는 동안 부르는 쪽은 로봇·길·구역·경유점·탭 편집을 끈다(좌표계 결속 확인 전)
import { useEffect, useRef, useState } from 'react';
import type { MapInfo } from '@contracts';
import { getMap, listMaps, mapKey, mapLabel, type Raster } from '../data/maps';
import { useLink } from '../data/link';
import { toast } from '../app/shell';

export function useMapPick(overlay = true) {   // overlay=false: 서랍 안 등 흐름 배치(폰 — 지도 위 안내를 가리지 않게)
  const [maps, setMaps] = useState<MapInfo[] | string | null>(null), [sel, setSel] = useState(''), [raster, setRaster] = useState<Raster | null>(null);
  const selRef = useRef(''), linked = useLink((x) => x.open);
  const load = () => { listMaps().then(setMaps); };
  useEffect(() => { if (linked && !Array.isArray(maps)) load(); }, [linked]);   // 연결되면 목록 한 번, 고를 때 다시
  const pick = async (key: string) => {
    selRef.current = key; setSel(key); setRaster(null);
    const m = Array.isArray(maps) ? maps.find((x) => mapKey(x) === key) : null; if (!m) return;
    const r = await getMap(m); if (selRef.current !== key) return;   // 그사이 다른 지도를 골랐으면 버림
    if (typeof r === 'string') { toast(`지도 · ${r}`); selRef.current = ''; setSel(''); } else setRaster(r);
  };
  const el = <select aria-label="지도 보기 선택(보기만 · 실제 world 안 바뀜)" title="지도 보기 선택 — 화면만 바뀝니다. 실제 Gazebo 지형·조종은 그대로" value={sel}
    onFocus={load} onChange={(e) => pick(e.target.value)}
    style={{ ...(overlay ? { position: 'absolute', top: 8, left: 8, zIndex: 2, maxWidth: 'calc(100% - 80px)' } : { width: '100%' }), minHeight: overlay ? 32 : 44, font: 'inherit', fontSize: 12, background: 'var(--bg)', color: 'var(--fg, inherit)', border: '1px solid var(--line2)', borderRadius: 6 }}>
    <option value="">실행 중 시뮬 바닥 · GT 위치</option>
    {Array.isArray(maps) && maps.map((m) => <option key={mapKey(m)} value={mapKey(m)}>{mapLabel(m)}</option>)}
    {typeof maps === 'string' && <option disabled value="-">{`저장 지도 목록 · ${maps}`}</option>}
    {Array.isArray(maps) && !maps.length && <option disabled value="-">저장 지도 없음</option>}
  </select>;
  return { raster, pickEl: el };
}
