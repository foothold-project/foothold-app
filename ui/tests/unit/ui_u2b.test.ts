import { afterEach, expect, test, vi } from 'vitest';
// U2-b(결정 7): PC 지도 탭 왼쪽 위 «지형 + 2D/3D/SLAM» — 보기 전용. 실제 useMapPick 을 react-dom createRoot(가짜 DOM)로 장착하고
// 돌려준 bar 요소의 select·단추 props 를 직접 부른다. 대체: link 의 ask(읽기 op 기록)·sendOp·sendStop(불리면 기록) · Image(해독 성공 흉내 — 정상 그림 fixture).
// map_get 답 = R.mapOk 면 목록의 그 지도 meta + png(정상 그림), 아니면 실패 답. map_list 답 = R.listOk 면 R.maps, 아니면 실패.
// 715 R1~R4 보완 확인: 볼 지도 없는 지형 = select·그림 그대로 + 읽을 수 있는 이유 · «실행 중»/실시간 = 유효 status + running 만 ·
// 같은 저장 시각 = 고정 규칙 + 한계 글 · 못 보는 단추 = 누르면 이유 글(요청 0).
const R = vi.hoisted(() => ({ asked: [] as { op: string; x: any }[], sent: [] as string[], maps: [] as any[], p: null as any, mapOk: false, listOk: true }));
vi.mock('../../src/data/link', async (orig) => ({ ...(await orig<typeof import('../../src/data/link')>()),
  ask: (op: string, x: any = {}) => {
    R.asked.push({ op, x });
    if (op === 'map_list') return Promise.resolve(R.listOk ? { op: 'reply', ok: true, maps: R.maps } : { op: 'reply', ok: false, text: '시험 — 목록 실패' });
    const m = op === 'map_get' && R.mapOk && R.maps.find((y) => y.building_id === x.building_id && y.floor_id === x.floor_id && y.map_version === x.map_version);
    return Promise.resolve(m ? { op: 'reply', ok: true, map: { ...m, png: 'AAAA' } } : { op: 'reply', ok: false, text: '시험 — 그림 안 받음' });
  },
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
class Img { src = ''; naturalWidth = 10; naturalHeight = 10; decode() { return Promise.resolve(); } }   // 정상 그림: 해독 성공 · meta 크기(10×10)와 같음
Object.assign(globalThis, { window: globalThis, document: doc, addEventListener() {}, removeEventListener() {}, IS_REACT_ACT_ENVIRONMENT: true, HTMLIFrameElement: class {}, Image: Img,
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, location: { href: 'http://127.0.0.1/', protocol: 'http:', hash: '', search: '', pathname: '/' } });
vi.spyOn(console, 'error').mockImplementation(() => {});

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useLink } = await import('../../src/data/link');
const { useMapPick } = await import('../../src/map/MapPick');

const M = (world_id: string, building_id: string, floor_id: string, map_version: string, slam: boolean, epoch = 1) =>
  ({ world_id, building_id, floor_id, map_version, map_source: slam ? 'slam' : 'gt_raster', epoch: slam ? epoch : null, resolution: 0.05, origin: [0, 0, 0], width: 10, height: 10 });
const MAPS = [M('v5_single', 'v5_single', 'f1', 'gt-20261001', false), M('v5_single', 'v5_single', 'f1', '20261012-090000-e2', true, 2), M('v5_single', 'v5_single', 'f1', '20261010-120000-e1', true),
  M('v5_building', 'v5', 'l1', 'gt-20261001', false), M('v5_building', 'v5', 'l2', 'gt-20261001', false), M('v5_building', 'v5', 'l1', '20261011-100000-e1', true)];
const SESS = (map_mode: string, result = 'running') => ({ runner: 'live_map', result, world_id: 'v5_building', floor_id: 'l1', map_mode });
const link = (sess: any) => useLink.setState({ open: true, bad: null, gen: 1, stGen: 1, lastMsg: performance.now(), provider: 'simulation_gate', st: { map_start: { session: sess }, live_map: null } as any });

const roots: any[] = [];
afterEach(async () => { for (const r of roots.splice(0)) await React.act(async () => r.unmount()); R.asked = []; R.sent = []; R.mapOk = false; R.listOk = true; });
const H = () => { R.p = useMapPick(false, true); return null; };
const mount = async (maps: any[] | null) => {
  R.maps = maps ?? []; if (!maps) useLink.setState({ stGen: 0 });   // 목록 못 받은 상태 = 이 연결 유효 status 전(loadList 안 보냄)
  const root: any = createRoot(new N('DIV') as any); roots.push(root);
  await React.act(async () => { root.render(React.createElement(H)); });
  await React.act(async () => { R.p.view(''); });   // 다른 시험이 남긴 공유 선택 → 시뮬 바닥(GT)으로
};
const sel = () => R.p.bar.props.children[0], btns = () => R.p.bar.props.children[1].props.children as any[];
const opts = () => sel().props.children.flat().filter(Boolean).map((o: any) => o.props.children);   // [«지형 고르기»?, 지형들]
const msg = () => { const c = R.p.bar.props.children[2]; return c ? c.props.children : null; };   // bar 안 읽을 수 있는 글(role=status)
const st = () => btns().map((b) => `${b.props.children}:${b.props['aria-pressed'] ? 'on' : b.props['aria-disabled'] ? `off(${b.props.title})` : '-'}`);
const click = async (i: number) => { await React.act(async () => { btns()[i].props.onClick({ preventDefault() {}, stopPropagation() {} }); }); };
const pickW = async (w: string) => { await React.act(async () => { sel().props.onChange({ target: { value: w } }); }); };
const settle = async () => { for (let i = 0; i < 4; i++) await React.act(async () => { await Promise.resolve(); }); };
const READ = ['map_list', 'map_get', 'map_live_get', 'geom_get'];
const { renderToStaticMarkup } = await import('react-dom/server');
const PcView = (await import('../../src/screens/PcMap.view')).View;

test('실행 중 2층 건물 SLAM — 지형 기본 = 실행 지형 · 2D=층 나란히 · 3D=입체 기하 · SLAM=실시간 · 눌림은 지금 보기 · 읽기 op 만', async () => {
  link(SESS('slam')); await mount(MAPS);
  expect([sel().props.value, opts()]).toEqual(['v5_building', ['1층 건물', '2층 건물 · 실행 중', '새 매핑 공간']]);
  expect(st()).toEqual(['2D:-', '3D:-', 'SLAM:-']);   // 시뮬 바닥 보기 = 어느 것도 안 눌림
  await click(0); expect([st(), R.p.on, R.p.live]).toEqual([['2D:on', '3D:-', 'SLAM:-'], true, false]);
  expect(R.p.blank).toMatch(/^층 나란히 보기 미표시/);   // 2D(2층) = 층 한 장이 아니라 층 나란히 보기
  expect(R.asked.filter((a) => a.op === 'map_get')[0].x).toEqual({ building_id: 'v5', floor_id: 'l1', map_version: 'gt-20261001' });   // 층 나란히 = 층별 GT 차례로(첫 층 실패에서 멈춤)
  await click(1); expect(st()).toEqual(['2D:-', '3D:on', 'SLAM:-']); expect(R.asked.some((a) => a.op === 'geom_get' && a.x.building_id === 'v5')).toBe(true);
  await click(2); expect([st(), R.p.live]).toEqual([['2D:-', '3D:-', 'SLAM:on'], true]);
  expect(R.asked.every((a) => READ.includes(a.op))).toBe(true); expect(R.sent).toEqual([]);
  expect(useLink.getState().st).toEqual({ map_start: { session: SESS('slam') }, live_map: null });   // 실행 지형·세션 그대로
});

test('R1 정상 그림 A → 볼 지도 없는 B: select·그림 A 그대로 + 이유 글 · 요청 0 / R4 못 보는 단추 누름 = 이유 글만 / 다른 곳에서 고르면 select 따라감', async () => {
  link(SESS('slam')); R.mapOk = true; await mount(MAPS);
  await pickW('v5_single'); await settle();   // 지금 방식 없음 → 2D = 1층 건물 GT
  const A = R.p.raster;
  expect([sel().props.value, st()[0], A?.label, A?.w]).toEqual(['v5_single', '2D:on', '1층 건물 · 시뮬 도면 지도 · gt-20261001', 10]);   // 정상 그림 실제로 받음
  const n = R.asked.length; await pickW('rooms_a');
  expect([sel().props.value, R.p.raster, R.p.on, R.asked.length]).toEqual(['v5_single', A, true, n]);   // select 는 실제 보기(A) · 그림 A · 요청 0
  expect(msg()).toBe('새 매핑 공간 — 볼 지도 없음(2D 이 지형 시뮬 도면 지도 없음 · 3D 입체 기하는 2층 건물만 · SLAM 이 지형 SLAM 저장 지도 없음) · 보던 화면 그대로');
  await click(1);   // R4: 1층 건물 3D = 못 봄 → 누르면 이유 글(aria-disabled · 초점 가능)
  expect([st()[1], msg(), R.asked.length, R.p.raster]).toEqual(['3D:off(입체 기하는 2층 건물만)', '3D 못 봄 · 입체 기하는 2층 건물만', n, A]);
  expect(btns()[1].props.disabled).toBeUndefined();   // disabled 아님 = 키보드 초점·터치 누름으로 이유 읽음
  await React.act(async () => { R.p.view('v5/l1/20261011-100000-e1'); }); expect([sel().props.value, st()[2], msg()]).toEqual(['v5_building', 'SLAM:on', null]);   // 아래 목록에서 고름 → select 따라감 · 옛 글 사라짐
  expect(R.asked.every((a) => READ.includes(a.op))).toBe(true); expect(R.sent).toEqual([]);
});

test('R1 초기 sel 빈 상태(시뮬 바닥)에서 B 고름 = on 그대로 false·select 실행 지형 · 그림 실패 = 그 보기 + 이유 · 목록 실패 = 이유 글', async () => {
  link(SESS('slam')); await mount(MAPS);
  await pickW('rooms_a');
  expect([R.p.on, sel().props.value, msg()]).toEqual([false, 'v5_building', expect.stringMatching(/^새 매핑 공간 — 볼 지도 없음.* · 보던 화면 그대로$/)]);   // «B 인데 시뮬 바닥» 표시 0
  await pickW('v5_single'); await settle();   // 그림 실패(mapOk=false) = 기존 정책: 그 보기 유지 + 빈 칸 + 이유(자동 복귀 0)
  expect([sel().props.value, R.p.raster, R.p.blank]).toEqual(['v5_single', null, '저장 지도 미표시 · 시험 — 그림 안 받음']);
  await React.act(async () => { roots.pop().unmount(); });
  R.listOk = false; link(SESS('slam')); await mount(MAPS); await settle();
  await pickW('v5_single');
  expect([sel().props.value, R.p.on, msg()]).toEqual(['v5_building', false, '1층 건물 — 볼 지도 없음(2D 저장 지도 목록 · 시험 — 목록 실패 · 3D 입체 기하는 2층 건물만 · SLAM 저장 지도 목록 · 시험 — 목록 실패) · 보던 화면 그대로']);
  expect(R.sent).toEqual([]);
});

test('R2 «실행 중»·실시간 = 유효 status + running 만: starting · stale · bad · stGen 불일치 · 닫힘 → 복구', async () => {
  link(SESS('slam', 'starting')); await mount(MAPS);
  expect([sel().props.value, opts()[1]]).toEqual(['v5_building', '2층 건물 · 시작 중']);
  await click(2); expect([R.p.live, R.asked.filter((a) => a.op === 'map_get').pop()!.x.map_version]).toEqual([false, '20261011-100000-e1']);   // 시작 중 = 실시간 아님 → 최신 SLAM 저장본
  await React.act(async () => { R.p.view(''); });
  const unk = async (s: any) => { await React.act(async () => { useLink.setState(s); }); return [sel().props.value, opts(), st()[2]]; };
  const U = ['', ['지형 고르기', '1층 건물', '2층 건물 · 실행 상태 미확인', '새 매핑 공간'], 'SLAM:off(지형 먼저 고르기)'];   // 옛 값으로 실행 중·지형 기본값 0
  link(SESS('slam'));
  expect(await unk({ lastMsg: performance.now() - 5000 })).toEqual(U);   // 수신 중단(stale)
  expect(await unk({ lastMsg: performance.now(), bad: 'session' })).toEqual(U);   // 형식 오류
  expect(await unk({ bad: null, gen: 2 })).toEqual(U);   // 재연결 첫 status 전(stGen ≠ gen)
  expect(await unk({ gen: 1, open: false })).toEqual(U);   // 닫힘
  expect(await unk({ open: true, lastMsg: performance.now() })).toEqual(['v5_building', ['1층 건물', '2층 건물 · 실행 중', '새 매핑 공간'], 'SLAM:-']);   // 복구
  await click(2); expect(R.p.live).toBe(true);
  expect(R.sent).toEqual([]);
});

test('R3 같은 저장 시각: 글자 순(e9>e10) 아님 · 고정 규칙(epoch 큰 것 → 층 순) + 한계 글 · 다른 시각이면 시각 순(epoch 무관)', async () => {
  const T = [M('v5_building', 'v5', 'l2', '20261013-080000-e9', true, 9), M('v5_building', 'v5', 'l1', '20261013-080000-e10', true, 10), M('v5_building', 'v5', 'l2', '20261013-080000-e10', true, 10),
    M('v5_building', 'v5', 'l1', '20261012-235959-e30', true, 30), M('v5_single', 'v5_single', 'f1', '20261014-000000-e1', true), M('v5_single', 'v5_single', 'f1', '20261013-235959-e7', true, 7)];
  link(SESS('static')); await mount(T);
  await click(2);
  expect(R.asked.filter((a) => a.op === 'map_get').pop()!.x).toEqual({ building_id: 'v5', floor_id: 'l1', map_version: '20261013-080000-e10' });
  const T0 = '같은 저장 시각 3개 — 선후 모름 · 고정 규칙(epoch 큰 것 → 층 순)으로 1층 · SLAM 저장 지도 · 20261013-080000-e10 고름';
  await settle(); expect([msg(), R.p.raster]).toEqual([`${T0} · 받기 실패 — 그림 없음(가운데 이유)`, null]);   // G2: 받기 실패에 «표시» 단정 0 · 선택(눌림)은 유지
  expect(st()[2]).toBe('SLAM:on');
  R.mapOk = true; await click(2); await settle();
  expect([msg(), R.p.raster?.label]).toEqual([`${T0} · 표시 중`, '2층 건물 · 1층 · SLAM 저장 지도 · 20261013-080000-e10']);   // 정상 그림 받은 뒤에만 «표시 중»
  await pickW('v5_single');
  expect([R.asked.filter((a) => a.op === 'map_get').pop()!.x.map_version, msg()]).toEqual(['20261014-000000-e1', null]);   // 더 늦은 시각 = e1 이라도 최신 · 동률 아님 = 글 0
});

test('SLAM 실행이 아닐 때(저장 지도 시뮬·꺼짐) = 그 지형 최신 SLAM 저장본 · 목록 전 = 지형 미정 → 고르면 2D/SLAM 이유(3D 는 목록 무관)', async () => {
  link(SESS('static')); await mount(MAPS); await click(2);
  expect([R.p.live, R.asked.filter((a) => a.op === 'map_get').pop()!.x]).toEqual([false, { building_id: 'v5', floor_id: 'l1', map_version: '20261011-100000-e1' }]);
  await React.act(async () => { roots.pop().unmount(); });
  link(null); await mount(null);
  expect([sel().props.value, st()]).toEqual(['', ['2D:off(지형 먼저 고르기)', '3D:off(지형 먼저 고르기)', 'SLAM:off(지형 먼저 고르기)']]);
  await React.act(async () => { R.p.view('v5_single/f1/gt-20261001'); }); expect(sel().props.value).toBe('v5_single');   // 목록 전 저장본 보기 = 지형은 키에서(«지형 고르기» 아님)
  await pickW('v5_building'); expect([sel().props.value, st()]).toEqual(['v5_building', ['2D:off(저장 지도 목록 받는 중)', '3D:on', 'SLAM:off(저장 지도 목록 받는 중)']]);   // 2D/SLAM 못 고름 → 3D
  expect(R.sent).toEqual([]);
});

test('G1 배치: bar = 흐름 줄(absolute 0) · 실제 PcMap View 에서 도구줄 뒤·그림 칸(position:relative) 앞 · 그림 칸 밖(3D 층 단추·캔버스 층 이름·오른쪽 단추와 다른 상자)', async () => {
  link(SESS('slam')); await mount(MAPS);
  expect([R.p.bar.props.style.position, R.p.bar.props.style.zIndex]).toEqual([undefined, undefined]);
  expect([R.p.bar.props.style.padding, R.p.bar.props.style.borderBottom]).toEqual(['6px 10px', '1px solid var(--line)']);   // PC = 도구줄 아래 흐름 줄(폰 머리줄 분기와 따로 · MMap 장착 뒤에도 그대로)
  const s = renderToStaticMarkup(React.createElement(PcView, { v: { mapBar: R.p.bar, map: React.createElement('i', { 'data-pic': '' }) } }));
  const i = { tb: s.indexOf('role="toolbar"'), bar: s.indexOf('data-mapview-bar'), rel: s.indexOf('<div style="position:relative">'), pic: s.indexOf('data-pic') };
  expect(i.tb >= 0 && i.tb < i.bar && i.bar < i.rel && i.rel < i.pic).toBe(true);
  expect(s.slice(i.bar, i.rel).endsWith('</span></span>')).toBe(true);   // bar 상자(단추 묶음 포함)가 그림 칸 열리기 전에 닫힘
  expect(s.match(/data-mapview-bar/g)!.length).toBe(1);
  const src = Object.values(import.meta.glob<string>('../../src/screens/PcMap.tsx', { query: '?raw', import: 'default', eager: true }))[0];   // PcMap 연결(장착 렌더 시험 없음 — 소스 계약만): bar 는 mapBar 로만, 그림 칸(map)엔 없음
  expect([src.includes('mapBar: bar,'), /map: <>\{bar\}/.test(src)]).toEqual([true, false]);
});
