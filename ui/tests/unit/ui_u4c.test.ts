import { beforeEach, expect, test, vi } from 'vitest';
// U4-c PcMissions: 잠김 = «기본 · 잠김» + «복제해서 고치세요» · 못 더하는 칩 = 회색(aria-disabled) + 이유 · 경보 규칙 «자동 실행 안 함» 칩 + ? · 고정 규칙 2줄(쉬운 말) + ? 전문 · 공용 STOP 글 · 운영 글 금지어 0.
// 실제 PcMissions 를 react-dom/server 로 그림. 대체: useRoute(고른 양식)·console.error(useLayoutEffect 경고)·문서 쿼리 캐시만.
let SEL = 'base';
vi.mock('../../src/app/shell', async (orig) => ({ ...(await orig<typeof import('../../src/app/shell')>()), useRoute: () => ({ name: 'PcMissions', q: new URLSearchParams(`tmpl=${SEL}`), setQ: () => {} }) }));
Object.assign(globalThis, { localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, location: { href: 'http://127.0.0.1/', protocol: 'http:', hash: '', search: '', pathname: '/' } });
vi.spyOn(console, 'error').mockImplementation(() => {});

const React = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { QueryClientProvider } = await import('@tanstack/react-query');
const { qc } = await import('../../src/data/shared');
const F = await import('../../src/data/facts');
const T = await import('../../src/data/tmpl');
const PcMissions = (await import('../../src/screens/PcMissions')).default;

const html = () => renderToStaticMarkup(React.createElement(QueryClientProvider, { client: qc }, React.createElement(PcMissions))).replace(/&quot;/g, '"').replace(/&amp;/g, '&');
// 운영 글 = ? 설명(role="note" 팝오버) 제거 뒤 태그·속성(title 등) 뺀 보이는 글
const ops = (s: string) => s.replace(/<span id="[^"]*" role="note" class="lv-pop"[\s\S]*?<\/span>(?=<\/span>)/g, '').replace(/<[^>]+>/g, ' ');
const TEAM = { id: 't1', kind: 'tmpl', rev: 2, by: 'op', at: '2026-10-16T00:00:00Z', doc: { name: '팀 양식', desc: '', mods: [{ type: '사진', detail: '' }] } };
beforeEach(() => { qc.clear(); SEL = 'base'; qc.setQueryData(['docs'], { docs: [TEAM], rev: 3 }); });

test('기본 양식: «기본 · 잠김» + «복제해서 고치세요» · 옛 긴 문장 0 · 공용 STOP 글 + ?', () => {
  const s = html(), o = ops(s);
  expect(o).toContain('기본 · 잠김'); expect(o).toContain('복제해서 고치세요');
  for (const w of ['기본 양식 · 잠김', '기본 제공 · 모든 기기 공통', '기본 양식은 지우거나 고칠 수 없습니다']) expect(o).not.toContain(w);
  expect(s).toContain('스페이스 · 입력 차단·잠금'); expect(s).toContain('aria-label="STOP 설명"'); expect(s).toContain(F.STOP_TIP);
});

test('모듈 칩: 미연결(AI 탐지·가스·음성) = 회색 aria-disabled + «아직 연결 안 됨» title · native disabled 0 · 미연결 문장 0 · 팀 양식의 사진은 실제 버튼', () => {
  SEL = 't1'; const s = html(), o = ops(s);
  for (const ty of Object.keys(T.MOD_OFF)) expect(s).toMatch(new RegExp(`<button class="pal lv-why" aria-disabled="true" title="아직 연결 안 됨 — [^"]*"[^>]*>\\+ <span[^>]*>${ty}<`));
  expect(s).not.toMatch(/<button class="pal[^"]*"[^>]*disabled=""/);
  expect(o).not.toContain('미연결(저장·실행 안 함)');
  expect(s).toMatch(/<button class="pal" title="">\+ <span[^>]*>대기</);   // 더할 수 있는 칩 = 그대로 버튼(aria-disabled 0)
  SEL = 'base'; expect(html()).toMatch(/<button class="pal lv-why" aria-disabled="true" title="기본 양식은 고칠 수 없습니다 · 복제해서 고치세요"/);
});

test('경보 규칙: «자동 실행 안 함» 회색 칩 + RULE_WHY ? · 규칙 추가 회색 유지 · 고정 규칙 2줄 쉬운 말 + ? 전문(3.6 s·0.32 m 보존)', () => {
  const s = html(), o = ops(s);
  expect(o).toContain('자동 실행 안 함'); expect(s).toContain('aria-label="경보 규칙 · 설명"'); expect(s).toContain(T.RULE_WHY);
  expect(o).not.toContain('조건이 맞으면 로봇이 먼저 조치');
  expect(o).toMatch(/항상 적용\s+조종 입력 0\.3초 끊김[\s\S]*입력 차단 \(몸 정지는 별도/);
  expect(o).toMatch(/항상 적용\s+화면을 떠나거나 신호 1초 끊김[\s\S]*입력 차단·잠금/);
  for (const t of [F.SAFE_NOTE, F.STOP_OBS, `${F.STOP_FACT[0]} → ${F.STOP_FACT[1]}`, `주의: ${F.RELURCH}`, `${F.STOP_FACT[2]} → ${F.STOP_FACT[3]}`]) expect(s).toContain(t);
  expect(s).toContain('3.6'); expect(s).toContain('0.32 m');
});

test('운영 글 금지어 0(v2·미제공·현재 v2 서버) · ? 안·title 은 허용', () => {
  for (const sel of ['base', 't1']) { SEL = sel; const o = ops(html()); for (const w of ['v2', '미제공', '현재 v2 서버', '끌 수 없음']) expect(o).not.toContain(w); }
});
