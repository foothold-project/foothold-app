import { afterEach, expect, test, vi } from 'vitest';
// SLAM-1 r3(10-18 요청 2·5·7 반영 · 715 R1·R2 · root «사본 검토 보완»): helper 직접 호출이 아니라 실제 «시뮬 실행» 칸(SimRun → MapStartBox — Main 오른쪽 칸 · 폰 MMap 본문과 같은 상자)을
// createRoot(가짜 DOM)에 장착·해제·재장착해 칸 사라짐(일시 소멸)·다시 장착(새 양식)·선택 변경·true 직후 STOP/숨김/이탈을 본다. 10-18: 상단 «시뮬 ▾»(SimMenu) 삭제 → 장착 대상 = SimRun.
// 대체 = link.ask(기록만 · 응답 즉시 · R.reply 로 op 별 답 바꿈) · shell.toast · maps.getMap(시험 그림). askPage/answerAsk/startGen/sendStop/hide/dropAsk 는 실제 코드.
// 10-18 현행 기능: 시작 = 늘 새 SLAM(mode slam · map_version 키 0 · 저장 모드·버전 고르기 0) · 미리보기 = 기본 도면(GT) 예고. 지운 옛 검사 이유 = P/UI-TEST-REMOVED-1018.md
const R = vi.hoisted(() => ({ asked: [] as any[], maps: [] as any[], reply: {} as Record<string, any>, onAsk: null as null | ((op: string) => void) }));
vi.mock('../../src/data/link', async (orig) => ({ ...(await orig<typeof import('../../src/data/link')>()),
  ask: (op: string, extra: Record<string, unknown> = {}) => { R.asked.push({ op, ...extra }); R.onAsk?.(op);
    return Promise.resolve(R.reply[op] ?? { op: 'reply', ok: true, text: '시험 — 요청 수락', ...(op === 'map_list' ? { maps: R.maps } : {}) }); } }));
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
const { SimRun } = await import('../../src/app/status');
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
afterEach(async () => { L.answerAsk(false); for (const r of roots.splice(0)) await React.act(async () => r.unmount()); R.asked = []; R.maps = []; R.reply = {}; R.onAsk = null; (globalThis as any).location.hash = '#/MDrive'; await flush(); });

const META = (w: string, b: string, f: string) => ({ world_id: w, building_id: b, floor_id: f, map_source: 'gt_raster', map_version: 'gt-test', epoch: null, width: 200, height: 200, resolution: 0.1, origin: [0, 0, 0] });
const CATALOG = [META('v5_single', 'v5_single', 'f1'), META('v5_building', 'v5', 'l1'), META('v5_building', 'v5', 'l2')] as any;
const SAVED = (f: string, v: string) => ({ world_id: 'v5_building', building_id: 'v5', floor_id: f, map_source: 'slam', map_version: v, epoch: 1, width: 200, height: 200, resolution: 0.05, origin: [0, 0, 0] });
const V1 = '20260101-000000-e1';
const raster = (src: string) => ({ img: { src }, w: 200, h: 200, res: 0.1, ox: 0, oy: 0, label: src }) as any;
const withGT = async (f: (get: any) => Promise<void>) => {   // 기본 도면 미리보기 = 즉시 그림(지형 바꾼 뒤 실행 가능 조건만 채움)
  const get = vi.spyOn(mapsModule, 'getMap').mockImplementation(async (m: any) => raster(`${m.map_source}:${m.floor_id}:${m.map_version}`));
  try { await f(get); } finally { get.mockRestore(); }
};
const asking = () => L.useAsk.getState().text;
const btnIn = (h: N, t: string) => all(h).find((n) => n.nodeName === 'BUTTON' && n.textContent === t);

// 실제 «시뮬 실행» 칸 하나(SimRun · Main 이 주는 목록 = catalog) — toggle = 칸 장착/해제: 장착 = 새 MapStartBox = 새 양식, 해제 = 일시 소멸(화면 오감과 같은 상태)
const simRun = async (catalog: any = CATALOG) => {
  fresh();
  const host = new N('DIV'), root: any = createRoot(host as any); roots.push(root);
  let on = true; const el = () => on ? React.createElement(SimRun, { catalog }) : null;
  await React.act(async () => { root.render(el()); });
  const toggle = async () => { on = !on; await React.act(async () => { root.render(el()); }); await flush(); };
  const box = () => all(host).find((n) => n.attrs.id === 'fh-mapopen') ?? null;
  const startBtn = () => btnIn(box()!, '시뮬 실행')!;
  const terrain = () => all(box()!).find((n) => n.nodeName === 'SELECT' && n.attrs['aria-label'] === '시작 지형')!;
  const chooseTerrain = (w: string) => props(terrain()).onChange({ target: { value: w } });
  const pick = async (w: string) => { await React.act(async () => { chooseTerrain(w); }); await flush(); };
  // start = «시뮬 실행» 누름(관제 칸은 지형을 고른 뒤에만 실행 가능 — 부르는 쪽이 pick). act 를 끝까지 기다림 · 확인 대기 promise 는 배열로 넘김(await 로 풀리지 않게)
  const start = async () => { let p: Promise<unknown> | undefined; await React.act(async () => { const s = startBtn(); p = props(s).onClick({ currentTarget: s }); }); return [p!] as const; };
  return { host, toggle, box, startBtn, terrain, chooseTerrain, pick, start };
};
const previewBox = async (catalog: any = CATALOG, reloadCatalog?: () => unknown) => {
  fresh();
  const host = new N('DIV'), root: any = createRoot(host as any); roots.push(root);
  const el = (c: any) => React.createElement(MapStartBox, { pc: true, part: 'open', preview: true, catalog: c, reloadCatalog });
  await React.act(async () => { root.render(el(catalog)); });
  return { host, choose: (w: string) => props(all(host).find((n) => n.attrs['aria-label'] === '시작 지형')!).onChange({ target: { value: w } }),
    run: () => btnIn(host, '시뮬 실행')!, rerender: async (c: any) => { await React.act(async () => { root.render(el(c)); }); } };
};
// 현행: 저장 모드·버전 고르기 입구 0(요청 2) — 어느 상자에도 없어야 함
const noModeUi = (h: N) => {
  expect(btnIn(h, '새 지도 만들기')).toBeUndefined(); expect(btnIn(h, '저장한 지도로 열기')).toBeUndefined();
  expect(all(h).find((n) => n.nodeName === 'SELECT' && n.attrs['aria-label'] === '저장한 지도 버전')).toBeUndefined();
};

test('관제: 미선택/불러오는 중은 실행 불가 · 바뀐 지형의 늦은 그림 폐기 · 현재 2D 도면 후에만 실행 가능 · 층 바꾸면 그 층 도면 다시', async () => {
  const pending: ((r: any) => void)[] = [];
  const get = vi.spyOn(mapsModule, 'getMap').mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
  try {
    const M = await previewBox([...CATALOG, SAVED('l1', V1)]);
    expect(props(M.run()).disabled).toBe(true); expect(get).not.toHaveBeenCalled(); noModeUi(M.host);
    expect(M.host.textContent).not.toContain('만든 지도 보관');
    await React.act(async () => { M.choose('v5_single'); });
    expect(props(M.run()).disabled).toBe(true); expect(get).toHaveBeenCalledTimes(1);
    await React.act(async () => { M.choose('v5_building'); });
    await React.act(async () => { pending[0](raster('old-single')); });
    expect(props(M.run()).disabled).toBe(true); expect(all(M.host).filter((n) => n.nodeName === 'IMG')).toHaveLength(0);
    await React.act(async () => { pending[1](raster('current-building-l1')); });
    expect(props(M.run()).disabled).toBe(false);
    expect(all(M.host).find((n) => n.nodeName === 'IMG')!.attrs.src).toBe('current-building-l1');
    expect(M.host.textContent).toContain('2D 미리보기 · 기본 도면');
    await React.act(async () => { props(btnIn(M.host, '2층(l2)')!).onClick(); });
    expect(props(M.run()).disabled).toBe(true); expect(get.mock.calls[get.mock.calls.length - 1][0].floor_id).toBe('l2');
    expect(get.mock.calls.map((c: any) => c[0].map_source)).toEqual(['gt_raster', 'gt_raster', 'gt_raster']);   // 저장본이 있어도 시작 미리보기 = 기본 도면만(저장본 복원 아님)
    expect(starts()).toHaveLength(0);
  } finally { get.mockRestore(); }
});

test('관제: 미리보기 실패는 실행 차단 · 다시 받기 성공 뒤 활성 · 서버 시작 불가 관문 유지', async () => {
  const get = vi.spyOn(mapsModule, 'getMap').mockResolvedValueOnce('PNG 풀기 실패').mockResolvedValue(raster('retry-ok'));
  try {
    const M = await previewBox(); await React.act(async () => { M.choose('v5_single'); }); await flush();
    expect(props(M.run()).disabled).toBe(true); expect(M.host.textContent).toContain('PNG 풀기 실패');
    await React.act(async () => { props(btnIn(M.host, '미리보기 다시 받기')!).onClick(); });
    expect(props(M.run()).disabled).toBe(false);
    await React.act(async () => { L.useLink.setState({ st: { ...ST, map_start: { ...ST.map_start, ok: false, why: '실행 중' } } as any }); });
    expect(props(M.run()).disabled).toBe(true); expect(starts()).toHaveLength(0);
  } finally { get.mockRestore(); }
});

test('관제: 새 매핑 공간은 기존 도면 없음 명시 · 선택 전 시작 0 · 선택 뒤 바로 실행 가능(그림 요청 0)', async () => {
  const get = vi.spyOn(mapsModule, 'getMap');
  try {
    const M = await previewBox(); expect(props(M.run()).disabled).toBe(true);
    await React.act(async () => { M.choose('rooms_a'); }); await flush();
    expect(M.host.textContent).toContain('기존 도면 없음'); expect(M.host.textContent).toContain('실행 후 지도가 만들어집니다');
    expect(props(M.run()).disabled).toBe(false); expect(get).not.toHaveBeenCalled(); expect(starts()).toHaveLength(0);
  } finally { get.mockRestore(); }
});

test('목록 읽는 중·목록 실패 = 실행 0 · 실패면 다시 받기 단추 1회만(자동 재시도 0)', async () => withGT(async (get) => {
  let reloads = 0;
  const M = await previewBox(null, () => { reloads++; });
  await React.act(async () => { M.choose('v5_building'); }); await flush();
  expect(props(M.run()).disabled).toBe(true); expect(get).not.toHaveBeenCalled();
  await M.rerender('지도 요청 처리 중'); await flush();
  expect(M.host.textContent).toContain('지도 요청 처리 중'); expect(props(M.run()).disabled).toBe(true); expect(reloads).toBe(0);
  await React.act(async () => { props(btnIn(M.host, '미리보기 다시 받기')!).onClick(); });
  expect(reloads).toBe(1); expect(get).not.toHaveBeenCalled(); expect(starts()).toHaveLength(0);
}));

test('정상: «시뮬 실행» 칸 → 확인창 → 칸 해제(일시 소멸) → 확인 = map_start 1회 · 늘 새 SLAM(mode slam · map_version 키 0)', async () => {
  const M = await simRun(); expect(M.box()).not.toBe(null); noModeUi(M.host);
  await M.pick('rooms_a');
  const [p] = await M.start();
  expect(asking()).toMatch(/^시뮬을 실행할까요/); expect(asking()).toContain('새 지도 만들며 시작');
  await M.toggle(); expect(M.box()).toBe(null);
  expect(asking()).not.toBe(null);                               // 일시 소멸만으로는 확인창 무효 0(R1)
  fresh(); await React.act(async () => { L.answerAsk(true); }); await p; await flush();
  expect(starts().length).toBe(1); expect(starts()[0]).toMatchObject({ op: 'map_start', world_id: 'rooms_a', floor_id: 'f1', mode: 'slam' });
  expect(starts()[0]).not.toHaveProperty('map_version');
});

test('저장본이 있는 층도 시작 = 새 SLAM · 확인문 «새 지도 만들며 시작» · 저장 PNG 요청 0', async () => withGT(async (get) => {
  const M = await simRun([...CATALOG, SAVED('l1', V1)]);
  await M.pick('v5_building'); noModeUi(M.host);
  expect(get.mock.calls.map((c: any) => c[0].map_source)).toEqual(['gt_raster']);
  const [p] = await M.start(); expect(asking()).toContain('새 지도 만들며 시작'); expect(asking()).not.toContain(V1);
  fresh(); await React.act(async () => { L.answerAsk(true); }); await p; await flush();
  expect(starts()).toHaveLength(1); expect(starts()[0]).toMatchObject({ op: 'map_start', world_id: 'v5_building', floor_id: 'l1', mode: 'slam' }); expect(starts()[0]).not.toHaveProperty('map_version');
}));

test('다시 장착 = 새 양식: 옛 확인창 닫힘 · 그 뒤 옛 창에 true 가 와도 보낸 것 0 · 새 상자에 «시작 결과» 줄', async () => {
  const M = await simRun(); await M.pick('rooms_a'); const [p] = await M.start();
  await M.toggle(); await M.toggle();                            // 칸 해제 후 재장착 → 새 MapStartBox → mapFormOpen → 옛 송신 전 요청 무효
  expect(asking()).toBe(null);
  fresh(); await React.act(async () => { L.answerAsk(true); }); await p; await flush();
  expect(starts().length).toBe(0);
  expect(M.box()!.textContent).toMatch(/시작 결과시작 확인 취소 · 새 시작 양식이 열림.*보낸 것 0/);   // 제목 = «시작 결과»(실패 단정 0) + 이 기기 원문
});

test('다시 장착 + 새 선택: 새 양식의 확인만 보냄(옛 선택 0) · 1회', async () => withGT(async () => {
  const M = await simRun(); await M.pick('rooms_a'); const [p1] = await M.start();
  await M.toggle(); await M.toggle(); await p1;
  expect(M.terrain().options.filter((n) => n.attrs.value).map((n) => [n.attrs.value, n.textContent])).toEqual([
    ['v5_single', '1층 건물'], ['v5_building', '2층 건물'], ['rooms_a', '새 매핑 공간'],
  ]);
  await M.pick('v5_building');
  expect(props(M.terrain()).value).toBe('v5_building'); expect(starts()).toHaveLength(0);
  const [p2] = await M.start();
  fresh(); await React.act(async () => { L.answerAsk(true); }); await p2; await flush();
  expect(starts().length).toBe(1); expect(starts()[0]).toMatchObject({ world_id: 'v5_building', floor_id: 'l1', mode: 'slam' });
}));

test('드롭다운 변경 = 렌더 전 동기 무효: 확인창이 열린 채 지형을 바꾸면 창 닫힘 · 그 뒤 true 0', async () => withGT(async () => {
  const M = await simRun(); await M.pick('rooms_a'); const [p] = await M.start();
  await React.act(async () => { M.chooseTerrain('v5_building'); });
  expect(asking()).toBe(null);
  fresh(); await React.act(async () => { L.answerAsk(true); }); await p; await flush();
  expect(starts().length).toBe(0); expect(M.box()!.textContent).toMatch(/고른 지형·층·카메라/);
}));

test('true 로 답한 같은 틱에 드롭다운 변경·STOP·숨김·화면 이동 → 송신 직전 대조로 보낸 것 0', async () => withGT(async () => {
  const acts: [string, (M: Awaited<ReturnType<typeof simRun>>) => void, RegExp][] = [
    ['드롭다운 변경', (M) => { M.chooseTerrain('v5_building'); }, /고른 지형·층·카메라 바뀜/],
    ['STOP', () => { L.sendStop(); }, /STOP·숨김·이탈/],
    ['숨김', () => { L.hide(); }, /STOP·숨김·이탈/],
    ['화면 이동', () => { (globalThis as any).location.hash = '#/Main'; (evs.hashchange || []).slice().forEach((f) => f()); }, /화면 바뀜/],
  ];
  for (const [name, act, re] of acts) {
    const M = await simRun(); await M.pick('rooms_a'); const [p] = await M.start();
    fresh(); await React.act(async () => { L.answerAsk(true); act(M); }); await p; await flush();   // answerAsk(true) 와 act 가 같은 동기 구간 — 이어지는 송신 판단은 그 뒤 microtask
    expect([name, starts().length]).toEqual([name, 0]);
    const box = M.box(); if (box) expect(box.textContent).toMatch(re);
    for (const r of roots.splice(0)) await React.act(async () => r.unmount()); (globalThis as any).location.hash = '#/MDrive';
  }
}));

test('새 주인(다른 시작 상자)이 장착되면 옛 상자 확인은 무효 · 새 상자 확인만 1회 · 옛 결과가 새 결과를 덮지 않음', async () => {
  const M = await simRun(); await M.pick('rooms_a'); const [p1] = await M.start();
  const host2 = new N('DIV'), r2: any = createRoot(host2 as any); roots.push(r2);
  await React.act(async () => { r2.render(React.createElement(MapStartBox, { pc: true })); });   // 폰 지도 본문 같은 다른 상자 = 새 양식(기본 rooms_a)
  expect(asking()).toBe(null); await p1; noModeUi(host2);
  const b2 = btnIn(host2, '시뮬 실행')!;
  let p2: Promise<unknown> | undefined; await React.act(async () => { p2 = props(b2).onClick({ currentTarget: b2 }); });
  fresh(); await React.act(async () => { L.answerAsk(true); }); await p2; await flush();
  expect(starts().length).toBe(1); expect(starts()[0]).toMatchObject({ mode: 'slam' });
  expect(host2.textContent).not.toMatch(/새 시작 양식이 열림/); expect(host2.textContent).not.toContain('시작 결과');   // 마지막 결과 = 새 상자의 수락(성공 추적 줄 0 · 요청 4)
});

test('보낸 뒤 응답 없음(시간 초과) = 제목 «시작 결과» + 원문 · «시작 안 됨»·«안 켜짐» 단정 0', async () => {
  R.reply.map_start = { op: 'reply', ok: false, text: '서버 응답 없음(5 s)' };   // 실제 ask 의 시간 초과 글과 같은 원문
  const M = await simRun(); await M.pick('rooms_a'); const [p] = await M.start();
  fresh(); await React.act(async () => { L.answerAsk(true); }); await p; await flush();
  expect(starts()).toHaveLength(1);
  const t = M.box()!.textContent;
  expect(t).toContain('시작 결과서버 응답 없음(5 s)'); expect(t).not.toContain('시작 안 됨'); expect(t).not.toMatch(/안 켜짐|실패함/);
});

test('지도 저장 결과 표면: 층 바뀐 늦은 응답·목록 미확인 = 제목 «저장 결과»(실패 단정 0) · 정상 = «저장됨» · 권한 사전 막힘 = «저장 안 됨» 그대로', async () => {
  const V = '20261018-120000-e1', LV = { st: 'ok', mode: 'slam', world_id: 'v5_building', building_id: 'v5', floor_id: 'l2', epoch: 1, floor_rev: 3 };
  const SV = { world_id: 'v5_building', building_id: 'v5', floor_id: 'l2', epoch: 1, floor_rev: 3, map_version: V };
  const hit = { ...SAVED('l2', V) };
  const mount = async () => {
    fresh(); L.useLink.setState({ st: { ...ST, map_save: { ok: true }, live_map: { ...LV } } as any });
    const host = new N('DIV'), root: any = createRoot(host as any); roots.push(root);
    await React.act(async () => { root.render(React.createElement(MapStartBox, { pc: true, part: 'save' })); });
    return host;
  };
  const save = async (h: N) => { await React.act(async () => { await props(btnIn(h, '지도 저장')!).onClick(); }); await flush(); };
  R.reply.map_save = { op: 'reply', ok: true, text: `지도 저장됨 · ${V}`, save: SV };
  // 1) 응답 사이 층 세대 바뀜(늦은 응답) — 목록엔 있음
  R.maps = [hit]; R.onAsk = (op) => { if (op === 'map_save') L.useLink.setState({ st: { ...L.useLink.getState().st, live_map: { ...LV, floor_rev: 4 } } as any }); };
  let h = await mount(); await save(h);
  expect(h.textContent).toMatch(/저장 결과[^]*지금 열린 지도와 다름\(지금 지도 저장으로 안 씀\)/); expect(h.textContent).not.toContain('저장 안 됨');
  for (const r of roots.splice(0)) await React.act(async () => r.unmount());
  // 2) 응답 ok · 다시 받은 목록에 그 버전 없음
  R.maps = []; R.onAsk = null; h = await mount(); await save(h);
  expect(h.textContent).toContain(`저장 결과지도 저장됨 · ${V} · 목록에 그 건물·층·버전 없음(목록 다시 받기)`); expect(h.textContent).not.toContain('저장 안 됨');
  for (const r of roots.splice(0)) await React.act(async () => r.unmount());
  // 3) 정상 = 저장됨 + 저장본 이름만
  R.maps = [hit]; h = await mount(); await save(h);
  expect(h.textContent).toContain(`저장됨v5/l2/${V}`); expect(h.textContent).not.toContain('저장 결과');
  for (const r of roots.splice(0)) await React.act(async () => r.unmount());
  // 4) 권한 사전 막힘(서버 map_save 거부 — 보낸 것 0) = 기존 «저장 안 됨» 유지
  const n0 = R.asked.filter((m) => m.op === 'map_save').length;
  fresh(); L.useLink.setState({ st: { ...ST, map_save: { ok: false, why: '로그인한 기기에서만(관문 경유)' }, live_map: { ...LV } } as any });
  const host = new N('DIV'), root: any = createRoot(host as any); roots.push(root);
  await React.act(async () => { root.render(React.createElement(MapStartBox, { pc: true, part: 'save' })); });
  expect(host.textContent).toContain('저장 안 됨로그인한 기기에서만(관문 경유)'); expect(host.textContent).not.toContain('저장 결과');
  await React.act(async () => { props(btnIn(host, '지도 저장')!).onClick({ preventDefault() {}, stopPropagation() {} }); }); await flush();
  expect(R.asked.filter((m) => m.op === 'map_save').length).toBe(n0);   // 막힌 단추 = 송신 0
});

test('목록 prop 없는 상자 = 상자가 map_list 1회 · 자동 재조회 0 · 기본 새 매핑 공간 실행 가능', async () => {
  fresh();
  const host = new N('DIV'), root: any = createRoot(host as any); roots.push(root);
  await React.act(async () => { root.render(React.createElement(MapStartBox, { pc: true })); }); await flush();
  expect(R.asked.filter((m) => m.op === 'map_list')).toHaveLength(1); noModeUi(host);
  expect(props(btnIn(host, '시뮬 실행')!).disabled).toBe(false);
  await flush(); expect(R.asked.filter((m) => m.op === 'map_list')).toHaveLength(1);
});

test('P2-3(715): 실행 후 한계 줄 = live_map ok·static·slam·같은 world/floor 수신 때만 · 시작 중/미수신/다른 층 = 확인 전 · GT static = SLAM 그림 한계 줄 0', async () => {
  const M = await previewBox();
  const LIM = '지금 실행 중 = 저장한 지도 보기', WAIT = '지도 표시·출처 확인 전';
  const put = async (session: any, live_map: any) => { await React.act(async () => { L.useLink.setState({ st: { ...ST, map_start: { ...ST.map_start, session }, live_map } as any }); }); };
  const ses = (o: object = {}) => ({ runner: 'live_map', result: 'running', world_id: 'v5_building', floor_id: 'l1', map_mode: 'static', ...o });
  const lvm = (o: object = {}) => ({ st: 'ok', why: '', world_id: 'v5_building', floor_id: 'l1', mode: 'static', map_source: 'slam', ...o });
  await put(ses({ result: 'starting' }), null);
  expect(M.host.textContent).not.toContain(LIM); expect(M.host.textContent).toContain(`저장 지도 시작 처리 중 · ${WAIT}`);   // 요청 수락·시작 중 ≠ 준비
  await put(ses(), lvm({ map_source: undefined }));
  expect(M.host.textContent).not.toContain(LIM); expect(M.host.textContent).toContain(`저장 지도 세션 실행 중 · ${WAIT}`);   // 출처 미수신
  await put(ses(), lvm({ floor_id: 'l2' }));
  expect(M.host.textContent).not.toContain(LIM); expect(M.host.textContent).toContain(WAIT);
  await put(ses(), lvm({ map_source: 'gt_raster' }));
  expect(M.host.textContent).not.toContain(LIM); expect(M.host.textContent).not.toContain(WAIT);   // 옛 앱 static GT
  await put(ses(), lvm());
  expect(M.host.textContent).toContain(LIM); expect(M.host.textContent).not.toContain(WAIT);       // 양성
  await put(ses({ map_mode: 'slam' }), lvm({ mode: 'slam' }));
  expect(M.host.textContent).not.toContain(LIM); expect(M.host.textContent).not.toContain(WAIT);
  expect(starts()).toHaveLength(0);
});
