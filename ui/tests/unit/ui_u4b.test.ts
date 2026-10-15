import { beforeEach, expect, test, vi } from 'vitest';
// U4-b PcRobot: 제목 «Go2 시뮬» · 값 없는 줄만 동적 접기(넘어짐·오래됨·잠금 상시) · 예시/추정 0 · 보기 수신 ≠ 실기 센서 · 정지 계층 v3 값 · «알려진 정지 특성» 운영 + ? 전문 · 진단 dev.
// 실제 PcRobot 을 react-dom/server 로 그림. 대체: useRoute·console.error(useLayoutEffect 경고)·useLink 서버 스냅샷(getInitialState 객체에 같은 상태)만.
vi.mock('../../src/app/shell', async (orig) => ({ ...(await orig<typeof import('../../src/app/shell')>()), useRoute: () => ({ name: 'PcRobot', q: new URLSearchParams(), setQ: () => {} }) }));
Object.assign(globalThis, { localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, location: { href: 'http://127.0.0.1/', protocol: 'http:', hash: '', search: '', pathname: '/' } });
vi.spyOn(console, 'error').mockImplementation(() => {});

const React = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { QueryClientProvider } = await import('@tanstack/react-query');
const { qc } = await import('../../src/data/shared');
const { useLink } = await import('../../src/data/link');
const F = await import('../../src/data/facts');
const PcRobot = (await import('../../src/screens/PcRobot')).default;

const put = (x: Record<string, unknown>) => { useLink.setState(x as any); Object.assign(useLink.getInitialState(), x); };
const html = () => renderToStaticMarkup(React.createElement(QueryClientProvider, { client: qc }, React.createElement(PcRobot))).replace(/&quot;/g, '"').replace(/&amp;/g, '&');
// 운영 글 = data-dev 요소·? 설명(role="note" 팝오버)·hidden 요소 제외(중첩 1단계 — 이 화면 dev 요소는 얕음)
const ops = (s: string) => s.replace(/<(section|button)[^>]*hidden=""[\s\S]*?<\/\1>/g, '')
  .replace(/<(\w+)[^>]*data-dev=""[^>]*>(?:(?!<\/?\1[\s>])[\s\S])*?(?:<\1[\s>][\s\S]*?<\/\1>(?:(?!<\/?\1[\s>])[\s\S])*?)*<\/\1>/g, '')
  .replace(/<span id="[^"]*" role="note" class="lv-pop"[\s\S]*?<\/span>(?=<\/span>)/g, '');
const SIM = { fallen: false, tilt_deg: 2.3, vx: 0.1, vy: 0, x: 1, y: 2, yaw: 0, body_still: false, camera: 'on' };
const ST = (x: Record<string, unknown> = {}) => ({ sim: SIM, state_age: 0.2, latch: true, applied: [0, 0, 0], ver: 'abc1234def', role: 'view', sim_block: '', cam_age: 9,
  views: { follow: { st: 'ok', why: '', seq: 3, age_s: 0.4 }, points: { st: 'off', why: '외부 끔', seq: null, age_s: null }, lidar: { st: 'stale', why: '3 s 전', seq: 2, age_s: 3 } }, ...x });
const fresh = (x: Record<string, unknown> = {}) => put({ provider: 'simulation_gate', open: true, lastMsg: performance.now(), st: ST(x), firstVer: 'abc1234def', bad: null, authEnd: false });
const row = (s: string, a: string) => s.match(new RegExp(`<span>${a.replace(/[()·.]/g, '\\$&')}</span><b[^>]*>([^<]*)</b>`))?.[1];
beforeEach(() => { qc.clear(); put({ provider: 'simulation_gate', open: false, lastMsg: 0, st: null, firstVer: null, bad: null }); });

test('머리줄: «Go2 시뮬» · 링크 알약 0(공통 칩) · 공용 STOP 글 + ? · 금지어(Gazebo·v2·실기 아님·미제공·원값) 운영 0 · 판 해시 dev', () => {
  fresh(); const s = html(), o = ops(s);
  expect(o).toContain('>Go2 시뮬<'); expect(o).not.toContain('● 링크'); expect(o).not.toContain('▲ 링크');
  expect(s).toContain('스페이스 · 입력 차단·잠금'); expect(s).toContain('aria-label="STOP 설명"'); expect(s).not.toContain('명령 0·잠금<');
  for (const w of ['Gazebo', 'v2', '(실기 아님)', '미제공', '원값', 'GT ']) expect(o).not.toContain(w);
  expect(o).not.toMatch(/\b(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b/); expect(s).toContain('abc1234def');   // 해시 = dev 에만
  expect(s).toMatch(/<button[^>]*data-dev=""[^>]*>상태 원값 내려받기 \(JSON\)/);
});

test('몸 상태: 값 있는 줄은 밖 · 값 없는 줄만 «값 없는 줄 n개» · 상태 오래됨이면 몸·넘어짐 상시(경고) + 나머지 접힘 · 값 오면 펼침', () => {
  fresh(); let o = ops(html());
  expect(row(o, '넘어짐')).toBe('아님'); expect(row(o, '기울기')).toBe('2.3°'); expect(o).toMatch(/<summary[^>]*>값 없는 줄 2개 ›<\/summary><div class="row"[^>]*><span class="m-off">○<\/span><span>보행 모드<\/span>/);
  fresh({ sim: { ...SIM, fallen: true } }); o = ops(html()); expect(o).toMatch(/m-warn">▲<\/span><span>넘어짐<\/span><b[^>]*>넘어짐</);
  // 상태 오래됨(state_age > 1) → 몸 «확인 안 됨 · …» 경고 · 넘어짐 «미확인» 상시 · 기울기·속도·위치는 접힘(꺼짐 단정 0 — 경고 톤)
  fresh({ state_age: 5 }); o = ops(html());
  expect(row(o, '몸')).toMatch(/^확인 안 됨 · /); expect(row(o, '넘어짐')).toBe('미확인'); expect(o).toContain('값 없는 줄 5개 ›');
  expect(o).toMatch(/m-warn">▲<\/span><span>기울기<\/span><b[^>]*>받은 값 없음</);
  // 링크 없음
  put({ open: false, lastMsg: 0, st: null }); o = ops(html()); expect(row(o, '넘어짐')).toBe('미확인'); expect(row(o, '앱 STOP → 서버')).toBe('잠금 확인 안 됨');
});

test('배터리 «값 없음» 회색 한 줄 + ? · 예시 0 · 장비 «등록된 장비 없음» + 등록 회색(aria-disabled, 이유) · 예시 장비 줄 0 · 자세 카드 숨김', () => {
  fresh(); const s = html(), o = ops(s);
  expect(o).toContain('배터리 값 없음'); expect(s).toContain('aria-label="배터리 · 설명"'); expect(s).toContain(F.WHY['배터리']);
  for (const x of ['>68<', '복귀 여유', '[V]', '가스 검지기', '스피커', '● 정상', '운영자 A']) expect(o).not.toContain(x);
  expect(o).toContain('등록된 장비 없음'); expect(o).toMatch(/<button class="btn lv-why"[^>]*aria-disabled="true"[^>]*title="장비 등록 미연결[^"]*"[^>]*>등록<\/button>/);
  expect(s).toMatch(/<section class="card" aria-label="자세 명령" hidden=""/); expect(o).not.toContain('일어서기');
});

test('센서/보기: 받은 보기 실제 상태(시뮬이 보냄·오래됨·꺼짐) · «RGB만»·«센서 없음» 단정 0 · 실기 센서는 접힘 · 링크 없으면 보기 «확인 안 됨»', () => {
  fresh(); let o = ops(html());
  expect(row(o, '외부 3인칭 영상')).toBe('시뮬이 보냄 · 0.4 s 전'); expect(row(o, '라이다(센서 기준)')).toBe('오래됨 · 3 s 전'); expect(row(o, '지도 누적 점군')).toBe('꺼짐 · 외부 끔');
  expect(o).toContain('실기 센서 연결·건강 판정 아님'); expect(o).not.toMatch(/RGB 압축 영상만|RGB만|연결된 센서 없음/);
  expect(o).toMatch(/값 없는 줄 4개 ›<\/summary>[\s\S]*실기 L1 라이다/);
  fresh({ views: undefined }); o = ops(html()); expect(row(o, '외부 3인칭 영상')).toBeUndefined();   // 이전 서버(보기 없음) = 줄 없음(지어낸 값 0)
  put({ open: false, lastMsg: 0, st: null }); o = ops(html()); expect(row(o, '라이다(센서 기준)')).toBe('확인 안 됨');
});

test('정지 계층 v3 값 · «알려진 정지 특성» 운영 경고(facts 정본) + ? 전문 · 보낸 명령 수치 dev', () => {
  fresh(); const s = html(), o = ops(s);
  expect(row(o, '앱 STOP → 서버')).toBe('잠금 켜짐'); expect(row(o, '서버 deadman 0.3 s (입력 만료)')).toBe('켜짐');
  expect(row(o, '화면 신호 1.0 s 끊김 → 입력 차단·잠금')).toBe('켜짐'); expect(row(o, '정지 시험 자동 실행')).toBe('없음');
  expect(o).toMatch(/m-warn">▲<\/span><span>로봇 쪽 명령 끊김 감시<\/span><b[^>]*>실기 미검증</); expect(row(o, '리모컨 비상 정지')).toBe('시뮬 없음');
  expect(row(o, '보낸 명령')).toBeUndefined(); expect(s).toMatch(/data-dev=""[^>]*><span class="m-ok">●<\/span><span>보낸 명령<\/span>/);
  fresh({ latch: false }); expect(row(ops(html()), '앱 STOP → 서버')).toBe('잠금 꺼짐');
  expect(F.STOP_OBS).toBe('한 시뮬 관측에서 STOP 뒤 약 3.6초 동안 약 0.32 m 추가 이동(원인 미확인)'); expect(F.RELURCH_OBS).toBe('정지 뒤 다시 움직임 관측(시뮬 · 원인 미확인)');
  expect(o).toMatch(/role="note" aria-label="알려진 정지 특성"[\s\S]*▲ 알려진 정지 특성[\s\S]*한 시뮬 관측에서 STOP 뒤 약 3\.6초[\s\S]*정지 뒤 다시 움직임 관측/);
  expect(s).toContain('aria-label="알려진 정지 특성 · 설명"'); for (const t of [F.SAFE_NOTE, F.STOP_FACT[1], F.RELURCH]) expect(s).toContain(t);   // 전문 = ? 안
  put({ open: false, lastMsg: 0, st: null }); expect(ops(html())).toContain('한 시뮬 관측에서 STOP 뒤');   // 연결 없어도 상시
});
