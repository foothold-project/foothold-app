import { afterEach, expect, test, vi } from 'vitest';
// U2-b(결정 7): PC 지도 탭 왼쪽 위 «지형 + 2D/3D/SLAM» — 보기 전용. 실제 useMapPick 을 react-dom createRoot(가짜 DOM)로 장착하고
// 돌려준 bar 요소의 select·단추 props 를 직접 부른다. 대체: link 의 ask(읽기 op 기록 · map_get/geom_get 은 실패 답 — 그림 해독 0)·sendOp·sendStop(불리면 기록) 만.
// 확인: 단추가 고르는 보기 키(2D=층 나란히/단층 GT 최신 · 3D=2층 건물 입체 기하 · SLAM=실행 중 SLAM 이면 실시간, 아니면 최신 SLAM 저장본),
// 눌림 = 지금 보기에서 계산, 볼 지도 없으면 비활성+이유, 지형 바꿈 = 보기만(실행 지형·기동·조종 op 0 · 읽기 op 만).
const R = vi.hoisted(() => ({ asked: [] as { op: string; x: any }[], sent: [] as string[], maps: [] as any[], p: null as any }));
vi.mock('../../src/data/link', async (orig) => ({ ...(await orig<typeof import('../../src/data/link')>()),
  ask: (op: string, x: any = {}) => { R.asked.push({ op, x }); return Promise.resolve(op === 'map_list' ? { op: 'reply', ok: true, maps: R.maps } : { op: 'reply', ok: false, text: '시험 — 그림 안 받음' }); },
  sendOp: (op: string) => { R.sent.push(op); return true; }, sendStop: () => { R.sent.push('stop'); return true; } }));
vi.mock('../../src/app/shell', async (orig) => ({ ...(await orig<typeof import('../../src/app/shell')>()), toast: () => {} }));
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
  addEventListener() {} removeEventListener() {}
}
const doc: any = { addEventListener() {}, removeEventListener() {}, nodeType: 9, fullscreenElement: null, activeElement: null, hidden: false, documentElement: new N('HTML'), body: new N('BODY'),
  createElement: (t: string) => new N(t.toUpperCase()), createElementNS: (_: string, t: string) => new N(t.toUpperCase()), createTextNode: (s: string) => Object.assign(new N('#text', 3), { nodeValue: s }), querySelectorAll: () => [] };
Object.assign(globalThis, { window: globalThis, document: doc, addEventListener() {}, removeEventListener() {}, IS_REACT_ACT_ENVIRONMENT: true, HTMLIFrameElement: class {},
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, location: { href: 'http://127.0.0.1/', protocol: 'http:', hash: '', search: '', pathname: '/' } });
vi.spyOn(console, 'error').mockImplementation(() => {});

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useLink } = await import('../../src/data/link');
const { useMapPick } = await import('../../src/map/MapPick');

const M = (world_id: string, building_id: string, floor_id: string, map_version: string, slam: boolean) =>
  ({ world_id, building_id, floor_id, map_version, map_source: slam ? 'slam' : 'gt_raster', epoch: slam ? 1 : null, resolution: 0.05, origin: [0, 0, 0], width: 10, height: 10 });
const MAPS = [M('v5_single', 'v5_single', 'f1', 'gt-20261001', false), M('v5_single', 'v5_single', 'f1', '20261012-090000-e2', true), M('v5_single', 'v5_single', 'f1', '20261010-120000-e1', true),
  M('v5_building', 'v5', 'l1', 'gt-20261001', false), M('v5_building', 'v5', 'l2', 'gt-20261001', false), M('v5_building', 'v5', 'l1', '20261011-100000-e1', true)];
const SESS = (map_mode: string) => ({ runner: 'live_map', result: 'running', world_id: 'v5_building', floor_id: 'l1', map_mode });
const link = (sess: any) => useLink.setState({ open: true, gen: 1, stGen: 1, lastMsg: performance.now(), provider: 'simulation_gate', st: { map_start: { session: sess }, live_map: null } as any });

const roots: any[] = [];
afterEach(async () => { for (const r of roots.splice(0)) await React.act(async () => r.unmount()); R.asked = []; R.sent = []; });
const H = () => { R.p = useMapPick(false, true); return null; };
const mount = async (maps: any[] | null) => {
  R.maps = maps ?? []; if (!maps) useLink.setState({ stGen: 0 });   // 목록 못 받은 상태 = 이 연결 유효 status 전(loadList 안 보냄)
  const root: any = createRoot(new N('DIV') as any); roots.push(root);
  await React.act(async () => { root.render(React.createElement(H)); });
  await React.act(async () => { R.p.view(''); });   // 다른 시험이 남긴 공유 선택 → 시뮬 바닥(GT)으로
};
const sel = () => R.p.bar.props.children[0], btns = () => R.p.bar.props.children[1].props.children as any[];
const st = () => btns().map((b) => `${b.props.children}:${b.props['aria-pressed'] ? 'on' : b.props.disabled ? `off(${b.props.title})` : '-'}`);
const click = async (i: number) => { await React.act(async () => { btns()[i].props.onClick(); }); };
const pickW = async (w: string) => { await React.act(async () => { sel().props.onChange({ target: { value: w } }); }); };
const READ = ['map_list', 'map_get', 'map_live_get', 'geom_get'];

test('실행 중 2층 건물 SLAM — 지형 기본 = 실행 지형 · 2D=층 나란히 · 3D=입체 기하 · SLAM=실시간 · 눌림은 지금 보기 · 읽기 op 만', async () => {
  link(SESS('slam')); await mount(MAPS);
  expect([sel().props.value, sel().props.children.map((o: any) => o.props.children)]).toEqual(['v5_building', ['1층 건물', '2층 건물 · 실행 중', '새 매핑 공간']]);
  expect(st()).toEqual(['2D:-', '3D:-', 'SLAM:-']);   // 시뮬 바닥 보기 = 어느 것도 안 눌림
  await click(0); expect([st(), R.p.on, R.p.live]).toEqual([['2D:on', '3D:-', 'SLAM:-'], true, false]);
  expect(R.p.blank).toMatch(/^층 나란히 보기 미표시/);   // 2D(2층) = 층 한 장이 아니라 층 나란히 보기
  expect(R.asked.filter((a) => a.op === 'map_get')[0].x).toEqual({ building_id: 'v5', floor_id: 'l1', map_version: 'gt-20261001' });   // 층 나란히 = 층별 GT 차례로(첫 층 실패에서 멈춤)
  await click(1); expect(st()).toEqual(['2D:-', '3D:on', 'SLAM:-']); expect(R.asked.some((a) => a.op === 'geom_get' && a.x.building_id === 'v5')).toBe(true);
  await click(2); expect([st(), R.p.live]).toEqual([['2D:-', '3D:-', 'SLAM:on'], true]);
  expect(R.asked.every((a) => READ.includes(a.op))).toBe(true); expect(R.sent).toEqual([]);
  expect(useLink.getState().st).toEqual({ map_start: { session: SESS('slam') }, live_map: null });   // 실행 지형·세션 그대로
});

test('지형 바꿈 = 보기만: 지금 방식 유지(1층 건물 SLAM = 최신 저장본) · 3D 비활성 이유 · 볼 지도 없는 지형은 그림 그대로·전부 비활성 · 다른 곳에서 고르면 select 따라감', async () => {
  link(SESS('slam')); await mount(MAPS); await click(2);
  await pickW('v5_single');
  expect([sel().props.value, st(), R.p.live]).toEqual(['v5_single', ['2D:-', '3D:off(입체 기하는 2층 건물만)', 'SLAM:on'], false]);
  expect(R.asked.filter((a) => a.op === 'map_get').pop()!.x).toEqual({ building_id: 'v5_single', floor_id: 'f1', map_version: '20261012-090000-e2' });   // 글자 순 최신(받은 순서 무관)
  await click(0); expect(R.asked.filter((a) => a.op === 'map_get').pop()!.x.map_version).toBe('gt-20261001'); expect(st()[0]).toBe('2D:on');
  const n = R.asked.length; await pickW('rooms_a');
  expect([sel().props.value, st(), R.asked.length]).toEqual(['rooms_a', ['2D:off(이 지형 시뮬 도면 지도 없음)', '3D:off(입체 기하는 2층 건물만)', 'SLAM:off(이 지형 SLAM 저장 지도 없음)'], n]);   // 요청 0 · 거짓 눌림 0
  expect(R.p.on).toBe(true);   // 보던 1층 건물 2D 그대로(자동 복귀·자동 선택 0)
  await React.act(async () => { R.p.view('v5/l1/20261011-100000-e1'); }); expect([sel().props.value, st()[2]]).toEqual(['v5_building', 'SLAM:on']);   // 아래 목록에서 고름 → select 따라감
  expect(R.asked.every((a) => READ.includes(a.op))).toBe(true); expect(R.sent).toEqual([]);
});

test('SLAM 실행이 아닐 때(저장 지도 시뮬·꺼짐) = 그 지형 최신 SLAM 저장본 · 목록 전 = 2D/SLAM 비활성 이유(3D 는 목록 무관)', async () => {
  link(SESS('static')); await mount(MAPS); await click(2);
  expect([R.p.live, R.asked.filter((a) => a.op === 'map_get').pop()!.x]).toEqual([false, { building_id: 'v5', floor_id: 'l1', map_version: '20261011-100000-e1' }]);
  await React.act(async () => { roots.pop().unmount(); });
  link(null); await mount(null);
  expect([sel().props.value, st()]).toEqual(['v5_single', ['2D:off(저장 지도 목록 받는 중)', '3D:off(입체 기하는 2층 건물만)', 'SLAM:off(저장 지도 목록 받는 중)']]);
  await pickW('v5_building'); expect([sel().props.value, st()]).toEqual(['v5_building', ['2D:off(저장 지도 목록 받는 중)', '3D:on', 'SLAM:off(저장 지도 목록 받는 중)']]);   // 2D/SLAM 못 고름 → 3D
  expect(R.sent).toEqual([]);
});
