// 지도 보기 선택 — 화면만 바뀐다. 실제 Gazebo world·조종 상태 변경 0. op 는 map_list/map_get/map_live_get(읽기)뿐
// 저장 지도: 위치 마커 0(결속 없음). 실시간(/v2_map): 서버가 status·epoch·격자형상을 결속한 격자 + 같은 status 의 pose 만 마커로.
// 지도를 보는 동안 부르는 쪽은 GT 로봇·길·구역·경유점·탭 편집을 끈다(GT 좌표 ≠ 지도 좌표)
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import type { LiveMap, MapInfo } from '@contracts';
import { getHeight, getLive, getMap, groupMaps, hHue, listMaps, liveLabel, mapKey, place, verLabel, runAt, runLine, type HeightInfo, type Raster, type Sess } from '../data/maps';
import { useLink } from '../data/link';
import type { Robot } from './MapCanvas';
import { toast } from '../app/shell';

const LIVE = 'live';
const keyOf = (v: LiveMap) => [v.world_id, v.building_id, v.floor_id, v.mode, v.map_source, v.map_version, v.epoch].join('|');   // 서버 결속 키 K
type Bound = { r: Raster; k: string; seq: number; gen: number };   // 실시간 그림 + 받을 때의 K·seq·연결 세대

// 선택은 화면들이 공유(관제·조종·지도 화면을 오가도 사용자가 고른 것 유지). touched = 사용자가 한 번이라도 직접 고름 → 그 뒤 자동 선택 0
const usePick = create<{ sel: string; touched: boolean; auto: boolean }>(() => ({ sel: '', touched: false, auto: false }));
// on = 지도 보기 중(sel ≠ GT). 이때 부르는 쪽은 그림이 없어도 GT 로봇·길·구역·경유점·초안·탭 편집 0 + blank 이유를 그린다. GT 복귀는 사용자가 직접 고를 때만
export function useMapPick(overlay = true) {   // overlay=false: 서랍 안 등 흐름 배치(폰 — 지도 위 안내를 가리지 않게)
  const [maps, setMaps] = useState<MapInfo[] | string | null>(null), [saved, setSaved] = useState<Raster | null>(null);
  const { sel, touched, auto } = usePick();
  const [bound, setBound] = useState<Bound | null>(null), [lwhy, setLwhy] = useState(''), [serr, setSerr] = useState('');
  const [hOn, setHOn] = useState(false), [hr, setHr] = useState<{ key: string; gen: number; r: Raster; h: HeightInfo } | string | null>(null);   // 높이색: 보기 선택마다 끔 · 연결 세대 결속
  const linked = useLink((x) => x.open), gen = useLink((x) => x.gen), lv = useLink((x) => x.st?.live_map) || null;
  const fresh = useLink((x) => x.open && x.lastMsg > 0 && performance.now() - x.lastMsg < 1000);   // tick(500 ms)마다 다시 계산 — 수신 1 s 끊기면 false
  const load = () => { listMaps().then(setMaps); };
  useEffect(() => { if (linked && !Array.isArray(maps)) load(); }, [linked]);   // 연결되면 목록 한 번, 고를 때 다시

  // 자동 실시간(앱 Codex 10-14): 사용자가 아직 안 골랐고 지금 지도 세션(live_map off·stale 아님)이 보일 때 한 번만 실시간으로.
  // 그 뒤로는 일반 선택과 같다 — 끊기면 빈 지도 + 이유(GT 자동 복귀 0). 사용자가 고른 GT·저장본은 빼앗지 않음
  const seen = !!lv && lv.st !== 'off' && lv.st !== 'stale';
  useEffect(() => { if (!touched && sel === '' && seen && fresh) usePick.setState({ sel: LIVE, auto: true }); }, [seen, fresh, sel, touched]);
  // 실시간: 연결 끊김·수신 중단·세대 변경·st≠ok·K 또는 seq 변경이면 그림·마커 즉시 버림. 새 seq 면 다시 받음(≤1 Hz) — 받는 동안 빈 칸·마커 0(옛 그림 + 새 pose 조합 금지)
  const ok = lv?.st === 'ok', k = ok ? keyOf(lv!) : null, seq = ok ? lv!.grid!.seq : null;
  useEffect(() => {
    if (sel !== LIVE) return;
    if (!fresh || k == null || seq == null) { setBound(null); return; }
    if (bound && bound.k === k && bound.seq === seq && bound.gen === gen) return;
    let gone = false; const g0 = gen;
    getLive(lv!).then((r) => {   // getLive 의 마지막 await = image.decode — 그 뒤 연결 세대·K·seq·선택을 다시 대조
      const s = useLink.getState(), now = s.st?.live_map;
      if (gone || usePick.getState().sel !== LIVE || s.gen !== g0 || !s.open || now?.st !== 'ok' || now.grid?.seq !== seq || keyOf(now) !== k) return;
      if (typeof r === 'string') { setBound(null); setLwhy(r); } else { setBound({ r, k, seq, gen: g0 }); setLwhy(''); }
    });
    return () => { gone = true; };
  }, [sel, seq, k, fresh, gen]);

  const loadSaved = async (key: string, list: MapInfo[] | string | null) => {
    const m = Array.isArray(list) ? list.find((x) => mapKey(x) === key) : null; if (!m) return setSerr(Array.isArray(list) ? '목록에 없음 — 목록 다시 받기' : '저장 지도 목록 받는 중');
    const r = await getMap(m); if (usePick.getState().sel !== key) return;   // 그사이 다른 지도를 골랐으면 버림
    if (typeof r === 'string') { toast(`지도 · ${r}`); setSerr(r); } else { setSaved(r); setSerr(''); }   // 실패해도 GT 로 자동 복귀 0 — 선택 유지 + 빈 칸 + 이유
  };
  const pick = (key: string) => {
    usePick.setState({ sel: key, touched: true, auto: false }); setSaved(null); setHOn(false); setHr(null); setBound(null); setLwhy(''); setSerr('');
    if (key !== LIVE && key) loadSaved(key, maps);
  };
  // 다른 화면에서 고른 저장 지도로 이 화면이 열림 → 목록이 오면 이 화면도 받아 그림
  useEffect(() => { if (sel && sel !== LIVE && !saved && Array.isArray(maps)) loadSaved(sel, maps); }, [sel, maps]);
  const live = sel === LIVE, on = sel !== '';
  const showL = live && fresh && !!bound && bound.gen === gen && bound.k === k && bound.seq === seq;   // 그리는 순간에도 현재 lv·연결로 다시 결속 확인
  // 높이색(GT 저장 지도만): 켤 때 1회 요청. 늦게 온 답은 선택·켬 상태가 그대로일 때만(다르면 버림). 자동 재요청 0
  const sm = !live && on && Array.isArray(maps) ? maps.find((m) => mapKey(m) === sel) : undefined, gt = !!saved && sm?.map_source === 'gt_raster';
  useEffect(() => {
    if (!hOn || !gt || !sm || !saved) return;
    let gone = false; const k0 = sel, g0 = gen; setHr(null);
    const still = () => { const s = useLink.getState(); return !gone && usePick.getState().sel === k0 && s.gen === g0 && s.open && s.provider === 'simulation_gate'; };
    getHeight(sm, saved, still).then((x) => { if (still()) setHr(typeof x === 'string' ? x : { key: k0, gen: g0, ...x }); });
    return () => { gone = true; };
  }, [hOn, gt, sel, saved, gen]);
  const hv = hOn && gt && hr && typeof hr !== 'string' && hr.key === sel && hr.gen === gen ? hr : null;   // 새 연결·대상엔 옛 높이 0
  const raster = live ? (showL ? bound!.r : null) : hv ? hv.r : saved;
  const p = showL ? lv?.pose : null;
  const pose: Robot = p ? { x: p.x, y: p.y, yaw: p.yaw, t: useLink.getState().lastMsg, fresh: true } : null;
  const note = !on ? '' : !live ? (saved ? '' : serr ? `저장 지도 미표시 · ${serr}` : '저장 지도 받는 중')
    : !fresh ? '연결 끊김·수신 중단 — 실시간 지도·위치 버림(조종 상태와 별개)'
    : !lv || lv.st === 'off' ? '실시간 지도 상태 없음 — «지도 열기»로 지도 시뮬을 열면 들어옵니다'
    : lv.st !== 'ok' ? `실시간 지도 미표시 · ${lv.why || lv.st}` : lwhy ? `실시간 지도 미표시 · ${lwhy}` : !raster ? '실시간 지도 받는 중'
    : `${auto ? '자동 선택 · ' : ''}${liveLabel(lv)} · ${p ? `위치 ${p.source === 'slam_tf' ? 'SLAM 보정' : 'GT(지도와 같은 좌표)'}` : `위치 미표시 · ${lv.pose_why || '모름'}`}`;
  const blank = on && !raster ? (note || '지도 없음') : null;   // MapCanvas blank — 지도 보기 중 그림 없음
  // 고른 저장 지도 ≠ 지금 열린 시뮬 지형·층이면 한 줄(보기는 화면만 — 시뮬은 그대로)
  const ss = useLink((x) => x.st?.map_start?.session) as Sess, at = runAt(ss);
  const diff = sm && (!at || at[0] !== sm.building_id || at[1] !== sm.floor_id)
    ? `보는 지도(${place(sm.world_id, sm.floor_id)})는 지금 열린 시뮬${at ? `(${place(ss!.world_id, ss!.floor_id)})` : '(지도 시뮬 꺼짐)'}과 다릅니다 — 보기만 바뀜, 시뮬은 그대로` : '';
  const hLeg = hv && <span aria-label="높이 범례" style={{ display: 'block', fontSize: 10, lineHeight: 1.3, padding: '4px 6px', borderRadius: 4, background: 'rgba(0,0,0,.6)', color: '#DDE5EC', maxWidth: 260 }}>
        <span style={{ display: 'block', height: 8, borderRadius: 2, background: `linear-gradient(90deg, ${[0, 0.25, 0.5, 0.75, 1].map((t) => `hsl(${hHue(t)} 75% 50%)`).join(',')})` }} />
        <span style={{ display: 'flex', justifyContent: 'space-between' }}><span>{`${hv.h.lo.toFixed(1)} m`}</span><span>{`${((hv.h.lo + hv.h.hi) / 2).toFixed(1)}`}</span><span>{`${hv.h.hi.toFixed(1)} m`}</span></span>
        <span style={{ display: 'block' }}>{`층 바닥 기준 높이(층 바닥 = map z ${hv.h.floor_z} m) · 출처 GT 기하(센서 아님) · 모름 ${hv.h.unknown}칸 = 회색 그대로 · 색은 이동 가능·벽·위험 판정 아님`}</span>
        <span style={{ display: 'block' }}>{`층 바닥 +${hv.h.band[1]} m 위에서 시작하는 기하(위층 바닥·높은 계단 윗단)는 빠짐 — 계단 상단 높이가 낮게 보일 수 있음`}</span></span>;
  const sty: React.CSSProperties = overlay ? { position: 'absolute', top: 8, left: 8, zIndex: 2, maxWidth: 'calc(100% - 80px)' } : { width: '100%' };
  const el = <span style={{ ...sty, display: 'flex', flexDirection: 'column', gap: 4 }}>
    <span style={{ fontSize: 11, color: 'var(--muted)' }}>지도 보기(화면만 · 시뮬은 그대로)</span>
    <select aria-label="지도 보기 선택(보기만 · 실제 world 안 바뀜)" title="지도 보기 선택 — 화면만 바뀝니다. 실제 Gazebo 지형·조종은 그대로" value={sel}
      onFocus={load} onChange={(e) => pick(e.target.value)}
      style={{ minHeight: overlay ? 32 : 44, font: 'inherit', fontSize: 12, background: 'var(--bg)', color: 'var(--fg, inherit)', border: '1px solid var(--line2)', borderRadius: 6 }}>
      <option value="">{touched ? '실행 중 시뮬 GT 위치' : '실행 중 시뮬 GT 위치(지도 시뮬이 보이면 실시간 자동)'}</option>
      <option value={LIVE}>현재 열린 지도(실시간 매핑)</option>
      {Array.isArray(maps) && groupMaps(maps).map((g) => <optgroup key={g.w} label={`저장 지도 보기 · ${g.label}`}>
        {g.items.map((m) => <option key={mapKey(m)} value={mapKey(m)}>{verLabel(m)}</option>)}</optgroup>)}
      {typeof maps === 'string' && <option disabled value="-">{`저장 지도 목록 · ${maps}`}</option>}
      {Array.isArray(maps) && !maps.length && <option disabled value="-">저장 지도 없음</option>}
    </select>
    {!overlay && <span style={{ fontSize: 11, padding: '2px 6px', borderRadius: 4, background: 'var(--bg)', color: 'var(--muted)' }}>{`지금 열린 시뮬 · ${runLine(ss)}`}</span>}
    {diff && <span role="status" style={{ fontSize: 11, padding: '2px 6px', borderRadius: 4, background: 'var(--bg)', color: 'var(--warn)' }}>{diff}</span>}
    {gt && <label style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 11, padding: '2px 6px', borderRadius: 4, background: 'var(--bg)' }}>
      <input type="checkbox" checked={hOn} onChange={(e) => { setHOn(e.target.checked); setHr(null); }} />높이 색(GT 기하 · 센서 아님)</label>}
    {hOn && gt && (typeof hr === 'string' ? <span role="status" style={{ fontSize: 11, padding: '2px 6px', borderRadius: 4, background: 'var(--bg)', color: 'var(--warn)' }}>{`높이 미표시 · ${hr}`}</span>
      : !hv ? <span style={{ fontSize: 11, padding: '2px 6px', background: 'var(--bg)', color: 'var(--muted)' }}>높이 받는 중</span>
      : hLeg)}
    {note && <span role="status" style={{ fontSize: 11, padding: '2px 6px', borderRadius: 4, background: 'var(--bg)', color: `var(--${raster ? 'muted' : 'warn'})` }}>{note}</span>}
  </span>;
  const showLive = () => pick(LIVE);   // 지도 체험 시작 수락 뒤 «실시간 지도 보기»(화면만 — 시작·조종 0)
  // GT 바닥 도면(±10 m 평지)이라고 쓰는 건 지금 켜진 쪽이 원본 평지 체험일 때만(지도 체험·모름이면 «지형 도면 없음»)
  const runner = useLink((x) => (x.st?.map_start?.session as any)?.runner), flat = runner === 'live_v2' || runner === 'ux_flat';
  return { legend: hLeg || null, raster, pickEl: el, pose, live, on, blank, showLive, reload: load, flat, auto, view: pick };
}
