import { afterEach, expect, test, vi } from 'vitest';
// U2-a 보완(715 review-41dc247 B2 P1·B1 P2 · root «기록 필터 보완 GO»).
// B2: 실제 PcHistory 를 react-dom createRoot 로 장착(가짜 DOM) — 사건 탭에서 심각도 «정보» 고른 뒤 탭 단추(go)가 아니라 주소(메뉴 «기록» = #/PcHistory)로
//     탭이 바뀌어도 같은 컴포넌트 수명의 숨은 f.sev 가 다른 탭 표·행수·전체 기록 CSV 의 사건을 거르지 않는지(유효 필터 정규화).
// B1: 실제 MHistory 서버 렌더 — 기본 «전체»에 정보 사건 새 노출 0 · 정보 사건이 많아도 위험 사건이 200행 밖으로 밀리지 않음.
// 대체: useRoute(외부 저장소 — 주소 바뀜 흉내)·View(받은 값 v 만 잡음)·saveBlob(파일 대신 Blob 보관) 만. useDocs/useMedia·histFilter 는 실제.
import type { MediaEvent } from '@contracts';
const R = vi.hoisted(() => ({ q: new URLSearchParams(), subs: new Set<() => void>(), v: null as any, saved: [] as Blob[] }));
vi.mock('../../src/app/shell', async (orig) => {
  const React = await import('react');
  const sub = (f: () => void) => { R.subs.add(f); return () => { R.subs.delete(f); }; };
  return { ...(await orig<typeof import('../../src/app/shell')>()), toast: () => {},
    useRoute: () => { const q = React.useSyncExternalStore(sub, () => R.q, () => R.q); return { name: 'PcHistory', q, setQ: (k: string, v: string) => { const n = new URLSearchParams(R.q); n.set(k, v); R.q = n; R.subs.forEach((f) => f()); } }; } };
});
vi.mock('../../src/screens/PcHistory.view', () => ({ CSS: '', View: ({ v }: { v: any }) => { R.v = v; return null; } }));
vi.mock('../../src/data/fmt', async (orig) => ({ ...(await orig<typeof import('../../src/data/fmt')>()), saveBlob: (_: string, b: Blob) => { R.saved.push(b); return Promise.resolve('저장'); } }));
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
const { renderToStaticMarkup } = await import('react-dom/server');
const { QueryClientProvider } = await import('@tanstack/react-query');
const { qc } = await import('../../src/data/shared');
const PcHistory = (await import('../../src/screens/PcHistory')).default;
const MHistory = (await import('../../src/screens/MHistory')).default;
const { evShow } = await import('../../src/data/facts');

const at = (min: number) => new Date(Date.now() - min * 60e3).toISOString().replace(/\.\d+Z$/, 'Z');
const ev = (text: string, st: string, min: number) => ({ t: '00:00:00', st, text, at: at(min) }) as MediaEvent;
const set = (events: MediaEvent[]) => {
  qc.clear(); for (const k of ['docs', 'media']) qc.setQueryDefaults([k], { staleTime: Infinity, retry: false, retryOnMount: false, refetchOnMount: false });
  qc.setQueryData(['docs'], { docs: [], rev: 2 }); qc.setQueryData(['media'], { photos: [], events });
};
const EVS = [ev('넘어짐 (시뮬 판정)', 'bad', 3), ev('조종권 해제 · 연결 끊김', 'warn', 4), ev('조종권 얻음 · 이 기기', 'ok', 5)];
const roots: any[] = [];
afterEach(async () => { for (const r of roots.splice(0)) await React.act(async () => r.unmount()); R.saved = []; });
const route = async (tab: string | null) => { await React.act(async () => { R.q = new URLSearchParams(tab ? { tab } : {}); R.subs.forEach((f) => f()); }); };
const kinds = () => String(R.v.ex2.props.title);
const csvOf = async () => { await React.act(async () => { R.v.ex2.props.onClick(); }); return R.saved[R.saved.length - 1].text(); };

test('B2: 사건 탭 «정보» → 메뉴/주소로 기본 탭(go 우회) — 같은 수명의 숨은 심각도가 임무 탭 표·전체 기록 CSV 의 위험·경고를 빼지 않음', async () => {
  set(EVS); R.q = new URLSearchParams({ tab: '사건' });
  const root: any = createRoot(new N('DIV') as any); roots.push(root);
  await React.act(async () => { root.render(React.createElement(QueryClientProvider, { client: qc }, React.createElement(PcHistory))); });
  expect(kinds()).toContain('사건 2');   // 기본 위험·경고
  await React.act(async () => { R.v.sSev.p.onChange({ target: { value: '정보' } }); });
  expect([R.v.sSev.p.value, R.v.pgL.startsWith('1건'), kinds()]).toEqual(['정보', true, expect.stringContaining('사건 1')]);   // 사건 탭: 선택대로(정보만)
  await route(null);   // 왼쪽 메뉴 «기록»(#/PcHistory) — 탭 단추 go() 아님, 같은 컴포넌트 그대로
  expect(R.v.sSev.p.hidden).toBe(true);   // 심각도 선택은 숨음
  expect(kinds()).toContain('사건 2');    // 숨은 «정보»가 남아 거르면 «사건 1»(41dc247)
  const csv = await csvOf();
  expect(csv).toContain('넘어짐 (시뮬 판정)'); expect(csv).toContain('조종권 해제 · 연결 끊김'); expect(csv).not.toContain('조종권 얻음 · 이 기기');
  await route('사진'); expect(kinds()).toContain('사건 2');   // 다른 비사건 탭도 같음
  await route('사건');   // 주소로 사건 탭 복귀 = 보이는 선택(정보)이 그대로 적용(숨은 값 아님)
  expect([R.v.sSev.p.hidden, R.v.sSev.p.value, kinds()]).toEqual([undefined, '정보', expect.stringContaining('사건 1')]);
});

test('B1: 폰 기록 기본 «전체» — 정보 사건 새 노출 0 · 정보 사건 250개가 더 최근이어도 위험 사건이 200행 밖으로 밀리지 않음', () => {
  const many = Array.from({ length: 250 }, (_, i) => ev(`정보 사건 ${i}`, 'ok', 1 + i * 0.001));
  set([...many, ...EVS.map((e) => ({ ...e, at: at(60) }))]);
  const s = renderToStaticMarkup(React.createElement(QueryClientProvider, { client: qc }, React.createElement(MHistory)));
  const has = (t: string) => s.includes(`>${evShow(t)}</b>`);   // 폰 항목 제목 = 표시 문장(evShow)
  expect([has('정보 사건 0'), has('조종권 얻음 · 이 기기'), has('넘어짐 (시뮬 판정)'), has('조종권 해제 · 연결 끊김')]).toEqual([false, false, true, true]);
  expect(s).toMatch(/서버 보관 · 2건/);
});
