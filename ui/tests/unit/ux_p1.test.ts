// UX P1(10-15): R14 경보 읽음 키 집합 · R24 임무 범위 CSV 행 · R25 stale 구분. 순수 함수만 — 화면 흐름은 runs/ux-fix-20261015 헤드리스 원물
import { beforeEach, expect, test } from 'vitest';
import type { MediaEvent } from '@contracts';
const mem = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
const { alertKey, markRead, unreadOf } = await import('../../src/data/alerts');
const { runRows, WIN_NOTE } = await import('../../src/data/hist');
const { isStale } = await import('../../src/data/shared');

const ev = (at: string, text = 'x', st: 'warn' | 'bad' = 'warn'): MediaEvent => ({ t: at.slice(11, 19), st, text, at });
const A = ev('2026-10-15T12:00:00+0900', 'a'), B = ev('2026-10-15T12:01:00+0900', 'b'), C = ev('2026-10-15T12:02:00+0900', 'c');
beforeEach(() => mem.clear());

test('R14 개별 읽음: 최신 1건만 읽으면 이전 2건은 미읽음', () => {
  const all = [C, B, A]; markRead([C], all);
  expect(unreadOf(all)).toEqual([B, A]);
});
test('R14 보이는 것 모두: 화면 2건만 표시 → 남은 1건 미읽음 · 뒤에 온 과거 시각 경보도 미읽음', () => {
  let all = [C, B, A]; markRead([C, B], all);
  expect(unreadOf(all)).toEqual([A]);
  const late = ev('2026-10-15T11:00:00+0900', 'late');   // 시각은 더 이르지만 나중에 도착
  all = [C, B, A, late];
  expect(unreadOf(all)).toEqual([A, late]);
});
test('R14 같은 at·다른 text 는 독립 · 키는 실존 필드(배열 위치 아님)', () => {
  const X = ev('2026-10-15T12:00:00+0900', 'x1'), Y = ev('2026-10-15T12:00:00+0900', 'x2');
  markRead([X], [X, Y]);
  expect(unreadOf([Y, X])).toEqual([Y]);
  expect(alertKey(X)).not.toBe(alertKey(Y));
});
test('R14 옛 단일 시각은 migration 만: 그 시각 이전 = 읽음, 이후 = 미읽음, 새로 쓰지 않음', () => {
  mem.set('fh.live.alerts.read', JSON.stringify(B.at));
  expect(unreadOf([C, B, A])).toEqual([C]);
  markRead([C], [C, B, A]);
  expect(mem.get('fh.live.alerts.read')).toBe(JSON.stringify(B.at));
  expect(unreadOf([C, B, A])).toEqual([]);
});
test('R14 보관 키는 지금 서버 목록에 남은 것만(상한)', () => {
  markRead([A, B], [A, B]); markRead([C], [C, B]);
  expect(JSON.parse(mem.get('fh.live.alerts.read.keys')!).sort()).toEqual([alertKey(B), alertKey(C)].sort());
});

test('R24 임무 CSV 행: 그 임무 행 + 지점 사진 + 시간 창 사건(원인 연결 아님 표시)만', () => {
  const row = (o: any) => ({ lvl: 'warn', title: '', res: '', sub: '서버 사건 원문', href: '', ...o });
  const rows = [row({ at: '2026-10-15T12:05:00+0900', kind: '임무', run: 'r1' }), row({ at: '2026-10-15T12:06:00+0900', kind: '임무', run: 'r2' }),
    row({ at: '2026-10-15T12:07:00+0900', kind: '사진', url: 'p1' }), row({ at: '2026-10-15T12:08:00+0900', kind: '사진', url: 'p2' }),
    row({ at: '2026-10-15T12:09:00+0900', kind: '사건' }), row({ at: '2026-10-15T13:30:00+0900', kind: '사건' })];
  const run = { id: 'r1', doc: { started: '2026-10-15T12:00:00+0900', ended: '2026-10-15T13:00:00+0900', wps: [{ photos: ['p1'] }] } };
  const out = runRows(rows as any, run);
  expect(out.map((r) => r.kind + (r.run || r.url || ''))).toEqual(['임무r1', '사진p1', '사건']);
  expect(out[2].sub).toContain(WIN_NOTE);
  expect(runRows(rows as any, { ...run, doc: { ...run.doc, ended: '' } }, Date.parse('2026-10-15T14:00:00+09:00')).filter((r) => r.kind === '사건')).toHaveLength(2);   // 진행 중 = 지금까지
});

test('R25 stale: 옛 자료 + 재조회 오류일 때만', () => {
  expect(isStale(true, true)).toBe(true);
  expect(isStale(true, false)).toBe(false);
  expect(isStale(false, true)).toBe(false);
});
