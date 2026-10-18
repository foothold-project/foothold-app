import { afterAll, afterEach, beforeEach, expect, test } from 'vitest';
// 임무 2D(SPEC 59dbad0e · ROOT 경계 fed508f6): plan2d 순수 helper(첫 점 rid·확정 대조·추가 관문·이어 붙이기 지문·프리셋·도면 범위)와
// usePlanTerrain(직렬 슬롯·늦은 응답 폐기·기하 실패 = ok+이유·자동 재시도 0·«다시 읽기»)를 실제 코드로 본다.
// 대체 = 읽기 deps(손으로 푸는 약속) · 가짜 DOM(createRoot 장착용 최소 노드). 실제 서버 슬롯·브라우저 그림은 범위 밖(670·운영 미측정).
const mem = new Map<string, string>();
// 가짜 전역은 원래 descriptor 를 먼저 보관 → afterAll 에서 root 정리 뒤 되돌림(없던 키 delete) — 단일 fork 뒤 파일 오염 0(ROOT fixture 독립성)
const GKEYS = ['localStorage', 'window', 'document', 'IS_REACT_ACT_ENVIRONMENT', 'HTMLIFrameElement', 'addEventListener', 'removeEventListener'];
const SAVED = GKEYS.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)] as const);
const restoreG = () => { for (const [k, d] of SAVED) { if (d) Object.defineProperty(globalThis, k, d); else delete (globalThis as any)[k]; } };
(globalThis as any).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
class N {   // 가짜 DOM — pcplan2d_mount 의 N 과 같은 기본 API(react-dom 이 모듈 초기화·root 장착에 부르는 것)
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
}
const doc: any = { nodeType: 9, addEventListener() {}, removeEventListener() {}, documentElement: new N('HTML'), body: new N('BODY'), activeElement: null,
  createElement: (t: string) => new N(t.toUpperCase()), createElementNS: (_: string, t: string) => new N(t.toUpperCase()), createTextNode: (x: string) => Object.assign(new N('#text', 3), { nodeValue: x }),
  querySelectorAll: () => [], querySelector: () => null };
Object.assign(globalThis, { window: globalThis, document: doc, IS_REACT_ACT_ENVIRONMENT: true, HTMLIFrameElement: class {}, addEventListener() {}, removeEventListener() {} });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const P = await import('../../src/screens/plan2d');
const { useLink } = await import('../../src/data/link');
const { planMap, wkey } = await import('../../src/data/run');
const { BLD, okInfo } = await import('../../src/data/maps');
import type { MapInfo, Mission } from '@contracts';

const SW = 'a'.repeat(64), SW2 = 'b'.repeat(64), GS = 'c'.repeat(64), GS2 = 'd'.repeat(64);
const GEO = { building_id: 'v5', label: '', sdf_sha256: {}, floors: [{ floor_id: 'l1', z: 0 }, { floor_id: 'l2', z: 3 }], boxes: [], meshes: [], connectors: [] } as any;
const RAS = { img: {} as any, res: 0.1, ox: -5, oy: -5, w: 100, h: 100, label: 'gt' };
const S1 = { w: 'v5_single', f: 'f1' }, B1 = { w: 'v5_building', f: 'l1' }, B2 = { w: 'v5_building', f: 'l2' };
const hW = (rid = `w:${SW}`, w = 'v5_single', f = 'f1') => ({ map: { src: 'gt' as const, world_id: w, floor_id: f, key: '', rid } });
const W = () => [{ x: 1, y: 2, name: 'a', mods: [] }, { x: 3, y: 4, name: 'b', mods: [] }] as Mission['wps'];
// 실제 계약형 MapInfo(715 R1 fixture 지적): GT = epoch null · building_id = BLD[world] · map_version 은 서버 gt-YYYYMMDD 형식 · SLAM = epoch ≥1.
// 모든 fixture 가 실제 수신 필터 okInfo 를 통과하는지 먼저 단언(deps 대체는 hook 순서 검증용 — 실제 listMaps/getMap 수신 검증 아님)
const gtI = (w: keyof typeof BLD, f: string, o: Partial<MapInfo> = {}) => ({ world_id: w, building_id: BLD[w], floor_id: f, map_version: 'gt-20261012', map_source: 'gt_raster',
  epoch: null, resolution: 0.05, origin: [-10, -10, 0], width: 400, height: 400, saved_sim_t: null, ...o }) as MapInfo;
const mi = (map?: object): Mission => { const wps = W(); return { name: 'p', tmpl: 'base', memo: '', wps, ...(map ? { map: { key: wkey(wps), ...map } } : {}) } as Mission; };

test('presetOf/modsTxt: 집합이 정확히 같을 때만 프리셋 · 순서 무관 · 중복·부분·초과 = «기존 조합»(정규화 0)', () => {
  expect(P.presetOf(['운영자 확인'])?.name).toBe('지점 확인');
  expect(P.presetOf(['대기', '운영자 확인'])?.name).toBe('현장 확인 후 대기');
  expect(P.presetOf(['사진'])?.name).toBe('사진 기록');
  for (const m of [[], ['대기'], ['사진', '사진'], ['운영자 확인', '운영자 확인'], ['사진', '운영자 확인'], ['운영자 확인', '대기', '사진']]) expect(P.presetOf(m)).toBeUndefined();
  expect(P.modsTxt([])).toBe('기존 조합 · 이동만');
  expect(P.modsTxt(['사진', '대기'])).toBe('기존 조합 · 사진·대기');
});

test('inRaster: 도면 범위 안 유한 좌표만(clamp 0) · okT: WF 안 지형·층만', () => {
  expect(P.inRaster(RAS, 0, 0)).toBe(true); expect(P.inRaster(RAS, -5, 5)).toBe(true);
  for (const [x, y] of [[5.01, 0], [0, -5.01], [NaN, 0], [0, Infinity]]) expect(P.inRaster(RAS, x, y)).toBe(false);
  expect(P.okT({ src: 'gt', world_id: 'v5_building', floor_id: 'l2', key: '' } as any)).toBe(true);
  expect(P.okT({ src: 'gt', world_id: 'v5_single', floor_id: 'l1', key: '' } as any)).toBe(false);
  expect(P.okT(undefined)).toBe(false);
});

test('firstSrc: 건물 = 선택 층이 든 검증 기하 g: · 단층 = 같은 world·층의 유효 w: · 그 밖 rid 키 없음(연관만)', () => {
  expect(P.firstSrc(B2, { why: 'x' }, { g: GEO, sha: GS })).toEqual({ src: 'gt', world_id: 'v5_building', floor_id: 'l2', key: '', rid: `g:${GS}` });
  expect('rid' in P.firstSrc(B1, { why: 'x' }, { why: '처리 중' })).toBe(false);   // 기하 실패 → 조용한 결속 0
  expect('rid' in P.firstSrc(B1, { why: 'x' }, null)).toBe(false);
  expect('rid' in P.firstSrc({ w: 'v5_building', f: 'f1' }, { why: 'x' }, { g: GEO, sha: GS })).toBe(false);   // 기하에 없는 층
  expect(P.firstSrc(S1, hW(), null).rid).toBe(`w:${SW}`);
  expect('rid' in P.firstSrc(S1, { why: '연결 끊김' }, null)).toBe(false);          // offline
  expect('rid' in P.firstSrc(S1, hW(`w:${SW}`, 'v5_building', 'l1'), null)).toBe(false);   // 시뮬 지형 다름
  expect('rid' in P.firstSrc(S1, hW(`g:${GS}`), null)).toBe(false);                  // w: 형식 아님
  expect('rid' in P.firstSrc(S1, hW('w:abc'), null)).toBe(false);
});

test('pinRid: 고리 때 후보와 확정 때 값이 같을 때만 rid · 다르거나 확정 때 없으면 생략(나중 응답으로 보충·승격 0)', () => {
  const c = P.firstSrc(S1, hW(), null), none = P.firstSrc(S1, { why: 'x' }, null);
  expect(P.pinRid(c, c).rid).toBe(`w:${SW}`);
  expect('rid' in P.pinRid(c, none)).toBe(false);
  expect('rid' in P.pinRid(c, P.firstSrc(S1, hW(`w:${SW2}`), null))).toBe(false);
  expect('rid' in P.pinRid(none, c)).toBe(false);   // 고리 때 미확인 → 확정 때 확인돼도 보충 0
});

test('srcGate: rid 있는 계획만 막음 — 지형 다름·지문 깨짐·기하 미확인/불일치·같은 world 다른 w: · 근거 모름(offline)은 시작 때 정책', () => {
  expect(P.srcGate(mi(), S1, hW(), null)).toBeNull();
  expect(P.srcGate(mi({ src: 'gt', world_id: 'v5_single', floor_id: 'f1' }), S1, hW(`w:${SW2}`), null)).toBeNull();   // rid 없는 연관
  const s = mi({ src: 'gt', world_id: 'v5_single', floor_id: 'f1', rid: `w:${SW}` });
  expect(P.srcGate(s, S1, hW(), null)).toBeNull();
  expect(P.srcGate(s, S1, { why: '연결 끊김' }, null)).toBeNull();
  expect(P.srcGate(s, S1, hW(`w:${SW2}`), null)).toBe('계획 기준(실행 world)과 지금 시뮬 world 가 다름');
  expect(P.srcGate(s, B1, hW(), null)).toBe('계획 지형·층과 선택이 다름');
  const broken = { ...s, map: { ...s.map!, key: '00000000' } };
  expect(planMap(broken).map).toBeFalsy();
  expect(P.srcGate(broken, S1, hW(), null)).toBe('출처 기록 뒤 좌표가 바뀐 계획 — 추가·옮기기 안 됨');
  const b = mi({ src: 'gt', world_id: 'v5_building', floor_id: 'l1', rid: `g:${GS}` });
  expect(P.srcGate(b, B1, { why: 'x' }, { g: GEO, sha: GS })).toBeNull();
  expect(P.srcGate(b, B1, { why: 'x' }, { why: '처리 중' })).toBe('기하 파일 확인 안 됨 · 처리 중 — «다시 읽기»');
  expect(P.srcGate(b, B1, { why: 'x' }, null)).toBe('기하 파일 확인 안 됨 — «다시 읽기»');
  expect(P.srcGate(b, B1, { why: 'x' }, { g: GEO, sha: GS2 })).toBe('계획 기준(기하 파일)과 지금 도면의 기하가 다름');
});

test('keepSrc: rid 있음 = 공용 rekey · rid 없는 연관 = 같은 지형·층 + 수정 전 지문 일치일 때만 key 갱신(아니면 map 제거) · map 없음 = fn 만', () => {
  const a = mi({ src: 'gt', world_id: 'v5_single', floor_id: 'f1' });
  P.keepSrc(a, S1, () => { a.wps.push({ x: 0, y: 0, name: '', mods: [] }); });
  expect(a.map).toMatchObject({ world_id: 'v5_single', key: wkey(a.wps) }); expect('rid' in a.map!).toBe(false);
  const b = mi({ src: 'gt', world_id: 'v5_single', floor_id: 'f1' }); b.map!.key = '00000000';
  P.keepSrc(b, S1, () => { b.wps.pop(); }); expect(b.map).toBeUndefined();   // 깨진 지문 재지문화 0
  const c = mi({ src: 'gt', world_id: 'v5_single', floor_id: 'f1' });
  P.keepSrc(c, B1, () => { c.wps.pop(); }); expect(c.map).toBeUndefined();     // 선택과 다른 지형
  const r = mi({ src: 'gt', world_id: 'v5_single', floor_id: 'f1', rid: `w:${SW}` });
  P.keepSrc(r, S1, () => { r.wps.reverse(); }); expect(r.map).toMatchObject({ rid: `w:${SW}`, key: wkey(r.wps) });
  const o = mi(); P.keepSrc(o, S1, () => { o.wps.pop(); }); expect(o.map).toBeUndefined(); expect(o.wps).toHaveLength(1);
});

test('gtOf: 그 지형·층의 GT 래스터만(저장 SLAM 제외) · 여럿이면 저장 시각 최신', () => {
  const ms = [gtI('v5_single', 'f1', { map_source: 'slam', epoch: 2, map_version: '20261019T090000Z' }), gtI('v5_single', 'f1'), gtI('v5_single', 'f1', { map_version: 'gt-20261018' }), gtI('v5_building', 'l1')];
  for (const x of ms) expect(okInfo(x), JSON.stringify(x)).toBe(true);
  expect(P.gtOf(ms, S1)?.map_version).toBe('gt-20261018');
  expect(P.gtOf(ms, B2)).toBeNull();
});

// ---- usePlanTerrain: 가짜 deps(손으로 푸는 약속) · 동시 진행 수를 셈(이 화면 요청끼리 겹침 0) ----
type Q = { k: 'list' | 'get' | 'geom'; arg?: unknown; res: (v: unknown) => void };
const q: Q[] = []; let busy = 0, peak = 0;
const call = (k: Q['k'], arg?: unknown) => new Promise<any>((res) => { busy++; peak = Math.max(peak, busy); q.push({ k, arg, res: (v) => { busy--; res(v); } }); });
const deps = { list: () => call('list'), get: (m: MapInfo) => call('get', m), geom: () => call('geom') } as any;
const MS = [gtI('v5_single', 'f1'), gtI('v5_building', 'l1'), gtI('v5_building', 'l2')];
test('fixture: 목록 대역이 실제 수신 필터(okInfo)를 통과', () => { for (const x of MS) expect(okInfo(x), JSON.stringify(x)).toBe(true); });
const R = { v: null as any };
function Probe({ t }: { t: { w: string; f: string } | null }) { R.v = P.usePlanTerrain(t, deps); return null; }
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const roots: any[] = [];
const mount = async (t: { w: string; f: string } | null) => {
  const root: any = createRoot(new N('DIV') as any); roots.push(root);
  const show = async (x: typeof t) => { await React.act(async () => { root.render(React.createElement(Probe, { t: x })); }); await React.act(flush); };
  await show(t); return show;
};
const answer = async (i: number, v: unknown) => { await React.act(async () => { q[i].res(v); }); await React.act(flush); };
const linkOn = (gen = 1, provider = 'simulation_gate') => useLink.setState({ open: true, gen, stGen: gen, provider } as any);
beforeEach(() => { q.length = 0; busy = 0; peak = 0; R.v = null; linkOn(); });
afterEach(async () => { for (const r of roots.splice(0)) await React.act(async () => r.unmount()); });
afterAll(async () => { for (const r of roots.splice(0)) await React.act(async () => r.unmount()); restoreG(); });

test('hook: 선택 없음 = off · 연결 없음/status 전 = nolink(요청 0) · 단층 = 목록→도면 후 ok(geo null)', async () => {
  await mount(null); expect(R.v.k).toBe('off');
  useLink.setState({ open: true, gen: 2, stGen: 1 } as any);
  const show = await mount(S1); expect(R.v.k).toBe('nolink'); expect(q).toHaveLength(0);
  linkOn(2); await show(S1); expect(R.v.k).toBe('loading'); expect(q.map((x) => x.k)).toEqual(['list']);
  await answer(0, MS); expect(q[1]).toMatchObject({ k: 'get', arg: { world_id: 'v5_single', floor_id: 'f1' } });
  await answer(1, RAS); expect(R.v).toMatchObject({ k: 'ok', ras: RAS, geo: null });
});

test('hook: A→B→A 빠른 전환 — 한 슬롯에서 순서대로(동시 1) · 앞 선택의 늦은 결과는 버리고 마지막 선택만 표시', async () => {
  const show = await mount(B1); await show(B2); await show(B1);
  expect(q.map((x) => x.k)).toEqual(['list']);   // 뒤 요청은 앞 체인 뒤에서 대기
  await answer(0, MS);                           // 첫 B1 요청은 B2 로 바뀔 때 gone — 결과·목록 캐시 모두 버림(같은 B1 key 로 돌아와도 새 effect)
  for (let i = 1; i < 20 && q.length > i; i++) {
    const x = q[i]; await answer(i, x.k === 'get' ? RAS : x.k === 'geom' ? { g: GEO, sha: GS } : MS);
  }
  expect(peak).toBe(1);
  expect(R.v).toMatchObject({ k: 'ok', geo: { sha: GS } });
  expect(q.filter((x) => x.k === 'list')).toHaveLength(2);   // 버린 첫 요청 1 + 마지막 B1 1 · 가운데 B2 는 요청 0(체인 차례에 gone)
  expect(q.filter((x) => x.k === 'get')).toHaveLength(1);
  expect(q.filter((x) => x.k === 'geom')).toHaveLength(1);   // 같은 연결 기하 성공 재사용
});

test('hook: 응답 전 연결 세대가 바뀌면 늦은 성공·실패 모두 버림 · 새 세대는 목록부터 다시', async () => {
  await mount(S1); expect(q.map((x) => x.k)).toEqual(['list']);
  linkOn(3); await React.act(flush);
  await answer(0, MS); expect(R.v.k).toBe('loading');   // 옛 세대 결과 → map_get 도 안 보냄
  expect(q.filter((x) => x.k === 'get')).toHaveLength(0);
  expect(q.filter((x) => x.k === 'list')).toHaveLength(2);
  await answer(1, '처리 중'); expect(R.v).toMatchObject({ k: 'fail', why: '처리 중' });
});

test('hook: 기하 실패 = 도면 ok + geo.why(첫 점 rid 생략용) · 자동 재시도 0 · «다시 읽기» = 목록부터 1회', async () => {
  await mount(B1);
  await answer(0, MS); await answer(1, RAS); expect(q[2].k).toBe('geom');
  await answer(2, '처리 중');
  expect(R.v).toMatchObject({ k: 'ok', ras: RAS, geo: { why: '처리 중' } });
  await React.act(flush); expect(q).toHaveLength(3);   // 자동 재시도 0
  await React.act(async () => R.v.retry()); await React.act(flush);
  expect(R.v.k).toBe('loading'); expect(q.slice(3).map((x) => x.k)).toEqual(['list']);
  await answer(3, MS); await answer(4, RAS); await answer(5, { g: GEO, sha: GS });
  expect(R.v).toMatchObject({ k: 'ok', geo: { sha: GS } });
});

test('hook: 도면 없음(목록에 GT 없음) = nomap · 목록 실패 = fail(이유 원문)', async () => {
  await mount({ w: 'rooms_a', f: 'f1' });
  await answer(0, MS); expect(R.v.k).toBe('nomap');
  // 독립 두 번째 분기: 옛 Probe 를 act 안에서 떼고(옛 대상 재요청 0) 새 연결 세대에서 새로 장착 — 새 요청 1개(list)에만 실패 응답
  const r0 = roots.pop(); await React.act(async () => r0.unmount());
  linkOn(4); await mount(S1);
  expect(q.map((x) => x.k)).toEqual(['list', 'list']);
  await answer(1, '목록 받기 실패'); expect(R.v).toMatchObject({ k: 'fail', why: '목록 받기 실패' });
});

test('hook N1: 완료된 A → B(미완료) → A 복귀 = 새 요청이 끝나기 전 옛 A 결과 재노출 0(loading) · 새 결과는 새 도면 순번 n', async () => {
  const show = await mount(S1);
  await answer(0, MS); await answer(1, RAS);
  expect(R.v).toMatchObject({ k: 'ok', ras: RAS }); const n1 = R.v.n;
  await show({ w: 'v5_building', f: 'l1' }); expect(R.v.k).toBe('loading');   // B 는 목록 재사용 → map_get 대기
  expect(q[2]).toMatchObject({ k: 'get' });
  await show(S1);
  expect(R.v.k).toBe('loading');   // 옛 A(res.key 같음)를 다시 ok 로 돌려주지 않음
  await answer(2, RAS);            // B 늦은 성공 = 버림
  expect(R.v.k).toBe('loading');
  const RAS2 = { ...RAS, label: 'gt2' };
  await answer(3, RAS2);
  expect(R.v).toMatchObject({ k: 'ok', ras: RAS2 }); expect(R.v.n).toBeGreaterThan(n1);
});

// ---- R3b·ROOT 7·8 새 임무 만들기 helper(SPEC-CREATE-R3 · ROOT-IMPLEMENT-DEPLOY 24434027 · UX-SPEC R1 5-1·5-3·5-6) ----
const W2 = [{ x: 0, y: 0, name: '창고 앞', mods: ['사진'] }, { x: 1, y: 0, name: ' ', mods: ['운영자 확인'] }] as Mission['wps'];
test('flowTxt: 종료 방식 없으면 흐름 없음 · S 없으면 «임무 시작 위치»/«시작 위치로 복귀» · S 있으면 «S 출발점»/«S 로 복귀» · 이름 비면 «지점 n»', () => {
  expect(P.flowTxt(W2, undefined)).toBeNull(); expect(P.flowTxt([], '출발점 복귀')).toBeNull(); expect(P.flowTxt([], '출발점 복귀', true)).toBeNull();
  expect(P.flowTxt(W2, '출발점 복귀')).toEqual(['임무 시작 위치', '1 창고 앞 · 사진 기록', '2 지점 2 · 지점 확인', '시작 위치로 복귀']);
  expect(P.flowTxt(W2, '마지막 지점 종료')).toEqual(['임무 시작 위치', '1 창고 앞 · 사진 기록', '2 지점 2 · 지점 확인 · 여기서 종료']);
  expect(P.flowTxt([W2[0]], '마지막 지점 종료')).toEqual(['임무 시작 위치', '1 창고 앞 · 사진 기록 · 여기서 종료']);
  expect(P.flowTxt(W2, '출발점 복귀', true)).toEqual(['S 출발점', '1 창고 앞 · 사진 기록', '2 지점 2 · 지점 확인', 'S 로 복귀']);
  expect(P.flowTxt(W2, '마지막 지점 종료', true)).toEqual(['S 출발점', '1 창고 앞 · 사진 기록', '2 지점 2 · 지점 확인 · 여기서 종료']);
  expect(P.FINISH.map((f) => f.v)).toEqual(['출발점 복귀', '마지막 지점 종료']);
});
test('createWhy: 빠진 것 전부 한 줄(① 지형 · ③ 목적지 · ④ 종료 방식(새 임무만) · ⑥ 이름) · ② 출발점 S 는 선택(막지 않음) · 옛 임무(id 있음) 키 없음은 ④ 요구 0', () => {
  const W = [{ x: 0, y: 0, name: '', mods: [] }] as Mission['wps'];
  const m = (o: Partial<Mission> = {}): Mission => ({ name: '', tmpl: 'base', memo: '', wps: [], ...o });
  expect(P.createWhy(m(), true, false)).toBe('만들려면: ① 지형 · ③ 목적지 1곳 이상 · ④ 종료 방식 · ⑥ 이름');
  expect(P.createWhy(m(), true, true)).toBe('만들려면: ③ 목적지 1곳 이상 · ④ 종료 방식 · ⑥ 이름');
  expect(P.createWhy(m({ wps: W }), true, true)).toBe('만들려면: ④ 종료 방식 · ⑥ 이름');
  expect(P.createWhy(m({ wps: W, finish: '출발점 복귀' }), true, true)).toBe('만들려면: ⑥ 이름');
  expect(P.createWhy(m({ wps: W, finish: '출발점 복귀', name: '   ' }), true, true)).toBe('만들려면: ⑥ 이름');   // 공백만 = 이름 없음
  expect(P.createWhy(m({ wps: W, finish: '마지막 지점 종료', name: 'x' }), true, true)).toBe('');
  expect(P.createWhy(m({ wps: W, name: '옛' }), false, false)).toBe('');           // 옛 임무: 키 없음 그대로 저장 허용(지형 없는 목록만 계획 포함)
  expect(P.createWhy(m({ wps: W }), false, true)).toBe('만들려면: ⑥ 이름');
  expect(P.createWhy(m({ wps: W, finish: '출발점 복귀', name: 'x' }), true, true)).toBe('');   // S 없음 = 막힘 0(ROOT 8 선택)
  expect(P.createWhy(m({ name: 'x', finish: '출발점 복귀', start: { x: 1, y: 1, map: { world_id: 'v5_single', floor_id: 'f1', key: 'k' } } as any }), true, true)).toBe('만들려면: ③ 목적지 1곳 이상');   // S 만으론 목적지 대신 0
});
test('autoName: «{지형·층} 임무 MM-DD HH:mm» · 지형 미정 «임무 …» · 60자 안 · mdhm 두 자리', () => {
  const t = new Date(2026, 9, 9, 7, 5);
  expect(P.mdhm(t)).toBe('10-09 07:05');
  expect(P.autoName(null, t)).toBe('임무 10-09 07:05');
  const a = P.autoName({ w: 'v5_single', f: 'f1' }, t); expect(a.endsWith(' 임무 10-09 07:05')).toBe(true); expect(a.length).toBeLessThanOrEqual(60); expect(a.startsWith('임무')).toBe(false);
});
test('mkStart: start.map = 받은 출처 + key = wkey([S]) · 받은 출처 객체 변경 0', () => {
  const src = { world_id: 'v5_single', floor_id: 'f1', rid: 'r9', key: 'old' } as any, before = JSON.stringify(src);
  const s = P.mkStart(1.25, -2, src);
  expect(s).toMatchObject({ x: 1.25, y: -2, map: { world_id: 'v5_single', floor_id: 'f1', rid: 'r9' } }); expect(s.map.key).not.toBe('old');
  expect(P.mkStart(1.25, -2, { world_id: 'v5_single', floor_id: 'f1' } as any).map.key).toBe(s.map.key);   // key 는 좌표로만(출처 무관)
  expect(P.mkStart(1.26, -2, src).map.key).not.toBe(s.map.key); expect(JSON.stringify(src)).toBe(before);
});
test('sView: 없음 none · 같은 도면·자기 key·부모 같은 지형/rid = ok · 그 밖 other(이유) — 원문 그대로 돌려줌(고침 0)', () => {
  const T = { w: 'v5_single', f: 'f1' } as any, s = P.mkStart(1, 2, { world_id: 'v5_single', floor_id: 'f1', rid: 'r1' } as any);
  const m = (o: Partial<Mission> = {}): Mission => ({ name: '', tmpl: 'base', memo: '', wps: [], ...o });
  expect(P.sView(m(), T)).toEqual({ k: 'none' });
  expect(P.sView(m({ start: s }), T)).toEqual({ k: 'ok', s });
  expect(P.sView(m({ start: s, map: { world_id: 'v5_single', floor_id: 'f1', rid: 'r1', key: 'x' } as any }), T).k).toBe('ok');
  expect(P.sView(m({ start: s, map: { world_id: 'v5_single', floor_id: 'f1', key: 'x' } as any }), T).k).toBe('ok');   // rid 없는 연관 = ok
  const o = (mm: Mission, t: any = T) => { const v = P.sView(mm, t); expect(v.k).toBe('other'); return v.k === 'other' ? v.why : ''; };
  expect(o(m({ start: s }), null)).toContain('지형 정보 없는');
  expect(o(m({ start: s }), { w: 'v5_single', f: 'f2' })).toContain('지형·층');
  const moved = { ...s, x: 1.5 }; const before = JSON.stringify(moved); expect(o(m({ start: moved }))).toContain('좌표가 바뀜'); expect(JSON.stringify(moved)).toBe(before);
  expect(o(m({ start: s, map: { world_id: 'v5_building', floor_id: 'f1', key: 'x' } as any }))).toContain('목적지 계획');
  expect(o(m({ start: s, map: { world_id: 'v5_single', floor_id: 'f1', rid: 'r2', key: 'x' } as any }))).toContain('좌표 기준');
});
