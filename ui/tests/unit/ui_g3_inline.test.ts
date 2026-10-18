import { afterAll, afterEach, beforeEach, expect, test, vi } from 'vitest';
// ROOT CODEX-G3 R1·R2(10-19 · UX-SPEC 2-3): «상태 ▾» 는 떠 있는 패널 자리가 없으면 토스트·닫힘 대신 본문 흐름 안(인라인)으로 펼친다.
// 본다: ① 자리 없음(창 높이 40) → 인라인 region 1개(data-pop-inline · 내용 = 상세 행) · 떠 있는 span 숨김 · 토스트 0 · aria-controls = 인라인 id · popOpen() 참
//       ② Esc = 그 패널만 닫힘 → popOpen() 거짓 · 리스너 정리 ③ 자리 있음(창 900) → 떠 있는 패널(style 좌표) · 인라인 0 — 기존 경로 그대로
// 한계: 실제 줄바꿈·밀림 픽셀·STOP/프로젝트 칸 겹침 rect 는 실브라우저(670 QA) 몫. 여기는 갈래·접근성 속성·수명만.
const T0 = vi.hoisted(() => ({ toasts: [] as string[] }));
vi.mock('../../src/app/shell', async (orig) => ({ ...(await orig<any>()), toast: (t: string) => { T0.toasts.push(t); } }));
class N {
  children: N[] = []; parentNode: N | null = null; attrs: Record<string, string> = {}; style: Record<string, any> = { setProperty(k: string, v: string) { (this as any)[k] = v; } };
  nodeValue = ''; _t = ''; namespaceURI = 'http://www.w3.org/1999/xhtml'; isConnected = true;
  constructor(public nodeName: string, public nodeType = 1) {}
  get tagName() { return this.nodeName; } get ownerDocument() { return doc; }
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
const evs: Record<string, ((e: any) => void)[]> = {};
const on = (k: string, f: any) => { (evs[k] ||= []).push(f); }, off = (k: string, f: any) => { evs[k] = (evs[k] || []).filter((g) => g !== f); };
const doc: any = { addEventListener() {}, removeEventListener() {}, nodeType: 9, fullscreenElement: null, activeElement: null, hidden: false, documentElement: new N('HTML'), body: new N('BODY'),
  createElement: (t: string) => new N(t.toUpperCase()), createElementNS: (_: string, t: string) => new N(t.toUpperCase()), createTextNode: (s: string) => Object.assign(new N('#text', 3), { nodeValue: s }),
  querySelectorAll: () => [], querySelector: () => null };
const FAKE = { window: globalThis, document: doc, addEventListener: on, removeEventListener: off, IS_REACT_ACT_ENVIRONMENT: true, HTMLIFrameElement: class {}, innerWidth: 390, innerHeight: 40,
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, location: { href: 'http://127.0.0.1/#/Main', protocol: 'http:', hash: '#/Main', search: '', pathname: '/' } };
const SAVED = Object.keys(FAKE).map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)] as const);
Object.assign(globalThis, FAKE);
afterAll(() => { for (const [k, d] of SAVED) { if (d) Object.defineProperty(globalThis, k, d); else delete (globalThis as any)[k]; } });   // 단일 fork 다른 파일 오염 0

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useLink } = await import('../../src/data/link');
const { StatusMore } = await import('../../src/app/status');
const { popOpen } = await import('../../src/app/chip');
const all = (n: N): N[] => [n, ...n.children.flatMap(all)];
const props = (n: N): any => Object.entries(n).find(([k]) => k.startsWith('__reactProps$'))![1];
const roots: any[] = [];
beforeEach(() => { T0.toasts = []; useLink.setState({ provider: 'simulation_gate', open: true, lastMsg: performance.now(), bad: null, st: { role: 'control', latch: false, sim_block: '', applied: [0, 0, 0] } } as any); });
afterEach(async () => { for (const r of roots.splice(0)) await React.act(async () => r.unmount()); expect(popOpen()).toBe(false); expect(evs.keydown ?? []).toHaveLength(0); });

const mount = async () => {
  const host = new N('DIV'), root: any = createRoot(host as any); roots.push(root);
  await React.act(async () => root.render(React.createElement(StatusMore)));
  const btn = () => all(host).find((n) => n.nodeName === 'BUTTON' && /^상태 /.test(n.textContent))!;
  const regions = () => [...all(host), ...all(doc.body)].filter((n) => n.attrs.role === 'region' && n.attrs['aria-label'] === '상태 상세');
  return { host, btn, regions, open: () => React.act(async () => { props(btn()).onClick({}); }) };
};

test('① 자리 없음 → 인라인(본문 흐름 안) · 내용 접근 가능 · 토스트·닫힘 0 · aria-controls 이음 · popOpen 참', async () => {
  (globalThis as any).innerHeight = 40;
  const m = await mount(); await m.open();
  const inl = m.regions().filter((n) => n.attrs['data-pop-inline'] === '1'); expect(inl).toHaveLength(1);
  expect(inl[0].attrs.class).toBe('lv-pop-inline'); expect(inl[0].textContent).toContain('관문 · '); expect(inl[0].textContent).toContain('잠금 · ');
  expect(m.host.contains(inl[0])).toBe(true);   // 머리줄 안(포털 0)
  const fl = m.regions().filter((n) => n.attrs['data-pop-inline'] !== '1'); expect(fl.every((n) => 'hidden' in n.attrs)).toBe(true);
  expect(T0.toasts).toEqual([]); expect(m.btn().attrs['aria-expanded']).toBe('true'); expect(m.btn().attrs['aria-controls']).toBe(inl[0].attrs.id);
  expect(fl.every((n) => !n.attrs.id)).toBe(true);   // 같은 id 둘 0
  expect(popOpen()).toBe(true);
  // ② Esc = 이 패널만 닫힘
  await React.act(async () => { for (const f of [...(evs.keydown || [])]) f({ key: 'Escape' }); });
  expect(m.regions().filter((n) => n.attrs['data-pop-inline'] === '1')).toHaveLength(0); expect(m.btn().attrs['aria-expanded']).toBe('false');
  expect(popOpen()).toBe(false); expect(evs.keydown ?? []).toHaveLength(0); expect(evs.pointerdown ?? []).toHaveLength(0);
});

test('③ 자리 있음 → 기존 떠 있는 패널(좌표 style) · 인라인 0 · 토스트 0', async () => {
  (globalThis as any).innerHeight = 900;
  const m = await mount(); await m.open();
  expect(m.regions().filter((n) => n.attrs['data-pop-inline'] === '1')).toHaveLength(0);
  const fl = m.regions().find((n) => !('hidden' in n.attrs))!; expect(fl).toBeTruthy(); expect(fl.attrs.class).toBe('lv-pop');
  expect(m.btn().attrs['aria-controls']).toBe(fl.attrs.id); expect(T0.toasts).toEqual([]); expect(popOpen()).toBe(true);
  (globalThis as any).innerHeight = 40;
});
