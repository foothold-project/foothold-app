// 지도 보기 선택 — 화면만 바뀐다. 실제 Gazebo world·조종 상태 변경 0. op 는 map_list/map_get/map_live_get(읽기)뿐
// 저장 지도: 위치 마커 0(결속 없음). 실시간(/v2_map): 서버가 status·epoch·격자형상을 결속한 격자 + 같은 status 의 pose 만 마커로.
// 지도를 보는 동안 부르는 쪽은 GT 로봇·길·구역·경유점·탭 편집을 끈다(GT 좌표 ≠ 지도 좌표)
import { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import type { LiveMap, MapInfo } from '@contracts';
import { BLD, FLOOR, WF, WORLD, allKey, getFloors, getHeight, getLive, getMap, groupMaps, gtFloors, hHue, loadList, useCatalog, liveLabel, liveShow, mapKey, place, stackFloors, verLabel, runAt, runLine, latestSaved, tsOf, type HeightInfo, type Raster, type Sess } from '../data/maps';
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
export function useMapPick(drop = true, pc = false, fit3d = false) {   // fit3d: 3D 덧칸을 작은 지도 칸에 맞춤(670 a9db ③ · MMap 만 참)
  // drop=false: 건물별 목록(폰 서랍·PC 지도). drop(관제 오른쪽 «지도 보기» 칸 — U2-c 전엔 지도 칸 위 겹침) = select 드롭다운. pc: 버튼 클래스
  const GT = pc ? '시뮬 ' : 'GT ';   // U4-a(PcMap = pc 만): 운영 글의 «GT» → «시뮬»(v3 §3 «Gazebo GT 위치 → 시뮬 위치»). 뜻(센서·SLAM 아님)은 글·? 에 그대로. 폰·관제 글 무변경
  const [ow, setOw] = useState<string | null>(null);   // 목록에서 펼친 건물 · 그 안 층 탭(층 id·'all') — 화면만
  const [msg, setMsg] = useState<{ sel: string; t: string; tie?: boolean } | null>(null);   // U2-b 보완(715 R1·R3·R4): bar 안내 글(읽기 · 누름/터치/키보드로 보임) — 그 보기(sel)일 때만
  const [maps, setMaps] = useState<MapInfo[] | string | null>(null), [saved, setSaved] = useState<Raster | null>(null);
  const { sel, touched, auto } = usePick();
  const [bound, setBound] = useState<Bound | null>(null), [lwhy, setLwhy] = useState(''), [serr, setSerr] = useState('');
  const [hOn, setHOn] = useState(false), [hr, setHr] = useState<{ key: string; gen: number; r: Raster; h: HeightInfo } | string | null>(null);   // 높이색: 보기 선택마다 끔 · 연결 세대 결속
  const linked = useLink((x) => x.open), gen = useLink((x) => x.gen), lv = useLink((x) => x.st?.live_map) || null;
  const fresh = useLink((x) => x.open && x.lastMsg > 0 && performance.now() - x.lastMsg < 1000);   // tick(500 ms)마다 다시 계산 — 수신 1 s 끊기면 false
  const [geo, setGeo] = useState<{ key: string; gen: number; g: Geom; sha: string } | string | null>(null);   // 건물 전체 3D(GT 간략 기하) — 선택·연결 세대 결속
  const [rq, setRq] = useState(0);   // 고를 때마다 +1 — 같은 보기를 다시 눌러도(pick 이 그림을 비움) 실시간·전체 3D 를 다시 받음(저장 지도의 loadSaved 재요청과 같은 규칙, real-04 고착)
  const ready = useLink((x) => x.open && x.stGen === x.gen);   // 이 연결에서 유효 status 를 받은 뒤만(관문이 upstream 없이 곧 닫는 연결엔 안 보냄)
  const lq = useRef({ n: 0, busy: null as number | null }).current, load = () => loadList(lq, (v) => { setMaps(v); useCatalog.setState({ v, gen: useLink.getState().gen }); });   // 늦은·겹친 결과 채택 0(세대·대상·최신 대조는 loadList)
  // 10-18 저장 지도 시작: 이 목록을 시작 상자와 나눔(useCatalog) — 같은 화면의 시작 상자가 따로 map_list 를 보내 map_busy 로 거절되지 않게. 장착 수만 셈
  useEffect(() => { useCatalog.setState((c) => ({ owners: c.owners + 1, reload: load })); return () => useCatalog.setState((c) => ({ owners: c.owners - 1, ...(c.owners <= 1 ? { v: null, reload: null } : {}) })); }, []);
  // 새 연결·대상 = 옛 목록 무효(정본인 척 남지 않게) → 그 세대 첫 유효 status 뒤 1회. 세대 변경·화면 닫힘 때 걸린 요청 버림. 자동 재시도 0 — 실패면 «목록 다시 불러오기»·고를 때(onFocus)
  useEffect(() => { setMaps(null); useCatalog.setState({ v: null, gen }); if (ready) load(); return () => { lq.n++; }; }, [ready, gen]);

  // 자동 실시간(앱 Codex 10-14): 사용자가 아직 안 골랐고 지금 지도 세션(live_map off·stale 아님)이 보일 때 한 번만 실시간으로.
  // 그 뒤로는 일반 선택과 같다 — 끊기면 빈 지도 + 이유(GT 자동 복귀 0). 사용자가 고른 GT·저장본은 빼앗지 않음
  const seen = !!lv && lv.st !== 'off' && lv.st !== 'stale';
  useEffect(() => { if (!touched && sel === '' && seen && fresh) usePick.setState({ sel: LIVE, auto: true }); }, [seen, fresh, sel, touched]);
  // 실시간: 연결 끊김·수신 중단·세대 변경·st≠ok·K 변경이면 그림·마커 즉시 버림. 새 seq 면 다시 받음(≤1 Hz) — 받는 동안 같은 K·세대 직전 검증본을 HOLD_MS 까지 «갱신 중»으로(마커 0), 해독 끝나면 Raster 통째 교체
  const ok = lv?.st === 'ok', k = ok ? keyOf(lv!) : null, seq = ok ? lv!.grid!.seq : null;
  // ── 층 저장 지도 대체(10-18 요청 1·3 · root 최소안 · 715 bd979410 · root SRC1153 보완): 실시간 보기(LIVE)에서만. 수동 GT·저장본·다른 층 보기는 건드리지 않음.
  // 현재층 신원(fbKey) = 이 연결의 신선한 live_map(st wait|ok) + world·building(BLD 대조)·epoch. 시작 정보(runAt) 대체 0 · reset/stale/unknown/bad/off/transit = fbKey 없음.
  //   연결 건물(층 여럿): floor{state on_floor·current(그 world 층)·rev} 필수 — 서버는 K 없는 정상 층 대기(st wait)에도 이 칸을 보냄(v2_link view) → mode·floor_id 요구 0.
  //   단층(v5_single·rooms_a): floor 칸 없음 — full key floor_id 가 그 world 의 유일 층이고 floor_rev 없음일 때만 · rev = null.
  const fl = (lv?.floor || null) as { state?: unknown; current?: unknown; rev?: unknown } | null, w0 = lv?.world_id, wf = w0 ? WF[w0] : undefined;
  const idOk = sel === LIVE && fresh && !!lv && (lv.st === 'wait' || lv.st === 'ok') && !!wf && lv.building_id === (BLD as Record<string, string>)[w0!] && Number.isInteger(lv.epoch);
  const floorNow = !idOk ? null : wf!.length > 1
    ? (fl?.state === 'on_floor' && typeof fl.current === 'string' && wf!.includes(fl.current) && Number.isInteger(fl.rev) ? { f: fl.current, rev: fl.rev as number } : null)
    : (lv!.floor_id === wf![0] && lv!.floor_rev == null ? { f: wf![0], rev: null } : null);
  const liveFor = !!floorNow && lv!.st === 'ok' && lv!.floor_id === floorNow.f && (lv!.floor_rev ?? null) === floorNow.rev;   // 서버 실시간 격자가 이 층·rev 것
  const fbKey = floorNow ? [gen, w0, lv!.building_id, lv!.epoch, floorNow.rev ?? '-', floorNow.f].join('|') : '';
  // fb = 이 fbKey 에서 고정한 저장본 1개 · fbTok = 하드 경계 번호(fbKey·다시 고름 바뀌면 +1 → 늦은 답 버림) · lpend/spend = 이 hook 의 진행 중 map_live_get/대체 map_get 수(옛 fbKey 요청 포함)
  const [fb, setFb] = useState<{ k: string; m: MapInfo | null; r?: Raster; why?: string } | null>(null), fbTok = useRef(0), [lpend, setLpend] = useState(0), [spend, setSpend] = useState(0);
  const liveBlock = !!fbKey && !liveFor;   // 신원은 섰는데 서버 실시간이 이 층·rev 아님 = 화면에 안 낼 다른 문맥 read 0
  useEffect(() => {
    if (sel !== LIVE) return;
    if (!fresh || k == null || seq == null || liveBlock) { setBound(null); return; }
    if (spend > 0) return;   // 같은 연결 지도 요청 하나(map_busy) — 대체 map_get 이 끝나면 deps(spend)로 다시
    if (bound && bound.k === k && bound.seq === seq && bound.gen === gen) return;
    if (bound && (bound.k !== k || bound.gen !== gen)) setBound(null);   // 하드 경계(K·세대) = 직전 검증본도 즉시 버림
    let gone = false; const g0 = gen;
    getLive(lv!).then((r) => {   // getLive 의 마지막 await = image.decode — 그 뒤 연결 세대·K·seq·선택을 다시 대조
      const s = useLink.getState(), now = s.st?.live_map;
      if (gone || usePick.getState().sel !== LIVE || s.gen !== g0 || !s.open || now?.st !== 'ok' || now.grid?.seq !== seq || keyOf(now) !== k) return;
      // 실패(응답 seq 가 그새 앞섬·PNG 해독 실패 등): 같은 K·세대·연결이 위에서 확인됐으니 직전 검증본은 원래 시한(b.t 그대로 — 연장 0) 안에서만 보유, 오류 그림 채택 0
      if (typeof r === 'string') setLwhy(r); else { setBound({ r, k, seq, gen: g0, t: performance.now() }); setLwhy(''); }   // 원자 교체: 이미지+메타+seq 한 번에
    }).finally(() => setLpend((n) => n - 1));
    setLpend((n) => n + 1);
    return () => { gone = true; };
  }, [sel, seq, k, fresh, gen, rq, liveBlock, spend > 0]);
  // 저장본 대체: fbKey·다시 고름(rq) 바뀜 = 하드 경계(번호 +1 · 고정본 철회). 고르기 = latestSaved(같은 world/building/floor·slam 검증본 최신 1) · fbKey 당 1회(목록 재수신 갈아끼우기 0)
  // 시작 조건: 서버 실시간이 이 층 것이 아님(liveFor 거짓) · 진행 중 map_live_get 0 · 목록 있음. 답은 같은 번호·LIVE 일 때만 · 자동 재시도 0(다시 고르면 다시 받음)
  useEffect(() => { fbTok.current++; setFb(null); }, [fbKey, rq]);
  useEffect(() => {
    if (!fbKey || fb || liveFor || lpend > 0 || spend > 0 || !Array.isArray(maps)) return;   // 옛 fbKey 의 map_get 이 아직이면 끝난 뒤(deps spend)
    const t = ++fbTok.current, k0 = fbKey, m = latestSaved(maps, w0!, floorNow!.f);
    if (!m) { setFb({ k: k0, m: null, why: '저장 지도 없음' }); return; }
    setFb({ k: k0, m }); setSpend((n) => n + 1);
    const done = (o: { r?: Raster; why?: string }) => { if (fbTok.current === t && usePick.getState().sel === LIVE) setFb({ k: k0, m, ...o }); };
    // 요청 4: 라벨 = 출처·층만(버전·epoch 원값은 기본 글 0 · 고른 본 원값 = fb.m)
    getMap(m).then((r) => done(typeof r === 'string' ? { why: r } : { r: { ...r, label: `저장 지도 · ${FLOOR[m.floor_id as keyof typeof FLOOR] || m.floor_id}` } }),
      () => done({ why: '저장 지도 받기 실패' })).finally(() => setSpend((n) => n - 1));
  }, [fbKey, rq, maps, fb, liveFor, lpend, spend]);

  const allN = useRef(0);   // 층 나란히 받기 호출 번호 — 마지막 호출만 채택 · 화면 닫힘 = 번호 올림(남은 층 요청 0)
  useEffect(() => () => { allN.current++; }, []);
  const loadSaved = async (key: string, list: MapInfo[] | string | null) => {
    if (key.startsWith('all:')) {   // 건물 전체 보기: 층별 GT 그림 나란히(보기만 · 좌표 결속·위치 마커 0)
      const w = key.slice(4), fs = Array.isArray(list) ? gtFloors(list, w) : '저장 지도 목록 받는 중';
      if (typeof fs === 'string') return setSerr(fs);
      // M①(670 P1): 동시 2요청(Promise.all) → 두 번째가 link map_busy 로 거절돼 «처리 중» 고정 — 한 층씩 차례로. 매 응답 뒤 최신 호출·선택·연결 세대 대조
      const t0 = ++allN.current, g0 = useLink.getState().gen;
      const rs = await getFloors(fs, () => allN.current === t0 && usePick.getState().sel === key && useLink.getState().gen === g0);
      if (rs === null) return;   // 그새 다른 보기·다시 고름·새 연결 — 버림(옛 그림 섞임 0)
      if (typeof rs === 'string') { setSerr(rs); return; }   // 다른 지도로 자동 복귀 0 — 선택 유지 + 빈 칸 + 이유
      setSaved(stackFloors(rs, fs.map((m) => `${FLOOR[m.floor_id as keyof typeof FLOOR] || m.floor_id} · ${GT}기하`), `${place(w, null).split(' · ')[0]} 층 나란히 · ${GT}기하 2D(SLAM·센서 아님)`)); setSerr(''); return;
    }
    const m = Array.isArray(list) ? list.find((x) => mapKey(x) === key) : null; if (!m) return setSerr(Array.isArray(list) ? '목록에 없음 — 목록 다시 받기' : '저장 지도 목록 받는 중');
    const r = await getMap(m); if (usePick.getState().sel !== key) return;   // 그사이 다른 지도를 골랐으면 버림
    if (typeof r === 'string') { toast(`지도 · ${r}`); setSerr(r); } else { setSaved(r); setSerr(''); }   // 실패해도 GT 로 자동 복귀 0 — 선택 유지 + 빈 칸 + 이유
  };
  const asked = useRef(0), did = useRef<{ t: number; sel: string; maps: unknown } | null>(null);   // 고른 횟수(동기 ref) · 마지막으로 받기 시작한 (고름·선택·목록)
  const pick = (key: string) => {
    asked.current++; usePick.setState({ sel: key, touched: true, auto: false }); setSaved(null); setHOn(false); setHr(null); setBound(null); setLwhy(''); setSerr(''); setGeo(null); setMsg(null); setRq((n) => n + 1);
  };
  // 저장 지도 받기는 이 effect 하나만(M① 670 P1: pick 직접 호출 + 이 effect = 한 번 고를 때 map_get 2개 → 둘째가 map_busy «처리 중»).
  // 고름(rq) · 다른 화면에서 고른 지도로 열림(sel) · 목록 도착(maps) 때 1회. 같은 보기를 다시 고르면 rq 로 다시 받음.
  // 공유 선택(zustand)과 rq 갱신이 두 렌더로 갈라져도(이벤트 밖 호출) 같은 (고름·선택·목록)은 한 번만 — did 대조
  useEffect(() => {
    if (!sel || sel === LIVE || sel.startsWith('g3d:') || saved || !Array.isArray(maps)) return;
    const d = did.current; if (d && d.t === asked.current && d.sel === sel && d.maps === maps) return;
    did.current = { t: asked.current, sel, maps }; loadSaved(sel, maps);
  }, [sel, maps, rq]);
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
  // 저장본은 이 fbKey 의 검증 완료 실시간 그림(같은 K 결속 · liveShow)이 생길 때까지 보임 → 그 순간 실시간으로 통째 교체. 서버 ok 알림만으론 안 버림
  const liveHere = liveFor && showL, fbShow = !!fbKey && !liveHere && (!liveFor || fb?.k === fbKey);
  const fbR = fbShow && fb?.k === fbKey ? fb.r || null : null;
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
  const raster = live ? (fbShow ? fbR : showL ? (held ? heldR : bound!.r) : null) : hv ? hv.r : saved;
  const p = showL && !held && !fbShow ? lv?.pose : null;   // 저장 지도 대체 중 = 마커 0
  const pose: Robot = p ? { x: p.x, y: p.y, yaw: p.yaw, t: useLink.getState().lastMsg, fresh: true } : null;
  const isAll = sel.startsWith('all:'), is3 = sel.startsWith('g3d:');
  const ss = useLink((x) => x.st?.map_start?.session) as Sess, at = runAt(ss);
  const gk = is3 && geo && typeof geo !== 'string' && geo.key === sel && geo.gen === gen ? geo : null;
  const gbind = gk ? geomBind(gk.g, gk.sha, at ? ss!.world_id : null, lv as any, sel.slice(4)) : '';   // 결속 = 런 안 불변 spawn_floor 원본 SDF sha(live_map)
  const v3d = gk && (gbind === 'ok' || gbind === '') ? <Geom3D g={gk.g} bind={gbind} fit={fit3d} /> : null;   // 같은 world 인데 미확인·불일치면 그리지 않음 · fit3d = 부르는 화면이 명시(MMap 만 · 기본 거짓)
  const note = !on ? '' : is3 ? (gk ? (v3d ? `건물 전체 3D · ${GT}간략 기하(센서·주행 판정 아님) · 위치·SLAM 겹치지 않음` : `건물 3D 미표시 · ${gbind}`)
      : typeof geo === 'string' ? `건물 3D 미표시 · ${geo}` : '건물 3D 기하 받는 중') : isAll ? (saved ? `층 나란히 보기 · ${GT}기하 2D(SLAM·센서 아님) · 위층부터 · 전체 3D 아님 · 위치·격자 표시 없음` : serr ? `층 나란히 보기 미표시 · ${serr}` : '층 나란히 보기 받는 중')
    : !live ? (saved ? '' : serr ? `저장 지도 미표시 · ${serr}` : '저장 지도 받는 중')
    : !fresh ? '연결 끊김·수신 중단 — 실시간 지도·위치 버림(조종 상태와 별개)'
    : !lv || lv.st === 'off' ? '실시간 지도 상태 없음 — «지도 열기»로 지도 시뮬을 열면 들어옵니다'
    : fbShow ? `${place(w0, floorNow!.f)} · ${fbR ? '저장 지도 · 위치 없음 — 실시간 지도가 오면 바뀜' : fb?.k === fbKey && fb.why ? `${fb.why} — 실시간 지도 기다림` : '저장 지도 받는 중'}`
    : lv.st !== 'ok' ? `실시간 지도 미표시 · ${lv.why || lv.st}` : !raster ? (lwhy ? `실시간 지도 미표시 · ${lwhy}` : '실시간 지도 받는 중')
    : held ? `${auto ? '자동 선택 · ' : ''}${liveLabel(lv)} · 지도 갱신 중(${lwhy ? `새 격자 못 받음 · ${lwhy} — 직전 지도` : '새 격자 받는 중'}) — 위치 표시 잠시 끔` : `${auto ? '자동 선택 · ' : ''}${liveLabel(lv)} · ${p ? `위치 ${p.source === 'slam_tf' ? 'SLAM 보정' : `${pc ? '시뮬 위치' : 'GT'}(지도와 같은 좌표)`}` : `위치 미표시 · ${lv.pose_why || '모름'}`}`;
  const blank = on && !raster ? (is3 && v3d ? '건물 전체 3D 는 «지도» 화면에서 봅니다' : note || '지도 없음') : null;   // MapCanvas blank — 지도 보기 중 그림 없음
  // 고른 저장 지도 ≠ 지금 열린 시뮬 지형·층이면 한 줄(보기는 화면만 — 시뮬은 그대로)
  const diff = sm && (!at || at[0] !== sm.building_id || at[1] !== sm.floor_id)
    ? `보는 지도(${place(sm.world_id, sm.floor_id)})는 지금 열린 시뮬${at ? `(${place(ss!.world_id, ss!.floor_id)})` : '(지도 시뮬 꺼짐)'}과 다릅니다 — 보기만 바뀜, 시뮬은 그대로` : '';
  const hLeg = hv && <span aria-label="높이 범례" style={{ display: 'block', fontSize: 10, lineHeight: 1.3, padding: '4px 6px', borderRadius: 4, background: 'rgba(0,0,0,.6)', color: '#DDE5EC', maxWidth: 260 }}>
        <span style={{ display: 'block', height: 8, borderRadius: 2, background: `linear-gradient(90deg, ${[0, 0.25, 0.5, 0.75, 1].map((t) => `hsl(${hHue(t)} 75% 50%)`).join(',')})` }} />
        <span style={{ display: 'flex', justifyContent: 'space-between' }}><span>{`${hv.h.lo.toFixed(1)} m`}</span><span>{`${((hv.h.lo + hv.h.hi) / 2).toFixed(1)}`}</span><span>{`${hv.h.hi.toFixed(1)} m`}</span></span>
        <span style={{ display: 'block' }}>{`층 바닥 기준 높이(층 바닥 = map z ${hv.h.floor_z} m) · 출처 ${GT}기하(센서 아님) · 모름 ${hv.h.unknown}칸 = 회색 그대로 · 색은 이동 가능·벽·위험 판정 아님`}</span>
        <span style={{ display: 'block' }}>{`층 바닥 +${hv.h.band[1]} m 위에서 시작하는 기하(위층 바닥·높은 계단 윗단)는 빠짐 — 계단 상단 높이가 낮게 보일 수 있음`}</span></span>;
  // ── 건물별 목록(흐름 배치): 건물 3행 → 펼치면 (2층 건물) 현재층·1층·2층·전체 보기 탭 → 버전. 누르면 보기 선택만(시뮬·조종 0). 펼침·탭 바꿈 = 배치 변경 → dropAll(기존 규칙)
  const B = pc ? 'btn' : 'lv-btn', tap = (f: () => void) => () => { dropAll(); f(); };
  const selW = isAll || is3 ? sel.slice(4) : sm?.world_id || null, openW = ow ?? selW;
  const segB = (on: boolean, t: string, f: () => void, dis?: string) => <button key={t} type="button" className={`${B}${on ? ' pri' : ''}`} aria-pressed={on} disabled={!!dis} title={dis} onClick={tap(f)}>{t}</button>;
  const vrow = { display: 'flex', gap: 6, flexWrap: 'wrap' } as const;
  const list = <span style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
    <span role="group" aria-label="실행 중 시뮬 보기" style={vrow}>
      {segB(sel === '', pc ? '실행 중 시뮬 바닥' : '실행 중 시뮬 GT 위치', () => pick(''))}{segB(live, '현재 열린 지도(실시간)', () => pick(LIVE))}</span>
    {typeof maps === 'string' && <span style={{ ...vrow, alignItems: 'center' }}><span className="lbl">{`저장 지도 목록 · ${maps}`}</span>
      <button type="button" className={B} disabled={!ready} title={ready ? undefined : '서버 연결 확인 전 — 확인되면 자동으로 1회 받음'} onClick={tap(() => { if (load()) setMaps(null); })}>목록 다시 불러오기</button></span>}
    {maps === null && <span className="lbl">{ready ? '저장 지도 목록 받는 중' : '저장 지도 목록 · 서버 연결 확인 뒤 받음'}</span>}
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span className="lbl">지형</span>
      <select aria-label="살펴볼 지형" className={pc ? 'inp' : 'lv-inp'} value={openW || ''} style={{ width: '100%', minWidth: 0, minHeight: 40, padding: '0 10px', boxSizing: 'border-box', border: '1px solid var(--line2)', borderRadius: 6, background: 'var(--panel2)', color: 'inherit', font: 'inherit' }}
        onChange={(e) => { const w = e.target.value; setOw(w); pickW(w); }}>
        <option value="" disabled>지형을 고르세요</option>
        {(Object.keys(WORLD) as (keyof typeof WORLD)[]).map((w) => <option key={w} value={w}>{WORLD[w]}</option>)}
      </select>
    </label>
    {openW && <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span className="lbl">볼 지도</span>
      <select aria-label="선택한 지형의 지도" className={pc ? 'inp' : 'lv-inp'} style={{ width: '100%', minWidth: 0, minHeight: 40, padding: '0 10px', boxSizing: 'border-box', border: '1px solid var(--line2)', borderRadius: 6, background: 'var(--panel2)', color: 'inherit', font: 'inherit' }}
        value={selW === openW ? sel : ''} onChange={(e) => { dropAll(); pick(e.target.value); }}>
        <option value="" disabled>지도를 고르세요</option>
        {WF[openW].length > 1 && <option value={allKey(openW)}>모든 층 · 2D</option>}
        {openW === 'v5_building' && <option value={`g3d:${openW}`}>건물 전체 · 3D</option>}
        {Array.isArray(maps) && maps.filter((m) => m.world_id === openW).map((m) => <option key={mapKey(m)} value={mapKey(m)}>
          {`${WF[openW].length > 1 ? `${FLOOR[m.floor_id as keyof typeof FLOOR]} · ` : ''}${m.map_source === 'gt_raster' ? '기본 도면' : '저장한 지도'} · ${m.map_version}`}
        </option>)}
      </select>
    </label>}

  </span>;
  // ── U2-b(결정 7): PC 지도 탭 왼쪽 위 «지형 + 2D/3D/SLAM» — 보기 전용(pick 만 · op 는 map_list/map_get/map_live_get/geom_get 읽기뿐).
  // 실행 지형·기동·조종 op 0(시뮬 시작 지형은 조종 화면 «시뮬 실행» 칸). 눌림은 지금 sel 에서 계산(거짓 눌림 0). 3D = 기존 건물 입체 기하(2층 건물만)
  // ── 보완(715 R1~R4, 이 bar 안에서만 — 공용 runAt/liveShow·좌표 정책 무변경)
  // R1: select = 실제 보기의 지형. 볼 지도 없는 지형을 고르면 보기·select 그대로 + «볼 지도 없음 · 보던 화면 그대로» 글(지형만 기억 0)
  // R2: «실행 중»·SLAM 실시간은 이 연결의 유효 status(열림·형식 정상·stGen=gen·수신 1 s 안) + running 일 때만. starting = «시작 중»(실시간 아님) · 그 밖 = «실행 상태 미확인»
  // R3: 최신 = map_version 의 저장 시각(YYYYMMDD-HHMMSS · gt-YYYYMMDD) 순. 같은 시각 여럿 = 선후 모름 → 고정 규칙(epoch 큰 것 → 층 순)으로 하나 + 그 한계를 글로(epoch 는 세션 안 번호 — 전역 시각 아님)
  // R4: 못 보는 단추 = aria-disabled(초점·누름 가능) — 누르면 이유 글만(요청·실행 0)
  const okSt = useLink((x) => !x.bad && x.stGen === x.gen) && fresh;   // 열림은 fresh 안에(open && 수신 1 s 안)
  const runW = at && ss!.world_id! in WORLD ? ss!.world_id! : null, rw = okSt ? runW : null;
  const runTag = (w: string) => w !== runW ? '' : !okSt ? ' · 실행 상태 미확인' : ss!.result === 'running' ? ' · 실행 중' : ' · 시작 중';
  const liveOk = (w: string) => rw === w && ss!.result === 'running' && ss!.map_mode === 'slam';
  const keyW = !on || live ? null : (Object.keys(WORLD) as string[]).find((w) => (BLD as Record<string, string>)[w] === sel.split('/')[0]) ?? null;   // 목록 전 저장본 보기도 지형은 키에서
  const vW = (selW && selW in WORLD ? selW : null) || keyW || (sel === '' || live ? rw : null) || '';   // '' = 지형 미정(«지형 고르기»)
  const last = (w: string, src: string) => {
    const ms = Array.isArray(maps) ? maps.filter((m) => m.world_id === w && m.map_source === src) : []; if (!ms.length) return null;
    const top = ms.reduce((a, m) => (tsOf(m.map_version) > a ? tsOf(m.map_version) : a), '');
    const tie = ms.filter((m) => tsOf(m.map_version) === top).sort((a, b) => (b.epoch ?? 0) - (a.epoch ?? 0) || WF[w].indexOf(a.floor_id) - WF[w].indexOf(b.floor_id));
    return { m: tie[0], note: tie.length > 1 ? `같은 저장 시각 ${tie.length}개 — 선후 모름 · 고정 규칙(epoch 큰 것 → 층 순)으로 ${verLabel(tie[0])} 고름` : '' };
  };
  const noList = Array.isArray(maps) ? '' : typeof maps === 'string' ? `저장 지도 목록 · ${maps}` : '저장 지도 목록 받는 중';
  type Md = { k: string; why: string; note?: string };
  const modes = (w: string): Record<'2D' | '3D' | 'SLAM', Md> => {
    if (!w) { const z = { k: '', why: '지형 먼저 고르기' }; return { '2D': z, '3D': z, SLAM: z }; }
    const g = WF[w].length > 1 ? (Array.isArray(maps) ? gtFloors(maps, w) : noList) : null, gt = last(w, 'gt_raster'), sl = last(w, 'slam');
    const sStart = rw === w && ss!.result === 'starting' && ss!.map_mode === 'slam';
    return { '2D': g !== null ? (typeof g === 'string' ? { k: '', why: g } : { k: allKey(w), why: '' }) : gt ? { k: mapKey(gt.m), why: '', note: gt.note } : { k: '', why: noList || '이 지형 시뮬 도면 지도 없음' },
      '3D': w === 'v5_building' ? { k: `g3d:${w}`, why: '' } : { k: '', why: '입체 기하는 2층 건물만' },
      SLAM: liveOk(w) ? { k: LIVE, why: '' } : sl ? { k: mapKey(sl.m), why: '', note: sl.note } : { k: '', why: noList || `이 지형 저장한 지도 없음${sStart ? ' · SLAM 시뮬 시작 중 — 실행 확인 뒤 실시간' : ''}` } };
  };
  const nowMode = (w: string) => !w ? '' : sel === allKey(w) || (sm?.world_id === w && sm.map_source === 'gt_raster') ? '2D' : sel === `g3d:${w}` ? '3D'
    : (live && liveOk(w)) || (sm?.world_id === w && sm.map_source === 'slam') ? 'SLAM' : '';
  const md = modes(vW), cur = nowMode(vW);
  const go = (d: Md) => { pick(d.k); if (d.note) setMsg({ sel: d.k, t: d.note, tie: true }); };
  const pickW = (w: string) => {   // 지형 바꿈: 지금 방식 → 2D → SLAM → 3D 중 볼 수 있는 첫 것. 없으면 보기·select 그대로 + 이유 글
    const m = modes(w), d = [cur, '2D', 'SLAM', '3D'].filter(Boolean).map((x) => m[x as keyof typeof m]).find((y) => y.k);
    dropAll(); if (d) go(d); else setMsg({ sel, t: `${WORLD[w as keyof typeof WORLD]} — 볼 지도 없음(${(['2D', '3D', 'SLAM'] as const).map((x) => `${x} ${m[x].why}`).join(' · ')}) · 보던 화면 그대로` });
  };
  const segV = (x: '2D' | '3D' | 'SLAM', d: Md) => d.k ? segB(cur === x, x, () => go(d))
    : <button key={x} type="button" className={`${B} lv-why`} aria-disabled="true" aria-pressed={false} title={d.why} onClick={tap(() => setMsg({ sel, t: `${x} 못 봄 · ${d.why}` }))}>{x}</button>;
  // G1(670 관찰 1·6): bar = 지도 그림 칸 밖 흐름 줄(PcMap.view 가 도구줄 아래 · 그림 칸(position:relative) 위에 둠) — 그림 칸 안 3D 층 단추·캔버스 층 이름·안내·오른쪽 단추와 다른 상자(z-index 경쟁 0)
  // G2: 같은 저장 시각 글은 «고름»(선택)까지만 말하고, 받기 결과는 지금 그림으로 따로 — 표시 중 / 받기 실패 / 받는 중(실패에도 «표시» 단정 0)
  const tieR = !raster ? (serr ? ' · 받기 실패 — 그림 없음(가운데 이유)' : ' · 받는 중') : ' · 표시 중';
  // 폰(MMap · pc 아님) = 지도 칸 밖 머리줄 안(live.css .mmap-hdr: 세로 = 지도 바로 위 자기 줄 · 가로 낮은 화면 = 제목 옆 — STOP·지도 최소 96 px 유지 목표 — 실측 0).
  // PC 는 c237425 G1 그대로(도구줄 아래 흐름 줄 · padding·아래 경계선). 폰은 머리줄이 테두리를 가짐 → 여백·선 0. 지형·단추는 안 꺾임(flex 0 0 auto) ·
  // 이유 글(R1·R3·R4): PC = 다음 줄 전문 그대로 · 폰 = 같은 줄 9em 한 줄 + ? 전문(670 a9db ① 가로 낮은 창 header 228 → STOP 화면 밖 보완 · 세로 좁으면 bar 둘째 줄)
  const barSty: React.CSSProperties = pc ? { padding: '6px 10px', borderBottom: '1px solid var(--line)' } : { minWidth: 0 };
  const fix = pc ? {} : { flex: '0 0 auto' };
  const bar = <span data-mapview-bar="" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', ...barSty }}>
    <select aria-label="지도 지형 보기(보기만 · 실행 지형 안 바뀜)" title={`보는 지형만 바뀝니다 — 시뮬 시작 지형은 ${pc ? '조종 화면 «시뮬 실행» 칸' : '«시뮬 실행 · 지도 관리» 서랍의 «시뮬 실행»'}`} value={vW} onChange={(e) => pickW(e.target.value)}
      style={{ ...fix, minHeight: pc ? 32 : 40, font: 'inherit', fontSize: 12, background: 'var(--bg)', color: 'var(--fg, inherit)', border: '1px solid var(--line2)', borderRadius: 6 }}>
      {!vW && <option value="" disabled>지형 고르기</option>}
      {(Object.keys(WORLD) as (keyof typeof WORLD)[]).map((w) => <option key={w} value={w}>{`${WORLD[w]}${runTag(w)}`}</option>)}</select>
    <span role="group" aria-label={`${vW ? WORLD[vW as keyof typeof WORLD] : '지형 미정'} 보기 방식(보기만)`} style={{ display: 'flex', gap: 4, ...fix }}>
      {(['2D', '3D', 'SLAM'] as const).map((x) => segV(x, md[x]))}</span>
    {msg && msg.sel === sel && (pc ? <span role="status" style={{ flexBasis: '100%', fontSize: 11, padding: '2px 6px', borderRadius: 4, background: 'var(--bg)', color: 'var(--warn)' }}>{`${msg.t}${msg.tie ? tieR : ''}`}</span>
      : <span style={{ flex: '1 1 9em', width: '9em', minWidth: 0, display: 'flex', alignItems: 'center', gap: 4 }}>   {/* 670 a9db ①: 폰은 같은 줄 한 칸(머리줄을 여러 줄로 밀지 않음) — 짧은 한 줄 + ? 전문(title·Help 모두 전문 · 내용 소실 0) */}
        <span role="status" title={`${msg.t}${msg.tie ? tieR : ''}`} style={{ minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontSize: 11, padding: '2px 6px', borderRadius: 4, background: 'var(--bg)', color: 'var(--warn)' }}>
          {msg.tie ? `${!raster ? (serr ? '받기 실패' : '받는 중') : '표시 중'} · ${msg.t}` : msg.t}</span>   {/* 동률: 받기 결과(tieR 와 같은 말)를 앞에 — 말줄임에 안 잘림 */}
        <Help label="지도 보기 안내 · 전문">{`${msg.t}${msg.tie ? tieR : ''}`}</Help></span>)}</span>;
  // U2-c: 모든 배치가 흐름(지도 칸 위 겹침 0) — 관제는 오른쪽 칸(drop), 폰 서랍·PC 지도는 목록
  const el = <span style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 4 }}>
    {drop ? <span style={{ fontSize: 11, color: 'var(--muted)' }}>지도 보기<Help label="지도 보기 · 설명">화면만 바뀜 · 시뮬은 그대로</Help></span>   /* 관제(Main)만 drop */
      : pc ? <span style={{ fontSize: 11, color: 'var(--muted)' }}>지도 보기 · 화면만<Help label="지도 보기 · 설명">화면만 바뀝니다 — 시뮬 지형·층·위치는 그대로입니다.</Help></span>   /* U4-a(PcMap): 아래 설명 문단 → ? */
      : <span style={{ fontSize: 11, color: 'var(--muted)' }}>지도 보기(화면만 · 시뮬은 그대로)</span>}
    {drop ? <select aria-label="지도 보기 선택(보기만 · 실제 시뮬 안 바뀜)" title="지도 보기 선택 — 화면만 바뀝니다. 실제 시뮬 지형·조종은 그대로" value={sel}
      onFocus={load} onChange={(e) => pick(e.target.value)}
      style={{ minHeight: drop ? 32 : 44, minWidth: 0, maxWidth: '100%', font: 'inherit', fontSize: 12, background: 'var(--bg)', color: 'var(--fg, inherit)', border: '1px solid var(--line2)', borderRadius: 6 }}>
      <option value="">{touched ? '시뮬 위치' : '시뮬 위치(지도 시뮬이 보이면 실시간 자동)'}</option>
      <option value={LIVE}>현재 열린 지도(실시간 매핑)</option>
      {Array.isArray(maps) && groupMaps(maps).map((g) => <optgroup key={g.w} label={`저장 지도 보기 · ${g.label}`}>
        {WF[g.w].length > 1 && <option value={allKey(g.w)}>층 나란히 보기</option>}
        {g.items.map((m) => <option key={mapKey(m)} value={mapKey(m)}>{verLabel(m)}</option>)}</optgroup>)}
      {typeof maps === 'string' && <option disabled value="-">{`저장 지도 목록 · ${maps}`}</option>}
      {Array.isArray(maps) && !maps.length && <option disabled value="-">저장 지도 없음</option>}
    </select> : list}
    <span style={{ fontSize: 11, padding: '2px 6px', borderRadius: 4, background: 'var(--bg)', color: 'var(--muted)' }}>{`${drop ? '받은 시뮬 상태(조회값 · 지금 실행 확정 아님)' : '지금 열린 시뮬'} · ${runLine(ss)}`}</span>   {/* U2-c: 관제에도 — 보는 지도와 실행 지형 구별 · drop(관제만): 받은 session 조회값이라 현재 실행 확정 아님(공용 runLine·다른 화면 글 그대로) */}
    {diff && drop && <span role="status" style={{ fontSize: 11, padding: '2px 6px', borderRadius: 4, background: 'var(--bg)', color: 'var(--warn)' }}>보는 지도 ≠ 실행 지도<Help label="보는 지도 · 실행 지도 차이">{diff}</Help></span>}
    {diff && !drop && <span role="status" style={{ fontSize: 11, padding: '2px 6px', borderRadius: 4, background: 'var(--bg)', color: 'var(--warn)' }}>{diff}</span>}
    {gt && <label style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 11, padding: '2px 6px', borderRadius: 4, background: 'var(--bg)' }}>
      <input type="checkbox" checked={hOn} onChange={(e) => { setHOn(e.target.checked); setHr(null); }} />{`높이 색(${GT}기하 · 센서 아님)`}</label>}
    {hOn && gt && (typeof hr === 'string' ? <span role="status" style={{ fontSize: 11, padding: '2px 6px', borderRadius: 4, background: 'var(--bg)', color: 'var(--warn)' }}>{`높이 미표시 · ${hr}`}</span>
      : !hv ? <span style={{ fontSize: 11, padding: '2px 6px', background: 'var(--bg)', color: 'var(--muted)' }}>높이 받는 중</span>
      : hLeg)}
    {note && <span role="status" style={{ fontSize: 11, padding: '2px 6px', borderRadius: 4, background: 'var(--bg)', color: `var(--${raster ? 'muted' : 'warn'})` }}>{isAll && raster ? <>여러 층의 2D 지도<Help label="2D 지도 설명">{note}</Help></> : note}</span>}
  </span>;
  const showLive = () => pick(LIVE);   // 지도 체험 시작 수락 뒤 «실시간 지도 보기»(화면만 — 시작·조종 0)
  // GT 바닥 도면(±10 m 평지)이라고 쓰는 건 지금 켜진 쪽이 원본 평지 체험일 때만(지도 체험·모름이면 «지형 도면 없음»)
  const runner = useLink((x) => (x.st?.map_start?.session as any)?.runner), flat = runner === 'live_v2' || runner === 'ux_flat';
  return { maps, v3d, legend: hLeg || null, raster, pickEl: el, pose, live, on, blank, showLive, reload: load, flat, auto, view: pick, bar };
}
