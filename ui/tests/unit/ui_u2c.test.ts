import { afterEach, expect, test, vi } from 'vitest';
// U2-c(정본 REVAMP-WORK-ORDER «U2 요구» · DECISIONS 7): 관제(Main) 오른쪽 칸 = 시뮬 실행(SimRun — «시뮬 ▾»와 같은 코드) · 지도 보기(보기만) · 임무(저장 임무 고르기 → 임무 계획), 사건 기록은 그 아래.
// 실제 Main 을 createRoot(가짜 DOM)에 장착(ui_u2b_mmap 방식). 대체 = View(받은 v 만 잡음)·MapCanvas(null)·link ask/sendOp/sendStop/dropAll(기록).
// runPanel 은 v.runPanel 을 가짜 DOM 에 다시 장착해 글·순서를 읽고, 누름은 React 가 노드에 둔 props(__reactProps$)의 onClick/onChange 를 직접 부른다.
const R = vi.hoisted(() => ({ asked: [] as string[], sent: [] as string[], v: null as any, docs: null as any }));
vi.mock('../../src/data/link', async (orig) => ({ ...(await orig<typeof import('../../src/data/link')>()),
  ask: (op: string) => { R.asked.push(op); return Promise.resolve(op === 'map_list' ? { op: 'reply', ok: true, maps: [] } : { op: 'reply', ok: false, text: '시험 — 안 받음' }); },
  sendOp: (op: string) => { R.sent.push(op); return true; }, sendStop: () => { R.sent.push('stop'); return true; }, dropAll: () => { R.sent.push('drop'); } }));
vi.mock('../../src/data/shared', async (orig) => { const o = await orig<typeof import('../../src/data/shared')>(); return { ...o, useDocs: () => R.docs ?? o.useDocs() }; });   // 보완: 읽는 중/빈/못 읽음/보관 상태 주입(R.docs) — 없으면 실제 useDocs
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
  getBoundingClientRect() { return { left: 0, top: 0, right: 80, bottom: 30, width: 80, height: 30, x: 0, y: 0 }; }   // 보완: «시뮬 ▾» 팝오버(usePop) 자리 계산용 — 위치 자체는 670 몫
}
const doc: any = { addEventListener() {}, removeEventListener() {}, nodeType: 9, fullscreenElement: null, activeElement: null, hidden: false, documentElement: new N('HTML'), body: new N('BODY'),
  createElement: (t: string) => new N(t.toUpperCase()), createElementNS: (_: string, t: string) => new N(t.toUpperCase()), createTextNode: (s: string) => Object.assign(new N('#text', 3), { nodeValue: s }),
  querySelectorAll: () => [], querySelector: () => null };
Object.assign(globalThis, { window: globalThis, document: doc, addEventListener() {}, removeEventListener() {}, IS_REACT_ACT_ENVIRONMENT: true, HTMLIFrameElement: class {}, innerWidth: 1280, innerHeight: 800,
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
afterEach(async () => { for (const r of roots.splice(0)) await React.act(async () => r.unmount()); R.asked = []; R.sent = []; R.docs = null; (globalThis as any).location.hash = '#/Main'; });
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
  expect(s).toContain('받은 시뮬 상태(조회값 · 지금 실행 확정 아님) · '); expect(s).not.toContain('지금 열린 시뮬 · ');   // 보완 P2: 관제(drop)만 — 받은 session 조회값
  expect(s).toMatch(/>시뮬 리셋</); expect(s).not.toMatch(/>시뮬 시작\(30분\)</);   // 메뉴와 같은 항목(SimRun) · SLAM-1: 평지 시작 항목 0
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
  // FIX2: 지도 보기 선택은 모듈 전역(usePick) — 뒤 시험(G4 접는 칸 요약·관제 범례)에 'live' 가 남지 않게 제품 단추 «지도 보기 끄기»로 되돌림
  const off = all(await panel()).find((n) => n.nodeName === 'BUTTON' && n.textContent === '지도 보기 끄기')!;
  await React.act(async () => { props(off).onClick(); });
  expect(all(await panel()).some((n) => n.nodeName === 'BUTTON' && n.textContent === '지도 보기 끄기')).toBe(false);
});

test('관제 칸의 시뮬 리셋 = 누르던 입력 폐기(dropAll) 뒤 reset 하나', async () => {
  await mount();
  const b = all(await panel()).find((n) => n.nodeName === 'BUTTON' && n.textContent === '시뮬 리셋')!;
  R.sent = [];
  await React.act(async () => { props(b).onClick(); });
  expect(R.sent).toEqual(['drop', 'reset']);
});

test('소스: 지도 칸 안 pickEl 0 · 임무 링크는 오른쪽 칸으로 · runPanel 은 사건 기록 바로 앞', async () => {
  const m = await rd('../../src/screens/Main.tsx'), vw = await rd('../../src/screens/Main.view.tsx');
  expect(m).not.toMatch(/q !== 'thumb' && pickEl/);
  expect(m.match(/\{pickEl\}/g)!.length).toBe(1); expect(m).toMatch(/aria-label="지도 보기\(보기만\)">\{pickEl\}/);
  expect(m.match(/>임무 시작</g)!.length).toBe(1); expect(m.match(/계획 보기 · «\$\{R\.name\}»/g)!.length).toBe(1);
  const a = vw.indexOf('{v.runPanel ?? null}'), b = vw.indexOf('"사건 기록"');
  expect(a > 0 && a < b).toBe(true);
});

// ── 055824d 보완(715 C1 P1 · P2) → 10-18 요청 7: 머리줄 «시뮬 ▾»(SimMenu) 삭제 — 시뮬 실행 = 관제 오른쪽 칸 하나(옛 «메뉴는 안내만» 검사 대체 · 이유 P/UI-TEST-REMOVED-1018.md)
const { HeadChips } = await import('../../src/app/status');
const draw = async (el: any) => { const host = new N('DIV'), root: any = createRoot(host as any); roots.push(root); await React.act(async () => { root.render(wrap(el)); }); return host; };
const bodies = (...h: N[]) => h.reduce((k, n) => k + all(n).filter((x) => x.nodeName === 'BUTTON' && x.textContent === '시뮬 리셋').length, 0);   // SimRun 본문 수(리셋 단추 = SimRun 안에만)
const maps = (...h: N[]) => h.reduce((k, n) => k + all(n).filter((x) => x.attrs.class === 'lv-simmap').length, 0);   // MapStartBox(지도 시뮬 열기) 수
const noMenu = (h: N) => { expect(all(h).some((x) => x.attrs['data-simmenu'] !== undefined || x.attrs['aria-label'] === '시뮬 메뉴')).toBe(false); expect(all(h).some((x) => x.nodeName === 'BUTTON' && /^시뮬 ▾$|^시뮬 실행$|^시뮬 리셋$/.test(x.textContent))).toBe(false); };

test('C1: 빈 hash·#·#/·#/?값·#/Main·#/Main?값 = 관제 → 오른쪽 SimRun 1 · 머리줄(실제 head)에 시뮬 메뉴·단추 0', async () => {
  for (const h of ['', '#', '#/', '#/?q=thumb', '#/Main', '#/Main?q=thumb']) {
    (globalThis as any).location.hash = h;
    await mount();
    const p = await panel(), hd = await draw(R.v.head);
    expect([h, bodies(p), bodies(hd)]).toEqual([h, 1, 0]); expect([h, maps(p) + maps(hd)]).toEqual([h, 1]);
    noMenu(hd);
    for (const r of roots.splice(0)) await React.act(async () => r.unmount());
  }
});

test('C1: 다른 화면(#/MDrive·#/PcMap·#/Mainx)의 공용 머리줄 칩(HeadChips)에도 시뮬 메뉴·SimRun 0', async () => {
  for (const h of ['#/MDrive', '#/PcMap?x=1', '#/Mainx']) {
    (globalThis as any).location.hash = h;
    useLink.setState({ open: true, gen: 1, stGen: 1, lastMsg: performance.now(), provider: 'simulation_gate', viewOnly: false, st: structuredClone(ST) as any });
    const hd = await draw(React.createElement(HeadChips));
    expect([h, bodies(hd), maps(hd)]).toEqual([h, 0, 0]); noMenu(hd);
    for (const r of roots.splice(0)) await React.act(async () => r.unmount());
  }
});

test('C1 소스: main.tsx 와 관제 판정이 같은 HOME(shell) · 화면 고르기 = SCREENS[name || HOME]', async () => {
  const mn = await rd('../../src/main.tsx'), sh = await rd('../../src/app/shell.tsx');
  expect(sh).toMatch(/export const HOME = 'Main';/);
  expect(mn).not.toMatch(/const HOME =/); expect(mn).toMatch(/import \{[^}]*\bHOME\b[^}]*\} from '\.\/app\/shell';/);   /* FIX2b(ROOT 결정 3): G1 이 GlobalStop 을 앞에 둠 — import 순서 무관, 같은 HOME */ expect(mn).toMatch(/SCREENS\[name \|\| HOME\]/);
});

test('P2: 임무 칸 — 읽는 중 / 정상 빈 목록 / 못 읽음 / 보관(재조회 실패, 옛 목록 + 기존 공유 문서 경고)', async () => {
  const first = async () => { await mount(); const sel = all(await panel()).find((n) => n.attrs['aria-label'] === '저장 임무 고르기(고르기만 · 시작 아님)')!; return sel; };
  R.docs = { list: [], rev: null, err: '' };
  let sel = await first(); expect(sel.options[0].textContent).toBe('저장 임무 목록 읽는 중'); expect(sel.options.length).toBe(1);
  R.docs = { list: [], rev: 3, err: '' };
  sel = await first(); expect(sel.options[0].textContent).toBe('저장 임무 없음 — 임무 계획에서 만들기');
  R.docs = { list: [], rev: null, err: '문서 읽기 실패 · 503' };
  sel = await first(); expect(sel.options[0].textContent).toBe('저장 임무 목록 못 읽음 · 문서 읽기 실패 · 503'); expect(sel.options[0].textContent).not.toMatch(/없음/);
  R.docs = { list: MS, rev: 2, err: '문서 읽기 실패 · 503', stale: true, at: 1 };
  sel = await first(); expect(sel.options[0].textContent).toBe('보관 목록(재조회 실패) · 문서 읽기 실패 · 503'); expect(sel.options.length).toBe(3);
  const host = new N('DIV'), root: any = createRoot(host as any); roots.push(root);
  await React.act(async () => { root.render(wrap(R.v.drive)); });
  expect(host.textContent).toContain('공유 문서: 문서 읽기 실패 · 503');   // 기존 Main 경고 유지
  expect(R.sent.filter((o) => o !== 'drop')).toEqual([]);
});

test('P2: 관제(drop) 세션 줄 = 받은 조회값 표기 · 다른 화면(drop 거짓) 글과 공용 runLine 그대로', async () => {
  const mp = await rd('../../src/map/MapPick.tsx'), mx = await rd('../../src/data/maps.ts');
  expect(mp).toContain("{`${drop ? '받은 시뮬 상태(조회값 · 지금 실행 확정 아님)' : '지금 열린 시뮬'} · ${runLine(ss)}`}");
  expect(mx).toContain("export const runLine = (ss: Sess) => !ss ? '꺼짐 · 지도용 시뮬 없음(또는 상태 미확인)'");
});

// ── G4(ROOT 4 · UX-SPEC 3-3 · 10-19): 오른쪽 칸 맨 위 «지금 할 일» + 시뮬·지도·임무 접는 칸 — 단계마다 주행동 하나만 pri(표시 강조뿐)
// 본다: 단계 → 주행동 표(nowAct) · pri 는 그 단추 하나(b1/시뮬 실행/방문 확인) · 단추 자리·disabled·보낸 op 무변경 · 접힘은 사용자 상태 유지(자동으로 닫기 0) · 요약 줄 글
// 한계: 실제 펼침 픽셀·포커스 링·좁은 창 배치는 670 몫.
const { nowAct } = await import('../../src/screens/Main');
const { stageOf } = await import('../../src/data/drive_stage');
const det = (h: N) => all(h).find((n) => 'data-runpanel' in n.attrs)!.children.filter((n) => n.nodeName === 'DETAILS');   // FIX2: runPanel 직계 접는 칸 3개만(MapStartBox·개발자 details 제외)
const sumTxt = (h: N) => det(h).map((d) => d.children[0].textContent);
const isOpen = (h: N) => det(h).map((d) => 'open' in d.attrs);
const simBtn = (h: N) => all(h).find((n) => n.nodeName === 'BUTTON' && n.textContent === '시뮬 실행')!;
const setSt = (o: any) => React.act(async () => { useLink.setState({ st: { ...structuredClone(ST), ...o } as any }); });

test('G4 nowAct 표: 연결 없음·시뮬 아닌 막힘·리셋/해제 대기 = none · 시뮬 관문 막힘 = sim · 조종 전/잠금 = b1 · 조종 중+진행 기록 = ask', () => {
  const g = (st: any, x: any = {}) => stageOf({ linkOk: true, linkTxt: '정상', st, viewOnly: false, fallen: false, newVer: false, block: '', ...x });
  const base = { role: 'control', sim_block: '', latch: false };
  expect(nowAct(stageOf({ linkOk: false, linkTxt: '끊김', st: null, viewOnly: false, fallen: false, newVer: false, block: '' } as any), false, false, true, true)).toBe('none');
  expect(nowAct(g({ ...base, sim_block: '시뮬 상태 미수신' }), true, true, true, true)).toBe('sim');
  expect(nowAct(g({ ...base, sim_block: '시뮬 상태 미수신' }), true, true, false, true)).toBe('none');
  expect(nowAct(g({ ...base, reset_pending: true }), true, false, true, true)).toBe('none');
  expect(nowAct(g({ ...base, resume_pending: true, role: 'view' }), true, false, true, true)).toBe('none');
  for (const st of [{ ...base, role: 'view_other' }, { ...base, role: 'view' }, { ...base, latch: true }]) expect(nowAct(g(st), true, false, true, true)).toBe('b1');
  expect(nowAct(g(base), true, false, true, true)).toBe('ask');
  expect(nowAct(g(base), true, false, true, false)).toBe('none');
});

test('G4 기본(조종 중 · 진행 없음): «지금 할 일» 카드가 맨 위 · 강조 0 · 접는 칸 3개 닫힘 · 요약 줄', async () => {
  await mount();
  const h = await panel(), s = ser(h);
  expect(s.indexOf('aria-label="지금 할 일"')).toBeLessThan(s.indexOf('aria-label="시뮬 실행"'));
  const now = all(h).find((n) => n.attrs['aria-label'] === '지금 할 일')!;
  expect(now.attrs['data-now']).toBe('none'); expect(now.textContent).toMatch(/^지금 할 일 · /);
  expect(simBtn(h).attrs.class).not.toMatch(/\bpri\b/); expect(R.v.b1P.className).toBeUndefined();
  expect(isOpen(h)).toEqual([false, false, false]);
  expect(sumTxt(h)).toEqual(['시뮬 실행 · 시작 불가 — 서버 이유 없음', '지도 보기 · 시뮬 바닥(기본)', '임무 · 시작 전']);
  expect(R.sent.filter((o) => o !== 'drop')).toEqual([]);
});

test('G4 시뮬 관문 막힘 → 시뮬 칸 펼침 + «시뮬 실행»만 pri(disabled 그대로) · 풀려도 다시 접지 않음 · 사용자가 연 지도 칸 유지', async () => {
  await mount();
  let h = await panel();
  const mapDet = det(h)[1];
  await React.act(async () => { props(mapDet).onToggle({ currentTarget: { open: true } }); });
  await setSt({ sim_block: '시뮬 상태 미수신', map_start: { ok: true, why: '', session: SESS } });
  h = await panel();
  expect(all(h).find((n) => n.attrs['aria-label'] === '지금 할 일')!.attrs['data-now']).toBe('sim');
  expect(isOpen(h)).toEqual([true, true, false]);
  const b = simBtn(h); expect(b.attrs.class).toMatch(/ pri$/); expect('disabled' in b.attrs).toBe(true);   // 지형 안 고름 = 기존 막힘 그대로
  expect(R.v.b1P.className).toBeUndefined();
  await setSt({});
  h = await panel();
  expect(isOpen(h)).toEqual([true, true, false]); expect(simBtn(h).attrs.class).not.toMatch(/\bpri\b/);
  expect(R.sent.filter((o) => o !== 'drop')).toEqual([]);
});

test('G4 조종 전(보기)·잠금 → 조작줄 «조종 시작»만 pri · onClick·disabled·title 은 원래 값', async () => {
  for (const o of [{ role: 'view' }, { latch: true }]) {
    await mount(); await setSt(o);
    await panel();
    expect([o, R.v.b1P.className]).toEqual([o, 'btn pri']); expect(typeof R.v.b1P.onClick).toBe('function'); expect(R.v.b1P.title).toBeTruthy();
    for (const r of roots.splice(0)) await React.act(async () => r.unmount());
  }
  await mount(); await setSt({ role: 'view', reset_pending: true }); await panel();
  expect(R.v.b1P.className).toBeUndefined();   // 리셋 처리 중 = 강조 0
});

test('G4 진행 기록 + 조종 중 → 임무 칸 펼침 · «방문 확인» pri · 요약 «진행 중» · 못 읽음 이유는 요약에', async () => {
  const RUN = { id: 'r1', kind: 'run', at: '2026-10-19T01:00:00Z', doc: { name: '순찰 1', status: '진행', wps: [{ name: '', x: 0, y: 0, st: '대기', at: '', why: '', mods: [], photos: [], chk: '' }] } };
  R.docs = { list: [RUN, ...MS], rev: 4, err: '' };
  await mount();
  const h = await panel();
  expect(all(h).find((n) => n.attrs['aria-label'] === '지금 할 일')!.attrs['data-now']).toBe('ask');
  expect(isOpen(h)[2]).toBe(true); expect(sumTxt(h)[2]).toBe('임무 · «순찰 1» 진행 중');
  const a = await draw(R.v.askActs); expect(all(a).find((n) => n.nodeName === 'BUTTON' && n.textContent === '방문 확인')!.attrs.class).toBe('lv-btn pri');
  for (const r of roots.splice(0)) await React.act(async () => r.unmount());
  R.docs = { list: [], rev: null, err: '문서 읽기 실패 · 503' };
  await mount(); expect(sumTxt(await panel())[2]).toBe('임무 · 시작 전 · 저장 임무 목록 못 읽음 — 문서 읽기 실패 · 503');
});

test('G4 소스: WpActs pri 기본 = 기존(휴대폰 MHome 은 넘기지 않음) · MapStartBox/SimRun pri 기본 참 · 접는 칸 안에 기존 aria-label 그대로', async () => {
  const ru = await rd('../../src/app/runui.tsx'), mh = await rd('../../src/screens/MHome.tsx'), mb = await rd('../../src/map/MapStartBox.tsx'), su = await rd('../../src/app/status.tsx'), m = await rd('../../src/screens/Main.tsx');
  expect(ru).toMatch(/pri = true \}: \{ id: string; R: Run; i: number; pri\?: boolean \}/); expect(ru.match(/<Btn pri=\{pri\}/g)!.length).toBe(2);
  expect(mh).toMatch(/<WpActs id=\{run\.id\} R=\{R\} i=\{ci\} \/>/);
  expect(mb).toMatch(/onView, pri = true \}/); expect(su).toMatch(/reloadCatalog, pri = true \}/);
  expect(m.match(/fold\('(sim|map|mis)'/g)).toEqual(["fold('sim'", "fold('map'", "fold('mis'"]);
});

// ── G4(ROOT 4 · UX-SPEC 3-4): 지도 아래 범례 = MapCanvas 에 넘긴 값으로 실제 그리는 표식만 · 14px 아이콘 + 12px 글(var(--text)) · 구역 뒤 «표시만 · 주행 제한 미연결 ?»
const { MapLegend } = await import('../../src/map/MapCanvas');
const labs = (h: N) => { const lg = all(h).find((n) => n.attrs['aria-label'] === '지도 범례'); return lg ? lg.children.map((c) => c.textContent) : null; };
test('G4 요약칩 3(ROOT3 · UX-SPEC 2): Main 머리줄 칩 = HeadChips 만(≤3) + «상태 ▾» · 영상·단계(막힘·다음)는 상세 행 · 단계는 «지금 할 일» 카드 밖에도', async () => {
  await mount();
  const h = await draw(R.v.head), s = ser(h), chips = all(h).filter((n) => /\blv-chip\b/.test(n.attrs.class || ''));
  expect(chips.length).toBeLessThanOrEqual(3); expect(all(h).filter((n) => n.attrs['data-head']).length).toBe(chips.length);   // 칩은 전부 HeadChips 것(화면 고유 칩 0)
  expect(s).toContain('상태 ▾');
  const det = [...all(h), ...all(doc.body)].filter((n) => n.attrs['aria-label'] === '상태 상세').map((n) => n.textContent).join('|');
  expect(det).toMatch(/영상 · [^|]+ — /); expect(det).toMatch(/단계 · [^|]+ — [^|]*다음: /);
  const now = all(await panel()).find((n) => n.attrs['aria-label'] === '지금 할 일')!; expect(now.textContent).toMatch(/^지금 할 일 · /);
});

test('G4 MapLegend: 그리는 것만 · 로봇 신선/오래됨/넘어짐 · noRobot = 로봇 0 · 아무것도 없으면 띠 0', async () => {
  const Z = (type: string) => ({ id: type, kind: 'zone', at: '', doc: { type, pts: [] } }) as any, nt = '표시만 · 주행 제한 미연결';
  const L0 = (p: any) => draw(React.createElement(MapLegend, { trail: false, wps: false, zones: [], note: nt, ...p }));
  expect(labs(await L0({}))).toBeNull();
  expect(labs(await L0({ robot: { x: 0, y: 0, t: 0, fresh: true } }))).toEqual(['로봇']);
  expect(labs(await L0({ robot: { x: 0, y: 0, t: 0, fresh: false } }))).toEqual(['로봇(위치 오래됨)']);
  expect(labs(await L0({ robot: { x: 0, y: 0, t: 0, fresh: true, fallen: true } }))).toEqual(['로봇(넘어짐)']);
  expect(labs(await L0({ robot: { x: 0, y: 0, t: 0, fresh: true }, noRobot: true }))).toBeNull();
  expect(labs(await L0({ trail: true, wps: true, zones: [Z('금지')] }))).toEqual(['지나온 길', '목적지 번호', '진입 금지 구역', nt]);
  expect(labs(await L0({ zones: [Z('감속')] }))).toEqual(['감속 구역', nt]);
  const h = await L0({ trail: true }), lg = all(h).find((n) => n.attrs['aria-label'] === '지도 범례')!;
  expect(lg.style.fontSize).toBe('12px'); expect(lg.style.color).toBe('var(--text)');
  expect(all(lg).filter((n) => n.nodeName === 'SVG').every((s) => s.attrs.width === '14' && s.attrs.height === '14')).toBe(true);
});

test('G4 관제 범례: 구역 문서 → 금지 구역 + 한계 ?(ZONE_NOTE) · 옛 예시 범례(남은 경로·측정 완료·발견물·통신 약함) 소스 0', async () => {
  R.docs = { list: [{ id: 'z1', kind: 'zone', at: '2026-10-19T01:00:00Z', doc: { name: 'z', type: '금지', pts: [[0, 0], [1, 0], [1, 1]] } }, ...MS], rev: 5, err: '' };
  await mount();
  const h = await draw(R.v.legend);
  const l = labs(h)!; expect(l).toHaveLength(2); expect(l[0]).toBe('진입 금지 구역'); expect(l[1]).toMatch(/^표시만 · 주행 제한 미연결\?/);   // ? 전문은 InTop(위치 무관 · 닫혀 있어도 DOM)
  expect(all(h).some((n) => n.nodeName === 'BUTTON' && n.attrs['aria-label'] === '구역 · 설명')).toBe(true);
  const vw = await rd('../../src/screens/Main.view.tsx');
  for (const t of ['legendHide', '"남은 경로"', '"측정 완료"', '"다음 지점"', '{"발견물"}', '{"통신 약함"}']) expect([t, vw.includes(t)]).toEqual([t, false]);
});
