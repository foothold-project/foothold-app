// #602 검토 H1 · H2 · G1: 관문 닫힘 잠금을 사람 STOP 확인으로 읽지 않고, FIELD_GATE_CLOSED 안내는 허용이어도 보인다
import { expect, it } from 'vitest';
import { GATE_STOP_TEXT, shownDriveBlocked, stopReach } from '../rt';
import { stopLine } from '../serverdrive';
import { state } from './fakeWs';

it('stopReach: CLOSED 는 gate, stop_applied false 는 other, 옛 서버(값 없음)는 applied', () => {
  expect(stopReach(state('r1', { field_gate: 'CLOSED', stop_applied: false }))).toBe('gate');
  expect(stopReach(state('r1', { field_gate: 'CLOSED', stop_applied: true }))).toBe('gate');
  expect(stopReach(state('r1', { field_gate: 'OPEN', stop_applied: false }))).toBe('other');
  expect(stopReach(state('r1', { field_gate: 'OPEN', stop_applied: true }))).toBe('applied');
  expect(stopReach(state('r1'))).toBe('applied');
  expect(stopReach(null)).toBe('applied');
});

const stop = { phase: 'sent' as const, at: 0, n: 1, g0: 1, conn: 1, rev: 0, latched: true as const };

it('stopLine: 관문 닫힘이면 리모컨 안내, «로봇 정지 확인» 아님 (G1 · H1)', () => {
  const closed = state('r1', { stop_gen: 2, field_gate: 'CLOSED', stop_applied: false });
  expect(stopLine({ stop, state: closed })).toEqual({ tone: 'bad', text: GATE_STOP_TEXT });
  expect(stopLine({ stop: { ...stop, latched: undefined }, state: closed })?.text).toBe(GATE_STOP_TEXT);
});

it('stopLine: 관문이 다시 열려도 사람 STOP 이 반영 안 된 잠금은 확인 대기 (H1)', () => {
  const other = state('r1', { stop_gen: 2, field_gate: 'OPEN', stop_applied: false });
  expect(stopLine({ stop, state: other })?.tone).toBe('warn');
  expect(stopLine({ stop, state: { ...other, stop_applied: true } })?.tone).toBe('ok');
  expect(stopLine({ stop, state: state('r1', { stop_gen: 2 }) })?.tone).toBe('ok');   // 옛 서버
});

it('shownDriveBlocked: 허용이 아니면 목록 그대로, 허용이면 FIELD_GATE_CLOSED 만 (H2)', () => {
  expect(shownDriveBlocked(false, ['AGENT_OFFLINE'])).toEqual(['AGENT_OFFLINE']);
  expect(shownDriveBlocked(true, ['FIELD_GATE_CLOSED'])).toEqual(['FIELD_GATE_CLOSED']);
  expect(shownDriveBlocked(true, [])).toBeNull();
  expect(shownDriveBlocked(true, null)).toBeNull();
  expect(shownDriveBlocked(undefined, undefined)).toBeNull();
});
