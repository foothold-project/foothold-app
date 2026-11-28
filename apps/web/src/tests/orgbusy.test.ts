// 조직 설정 혼잡 시간 식(orgbusy.ts): 모의 실행 점검 · 보고서 혼잡 줄이 쓰는 겹침 판단
import { describe, expect, it } from 'vitest';
import { busyDuring, busyOverlap, durText } from '../orgbusy';

const B = [{ day: 'mon', start: '08:30', end: '09:15', label: '출근' }, { day: 'mon', start: '12:00', end: '13:00', label: '점심' }, { day: 'tue', start: '08:30', end: '09:15', label: '출근' }] as const;
const at = (d: number, h: number, m: number) => new Date(2026, 10, d, h, m).toISOString();   // 2026-11-30 = 월

describe('혼잡 시간 겹침', () => {
  it('같은 요일 · 시각이 겹칠 때만(끝 = 시작은 겹침 아님)', () => {
    expect(busyOverlap([...B], 'mon', '09:00', '10:00').map((b) => b.label)).toEqual(['출근']);
    expect(busyOverlap([...B], 'mon', '09:15', '12:00')).toEqual([]);
    expect(busyOverlap([...B], 'wed', '08:00', '20:00')).toEqual([]);
  });
  it('실행 시각(ISO): 시작 날 요일로 · 끝이 없으면 시작 그 분', () => {
    expect(busyDuring([...B], at(30, 11, 50), at(30, 12, 10)).map((b) => b.label)).toEqual(['점심']);
    expect(busyDuring([...B], at(30, 8, 40), null).map((b) => b.label)).toEqual(['출근']);
    expect(busyDuring([...B], at(30, 10, 0), at(30, 11, 0))).toEqual([]);
  });
  it('분 → 시간 글', () => {
    expect(durText(240)).toBe('4 시간'); expect(durText(270)).toBe('4 시간 30 분'); expect(durText(30)).toBe('30 분');
  });
});
