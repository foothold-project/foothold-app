import { afterEach, expect, test } from 'vitest';
// R1(715 40625ca · root «R1 보완 GO»): 실제 StartAsk(+Toast)를 react-dom createRoot 로 장착하고, 창 A 가 등록한 rAF tick·resize·Escape 콜백을 보관한 뒤
// 같은/다른 문장 창 B 를 열고 A 콜백을 «cleanup 전»(같은 act 안 — 아직 B 렌더·A cleanup 전)과 «cleanup 뒤»에 불러 B 의 DOM 측정·배치·답·안내·예약 무영향을 본다.
// 가짜 DOM(노드 환경 · 새 도구 설치 0 — ui_m1_mount 의 createRoot 장착 방식 재사용): 요소는 최소 메서드만, 측정(getBoundingClientRect) 횟수·rAF 예약·keydown/resize 리스너를 기록.
// 한계: 실브라우저 이벤트 순서·paint·실제 click/터치 아님(670 몫). React 렌더·commit·effect 순서는 실제 react-dom 18.
const K = { reads: 0, seq: 0, raf: new Map<number, FrameRequestCallback>(), win: new Map<string, Set<(e: any) => void>>(), doc: new Map<string, Set<(e: any) => void>>(),
  focus: [] as any[], anchor: { left: 0, top: 0, right: 10, bottom: 10 } };
const on = (m: typeof K.win) => ({ addEventListener: (t: string, f: any) => { if (!m.has(t)) m.set(t, new Set()); m.get(t)!.add(f); }, removeEventListener: (t: string, f: any) => { m.get(t)?.delete(f); } });
const rect = (r: { left: number; top: number; right: number; bottom: number }) => ({ ...r, x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top });
class N {   // 가짜 요소/글 노드
  children: N[] = []; parentNode: N | null = null; attrs: Record<string, string> = {}; style: Record<string, any> = { setProperty(k: string, v: string) { (this as any)[k] = v; } };
  nodeValue = ''; _t = ''; namespaceURI = 'http://www.w3.org/1999/xhtml'; isConnected = true; scrollHeight = 80; scrollWidth = 0; clientWidth = 0;
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
  focus() { K.focus.push(this); }
  getBoundingClientRect() { K.reads++; return rect({ left: 0, top: 0, right: 300, bottom: 120 }); }   // 창·본문 같은 높이 → 필요 높이 = 본문 scrollHeight 80
  all(): N[] { return [this, ...this.children.flatMap((c) => c.all())]; }
}
const doc: any = { ...on(K.doc), nodeType: 9, fullscreenElement: null, activeElement: null, hidden: false, documentElement: new N('HTML'), body: new N('BODY'),
  createElement: (t: string) => new N(t.toUpperCase()), createElementNS: (_: string, t: string) => new N(t.toUpperCase()), createTextNode: (s: string) => Object.assign(new N('#text', 3), { nodeValue: s }),
  querySelectorAll: () => [] };   // STOP 단추 없음(stopBoxes = [])
Object.assign(globalThis, { window: globalThis, document: doc, ...on(K.win), innerWidth: 800, innerHeight: 600, IS_REACT_ACT_ENVIRONMENT: true, HTMLIFrameElement: class {},
  location: { href: 'http://127.0.0.1/', protocol: 'http:', hash: '', search: '', pathname: '/' },
  requestAnimationFrame: (f: FrameRequestCallback) => { K.raf.set(++K.seq, f); return K.seq; }, cancelAnimationFrame: (n: number) => { K.raf.delete(n); } });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { askPage, sendStop, useAsk } = await import('../../src/data/link');
const { StartAsk, Toast, ASK_NOROOM, ASK_RESIZED } = await import('../../src/app/shell');

const roots: any[] = [];
afterEach(async () => { for (const r of roots.splice(0)) await React.act(async () => r.unmount()); });
const anchorEl = { isConnected: true, getBoundingClientRect: () => rect(K.anchor) } as unknown as Element;   // 연 단추(가짜) — 크기는 K.anchor
const one = <T,>(s: Set<T> | undefined) => { expect(s?.size).toBe(1); return [...s!][0]; };
async function mount() {
  K.reads = 0; K.raf.clear(); K.win.clear(); K.doc.clear(); K.focus = []; K.anchor = { left: 0, top: 0, right: 10, bottom: 10 }; Object.assign(globalThis, { innerWidth: 800, innerHeight: 600 });
  const box = new N('DIV'); const root: any = createRoot(box as any); roots.push(root);
  await React.act(async () => { root.render(React.createElement(React.Fragment, null, React.createElement(StartAsk), React.createElement(Toast))); });
  return box;
}
const settle = (p: Promise<boolean>) => { const r = { v: undefined as boolean | undefined }; p.then((v) => { r.v = v; }); return r; };
const dlg = (box: N) => box.all().filter((n) => n.attrs['data-start-ask'] === '1');
const toastText = (box: N) => box.all().filter((n) => n.attrs['data-live-toast'] === '1').map((n) => n.textContent).join('|');
const esc = () => { const e = { key: 'Escape', prevented: 0, preventDefault() { e.prevented++; } }; return e; };
/** 지금 열린 창의 콜백: tick = 마지막 예약 rAF · gone = resize 리스너 · key = keydown 리스너(창마다 하나만 등록돼 있어야 함) */
const cbs = () => ({ tick: [...K.raf.values()].slice(-1)[0], gone: one(K.win.get('resize')), key: one(K.win.get('keydown')) });

for (const same of [true, false]) test(`R1 효과 수명: 창 A 콜백(tick·resize·Escape)을 ${same ? '같은' : '다른'} 문장 B 를 연 뒤 cleanup 전·후에 불러도 B 의 DOM 측정·배치·답·안내·예약 0`, async () => {
  const box = await mount();
  let pA!: Promise<boolean>; await React.act(async () => { pA = askPage('창 A', undefined, undefined, anchorEl); });
  const A = cbs(), nodeA = dlg(box)[0], idA = useAsk.getState().id; expect(nodeA).toBeTruthy(); expect(K.raf.size).toBe(1);
  const t = same ? '창 A' : '창 B';
  let pB!: Promise<boolean>, sB!: { v: boolean | undefined };
  const callA = (when: string) => {
    const r0 = K.reads, s0 = K.seq, n0 = K.raf.size, e = esc();
    A.tick(0); A.gone({}); A.key(e);
    expect([K.reads - r0, K.seq - s0, K.raf.size - n0, e.prevented], `${when}: A 콜백의 측정·예약·Escape 처리`).toEqual([0, 0, 0, 0]);
    expect(useAsk.getState(), when).toMatchObject({ text: t }); expect(useAsk.getState().id, when).toBe(idA + 1); expect(sB.v, `${when}: B 답`).toBeUndefined();
  };
  await React.act(async () => {
    pB = askPage(t); sB = settle(pB);   // B: 앵커 없음 · A 는 새 창으로 false
    K.anchor = { left: 0, top: 0, right: 800, bottom: 600 };   // A 앵커(현재 자리)가 화면 전체 → A 기준 계산이면 자리 없음 → 옛 코드는 B 를 취소+안내
    callA('cleanup 전(B 렌더·A cleanup 전)');
  });
  expect(await pA).toBe(false);
  const nodeB = dlg(box); expect(nodeB).toHaveLength(1); expect(nodeB[0]).not.toBe(nodeA);   // key={id}: 같은 문장도 새 노드
  expect(nodeB[0].style.visibility).not.toBe('hidden'); expect([nodeB[0].style.left, nodeB[0].style.top]).toEqual(['210px', '56px']);   // B 는 자기 측정으로 놓임(놓기 전 기본 left 는 '50%')
  expect(K.focus[K.focus.length - 1].textContent).toBe('취소'); expect(nodeB[0].all()).toContain(K.focus[K.focus.length - 1]);   // 새 창 «취소» 초점
  const posB = { ...nodeB[0].style }, B = cbs(); expect(B.key).not.toBe(A.key); expect(B.gone).not.toBe(A.gone);
  await React.act(async () => { callA('cleanup 뒤'); });
  expect(dlg(box)[0]).toBe(nodeB[0]); expect({ ...nodeB[0].style }).toEqual(posB); expect(toastText(box)).toBe('');   // B 노드·자리 그대로 · 안내 0
  // 양성: 현재 창(B) 의 Escape 는 B 만 취소(안내 없음 — 기존대로)
  const e = esc(); await React.act(async () => { B.key(e); });
  expect(e.prevented).toBe(1); expect(sB.v).toBe(false); expect(useAsk.getState().text).toBeNull(); expect(dlg(box)).toHaveLength(0); expect(K.raf.size).toBe(0);
  expect(K.win.get('keydown')?.size ?? 0).toBe(0); expect(K.win.get('resize')?.size ?? 0).toBe(0);   // 닫히면 리스너·예약 해제
});

test('R1 양성(현재 창): 자리 없음 = false+안내 · 크기 변화 = 숨김 먼저+false+안내 · STOP = false(안내 없음) · 재열기 정상', async () => {
  const box = await mount();
  // 자리 없음: 연 단추 현재 자리가 화면 전체가 되면 이 창의 다음 tick 이 취소
  let p!: Promise<boolean>; await React.act(async () => { p = askPage('창 C', undefined, undefined, anchorEl); });
  const C = cbs(); K.anchor = { left: 0, top: 0, right: 800, bottom: 600 };
  await React.act(async () => { C.tick(0); });
  expect(await p).toBe(false); expect(toastText(box)).toBe(ASK_NOROOM); expect(dlg(box)).toHaveLength(0); expect(K.raf.size).toBe(0);
  // 크기 변화: resize 리스너 → 실제 노드에 숨김·클릭 불가 → 취소 → 안내
  K.anchor = { left: 0, top: 0, right: 10, bottom: 10 };
  await React.act(async () => { p = askPage('창 D'); });
  const D = cbs(), nodeD = dlg(box)[0]; Object.assign(globalThis, { innerWidth: 700 });
  await React.act(async () => { D.gone({}); });
  expect(await p).toBe(false); expect([nodeD.style.visibility, nodeD.style.pointerEvents]).toEqual(['hidden', 'none']); expect(toastText(box)).toBe(ASK_RESIZED); expect(dlg(box)).toHaveLength(0);
  // STOP(전역 취소 정책 그대로): 열린 창 취소 · 다시 누르면 새 창
  await React.act(async () => { p = askPage('창 E'); }); expect(dlg(box)).toHaveLength(1);
  await React.act(async () => { sendStop(); });
  expect(await p).toBe(false); expect(dlg(box)).toHaveLength(0);
  await React.act(async () => { p = askPage('창 E'); }); expect(dlg(box)).toHaveLength(1); expect(K.focus[K.focus.length - 1].textContent).toBe('취소');
});
