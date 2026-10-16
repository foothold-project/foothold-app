import { afterEach, expect, test, vi } from 'vitest';
// 670 a9db ①②③ 보완(root «MMap P1/P2 협소화 보완» · 설계 DESIGN.md r2): 폰 이유 글 한 줄 + ? 전문 · «고른 목표» 안 스크롤·지도 최소 96 은 높이 조건 없이 ·
// 낮은 창(높이 ≤ 500)만 바깥 여백·비상호작용 padding 줄임(STOP·메뉴·단추 크기 0) · Geom3D 덧칸 맞춤은 MMap 명시 opt-in(fit3d)만.
// 실제 MMap·Geom3D 를 createRoot(가짜 DOM)에 장착(ui_u2b_mmap 방식). 화면 배치·높이 실측은 670 몫(여기서는 규칙·분기만).
const R = vi.hoisted(() => ({ asked: [] as string[], sent: [] as string[], v: null as any, H: 96 }));
vi.mock('../../src/data/link', async (orig) => ({ ...(await orig<typeof import('../../src/data/link')>()),
  ask: (op: string) => { R.asked.push(op); return Promise.resolve(op === 'map_list' ? { op: 'reply', ok: true, maps: MAPS } : { op: 'reply', ok: false, text: '시험 — 그림 안 받음' }); },
  sendOp: (op: string) => { R.sent.push(op); return true; }, sendStop: () => { R.sent.push('stop'); return true; } }));
vi.mock('../../src/app/shell', async (orig) => ({ ...(await orig<typeof import('../../src/app/shell')>()), toast: () => {} }));
vi.mock('../../src/screens/MMap.view', async (orig) => ({ ...(await orig<typeof import('../../src/screens/MMap.view')>()), View: ({ v }: { v: any }) => { R.v = v; return null; } }));
vi.mock('../../src/map/MapCanvas', async (orig) => ({ ...(await orig<typeof import('../../src/map/MapCanvas')>()), MapCanvas: () => null }));
const MAPS = vi.hoisted(() => [
  { world_id: 'v5_building', building_id: 'v5', floor_id: 'l1', map_version: '20261011-100000-e1', map_source: 'slam', epoch: 1, resolution: 0.05, origin: [0, 0, 0], width: 10, height: 10 }]);
class N {
  children: N[] = []; parentNode: N | null = null; attrs: Record<string, string> = {}; style: Record<string, any> = { setProperty(k: string, v: string) { (this as any)[k] = v; } };
  nodeValue = ''; _t = ''; namespaceURI = 'http://www.w3.org/1999/xhtml'; isConnected = true; dataset: Record<string, string> = {};
  constructor(public nodeName: string, public nodeType = 1) {}
  get tagName() { return this.nodeName; } get ownerDocument() { return doc; }
  get firstChild() { return this.children[0] ?? null; } get lastChild() { return this.children[this.children.length - 1] ?? null; }
  get textContent(): string { return this.nodeType === 3 ? this.nodeValue : this._t + this.children.map((c) => c.textContent).join(''); }
  set textContent(v: string) { this.children = []; this._t = v; }
  get clientWidth() { return 320; } get clientHeight() { return R.H; } get scrollHeight() { return 150; }   // 캔버스 칸 높이 = R.H · 덧칸 내용 높이 = 150(층 단추+범례+칩 3개 어림)
  width = 0; height = 0;
  getContext() { return new Proxy({}, { get: (_, k) => (k === 'measureText' ? () => ({ width: 10 }) : () => {}), set: () => true }); }
  setPointerCapture() {}
  appendChild(c: N) { c.parentNode?.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
  insertBefore(c: N, b: N) { c.parentNode?.removeChild(c); c.parentNode = this; this.children.splice(this.children.indexOf(b), 0, c); return c; }
  removeChild(c: N) { this.children.splice(this.children.indexOf(c), 1); c.parentNode = null; return c; }
  setAttribute(k: string, v: string) { this.attrs[k] = String(v); } removeAttribute(k: string) { delete this.attrs[k]; } getAttribute(k: string) { return this.attrs[k] ?? null; }
  get options() { return this.children.filter((c) => c.nodeName === 'OPTION'); }
  addEventListener() {} removeEventListener() {}
}
const doc: any = { addEventListener() {}, removeEventListener() {}, nodeType: 9, fullscreenElement: null, activeElement: null, hidden: false, documentElement: new N('HTML'), body: new N('BODY'),
  createElement: (t: string) => new N(t.toUpperCase()), createElementNS: (_: string, t: string) => new N(t.toUpperCase()), createTextNode: (s: string) => Object.assign(new N('#text', 3), { nodeValue: s }), querySelectorAll: () => [] };
Object.assign(globalThis, { window: globalThis, document: doc, addEventListener() {}, removeEventListener() {}, IS_REACT_ACT_ENVIRONMENT: true, HTMLIFrameElement: class {}, devicePixelRatio: 1,
  ResizeObserver: class { observe() {} disconnect() {} }, getComputedStyle: () => ({ getPropertyValue: () => '' }),
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, location: { href: 'http://127.0.0.1/', protocol: 'http:', hash: '', search: '', pathname: '/' } });
vi.spyOn(console, 'error').mockImplementation(() => {});

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { QueryClientProvider } = await import('@tanstack/react-query');
const { qc } = await import('../../src/data/shared');
const { useLink } = await import('../../src/data/link');
const MMap = (await import('../../src/screens/MMap')).default;
const { Geom3D } = await import('../../src/map/Geom3D');
const all = (n: N): N[] => [n, ...n.children.flatMap(all)];
const fsm = 'node:fs', rd = async (f: string) => (await import(/* @vite-ignore */ fsm)).readFileSync(new URL(f, import.meta.url), 'utf8') as string;

const roots: any[] = [];
afterEach(async () => { for (const r of roots.splice(0)) await React.act(async () => r.unmount()); R.asked = []; R.sent = []; R.H = 96; });
const wrap = (el: any) => React.createElement(QueryClientProvider, { client: qc }, el);
const put = async (el: any) => { const host = new N('DIV'), root: any = createRoot(host as any); roots.push(root); await React.act(async () => { root.render(wrap(el)); }); return host; };

test('① 폰 bar 이유 글 = 같은 줄 한 칸(9em · 말줄임 한 줄) + ? 전문 · 요청·op 0', async () => {
  qc.clear(); for (const k of ['docs', 'media']) qc.setQueryDefaults([k], { staleTime: Infinity, retry: false, retryOnMount: false, refetchOnMount: false });
  qc.setQueryData(['docs'], { docs: [], rev: 2 });
  useLink.setState({ open: true, gen: 1, stGen: 1, lastMsg: performance.now(), provider: 'simulation_gate', st: { map_start: { session: null }, live_map: null, applied: [0, 0, 0] } as any });
  await put(React.createElement(MMap));
  await React.act(async () => { useLink.setState({ lastMsg: performance.now() }); });
  const bar = () => R.v.mapBar, b2d = bar().props.children[1].props.children[0];
  expect(b2d.props['aria-disabled']).toBe('true');   // 1층 GT 없음 → 못 봄 단추
  const n0 = R.asked.length;
  await React.act(async () => { b2d.props.onClick(); });
  const w = bar().props.children[2], [line, help] = w.props.children.filter((c: any) => typeof c === 'object');   // 같은 줄 공백 글(JSX) 제외
  expect([w.props.style.flex, w.props.style.width, w.props.style.minWidth]).toEqual(['1 1 9em', '9em', 0]);   // flex-basis 100% 아님 → 머리줄을 여러 줄로 밀지 않음
  expect([line.props.role, line.props.style.whiteSpace, line.props.style.textOverflow, line.props.style.overflow]).toEqual(['status', 'nowrap', 'ellipsis', 'hidden']);
  expect(line.props.children).toMatch(/^2D 못 봄 · /); expect(line.props.title).toBe(line.props.children);   // 이유 글은 동률 아님 → 짧은 줄 = 전문
  expect([help.props.label, help.props.children]).toEqual(['지도 보기 안내 · 전문', line.props.children]);
  expect(R.asked.length).toBe(n0); expect(R.sent).toEqual([]);
});

test('① 소스: PC bar 이유 글은 그대로(flex-basis 100% 전문) · 폰 동률 줄은 받기 결과(tieR 와 같은 말)를 앞에', async () => {
  const mp = await rd('../../src/map/MapPick.tsx');
  expect(mp).toMatch(/pc \? <span role="status" style=\{\{ flexBasis: '100%'[^}]*\}\}>\{`\$\{msg\.t\}\$\{msg\.tie \? tieR : ''\}`\}<\/span>/);
  expect(mp).toContain("msg.tie ? `${!raster ? (serr ? '받기 실패' : '받는 중') : '표시 중'} · ${msg.t}` : msg.t");
  expect(mp).toContain("<Help label=\"지도 보기 안내 · 전문\">{`${msg.t}${msg.tie ? tieR : ''}`}</Help>");   // ? 전문 = 동률이면 받기 결과까지(위 ①은 동률 아님 — 변이 «Help 전문 빠짐» 보완)
  expect(mp).toMatch(/const tieR = !raster \? \(serr \? ' · 받기 실패 — 그림 없음\(가운데 이유\)' : ' · 받는 중'\) : ' · 표시 중';/);   // 짧은 말의 출처
});

test('② LAND_CSS: 고른 목표 안 스크롤·지도 최소 96 은 높이 조건 없이 · 낮은 창(≤ 500)은 여백·padding 만(크기 속성 0)', async () => {
  const m = await rd('../../src/screens/MMap.tsx'), css = m.match(/const LAND_CSS = `([^`]*)`/)![1];
  const [base, low] = css.split('@media (max-height: 500px){');
  expect(base).toContain('#dc-root section[aria-label="고른 목표"]{min-height:0!important;overflow-y:auto!important}');
  expect(base).toContain('#dc-root div:has(>svg[role="img"][preserveAspectRatio]){min-height:96px!important}');
  expect(base).not.toMatch(/@media/);
  const props = [...low.matchAll(/\{([^}]*)\}/g)].flatMap((x) => x[1].split(';').filter(Boolean).map((d) => d.split(':')[0]));
  expect(props.length).toBeGreaterThan(0);
  expect(props.every((p) => /^(padding|margin)-(top|bottom)$/.test(p))).toBe(true);   // STOP·메뉴·단추 크기(height·min-height·font) 변경 0
  expect(low).toContain('div:has(>button[aria-label="비상 정지"])'); expect(low).toContain('nav[aria-label="주 메뉴"]');
});

test('③ fit3d 는 MMap 만 명시(기본 거짓) · PcMap·Main·MDrive 호출 그대로', async () => {
  const mp = await rd('../../src/map/MapPick.tsx');
  // U2-c: 첫 인자 이름 overlay → drop(뜻: 관제 오른쪽 칸 드롭다운)
  expect(mp).toContain('export function useMapPick(drop = true, pc = false, fit3d = false)'); expect(mp).toContain('fit={fit3d}');
  expect(await rd('../../src/screens/MMap.tsx')).toContain('useMapPick(false, false, true)');
  expect(await rd('../../src/screens/PcMap.tsx')).toContain('useMapPick(false, true)');
  expect(await rd('../../src/screens/Main.tsx')).toContain('useMapPick()');
  expect(await rd('../../src/screens/MDrive.tsx')).toContain('useMapPick(false)');
});

const G = { building_id: 'v5', label: 'L', sdf_sha256: {}, floors: [{ floor_id: 'l1', z: 0 }, { floor_id: 'l2', z: 2.4 }],
  boxes: [{ id: 'b', floor_id: 'l1', kind: 'floor', corners: Array.from({ length: 8 }, (_, i) => [i & 4 ? 1 : 0, i & 2 ? 1 : 0, i & 1 ? 0.1 : 0]), aabb: [0, 0, 0, 1, 1, 0.1] }], meshes: [], connectors: [] } as any;
const ov = (h: N) => all(h).find((n) => n.nodeName === 'DIV' && n.style.bottom === '8px' && n.style.left === '8px')!;   // 덧칸(왼쪽 아래 한 열 · React 는 숫자 style 에 px 붙여 넣음)

test('③ Geom3D 덧칸: fit + 작은 칸(96)만 맞춤(위 60 비움 · 덧칸 안 스크롤) · fit 거짓 또는 큰 칸은 그대로', async () => {
  const o1 = ov(await put(React.createElement(Geom3D, { g: G, bind: 'ok', fit: true })));
  expect([o1.attrs['data-g3d-tight'], o1.style.maxHeight, o1.style.overflowY, o1.style.pointerEvents]).toEqual(['', 'calc(100% - 60px)', 'auto', 'auto']);
  const o2 = ov(await put(React.createElement(Geom3D, { g: G, bind: 'ok' })));   // PcMap·Main(fit 기본 거짓)
  expect([o2.attrs['data-g3d-tight'], o2.style.maxHeight, o2.style.overflowY, o2.style.pointerEvents]).toEqual([undefined, undefined, undefined, 'none']);
  R.H = 400;
  const o3 = ov(await put(React.createElement(Geom3D, { g: G, bind: 'ok', fit: true })));   // 폰이어도 칸이 크면 그대로
  expect([o3.attrs['data-g3d-tight'], o3.style.maxHeight, o3.style.pointerEvents]).toEqual([undefined, undefined, 'none']);
  const fl = all(o1).filter((n) => n.nodeName === 'BUTTON').map((n) => n.textContent);
  expect(fl).toEqual(['전체 비교', '1층만', '2층만']);   // 층 단추는 덧칸 첫 줄 그대로(스크롤 시 먼저 보임)
});
