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
  .replace(/<span id="[^"]*" role="note" class="lv-pop"[\s\S]*?<\/span>(?=<\/span>)/g, '')
  // FIX2b(ROOT 결정 4): 숨긴 «상태 상세» = ? 전문처럼 운영 글 검사에서만 제외(hidden+region+이름 정확히 · 보이는 region·원문 DOM 그대로)
  .replace(/<span id="[^"]*" role="region" aria-label="상태 상세" class="lv-pop" hidden=""[^>]*>(?:<span[^>]*><b>[^<]*<\/b>[^<]*<\/span>)*<\/span>/g, '');
const SIM = { fallen: false, tilt_deg: 2.3, vx: 0.1, vy: 0, x: 1, y: 2, yaw: 0, body_still: false, camera: 'on' };
const ST = (x: Record<string, unknown> = {}) => ({ sim: SIM, state_age: 0.2, latch: true, applied: [0, 0, 0], ver: 'abc1234def', role: 'view', sim_block: '', cam_age: 9,
  views: { follow: { st: 'ok', why: '', seq: 3, age_s: 0.4 }, points: { st: 'off', why: '외부 끔', seq: null, age_s: null }, lidar: { st: 'stale', why: '3 s 전', seq: 2, age_s: 3 } }, ...x });
const fresh = (x: Record<string, unknown> = {}) => put({ provider: 'simulation_gate', open: true, lastMsg: performance.now(), st: ST(x), firstVer: 'abc1234def', bad: null, authEnd: false, gen: 1, stGen: 1 });   // 이 연결에서 받은 유효 status
const row = (s: string, a: string) => s.match(new RegExp(`<span>${a.replace(/[()·.]/g, '\\$&')}</span><b[^>]*>([^<]*)</b>`))?.[1];
beforeEach(() => { qc.clear(); put({ provider: 'simulation_gate', open: false, lastMsg: 0, st: null, firstVer: null, bad: null }); });

test('머리줄: «Go2 시뮬» · 링크 알약 0(공통 칩) · 공용 STOP 글 + ? · 금지어(Gazebo·v2·실기 아님·미제공·원값) 운영 0 · 판 해시 dev', () => {
  fresh(); const s = html(), o = ops(s);
  expect(o).toContain('>Go2 시뮬<'); expect(o).not.toContain('● 링크'); expect(o).not.toContain('▲ 링크');
  expect(s).not.toContain('aria-label="비상 정지"'); expect(s).not.toContain('스페이스 · 입력 차단·잠금'); expect(s).toContain('aria-label="STOP 설명"'); expect(s).not.toContain('명령 0·잠금<');   // FIX2b(ROOT 결정 1): G1 = 화면별 STOP 삭제 → 이 화면 STOP 0 · 공용 STOP 존재·title(STOP_TIP)·송신은 ui_g1_stop(실제 App)
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
  // G4(ROOT 10-19 · UX-SPEC 2-4): 관문 미확인 = 종속 줄 회색 «대기(관문 먼저)»(옛 기대 «미확인»·«잠금 확인 안 됨» warn 대체 — 이유 UX-IMPL/G4-NOTE.md)
  put({ open: false, lastMsg: 0, st: null }); o = ops(html()); expect(row(o, '넘어짐')).toBe('미확인 · 대기(관문 먼저)'); expect(row(o, '앱 STOP → 서버')).toBe('잠금 미확인 · 대기(관문 먼저)');
});

test('배터리 «값 없음» 회색 한 줄 + ? · 예시 0 · 장비 «등록된 장비 없음» + 등록 회색(aria-disabled, 이유) · 예시 장비 줄 0 · 자세 카드 숨김', () => {
  fresh(); const s = html(), o = ops(s);
  expect(o).toContain('배터리 값 없음'); expect(s).toContain('aria-label="배터리 · 설명"'); expect(s).toContain(F.WHY['배터리']);
  for (const x of ['>68<', '복귀 여유', '[V]', '가스 검지기', '스피커', '● 정상', '운영자 A']) expect(o).not.toContain(x);
  expect(o).toContain('등록된 장비 없음'); expect(o).toMatch(/<button class="btn lv-why"[^>]*aria-disabled="true"[^>]*title="장비 등록 미연결[^"]*"[^>]*>등록<\/button>/);
  expect(s).toMatch(/<section class="card" aria-label="자세 명령" hidden=""/); expect(o).not.toContain('일어서기');
});

test('센서/보기: 받은 보기 실제 상태(시뮬이 보냄·오래됨·받은 것 없음) · «RGB만»·«센서 없음» 단정 0 · 실기 센서는 접힘 · 링크 없으면 보기 «확인 안 됨»', () => {
  fresh(); let o = ops(html());
  expect(row(o, '외부 3인칭 영상')).toBe('시뮬이 보냄 · 0.4 s 전'); expect(row(o, '라이다(센서 기준)')).toBe('오래됨 · 3 s 전'); expect(row(o, '지도 누적 점군')).toBe('받은 것 없음 · 외부 끔');   // B2: off = 미수신(꺼짐 단정 0)
  expect(o).toContain('실기 센서 연결·건강 판정 아님'); expect(o).not.toMatch(/RGB 압축 영상만|RGB만|연결된 센서 없음/);
  expect(o).toMatch(/값 없는 줄 4개 ›<\/summary>[\s\S]*실기 L1 라이다/);
  fresh({ views: undefined }); o = ops(html()); expect(row(o, '외부 3인칭 영상')).toBeUndefined();   // 이전 서버(보기 없음) = 줄 없음(지어낸 값 0)
  put({ open: false, lastMsg: 0, st: null }); o = ops(html()); expect(row(o, '라이다(센서 기준)')).toBe('미확인 · 대기(관문 먼저)'); expect(tone(o, '라이다(센서 기준)')).toBe('off');   // G4: 옛 «확인 안 됨»(warn) 대체
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

// ── 보완(715 B1·B2·B3) 반례 ──
const tone = (o: string, a: string) => o.match(new RegExp(`<span class="m-(\\w+)">[^<]*</span><span>${a.replace(/[()·.]/g, '\\$&')}</span>`))?.[1];
const unf = (o: string) => o.replace(/<details data-none="">[\s\S]*?<\/details>/g, '');   // 펼친(밖) 줄만
const folded = (o: string) => o.match(/<details data-none=""><summary[^>]*>[^<]*<\/summary>([\s\S]*?)<\/details>/)?.[1] ?? '';

test('B1: 유효 status 가 현재 연결에 없으면(형식 오류·st 없음·이전 연결 세대) 잠금·보기 «확인 안 됨»(warn) — 머리줄과 같은 뜻 · 돌아오면 확정', () => {
  // 열린 소켓·신선 lastMsg 인데 형식 오류(checkStatus 실패 경로: st=null·bad)
  put({ provider: 'simulation_gate', open: true, lastMsg: performance.now(), st: null, bad: '형식', gen: 1, stGen: 1, firstVer: 'abc1234def', authEnd: false });
  let s = html(), o = ops(s);
  // G4: 종속 잠금 줄 = 회색 대기(옛 warn «잠금 확인 안 됨» 대체) · 원인 ▲ 는 «연결 · 상태 나이» 하나
  expect(row(o, '앱 STOP → 서버')).toBe('잠금 미확인 · 대기(관문 먼저)'); expect(tone(o, '앱 STOP → 서버')).toBe('off'); expect(o).not.toContain('잠금 꺼짐');
  expect(s).toContain('잠금 미확인'); expect(tone(o, '연결 · 상태 나이')).toBe('warn');
  // st 는 남았는데 bad(이전 st 유지 경로 가정) → 확정 0
  fresh(); put({ bad: '형식' }); o = ops(html()); expect(row(o, '앱 STOP → 서버')).toBe('잠금 미확인 · 대기(관문 먼저)'); expect(row(o, '외부 3인칭 영상')).toBe('미확인 · 대기(관문 먼저)');
  // 재연결: 새 연결(gen 2)에서 아직 status 못 받음 — 이전 연결 st(stGen 1)로 확정 0
  fresh({ latch: false }); put({ gen: 2, stGen: 1 }); o = ops(html()); expect(row(o, '앱 STOP → 서버')).toBe('잠금 미확인 · 대기(관문 먼저)'); expect(row(o, '라이다(센서 기준)')).toBe('미확인 · 대기(관문 먼저)');   // FIX2c(ROOT 결정 B · G3 CURRENT): 이 연결의 유효 status 없음 = 관문 칩 «관문 상태 확인 안 됨»(옛 세대 st 로 정상 승격 0) → «관문 먼저»
  // 대상 전환 직후(st 없음·bad 없음)
  fresh(); put({ st: null }); o = ops(html()); expect(row(o, '앱 STOP → 서버')).toBe('잠금 미확인 · 대기(관문 먼저)');
  // 복원: 이 연결에서 유효 status → 확정
  fresh({ latch: false }); put({ gen: 2, stGen: 2 }); o = ops(html()); expect(row(o, '앱 STOP → 서버')).toBe('잠금 꺼짐'); expect(tone(o, '앱 STOP → 서버')).toBe('ok');
});

test('B2: 보기 off = 미수신 «받은 것 없음»(warn) · 꺼짐 확정 0(명시 false 는 B2-R 시험) · why 중복 0 · 키 전환 대기도 받은 것 없음', () => {
  const off = (why: string, prod: unknown = null) => ({ st: 'off', why, seq: null, age_s: null, prod });
  fresh({ views: { follow: off('받은 것 없음', { reason: null, n_pub: 0, enabled: true }), points: off('받은 것 없음'), lidar: off('') } });
  let o = ops(html());
  expect(row(o, '외부 3인칭 영상')).toBe('받은 것 없음'); expect(row(o, '지도 누적 점군')).toBe('받은 것 없음'); expect(row(o, '라이다(센서 기준)')).toBe('받은 것 없음');
  for (const n of ['외부 3인칭 영상', '지도 누적 점군', '라이다(센서 기준)']) expect(tone(o, n)).toBe('warn');
  expect(o).not.toMatch(/>꺼짐/);
  fresh({ views: { follow: off('받은 것 없음', { reason: null, n_pub: 0, enabled: null }), points: off('키 바뀜 — 새 자료 기다림'), lidar: null } });   // enabled 모름·전환 대기
  o = ops(html()); expect(row(o, '외부 3인칭 영상')).toBe('받은 것 없음'); expect(row(o, '지도 누적 점군')).toBe('받은 것 없음 · 키 바뀜 — 새 자료 기다림');
});

test('B2-R: prod.enabled=false 는 run/epoch 결속 없는 최근 발행 진단 — «꺼짐» 확정 0 · 받은 것 없음 + 최근 진단 + 지금 실행 미확인(warn) · reset/hold·전환·지연 prod 반례', () => {
  const DG = '최근 발행 진단: 외부카메라 끔(지금 실행인지 미확인)', F0 = { reason: null, n_pub: 0, enabled: false };
  const off = (why: string, prod: unknown = null, run: unknown = null) => ({ st: 'off', why, seq: null, age_s: null, prod, run });
  const RUN = { run_id: 'a'.repeat(32), epoch: 2, world_id: 'w', building_id: 'b', mode: 'slam' };
  const cases: [string, Record<string, unknown>, string][] = [
    ['명시 false · run 없음', { views: { follow: off('받은 것 없음', F0), points: off('받은 것 없음') } }, `받은 것 없음 · ${DG}`],
    ['reset/hold · run null · 이전 실행 진단 잔존', { reset_pending: true, views: { follow: off('받은 것 없음', F0, null), points: off('받은 것 없음') } }, `받은 것 없음 · ${DG}`],
    ['전환 · 새 run 결속 + 지난 prod', { views: { follow: off('키 바뀜 — 새 자료 기다림', { reason: 'no_frame', n_pub: 12, enabled: false }, RUN), points: off('받은 것 없음') } }, `받은 것 없음 · 키 바뀜 — 새 자료 기다림 · ${DG}`],
  ];
  for (const [, x, want] of cases) {
    fresh(x); const o = ops(html());
    expect(row(o, '외부 3인칭 영상')).toBe(want); expect(tone(o, '외부 3인칭 영상')).toBe('warn'); expect(o).not.toMatch(/>꺼짐/); expect(o).not.toContain('이번 지도 시뮬에서 외부카메라 끔');
  }
  // 지연 prod: 지금 영상이 오는데(ok) 지난 진단 false — 진단 덧붙임 0, 받은 상태 그대로
  fresh({ views: { follow: { st: 'ok', why: '', seq: 4, age_s: 0.3, prod: F0, run: RUN }, points: off('받은 것 없음') } });
  let o = ops(html()); expect(row(o, '외부 3인칭 영상')).toBe('시뮬이 보냄 · 0.3 s 전'); expect(tone(o, '외부 3인칭 영상')).toBe('ok');
  // points·lidar 는 enabled 를 봐도 진단 덧붙임 0(follow 만)
  fresh({ views: { follow: off('받은 것 없음'), points: off('받은 것 없음', F0), lidar: off('', F0) } });
  o = ops(html()); expect(row(o, '지도 누적 점군')).toBe('받은 것 없음'); expect(row(o, '라이다(센서 기준)')).toBe('받은 것 없음');
});

test('B3: 측정값은 필드별 — null 만 접힘(warn) · 0 은 유효 · 일부만 받으면 받은 부분 보존 + 미확인(warn) · 값 오면 복원 · 미확인 글 정상 톤 0', () => {
  fresh({ sim: { ...SIM, tilt_deg: null } }); let o = ops(html());
  expect(row(unf(o), '기울기')).toBeUndefined(); expect(folded(o)).toMatch(/m-warn">▲<\/span><span>기울기<\/span><b[^>]*>받은 값 없음</); expect(o).toContain('값 없는 줄 3개 ›');
  fresh({ sim: { ...SIM, tilt_deg: 0, vx: 0, vy: 0, x: 0, y: 0, yaw: 0 } }); o = ops(html());   // 0 = 유효
  expect(row(o, '기울기')).toBe('0.0°'); expect(tone(o, '기울기')).toBe('ok'); expect(row(o, '속도(앞 · 옆)')).toBe('0.00 · 0.00 m/s'); expect(tone(o, '위치 · 방향')).toBe('ok'); expect(o).toContain('값 없는 줄 2개 ›');
  fresh({ sim: { ...SIM, vy: null, yaw: null } }); o = ops(html());   // 혼합: 받은 부분 보존
  expect(row(o, '속도(앞 · 옆)')).toBe('0.10 · 미확인 m/s'); expect(tone(o, '속도(앞 · 옆)')).toBe('warn'); expect(row(o, '위치 · 방향')).toBe('x +1.00 · y +2.00 m · 미확인'); expect(tone(o, '위치 · 방향')).toBe('warn');
  // B3-R: 위치 축별 — x 만/y 만/0 만 받아도 받은 축 보존, 빠진 축만 미확인(warn)
  fresh({ sim: { ...SIM, y: null } }); o = ops(html()); expect(row(o, '위치 · 방향')).toBe('x +1.00 m · y 미확인 · 0°'); expect(tone(o, '위치 · 방향')).toBe('warn');
  fresh({ sim: { ...SIM, x: null, yaw: null } }); o = ops(html()); expect(row(o, '위치 · 방향')).toBe('x 미확인 · y +2.00 m · 미확인'); expect(tone(o, '위치 · 방향')).toBe('warn');
  fresh({ sim: { ...SIM, x: 0, y: null, yaw: null } }); o = ops(html()); expect(row(o, '위치 · 방향')).toBe('x +0.00 m · y 미확인 · 미확인');
  fresh({ sim: { ...SIM, x: null, y: null, yaw: null, vx: null, vy: null } }); o = ops(html());
  expect(row(unf(o), '위치 · 방향')).toBeUndefined(); expect(row(unf(o), '속도(앞 · 옆)')).toBeUndefined(); expect(o).toContain('값 없는 줄 4개 ›');
  fresh(); o = ops(html()); expect(row(o, '위치 · 방향')).toBe('x +1.00 · y +2.00 m · 0°'); expect(o).toContain('값 없는 줄 2개 ›');   // 복원
  fresh({ sim: { ...SIM, fallen: null } }); o = ops(html()); expect(row(o, '몸')).toBe('넘어짐 미확인'); expect(tone(o, '몸')).toBe('warn'); expect(row(o, '넘어짐')).toBe('미확인');
  fresh({ sim: { ...SIM, vx: null } }); o = ops(html()); expect(row(o, '몸')).toBe('실측 속도 미확인'); expect(tone(o, '몸')).toBe('warn');
});

test('670 P2(8373ea3): 행 국소 배치 style — 이름 칸 최소 읽기 폭·값 칸 단어 줄바꿈 · 모든 PcRobot 행 동일 · 긴 진단 값 생략·잘림 0(실 배치 geometry 는 670)', () => {
  const G = 'grid-template-columns:18px minmax(min(7.5em, 45%), 1fr) minmax(0, max-content);word-break:keep-all;overflow-wrap:anywhere';
  fresh({ views: { follow: { st: 'off', why: '키 바뀜 — 새 자료 기다림', seq: null, age_s: null, prod: { reason: null, n_pub: 0, enabled: false } }, points: { st: 'off', why: '', seq: null, age_s: null } } });
  const s = html();
  expect(s).toContain(`<div class="row" style="${G}"><span class="m-warn">▲</span><span>외부 3인칭 영상</span><b style="color:var(--warn)">받은 것 없음 · 키 바뀜 — 새 자료 기다림 · 최근 발행 진단: 외부카메라 끔(지금 실행인지 미확인)</b>`);
  const all = s.match(/<div class="row"[^>]*>/g) ?? [];
  expect(all.length).toBeGreaterThan(10); for (const r of all) expect(r).toContain(`style="${G}`);   // 이 화면 행은 전부 같은 국소 배치(첫 행만 border-top:0 추가)
  expect(s).toContain(`style="${G};border-top:0"`);
  expect(s).toContain('.row{display:grid;grid-template-columns:18px 1fr auto;');   // 공용 CSS .row 규칙 무변경
});

// ── G4(ROOT 10-19 · UX-SPEC 2-4 · ROOT3): 상위 원인 하나 — 유효 status 없으면 본문 종속 줄은 회색 대기 · ▲ 는 원인 줄과 정적 사실만 · 받은 넘어짐·받은 영상·정지 특성은 그대로
const warns = (o: string) => [...o.matchAll(/<span class="m-warn">▲<\/span><span>([^<]*)<\/span>/g)].map((m) => m[1]);
test('G4 Robot 본문: 관문 미확인·이전 연결 세대 = ▲ 는 «연결 · 상태 나이»(원인)·«로봇 쪽 명령 끊김 감시»(정적)만 · 정상 톤 0 · 정지 특성 유지', () => {
  for (const set of [() => put({ open: false, lastMsg: 0, st: null }), () => { fresh(); put({ bad: '형식' }); }, () => { fresh({ latch: false }); put({ gen: 2, stGen: 1 }); }]) {
    set(); const o = ops(html());
    expect(warns(o)).toEqual(['연결 · 상태 나이', '로봇 쪽 명령 끊김 감시']);
    for (const a of ['몸', '넘어짐', '앱 STOP → 서버', '외부 3인칭 영상']) expect([a, tone(o, a)]).not.toEqual([a, 'ok']);
    expect(o).not.toContain('잠금 꺼짐'); expect(o).toContain('한 시뮬 관측에서 STOP 뒤'); expect(o).toMatch(/▲ 알려진 정지 특성/);
  }
});
test('G4 Robot 본문: 받은 넘어짐(true)은 status 세대가 낡아도 ▲ 그대로 · 유효 status 면 기존 줄(잠금 켜짐·넘어짐 아님·보기 실제 상태) 그대로', () => {
  fresh({ sim: { ...SIM, fallen: true } }); put({ gen: 2, stGen: 1 }); let o = ops(html());
  expect(row(o, '넘어짐')).toBe('넘어짐'); expect(tone(o, '넘어짐')).toBe('warn');
  fresh(); o = ops(html());
  expect(row(o, '앱 STOP → 서버')).toBe('잠금 켜짐'); expect(tone(o, '앱 STOP → 서버')).toBe('warn'); expect(row(o, '넘어짐')).toBe('아님'); expect(tone(o, '넘어짐')).toBe('ok');
  expect(row(o, '라이다(센서 기준)')).toBe('오래됨 · 3 s 전'); expect(tone(o, '라이다(센서 기준)')).toBe('warn');
});

// G3 CURRENT(715 13d12525 P2 · ROOT3): 머리줄 칩·«상태 ▾» 도 PcRobot 과 같은 known(stGen === gen) — 신선 lastMsg + 옛 세대 st 합성 입력 = 회색 대기 · 현재 잠금/다른 기기 단정 0.
// 정상 세대면 sim_block 미수신/리셋이어도 다른 기기·STOP 잠금 밖 유지(기존 G3 반례 · 순수판은 ui_g3_chips ③). 한계: 합성 세대 주입 = 실제 재연결 노출 증명 아님.
test('G3 CURRENT: 옛 세대 status(신선 lastMsg) = 조작 · 대기 + 역할/잠금 확인 안 됨 · 옛 다른 기기/잠금 글 0 · 정상 세대 + 미수신/리셋 = 다른 기기 · STOP 잠금 유지', () => {
  const head = (s: string) => s.slice(s.indexOf('data-head="gate"'), s.indexOf('상태 ▾'));
  fresh({ role: 'view_other', latch: true }); put({ gen: 2, stGen: 1 });
  const raw = html(); let o = ops(raw);
  expect(head(o)).toContain('조작 · 대기'); expect(head(o)).not.toContain('STOP 잠금');
  expect(o).not.toContain('다른 기기');   // 운영 글(칩·본문) — 옛 roleTxt 0
  const det = raw.match(/role="region" aria-label="상태 상세"[\s\S]*?<\/span><\/span>/)?.[0] ?? '';   // 숨긴 상세 원문(ops 는 운영 글 검사용으로 이것을 뺌 · DOM 은 그대로)
  expect(det).not.toContain('다른 기기');
  expect(det).toContain('<b>역할 · 역할 확인 안 됨</b> — 역할 미확인(이 연결에서 받은 상태 없음)'); expect(det).toContain('<b>잠금 · 잠금 확인 안 됨</b>');
  // FIX2c(ROOT 결정 B): 머리줄 칩 3개 명시 — ① 관문 warn «관문 상태 확인 안 됨» · ② 대상 off «시뮬 · 대기(관문 먼저)» · ③ 조작 off «조작 · 대기»
  const chip = (s: string, k: string) => s.match(new RegExp(`data-head="${k}"[^>]*><span class="lv-chip [^"]*" data-tone="([^"]*)"><span aria-hidden="true">[^<]*</span><span>([^<]*)</span>`))?.slice(1, 3);
  expect(chip(o, 'gate')).toEqual(['warn', '관문 상태 확인 안 됨']); expect(chip(o, 'target')).toEqual(['off', '시뮬 · 대기(관문 먼저)']); expect(chip(o, 'op')).toEqual(['off', '조작 · 대기']);
  for (const b of ['시뮬 상태 미수신', '시뮬 리셋 중']) {
    fresh({ role: 'view_other', latch: true, sim_block: b }); o = ops(html());
    expect([b, head(o).includes('다른 기기 조종 중 · STOP 잠금')]).toEqual([b, true]);
  }
});
