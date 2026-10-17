import { afterEach, expect, test, vi } from 'vitest';
// SLAM-1 r2(715 CODEX-DESIGN-REVIEW R1·R2 · root «사본 검토 보완»): helper 직접 호출이 아니라 실제 «시뮬 ▾»(SimMenu → SimRun → MapStartBox)를
// createRoot(가짜 DOM)에 장착·해제·재장착해 메뉴 닫기(일시 소멸)·다시 열기(새 양식)·선택 변경·true 직후 STOP/숨김/이탈을 본다.
// 대체 = link.ask(기록만 · 응답 즉시) · shell.toast. askPage/answerAsk/startGen/sendStop/hide/dropAsk 는 실제 코드.
// 팝오버 위치(usePop·placePop)는 가짜 사각형 값 — 실제 위치·포커스·바깥 누름 닫기는 670 화면 QA 몫. ※ 이 파일은 사본 — 미실행.
const R = vi.hoisted(() => ({ asked: [] as any[] }));
vi.mock('../../src/data/link', async (orig) => ({ ...(await orig<typeof import('../../src/data/link')>()),
  ask: (op: string, extra: Record<string, unknown> = {}) => { R.asked.push({ op, ...extra }); return Promise.resolve({ op: 'reply', ok: true, text: '시험 — 요청 수락' }); } }));
vi.mock('../../src/app/shell', async (orig) => ({ ...(await orig<typeof import('../../src/app/shell')>()), toast: () => {} }));
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
  addEventListener() {} removeEventListener() {}
  getBoundingClientRect() { return { left: 0, top: 0, right: 80, bottom: 30, width: 80, height: 30, x: 0, y: 0 }; }
}
const evs: Record<string, ((...a: any[]) => void)[]> = {};
const on = (k: string, f: any) => { (evs[k] ||= []).push(f); }, off = (k: string, f: any) => { evs[k] = (evs[k] || []).filter((g) => g !== f); };
const doc: any = { addEventListener: on, removeEventListener: off, nodeType: 9, fullscreenElement: null, activeElement: null, hidden: false, documentElement: new N('HTML'), body: new N('BODY'),
  createElement: (t: string) => new N(t.toUpperCase()), createElementNS: (_: string, t: string) => new N(t.toUpperCase()), createTextNode: (s: string) => Object.assign(new N('#text', 3), { nodeValue: s }),
  querySelectorAll: () => [], querySelector: () => null };
Object.assign(globalThis, { window: globalThis, document: doc, addEventListener: on, removeEventListener: off, IS_REACT_ACT_ENVIRONMENT: true, HTMLIFrameElement: class {}, innerWidth: 1280, innerHeight: 800,
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, location: { href: 'http://127.0.0.1/#/MDrive', protocol: 'http:', hash: '#/MDrive', search: '', pathname: '/' } });
vi.spyOn(console, 'error').mockImplementation(() => {});

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const L = await import('../../src/data/link');
const { SimMenu } = await import('../../src/app/status');
const { MapStartBox } = await import('../../src/map/MapStartBox');
const mapsModule = await import('../../src/data/maps');
const all = (n: N): N[] => [n, ...n.children.flatMap(all)];
const props = (n: N): any => Object.entries(n).find(([k]) => k.startsWith('__reactProps$'))![1];
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const ST = { op: 'status', ver: 'v1', role: 'control', latch: true, resume_pending: false, reset_pending: false, sim_block: '시뮬 상태 미수신', episode: 1, state_age: 0.1, cam_age: null,
  docs_rev: 1, applied: [0, 0, 0], events: [], reason: '', me: 'pc', holder: null, stop_gen: 1, sim_start: { ok: true, why: '', busy: false, session: null },
  map_start: { ok: true, why: '', busy: false, ledger: null, session: null, last: null, usage_scope: 'user_experience', follow_cam_ok: true } };
const fresh = () => L.useLink.setState({ open: true, bad: null, gen: 1, stGen: 1, lastMsg: performance.now(), provider: 'simulation_gate', viewOnly: false, st: structuredClone(ST) as any });
const starts = () => R.asked.filter((m) => m.op === 'map_start' || m.op === 'sim_start');
const roots: any[] = [];
afterEach(async () => { L.answerAsk(false); for (const r of roots.splice(0)) await React.act(async () => r.unmount()); R.asked = []; (globalThis as any).location.hash = '#/MDrive'; await flush(); });

// 실제 «시뮬 ▾» 하나 — toggle = 메뉴 단추 onClick(usePop): 열기 = 본문(SimRun·MapStartBox) 장착 = 새 양식, 닫기 = 본문 해제(일시 소멸)
const menu = async () => {
  fresh();
  const host = new N('DIV'), root: any = createRoot(host as any); roots.push(root);
  await React.act(async () => { root.render(React.createElement(SimMenu)); });
  const b = all(host).find((n) => n.attrs['data-simmenu'] !== undefined)!;
  const toggle = async () => { await React.act(async () => { props(b).onClick(); }); };
  const box = () => all(host).find((n) => n.attrs.id === 'fh-mapopen') ?? null;
  const startBtn = () => all(box()!).find((n) => n.nodeName === 'BUTTON' && n.textContent === '시뮬 실행')!;
  const terrain = () => all(box()!).find((n) => n.nodeName === 'SELECT' && n.attrs['aria-label'] === '시작 지형')!;
  const chooseTerrain = (w: string) => props(terrain()).onChange({ target: { value: w } });
  const start = async () => { let p: Promise<unknown> | undefined; await React.act(async () => { const s = startBtn(); p = props(s).onClick({ currentTarget: s }); }); return [p!] as const; };   // act 를 끝까지 기다림(겹친 act 0) · 확인 대기 promise 는 배열로 넘김(await 로 풀리지 않게)
  return { host, toggle, box, startBtn, terrain, chooseTerrain, start };
};
const asking = () => L.useAsk.getState().text;

const META = (w: string, b: string, f: string) => ({ world_id: w, building_id: b, floor_id: f, map_source: 'gt_raster', map_version: 'gt-test', epoch: null, width: 200, height: 200, resolution: 0.1, origin: [0, 0, 0] });
const CATALOG = [META('v5_single', 'v5_single', 'f1'), META('v5_building', 'v5', 'l1'), META('v5_building', 'v5', 'l2')] as any;
const previewBox = async () => {
  fresh();
  const host = new N('DIV'), root: any = createRoot(host as any); roots.push(root);
  await React.act(async () => { root.render(React.createElement(MapStartBox, { pc: true, part: 'open', preview: true, catalog: CATALOG })); });
  return { host, choose: (w: string) => props(all(host).find((n) => n.attrs['aria-label'] === '시작 지형')!).onChange({ target: { value: w } }),
    run: () => all(host).find((n) => n.nodeName === 'BUTTON' && n.textContent === '시뮬 실행')! };
};
const raster = (src: string) => ({ img: { src }, w: 200, h: 200, res: 0.1, ox: 0, oy: 0, label: src }) as any;

test('관제: 미선택/불러오는 중은 실행 불가 · 바뀐 지형의 늦은 그림 폐기 · 현재 2D 도면 후에만 실행 가능', async () => {
  const pending: ((r: any) => void)[] = [];
  const get = vi.spyOn(mapsModule, 'getMap').mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
  try {
    const M = await previewBox();
    expect(props(M.run()).disabled).toBe(true); expect(get).not.toHaveBeenCalled();
    expect(M.host.textContent).not.toContain('만든 지도 보관');
    await React.act(async () => { M.choose('v5_single'); });
    expect(props(M.run()).disabled).toBe(true);
    await React.act(async () => { M.choose('v5_building'); });
    await React.act(async () => { pending[0](raster('old-single')); });
    expect(props(M.run()).disabled).toBe(true); expect(all(M.host).filter((n) => n.nodeName === 'IMG')).toHaveLength(0);
    await React.act(async () => { pending[1](raster('current-building-l1')); });
    expect(props(M.run()).disabled).toBe(false);
    expect(all(M.host).find((n) => n.nodeName === 'IMG')!.attrs.src).toBe('current-building-l1');
    const l2 = all(M.host).find((n) => n.nodeName === 'BUTTON' && n.textContent === '2층(l2)')!;
    await React.act(async () => { props(l2).onClick(); });
    expect(props(M.run()).disabled).toBe(true); expect(get.mock.calls[get.mock.calls.length - 1][0].floor_id).toBe('l2');
    expect(starts()).toHaveLength(0);
  } finally { get.mockRestore(); }
});

test('관제: 미리보기 실패는 실행 차단 · 다시 받기 성공 뒤 활성 · 서버 시작 불가 관문 유지', async () => {
  const get = vi.spyOn(mapsModule, 'getMap').mockResolvedValueOnce('PNG 풀기 실패').mockResolvedValue(raster('retry-ok'));
  try {
    const M = await previewBox(); await React.act(async () => { M.choose('v5_single'); });
    expect(props(M.run()).disabled).toBe(true); expect(M.host.textContent).toContain('PNG 풀기 실패');
    const retry = all(M.host).find((n) => n.nodeName === 'BUTTON' && n.textContent === '미리보기 다시 받기')!;
    await React.act(async () => { props(retry).onClick(); });
    expect(props(M.run()).disabled).toBe(false);
    await React.act(async () => { L.useLink.setState({ st: { ...ST, map_start: { ...ST.map_start, ok: false, why: '실행 중' } } as any }); });
    expect(props(M.run()).disabled).toBe(true); expect(starts()).toHaveLength(0);
  } finally { get.mockRestore(); }
});

test('관제: 새 매핑 공간은 기존 도면 없음 명시 · 선택 전 시작 0 · 선택 뒤 빈 공간 안내', async () => {
  const get = vi.spyOn(mapsModule, 'getMap');
  try {
    const M = await previewBox(); expect(props(M.run()).disabled).toBe(true);
    await React.act(async () => { M.choose('rooms_a'); });
    expect(M.host.textContent).toContain('기존 도면 없음'); expect(M.host.textContent).toContain('실행 후 지도가 만들어집니다');
    expect(props(M.run()).disabled).toBe(false); expect(get).not.toHaveBeenCalled(); expect(starts()).toHaveLength(0);
  } finally { get.mockRestore(); }
});

test('정상: 메뉴에서 «지도 열기» → 확인창 → 메뉴 닫힘(본문 해제 · 일시 소멸) → 확인 = map_start 1회(고른 값 그대로)', async () => {
  const M = await menu(); await M.toggle(); expect(M.box()).not.toBe(null);
  const [p] = await M.start();
  expect(asking()).toMatch(/^시뮬을 실행할까요/);
  await M.toggle(); expect(M.box()).toBe(null);                  // 확인창을 누르면 바깥 누름으로 메뉴가 닫히는 것과 같은 상태(본문 해제)
  expect(asking()).not.toBe(null);                               // 일시 소멸만으로는 확인창 무효 0(R1)
  fresh(); await React.act(async () => { L.answerAsk(true); }); await p; await flush();
  expect(starts().length).toBe(1); expect(starts()[0]).toMatchObject({ op: 'map_start', world_id: 'rooms_a', floor_id: 'f1', mode: 'slam' });   // 상자 기본 선택(rooms_a/f1) 그대로
});

test('다시 열기 = 새 양식: 옛 확인창 닫힘 · 그 뒤 옛 창에 true 가 와도 보낸 것 0 · 새 상자에 «안 보냄 · 새 시작 양식이 열림»', async () => {
  const M = await menu(); await M.toggle(); const [p] = await M.start();
  await M.toggle(); await M.toggle();                            // 닫았다 다시 엶 → 새 MapStartBox 장착 → mapFormOpen → 옛 송신 전 요청 무효
  expect(asking()).toBe(null);
  fresh(); await React.act(async () => { L.answerAsk(true); }); await p; await flush();
  expect(starts().length).toBe(0);
  expect(M.box()!.textContent).toMatch(/안 보냄 · 시작 확인 취소 · 새 시작 양식이 열림.*보낸 것 0/);
});

test('다시 열기 + 새 선택: 새 양식의 확인만 보냄(옛 선택 0) · 1회', async () => {
  const M = await menu(); await M.toggle(); const [p1] = await M.start();
  await M.toggle(); await M.toggle(); await p1;
  expect(M.terrain().options.filter((n) => n.attrs.value).map((n) => [n.attrs.value, n.textContent])).toEqual([
    ['v5_single', '1층 건물'], ['v5_building', '2층 건물'], ['rooms_a', '새 매핑 공간'],
  ]);
  await React.act(async () => { M.chooseTerrain('v5_building'); });
  expect(props(M.terrain()).value).toBe('v5_building');
  expect(starts()).toHaveLength(0);
  const [p2] = await M.start();
  fresh(); await React.act(async () => { L.answerAsk(true); }); await p2; await flush();
  expect(starts().length).toBe(1);
  expect(starts()[0]).toMatchObject({ world_id: 'v5_building', floor_id: 'l1' });
});

test('드롭다운 변경 = 렌더 전 동기 무효: 확인창이 열린 채 지형을 바꾸면 창 닫힘 · 그 뒤 true 0', async () => {
  const M = await menu(); await M.toggle(); const [p] = await M.start();
  await React.act(async () => { M.chooseTerrain('v5_building'); });
  expect(asking()).toBe(null);
  fresh(); await React.act(async () => { L.answerAsk(true); }); await p; await flush();
  expect(starts().length).toBe(0); expect(M.box()!.textContent).toMatch(/고른 지형·층·카메라/);
});

test('true 로 답한 같은 틱에 드롭다운 변경·STOP·숨김·화면 이동 → 송신 직전 대조로 보낸 것 0', async () => {
  const acts: [string, (M: Awaited<ReturnType<typeof menu>>) => void, RegExp][] = [
    ['드롭다운 변경', (M) => { M.chooseTerrain('v5_building'); }, /고른 지형·층·카메라 바뀜/],
    ['STOP', () => { L.sendStop(); }, /STOP·숨김·이탈/],
    ['숨김', () => { L.hide(); }, /STOP·숨김·이탈/],
    ['화면 이동', () => { (globalThis as any).location.hash = '#/Main'; (evs.hashchange || []).slice().forEach((f) => f()); }, /화면 바뀜/],
  ];
  for (const [name, act, re] of acts) {
    const M = await menu(); await M.toggle(); const [p] = await M.start();
    fresh(); await React.act(async () => { L.answerAsk(true); act(M); }); await p; await flush();   // answerAsk(true) 와 act 가 같은 동기 구간 — 이어지는 송신 판단은 그 뒤 microtask
    expect([name, starts().length]).toEqual([name, 0]);
    const box = M.box(); if (box) expect(box.textContent).toMatch(re);
    for (const r of roots.splice(0)) await React.act(async () => r.unmount()); (globalThis as any).location.hash = '#/MDrive';
  }
});

test('새 주인(다른 시작 상자)이 장착되면 옛 상자 확인은 무효 · 새 상자 확인만 1회 · 옛 결과가 새 결과를 덮지 않음', async () => {
  const M = await menu(); await M.toggle(); const [p1] = await M.start();
  const host2 = new N('DIV'), r2: any = createRoot(host2 as any); roots.push(r2);
  await React.act(async () => { r2.render(React.createElement(MapStartBox, { pc: true })); });   // 다른 화면·다른 상자 = 새 양식
  expect(asking()).toBe(null); await p1;
  const b2 = all(host2).find((n) => n.nodeName === 'BUTTON' && n.textContent === '시뮬 실행')!;
  let p2: Promise<unknown> | undefined; await React.act(async () => { p2 = props(b2).onClick({ currentTarget: b2 }); });
  fresh(); await React.act(async () => { L.answerAsk(true); }); await p2; await flush();
  expect(starts().length).toBe(1);
  expect(host2.textContent).toContain('요청 수락'); expect(host2.textContent).not.toMatch(/새 시작 양식이 열림/);   // 마지막 결과 = 새 상자 것
});
