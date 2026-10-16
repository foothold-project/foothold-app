import { expect, test, vi } from 'vitest';
// U1(10-16 root «U1 STOP 알림 GO»): STOP 뒤 비차단 결과 알림의 단계 판정(순수)과 stopNow 기록.
// 실화면 배치(STOP·확인창·toast 회피)·전체화면·폰·실제 누름은 670 고정판 QA 몫(여기서는 판정·기록만).
Object.assign(globalThis, { localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, location: { href: 'http://127.0.0.1/', protocol: 'http:', hash: '', search: '', pathname: '/' } });
vi.spyOn(console, 'error').mockImplementation(() => {});
const { stopPhase, stopNow, useStopN, STOP_MSG, STOP_FAIL_LINK, STOP_FAIL_REAL, STOP_WAIT_MS } = await import('../../src/app/shell');
const { useLink, askPage, useAsk } = await import('../../src/data/link');

const R = { seq: 1, t: 1000, sent: true, fail: '', gen: 3, sg: 5 };
const L = (x: Record<string, unknown>) => ({ ...useLink.getState(), open: true, gen: 3, stGen: 3, lastMsg: 1100, st: { latch: true, stop_gen: 6 }, ...x }) as any;
const ph = (r: Partial<typeof R>, s: Record<string, unknown>, now = 1200) => stopPhase({ ...R, ...r }, L(s), now)[0];

test('단계: 보낸 뒤 같은 연결의 새 status 가 latch·세대 증가일 때만 «서버 확인»', () => {
  expect(ph({}, {})).toBe('ok');
  expect(ph({}, { st: { latch: true, stop_gen: 5 } })).toBe('wait');    // 이미 잠겨 있던 옛 세대 그대로 = 이 STOP 처리 확인 아님
  expect(ph({}, { lastMsg: 1000 })).toBe('wait');                        // 보내기 전(같은 시각) 받은 status
  expect(ph({}, { st: { latch: false, stop_gen: 6 } })).toBe('wait');   // 세대만 오르고 잠금 꺼짐
  expect(ph({}, { stGen: 2 })).toBe('wait');                             // 이 연결에서 유효 status 미확인
  expect(ph({ sg: undefined }, { st: { latch: true } })).toBe('ok');     // 보낼 때 세대 모름(옛 서버) → 보낸 뒤 latch 만
});
test('단계: 연결 바뀜·닫힘 = 끊김(미확인), 2 s 넘게 확인 없음 = 초과(미확인), 실패는 그 글', () => {
  expect(ph({}, { gen: 4, stGen: 4 })).toBe('lost');
  expect(ph({}, { open: false, st: { latch: false, stop_gen: 5 } })).toBe('lost');
  expect(ph({}, { st: { latch: false, stop_gen: 5 } }, 1000 + STOP_WAIT_MS)).toBe('wait');
  expect(ph({}, { st: { latch: false, stop_gen: 5 } }, 1001 + STOP_WAIT_MS)).toBe('late');
  expect(stopPhase({ ...R, sent: false, fail: STOP_FAIL_LINK }, L({}), 1200)).toEqual(['fail', STOP_FAIL_LINK]);
});
test('글: 어느 단계도 몸 정지를 단정하지 않고, 보낸 뒤 단계는 «몸이 멈췄는지 화면에서 확인»', () => {
  for (const t of Object.values(STOP_MSG)) { expect(t).toContain('몸이 멈췄는지 화면에서 확인'); expect(t).not.toMatch(/정지됨|멈춤 완료|멈췄습니다|안전/); }
  expect(STOP_MSG.lost).toContain('미확인'); expect(STOP_MSG.late).toContain('미확인'); expect(STOP_MSG.wait).toContain('기다리는');
});
test('stopNow: 송신 시도 기록(실기 = 미연결 글 · 시뮬 링크 없음 = 보내지 못함 글) · 다시 누르면 새 기록 · 열린 확인창 취소 그대로', async () => {
  useLink.setState({ provider: 'real_go2', gen: 7 } as any); stopNow();
  expect(useStopN.getState().r).toMatchObject({ sent: false, fail: STOP_FAIL_REAL, gen: 7 });
  const s1 = useStopN.getState().r!.seq;
  useLink.setState({ provider: 'simulation_gate', st: { latch: false, stop_gen: 2 } } as any);
  const p = askPage('창');
  stopNow();
  expect(useStopN.getState().r).toMatchObject({ seq: s1 + 1, sent: false, fail: STOP_FAIL_LINK, sg: 2 });
  expect(await p).toBe(false); expect(useAsk.getState().text).toBeNull();
});
