// #/MapEditor — PC 지도 편집기(새 기획 10-18, SPEC §4). 설계도(Scene) 만들기·저장(put)·검토(analyze)·묶음 내보내기(export).
// 로봇 명령 0(sendOp·startDrive 호출 없음) · Gazebo 기동 0 · 사용자 도면은 우리 서버 저장소에만(외부 업로드 0).
// 초안: 기존 scratch 규칙(탭 메모리 drafts, 키 rehearsal:<id|new>) — 화면을 떠날 때만 보관, 로그아웃·관문 변경·세션 끝(dropScratch → ctx.n)이면 버림.
// 서버 응답: 요청 번호(gen) + 문맥(ctx.n)이 그대로일 때만 반영. 자동 재시도·자동 덮어쓰기 0.
import { useEffect, useMemo, useRef, useState } from 'react';
import { PcFrame, SourceTag, listErr, useWidth } from '../app/fleetui';
import { toast, useRoute } from '../app/shell';
import { saveBlob } from '../data/fmt';
import { ctx, drafts } from '../data/scratch';
import {
  type Analysis, type Element, type Exported, type Issue, type ProjectMeta, type Scene, type Sel, type SensorKind, type EquipKind, type Vec2,
  EQUIP_KO, EXAMPLE_NAME, EXPORT_NOTE, MODEL_TAG, RLIM, SENSOR_KO, SENSOR_TAG, SH, STAIRS_TAG, autoFit, b64Bytes, blankScene, bytesOf, checkScene, edit,
  exampleScene, fitBackground, kib, newId, newStairs, parseScene, pathLen, r3, rcall, removeSel, rescale, saveExport, snap, toggleIn, moveSel, listProjects, brokenTxt, damagedTxt, sceneJson,
} from '../data/rehearsal';
import { type Draft, type Focus, SceneCanvas, hitTest } from '../map/SceneCanvas';

type Tool = 'V' | 'W' | 'B' | 'S' | 'R' | 'C' | 'E' | 'P' | 'I' | 'K';
const TOOLS: [Tool, string][] = [['V', '선택'], ['W', '벽'], ['B', '상자'], ['S', '계단'], ['R', '로봇'], ['C', '센서'], ['E', '장비'], ['P', '경로'], ['I', '도면'], ['K', '축척']];
const HELP: Record<Tool, string> = {
  V: '누르면 고름 · 끌면 옮김(0.05 m 단위) · 빈 곳을 끌면 지도 이동', W: '두 점을 차례로 누름 · 이어서 다음 벽 · Esc 끝', B: '누른 자리에 1 m 상자',
  S: '누른 자리에서 위층으로 오르는 계단(바로 위층)', R: '누른 자리에 로봇(출발 자세)', C: '로봇을 누르면 센서 하나 붙임(로봇에만)', E: '누른 자리에 장비',
  P: '로봇을 먼저 고른 뒤 점을 차례로 누름 · Enter 또는 «경로 끝»', I: '도면 그림 파일을 고름(이 PC 안에서 줄여 넣음)', K: '도면 위 두 점을 누르고 실제 거리 입력',
};
const deg = (r: number) => Math.round((r * 180) / Math.PI * 10) / 10, rad = (d: number) => r3((d * Math.PI) / 180);
const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));
type Meta = { id: string | null; rev: number | null };
type H = { s: Scene; past: Scene[]; fut: Scene[] };
const keyOf = (m: Meta) => `rehearsal:${m.id || 'new'}`;

/** 숫자 칸: 바뀌면 바로가 아니라 Enter·포커스 이탈 때 확정. 범위 밖·숫자 아님은 거부하고 원래 값으로 */
function Num({ label, v, min, max, step = 0.05, unit = 'm', on, ro }: { label: string; v: number; min: number; max: number; step?: number; unit?: string; on?: (n: number) => boolean | void; ro?: boolean }) {
  const [t, setT] = useState(String(v)), [bad, setBad] = useState('');
  useEffect(() => { setT(String(v)); setBad(''); }, [v]);
  const commit = () => {
    const n = Number(t);
    if (t.trim() === '' || !Number.isFinite(n) || n < min || n > max) { setBad(`${min}–${max} ${unit}`); setT(String(v)); return; }
    setBad(''); if (n !== v && on?.(n) === false) setT(String(v));   // 부모가 거부(저장 중)하면 표시도 실제 값으로 — 표시≠scene 0
  };
  return <label style={{ display: 'grid', gridTemplateColumns: '1fr 110px', alignItems: 'center', gap: 6, fontSize: 13 }}>
    <span>{label} <span className="lbl">{unit}</span>{bad && <span style={{ display: 'block', color: 'var(--bad)', fontSize: 12 }}>{`범위 ${bad} — 되돌림`}</span>}</span>
    <input className="inp mono" inputMode="decimal" value={t} readOnly={ro || !on} min={min} max={max} step={step} aria-label={label}
      onChange={(e) => setT(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') commit(); }} style={{ height: 36 }} />
  </label>;
}
function Txt({ label, v, on }: { label: string; v: string; on: (s: string) => boolean | void }) {
  const [t, setT] = useState(v); useEffect(() => setT(v), [v]);
  const commit = () => { const x = t.slice(0, RLIM.name).replace(/[\u0000-\u001f\u007f]/g, ''); setT(x); if (x !== v && on(x) === false) setT(v); };
  return <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>{label}
    <input className="inp" value={t} maxLength={RLIM.name} onChange={(e) => setT(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') commit(); }} style={{ height: 36 }} /></label>;
}
const Tag = ({ t }: { t: string }) => <span style={{ display: 'inline-block', fontSize: 12, padding: '2px 8px', border: '1px dashed var(--line2)', borderRadius: 6, color: 'var(--muted)' }}>{t}</span>;

export default function MapEditor() {
  const { q, setQ } = useRoute(), qid = q.get('id'), W = useWidth(), viewOnly = W < 600, wide = W >= 1280;
  const at = useRef(ctx.n), gen = useRef(0), alive = useRef(true);
  const docGen = useRef(0), editSeq = useRef(0), listSeq = useRef(0), fileSeq = useRef(0);   // 문서 세대(새로·열기·가져오기) · 편집 번호(모든 바꿈) — 늦은 응답을 그 문서·그 내용에만 적용
  const [h, setH] = useState<H>(() => ({ s: blankScene(), past: [], fut: [] }));
  const s = h.s;
  const [meta, setMeta] = useState<Meta>({ id: null, rev: null });
  const [dirty, setDirty] = useState(false);
  const [floor, setFloor] = useState('f1');
  const [scId, setScId] = useState<string | null>(null);
  const [sel, setSel] = useState<Sel>(null);
  const [tool, setTool] = useState<Tool>('V');
  const [draft, setDraft] = useState<Draft>(null);
  const [preview, setPreview] = useState<Scene | null>(null);   // 끄는 중(기록 0)
  const drag = useRef<{ base: Scene; from: Vec2; moved: boolean; pid: number; dg: number; es: number } | null>(null);   // pid·dg·es = 누른 손가락·그때 문서·그때 편집 번호(715 U4: 모두 같을 때만 놓기 확정)
  const [busy, setBusy] = useState<'' | 'load' | 'save' | 'analyze' | 'export'>('');
  const [srv, setSrv] = useState<{ issues: Issue[]; analysis: Analysis | null; from: string; stale?: boolean }>({ issues: [], analysis: null, from: '' });
  const [msg, setMsg] = useState<{ t: string; bad?: boolean } | null>(null);
  const [conflict, setConflict] = useState<{ rev: number } | null>(null);
  const [apiErr, setApiErr] = useState<number | null>(null);   // 마지막 서버 응답이 실패면 그 code(0 = 응답 없음)
  const [exp, setExp] = useState<string>('');
  const [focus, setFocus] = useState<Focus>(null);
  const [scaleD, setScaleD] = useState('');
  const [list, setList] = useState<ProjectMeta[] | string | null>(null), [listNote, setListNote] = useState<string | null>(null);
  const [bgAlpha] = useState(0.45);
  const fileJ = useRef<HTMLInputElement>(null), fileI = useRef<HTMLInputElement>(null);
  const still = (g: number) => g === gen.current && at.current === ctx.n;
  const S = preview || s;

  // ---- 기록(되돌리기 100) ----
  // 바뀌면: 저장 안 함 표시 · 내보내기 결과 지움 · 서버 검토 결과는 «검토 뒤 편집됨»(위치가 옛 내용 기준)
  // 다른 편집(Delete·되돌리기·속성 등)이 끼면 끌던 것은 옛 사본 기준 → 버림(root U4). 자기 놓기 확정은 drag 를 먼저 비운 뒤 commit 이라 영향 0
  const touched = () => { editSeq.current++; drag.current = null; setPreview(null); setDirty(true); setExp(''); setSrv((o) => (o.from ? { ...o, stale: true } : o)); };
  const commit = (next: Scene, note?: string) => { setH((o) => ({ s: next, past: [...o.past.slice(-99), o.s], fut: [] })); touched(); if (note) setMsg({ t: note }); };
  const undo = () => { if (!h.past.length) return; setH((o) => (o.past.length ? { s: o.past[o.past.length - 1], past: o.past.slice(0, -1), fut: [o.s, ...o.fut] } : o)); touched(); };
  const redo = () => { if (!h.fut.length) return; setH((o) => (o.fut.length ? { s: o.fut[0], past: [...o.past, o.s], fut: o.fut.slice(1) } : o)); touched(); };
  const replaceDoc = (sc: Scene, m: Meta, d: boolean, note: string) => {
    gen.current++; docGen.current++; editSeq.current++;   // 진행 중 응답(저장·검토·도면)은 옛 문서 것 — 버림
    setBusy(''); drag.current = null; setPreview(null);   // 끌던 것·미리보기는 옛 문서 것(715 U4)
    setH({ s: sc, past: [], fut: [] }); setMeta(m); setDirty(d); setSel(null); setDraft(null); setConflict(null); setExp('');
    setSrv({ issues: [], analysis: null, from: '' }); setFloor(sc.floors[0]?.id || 'f1'); setScId(sc.scenarios[0]?.id || null); setMsg({ t: note });
  };
  const okLeave = () => !live.current.dirty || confirm('저장 안 한 변경이 있습니다. 이 초안을 버리고 바꿀까요? (취소 = 지금 초안 유지)');

  // ---- 문서 열기의 주인 = 주소 id(715 U2) — 처음 들어옴·저장본 단추(setQ)·뒤로가기 모두 여기 한 곳에서만 open ----
  //   주소 id 가 지금 문서 id 와 같으면(자기 저장의 id 반영) 다시 열지 않음. 처음 이후 주소에서 id 가 빠지면 문서 그대로.
  //   뒤로가기 등 확인 없이 바뀐 경우 저장 안 한 초안은 버리지 않고 탭 메모리에 보관(그 주소로 돌아오면 이어서). 단추는 이미 okLeave 로 물었음(leaveOk).
  const first = useRef(true), leaveOk = useRef(false);
  useEffect(() => {
    const was = first.current, ok = leaveOk.current, L = live.current; first.current = false; leaveOk.current = false;
    if (!was && (!qid || qid === L.meta.id)) return;
    let note = '';
    if (!was && L.dirty && !ok && at.current === ctx.n) { drafts.set(keyOf(L.meta), { id: L.meta.id, rev: L.meta.rev, d: L.h.s }); note = ` · 바꾸기 전 초안 «${L.h.s.name}»은 이 탭에 보관(그 주소로 돌아오면 이어서)`; }
    const k = `rehearsal:${qid || 'new'}`, kept = drafts.get(k);
    if (kept && kept.d) { drafts.delete(k); replaceDoc(kept.d as Scene, { id: kept.id, rev: kept.rev }, true, `저장 안 한 초안 «${(kept.d as Scene).name}»을 이어서 편집합니다 · 이 탭에만 보관 — 저장하거나 버리세요${note}`); return; }
    if (qid) void open(qid, note);
  }, [qid]);   // eslint-disable-line react-hooks/exhaustive-deps
  // 떠날 때: 저장 안 한 초안만 탭 메모리에(문맥이 그대로일 때만) · 늦은 응답은 gen 으로 버림
  const live = useRef({ h, meta, dirty }); live.current = { h, meta, dirty };   // okLeave·늦은 응답은 이 «지금 값»으로 판단(시작 때 값 0)
  useEffect(() => () => { alive.current = false; gen.current++; const L = live.current; if (L.dirty && at.current === ctx.n) drafts.set(keyOf(L.meta), { id: L.meta.id, rev: L.meta.rev, d: L.h.s }); }, []);
  useEffect(() => {   // 창 닫기·새로고침 = 탭 메모리도 사라짐 → 브라우저 확인
    if (!dirty) return; const f = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    addEventListener('beforeunload', f); return () => removeEventListener('beforeunload', f);
  }, [dirty]);

  // ---- 서버 ----
  const fail = (r: { code: number; error: string; issues: Issue[] }, what: string) => { setApiErr(r.code); setMsg({ t: `${what} 실패 · ${r.error}`, bad: true }); if (r.issues.length) setSrv({ issues: r.issues, analysis: null, from: `${what} 거부(서버 검증)` }); };
  async function open(id: string, note = '') {
    const g = ++gen.current, es = editSeq.current; setBusy('load');
    const r = await rcall<{ project: ProjectMeta; scene: Scene }>({ op: 'get', id }, SH.get);   // 모양·그리기 범위(drawBounds) 밖이면 실패 → 지금 초안 그대로
    if (!still(g)) return; setBusy('');
    if (!r.ok) { fail(r, '불러오기'); if (note) setMsg((m) => m && { ...m, t: m.t + note }); return; }
    if (editSeq.current !== es) return setMsg({ t: `불러오는 사이 지금 초안을 고쳐서 r${r.data.project.rev} 을 열지 않았습니다 · 지금 초안 그대로(필요하면 저장본 열기)${note}`, bad: true });
    setApiErr(null); replaceDoc(r.data.scene, { id: r.data.project.id, rev: r.data.project.rev }, false, `불러옴 · ${r.data.project.name} · 판 r${r.data.project.rev}${note}`);
  }
  async function save(rev = meta.rev) {
    if (busy) return;
    const g = ++gen.current, es = editSeq.current; setBusy('save'); setConflict(null);
    const r = await rcall<{ project: ProjectMeta; new: boolean; warnings: Issue[] }>(meta.id ? { op: 'put', id: meta.id, rev, scene: s } : { op: 'put', id: null, scene: s }, SH.put);
    if (!still(g)) return; setBusy('');
    if (!r.ok) {
      if (r.code === 409 && r.cur) { setApiErr(null); setConflict({ rev: r.cur.rev }); setMsg({ t: `다른 곳에서 r${r.cur.rev} 가 저장됨 · 내 초안은 남아 있습니다`, bad: true }); return; }
      return fail(r, '저장');
    }
    const p = r.data.project, later = editSeq.current !== es;   // 저장 요청 뒤에 고친 것은 아직 저장 안 됨(dirty 유지)
    setApiErr(null); setMeta({ id: p.id, rev: p.rev }); if (!later) setDirty(false);
    setSrv({ issues: r.data.warnings, analysis: null, from: `저장 r${p.rev} 경고(저장됨)`, stale: later });
    setMsg({ t: `저장됨 · ${p.name} · 판 r${p.rev} · ${kib(p.bytes)} KiB${r.data.warnings.length ? ` · 경고 ${r.data.warnings.length}건(저장은 됨)` : ''}${later ? ' · 저장 요청 뒤 고친 내용은 아직 저장 안 함' : ''}` });
    if (qid !== p.id) history.replaceState(null, '', `#/MapEditor?id=${encodeURIComponent(p.id)}`);   // 기록 쌓지 않음(뒤로 = 들어오기 전) · 주소 id = 지금 문서 id 라 위 주인 effect 는 다시 열지 않음(U2)
  }
  async function review() {
    if (busy) return;
    const g = ++gen.current, es = editSeq.current; setBusy('analyze');
    const r = await rcall<Analysis>({ op: 'analyze', scene: s }, SH.analyze);
    if (!still(g)) return; setBusy('');
    if (!r.ok) return fail(r, '검토');
    setApiErr(null); setSrv({ issues: r.data.issues, analysis: r.data, from: '검토(초안 그대로 · 서버 계산)', stale: editSeq.current !== es });
    setMsg({ t: `검토 끝 · 오류 ${r.data.issues.filter((x) => x.level === 'error').length} · 경고 ${r.data.issues.filter((x) => x.level === 'warn').length}` });
  }
  async function exportZip() {
    if (busy || !meta.id || dirty) return;
    const g = ++gen.current; setBusy('export');
    const r = await rcall<Exported>({ op: 'export', id: meta.id, rev: meta.rev }, SH.export);
    if (!still(g)) return;
    if (!r.ok) { setBusy(''); return fail(r, '내보내기'); }
    setApiErr(null);
    const t = await saveExport(r.data, () => still(g));
    if (!still(g)) return; setBusy('');
    if (t) setExp(`${r.data.filename} · ${kib(r.data.bytes)} KiB · sha256 ${r.data.sha256.slice(0, 16)}… · ${t}`);
  }
  async function openList() {   // 목록은 따로 번호(gen 을 올리면 진행 중 저장 응답이 버려져 busy 가 남음)
    const g = ++listSeq.current, cx = ctx.n; setList('읽는 중');
    const r = await listProjects();
    if (!alive.current || g !== listSeq.current || cx !== ctx.n) return;
    setList(!r.ok ? listErr(r.code, r.error) : brokenTxt(r.data) || r.data.projects); setListNote(r.ok ? damagedTxt(r.data) : null);   // 200 이어도 저장소 이상·손상 따로
  }

  // ---- 파일: JSON 가져오기(새 초안 · 실패면 지금 편집 그대로) / 내보내기 · 도면 ----
  async function importJson(f: File) {
    if (f.size > RLIM.req) return setMsg({ t: `가져오지 않음 · 파일이 256 KiB 를 넘습니다(${kib(f.size)} KiB) · 지금 편집은 그대로`, bad: true });
    const dg = docGen.current, fs = ++fileSeq.current, txt = await f.text();
    if (!alive.current || at.current !== ctx.n || dg !== docGen.current || fs !== fileSeq.current) return;   // fs = 마지막에 고른 파일만(A 다음 B 를 고르면 A 버림)   // 읽는 사이 문서·계정·화면이 바뀜 → 버림(그사이 편집은 아래 okLeave 가 지금 dirty 로 물음)
    const r = parseScene(txt);
    if (typeof r === 'string') return setMsg({ t: `가져오지 않음 · ${r} · 지금 편집은 그대로`, bad: true });
    if (!okLeave()) return;
    replaceDoc(r, { id: null, rev: null }, true, `가져옴 «${r.name}» · 새 초안(아직 저장 안 함) · 정본 검증은 저장할 때 서버`);
  }
  const exportJson = () => toast(saveBlob(`rehearsal-${meta.id || 'draft'}${meta.rev ? `-r${meta.rev}` : ''}.json`, new Blob([sceneJson(s)], { type: 'application/json' })));
  async function addBackground(f: File) {
    if (!/^image\/(png|jpeg|webp|gif|bmp)$/.test(f.type)) return setMsg({ t: '도면은 그림 파일(PNG·JPEG 등)만', bad: true });
    if (f.size > 30 * 1024 * 1024) return setMsg({ t: '도면 원본이 30 MB 를 넘어 열지 않음', bad: true });
    const url = URL.createObjectURL(f), dg = docGen.current, es = editSeq.current, fs = ++fileSeq.current;
    const gone = () => !alive.current || at.current !== ctx.n || dg !== docGen.current || fs !== fileSeq.current;   // 나중에 고른 파일이 있으면 이것은 버림   // 문서·계정·화면이 바뀜 → 글도 안 띄움
    try {
      const im = new Image(); im.src = url; await im.decode();
      const shrink = async (side: number, qq: number) => {
        const k = Math.min(1, side / Math.max(im.naturalWidth, im.naturalHeight)), w = Math.max(1, Math.round(im.naturalWidth * k)), hh = Math.max(1, Math.round(im.naturalHeight * k));
        const c = document.createElement('canvas'); c.width = w; c.height = hh; const g = c.getContext('2d')!; g.fillStyle = '#FFFFFF'; g.fillRect(0, 0, w, hh); g.drawImage(im, 0, 0, w, hh);
        return { b64: c.toDataURL('image/jpeg', qq).split(',')[1] || '', w, h: hh };
      };
      const r = await fitBackground(s, floor, shrink);
      if (gone()) return;
      if (editSeq.current !== es) return setMsg({ t: '도면을 줄이는 사이 설계도를 고쳐서 넣지 않았습니다 · 지금 편집 그대로 — 도면을 다시 넣으세요', bad: true });   // 고친 내용 유실 0
      if (typeof r === 'string') return setMsg({ t: r, bad: true });
      const next = edit(s, (c) => { c.world.background = r.bg; });   // es 같음 = s 가 지금 내용
      if (bytesOf(next) > RLIM.scene) return setMsg({ t: `도면을 넣으면 설계도가 240 KiB 를 넘습니다(${kib(bytesOf(next))} KiB) — 넣지 않음`, bad: true });
      commit(next, r.note);
    } catch (e) { if (!gone()) setMsg({ t: `도면을 읽지 못함 · ${(e as Error)?.message || e}`, bad: true }); }
    finally { URL.revokeObjectURL(url); }
  }

  // ---- 캔버스 조작 ----
  const routeRobot = () => (sel?.k === 'robot' ? S.robots.find((r) => r.id === sel.id) : sel?.k === 'route' ? S.robots.find((r) => r.id === S.routes.find((x) => x.id === sel.id)?.robot) : null);
  const finishRoute = () => {
    if (draft?.kind !== 'route') return;
    const rb = routeRobot(); setDraft(null);
    if (!rb) return setMsg({ t: '경로 로봇이 없습니다 — 로봇을 먼저 고르세요', bad: true });
    if (draft.pts.length < 2) return setMsg({ t: '경로는 점 2개 이상', bad: true });
    if (S.routes.length >= RLIM.routes) return setMsg({ t: '경로는 48개까지', bad: true });
    const id = newId(s, 'p');
    commit(edit(s, (c) => { c.routes.push({ id, robot: rb.id, floor, points: draft.pts.slice(0, RLIM.routePts) }); }), `경로 ${id} 만듦(${rb.name}) · 배치안에 넣으려면 오른쪽 배치안 칸`);
    setSel({ k: 'route', id });
  };
  const onDown = (p0: Vec2, e: React.PointerEvent, tol: number): boolean | void => {
    if (viewOnly || e.button > 0 || busy === 'save') return;
    const p: Vec2 = [snap(p0[0]), snap(p0[1])];
    if (tool === 'V') {
      const hit = hitTest(s, floor, p0, tol); setSel(hit);
      if (!hit) return;
      drag.current = { base: s, from: p, moved: false, pid: e.pointerId, dg: docGen.current, es: editSeq.current }; return true;
    }
    if (tool === 'W') {
      if (!draft) { setDraft({ kind: 'wall', pts: [p, p] }); return true; }
      const a = draft.pts[0];
      if (Math.hypot(p[0] - a[0], p[1] - a[1]) < 0.05) return true;
      if (s.elements.length >= RLIM.elements) { setDraft(null); setMsg({ t: '요소는 1500개까지', bad: true }); return true; }
      const id = newId(s, 'w'); commit(edit(s, (c) => { c.elements.push({ id, type: 'wall', floor, a, b: p, thickness: 0.15, height: 2.4 }); }));
      setDraft({ kind: 'wall', pts: [p, p] }); return true;
    }
    if (tool === 'B') { if (s.elements.length >= RLIM.elements) return setMsg({ t: '요소는 1500개까지', bad: true }), true; const id = newId(s, 'b'); commit(edit(s, (c) => { c.elements.push({ id, type: 'box', floor, center: p, size: [1, 1, 1], yaw: 0 }); })); setSel({ k: 'el', id }); return true; }
    if (tool === 'S') { const st = newStairs(s, floor, p, 0); if (typeof st === 'string') setMsg({ t: st, bad: true }); else { commit(edit(s, (c) => { c.elements.push(st); }), `계단 ${st.id} · ${STAIRS_TAG}`); setSel({ k: 'el', id: st.id }); } return true; }
    if (tool === 'R') {
      if (s.robots.length >= RLIM.robots) return setMsg({ t: '로봇은 12대까지', bad: true }), true;
      const id = newId(s, 'r'); commit(edit(s, (c) => { c.robots.push({ id, name: `로봇 ${c.robots.length + 1}`, model: 'go2_proxy', floor, pose: [p[0], p[1], 0], sensors: [] }); }), `로봇 ${id} · ${MODEL_TAG}`); setSel({ k: 'robot', id }); return true;
    }
    if (tool === 'C') {
      const hit = hitTest(s, floor, p0, tol);
      if (hit?.k !== 'robot') return setMsg({ t: '센서는 로봇에만 붙습니다 — 로봇을 누르세요(고정 카메라는 «장비»)', bad: true }), true;
      const rb = s.robots.find((r) => r.id === hit.id)!;
      if (rb.sensors.length >= RLIM.sensors) return setMsg({ t: '로봇당 센서는 6개까지', bad: true }), true;
      const id = newId(s, `${rb.id.slice(0, 20)}_s`); commit(edit(s, (c) => { c.robots.find((r) => r.id === rb.id)!.sensors.push({ id, kind: 'lidar_unknown', mount: [0.25, 0, 0.1, 0] }); }), `센서 ${id} · ${SENSOR_TAG}`);
      setSel({ k: 'sensor', id, of: rb.id }); return true;
    }
    if (tool === 'E') { if (s.equipment.length >= RLIM.equip) return setMsg({ t: '장비는 200개까지', bad: true }), true; const id = newId(s, 'e'); commit(edit(s, (c) => { c.equipment.push({ id, kind: 'marker', floor, pose: [p[0], p[1], 0], label: '표지' }); })); setSel({ k: 'equip', id }); return true; }
    if (tool === 'P') {
      if (!routeRobot()) return setMsg({ t: '경로 로봇을 먼저 고르세요(선택 도구로 로봇을 누른 뒤 P)', bad: true }), true;
      setDraft((d) => ({ kind: 'route', pts: [...(d?.kind === 'route' ? d.pts : []), p].slice(0, RLIM.routePts) })); return true;
    }
    if (tool === 'K') {
      if (!s.world.background || s.world.background.floor !== floor) return setMsg({ t: '이 층에 도면이 없습니다 — «도면»으로 먼저 넣으세요', bad: true }), true;
      setDraft((d) => (d?.kind === 'scale' && d.pts.length === 1 ? { kind: 'scale', pts: [d.pts[0], p0] } : { kind: 'scale', pts: [p0] })); return true;
    }
  };
  const onMove = (p0: Vec2, e: React.PointerEvent) => {
    const p: Vec2 = [snap(p0[0]), snap(p0[1])], d = drag.current;
    if (d && d.pid !== e.pointerId) return;   // 다른 손가락은 무시
    if (d && (d.es !== editSeq.current || d.dg !== docGen.current)) { onCancel(); return; }   // 그사이 편집·문서 교체 = 끌기 폐기
    if (d && sel) { const dx = r3(p[0] - d.from[0]), dy = r3(p[1] - d.from[1]); if (dx || dy) { d.moved = true; setPreview(moveSel(d.base, sel, dx, dy)); } return; }
    if (draft?.kind === 'wall') setDraft({ kind: 'wall', pts: [draft.pts[0], p] });
  };
  // 놓기 확정은 같은 손가락·같은 문서일 때만(715 U4). 취소(pointercancel·lostpointercapture)는 끌던 것·미리보기만 버림 — 기록 0 · 벽/경로 그리기 중(draft)은 유지
  const onUp = (_: Vec2, e: React.PointerEvent) => { const d = drag.current; drag.current = null; if (d?.moved && preview && d.pid === e.pointerId && d.dg === docGen.current && d.es === editSeq.current) commit(preview); setPreview(null); };
  const onCancel = () => { drag.current = null; setPreview(null); };

  // ---- 단축키: 입력 중이면 무시 · Space 는 손대지 않음(전역 STOP) ----
  const K = useRef<(e: KeyboardEvent) => void>(); K.current = (e) => {
    if (typing(e.target) || viewOnly || e.key === ' ' || busy === 'save') return;
    const m = e.ctrlKey || e.metaKey;
    if (m && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (m && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redo(); return; }
    if (m || e.altKey) return;
    if (e.key === 'Escape') { setDraft(null); onCancel(); return; }   // 끌던 것·미리보기도 버림
    if (e.key === 'Enter' && draft?.kind === 'route') { e.preventDefault(); finishRoute(); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel) { e.preventDefault(); del(); return; }
    const t = TOOLS.find(([k]) => k === e.key.toUpperCase());
    if (t && e.key.length === 1) { pick(t[0]); }
  };
  useEffect(() => { const f = (e: KeyboardEvent) => K.current!(e); addEventListener('keydown', f); return () => removeEventListener('keydown', f); }, []);
  const pick = (t: Tool) => { if (draft?.kind === 'route' && t !== 'P') finishRoute(); else setDraft(null); setTool(t); if (t === 'I') fileI.current?.click(); };
  const del = () => { if (!sel) return; const r = removeSel(s, sel); if (typeof r === 'string') return setMsg({ t: r, bad: true }); commit(r.s, r.note); setSel(null); };

  // ---- 화면 계산 ----
  const local = useMemo(() => checkScene(s), [s]);
  const sc = s.scenarios.find((x) => x.id === scId) || null;
  const allIssues = [...srv.issues];
  const size = useMemo(() => bytesOf(s), [s]);
  const errs = srv.issues.filter((x) => x.level === 'error').length;
  const expWhy = !meta.id ? '저장한 판만 내보냅니다 · 먼저 저장' : dirty ? '저장한 판만 내보냅니다 · 먼저 저장' : apiErr != null ? `리허설 서버 응답 없음(${apiErr || '응답 없음'})` : '';

  // ---- 속성 판 ----
  // 저장 중 편집 잠금(root 10-18): 속성 판은 fieldset disabled 로 실제 입력을 막고, 여기 거부는 그 뒤 방어선(false → Num/Txt 가 표시를 되돌림)
  const lock = busy === 'save';
  const set = (f: (c: Scene) => void, note?: string): boolean => { if (lock) { setMsg({ t: '저장 중 — 끝난 뒤 고치세요(지금 값은 그대로)', bad: true }); return false; } commit(edit(s, f), note); return true; };
  const Insp = () => {
    if (!sel) return <>
      <Txt label="설계도 이름" v={s.name} on={(x) => set((c) => { c.name = x; })} />
      {s.name.startsWith('예시 계획') && <Tag t="예시 계획 · 가상 치수(실제 건물·로봇 측정 아님)" />}
      <Num label="세계 가로" v={s.world.size[0]} min={RLIM.worldMin} max={RLIM.worldMax} on={(n) => set((c) => { c.world.size[0] = n; })} />
      <Num label="세계 세로" v={s.world.size[1]} min={RLIM.worldMin} max={RLIM.worldMax} on={(n) => set((c) => { c.world.size[1] = n; })} />
      <Num label="원점 x" v={s.world.origin[0]} min={-10000} max={10000} on={(n) => set((c) => { c.world.origin[0] = n; })} />
      <Num label="원점 y" v={s.world.origin[1]} min={-10000} max={10000} on={(n) => set((c) => { c.world.origin[1] = n; })} />
      <span className="lbl">{`해상도 0.05 m 고정 · 설계도 ${kib(size)} / 240 KiB`}</span>
      {s.world.background && <div style={{ display: 'grid', gap: 6 }}>
        <span className="lbl">{`도면 · ${s.world.background.floor} 층 · ${kib(b64Bytes(s.world.background.data_b64))} KiB${autoFit(s) ? ' · 도면 축척 안 맞춤' : ' · 축척 맞춤'}`}</span>
        <button type="button" className="btn" onClick={() => set((c) => { c.world.background = null; }, '도면 뺌')}>도면 빼기</button>
      </div>}
    </>;
    if (sel.k === 'floor') {
      const i = s.floors.findIndex((f) => f.id === sel.id), f = s.floors[i]; if (!f) return null;
      const lo = i ? r3(s.floors[i - 1].z + 1) : 0, hi = s.floors[i + 1] ? r3(s.floors[i + 1].z - 1) : 200;   // 서버: z 0–200 · 아래층보다 1 m 이상 위
      return <>
        <Txt label="층 이름" v={f.name} on={(x) => set((c) => { c.floors[i].name = x; })} />
        <Num label="바닥 z" v={f.z} min={lo} max={i ? hi : 0} ro={i === 0} on={i ? (n) => set((c) => { c.floors[i].z = n; }) : undefined} />
        <Num label="층 높이" v={f.height} min={1} max={10} on={(n) => set((c) => { c.floors[i].height = n; })} />
        <button type="button" className="btn" onClick={del}>층 지우기</button>
      </>;
    }
    if (sel.k === 'el') {
      const e = s.elements.find((x) => x.id === sel.id); if (!e) return null;
      const up = (f: (x: Element) => void) => set((c) => { f(c.elements.find((x) => x.id === e.id)!); });
      return <>
        <span className="mono">{`${e.id} · ${e.type === 'wall' ? '벽' : e.type === 'box' ? '상자' : '계단'}`}</span>
        {e.type === 'wall' && <>
          {autoFit(s) && s.world.background?.floor === floor ? <span className="lbl">길이 · 도면 축척 안 맞춤</span> : <span className="lbl">{`길이 ${r3(Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]))} m`} <SourceTag k="geo" /></span>}
          <Num label="두께" v={e.thickness} min={0.05} max={1} on={(n) => up((x) => { (x as typeof e).thickness = n; })} />
          <Num label="높이" v={e.height} min={0.05} max={10} on={(n) => up((x) => { (x as typeof e).height = n; })} />
        </>}
        {e.type === 'box' && <>
          {(['가로', '세로', '높이'] as const).map((l, j) => <Num key={l} label={l} v={e.size[j]} min={0.05} max={50} on={(n) => up((x) => { (x as typeof e).size[j] = n; })} />)}
          <Num label="회전" unit="°" step={1} v={deg(e.yaw)} min={-360} max={360} on={(n) => up((x) => { (x as typeof e).yaw = rad(n); })} />
        </>}
        {e.type === 'stairs' && <>
          <Tag t={STAIRS_TAG} />
          <Num label="단 수(단 높이 자동 = 층 높이 차 ÷ 단 수)" unit="단" step={1} v={e.steps} min={2} max={40} on={(n) => up((x) => {
            const st = x as typeof e, i0 = s.floors.findIndex((f) => f.id === st.floor), dz = (s.floors[i0 + 1]?.z ?? 0) - (s.floors[i0]?.z ?? 0);
            st.steps = Math.round(n); if (dz > 0) st.riser = Math.round((dz / st.steps) * 10000) / 10000; })} />
          <Num label="단 높이" v={e.riser} min={0.05} max={0.25} step={0.0001} on={(n) => up((x) => { (x as typeof e).riser = n; })} />
          <Num label="디딤" v={e.tread} min={0.15} max={0.6} on={(n) => up((x) => { (x as typeof e).tread = n; })} />
          <Num label="폭" v={e.width} min={0.5} max={4} on={(n) => up((x) => { (x as typeof e).width = n; })} />
          <Num label="오르는 방향" unit="°" step={1} v={deg(e.yaw)} min={-360} max={360} on={(n) => up((x) => { (x as typeof e).yaw = rad(n); })} />
          <span className="lbl">{`도착 층 ${e.to_floor} · 단 수 × 단 높이 ${r3(e.steps * e.riser)} m`}</span>
        </>}
        <button type="button" className="btn" onClick={del}>지우기 (Delete)</button>
      </>;
    }
    if (sel.k === 'robot' || sel.k === 'sensor') {
      const rid = sel.k === 'robot' ? sel.id : sel.of!, r = s.robots.find((x) => x.id === rid); if (!r) return null;
      const up = (f: (x: NonNullable<typeof r>) => void) => set((c) => { f(c.robots.find((x) => x.id === r.id)!); });
      const nr = s.routes.filter((x) => x.robot === r.id).length;
      return <>
        <span className="mono">{r.id}</span><Tag t={MODEL_TAG} />
        <Txt label="이름" v={r.name} on={(x) => up((q) => { q.name = x; })} />
        <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>층
          <select className="inp" value={r.floor} onChange={(e) => up((q) => { q.floor = e.target.value; })}>{s.floors.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>
        <Num label="x" v={r.pose[0]} min={s.world.origin[0]} max={s.world.origin[0] + s.world.size[0]} on={(n) => up((q) => { q.pose[0] = n; })} />
        <Num label="y" v={r.pose[1]} min={s.world.origin[1]} max={s.world.origin[1] + s.world.size[1]} on={(n) => up((q) => { q.pose[1] = n; })} />
        <Num label="방향" unit="°" step={1} v={deg(r.pose[2])} min={-360} max={360} on={(n) => up((q) => { q.pose[2] = rad(n); })} />
        <h3 style={{ margin: '6px 0 0', fontSize: 14 }}>{`센서 ${r.sensors.length}/6`}</h3>
        {r.sensors.map((x, j) => <div key={x.id} className="card" style={{ padding: 8, display: 'grid', gap: 6, outline: sel.k === 'sensor' && sel.id === x.id ? '2px solid var(--accent)' : undefined }}>
          <span className="mono">{x.id}</span>
          <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>종류
            <select className="inp" value={x.kind} onChange={(e) => up((q) => { q.sensors[j].kind = e.target.value as SensorKind; })}>{(Object.keys(SENSOR_KO) as SensorKind[]).map((k) => <option key={k} value={k}>{SENSOR_KO[k]}</option>)}</select></label>
          {x.kind.startsWith('lidar') && <Tag t={SENSOR_TAG} />}
          {(['앞(x)', '옆(y)', '높이(z)'] as const).map((l, k) => <Num key={l} label={`붙는 위치 ${l}`} v={x.mount[k]} min={k === 2 ? 0 : -1} max={k === 2 ? 1.5 : 1} step={0.01} on={(n) => up((q) => { q.sensors[j].mount[k] = n; })} />)}
          <Num label="붙는 방향" unit="°" step={1} v={deg(x.mount[3])} min={-360} max={360} on={(n) => up((q) => { q.sensors[j].mount[3] = rad(n); })} />
          <button type="button" className="btn" onClick={() => { const rr = removeSel(s, { k: 'sensor', id: x.id, of: r.id }); if (typeof rr !== 'string') { commit(rr.s, rr.note); setSel({ k: 'robot', id: r.id }); } }}>센서 지우기</button>
        </div>)}
        <button type="button" className="btn" onClick={del}>{`로봇 지우기${nr ? ` (경로 ${nr}개 함께)` : ''}`}</button>
      </>;
    }
    if (sel.k === 'equip') {
      const e = s.equipment.find((x) => x.id === sel.id); if (!e) return null;
      const up = (f: (x: NonNullable<typeof e>) => void) => set((c) => { f(c.equipment.find((x) => x.id === e.id)!); });
      return <>
        <span className="mono">{e.id}</span>
        <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>종류
          <select className="inp" value={e.kind} onChange={(ev) => up((q) => { q.kind = ev.target.value as EquipKind; })}>{(Object.keys(EQUIP_KO) as EquipKind[]).map((k) => <option key={k} value={k}>{EQUIP_KO[k]}</option>)}</select></label>
        <Txt label="이름표" v={e.label} on={(x) => up((q) => { q.label = x; })} />
        <Num label="방향" unit="°" step={1} v={deg(e.pose[2])} min={-360} max={360} on={(n) => up((q) => { q.pose[2] = rad(n); })} />
        <button type="button" className="btn" onClick={del}>지우기 (Delete)</button>
      </>;
    }
    if (sel.k === 'route') {
      const r = s.routes.find((x) => x.id === sel.id); if (!r) return null;
      return <>
        <span className="mono">{`${r.id} · ${s.robots.find((x) => x.id === r.robot)?.name || r.robot}`}</span>
        <span>{`점 ${r.points.length}개 · 길이 ${r3(pathLen(r.points))} m `}<SourceTag k="geo" /></span>
        <button type="button" className="btn" disabled={r.points.length <= 2} onClick={() => set((c) => { c.routes.find((x) => x.id === r.id)!.points.pop(); }, '마지막 점 뺌')}>마지막 점 빼기</button>
        <button type="button" className="btn" onClick={del}>경로 지우기 (Delete)</button>
      </>;
    }
    if (sel.k === 'scenario' && sc) return <>
      <Txt label="배치안 이름" v={sc.name} on={(x) => set((c) => { c.scenarios.find((q) => q.id === sc.id)!.name = x; })} />
      <span className="lbl">경로를 넣으면 그 로봇도 들어가고, 로봇을 빼면 그 로봇 경로도 빠집니다</span>
      {s.robots.map((r) => <label key={r.id} style={{ display: 'flex', gap: 8, alignItems: 'center', minHeight: 36 }}><input type="checkbox" checked={sc.robots.includes(r.id)} onChange={() => commit(toggleIn(s, sc.id, 'robots', r.id))} />{`${r.name} (${r.id})`}</label>)}
      {s.routes.map((r) => <label key={r.id} style={{ display: 'flex', gap: 8, alignItems: 'center', minHeight: 36, paddingLeft: 16 }}><input type="checkbox" checked={sc.routes.includes(r.id)} onChange={() => commit(toggleIn(s, sc.id, 'routes', r.id))} />{`경로 ${r.id} · ${r.robot}`}</label>)}
      <button type="button" className="btn" onClick={() => { const rr = removeSel(s, { k: 'scenario', id: sc.id }); if (typeof rr !== 'string') { commit(rr.s, rr.note); setScId(null); setSel(null); } }}>배치안 지우기</button>
    </>;
    return null;
  };

  // ---- 그리기 ----
  const tab = (on: boolean): React.CSSProperties => ({ minHeight: 36, padding: '0 12px', borderRadius: 6, border: `1px solid ${on ? 'var(--accent)' : 'var(--line)'}`, background: on ? 'var(--acc-bg)' : 'var(--panel)', color: 'var(--text)', cursor: 'pointer' });
  const status = busy === 'save' ? '저장 중…' : busy === 'load' ? '불러오는 중…' : dirty ? '저장 안 한 변경 있음' : meta.id ? '저장됨' : '새 설계도(저장 전)';
  const head = <>
    <span className="lbl" data-save-state>{`${meta.id ? `판 r${meta.rev}` : '새 설계도'} · ${status}`}</span>
    {!viewOnly && <>
      <button type="button" className="btn" disabled={!!busy} onClick={review}>{busy === 'analyze' ? '검토 중…' : '검토'}</button>
      <button type="button" className="btn" disabled={!!busy || !dirty && !!meta.id} onClick={() => save()} style={{ background: 'var(--accent)', color: 'var(--on-accent)', borderColor: 'var(--accent)' }}>{busy === 'save' ? '저장 중…' : '저장'}</button>
    </>}
    <button type="button" className="btn" disabled={!!busy || !!expWhy} title={expWhy || undefined} onClick={exportZip}>{busy === 'export' ? '내보내는 중…' : expWhy ? `묶음 내보내기 · ${expWhy}` : `세계·지도 묶음 내보내기 (r${meta.rev})`}</button>
  </>;
  const grid: React.CSSProperties = wide ? { display: 'grid', gridTemplateColumns: viewOnly ? '1fr 320px' : '64px 1fr 320px', gap: 12, padding: 12 } : { display: 'grid', gridTemplateColumns: viewOnly ? '1fr' : '64px 1fr', gap: 12, padding: 12 };

  return (
    <PcFrame cur="MapEditor" sub="지도 편집" title={s.name} head={head}>
      {!viewOnly && !wide && <div role="note" style={{ padding: '8px 16px', fontSize: 13, background: 'var(--panel2)' }}>편집은 1280px 이상 권장</div>}
      {viewOnly && <div role="note" style={{ padding: '8px 16px', fontSize: 14, background: 'var(--panel2)' }}>보기 전용 · 이 폭에서는 편집 도구를 숨깁니다</div>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '10px 12px 0', alignItems: 'center' }}>
        <button type="button" className="btn" disabled={!!busy} onClick={() => { if (okLeave()) replaceDoc(blankScene(), { id: null, rev: null }, false, '새 설계도 · 빈 1층 20×20 m'); }}>새 설계도</button>
        <button type="button" className="btn" disabled={!!busy} onClick={openList}>저장본 열기</button>
        <button type="button" className="btn" disabled={!!busy} onClick={() => { if (okLeave()) replaceDoc(exampleScene(), { id: null, rev: null }, true, `${EXAMPLE_NAME} · 예시 계획 초안(가상 치수) · 저장하면 새 프로젝트`); }}>예시 계획 불러오기</button>
        <button type="button" className="btn" disabled={!!busy} onClick={() => fileJ.current?.click()}>JSON 가져오기</button>
        <button type="button" className="btn" onClick={exportJson}>JSON 내보내기</button>
        {!viewOnly && <><button type="button" className="btn" disabled={!h.past.length} onClick={undo} aria-keyshortcuts="Control+Z">되돌리기</button>
          <button type="button" className="btn" disabled={!h.fut.length} onClick={redo} aria-keyshortcuts="Control+Shift+Z Control+Y">다시 하기</button></>}
        <input ref={fileJ} type="file" accept="application/json,.json" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importJson(f); }} />
        <input ref={fileI} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; setTool('V'); if (f) void addBackground(f); }} />
      </div>
      {msg && <p role="status" style={{ margin: '8px 12px 0', padding: '8px 12px', borderLeft: `4px solid ${msg.bad ? 'var(--bad)' : 'var(--accent)'}`, background: 'var(--panel)', whiteSpace: 'pre-line' }}>{msg.t}</p>}
      {conflict && <div role="alert" style={{ margin: '8px 12px 0', padding: 12, border: '1px solid var(--warn)', borderRadius: 8, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <span>{`다른 곳에서 r${conflict.rev} 가 저장됨 · 내 초안은 남아 있습니다`}</span>
        <button type="button" className="btn" onClick={() => open_(`#/MapEditor?id=${encodeURIComponent(meta.id || '')}`)}>서버 판 열어 비교(다른 탭)</button>
        <button type="button" className="btn" disabled={!!busy} onClick={() => save(conflict.rev)}>내 초안으로 새 판 저장(서버 판 위에)</button>
      </div>}
      {exp && <p role="status" style={{ margin: '8px 12px 0', padding: '8px 12px', background: 'var(--panel)', borderLeft: '4px solid var(--accent)' }}>{exp}<br /><span className="lbl">{EXPORT_NOTE}</span></p>}
      {list && <div className="card" style={{ margin: '8px 12px 0', padding: 12, display: 'grid', gap: 6 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}><strong>저장본</strong><button type="button" className="btn" onClick={() => setList(null)}>닫기</button></div>
        {listNote && typeof list !== 'string' && <span role="alert">{listNote}</span>}
        {typeof list === 'string' ? <span role={list === '읽는 중' ? undefined : 'alert'}>{list}</span> : !list.length ? <span>{listNote ? '열 수 있는 리허설 프로젝트가 없습니다' : '리허설 프로젝트가 없습니다'}</span>
          : list.map((p) => <button key={p.id} type="button" className="btn" style={{ justifyContent: 'flex-start' }} onClick={() => {   // 주소만 바꾸고 여는 것은 주인 effect(U2) · 주소가 이미 그 id 거나 지금 문서가 그 id 면 effect 가 안 돌므로 여기서 한 번
                if (!okLeave()) return; setList(null);
                if (p.id === qid || p.id === meta.id) { if (p.id !== qid) history.replaceState(null, '', `#/MapEditor?id=${encodeURIComponent(p.id)}`); void open(p.id); return; }
                leaveOk.current = true; setQ('id', p.id); }}>{`${p.name} · r${p.rev} · ${p.at}`}</button>)}
      </div>}
      <div style={grid}>
        {!viewOnly && <div role="toolbar" aria-label="편집 도구" aria-orientation="vertical" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {TOOLS.map(([k, t]) => <button key={k} type="button" className="tool" aria-pressed={tool === k} title={`${t} (${k}) · ${HELP[k]}`} aria-keyshortcuts={k} onClick={() => pick(k)} style={{ minHeight: 44, flexDirection: 'column', gap: 0, justifyContent: 'center' }}>
            <span style={{ fontSize: 13 }}>{t}</span><span className="mono" style={{ fontSize: 12 }}>{k}</span></button>)}
        </div>}
        <section style={{ minWidth: 0, display: 'grid', gap: 8, alignContent: 'start' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            <span className="lbl">층</span>
            {s.floors.map((f) => <button key={f.id} type="button" style={tab(floor === f.id)} onClick={() => { setFloor(f.id); setSel({ k: 'floor', id: f.id }); setDraft(null); }}>{`${f.name} z ${f.z}`}</button>)}
            {!viewOnly && <button type="button" style={tab(false)} disabled={lock || s.floors.length >= RLIM.floors} onClick={() => {
              const last = s.floors[s.floors.length - 1], id = newId(s, 'f');
              const z = r3(last.z + Math.max(1, last.height)); if (z > 200) return setMsg({ t: '층 바닥 z 는 200 m 까지', bad: true });
              set((c) => { c.floors.push({ id, name: `${c.floors.length + 1}층`, z, height: last.height }); }, `층 ${id} 더함`); setFloor(id);
            }}>+층</button>}
            <span className="lbl" style={{ marginLeft: 12 }}>배치안</span>
            <button type="button" style={tab(!scId)} onClick={() => setScId(null)}>전체</button>
            {s.scenarios.map((x) => <button key={x.id} type="button" style={tab(scId === x.id)} onClick={() => { setScId(x.id); setSel({ k: 'scenario', id: x.id }); }}>{x.name}</button>)}
            {!viewOnly && <button type="button" style={tab(false)} disabled={lock || s.scenarios.length >= RLIM.scenarios} onClick={() => { const id = newId(s, 'sc'); set((c) => { c.scenarios.push({ id, name: `배치안 ${c.scenarios.length + 1}`, robots: [], routes: [] }); }); setScId(id); setSel({ k: 'scenario', id }); }}>+</button>}
          </div>
          <p className="lbl" style={{ margin: 0 }}>{viewOnly ? '보기 전용' : `${TOOLS.find(([k]) => k === tool)![1]} · ${HELP[tool]}`}</p>
          {draft?.kind === 'route' && <div style={{ display: 'flex', gap: 8 }}><span>{`경로 점 ${draft.pts.length}개`}</span><button type="button" className="btn" disabled={lock} onClick={finishRoute}>경로 끝 (Enter)</button><button type="button" className="btn" onClick={() => setDraft(null)}>취소 (Esc)</button></div>}
          {draft?.kind === 'scale' && draft.pts.length === 2 && <form style={{ display: 'flex', gap: 8, alignItems: 'center' }} onSubmit={(e) => {
            e.preventDefault(); const b = s.world.background; if (!b) return;
            const r = rescale(b, draft.pts[0], draft.pts[1], Number(scaleD));
            if (typeof r === 'string') return setMsg({ t: r, bad: true });
            commit(edit(s, (c) => { c.world.background = r; }), '도면 축척 맞춤(첫 점 자리·방향 유지)'); setDraft(null); setScaleD('');
          }}><label>두 점 사이 실제 거리(m) <input className="inp mono" style={{ width: 120, height: 36 }} inputMode="decimal" value={scaleD} onChange={(e) => setScaleD(e.target.value)} /></label><button type="submit" className="btn" disabled={lock}>축척 적용</button></form>}
          <SceneCanvas scene={S} floor={floor} sel={sel} scenario={sc} analysis={srv.analysis} issues={allIssues} draft={draft} focus={focus}
            height="calc(100vh - 300px)" label={`설계도 ${s.name} · ${s.floors.find((f) => f.id === floor)?.name || ''}`} onDown={onDown} onMove={onMove} onUp={onUp} onCancel={onCancel} />
          <span className="lbl">{`도면 투명도 ${bgAlpha}(화면 전용) · 계획 · 2D 기하 검토 — 물리·넘어짐·실제 도달 판정 아님`}</span>
        </section>
        <aside style={{ display: 'grid', gap: 10, alignContent: 'start', gridColumn: wide ? undefined : '1 / -1' }}>
          {!viewOnly && <div className="card" style={{ padding: 12, display: 'grid', gap: 8 }}><h2 style={{ margin: 0, fontSize: 15 }}>속성</h2>
            <fieldset disabled={lock} aria-label={lock ? '저장 중 · 편집 잠금' : undefined} style={{ border: 0, padding: 0, margin: 0, minWidth: 0, display: 'grid', gap: 8 }}>{lock && <span className="lbl">저장 중 · 편집 잠금(보기·이동·STOP 은 됨)</span>}{Insp()}</fieldset></div>}
          <div className="card" style={{ padding: 12, display: 'grid', gap: 6 }}>
            <h2 style={{ margin: 0, fontSize: 15 }}>검토 결과</h2>
            {srv.analysis && <p style={{ margin: 0, fontSize: 13 }}>{srv.analysis.note}</p>}
            {srv.analysis?.truncated && <p style={{ margin: 0, fontSize: 13 }}>경고가 200건을 넘어 일부만 보입니다</p>}
            <p className="lbl" style={{ margin: 0 }}>저장은 오류가 없을 때만 됩니다(경고는 있어도 저장됨)</p>
            {srv.from ? <span className="lbl">{`${srv.from} · 오류 ${errs} · 경고 ${srv.issues.length - errs}${srv.stale ? ' · 검토 뒤 편집됨 — 위치는 옛 내용 기준, 다시 검토' : ''}`}</span> : <span className="lbl">아직 검토 안 함 — «검토»를 누르면 서버가 초안을 계산합니다</span>}
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 4, maxHeight: 320, overflow: 'auto' }}>
              {srv.issues.map((x, i) => <li key={i}><button type="button" className="btn" style={{ width: '100%', height: 'auto', minHeight: 36, justifyContent: 'flex-start', textAlign: 'left', fontWeight: 400 }}
                onClick={() => { if (x.floor) setFloor(x.floor); if (x.at) setFocus({ at: x.at, n: Date.now() }); }}>
                <span aria-hidden="true" style={{ color: x.level === 'error' ? 'var(--bad)' : 'var(--warn)' }}>{x.level === 'error' ? '■' : '▲'}</span>
                <span>{`${x.level === 'error' ? '오류' : '경고'} · ${x.msg}`}<span className="lbl">{` ${x.code}${x.path ? ` · ${x.path}` : ''}`}</span></span></button></li>)}
            </ul>
            {local.length > 0 && <details><summary className="lbl">{`화면 입력 검사 ${local.length}건(편의 · 정본은 서버)`}</summary>
              <ul style={{ margin: 0, paddingLeft: 16, fontSize: 13 }}>{local.map((x, i) => <li key={i}>{`${x.level === 'error' ? '■' : '▲'} ${x.msg}`}</li>)}</ul></details>}
          </div>
        </aside>
      </div>
    </PcFrame>
  );
}
const open_ = (h: string) => { window.open(h, '_blank', 'noopener'); };
