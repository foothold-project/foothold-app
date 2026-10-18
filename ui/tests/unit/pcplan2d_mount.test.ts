import { afterAll, afterEach, beforeEach, expect, test, vi } from 'vitest';
// 임무 2D(ROOT 경계 8 · ROOT-IMPLEMENT-DEPLOY 24434027 6·7·8·9 · UX-SPEC R1 5-1~5-6): 실제 PcPlan 을 createRoot(가짜 DOM)에 장착하고, MapCanvas 가 받은 onDown/onTap 을
// «누름 → (도구·도면·문서 바뀜) → 뗌» 순서로 불러 본다. 짧게 누름 = 즉시 «지점 확인»(팝오버 0) · 중간에 수명이 바뀌면 추가 0 · Esc 는 확정점 삭제 0 ·
// 계획 출발점 S(선택 · 첫 목적지 출처 = 유효 S 출처 · 다른 도면 S 는 막음·원문 보존) · 5초 되돌리기(쓰기 호출·실제 경과 뒤 무효) · 기본값(출발점 복귀·자동 이름).
// 대체 = MapCanvas(그림 대신 props 기록) · usePlanTerrain(도면 상태 고정 — 읽기 hook 은 plan2d.test 에서 따로) · useRoute·toast · T.get(응답 없음).
// 한계: 실제 포인터 이벤트 순서·6 px 끌기 판정·Canvas 그림은 MapCanvas/670 브라우저 범위(미측정).
// console.error 는 전체 억제하지 않음(715 R1): 모으기만 하고 시험마다 0건을 단언 — 새 경고가 나오면 그 문구를 보고 좁게 다룬다.
const R = vi.hoisted(() => ({ mc: null as any, terr: null as any, toasts: [] as string[], q: new URLSearchParams() }));
vi.mock('../../src/map/MapCanvas', async (orig) => { const m = await orig<any>(), React = await import('react');
  return { ...m, MapCanvas: (p: any) => { R.mc = p; return React.createElement('div', { 'data-map': p.name }); } }; });
vi.mock('../../src/screens/plan2d', async (orig) => ({ ...(await orig<any>()), usePlanTerrain: () => R.terr }));
vi.mock('../../src/app/shell', async (orig) => ({ ...(await orig<any>()), useRoute: () => ({ name: 'PcPlan', q: R.q, setQ: () => {} }), toast: (t: string) => { R.toasts.push(t); } }));
class N {
  children: N[] = []; parentNode: N | null = null; attrs: Record<string, string> = {}; style: Record<string, any> = { setProperty(k: string, v: string) { (this as any)[k] = v; } };
  nodeValue = ''; _t = ''; namespaceURI = 'http://www.w3.org/1999/xhtml'; isConnected = true;
  constructor(public nodeName: string, public nodeType = 1) {}
  get tagName() { return this.nodeName; } get ownerDocument() { return doc; }
  get options(): N[] { return this.children.flatMap((c) => c.nodeName === 'OPTION' ? [c] : c.options); }
  get firstChild() { return this.children[0] ?? null; } get lastChild() { return this.children[this.children.length - 1] ?? null; }
  get textContent(): string { return this.nodeType === 3 ? this.nodeValue : this._t + this.children.map((c) => c.textContent).join(''); }
  set textContent(v: string) { this.children = []; this._t = v; }
  appendChild(c: N) { c.parentNode?.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
  insertBefore(c: N, b: N) { c.parentNode?.removeChild(c); c.parentNode = this; this.children.splice(this.children.indexOf(b), 0, c); return c; }
  removeChild(c: N) { this.children.splice(this.children.indexOf(c), 1); c.parentNode = null; return c; }
  setAttribute(k: string, v: string) { this.attrs[k] = String(v); } removeAttribute(k: string) { delete this.attrs[k]; } getAttribute(k: string) { return this.attrs[k] ?? null; }
  contains(n: N | null): boolean { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  addEventListener() {} removeEventListener() {} focus() {}
  getBoundingClientRect() { return { left: 0, top: 0, right: 80, bottom: 30, width: 80, height: 30, x: 0, y: 0 }; }
  getClientRects() { return [this.getBoundingClientRect()]; }   // focusBack(보이는 단추만 초점) 이 부름 — 실제 DOM 메서드
}
const evs: Record<string, ((e: any) => void)[]> = {};   // window keydown 등(Esc 시험)
const on = (k: string, f: any) => { (evs[k] ||= []).push(f); }, off = (k: string, f: any) => { evs[k] = (evs[k] || []).filter((g) => g !== f); };
const doc: any = { addEventListener() {}, removeEventListener() {}, nodeType: 9, fullscreenElement: null, activeElement: null, hidden: false, documentElement: new N('HTML'), body: new N('BODY'),
  createElement: (t: string) => new N(t.toUpperCase()), createElementNS: (_: string, t: string) => new N(t.toUpperCase()), createTextNode: (s: string) => Object.assign(new N('#text', 3), { nodeValue: s }),
  querySelectorAll: () => [], querySelector: () => null };
// 가짜 전역은 원래 descriptor 를 먼저 보관 → afterAll 에서 root 정리 뒤 되돌림(없던 키 delete) — 단일 fork 뒤 파일 오염 0(ROOT fixture 독립성)
const GKEYS = ['window', 'document', 'addEventListener', 'removeEventListener', 'IS_REACT_ACT_ENVIRONMENT', 'HTMLIFrameElement', 'innerWidth', 'innerHeight', 'localStorage', 'confirm', 'location'];
const SAVED = GKEYS.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)] as const);
const restoreG = () => { for (const [k, d] of SAVED) { if (d) Object.defineProperty(globalThis, k, d); else delete (globalThis as any)[k]; } };
Object.assign(globalThis, { window: globalThis, document: doc, addEventListener: on, removeEventListener: off, IS_REACT_ACT_ENVIRONMENT: true, HTMLIFrameElement: class {}, innerWidth: 1440, innerHeight: 900,
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, confirm: () => true,
  location: { href: 'http://127.0.0.1/#/PcPlan', protocol: 'http:', hash: '#/PcPlan', search: '', pathname: '/' } });
const errs: unknown[][] = [];
const ceSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errs.push(a); });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { QueryClientProvider } = await import('@tanstack/react-query');
const { qc } = await import('../../src/data/shared');
const { T } = await import('../../src/data/transport');
const { useLink } = await import('../../src/data/link');
const { drafts } = await import('../../src/data/scratch');
const PcPlan = (await import('../../src/screens/PcPlan')).default;
vi.spyOn(T, 'get').mockImplementation((() => new Promise(() => {})) as any);   // 문서 목록 응답 없음(빈 새 계획 그대로)

const SS = 'a'.repeat(64), SS2 = 'b'.repeat(64);
const RAS = { img: {} as any, res: 0.1, ox: -5, oy: -5, w: 100, h: 100, label: 'gt' };
const single = (sha = SS) => useLink.setState({ provider: 'simulation_gate', open: true, lastMsg: performance.now(), bad: null, gen: 1, stGen: 1,
  st: { applied: [0, 0, 0], latch: true, role: 'view', live_map: { st: 'ok', bound: true, world_id: 'v5_single', floor_id: 'f1', world_src_sha256: sha, spawn_floor: 'f1' } } } as any);
const ESC = () => ({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
const all = (n: N): N[] => [n, ...n.children.flatMap(all)];
const props = (n: N): any => Object.entries(n).find(([k]) => k.startsWith('__reactProps$'))![1];
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const roots: any[] = [];
afterEach(async () => { for (const r of roots.splice(0)) await React.act(async () => r.unmount()); expect(errs.map((a) => String(a[0]).slice(0, 200))).toEqual([]); });
afterAll(async () => { try { for (const r of roots.splice(0)) await React.act(async () => r.unmount()); } finally { ceSpy.mockRestore(); restoreG(); } });
beforeEach(() => { errs.length = 0; qc.clear(); drafts.clear(); R.mc = null; R.toasts = []; R.q = new URLSearchParams(); R.terr = { k: 'ok', ras: RAS, n: 1, geo: null, retry: () => {} }; single(); });

const mount = async () => {
  const host = new N('DIV'), root: any = createRoot(host as any); roots.push(root);
  const act = async (f: () => unknown) => { await React.act(async () => { f(); }); await React.act(flush); };
  await act(() => root.render(React.createElement(QueryClientProvider, { client: qc }, React.createElement(PcPlan))));
  const btn = (t: RegExp) => all(host).find((n) => n.nodeName === 'BUTTON' && t.test(n.textContent));
  const click = async (t: RegExp) => { const b = btn(t); expect(b, String(t)).toBeTruthy(); await act(() => props(b!).onClick?.({ currentTarget: b, preventDefault() {} })); };
  const dialog = () => all(host).find((n) => n.attrs.role === 'dialog');
  const down = () => act(() => R.mc.onDown()), up = (x = 1, y = 1) => act(() => R.mc.onTap(x, y, 10));
  const tap = async (x = 1, y = 1) => { await down(); await up(x, y); };
  const esc = () => act(() => { for (const f of evs.keydown || []) f(ESC()); });
  const rerender = (k: number) => act(() => useLink.setState({ tick: k } as any));
  // G4 요약칩 3: 지도 출처 짧은 글은 «상태 ▾» 상세 행(InTop → 가짜 DOM 에선 document.body portal) — 그 글까지 볼 때는 seen
  return { host, act, btn, click, dialog, down, up, tap, esc, rerender, text: () => host.textContent, seen: () => host.textContent + doc.body.textContent };
};
const keep = async () => { const r = roots.pop(); await React.act(async () => r.unmount()); return structuredClone(drafts.get('mission:PcPlan')!.d) as any; };   // 떠날 때 보관 = 편집기 문서 그대로
const nameIn = (h: N) => all(h).find((n) => n.nodeName === 'INPUT' && n.attrs.id === 'pname')!;
const setName = (m: Awaited<ReturnType<typeof mount>>, v: string) => m.act(() => props(nameIn(m.host)).onChange({ target: { value: v }, currentTarget: { value: v } }));
const radios = (h: N) => all(h).filter((n) => n.attrs.role === 'radio').map((n) => `${n.textContent}=${n.attrs['aria-checked']}`);
const mkBtn = (h: N) => all(h).find((n) => n.nodeName === 'BUTTON' && /^(임무 만들기|변경 저장)$/.test(n.textContent))!;
const P1 = { x: 1, y: 2, name: '', mods: ['운영자 확인'] };

// ---- ROOT 6 즉시 추가 + 누름→뗌 수명 반례(옛 고리 시험의 의미 그대로 · 결과는 «추가됨/0») ----
test('정상 경로: 누름→뗌 = «지점 확인» 1개 즉시(팝오버·dialog 0) · 그 줄 선택 · 첫 점 rid = 지금 w: → «출처 일치»', async () => {
  const m = await mount();
  expect(R.mc).toBeTruthy(); expect(R.mc.onDown).toBeTypeOf('function'); expect('sel' in R.mc).toBe(false);
  await m.tap(1, 2);
  expect(m.dialog()).toBeFalsy(); expect(R.mc.wps).toEqual([P1]); expect(R.mc.hiWp).toBe(0);
  expect(m.text()).toContain('출처 일치');
  await m.tap(3, 4); expect(R.mc.wps).toHaveLength(2); expect(R.mc.hiWp).toBe(1);
});

test('반례: 누름 → 도구 바꿈(선택) → 뗌 = 추가 0 · 다시 «목적지 추가» 뒤 정상', async () => {
  const m = await mount();
  await m.down(); await m.click(/^선택$/); await m.up();
  expect(R.mc.wps).toHaveLength(0);
  await m.click(/^목적지 추가$/); await m.tap();
  expect(R.mc.wps).toHaveLength(1);
});

test('반례: 누름 → 도면 신원 바뀜(n) → 뗌 = 추가 0 · 누름 → 지형 선택 바뀜 → 뗌 = 추가 0', async () => {
  const m = await mount();
  await m.down(); R.terr = { ...R.terr, n: 2 }; await m.rerender(1); await m.up();
  expect(R.mc.wps).toHaveLength(0);
  await m.down();
  const s = all(m.host).find((n) => n.nodeName === 'SELECT' && n.attrs['aria-label'] === '지형')!; expect(s).toBeTruthy();
  await m.act(() => props(s).onChange({ target: { value: 'v5_building' }, currentTarget: { value: 'v5_building' } }));
  await m.up();
  expect(R.mc.wps).toHaveLength(0);
});

test('반례: 누름 → 문서 편집(지점 삭제) → 뗌 = 추가 0', async () => {
  const m = await mount();
  await m.tap(1, 1); expect(R.mc.wps).toHaveLength(1);
  await m.down(); await m.click(/^삭제$/); await m.up(2, 2);
  expect(R.mc.wps).toHaveLength(0);
});

test('반례(715 R1 P1): 누름 → «선택» → 다시 «목적지 추가» → 뗌 = 값은 처음과 같아도 세대가 바뀌어 추가 0 · 다음 누름은 정상', async () => {
  const m = await mount();
  await m.down(); await m.click(/^선택$/); await m.click(/^목적지 추가$/); await m.up();
  expect(R.mc.wps).toHaveLength(0);
  await m.tap(); expect(R.mc.wps).toHaveLength(1);
});

test('반례(P1 + N1 결합): 누름 → 도면 n 바뀜 → 원래 n 으로 복귀 → 뗌 = 추가 0', async () => {
  const m = await mount();
  await m.down();
  R.terr = { ...R.terr, n: 2 }; await m.rerender(1);
  R.terr = { ...R.terr, n: 1 }; await m.rerender(2);
  await m.up();
  expect(R.mc.wps).toHaveLength(0);
});

test('N2: 지형 전환 패널(미저장 지점 있음) = Esc 로 취소 · 지형·지점 그대로 · 패널 중 누름→닫힘→뗌 = 추가 0 · 그 뒤 Esc 는 확정점 삭제 0', async () => {
  const m = await mount();
  await m.tap(1, 1); expect(R.mc.wps).toHaveLength(1);
  const sel = () => all(m.host).find((n) => n.nodeName === 'SELECT' && n.attrs['aria-label'] === '지형')!;
  await m.act(() => props(sel()).onChange({ target: { value: 'v5_building' }, currentTarget: { value: 'v5_building' } }));
  const panel = () => all(m.host).find((n) => n.attrs['aria-label'] === '지형 바꾸기 확인');
  expect(panel()).toBeTruthy();
  await m.down();
  await m.esc();
  expect(panel()).toBeFalsy(); expect(R.mc.wps).toHaveLength(1); expect(props(sel()).value).toBe('v5_single');
  await m.up(2, 2); expect(R.mc.wps).toHaveLength(1);
  await m.esc(); await m.esc();   // 선택 해제 → 무동작 — 확정점은 그대로
  expect(R.mc.wps).toHaveLength(1); expect(R.mc.hiWp ?? null).toBeNull();
});

test('Esc 순서(ROOT CODEX-G3 R2): 열린 도움말(?)이 있으면 Esc 는 그 패널 몫 — 줄 선택·확정점 그대로 · 창 밖 누름 리스너 0', async () => {
  const m = await mount();
  await m.tap(1, 1); expect(R.mc.hiWp).toBe(0);
  const q = all(m.host).find((n) => n.nodeName === 'BUTTON' && n.attrs['aria-label'] === '출발점 · 설명')!; expect(q).toBeTruthy();
  await m.act(() => props(q).onClick({ currentTarget: q, preventDefault() {}, stopPropagation() {} }));
  expect(q.attrs['aria-expanded']).toBe('true');
  await m.esc();
  expect(R.mc.hiWp).toBe(0); expect(R.mc.wps).toHaveLength(1);
  expect(evs.pointerdown ?? []).toHaveLength(0);   // 옛 할 일 창(창 밖 누름 닫기) 리스너 없음
});

// ---- ROOT 7 기본값 · UX-SPEC 5-1 여섯 단계 ----
test('새 임무: 여섯 단계 늘 보임 · ④ 출발점 복귀 미리 선택 + «기본값» 표 · 직접 누르면 표만 사라짐 · 이름 자동 1회 · 빠진 것 전부 한 줄', async () => {
  const m = await mount();
  expect(all(m.host).filter((n) => n.attrs['data-step']).map((n) => n.attrs['data-step'])).toEqual(['1', '2', '3', '4', '5', '6']);
  expect(radios(m.host)).toEqual(['출발점 복귀=true', '마지막 지점 종료=false']);   // 목적지 0곳이어도 ④ 보임
  expect(m.text()).toContain('기본값'); expect(m.text()).toContain('출발점 · 지정 안 함(선택)');
  const nm = props(nameIn(m.host)).value as string; expect(nm).toMatch(/임무 \d\d-\d\d \d\d:\d\d$/);
  expect(m.text()).toContain('만들려면: ③ 목적지 1곳 이상'); expect(props(mkBtn(m.host)).disabled).toBe(true);
  expect(m.text()).toContain('③ 목적지를 찍으면 흐름이 보입니다');
  await m.tap(1, 1);
  expect(m.text()).not.toContain('만들려면'); expect(props(mkBtn(m.host)).disabled).toBe(false); expect(mkBtn(m.host).textContent).toBe('임무 만들기');
  expect(m.text()).toContain('임무 시작 위치'); expect(m.text()).toContain('1 지점 1 · 지점 확인'); expect(m.text()).toContain('시작 위치로 복귀');
  await m.click(/^출발점 복귀$/);
  expect(radios(m.host)).toEqual(['출발점 복귀=true', '마지막 지점 종료=false']); expect(m.text()).not.toContain('기본값');
  await m.click(/^마지막 지점 종료$/);
  expect(m.text()).toContain('1 지점 1 · 지점 확인 · 여기서 종료'); expect(m.text()).not.toContain('시작 위치로 복귀');
  await setName(m, '');
  expect(m.text()).toContain('만들려면: ⑥ 이름'); expect(props(mkBtn(m.host)).disabled).toBe(true);
  await setName(m, '창고 앞'); expect(props(mkBtn(m.host)).disabled).toBe(false);
  expect(props(nameIn(m.host)).value).toBe('창고 앞');   // 자동 이름이 사용자 이름을 다시 덮음 0
});

test('옛 임무 재열기(id 있음 · finish·start 키 없음): ④ 요구 0 · «종료 방식 미지정» · S «좌표 없음 · 지정 안 함(선택)» · 이름만 고쳐도 키 새로 생김 0', async () => {
  drafts.set('mission:PcPlan', { id: 'm1', rev: 1, d: { name: '옛 계획', tmpl: 'base', memo: '', wps: [{ x: 1, y: 1, name: '', mods: ['사진'] }] } });
  const m = await mount();
  expect(m.text()).toContain('임무 수정 · 옛 계획'); expect(m.text()).toContain('종료 방식 미지정'); expect(m.text()).not.toContain('④ 종료 방식 ·');
  expect(m.text()).not.toContain('기본값'); expect(m.text()).toContain('출발점 좌표 없음 · 지정 안 함(선택)');
  expect(radios(m.host)).toEqual(['출발점 복귀=false', '마지막 지점 종료=false']);
  expect(m.text()).toContain('④ 종료 방식을 고르면 흐름이 보입니다');
  await setName(m, '옛 계획 2');
  expect(radios(m.host)).toEqual(['출발점 복귀=false', '마지막 지점 종료=false']); expect(props(mkBtn(m.host)).disabled).toBe(false);
  const kept = await keep();
  expect(kept.name).toBe('옛 계획 2'); expect('finish' in kept).toBe(false); expect('start' in kept).toBe(false);
});

// ---- ROOT 8 계획 출발점 S(선택) ----
test('S 지정: «출발점 지정» → 도면 한 번 누름 = S(목적지 0곳 그대로) → 이전 도구로 · 카드 «계획 위치 · 실제 로봇 위치 아님» · Esc 는 도구만 끔(S 그대로)', async () => {
  const m = await mount();
  await m.click(/^출발점 지정$/);
  expect(m.text()).toContain('도면을 한 번 누르면 출발점 S');
  await m.tap(5, 6); expect(R.mc.start ?? null).toBeNull(); expect(R.toasts[R.toasts.length - 1]).toBe('도면 밖 · 출발점 안 찍힘');   // FIX2 범위 밖 반례(RAS x·y ∈ [-5, 5] · 제품 inRaster) — S 도구 유지
  await m.tap(3, 4);
  expect(R.mc.start).toEqual([3, 4]); expect(R.mc.wps).toHaveLength(0);
  expect(m.text()).toContain('S 출발점 · X 3.00 m · Y 4.00 m'); expect(m.text()).toContain('실제 로봇 위치 아님');
  await m.tap(6, 6); expect(R.mc.wps).toHaveLength(0); expect(R.toasts[R.toasts.length - 1]).toBe('도면 밖 · 안 찍힘');   // 범위 밖 목적지 = 추가 0
  await m.tap(2, 1); expect(R.mc.wps).toHaveLength(1); expect(R.mc.start).toEqual([3, 4]);   // 이전 도구(목적지 추가)로 돌아옴
  expect(m.text()).toContain('S 출발점'); expect(m.text()).toContain('S 로 복귀');
  await m.click(/^위치 옮기기$/); await m.esc();
  await m.tap(-2, -3); expect(R.mc.start).toEqual([3, 4]); expect(R.mc.wps).toHaveLength(2);   // Esc = S 도구만 끔 · S 그대로
});

test('S 경계(PREP-UI R2): rid 없는 S → 실행 world 늦게 확인 → 첫 목적지 = S 출처 그대로(rid 승격 0) · 마지막 목적지 삭제→재추가에도 S 원문 바이트 같음', async () => {
  useLink.setState({ st: { ...(useLink.getState() as any).st, live_map: { st: 'ok', bound: false, world_id: 'v5_single', floor_id: 'f1', world_src_sha256: SS, spawn_floor: 'f1' } } } as any);
  const m = await mount();
  // FIX2: bound false = 지금 시뮬 지형 미확정(hT null) → 기본 지형 없음 · 사용자가 «지형»을 먼저 고르는 실제 전제(S 는 rid 없이 world/floor 만)
  const ts = all(m.host).find((n) => n.nodeName === 'SELECT' && n.attrs['aria-label'] === '지형')!; expect(props(ts).value).toBe('');
  await m.act(() => props(ts).onChange({ target: { value: 'v5_single' }, currentTarget: { value: 'v5_single' } }));
  await m.click(/^출발점 지정$/); await m.tap(3, 4); expect(R.mc.start).toEqual([3, 4]);
  await m.act(() => single(SS));   // 이제 지금 firstSrc 는 w:SS rid 를 줌
  // CODEX-G2 R2: 첫 누름 «전» 안내도 실제로 쓸 S 출처(rid 없음) — «첫 점 · 출처 확인됨»·«계획 기준 = 실행 world» 0
  expect(m.seen()).toContain('첫 점 · 출처 미확인 · 기록만'); expect(m.seen()).not.toContain('출처 확인됨'); expect(m.seen()).not.toContain('계획 기준 = 실행 world');
  await m.tap(2, 1); expect(R.mc.wps).toHaveLength(1);
  expect(m.text()).not.toContain('출처 일치');
  const a = await keep();
  expect('rid' in a.start.map).toBe(false); expect('rid' in a.map).toBe(false);
  expect(a.map.world_id).toBe(a.start.map.world_id); expect(a.map.floor_id).toBe(a.start.map.floor_id); expect(a.map.key).not.toBe(a.start.map.key);
  const s0 = JSON.stringify(a.start);
  const m2 = await mount();   // 보관 초안 복원
  await m2.click(/^선택$/); await m2.tap(2, 1); expect(R.mc.hiWp).toBe(0);
  const dels = all(m2.host).filter((n) => n.nodeName === 'BUTTON' && n.textContent === '삭제'); expect(dels).toHaveLength(2);   // S 카드 삭제 + 줄 삭제(뒤)
  await m2.act(() => props(dels[1]).onClick({})); expect(R.mc.wps).toHaveLength(0); expect(R.mc.start).toEqual([3, 4]);
  await m2.click(/^목적지 추가$/);
  await m2.tap(-1, 2); expect(R.mc.wps).toHaveLength(1);
  const b = await keep();
  expect(JSON.stringify(b.start)).toBe(s0); expect('rid' in b.map).toBe(false); expect(b.map.world_id).toBe(a.map.world_id);
});

test('S 경계: 다른 층 S(원문) = 숫자 카드만 · 지도 그림 0 · 첫 목적지 추가 막힘(이유 토스트) · S 원문 그대로', async () => {
  const S0 = { x: 1, y: 1, map: { src: 'gt', world_id: 'v5_single', floor_id: 'f2', key: 'zz' } };
  drafts.set('mission:PcPlan', { id: null, rev: null, d: { name: '새', tmpl: 'base', memo: '', wps: [], finish: '출발점 복귀', start: S0 } } as any);
  const m = await mount();
  expect(R.mc.start).toBeNull(); expect(m.text()).toContain('도면이 달라 지도에 안 그림');
  expect(m.seen()).toContain('첫 점 · 추가 막힘'); expect(m.seen()).not.toContain('지금 찍으면 기록만'); expect(m.seen()).not.toContain('출처 확인됨');   // CODEX-G2 R2: 막힌 S 에 «생성 가능» 안내 0
  await m.tap(2, 2);
  expect(R.mc.wps).toHaveLength(0); expect(R.toasts[R.toasts.length - 1]).toContain('출발점과 도면이 달라 목적지 추가 불가');
  expect((await keep()).start).toEqual(S0);
});

// ---- ROOT 9 5초 되돌리기 · ROOT G2 Undo 경계(쓰기 호출 세대·실제 경과) ----
const posts: any[] = [];
const reply = (...rs: [number, unknown][]) => { posts.length = 0; vi.spyOn(T, 'postDocs').mockImplementation((async (b: unknown) => { posts.push(b); const [status, body] = rs.shift() ?? [500, { error: 'x' }]; return { status, body: JSON.stringify(body) }; }) as any); };
const OK = (id: string, rev = 1): [number, unknown] => [200, { ok: true, id, rev, kind: 'mission', name: '', new: true }];
const undoBtn = (m: Awaited<ReturnType<typeof mount>>) => m.btn(/^되돌리기$/);

test('삭제 → «되돌리기» = 같은 자리·같은 값 · 한 번만', async () => {
  const m = await mount();
  await m.tap(1, 2); await m.tap(3, 4); const before = structuredClone(R.mc.wps);
  await m.click(/^삭제$/);
  expect(R.mc.wps).toHaveLength(1); expect(m.text()).toContain('지점 2 «지점 2» 삭제함');
  await m.click(/^되돌리기$/);
  expect(R.mc.wps).toEqual(before); expect(undoBtn(m)).toBeFalsy();
});

test('되돌리기 무효: 다른 편집 · 실제 경과 5 s(타이머가 늦어도) · 저장 성공 · 저장 409 — busy 가 풀려도 되살아남 0', async () => {
  const m = await mount();
  await m.tap(1, 2); await m.tap(3, 4); await m.click(/^삭제$/); expect(undoBtn(m)).toBeTruthy();
  await m.tap(5, 5); expect(undoBtn(m)).toBeFalsy();                                          // 다른 편집
  await m.click(/^삭제$/); expect(undoBtn(m)).toBeTruthy();
  const t0 = Date.now(), dn = vi.spyOn(Date, 'now').mockReturnValue(t0 + 6000);
  await m.rerender(3); expect(undoBtn(m)).toBeFalsy(); dn.mockRestore();                    // 백그라운드 지연 = 실제 경과로 판정
  await m.tap(-3, -3); await m.click(/^삭제$/); expect(undoBtn(m)).toBeTruthy();
  reply(OK('m5')); await m.click(/^임무 만들기$/); expect(posts).toHaveLength(1);
  await m.rerender(4); expect(undoBtn(m)).toBeFalsy();
  { const r = roots.pop(); await React.act(async () => r.unmount()); } drafts.clear();
  const m2 = await mount();
  await m2.tap(1, 1); await m2.tap(2, 2); await m2.click(/^삭제$/); expect(undoBtn(m2)).toBeTruthy();
  reply([409, { error: '다른 기기' }]); await m2.click(/^(임무 만들기|변경 저장)$/); expect(posts).toHaveLength(1);
  await m2.rerender(5); expect(undoBtn(m2)).toBeFalsy();
});

test('관문에서 막힌 저장(요청 0)은 되돌리기를 지우지 않음 · 새 임무 «초안 버리기» → 되돌리기 = 지점·이름 그대로', async () => {
  const m = await mount();
  await m.tap(1, 2); await setName(m, '창고');
  await m.click(/^초안 버리기$/);
  expect(R.mc.wps).toHaveLength(0); expect(m.text()).toContain('초안 버림');
  reply(OK('m6')); await m.click(/^임무 만들기$/);                                        // 목적지 0곳 = 관문에서 막힘
  expect(posts).toHaveLength(0); expect(undoBtn(m)).toBeTruthy();
  await m.click(/^되돌리기$/);
  expect(R.mc.wps).toEqual([P1]); expect(props(nameIn(m.host)).value).toBe('창고');
});

test('저장된 임무 «초안 버리기» → 서버 판 → 편집 없이 «변경 저장» 성공 = 옛 초안 되돌리기 0(같은 문서·편집 세대여도)', async () => {
  const O = { name: '옛 계획', tmpl: 'base', memo: '', wps: [{ x: 1, y: 1, name: '가', mods: ['사진'] }], finish: '출발점 복귀' };
  qc.setQueryData(['docs'], { docs: [{ id: 'm1', kind: 'mission', rev: 1, by: 'u', at: '2026-10-19T00:00:00', doc: O }], rev: 1 }); R.q = new URLSearchParams('mission=m1');
  vi.spyOn(T, 'get').mockImplementation((async () => ({ status: 200, body: JSON.stringify(qc.getQueryData(['docs'])) })) as any);
  const m = await mount();
  await setName(m, '바꾼 이름'); await m.click(/^초안 버리기$/);
  expect(props(nameIn(m.host)).value).toBe('옛 계획'); expect(undoBtn(m)).toBeTruthy();
  reply(OK('m1', 2)); await m.click(/^변경 저장$/); expect(posts).toHaveLength(1);
  await m.rerender(6); expect(undoBtn(m)).toBeFalsy(); expect(props(nameIn(m.host)).value).toBe('옛 계획');
});

// ---- R3b 저장 관문(715 발견 · ROOT GO): ⑤ 말고 C0 «이 초안 저장»·404 «새 문서로 저장» 도 같은 createWhy · 기존 id 옛 계획은 키 없음 그대로 ----
test('저장 관문 C0: 주소 문서와 다른 새 초안 «이 초안 저장» = 이름 비면 요청 0·초안 그대로 · 넣은 뒤 1회(기본 종료 방식 값 그대로)', async () => {
  R.q = new URLSearchParams('mission=m9'); reply(OK('m2'));
  const m = await mount();
  await m.tap(1, 1);
  expect(m.text()).toContain('요청한 문서 «찾지 못함»');
  await setName(m, '');
  await m.click(/^이 초안 저장$/);
  expect(posts).toHaveLength(0); expect(R.toasts[R.toasts.length - 1]).toBe('만들려면: ⑥ 이름'); expect(R.mc.wps).toHaveLength(1);
  await setName(m, '새 계획');
  await m.click(/^이 초안 저장$/);
  expect(posts).toHaveLength(1); expect(posts[0]).toMatchObject({ op: 'put', kind: 'mission', id: null, doc: { name: '새 계획', finish: '출발점 복귀' } });
  expect('start' in posts[0].doc).toBe(false);   // S 안 찍으면 키 0
});

test('저장 관문 404: 옛 계획(id·키 없음) 저장 = 키 없이 1회(양성) · 지워짐 → «새 문서로 저장»(id 없음) = 종료 방식 없으면 요청 0 · 고른 뒤 새 문서 1회', async () => {
  drafts.set('mission:PcPlan', { id: 'm1', rev: 1, d: { name: '옛 계획', tmpl: 'base', memo: '', wps: [{ x: 1, y: 1, name: '가', mods: ['사진'] }] } });
  reply([404, { error: '없음' }], OK('m3'));
  const m = await mount();
  await m.click(/^변경 저장$/);
  expect(posts).toHaveLength(1); expect(posts[0]).toMatchObject({ op: 'put', id: 'm1', rev: 1 }); expect('finish' in posts[0].doc).toBe(false);
  await m.click(/^새 문서로 저장$/);
  expect(posts).toHaveLength(1); expect(R.toasts[R.toasts.length - 1]).toBe('만들려면: ④ 종료 방식');
  await m.click(/^마지막 지점 종료$/);
  await m.click(/^새 문서로 저장$/);
  expect(posts).toHaveLength(2); expect(posts[1]).toMatchObject({ op: 'put', id: null, doc: { name: '옛 계획', finish: '마지막 지점 종료' } });
});

// ---- E6c(QA3 · ROOT GO): 저장 중 화면 이탈 → 늦은 응답(판 2) → 복귀. 서버 본문 = 보관 초안이면 새 판·깨끗, 한 글자라도 다르면 초안 보존 ----
const O6 = { name: '옛 계획', tmpl: 'base', memo: '', wps: [{ x: 1, y: 1, name: '가', mods: ['사진'] }] };
const env6 = (rev: number, d: unknown) => ({ id: 'm1', kind: 'mission', rev, by: 'u', at: '2026-10-19T00:00:00', doc: d });
const e6c = async (more?: string) => {
  qc.setQueryData(['docs'], { docs: [env6(1, O6)], rev: 1 }); R.q = new URLSearchParams('mission=m1');
  let done!: (v: unknown) => void; const sent: any[] = [];
  vi.spyOn(T, 'postDocs').mockImplementation(((b: any) => { sent.push(b); return new Promise((r) => { done = r; }); }) as any);
  vi.spyOn(T, 'get').mockImplementation((async () => ({ status: 200, body: JSON.stringify(qc.getQueryData(['docs'])) })) as any);
  const m = await mount(), nm = (h: N, v: string) => React.act(async () => props(nameIn(h)).onChange({ target: { value: v }, currentTarget: { value: v } }));
  await nm(m.host, 'Z 계획'); await m.click(/^변경 저장$/); expect(sent).toHaveLength(1); expect(sent[0]).toMatchObject({ op: 'put', id: 'm1', rev: 1, doc: { name: 'Z 계획' } });
  if (more) await nm(m.host, more);
  const r = roots.pop(); await React.act(async () => r.unmount());                     // 저장 응답 전 이탈 = 옛 판 1 로 보관
  expect(drafts.get('mission:PcPlan')).toMatchObject({ id: 'm1', rev: 1, d: { name: more ?? 'Z 계획' } });
  await React.act(async () => { done({ status: 200, body: JSON.stringify({ ok: true, id: 'm1', rev: 2, kind: 'mission', name: 'Z 계획' }) }); await flush(); });
  expect(R.toasts).toContain('앞 문서 저장됨 · 판 2');
  qc.setQueryData(['docs'], { docs: [env6(2, sent[0].doc)], rev: 2 });               // 서버 판 2 = 보낸 본문 그대로
  const m2 = await mount();
  return { m2, sent, name: () => (props(nameIn(m2.host)).value as string) };
};

// ---- ROOT 5 · UX-SPEC 4 지형 기억(fh.plan.wf) ----
test('지형 기억: WF 안 값 = 새 빈 계획 ①·층 미리 고름 · 낡은 값 = 기존 규칙(지금 시뮬 지형) · 열기만 = 저장 0 · 사용자가 고름 = 저장', async () => {
  const st = new Map<string, string>(), w: string[] = [], old = (globalThis as any).localStorage;
  (globalThis as any).localStorage = { getItem: (k: string) => st.get(k) ?? null, setItem: (k: string, v: string) => { w.push(`${k}=${v}`); st.set(k, v); }, removeItem: (k: string) => { w.push(`${k}-`); st.delete(k); } };
  try {
    const sv = (h: N, lab: string) => props(all(h).find((n) => n.nodeName === 'SELECT' && n.attrs['aria-label'] === lab)!).value;
    st.set('fh.plan.wf', 'v5_building/l2');
    const m = await mount();
    expect(sv(m.host, '지형')).toBe('v5_building'); expect(sv(m.host, '층')).toBe('l2'); expect(w).toEqual([]);
    await React.act(async () => roots.pop().unmount()); drafts.clear();
    st.set('fh.plan.wf', 'v5_building/zz');   // WF 밖 층 = 무시
    const m2 = await mount();
    expect(sv(m2.host, '지형')).toBe('v5_single'); expect(w).toEqual([]);
    const s = all(m2.host).find((n) => n.nodeName === 'SELECT' && n.attrs['aria-label'] === '지형')!;
    await m2.act(() => props(s).onChange({ target: { value: 'rooms_a' }, currentTarget: { value: 'rooms_a' } }));
    expect(sv(m2.host, '지형')).toBe('rooms_a'); expect(w).toEqual(['fh.plan.wf=rooms_a/f1']);
  } finally { (globalThis as any).localStorage = old; }
});

test('E6c 같은 본문: 저장 중 이탈 → 판 2 응답 → 복귀 = 새 판 2 · 깨끗(dirty 0) · 추가 쓰기 0', async () => {
  const { m2, sent, name } = await e6c();
  expect(m2.text()).toContain('저장됨 · 판 2'); expect(m2.text()).not.toContain('저장 안 한 수정 있음');
  expect(name()).toBe('Z 계획'); expect(sent).toHaveLength(1); expect(drafts.has('mission:PcPlan')).toBe(false);
});

test('E6c 다른 본문: 저장 중 Y 로 더 고치고 이탈 → 판 2(Z) 응답 → 복귀 = 초안 Y 보존 · dirty 유지 · 추가 쓰기 0', async () => {
  const { m2, sent, name } = await e6c('Y 계획');
  expect(m2.text()).toContain('저장 안 한 수정 있음'); expect(m2.text()).not.toContain('저장됨 · 판 2');
  expect(name()).toBe('Y 계획'); expect(sent).toHaveLength(1);
});
