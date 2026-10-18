import { afterEach, expect, test, vi } from 'vitest';
// 10-18 요청 1·3(root 최소안 · SRC1153 보완): 실제 useMapPick 을 createRoot 로 장착해 «실시간 보기 중 현재층 저장 지도 대체»를 본다.
// 가짜 link = v2_link map_op 규칙(연결마다 map_list·map_get·map_live_get 한 번에 하나 — 진행 중이면 «지도 요청 처리 중» 거절), 응답은 시험이 손으로 풂.
// status 는 useLink.setState 로 직접 넣음(서버 view 모양: 연결 건물 K 없는 정상 층 대기 = world/building/epoch + floor 만). ※ ROOT 슬롯 전 미실행.
vi.mock('../../src/data/shared', () => ({ refreshShared: () => {}, reread: () => {} }));
const L = vi.hoisted(() => ({ busy: false, log: [] as string[], q: [] as Array<() => void>, fail: {} as Record<string, string>, list: [] as any[] }));
vi.mock('../../src/data/link', async (orig) => {
  const real = await orig<typeof import('../../src/data/link')>();
  return { ...real, ask: (op: string, extra: any = {}) => new Promise((res) => {
    const tag = op === 'map_get' ? `get:${extra.floor_id}:${extra.map_version}` : op === 'map_live_get' ? 'live' : op;
    if (!['map_list', 'map_get', 'map_live_get'].includes(op)) { L.log.push(`other:${op}`); return res({ op: 'reply', ok: false, text: '시험 밖 op' }); }
    if (L.busy) { L.log.push(`${tag}:거절`); return res({ op: 'reply', ok: false, text: '지도 요청 처리 중' }); }
    L.busy = true; L.log.push(tag);
    L.q.push(() => {
      L.busy = false;
      if (op === 'map_list') return res({ op: 'reply', ok: true, maps: L.list });
      if (op === 'map_live_get') { const v = real.useLink.getState().st?.live_map as any; return res({ op: 'reply', ok: true, live: { seq: v?.grid?.seq, epoch: v?.epoch, world_id: v?.world_id, floor_id: v?.floor_id, png: 'AA==' } }); }
      const m = L.list.find((x) => x.floor_id === extra.floor_id && x.building_id === extra.building_id && x.map_version === extra.map_version);
      const f = L.fail[`${extra.building_id}/${extra.floor_id}`];
      res(f ? { op: 'reply', ok: false, text: f } : { op: 'reply', ok: true, map: { ...m, png: 'AA==' } });
    });
  }) };
});
vi.mock('../../src/app/shell', async (orig) => ({ ...(await orig<typeof import('../../src/app/shell')>()), toast: () => {} }));
const ctx = new Proxy({}, { get: (_, k) => (k === 'measureText' ? () => ({ width: 10 }) : () => {}), set: () => true });
const doc = { hidden: false, addEventListener: () => {}, removeEventListener: () => {}, createElement: () => ({ getContext: () => ctx, width: 0, height: 0, setAttribute: () => {}, style: {} }), fullscreenElement: null };
Object.assign(globalThis, { window: globalThis, document: doc, addEventListener: () => {}, removeEventListener: () => {}, IS_REACT_ACT_ENVIRONMENT: true, HTMLIFrameElement: class {},
  location: { href: 'http://127.0.0.1/', protocol: 'http:', hash: '', search: '', pathname: '/' },
  Image: class { src = ''; naturalWidth = 200; naturalHeight = 200; decode() { return Promise.resolve(); } } });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useLink } = await import('../../src/data/link');
const { useMapPick } = await import('../../src/map/MapPick');

const meta = (w: string, b: string, f: string, ver: string, src: 'slam' | 'gt_raster' = 'slam') => ({ schema: 'v2_map_meta/1', world_id: w, building_id: b, floor_id: f, epoch: src === 'slam' ? 3 : null,
  map_version: ver, map_source: src, map_frame: 'map', resolution: 0.1, origin: [-10, -10, 0], width: 200, height: 200 });
// l2 = 저장 2개(최신 = 20261015-144711-e3) + GT(대체 대상 아님) · 단층 f1 = 1개 · l1 = 1개
const LIST = [meta('v5_building', 'v5', 'l2', '20261014-100000-e1'), meta('v5_building', 'v5', 'l2', '20261015-144711-e3'), meta('v5_building', 'v5', 'l2', 'gt-20261014', 'gt_raster'),
  meta('v5_building', 'v5', 'l1', '20261014-174721-e3'), meta('v5_single', 'v5_single', 'f1', '20261014-120000-e2')];
const NEW_L2 = 'get:l2:20261015-144711-e3';
const BLDG = { world_id: 'v5_building', building_id: 'v5' };
const WAIT = (o: any = {}) => ({ st: 'wait', why: '현재층 확정 · 그 층 지도 대기', ...BLDG, epoch: 2, floor: { state: 'on_floor', current: 'l2', rev: 4, reason: '' }, ...o });   // K 없는 정상 층 대기(mode·floor_id 없음)
const OK = (o: any = {}) => ({ ...WAIT(), st: 'ok', why: '', floor_id: 'l2', mode: 'slam', map_source: 'slam', map_version: null, floor_rev: 4, pose: { x: 1, y: 1, yaw: 0, source: 'slam_tf' },
  grid: { seq: 1, w: 200, h: 200, res: 0.1, origin: [-10, -10, 0] }, ...o });
const tick = () => React.act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const flush1 = async () => { const f = L.q.shift(); expect(f, '풀 응답 없음').toBeTruthy(); await React.act(async () => { f!(); await new Promise((r) => setTimeout(r, 0)); }); await tick(); };
const text = (n: any): string => (n == null || typeof n === 'boolean' ? '' : typeof n === 'string' || typeof n === 'number' ? String(n) : Array.isArray(n) ? n.map(text).join(' ')
  : n.props ? text(n.props.children) + ' ' + (typeof n.props.title === 'string' ? n.props.title : '') : '');
const live = async (lv: any) => { await React.act(async () => { useLink.setState({ st: { live_map: lv } as any, lastMsg: performance.now() }); }); await tick(); };
const rej = () => L.log.filter((x) => x.endsWith('거절'));

async function mount() {
  for (const r of roots.splice(0)) await React.act(async () => r.unmount());   // 앞 장착이 새 연결 세대에 반응(목록 재요청)하지 않게
  L.busy = false; L.log = []; L.q = []; L.fail = {}; L.list = LIST;
  useLink.setState({ open: true, bad: null, gen: (useLink.getState().gen || 0) + 1, provider: 'simulation_gate', st: null, lastMsg: performance.now() } as any); useLink.setState({ stGen: useLink.getState().gen } as any);
  const out: { r: any } = { r: null };
  function H() { out.r = useMapPick(true, false); return null; }
  const root: any = createRoot({ nodeType: 1, tagName: 'DIV', nodeName: 'DIV', namespaceURI: 'http://www.w3.org/1999/xhtml', addEventListener: () => {}, removeEventListener: () => {}, ownerDocument: doc } as any);
  roots.push(root);
  await React.act(async () => { root.render(React.createElement(H)); }); await tick();
  expect(L.log).toEqual(['map_list']); await flush1(); L.log = [];
  const pick = async (k: string) => { await React.act(async () => { out.r.view(k); }); await tick(); };
  await pick('live');   // 실시간 보기(사용자 고름 = touched)
  return { out, pick };
}
const shown = (o: { r: any }) => o.r.raster?.label ?? null;
const roots: any[] = [];
afterEach(async () => { for (const r of roots.splice(0)) await React.act(async () => r.unmount()); });

test('연결 건물: K 없는 대기(저장 받는 중) → ok(실시간 해독 대기) 동안 저장본 유지 · 동시 read 0 → 실시간 검증 뒤 교체', async () => {
  const m = await mount();
  await live(WAIT()); expect(L.log).toEqual([NEW_L2]);                     // 같은 층 slam 최신 1개 · GT 0
  await live(OK()); expect(L.log).toEqual([NEW_L2]);                       // map_get 진행 중 = map_live_get 0
  await flush1(); expect(shown(m.out)).toBe('저장 지도 · 2층'); expect(m.out.r.pose).toBeNull();   // ok 알림 뒤에도 저장본 유지 · 마커 0
  expect(L.log).toEqual([NEW_L2, 'live']);                                  // 저장 받기 끝난 뒤 실시간 1회
  await flush1(); expect(shown(m.out)).toMatch(/^현재 열린 지도 · /); expect(m.out.r.pose).not.toBeNull();
  expect(rej()).toEqual([]);
});

test('ok 가 먼저면 저장 받기 0 — 실시간만', async () => {
  const m = await mount();
  await live(OK()); expect(L.log).toEqual(['live']); await flush1(); expect(shown(m.out)).toMatch(/^현재 열린 지도 · /); expect(L.log).toEqual(['live']);
});

test.each([['reset', { st: 'reset', why: '리셋 중' }], ['stale', { ...WAIT(), st: 'stale' }]])('%s 뒤 같은 key·epoch 복귀: 늦은 답 버림 · 새로 1회', async (_, mid) => {
  const m = await mount();
  await live(WAIT()); expect(L.log).toEqual([NEW_L2]);
  await live(mid); await flush1(); expect(shown(m.out)).toBeNull();          // 경계 뒤 늦은 성공 = 채택 0
  await live(WAIT()); expect(shown(m.out)).toBeNull(); expect(L.log).toEqual([NEW_L2, NEW_L2]);   // 옛 결과 부활 0 · 새 요청
  await flush1(); expect(shown(m.out)).toBe('저장 지도 · 2층'); expect(rej()).toEqual([]);
});

test('다른 epoch 로 바뀌면 진행 중 답 버림 · 옛 요청 끝난 뒤 새 요청(거절 0)', async () => {
  const m = await mount();
  await live(WAIT()); await live(WAIT({ epoch: 3 })); expect(L.log).toEqual([NEW_L2]);
  await flush1(); expect(L.log).toEqual([NEW_L2, NEW_L2]); expect(shown(m.out)).toBeNull();
  await flush1(); expect(shown(m.out)).toBe('저장 지도 · 2층'); expect(rej()).toEqual([]);
});

test('받기 실패 → 짧은 이유 · 자동 재시도 0 → 다시 고름(rq) = 1회 더', async () => {
  const m = await mount(); L.fail = { 'v5/l2': 'PNG 풀기 실패' };
  await live(WAIT()); await flush1(); expect(shown(m.out)).toBeNull(); expect(text(m.out.r.pickEl)).toMatch(/PNG 풀기 실패 — 실시간 지도 기다림/);
  await tick(); expect(L.q.length).toBe(0); expect(L.log).toEqual([NEW_L2]);
  L.fail = {}; await m.pick('live'); expect(L.log).toEqual([NEW_L2, NEW_L2]); await flush1(); expect(shown(m.out)).toBe('저장 지도 · 2층');
});

test('서버 ok 가 다른 층·rev 면 map_live_get 0 · 저장본 유지', async () => {
  for (const o of [{ floor_id: 'l1' }, { floor_rev: 3 }]) {
    const m = await mount();
    await live(OK(o)); expect(L.log).toEqual([NEW_L2]); await flush1();
    expect(shown(m.out)).toBe('저장 지도 · 2층'); await tick(); expect(L.log).toEqual([NEW_L2]); expect(m.out.r.pose).toBeNull();
  }
});

test('단층: floor 칸 없이 full key(유일 층 · floor_rev 없음)로 양성', async () => {
  const m = await mount();
  await live({ st: 'wait', why: '이번 epoch 지도 기다림', world_id: 'v5_single', building_id: 'v5_single', floor_id: 'f1', mode: 'slam', map_source: 'slam', map_version: null, epoch: 1, floor_rev: null, grid: null });
  expect(L.log).toEqual(['get:f1:20261014-120000-e2']); await flush1(); expect(shown(m.out)).toBe('저장 지도 · 1층');
});

test('음성: 연결 건물 floor 없음 · transit · 수동 저장본 보기 = 대체 요청 0', async () => {
  let m = await mount();
  await live({ st: 'wait', why: '', ...BLDG, floor_id: 'l1', mode: 'slam', map_source: 'slam', epoch: 1, floor_rev: 3, grid: null }); await tick();
  expect(L.log).toEqual([]); expect(shown(m.out)).toBeNull();
  m = await mount();
  await live(WAIT({ floor: { state: 'transit', current: null, rev: 5, reason: '' } })); expect(L.log).toEqual([]); expect(shown(m.out)).toBeNull();
  m = await mount(); await m.pick('v5/l1/20261014-174721-e3'); L.log = []; L.q = []; L.busy = false;
  await live(WAIT()); expect(L.log).toEqual([]);                            // 수동으로 다른 층을 보는 중 = 간섭 0
});
