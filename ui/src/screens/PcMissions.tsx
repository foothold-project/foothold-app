// PC 임무 양식(원본 목록·편집·모듈·규칙 틀 그대로) — web/live.js pagePcMissions 와 같은 규칙.
// 저장은 서버 문서(kind 'tmpl') · 입력 칸을 벗어날 때 저장 · 409/404 에도 초안 유지(editor). 규칙 자동 실행·가스·AI·음성은 미연결.
import { useEffect, useRef, useState } from 'react';
import type { Tmpl } from '@contracts';
import { CSS, View } from './PcMissions.view';
import { fmtT, themeClass } from '../data/fmt';
import { docById, docsOf, useDocs } from '../data/shared';
import { useEditor } from '../data/editor';
import { MOD_DEF, MOD_OFF, RULE_WHY, plain, tmpls } from '../data/tmpl';
import { STOP_FACT } from '../data/facts';
import { href } from '../data/hist';
import { LiveStatus } from '../app/status';
import { stopProps, toast, useRoute, whyProps } from '../app/shell';

const CATALOG = ['사진', '운영자 확인', 'AI 탐지', '가스 측정', '대기', '음성 방송'];
const PANEL: Record<string, string> = { '사진': '사진 줄', '운영자 확인': '확인 요청 카드' };
const SEC: Record<string, string> = { '사진': '지점 사진', '운영자 확인': '운영자 판단 기록' };
const COL: Record<string, string> = { '사진': '사진 수', '운영자 확인': '운영자 판단', '대기': '대기 시간' };
const uniq = (a: (string | undefined)[]) => a.filter((x, i): x is string => !!x && a.indexOf(x) === i);
const kindCls = (k: string) => (k === '기본' ? 'base' : '');

export default function PcMissions() {
  const D = useDocs(), E = useEditor<Tmpl>('tmpl'), { q, setQ } = useRoute();
  const sel = q.get('tmpl') || 'base', made = useRef<string | null>(null);   // made: 방금 만든 양식 id(목록이 아직 안 읽혔어도 기본으로 되돌리지 않음)
  const [gone, setGone] = useState<Tmpl | null>(null);

  const selR = useRef(sel); selR.current = sel;   // 응답이 왔을 때의 고른 양식(지연 응답이 그사이 고른 것을 덮지 않게)
  useEffect(() => {   // 고른 양식을 편집기에 — 고치는 중(dirty)·저장 중이면 그대로
    // 404 «새 문서로 저장»으로 id 가 바뀐 경우: 지워진 옛 id 대신 새 id 를 계속 고름(기본으로 되돌아가지 않음)
    if (E.id && E.id !== sel && sel !== 'base' && sel !== made.current && D.rev != null && !docById(D, sel) && !E.busy) { made.current = E.id; return setQ('tmpl', E.id); }
    if (sel !== 'base' && D.rev != null && !docById(D, sel) && sel !== made.current && !E.busy && !E.dirty) return setQ('tmpl', 'base');
    if (docById(D, sel)) made.current = null;
    if (!q.get('tmpl')) return setQ('tmpl', sel);
    if (sel === 'base') { if (E.id || E.d) E.load(null); return; }
    const d = docById(D, sel); if (d && (E.id !== sel || (!E.dirty && !E.busy && d.rev > (E.rev ?? 0)))) E.load(d);
  });

  const pick = (id: string) => { if (E.busy) return toast('저장 중 — 잠시 뒤 다시 고르세요'); if (E.dirty && !confirm('저장 안 한 수정이 있습니다. 버릴까요?')) return; E.dirty = false; setGone(null); setQ('tmpl', id); };
  const create = async (doc: Tmpl, what: string) => {   // 공용 쓰기 계약(editor.write): 응답 때 같은 화면·같은 초안일 때만 새 양식으로 옮김
    if (E.dirty && !confirm('저장 안 한 수정이 있습니다. 버릴까요?')) return;
    const from = selR.current, w = await E.write({ op: 'put', kind: 'tmpl', id: null, doc }); if (!w) return;
    if (!w.r.ok) return toast(`${what} 안 됨 · ${w.r.error}`);
    if (!w.same || selR.current !== from) return toast(`${what} · 서버에 저장됨(판 ${w.r.rev}) — 그사이 화면이 바뀌어 자동으로 열지 않음`);
    E.dirty = false; made.current = w.r.id; setGone(null); toast(`${what} · 모든 기기 공유`); setQ('tmpl', w.r.id);
  };
  const commit = (k: 'name' | 'desc', val: string) => {   // 입력 칸을 벗어날 때 저장
    if (sel === 'base' || !E.d || !E.dirty) return;
    E.d[k] = val;
    if (!E.d.name.trim()) { E.msg = <p className="lv-note">이름을 넣어야 저장됩니다 — 초안은 화면에 그대로</p>; return E.touch(); }
    E.save();
  };
  const upd = (mods: Tmpl['mods']) => {   // 모듈 더하기·빼기·내용 고치기 → 바로 서버 저장
    if (sel === 'base' || !E.d) return toast('기본 양식은 고칠 수 없습니다 · 복제해서 고치세요');
    if (E.busy) return toast('저장 중 — 잠시 뒤');
    E.d = plain({ ...E.d, mods }); E.dirty = true; E.save();
  };

  const runs = docsOf(D, 'run');
  const list = tmpls(D).map((t) => (t.id === sel && E.id === sel && E.d ? { ...t, ...E.d } : t));
  // 서버 목록에 없는 편집 중 초안(밖에서 지워짐·404 뒤 새로 저장한 직후): 기본 양식으로 바꿔 보이지 않고 내 초안을 그대로 보임
  const orphan = !!(E.id && E.id === sel && E.d && !list.some((t) => t.id === sel));
  if (orphan) list.push({ id: sel, kind: '팀', locked: false, ...E.d! });
  const cur = list.find((t) => t.id === sel) || list[0], mods = cur.mods, full = mods.length >= 6, has = (ty: string) => mods.some((m) => m.type === ty);
  const edit = (i: number) => { const y = prompt(`${mods[i].type} — 내용`, mods[i].detail); if (y == null || !y.trim()) return; upd(mods.map((x, j) => (j === i ? { ...x, detail: y.trim().slice(0, 80) } : x))); };
  const types = mods.map((m) => m.type);
  const fixedRule = (c: string, a: string, k: number) => (
    <div className="rule" key={k} style={{ borderStyle: 'dashed', color: 'var(--muted)' }}>
      <span><span className="lbl">현재 v2 서버 · 항상 적용(끌 수 없음)</span><br />{c}</span><span aria-hidden="true">→</span><span><span className="lbl" /><br />{a}</span><span />
    </div>);
  const v = {
    themeClass: themeClass(true), status: <LiveStatus D={D} />, stopProps,
    count: `${list.length}개`,
    items: list.map((t) => {
      const used = runs.filter((r) => r.doc.tmpl === t.name).length, edited = t.locked ? '기본 제공' : `${t.by} · ${fmtT(t.at)}`;
      return { name: t.name, kind: t.kind, kindCls: kindCls(t.kind), summary: `이동 · ${t.mods.length ? t.mods.map((m) => m.type).join(' · ') : '할 일 없음'}`,
        meta: used ? `사용 ${used}회 · ${edited}` : edited, blocked: false, cls: t.id === cur.id ? 'sel' : '', pressed: String(t.id === cur.id), pick: () => pick(t.id) };
    }),
    cur: { name: cur.name, desc: cur.desc, kind: cur.kind + (cur.locked ? ' 양식 · 잠김' : ' 양식'), kindCls: kindCls(cur.kind), locked: cur.locked,
      saved: cur.locked ? '기본 제공 · 모든 기기 공통 · 고칠 수 없음' : E.busy ? '저장 중…' : orphan ? '서버 목록에 없음(지워졌거나 아직 안 읽힘) — 내 초안은 화면에 그대로' : E.dirty ? '저장 안 됨 — 입력 칸을 벗어나면 저장' : `자동 저장 · ${cur.by} · ${fmtT(cur.at)} · 판 ${E.rev}` },
    mods: mods.map((m, i) => ({ no: String(i + 1), type: m.type, detail: m.detail, cls: '', delLabel: `${m.type} 모듈 삭제`, del: () => upd(mods.filter((_, j) => j !== i)),
      detProps: cur.locked ? {} : { role: 'button', tabIndex: 0, title: '눌러서 내용 고치기', style: { cursor: 'pointer' }, onClick: () => edit(i), onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter') edit(i); } } })),
    noMods: mods.length === 0,
    palette: CATALOG.map((ty) => ({ type: ty, add: () => upd([...mods, { type: ty as Tmpl['mods'][number]['type'], detail: MOD_DEF[ty] }]),
      ...(MOD_OFF[ty] ? { off: true, why: MOD_OFF[ty] } : cur.locked ? { off: true, why: '기본 양식은 고칠 수 없습니다' } : has(ty) && ty !== '대기' ? { off: true, why: '이미 들어 있음' } : full ? { off: true, why: '모듈은 6개까지' } : { off: false, why: '' }) })),
    offL: `${Object.keys(MOD_OFF).join(' · ')} — 현재 v2 연결에 미연결(저장·실행 안 함) · 열화상 — 장비 미등록`,
    rules: [], ruleWhy: <div className="lbl">{RULE_WHY}</div>,
    fixed: <>{fixedRule(STOP_FACT[0], STOP_FACT[1], 0)}{fixedRule(STOP_FACT[2], STOP_FACT[3], 1)}</>,
    addRuleProps: { ...whyProps(RULE_WHY), className: 'btn lv-why' },
    panels: uniq(types.map((t) => PANEL[t])), sections: uniq(types.map((t) => SEC[t])), cols: ['도착 시각', ...uniq(types.map((t) => COL[t])), '판정'].join(' · '),
    planHref: href('PcPlan', { tmpl: sel }),
    add: () => create({ name: `새 임무 양식 ${new Date().toTimeString().slice(0, 5)}`, desc: '', mods: [{ type: '사진', detail: MOD_DEF['사진'] }] }, '새 양식 만듦'),
    dup: () => create({ ...plain(cur), name: `${cur.name} 복사본`.slice(0, 60) }, '복제됨'),
    remove: async () => {
      if (cur.locked || !E.id || E.busy || !E.d) return;
      const sent = plain(E.d), from = selR.current, w = await E.write({ op: 'del', id: E.id, rev: E.rev! }); if (!w) return;   // 지운 것 = 보낸 때의 초안
      if (!w.r.ok) return toast(w.r.code === 409 ? '다른 기기가 먼저 고침 — 최신 판을 확인한 뒤 다시 지우세요' : `지우지 못함 · ${w.r.error}`);
      if (!w.same || selR.current !== from) return toast(`«${sent.name}» 지움 · 모든 기기 공유 — 그사이 화면이 바뀌어 지금 화면은 그대로`);
      setGone(sent); E.load(null); setQ('tmpl', 'base');
    },
    undo: () => gone && create(gone, '되돌림(새 양식으로 다시 저장)'),
    hasToast: !!gone, toastName: gone ? gone.name : '',
    rename: (e: React.ChangeEvent<HTMLInputElement>) => { if (E.d) { E.d.name = e.target.value; E.dirty = true; E.touch(); } },
    redesc: (e: React.ChangeEvent<HTMLInputElement>) => { if (E.d) { E.d.desc = e.target.value; E.dirty = true; E.touch(); } },
    nmP: { maxLength: 60, onBlur: (e: React.FocusEvent<HTMLInputElement>) => commit('name', e.target.value) },
    dsP: { maxLength: 120, onBlur: (e: React.FocusEvent<HTMLInputElement>) => commit('desc', e.target.value) },
    msg: E.msg,
  };
  return <><style>{CSS}</style><div id="dc-root"><View v={v} /></div></>;
}
