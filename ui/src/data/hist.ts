// 기록 공용 행: 수동 임무·관찰 사진·서버 사건 (web/live.js histRows 와 같은 규칙). 화면 주소만 React 경로(#/화면?…)로.
import { csvOf, durTxt, posTxt, tms } from './fmt';
import { docsOf, noteOf, type Docs, type Media } from './shared';
import { evShow } from './facts';

// title = 원문(검색·CSV·Report 그대로) · show = 화면 표시 문장(사건만, §3 evShow)
export type Row = { at: string; kind: '사건' | '사진' | '임무'; lvl: string; title: string; show?: string; res: string; sub: string; by?: string; href: string;
  wait?: boolean; extra?: string; url?: string; st?: string; tmpl?: string; dur?: string; pts?: string; photos?: number; run?: string };

export const href = (screen: string, q: Record<string, string> = {}) => `#/${screen}${Object.keys(q).length ? `?${new URLSearchParams(q)}` : ''}`;

export function histRows(D: Docs, M: Media, pc: boolean): Row[] {
  const rows: Row[] = [];
  for (const e of M.events) if (e.st !== 'ok') rows.push({ at: e.at, kind: '사건', lvl: e.st, title: e.text, show: evShow(e.text), res: ({ bad: '위험', warn: '경고', ok: '정보' } as any)[e.st] || e.st, sub: '서버 사건 원문', by: '서버', href: href('MAlert', { at: e.at, t: e.text }) });
  for (const p of M.photos) {
    const n = noteOf(D, p.url);
    rows.push({ at: p.saved_at, kind: '사진', lvl: n ? (n.doc.cls === '확인' ? 'ok' : 'warn') : 'warn', title: '관찰 사진', res: n ? n.doc.cls : '미분류', wait: !n, sub: posTxt(p.x, p.y), by: p.by, extra: n?.doc.memo, url: p.url, href: href(pc ? 'PcReview' : 'MFinding', { url: p.url }) });
  }
  for (const d of docsOf(D, 'run')) {
    const r = d.doc, v = r.wps.filter((w) => w.st === '방문').length, ph = r.wps.reduce((a, w) => a + w.photos.length, 0);
    rows.push({ at: r.started || d.at, kind: '임무', lvl: r.status === '완료' ? 'ok' : r.status === '진행' ? 'warn' : 'bad', title: r.name, res: r.status === '진행' ? '진행(수동)' : r.status, st: r.status, tmpl: r.tmpl, wait: r.status === '진행',
      sub: `${r.tmpl || '양식 없음'} · 방문 ${v}/${r.wps.length} · ${durTxt(r.started, r.ended)}`, by: d.by, dur: durTxt(r.started, r.ended), pts: `${v}/${r.wps.length}`, photos: ph, extra: r.memo, run: d.id, href: href('Report', { run: d.id }) });
  }
  return rows.sort((a, b) => tms(b.at) - tms(a.at));
}
// R24 보고서 CSV = 고른 임무 하나: 그 임무 행 + 지점에 붙은 사진 + 임무 시작~종료(진행 중이면 지금) 시간 창 안 서버 사건.
// 사건은 «시간 창 안»일 뿐 원인 연결이 아님 — detail 에 그대로 적는다.
export const WIN_NOTE = '임무 시간 창 안 사건 · 원인 연결 아님';
export function runRows(rows: Row[], run: { id: string; doc: { started: string; ended?: string | null; wps: { photos: string[] }[] } }, now = Date.now()): Row[] {
  const ph = new Set(run.doc.wps.flatMap((w) => w.photos)), t0 = tms(run.doc.started), t1 = run.doc.ended ? tms(run.doc.ended) : now;
  return rows.flatMap((r) => r.kind === '임무' ? (r.run === run.id ? [r] : []) : r.kind === '사진' ? (r.url && ph.has(r.url) ? [r] : [])
    : t0 && tms(r.at) >= t0 && tms(r.at) <= t1 ? [{ ...r, sub: `${r.sub} · ${WIN_NOTE}` }] : []);
}
export const histCSV = (rs: Row[]) => csvOf(['at', 'kind', 'level', 'title', 'result', 'detail', 'by', 'photo'], rs.map((r) => [r.at, r.kind, r.lvl, r.title, r.res, r.sub, r.by, r.url]));
