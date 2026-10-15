import { beforeEach, expect, test, vi } from 'vitest';
// U3-a(v3 §3): 알려진 사건 원문 → 표시 문장(evShow). 원문은 저장·at+text 조회·읽음 키·주소·CSV 에 그대로.
// 화면은 실제 MAlerts·MAlert 컴포넌트를 react-dom/server 로 그려 본다(쿼리 캐시에 media 를 넣고, 주소 해석 useRoute 만 대체 — 노드 서버 렌더에 hash 구독이 없어서).
import linkPy from '../../../sim/v2_link.py?raw';
import mainSrc from '../../src/screens/Main.tsx?raw';
import type { MediaEvent } from '@contracts';
const mem = new Map<string, string>();
const R = vi.hoisted(() => ({ q: new URLSearchParams() }));
vi.mock('../../src/app/shell', async (orig) => ({ ...(await orig<typeof import('../../src/app/shell')>()), useRoute: () => ({ name: 'MAlert', q: R.q, setQ: () => {} }) }));
Object.assign(globalThis, { localStorage: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) },
  location: { href: 'http://127.0.0.1/', protocol: 'http:', hash: '', search: '', pathname: '/' } });

const React = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { QueryClientProvider } = await import('@tanstack/react-query');
const { evShow } = await import('../../src/data/facts');
const { histRows, histCSV } = await import('../../src/data/hist');
const { alertKey, markRead, unreadOf } = await import('../../src/data/alerts');
const { qc } = await import('../../src/data/shared');
const MAlerts = (await import('../../src/screens/MAlerts')).default;
const MAlert = (await import('../../src/screens/MAlert')).default;
const MHistory = (await import('../../src/screens/MHistory')).default;
const PcHistory = (await import('../../src/screens/PcHistory')).default;
vi.spyOn(console, 'error').mockImplementation(() => {});   // 서버 렌더의 useLayoutEffect 경고만 조용히(판정 무관)

// 서버(sim/v2_link.py)가 실제로 만드는 원문 — 아래 «서버 원문 대조» 시험이 이 문자열의 출처를 확인한다
const KNOWN: [string, string][] = [
  ['STOP 요청 · 명령 0 잠금 (이 기기)', 'STOP · 입력 차단·잠금'],
  ['STOP 요청 · 명령 0 잠금 (보기 전용 기기)', 'STOP · 입력 차단·잠금'],
  ['조종권 해제 · 화면에서 놓음 → 명령 0 · STOP 잠금', '조종 반납 · 입력 차단·잠금'],
  ['조종권 해제 · 화면 숨김 → 명령 0 · STOP 잠금', '화면 숨김으로 입력 차단·잠금'],
  ['정책 미실행 → 명령 0 · 입력 버림', '제어 준비 안 됨 · 입력 무시'],
  ['시뮬 리셋 중 → 명령 0 · 입력 버림', '시뮬 리셋 중 · 입력 무시'],
  ['시뮬이 STOP 상태 · «STOP 해제» 필요', 'STOP 잠금 · 조종 시작 필요'],
  ['새 에피소드 7 · STOP 유지', '시뮬 회차 변경 · 잠금 유지'],
  ['새 에피소드 12 · STOP 유지', '시뮬 회차 변경 · 잠금 유지'],
  ['넘어짐 (시뮬 판정)', '넘어짐'],
];
// 사전 밖·비슷하지만 다른 원문은 그대로(임의 해석 0)
const RAW = ['조종권 해제 · 연결 끊김 → 명령 0 · STOP 잠금', '조종권 해제 · Gazebo 종료 → 명령 0 · STOP 잠금', '시뮬 상태 끊김 → 명령 0 · 입력 버림', '시뮬 상태 미수신 → 명령 0 · 입력 버림',
  'STOP (이 기기) · 재개 요청 취소', '입력 끊김 0.3 s → 명령 0', '시뮬 리셋 요청 · STOP 잠금', '리셋 응답: ok · STOP 유지', 'STOP 요청 · 명령 0 잠금 ()', 'STOP 요청 · 명령 0 잠금',
  '넘어짐 (시뮬 판정) ', ' 넘어짐 (시뮬 판정)', '넘어짐', '새 에피소드  · STOP 유지', '새 에피소드 3 · STOP 유지 · 추가', '서버가 새로 만든 알 수 없는 문장', ''];

test('§3 알려진 원문 → 표시 문장 · 사전 밖 원문은 그대로', () => {
  for (const [raw, show] of KNOWN) expect(evShow(raw), raw).toBe(show);
  for (const raw of RAW) expect(evShow(raw), raw).toBe(raw);
});

test('서버 원문 대조: 사전의 각 문장이 sim/v2_link.py 의 실제 ev 문구에서 나온다(서버 문구가 바뀌면 이 시험이 먼저 깨짐)', () => {
  const py = linkPy as string;
  for (const s of ["self.ev('bad', f'STOP 요청 · 명령 0 잠금 ({who})')", "self.ev('warn', f'조종권 해제 · {why} → 명령 0 · STOP 잠금')", "core.drop(self.cid, '화면에서 놓음')", "core.drop(self.cid, '화면 숨김')",
    "self.ev('warn', f'{block} → 명령 0 · 입력 버림')", "return '정책 미실행'", "return '시뮬 리셋 중'", "self.ev('warn', '시뮬이 STOP 상태 · «STOP 해제» 필요')",
    "self.ev('warn', f'새 에피소드 {d[\"episode\"]} · STOP 유지')", "self.ev('bad', '넘어짐 (시뮬 판정)')"]) expect(py, s).toContain(s);
});

const iso = (agoMs: number) => new Date(Date.now() - agoMs).toISOString().replace(/\.\d+Z$/, 'Z'), AT = iso(60e3);   // PcHistory 기본 기간(최근 30일) 안 — 실행 날짜와 무관
const ev = (text: string, st: 'warn' | 'bad' | 'ok' = 'bad', at = AT): MediaEvent => ({ t: at.slice(11, 19), st, text, at });
// 같은 at · 다른 원문 · 같은 표시 문장(누가만 다름) — 표시 문장으로 묶이면 안 되는 반례
const X = ev('STOP 요청 · 명령 0 잠금 (이 기기)'), Y = ev('STOP 요청 · 명령 0 잠금 (보기 전용 기기)'), Z = ev('넘어짐 (시뮬 판정)', 'bad', iso(90e3)), U = ev('알 수 없는 원문 "a,b"', 'warn', iso(120e3));
const M = (events: MediaEvent[]) => ({ photos: [], events, ok: true, err: '', stale: false, at: 1 });
const D = { list: [], rev: 0, err: '' };
beforeEach(() => { mem.clear(); qc.clear(); qc.setQueryData(['media'], { photos: [], events: [X, Y, Z, U] }); qc.setQueryData(['docs'], { docs: [], rev: 0 }); R.q = new URLSearchParams(); });

test('기록 행: title·href·CSV 는 원문, show 만 표시 문장 · 같은 at 다른 원문은 두 행', () => {
  const rows = histRows(D as any, M([X, Y, Z, U, ev('조종권 얻음 · 이 기기', 'ok')]) as any, true);
  expect(rows.map((r) => r.title)).toEqual([X.text, Y.text, Z.text, U.text]);   // ok 사건은 기존대로 기록에서 뺌
  expect(rows.map((r) => r.show)).toEqual(['STOP · 입력 차단·잠금', 'STOP · 입력 차단·잠금', '넘어짐', U.text]);
  expect(rows.map((r) => r.sub)).toEqual(Array(4).fill('서버 사건 원문'));
  expect(rows[0].href).not.toBe(rows[1].href);
  expect(new URLSearchParams(rows[1].href.split('?')[1]).get('t')).toBe(Y.text);
  const csv = histCSV(rows);
  expect(csv).toContain(X.text); expect(csv).toContain(Y.text); expect(csv).toContain('"알 수 없는 원문 ""a,b"""');
  expect(csv).not.toContain('입력 차단·잠금');
});

test('읽음 키는 원문: 같은 at·같은 표시 문장이라도 한 건 읽으면 다른 건은 미읽음', () => {
  expect(alertKey(X)).not.toBe(alertKey(Y));
  markRead([X], [X, Y, Z]);
  expect(unreadOf([X, Y, Z])).toEqual([Y, Z]);
});

const h = React.createElement;
const html = (C: any) => renderToStaticMarkup(h(QueryClientProvider, { client: qc }, h(C)));
const attrs = (s: string) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

test('MAlerts 화면: 제목은 표시 문장, 주소(at+t)는 원문, 사건마다 1행 · 모르는 원문은 «서버 사건 원문»', () => {
  const s = attrs(html(MAlerts));
  expect(s.match(/STOP · 입력 차단·잠금/g)?.length).toBe(2);
  expect(s).not.toContain('명령 0 잠금 (이 기기)</b>');
  for (const e of [X, Y, Z, U]) expect(s).toContain(`href="#/MAlert?${new URLSearchParams({ at: e.at, t: e.text })}"`);
  expect(s).toContain('서버 사건 · 원문은 상세 · 원인 판단 없음');
  expect(s).toContain(`<b style="font-size:14px">${U.text}</b><span class="lbl">서버 사건 원문 · 원인 판단 없음</span>`);
});

test('MAlert 상세: at+원문으로 찾은 그 사건 — 제목은 표시 문장, 원문 전문은 바로 아래 · 같은 at 다른 원문을 섞지 않음', () => {
  for (const e of [X, Y]) {
    R.q = new URLSearchParams({ at: e.at, t: e.text });
    const s = attrs(html(MAlert));
    expect(s).toContain('STOP · 입력 차단·잠금');
    expect(s).toContain(`원문: ${e.text}`);
    expect(s).not.toContain(`원문: ${(e === X ? Y : X).text}`);
  }
  R.q = new URLSearchParams({ at: AT, t: 'STOP · 입력 차단·잠금' });   // 표시 문장으로는 찾지 않는다(주소 키 = 원문)
  expect(attrs(html(MAlert))).toContain('사건을 찾지 못함');
  R.q = new URLSearchParams({ at: U.at, t: U.text });
  const s = attrs(html(MAlert));
  expect(s).toContain('서버 사건 원문 · Go2'); expect(s).not.toContain('원문: ');
});

test('MHistory·PcHistory 화면: 사건 제목은 표시 문장, 링크는 원문 키 · 모르는 원문은 그대로', () => {
  for (const C of [MHistory, PcHistory]) {
    const s = attrs(html(C));
    expect(s.match(/STOP · 입력 차단·잠금/g)?.length, C.name).toBe(2);
    expect(s).toContain('>넘어짐<');
    for (const e of [X, Y, Z, U]) expect(s, C.name).toContain(`href="#/MAlert?${new URLSearchParams({ at: e.at, t: e.text })}"`);
    expect(s).toContain(U.text);
    expect(s).not.toContain('명령 0 잠금 (이 기기)<');
  }
  const m = attrs(html(MHistory));
  expect(m).toContain('사건 · 원문은 상세 · 서버');
  expect(m).toContain('사건 · 서버 사건 원문 · 서버');   // U(모르는 원문)만
});

test('Main 사건 5줄은 evShow 를 거친다(소스 보조 — 화면은 670 QA)', () => {
  expect(mainSrc).toMatch(/events: \(st \? st\.events : \[\]\)\.slice\(0, 5\)\.map\(\(e\) => \(\{ t: e\.t, st: e\.st, mark: MARK\[e\.st\] \|\| '·', text: evShow\(e\.text\) \}\)\)/);
});
