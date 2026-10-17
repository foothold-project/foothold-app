import { expect, test } from 'vitest';
// U3-b(v3 §4 PcHistory): 3탭 거르기 histFilter — 화면 표와 «현재 탭 CSV»·«전체 기록 CSV»가 같은 함수 결과(쪽 나누기 전)를 쓴다. 순수 함수만.
import type { MediaEvent } from '@contracts';
const { histRows, histCSV, histFilter } = await import('../../src/data/hist');

const NOW = Date.parse('2026-10-16T12:00:00Z');
const at = (min: number) => new Date(NOW - min * 60e3).toISOString().replace(/\.\d+Z$/, 'Z');
const ev = (text: string, st: 'warn' | 'bad' | 'ok', a: string): MediaEvent => ({ t: a.slice(11, 19), st, text, at: a });
const run = (id: string, name: string, tmpl: string, status: string, by: string, a: string, memo = '') =>
  ({ kind: 'run', id, at: a, by, rev: 1, doc: { name, tmpl, status, started: a, ended: status === '진행' ? null : a, memo, wps: [{ st: '방문', photos: [] }] } });
const note = (url: string, cls: string, memo: string) => ({ kind: 'note', id: `n-${url}`, at: at(1), by: 'kim', rev: 1, doc: { photo: url, cls, memo } });
const T0 = at(30);   // 같은 시각 두 원문
const EVS = [ev('STOP 요청 · 명령 0 잠금 (이 기기)', 'bad', T0), ev('STOP 요청 · 명령 0 잠금 (보기 전용 기기)', 'bad', T0), ev('넘어짐 (시뮬 판정)', 'bad', at(40)),
  ev('조종권 해제 · 연결 끊김 → 명령 0 · STOP 잠금', 'warn', at(50)), ev('특수 "따옴표", 쉼표\n줄바꿈', 'warn', at(60)), ev('조종권 얻음 · 이 기기', 'ok', at(70)),
  ev('이틀 전 경고', 'warn', at(60 * 24 * 2)), ev('25일 전 경고', 'warn', at(60 * 24 * 25)), ev('오래된 경고', 'warn', at(60 * 24 * 40))];
const PHOTOS = [{ url: '/p/1.jpg', saved_at: at(5), x: 1, y: 2, by: 'kim' }, { url: '/p/2.jpg', saved_at: at(6), x: null, y: null, by: 'lee' }];
// 임무 25개(쪽 20 초과) — 양식 둘·상태 셋·운영자 둘
const RUNS = Array.from({ length: 25 }, (_, i) => run(`r${i}`, `임무${i}`, i % 2 ? '순찰' : '점검', ['완료', '진행', '중단'][i % 3], i % 2 ? 'kim' : 'lee', at(100 + i), i === 3 ? '입력 차단 메모' : ''));
const D = { list: [...RUNS, note('/p/1.jpg', '확인', '계단 앞')], rev: 3, err: '' } as any;
const M = { photos: PHOTOS, events: EVS, ok: true, err: '', stale: false, at: 1 } as any;
const ALL = histRows(D, M, true);
const F = (o: any = {}) => ({ q: '', per: '최근 30일', tpl: '', res: '모든 결과', by: '', ...o });
const H = (tab: any, o: any = {}) => histFilter(ALL, tab, F(o), NOW);
const titles = (rs: any[]) => rs.map((r) => r.title);

test('탭 = 종류 제한 · every = 같은 조건 3종 · every 의 그 종류 = 탭 행(같은 순서)', () => {
  for (const tab of ['임무', '사진', '사건'] as const) for (const o of [{}, { q: '입력 차단' }, { per: '전체' }, { tpl: '순찰', res: '완료', by: 'kim' }]) {
    const r = H(tab, o);
    expect(r.tab.every((x) => x.kind === tab)).toBe(true);
    expect(r.every.filter((x) => x.kind === tab)).toEqual(r.tab);
  }
  const r = H('임무');
  expect(r.tab.length).toBe(25);   // 쪽 20 을 넘는 전체 — CSV 는 이 배열 그대로
  expect(r.every.length).toBe(25 + 2 + 7);   // 사진 2 · 사건 7(ok 제외 · 40일 전 제외)
  expect(histCSV(r.tab).trim().split('\n').length).toBe(1 + 25);
});

test('검색: 표시 문장만 일치·원문만 일치·둘 다 · 같은 시각 다른 원문 · 행은 한 번', () => {
  expect(titles(H('사건', { q: '입력 차단·잠금' }).tab)).toEqual(['STOP 요청 · 명령 0 잠금 (이 기기)', 'STOP 요청 · 명령 0 잠금 (보기 전용 기기)']);   // 표시만 일치
  expect(titles(H('사건', { q: '보기 전용' }).tab)).toEqual(['STOP 요청 · 명령 0 잠금 (보기 전용 기기)']);                                       // 원문만(같은 시각 다른 원문 구분)
  expect(titles(H('사건', { q: 'STOP' }).tab)).toEqual(['STOP 요청 · 명령 0 잠금 (이 기기)', 'STOP 요청 · 명령 0 잠금 (보기 전용 기기)', '조종권 해제 · 연결 끊김 → 명령 0 · STOP 잠금']);   // 둘 다 일치해도 한 번
  expect(titles(H('사건', { q: '넘어짐' }).tab)).toEqual(['넘어짐 (시뮬 판정)']);
  expect(titles(H('사건', { q: '"따옴표", 쉼표' }).tab)).toEqual(['특수 "따옴표", 쉼표\n줄바꿈']);
  // 같은 검색이 다른 종류에도: «입력 차단»은 사건 표시 문장 + 임무 메모
  const e = H('임무', { q: '입력 차단' });
  expect(titles(e.tab)).toEqual(['임무3']);
  expect(e.every.map((r) => r.kind)).toEqual(['사건', '사건', '임무']);
});

test('CSV: 열·원문 그대로(표시 문장 0) · 특수문자 이스케이프 · 탭/전체 행수', () => {
  const r = H('사건', { q: '' }), csv = histCSV(r.tab);
  expect(csv.split('\n')[0]).toBe('at,kind,level,title,result,detail,by,photo');
  expect(csv).toContain('STOP 요청 · 명령 0 잠금 (이 기기)'); expect(csv).not.toContain('입력 차단·잠금');
  expect(csv).toContain('"특수 ""따옴표"", 쉼표\n줄바꿈"');
  expect(r.tab.length).toBe(7);
  const all = H('사건', { q: '입력 차단·잠금' });
  expect(histCSV(all.every)).not.toContain('입력 차단·잠금');   // 표시 문장으로 찾은 행도 CSV 는 원문
  expect(all.every.length).toBe(2);
});

test('탭 필터는 값이 있는 종류에만 · 다른 탭에서는 적용 0(몰래 0건 0)', () => {
  // 임무 탭: 양식·결과·운영자 → 임무에만, 운영자는 사진에도. 사건(by 서버)은 운영자 필터와 무관
  const a = H('임무', { tpl: '순찰', res: '완료', by: 'kim' });
  expect(a.tab.every((r) => r.tmpl === '순찰' && r.st === '완료' && r.by === 'kim')).toBe(true);
  expect(a.tab.length).toBe(RUNS.filter((_, i) => i % 2 && i % 3 === 0).length);
  expect(a.every.filter((r) => r.kind === '사진').map((r) => r.by)).toEqual(['kim']);
  expect(a.every.filter((r) => r.kind === '사건').length).toBe(7);
  // 사진 탭: 양식·결과는 TAB_F 밖 → 값이 남아 있어도 적용 안 함
  const p = H('사진', { tpl: '순찰', res: '완료' });
  expect(p.tab.length).toBe(2); expect(p.every.filter((r) => r.kind === '임무').length).toBe(25);
  // 사건 탭: 운영자 값이 남아 있어도 적용 안 함
  expect(H('사건', { by: 'kim' }).tab.length).toBe(7);
  expect(H('사건', { by: 'kim' }).every.filter((r) => r.kind === '임무').length).toBe(25);
});

test('기간: 최근 30일 · 오늘 · 전체 · 사진 메모 검색', () => {
  expect(H('사건', { per: '전체' }).tab.length).toBe(8);
  expect(H('사건', { per: '최근 7일' }).tab.length).toBe(6);
  expect(H('사건', { per: '오늘' }).tab.length).toBe(5);
  expect(H('사진', { q: '계단' }).tab.map((r) => r.extra)).toEqual(['계단 앞']);
  expect(H('사진', { q: '미분류' }).tab).toEqual([]);   // 분류 글자는 기존처럼 검색 대상 아님(title·sub·extra·show 만)
});
