// UX P0(10-15): R01 지점 선택(pickWp)·R02 탭 보관소 폐기(dropScratch). 순수 함수만 — 화면 흐름은 runs/ux-fix-20261015 의 헤드리스 원물
import { expect, test } from 'vitest';
import type { Run } from '@contracts';
import { pickWp } from '../../src/data/run';
import { ctx, drafts, dropScratch, useSel } from '../../src/data/scratch';

const wp = (st: '대기' | '방문' | '미방문') => ({ x: 0, y: 0, name: '', mods: [], st, at: '', why: '', chk: '', photos: [] }) as unknown as Run['wps'][number];
const run = (...s: ('대기' | '방문' | '미방문')[]) => ({ wps: s.map(wp) }) as unknown as Run;

test('pickWp: 고른 번호가 유효하면 그대로(방문 확인 뒤에도 같은 지점), 아니면 첫 대기', () => {
  expect(pickWp(run('대기', '대기', '대기'), undefined)).toEqual({ i: 0, next: 1 });
  expect(pickWp(run('방문', '대기', '대기'), 0)).toEqual({ i: 0, next: 1 });          // 방문 확인 뒤 선택 유지 · 다음 = WP2
  expect(pickWp(run('방문', '대기', '대기'), undefined)).toEqual({ i: 1, next: 2 });  // 고른 적 없음 → 첫 대기
  expect(pickWp(run('방문', '방문', '대기'), 2)).toEqual({ i: 2, next: -1 });
  expect(pickWp(run('대기', '방문', '방문'), 2)).toEqual({ i: 2, next: 0 });          // 뒤에 없으면 앞쪽 대기
  expect(pickWp(run('방문', '방문'), undefined)).toEqual({ i: -1, next: -1 });         // 모두 기록됨
  expect(pickWp(run('방문', '방문'), 1)).toEqual({ i: 1, next: -1 });                  // 지난 지점 보완(사진·판단)
});
test('pickWp: 범위 밖·음수·소수 선택은 버리고 첫 대기(다른 기록의 옛 번호 오채택 0)', () => {
  for (const s of [5, -1, 1.5, NaN]) expect(pickWp(run('방문', '대기'), s).i).toBe(1);
});
test('dropScratch: 초안·지점 선택 모두 버리고 문맥 번호 +1(떠나는 화면이 옛 문맥 초안을 다시 넣지 않게)', () => {
  drafts.set('mission:PcPlan', { id: 'm1', rev: 3, d: { name: 'x' } }); useSel.setState({ r1: 2 });
  const n = ctx.n; dropScratch();
  expect(drafts.size).toBe(0); expect(useSel.getState()).toEqual({}); expect(ctx.n).toBe(n + 1);
});
