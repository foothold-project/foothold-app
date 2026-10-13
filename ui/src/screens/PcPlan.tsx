// PC 임무 계획(원본 지도·경로·점검 틀 그대로) — web/live.js pagePcPlan 과 같은 규칙.
// 저장은 서버 문서(kind 'mission') · 409/404 에도 초안 유지(editor). «수동 진행 시작»은 기록을 시작할 뿐 로봇을 움직이지 않는다.
// 경로 검사(Nav2)·시간 예측·배터리·도착 반경/방향·자동 후퇴·경보 규칙은 미연결 — 원본 자리에 이유를 둔다.
import { useEffect, useRef, useState } from 'react';
import type { Mission } from '@contracts';
import { CSS, View } from './PcPlan.view';
import { themeClass } from '../data/fmt';
import { activeRun, docById, docsOf, useDocs } from '../data/shared';
import { useEditor } from '../data/editor';
import { linkView, useLink } from '../data/link';
import { LIVE_MODS, MISSING_T, RULE_WHY, defMods, modDetail, tmplOf, tmpls } from '../data/tmpl';
import { STOP_FACT, WHY } from '../data/facts';
import { legLen, r2, startRun, zoneTxt, zonesAt } from '../data/run';
import { href } from '../data/hist';
import { MapCanvas } from '../map/MapCanvas';
import { LiveStatus } from '../app/status';
import { stopProps, toast, useRoute } from '../app/shell';

type Tool = 'sel' | 'add' | 'measure';
const GOTO = WHY['자동 목적지 이동·자동 복귀'];
const OV = { display: 'flex', alignItems: 'center', gap: '6px', height: '30px', padding: '0 10px', borderRadius: '6px', background: 'var(--panel)', border: '1px solid var(--line2)', fontSize: '12px' } as const;
const dot = (good: boolean) => <span style={{ color: good ? 'var(--ok)' : 'var(--warn)' }}>{good ? '●' : '▲'}</span>;
const chip = (k: string, val: string, good: boolean) => (
  <div className={`chip ${good ? 'ok' : 'warn'}`} key={k}><span className="mk">{good ? '●' : '▲'}</span><span style={{ color: 'var(--muted)' }}>{k}</span><span className="mono" style={{ fontWeight: 600 }}>{val}</span></div>);

export default function PcPlan() {
  const D = useDocs(), L = useLink(), lk = linkView(L), st = L.st, E = useEditor<Mission>('mission'), { q, setQ } = useRoute();
  const [tool, setTool0] = useState<Tool>('add'), [wsel, setWsel] = useState<number | null>(null), [meas, setMeas] = useState<number[][]>([]);
  const want = q.get('mission') || '', shown = useRef<string | null>(null);   // shown: 주소에 이미 반영한 id(새로 저장된 id 만 주소에 씀)
  const blank = (): Mission => ({ name: '', tmpl: q.get('tmpl') || 'base', memo: '', wps: [] });
  if (!E.d) E.d = blank();   // 문서 읽기 전 첫 그리기용(다시 그리기 없이)
  const d = E.d, ws = d.wps, run = activeRun(D), len = legLen(ws);

  useEffect(() => {   // 고른 계획을 편집기에 · 다른 기기가 고친 새 판은 깨끗할 때만 반영 · 저장 뒤 주소에 id
    if (want && E.id !== want && !E.dirty) { const x = docById(D, want); if (x) { E.load(x); shown.current = x.id; setWsel(null); return; } }
    const sc = E.stale(D); if (sc && !E.dirty) E.load(sc);
    if (E.id && E.id !== shown.current) { shown.current = E.id; if (want !== E.id) setQ('mission', E.id); }   // 저장(새 문서)으로 생긴 id 만 — 사용자가 연 주소는 덮지 않음
  });
  useEffect(() => { const f = (e: BeforeUnloadEvent) => { if (E.dirty) e.preventDefault(); }; addEventListener('beforeunload', f); return () => removeEventListener('beforeunload', f); }, [E]);

  const edit = (f: () => void) => { f(); E.dirty = true; E.touch(); };
  const setTool = (t: Tool) => { setTool0(t); setMeas([]); };
  const openPlan = (id: string) => {
    if (E.dirty && !confirm('저장 안 한 수정이 있습니다. 버릴까요?')) return;
    E.load(docById(D, id) || null, blank()); shown.current = E.id; setWsel(null); setQ('mission', id);
  };
  const onTap = (x: number, y: number, k: number) => {
    if (tool === 'add') { if (ws.length >= 30) return toast('지점은 30개까지'); if (!tmplOf(D, d.tmpl)) toast(`${MISSING_T} · 이 지점 할 일은 비워 둠`); edit(() => ws.push({ x: r2(x), y: r2(y), name: '', mods: defMods(D, d.tmpl) })); setWsel(ws.length - 1); }
    else if (tool === 'measure') setMeas((m) => (m.length >= 2 ? [[r2(x), r2(y)]] : [...m, [r2(x), r2(y)]]));
    else { const i = ws.findIndex((w) => Math.hypot(w.x - x, w.y - y) * k < 16); setWsel(i < 0 ? null : i); }
  };
  const toZone = (ty: string) => {
    if (st?.role === 'control') return toast('조종 중입니다 — 조종권 반납 뒤 지도 화면으로');
    if (E.dirty && !confirm('저장 안 한 계획 수정이 있습니다. 지도 화면으로 갈까요?')) return;
    E.dirty = false; location.hash = href('PcMap', { draw: ty });
  };
  const loadPrev = () => {
    const r = docsOf(D, 'run')[0]; if (!r) return toast('지난 수동 진행 기록이 없습니다');
    if (ws.length && !confirm(`지금 지점 ${ws.length}개를 «${r.doc.name}» 기록의 지점 ${r.doc.wps.length}개로 바꿀까요?`)) return;
    edit(() => { d.wps = r.doc.wps.slice(0, 30).map((w) => ({ x: w.x, y: w.y, name: w.name, mods: w.mods.slice() })); }); setWsel(null);
  };
  const mv = (i: number, s: number) => { const j = i + s; if (j < 0 || j >= ws.length) return; edit(() => { [ws[i], ws[j]] = [ws[j], ws[i]]; }); setWsel(j); };
  const save = async () => {
    if (!d.name.trim()) { document.getElementById('pname')?.focus(); return toast('계획 이름을 넣으세요'); }
    if (!ws.length) return toast('지도에서 지점을 1개 이상 찍으세요');
    ws.forEach((w, i) => { if (!w.name.trim()) w.name = `지점 ${i + 1}`; });
    await E.save();
  };
  const start = async () => {
    if (run) { location.hash = href('Main'); return; }
    let same = true;   // 응답 사이 다른 계획을 열었거나 고쳤으면 화면은 그대로(초안 보존), 결과만 알림
    const r = await startRun(D, E.id, async (m) => { const w = await E.write(m); if (w) same = w.same; return w && w.r; });
    if (!r) return;
    if (same && !E.dirty) location.hash = href('Main'); else toast('수동 진행은 시작됨 · 모든 기기 공유 — 그사이 화면·계획이 바뀌어 자동으로 옮기지 않음(관제에서 기록)');
  };

  // ---- 경로 목록(원본 .wp 줄) ----
  const T = tmplOf(D, d.tmpl);
  let cum = 0;
  const rows = ws.map((w, i) => {
    if (i) cum += Math.hypot(w.x - ws[i - 1].x, w.y - ws[i - 1].y);
    const head = [<span key="h" aria-hidden="true" style={{ color: 'var(--muted)' }}>⋮⋮</span>];
    const dist = <span key="m" className="mono lbl">{`${cum.toFixed(1)} m`}</span>;
    if (i !== wsel) {
      const zin = zonesAt(D, w.x, w.y).length;
      return <div key={i} className="wp" style={{ cursor: 'pointer' }} tabIndex={0} onClick={() => setWsel(i)} onKeyDown={(e) => { if (e.key === 'Enter') setWsel(i); }}>
        {head}<span className="num mono">{i + 1}</span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 }}>
          <span style={{ fontSize: '13px', fontWeight: 600 }}>{w.name || `지점 ${i + 1}`}</span>
          <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
            {(w.mods.length ? w.mods : ['이동만']).map((m) => <span key={m} className="act">{m}</span>)}
            {zin ? <span className="act">{`▲ ${zoneTxt(D, w.x, w.y)}`}</span> : null}
          </div>
        </div>{dist}
      </div>;
    }
    const ro = (id: string, t: string) => <input id={id} className="inp mono" value="미연결" readOnly title={`${t} — ${GOTO} · 도착은 운영자가 «방문 확인»으로 기록`} />;
    const sb = (t: string, f: () => void, lab?: string) => <button type="button" className="btn sm" aria-label={lab} onClick={f}>{t}</button>;
    return <div key={i} className="wp sel" style={{ gridTemplateColumns: '18px 28px 1fr auto' }}>
      {head}<span className="num mono" style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>{i + 1}</span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 }}>
        <input className="inp" value={w.name} maxLength={40} placeholder={`지점 ${i + 1} 이름`} aria-label={`지점 ${i + 1} 이름`} onChange={(e) => edit(() => { w.name = e.target.value; })} />
        <span className="lbl">이 지점에서 할 일</span>
      </div>{dist}
      <div style={{ gridColumn: '2 / -1', display: 'flex', flexDirection: 'column', gap: '8px', paddingTop: '4px' }}>
        {LIVE_MODS.map((ty) => <label key={ty} style={{ display: 'flex', gap: '8px', alignItems: 'center', fontSize: '13px' }}>
          <input type="checkbox" checked={w.mods.includes(ty)} style={{ accentColor: 'var(--accent)', width: '16px', height: '16px' }}
            onChange={(e) => edit(() => { const on = e.target.checked; w.mods = LIVE_MODS.filter((t) => (t === ty ? on : w.mods.includes(t))); })} />
          {` ${ty} · ${modDetail(D, d.tmpl, ty)}`}
        </label>)}
        <div style={{ display: 'flex', gap: '8px' }}>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '4px' }}><label className="lbl" htmlFor="rad">도착 판정 반경</label>{ro('rad', '도착 판정 반경')}</div>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '4px' }}><label className="lbl" htmlFor="hdg">도착 방향</label>{ro('hdg', '도착 방향')}</div>
        </div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', gridColumn: '1/-1' }}>
        {sb('↑', () => mv(i, -1), '위로')}{sb('↓', () => mv(i, 1), '아래로')}
        {sb('삭제', () => { edit(() => { ws.splice(i, 1); }); setWsel(null); })}{sb('선택 해제', () => setWsel(null))}
      </div>
    </div>;
  });
  const rList = ws.length ? <>{rows}
    <div className="wp" style={{ opacity: 0.8 }}><span />
      <span className="mono" style={{ width: '26px', height: '26px', border: '2px solid var(--text)', borderRadius: '4px', display: 'grid', placeItems: 'center', fontSize: '12px', fontWeight: 700 }}>S</span>
      <span style={{ fontSize: '13px', fontWeight: 600 }}>{`출발점 복귀 — ${GOTO.split(' — ')[0]} · 직접 조종`}</span><span className="mono lbl">—</span>
    </div></> : <span className="lbl">«측정 지점 추가» 도구로 지도를 누르면 지점이 생깁니다(30개까지). 끌면 지도 이동.</span>;

  // ---- 출발 전 점검: 막는 것은 «진행 중 임무 없음»·«계획 저장됨»뿐(기록을 시작할 뿐 로봇을 움직이지 않음) ----
  const linkGood = lk.linkOk && !st?.sim_block, posTxt = lk.fresh ? 'Gazebo GT(SLAM 아님)' : lk.robot ? 'GT 오래됨' : 'GT 미수신';
  const cks: [boolean, string, 1?][] = [[linkGood, `로봇 링크 · ${lk.linkTxt}`], [lk.fresh, `위치 · ${lk.fresh ? 'Gazebo GT 수신(SLAM 아님)' : posTxt}`],
    [lk.camOk, `영상 · ${lk.camTxt}`], [false, '배터리 · 미제공(v2 시뮬 상태에 값 없음)'],
    [!run, run ? `진행 중 수동 임무 «${run.doc.name}» — 먼저 끝내기` : '진행 중 수동 임무 없음', 1],
    [!!(E.id && !E.dirty && ws.length), !E.id ? '계획 저장 · 아직 저장 안 됨' : E.dirty ? '계획 저장 · 저장 안 한 수정 있음' : `계획 저장됨 · 지점 ${ws.length}개`, 1],
    ...(T ? [] : [[false, `임무 양식 · ${MISSING_T}`, 1] as [boolean, string, 1]])];   // 누락 양식은 기본으로 대신하지 않고 막음
  const block = cks.filter((c) => c[2] && !c[0]).map((c) => c[1]);
  const inZ = ws.map((w, i) => (zonesAt(D, w.x, w.y).length ? `WP${i + 1} ${zoneTxt(D, w.x, w.y)}` : null)).filter(Boolean);
  const zoneWarn = inZ.length > 0 && tool !== 'measure';
  const tp = (t: Tool) => ({ 'aria-pressed': String(tool === t) as 'true' | 'false', onClick: () => setTool(t) });
  const zp = (ty: '금지' | '감속') => ({ 'aria-pressed': 'false' as const, title: `${ty} 구역은 지도 화면에서 그립니다(표시·공유만 · ${WHY['구역 주행 제한(피하기·감속)']})`, onClick: () => toZone(ty) });
  const opt = (b: string, extra: string, lbl: string, on: boolean) => (
    <label className={`opt${on ? ' on' : ''}`}><input type="radio" name="lost" checked={on} disabled readOnly /><span><b>{b}</b>{extra}<br /><span className="lbl">{lbl}</span></span></label>);

  const v = {
    themeClass: themeClass(true), status: <LiveStatus D={D} />, stopProps,
    hdrA: `임무 계획 · ${!E.id ? '새 계획 · 저장 안 됨' : E.dirty ? '저장 안 한 수정 있음' : `저장됨 · 판 ${E.rev}`}`, hdrB: d.name || '새 임무 계획',
    pill: run ? `수동 진행 중 · ${run.doc.name}` : '진행 중 임무 없음',
    chips: <>{chip('링크', lk.linkTxt, linkGood)}{chip('위치', posTxt, lk.fresh)}{chip('배터리', '미제공', false)}</>,
    tSel: tp('sel'), tAdd: tp('add'), tMeas: tp('measure'), tNo: zp('금지'), tSlow: zp('감속'),
    prevP: { onClick: loadPrev }, prevT: '지난 수동 진행 경로 불러오기',
    map: <MapCanvas name="plan" btns wps={ws} hiWp={wsel} zones={D.err ? [] : docsOf(D, 'zone')} robot={lk.robot} onTap={onTap}
      draft={tool === 'measure' && meas.length ? { type: '측정', pts: meas } : null} />,
    ov1: <span style={OV}>{dot(false)}경로 검사 미연결(Nav2) · 거리는 직선</span>,
    ov2: <span style={{ ...OV, border: '1px solid var(--warn)' }}>{dot(!zoneWarn)}{tool === 'measure'
      ? (meas.length === 2 ? `거리 재기: 직선 ${Math.hypot(meas[1][0] - meas[0][0], meas[1][1] - meas[0][1]).toFixed(2)} m` : '거리 재기: 지도에서 두 점을 누르세요')
      : inZ.length ? `${inZ.join(' · ')}(구역은 표시만)` : '구역 안 지점 없음'}</span>,
    planBox: <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <label className="lbl" htmlFor="plan">임무 계획</label>
        <a href="#" style={{ fontSize: '12px', color: 'var(--accent)' }} onClick={(e) => { e.preventDefault(); openPlan(''); }}>+ 새 계획</a>
      </div>
      <select id="plan" className="inp" value={E.id || ''} onChange={(e) => openPlan(e.target.value)}>
        {[['', '+ 새 계획'], ...docsOf(D, 'mission').map((m) => [m.id, `${m.doc.name} · 지점 ${m.doc.wps.length}`])].map(([id, t]) => <option key={id} value={id}>{t}</option>)}
      </select>
      <input id="pname" className="inp" maxLength={60} placeholder="계획 이름(예: B1 순찰 경로)" aria-label="계획 이름" value={d.name} onChange={(e) => edit(() => { d.name = e.target.value; })} />
    </div>,
    tplP: { value: T ? T.id : d.tmpl, onChange: (e: React.ChangeEvent<HTMLSelectElement>) => { const id = e.target.value; edit(() => { d.tmpl = id; }); if (ws.length && confirm('지점마다 할 일을 이 양식 기본값으로 바꿀까요?')) edit(() => { for (const w of ws) w.mods = defMods(D, id); }); } },
    tplO: <>{T ? null : <option value={d.tmpl}>{MISSING_T}</option>}{tmpls(D).map((t) => <option key={t.id} value={t.id}>{t.locked ? `${t.name} (기본)` : t.name}</option>)}</>,
    tplHref: href('PcMissions', T ? { tmpl: T.id } : {}), ruleHref: href('PcMissions', T ? { tmpl: T.id } : {}),
    rH: `${ws.length}개 지점 · ${len.toFixed(1)} m 직선`, rList,
    lost: <>{opt('명령 0 요청 · 잠금', '', `현재 v2 서버: ${STOP_FACT[0]} → ${STOP_FACT[1]}. ${STOP_FACT[2]} → ${STOP_FACT[3]}. 선택이 아니라 서버 고정 동작입니다.`, true)}
      {opt('마지막 통신 지점으로 후퇴', ' · 미연결', `${GOTO} — 자동 후퇴는 실행하지 않습니다.`, false)}</>,
    aH: '미연결', aOpts: <div className="opt" style={{ cursor: 'default' }}><span className="lbl">{RULE_WHY}</span></div>,
    cH: `${cks.filter((c) => c[0]).length} / ${cks.length}`,
    cList: <>{cks.map(([good, t]) => <div className="ck" key={t}><span className={`m ${good ? 'ok' : 'warn'}`}>{good ? '●' : '▲'}</span><span>{t}</span><span /></div>)}</>,
    fb0: '미연결', fb0T: '자동 이동이 없어 시간 예측 미연결', fb1: `${len.toFixed(1)} m 직선`, fb2: '미제공',
    saveP: { onClick: save }, saveT: '계획 저장',
    startP: { onClick: start }, startT: run ? '진행 기록 화면(관제)' : '수동 진행 시작', startDis: !run && block.length > 0,
    msg: E.msg,
    why: run ? '▲ 수동 진행 중 — 관제 화면 «임무 단계»·휴대폰 «현황»에서 지점마다 기록' : block.length ? `▲ ${block.join(' · ')}` : '● 로봇은 자동으로 움직이지 않습니다 · 직접 조종하며 지점마다 기록',
  };
  return <><style>{CSS}</style><div id="dc-root"><View v={v} /></div></>;
}
