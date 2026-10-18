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
  // FIX2b(ROOT 결정 4): 숨긴 «상태 상세» = ? 전문처럼 운영 글 검사에서만 제외(hidden+region+이름 정확히 · 보이는 region·원문 DOM 그대로)
  .replace(/<span id="[^"]*" role="region" aria-label="상태 상세" class="lv-pop" hidden=""[^>]*>(?:<span[^>]*><b>[^<]*<\/b>[^<]*<\/span>)*<\/span>/g, '')
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
  expect(s).not.toContain('aria-label="비상 정지"'); expect(s).not.toContain('스페이스 · 입력 차단·잠금'); expect(s).not.toContain('스페이스 · 명령 0·잠금');   // FIX2b(ROOT 결정 1): G1 = 화면별 STOP 삭제 → 이 화면 STOP 0 · 공용 STOP 존재·title(STOP_TIP)·송신은 ui_g1_stop(실제 App)
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

test('운영 기능 유지: 테마·막대 배치·지도 보기·로그아웃·보관 글', () => {
  const o = ops(html());
  expect(o).toContain('role="radiogroup" aria-label="테마"'); for (const t of F.LAYOUTS) expect(o).toContain(`<option value="${t}"`);
  expect(o).toContain('<option value="robot"'); expect(o).toContain('>로그아웃</button>');
  expect(o).toContain('서버 media 폴더 · 사진 최근 200 · 사건 최근 300 보관'); expect(o).toContain('CSV 내보내기(기록·사진 검토) · 보고서는 인쇄');
});

// B1(715 review-395a234): firstVer = 이 탭이 처음 받은 status.ver · 서버 version() 실패값 = «미확인»(+수정) 문자열.
// 비교는 이 연결의 신선한 수신 + 두 값 모두 실제 판일 때만, 범위는 «서버 판» 표기 — 화면 번들 일치·새 화면 반영 확정 글 0. 부족하면 warn «판 비교 미확인».
test('판 상태: 신선·bad 없음·같은 세대·실제 판 두 개일 때만 서버 판 비교 · 나머지는 warn 미확인', () => {
  const SAME = '<span class="mono">서버 판 그대로(이 탭이 처음 받은 판과 같음)</span>', CHG = '<span class="mono">서버 판 바뀜(이 탭이 처음 받은 판과 다름) · 새로고침 권장</span>';
  const UNK = '<span class="mono" style="color:var(--warn)">판 비교 미확인</span>';
  const one = () => { const s = html(), o = ops(s);
    // PcSettings 값 칸의 옛 확정 글 0(공용 LiveStatus status.tsx:87 의 새 판 경고는 부모 잔여·범위 밖 — 여기서 검사 안 함)
    for (const w of ['<span class="mono">화면·서버 같은 판', '<span class="mono">새 화면 판 반영됨']) expect(s).not.toContain(w);
    return [SAME, CHG, UNK].filter((t) => o.includes(t)); };
  const at = (first: string, ver: string | undefined, x: Record<string, unknown> = {}) => { link(first, ver); put(x); return one(); };
  expect(at(V1, V1)).toEqual([SAME]);
  expect(at(V1, V2)).toEqual([CHG]);
  // 열린 채 오래됨 · 닫힘 · 형식 이상 · 새 세대/옛 st → 미확인, 같은 세대 수신 복원 → 다시 비교
  expect(at(V1, V1, { lastMsg: performance.now() - 2000 })).toEqual([UNK]);
  expect(at(V1, V2, { open: false })).toEqual([UNK]);
  expect(at(V1, V1, { bad: 'ver' })).toEqual([UNK]);
  expect(at(V1, V2, { gen: 2 })).toEqual([UNK]);
  expect(at(V1, V2, { gen: 2, stGen: 2 })).toEqual([CHG]);
  // 서버 «미확인»·«미확인+수정» 문자열은 판이 아님(양쪽·한쪽·접두)
  for (const [a, b] of [['미확인', '미확인'], ['미확인+수정', '미확인+수정'], ['미확인', V1], [V1, '미확인'], [V1, '미확인+수정'], ['', V1]]) expect(at(a, b)).toEqual([UNK]);
  expect(at(V1, undefined)).toEqual([UNK]);
  // 원값·다시 확인 경로는 개발자 모드에 그대로
  link(V1, V2); expect(html()).toContain(`<span data-dev="true"><span class="mono"> · 화면 ${V1} · 서버 ${V2}</span></span>`);
});

// 670 395a §2 P2: .set = 2열 grid(이름 칸 · 값 칸). 값 옆 ?/DirTag 가 조각(자식 3개)이면 ? 가 다음 줄 이름 칸으로 떨어짐 → 행 자식은 정확히 2개.
// 행 끝 = 짝 맞는 </div> 까지(태그 깊이로 셈 — 정규식 비탐욕은 안쪽 div 에서 끊김). 자식 수도 깊이 0 여는 태그로 셈.
const rows = (s: string) => {
  const out: { name: string; kids: number; body: string }[] = [];
  for (const m of s.matchAll(/<div class="set">/g)) {
    let d = 0, kids = 0, i = m.index! + m[0].length, end = -1;
    for (const t of s.slice(i).matchAll(/<(\/?)([a-z0-9]+)[^>]*?(\/?)>/g)) {
      const close = t[1] === '/', self = t[3] === '/' || /^(input|br|img|hr)$/.test(t[2]);
      if (close) { if (d === 0) { end = i + t.index!; break; } d--; }
      else { if (d === 0) kids++; if (!self) d++; }
    }
    const body = s.slice(i, end);
    out.push({ name: (body.match(/<b>([^<]*)<\/b>/) ?? [])[1] ?? '', kids, body });
  }
  return out;
};
test('P2 안전 행: 값과 ?/DirTag 가 같은 값 칸(행 자식 2개) · 전문·글 그대로', () => {
  const r = rows(html()), by = (n: string) => r.find((x) => x.name === n)!;
  // 안전 정책 7행(SAFETY 순서) + «앱 버전»(판 요약 + data-dev 원값). SSR 직접 자식 수만 — 실제 grid 배치·줄바꿈·겹침은 670 3폭 dev0/1 실측 몫
  const SAFE = ['통신 끊김으로 판정하는 시간', '통신이 끊기면', '영상 멎음 기준', '손을 뗐을 때 서버 정지 (deadman)', '다시 연결되면 자동으로 이어 가기', '최대 속도', '배터리 복귀 기준', '앱 버전'];
  for (const n of SAFE) { expect(by(n), n).toBeTruthy(); expect(by(n).kids, n).toBe(2); }
  const lost = by('통신이 끊기면').body, sp = by('최대 속도').body, bat = by('배터리 복귀 기준').body;
  expect(lost).toMatch(/<\/span><span><span class="mono">입력 차단 \(몸 정지는 별도\) · 자동 후퇴 미연결<\/span><span class="lv-help">/);
  expect(sp).toMatch(/<\/span><span><span class="mono">시뮬에서 시험한 값만 · <\/span>/); expect(sp).toContain(F.DIR_TAG);
  expect(bat).toMatch(/<\/span><span><span class="mono" style="color:var\(--muted\)">값 없음<\/span><span class="lv-help">/);
  // 앱 버전: 판 요약(B1 글·톤 그대로) 과 dev 원값이 같은 값 칸 안 — 세 경우(그대로·바뀜·미확인)
  const ver = () => rows(html()).find((x) => x.name === '앱 버전')!.body;   // 상태 바꿀 때마다 새로 그림
  expect(ver()).toMatch(new RegExp(`</span><span><span class="mono">서버 판 그대로\\(이 탭이 처음 받은 판과 같음\\)</span><span data-dev="true"><span class="mono"> · 화면 ${V1} · 서버 ${V1}</span></span></span>$`));
  link(V1, V2); expect(ver()).toMatch(/<span><span class="mono">서버 판 바뀜\(이 탭이 처음 받은 판과 다름\) · 새로고침 권장<\/span><span data-dev="true">/);
  link('미확인', '미확인'); expect(ver()).toMatch(/<span><span class="mono" style="color:var\(--warn\)">판 비교 미확인<\/span><span data-dev="true"><span class="mono"> · 화면 미확인 · 서버 미확인<\/span><\/span><\/span>$/);
  expect(pops(lost)).toHaveLength(1); expect(pops(bat)).toEqual([F.WHY['배터리']]); expect(pops(sp)).toContain(F.NOMOVE);
});
