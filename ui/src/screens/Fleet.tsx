// #/Fleet — PC 전체 관제(새 기획 10-18, SPEC §2·§3). 리허설(저장 설계도의 배치안 보기·비교) | 현장 관제(연결 로봇 상태 + 실측 궤적 별도 패널).
// 새 명령 경로 0: STOP = 기존 stopProps(stopNow) · 조종은 #/Main 으로 이동만. 계획 지도 위에 실측 궤적·실제 위치를 얹지 않음(좌표 정합 근거 없음 — root 10-18).
// 비교 값은 API 가 준 것만(analyze) — 예상 시간·센서 범위 같은 행은 만들지 않음. «추천» 0.
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { ModeBand, ModeSwitch, PcFrame, SourceTag, listErr, liveOf, saveMode, savedMode, useProject, useProjects, useSavedAnalysis, useWidth, type Mode } from '../app/fleetui';
import { Chip } from '../app/chip';
import { camChip, useHeadChips } from '../app/status';
import { Drawer, stopProps } from '../app/shell';
import { TRAIL, linkView, useLink } from '../data/link';
import { alertsOf, useMedia } from '../data/shared';
import { type Analysis, type Exported, type Scenario, type Scene, SH, brokenTxt, damagedTxt, kib, r3, rcall, saveExport, EXPORT_NOTE } from '../data/rehearsal';
import { ctx } from '../data/scratch';
import { type Focus, SceneCanvas, robotTags } from '../map/SceneCanvas';
import { MapCanvas } from '../map/MapCanvas';

/** 배치안별 비교 값(API analyze 결과만 · 화면 계산은 합·최댓값·개수 세기뿐) */
export function compareRows(s: Scene, a: Analysis) {
  const ar = new Map(a.routes.map((r) => [r.id, r]));
  return s.scenarios.map((sc) => {
    const rs = sc.routes.map((id) => ar.get(id)).filter((x): x is Analysis['routes'][number] => !!x);
    const per = new Map<string, number>(); for (const r of rs) per.set(r.robot, (per.get(r.robot) || 0) + r.length_m);
    return {
      id: sc.id, name: sc.name, robots: sc.robots.length,
      sum: r3(rs.reduce((t, r) => t + r.length_m, 0)), max: r3(Math.max(0, ...per.values())),
      blocked: rs.reduce((t, r) => t + r.blocked_segments.length, 0), unreach: rs.reduce((t, r) => t + r.unreachable_points.length, 0),
      cross: a.crossings.filter((x) => x.scenario === sc.id).length,
      missing: sc.routes.length - rs.length,   // 분석 결과에 없는 경로 → 길이·막힘·연결 없음 값은 일부(부분값)
      crossPart: a.truncated,                  // 교차 목록이 200건에서 잘림 → 교차 수는 일부
    };
  });
}

function PlanCompare({ s, a, pid, rev }: { s: Scene; a: Analysis; pid: string; rev: number }) {
  const rows = compareRows(s, a);
  const [exp, setExp] = useState(''), [busy, setBusy] = useState(false);
  type K = 'sum' | 'max' | 'blocked' | 'unreach' | 'cross';
  const part = (r: (typeof rows)[number], k: K) => (k === 'cross' ? r.crossPart : r.missing > 0);   // 부분값: «≥n · 일부» — 0 이 온전한 값으로 읽히지 않게
  const minOf = (k: K) => Math.min(...rows.map((r) => r[k]));
  const cell = (r: (typeof rows)[number], k: K, unit = '') => { const p = part(r, k), v = r[k];
    return <td className="mono" style={{ padding: '6px 8px', fontWeight: rows.length > 1 && !rows.some((x) => part(x, k)) && v === minOf(k) ? 700 : 400 }}>{p ? `≥${v}${unit} · 일부` : `${v}${unit}`}</td>; };
  // 내보내기 응답·다운로드는 이 요청(같은 프로젝트·판·계정·화면)에만 — 바뀌면 버림
  const seq = useRef(0);
  useEffect(() => { setBusy(false); setExp(''); return () => { seq.current++; }; }, [pid, rev]);
  const doExport = async () => {
    if (busy) return; setBusy(true); setExp('');
    const my = ++seq.current, cx = ctx.n, ok = () => my === seq.current && cx === ctx.n;
    const r = await rcall<Exported>({ op: 'export', id: pid, rev }, SH.export);
    if (!ok()) return;
    if (!r.ok) { setBusy(false); return setExp(`내보내기 실패 · ${r.error}`); }
    if (r.data.project.id !== pid || r.data.project.rev !== rev) { setBusy(false); return setExp(`내보내기 응답이 요청한 판이 아님(요청 ${pid} r${rev} · 받음 ${r.data.project.id} r${r.data.project.rev}) — 저장하지 않음`); }
    const t = await saveExport(r.data, ok);
    if (!ok()) return; setBusy(false);
    if (t) setExp(`${r.data.filename} · ${kib(r.data.bytes)} KiB · sha256 ${r.data.sha256.slice(0, 16)}… · ${t}`);
  };
  const th = (t: string, tag?: React.ReactNode) => <th scope="row" style={{ textAlign: 'left', padding: '6px 8px', fontWeight: 500, fontSize: 13 }}>{t} {tag}</th>;
  return <div style={{ display: 'grid', gap: 8 }}>
    <h2 style={{ margin: 0, fontSize: 15 }}>배치안 비교</h2>
    <p style={{ margin: 0, fontSize: 13 }}>{a.note}</p>
    {a.truncated && <p style={{ margin: 0, fontSize: 13 }}>경고·교차가 200건을 넘어 일부만 왔습니다 — 교차 수는 «일부»</p>}
    {!a.ok && <p style={{ margin: 0, fontSize: 13 }}>검토 오류가 있어 경로 값이 없습니다 — 편집기에서 오류를 고친 뒤 저장하세요</p>}
    {!rows.length ? <p style={{ margin: 0 }}>배치안이 없습니다 — 지도 편집에서 배치안을 만드세요</p> : <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', fontSize: 13, minWidth: '100%' }}>
        <thead><tr><th />{rows.map((r) => <th key={r.id} scope="col" style={{ padding: '6px 8px', textAlign: 'left' }}>{r.name}</th>)}</tr></thead>
        <tbody>
          <tr>{th('로봇 수', <SourceTag k="plan" />)}{rows.map((r) => <td key={r.id} className="mono" style={{ padding: '6px 8px' }}>{r.robots}</td>)}</tr>
          <tr>{th('경로 길이 합', <SourceTag k="geo" />)}{rows.map((r) => <Fragment key={r.id}>{cell(r, 'sum', ' m')}</Fragment>)}</tr>
          <tr>{th('가장 긴 로봇', <SourceTag k="geo" />)}{rows.map((r) => <Fragment key={r.id}>{cell(r, 'max', ' m')}</Fragment>)}</tr>
          <tr>{th('막힌 구간 수', <SourceTag k="geo" />)}{rows.map((r) => <Fragment key={r.id}>{cell(r, 'blocked')}</Fragment>)}</tr>
          <tr>{th('연결 없는 점 수', <SourceTag k="geo" />)}{rows.map((r) => <Fragment key={r.id}>{cell(r, 'unreach')}</Fragment>)}</tr>
          <tr>{th('경로 교차 수', <SourceTag k="geo" />)}{rows.map((r) => <Fragment key={r.id}>{cell(r, 'cross')}</Fragment>)}</tr>
          <tr>{th('모든 지점 도달 · 넘어짐/막힘')}{rows.map((r) => <td key={r.id} style={{ padding: '6px 8px' }}><SourceTag k="unmeasured" /></td>)}</tr>
        </tbody>
      </table></div>}
    {rows.some((r) => r.missing) && <p className="lbl" style={{ margin: 0 }}>검토 결과에 없는 경로가 있어 «일부» 칸은 그 경로를 빼고 센 값입니다(실제는 같거나 더 큼)</p>}
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      <a className="btn" href={`#/MapEditor?id=${encodeURIComponent(pid)}`} style={{ textDecoration: 'none', color: 'inherit', minHeight: 44 }}>편집기에서 열기</a>
      <button type="button" className="btn" disabled={busy} onClick={doExport} style={{ minHeight: 44 }}>{busy ? '내보내는 중…' : `세계·지도 묶음 내보내기 (r${rev})`}</button>
    </div>
    <p className="lbl" style={{ margin: 0 }}>Gazebo 기동은 사용자가 합니다 · 내보낸 묶음 사용</p>
    {exp && <p role="status" style={{ margin: 0, fontSize: 13 }}>{exp}<br /><span className="lbl">{EXPORT_NOTE}</span></p>}
  </div>;
}
/** 실측 궤적 — 기존 live map 좌표(GT)만. 계획 지도와 겹치지 않고 거리·지남 계산 0 */
export function LiveTrailPanel({ small = true }: { small?: boolean }) {
  const L = useLink(), v = linkView(L);
  return <div style={{ display: 'grid', gap: 6 }}>
    <h2 style={{ margin: 0, fontSize: 15 }}>실측 궤적 · 기존 연결 대상</h2>
    <p style={{ margin: 0, fontSize: 13 }}>좌표 정합 미확인 · 계획 지도와 겹치지 않습니다</p>
    {/* MapCanvas 는 absolute·inset 0 — 호출자가 위치 기준·크기를 줘야 패널 안에 머묾(715 U5, Field 와 같은 방식) */}
    <div style={{ position: 'relative', height: 240, overflow: 'hidden', borderRadius: 8 }}><MapCanvas name="fleet-live" small={small} trail={TRAIL.pts} robot={v.robot} showTrail /></div>
  </div>;
}

function LiveCard({ s, sc, pair, setPair }: { s: Scene | null; sc: Scenario | null; pair: string; setPair: (x: string) => void }) {
  const v = linkView(useLink()), chips = useHeadChips(), cam = camChip(v), body = !!v.s;   // 관문이 살아 있을 때(v.linkOk)만 그려짐 · 로봇 연결은 몸 상태(v.s)가 있을 때만
  const tags = s ? robotTags(s, sc) : new Map(), pt = pair ? tags.get(pair) : undefined;
  return <article className="card" style={{ padding: 12, display: 'grid', gap: 8, borderStyle: 'solid', borderColor: 'var(--accent)' }}>
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <strong>{pt ? pt.tag : body ? '연결 로봇' : '관문 현재 대상'}</strong><span>{body ? '시뮬 로봇' : '몸 상태 미확인 · 연결 로봇 0대'}</span><SourceTag k={body ? 'live_sim' : 'unmeasured'} />
    </div>
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>{chips.map((c) => <Chip key={c.k} tone={c.tone} text={c.text} why={c.why} />)}</div>
    <Chip tone={cam.tone} text={cam.text} why={cam.why} />
    <span className="lbl">조종권 회수 규칙 미정</span>
    {sc && <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>짝짓기(이름표만)
      <select className="inp" value={pair} onChange={(e) => setPair(e.target.value)} style={{ minHeight: 44 }}>
        <option value="">짝짓지 않음</option>
        {sc.robots.map((id) => <option key={id} value={id}>{`이 연결을 ${tags.get(id)?.tag} 로 보기 · ${s?.robots.find((r) => r.id === id)?.name || id}`}</option>)}
      </select></label>}
    {pair && <span className="lbl">좌표 정합 미확인 — 이름표만 같음</span>}
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <a className="btn" href="#/Main" style={{ textDecoration: 'none', color: 'inherit', minHeight: 44 }}>조종 화면</a>
      <div style={{ flex: 1 }} />
      <button type="button" {...stopProps} style={{ minHeight: 44, minWidth: 88, border: 0, borderRadius: 8, background: 'var(--stop)', color: '#FFFFFF', fontWeight: 700, letterSpacing: '.06em' }}>STOP</button>
    </div>
  </article>;
}

function PlanCard({ s, sc, a, id, tag, i, on, show }: { s: Scene; sc: Scenario; a: Analysis | null; id: string; tag: string; i: number; on: boolean; show: () => void }) {
  const r = s.robots.find((x) => x.id === id);
  if (!r) return null;
  const mine = (a?.routes || []).filter((x) => x.robot === id && sc.routes.includes(x.id));
  const part = !!a && (a.truncated || sc.routes.some((rid) => s.routes.find((x) => x.id === rid)?.robot === id && !a.routes.some((x) => x.id === rid)));   // 잘림·빠진 경로 → 부분값
  const warn = mine.reduce((t, x) => t + x.blocked_segments.length + x.unreachable_points.length, 0) + (a?.crossings || []).filter((x) => x.scenario === sc.id && (mine.some((m) => m.id === x.a || m.id === x.b))).length;
  return <article className="card" style={{ padding: 12, display: 'grid', gap: 6, borderStyle: 'dashed', borderColor: on ? 'var(--accent)' : 'var(--line2)' }}>
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><strong>{tag}</strong><span>{r.name}</span><SourceTag k="plan" /></div>
    <span style={{ fontSize: 13 }}>{`${s.floors.find((f) => f.id === r.floor)?.name || r.floor} · 출발 (${r.pose[0]}, ${r.pose[1]}) · ${Math.round((r.pose[2] * 180) / Math.PI)}°`}</span>
    {a ? <span style={{ fontSize: 13 }}>{`경로 길이 ${part ? '≥' : ''}${r3(mine.reduce((t, x) => t + x.length_m, 0))} m${part ? ' · 일부' : ''} `}<SourceTag k="geo" /></span> : <span className="lbl">경로 길이 · 검토 결과 없음</span>}
    {a && <span style={{ fontSize: 13 }}>{`경고 ${part ? '≥' : ''}${warn}건(막힘·연결 없음·교차)${part ? ' · 일부(검토 결과 잘림·빠진 경로)' : ''}`}</span>}
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <button type="button" className="btn" onClick={show} style={{ minHeight: 44 }}>지도에서 보기</button>
      <span className="lbl">연결 없음 · 이 카드 조작은 로봇 명령 없음</span>
    </div>
  </article>;
}

export default function Fleet() {
  const W = useWidth(), L = useLink(), v = linkView(L), M = useMedia();
  const [mode, setModeS] = useState<Mode>(() => savedMode() || (v.s ? 'live' : 'rehearsal'));   // 몸 상태가 있을 때만 관제로 시작(관문만 떠 있으면 리허설)
  const setMode = (m: Mode) => { setModeS(m); saveMode(m); };
  const P = useProjects();
  const [pid, setPid] = useState<string | null>(null), [scId, setScId] = useState<string | null>(null);
  const G = useProject(pid), s = G.st === 'ok' ? G.data!.scene : null, meta = G.st === 'ok' ? G.data!.project : null;
  const A = useSavedAnalysis(meta?.id || null, meta?.rev || null), an = A.st === 'ok' ? A.data : null;
  const [floor, setFloor] = useState(''), [focus, setFocus] = useState<Focus>(null), [pair, setPair] = useState(''), [sel, setSel] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);
  useEffect(() => { if (s) { setFloor(s.floors[0]?.id || ''); setScId(s.scenarios[0]?.id || null); setPair(''); } }, [s]);
  const sc = s?.scenarios.find((x) => x.id === scId) || null, tags = useMemo(() => (s ? robotTags(s, sc) : new Map<string, { tag: string; i: number }>()), [s, sc]);
  const projects = P.st === 'ok' ? P.data!.projects : [], broken = P.st === 'ok' ? brokenTxt(P.data!) : null, damaged = P.st === 'ok' ? damagedTxt(P.data!) : null;
  const listRev = pid ? projects.find((p) => p.id === pid)?.rev : undefined, gone = P.st === 'ok' && !broken && !!pid && listRev === undefined;
  const direct = L.provider !== 'simulation_gate';   // 실기 Go2 선택 — 직접 연결 미구현이라 연결 0대(linkView 가 linkOk=false 로 줌)
  const wide = W >= 1280, mid = W >= 960;

  const head = <>
    <label className="lbl" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>프로젝트
      <select className="inp" style={{ width: 200, minHeight: 44 }} value={pid || ''} onChange={(e) => setPid(e.target.value || null)} disabled={P.st !== 'ok'}>
        <option value="">{P.st === 'loading' ? '읽는 중…' : P.st === 'err' ? '불러오지 못함' : broken ? '저장소 이상' : projects.length ? '고르세요' : '없음'}</option>
        {projects.map((p) => <option key={p.id} value={p.id}>{`${p.name} · r${p.rev}`}</option>)}
      </select></label>
    {/* 목록·계획 다시 읽기 = 누를 때만(자동 폴링·자동 새 판 전환 0) · 고른 프로젝트·배치안은 그대로(WORDING-CHECK §2) */}
    <button type="button" className="btn" onClick={P.reload} disabled={P.st === 'loading'} style={{ minHeight: 44 }}>목록 새로 읽기</button>
    {gone && <span role="status" className="lbl">고른 프로젝트가 목록에 없습니다</span>}
    {meta && <span className="lbl">{`읽은 판 r${meta.rev}${listRev && listRev !== meta.rev ? ` · 목록은 r${listRev}(계획 다시 읽기로 바꿈)` : ''}`}</span>}
    {meta && <button type="button" className="btn" onClick={G.reload} style={{ minHeight: 44 }}>계획 다시 읽기</button>}
    <label className="lbl" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>배치안
      <select className="inp" style={{ width: 160, minHeight: 44 }} value={scId || ''} onChange={(e) => setScId(e.target.value || null)} disabled={!s}>
        <option value="">{s ? '전체' : '—'}</option>
        {s?.scenarios.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
      </select></label>
    <ModeSwitch mode={mode} set={setMode} />
    <a className="btn" href="#/Main" style={{ textDecoration: 'none', color: 'inherit', minHeight: 44 }}>조종 화면</a>
    {!wide && mid && <button type="button" className="btn" onClick={() => setDrawer(true)} style={{ minHeight: 44 }}>{mode === 'rehearsal' ? '비교' : '경고'}</button>}
  </>;

  // ---- 가운데: 계획 지도 ----
  const center = P.st === 'loading' || P.st === 'idle' ? <p>리허설 저장소 읽는 중…</p>
    : P.st === 'err' ? <div role="alert" style={{ display: 'grid', gap: 8, justifyItems: 'start' }}><p style={{ margin: 0 }}>{listErr(P.code, P.error)}</p><button type="button" className="btn" onClick={P.reload} style={{ minHeight: 44 }}>다시 시도</button></div>
    : broken ? <div role="alert" style={{ display: 'grid', gap: 8, justifyItems: 'start' }}><p style={{ margin: 0 }}>{broken}</p><button type="button" className="btn" onClick={P.reload} style={{ minHeight: 44 }}>다시 읽기</button></div>
    : !projects.length ? <div style={{ display: 'grid', gap: 8, justifyItems: 'center', padding: 40 }}><p style={{ margin: 0 }}>{damaged ? '열 수 있는 리허설 프로젝트가 없습니다' : '리허설 프로젝트가 없습니다'}</p>{damaged && <p role="alert" style={{ margin: 0, fontSize: 13 }}>{damaged}</p>}<a className="btn" href="#/MapEditor" style={{ textDecoration: 'none', color: 'inherit', minHeight: 44 }}>지도 편집에서 만들기</a></div>
    : !pid ? <div><p>위에서 프로젝트를 고르세요</p>{damaged && <p role="alert" style={{ fontSize: 13 }}>{damaged}</p>}</div>
    : G.st === 'err' ? <div role="alert" style={{ display: 'grid', gap: 8, justifyItems: 'start' }}><p style={{ margin: 0 }}>{`프로젝트를 불러오지 못했습니다 · ${G.error}`}</p><button type="button" className="btn" onClick={G.reload} style={{ minHeight: 44 }}>다시 시도</button></div>
    : !s ? <p>프로젝트 읽는 중…</p>
    : <div style={{ display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <span className="lbl">층</span>
        {s.floors.map((f) => <button key={f.id} type="button" className="tool" aria-pressed={floor === f.id} onClick={() => setFloor(f.id)} style={{ minHeight: 44 }}>{f.name}</button>)}
        <span className="lbl" style={{ marginLeft: 'auto' }}>점선 = 계획 · R1/R2/R3 = 배치안 안 순서 · 굵은 갈색 = 막힌 구간 · ▲ 연결 없는 점 · 원 = 경로 교차(같은 층)</span>
      </div>
      <SceneCanvas scene={s} floor={floor} scenario={sc} analysis={mode === 'rehearsal' ? an : null} issues={[]} focus={focus} sel={sel ? { k: 'robot', id: sel } : null}
        height={mid ? 'calc(100vh - 260px)' : 360} label={`계획 지도 · ${s.name}${sc ? ` · ${sc.name}` : ''}`} />
      {A.st === 'err' && <p className="lbl" style={{ margin: 0 }}>{`검토 결과를 받지 못했습니다 · ${A.error}`}</p>}
    </div>;

  // ---- 왼쪽: 로봇 목록 ----
  const robots = <div style={{ display: 'grid', gap: 10, alignContent: 'start', ...(mid ? {} : { gridAutoFlow: 'column', gridAutoColumns: 'minmax(260px, 80%)', overflowX: 'auto' }) }}>
    {mode === 'live' && (v.linkOk ? <LiveCard s={s} sc={sc} pair={pair} setPair={setPair} />
      : <p style={{ margin: 0 }}>{`연결 로봇 0대 · ${liveOf(v, direct).txt}${direct ? ' · 조종 미지원' : ''}`}</p>)}
    {s && sc ? sc.robots.map((id) => { const t = tags.get(id); return t && <PlanCard key={id} s={s} sc={sc} a={an} id={id} tag={t.tag} i={t.i} on={sel === id}
      show={() => { const r = s.robots.find((x) => x.id === id); if (!r) return; setSel(id); setFloor(r.floor); setFocus({ at: [r.pose[0], r.pose[1]], n: Date.now() }); }} />; })
      : s && <p className="lbl" style={{ margin: 0 }}>배치안을 고르면 계획 로봇이 보입니다</p>}
  </div>;

  // ---- 오른쪽 판 ----
  const al = alertsOf(M).slice(0, 50), ptag = pair ? tags.get(pair)?.tag : '';
  const right = mode === 'rehearsal'
    ? (s && meta && an ? <PlanCompare s={s} a={an} pid={meta.id} rev={meta.rev} /> : s && A.st === 'loading' ? <p>검토 결과 읽는 중…</p> : <p>배치안 비교 · 프로젝트를 고르면 서버 검토 결과로 채웁니다</p>)
    : <div style={{ display: 'grid', gap: 12 }}>
      <section style={{ display: 'grid', gap: 6 }}>
        <h2 style={{ margin: 0, fontSize: 15 }}>경고</h2>
        {!M.ok ? <p style={{ margin: 0 }}>{M.err || '서버 기록 읽는 중…'}</p> : !al.length ? <p style={{ margin: 0 }}>경보 사건 없음(서버 최근 300건 중)</p>
          : <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 4, maxHeight: 240, overflow: 'auto' }}>{al.map((e, i) => <li key={i} style={{ fontSize: 13 }}>
            <span aria-hidden="true" style={{ color: e.st === 'bad' ? 'var(--bad)' : 'var(--warn)' }}>{e.st === 'bad' ? '■ ' : '▲ '}</span>{`${ptag || '연결 로봇'} · ${e.text}`}</li>)}</ul>}
      </section>
      {!sc && <p style={{ margin: 0 }}>배치안 없음 · 위에서 프로젝트·배치안을 고르세요</p>}
      <LiveTrailPanel />
    </div>;

  const grid: React.CSSProperties = wide ? { display: 'grid', gridTemplateColumns: '300px minmax(0,1fr) 380px', gap: 12, padding: 12 }
    : mid ? { display: 'grid', gridTemplateColumns: '300px minmax(0,1fr)', gap: 12, padding: 12 } : { display: 'grid', gap: 12, padding: 12 };
  return (
    <PcFrame cur="Fleet" title={s ? s.name : '관제'} head={head}>
      <ModeBand mode={mode} live={liveOf(v, direct)} />
      <div style={grid}>
        {robots}
        <section style={{ minWidth: 0 }}>{center}</section>
        {(wide || !mid) && <aside className="card" style={{ padding: 12, alignSelf: 'start' }}>{right}</aside>}
      </div>
      {drawer && !wide && mid && <Drawer title={mode === 'rehearsal' ? '배치안 비교' : '경고 · 실측 궤적'} onClose={() => setDrawer(false)}>{right}</Drawer>}
    </PcFrame>
  );
}
