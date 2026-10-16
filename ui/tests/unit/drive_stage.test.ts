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
  it('시뮬 꺼짐 + 시작 불가면 이유를 해결 안내로, 최근 실패 결과는 주의로 계속 표시(toast 만으로 숨기지 않음) — SLAM-1: 시작 = map_start 칸', () => {
    const ms = { ok: false, why: '지도 체험 원장 소진 3/3', busy: false, session: null, ledger: { used: 3, max: 3, keys: [] }, last: { t: '13:06:35', st: 'bad', text: 'rooms_a/f1 · 기동 실패' } };
    const w = warnsOf(x({}, { sim_block: '시뮬 상태 미수신', map_start: ms }));
    expect(w[0]).toMatchObject({ lvl: 'block', fix: '시뮬 시작 불가 — 지도 체험 원장 소진 3/3' });
    expect(w.find((v) => v.text.startsWith('최근 시작 결과 13:06:35'))).toMatchObject({ lvl: 'warn', fix: 'rooms_a/f1 · 기동 실패' });
    expect(w.map((v) => v.text).join()).toMatch('13:06:35 · 실패·결과 미확인'); expect(w.map((v) => v.text + v.fix).join()).not.toMatch(/안 켜짐/);   // r2: bad 에 시간 초과 포함 — 꺼짐 단정 0
    expect(warnsOf(x({}, { sim_block: '시뮬 상태 미수신', map_start: { ...ms, ok: true, why: '', last: null } }))[0].fix).toMatch('꺼짐 확정 아님');   // 미수신 ≠ 꺼짐
    expect(warnsOf(x({}, { sim_block: '시뮬 상태 미수신', map_start: { ...ms, ok: true, why: '', last: null } }))[0].fix).toMatch('«지도 열기»(SLAM');
    // 반례: 평지 sim_start 칸만 거부·실패여도 안내·주의에 평지 이유를 쓰지 않음(새 UI 는 평지 시작을 안 보냄)
    const flat = { ok: false, why: '기존 평지 체험 사용 가능 횟수 소진(8/8)', busy: false, session: null, last: { t: '12:00:00', st: 'bad', text: '평지 실패' } };
    const w2 = warnsOf(x({}, { sim_block: '시뮬 상태 미수신', sim_start: flat, map_start: { ...ms, ok: true, why: '', last: null } }));
    expect(w2[0].fix).toMatch('«지도 열기»(SLAM'); expect(w2.map((v) => v.text + v.fix).join()).not.toMatch(/평지/);
  });
  it('조종 가능 상태는 경고 0', () => {
    expect(warnsOf(x({ viewOnly: false }, { role: 'control', latch: false }))).toEqual([]);
  });
  it('서버 이유는 STOP·막힘·«조종권 없음»일 때 중복 표시 안 함', () => {
    expect(warnsOf(x({ viewOnly: false }, { role: 'control', latch: false, reason: '후진 미검증 — 0' })).map((v) => v.text)).toEqual(['후진 미검증 — 0']);
    expect(warnsOf(x({}, { latch: false, reason: '조종권 없음' })).map((v) => v.text)).toEqual(['보기 전용']);
  });
});
