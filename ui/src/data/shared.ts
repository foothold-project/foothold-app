// 서버 공유 기록(문서 api/docs · 사진·사건 api/media) 조회 — TanStack Query 는 «문서 조회·저장»만 맡는다(조종 명령 재시도 큐로 쓰지 않음).
// 다시 읽는 때는 상태 메시지가 정한다(link.ts refreshShared): docs_rev 가 바뀌거나 최신 사건이 바뀌면. 자동 재시도·창 포커스 재조회 없음(live.js 와 같음).
import { QueryClient, useQuery } from '@tanstack/react-query';
import type { DocEnvelope, DocsList, MediaList, MediaEvent, RunEnv } from '@contracts';

export const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false } } });

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d as T;
}

export type Docs = { list: DocEnvelope[]; rev: number | null; err: string };
// 문서: 읽기 실패면 err 가 차고, 화면은 옛 목록을 확정값처럼 쓰지 않는다(보고서는 비우고 «미확인»). broken = 서버 저장소가 깨짐.
export function useDocs(): Docs {
  const q = useQuery({ queryKey: ['docs'], queryFn: () => getJson<DocsList>('api/docs') });
  return { list: q.data?.docs || [], rev: q.data ? q.data.rev : null, err: q.error ? `문서 읽기 실패 · ${q.error.message}` : q.data?.broken || '' };
}
export const docsOf = <K extends DocEnvelope['kind']>(D: Docs, k: K) =>
  D.list.filter((d): d is Extract<DocEnvelope, { kind: K }> => d.kind === k).sort((a, b) => (a.at < b.at ? 1 : -1));
export const docById = (D: Docs, id: string | null) => D.list.find((d) => d.id === id);
export const noteOf = (D: Docs, url: string) => docsOf(D, 'note').find((n) => n.doc.photo === url);
export const activeRun = (D: Docs): RunEnv | undefined => docsOf(D, 'run').find((d) => d.doc.status === '진행');

export type Media = { photos: MediaList['photos']; events: MediaEvent[]; ok: boolean; err: string };
// 사진·사건: 한 번 읽힌 뒤 실패하면 옛 목록을 계속 보여 준다(live.js MEDIA.ok 규칙). 처음부터 못 읽으면 ok=false + err.
export function useMedia(): Media {
  const q = useQuery({ queryKey: ['media'], queryFn: () => getJson<MediaList>('api/media') });
  return { photos: q.data?.photos || [], events: q.data?.events || [], ok: !!q.data, err: q.error ? `서버 기록 읽기 실패 · ${q.error.message}` : '' };
}
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
