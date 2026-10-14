// 지도 보기 선택 — 화면만 바뀐다. 실제 Gazebo world·조종 상태 변경 0. op 는 map_list/map_get/map_live_get(읽기)뿐
// 저장 지도: 위치 마커 0(결속 없음). 실시간(/v2_map): 서버가 status·epoch·격자형상을 결속한 격자 + 같은 status 의 pose 만 마커로.
// 지도를 보는 동안 부르는 쪽은 GT 로봇·길·구역·경유점·탭 편집을 끈다(GT 좌표 ≠ 지도 좌표)
import { useEffect, useRef, useState } from 'react';
import type { MapInfo } from '@contracts';
import { getLive, getMap, listMaps, liveLabel, mapKey, mapLabel, type Raster } from '../data/maps';
import { useLink } from '../data/link';
import type { Robot } from './MapCanvas';
import { toast } from '../app/shell';

const LIVE = 'live';

export function useMapPick(overlay = true) {   // overlay=false: 서랍 안 등 흐름 배치(폰 — 지도 위 안내를 가리지 않게)
  const [maps, setMaps] = useState<MapInfo[] | string | null>(null), [sel, setSel] = useState(''), [raster, setRaster] = useState<Raster | null>(null);
  const selRef = useRef(''), linked = useLink((x) => x.open), lv = useLink((x) => x.st?.live_map) || null;
  const [lwhy, setLwhy] = useState('');
  const load = () => { listMaps().then(setMaps); };
  useEffect(() => { if (linked && !Array.isArray(maps)) load(); }, [linked]);   // 연결되면 목록 한 번, 고를 때 다시

  // 실시간: 서버 st 가 ok 가 아니게 되면(끊김·RESET·epoch 변경·형식 모름) 그림 즉시 버림. 새 seq 면 다시 받음(≤1 Hz)
  const seq = lv?.st === 'ok' ? lv.grid?.seq ?? null : null, ep = lv?.epoch ?? null;
  useEffect(() => {
    if (sel !== LIVE) return;
    if (seq == null) { setRaster(null); return; }
    let gone = false;
    getLive(lv!).then((r) => {
      const now = useLink.getState().st?.live_map;   // 받는 사이 seq·epoch 가 바뀌었으면 버림(다음 seq 로 다시 받음)
      if (gone || selRef.current !== LIVE || now?.st !== 'ok' || now.grid?.seq !== seq || now.epoch !== ep) return;
      if (typeof r === 'string') { setRaster(null); setLwhy(r); } else { setRaster(r); setLwhy(''); }
    });
    return () => { gone = true; };
  }, [sel, seq, ep]);

  const pick = async (key: string) => {
    selRef.current = key; setSel(key); setRaster(null); setLwhy('');
    if (key === LIVE) return;
    const m = Array.isArray(maps) ? maps.find((x) => mapKey(x) === key) : null; if (!m) return;
    const r = await getMap(m); if (selRef.current !== key) return;   // 그사이 다른 지도를 골랐으면 버림
    if (typeof r === 'string') { toast(`지도 · ${r}`); selRef.current = ''; setSel(''); } else setRaster(r);
  };
  const live = sel === LIVE, p = live && raster ? lv?.pose : null;
  const pose: Robot = p ? { x: p.x, y: p.y, yaw: p.yaw, t: performance.now(), fresh: true } : null;
  const note = !live ? '' : !lv || lv.st === 'off' ? '실시간 지도 상태 없음 — 지도 체험이 켜지면 들어옵니다'
    : lv.st !== 'ok' ? `실시간 지도 미표시 · ${lv.why || lv.st}` : lwhy ? `실시간 지도 미표시 · ${lwhy}`
    : `${liveLabel(lv)} · ${p ? `위치 ${p.source === 'slam_tf' ? 'SLAM 보정' : 'GT(지도와 같은 좌표)'}` : `위치 미표시 · ${lv.pose_why || '모름'}`}`;
  const sty: React.CSSProperties = overlay ? { position: 'absolute', top: 8, left: 8, zIndex: 2, maxWidth: 'calc(100% - 80px)' } : { width: '100%' };
  const el = <span style={{ ...sty, display: 'flex', flexDirection: 'column', gap: 4 }}>
    <select aria-label="지도 보기 선택(보기만 · 실제 world 안 바뀜)" title="지도 보기 선택 — 화면만 바뀝니다. 실제 Gazebo 지형·조종은 그대로" value={sel}
      onFocus={load} onChange={(e) => pick(e.target.value)}
      style={{ minHeight: overlay ? 32 : 44, font: 'inherit', fontSize: 12, background: 'var(--bg)', color: 'var(--fg, inherit)', border: '1px solid var(--line2)', borderRadius: 6 }}>
      <option value="">실행 중 시뮬 바닥 · GT 위치</option>
      <option value={LIVE}>실시간 지도(/v2_map)</option>
      {Array.isArray(maps) && maps.map((m) => <option key={mapKey(m)} value={mapKey(m)}>{mapLabel(m)}</option>)}
      {typeof maps === 'string' && <option disabled value="-">{`저장 지도 목록 · ${maps}`}</option>}
      {Array.isArray(maps) && !maps.length && <option disabled value="-">저장 지도 없음</option>}
    </select>
    {note && <span role="status" style={{ fontSize: 11, padding: '2px 6px', borderRadius: 4, background: 'var(--bg)', color: `var(--${raster ? 'muted' : 'warn'})` }}>{note}</span>}
  </span>;
  return { raster, pickEl: el, pose, live, reload: load };
}
