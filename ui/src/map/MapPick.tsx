// 지도 보기 선택 — 화면만 바뀐다. 실제 Gazebo world·조종 상태 변경 0. op 는 map_list/map_get/map_live_get(읽기)뿐
// 저장 지도: 위치 마커 0(결속 없음). 실시간(/v2_map): 서버가 status·epoch·격자형상을 결속한 격자 + 같은 status 의 pose 만 마커로.
// 지도를 보는 동안 부르는 쪽은 GT 로봇·길·구역·경유점·탭 편집을 끈다(GT 좌표 ≠ 지도 좌표)
import { useEffect, useRef, useState } from 'react';
import type { LiveMap, MapInfo } from '@contracts';
import { getLive, getMap, listMaps, liveLabel, mapKey, mapLabel, type Raster } from '../data/maps';
import { useLink } from '../data/link';
import type { Robot } from './MapCanvas';
import { toast } from '../app/shell';

const LIVE = 'live';
const keyOf = (v: LiveMap) => [v.world_id, v.building_id, v.floor_id, v.mode, v.map_source, v.map_version, v.epoch].join('|');   // 서버 결속 키 K
type Bound = { r: Raster; k: string; seq: number; gen: number };   // 실시간 그림 + 받을 때의 K·seq·연결 세대

// on = 지도 보기 중(sel ≠ GT). 이때 부르는 쪽은 그림이 없어도 GT 로봇·길·구역·경유점·초안·탭 편집 0 + blank 이유를 그린다. GT 복귀는 사용자가 직접 고를 때만
export function useMapPick(overlay = true) {   // overlay=false: 서랍 안 등 흐름 배치(폰 — 지도 위 안내를 가리지 않게)
  const [maps, setMaps] = useState<MapInfo[] | string | null>(null), [sel, setSel] = useState(''), [saved, setSaved] = useState<Raster | null>(null);
  const [bound, setBound] = useState<Bound | null>(null), [lwhy, setLwhy] = useState(''), [serr, setSerr] = useState('');
  const selRef = useRef(''), linked = useLink((x) => x.open), gen = useLink((x) => x.gen), lv = useLink((x) => x.st?.live_map) || null;
  const fresh = useLink((x) => x.open && x.lastMsg > 0 && performance.now() - x.lastMsg < 1000);   // tick(500 ms)마다 다시 계산 — 수신 1 s 끊기면 false
  const load = () => { listMaps().then(setMaps); };
  useEffect(() => { if (linked && !Array.isArray(maps)) load(); }, [linked]);   // 연결되면 목록 한 번, 고를 때 다시

  // 실시간: 연결 끊김·수신 중단·세대 변경·st≠ok·K 또는 seq 변경이면 그림·마커 즉시 버림. 새 seq 면 다시 받음(≤1 Hz) — 받는 동안 빈 칸·마커 0(옛 그림 + 새 pose 조합 금지)
  const ok = lv?.st === 'ok', k = ok ? keyOf(lv!) : null, seq = ok ? lv!.grid!.seq : null;
  useEffect(() => {
    if (sel !== LIVE) return;
    if (!fresh || k == null || seq == null) { setBound(null); return; }
    if (bound && bound.k === k && bound.seq === seq && bound.gen === gen) return;
    let gone = false; const g0 = gen;
    getLive(lv!).then((r) => {   // getLive 의 마지막 await = image.decode — 그 뒤 연결 세대·K·seq·선택을 다시 대조
      const s = useLink.getState(), now = s.st?.live_map;
      if (gone || selRef.current !== LIVE || s.gen !== g0 || !s.open || now?.st !== 'ok' || now.grid?.seq !== seq || keyOf(now) !== k) return;
      if (typeof r === 'string') { setBound(null); setLwhy(r); } else { setBound({ r, k, seq, gen: g0 }); setLwhy(''); }
    });
    return () => { gone = true; };
  }, [sel, seq, k, fresh, gen]);

  const pick = async (key: string) => {
    selRef.current = key; setSel(key); setSaved(null); setBound(null); setLwhy(''); setSerr('');
    if (key === LIVE || !key) return;
    const m = Array.isArray(maps) ? maps.find((x) => mapKey(x) === key) : null; if (!m) return setSerr('목록에 없음 — 목록 다시 받기');
    const r = await getMap(m); if (selRef.current !== key) return;   // 그사이 다른 지도를 골랐으면 버림
    if (typeof r === 'string') { toast(`지도 · ${r}`); setSerr(r); } else setSaved(r);   // 실패해도 GT 로 자동 복귀 0 — 선택 유지 + 빈 칸 + 이유
  };
  const live = sel === LIVE, on = sel !== '';
  const showL = live && fresh && !!bound && bound.gen === gen && bound.k === k && bound.seq === seq;   // 그리는 순간에도 현재 lv·연결로 다시 결속 확인
  const raster = live ? (showL ? bound!.r : null) : saved;
  const p = showL ? lv?.pose : null;
  const pose: Robot = p ? { x: p.x, y: p.y, yaw: p.yaw, t: useLink.getState().lastMsg, fresh: true } : null;
  const note = !on ? '' : !live ? (saved ? '' : serr ? `저장 지도 미표시 · ${serr}` : '저장 지도 받는 중')
    : !fresh ? '연결 끊김·수신 중단 — 실시간 지도·위치 버림(조종 상태와 별개)'
    : !lv || lv.st === 'off' ? '실시간 지도 상태 없음 — 지도 체험이 켜지면 들어옵니다'
    : lv.st !== 'ok' ? `실시간 지도 미표시 · ${lv.why || lv.st}` : lwhy ? `실시간 지도 미표시 · ${lwhy}` : !raster ? '실시간 지도 받는 중'
    : `${liveLabel(lv)} · ${p ? `위치 ${p.source === 'slam_tf' ? 'SLAM 보정' : 'GT(지도와 같은 좌표)'}` : `위치 미표시 · ${lv.pose_why || '모름'}`}`;
  const blank = on && !raster ? (note || '지도 없음') : null;   // MapCanvas blank — 지도 보기 중 그림 없음
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
  const showLive = () => pick(LIVE);   // 지도 체험 시작 수락 뒤 «실시간 지도 보기»(화면만 — 시작·조종 0)
  return { raster, pickEl: el, pose, live, on, blank, showLive, reload: load };
}
