import { afterEach, expect, test, vi } from 'vitest';
// U2-b 폰(root «MMap 장착 별도 묶음»): 실제 MMap 을 createRoot(가짜 DOM)에 장착. 대체 = View(받은 v 만 잡음)·MapCanvas(받은 props 만 잡음)·link ask/sendOp/sendStop(기록).
// 확인: 폰 bar(겹침 배치 아님 · lv-btn · 시뮬 실행은 서랍이라는 title) · 같은 보기 선택 · 지도 보기 중 지점 고르기·구역·길 잠금 · 읽기 op 만 · 실행 지형 그대로 ·
// 실제 View 장착(가짜 DOM)에서 bar 가 머리줄(header) 안 · 지도 칸 밖(지도 안 오른쪽 위 단추·왼쪽 위 안내·범례와 다른 상자).
const R = vi.hoisted(() => ({ asked: [] as string[], sent: [] as string[], v: null as any, mc: null as any }));
vi.mock('../../src/data/link', async (orig) => ({ ...(await orig<typeof import('../../src/data/link')>()),
  ask: (op: string) => { R.asked.push(op); return Promise.resolve(op === 'map_list' ? { op: 'reply', ok: true, maps: MAPS } : { op: 'reply', ok: false, text: '시험 — 그림 안 받음' }); },
  sendOp: (op: string) => { R.sent.push(op); return true; }, sendStop: () => { R.sent.push('stop'); return true; } }));
vi.mock('../../src/app/shell', async (orig) => ({ ...(await orig<typeof import('../../src/app/shell')>()), toast: () => {} }));
vi.mock('../../src/screens/MMap.view', async (orig) => ({ ...(await orig<typeof import('../../src/screens/MMap.view')>()), View: ({ v }: { v: any }) => { R.v = v; return v.map ?? null; } }));   // 지도 칸만 그림(MapCanvas 대체가 받은 props 를 잡게)
vi.mock('../../src/map/MapCanvas', async (orig) => ({ ...(await orig<typeof import('../../src/map/MapCanvas')>()), MapCanvas: (p: any) => { R.mc = p; return null; } }));
const MAPS = vi.hoisted(() => [
  { world_id: 'v5_single', building_id: 'v5_single', floor_id: 'f1', map_version: 'gt-20261001', map_source: 'gt_raster', epoch: null, resolution: 0.05, origin: [0, 0, 0], width: 10, height: 10 },
  { world_id: 'v5_building', building_id: 'v5', floor_id: 'l1', map_version: '20261011-100000-e1', map_source: 'slam', epoch: 1, resolution: 0.05, origin: [0, 0, 0], width: 10, height: 10 }]);
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
  get options() { return this.children.filter((c) => c.nodeName === 'OPTION'); }   // select 장착(React updateOptions)
  addEventListener() {} removeEventListener() {}
}
const doc: any = { addEventListener() {}, removeEventListener() {}, nodeType: 9, fullscreenElement: null, activeElement: null, hidden: false, documentElement: new N('HTML'), body: new N('BODY'),
  createElement: (t: string) => new N(t.toUpperCase()), createElementNS: (_: string, t: string) => new N(t.toUpperCase()), createTextNode: (s: string) => Object.assign(new N('#text', 3), { nodeValue: s }), querySelectorAll: () => [] };
Object.assign(globalThis, { window: globalThis, document: doc, addEventListener() {}, removeEventListener() {}, IS_REACT_ACT_ENVIRONMENT: true, HTMLIFrameElement: class {},
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, location: { href: 'http://127.0.0.1/', protocol: 'http:', hash: '', search: '', pathname: '/' } });
vi.spyOn(console, 'error').mockImplementation(() => {});

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { QueryClientProvider } = await import('@tanstack/react-query');
const { qc } = await import('../../src/data/shared');
const { useLink } = await import('../../src/data/link');
const MMap = (await import('../../src/screens/MMap')).default;
const ser = (n: N): string => n.nodeType === 3 ? n.nodeValue : `<${n.nodeName.toLowerCase()}${Object.entries(n.attrs).map(([k, v]) => ` ${k}="${v}"`).join('')}>${n._t}${n.children.map(ser).join('')}</${n.nodeName.toLowerCase()}>`;   // 가짜 DOM → 글(속성·순서 확인용)
const RealView = (await vi.importActual<typeof import('../../src/screens/MMap.view')>('../../src/screens/MMap.view')).View;

const SESS = { runner: 'live_map', result: 'running', world_id: 'v5_building', floor_id: 'l1', map_mode: 'slam' };
const roots: any[] = [];
afterEach(async () => { for (const r of roots.splice(0)) await React.act(async () => r.unmount()); R.asked = []; R.sent = []; });
const wrap = (el: any) => React.createElement(QueryClientProvider, { client: qc }, el);
const mount = async () => {
  qc.clear(); for (const k of ['docs', 'media']) qc.setQueryDefaults([k], { staleTime: Infinity, retry: false, retryOnMount: false, refetchOnMount: false });
  qc.setQueryData(['docs'], { docs: [], rev: 2 });
  useLink.setState({ open: true, gen: 1, stGen: 1, lastMsg: performance.now(), provider: 'simulation_gate', st: { map_start: { session: SESS }, live_map: null, applied: [0, 0, 0] } as any });   // applied = linkView «보내는 명령» 글(실제 상태엔 항상 있음)
  const root: any = createRoot(new N('DIV') as any); roots.push(root);
  await React.act(async () => { root.render(wrap(React.createElement(MMap))); });
};
const bar = () => R.v.mapBar, btns = () => bar().props.children[1].props.children as any[];

test('폰 bar: 겹침 배치 아님(흐름 · 머리줄 CSS 가 자리) · lv-btn · 시뮬 실행은 서랍 «지도 열기»라고 말함 · 기본 지형 = 실행 지형', async () => {
  await mount();
  expect([bar().props.style.position, bar().props.style.padding, bar().props.style.borderBottom, bar().props.style.minWidth]).toEqual([undefined, undefined, undefined, 0]);   // 폰 = 머리줄 안 흐름(PC 도구줄 아래 줄의 여백·선 없음)
  expect(bar().props['data-mapview-bar']).toBe('');
  const sel = bar().props.children[0];
  expect([sel.props.value, sel.props.title, sel.props.style.minHeight]).toEqual(['v5_building', expect.stringContaining('서랍의 «지도 열기»'), 40]);
  expect([sel.props.style.flex, bar().props.children[1].props.style.flex]).toEqual(['0 0 auto', '0 0 auto']);   // 폰: 지형·단추 묶음은 안 꺾임(이유 글만 다음 줄)
  expect(btns().map((b) => [b.props.className, b.props.children])).toEqual([['lv-btn lv-why', '2D'], ['lv-btn', '3D'], ['lv-btn', 'SLAM']]);   // 2D = 1층 GT 없음 → aria-disabled(누르면 이유 글 · 31d235b R4)
});

test('같은 보기 선택 + 지도 보기 중 잠금: 고르기 전 지점 고르기·구역·길 켬 → 3D/SLAM/2D 고르면 지점 고르기·구역·길 끔(좌표 미결속) · 읽기 op 만 · 실행 세션 그대로', async () => {
  await mount();
  const lock0 = () => [typeof R.mc?.onTap, R.mc?.showZones, R.mc?.showTrail];
  await React.act(async () => { useLink.setState({ lastMsg: performance.now() }); });
  expect(R.v.map).toBeTruthy();
  expect(lock0()).toEqual(['function', true, true]);
  await React.act(async () => { btns()[2].props.onClick(); });   // SLAM = 실행 중 SLAM → 실시간
  expect([lock0(), R.v.hint]).toEqual([['undefined', false, false], '지도 보기 중 · 지점 고르기 꺼짐']);
  await React.act(async () => { btns()[1].props.onClick(); });   // 3D = 입체 기하(MapCanvas 대신 Geom3D 자리 — 그림 전엔 MapCanvas 그대로 잠금)
  expect([btns()[1].props['aria-pressed'], R.v.hint]).toEqual([true, '지도 보기 중 · 지점 고르기 꺼짐']);
  await React.act(async () => { bar().props.children[0].props.onChange({ target: { value: 'v5_single' } }); });   // 지형 바꿈(3D 없음 → 2D)
  expect([bar().props.children[0].props.value, btns()[0].props['aria-pressed'], lock0()]).toEqual(['v5_single', true, ['undefined', false, false]]);
  expect(R.asked.every((o) => ['map_list', 'map_get', 'map_live_get', 'geom_get'].includes(o))).toBe(true); expect(R.sent).toEqual([]);
  expect(useLink.getState().st).toEqual({ map_start: { session: SESS }, live_map: null, applied: [0, 0, 0] });
});

test('실제 View 장착: bar 는 머리줄(header) 안 · 지도 레이어 단추 앞 · 지도 칸(오른쪽 위 단추·왼쪽 위 안내 상자)보다 앞·밖', async () => {
  await mount();
  const host = new N('DIV'), root: any = createRoot(host as any); roots.push(root);   // 서버 렌더는 zustand 구독(getServerSnapshot 없음)이라 불가 → 가짜 DOM 에 실제 장착
  await React.act(async () => { root.render(wrap(React.createElement(RealView, { v: R.v }))); });
  const s = ser(host);
  const i = { h0: s.indexOf('<header'), bar: s.indexOf('data-mapview-bar'), fab: s.indexOf('aria-label="지도 보기·레이어"'), h1: s.indexOf('</header>'), hint: s.indexOf(`>${R.v.hint}<`) };   // 안내 상자(지도 칸 안 왼쪽 위) — 앞 시험의 보기 선택이 남아도 그 글 그대로
  expect(i.hint).toBeGreaterThan(0);
  expect(i.h0 < i.bar && i.bar < i.fab && i.fab < i.h1 && i.h1 < i.hint).toBe(true);
  expect(s.match(/data-mapview-bar/g)!.length).toBe(1);
});

test('live.css 폰 머리줄 자리: 세로 = 자기 줄(order 4 · 100%) · 가로 낮은 화면(MMap LAND_CSS 와 같은 조건) = 제목 옆(order 0)', async () => {
  const fsm = 'node:fs';   // ui_u2 와 같은 방식(css ?raw 는 vitest 에서 빈 글)
  const css: string = (await import(/* @vite-ignore */ fsm)).readFileSync(new URL('../../src/live.css', import.meta.url), 'utf8');
  expect(css).toContain('.mmap-hdr>header>[data-mapview-bar]{order:4;flex:1 1 100%}');
  expect(css).toContain('@media (orientation: landscape) and (max-height: 500px){.mmap-hdr>header>[data-mapview-bar]{order:0;flex:0 1 auto}}');
});
