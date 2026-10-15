import { beforeEach, expect, test, vi } from 'vitest';
// U5-b PcSettings(v3 §2-4·§2-5·§4): 지원 범위 = UNSUP 표 그대로(원어 포함 · 금지어 검사 제외 구역), TERMS·판 해시 = 개발자 모드,
// 안전 정책 = 쉬운 말 + ? 전문(STOP_FACT·SAFE_NOTE·STOP_OBS·RELURCH·NOMOVE·WHY), 공용 STOP 글·?, 기존 개발자 스위치 재사용.
// 실제 PcSettings 를 react-dom/server 로 그림. 보호 관문(https)으로 연 화면이라 로그아웃 단추까지 그려진다.
vi.mock('../../src/app/shell', async (orig) => ({ ...(await orig<typeof import('../../src/app/shell')>()), useRoute: () => ({ name: 'PcSettings', q: new URLSearchParams(), setQ: () => {} }) }));
Object.assign(globalThis, { localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, location: { href: 'https://h/', protocol: 'https:', host: 'h:8453', hostname: 'h', hash: '', search: '', pathname: '/' } });
vi.spyOn(console, 'error').mockImplementation(() => {});

const React = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { QueryClientProvider } = await import('@tanstack/react-query');
const { qc } = await import('../../src/data/shared');
const { useLink } = await import('../../src/data/link');
const F = await import('../../src/data/facts');
const PcSettings = (await import('../../src/screens/PcSettings')).default;
const PcPlan = (await import('../../src/screens/PcPlan')).default;

const V1 = 'cd7e7c5a0b1c2d3e', V2 = 'd866c6e9f8e7d6c5';
const put = (x: Record<string, unknown>) => { useLink.setState(x as any); Object.assign(useLink.getInitialState(), x); };
const link = (firstVer: string, ver?: string) => put({ provider: 'simulation_gate', open: true, lastMsg: performance.now(), bad: null, gen: 1, stGen: 1, firstVer,
  st: { applied: [0, 0, 0], latch: true, role: 'view', ...(ver ? { ver } : {}) } });
const draw = (C: React.ComponentType) => renderToStaticMarkup(React.createElement(QueryClientProvider, { client: qc }, React.createElement(C))).replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const html = () => draw(PcSettings);
// 운영 글 = 화면 전체 − <style> − ? 팝오버 본문 − 공용 STOP 단추 title − 지원 범위 구역(§2-4 원어 포함) − 개발자 모드(data-dev) 요소
const ops = (s: string) => s.replace(/<style>[\s\S]*?<\/style>/g, '')
  .replace(/(<button aria-label="비상 정지") title="[^"]*"/, '$1')
  .replace(/<span id="[^"]*" role="note" class="lv-pop"[\s\S]*?<\/span>(?=<\/span>)/g, '')
  .replace(/<section id="limits"[\s\S]*?<\/section>/, '')
  .replace(/<span data-dev="true"><span[^>]*>[^<]*<\/span><\/span>/g, '');
const text = (s: string) => s.replace(/<[^>]+>/g, ' ');
const pops = (s: string) => [...s.matchAll(/<span id="[^"]*" role="note" class="lv-pop"[^>]*>([\s\S]*?)<\/span>(?=<\/span>)/g)].map((m) => text(m[1]).replace(/\s+/g, ' ').trim());
beforeEach(() => { qc.clear(); link(V1, V1); });

test('운영 글 금지어 0(지원 범위·? 팝오버·data-dev 제외) · 판 해시는 data-dev 안에만', () => {
  const s = html(), o = ops(s);
  for (const w of ['GT ', 'GT)', 'Gazebo', 'rad/s', 'm/s', '미제공', '원값', '명령 0', V1]) expect(o).not.toContain(w);
  expect(o).not.toMatch(/\bv2\b/);
  expect(text(o)).not.toMatch(/\b(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b/);
  expect(s).toContain(`<span data-dev="true"><span class="mono">${' · '}화면 ${V1} · 서버 ${V1}</span></span>`);
});

test('공용 STOP 글 + ? · 개발자 스위치 = 공용 DevSwitch 1개(중복 0)', () => {
  const s = html();
  expect(s).toContain('스페이스 · 입력 차단·잠금'); expect(s).not.toContain('스페이스 · 명령 0·잠금');
  expect(s).toContain('aria-label="STOP 설명"'); expect(pops(s)).toContain(F.STOP_TIP);
  expect(s.match(/role="switch"/g)).toHaveLength(1);
  expect(s).toContain('<button type="button" class="sw" role="switch" aria-checked="false" aria-label="개발자 모드"><span></span></button>');
});

test('안전 정책: 쉬운 말 + ? 전문(통신 끊김 = PcPlan 과 같은 글 · NOMOVE · 배터리 · 가스) · 관측 조건·실기 미검증 접근 가능', () => {
  const s = html(), o = ops(s), p = pops(s);
  expect(o).toContain('조종 입력 0.3초 끊김 → 입력 차단 · 화면 신호 1초 끊김 → 입력 차단·잠금');
  expect(o).toContain('입력 차단 (몸 정지는 별도) · 자동 후퇴 미연결'); expect(o).toContain('지금 서버의 고정값입니다');
  const lost = p.find((t) => t.startsWith(F.SAFE_NOTE))!;
  for (const t of [F.STOP_OBS, `${F.STOP_FACT[0]} → ${F.STOP_FACT[1]}`, `${F.STOP_FACT[2]} → ${F.STOP_FACT[3]}`, `주의: ${F.RELURCH}`]) expect(lost).toContain(t);
  // 전문·순서 보존(U5-a PcPlan 인라인과 같은 순서): SAFE_NOTE → STOP_OBS → STOP_FACT 0→1 → 2→3 → 주의 RELURCH
  expect(lost).toBe([F.SAFE_NOTE, F.STOP_OBS, `${F.STOP_FACT[0]} → ${F.STOP_FACT[1]}`, `${F.STOP_FACT[2]} → ${F.STOP_FACT[3]}`, `주의: ${F.RELURCH}`].join(' '));
  expect(F.SAFE_NOTE).toContain('실기 미검증');
  // 통신 끊김 ? 는 PcPlan 과 같은 글(공용 LostHelp)
  expect(pops(draw(PcPlan))).toContain(lost);
  expect(o).toContain('시뮬에서 시험한 값만'); expect(o).toContain(F.DIR_TAG); expect(p).toContain(F.NOMOVE);
  expect(s.split('aria-label="배터리 · 설명"').length - 1).toBe(1); expect(p).toContain(F.WHY['배터리']);
  expect(s).toContain('aria-label="가스 측정 · 설명"'); expect(p).toContain(F.WHY['가스·측정값·통신 품질']);
  expect(o).toContain('값 없음 — 가스 측정값이 들어오지 않아 기준값을 쓰지 않습니다.');
  expect(o).toContain('title="조종권 해제 · 입력 차단·잠금(서버) 뒤 로그인 화면"');
});

test('지원 범위: UNSUP 전 항목 표로 그대로(원어 포함) · TERMS 는 data-dev · 회색 이유 단추는 whyProps 그대로', () => {
  const s = html(), sec = s.match(/<section id="limits"[\s\S]*?<\/section>/)![0];
  expect(sec.match(/<tr>/g)).toHaveLength(F.UNSUP.length + 1);
  for (const [a, b] of F.UNSUP) expect(sec).toContain(`<tr><td style="font-weight:600">${a}</td><td class="lbl">${b}</td></tr>`);
  expect(sec).toContain(`<p class="lbl" data-dev="true" style="margin-top:8px">${F.TERMS}</p>`);
  expect(s).toMatch(/aria-disabled="true" title="계정 추가·편집 미연결 — 계정은 서버 관리자가 이 PC 에서 관리"/);
});

test('운영 기능 유지: 테마·막대 배치·지도 보기·로그아웃·보관 글 · 판 상태는 기존 newVer 판정만', () => {
  let s = html(); const o = ops(s);
  expect(o).toContain('role="radiogroup" aria-label="테마"'); for (const t of F.LAYOUTS) expect(o).toContain(`<option value="${t}"`);
  expect(o).toContain('<option value="robot"'); expect(o).toContain('>로그아웃</button>');
  expect(o).toContain('서버 media 폴더 · 사진 최근 200 · 사건 최근 300 보관'); expect(o).toContain('CSV 내보내기(기록·사진 검토) · 보고서는 인쇄');
  expect(o).toContain('화면·서버 같은 판');
  link(V1, V2); s = ops(html()); expect(s).toContain('<span class="mono">새 화면 판 반영됨 — 새로고침 필요</span>'); expect(s).not.toContain('화면·서버 같은 판');
  link(V1); s = ops(html()); expect(s).toContain('<span class="mono" style="color:var(--muted)">미확인</span>'); expect(html()).toContain(`미확인</span><span data-dev="true"><span class="mono"> · 화면 ${V1} · 서버 미확인</span></span>`);
});
