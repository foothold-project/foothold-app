import { beforeEach, expect, test, vi } from 'vitest';
// U3-b 보완(715 B1·670 P2/P3): 소스 상태(정상·읽는 중·최초 실패·broken·보관)별로 «정상 0·미분류·분류 대기·완전한 전체»를 단정하지 않는지.
// 실제 useDocs/useMedia 경계를 쓴다: 쿼리 캐시에 계약 응답({docs,rev,broken})·오류 상태를 넣고 실제 컴포넌트를 react-dom/server 로 그림.
// 대체: useRoute(?tab= — 노드 서버 렌더에 hash 구독 없음)·console.error(useLayoutEffect 경고 — 전체 억제라 다른 렌더 경고도 안 보임) 만.
import type { MediaEvent } from '@contracts';
const R = vi.hoisted(() => ({ q: new URLSearchParams() }));
vi.mock('../../src/app/shell', async (orig) => ({ ...(await orig<typeof import('../../src/app/shell')>()), useRoute: () => ({ name: 'PcHistory', q: R.q, setQ: () => {} }) }));
Object.assign(globalThis, { localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, location: { href: 'http://127.0.0.1/', protocol: 'http:', hash: '', search: '', pathname: '/' } });
vi.spyOn(console, 'error').mockImplementation(() => {});

const React = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { QueryClientProvider } = await import('@tanstack/react-query');
const { qc, docsSt, mediaSt, useDocs, useMedia } = await import('../../src/data/shared');
const { histRows, srcGaps } = await import('../../src/data/hist');
const PcHistory = (await import('../../src/screens/PcHistory')).default;
const MAlerts = (await import('../../src/screens/MAlerts')).default;

const at = (min: number) => new Date(Date.now() - min * 60e3).toISOString().replace(/\.\d+Z$/, 'Z');
const EV: MediaEvent = { t: '00:00:00', st: 'bad', text: '넘어짐 (시뮬 판정)', at: at(3) };
const PH = { url: '/p/1.jpg', saved_at: at(2), x: 1, y: 2, by: 'kim' };
const NOTE = { kind: 'note', id: 'n1', at: at(1), by: 'kim', rev: 1, doc: { photo: '/p/1.jpg', cls: '확인', memo: '계단 앞' } };
const BROKEN = '저장소 문서 깨짐(docs.jsonl 3행)';
const html = (C: any, tab?: string) => { R.q = new URLSearchParams(tab ? { tab } : {});
  return renderToStaticMarkup(React.createElement(QueryClientProvider, { client: qc }, React.createElement(C))).replace(/&quot;/g, '"').replace(/&amp;/g, '&'); };
// 실패 상태: 쿼리 캐시에 오류를 직접 넣음. data 없음 + 오류는 마운트 재시도가 낙관적 «읽는 중»으로 바꾸므로 retryOnMount false(시험 한정)
const fail = (k: string, keep: boolean) => { const q = qc.getQueryCache().build(qc, { queryKey: [k] });
  q.setState({ ...q.state, error: new Error('HTTP 502'), status: 'error', errorUpdatedAt: Date.now(), ...(keep ? {} : { data: undefined, dataUpdatedAt: 0 }) }); };
type S = 'ok' | 'pend' | 'fail' | 'broken' | 'stale';
const set = (d: S, m: S, docs: any[] = [], media: any = { photos: [PH], events: [EV] }) => {
  qc.clear(); for (const k of ['docs', 'media']) qc.setQueryDefaults([k], { retryOnMount: false });
  if (d === 'ok' || d === 'stale') qc.setQueryData(['docs'], { docs, rev: 2 });
  if (d === 'broken') qc.setQueryData(['docs'], { docs: [], rev: 0, broken: BROKEN });   // 정상 HTTP · rev 정수 · broken (계약 DocsList)
  if (d === 'fail' || d === 'stale') fail('docs', d === 'stale');
  if (m === 'ok' || m === 'stale') qc.setQueryData(['media'], media);
  if (m === 'fail' || m === 'stale') fail('media', m === 'stale');
};
const card = (s: string, name: string) => s.match(new RegExp(`>${name}</span><span class="mono"[^>]*>([^<]*)</span>(?:<span class="lbl">([^<]*)</span>)?`))?.slice(1, 3);
const NOT_EMPTY_CLAIM = ['아직 임무 기록이 없습니다', 'href="#/PcPlan"'];
beforeEach(() => set('ok', 'ok'));

test('경계: 실제 useDocs 가 계약 broken 을 D.err 로 노출 → docsSt «저장소 오류» · 최초 실패 «못 읽음» · 보관 · 정상 ""', () => {
  let D: any, M: any; const Probe = () => { D = useDocs(); M = useMedia(); return null; };
  const st = (d: S, m: S) => { set(d, m); html(Probe); return [docsSt(D), mediaSt(M), D.rev, D.err]; };
  expect(st('broken', 'ok')).toEqual(['저장소 오류', '', 0, BROKEN]);           // rev 0 이 있어도 정상 아님
  expect(st('fail', 'fail').slice(0, 3)).toEqual(['못 읽음', '못 읽음', null]);
  expect(st('pend', 'pend')).toEqual(['읽는 중', '읽는 중', null, '']);
  expect(st('stale', 'stale').slice(0, 2)).toEqual(['보관', '보관']);
  expect(st('ok', 'ok')).toEqual(['', '', 2, '']);
});

test('B1 broken/최초 실패: 임무 0·«아직 없음»·임무 시작 단정 0 · 오류 원문 + 다시 읽기 · 카드 — · 탭 CSV 끔 · 전체 CSV «일부»', () => {
  for (const [d, why] of [['broken', BROKEN], ['fail', '문서 읽기 실패 · HTTP 502']] as const) {
    set(d, 'ok'); const s = html(PcHistory);
    for (const x of NOT_EMPTY_CLAIM) expect(s).not.toContain(x);
    expect(s).toContain(`${why} — 임무 기록 유무 미확인`); expect(s).toContain('>다시 읽기</button>');
    expect(card(s, '임무')).toEqual(['—', `문서 ${d === 'broken' ? '저장소 오류' : '못 읽음'}`]);
    expect(s).toMatch(/<button[^>]*disabled=""[^>]*>임무 탭 CSV · 자료 못 읽음</);
    expect(s).toContain('받은 기록 CSV · 2행 · 일부'); expect(s).not.toContain('전체 기록 CSV');
    expect(s).toContain('title="완전한 전체 기록 아님 — 임무·분류 문서');
  }
  set('pend', 'ok'); const p = html(PcHistory);
  expect(p).toContain('임무 기록 읽는 중…'); for (const x of NOT_EMPTY_CLAIM) expect(p).not.toContain(x);
});

test('정상 빈 응답만 «임무 0 · 아직 없음 + 임무 시작» · CSV 라벨·파일명 기존 그대로', () => {
  set('ok', 'ok', [], { photos: [], events: [] }); const s = html(PcHistory);
  for (const x of NOT_EMPTY_CLAIM) expect(s).toContain(x);
  expect(card(s, '임무')?.[0]).toBe('0');
  expect(s).toContain('임무 탭 CSV · 0행<'); expect(s).toContain('전체 기록 CSV · 0행<'); expect(s).not.toContain('일부');
});

test('보관(옛 목록 + 재조회 실패): 임무 0 은 보관 시각·유무 미확인 · 옛 분류는 «(보관)» · 탭 CSV 보관 표기', () => {
  set('stale', 'ok'); const s = html(PcHistory);
  for (const x of NOT_EMPTY_CLAIM) expect(s).not.toContain(x);
  expect(s).toMatch(/보관 자료\(마지막 받음 [^)]+ · 재조회 실패\)에 임무 0 — 지금 기록 유무 미확인/);
  expect(card(s, '임무')).toEqual(['0', '보관 자료 · 재조회 실패']);
  expect(s).toContain('임무 탭 CSV · 0행 · 보관 자료'); expect(s).toContain('받은 기록 CSV · 2행 · 일부');
  set('stale', 'ok', [NOTE]); const p = html(PcHistory, '사진');
  expect(p).toContain('확인(보관)'); expect(p).not.toContain('미분류');
  expect(card(p, '관찰 사진 분류 대기')).toEqual(['—', '분류 미확인 · 문서 보관']);
  expect(p).toContain('사진 탭 CSV · 1행 · 분류 미확인');
});

test('P2 사진 분류: 문서 못 읽음·broken 이면 «분류 미확인»·대기 아님 · 카드 —·강조/링크 0 · 정상 문서의 note 없음은 미분류·대기 유지', () => {
  for (const d of ['broken', 'fail', 'pend'] as const) {
    set(d, 'ok'); const s = html(PcHistory, '사진');
    expect(s).toContain('분류 미확인'); expect(s).not.toContain('>미분류<');
    expect(card(s, '관찰 사진 분류 대기')?.[0]).toBe('—');
    expect(s).not.toContain('href="#/PcReview"');   // 카드 «지금 분류» 링크(행 링크는 ?url= 가 붙음)
    expect(s).toContain('사진 탭 CSV · 1행 · 분류 미확인');
    expect(histRows({ list: [], rev: d === 'broken' ? 0 : null, err: d === 'pend' ? '' : 'x' } as any, { photos: [PH], events: [], ok: true, err: '', stale: false, at: 1 } as any, true)
      .filter((r) => r.kind === '사진').map((r) => [r.res, r.wait, r.lvl])).toEqual([['분류 미확인', false, '']]);
  }
  set('ok', 'ok'); const n = html(PcHistory, '사진');
  expect(n).toContain('미분류'); expect(card(n, '관찰 사진 분류 대기')?.[0]).toBe('1'); expect(n).toContain('href="#/PcReview"');
});

test('P3 사진·사건 못 읽음: 0 단정·0행 정상 CSV 0 · 이유 + 다시 읽기 · 전체 CSV 는 받은 임무만 «일부»', () => {
  set('ok', 'fail', [{ kind: 'run', id: 'r1', at: at(10), by: 'kim', rev: 1, doc: { name: '임무1', tmpl: '점검', status: '완료', started: at(10), ended: at(9), memo: '', wps: [] } }]);
  for (const tab of ['사진', '사건']) {
    const s = html(PcHistory, tab);
    expect(s).toContain(`서버 기록 읽기 실패 · HTTP 502 — ${tab === '사진' ? '관찰 사진' : '사건'} 유무 미확인`);
    expect(s).not.toContain('받은 관찰 사진 없음'); expect(s).not.toContain('받은 사건 없음');
    expect(s).toMatch(new RegExp(`<button[^>]*disabled=""[^>]*>${tab === '사진' ? '관찰 사진' : '사건'} 탭 CSV · 자료 못 읽음<`));
    expect(s).toContain('받은 기록 CSV · 1행 · 일부'); expect(s).toContain('사진·사건 못 읽음');
  }
  set('ok', 'stale', [], { photos: [], events: [] }); const s = html(PcHistory, '사건');
  expect(s).toMatch(/보관 자료\(마지막 받음 [^)]+ · 재조회 실패\)에 사건 0 — 지금 유무 미확인/);
});

test('srcGaps · MAlerts: 문서 이상이면 «분류 대기» 항목 0, 정상이면 유지', () => {
  const D = (rev: any, err = '', stale = false) => ({ list: [], rev, err, stale } as any), M = (ok: boolean, err = '', stale = false) => ({ photos: [], events: [], ok, err, stale, at: 1 } as any);
  expect(srcGaps(D(2), M(true))).toEqual([]);
  expect(srcGaps(D(0, BROKEN), M(false, 'x'))).toEqual(['임무·분류 문서 저장소 오류', '사진·사건 못 읽음']);
  expect(srcGaps(D(2, 'x', true), M(true, 'y', true))).toEqual(['임무·분류 문서 보관', '사진·사건 보관']);
  set('broken', 'ok'); expect(html(MAlerts)).not.toContain('분류 대기');
  set('ok', 'ok'); expect(html(MAlerts)).toContain('관찰 사진 분류 대기 1장');
});

test('Report 전체 CSV 버튼: 소스 이상이면 «받은 기록 CSV · 일부» + title, 정상이면 기존 «전체 기록 CSV»', async () => {
  const Report = (await import('../../src/screens/Report')).default;
  set('broken', 'ok'); const s = html(Report);
  expect(s).toContain('>받은 기록 CSV · 일부</button>'); expect(s).toContain('title="완전한 전체 기록 아님 — 임무·분류 문서 저장소 오류"');
  set('ok', 'fail'); expect(html(Report)).toContain('사진·사건 못 읽음');
  set('ok', 'ok'); const n = html(Report);
  expect(n).toContain('>전체 기록 CSV</button>'); expect(n).not.toContain('완전한 전체 기록 아님');
});
