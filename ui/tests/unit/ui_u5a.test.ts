import { beforeEach, expect, test, vi } from 'vitest';
// U5-a PcPlan(v3 §4·§2-5): 지도 칩 운영 = «출처 일치 / 출처 확인 중 · 기록만 / 출처 미확인 · 기록만 / 지도·층·출처 다름» + ?(기존 GT·SDF/기하 sha·실패 이유 전문),
// 빈 계획 «첫 점 …» ≠ 계획 출처, 개발자 모드 = 기존 문구 그대로. 판정(gtHere·planMap·startPolicy)은 그대로 — 표시만.
// 실제 PcPlan 을 react-dom/server 로 그림(초안은 scratch.drafts 로 주입 → effect 없이 첫 그림에 지점). 대체: useRoute·console.error·useLink 스냅샷만.
vi.mock('../../src/app/shell', async (orig) => ({ ...(await orig<typeof import('../../src/app/shell')>()), useRoute: () => ({ name: 'PcPlan', q: new URLSearchParams(), setQ: () => {} }) }));
Object.assign(globalThis, { localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, location: { href: 'http://127.0.0.1/', protocol: 'http:', hash: '', search: '', pathname: '/' } });
vi.spyOn(console, 'error').mockImplementation(() => {});

const React = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { QueryClientProvider } = await import('@tanstack/react-query');
const { qc } = await import('../../src/data/shared');
const { useLink } = await import('../../src/data/link');
const { useDev } = await import('../../src/data/dev');
const { drafts } = await import('../../src/data/scratch');
const { wkey, gtHere, planMap, startPolicy } = await import('../../src/data/run');
const F = await import('../../src/data/facts');
const { RULE_WHY } = await import('../../src/data/tmpl');
const M = await import('../../src/screens/PcPlan');
const PcPlan = M.default;

const SS = 'a'.repeat(64), GS = 'c'.repeat(64);
const put = (x: Record<string, unknown>) => { useLink.setState(x as any); Object.assign(useLink.getInitialState(), x); };
const single = (fresh = true) => put({ provider: 'simulation_gate', open: true, lastMsg: fresh ? performance.now() : performance.now() - 5000, bad: null, gen: 1, stGen: 1,
  st: { applied: [0, 0, 0], latch: true, role: 'view', live_map: { st: 'ok', bound: true, world_id: 'v5_single', floor_id: 'f1', world_src_sha256: SS, spawn_floor: 'f1' } } });
const W = [{ x: 1, y: 2, name: 'a', mods: [] }, { x: 3, y: 4, name: 'b', mods: [] }];
const SM = { src: 'gt' as const, world_id: 'v5_single', floor_id: 'f1', key: wkey(W), rid: `w:${SS}` };
const BM = { src: 'gt' as const, world_id: 'v5_building', floor_id: 'l1', key: wkey(W), rid: `g:${GS}` };
const draft = (map?: object) => drafts.set('mission:PcPlan', { id: 'm1', rev: 1, d: { name: '계획', tmpl: 'base', memo: '', wps: W, ...(map ? { map } : {}) } });
const html = () => renderToStaticMarkup(React.createElement(QueryClientProvider, { client: qc }, React.createElement(PcPlan))).replace(/&quot;/g, '"').replace(/&amp;/g, '&');
// 운영 글 = ? 설명(role="note" 팝오버)·공용 STOP 단추 title(stopProps — 모든 화면 같음, U5-a 범위 밖) 제외
const ops = (s: string) => s.replace(/(<button aria-label="비상 정지") title="[^"]*"/, '$1').replace(/<span id="[^"]*" role="note" class="lv-pop"[\s\S]*?<\/span>(?=<\/span>)/g, '')
  // FIX2b(ROOT 결정 4): 숨긴 «상태 상세» = ? 전문처럼 운영 글 검사에서만 제외(hidden+region+이름 정확히 · 보이는 region·원문 DOM 그대로)
  .replace(/<span id="[^"]*" role="region" aria-label="상태 상세" class="lv-pop" hidden=""[^>]*>(?:<span[^>]*><b>[^<]*<\/b>[^<]*<\/span>)*<\/span>/g, '');
const mapChip = (s: string) => s.match(/<b>지도 · ([^<]*)<\/b>/)?.[1];   // G4 요약칩 3: 옛 지도 칩 → «상태 ▾» 상세 행 «지도 · 짧은 글»(기대 글은 그대로)
const dev = (on: boolean) => { useDev.setState({ on }); Object.assign(useDev.getInitialState(), { on }); };   // SSR 은 서버 스냅샷(초기 상태 객체)을 읽음
beforeEach(() => { qc.clear(); drafts.clear(); dev(false); single(); });

test('srcView 분기: 첫 점(확인됨/확인 중/미확인) · 일치 · 다름(차단) · 계획 출처 있음+지금 확인 중/미확인 · 계획 출처 없음 — 판정은 startPolicy 그대로', () => {
  const ok = { map: SM }, wait = { why: '좌표 개정 확인 중(GT 기하 파일 받는 중)' }, off = { why: '연결 끊김' }, bad = { why: '좌표 개정 미확인(GT 기하 파일 미검증 · x)' };
  expect(M.srcView(null, ok, null)).toMatchObject({ good: true, text: '첫 점 · 출처 확인됨' });
  expect(M.srcView(null, wait, null)).toMatchObject({ good: false, text: '첫 점 · 출처 확인 중 · 기록만', line: '지도 · 지점 없음 · 지금 좌표 개정 확인 중 · 지금 찍으면 기록만' });
  expect(M.srcView(null, bad, null)).toMatchObject({ good: false, text: '첫 점 · 출처 미확인 · 기록만', line: '지도 · 지점 없음 · 지금 좌표 개정 미확인 · 지금 찍으면 기록만' });
  const d = (map?: object) => ({ name: 'p', tmpl: 'base', memo: '', wps: W, ...(map ? { map } : {}) }) as any;
  const sv = (map: object | undefined, h: any) => M.srcView(planMap(d(map)), h, startPolicy(d(map), h));
  expect(sv(SM, ok)).toMatchObject({ good: true, text: '출처 일치' });
  expect(sv(BM, ok)).toMatchObject({ good: false, text: '지도·층·출처 다름', line: '지도·층·출처 다름 — 시작 안 됨 · 맞는 지도·층에서 시작(열기·편집은 가능)' });
  expect(sv(SM, wait)).toMatchObject({ good: false, text: '출처 확인 중 · 기록만', line: '지도 · 출처 확인 중 · 기록만 — 지금 좌표 개정 확인 중 (거리·지도 겹치기 표시 안 함)' });
  expect(sv(SM, off)).toMatchObject({ good: false, text: '출처 미확인 · 기록만', line: '지도 · 출처 미확인 · 기록만 — 지금 연결 끊김 (거리·지도 겹치기 표시 안 함)' });
  expect(sv(undefined, ok)).toMatchObject({ good: false, text: '출처 미확인 · 기록만', line: '지도 · 출처 미확인 · 기록만 — 출처 기록 없음 (거리·지도 겹치기 표시 안 함)' });
  expect(sv({ ...SM, rid: undefined }, ok).line).toBe('지도 · 출처 미확인 · 기록만 — 개정 기록 없음 — 지금 지도에서 다시 찍어야 확인 (거리·지도 겹치기 표시 안 함)');
  expect(sv({ ...SM, key: '00000000' }, ok).line).toBe('지도 · 출처 미확인 · 기록만 — 출처 기록 뒤 좌표가 바뀜 (거리·지도 겹치기 표시 안 함)');
  // «확인 중» 은 gtHere 의 G1 대기 문구 하나에만 — 다른 이유는 모두 «미확인»(새 추정 0)
  for (const why of ['지도 미수신', '층 이동 중', '시뮬 리셋 중', '서버 결속 미확인', '현재층 미확인', '좌표 개정 미확인(world 원본 SDF sha 없음)']) expect(M.srcView(null, { why }, null).text).toBe('첫 점 · 출처 미확인 · 기록만');
});

test('그림: 빈 계획 «첫 점 · 출처 확인됨» + ? 전문(GT·SDF sha) · 운영 글 금지어(GT·v2·미제공·명령 0·해시) 0 · 공용 STOP 글 + ?', () => {
  expect(gtHere().map).toMatchObject({ world_id: 'v5_single' });
  const s = html(), o = ops(s);
  expect(mapChip(s)).toBe('첫 점 · 출처 확인됨'); expect(o).toContain('지도 · 지점 없음 · 첫 점은 지금 지도 출처로 기록');
  expect(s.split('aria-label="지도 출처 · 설명"').length - 1).toBe(1);   // G4: 칩이 상세 행으로 옮겨 ? 는 점검 줄 한 곳(전문 글 그대로 아래 단언)
  expect(s).toContain('<b>지도 · 첫 점 · 출처 확인됨</b> — 지도 · 지점 없음 · 첫 점은 지금 지도 출처로 기록');   // 상세 행 = 짧은 글 + 운영 줄
  expect(s).toContain('첫 지점 결속 준비됨 · v5_single · f1 (GT · SDF aaaaaaaa)'); expect(s).toContain(M.SRC_NOTE);
  expect(s).not.toContain('aria-label="비상 정지"'); expect(s).not.toContain('스페이스 · 입력 차단·잠금'); expect(s).toContain('aria-label="STOP 설명"'); expect(s).toContain(F.STOP_TIP);   // FIX2b(ROOT 결정 1): G1 = 화면별 STOP 삭제 → 이 화면 STOP 0 · 공용 STOP 존재·title(STOP_TIP)·송신은 ui_g1_stop(실제 App)
  for (const w of ['GT ', 'GT)', '미제공', '명령 0', 'Gazebo', '원값']) expect(o).not.toContain(w);
  expect(o).not.toMatch(/\bv2\b/);   // «Nav2» 는 금지어 아님
  expect(o).not.toMatch(/\b(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b/);
});

test('G4 요약칩 3: PcPlan 머리줄 = HeadChips 만(≤3) · 옛 위치/지도 칩 0 → «상태 ▾» 상세 행 «위치 · » «지도 · » · 출처 ? 전문은 점검 줄에 그대로', () => {
  const s = html();
  expect((s.match(/data-head="/g) || []).length).toBeLessThanOrEqual(3); expect(s).toContain('상태 ▾');
  expect(s).not.toMatch(/<span style="color:var\(--muted\)">(지도|위치)<\/span>/);   // 옛 칩 마크업 0
  expect(s).toMatch(/<b>위치 · [^<]+<\/b> — [^<]+/); expect(mapChip(s)).toBe('첫 점 · 출처 확인됨');
  expect(s).toContain('aria-label="지도 출처 · 설명"'); expect(s).toContain(M.SRC_NOTE);
});

test('그림: 지점 있는 계획 — 같은 출처 «출처 일치» · 다른 출처 «지도·층·출처 다름» 차단(시작 회색·막힌 이유 운영 줄) · 출처 없음 «출처 미확인 · 기록만» · 연결 오래됨 «지금 연결 끊김»', () => {
  draft(SM); let s = html(), o = ops(s); expect(mapChip(s)).toBe('출처 일치'); expect(o).toContain('지도 · 출처 일치 · 지금 시뮬과 같은 출처');
  expect(s).toContain('지도 v5_single · f1 (GT · SDF aaaaaaaa) · 지금 시뮬과 같은 GT 출처');   // ? 전문 = startPolicy.line 그대로
  draft(BM); s = html(); o = ops(s); expect(mapChip(s)).toBe('지도·층·출처 다름');
  expect(o).toContain('▲ 지도·층·출처 다름 — 시작 안 됨 · 맞는 지도·층에서 시작(열기·편집은 가능)');
  expect(s).toContain('다른 지도 · 계획 v5_building · l1 (GT · 기하 cccccccc) ≠ 지금 v5_single · f1 (GT · SDF aaaaaaaa) — 시작 안 됨');   // ? 전문 = startPolicy.block 그대로
  for (const w of ['GT ', '명령 0']) expect(o).not.toContain(w);
  expect(o).not.toMatch(/\bv2\b/);
  draft(); s = html(); expect(mapChip(s)).toBe('출처 미확인 · 기록만'); expect(ops(s)).toContain('지도 · 출처 미확인 · 기록만 — 출처 기록 없음');
  draft(SM); single(false); s = html(); expect(mapChip(s)).toBe('출처 미확인 · 기록만'); expect(ops(s)).toContain('— 지금 연결 끊김 (거리·지도 겹치기 표시 안 함)');
});

test('개발자 모드: 지도 칩·점검 줄은 기존 문구 그대로(GT·SDF sha), 운영 짧은 글·? 0', () => {
  dev(true);
  let s = html(); expect(mapChip(s)).toBe('첫 지점 결속 준비됨 · v5_single · f1 (GT · SDF aaaaaaaa)'); expect(s).toContain('지도 · 지점 없음 · 첫 지점 결속 준비됨');
  draft(BM); s = html(); expect(mapChip(s)).toBe('v5_building · l1 (GT · 기하 cccccccc)'); expect(s).toContain('▲ 다른 지도 · 계획 v5_building · l1');
  expect(s).not.toContain('aria-label="지도 출처 · 설명"'); expect(s).not.toContain('지도·층·출처 다름');
});

test('통신 끊김·경보 규칙·배터리: 쉬운 말 + ? 전문 보존(STOP_FACT·SAFE_NOTE·STOP_OBS·RELURCH·RULE_WHY·WHY 배터리) · 선택 불가 그대로', () => {
  const s = html(), o = ops(s);
  expect(o).toContain('<b>입력 차단·잠금</b>'); expect(o).toContain(' · 서버 고정'); expect(o).not.toContain('조종 입력 0.3초 끊김');   // M9(디자인 정본): 짧은 글 + ? — 0.3 s/1 s 전문은 LostHelp(아래 STOP_FACT 보존 검사)
  for (const t of [F.SAFE_NOTE, F.STOP_OBS, `${F.STOP_FACT[0]} → ${F.STOP_FACT[1]}`, `${F.STOP_FACT[2]} → ${F.STOP_FACT[3]}`, `주의: ${F.RELURCH}`, RULE_WHY, F.WHY['배터리']]) expect(s).toContain(t);
  expect(s.match(/<input type="radio" name="lost"[^>]*>/g)!.every((x) => x.includes('disabled'))).toBe(true);
  expect(s.split('aria-label="배터리 · 설명"').length - 1).toBe(1);   // M11(디자인 정본): 배터리 사용 칸 삭제 → 점검 줄 한 곳(전문 WHY 배터리 보존)
  expect(o).toContain('자동 실행 안 함'); expect(o).toContain('배터리 · 값 없음'); expect(o).not.toContain('배터리 사용');
});
