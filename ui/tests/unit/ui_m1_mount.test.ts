import { afterEach, expect, test, vi } from 'vitest';
// M① 보완(670 P1 · root «M1 중복 호출 HOLD·좁은 보완 GO»): 실제 useMapPick 을 React(react-dom createRoot)로 장착해
// handler(view=pick) → store 갱신 → effect 경계에서 «선택 한 번 = 저장 지도 요청 소유자 하나»를 본다.
// 가짜 link = v2_link map_op 규칙: 연결마다 map_list·map_get·height_get 한 번에 하나(진행 중이면 «지도 요청 처리 중» 거절), 응답은 시험이 손으로 풂(= 캐시 미적중·첫 응답 지연)
vi.mock('../../src/data/shared', () => ({ refreshShared: () => {}, reread: () => {} }));
const L = vi.hoisted(() => ({ busy: false, log: [] as string[], q: [] as Array<() => void>, fail: {} as Record<string, string>, list: [] as any[] }));
vi.mock('../../src/data/link', async (orig) => ({
  ...(await orig<typeof import('../../src/data/link')>()),
  ask: (op: string, extra: any = {}) => new Promise((res) => {
    const tag = op === 'map_get' ? `get:${extra.floor_id}` : op;
    if (!['map_list', 'map_get', 'height_get'].includes(op)) { L.log.push(`other:${op}`); return res({ op: 'reply', ok: false, text: '시험 밖 op' }); }
    if (L.busy) { L.log.push(`${tag}:거절`); return res({ op: 'reply', ok: false, text: '지도 요청 처리 중' }); }
    L.busy = true; L.log.push(tag);
    L.q.push(() => {
      L.busy = false;
      if (op === 'map_list') return res({ op: 'reply', ok: true, maps: L.list });
      const m = L.list.find((x) => x.floor_id === extra.floor_id && x.building_id === extra.building_id && x.map_version === extra.map_version);
      const f = L.fail[`${extra.building_id}/${extra.floor_id}`];
      res(f ? { op: 'reply', ok: false, text: f } : { op: 'reply', ok: true, map: { ...m, png: 'AA==' } });
    });
  }),
}));
vi.mock('../../src/app/shell', async (orig) => ({ ...(await orig<typeof import('../../src/app/shell')>()), toast: () => {} }));
// 노드 환경: 그림 해독(Image)·canvas 만 흉내 — 지도 크기 = meta 크기
const ctx = new Proxy({}, { get: (_, k) => (k === 'measureText' ? () => ({ width: 10 }) : () => {}), set: () => true });
const doc = { hidden: false, addEventListener: () => {}, removeEventListener: () => {}, createElement: () => ({ getContext: () => ctx, width: 0, height: 0, setAttribute: () => {}, style: {} }), fullscreenElement: null };
Object.assign(globalThis, { window: globalThis, document: doc, addEventListener: () => {}, removeEventListener: () => {}, IS_REACT_ACT_ENVIRONMENT: true, HTMLIFrameElement: class {},
  location: { href: 'http://127.0.0.1/', protocol: 'http:', hash: '', search: '', pathname: '/' },
  Image: class { src = ''; naturalWidth = 200; naturalHeight = 200; decode() { return Promise.resolve(); } } });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useLink } = await import('../../src/data/link');
const { useMapPick } = await import('../../src/map/MapPick');
const { mapKey } = await import('../../src/data/maps');

const meta = (w: string, b: string, f: string, src: 'gt_raster' | 'slam', ver: string) => ({ schema: 'v2_map_meta/1', world_id: w, building_id: b, floor_id: f, epoch: src === 'slam' ? 1 : null,
  map_version: ver, map_source: src, map_frame: 'map', resolution: 0.1, origin: [-10, -10, 0], width: 200, height: 200 });
const LIST = [meta('v5_building', 'v5', 'l1', 'gt_raster', 'gt-1'), meta('v5_building', 'v5', 'l2', 'gt_raster', 'gt-1'), meta('rooms_a', 'rooms_a', 'f1', 'slam', 'v-1'), meta('v5_single', 'v5_single', 'f1', 'slam', 'v-2')];
const ALL = 'all:v5_building', ROOM = mapKey(LIST[2] as any), SING = mapKey(LIST[3] as any);
const tick = () => React.act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const flush1 = async () => { const f = L.q.shift(); expect(f, '풀 응답 없음').toBeTruthy(); await React.act(async () => { f!(); await new Promise((r) => setTimeout(r, 0)); }); await tick(); };
const text = (n: any): string => (n == null || typeof n === 'boolean' ? '' : typeof n === 'string' || typeof n === 'number' ? String(n) : Array.isArray(n) ? n.map(text).join(' ')
  : n.props ? text(n.props.children) + ' ' + (typeof n.props.title === 'string' ? n.props.title : '') : '');

async function mount(keep = false) {   // keep=false: 앞 시험이 남긴 공유 선택(usePick)을 목록 도착 전에 비움 — keep=true 는 «다른 화면에서 고른 지도로 열림»
  L.busy = false; L.log = []; L.q = []; L.fail = {}; L.list = LIST;
  useLink.setState({ open: true, gen: (useLink.getState().gen || 0) + 1, provider: 'simulation_gate' } as any); useLink.setState({ stGen: useLink.getState().gen } as any);
  const out: { r: any } = { r: null };
  function H() { out.r = useMapPick(true, false); return null; }
  const root: any = createRoot({ nodeType: 1, tagName: 'DIV', nodeName: 'DIV', namespaceURI: 'http://www.w3.org/1999/xhtml', addEventListener: () => {}, removeEventListener: () => {}, ownerDocument: doc } as any);
  const u0 = root.unmount.bind(root); let up = true; root.unmount = () => { if (up) { up = false; u0(); } }; roots.push(root);
  await React.act(async () => { root.render(React.createElement(H)); }); await tick();
  if (!keep) await React.act(async () => { out.r.view(''); });
  expect(L.log).toEqual(['map_list']); await flush1();   // 목록 1회 받음
  L.log = L.log.slice(1);   // 목록 뒤에 생긴 요청(keep 의 화면 복귀 로딩)만 남김
  return { out, root, pick: async (k: string) => { await React.act(async () => { out.r.view(k); }); await tick(); } };
}
const shown = (o: { r: any }) => o.r.raster?.label ?? null;
const roots: any[] = [];
afterEach(async () => { for (const r of roots.splice(0)) await React.act(async () => r.unmount()); });   // 실패한 시험의 화면이 다음 시험 연결 세대 변경에 반응하지 않게

test('M① 장착: 층 나란히 선택 1회(첫 응답 지연) → 1층 요청 1 → 그 응답 뒤 2층 요청 1 → 두 층 표시 · 거절 0', async () => {
  const m = await mount(); await m.pick(ALL);
  expect(L.log).toEqual(['get:l1']);                     // 옛 코드: ['get:l1', 'get:l1:거절'] — pick 직접 호출 + effect 의 두 소유자
  await flush1(); expect(L.log).toEqual(['get:l1', 'get:l2']);
  await flush1(); expect(shown(m.out)).toMatch(/층 나란히 · GT 기하 2D/); expect(m.out.r.raster.noGrid).toBe(true);
  expect(L.log.filter((x) => x.endsWith('거절'))).toEqual([]);
  // 같은 선택 다시 누름(명시 다시 받기 rq) → 새 묶음 1개(1층부터)
  L.log = []; await m.pick(ALL); expect(shown(m.out)).toBeNull(); expect(L.log).toEqual(['get:l1']);
  await flush1(); await flush1(); expect(L.log).toEqual(['get:l1', 'get:l2']); expect(shown(m.out)).toMatch(/층 나란히/);
  await React.act(async () => m.root.unmount());
});

test('M① 장착: 단일 저장 지도 선택 1회 → 요청 1 · 표시 · 다시 누름 = 요청 1 더', async () => {
  const m = await mount(); await m.pick(ROOM); expect(L.log).toEqual(['get:f1']);
  await flush1(); expect(shown(m.out)).toMatch(/SLAM 저장 지도/); expect(L.log).toEqual(['get:f1']);
  await m.pick(ROOM); expect(L.log).toEqual(['get:f1', 'get:f1']); await flush1(); expect(shown(m.out)).toMatch(/SLAM 저장 지도/);
  await React.act(async () => m.root.unmount());
});

test('M① 장착: 둘째 층 실패 → «2층 · 원문» · 부분 그림 0 / 첫 층 실패 → 2층 요청 0 · 선택 유지 · 재시도 0', async () => {
  let m = await mount(); L.fail = { 'v5/l2': 'PNG 풀기 실패' }; await m.pick(ALL); await flush1(); await flush1();
  expect(shown(m.out)).toBeNull(); expect(text(m.out.r.pickEl)).toMatch(/2층 · PNG 풀기 실패/); expect(L.log).toEqual(['get:l1', 'get:l2']);
  await tick(); expect(L.q.length).toBe(0); await React.act(async () => m.root.unmount());
  m = await mount(); L.fail = { 'v5/l1': '지도 없음' }; await m.pick(ALL); await flush1();
  expect(L.log).toEqual(['get:l1']); expect(text(m.out.r.pickEl)).toMatch(/1층 · 지도 없음/); expect(shown(m.out)).toBeNull(); expect(L.q.length).toBe(0);
  await React.act(async () => m.root.unmount());
});

test('M① 장착: A→B→A(첫 응답 지연 중) · 옛 응답이 새 선택을 덮지 않음 · 추가 층 요청 0', async () => {
  const m = await mount(); await m.pick(ALL); expect(L.log).toEqual(['get:l1']);
  await m.pick(ROOM);                                   // 진행 중 1요청은 취소 불가 → 새 단일 지도 요청은 서버 슬롯에서 거절(기존 단일 슬롯 계열, 재시도 0)
  expect(L.log).toEqual(['get:l1', 'get:f1:거절']); await tick(); expect(text(m.out.r.pickEl)).toMatch(/지도 요청 처리 중/);
  await flush1();                                       // 옛 층 나란히 1층 응답 → 버림: 2층 요청 0 · 그림 0
  expect(L.log).toEqual(['get:l1', 'get:f1:거절']); expect(shown(m.out)).toBeNull();
  await m.pick(ALL); expect(L.log.slice(2)).toEqual(['get:l1']); await flush1(); await flush1();
  expect(L.log.slice(2)).toEqual(['get:l1', 'get:l2']); expect(shown(m.out)).toMatch(/층 나란히/);
  await React.act(async () => m.root.unmount());
});

test('M① 장착: 진행 중 언마운트 · 연결 세대 전환 → 늦은 응답 버림 · 다음 층 요청 0', async () => {
  let m = await mount(); await m.pick(ALL); await React.act(async () => m.root.unmount());
  await React.act(async () => { L.q.shift()!(); await new Promise((r) => setTimeout(r, 0)); }); expect(L.log).toEqual(['get:l1']);
  m = await mount(); await m.pick(ALL);
  await React.act(async () => { useLink.setState({ gen: useLink.getState().gen + 1 } as any); });   // 새 연결(아직 status 전) — 옛 묶음 무효
  await React.act(async () => { L.q.shift()!(); await new Promise((r) => setTimeout(r, 0)); }); await tick();
  expect(L.log).toEqual(['get:l1']); expect(shown(m.out)).toBeNull();
  await React.act(async () => m.root.unmount());
});

test('M① 장착: 목록 다시 받기(같은 선택 진행 중) — 목록 요청은 슬롯 거절 · 지도 요청 추가 0 · 묶음은 끝까지', async () => {
  const m = await mount(); await m.pick(ALL);
  await React.act(async () => { m.out.r.reload(); }); await tick();
  expect(L.log).toEqual(['get:l1', 'map_list:거절']);   // 기존 단일 슬롯 — 자동 재시도 0
  await flush1(); await flush1(); expect(L.log).toEqual(['get:l1', 'map_list:거절', 'get:l2']); expect(shown(m.out)).toMatch(/층 나란히/);
  await React.act(async () => m.root.unmount());
});

test('M① 장착: 다른 화면에서 고른 저장 지도로 열림 → 목록 도착 뒤 1회 받음(화면 복귀 로딩 유지)', async () => {
  const a = await mount(); await a.pick(SING); await flush1(); expect(shown(a.out)).toMatch(/SLAM 저장 지도/);
  await React.act(async () => a.root.unmount());
  const b = await mount(true);                          // 새 화면: 목록 받은 뒤 같은 선택(sel 유지)을 effect 가 1회 받음
  expect(L.log).toEqual(['get:f1']); await flush1(); expect(shown(b.out)).toMatch(/SLAM 저장 지도/); expect(L.log).toEqual(['get:f1']);
  await React.act(async () => b.root.unmount());
});

test('M① 장착: 단일 저장 지도 A→B(A 응답 지연) — A 늦은 응답이 B 선택에 그려지지 않음 · B 다시 누름 = 요청 1', async () => {
  const m = await mount(); await m.pick(ROOM); await m.pick(SING);
  expect(L.log).toEqual(['get:f1', 'get:f1:거절']); expect(text(m.out.r.pickEl)).toMatch(/지도 요청 처리 중/);
  await flush1(); expect(shown(m.out)).toBeNull(); expect(L.log.length).toBe(2);   // 옛 A 그림 채택 0 · 자동 재시도 0
  await m.pick(SING); expect(L.log.slice(2)).toEqual(['get:f1']); await flush1(); expect(shown(m.out)).toMatch(/SLAM 저장 지도/);
});
