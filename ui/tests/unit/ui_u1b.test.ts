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
  // B1: 연결은 됐어도(linkOk) 유효한 현재 status 가 없으면 잠금도 미확인 — «해제» 확정 0, 도움말도 «꺼짐» 아님
  for (const o of [{ bad: '형식 x', st: null, linkTxt: '상태 미확인(형식 형식 x)' }, { st: null, linkTxt: '상태 수신 대기' }, { bad: 'role', linkTxt: '상태 미확인(형식 role)' }]) {
    const l = by(H(o), 'lock'); expect(`${l.tone}:${l.text}`).toBe('warn:잠금 확인 안 됨');
    expect(l.why).toContain('미확인'); expect(l.why).toContain(o.linkTxt); expect(l.why).not.toMatch(/꺼짐|해제/);
  }
  expect(by(H({ linkOk: false }), 'lock').why).toBe('잠금 상태 미확인(서버 연결 끊김)');
});

test('시뮬 칩(B2): 세션 조회값(idle·starting·running)으로 꺼짐·켜짐을 확정하지 않음 · 끊김 · 리셋 · 정책 중립 · 기타 처리 중', () => {
  const blk = (b: string, session: any = null) => t(H({ st: ST({ sim_block: b, sim_start: { ok: true, why: '', session } }) }), 'sim');
  expect(blk('시뮬 상태 미수신', { result: 'idle' })).toBe('warn:시뮬 확인 안 됨');   // 신선도·unit·요청 진행 근거 없음 → 꺼짐 확정 0
  expect(blk('시뮬 상태 끊김', { result: 'idle' })).toBe('bad:시뮬 끊김');
  expect(blk('시뮬 상태 미수신', { result: 'starting' })).toBe('warn:시뮬 확인 안 됨');
  for (const r of ['idle', 'starting', 'running', 'x']) for (const b of ['시뮬 상태 미수신', '시뮬 상태 끊김', '', '정책 미실행'])
    expect(by(H({ st: ST({ sim_block: b, sim_start: { ok: false, why: '', session: { result: r } } }) }), 'sim').tone).not.toBe('off');
  expect(by(H({ st: ST({ sim_block: '시뮬 상태 미수신', sim_start: { ok: false, why: 'w', session: { result: 'idle' } } }) }), 'sim').why).toContain('꺼짐 확정 아님');
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
  // U2: 제목 위 진단 줄은 전부 data-dev, 안전 부분(TRIAL_SAFE)은 SafeLine 의 ? 안(ui_u2 가 렌더 내용 검사)
  expect(mainSrc).toMatch(/siteNode: <span data-dev>/); expect(mainSrc).toMatch(/<SafeLine \/>/);
  expect(mainSrc).not.toMatch(/chip\('링크'/); expect(mainSrc).toMatch(/<HeadChips /);
});

// B3: 팝오버 자리 — 보이는 STOP(+8) 과 겹침 0 · 화면 안 · 최소 높이로 STOP·화면 끝을 넘지 않음 · 자리 없으면 null
const { placePop } = await import('../../src/app/chip');
const R = (left: number, top: number, w: number, h: number) => ({ left, top, right: left + w, bottom: top + h });
const hit = (p: { left: number; top: number; maxHeight: number }, w: number, h: number, s: ReturnType<typeof R>) => {
  const bot = p.top + Math.min(h, p.maxHeight); return p.left < s.right && p.left + w > s.left && p.top < s.bottom && bot > s.top;
};
const inside = (p: { left: number; top: number; maxHeight: number }, w: number, h: number, W: number, H: number) => p.left >= 0 && p.left + w <= W && p.top >= 0 && p.top + Math.min(h, p.maxHeight) <= H;
test('B3 반례: 아래 여유 72 · STOP 바로 아래 · 화면 바닥 근처 · 같은 줄 옆 STOP · 확대/전체화면 STOP', () => {
  const W = 390, w = 358;
  // 645 반례 1: 단추 아래 300, STOP top 380(여유 72) · 메뉴 높이 400 → STOP 침범 0
  const s1 = R(16, 380, 358, 64), p1 = placePop(R(16, 270, 60, 24), 400, w, W, 844, [s1])!;
  expect(hit(p1, w, 400, s1)).toBe(false); expect(inside(p1, w, 400, W, 844)).toBe(true);
  // 실화면 QA: 390 PcSettings — STOP 이 칩 줄 바로 아래(남은 칸 ≈1) · «잠금 ?» 높이 90
  const s2 = R(16, 170, 358, 52), p2 = placePop(R(300, 140, 24, 24), 90, w, W, 844, [s2])!;
  expect(hit(p2, w, 90, s2)).toBe(false); for (const [x, y] of [[195, 196], [20, 174], [370, 174], [20, 218], [370, 218]]) expect(p2.left < x && x < p2.left + w && p2.top < y && y < p2.top + Math.min(90, p2.maxHeight)).toBe(false);
  // 645 반례 2: STOP 없음, 높이 390 · 단추 bottom 370 → 화면 밖 0(위로)
  const p3 = placePop(R(16, 346, 60, 24), 200, w, W, 390, [])!; expect(inside(p3, w, 200, W, 390)).toBe(true); expect(p3.top + p3.maxHeight).toBeLessThanOrEqual(340);
  // PC: 같은 줄 오른쪽 STOP(위끝이 팝오버보다 위) — 겹침 0, 가로는 단추 쪽 유지
  const s4 = R(1256, 25, 168, 52), p4 = placePop(R(1000, 30, 60, 24), 300, 320, 1440, 900, [s4])!;
  expect(hit(p4, 320, 300, s4)).toBe(false); expect(Math.abs(p4.left - 1000)).toBeLessThan(120);
  // 확대·전체화면 STOP 여러 개 동시
  const ss = [R(0, 0, 390, 60), R(16, 780, 358, 56), R(300, 300, 80, 80)], p5 = placePop(R(16, 64, 60, 24), 500, w, W, 844, ss)!;
  for (const s of ss) expect(hit(p5, w, 500, s)).toBe(false);
  expect(inside(p5, w, 500, W, 844)).toBe(true);
});
test('B3 양성·부족 공간: 자리 있으면 단추 바로 아래 그대로 · 빈 띠 < 40 이면 펼치지 않음', () => {
  expect(placePop(R(100, 40, 60, 24), 200, 320, 1440, 900, [R(1256, 25, 168, 52)])).toEqual({ left: 100, top: 70, maxHeight: 830 - 8 });
  expect(placePop(R(16, 10, 60, 24), 200, 358, 390, 120, [R(0, 40, 390, 40)])).toBe(null);   // 위 32 · 아래 0(STOP 이 화면 대부분)
  const small = placePop(R(16, 10, 60, 24), 20, 358, 390, 120, [R(0, 70, 390, 50)])!;        // 짧은 내용은 좁은 띠에도 들어감
  expect(small.top).toBe(40); expect(small.top + 20).toBeLessThanOrEqual(62);
});
test('B3 소스: 모든 «비상 정지…» STOP · 전체화면 안 · 실제 높이 측정 · 120 하한 없음 · 스크롤·전체화면 바뀜 닫힘', () => {
  expect(chipSrc).toMatch(/\[aria-label\^="비상 정지"\]/); expect(chipSrc).toMatch(/fs\.contains\(e\)/);
  expect(chipSrc).toMatch(/getBoundingClientRect\(\)\.height/); expect(chipSrc).not.toMatch(/Math\.max\(120/);
  expect(chipSrc).toMatch(/'fullscreenchange', shut/); expect(chipSrc).toMatch(/'scroll', out, true/);
  expect(chipSrc).toMatch(/<InTop>/); expect(statusSrc).toMatch(/<InFs><div ref/);   // R ③: Help 는 InTop(활성 전체화면 요소 우선 → 없으면 body) — 전체화면 안 그리기는 그대로 포함
});
test('R1: 화면 밖·부분 밖 STOP 을 화면과 교차 — 외곽은 늘 [8, H-8] 안 · 내용이 커져도 안 스크롤', () => {
  const inV = (p: { top: number; maxHeight: number }, H: number) => p.top >= 8 && p.top + p.maxHeight <= H - 8;
  // 반례: W390 H390 · 단추 [16,40]-[40,64] · STOP 완전히 아래 밖 [0,500]-[390,552] · 내용 400 → 이전 bottom 470
  const p = placePop(R(16, 40, 24, 24), 400, 358, 390, 390, [R(0, 500, 390, 52)])!;
  expect(inV(p, 390)).toBe(true); expect(p).toEqual({ left: 16, top: 70, maxHeight: 312 });
  const cases: [ReturnType<typeof R>[], number][] = [
    [[R(0, -200, 390, 52)], 400],                    // 완전히 위 밖
    [[R(0, 360, 390, 60)], 400],                     // 부분 아래 밖
    [[R(0, -30, 390, 60)], 400],                     // 부분 위 밖
    [[R(0, -200, 390, 52), R(0, 500, 390, 52), R(0, 360, 390, 60), R(300, 150, 80, 80)], 400],   // 여러 STOP
  ];
  for (const [ss, h] of cases) for (const c of [100, h]) {   // 내용 100 → 400 증가
    const q = placePop(R(16, 40, 24, 24), c, 358, 390, 390, ss)!;
    expect(inV(q, 390)).toBe(true);
    for (const s of ss) { const t = { left: Math.max(0, s.left), top: Math.max(0, s.top), right: Math.min(390, s.right), bottom: Math.min(390, s.bottom) };
      if (t.right > t.left && t.bottom > t.top) expect(hit(q, 358, c, t)).toBe(false); }
  }
  // 양성 유지: 화면 안 STOP 회피 · 공간 < 40 거부
  const on = R(16, 100, 358, 52), q2 = placePop(R(16, 40, 24, 24), 400, 358, 390, 390, [on])!;
  expect(hit(q2, 358, 400, on)).toBe(false); expect(inV(q2, 390)).toBe(true);
  expect(placePop(R(16, 10, 60, 24), 200, 358, 390, 120, [R(0, 40, 390, 200)])).toBe(null);
});
test('R1: 화면 밖 STOP 이 «아래에 다 들어감»으로 속이지 않음 — 실제로 다 들어가는 위쪽을 고름', () => {
  // H390 · 단추 bottom 324 → 아래 실제 52 · 위 286. STOP 은 화면 밖 아래(700) — 띠를 화면 끝에서 자르지 않으면 아래가 «362 fit» 로 보임
  const q = placePop(R(16, 300, 24, 24), 200, 358, 390, 390, [R(0, 700, 390, 52)])!;
  expect(q.maxHeight).toBeGreaterThanOrEqual(200); expect(q.top + q.maxHeight).toBeLessThanOrEqual(294); expect(q.top).toBeGreaterThanOrEqual(8);
});
