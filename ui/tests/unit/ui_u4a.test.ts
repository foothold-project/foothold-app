import { beforeEach, expect, test, vi } from 'vitest';
// U4-a PcMap: 제목 «시뮬 바닥» · 지도 열기 → 시뮬 메뉴(part open) · 화면엔 SLAM 저장만(part save) · 저장 막힘 = 지금 이유 + 다음(일반 문구로 덮기 0) · 진단 = data-dev.
// 실제 MapStartBox·PcMap 을 react-dom/server 로 그림(useLink 상태 주입). 대체: useRoute·console.error(useLayoutEffect 경고)·useLink 서버 스냅샷만.
const R = vi.hoisted(() => ({ name: 'PcMap' }));
vi.mock('../../src/app/shell', async (orig) => ({ ...(await orig<typeof import('../../src/app/shell')>()), useRoute: () => ({ name: R.name, q: new URLSearchParams(), setQ: () => {} }) }));
Object.assign(globalThis, { localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, location: { href: 'http://127.0.0.1/', protocol: 'http:', hash: '', search: '', pathname: '/' } });
vi.spyOn(console, 'error').mockImplementation(() => {});

const React = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { QueryClientProvider } = await import('@tanstack/react-query');
const { qc } = await import('../../src/data/shared');
const { useLink } = await import('../../src/data/link');
// 시험 한정: zustand 4 서버 렌더는 getInitialState() 객체를 읽음 → 그 객체에도 같은 값을 넣는다(이 파일 안에서만 · 앱 코드 변경 0)
const put = (x: Record<string, unknown>) => { useLink.setState(x as any); Object.assign(useLink.getInitialState(), x); };
const { MapStartBox, saveBlock } = await import('../../src/map/MapStartBox');
const { ZONE_NOTE, STOP_TIP } = await import('../../src/data/facts');
const PcMap = (await import('../../src/screens/PcMap')).default;
const fsm = 'node:fs', rd = async (f: string) => (await import(/* @vite-ignore */ fsm)).readFileSync(new URL(f, import.meta.url), 'utf8') as string;

const html = (el: any) => renderToStaticMarkup(React.createElement(QueryClientProvider, { client: qc }, el)).replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const box = (p: Record<string, unknown>) => html(React.createElement(MapStartBox, { pc: true, ...p } as any));
const LIVE_WHY = 'SLAM 실시간 지도가 보일 때만 저장';
const FLOOR_HOLD = '층 이동 중·층 미확인 — 지도·위치 숨김(조종·STOP 은 그대로)';
const MS = { ok: true, why: '', ledger: null, session: { runner: 'live_map', world_id: 'v5_single', floor_id: 'f1', map_mode: 'slam', result: 'running' } };
const st = (x: Record<string, unknown>) => put({ st: { map_start: MS, ...x }, provider: 'simulation_gate' });
// 운영 글 = data-dev 요소·? 설명(role="note")·hidden 버튼·숨긴 자리 그림(visibility:hidden SVG — 기존 view 견본)을 뺀 나머지(중첩 1단계까지 — 이 화면의 dev 요소는 얕음)
const ops = (s: string) => s.replace(/<svg[^>]*visibility:hidden[\s\S]*?<\/svg>/g, '').replace(/<button[^>]*hidden=""[\s\S]*?<\/button>/g, '').replace(/<(\w+)[^>]*data-dev=""[^>]*>(?:(?!<\/?\1[\s>])[\s\S])*?(?:<\1[\s>][\s\S]*?<\/\1>(?:(?!<\/?\1[\s>])[\s\S])*?)*<\/\1>/g, '').replace(/<span[^>]*role="note"[\s\S]*?<\/span>(?=<\/span>)/g, '');
beforeEach(() => { qc.clear(); R.name = 'PcMap'; put({ st: null, provider: 'simulation_gate' }); });

test('saveBlock 순수: 지금 이유를 덮지 않음 · 끊긴 초·서비스 경로는 원문만 · 다음 행동 · ok/없음/busy/static', () => {
  expect(saveBlock({ ok: true })).toBeNull();
  expect(saveBlock(null)).toEqual({ txt: '저장 상태 확인 안 됨', next: '서버 상태가 들어온 뒤 다시(자동 재시도 없음)', raw: '' });
  expect(saveBlock({ ok: false, busy: true, why: '저장 처리 중' })).toEqual({ txt: '지도 저장 중', next: '끝날 때까지 기다리세요', raw: '저장 처리 중' });
  const cut = saveBlock({ ok: false, why: `${LIVE_WHY} · 지도 상태 12.4 s 끊김` })!;
  expect(cut.txt).toBe(`${LIVE_WHY} · 지도 상태 끊김(오래됨)`); expect(cut.txt).not.toMatch(/\d+(\.\d+)? s/); expect(cut.raw).toContain('12.4 s 끊김');
  expect(cut.next).toBe('지도 상태가 다시 들어오면 저장(자동 재시도 없음)');
  expect(saveBlock({ ok: false, why: `${LIVE_WHY} · 지도 상태 미수신` })!.next).toBe('지도 상태가 다시 들어오면 저장(자동 재시도 없음)');
  const fl = saveBlock({ ok: false, why: `${LIVE_WHY} · ${FLOOR_HOLD}` })!;
  expect(fl.txt).toBe(`${LIVE_WHY} · ${FLOOR_HOLD}`); expect(fl.next).toBe('층 이동이 끝나 그 층 지도가 보이면 저장');
  expect(saveBlock({ ok: false, why: `${LIVE_WHY} · 리셋 중 — 지도 숨김` })!.next).toBe('리셋이 끝나 새 지도가 보이면 저장');
  expect(saveBlock({ ok: false, why: `${LIVE_WHY} · 지도 오류 · decode` })!.next).toBe('오류 원문을 확인한 뒤, 지도가 다시 보이면 저장');
  const svc = saveBlock({ ok: false, why: '저장 서비스 없음(/v2_map/save)' })!;
  expect(svc.txt).toBe('저장 서비스 없음'); expect(svc.raw).toBe('저장 서비스 없음(/v2_map/save)');
  expect(saveBlock({ ok: false, why: LIVE_WHY }, 'static')!.txt).toBe(`${LIVE_WHY} · 지금은 저장 지도로 연 시뮬(SLAM 만들기 아님)`);
  expect(saveBlock({ ok: false, why: LIVE_WHY }, 'slam')!.txt).toBe(LIVE_WHY);
  expect(saveBlock({ ok: false, why: '' })!.txt).toBe('저장 안 됨 · 서버 이유 없음');
  expect(saveBlock({ ok: false, why: '로그인한 기기에서만(관문 경유)' })!.txt).toBe('로그인한 기기에서만(관문 경유)');   // 모르는 이유 = 원문 그대로
});

test('MapStartBox pc part=save: 저장만 · 막히면 회색(aria-disabled, native disabled 0) + 이유·다음 운영 · 원문(초) dev', () => {
  st({ map_save: { ok: false, why: `${LIVE_WHY} · 지도 상태 7 s 끊김` }, live_map: { st: 'stale', mode: 'slam' } });
  const s = box({ part: 'save' }), o = ops(s);
  expect(s).not.toContain('id="fh-mapopen"'); expect(s).not.toContain('지도 열기 ·'); expect(s).not.toContain('role="group" aria-label="지형"');
  expect(s).toMatch(/<button[^>]*aria-disabled="true"[^>]*title="실시간 지도가 보일 때만 저장 · 지도 상태 끊김\(오래됨\) — 지도 상태가 다시 들어오면 저장\(자동 재시도 없음\)"[^>]*>지도 저장<\/button>/);
  expect(s).not.toMatch(/<button[^>]*disabled=""[^>]*>지도 저장/);
  expect(o).toContain('>저장 안 됨</span><span style="color:var(--warn)">실시간 지도가 보일 때만 저장 · 지도 상태 끊김(오래됨)</span>');   // 줄 자체(버튼 title 만으로 통과 0)
  expect(o).toContain('>다음</span><span>지도 상태가 다시 들어오면 저장(자동 재시도 없음)</span>'); expect(o).not.toContain('7 s 끊김');
  expect(s).toMatch(/data-dev=""[^>]*>[\s\S]*?원문[\s\S]*?7 s 끊김/);
  expect(o).not.toContain('2D 점유 격자');   // PcMap 은 ? 로 옮김
  // 서버 상태 없음 = «확인 안 됨»(꺼짐·저장 가능 단정 0)
  put({ st: { map_start: MS } }); const n = ops(box({ part: 'save' }));
  expect(n).toContain('저장 상태 확인 안 됨'); expect(n).not.toContain('저장할 수 있음');
  // 저장 가능 = 일반 안내 + 실제 버튼(aria-disabled 0)
  st({ map_save: { ok: true }, live_map: { st: 'ok', mode: 'slam', world_id: 'v5_single', floor_id: 'f1' } }); const k = box({ part: 'save' });
  expect(k).toMatch(/<button type="button" class="btn">지도 저장<\/button>/); expect(k).toContain('새 버전으로 저장'); expect(k).not.toContain('저장 안 됨');
});

test('MapStartBox pc part=open(시뮬 메뉴): 지도 열기만 · 고른 곳/지금 실행/기술 원값 dev · 고른 곳≠지금 실행 운영 · 저장 0 · pc=false 기존 그대로', () => {
  st({ map_save: { ok: false, why: LIVE_WHY } });
  const s = box({ part: 'open' }), o = ops(s);
  expect(s).toContain('id="fh-mapopen"'); expect(s).not.toContain('지도 저장'); expect(s).not.toContain('Gazebo');
  expect(o).not.toMatch(/>고른 곳</); expect(o).not.toMatch(/>지금 실행</); expect(o).not.toContain('world_id=');
  expect(o).toContain('고른 곳 ≠ 지금 실행(1층 건물'); expect(o).toContain('바꾸려면 시뮬 끄고 새로 열기');
  expect(s).toMatch(/<details data-dev="">/);
  const m = html(React.createElement(MapStartBox, { pc: false }));   // 폰 지도: 두 부분 · 기존 문구 · dev 표시 0
  expect(m).toContain('시뮬 실행'); expect(m).toContain('지도 저장'); expect(m).toMatch(/<button[^>]*disabled=""[^>]*>지도 저장/);
  expect(m).toContain('고른 곳과 지금 실행 중인 곳이 다릅니다'); expect(m).not.toContain('data-dev'); expect(m).toContain('2D 점유 격자');
});

test('PcMap 렌더: 제목 «시뮬 바닥» · lean 캔버스 · 구역 «표시만»+ZONE_NOTE ? · 지도 정보 운영/dev · STOP 공용 글 · 운영 글 금지어 0', () => {
  st({ map_save: { ok: false, why: `${LIVE_WHY} · ${FLOOR_HOLD}` }, live_map: { st: 'hold', mode: 'slam' } });
  const s = html(React.createElement(PcMap)), o = ops(s);
  expect(o).toContain('>시뮬 바닥<'); expect(o).not.toContain('시뮬 바닥 도면'); expect(o).not.toContain('±10');
  expect(s).toContain('스페이스 · 입력 차단·잠금'); expect(s).not.toContain('명령 0·잠금<'); expect(s).toContain('aria-label="STOP 설명"'); expect(s).toContain(STOP_TIP);
  expect(s).toMatch(/lv-chip warn[^>]*>[\s\S]*?<span>표시만<\/span>[\s\S]*?aria-label="구역 · 설명"/); expect(s).toContain(ZONE_NOTE);
  expect(o).toContain('층 이동이 끝나 그 층 지도가 보이면 저장'); expect(o).toContain(FLOOR_HOLD);   // 저장 막힘 지금 이유 = 운영
  expect(o).toMatch(/>크기<\/span><span>(20 × 20 m|도면 없음)</); expect(o).toMatch(/>격자<\/span><span>1 m</); expect(o).toMatch(/>구역<\/span><span>(\d+개|미확인)</);
  for (const d of ['만든 사람', '위치 추정', '>방법<', 'world_live.sdf', 'foothold-v2']) expect(o).not.toContain(d);   // dev
  for (const w of ['GT ', 'Gazebo', '±10 m', '(SLAM 지도 아님)', 'v2']) expect(o).not.toContain(w);
  expect(o).not.toContain('id="fh-mapopen"');   // 지도 열기는 시뮬 메뉴(화면 중복 장착 0)
  expect(s).toContain('aria-label="지도 · 설명"'); expect(s).toContain('2D 점유 격자'); expect(s).toContain('재위치추정');   // 설명 전문 보존(? 안)
});

test('소스 결속: PcMap 캔버스 lean · SimMenu 는 PcMap 에서 part open(MMap 만 안내) · 새 지도 = 시뮬 메뉴 열기(시뮬 아니면 whyProps)', async () => {
  const pm = await rd('../../src/screens/PcMap.tsx'), sm = await rd('../../src/app/status.tsx');
  expect(pm).toMatch(/<MapCanvas name="pcmap" lean /); expect(pm).toMatch(/<MapStartBox pc part="save"/);
  expect(sm).toMatch(/onMapPage = name === 'MMap';/); expect(sm).toMatch(/part=\{name === 'PcMap' \|\| \(name \|\| HOME\) === 'Main' \? 'open' : undefined\}/); expect(sm).toContain('data-simmenu=""');
  expect(pm).toMatch(/newP: sim \? \{[^}]*onClick: openSimMenu \}\s*(\/\/[^\n]*)?\n\s*: \{ \.\.\.whyProps\(/);
});
