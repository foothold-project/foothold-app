// PC 기록(원본 요약 카드·검색줄·표·쪽 넘김) — web/live.js pagePcHistory 와 같은 규칙. 예시 행·숫자는 쓰지 않는다.
import { useState } from 'react';
import { CSS, View } from './PcHistory.view';
import { LV, fmtT, saveBlob, themeClass, tms } from '../data/fmt';
import { alertsOf, useDocs, useMedia } from '../data/shared';
import { histCSV, histRows, type Row } from '../data/hist';
import { LiveStatus, MediaStale } from '../app/status';
import { stopProps, toast } from '../app/shell';

const PER: Record<string, number> = { '오늘': 1, '최근 7일': 7, '최근 30일': 30 };
const RF: Record<string, (r: Row) => boolean> = { '완료': (r) => r.st === '완료', '진행': (r) => r.st === '진행', '실패 · 중단': (r) => /실패|중단/.test(r.st || ''), '경고 · 위험 사건': (r) => r.kind === '사건' && r.lvl !== 'ok', '관찰 사진': (r) => r.kind === '사진' };
const N = 20;

export default function PcHistory() {
  const D = useDocs(), M = useMedia();
  const [f, setF] = useState({ q: '', per: '최근 30일', tpl: '', res: '모든 결과', by: '' }), [page, setPage] = useState(0);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => { setF({ ...f, [k]: e.target.value }); setPage(0); };
  const all = histRows(D, M, true), runs = all.filter((r) => r.kind === '임무'), ph = all.filter((r) => r.kind === '사진'), al = alertsOf(M);
  const tpls = [...new Set(runs.map((r) => r.tmpl).filter(Boolean))] as string[], bys = [...new Set(all.map((r) => r.by).filter(Boolean))] as string[];
  const tpl = tpls.includes(f.tpl) ? f.tpl : '', by = bys.includes(f.by) ? f.by : '';   // 목록에서 사라진 값이면 «모두»로
  const cnt = (fn: (r: Row) => boolean) => runs.filter(fn).length, days = PER[f.per], qq = f.q.trim();
  const rows = all.filter((r) => (!days || Date.now() - tms(r.at) < days * 864e5) && (!tpl || r.tmpl === tpl) && (!by || r.by === by)
    && (!RF[f.res] || RF[f.res](r)) && (!qq || `${r.title} ${r.sub} ${r.extra || ''}`.includes(qq)));
  const pages = Math.max(1, Math.ceil(rows.length / N)), pg = Math.min(page, pages - 1), s0 = Math.max(0, Math.min(pg - 2, pages - 5));
  const opts = (first: string | null, vals: string[]) => <>{first != null && <option value="">{first}</option>}{vals.map((x) => <option key={x} value={x}>{x}</option>)}</>;
  const pb = (t: string, p: number, lab?: string, cur?: boolean) => {
    const off = p < 0 || p >= pages;
    return <button key={`${t}${p}`} className="btn" aria-label={lab} aria-current={cur ? 'page' : undefined} disabled={off} onClick={() => setPage(p)}
      style={off ? { opacity: '.5' } : cur ? { background: 'var(--acc-bg)', borderColor: 'var(--accent)' } : undefined}>{t}</button>;
  };
  const v = {
    themeClass: themeClass(true), h2: '임무 기록 · 관찰 사진 · 서버 사건', status: <><LiveStatus D={D} /><MediaStale M={M} D={D} /></>, stopProps,
    stats: [
      ['수동 임무 진행', String(runs.length), `완료 ${cnt((r) => r.st === '완료')} · 실패·중단 ${cnt((r) => /실패|중단/.test(r.st || ''))} · 진행 ${cnt((r) => r.st === '진행')}`],
      ['경보 사건(서버 최근 300)', String(al.length), '자동 경보 규칙 미연결 · 사건 원문'],
      ['관찰 사진 분류 대기', String(ph.filter((r) => r.wait).length), '지금 분류 →'],
      ['관찰 사진', String(ph.length), ['확인', '보류', '제외'].map((c) => `${c} ${ph.filter((r) => r.res === c).length}`).join(' · ')],
    ],
    qProps: { placeholder: '임무 이름 · 내용 · 메모', 'aria-label': '기록 검색', value: f.q, onChange: set('q') },
    sPer: { p: { value: f.per, onChange: set('per') }, o: opts(null, ['최근 30일', '오늘', '최근 7일', '전체']) },
    sTpl: { p: { value: tpl, onChange: set('tpl') }, o: opts('모든 양식', tpls) },
    sRes: { p: { value: f.res, onChange: set('res') }, o: opts(null, ['모든 결과', '완료', '진행', '실패 · 중단', '경고 · 위험 사건', '관찰 사진']) },
    sBy: { p: { value: by, onChange: set('by') }, o: opts('모든 운영자', bys) },
    exT: '보이는 기록 내보내기 (CSV)', exP: { onClick: () => toast(saveBlob(`foothold-v2-history-${Date.now()}.csv`, new Blob([histCSV(rows)], { type: 'text/csv' }))) },
    rows: rows.length ? rows.slice(pg * N, pg * N + N).map((r, i) => (
      <tr key={`${r.at}${r.kind}${i}`}>
        <td className="mono">{fmtT(r.at).slice(0, 11)}</td>
        <td><a href={r.href} style={{ color: 'inherit', fontWeight: '600' }}>{r.title}</a></td>
        <td>{r.kind === '임무' ? r.tmpl || '—' : r.kind === '사진' ? '관찰 사진' : '서버 사건'}</td>
        <td>{r.kind === '사진' ? r.sub : '시뮬 바닥(±10 m)'}</td>
        <td>{r.by || '—'}</td><td className="mono r">{r.dur || '—'}</td><td className="mono r">{r.pts || '—'}</td>
        <td><span className={`res ${r.lvl}`}>{`${LV[r.lvl] || '·'} ${r.res}`}</span></td>
        <td className="mono r">{r.kind === '임무' ? String(r.photos) : r.kind === '사진' ? '1' : '—'}</td>
        <td>{r.run ? <a href={r.href} style={{ color: 'var(--accent)' }}>보고서</a> : '—'}</td>
      </tr>)) : <tr><td colSpan={10}>{M.ok ? '해당 기록 없음' : M.err || '서버 기록 읽는 중…'}</td></tr>,
    pgL: `${rows.length}건 중 ${rows.length ? pg * N + 1 : 0}–${Math.min(rows.length, pg * N + N)} · 서버 보관: 사건 최근 300 · 사진 최근 200 · 임무 진행 전부`,
    pages: <>{pb('‹', pg - 1, '이전 쪽')}{Array.from({ length: Math.min(5, pages) }, (_, i) => pb(String(s0 + i + 1), s0 + i, undefined, s0 + i === pg))}{pb('›', pg + 1, '다음 쪽')}</>,
  };
  return <><style>{CSS}</style><div id="dc-root"><View v={v} /></div></>;
}
