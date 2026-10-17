import { afterEach, expect, test, vi } from 'vitest';
// 715 UIReview-R1 U1~U5 + root «저장 중 입력 일관성»: 실제 MapEditor·Field·LiveTrailPanel 을 createRoot(가짜 DOM)에 장착해 열기·저장·뒤로가기·끌기 취소·가져오기 경합을 본다.
// 대체 = SceneCanvas/MapCanvas(그림 대신 props 기록) · PcFrame(머리+본문 그대로) · T.postRehearsal/T.get(손으로 푸는 약속 — 서버 단일 슬롯처럼 호출 수를 셈).
// 열기 주인 effect·저장/취소/파일 순번·속성 잠금은 실제 코드. 실제 Canvas 픽셀·포인터 이벤트 순서·화면 배치는 670 브라우저 범위(미측정).
const R = vi.hoisted(() => ({ cv: null as any }));
vi.mock('../../src/map/SceneCanvas', async (orig) => { const m = await orig<any>(), React = await import('react');
  return { ...m, SceneCanvas: (p: any) => { R.cv = p; return React.createElement('div', { 'data-cv': '' }); } }; });
vi.mock('../../src/map/MapCanvas', async (orig) => { const m = await orig<any>(), React = await import('react');
  return { ...m, MapCanvas: (p: any) => React.createElement('div', { 'data-map': p.name }) }; });
vi.mock('../../src/app/fleetui', async (orig) => { const m = await orig<any>(), React = await import('react');
  return { ...m, PcFrame: ({ head, children }: any) => React.createElement('div', null, head, children) }; });
vi.mock('../../src/app/shell', async (orig) => ({ ...(await orig<any>()), toast: () => {} }));
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
const loc = { href: 'http://127.0.0.1/#/MapEditor', protocol: 'http:', hash: '#/MapEditor', search: '', pathname: '/' };
Object.assign(globalThis, { window: globalThis, document: doc, addEventListener: on, removeEventListener: off, IS_REACT_ACT_ENVIRONMENT: true, HTMLIFrameElement: class {}, innerWidth: 1440, innerHeight: 900,
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, location: loc, confirm: () => true,
  HashChangeEvent: class { constructor(public type: string) {} }, dispatchEvent: (e: any) => { for (const f of evs[e.type] || []) f(e); return true; },
  history: { replaceState: (_: unknown, __: string, u: string) => { loc.hash = u.slice(u.indexOf('#')); } } });
vi.spyOn(console, 'error').mockImplementation(() => {});

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { T } = await import('../../src/data/transport');
const RH = await import('../../src/data/rehearsal');
const { drafts } = await import('../../src/data/scratch');
const MapEditor = (await import('../../src/screens/MapEditor')).default;
const Field = (await import('../../src/screens/Field')).default;
const { LiveTrailPanel } = await import('../../src/screens/Fleet');

// 서버 대체: 보낸 요청을 쌓고 시험이 하나씩 응답(늦은 응답·경합 재현). 호출 수 = 서버 슬롯 사용 수
const Q: { body: any; res: (r: any) => void }[] = [], GQ: ((r: any) => void)[] = [];
vi.spyOn(T, 'postRehearsal').mockImplementation((body: any) => new Promise((res) => { Q.push({ body, res }); }));
vi.spyOn(T, 'get').mockImplementation((() => new Promise((res) => { GQ.push(res); })) as any);
const ok = (j: unknown) => ({ status: 200, body: JSON.stringify(j) });
const META = (id: string, rev = 1) => ({ id, name: `n-${id}`, rev, sha256: 'a'.repeat(64), bytes: 100, counts: {}, at: '2026-10-18' });
const named = (name: string) => ({ ...RH.blankScene(), name });

const all = (n: N): N[] => [n, ...n.children.flatMap(all)];
const props = (n: N): any => Object.entries(n).find(([k]) => k.startsWith('__reactProps$'))![1];
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const roots: any[] = [];
afterEach(async () => { for (const r of roots.splice(0)) await React.act(async () => r.unmount()); Q.length = 0; GQ.length = 0; drafts.clear(); loc.hash = '#/MapEditor'; R.cv = null; await flush(); });
const mount = async (C: any, hash: string) => {
  loc.hash = hash;
  const host = new N('DIV'), root: any = createRoot(host as any); roots.push(root);
  await React.act(async () => { root.render(React.createElement(C)); }); await React.act(flush);
  const btn = (t: string | RegExp) => all(host).find((n) => n.nodeName === 'BUTTON' && (typeof t === 'string' ? n.textContent === t : t.test(n.textContent)))!;
  const click = async (t: string | RegExp) => { const b = btn(t); expect(b, String(t)).toBeTruthy(); await React.act(async () => { props(b).onClick?.({ currentTarget: b }); }); await React.act(flush); };
  const text = () => host.textContent;
  const act = async (f: () => unknown) => { await React.act(async () => { f(); }); await React.act(flush); };
  return { host, btn, click, text, act };
};
const answer = async (i: number, r: unknown) => { await React.act(async () => { Q[i].res(r); }); await React.act(flush); };
const tool = async (m: Awaited<ReturnType<typeof mount>>, k: string) => { const b = all(m.host).find((n) => n.nodeName === 'BUTTON' && n.attrs['aria-keyshortcuts'] === k)!; await m.act(() => props(b).onClick()); };
const addBox = async (m: Awaited<ReturnType<typeof mount>>, at: [number, number]) => { await tool(m, 'B'); await m.act(() => R.cv.onDown(at, { button: 0, pointerId: 9 }, 0.1)); await tool(m, 'V'); };
const hashTo = async (h: string) => { loc.hash = h; await React.act(async () => { for (const f of evs.hashchange || []) f({ type: 'hashchange' }); }); await React.act(flush); };

// ---- U2: 열기 주인 하나 ----
test('U2 저장본 단추로 열기 = get 1회만(주소 바꿈 + effect 한 곳) · 응답이 화면에 채택', async () => {
  const m = await mount(MapEditor, '#/MapEditor');
  expect(Q.length).toBe(0);
  await m.click('저장본 열기');
  await React.act(async () => { GQ[0](ok({ projects: [META('a')] })); }); await React.act(flush);
  await m.click(/^n-a · r1/);
  expect(loc.hash).toBe('#/MapEditor?id=a');
  expect(Q.map((x) => x.body)).toEqual([{ op: 'get', id: 'a' }]);   // 단추 open + qid effect open 이중 호출 0
  await answer(0, ok({ project: META('a'), scene: named('A안') }));
  expect(R.cv.scene.name).toBe('A안'); expect(Q.length).toBe(1);
});

test('U2 새 초안 첫 저장: 주소 id 반영이 다시 열기가 아님 · 저장 중 되돌리기 유지 · 속성 판 잠금(표시=실제)', async () => {
  const m = await mount(MapEditor, '#/MapEditor');
  await addBox(m, [2, 2]);
  expect(R.cv.scene.elements.length).toBe(1);
  await m.click('저장');
  expect(Q[0].body.op).toBe('put');
  // 저장 중: 속성 판 fieldset 이 실제로 disabled · 혹시 값이 들어와도(blur) 모델·표시 모두 원래 값
  const fs = all(m.host).find((n) => n.nodeName === 'FIELDSET')!;
  expect(props(fs).disabled).toBe(true);
  const w = all(m.host).find((n) => n.nodeName === 'INPUT' && n.attrs['aria-label'] === '가로')!;   // 선택된 상자의 가로(1 m)
  await m.act(() => props(w).onChange({ target: { value: '3' } }));
  await m.act(() => props(w).onBlur());
  expect(props(all(m.host).find((n) => n.nodeName === 'INPUT' && n.attrs['aria-label'] === '가로')!).value).toBe('1');
  expect(R.cv.scene.elements[0].size[0]).toBe(1);
  // 저장 중 되돌리기(허용) → 응답 뒤에도 되돌린 내용 유지, 다시 불러오기 0
  await m.click('되돌리기');
  expect(R.cv.scene.elements.length).toBe(0);
  await answer(0, ok({ project: META('p1'), new: true, warnings: [] }));
  expect(loc.hash).toBe('#/MapEditor?id=p1');
  expect(Q.length).toBe(1);                                   // 자기 저장 id 반영으로 get 0
  expect(R.cv.scene.elements.length).toBe(0);                 // 옛 저장본으로 덮지 않음
  expect(m.text()).toContain('저장 요청 뒤 고친 내용은 아직 저장 안 함');
  expect(props(all(m.host).find((n) => n.nodeName === 'FIELDSET')!).disabled).toBe(false);
});

test('U2 주소 뒤로가기(확인 없음): 저장 안 한 초안은 탭에 보관 → 그 주소로 돌아오면 이어서(get 0)', async () => {
  const m = await mount(MapEditor, '#/MapEditor?id=a');
  expect(Q.map((x) => x.body)).toEqual([{ op: 'get', id: 'a' }]);
  await answer(0, ok({ project: META('a'), scene: named('A안') }));
  await addBox(m, [3, 3]);
  await hashTo('#/MapEditor?id=b');
  expect((drafts.get('rehearsal:a') as any)?.d.elements.length).toBe(1);
  expect(Q[1].body).toEqual({ op: 'get', id: 'b' });
  await answer(1, ok({ project: META('b'), scene: named('B안') }));
  expect(R.cv.scene.name).toBe('B안'); expect(m.text()).toContain('이 탭에 보관');
  await hashTo('#/MapEditor?id=a');
  expect(Q.length).toBe(2);
  expect(R.cv.scene.name).toBe('A안'); expect(R.cv.scene.elements.length).toBe(1);
});

// ---- U4: 취소·다른 손가락·문서 교체 ----
test('U4 끌기 취소(pointercancel/lostcapture) 뒤 놓기 확정 0 · 다른 손가락 놓기 0 · 문서 교체 뒤 미리보기 0', async () => {
  const m = await mount(MapEditor, '#/MapEditor');
  await addBox(m, [2, 2]);
  const c = () => R.cv.scene.elements[0]?.center;
  await m.act(() => R.cv.onDown([2, 2], { button: 0, pointerId: 1 }, 0.3));
  await m.act(() => R.cv.onMove([5, 5], { pointerId: 1 }));
  expect(c()).toEqual([5, 5]);                                // 미리보기
  await m.act(() => R.cv.onCancel());
  expect(c()).toEqual([2, 2]);
  await m.act(() => R.cv.onUp([5, 5], { pointerId: 1 }));
  expect(c()).toEqual([2, 2]);
  await m.act(() => R.cv.onDown([2, 2], { button: 0, pointerId: 1 }, 0.3));
  await m.act(() => R.cv.onMove([4, 4], { pointerId: 2 }));   // 다른 손가락 움직임 무시
  expect(c()).toEqual([2, 2]);
  await m.act(() => R.cv.onMove([4, 4], { pointerId: 1 }));
  await m.act(() => R.cv.onUp([4, 4], { pointerId: 2 }));     // 다른 손가락 놓기 = 확정 0
  expect(c()).toEqual([2, 2]);
  await m.act(() => R.cv.onDown([2, 2], { button: 0, pointerId: 1 }, 0.3));
  await m.act(() => R.cv.onMove([5, 5], { pointerId: 1 }));
  await m.click('새 설계도');
  expect(R.cv.scene.elements.length).toBe(0);                 // 옛 문서 미리보기 0
  await m.act(() => R.cv.onUp([5, 5], { pointerId: 1 }));
  expect(R.cv.scene.elements.length).toBe(0);                 // 새 문서에 옛 내용 확정 0
  await addBox(m, [2, 2]);
  // 끌기 시작 → 되돌리기(다른 편집) → 이동·놓기: 옛 사본(base) 재확정 0 (root U4)
  await m.act(() => R.cv.onDown([2, 2], { button: 0, pointerId: 4 }, 0.3));
  await m.act(() => R.cv.onMove([3, 3], { pointerId: 4 }));
  await m.click('되돌리기');
  expect(R.cv.scene.elements.length).toBe(0);
  await m.act(() => R.cv.onMove([5, 5], { pointerId: 4 }));
  await m.act(() => R.cv.onUp([5, 5], { pointerId: 4 }));
  expect(R.cv.scene.elements.length).toBe(0);
  await m.click('다시 하기');
  expect(c()).toEqual([2, 2]);
  // 정상: 같은 손가락·같은 문서·편집 없음 → 놓기 확정(양성)
  await m.act(() => R.cv.onDown([2, 2], { button: 0, pointerId: 3 }, 0.3));
  await m.act(() => R.cv.onMove([6, 6], { pointerId: 3 }));
  await m.act(() => R.cv.onUp([6, 6], { pointerId: 3 }));
  expect(c()).toEqual([6, 6]);
});

// ---- U1: 그리기 범위 밖 채택 0 · 파일 최신 선택 ----
const file = (txt: string, wait?: Promise<void>) => ({ size: txt.length, text: async () => { if (wait) await wait; return txt; } });
const pickJson = (m: Awaited<ReturnType<typeof mount>>, f: unknown) => m.act(() => props(all(m.host).find((n) => n.nodeName === 'INPUT' && String(n.attrs.accept).includes('json'))!).onChange({ target: { files: [f], value: 'x' } }));
test('U1 원점 1e20 JSON 가져오기 = 거부 · 지금 초안 유지 / 서버 get 의 범위 밖 scene 도 채택 0', async () => {
  const m = await mount(MapEditor, '#/MapEditor');
  const bad = { ...named('나쁜 원점'), world: { ...RH.blankScene().world, origin: [1e20, 0] } };
  await pickJson(m, file(JSON.stringify(bad)));
  expect(m.text()).toContain('범위 밖'); expect(R.cv.scene.name).toBe(RH.blankScene().name);
  const steps = { ...named('큰 단'), elements: [{ id: 's1', type: 'stairs', floor: 'f1', to_floor: 'f1', start: [1, 1], yaw: 0, steps: 1e9, riser: 0.17, tread: 0.3, width: 1 }] };
  await pickJson(m, file(JSON.stringify(steps)));
  expect(m.text()).toContain('단 수(정수 2–40)'); expect(R.cv.scene.name).toBe(RH.blankScene().name);
  await hashTo('#/MapEditor?id=z');
  await answer(0, ok({ project: META('z'), scene: bad }));
  expect(m.text()).toContain('불러오기 실패'); expect(R.cv.scene.name).toBe(RH.blankScene().name);
});
test('비차단: JSON A 다음 B 를 고르면 늦게 끝난 A 는 버림(마지막 선택만 · B 가 거부돼도 A 로 조용히 바뀌지 않음)', async () => {
  const m = await mount(MapEditor, '#/MapEditor');
  let go!: () => void; const slow = new Promise<void>((r) => { go = r; });
  await pickJson(m, file(JSON.stringify(named('A파일')), slow));
  await pickJson(m, file(JSON.stringify(named('B파일'))));
  expect(R.cv.scene.name).toBe('B파일');
  await m.act(() => go());
  expect(R.cv.scene.name).toBe('B파일');
  let go2!: () => void; const slow2 = new Promise<void>((r) => { go2 = r; });
  await pickJson(m, file(JSON.stringify(named('C파일')), slow2));
  await pickJson(m, file('{"schema":'));                        // 마지막 선택 D = 문법 오류 → 거부(문서 세대는 그대로)
  expect(m.text()).toContain('JSON 문법 오류');
  await m.act(() => go2());
  expect(R.cv.scene.name).toBe('B파일');                         // 먼저 고른 C 가 나중에 끝나도 채택 0
});

// ---- U3: Field 계획 대상 중 보고·기록 보류 · 기존 입구 ----
test('U3 Field: 계획 로봇 고른 동안 보고·기록은 보류(기존 연결 자료 링크 0) · 돌아가면 링크 · 현황에 MHome/MMap 입구 · 목록 새로 읽기 선택 유지', async () => {
  const m = await mount(Field, '#/Field');
  await React.act(async () => { GQ[0](ok({ projects: [META('a')] })); }); await React.act(flush);
  const sel = (has: string) => all(m.host).find((n) => n.nodeName === 'SELECT' && n.options.some((o) => o.textContent.includes(has)))!;
  await m.act(() => props(sel('n-a · r1')).onChange({ target: { value: 'a' } }));
  const ex = RH.exampleScene();
  await answer(0, ok({ project: META('a', 3), scene: ex }));
  expect(m.text()).toContain('읽은 판 r3');
  const hrefs = () => all(m.host).filter((n) => n.nodeName === 'A').map((n) => n.attrs.href);
  expect(hrefs()).toEqual(expect.arrayContaining(['#/MHome', '#/MMap']));
  await m.act(() => props(sel('· 계획')).onChange({ target: { value: ex.scenarios[0].robots[0] } }));
  expect(m.text()).toContain('계획 대상 · 연결 없음'); expect(m.text()).toContain('고른 계획 로봇 아님');
  await m.click('보고');
  expect(m.text()).toContain('보류'); expect(hrefs()).not.toContain('#/MFinding'); expect(hrefs()).not.toContain('#/Report');
  await m.click('기록');
  expect(m.text()).toContain('보류'); expect(hrefs()).not.toContain('#/MHistory');
  await m.click(/으로 돌아가기$/);
  expect(hrefs()).toContain('#/MHistory');
  await m.click('현황');
  await m.click('목록 새로 읽기');
  expect(GQ.length).toBe(2); expect(Q.length).toBe(1);        // 목록만 다시(계획 get 자동 재요청 0)
  await React.act(async () => { GQ[1](ok({ projects: [] })); }); await React.act(flush);
  expect(m.text()).toContain('고른 프로젝트가 목록에 없습니다');
  expect(m.text()).toContain('읽은 판 r3');                    // 고른 계획은 그대로
});

// ---- U5: Fleet 실측 패널 경계 ----
test('U5 LiveTrailPanel: MapCanvas 는 relative·높이·overflow 상자 안', async () => {
  const m = await mount(LiveTrailPanel, '#/Fleet');
  const map = all(m.host).find((n) => n.attrs['data-map'] === 'fleet-live')!, box = map.parentNode!;
  expect(box.style.position).toBe('relative'); expect(box.style.height).toBe('240px'); expect(box.style.overflow).toBe('hidden');
});
