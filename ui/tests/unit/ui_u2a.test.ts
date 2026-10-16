import { expect, test } from 'vitest';
// U2-a(10-16 root «U2 개편»): 기록 사건 심각도 위험·경고·정보 — 기본 위험·경고. 정보 사건을 histRows 에서 미리 빼던 경로를 없애고
// 거르기는 histFilter·sevKeep 한 곳. 원문 title·at·href(키)·CSV 열 보존, 다른 탭·보고서 CSV 는 기본값(옛 결과와 같음). 순수 함수만.
import type { MediaEvent } from '@contracts';
const { histRows, histCSV, histFilter, sevKeep, SEV, SEV0 } = await import('../../src/data/hist');

const NOW = Date.parse('2026-10-16T12:00:00Z');
const at = (min: number) => new Date(NOW - min * 60e3).toISOString().replace(/\.\d+Z$/, 'Z');
const ev = (text: string, st: string, a: string) => ({ t: a.slice(11, 19), st, text, at: a }) as MediaEvent;
const EVS = [ev('넘어짐 (시뮬 판정)', 'bad', at(10)), ev('조종권 해제 · 연결 끊김', 'warn', at(20)), ev('조종권 얻음 · 이 기기', 'ok', at(30)), ev('정보 "쉼표", 둘', 'ok', at(40)), ev('알 수 없는 단계', 'odd', at(50))];
const RUN = { kind: 'run', id: 'r1', at: at(5), by: 'kim', rev: 1, doc: { name: '임무1', tmpl: '순찰', status: '완료', started: at(5), ended: at(5), memo: '', wps: [{ st: '방문', photos: [] }] } };
const D = { list: [RUN], rev: 1, err: '' } as any, M = { photos: [], events: EVS, ok: true, err: '', stale: false, at: 1 } as any;
const ALL = histRows(D, M, true);
const H = (tab: any, sev?: string) => histFilter(ALL, tab, { q: '', per: '최근 30일', tpl: '', res: '모든 결과', by: '', ...(sev ? { sev } : {}) }, NOW);
const T = (rs: any[]) => rs.map((r) => r.title);

test('histRows 는 정보 사건도 행으로(사전 제외 0) — 원문·키·결과 글 보존', () => {
  const ev = ALL.filter((r) => r.kind === '사건');
  expect(T(ev)).toEqual(EVS.map((e) => e.text));
  const info = ev.find((r) => r.title === '조종권 얻음 · 이 기기')!;
  expect(info).toMatchObject({ lvl: 'ok', res: '정보', at: EVS[2].at, sub: '서버 사건 원문', by: '서버' });
  expect(info.href).toBe(`#/MAlert?${new URLSearchParams({ at: EVS[2].at, t: EVS[2].text })}`);
});
test('사건 탭 심각도: 기본(sev 없음·SEV0) = 정보 아님(알 수 없는 st 남김 · 옛 결과) · 위험 · 경고 · 정보 · 모두', () => {
  const old = EVS.filter((e) => e.st !== 'ok').map((e) => e.text);   // 옛 histRows 사전 제외와 같은 결과
  expect(T(H('사건').tab)).toEqual(old); expect(T(H('사건', SEV0).tab)).toEqual(old);
  expect(T(H('사건', '위험').tab)).toEqual(['넘어짐 (시뮬 판정)']);
  expect(T(H('사건', '경고').tab)).toEqual(['조종권 해제 · 연결 끊김']);
  expect(T(H('사건', '정보').tab)).toEqual(['조종권 얻음 · 이 기기', '정보 "쉼표", 둘']);
  expect(T(H('사건', '모두').tab)).toEqual(EVS.map((e) => e.text));
  expect(T(H('사건', '없는 값').tab)).toEqual(old);   // 모르는 값 = 기본
  expect(Object.keys(SEV)).toEqual(['위험·경고', '위험', '경고', '정보', '모두']);
});
test('공통 규칙: 다른 탭 every·보고서(sevKeep 기본) = 정보 제외 · 사건 아닌 행은 무관 · CSV 는 원문·level 그대로', () => {
  expect(T(H('임무').every.filter((r) => r.kind === '사건'))).toEqual(EVS.filter((e) => e.st !== 'ok').map((e) => e.text));
  expect(H('임무').tab.length).toBe(1);
  expect(ALL.filter((r) => sevKeep(r)).length).toBe(ALL.length - 2);
  expect(H('사건', '정보').every.filter((r) => r.kind === '임무').length).toBe(1);   // 임무 행은 심각도와 무관
  const csv = histCSV(H('사건', '정보').tab).split('\n');
  expect(csv[0]).toBe('at,kind,level,title,result,detail,by,photo');
  expect(csv[1]).toContain(`${EVS[2].at},사건,ok,조종권 얻음 · 이 기기,정보,서버 사건 원문,서버`);
  expect(csv.join('\n')).toContain('"정보 ""쉼표"", 둘"');
});
