// PC 기록(원본 요약 카드·검색줄·표·쪽 넘김) — web/live.js pagePcHistory 와 같은 규칙. 예시 행·숫자는 쓰지 않는다.
// U3-b(v3 §4 PcHistory): 임무 | 관찰 사진 | 사건 3탭(기본 임무, 주소 ?tab= — 상세에서 뒤로 오면 같은 탭). 거르기는 hist.ts histFilter 하나.
import { useState } from 'react';
import { CSS, View } from './PcHistory.view';
import { LV, fmtT, saveBlob, themeClass } from '../data/fmt';
import { useDocs, useMedia } from '../data/shared';
import { histCSV, histFilter, histRows, href, TAB_F, type HF, type Row, type Tab } from '../data/hist';
import { LiveStatus, MediaStale } from '../app/status';
import { stopProps, toast, useRoute } from '../app/shell';

const N = 20;
const TABS: [Tab, string, string][] = [['임무', '임무', 'mission'], ['사진', '관찰 사진', 'photo'], ['사건', '사건', 'event']];
const COLS: Record<Tab, string[]> = { '임무': ['일시', '임무', '양식', '운영자', '소요', '지점', '결과', '사진', '보고서'], '사진': ['일시', '분류', '위치', '찍은 사람', '메모', '사진'], '사건': ['일시', '사건', '심각도', '상세'] };
const RIGHT = new Set(['소요', '지점', '사진']);
const PH: Record<Tab, string> = { '임무': '임무 이름 · 양식 · 메모', '사진': '위치 · 메모', '사건': '사건 문장 · 원문' };
const NOTE: Record<Tab, string> = { '임무': '임무 기록 전부(서버 문서)', '사진': '받은 최근 사진 200장 안에서', '사건': '받은 최근 사건 300건 안에서(정보 사건 제외)' };
const F0: HF = { q: '', per: '최근 30일', tpl: '', res: '모든 결과', by: '' };

export default function PcHistory() {
  const D = useDocs(), M = useMedia(), { q: rq, setQ } = useRoute();
  const tab: Tab = TABS.some(([k]) => k === rq.get('tab')) ? rq.get('tab') as Tab : '임무', [, tLabel, tEn] = TABS.find(([k]) => k === tab)!;
  const [f, setF] = useState(F0), [page, setPage] = useState(0);
  const set = (k: keyof HF) => (e: { target: { value: string } }) => { setF({ ...f, [k]: e.target.value }); setPage(0); };
  // 탭 이동: 1쪽 · 검색·기간 유지 · 탭 필터(양식·결과·운영자)는 기본값으로(숨은 필터가 남아 몰래 거르지 않게)
  const go = (k: Tab) => { if (k === tab) return; setF({ ...F0, q: f.q, per: f.per }); setPage(0); setQ('tab', k); };
  const all = histRows(D, M, true), runs = all.filter((r) => r.kind === '임무'), ph = all.filter((r) => r.kind === '사진');
  const runsOk = D.rev != null, on = TAB_F[tab];
  const tpls = [...new Set(runs.map((r) => r.tmpl).filter(Boolean))] as string[];
  const bys = [...new Set(all.filter((r) => r.kind === tab).map((r) => r.by).filter(Boolean))] as string[];
  const hf: HF = { ...f, tpl: tpls.includes(f.tpl) ? f.tpl : '', by: bys.includes(f.by) ? f.by : '' };   // 목록에서 사라진 값이면 «모두»로
  const { tab: rows, every } = histFilter(all, tab, hf);
  const kinds = TABS.map(([k, l]) => `${l} ${every.filter((r) => r.kind === k).length}`).join(' · ');
  const pages = Math.max(1, Math.ceil(rows.length / N)), pg = Math.min(page, pages - 1), s0 = Math.max(0, Math.min(pg - 2, pages - 5));
  const opts = (first: string | null, vals: string[]) => <>{first != null && <option value="">{first}</option>}{vals.map((x) => <option key={x} value={x}>{x}</option>)}</>;
  const hide = (k: 'tpl' | 'res' | 'by') => (on.includes(k) ? {} : { hidden: true, 'aria-hidden': true, tabIndex: -1 });
  const pb = (t: string, p: number, lab?: string, cur?: boolean) => {
    const off = p < 0 || p >= pages;
    return <button key={`${t}${p}`} className="btn" aria-label={lab} aria-current={cur ? 'page' : undefined} disabled={off} onClick={() => setPage(p)}
      style={off ? { opacity: '.5' } : cur ? { background: 'var(--acc-bg)', borderColor: 'var(--accent)' } : undefined}>{t}</button>;
  };
  const csv = (rs: Row[], name: string, what: string) => toast(saveBlob(`foothold-v2-history-${name}-${Date.now()}.csv`, new Blob([histCSV(rs)], { type: 'text/csv' })).then((x) => x && `${what} · ${rs.length}행 · ${x}`));
  const res = (r: Row) => <span className={`res ${r.lvl}`}>{`${LV[r.lvl] || '·'} ${r.res}`}</span>;
  const cell = (r: Row): JSX.Element[] => tab === '임무' ? [
    <td key="n"><a href={r.href} style={{ color: 'inherit', fontWeight: '600' }}>{r.title}</a></td>, <td key="t">{r.tmpl || '—'}</td>, <td key="b">{r.by || '—'}</td>,
    <td key="d" className="mono r">{r.dur || '—'}</td>, <td key="p" className="mono r">{r.pts || '—'}</td>, <td key="r">{res(r)}</td>, <td key="f" className="mono r">{String(r.photos ?? 0)}</td>,
    <td key="h"><a href={r.href} style={{ color: 'var(--accent)' }}>보고서</a></td>]
    : tab === '사진' ? [<td key="r">{res(r)}</td>, <td key="s" className="mono">{r.sub}</td>, <td key="b">{r.by || '—'}</td>, <td key="m" style={{ whiteSpace: 'normal' }}>{r.extra || '—'}</td>,
      <td key="h" className="r"><a href={r.href} style={{ color: 'var(--accent)' }}>열기</a></td>]
    : [<td key="e" style={{ whiteSpace: 'normal' }}>{r.show !== r.title
        ? <details><summary style={{ cursor: 'pointer', fontWeight: '600' }}>{r.show}</summary><span className="lbl">{`원문: ${r.title}`}</span></details>   // 펼치면 원문(누가·원인 추정 0)
        : <span style={{ fontWeight: '600' }}>{r.title}</span>}</td>,
      <td key="r">{res(r)}</td>, <td key="h"><a href={r.href} style={{ color: 'var(--accent)' }}>상세 ›</a></td>];
  const nc = COLS[tab].length, one = (x: JSX.Element | string) => <tr><td colSpan={nc} style={{ whiteSpace: 'normal' }}>{x}</td></tr>;
  const empty = tab === '임무'
    ? (!runsOk ? one(D.err || '임무 기록 읽는 중…') : !runs.length ? one(<span style={{ display: 'inline-flex', gap: '10px', alignItems: 'center' }}>아직 임무 기록이 없습니다
        <a className="btn" href={href('PcPlan')} title="임무 계획에서 계획을 고르고 «수동 진행 시작»" style={{ textDecoration: 'none' }}>임무 시작</a></span>) : one('해당 기록 없음'))
    : !M.ok ? one(M.err || '서버 기록 읽는 중…') : !all.some((r) => r.kind === tab) ? one(tab === '사진' ? '받은 관찰 사진 없음' : '받은 경고·위험 사건 없음') : one('해당 기록 없음');
  const st = (fn: (r: Row) => boolean) => runs.filter(fn).length, bad = M.events.filter((e) => e.st === 'bad').length, warn = M.events.filter((e) => e.st === 'warn').length;
  const wait = ph.filter((r) => r.wait).length;
  const v = {
    themeClass: themeClass(true), h2: '기록', status: <><LiveStatus D={D} /><MediaStale M={M} D={D} /></>, stopProps,
    stats: [
      ['임무', runsOk ? String(runs.length) : '—', ([['완료', st((r) => r.st === '완료')], ['실패·중단', st((r) => /실패|중단/.test(r.st || ''))], ['진행', st((r) => r.st === '진행')]] as [string, number][])
        .filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(' · ')],   // 0 인 보조 항목은 접음
      ['위험 사건', M.ok ? String(bad) : '—', M.ok ? `받은 최근 사건 중 · 경고 ${warn}` : '받은 최근 사건 중'],   // Event.st=bad 기록 수(현재 미해소·전체 기간 아님)
      ['관찰 사진 분류 대기', M.ok ? String(wait) : '—', wait ? '지금 분류 →' : ''],
      ['관찰 사진', M.ok ? String(ph.length) : '—', ph.length ? ['확인', '보류', '제외'].map((c) => `${c} ${ph.filter((r) => r.res === c).length}`).join(' · ') : ''],
    ],
    waitOn: wait > 0,
    tabs: <div role="tablist" aria-label="기록 종류" style={{ display: 'flex', gap: '6px', padding: '12px 14px 0' }}>{TABS.map(([k, l]) =>
      <button key={k} type="button" role="tab" className="btn" aria-selected={k === tab} onClick={() => go(k)}
        style={k === tab ? { background: 'var(--acc-bg)', borderColor: 'var(--accent)' } : undefined}>{l}</button>)}</div>,
    qProps: { placeholder: PH[tab], 'aria-label': '기록 검색', value: f.q, onChange: set('q') },
    sPer: { p: { value: f.per, onChange: set('per') }, o: opts(null, ['최근 30일', '오늘', '최근 7일', '전체']) },
    sTpl: { p: { value: hf.tpl, onChange: set('tpl'), ...hide('tpl') }, o: opts('모든 양식', tpls) },
    sRes: { p: { value: f.res, onChange: set('res'), ...hide('res') }, o: opts(null, ['모든 결과', '완료', '진행', '실패 · 중단']) },
    sBy: { p: { value: hf.by, onChange: set('by'), ...hide('by') }, o: opts(tab === '사진' ? '모든 찍은 사람' : '모든 운영자', bys) },
    exT: `${tLabel} 탭 CSV · ${rows.length}행`, exP: { title: '이 탭의 검색·기간·필터 결과 전체(쪽 나누기 전)', onClick: () => csv(rows, tEn, `${tLabel} 탭 · 검색·기간·필터 적용(쪽 나누기 전)`) },
    ex2: <button className="btn" title={`같은 검색·기간·필터, 종류 제한만 뺌 · ${kinds}`} onClick={() => csv(every, 'all', `전체 기록 · 같은 검색·기간·필터 · ${kinds}`)}>{`전체 기록 CSV · ${every.length}행`}</button>,
    thead: <tr>{COLS[tab].map((c) => <th key={c} className={RIGHT.has(c) ? 'r' : undefined}>{c}</th>)}</tr>,
    rows: rows.length ? rows.slice(pg * N, pg * N + N).map((r, i) => <tr key={`${r.at}${r.kind}${i}`}><td className="mono">{fmtT(r.at).slice(0, 11)}</td>{cell(r)}</tr>) : empty,
    pgL: `${rows.length}건 중 ${rows.length ? pg * N + 1 : 0}–${Math.min(rows.length, pg * N + N)} · ${NOTE[tab]}`,
    pages: <>{pb('‹', pg - 1, '이전 쪽')}{Array.from({ length: Math.min(5, pages) }, (_, i) => pb(String(s0 + i + 1), s0 + i, undefined, s0 + i === pg))}{pb('›', pg + 1, '다음 쪽')}</>,
  };
  return <><style>{CSS}</style><div id="dc-root"><View v={v} /></div></>;
}
