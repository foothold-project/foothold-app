// 지도 보기 선택 — 화면만 바뀐다. 실제 Gazebo world·조종 상태 변경 0. op 는 map_list/map_get/map_live_get(읽기)뿐
// 저장 지도: 위치 마커 0(결속 없음). 실시간(/v2_map): 서버가 status·epoch·격자형상을 결속한 격자 + 같은 status 의 pose 만 마커로.
// 지도를 보는 동안 부르는 쪽은 GT 로봇·길·구역·경유점·탭 편집을 끈다(GT 좌표 ≠ 지도 좌표)
import { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import type { LiveMap, MapInfo } from '@contracts';
import { BLD, FLOOR, WF, WORLD, allKey, getHeight, getLive, getMap, groupMaps, gtFloors, hHue, loadList, liveLabel, liveShow, mapKey, place, stackFloors, verLabel, runAt, runLine, type HeightInfo, type Raster, type Sess } from '../data/maps';
import { dropAll, useLink } from '../data/link';
import type { Robot } from './MapCanvas';
import { toast } from '../app/shell';
import { Help } from '../app/chip';
import { geomBind, getGeom, type Geom } from '../data/geom';
import { Geom3D } from './Geom3D';

const LIVE = 'live';
const keyOf = (v: LiveMap) => [v.world_id, v.building_id, v.floor_id, v.mode, v.map_source, v.map_version, v.epoch, v.floor_rev ?? ''].join('|');   // 서버 결속 키 K(+연결 건물 층 세대)
type Bound = { r: Raster; k: string; seq: number; gen: number; t: number };   // 실시간 그림(이미지+메타 한 덩어리) + 받을 때의 K·seq·연결 세대 + 검증 완료 시각(performance.now)

// 선택은 화면들이 공유(관제·조종·지도 화면을 오가도 사용자가 고른 것 유지). touched = 사용자가 한 번이라도 직접 고름 → 그 뒤 자동 선택 0
const usePick = create<{ sel: string; touched: boolean; auto: boolean }>(() => ({ sel: '', touched: false, auto: false }));
// on = 지도 보기 중(sel ≠ GT). 이때 부르는 쪽은 그림이 없어도 GT 로봇·길·구역·경유점·초안·탭 편집 0 + blank 이유를 그린다. GT 복귀는 사용자가 직접 고를 때만
export function useMapPick(overlay = true, pc = false) {   // overlay=false: 서랍 안 등 흐름 배치(폰 — 지도 위 안내를 가리지 않게) → 건물별 목록. overlay(관제 작은 지도) = 기존 select. pc: 버튼 클래스
  const [ow, setOw] = useState<string | null>(null), [of, setOf] = useState('');   // 목록에서 펼친 건물 · 그 안 층 탭(층 id·'all') — 화면만
  const [maps, setMaps] = useState<MapInfo[] | string | null>(null), [saved, setSaved] = useState<Raster | null>(null);
  const { sel, touched, auto } = usePick();
  const [bound, setBound] = useState<Bound | null>(null), [lwhy, setLwhy] = useState(''), [serr, setSerr] = useState('');
  const [hOn, setHOn] = useState(false), [hr, setHr] = useState<{ key: string; gen: number; r: Raster; h: HeightInfo } | string | null>(null);   // 높이색: 보기 선택마다 끔 · 연결 세대 결속
  const linked = useLink((x) => x.open), gen = useLink((x) => x.gen), lv = useLink((x) => x.st?.live_map) || null;
  const fresh = useLink((x) => x.open && x.lastMsg > 0 && performance.now() - x.lastMsg < 1000);   // tick(500 ms)마다 다시 계산 — 수신 1 s 끊기면 false
  const [geo, setGeo] = useState<{ key: string; gen: number; g: Geom; sha: string } | string | null>(null);   // 건물 전체 3D(GT 간략 기하) — 선택·연결 세대 결속
  const [rq, setRq] = useState(0);   // 고를 때마다 +1 — 같은 보기를 다시 눌러도(pick 이 그림을 비움) 실시간·전체 3D 를 다시 받음(저장 지도의 loadSaved 재요청과 같은 규칙, real-04 고착)
  const ready = useLink((x) => x.open && x.stGen === x.gen);   // 이 연결에서 유효 status 를 받은 뒤만(관문이 upstream 없이 곧 닫는 연결엔 안 보냄)
  const lq = useRef({ n: 0, busy: null as number | null }).current, load = () => loadList(lq, setMaps);   // 늦은·겹친 결과 채택 0(세대·대상·최신 대조는 loadList)
  // 새 연결·대상 = 옛 목록 무효(정본인 척 남지 않게) → 그 세대 첫 유효 status 뒤 1회. 세대 변경·화면 닫힘 때 걸린 요청 버림. 자동 재시도 0 — 실패면 «목록 다시 불러오기»·고를 때(onFocus)
  useEffect(() => { setMaps(null); if (ready) load(); return () => { lq.n++; }; }, [ready, gen]);

  // 자동 실시간(앱 Codex 10-14): 사용자가 아직 안 골랐고 지금 지도 세션(live_map off·stale 아님)이 보일 때 한 번만 실시간으로.
  // 그 뒤로는 일반 선택과 같다 — 끊기면 빈 지도 + 이유(GT 자동 복귀 0). 사용자가 고른 GT·저장본은 빼앗지 않음
  const seen = !!lv && lv.st !== 'off' && lv.st !== 'stale';
  useEffect(() => { if (!touched && sel === '' && seen && fresh) usePick.setState({ sel: LIVE, auto: true }); }, [seen, fresh, sel, touched]);
  // 실시간: 연결 끊김·수신 중단·세대 변경·st≠ok·K 변경이면 그림·마커 즉시 버림. 새 seq 면 다시 받음(≤1 Hz) — 받는 동안 같은 K·세대 직전 검증본을 HOLD_MS 까지 «갱신 중»으로(마커 0), 해독 끝나면 Raster 통째 교체
  const ok = lv?.st === 'ok', k = ok ? keyOf(lv!) : null, seq = ok ? lv!.grid!.seq : null;
  useEffect(() => {
    if (sel !== LIVE) return;
    if (!fresh || k == null || seq == null) { setBound(null); return; }
    if (bound && bound.k === k && bound.seq === seq && bound.gen === gen) return;
    if (bound && (bound.k !== k || bound.gen !== gen)) setBound(null);   // 하드 경계(K·세대) = 직전 검증본도 즉시 버림
    let gone = false; const g0 = gen;
    getLive(lv!).then((r) => {   // getLive 의 마지막 await = image.decode — 그 뒤 연결 세대·K·seq·선택을 다시 대조
      const s = useLink.getState(), now = s.st?.live_map;
      if (gone || usePick.getState().sel !== LIVE || s.gen !== g0 || !s.open || now?.st !== 'ok' || now.grid?.seq !== seq || keyOf(now) !== k) return;
      // 실패(응답 seq 가 그새 앞섬·PNG 해독 실패 등): 같은 K·세대·연결이 위에서 확인됐으니 직전 검증본은 원래 시한(b.t 그대로 — 연장 0) 안에서만 보유, 오류 그림 채택 0
      if (typeof r === 'string') setLwhy(r); else { setBound({ r, k, seq, gen: g0, t: performance.now() }); setLwhy(''); }   // 원자 교체: 이미지+메타+seq 한 번에
    });
    return () => { gone = true; };
  }, [sel, seq, k, fresh, gen, rq]);

  const loadSaved = async (key: string, list: MapInfo[] | string | null) => {
    if (key.startsWith('all:')) {   // 건물 전체 보기: 층별 GT 그림 나란히(보기만 · 좌표 결속·위치 마커 0)
      const w = key.slice(4), fs = Array.isArray(list) ? gtFloors(list, w) : '저장 지도 목록 받는 중';
      if (typeof fs === 'string') return setSerr(fs);
      const rs = await Promise.all(fs.map(getMap)); if (usePick.getState().sel !== key) return;
      const bad = rs.find((r): r is string => typeof r === 'string'); if (bad) { setSerr(bad); return; }
      setSaved(stackFloors(rs as Raster[], fs.map((m) => `${FLOOR[m.floor_id as keyof typeof FLOOR] || m.floor_id} · GT 기하`), `${place(w, null).split(' · ')[0]} 층 나란히 · GT 기하 2D(SLAM·센서 아님)`)); setSerr(''); return;
    }
    const m = Array.isArray(list) ? list.find((x) => mapKey(x) === key) : null; if (!m) return setSerr(Array.isArray(list) ? '목록에 없음 — 목록 다시 받기' : '저장 지도 목록 받는 중');
    const r = await getMap(m); if (usePick.getState().sel !== key) return;   // 그사이 다른 지도를 골랐으면 버림
    if (typeof r === 'string') { toast(`지도 · ${r}`); setSerr(r); } else { setSaved(r); setSerr(''); }   // 실패해도 GT 로 자동 복귀 0 — 선택 유지 + 빈 칸 + 이유
  };
  const pick = (key: string) => {
    usePick.setState({ sel: key, touched: true, auto: false }); setSaved(null); setHOn(false); setHr(null); setBound(null); setLwhy(''); setSerr(''); setGeo(null); setRq((n) => n + 1);
    if (key !== LIVE && key && !key.startsWith('g3d:')) loadSaved(key, maps);
  };
  // 다른 화면에서 고른 저장 지도로 이 화면이 열림 → 목록이 오면 이 화면도 받아 그림
  useEffect(() => { if (sel && sel !== LIVE && !sel.startsWith('g3d:') && !saved && Array.isArray(maps)) loadSaved(sel, maps); }, [sel, maps]);
  // 건물 전체 3D: 고를 때·연결 세대 바뀔 때 1회 받음. 늦은 답은 선택·세대가 그대로일 때만
  useEffect(() => {
    if (!sel.startsWith('g3d:') || !linked) return;
    let gone = false; const k0 = sel, g0 = gen; setGeo(null);
    getGeom('v5').then((x) => { if (!gone && usePick.getState().sel === k0 && useLink.getState().gen === g0) setGeo(typeof x === 'string' ? x : { key: k0, gen: g0, ...x }); });
    return () => { gone = true; };
  }, [sel, gen, linked, rq]);
  const live = sel === LIVE, on = sel !== '';
  // 그리는 순간에도 현재 lv·연결로 다시 결속 확인. 같은 seq = 정상, 앞선 seq 대기 = 검증 시각 + HOLD_MS 까지만 보유(K·세대·끊김은 위에서 즉시 버림)
  const ls = live ? liveShow(bound, k, seq, gen, fresh, lv?.grid?.upd === true, performance.now()) : null;
  const showL = !!ls, held = ls === 'held';   // held = 클라이언트 해독 대기 또는 서버 보유(grid.upd) — 옛 그림 + 새 pose 조합 0
  const heldR = useMemo(() => bound && { ...bound.r, upd: true, label: `지도 갱신 중 · ${bound.r.label}` }, [bound]);
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
  const raster = live ? (showL ? (held ? heldR : bound!.r) : null) : hv ? hv.r : saved;
  const p = showL && !held ? lv?.pose : null;
  const pose: Robot = p ? { x: p.x, y: p.y, yaw: p.yaw, t: useLink.getState().lastMsg, fresh: true } : null;
  const isAll = sel.startsWith('all:'), is3 = sel.startsWith('g3d:');
  const ss = useLink((x) => x.st?.map_start?.session) as Sess, at = runAt(ss);
  const gk = is3 && geo && typeof geo !== 'string' && geo.key === sel && geo.gen === gen ? geo : null;
  const gbind = gk ? geomBind(gk.g, gk.sha, at ? ss!.world_id : null, lv as any, sel.slice(4)) : '';   // 결속 = 런 안 불변 spawn_floor 원본 SDF sha(live_map)
  const v3d = gk && (gbind === 'ok' || gbind === '') ? <Geom3D g={gk.g} bind={gbind} /> : null;   // 같은 world 인데 미확인·불일치면 그리지 않음
  const note = !on ? '' : is3 ? (gk ? (v3d ? '건물 전체 3D · GT 간략 기하(센서·주행 판정 아님) · 위치·SLAM 겹치지 않음' : `건물 3D 미표시 · ${gbind}`)
      : typeof geo === 'string' ? `건물 3D 미표시 · ${geo}` : '건물 3D 기하 받는 중') : isAll ? (saved ? '층 나란히 보기 · GT 기하 2D(SLAM·센서 아님) · 위층부터 · 전체 3D 아님 · 위치·격자 표시 없음' : serr ? `층 나란히 보기 미표시 · ${serr}` : '층 나란히 보기 받는 중')
    : !live ? (saved ? '' : serr ? `저장 지도 미표시 · ${serr}` : '저장 지도 받는 중')
    : !fresh ? '연결 끊김·수신 중단 — 실시간 지도·위치 버림(조종 상태와 별개)'
    : !lv || lv.st === 'off' ? '실시간 지도 상태 없음 — «지도 열기»로 지도 시뮬을 열면 들어옵니다'
    : lv.st !== 'ok' ? `실시간 지도 미표시 · ${lv.why || lv.st}` : !raster ? (lwhy ? `실시간 지도 미표시 · ${lwhy}` : '실시간 지도 받는 중')
    : held ? `${auto ? '자동 선택 · ' : ''}${liveLabel(lv)} · 지도 갱신 중(${lwhy ? `새 격자 못 받음 · ${lwhy} — 직전 지도` : '새 격자 받는 중'}) — 위치 표시 잠시 끔` : `${auto ? '자동 선택 · ' : ''}${liveLabel(lv)} · ${p ? `위치 ${p.source === 'slam_tf' ? 'SLAM 보정' : 'GT(지도와 같은 좌표)'}` : `위치 미표시 · ${lv.pose_why || '모름'}`}`;
  const blank = on && !raster ? (is3 && v3d ? '건물 전체 3D 는 «지도» 화면에서 봅니다' : note || '지도 없음') : null;   // MapCanvas blank — 지도 보기 중 그림 없음
  // 고른 저장 지도 ≠ 지금 열린 시뮬 지형·층이면 한 줄(보기는 화면만 — 시뮬은 그대로)
  const diff = sm && (!at || at[0] !== sm.building_id || at[1] !== sm.floor_id)
    ? `보는 지도(${place(sm.world_id, sm.floor_id)})는 지금 열린 시뮬${at ? `(${place(ss!.world_id, ss!.floor_id)})` : '(지도 시뮬 꺼짐)'}과 다릅니다 — 보기만 바뀜, 시뮬은 그대로` : '';
  const hLeg = hv && <span aria-label="높이 범례" style={{ display: 'block', fontSize: 10, lineHeight: 1.3, padding: '4px 6px', borderRadius: 4, background: 'rgba(0,0,0,.6)', color: '#DDE5EC', maxWidth: 260 }}>
        <span style={{ display: 'block', height: 8, borderRadius: 2, background: `linear-gradient(90deg, ${[0, 0.25, 0.5, 0.75, 1].map((t) => `hsl(${hHue(t)} 75% 50%)`).join(',')})` }} />
        <span style={{ display: 'flex', justifyContent: 'space-between' }}><span>{`${hv.h.lo.toFixed(1)} m`}</span><span>{`${((hv.h.lo + hv.h.hi) / 2).toFixed(1)}`}</span><span>{`${hv.h.hi.toFixed(1)} m`}</span></span>
        <span style={{ display: 'block' }}>{`층 바닥 기준 높이(층 바닥 = map z ${hv.h.floor_z} m) · 출처 GT 기하(센서 아님) · 모름 ${hv.h.unknown}칸 = 회색 그대로 · 색은 이동 가능·벽·위험 판정 아님`}</span>
        <span style={{ display: 'block' }}>{`층 바닥 +${hv.h.band[1]} m 위에서 시작하는 기하(위층 바닥·높은 계단 윗단)는 빠짐 — 계단 상단 높이가 낮게 보일 수 있음`}</span></span>;
  // ── 건물별 목록(흐름 배치): 건물 3행 → 펼치면 (2층 건물) 현재층·1층·2층·전체 보기 탭 → 버전. 누르면 보기 선택만(시뮬·조종 0). 펼침·탭 바꿈 = 배치 변경 → dropAll(기존 규칙)
  const B = pc ? 'btn' : 'lv-btn', tap = (f: () => void) => () => { dropAll(); f(); };
  const selW = isAll || is3 ? sel.slice(4) : sm?.world_id || null, openW = ow ?? selW;
  const card = (hi: boolean): React.CSSProperties => ({ display: 'flex', flexDirection: 'column', gap: 4, padding: 10, width: '100%', boxSizing: 'border-box', textAlign: 'left', font: 'inherit', color: 'inherit', cursor: 'pointer',
    border: `1px solid var(--${hi ? 'accent' : 'line'})`, borderRadius: 8, background: hi ? 'var(--acc-bg, transparent)' : 'var(--panel2)' });
  const segB = (on: boolean, t: string, f: () => void, dis?: string) => <button key={t} type="button" className={`${B}${on ? ' pri' : ''}`} aria-pressed={on} disabled={!!dis} title={dis} onClick={tap(f)}>{t}</button>;
  const vrow = { display: 'flex', gap: 6, flexWrap: 'wrap' } as const;
  const list = <span style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
    <span role="group" aria-label="실행 중 시뮬 보기" style={vrow}>
      {segB(sel === '', '실행 중 시뮬 GT 위치', () => pick(''))}{segB(live, '현재 열린 지도(실시간)', () => pick(LIVE))}</span>
    {typeof maps === 'string' && <span style={{ ...vrow, alignItems: 'center' }}><span className="lbl">{`저장 지도 목록 · ${maps}`}</span>
      <button type="button" className={B} disabled={!ready} title={ready ? undefined : '서버 연결 확인 전 — 확인되면 자동으로 1회 받음'} onClick={tap(() => { if (load()) setMaps(null); })}>목록 다시 불러오기</button></span>}
    {maps === null && <span className="lbl">{ready ? '저장 지도 목록 받는 중' : '저장 지도 목록 · 서버 연결 확인 뒤 받음'}</span>}
    {Array.isArray(maps) && (Object.keys(WORLD) as (keyof typeof WORLD)[]).map((w) => {
      const its = maps.filter((m) => m.world_id === w), multi = WF[w].length > 1, here = !!at && at[0] === BLD[w], op = openW === w;
      const nG = its.filter((m) => m.map_source === 'gt_raster').length, nS = its.length - nG;
      // 현재층 = 서버 층 판정(live_map.floor, GT 기하 판정) 이 on_floor 일 때만. 열 때 고른 층은 «시작층»으로만(현재층으로 표시 0 — root 10-14)
      const sf = here ? FLOOR[at![1] as keyof typeof FLOOR] || at![1] : '';
      const fl = here && lv && lv.st !== 'stale' && lv.st !== 'unknown' && lv.world_id === ss!.world_id ? lv.floor as { state?: string; current?: string | null } | null | undefined : null;
      const cf = fl?.state === 'on_floor' && typeof fl.current === 'string' && WF[w].includes(fl.current) ? fl.current : '';
      const curT = cf ? `현재층 ${FLOOR[cf as keyof typeof FLOOR] || cf}` : fl?.state === 'transit' ? '층 이동 중' : '현재층 미확인';
      const tabF = of && of !== 'all' ? of : (sm?.world_id === w ? sm.floor_id : WF[w][0]);
      const tabOn = of || (isAll && selW === w ? 'all' : is3 && selW === w ? 'g3d' : tabF);   // 층 탭(보기만) — 현재층 탭은 계약 전 비활성
      const vs = its.filter((m) => !multi || m.floor_id === tabF);
      return <span key={w} style={card(selW === w)}>
        <button type="button" aria-expanded={op} onClick={tap(() => { setOw(op ? '' : w); setOf(''); })} style={{ all: 'unset', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 2 }}>
          <b style={{ fontSize: 14 }}>{`${op ? '▾' : '▸'} ${WORLD[w]}`}</b>
          <span className="lbl">{`${multi ? '1·2층' : '단층'} · GT 기하 ${nG} · SLAM 저장 ${nS}${w === 'rooms_a' ? ' · SLAM 지도 만들기용' : ''}${here ? ` · 지금 열림 · 시작층 ${sf} · ${curT}` : ''}`}</span></button>
        {op && multi && <span role="group" aria-label={`${WORLD[w]} 층 보기(화면만)`} style={vrow}>
          {segB(false, curT, () => setOf(cf), cf ? undefined : !here ? '이 건물 지도 시뮬이 꺼져 있음' : fl?.state === 'transit' ? '층 사이 이동 중 — 도착 층이 확정되면 표시' : `층 판정 없음 — 시작층(${sf})만 압니다`)}   {/* 누르면 그 층 보기(화면만) */}
          {WF[w].map((f) => segB(tabOn === f, FLOOR[f as keyof typeof FLOOR] || f, () => setOf(f)))}
          {segB(tabOn === 'all', '층 나란히 보기', () => { setOf('all'); pick(allKey(w)); })}
          {segB(tabOn === 'g3d', '전체 3D', () => { setOf('g3d'); pick(`g3d:${w}`); })}</span>}
        {op && multi && tabOn === 'all' && <span className="lbl">층별 GT 기하 2D 지도를 위층부터 나란히 — 전체 3D 아님 · 위치·SLAM·센서 없음. 층 탭은 보기만(시뮬 층 바꾸기 아님)</span>}
        {op && multi && tabOn === 'g3d' && <span className="lbl">원본 SDF 충돌 상자 그대로 + 계단·경사로 구조상 연결 — GT 간략 기하(센서·주행 판정 아님). 실제 mesh 는 외곽 점선만</span>}
        {op && tabOn !== 'all' && tabOn !== 'g3d' && (<span role="group" aria-label="저장 지도 버전(보기만)" style={vrow}>
            {vs.map((m) => segB(sel === mapKey(m), `${m.map_source === 'gt_raster' ? '시뮬 도면 지도' : 'SLAM 저장 지도'} · ${m.map_version}`, () => pick(mapKey(m))))}   {/* 층은 탭이 이미 말함 — 버전 줄엔 출처·버전만 */}
            {!vs.length && <span className="lbl">이 층 저장 지도 없음</span>}</span>)}
      </span>;
    })}
  </span>;
  const sty: React.CSSProperties = overlay ? { position: 'absolute', top: 8, left: 8, zIndex: 2, maxWidth: 'calc(100% - 200px)' /* 오른쪽 위 보기 버튼 자리 */ } : { width: '100%' };
  const el = <span className={overlay ? 'lv-mappick' : undefined} style={{ ...sty, display: 'flex', flexDirection: 'column', gap: 4 }}>   {/* lv-mappick: Main 좁은 칸 배치(live.css [data-mapnarrow]) */}
    {overlay ? <span style={{ fontSize: 11, color: 'var(--muted)' }}>지도 보기<Help label="지도 보기 · 설명">화면만 바뀜 · 시뮬은 그대로</Help></span>   /* U2-b(Main 만 overlay) */
      : <span style={{ fontSize: 11, color: 'var(--muted)' }}>지도 보기(화면만 · 시뮬은 그대로)</span>}
    {overlay ? <select aria-label="지도 보기 선택(보기만 · 실제 시뮬 안 바뀜)" title="지도 보기 선택 — 화면만 바뀝니다. 실제 시뮬 지형·조종은 그대로" value={sel}
      onFocus={load} onChange={(e) => pick(e.target.value)}
      style={{ minHeight: overlay ? 32 : 44, minWidth: 0, maxWidth: '100%', font: 'inherit', fontSize: 12, background: 'var(--bg)', color: 'var(--fg, inherit)', border: '1px solid var(--line2)', borderRadius: 6 }}>
      <option value="">{touched ? '시뮬 위치' : '시뮬 위치(지도 시뮬이 보이면 실시간 자동)'}</option>
      <option value={LIVE}>현재 열린 지도(실시간 매핑)</option>
      {Array.isArray(maps) && groupMaps(maps).map((g) => <optgroup key={g.w} label={`저장 지도 보기 · ${g.label}`}>
        {WF[g.w].length > 1 && <option value={allKey(g.w)}>층 나란히 보기</option>}
        {g.items.map((m) => <option key={mapKey(m)} value={mapKey(m)}>{verLabel(m)}</option>)}</optgroup>)}
      {typeof maps === 'string' && <option disabled value="-">{`저장 지도 목록 · ${maps}`}</option>}
      {Array.isArray(maps) && !maps.length && <option disabled value="-">저장 지도 없음</option>}
    </select> : list}
    {!overlay && <span style={{ fontSize: 11, padding: '2px 6px', borderRadius: 4, background: 'var(--bg)', color: 'var(--muted)' }}>{`지금 열린 시뮬 · ${runLine(ss)}`}</span>}
    {diff && overlay && <span role="status" style={{ fontSize: 11, padding: '2px 6px', borderRadius: 4, background: 'var(--bg)', color: 'var(--warn)' }}>보는 지도 ≠ 실행 지도<Help label="보는 지도 · 실행 지도 차이">{diff}</Help></span>}
    {diff && !overlay && <span role="status" style={{ fontSize: 11, padding: '2px 6px', borderRadius: 4, background: 'var(--bg)', color: 'var(--warn)' }}>{diff}</span>}
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
  return { v3d, legend: hLeg || null, raster, pickEl: el, pose, live, on, blank, showLive, reload: load, flat, auto, view: pick };
}
