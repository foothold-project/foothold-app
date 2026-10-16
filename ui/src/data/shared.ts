// 서버 공유 기록(문서 api/docs · 사진·사건 api/media) 조회 — TanStack Query 는 «문서 조회·저장»만 맡는다(조종 명령 재시도 큐로 쓰지 않음).
// 다시 읽는 때는 상태 메시지가 정한다(link.ts refreshShared): docs_rev 가 바뀌거나 최신 사건이 바뀌면. 자동 재시도·창 포커스 재조회 없음(live.js 와 같음).
import { QueryClient, useQuery } from '@tanstack/react-query';
import { T } from './transport';
import type { DocEnvelope, DocWrite, DocsList, MediaList, MediaEvent, RunEnv } from '@contracts';

export const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false } } });

// 읽기·저장은 전송층 T 하나로(웹 쿠키 fetch 또는 네이티브 FhGate). 오류 의미는 그대로: 읽기 실패 = 던짐, 저장 = status 로
const parse = (body: string) => { try { return JSON.parse(body); } catch { return {}; } };
/** B2 A2: 상태 코드 대신 쉬운 말 — 원래 코드는 괄호에 남김 */
export const httpTxt = (n: number) => `${n === 401 || n === 403 ? '권한 없음(다시 로그인)' : n === 404 ? '서버에 없음' : n === 409 ? '다른 기기가 먼저 바꿈' : n >= 500 ? '서버 오류' : '요청 실패'} (HTTP ${n})`;
async function getJson<R>(what: 'docs' | 'media'): Promise<R> {
  const r = await T.get(what);
  const d = parse(r.body);
  if (r.status < 200 || r.status >= 300) throw new Error(d.error || httpTxt(r.status));
  return d as R;
}

export type Docs = { list: DocEnvelope[]; rev: number | null; err: string; stale?: boolean; at?: number };   // stale·at: R25(옛 목록 + 재조회 실패)
// 문서: 읽기 실패면 err 가 차고, 화면은 옛 목록을 확정값처럼 쓰지 않는다(보고서는 비우고 «미확인»). broken = 서버 저장소가 깨짐.
export function useDocs(): Docs {
  const q = useQuery({ queryKey: ['docs'], queryFn: () => getJson<DocsList>('docs') });
  return { list: q.data?.docs || [], rev: q.data ? q.data.rev : null, err: q.error ? `문서 읽기 실패 · ${q.error.message}` : q.data?.broken || '',
    stale: isStale(!!q.data, !!q.error), at: q.data ? q.dataUpdatedAt : 0 };
}
// 지금 캐시에 있는 최신 문서(비동기 뒤 판 번호용 — live.js 전역 DOCS 와 같은 역할)
export const docsNow = (): Docs => { const d = qc.getQueryData<DocsList>(['docs']); return { list: d?.docs || [], rev: d ? d.rev : null, err: '' }; };
export const docsOf = <K extends DocEnvelope['kind']>(D: Docs, k: K) =>
  D.list.filter((d): d is Extract<DocEnvelope, { kind: K }> => d.kind === k).sort((a, b) => (a.at < b.at ? 1 : -1));
export const docById = (D: Docs, id: string | null) => D.list.find((d) => d.id === id);
export const noteOf = (D: Docs, url: string) => docsOf(D, 'note').find((n) => n.doc.photo === url);
export const activeRun = (D: Docs): RunEnv | undefined => docsOf(D, 'run').find((d) => d.doc.status === '진행');

// R25: stale = 옛 목록은 있는데 다시 읽기가 실패한 상태(정상과 구분해 표시) · at = 마지막으로 받은 시각(ms, 0 = 못 받음)
export type Media = { photos: MediaList['photos']; events: MediaEvent[]; ok: boolean; err: string; stale: boolean; at: number };
// 사진·사건: 한 번 읽힌 뒤 실패하면 옛 목록을 계속 보여 준다(live.js MEDIA.ok 규칙). 처음부터 못 읽으면 ok=false + err.
export function useMedia(): Media {
  const q = useQuery({ queryKey: ['media'], queryFn: () => getJson<MediaList>('media') });
  return { photos: q.data?.photos || [], events: q.data?.events || [], ok: !!q.data, err: q.error ? `서버 기록 읽기 실패 · ${q.error.message}` : '',
    stale: isStale(!!q.data, !!q.error), at: q.data ? q.dataUpdatedAt : 0 };
}
export const isStale = (hasData: boolean, hasErr: boolean) => hasData && hasErr;
// U3-b 보완(715 B1·670 P2): 소스 상태 — '' = 정상 응답·오류 0. 그 밖은 «기록 유무·분류 미확인»(정상 0/미분류로 단정하지 않음).
// 문서: 읽는 중(rev null·err 0) · 못 읽음(rev null·err) · 저장소 오류(정상 HTTP + broken → rev 는 정수, err = broken) · 보관(옛 목록 + 재조회 실패)
export const docsSt = (D: Docs) => D.rev == null ? (D.err ? '못 읽음' : '읽는 중') : D.stale ? '보관' : D.err ? '저장소 오류' : '';
export const mediaSt = (M: Media) => !M.ok ? (M.err ? '못 읽음' : '읽는 중') : M.stale ? '보관' : '';
export const reread = (k: 'media' | 'docs') => qc.invalidateQueries({ queryKey: [k] });
export const alertsOf = (M: Media) => M.events.filter((e) => e.st === 'warn' || e.st === 'bad');

// 상태 메시지마다 부름: 판·최신 사건이 바뀌면 다시 읽기(실패 뒤엔 3 s 쉬고). 진행 중인 읽기는 끊지 않는다.
let mediaKey: string | null = null;
export function refreshShared(docsRev: number | null | undefined, head: { t: string; text: string } | undefined) {
  const now = Date.now();
  const since = (k: string) => { const s = qc.getQueryState([k]); return s ? { busy: s.fetchStatus === 'fetching', err: !!s.error, dt: now - Math.max(s.dataUpdatedAt, s.errorUpdatedAt) } : null; };
  const d = since('docs'), cur = qc.getQueryData<DocsList>(['docs']);
  if (d && !d.busy && docsRev != null && docsRev !== cur?.rev && d.dt > (d.err ? 3000 : 300)) qc.invalidateQueries({ queryKey: ['docs'] }, { cancelRefetch: false });
  const m = since('media'), k = head ? `${head.t}|${head.text}` : '';
  if (m && !m.busy && k !== mediaKey && m.dt > (m.err ? 3000 : 1500)) { mediaKey = k; qc.invalidateQueries({ queryKey: ['media'] }, { cancelRefetch: false }); }
}

// 공용 문서 저장 — web/live.js saveDoc 과 같은 규칙. 저장 뒤 목록은 늘 다시 읽는다(성공·실패 모두).
// code = HTTP 상태(숫자) 그대로 — 409 초안 보존 경로 무변경. reason = 서버 본문 reason_code(C 가 새로 내는 사유만, 그 밖엔 없음)
// mcasDropped = 결과 편집에서 근거 필드가 바뀌어 서버가 «시작 대조» 표시(mcas)를 뗌
export type SaveRes = { ok: true; id: string; rev: number; mcasDropped?: true } | { ok: false; code: number; error: string; cur?: DocEnvelope | null; reason?: string };
export async function saveDoc(m: DocWrite): Promise<SaveRes> {
  try {
    const r = await T.postDocs(m);
    const d = parse(r.body), ok = r.status >= 200 && r.status < 300;
    qc.invalidateQueries({ queryKey: ['docs'] }, { cancelRefetch: false });
    return ok ? { ok: true, ...d, ...(d.mcas_dropped === true ? { mcasDropped: true as const } : {}) }
      : { ok: false, code: r.status, error: d.error || httpTxt(r.status), cur: d.cur, ...(typeof d.reason_code === 'string' ? { reason: d.reason_code } : {}) };
  } catch (e: any) { return { ok: false, code: 0, error: `서버에 닿지 않음 · ${e?.message || e}` }; }
}
