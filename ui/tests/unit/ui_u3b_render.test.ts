import { beforeEach, expect, test, vi } from 'vitest';
// U3-b PcHistory 실제 컴포넌트 서버 렌더(react-dom/server + 쿼리 캐시). 대체: useRoute(?tab= 주소 — 노드 서버 렌더에 hash 구독 없음)·console.error(useLayoutEffect 경고)만.
import type { MediaEvent } from '@contracts';
const R = vi.hoisted(() => ({ q: new URLSearchParams() }));
vi.mock('../../src/app/shell', async (orig) => ({ ...(await orig<typeof import('../../src/app/shell')>()), useRoute: () => ({ name: 'PcHistory', q: R.q, setQ: () => {} }) }));
Object.assign(globalThis, { localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, location: { href: 'http://127.0.0.1/', protocol: 'http:', hash: '', search: '', pathname: '/' } });
vi.spyOn(console, 'error').mockImplementation(() => {});

const React = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { QueryClientProvider } = await import('@tanstack/react-query');
const { qc } = await import('../../src/data/shared');
const PcHistory = (await import('../../src/screens/PcHistory')).default;

const at = (min: number) => new Date(Date.now() - min * 60e3).toISOString().replace(/\.\d+Z$/, 'Z');
const ev = (text: string, st: 'warn' | 'bad' | 'ok', a: string): MediaEvent => ({ t: a.slice(11, 19), st, text, at: a });
const run = (i: number) => ({ kind: 'run', id: `r${i}`, at: at(100 + i), by: 'kim', rev: 1, doc: { name: `임무${i}`, tmpl: '점검', status: '완료', started: at(100 + i), ended: at(99 + i), memo: '', wps: [] } });
const EVS = [ev('STOP 요청 · 명령 0 잠금 (이 기기)', 'bad', at(3)), ev('조종권 해제 · 연결 끊김 → 명령 0 · STOP 잠금', 'warn', at(4)), ev('조종권 얻음 · 이 기기', 'ok', at(5))];
const page = (tab?: string) => { R.q = new URLSearchParams(tab ? { tab } : {});
  return renderToStaticMarkup(React.createElement(QueryClientProvider, { client: qc }, React.createElement(PcHistory))).replace(/&quot;/g, '"').replace(/&amp;/g, '&'); };
const set = (docs: any[] | null, media: any | null) => { qc.clear(); if (docs) qc.setQueryData(['docs'], { docs, rev: 1 }); if (media) qc.setQueryData(['media'], media); };
beforeEach(() => set([], { photos: [], events: [] }));

test('기본 탭 = 임무 · 탭 3개 · 제목 «기록» · 주소 ?tab= 가 고른 탭', () => {
  const s = page();
  expect(s.match(/role="tab"/g)?.length).toBe(3);
  expect(s).toContain('aria-selected="true" style="background:var(--acc-bg);border-color:var(--accent)">임무</button>');
  expect(s).toContain('>기록</span>');
  expect(page('사건')).toContain('aria-selected="true" style="background:var(--acc-bg);border-color:var(--accent)">사건</button>');
  expect(page('엉뚱')).toContain('aria-selected="true" style="background:var(--acc-bg);border-color:var(--accent)">임무</button>');
});

test('빈 임무: «아직 임무 기록이 없습니다» + 임무 시작(PcPlan) · 문서 못 읽음이면 «없음» 단정 0 · 숫자 —', () => {
  const s = page();
  expect(s).toContain('아직 임무 기록이 없습니다'); expect(s).toContain('href="#/PcPlan"');
  set(null, { photos: [], events: [] });
  const w = page();
  expect(w).not.toContain('아직 임무 기록이 없습니다'); expect(w).toContain('임무 기록 읽는 중…');
  expect(w).toMatch(/>임무<\/span><span class="mono"[^>]*>—</);
  set([], null);
  const m = page('사건');
  expect(m).toContain('서버 기록 읽는 중…'); expect(m).toMatch(/>위험 사건<\/span><span class="mono"[^>]*>—</);
});

test('사건 탭: 열 = 일시·사건·심각도·상세 · 펼침 원문 · 탭에 안 맞는 필터 숨김 · 카드 수 = 받은 bad/warn', () => {
  set([], { photos: [], events: EVS });
  const s = page('사건');
  expect(s).toContain('<th>일시</th><th>사건</th><th>심각도</th><th>상세</th>');
  expect(s).toContain('>STOP · 입력 차단·잠금</summary><span class="lbl">원문: STOP 요청 · 명령 0 잠금 (이 기기)</span>');
  expect(s).toContain('조종권 해제 · 연결 끊김 → 명령 0 · STOP 잠금');   // 사전 밖 = 원문 그대로
  expect(s).not.toContain('조종권 얻음');                                 // 정보 사건은 기존대로 기록 제외
  for (const lab of ['임무 양식', '결과', '운영자']) expect(s).toMatch(new RegExp(`aria-label="${lab}"[^>]*hidden=""`));
  expect(s).toMatch(/>위험 사건<\/span><span class="mono"[^>]*>1<\/span><span class="lbl">받은 최근 사건 중 · 경고 1</);
  expect(s).toContain('사건 탭 CSV · 2행'); expect(s).toContain('전체 기록 CSV · 2행');
  expect(s).toContain('받은 최근 사건 300건 안에서');
});

test('임무 25개: 쪽 1 = 20행, CSV 버튼은 쪽 나누기 전 25 · 0 보조줄·분류 대기 0 은 링크/강조 끔', () => {
  set(Array.from({ length: 25 }, (_, i) => run(i)), { photos: [], events: EVS });
  const s = page();
  expect(s).toContain('25건 중 1–20');
  expect(s.match(/>보고서<\/a>/g)?.length).toBe(20);
  expect(s).toContain('임무 탭 CSV · 25행'); expect(s).toContain('전체 기록 CSV · 27행');
  expect(s).toMatch(/>임무<\/span><span class="mono"[^>]*>25<\/span><span class="lbl">완료 25</);   // 0 인 실패·진행은 접음
  expect(s).not.toContain('href="#/PcReview"');                                                  // 분류 대기 0 → 링크 없음
  expect(s).toMatch(/>관찰 사진<\/span><span class="mono"[^>]*>0<\/span><span class="lbl"><\/span>/);
  expect(s).toMatch(/aria-label="임무 양식"(?![^>]*hidden)/);
});

test('사진 탭: 분류·위치·찍은 사람·메모·열기 · 분류 대기 n 이면 링크', () => {
  set([], { photos: [{ url: '/p/1.jpg', saved_at: at(2), x: 1, y: 2, by: 'kim' }], events: [] });
  const s = page('사진');
  expect(s).toContain('<th>일시</th><th>분류</th><th>위치</th><th>찍은 사람</th><th>메모</th><th class="r">사진</th>');
  expect(s).toContain('미분류'); expect(s).toContain('>열기</a>');
  expect(s).toContain('href="#/PcReview"');
  expect(s).toMatch(/aria-label="운영자"(?![^>]*hidden)/);
});
