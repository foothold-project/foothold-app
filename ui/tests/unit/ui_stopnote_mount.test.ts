import { afterEach, expect, test, vi } from 'vitest';
// U1-R1/R2/R3(715 670805a codex.md · root «U1 보완 GO»): 실제 StopNote 를 react-dom createRoot 로 장착(가짜 DOM — ui_ask_mount 방식 재사용, 새 도구 0).
// R1 끝 단계 글 = 과거 수신 관측(뒤 latch 해제·연결 끊김에도 현재 잠금 주장 0) · R2 긴 유휴 뒤 첫 실패/빠른 확인/재누름이 진입 시각부터 4 s
// R3 자리 단계(① 가운데 · ①′ toast 합침 · ② 가로확장 · ③ 본문 스크롤 · 극단 null)와 전체화면 안 도착지 — 어느 경우도 STOP 과 겹침 0.
// 한계: 숨은 측정 요소 높이는 K.mh(폭·글 길이)로 흉내(실제 글꼴·줄바꿈 아님) · paint·실제 스크롤·터치 아님(670 실측 몫).
const K = { raf: new Map<number, FrameRequestCallback>(), seq: 0, now: 0, stops: [] as Box[], toasts: [] as Box[], doc: new Map<string, Set<(e: any) => void>>() };
type Box = { left: number; top: number; right: number; bottom: number };
const rect = (r: Box) => ({ ...r, x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top });
const mh = (w: number, t: string) => 16 + 20 * t.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / Math.floor((w - 24) / 13))), 0);   // 13 px 글자 · 줄 20 · 위아래 여백 16
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
  addEventListener() {} removeEventListener() {} focus() { throw new Error('초점 이동 0 이어야 함'); }
  getBoundingClientRect() { return this.attrs['data-stop-measure'] ? rect({ left: 0, top: 0, right: parseFloat(this.style.width), bottom: mh(parseFloat(this.style.width), this._t) }) : rect({ left: 0, top: 0, right: 0, bottom: 0 }); }
  all(): N[] { return [this, ...this.children.flatMap((c) => c.all())]; }
}
const fake = (b: Box) => ({ getBoundingClientRect: () => rect(b), checkVisibility: () => true });
const doc: any = { addEventListener: (t: string, f: any) => { if (!K.doc.has(t)) K.doc.set(t, new Set()); K.doc.get(t)!.add(f); }, removeEventListener: (t: string, f: any) => { K.doc.get(t)?.delete(f); },
  nodeType: 9, fullscreenElement: null, activeElement: null, hidden: false, documentElement: new N('HTML'), body: new N('BODY'),
  createElement: (t: string) => new N(t.toUpperCase()), createElementNS: (_: string, t: string) => new N(t.toUpperCase()), createTextNode: (s: string) => Object.assign(new N('#text', 3), { nodeValue: s }),
  querySelectorAll: (q: string) => q.includes('비상 정지') ? K.stops.map(fake) : q.includes('data-live-toast') ? K.toasts.map(fake) : [] };
Object.assign(globalThis, { window: globalThis, document: doc, addEventListener() {}, removeEventListener() {}, innerWidth: 390, innerHeight: 844, IS_REACT_ACT_ENVIRONMENT: true, HTMLIFrameElement: class {},
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  location: { href: 'http://127.0.0.1/', protocol: 'http:', hash: '', search: '', pathname: '/' },
  requestAnimationFrame: (f: FrameRequestCallback) => { K.raf.set(++K.seq, f); return K.seq; }, cancelAnimationFrame: (n: number) => { K.raf.delete(n); } });
vi.spyOn(performance, 'now').mockImplementation(() => K.now);
vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useLink } = await import('../../src/data/link');
const { StopNote, Toast, useStopN, toast, STOP_MSG, STOP_FAIL_REAL, STOP_SHOW_MS, STOP_READ_MS } = await import('../../src/app/shell');

const roots: any[] = [];
afterEach(async () => { for (const r of roots.splice(0)) await React.act(async () => r.unmount()); useStopN.setState({ r: null }); });
async function mount(W = 390, H = 844, stops: Box[] = [], toasts: Box[] = []) {
  K.raf.clear(); K.stops = stops; K.toasts = toasts; Object.assign(globalThis, { innerWidth: W, innerHeight: H });
  const box = new N('DIV'), root: any = createRoot(box as any); roots.push(root);
  await React.act(async () => { root.render(React.createElement(React.Fragment, null, React.createElement(Toast), React.createElement(StopNote))); });
  return box;
}
let SEQ = 100;
const press = async (x: Record<string, unknown>) => { await React.act(async () => { useStopN.setState({ r: { seq: ++SEQ, t: K.now, sent: true, fail: '', gen: 3, sg: 5, ...x } as any }); }); };
const at = async (t: number) => { K.now = t; await React.act(async () => { vi.advanceTimersByTime(200); }); };
const note = (b: N) => b.all().filter((n) => n.attrs['data-stop-note'])[0];
const px = (v: unknown) => parseFloat(String(v));
/** 보이는 알림 사각형(높이 = 그 폭에서 잰 높이와 maxHeight 중 작은 것) */
const box = (n: N): Box => { const w = px(n.style.width), h = Math.min(mh(w, n.textContent), n.style.maxHeight ? px(n.style.maxHeight) : Infinity);
  return { left: px(n.style.left), top: px(n.style.top), right: px(n.style.left) + w, bottom: px(n.style.top) + h }; };
const hit = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const LINK = { open: true, gen: 3, stGen: 3, provider: 'simulation_gate' };

test('R1: 끝 단계 «확인» 글은 과거 수신 관측 — 뒤에 latch 해제·status 오류·연결 끊김이 와도 현재 잠금·명령 0 유지 주장 0', async () => {
  K.now = 1000; useLink.setState({ ...LINK, lastMsg: 900, st: { latch: false, stop_gen: 5 } } as any);
  const b = await mount();
  await press({});
  expect(note(b).attrs['data-stop-note']).toBe('wait');
  await React.act(async () => { useLink.setState({ lastMsg: 1100, st: { latch: true, stop_gen: 6 } } as any); });
  const t = note(b).textContent; expect(t).toBe(STOP_MSG.ok); expect(t).toContain('수신 당시'); expect(t).toContain('지금 상태 아님');
  expect(t).not.toMatch(/잠금 켜짐|명령 0 유지|처리 완료|정지됨/);
  for (const x of [{ st: { latch: false, stop_gen: 6 } }, { st: null }, { open: false, gen: 4 }]) {   // 뒤 변화: 해제 · 형식 오류 · 끊김
    await React.act(async () => { useLink.setState(x as any); });
    expect(note(b).textContent).toBe(STOP_MSG.ok);   // 고정된 글은 «그때 받은 상태» 라서 뒤 변화와 모순 0
  }
});

test('R2: 장착 → 긴 유휴 → 첫 실패 / 빠른 확인 / 사라진 뒤 긴 유휴 → 재누름 — 모두 끝 단계 진입 시각부터 4 s', async () => {
  K.now = 0; useLink.setState({ ...LINK, lastMsg: 0, st: { latch: false, stop_gen: 5 } } as any);
  const b = await mount();
  K.now = 10_000; await press({ sent: false, fail: STOP_FAIL_REAL });   // 유휴 10 s 뒤 첫 누름 = 실패
  await at(10_200); expect(note(b)?.textContent).toBe(STOP_FAIL_REAL);   // 옛 코드: 멈춘 시계(0) 기준이라 여기서 사라짐
  await at(10_000 + STOP_SHOW_MS); expect(note(b)).toBeTruthy();
  await at(10_001 + STOP_SHOW_MS); expect(note(b)).toBeUndefined();
  K.now = 40_000; useLink.setState({ lastMsg: 40_050, st: { latch: true, stop_gen: 6 } } as any);   // 사라진 뒤 긴 유휴 → 재누름, 확인이 첫 그림 전에 이미 와 있음(빠른 확인)
  await press({ t: 39_990 });
  await at(40_200); expect(note(b)?.textContent).toBe(STOP_MSG.ok);
  await at(40_000 + STOP_SHOW_MS); expect(note(b)).toBeTruthy();
  await at(40_001 + STOP_SHOW_MS); expect(note(b)).toBeUndefined();
});

const FAIL = { sent: false, fail: STOP_FAIL_REAL };
test('R3 ①: 자리 있으면 가운데 폭 · 포인터 0 · 합침 0', async () => {
  const b = await mount(390, 844, [{ left: 300, top: 780, right: 382, bottom: 836 }]);
  await press(FAIL); const n = note(b);
  expect([n.style.left, n.style.top, n.style.width, n.style.visibility, n.style.pointerEvents]).toEqual(['16px', '56px', '358px', 'visible', 'none']);
  expect(n.textContent).toBe(STOP_FAIL_REAL); expect(hit(box(n), K.stops[0])).toBe(false);
});

test('R3 ①′: STOP·toast 를 함께 피할 자리가 없으면 toast 원문을 알림 안에 합쳐 STOP 만 피함(겹쳐도 두 글 다 읽힘)', async () => {
  const stop = { left: 0, top: 200, right: 390, bottom: 292 }, b = await mount(390, 300, [stop], [{ left: 0, top: 60, right: 390, bottom: 130 }]);
  await React.act(async () => { toast('확인창 취소함'); });
  await press(FAIL); const n = note(b);
  expect(n.textContent).toBe(`${STOP_FAIL_REAL}\n확인창 취소함`); expect(n.style.width).toBe('358px'); expect(n.style.visibility).toBe('visible');
  expect(n.style.pointerEvents).toBe('none'); expect(hit(box(n), stop)).toBe(false); expect(px(n.style.zIndex)).toBeGreaterThan(50);   // toast(50) 위
  const tn = () => b.all().filter((x) => x.attrs['data-live-toast'])[0];
  expect([tn().style.visibility, tn().attrs['aria-hidden']]).toEqual(['hidden', 'true']);   // 읽는 면 하나: 원래 toast 숨김(합친 글을 다시 가리지 않음)
  await React.act(async () => { useStopN.setState({ r: null }); });
  expect(tn().style.visibility).toBe('visible');   // 알림이 끝나면 toast 복귀(남은 시간 동안)
});

test('R3 ②: 가운데 폭엔 전부 안 들어가면 가로확장(W−16)', async () => {
  const stop = { left: 0, top: 60, right: 844, bottom: 140 }, b = await mount(844, 200, [stop]);
  await press(FAIL); const n = note(b);
  expect([n.style.left, n.style.width, n.style.visibility, n.style.pointerEvents]).toEqual(['8px', '828px', 'visible', 'none']);
  expect(n.attrs['data-stop-clip']).toBeUndefined(); expect(hit(box(n), stop)).toBe(false);
});

test('R3 ③: 글 전부 들어갈 띠가 없으면 가장 큰 빈 띠에 본문 스크롤(포인터는 이 알림만) · 표시 STOP_READ_MS', async () => {
  K.now = 0; const stop = { left: 0, top: 58, right: 390, bottom: 800 }, b = await mount(390, 844, [stop]);
  await press(FAIL); const n = note(b);
  expect([n.style.top, n.style.maxHeight, n.style.overflowY, n.style.pointerEvents, n.attrs['data-stop-clip']]).toEqual(['8px', '42px', 'auto', 'auto', '1']);
  expect(n.textContent).toBe(STOP_FAIL_REAL); expect(hit(box(n), stop)).toBe(false);
  await at(STOP_SHOW_MS + 1); expect(note(b)).toBeTruthy();   // 잘린 글은 4 s 로 끝나지 않음
  await at(STOP_READ_MS + 1); expect(note(b)).toBeUndefined();
});

test('R3 극단: 한 줄 띠도 없는 viewport(STOP 이 화면 전부) = 숨김(측정 범위 밖으로 분리) · STOP 겹침 0', async () => {
  const b = await mount(390, 844, [{ left: 0, top: 0, right: 390, bottom: 844 }]);
  await press(FAIL); expect(note(b).style.visibility).toBe('hidden');
});

test('R3 전체화면: 활성 FS 요소 안에 알림·측정 요소 · 끝나면 측정 요소 제거', async () => {
  const fs = new N('DIV'); doc.fullscreenElement = fs;
  try {
    const b = await mount();
    await press(FAIL);
    expect(note(b)).toBeUndefined(); const n = note(fs);
    expect(n.textContent).toBe(STOP_FAIL_REAL); expect(n.style.visibility).toBe('visible');
    expect(fs.all().filter((x) => x.attrs['data-stop-measure'])).toHaveLength(1);
    await React.act(async () => { useStopN.setState({ r: null }); });
    expect(fs.all().filter((x) => x.attrs['data-stop-measure'] || x.attrs['data-stop-note'])).toHaveLength(0);
  } finally { doc.fullscreenElement = null; }
});
