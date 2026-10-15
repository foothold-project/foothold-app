import { expect, test, vi } from 'vitest';
// UI-SIMPLIFY v3 U1-b: 공통 머리줄 칩(서버 값만 · 미확인≠꺼짐) · «시뮬 ▾» 메뉴(기존 경로만) · 개발자 표시 이동 · 초점 되돌림 가드.
vi.mock('../../src/data/shared', () => ({ refreshShared: () => {}, reread: () => {} }));
(globalThis as any).window = globalThis;
Object.assign(globalThis, { location: { href: 'http://127.0.0.1/', protocol: 'http:', hash: '', search: '', pathname: '/' }, addEventListener: () => {}, document: { hidden: false, addEventListener: () => {}, querySelectorAll: () => [] } });
import statusSrc from '../../src/app/status.tsx?raw';
import chipSrc from '../../src/app/chip.tsx?raw';
import mainSrc from '../../src/screens/Main.tsx?raw';
import mdriveSrc from '../../src/screens/MDrive.tsx?raw';
import mainSrcMain from '../../src/main.tsx?raw';
const { headChips } = await import('../../src/app/status');
const { focusBack } = await import('../../src/app/chip');
const F = await import('../../src/data/facts');

const ST = (o: any = {}) => ({ role: 'control', latch: false, sim_block: '', holder: null, sim_start: { ok: true, why: '', session: null }, ...o });
const H = (o: any = {}) => headChips({ provider: 'simulation_gate', linkOk: true, everMsg: true, authEnd: false, bad: null, st: ST(), viewOnly: false, linkTxt: '정상', roleTxt: '조종권 · 이 기기', latch: false, ...o });
const by = (cs: ReturnType<typeof H>, k: string) => cs.find((c) => c.k === k)!;
const t = (cs: ReturnType<typeof H>, k: string) => `${by(cs, k).tone}:${by(cs, k).text}`;

test('정상 연결: 시뮬 실행 · 연결됨 · 이 기기 조종 · 잠금 해제(순서 시뮬·연결·역할·잠금)', () => {
  const c = H();
  expect(c.map((x) => x.k)).toEqual(['sim', 'link', 'role', 'lock']);
  expect(c.map((x) => `${x.tone}:${x.text}`)).toEqual(['ok:시뮬 실행', 'ok:연결됨', 'ok:이 기기 조종', 'ok:잠금 해제']);
});

test('연결 미확인은 «꺼짐»이 아님: 처음 연결 중 · 끊김 · 로그인 끝남 · 형식 오류 · 상태 대기', () => {
  const a = H({ linkOk: false, everMsg: false, st: null });
  expect([t(a, 'sim'), t(a, 'link'), t(a, 'role'), t(a, 'lock')]).toEqual(['warn:시뮬 확인 안 됨', 'warn:연결 중', 'warn:역할 확인 안 됨', 'warn:잠금 확인 안 됨']);
  expect(t(H({ linkOk: false }), 'link')).toBe('bad:연결 끊김');
  expect(t(H({ linkOk: false }), 'sim')).toBe('warn:시뮬 확인 안 됨');   // 끊겨도 «시뮬 꺼짐» 아님
  expect(t(H({ linkOk: false, authEnd: true }), 'link')).toBe('bad:로그인 끝남');
  expect(t(H({ bad: 'x' }), 'link')).toBe('warn:상태 확인 안 됨');
  expect(t(H({ st: null }), 'link')).toBe('warn:상태 확인 안 됨');
  for (const c of [a, H({ linkOk: false }), H({ bad: 'x' })]) expect(c.every((x) => x.tone !== 'off')).toBe(true);
});

test('시뮬 칩: 꺼짐은 서버 세션 idle 일 때만 · 켜지는 중 · 끊김 · 리셋 · 정책 중립 · 기타 처리 중', () => {
  const blk = (b: string, session: any = null) => t(H({ st: ST({ sim_block: b, sim_start: { ok: true, why: '', session } }) }), 'sim');
  expect(blk('시뮬 상태 미수신', { result: 'idle' })).toBe('off:시뮬 꺼짐');
  expect(blk('시뮬 상태 끊김', { result: 'idle' })).toBe('off:시뮬 꺼짐');
  expect(blk('시뮬 상태 미수신', { result: 'starting' })).toBe('warn:시뮬 켜지는 중');
  expect(blk('시뮬 상태 미수신')).toBe('warn:시뮬 확인 안 됨');          // 세션 모름 = 미확인
  expect(blk('시뮬 상태 미수신', { result: 'running' })).toBe('warn:시뮬 확인 안 됨');
  expect(blk('시뮬 상태 끊김')).toBe('bad:시뮬 끊김');
  expect(blk('시뮬 리셋 중')).toBe('warn:시뮬 리셋 중');
  expect(blk('정책 미실행')).toBe('warn:제어 준비 안 됨');
  expect(by(H({ st: ST({ sim_block: '정책 미실행' }) }), 'sim').why).toContain('정책 미실행');   // 원문은 ? 안에
  expect(blk('무엇이든')).toBe('warn:시뮬 처리 중');
  expect(t(H({ st: ST({ sim_block: '' }), linkTxt: '정상' }), 'sim')).toBe('ok:시뮬 실행');
});

test('역할·잠금 칩: 보기 전용 · 다른 기기(누구인지 ? 안) · STOP 잠금', () => {
  expect(t(H({ viewOnly: true }), 'role')).toBe('off:보기 전용');
  expect(t(H({ st: ST({ role: 'view' }) }), 'role')).toBe('off:보기 전용');
  const o = H({ st: ST({ role: 'view_other', holder: 'phone' }), roleTxt: '다른 기기가 조종 중 · phone' });
  expect(t(o, 'role')).toBe('warn:다른 기기 조종 중'); expect(by(o, 'role').why).toContain('phone');
  expect(t(H({ latch: true }), 'lock')).toBe('bad:STOP 잠금');
  expect(by(H({ latch: true }), 'lock').why).toBe(F.LATCH_TXT({ linkOk: true, latch: true }));
});

test('실기 대상: 시뮬 값 0 — 연결 «실기 미연결» 하나만', () => {
  expect(H({ provider: 'go2_direct' }).map((x) => `${x.k}:${x.tone}:${x.text}`)).toEqual(['link:off:실기 미연결']);
});

test('초점 되돌림: 문서에 있고 보일 때만', () => {
  const mk = (isConnected: boolean, n: number) => { const e: any = { isConnected, getClientRects: () => ({ length: n }), focus: vi.fn() }; return e; };
  const ok = mk(true, 1), gone = mk(false, 1), hid = mk(true, 0);
  focusBack(ok); focusBack(gone); focusBack(hid); focusBack(null);
  expect(ok.focus).toHaveBeenCalledTimes(1); expect(gone.focus).not.toHaveBeenCalled(); expect(hid.focus).not.toHaveBeenCalled();
});

test('메뉴·팝오버는 기존 경로만 · 송신은 누름 때 · STOP 첫 누름 소비 0', () => {
  expect(chipSrc).toMatch(/const open = \(\) => \{\n\s+dropAll\(\);/);   // 열 때 입력 폐기
  expect(chipSrc).not.toMatch(/preventDefault|stopPropagation|sendOp|sendStop/);
  expect(statusSrc).not.toMatch(/sendStop|sendOp\('(take|resume|release)'\)|startDrive|setInterval|setTimeout|preventDefault|stopPropagation/);
  expect(statusSrc.match(/sendOp\(/g)!.length).toBe(1);
  expect(statusSrc).toMatch(/onClick=\{go\}/);
  expect(statusSrc).toMatch(/startSimAsk\(st\)/);                       // 시뮬 시작은 기존 확인창
  expect(statusSrc).toMatch(/onMapPage \?/);                            // 지도 화면에선 상자 중복 장착 0
});

test('배지 → 머리줄 · 폰 서랍 스위치 · 안전 문구 유지 · 링크 칩 대체', () => {
  expect(chipSrc).not.toMatch(/DevBadge|lv-devbadge/); expect(mainSrcMain).not.toMatch(/DevBadge/);
  expect(statusSrc).toMatch(/<DevMark \/>/);
  expect(mdriveSrc).toMatch(/<DevSwitch text \/>/); expect(mdriveSrc).toMatch(/simOff: <DevMark \/>/);
  expect(F.TRIAL).toBe('Gazebo · foothold-v2 시험 · 낙상·정지 지연 미검증');
  expect(mainSrc).toMatch(/<\/span>\{TRIAL_SAFE\}<span data-dev>/);     // 안전 부분은 data-dev 밖
  expect(mainSrc).not.toMatch(/chip\('링크'/); expect(mainSrc).toMatch(/head: <HeadChips \/>/);
});
