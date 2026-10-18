import { afterAll, expect, test } from 'vitest';
// G3(ROOT-IMPLEMENT 3 · UX-SPEC 2-1 R1·2-2·2-4 · 10-19): 머리줄 칩 3개 순수 판정 — ① 관문 ② 대상 ③ 조작·다음 행동.
// 본다: 관문 도움말에 sim_block 0 · 관문 비정상이면 ② off «대기»(경고 연쇄 0) · ③ 은 ② 와 무관(유효 status 면 sim_block 끊김·리셋이어도 다른 기기 조종·잠금 밖 유지)
//       · status 미확인일 때만 «조작 · 대기»(옛 잠금 현재 단정 0) · 잠금은 lock tone(bad 아님) · 실기 대상은 ② 하나 · 영상은 관문 정상일 때만 경고.
// 한계: 색·테두리(.lv-chip.lock)·«상태 ▾» 패널 자리는 CSS·실브라우저 몫(670).
const FAKE = { window: globalThis, localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, location: { href: 'http://127.0.0.1/', protocol: 'http:', hash: '', search: '', pathname: '/' } };
const SAVED = Object.keys(FAKE).map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)] as const);
Object.assign(globalThis, FAKE);
afterAll(() => { for (const [k, d] of SAVED) { if (d) Object.defineProperty(globalThis, k, d); else delete (globalThis as any)[k]; } });   // 단일 fork 다른 파일에 가짜 전역 남김 0
const { headChips, statusRows, camChip, gateWait, LOCK_NOTE } = await import('../../src/app/status');
const ST = (o: any = {}) => ({ role: 'control', latch: false, sim_block: '', ...o });
const H = (o: any = {}) => headChips({ provider: 'simulation_gate', linkOk: true, open: true, everMsg: true, authEnd: false, bad: null, viewOnly: false, linkTxt: '정상', roleTxt: '조종권 · 이 기기', latch: false, ...o, st: o.st === null ? null : ST(o.st) as any });
const t = (c: { tone: string; text: string }) => `${c.tone}:${c.text}`;

test('① 관문: 조건별 글 · 도움말에 sim_block 섞임 0(정상이면 «정상»)', () => {
  expect(H().map((c) => c.k)).toEqual(['gate', 'target', 'op']);
  expect(t(H()[0])).toBe('ok:관문 연결됨');
  const sb = H({ st: { sim_block: '시뮬 상태 끊김' }, linkTxt: '시뮬 상태 끊김' })[0];   // linkView 는 정상 연결이면 linkTxt 에 sim_block 을 담음
  expect(t(sb)).toBe('ok:관문 연결됨'); expect(sb.why).not.toContain('시뮬'); expect(sb.why).toContain('정상');
  expect(t(H({ authEnd: true })[0])).toBe('bad:로그인 끝남 · 다시 로그인');
  expect(t(H({ linkOk: false, everMsg: false })[0])).toBe('warn:관문 연결 중');
  expect(t(H({ linkOk: false, open: true })[0])).toBe('warn:관문 상태 오래됨');
  expect(t(H({ linkOk: false, open: false })[0])).toBe('bad:관문 끊김 · 다시 연결 중');
  expect(H({ linkOk: false, open: false })[0].why).toContain('STOP 전달·잠금 확인 불가');
  expect(t(H({ bad: '형식' })[0])).toBe('warn:관문 상태 확인 안 됨');
  expect(t(H({ st: null })[0])).toBe('warn:관문 상태 확인 안 됨');
});

test('② 대상: 관문 비정상이면 off «대기»(경고 연쇄 0) · 관문 정상이면 sim_block 대로', () => {
  for (const o of [{ linkOk: false, open: false }, { linkOk: false, everMsg: false }, { bad: 'x' }, { st: null }, { authEnd: true }]) {
    const c = H(o); expect(t(c[1])).toBe('off:시뮬 · 대기(관문 먼저)'); expect(c.filter((x) => x.tone === 'warn' || x.tone === 'bad').length).toBeLessThanOrEqual(1);
  }
  const tg = (b: string) => t(H({ st: { sim_block: b } })[1]);
  expect(tg('')).toBe('ok:시뮬 응답 중'); expect(tg('시뮬 상태 미수신')).toBe('warn:시뮬 확인 안 됨'); expect(tg('시뮬 상태 끊김')).toBe('bad:시뮬 끊김');
  expect(tg('시뮬 리셋 중')).toBe('warn:시뮬 리셋 중'); expect(tg('정책 미실행')).toBe('warn:제어 준비 안 됨'); expect(tg('그 밖')).toBe('warn:시뮬 처리 중');
});

test('③ 조작: status 미확인만 «대기» · 유효 status 면 sim_block 과 무관하게 다른 기기 조종·잠금 밖 · 잠금 = lock tone', () => {
  for (const o of [{ linkOk: false, open: false, latch: true }, { bad: 'x', latch: true }, { st: null, latch: true }]) {
    const c = H(o)[2]; expect(t(c)).toBe('off:조작 · 대기'); expect(c.why).toContain('잠금 상태 미확인'); expect(c.text).not.toContain('잠금');   // 옛 잠금 현재 단정 0
  }
  for (const b of ['', '시뮬 상태 끊김', '시뮬 리셋 중', '시뮬 상태 미수신']) {
    expect(t(H({ st: { sim_block: b, role: 'view_other' } })[2])).toBe('warn:다른 기기 조종 중 · 반납 대기');
    expect(t(H({ st: { sim_block: b, latch: true }, latch: true })[2])).toBe('lock:STOP 잠금 · «조종 시작»으로 해제');
  }
  expect(t(H({ st: { role: 'view_other', latch: true }, latch: true })[2])).toBe('warn:다른 기기 조종 중 · STOP 잠금');   // 두 독립 사실 함께
  expect(t(H()[2])).toBe('ok:이 기기 조종 중');
  expect(t(H({ viewOnly: true, latch: true, st: { latch: true } })[2])).toBe('lock:보기 전용 · STOP 잠금');
  expect(t(H({ viewOnly: true })[2])).toBe('off:보기 전용 · 조종은 «조종» 메뉴');
  expect(t(H({ viewOnly: true, main: true })[2])).toBe('off:보기 전용 · «조종 시작»');
  expect(t(H({ viewOnly: true, main: true, latch: true, st: { latch: true } })[2])).toBe('lock:보기 전용 · STOP 잠금 · «조종 시작»');
  expect(H({ latch: true, st: { latch: true } })[2].why).toContain(LOCK_NOTE);
  for (const o of [{}, { latch: true, st: { latch: true } }, { viewOnly: true, latch: true, st: { latch: true } }]) expect(H(o).some((c) => c.tone === 'bad')).toBe(false);   // 잠금은 bad(빨강) 아님
});

test('실기 대상 = ② 하나 · 상세 4행(statusRows) 은 옛 판정 그대로 · 영상은 관문 정상일 때만 경고', () => {
  expect(H({ provider: 'go2_direct' }).map((c) => `${c.k}:${t(c)}`)).toEqual(['target:off:실기 미연결 · 직접 연결 준비 중']);
  const d = statusRows({ provider: 'simulation_gate', linkOk: true, open: true, everMsg: true, authEnd: false, bad: null, st: ST() as any, viewOnly: false, linkTxt: '정상', roleTxt: 'r', latch: false });
  expect(d.map((c) => c.k)).toEqual(['sim', 'link', 'role', 'lock']); expect(t(d[3])).toBe('ok:잠금 해제');   // 정상 값은 패널에만
  expect(gateWait(H())).toBe(false); expect(gateWait(H({ linkOk: false, open: false }))).toBe(true); expect(gateWait(H({ provider: 'go2_direct' }))).toBe(true);
  expect(t(camChip({ camOk: false, camTxt: '미연결' }, true))).toBe('off:영상 · 대기');
  expect(t(camChip({ camOk: false, camTxt: '미연결' }, false))).toBe('warn:영상 없음');
  expect(t(camChip({ camOk: true, camTxt: '받음' }, true))).toBe('ok:영상 받음');
});
