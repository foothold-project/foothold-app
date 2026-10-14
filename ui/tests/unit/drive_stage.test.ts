// 조종 단계·경고 목록 — 서버 원값 조합별 표시. 명령 송신 없음(순수)
import { describe, expect, it } from 'vitest';
import { stageOf, warnsOf, type In } from '../../src/data/drive_stage';

const st = (o: Record<string, unknown> = {}) => ({ role: 'view', latch: true, reason: '', sim_block: '', resume_pending: false, reset_pending: false, ver: 'v1', holder: null, ...o }) as any;
const x = (o: Partial<In> = {}, s: Record<string, unknown> = {}): In => ({ linkOk: true, linkTxt: '정상', st: st(s), viewOnly: true, fallen: false, newVer: false, block: null, ...o });

describe('stageOf', () => {
  it('보기 → 조종권 → STOP 해제 → 조종 가능', () => {
    expect(stageOf(x()).i).toBe(0);
    expect(stageOf(x({ viewOnly: false }, { role: 'control' }))).toMatchObject({ i: 1, stop: null });
    expect(stageOf(x({ viewOnly: false }, { role: 'control', resume_pending: true }))).toMatchObject({ i: 2, stop: 'STOP 해제 확인 대기' });
    expect(stageOf(x({ viewOnly: false }, { role: 'control', latch: false }))).toMatchObject({ i: 3, stop: null });
  });
  it('서버 role=control 이어도 이 화면이 보기 전용이면 조종권 칸이 아님(자동 take 0)', () => {
    expect(stageOf(x({ viewOnly: true }, { role: 'control', latch: false })).i).toBe(0);
  });
  it('막힘은 단계 대신 이유', () => {
    expect(stageOf(x({ linkOk: false, linkTxt: '끊김 3 s' })).stop).toBe('링크 끊김 3 s');
    expect(stageOf(x({}, { sim_block: '시뮬 상태 끊김' })).stop).toBe('시뮬 상태 끊김');
    expect(stageOf(x({}, { role: 'view_other' })).stop).toBe('다른 기기가 조종 중');
    expect(stageOf(x({ st: null })).stop).toMatch(/^링크/);
    // 실제 발행 차단(driveBlock)이 있으면 앞 칸이 다 맞아도 «조종 가능» 아님
    expect(stageOf(x({ viewOnly: false, block: '새 판 — 새로고침' }, { role: 'control', latch: false }))).toMatchObject({ i: 2, stop: '새 판 — 새로고침' });
  });
});

describe('warnsOf', () => {
  it('막힘 → 주의 → 안내 순, 항목마다 해결 안내', () => {
    const w = warnsOf(x({ newVer: true, fallen: true }, { reason: '' }));
    expect(w.map((v) => [v.lvl, v.text.split(' ')[0]])).toEqual([['block', '새'], ['block', 'STOP'], ['warn', expect.any(String)], ['warn', '넘어짐'], ['info', '보기']]);
    expect(w.every((v) => v.fix.length > 0)).toBe(true);
  });
  it('링크 끊김이면 서버 상태 항목을 섞지 않음', () => {
    const w = warnsOf(x({ linkOk: false, linkTxt: '끊김 2 s' }, { sim_block: '시뮬 상태 끊김' }));
    expect(w.map((v) => v.text)).toEqual(['링크 끊김 2 s · 명령 0']);
  });
  it('넘어짐 단독은 주의(명령을 막지 않는 기존 계약) — 막힘 등급 0', () => {
    const w = warnsOf(x({ viewOnly: false, fallen: true }, { role: 'control', latch: false }));
    expect(w.map((v) => v.lvl)).toEqual(['warn']); expect(w[0].fix).toMatch('STOP');
  });
  it('조종 가능 상태는 경고 0', () => {
    expect(warnsOf(x({ viewOnly: false }, { role: 'control', latch: false }))).toEqual([]);
  });
  it('서버 이유는 STOP·막힘·«조종권 없음»일 때 중복 표시 안 함', () => {
    expect(warnsOf(x({ viewOnly: false }, { role: 'control', latch: false, reason: '후진 미검증 — 0' })).map((v) => v.text)).toEqual(['후진 미검증 — 0']);
    expect(warnsOf(x({}, { latch: false, reason: '조종권 없음' })).map((v) => v.text)).toEqual(['보기 전용']);
  });
});
