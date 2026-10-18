// 기록 공용 행: 수동 임무·관찰 사진·서버 사건 (web/live.js histRows 와 같은 규칙). 화면 주소만 React 경로(#/화면?…)로.
import { csvOf, durTxt, posTxt, tms } from './fmt';
import { docsOf, docsSt, mediaSt, noteOf, type Docs, type Media } from './shared';
import { evShow } from './facts';
import { finishText } from './run';

// title = 원문(검색·CSV·Report 그대로) · show = 화면 표시 문장(사건만, §3 evShow)
export type Row = { at: string; kind: '사건' | '사진' | '임무'; lvl: string; title: string; show?: string; res: string; sub: string; by?: string; href: string;
  wait?: boolean; fin?: string; extra?: string; url?: string; st?: string; tmpl?: string; dur?: string; pts?: string; photos?: number; run?: string };

export const href = (screen: string, q: Record<string, string> = {}) => `#/${screen}${Object.keys(q).length ? `?${new URLSearchParams(q)}` : ''}`;

export function histRows(D: Docs, M: Media, pc: boolean): Row[] {
  const rows: Row[] = [];
  for (const e of M.events) rows.push({ at: e.at, kind: '사건', lvl: e.st, title: e.text, show: evShow(e.text), res: ({ bad: '위험', warn: '경고', ok: '정보' } as any)[e.st] || e.st, sub: '서버 사건 원문', by: '서버', href: href('MAlert', { at: e.at, t: e.text }) });
  // 분류는 문서(note)에서 온다. 문서가 정상일 때만 «note 없음 = 미분류·분류 대기». 못 읽음·저장소 오류·읽는 중이면 «분류 미확인»(대기 아님),
  // 보관(옛 목록 + 재조회 실패)이면 옛 분류값에 «(보관)» — 현재값 확정·새 추정 0. 보관 시각은 MediaStale 이 따로 보인다.
  const dk = docsSt(D);
  for (const p of M.photos) {
    const n = !dk || dk === '보관' ? noteOf(D, p.url) : undefined;
    rows.push({ at: p.saved_at, kind: '사진', lvl: n ? (n.doc.cls === '확인' ? 'ok' : 'warn') : dk ? '' : 'warn', title: '관찰 사진',
      res: n ? (dk ? `${n.doc.cls}(보관)` : n.doc.cls) : dk ? '분류 미확인' : '미분류', wait: !n && !dk, sub: posTxt(p.x, p.y), by: p.by, extra: n?.doc.memo, url: p.url, href: href(pc ? 'PcReview' : 'MFinding', { url: p.url }) });
  }
  for (const d of docsOf(D, 'run')) {
    const r = d.doc, v = r.wps.filter((w) => w.st === '방문').length, ph = r.wps.reduce((a, w) => a + w.photos.length, 0);
    // R3: fin = 종료 방식 기록 사본 그대로(키 없음 «종료 방식 기록 없음» · 계획 값으로 채움 0)
    rows.push({ at: r.started || d.at, kind: '임무', lvl: r.status === '완료' ? 'ok' : r.status === '진행' ? 'warn' : 'bad', title: r.name, res: r.status === '진행' ? '진행(수동)' : r.status, st: r.status, tmpl: r.tmpl, wait: r.status === '진행',
      fin: finishText(r), sub: `${r.tmpl || '양식 없음'} · ${finishText(r)} · 방문 ${v}/${r.wps.length} · ${durTxt(r.started, r.ended)}`, by: d.by, dur: durTxt(r.started, r.ended), pts: `${v}/${r.wps.length}`, photos: ph, extra: r.memo, run: d.id, href: href('Report', { run: d.id }) });
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
// 소스 빠짐·보관(전체 기록 CSV 표기용) — 받은 행만 내보내는 기능은 그대로, «완전한 전체»로 표기하지 않기 위한 목록
export const srcGaps = (D: Docs, M: Media) => [docsSt(D) && `임무·분류 문서 ${docsSt(D)}`, mediaSt(M) && `사진·사건 ${mediaSt(M)}`].filter(Boolean) as string[];
export const histCSV = (rs: Row[]) => csvOf(['at', 'kind', 'level', 'title', 'result', 'detail', 'by', 'photo'], rs.map((r) => [r.at, r.kind, r.lvl, r.title, r.res, r.sub, r.by, r.url]));
// U3-b PcHistory 3탭 거르기(순수 함수 — 화면·CSV 가 같은 결과를 씀). 검색·기간은 모든 종류.
// 탭 필터(양식·결과·운영자)는 그 값이 있는 종류에만: 양식·결과 = 임무, 운영자 = 임무·사진(사건 by '서버'는 기기 신원 아님 → 제외).
// 검색 = 원문(title·sub·extra) + 사건 표시 문장(show). 행은 한 번만. tab = 현재 탭 행, every = 탭 종류 제한만 뺀 같은 조건(전체 기록 CSV).
export type Tab = '임무' | '사진' | '사건';
export type HF = { q: string; per: string; tpl: string; res: string; by: string; sev?: string };
// U2-a(10-16): 사건 심각도 거르기 — 위험(bad)·경고(warn)·정보(ok). 기본 = 정보 아님(옛 histRows 사전 제외와 같은 결과 · 알 수 없는 st 도 남김).
//   사건 행에만, 탭과 무관하게 적용(다른 탭에선 늘 기본값 — go() 가 F0 로 되돌림). 원문 title·at·href(키)·CSV 열은 그대로.
export const SEV0 = '위험·경고';
export const SEV: Record<string, (lvl: string) => boolean> = { '위험·경고': (l) => l !== 'ok', '위험': (l) => l === 'bad', '경고': (l) => l === 'warn', '정보': (l) => l === 'ok', '모두': () => true };
export const sevKeep = (r: Row, sev = SEV0) => r.kind !== '사건' || (SEV[sev] ?? SEV[SEV0])(r.lvl);
export const PERIOD: Record<string, number> = { '오늘': 1, '최근 7일': 7, '최근 30일': 30 };   // '전체' = 기간 제한 없음
export const TAB_F: Record<Tab, ('tpl' | 'res' | 'by' | 'sev')[]> = { '임무': ['tpl', 'res', 'by'], '사진': ['by'], '사건': ['sev'] };
export const RUN_RES: Record<string, (r: Row) => boolean> = { '완료': (r) => r.st === '완료', '진행': (r) => r.st === '진행', '실패 · 중단': (r) => /실패|중단/.test(r.st || '') };
export function histFilter(all: Row[], tab: Tab, f: HF, now = Date.now()) {
  const on = TAB_F[tab], days = PERIOD[f.per], qq = f.q.trim();
  const ok = (r: Row) => (!days || now - tms(r.at) < days * 864e5)
    && (!qq || `${r.title} ${r.sub} ${r.extra || ''} ${r.show || ''}`.includes(qq))
    && (!on.includes('tpl') || !f.tpl || r.kind !== '임무' || r.tmpl === f.tpl)
    && (!on.includes('res') || !RUN_RES[f.res] || r.kind !== '임무' || RUN_RES[f.res](r))
    && (!on.includes('by') || !f.by || r.kind === '사건' || r.by === f.by)
    && sevKeep(r, f.sev);
  const every = all.filter(ok);
  return { tab: every.filter((r) => r.kind === tab), every };
}
