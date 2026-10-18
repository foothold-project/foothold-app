import { afterEach, beforeEach, expect, test, vi } from 'vitest';
// 임무 2D(ROOT 경계 8 · root «MapCanvas onDown 1prop GO»): 실제 PcPlan 을 createRoot(가짜 DOM)에 장착하고, MapCanvas 가 받은 onDown/onTap 을
// «누름 → (도구·도면·문서 바뀜) → 뗌» 순서로 불러 commit 0 을 본다. 임시 고리 때 잡은 첫 점 후보는 확정 때 재계산과 같을 때만 rid(나중 응답 보충 0).
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
}
const evs: Record<string, ((e: any) => void)[]> = {};   // window keydown 등(Esc 시험)
const on = (k: string, f: any) => { (evs[k] ||= []).push(f); }, off = (k: string, f: any) => { evs[k] = (evs[k] || []).filter((g) => g !== f); };
const doc: any = { addEventListener() {}, removeEventListener() {}, nodeType: 9, fullscreenElement: null, activeElement: null, hidden: false, documentElement: new N('HTML'), body: new N('BODY'),
  createElement: (t: string) => new N(t.toUpperCase()), createElementNS: (_: string, t: string) => new N(t.toUpperCase()), createTextNode: (s: string) => Object.assign(new N('#text', 3), { nodeValue: s }),
  querySelectorAll: () => [], querySelector: () => null };
Object.assign(globalThis, { window: globalThis, document: doc, addEventListener: on, removeEventListener: off, IS_REACT_ACT_ENVIRONMENT: true, HTMLIFrameElement: class {}, innerWidth: 1440, innerHeight: 900,
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, confirm: () => true,
  location: { href: 'http://127.0.0.1/#/PcPlan', protocol: 'http:', hash: '#/PcPlan', search: '', pathname: '/' } });
const errs: unknown[][] = [];
vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errs.push(a); });

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
beforeEach(() => { errs.length = 0; qc.clear(); drafts.clear(); R.mc = null; R.toasts = []; R.q = new URLSearchParams(); R.terr = { k: 'ok', ras: RAS, n: 1, geo: null, retry: () => {} }; single(); });

const mount = async () => {
  const host = new N('DIV'), root: any = createRoot(host as any); roots.push(root);
  const act = async (f: () => unknown) => { await React.act(async () => { f(); }); await React.act(flush); };
  await act(() => root.render(React.createElement(QueryClientProvider, { client: qc }, React.createElement(PcPlan))));
  const btn = (t: RegExp) => all(host).find((n) => n.nodeName === 'BUTTON' && t.test(n.textContent));
  const click = async (t: RegExp) => { const b = btn(t); expect(b, String(t)).toBeTruthy(); await act(() => props(b!).onClick?.({ currentTarget: b })); };
  const pop = () => all(host).find((n) => n.attrs.role === 'dialog' && n.attrs['aria-label'] === '할 일 고르기');
  const down = () => act(() => R.mc.onDown()), up = (x = 1, y = 1) => act(() => R.mc.onTap(x, y, 10));
  return { host, act, btn, click, pop, down, up, text: () => host.textContent };
};

test('정상 경로: 누름→뗌 = 임시 고리+선택창 · 프리셋 확정 1회 = 지점 1(mods 그대로) · 첫 점 rid = 고리 때와 같은 w: → «출처 일치»', async () => {
  const m = await mount();
  expect(R.mc).toBeTruthy(); expect(R.mc.onDown).toBeTypeOf('function');
  await m.down(); await m.up(1, 2);
  expect(m.pop()).toBeTruthy(); expect(R.mc.sel).toEqual([1, 2]); expect(R.mc.wps).toHaveLength(0);   // 확정 전 wps 추가 0
  await m.click(/^지점 확인/);
  expect(m.pop()).toBeFalsy(); expect(R.mc.wps).toEqual([{ x: 1, y: 2, name: '', mods: ['운영자 확인'] }]);
  expect(m.text()).toContain('출처 일치');
});

test('반례: 누름 → 도구 바꿈(선택) → 뗌 = 고리 0 · 다시 «목적지 추가» 뒤 정상', async () => {
  const m = await mount();
  await m.down(); await m.click(/^선택$/); await m.up();
  expect(m.pop()).toBeFalsy(); expect(R.mc.wps).toHaveLength(0);
  await m.click(/^목적지 추가$/); await m.down(); await m.up();
  expect(m.pop()).toBeTruthy();
});

test('반례: 누름 → 도면 신원 바뀜(n) → 뗌 = 고리 0 · 누름 → 지형 선택 바뀜 → 뗌 = 고리 0', async () => {
  const m = await mount();
  await m.down(); R.terr = { ...R.terr, n: 2 }; await m.act(() => useLink.setState({ tick: 1 } as any)); await m.up();
  expect(m.pop()).toBeFalsy();
  await m.down();
  const s = all(m.host).find((n) => n.nodeName === 'SELECT' && n.attrs['aria-label'] === '지형')!; expect(s).toBeTruthy();
  await m.act(() => props(s).onChange({ target: { value: 'v5_building' }, currentTarget: { value: 'v5_building' } }));
  await m.up();
  expect(m.pop()).toBeFalsy(); expect(R.mc.wps).toHaveLength(0);
});

test('반례: 누름 → 문서 편집(지점 삭제) → 뗌 = 고리 0 · 열린 선택창도 편집 1회로 무효(확정 0)', async () => {
  const m = await mount();
  await m.down(); await m.up(1, 1); await m.click(/^사진 기록/);
  expect(R.mc.wps).toHaveLength(1);
  await m.down(); await m.click(/^삭제$/); await m.up(2, 2);
  expect(m.pop()).toBeFalsy(); expect(R.mc.wps).toHaveLength(0);
  await m.down(); await m.up(1, 1); await m.click(/^지점 확인/);   // 첫 점 다시
  await m.down(); await m.up(2, 2); expect(m.pop()).toBeTruthy();   // 2번째 고리 열림(1번 선택 중)
  await m.click(/^삭제$/);                                          // 편집 1회 → 토큰 무효
  expect(m.pop()).toBeFalsy(); expect(R.mc.wps).toHaveLength(0);
});

test('첫 점 후보 묶기: 고리 때 w:SS → 확정 전 시뮬 world sha 바뀜 → 확정 = rid 생략(연관만 · 출처 일치 0) · 승격 0', async () => {
  const m = await mount();
  await m.down(); await m.up(1, 1); expect(m.pop()).toBeTruthy();
  await m.act(() => single(SS2));
  expect(m.pop()).toBeTruthy();   // 지형·도면·문서 수명은 그대로 — 고리 유지
  await m.click(/^지점 확인/);
  expect(R.mc.wps).toHaveLength(1);
  expect(m.text()).not.toContain('출처 일치');
  expect(m.text()).toContain('출처 미확인 · 기록만');
});

test('반례(715 R1 P1): 누름 → «선택» → 다시 «목적지 추가» → 뗌 = 값은 처음과 같아도 세대가 바뀌어 고리 0 · 다음 누름은 정상', async () => {
  const m = await mount();
  await m.down(); await m.click(/^선택$/); await m.click(/^목적지 추가$/); await m.up();
  expect(m.pop()).toBeFalsy(); expect(R.mc.wps).toHaveLength(0);
  await m.down(); await m.up(); expect(m.pop()).toBeTruthy();
});

test('반례(P1 + N1 결합): 누름 → 도면 n 바뀜 → 원래 n 으로 복귀 → 뗌 = 고리 0', async () => {
  const m = await mount();
  await m.down();
  R.terr = { ...R.terr, n: 2 }; await m.act(() => useLink.setState({ tick: 1 } as any));
  R.terr = { ...R.terr, n: 1 }; await m.act(() => useLink.setState({ tick: 2 } as any));
  await m.up();
  expect(m.pop()).toBeFalsy();
});

test('N2: 지형 전환 패널(미저장 지점 있음) = Esc 로 취소 · 지형·지점 그대로 · 패널 중 누름→닫힘→뗌 = 고리 0', async () => {
  const m = await mount();
  await m.down(); await m.up(1, 1); await m.click(/^지점 확인/); expect(R.mc.wps).toHaveLength(1);
  const sel = () => all(m.host).find((n) => n.nodeName === 'SELECT' && n.attrs['aria-label'] === '지형')!;
  await m.act(() => props(sel()).onChange({ target: { value: 'v5_building' }, currentTarget: { value: 'v5_building' } }));
  const panel = () => all(m.host).find((n) => n.attrs['aria-label'] === '지형 바꾸기 확인');
  expect(panel()).toBeTruthy();
  await m.down();
  await m.act(() => { for (const f of evs.keydown || []) f(ESC()); });
  expect(panel()).toBeFalsy(); expect(R.mc.wps).toHaveLength(1); expect(props(sel()).value).toBe('v5_single');
  await m.up(2, 2); expect(m.pop()).toBeFalsy();
  await m.act(() => { for (const f of evs.keydown || []) f(ESC()); });   // 열린 것 없음 = 무동작
  expect(R.mc.wps).toHaveLength(1);
});

// ---- R3b 새 임무 만들기(SPEC-CREATE-R3 8299013f · ROOT 결정 cc2755b9) ----
const radios = (h: N) => all(h).filter((n) => n.attrs.role === 'radio').map((n) => `${n.textContent}=${n.attrs['aria-checked']}`);
const nameIn = (h: N) => all(h).find((n) => n.nodeName === 'INPUT' && n.attrs.id === 'pname')!;
const mkBtn = (h: N) => all(h).find((n) => n.nodeName === 'BUTTON' && /^(임무 만들기|변경 저장)$/.test(n.textContent))!;

test('R3b 생성: ② → ③(기본 미선택) → 종료 방식 직접 누름 = 흐름 · 이름 비면 막힘 · 이름 넣으면 «임무 만들기» 열림', async () => {
  const m = await mount();
  expect(m.text()).toContain('새 임무 만들기'); expect(m.text()).toContain('▲ ② 목적지를 하나 이상 찍으세요');
  expect(radios(m.host)).toEqual([]);                                     // 지점 없으면 ③ 단추 없음
  await m.down(); await m.up(1, 1); await m.click(/^사진 기록/);
  expect(m.text()).toContain('▲ ③ 종료 방식을 고르세요'); expect(m.text()).toContain('하나를 고르세요 · 기본값 없음');
  expect(radios(m.host)).toEqual(['출발점 복귀=false', '마지막 지점 종료=false']);
  expect(props(mkBtn(m.host)).disabled).toBe(true);
  await m.click(/^출발점 복귀$/);
  expect(radios(m.host)).toEqual(['출발점 복귀=true', '마지막 지점 종료=false']);
  expect(m.text()).toContain('임무 시작 위치'); expect(m.text()).toContain('1 지점 1 · 사진 기록'); expect(m.text()).toContain('시작 위치로 복귀');
  expect(m.text()).toContain('▲ 이름을 넣으세요'); expect(props(mkBtn(m.host)).disabled).toBe(true);
  await m.click(/^마지막 지점 종료$/);
  expect(m.text()).toContain('1 지점 1 · 사진 기록 · 여기서 종료'); expect(m.text()).not.toContain('시작 위치로 복귀');
  await m.act(() => props(nameIn(m.host)).onChange({ target: { value: '창고 앞' }, currentTarget: { value: '창고 앞' } }));
  expect(m.text()).toContain('누르면 저장 · 저장 뒤 «임무 수정»으로'); expect(props(mkBtn(m.host)).disabled).toBe(false); expect(mkBtn(m.host).textContent).toBe('임무 만들기');
});

test('R3b 옛 임무 재열기(id 있음 · finish 키 없음): ③ 요구 0 · «종료 방식 미지정» · 이름만 고쳐도 키 새로 생김 0', async () => {
  drafts.set('mission:PcPlan', { id: 'm1', rev: 1, d: { name: '옛 계획', tmpl: 'base', memo: '', wps: [{ x: 1, y: 1, name: '', mods: ['사진'] }] } });
  const m = await mount();
  expect(m.text()).toContain('임무 수정 · 옛 계획'); expect(m.text()).toContain('종료 방식 미지정'); expect(m.text()).not.toContain('③ 종료 방식을 고르세요');
  expect(radios(m.host)).toEqual(['출발점 복귀=false', '마지막 지점 종료=false']);
  expect(m.text()).toContain('③ 종료 방식을 고르면 흐름이 보입니다');
  await m.act(() => props(nameIn(m.host)).onChange({ target: { value: '옛 계획 2' }, currentTarget: { value: '옛 계획 2' } }));
  expect(radios(m.host)).toEqual(['출발점 복귀=false', '마지막 지점 종료=false']); expect(props(mkBtn(m.host)).disabled).toBe(false);
  const r = roots.pop(); await React.act(async () => r.unmount());     // 떠날 때 보관되는 초안 = 편집기 문서 그대로
  const kept = drafts.get('mission:PcPlan')!.d as Record<string, unknown>;
  expect(kept.name).toBe('옛 계획 2'); expect('finish' in kept).toBe(false);
});

test('R3b 할 일 창 밖 누름 = 취소(고리 0) · 창 안 누름 = 유지 · 지도 위 누름은 기존 onTap 취소 경로(같은 탭이 새 고리 0)', async () => {
  const m = await mount();
  const press = (target: unknown) => m.act(() => { for (const f of evs.pointerdown || []) f({ target }); });
  await m.down(); await m.up(1, 1); expect(m.pop()).toBeTruthy();
  await press(m.pop()); expect(m.pop()).toBeTruthy();                                   // 창 안
  await press(m.btn(/^선택$/)); expect(m.pop()).toBeFalsy(); expect(R.mc.wps).toHaveLength(0);   // 도구줄 = 창 밖
  await m.down(); await m.up(1, 1); expect(m.pop()).toBeTruthy();
  await press({ getAttribute: (k: string) => (k === 'data-live-map' ? 'plan' : null) }); expect(m.pop()).toBeTruthy();   // 지도 캔버스는 여기서 안 닫음
  await m.down(); await m.up(2, 2); expect(m.pop()).toBeFalsy(); expect(R.mc.wps).toHaveLength(0);   // onTap = 취소만
  await m.down(); await m.up(2, 2); expect(m.pop()).toBeTruthy();                                     // 다음 누름은 정상
  expect(evs.pointerdown ?? []).toHaveLength(1);
  await m.click(/^지점 확인/); expect(m.pop()).toBeFalsy(); expect(evs.pointerdown ?? []).toHaveLength(0);   // 창 닫히면 리스너 해제
});

// ---- R3b 저장 관문(715 발견 · ROOT GO): ⑤ 말고 C0 «이 초안 저장»·404 «새 문서로 저장» 도 새 문서는 종료 방식 필수 · 기존 id 옛 계획은 키 없음 그대로 ----
const posts: any[] = [];
const reply = (...rs: [number, unknown][]) => { posts.length = 0; vi.spyOn(T, 'postDocs').mockImplementation((async (b: unknown) => { posts.push(b); const [status, body] = rs.shift() ?? [500, { error: 'x' }]; return { status, body: JSON.stringify(body) }; }) as any); };
const OK = (id: string): [number, unknown] => [200, { ok: true, id, rev: 1, kind: 'mission', name: '', new: true }];

test('R3b 저장 관문 C0: 주소 문서와 다른 새 초안 «이 초안 저장» = 종료 방식 없으면 요청 0·초안 그대로 · 고른 뒤 1회(같은 값)', async () => {
  R.q = new URLSearchParams('mission=m9'); reply(OK('m2'));
  const m = await mount();
  await m.down(); await m.up(1, 1); await m.click(/^지점 확인/);
  expect(m.text()).toContain('요청한 문서 «찾지 못함»');
  await m.click(/^이 초안 저장$/);
  expect(posts).toHaveLength(0); expect(R.toasts[R.toasts.length - 1]).toBe('③ 종료 방식을 고르세요'); expect(R.mc.wps).toHaveLength(1);
  await m.click(/^출발점 복귀$/); await m.act(() => props(nameIn(m.host)).onChange({ target: { value: '새 계획' }, currentTarget: { value: '새 계획' } }));
  await m.click(/^이 초안 저장$/);
  expect(posts).toHaveLength(1); expect(posts[0]).toMatchObject({ op: 'put', kind: 'mission', id: null, doc: { name: '새 계획', finish: '출발점 복귀' } });
});

test('R3b 저장 관문 404: 옛 계획(id·키 없음) 저장 = 키 없이 1회(양성) · 지워짐 → «새 문서로 저장»(id 없음) = 종료 방식 없으면 요청 0 · 고른 뒤 새 문서 1회', async () => {
  drafts.set('mission:PcPlan', { id: 'm1', rev: 1, d: { name: '옛 계획', tmpl: 'base', memo: '', wps: [{ x: 1, y: 1, name: '가', mods: ['사진'] }] } });
  reply([404, { error: '없음' }], OK('m3'));
  const m = await mount();
  await m.click(/^변경 저장$/);
  expect(posts).toHaveLength(1); expect(posts[0]).toMatchObject({ op: 'put', id: 'm1', rev: 1 }); expect('finish' in posts[0].doc).toBe(false);
  await m.click(/^새 문서로 저장$/);
  expect(posts).toHaveLength(1); expect(R.toasts[R.toasts.length - 1]).toBe('③ 종료 방식을 고르세요');
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
