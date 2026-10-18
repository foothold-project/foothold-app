import { afterAll, afterEach, beforeEach, expect, test, vi } from 'vitest';
// G4(ROOT-IMPLEMENT 5·12 · UX-SPEC 3-1·4·5-7 · 10-19): 실제 Fleet 을 createRoot(가짜 DOM)에 장착해 조회 기억·비교 막힘·조종 입구 정리를 본다.
// 본다: 우선순위 URL > localStorage > (목록 1개면 그것) > 고르세요 · 저장은 사용자가 고를 때만 · 없는 프로젝트/배치안 id 를 다른 것으로 바꾸지 않음(안내 + 기억 유지)
//       · 다른 프로젝트를 고르면 옛 배치안 기억 비움 · localStorage 예외 = 기본값 · «비교» = 프로젝트·검토 결과 없으면 이유와 함께 막힘 · Fleet 안 «조종 화면» 링크 0.
// 대체 = 읽기 hook 3개(useProjects·useProject·useSavedAnalysis — 응답 고정 · 실제 직렬 읽기는 rehearsal 시험) · SceneCanvas · PcFrame(머리+본문) · toast.
// 한계: 실제 주소창·저장소 거부 브라우저 동작·배치는 670 실브라우저 몫.
const R = vi.hoisted(() => ({ P: null as any, G: {} as Record<string, any>, A: null as any, asked: [] as (string | null)[], toasts: [] as string[] }));
vi.mock('../../src/app/fleetui', async (orig) => { const m = await orig<any>(), React = await import('react');
  return { ...m, PcFrame: ({ head, children }: any) => React.createElement('div', null, head, children),
    useProjects: () => R.P, useProject: (id: string | null) => { R.asked.push(id); return id && R.G[id] ? R.G[id] : { st: id ? 'loading' : 'idle', reload() {} }; },
    useSavedAnalysis: () => R.A }; });
vi.mock('../../src/map/SceneCanvas', async (orig) => { const m = await orig<any>(), React = await import('react');
  return { ...m, SceneCanvas: () => React.createElement('div', { 'data-cv': '' }) }; });
vi.mock('../../src/app/shell', async (orig) => ({ ...(await orig<any>()), toast: (t: string) => { R.toasts.push(t); } }));
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
const evs: Record<string, ((...a: any[]) => void)[]> = {};
const on = (k: string, f: any) => { (evs[k] ||= []).push(f); }, off = (k: string, f: any) => { evs[k] = (evs[k] || []).filter((g) => g !== f); };
const doc: any = { addEventListener() {}, removeEventListener() {}, nodeType: 9, fullscreenElement: null, activeElement: null, hidden: false, documentElement: new N('HTML'), body: new N('BODY'),
  createElement: (t: string) => new N(t.toUpperCase()), createElementNS: (_: string, t: string) => new N(t.toUpperCase()), createTextNode: (s: string) => Object.assign(new N('#text', 3), { nodeValue: s }),
  querySelectorAll: () => [], querySelector: () => null };
const store = new Map<string, string>(), LS = { bad: false, writes: [] as string[] };
const loc = { href: 'http://127.0.0.1/#/Fleet', protocol: 'http:', hash: '#/Fleet', search: '', pathname: '/' };
const FAKE = { window: globalThis, document: doc, addEventListener: on, removeEventListener: off, IS_REACT_ACT_ENVIRONMENT: true, HTMLIFrameElement: class {}, innerWidth: 1000, innerHeight: 900,
  localStorage: { getItem: (k: string) => { if (LS.bad) throw new Error('denied'); return store.get(k) ?? null; },
    setItem: (k: string, v: string) => { if (LS.bad) throw new Error('denied'); LS.writes.push(`${k}=${v}`); store.set(k, v); },
    removeItem: (k: string) => { if (LS.bad) throw new Error('denied'); LS.writes.push(`${k}-`); store.delete(k); } },
  location: loc, HashChangeEvent: class { constructor(public type: string) {} }, dispatchEvent: (e: any) => { for (const f of evs[e.type] || []) f(e); return true; },
  history: { replaceState: (_: unknown, __: string, u: string) => { loc.hash = u.slice(u.indexOf('#')); } } };
const SAVED = Object.keys(FAKE).map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)] as const);
Object.assign(globalThis, FAKE);
const errs: unknown[][] = [], ceSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errs.push(a); });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { QueryClientProvider } = await import('@tanstack/react-query');
const { qc } = await import('../../src/data/shared');
const { T } = await import('../../src/data/transport');
const RH = await import('../../src/data/rehearsal');
const Fleet = (await import('../../src/screens/Fleet')).default;
const tGet = vi.spyOn(T, 'get').mockImplementation((() => new Promise(() => {})) as any);   // 사건 기록(useMedia) 응답 없음

const all = (n: N): N[] => [n, ...n.children.flatMap(all)];
const props = (n: N): any => Object.entries(n).find(([k]) => k.startsWith('__reactProps$'))![1];
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const roots: any[] = [];
const META = (id: string, rev = 1) => ({ id, name: `n-${id}`, rev, sha256: 'a'.repeat(64), bytes: 100, counts: {}, at: '2026-10-18' });
const EX = RH.exampleScene();
const proj = (id: string) => ({ st: 'ok', data: { project: META(id), scene: RH.exampleScene() }, reload() {} });   // 프로젝트·재조회마다 새 scene 객체(실제 hook 처럼 신원이 다름 — 715 T1)
beforeEach(() => { store.clear(); store.set('fh.fleet.mode', 'rehearsal'); LS.bad = false; LS.writes = []; R.asked = []; R.toasts = []; errs.length = 0; loc.hash = '#/Fleet';
  R.P = { st: 'ok', data: { projects: [META('a'), META('b')] }, reload() {} }; R.G = { a: proj('a'), b: proj('b') }; R.A = { st: 'idle' }; });
afterEach(async () => { for (const r of roots.splice(0)) await React.act(async () => r.unmount()); expect(errs.map((a) => String(a[0]).slice(0, 200))).toEqual([]); });
afterAll(() => { try { ceSpy.mockRestore(); tGet.mockRestore(); } finally { for (const [k, d] of SAVED) { if (d) Object.defineProperty(globalThis, k, d); else delete (globalThis as any)[k]; } } });

const mount = async (hash = '#/Fleet') => {
  loc.hash = hash; LS.writes = [];
  const host = new N('DIV'), root: any = createRoot(host as any); roots.push(root);
  const draw = async () => { await React.act(async () => { root.render(React.createElement(QueryClientProvider, { client: qc }, React.createElement(Fleet))); }); await React.act(flush); };
  await draw();
  const sel = (lab: string) => all(host).find((n) => n.nodeName === 'SELECT' && n.parentNode?.textContent.startsWith(lab))!;
  const pick = async (lab: string, v: string) => { await React.act(async () => { props(sel(lab)).onChange({ target: { value: v } }); }); await React.act(flush); };
  return { host, sel, pick, draw, val: (lab: string) => props(sel(lab)).value as string, text: () => host.textContent };
};
const lastAsk = () => R.asked[R.asked.length - 1];

test('우선순위: URL project·sc > localStorage — URL 로 열어도 기억 값 덮음 0(사용자가 고를 때만 저장)', async () => {
  store.set('fh.fleet.pid', 'a'); store.set('fh.fleet.sc', EX.scenarios[0].id);
  const m = await mount(`#/Fleet?project=b&sc=${EX.scenarios[1].id}`);
  expect(m.val('프로젝트')).toBe('b'); expect(lastAsk()).toBe('b'); expect(m.val('배치안')).toBe(EX.scenarios[1].id);
  expect(LS.writes.filter((w) => w.startsWith('fh.fleet.pid') || w.startsWith('fh.fleet.sc'))).toEqual([]);
});

test('localStorage 만: 기억 프로젝트·배치안 바로 보임 · 기억 없으면 첫 배치안(지금 규칙)', async () => {
  store.set('fh.fleet.pid', 'a'); store.set('fh.fleet.sc', EX.scenarios[1].id);
  const m = await mount();
  expect(m.val('프로젝트')).toBe('a'); expect(m.val('배치안')).toBe(EX.scenarios[1].id);
  store.delete('fh.fleet.sc'); await React.act(async () => roots.pop().unmount());
  const m2 = await mount();
  expect(m2.val('배치안')).toBe(EX.scenarios[0].id);
});

test('첫 진입 목록 1개 = 그것(기억 저장 0) · 2개 이상이고 기억 없음 = 고르세요', async () => {
  R.P = { st: 'ok', data: { projects: [META('a')] }, reload() {} };
  const m = await mount();
  expect(m.val('프로젝트')).toBe('a'); expect(LS.writes).toEqual([]);
  R.P = { st: 'ok', data: { projects: [META('a'), META('b')] }, reload() {} }; await React.act(async () => roots.pop().unmount());
  const m2 = await mount();
  expect(m2.val('프로젝트')).toBe(''); expect(m2.text()).toContain('위에서 프로젝트를 고르세요');
});

test('없는 id: 다른 프로젝트로 바꿈 0 · 안내 «목록에 없습니다 · id» · 기억 유지 · 목록 1개여도 자동 선택 0', async () => {
  store.set('fh.fleet.pid', 'zz'); R.P = { st: 'ok', data: { projects: [META('a')] }, reload() {} };
  const m = await mount();
  expect(m.text()).toContain('고른 프로젝트가 목록에 없습니다 · zz'); expect(R.asked).not.toContain('a'); expect(store.get('fh.fleet.pid')).toBe('zz');
});

test('없는 배치안 id: «전체» + 안내 · 다른 배치안으로 바꿈 0 · 기억 유지', async () => {
  store.set('fh.fleet.pid', 'a'); store.set('fh.fleet.sc', 'nope');
  const m = await mount();
  expect(m.val('배치안')).toBe(''); expect(m.text()).toContain('고른 배치안이 이 판에 없습니다 · nope'); expect(store.get('fh.fleet.sc')).toBe('nope');
});

test('사용자가 고름 = 저장 + 주소 반영 · 다른 프로젝트 = 옛 배치안 기억 비움 · 배치안 고름 = 저장', async () => {
  store.set('fh.fleet.pid', 'a'); store.set('fh.fleet.sc', EX.scenarios[1].id);
  const m = await mount();
  await m.pick('프로젝트', 'b');
  expect(store.get('fh.fleet.pid')).toBe('b'); expect(store.has('fh.fleet.sc')).toBe(false); expect(loc.hash).toContain('project=b');
  expect(m.val('배치안')).toBe(EX.scenarios[0].id);   // 새 프로젝트 = 첫 배치안
  await m.pick('배치안', EX.scenarios[1].id);
  expect(store.get('fh.fleet.sc')).toBe(EX.scenarios[1].id); expect(loc.hash).toContain(`sc=${EX.scenarios[1].id}`);
});

// G4FIX(ROOT5 기억 보완): «전체»도 고른 값으로 기억(기억 없음과 구분) · 같은 프로젝트 재읽기 = 지금 선택 유지 · 없어진 배치안만 «전체» + 안내.
// 재읽기 = 새 판(rev+1 · scene 새 객체)을 hook 이 돌려주는 것으로 대체(실제 읽기는 rehearsal 시험) → 다시 그림.
const reread = async (m: Awaited<ReturnType<typeof mount>>, drop?: string) => {
  R.G.a = { st: 'ok', data: { project: META('a', 2), scene: { ...EX, scenarios: EX.scenarios.filter((x: any) => x.id !== drop) } }, reload() {} }; await m.draw(); };

test('G4FIX 전체 → 다른 탭 왕복: «전체» 그대로(첫 배치안으로 바뀜 0) · 기억 = scAll 표지(sc id 없음)', async () => {
  store.set('fh.fleet.pid', 'a'); store.set('fh.fleet.sc', EX.scenarios[1].id);
  const m = await mount();
  await m.pick('배치안', '');
  expect(m.val('배치안')).toBe(''); expect(store.has('fh.fleet.sc')).toBe(false); expect(store.get('fh.fleet.scAll')).toBe('1');
  await React.act(async () => roots.pop().unmount());
  const m2 = await mount();
  expect(m2.val('배치안')).toBe(''); expect(m2.text()).not.toContain('고른 배치안이 이 판에 없습니다');
  await m2.pick('배치안', EX.scenarios[1].id);   // 다시 id 를 고르면 «전체» 표지 지움
  expect(store.get('fh.fleet.sc')).toBe(EX.scenarios[1].id); expect(store.has('fh.fleet.scAll')).toBe(false);
});

test('G4FIX 두 번째 배치안 → 계획 다시 읽기(같은 프로젝트 새 판): 그대로 · «전체» 도 그대로', async () => {
  store.set('fh.fleet.pid', 'a');
  const m = await mount();
  expect(m.val('배치안')).toBe(EX.scenarios[0].id);   // 기억 없음 = 첫 배치안(지금 규칙)
  await m.pick('배치안', EX.scenarios[1].id);
  await reread(m);
  expect(m.text()).toContain('읽은 판 r2'); expect(m.val('배치안')).toBe(EX.scenarios[1].id); expect(m.text()).not.toContain('고른 배치안이 이 판에 없습니다');
  await m.pick('배치안', ''); LS.writes = [];
  R.G.a = proj('a'); await m.draw();   // 판이 또 바뀜(r1 객체)
  expect(m.val('배치안')).toBe(''); expect(LS.writes).toEqual([]);   // 재읽기는 기억을 쓰지 않음
});

test('G4FIX 없어진 배치안(재읽기 새 판에 없음): «전체» + 안내 · 다른 배치안으로 바꿈 0 · 기억 유지 · 다음 재읽기에도 안내 유지', async () => {
  store.set('fh.fleet.pid', 'a');
  const m = await mount();
  await m.pick('배치안', EX.scenarios[1].id); LS.writes = [];
  await reread(m, EX.scenarios[1].id);
  expect(m.val('배치안')).toBe(''); expect(m.text()).toContain(`고른 배치안이 이 판에 없습니다 · ${EX.scenarios[1].id}`);
  expect(store.get('fh.fleet.sc')).toBe(EX.scenarios[1].id); expect(LS.writes).toEqual([]);
  R.G.a = { ...R.G.a, data: { ...R.G.a.data, scene: { ...R.G.a.data.scene } } }; await m.draw();
  expect(m.val('배치안')).toBe(''); expect(m.text()).toContain(`고른 배치안이 이 판에 없습니다 · ${EX.scenarios[1].id}`);
});

test('localStorage 예외 = 기본값(화면 그대로 · 오류 0) · 고르기도 그대로 동작', async () => {
  LS.bad = true;
  const m = await mount();
  expect(m.val('프로젝트')).toBe('');
  await m.pick('프로젝트', 'a'); expect(m.val('프로젝트')).toBe('a');
});

test('비교(960–1279 서랍 단추): 프로젝트 없음·검토 결과 없음 = 이유와 함께 막힘(서랍 0) · 결과 있으면 열림 · Fleet 안 «조종 화면» 링크 0', async () => {
  const cmp = (m: Awaited<ReturnType<typeof mount>>) => all(m.host).find((n) => n.nodeName === 'BUTTON' && n.textContent === '비교')!;
  const m = await mount();
  // FIX2: whyProps 는 shell 모듈 안의 toast 를 직접 불러 export mock(R.toasts)에 안 찍힘 → 실제 Toast 를 장착해 화면 표시로 본다(전체화면 0 = InFs 제자리)
  const { Toast } = await import('../../src/app/shell');
  const th = new N('DIV'), tr: any = createRoot(th as any); roots.push(tr);
  await React.act(async () => { tr.render(React.createElement(Toast)); });
  const shown = () => all(th).find((n) => n.attrs['data-live-toast'] === '1')?.textContent;
  expect(shown()).not.toBe('프로젝트를 고르면 비교할 수 있습니다');
  expect(cmp(m).attrs['aria-disabled']).toBe('true'); expect(cmp(m).attrs.title).toBe('프로젝트를 고르면 비교할 수 있습니다');
  const asked0 = R.asked.length; let pd = 0;
  await React.act(async () => { props(cmp(m)).onClick({ preventDefault() { pd++; }, stopPropagation() {} }); });
  expect(shown()).toBe('프로젝트를 고르면 비교할 수 있습니다'); expect(pd).toBe(1); expect(R.asked.slice(asked0).filter(Boolean)).toEqual([]);   // 막힘 = 이유 표시 · 기본 동작 0 · 프로젝트 조회 0(useProject 는 렌더마다 불려 null 만 허용)
  expect(m.text()).not.toContain('배치안 비교');
  await m.pick('프로젝트', 'a');
  expect(cmp(m).attrs.title).toBe('검토 결과가 아직 없습니다');
  expect(all(m.host).filter((n) => n.nodeName === 'A' && n.attrs.href === '#/Main')).toEqual([]);
  expect(m.text()).not.toContain('조종 화면');
});
