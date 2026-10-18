import { afterAll, expect, test, vi } from 'vitest';
// G1(ROOT-IMPLEMENT 1·2 · 10-19): App 수준 공통 STOP 하나 — 실제 main.tsx 입구가 가짜 #root 에 App 을 장착(react-dom 18 createRoot).
// 본다: ① 모든 route(모르는 화면 · 로그인 · 화면 여는 중 Suspense)에서 «비상 정지» 단추 정확히 1개 · body 포털(transform 조상 0)
//       ② 활성 전체화면 요소가 있으면 그 안으로 옮김(여전히 1개) · 문서 전체 전체화면(MDrive)은 body 그대로
//       ③ 누름(pointerdown·Enter) → sendStop 1회 · ④ App 이 단 keydown 리스너 1개, Space 1 → 1회 · 길게 누름(repeat) 0 · 입력칸·IME 0
// ⑤ 끝(afterAll): 실제 입구가 만든 root 를 unmount → keydown 리스너 0 · 포털 STOP 0 · 가짜 전역 원래대로(단일 fork 다른 파일 오염 0).
// 한계: 좌표(top 8 · right 12 · 144×64)·가림·실제 터치는 CSS·실브라우저 몫(670 QA rect 측정). 여기는 개수·장착 위치·송신 0/1 의미만.
const K = { win: new Map<string, Set<(e: any) => void>>(), doc: new Map<string, Set<(e: any) => void>>() };
const on = (m: typeof K.win) => ({ addEventListener: (t: string, f: any) => { if (!m.has(t)) m.set(t, new Set()); m.get(t)!.add(f); }, removeEventListener: (t: string, f: any) => { m.get(t)?.delete(f); } });
class N {   // 가짜 요소/글 노드(최소 메서드 — ui_ask_mount 방식)
  children: N[] = []; parentNode: N | null = null; attrs: Record<string, string> = {}; style: Record<string, any> = { setProperty(k: string, v: string) { (this as any)[k] = v; } };
  nodeValue = ''; _t = ''; namespaceURI = 'http://www.w3.org/1999/xhtml'; isConnected = true; dataset: Record<string, string> = {};
  constructor(public nodeName: string, public nodeType = 1) {}
  get tagName() { return this.nodeName; } get ownerDocument() { return doc; }
  get firstChild() { return this.children[0] ?? null; } get lastChild() { return this.children[this.children.length - 1] ?? null; }
  get textContent(): string { return this.nodeType === 3 ? this.nodeValue : this._t + this.children.map((c) => c.textContent).join(''); }
  set textContent(v: string) { this.children = []; this._t = v; }
  appendChild(c: N) { c.parentNode?.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
  insertBefore(c: N, b: N) { c.parentNode?.removeChild(c); c.parentNode = this; this.children.splice(this.children.indexOf(b), 0, c); return c; }
  removeChild(c: N) { this.children.splice(this.children.indexOf(c), 1); c.parentNode = null; return c; }
  setAttribute(k: string, v: string) { this.attrs[k] = String(v); } removeAttribute(k: string) { delete this.attrs[k]; } getAttribute(k: string) { return this.attrs[k] ?? null; }
  addEventListener() {} removeEventListener() {} focus() {}
  getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, x: 0, y: 0, width: 0, height: 0 }; }
  all(): N[] { return [this, ...this.children.flatMap((c) => c.all())]; }
}
const ROOT = new N('DIV'), FS = new N('DIV');
const doc: any = { ...on(K.doc), nodeType: 9, fullscreenElement: null, activeElement: null, hidden: false, documentElement: new N('HTML'), body: new N('BODY'),
  createElement: (t: string) => new N(t.toUpperCase()), createElementNS: (_: string, t: string) => new N(t.toUpperCase()), createTextNode: (s: string) => Object.assign(new N('#text', 3), { nodeValue: s }),
  getElementById: (id: string) => (id === 'root' ? ROOT : null), querySelector: () => null, querySelectorAll: () => [] };
const FAKE = { window: globalThis, document: doc, ...on(K.win), innerWidth: 1440, innerHeight: 900, IS_REACT_ACT_ENVIRONMENT: true, HTMLIFrameElement: class {},
  navigator: { userAgent: 'node' }, history: { replaceState() {}, pushState() {} },   // 첫 입구 해시 교체 0 → 시험이 고른 route 유지
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  location: { href: 'http://127.0.0.1/#/NoSuch', protocol: 'http:', host: '127.0.0.1', hash: '#/NoSuch', search: '', pathname: '/' },
  requestAnimationFrame: () => 0, cancelAnimationFrame: () => {} };
const SAVED = Object.keys(FAKE).map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)] as const);   // 원래 전역(없으면 undefined) — afterAll 에서 되돌림
for (const [k, v] of Object.entries(FAKE)) Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });   // Node 22 navigator = getter 만 → assign 불가 · afterAll 이 SAVED descriptor 로 되돌림

// 송신만 가짜(링크 상태·stopNow·확인 경로는 실제) · 입구 부수효과(WS 열기·테마 감시·개발자 모드)는 끔 · 로그인 화면 본문은 빈 컴포넌트(공통 STOP 만 봄)
const sendStop = vi.fn(() => true);
vi.mock('../../src/data/link', async (orig) => ({ ...(await orig<any>()), sendStop: () => sendStop(), startLink: () => {} }));
vi.mock('../../src/app/theme', () => ({ syncTheme: () => {} }));
vi.mock('../../src/data/dev', async (orig) => ({ ...(await orig<any>()), devStart: () => {} }));
vi.mock('../../src/screens/PcLogin', () => ({ default: () => null }));
vi.mock('../../src/screens/MLogin', () => ({ default: () => null }));
const roots: { unmount(): void }[] = [];   // 실제 main 의 createRoot 를 얇게 추적만(동작 그대로) — 끝에서 unmount
vi.mock('react-dom/client', async (orig) => { const o = await orig<any>(); return { ...o, createRoot: (...a: any[]) => { const r = o.createRoot(...a); roots.push(r); return r; } }; });

const React = await import('react');
await React.act(async () => { await import('../../src/main'); });   // 실제 입구: createRoot(#root).render(<App />)
const { STOP_TIP } = await import('../../src/data/facts');   // FIX2b(ROOT 결정 1): 화면별 STOP 설명이 빠진 대신 공용 STOP title = 기존 STOP_TIP

afterAll(async () => {
  try {   // FIX2(ROOT G1-R2): 단언·해제가 실패해도 전역 descriptor 는 반드시 복구(뒤 파일 오염 0)
    expect(roots.length).toBe(1);   // 입구는 root 하나
    await React.act(async () => { for (const r of roots) r.unmount(); });
    expect(K.win.get('keydown')?.size ?? 0).toBe(0);   // useStopKey 정리 — 재장착 때 리스너 2개 0
    expect(stops().length).toBe(0);   // 포털 STOP 도 같이 빠짐(body·전체화면 요소에 남는 단추 0)
  } finally {
    for (const [k, d] of SAVED) { if (d) Object.defineProperty(globalThis, k, d); else delete (globalThis as any)[k]; }
  }
});

const stops = () => [...ROOT.all(), ...doc.body.all(), ...FS.all(), ...doc.documentElement.all()].filter((n) => n.nodeName === 'BUTTON' && n.attrs['aria-label'] === '비상 정지');
const where = (n: N) => { let p: N | null = n; while (p && p !== doc.body && p !== FS && p !== ROOT) p = p.parentNode; return p === doc.body ? 'body' : p === FS ? 'fs' : p === ROOT ? 'root' : 'none'; };
const props = (n: N) => (n as any)[Object.keys(n).find((k) => k.startsWith('__reactProps'))!];
const go = async (hash: string) => { location.hash = hash; await React.act(async () => { for (const f of K.win.get('hashchange') ?? []) f({}); }); };
const fsTo = async (el: unknown) => { doc.fullscreenElement = el; await React.act(async () => { for (const f of K.doc.get('fullscreenchange') ?? []) f({}); }); };
const key = (x: Record<string, unknown>) => { const e = { code: 'Space', key: ' ', repeat: false, isComposing: false, keyCode: 32, target: doc.body, preventDefault: vi.fn(), ...x };
  for (const f of K.win.get('keydown') ?? []) f(e); return e; };

test('① 모든 route 에 공통 STOP 정확히 1개 — body 포털, 이름표 «비상 정지», 인쇄 제외 클래스', async () => {
  for (const h of ['#/NoSuch', '#/PcLogin', '#/MLogin']) {   // 모르는 화면 · 로그인 2화면(ROOT 최신: 로그인 포함) — 처음 여는 lazy 화면은 미해결 = 화면 여는 중(Suspense) 상태
    location.hash = h; React.act(() => { for (const f of K.win.get('hashchange') ?? []) f({}); });   // 동기 act: lazy 가 풀리기 전 프레임도 본다
    const s = stops(); expect(s.length, h).toBe(1); expect(where(s[0]), h).toBe('body');
    expect(s[0].attrs.class).toContain('fh-stop'); expect(s[0].attrs.class).toContain('lv-noprint'); expect(s[0].attrs['data-fh-stop']).toBe('1');
    expect(s[0].attrs.title, h).toBe(STOP_TIP);
  }
  await go('#/NoSuch'); expect(stops().length).toBe(1);
});

test('② 전체화면 요소 안으로 옮김(여전히 1개) · 문서 전체 전체화면은 body 그대로 · 끝나면 body 로', async () => {
  await go('#/NoSuch');
  await fsTo(FS); expect(stops().length).toBe(1); expect(where(stops()[0])).toBe('fs');
  await fsTo(doc.documentElement); expect(stops().length).toBe(1); expect(where(stops()[0])).toBe('body');   // MDrive(documentElement) = 원래 자리도 보임
  await fsTo(null); expect(stops().length).toBe(1); expect(where(stops()[0])).toBe('body');
});

test('③ 누름 = sendStop 1회(pointerdown · Enter) · 다른 키 0', async () => {
  const p = props(stops()[0]);
  sendStop.mockClear(); await React.act(async () => { p.onPointerDown({}); }); expect(sendStop).toHaveBeenCalledTimes(1);
  sendStop.mockClear(); await React.act(async () => { p.onKeyDown({ key: 'Enter' }); }); expect(sendStop).toHaveBeenCalledTimes(1);
  sendStop.mockClear(); await React.act(async () => { p.onKeyDown({ key: 'a' }); }); expect(sendStop).toHaveBeenCalledTimes(0);
});

test('④ Space: App 한 리스너 · 1회 → 1 · 길게 누름 반복 0(기본 동작은 막음) · 입력칸·IME·다른 키 0(기본 동작 그대로)', async () => {
  expect(K.win.get('keydown')?.size).toBe(1);   // useStopKey 는 App 에서 1회 — 화면별 중복 리스너 0
  sendStop.mockClear();
  let e = key({}); expect(sendStop).toHaveBeenCalledTimes(1); expect(e.preventDefault).toHaveBeenCalled();
  e = key({ repeat: true }); expect(sendStop).toHaveBeenCalledTimes(1); expect(e.preventDefault).toHaveBeenCalled();   // 화면 스크롤도 0
  const inp = new N('INPUT'), sel = new N('SELECT'), ce = Object.assign(new N('DIV'), { isContentEditable: true });
  for (const x of [{ target: inp }, { target: sel }, { target: ce }, { isComposing: true }, { keyCode: 229 }, { code: 'Enter', key: 'Enter' }]) {
    e = key(x); expect(sendStop).toHaveBeenCalledTimes(1); expect(e.preventDefault).not.toHaveBeenCalled();
  }
});
