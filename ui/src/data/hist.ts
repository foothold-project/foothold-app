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
// U3-b PcHistory 3탭 거르기(순수 함수 — 화면·CSV 가 같은 결과를 씀). 검색·기간은 모든 종류.
// 탭 필터(양식·결과·운영자)는 그 값이 있는 종류에만: 양식·결과 = 임무, 운영자 = 임무·사진(사건 by '서버'는 기기 신원 아님 → 제외).
// 검색 = 원문(title·sub·extra) + 사건 표시 문장(show). 행은 한 번만. tab = 현재 탭 행, every = 탭 종류 제한만 뺀 같은 조건(전체 기록 CSV).
export type Tab = '임무' | '사진' | '사건';
export type HF = { q: string; per: string; tpl: string; res: string; by: string };
export const PERIOD: Record<string, number> = { '오늘': 1, '최근 7일': 7, '최근 30일': 30 };   // '전체' = 기간 제한 없음
export const TAB_F: Record<Tab, ('tpl' | 'res' | 'by')[]> = { '임무': ['tpl', 'res', 'by'], '사진': ['by'], '사건': [] };
export const RUN_RES: Record<string, (r: Row) => boolean> = { '완료': (r) => r.st === '완료', '진행': (r) => r.st === '진행', '실패 · 중단': (r) => /실패|중단/.test(r.st || '') };
export function histFilter(all: Row[], tab: Tab, f: HF, now = Date.now()) {
  const on = TAB_F[tab], days = PERIOD[f.per], qq = f.q.trim();
  const ok = (r: Row) => (!days || now - tms(r.at) < days * 864e5)
    && (!qq || `${r.title} ${r.sub} ${r.extra || ''} ${r.show || ''}`.includes(qq))
    && (!on.includes('tpl') || !f.tpl || r.kind !== '임무' || r.tmpl === f.tpl)
    && (!on.includes('res') || !RUN_RES[f.res] || r.kind !== '임무' || RUN_RES[f.res](r))
    && (!on.includes('by') || !f.by || r.kind === '사건' || r.by === f.by);
  const every = all.filter(ok);
  return { tab: every.filter((r) => r.kind === tab), every };
}
