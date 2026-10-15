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
import { STOP_TIP, WHY } from '../data/facts';
import { addPlan, dupMission, gtHere, legLen, mapTxt, planEdit, planMap, planOwn, r2, rekey, startPolicy, startRun, wkey, zoneTxt, zonesAt } from '../data/run';
import type { Here } from '../data/run';
import { href } from '../data/hist';
import { useDev } from '../data/dev';
import { MapCanvas } from '../map/MapCanvas';
import { LiveStatus } from '../app/status';
import { Chip, Help, LostHelp } from '../app/chip';
import { stopProps, toast, useRoute } from '../app/shell';

// ---- U5-a(v3 §4 PcPlan·§2-5): 지도 출처 운영 표시 — 판정은 gtHere·planMap·startPolicy 결과 그대로, 글만 줄인다(새 추정·자동 승격 0) ----
// 전문(GT·SDF/기하 sha·실패 이유)은 «?» 와 개발자 모드(기존 문구 그대로). 빈 계획 = «첫 점» 준비, 지점 있는 계획 = 계획 출처 대 지금 시작 상태로 구분
export const SRC_NOTE = '출처 일치 = 시뮬 좌표 출처(지도·층·개정 sha)만 대조한 것 — 실제 환경·경로 안전·SLAM 위치 확인이 아님';
/** gtHere 이유의 운영 짧은 글: «좌표 개정 확인 중(GT 기하 …)» → «좌표 개정 확인 중». 다른 이유엔 괄호 없음(그대로) */
export const hereShort = (why: string) => why.split('(')[0].trim();
/** «확인 중» = gtHere 가 GT 기하 파일을 받는 중(G1 대기)일 때만 — 나머지 이유는 «미확인» */
const waiting = (h: Here) => !h.map && h.why.startsWith('좌표 개정 확인 중');
export function srcView(pm: Here | null, h: Here, sp: { block: string | null; map: unknown } | null): { good: boolean; text: string; line: string } {
  const now = (x: Here) => (waiting(x) ? '출처 확인 중 · 기록만' : '출처 미확인 · 기록만');
  if (!pm || !sp) return h.map ? { good: true, text: '첫 점 · 출처 확인됨', line: '지도 · 지점 없음 · 첫 점은 지금 지도 출처로 기록' }
    : { good: false, text: `첫 점 · ${now(h)}`, line: `지도 · 지점 없음 · 지금 ${hereShort(h.why)} · 지금 찍으면 기록만` };
  if (sp.block) return { good: false, text: '지도·층·출처 다름', line: '지도·층·출처 다름 — 시작 안 됨 · 맞는 지도·층에서 시작(열기·편집은 가능)' };
  if (sp.map) return { good: true, text: '출처 일치', line: '지도 · 출처 일치 · 지금 시뮬과 같은 출처' };
  const why = pm.map ? `지금 ${hereShort(h.why ?? "")}` : pm.why.replace(/^출처 미확인\((.*)\)$/, '$1');
  const text = pm.map ? now(h) : '출처 미확인 · 기록만';
  return { good: false, text, line: `지도 · ${text} — ${why} (거리·지도 겹치기 표시 안 함)` };
}

type Tool = 'sel' | 'add' | 'measure';
const GOTO = WHY['자동 목적지 이동·자동 복귀'];
const OV = { display: 'flex', alignItems: 'center', gap: '6px', height: '30px', padding: '0 10px', borderRadius: '6px', background: 'var(--panel)', border: '1px solid var(--line2)', fontSize: '12px' } as const;
const dot = (good: boolean) => <span style={{ color: good ? 'var(--ok)' : 'var(--warn)' }}>{good ? '●' : '▲'}</span>;
// wrap: 이 칩만 줄바꿈·폭 제한(폰 390 에서 «기록만»·이유가 첫 화면에 — 670 2129 P2). 공용 .chip(nowrap)·다른 칩 무변경
const WRAP = { whiteSpace: 'normal', height: 'auto', minHeight: '34px', flexWrap: 'wrap', maxWidth: '100%', minWidth: 0, padding: '4px 10px' } as const;
const chip = (k: string, val: string, good: boolean, wrap?: boolean, help?: React.ReactNode) => (
  <div className={`chip ${good ? 'ok' : 'warn'}`} key={k} style={wrap ? WRAP : undefined}><span className="mk">{good ? '●' : '▲'}</span><span style={{ color: 'var(--muted)' }}>{k}</span><span className="mono" style={{ fontWeight: 600, ...(wrap ? { overflowWrap: 'anywhere' as const } : {}) }}>{val}</span>{help}</div>);
const P = ({ t }: { t: string }) => <span style={{ display: 'block', marginTop: 4 }}>{t}</span>;

export default function PcPlan() {
  const D = useDocs(), L = useLink(), lk = linkView(L), st = L.st, E = useEditor<Mission>('mission', 'PcPlan'), { q, setQ } = useRoute(), dev = useDev((s) => s.on);
  const [tool, setTool0] = useState<Tool>('add'), [wsel, setWsel] = useState<number | null>(null), [meas, setMeas] = useState<number[][]>([]);
  const want = q.get('mission') || '', shown = useRef<string | null>(null);   // shown: 주소에 이미 반영한 id(새로 저장된 id 만 주소에 씀)
  const blank = (): Mission => ({ name: '', tmpl: q.get('tmpl') || 'base', memo: '', wps: [] });
  if (!E.d) E.d = blank();   // 문서 읽기 전 첫 그리기용(다시 그리기 없이)
  const d = E.d, ws = d.wps, run = activeRun(D), len = legLen(ws);

  useEffect(() => {   // 고른 계획을 편집기에 · 다른 기기가 고친 새 판은 깨끗할 때만 반영 · 저장 뒤 주소에 id
    if (want && E.id !== want && !E.dirty) { const x = docById(D, want); if (x) { E.load(x); shown.current = x.id; setWsel(null); return; } }
    const sc = E.stale(D); if (sc && !E.dirty) E.load(sc);
    if (E.id && !E.dirty && E.id !== shown.current) { shown.current = E.id; if (want !== E.id) setQ('mission', E.id); }   // 저장(새 문서)으로 생긴 id 만 — 사용자가 연 주소는 덮지 않음 · 이어 편집 중인 초안(dirty)은 주소를 바꾸지 않음
  });
  useEffect(() => { const f = (e: BeforeUnloadEvent) => { if (E.dirty) e.preventDefault(); }; addEventListener('beforeunload', f); return () => removeEventListener('beforeunload', f); }, [E]);

  const edit = (f: () => void) => planEdit(E, f);
  const setTool = (t: Tool) => { setTool0(t); setMeas([]); };
  const openPlan = (id: string) => {
    if (E.dirty && !confirm('저장 안 한 수정이 있습니다. 버릴까요?')) return;
    E.load(docById(D, id) || null, blank()); shown.current = E.id; setWsel(null); setQ('mission', id);
  };
  const onTap = (x: number, y: number, k: number) => {
    if (tool === 'add') {
      if (ws.length >= 30) return toast('지점은 30개까지');
      // 좌표 출처는 찍는 순간의 지도(저장 때 붙이지 않음). 다른/모르는 지도에서 더하면 확인 뒤 «기록만»으로 낮춤 — 올리는 길 0
      const h = gtHere(L), a = addPlan(d, h);
      // U5-a: 운영은 짧은 이유(지도·층·출처 다름 / 지금 이유), 개발자 모드는 기존 전문 — 확인창 동작·판정 그대로
      const dropWhy = dev ? a.why : h.map ? '지금 지도·층·출처가 이 계획과 다름' : `지금 ${hereShort(h.why)}`;
      if (a.act === 'drop' && !confirm(`${dropWhy}\n이 지점을 더하면 이 계획은 «${dev ? '지도 미확인' : '출처 미확인'} · 기록만»이 됩니다(거리·지도 겹치기 표시 안 함). 더할까요?`)) return;
      if (!tmplOf(D, d.tmpl)) toast(`${MISSING_T} · 이 지점 할 일은 비워 둠`);
      edit(() => {
        d.wps.push({ x: r2(x), y: r2(y), name: '', mods: defMods(D, d.tmpl) });
        const m = a.act === 'bind' ? h.map : a.act === 'keep' ? d.map : undefined;
        if (m) d.map = { ...m, key: wkey(d.wps) }; else delete d.map;
      }); setWsel(d.wps.length - 1);
      if (a.act === 'bind' && !h.map) toast(dev ? `지금 ${h.why} — 이 계획은 «지도 미확인 · 기록만»(나중에 확인돼도 자동으로 올리지 않음)` : `지금 ${hereShort(h.why)} — 이 계획은 «출처 미확인 · 기록만»(나중에 확인돼도 자동으로 올리지 않음)`);
    }
    else if (tool === 'measure') setMeas((m) => (m.length >= 2 ? [[r2(x), r2(y)]] : [...m, [r2(x), r2(y)]]));
    else { const i = ws.findIndex((w) => Math.hypot(w.x - x, w.y - y) * k < 16); setWsel(i < 0 ? null : i); }
  };
  // R02-C0: 주소가 가리키는 문서(want)와 편집 중 초안이 다를 때 — 둘 다 이름으로 알리고, 사용자가 고르게(주소·서버 판은 그대로)
  const asked = want ? docById(D, want) : null, mine = E.id ? docById(D, E.id) : null;
  const c0 = want && E.dirty && E.id !== want ? (
    <div className="lv-warnbox" role="alert" data-c0="1">
      <span>{`요청한 문서 «${asked?.kind === 'mission' ? asked.doc.name || '이름 없음' : '찾지 못함'}»와 다른 문서의 초안을 편집 중: «${d.name || '이름 없음'}»(${E.id ? `${mine?.kind === 'mission' ? `«${mine.doc.name}» ` : ''}판 ${E.rev}` : '새 문서'}) · 저장 안 됨`}</span>
      <div className="lv-row">
        <button type="button" className="lv-btn pri" disabled={E.busy} onClick={() => { const nm = d.name; E.save().then((r) => { if (r?.ok) toast(E.dirty ? `초안 판 ${r.rev} 저장됨 · 저장 중 고친 내용은 아직 저장 안 됨 — 요청한 문서로 옮기지 않음` : `초안 «${nm || '이름 없음'}» 저장됨 · 판 ${r.rev} — 요청한 문서를 엽니다`); /* dirty 면 effect 도 옮기지 않음(새 편집 보존) */ }); }}>이 초안 저장</button>
        <button type="button" className="lv-btn" disabled={E.busy} onClick={() => { E.load(asked?.kind === 'mission' ? asked : null, blank()); shown.current = E.id; setWsel(null); }}>초안 버리고 요청 문서 열기</button>
      </div>
    </div>) : null;
  const dup = () => {   // 저장된 판을 복제(초안 아님) → 새 문서 초안. 원본·주소의 원본 id 는 건드리지 않음
    const src = E.id ? docById(D, E.id) : null; if (!src || src.kind !== 'mission') return toast('저장된 계획을 먼저 고르세요');
    if (E.dirty && !confirm('저장 안 한 수정이 있습니다. 버리고 저장된 판을 복제할까요?')) return;
    E.load(null, dupMission(src.doc)); E.dirty = true; shown.current = null; setWsel(null); setQ('mission', '');
    toast(`«${src.doc.name}» 사본 초안 — 고친 뒤 저장하면 새 계획(원본 그대로)`);
  };
  const toZone = (ty: string) => {
    if (st?.role === 'control') return toast('조종 중입니다 — 조종권 반납 뒤 지도 화면으로');
    if (E.dirty) toast('저장 안 한 계획은 이 탭에 보관 — 계획 화면으로 돌아오면 이어서 편집');   // R02: 버리지 않음(확인창 대신 보관)
    location.hash = href('PcMap', { draw: ty });
  };
  const loadPrev = () => {
    const r = docsOf(D, 'run')[0]; if (!r) return toast('지난 수동 진행 기록이 없습니다');
    if (ws.length && !confirm(`지금 지점 ${ws.length}개를 «${r.doc.name}» 기록의 지점 ${r.doc.wps.length}개로 바꿀까요?`)) return;
    edit(() => {   // 가져온 좌표는 그 기록의 출처를 그대로(지금 연결로 다시 붙이지 않음) — 기록에 유효한 출처가 없으면 미확인
      d.wps = r.doc.wps.slice(0, 30).map((w) => ({ x: w.x, y: w.y, name: w.name, mods: w.mods.slice() }));
      const b = planMap(r.doc); if (b.map && b.map.key === wkey(d.wps)) d.map = { ...b.map }; else delete d.map;
    }); setWsel(null);
  };
  const mv = (i: number, s: number) => { const j = i + s; if (j < 0 || j >= ws.length) return; edit(() => rekey(d, () => { [ws[i], ws[j]] = [ws[j], ws[i]]; })); setWsel(j); };
  const save = async () => {
    if (!d.name.trim()) { document.getElementById('pname')?.focus(); return toast('계획 이름을 넣으세요'); }
    if (!ws.length) return toast('지도에서 지점을 1개 이상 찍으세요');
    ws.forEach((w, i) => { if (!w.name.trim()) w.name = `지점 ${i + 1}`; });
    await E.save();
  };
  const start = async () => {
    if (run) { location.hash = href('Main'); return; }
    let same = true;   // 응답 사이 다른 계획을 열었거나 고쳤으면 화면은 그대로(초안 보존), 결과만 알림
    // E1: 확인창 사이 이탈(unmount)·다른 계획·복제(gen 오름)·같은 계획 수정(dirty) → 쓰기 0. 확인 직후 대조(E.write 가 새 gen 을 잡아 옛 확인을 살리지 않게)
    const r = await startRun(D, E.id, async (m) => { const w = await E.write(m); if (w) same = w.same; return w && w.r; }, planOwn(E));
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
        {sb('삭제', () => { edit(() => rekey(d, () => { ws.splice(i, 1); })); setWsel(null); })}{sb('선택 해제', () => setWsel(null))}
      </div>
    </div>;
  });
  const rList = ws.length ? <>{rows}
    <div className="wp" style={{ opacity: 0.8 }}><span />
      <span className="mono" style={{ width: '26px', height: '26px', border: '2px solid var(--text)', borderRadius: '4px', display: 'grid', placeItems: 'center', fontSize: '12px', fontWeight: 700 }}>S</span>
      <span style={{ fontSize: '13px', fontWeight: 600 }}>{`출발점 복귀 — ${GOTO.split(' — ')[0]} · 직접 조종`}</span><span className="mono lbl">—</span>
    </div></> : <span className="lbl">«측정 지점 추가» 도구로 지도를 누르면 지점이 생깁니다(30개까지). 끌면 지도 이동.</span>;

  // ---- 출발 전 점검: 막는 것은 «진행 중 임무 없음»·«계획 저장됨»뿐(기록을 시작할 뿐 로봇을 움직이지 않음) ----
  // G1: 빈 계획에서도 매번 지금 지도를 판정 — 연결 건물이면 첫 점 전에 GT 기하를 받아 둠(받는 중/확인됨/미확인을 지도 칩에 표시)
  const hNow = gtHere(L), pm = ws.length ? planMap(d) : null, sp = ws.length ? startPolicy(d, hNow) : null;   // 좌표 출처·시작 정책(startRun 과 같은 함수)
  const firstTxt = hNow.map ? `첫 지점 결속 준비됨 · ${mapTxt(hNow.map)}` : `지금 ${hNow.why} · 지금 찍으면 기록만`;
  const linkGood = lk.linkOk && !st?.sim_block, posTxt = lk.fresh ? '시뮬 위치 수신' : lk.robot ? '시뮬 위치 오래됨' : '시뮬 위치 미수신';
  // U5-a: 지도 칩·점검 줄 — 운영 = srcView 짧은 글 + ?(기존 전문·SRC_NOTE), 개발자 모드 = 기존 문구 그대로
  const sv = srcView(pm, hNow, sp), oldChip = !pm ? firstTxt : pm.map ? mapTxt(pm.map) : `미확인 · ${pm.why}`, oldLine = sp ? sp.block || sp.line : `지도 · 지점 없음 · ${firstTxt}`;
  const srcHelp = <Help label="지도 출처 · 설명"><span style={{ display: 'block' }}>{oldChip}</span>{sp ? <P t={oldLine} /> : null}<P t={SRC_NOTE} /></Help>;
  const batHelp = <Help label="배터리 · 설명">{WHY['배터리']}</Help>;
  const cks: [boolean, string, 1?, React.ReactNode?][] = [[linkGood, `로봇 링크 · ${lk.linkTxt}`], [lk.fresh, `위치 · ${posTxt}`],
    [lk.camOk, `영상 · ${lk.camTxt}`], [false, '배터리 · 값 없음', undefined, batHelp],
    [!run, run ? `진행 중 수동 임무 «${run.doc.name}» — 먼저 끝내기` : '진행 중 수동 임무 없음', 1],
    [!!sp?.map, dev ? oldLine : sv.line, sp?.block ? 1 : undefined, dev ? undefined : srcHelp],
    [!!(E.id && !E.dirty && ws.length), !E.id ? '계획 저장 · 아직 저장 안 됨' : E.dirty ? '계획 저장 · 저장 안 한 수정 있음' : `계획 저장됨 · 지점 ${ws.length}개`, 1],
    ...(T ? [] : [[false, `임무 양식 · ${MISSING_T}`, 1] as [boolean, string, 1]])];   // 누락 양식은 기본으로 대신하지 않고 막음
  const block = cks.filter((c) => c[2] && !c[0]).map((c) => c[1]);
  const inZ = ws.map((w, i) => (zonesAt(D, w.x, w.y).length ? `WP${i + 1} ${zoneTxt(D, w.x, w.y)}` : null)).filter(Boolean);
  const zoneWarn = inZ.length > 0 && tool !== 'measure';
  const tp = (t: Tool) => ({ 'aria-pressed': String(tool === t) as 'true' | 'false', onClick: () => setTool(t) });
  const zp = (ty: '금지' | '감속') => ({ 'aria-pressed': 'false' as const, title: `${ty} 구역은 지도 화면에서 그립니다(표시·공유만 · ${WHY['구역 주행 제한(피하기·감속)']})`, onClick: () => toZone(ty) });
  const opt = (b: string, extra: string, lbl: React.ReactNode, on: boolean) => (
    <label className={`opt${on ? ' on' : ''}`}><input type="radio" name="lost" checked={on} disabled readOnly /><span><b>{b}</b>{extra}<br /><span className="lbl">{lbl}</span></span></label>);

  const v = {
    themeClass: `${themeClass(true)} pcplan-hdr`, status: <LiveStatus D={D} />, stopProps,   // pcplan-hdr: B2 A3 STOP 첫 줄 오른쪽(live.css)
    hdrA: `임무 계획 · ${!E.id ? '새 계획 · 저장 안 됨' : E.dirty ? '저장 안 한 수정 있음' : `저장됨 · 판 ${E.rev}`}`, hdrB: d.name || '새 임무 계획',
    pill: run ? `수동 진행 중 · ${run.doc.name}` : '진행 중 임무 없음',
    chips: <>{chip('위치', posTxt, lk.fresh)}{dev ? chip('지도', oldChip, pm ? !!pm.map : !!hNow.map, true) : chip('지도', sv.text, sv.good, true, srcHelp)}</>,   // B2 R16: 링크는 상태 줄 · 배터리 값 없음은 출발 전 점검 한 곳 · U5-a 지도 칩 운영/개발자
    tSel: tp('sel'), tAdd: tp('add'), tMeas: tp('measure'), tNo: zp('금지'), tSlow: zp('감속'),
    prevP: { onClick: loadPrev }, prevT: '지난 수동 진행 경로 불러오기',
    map: <MapCanvas name="plan" btns wps={ws} hiWp={wsel} zones={D.err ? [] : docsOf(D, 'zone')} robot={lk.robot} onTap={onTap}
      draft={tool === 'measure' && meas.length ? { type: '측정', pts: meas } : null} />,
    ov1: <span style={OV}>{dot(false)}경로 검사(자동 길찾기) 미연결 · 거리는 직선</span>,
    ov2: <span style={{ ...OV, border: '1px solid var(--warn)' }}>{dot(!zoneWarn)}{tool === 'measure'
      ? (meas.length === 2 ? `거리 재기: 직선 ${Math.hypot(meas[1][0] - meas[0][0], meas[1][1] - meas[0][1]).toFixed(2)} m` : '거리 재기: 지도에서 두 점을 누르세요')
      : inZ.length ? `${inZ.join(' · ')}(구역은 표시만)` : '구역 안 지점 없음'}</span>,
    planBox: <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <label className="lbl" htmlFor="plan">임무 계획</label>
        <span style={{ display: 'flex', gap: '12px' }}>
          {E.id ? <a href="#" style={{ fontSize: '12px', color: 'var(--accent)' }} onClick={(e) => { e.preventDefault(); dup(); }}>복제해서 새 계획</a> : null}
          <a href="#" style={{ fontSize: '12px', color: 'var(--accent)' }} onClick={(e) => { e.preventDefault(); openPlan(''); }}>+ 새 계획</a>
        </span>
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
    // U5-a: 공용 쉬운 말(U4-c 고정 규칙과 같은 글) + ? 전문(U5-b: 공용 LostHelp — STOP_FACT·SAFE_NOTE·STOP_OBS·RELURCH 보존) · 동작·선택 불가 그대로
    lost: <>{opt('입력 차단·잠금', '', <>조종 입력 0.3초 끊김 → 입력 차단 (몸 정지는 별도) · 화면을 떠나거나 신호 1초 끊김 → 입력 차단·잠금. 선택이 아니라 서버 고정 동작입니다.
        <LostHelp /></>, true)}
      {opt('마지막 통신 지점으로 후퇴', ' · 미연결', `${GOTO} — 자동 후퇴는 실행하지 않습니다.`, false)}</>,
    aH: <Chip tone="off" text="자동 실행 안 함" why={RULE_WHY} whyLabel="경보 규칙 · 설명" />, aOpts: <></>,   // U5-a: U4-c 경보 규칙 칩과 같음(전문은 ?)
    cH: `${cks.filter((c) => c[0]).length} / ${cks.length}`,
    cList: <>{cks.map(([good, t, , hp]) => <div className="ck" key={t}><span className={`m ${good ? 'ok' : 'warn'}`}>{good ? '●' : '▲'}</span><span>{t}{hp}</span><span /></div>)}</>,
    fb0: '미연결', fb0T: '자동 이동이 없어 시간 예측 미연결', fb1: `${len.toFixed(1)} m 직선`, fb2: <>값 없음{batHelp}</>,
    stopSub: '스페이스 · 입력 차단·잠금', stopHelp: <Help label="STOP 설명">{STOP_TIP}</Help>,   // 공용 STOP 글(v3 §3 — PcMissions·PcRobot 와 같음)
    saveP: { onClick: save }, saveT: '계획 저장',
    startP: { onClick: start }, startT: run ? '진행 기록 화면(관제)' : '수동 진행 시작', startDis: !run && block.length > 0,
    msg: c0 ? <>{c0}{E.msg !== E.kept ? E.msg : null}</> : E.msg,
    why: run ? '▲ 수동 진행 중 — 관제 화면 «임무 단계»·휴대폰 «현황»에서 지점마다 기록' : block.length ? `▲ ${block.join(' · ')}` : '● 로봇은 자동으로 움직이지 않습니다 · 직접 조종하며 지점마다 기록',
  };
  return <><style>{CSS}</style><div id="dc-root"><View v={v} /></div></>;
}
