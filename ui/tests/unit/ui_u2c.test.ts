import { afterEach, expect, test, vi } from 'vitest';
// U2-c(정본 REVAMP-WORK-ORDER «U2 요구» · DECISIONS 7): 관제(Main) 오른쪽 칸 = 시뮬 실행(SimRun — «시뮬 ▾»와 같은 코드) · 지도 보기(보기만) · 임무(저장 임무 고르기 → 임무 계획), 사건 기록은 그 아래.
// 실제 Main 을 createRoot(가짜 DOM)에 장착(ui_u2b_mmap 방식). 대체 = View(받은 v 만 잡음)·MapCanvas(null)·link ask/sendOp/sendStop/dropAll(기록).
// runPanel 은 v.runPanel 을 가짜 DOM 에 다시 장착해 글·순서를 읽고, 누름은 React 가 노드에 둔 props(__reactProps$)의 onClick/onChange 를 직접 부른다.
const R = vi.hoisted(() => ({ asked: [] as string[], sent: [] as string[], v: null as any }));
vi.mock('../../src/data/link', async (orig) => ({ ...(await orig<typeof import('../../src/data/link')>()),
  ask: (op: string) => { R.asked.push(op); return Promise.resolve(op === 'map_list' ? { op: 'reply', ok: true, maps: [] } : { op: 'reply', ok: false, text: '시험 — 안 받음' }); },
  sendOp: (op: string) => { R.sent.push(op); return true; }, sendStop: () => { R.sent.push('stop'); return true; }, dropAll: () => { R.sent.push('drop'); } }));
vi.mock('../../src/app/shell', async (orig) => ({ ...(await orig<typeof import('../../src/app/shell')>()), toast: () => {} }));
vi.mock('../../src/screens/Main.view', async (orig) => ({ ...(await orig<typeof import('../../src/screens/Main.view')>()), View: ({ v }: { v: any }) => { R.v = v; return null; } }));
vi.mock('../../src/map/MapCanvas', async (orig) => ({ ...(await orig<typeof import('../../src/map/MapCanvas')>()), MapCanvas: () => null }));
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
  get options() { return this.children.filter((c) => c.nodeName === 'OPTION'); }
  addEventListener() {} removeEventListener() {}
}
const doc: any = { addEventListener() {}, removeEventListener() {}, nodeType: 9, fullscreenElement: null, activeElement: null, hidden: false, documentElement: new N('HTML'), body: new N('BODY'),
  createElement: (t: string) => new N(t.toUpperCase()), createElementNS: (_: string, t: string) => new N(t.toUpperCase()), createTextNode: (s: string) => Object.assign(new N('#text', 3), { nodeValue: s }),
  querySelectorAll: () => [], querySelector: () => null };
Object.assign(globalThis, { window: globalThis, document: doc, addEventListener() {}, removeEventListener() {}, IS_REACT_ACT_ENVIRONMENT: true, HTMLIFrameElement: class {},
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, location: { href: 'http://127.0.0.1/#/Main', protocol: 'http:', hash: '#/Main', search: '', pathname: '/' } });
vi.spyOn(console, 'error').mockImplementation(() => {});

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { QueryClientProvider } = await import('@tanstack/react-query');
const { qc } = await import('../../src/data/shared');
const { useLink } = await import('../../src/data/link');
const Main = (await import('../../src/screens/Main')).default;
const ser = (n: N): string => n.nodeType === 3 ? n.nodeValue : `<${n.nodeName.toLowerCase()}${Object.entries(n.attrs).map(([k, v]) => ` ${k}="${v}"`).join('')}>${n._t}${n.children.map(ser).join('')}</${n.nodeName.toLowerCase()}>`;
const all = (n: N): N[] => [n, ...n.children.flatMap(all)];
const props = (n: N): any => Object.entries(n).find(([k]) => k.startsWith('__reactProps$'))![1];   // React 가 노드에 둔 지금 props
const fsm = 'node:fs', rd = async (f: string) => (await import(/* @vite-ignore */ fsm)).readFileSync(new URL(f, import.meta.url), 'utf8') as string;

const SESS = { runner: 'live_map', result: 'running', world_id: 'v5_building', floor_id: 'l1', map_mode: 'slam' };
const ST = { role: 'control', sim_block: '', sim_start: { ok: true, why: '' }, map_start: { session: SESS }, live_map: null, applied: [0, 0, 0], events: [] };
const MS = [{ id: 'm1', kind: 'mission', at: '2026-10-16T01:00:00Z', doc: { name: '1층 순찰', wps: [{}, {}] } }, { id: 'm2', kind: 'mission', at: '2026-10-16T02:00:00Z', doc: { name: '2층 점검', wps: [{}] } }];
const roots: any[] = [];
afterEach(async () => { for (const r of roots.splice(0)) await React.act(async () => r.unmount()); R.asked = []; R.sent = []; });
const wrap = (el: any) => React.createElement(QueryClientProvider, { client: qc }, el);
const mount = async () => {
  qc.clear(); for (const k of ['docs', 'media']) qc.setQueryDefaults([k], { staleTime: Infinity, retry: false, retryOnMount: false, refetchOnMount: false });
  qc.setQueryData(['docs'], { docs: MS, rev: 2 });
  useLink.setState({ open: true, gen: 1, stGen: 1, lastMsg: performance.now(), provider: 'simulation_gate', viewOnly: false, st: structuredClone(ST) as any });
  const root: any = createRoot(new N('DIV') as any); roots.push(root);
  await React.act(async () => { root.render(wrap(React.createElement(Main))); });
};
const panel = async () => {   // 지금 v.runPanel 을 따로 장착(SimRun·pickEl·임무 칸이 실제로 그려짐)
  const host = new N('DIV'), root: any = createRoot(host as any); roots.push(root);
  await React.act(async () => { root.render(wrap(R.v.runPanel)); });
  return host;
};
const READ = ['map_list', 'map_get', 'map_live_get', 'geom_get'];

test('오른쪽 칸: 시뮬 실행 → 지도 보기(보기만) → 임무 차례 · 지도 보기 select 한 개 · «지금 열린 시뮬» 줄 · 저장 임무 2개(최신 먼저)', async () => {
  await mount();
  const s = ser(await panel());
  const i = [s.indexOf('data-runpanel'), s.indexOf('aria-label="시뮬 실행"'), s.indexOf('aria-label="지도 보기(보기만)"'), s.indexOf('aria-label="임무"')];
  expect(i.every((x, k) => x >= 0 && (k === 0 || x > i[k - 1]))).toBe(true);
  expect(s.match(/aria-label="지도 보기 선택\(보기만 · 실제 시뮬 안 바뀜\)"/g)!.length).toBe(1);
  expect(s).toContain('지금 열린 시뮬 · ');
  expect(s).toMatch(/>시뮬 리셋</); expect(s).toMatch(/>시뮬 시작\(30분\)</);   // 메뉴와 같은 항목(SimRun)
  expect(s.indexOf('2층 점검 · 지점 1')).toBeLessThan(s.indexOf('1층 순찰 · 지점 2'));
  expect(s).toContain('href="#/PcPlan"');   // 고르기 전 = 임무 계획 그대로
  expect(R.sent.filter((o) => o !== 'drop')).toEqual([]); expect(R.asked.every((o) => READ.includes(o))).toBe(true);
});

test('임무 고르기 = 고르기만: «임무 시작» 링크가 그 임무로(PcPlan?mission=) · op·문서 쓰기 0 · 세션 그대로', async () => {
  await mount();
  let h = await panel();
  const sel = all(h).find((n) => n.attrs['aria-label'] === '저장 임무 고르기(고르기만 · 시작 아님)')!;
  await React.act(async () => { props(sel).onChange({ target: { value: 'm1' } }); });
  h = await panel();
  expect(ser(h)).toContain('href="#/PcPlan?mission=m1"');
  expect(R.sent.filter((o) => o !== 'drop')).toEqual([]); expect(R.asked.every((o) => READ.includes(o))).toBe(true);
  expect(useLink.getState().st).toEqual(ST);
});

test('지도 보기 고르기 = 읽기 op 만 · 실행 세션 그대로', async () => {
  await mount();
  const sel = all(await panel()).find((n) => n.attrs['aria-label'] === '지도 보기 선택(보기만 · 실제 시뮬 안 바뀜)')!;
  await React.act(async () => { props(sel).onChange({ target: { value: 'live' } }); });
  expect(R.sent.filter((o) => o !== 'drop')).toEqual([]); expect(R.asked.every((o) => READ.includes(o))).toBe(true);
  expect(useLink.getState().st).toEqual(ST);
});

test('관제 칸의 시뮬 리셋 = 누르던 입력 폐기(dropAll) 뒤 reset 하나', async () => {
  await mount();
  const b = all(await panel()).find((n) => n.nodeName === 'BUTTON' && n.textContent === '시뮬 리셋')!;
  R.sent = [];
  await React.act(async () => { props(b).onClick(); });
  expect(R.sent).toEqual(['drop', 'reset']);
});

test('소스: 지도 칸 안 pickEl 0 · 임무 링크는 오른쪽 칸으로 · runPanel 은 사건 기록 바로 앞 · Main 의 «시뮬 ▾»는 안내만(두 번 장착 0)', async () => {
  const m = await rd('../../src/screens/Main.tsx'), vw = await rd('../../src/screens/Main.view.tsx'), sm = await rd('../../src/app/status.tsx');
  expect(m).not.toMatch(/q !== 'thumb' && pickEl/);
  expect(m.match(/\{pickEl\}/g)!.length).toBe(1); expect(m).toMatch(/aria-label="지도 보기\(보기만\)">\{pickEl\}/);
  expect(m.match(/>임무 시작</g)!.length).toBe(1); expect(m.match(/계획 보기 · «\$\{R\.name\}»/g)!.length).toBe(1);
  const a = vw.indexOf('{v.runPanel ?? null}'), b = vw.indexOf('"사건 기록"');
  expect(a > 0 && a < b).toBe(true);
  expect(sm).toMatch(/name === 'Main' \? <><p className="lv-note">관제 화면에서는 오른쪽 «시뮬 실행» 칸에서 엽니다/);
  expect(sm).toMatch(/: <SimRun close=\{\(\) => P\.close\(false\)\} \/>\}/);
});
