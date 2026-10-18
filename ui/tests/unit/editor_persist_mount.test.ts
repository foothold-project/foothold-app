// 영속 초안 장착 의미 반례(10-19 RL, ROOT GO) — 실제 useEditor + persistDraft + scratch 를 createRoot 로 장착(얇은 소비자 H, 화면 그림 0).
// 바꾸는 것은 바깥만: transport(T.whoami)·shared(saveDoc)·link(dropAsk)·shell(toast) + 가짜 localStorage·DOM. editor·PD·scratch 는 실물.
// 시험마다 모듈을 새로 불러 PD 상태를 비우고(새로 읽기 흉내), createRoot 는 매번 unmount, 전역은 afterAll 에 원래 descriptor 로 복구. console 억제 0.
import { afterAll, afterEach, beforeEach, expect, test, vi } from 'vitest';

const W = vi.hoisted(() => ({ whoami: (() => Promise.resolve({ status: 401, body: '{}' })) as () => Promise<{ status: number; body: string }> }));
const X = vi.hoisted(() => ({ sent: [] as any[], toasts: [] as string[], save: (async () => ({ ok: true, id: 'm1', rev: 1 })) as (m: any) => Promise<any> }));
vi.mock('../../src/data/transport', () => ({ T: { gated: true, whoami: () => W.whoami() } }));
vi.mock('../../src/data/shared', () => ({ saveDoc: (m: any) => { X.sent.push(JSON.parse(JSON.stringify(m))); return X.save(m); }, docById: () => null }));
vi.mock('../../src/data/link', () => ({ dropAsk: () => {} }));
vi.mock('../../src/app/shell', () => ({ toast: (t: string) => { X.toasts.push(String(t)); } }));

// ---- 전역(가짜 DOM·storage·location) — 원래 descriptor 보관 후 afterAll 복구
const KEYS = ['window', 'document', 'localStorage', 'location', 'addEventListener', 'removeEventListener', 'IS_REACT_ACT_ENVIRONMENT', 'HTMLIFrameElement'] as const;
const G = globalThis as any;
const saved = new Map(KEYS.map((k) => [k, Object.getOwnPropertyDescriptor(G, k)]));
let onStorage: ((e: any) => void) | null = null;
// M1(715 R1): ReactDOM commit 의 selection 준비(getActiveElementDeep)가 document.activeElement/body 와 window.HTMLIFrameElement 를 읽는다
const body = { nodeType: 1, tagName: 'BODY', nodeName: 'BODY' };
const doc = { hidden: false, body, activeElement: body, addEventListener: () => {}, removeEventListener: () => {}, createElement: () => ({ setAttribute: () => {}, style: {} }) };
const def = (k: string, v: unknown) => Object.defineProperty(G, k, { value: v, configurable: true, writable: true, enumerable: true });
def('window', G); def('document', doc); def('IS_REACT_ACT_ENVIRONMENT', true); def('HTMLIFrameElement', class {});
def('location', { origin: 'https://gate.test:8453', protocol: 'https:', href: 'https://gate.test:8453/', hash: '', search: '', pathname: '/' });
// storage 는 기존 그대로(첫 등록 callback 하나·해제 흉내 0). 그 밖의 window 이벤트(pagehide·beforeunload)만 등록/해제를 모음 — beforeEach 에 비움(시험 사이 누수 0)
const ev = new Map<string, Set<(e: any) => void>>();
def('addEventListener', (n: string, f: (e: any) => void) => { if (n === 'storage') { onStorage = f; return; } if (!ev.has(n)) ev.set(n, new Set()); ev.get(n)!.add(f); });
def('removeEventListener', (n: string, f: (e: any) => void) => { if (n !== 'storage') ev.get(n)?.delete(f); });
afterAll(() => { for (const [k, d] of saved) { if (d) Object.defineProperty(G, k, d); else delete G[k]; } });

function store() {
  const m = new Map<string, string>();
  const s: any = {
    m, get length() { return m.size; }, key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null), setItem: (k: string, v: string) => { m.set(k, String(v)); },
    removeItem: (k: string) => { m.delete(k); }, clear: () => m.clear(),
  };
  return s as Storage & { m: Map<string, string> };
}
const NK = 'fh.pd.v1.nonce', K = 'mission:PcPlan' as const;
const pdKeys = (s: { m: Map<string, string> }) => [...s.m.keys()].filter((k) => k.startsWith('fh.pd.v1:')).sort();
/** storage 원문에서 직접 읽은 보관본 이름들(PD.get 의 탭 메모리 우선을 거치지 않음) */
const rawNames = (s: { m: Map<string, string> }) => pdKeys(s).map((k) => JSON.parse(s.m.get(k)!).d?.name);
const OK = (account = 'oh') => () => Promise.resolve({ status: 200, body: JSON.stringify({ account, device: 'abcdef', label: null, exp: 9 }) });
const M = (name = 'A') => ({ name, tmpl: 'base', memo: '', wps: [{ x: 1, y: 2, name: '', mods: [] as string[] }] });
const DR = { id: 'm1', rev: 3, d: M('보관본') };

type B = Awaited<ReturnType<typeof boot>>;
const roots: { root: any; B: B }[] = [];
/** 새로 읽기 흉내: 모듈 새로(React·editor·PD·scratch 같은 세트) + storage 교체 */
async function boot(s: Storage | null) {
  vi.resetModules();
  def('localStorage', s);
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const PD = await import('../../src/data/persistDraft');
  const S = await import('../../src/data/scratch');
  const Ed = await import('../../src/data/editor');
  return { React, createRoot, PD, S, Ed };
}
/** 이전 세션: 같은 storage 에 ready 문맥으로 초안 1개 보관 */
async function seed(s: Storage, d = DR) {
  const B0 = await boot(s); W.whoami = OK();
  expect(await B0.PD.check()).toBe('ready');
  expect(B0.PD.put(K, d, B0.PD.snapshot().gen)).toBe(true);
}
async function mount(B: B) {
  const out: { E: any; renders: number } = { E: null, renders: 0 };
  function H() { out.E = B.Ed.useEditor<any>('mission', 'PcPlan'); out.renders++; return null; }
  const root = B.createRoot({ nodeType: 1, tagName: 'DIV', nodeName: 'DIV', namespaceURI: 'http://www.w3.org/1999/xhtml', addEventListener: () => {}, removeEventListener: () => {}, ownerDocument: doc } as any);
  roots.push({ root, B });
  await B.React.act(async () => { root.render(B.React.createElement(H)); });
  return out;
}
const act = (B: B, f: () => unknown) => B.React.act(async () => { await f(); });
const adv = (B: B, ms = 400) => B.React.act(async () => { await vi.advanceTimersByTimeAsync(ms); });
/** 탭 닫기·새로 읽기 직전 브라우저가 window 에 보내는 이벤트(타이머 진행 0) */
const fire = (B: B, n: 'pagehide' | 'beforeunload') => B.React.act(async () => { for (const f of [...(ev.get(n) ?? [])]) f({ type: n, persisted: false }); });
const nEv = () => (ev.get('pagehide')?.size ?? 0) + (ev.get('beforeunload')?.size ?? 0);
/** PcPlan 처럼: E.d 를 고치고 dirty + 다시 그리기 */
const edit = (B: B, E: any, f: (d: any) => void) => act(B, () => { f(E.d); E.dirty = true; E.touch(); });
async function unmountAll() { for (const { root, B } of roots.splice(0)) await B.React.act(async () => root.unmount()); }

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); X.sent = []; X.toasts = []; onStorage = null; ev.clear(); });
afterEach(async () => { try { await unmountAll(); } finally { vi.useRealTimers(); } });

test('ready 뒤 새로 읽기 복원: id/rev 그대로 → 저장은 그 rev 로(CAS), 409·404 는 초안·보관본 유지, 저장 성공 뒤 보관본 삭제', async () => {
  const s = store(); await seed(s);
  const B = await boot(s); W.whoami = OK(); await B.PD.check();
  const o = await mount(B);
  expect(o.E.restored).toMatchObject({ src: 'pd' });
  expect([o.E.id, o.E.rev, o.E.dirty]).toEqual(['m1', 3, true]);
  expect(o.E.d).toEqual(DR.d);
  X.save = async () => ({ ok: false, code: 409, error: '충돌', cur: { kind: 'mission', id: 'm1', rev: 5, by: 'kim', at: 0, doc: M('남의 판') } });
  await act(B, () => o.E.save());
  expect(X.sent[0]).toMatchObject({ op: 'put', kind: 'mission', id: 'm1', rev: 3, doc: DR.d });
  expect(o.E.d).toEqual(DR.d); expect(o.E.dirty).toBe(true);            // 최신 판으로 조용히 덮기 0
  await adv(B); expect(B.PD.get(K)).toEqual(DR);
  X.save = async () => ({ ok: false, code: 404, error: '없음' });
  await act(B, () => o.E.save());
  expect(o.E.d).toEqual(DR.d); expect(o.E.dirty).toBe(true);
  await adv(B); expect(B.PD.get(K)).toEqual(DR);
  X.save = async () => ({ ok: true, id: 'm1', rev: 6 });
  await act(B, () => o.E.save(5));                                        // «내 초안을 최신 판 위에 저장» 과 같은 rev 지정
  expect(X.sent[2]).toMatchObject({ id: 'm1', rev: 5 });
  expect(o.E.dirty).toBe(false);
  await adv(B); expect(B.PD.get(K)).toBeNull(); expect(pdKeys(s)).toEqual([]);
});

test('whoami 지연 중 편집 → 300 ms 보관 실패 → ready 가 되면 추가 편집 없이 보관', async () => {
  const s = store(); const B = await boot(s);
  let rel!: (r: { status: number; body: string }) => void;
  W.whoami = () => new Promise((r) => { rel = r; });
  const p = B.PD.check();
  const o = await mount(B);
  await act(B, () => o.E.load(null, M()));
  await edit(B, o.E, (d) => { d.name = '대기 중 편집'; });
  await adv(B);
  expect(pdKeys(s)).toEqual([]);                                          // checking → put false
  expect(o.E.pdNote).toBe('');                                            // ready 아님 = 보관 실패 안내 아님
  await act(B, async () => { rel({ status: 200, body: '{"account":"oh"}' }); await p; });
  await adv(B);
  expect(B.PD.get(K)?.d).toMatchObject({ name: '대기 중 편집' });
  expect(o.E.d.name).toBe('대기 중 편집'); expect(o.E.restored).toBeNull();
});

test('늦은 ready 복원은 사용자 편집(dirty)·다른 문서를 덮지 않음 · 남의 보관본은 지우지 않음', async () => {
  // dirty
  let s = store(); await seed(s);
  let B = await boot(s); let rel!: (r: any) => void;
  W.whoami = () => new Promise((r) => { rel = r; });
  let p = B.PD.check();
  let o = await mount(B);
  await act(B, () => o.E.load(null, M()));
  await edit(B, o.E, (d) => { d.name = '내 편집'; });
  await act(B, async () => { rel({ status: 200, body: '{"account":"oh"}' }); await p; });
  expect(o.E.d.name).toBe('내 편집'); expect(o.E.restored).toBeNull(); expect(o.E.id).toBeNull();
  await unmountAll();
  // 다른 문서를 연 편집기(깨끗)
  s = store(); await seed(s);
  B = await boot(s);
  W.whoami = () => new Promise((r) => { rel = r; });
  p = B.PD.check();
  o = await mount(B);
  await act(B, () => o.E.load({ id: 'm9', rev: 1, doc: M('다른 문서') }));
  await act(B, async () => { rel({ status: 200, body: '{"account":"oh"}' }); await p; });
  await adv(B);
  expect([o.E.id, o.E.rev, o.E.d.name, o.E.dirty]).toEqual(['m9', 1, '다른 문서', false]);
  expect(B.PD.get(K)).toEqual(DR);                                        // mine 아님 → remove 0
});

test('로그아웃(dropScratch) → 지금 E.d 폐기 · 진행 중 저장의 늦은 성공·unmount cleanup 이 되살리지 않음', async () => {
  const s = store(); const B = await boot(s); W.whoami = OK(); await B.PD.check();
  const o = await mount(B);
  await act(B, () => o.E.load(null, M()));
  await edit(B, o.E, (d) => { d.name = '로그아웃 전'; });
  await adv(B); expect(B.PD.get(K)?.d).toMatchObject({ name: '로그아웃 전' });
  let relSave!: (r: any) => void;
  X.save = () => new Promise((r) => { relSave = r; });
  let sp!: Promise<any>;
  await act(B, () => { sp = o.E.save(); });
  await act(B, () => B.S.dropScratch());
  expect(o.E.d).toBeNull(); expect(o.E.id).toBeNull(); expect(o.E.dirty).toBe(false);
  expect(pdKeys(s)).toEqual([]);
  await act(B, async () => { relSave({ ok: true, id: 'm1', rev: 1 }); await sp; });
  expect(o.E.d).toBeNull(); expect(o.E.id).toBeNull();                    // 늦은 성공 = «앞 문서» 알림만
  expect(X.toasts.some((t) => t.includes('앞 문서'))).toBe(true);
  await adv(B); await unmountAll();
  expect(pdKeys(s)).toEqual([]); expect(B.S.drafts.size).toBe(0);
});

test('다른 탭 nonce 교체(storage 이벤트) → 지금 E.d 폐기 · 다른 탭 초안 보존 · cleanup 부활 0', async () => {
  const s = store(); const B = await boot(s); W.whoami = OK(); await B.PD.check();
  const o = await mount(B);
  await act(B, () => o.E.load(null, M()));
  await edit(B, o.E, (d) => { d.name = '이 탭'; });
  await adv(B);
  const g = B.PD.snapshot().gen;
  s.m.set(NK, 'N2');
  const bKey = `fh.pd.v1:N2:${K}`, bRaw = JSON.stringify({ v: 1, nonce: 'N2', acct: 'oh', origin: 'https://gate.test:8453', key: K, at: Date.now(), id: null, rev: null, d: M('다른 탭') });
  s.m.set(bKey, bRaw);
  await act(B, () => onStorage!({ key: NK }));
  expect(B.PD.snapshot()).toMatchObject({ status: 'off', gen: g + 1 });
  expect(o.E.d).toBeNull(); expect(o.E.dirty).toBe(false);
  await adv(B); await unmountAll();
  expect(s.m.get(bKey)).toBe(bRaw); expect(B.S.drafts.size).toBe(0);
});

test('다른 탭 nonce 교체(이벤트 없음) → 다음 보관 시도에서 감지 · E.d 폐기 · 새 nonce 키에 쓰기 0', async () => {
  const s = store(); const B = await boot(s); W.whoami = OK(); await B.PD.check();
  const o = await mount(B);
  await act(B, () => o.E.load(null, M()));
  await edit(B, o.E, (d) => { d.name = '1차'; });
  await adv(B);
  const before = pdKeys(s);
  s.m.set(NK, 'N2');
  await edit(B, o.E, (d) => { d.name = '2차'; });
  await adv(B);
  expect(B.PD.snapshot().status).toBe('off');
  expect(o.E.d).toBeNull();
  expect(pdKeys(s)).toEqual(before);                                      // N2 키 생성 0 · 옛 키 덮기 0
  expect(s.m.get(before[0])).toContain('1차');
});

test('storage 가득 → 탭 메모리 보관 + 안내 / ready 인데 보관 거부(구조 위반) → 보관 실패 안내', async () => {
  let s = store(); let B = await boot(s); W.whoami = OK(); await B.PD.check();
  let o = await mount(B);
  s.setItem = () => { throw new Error('QuotaExceededError'); };
  await act(B, () => o.E.load(null, M()));
  await edit(B, o.E, (d) => { d.name = '가득'; });
  await adv(B);
  expect(B.PD.snapshot().mem).toBe(true);
  expect(o.E.pdNote).toContain('탭 메모리');
  expect(B.PD.get(K)?.d).toMatchObject({ name: '가득' });
  await unmountAll();
  s = store(); B = await boot(s); W.whoami = OK(); await B.PD.check();
  o = await mount(B);
  await act(B, () => o.E.load(null, M()));
  await edit(B, o.E, (d) => { d.wps = Array.from({ length: 201 }, () => ({ x: 0, y: 0, name: '', mods: [] })); });
  await adv(B);
  expect(pdKeys(s)).toEqual([]);
  expect(o.E.pdNote).toBe(B.Ed.PD_FAIL);
});

// ---- 10-19 ROOT G2 영속 닫기: 마지막 300 ms 안 편집 직후 탭 닫기·새로 읽기 (pagehide·beforeunload 동기 1회)
test.each(['pagehide', 'beforeunload'] as const)('편집 직후(타이머 진행 0) %s → 최신 초안이 storage 에 보관 · 새로 읽으면 그 초안 복원', async (n) => {
  const s = store(); let B = await boot(s); W.whoami = OK(); await B.PD.check();
  const o = await mount(B);
  await act(B, () => o.E.load(null, M()));
  await edit(B, o.E, (d) => { d.name = '1차'; });
  await adv(B); expect(rawNames(s)).toEqual(['1차']);
  await edit(B, o.E, (d) => { d.name = '마지막'; });                      // 300 ms 타이머 진행 0
  expect(rawNames(s)).toEqual(['1차']);
  await fire(B, n);
  expect(rawNames(s)).toEqual(['마지막']);                                // React unmount 없이 이벤트만으로
  // 브라우저는 이 뒤 cleanup 을 못 돌릴 수 있음 → 옛 화면 해제 전에 새로 읽기 흉내(모듈 새로 · 같은 storage). 옛 root 는 afterEach 가 해제
  B = await boot(s); W.whoami = OK(); await B.PD.check();
  const o2 = await mount(B);
  expect(o2.E.restored).toMatchObject({ src: 'pd' }); expect(o2.E.d.name).toBe('마지막'); expect(o2.E.dirty).toBe(true);
});

test('폐기된 문맥(다른 탭 nonce·dropScratch·이벤트 없는 nonce 교체) 뒤 pagehide·beforeunload → 쓰기 0 · 다른 탭 초안 보존 · 해제 뒤 리스너 0', async () => {
  // ① storage 이벤트로 폐기
  let s = store(); let B = await boot(s); W.whoami = OK(); await B.PD.check();
  let o = await mount(B);
  expect(nEv()).toBeGreaterThan(0);
  await act(B, () => o.E.load(null, M()));
  await edit(B, o.E, (d) => { d.name = '이 탭'; });
  await adv(B);
  const aKey = pdKeys(s)[0], aRaw = s.m.get(aKey)!;
  s.m.set(NK, 'N2');
  const bKey = `fh.pd.v1:N2:${K}`, bRaw = JSON.stringify({ v: 1, nonce: 'N2', acct: 'oh', origin: 'https://gate.test:8453', key: K, at: Date.now(), id: null, rev: null, d: M('다른 탭') });
  s.m.set(bKey, bRaw);
  await act(B, () => onStorage!({ key: NK }));
  expect(o.E.d).toBeNull();
  await fire(B, 'pagehide'); await fire(B, 'beforeunload');
  expect(pdKeys(s)).toEqual([aKey, bKey].sort()); expect(s.m.get(aKey)).toBe(aRaw); expect(s.m.get(bKey)).toBe(bRaw);
  await unmountAll();
  expect(nEv()).toBe(0);                                                  // 화면 해제 = 리스너 제거
  // ② dropScratch(로그아웃) 뒤
  s = store(); B = await boot(s); W.whoami = OK(); await B.PD.check();
  o = await mount(B);
  await act(B, () => o.E.load(null, M()));
  await edit(B, o.E, (d) => { d.name = '로그아웃 전'; });
  await act(B, () => B.S.dropScratch());
  await fire(B, 'pagehide'); await fire(B, 'beforeunload');
  expect(pdKeys(s)).toEqual([]); expect(o.E.d).toBeNull();
  await unmountAll();
  // ③ 이벤트 없이 nonce 교체 + 보관 안 된 편집 → pagehide 의 보관 시도가 감지 · 새 nonce 키 쓰기 0 · 옛 키 덮기 0
  s = store(); B = await boot(s); W.whoami = OK(); await B.PD.check();
  o = await mount(B);
  await act(B, () => o.E.load(null, M()));
  await edit(B, o.E, (d) => { d.name = '1차'; });
  await adv(B);
  const before = pdKeys(s);
  s.m.set(NK, 'N2');
  await edit(B, o.E, (d) => { d.name = '2차'; });
  await fire(B, 'pagehide');
  expect(B.PD.snapshot().status).toBe('off');
  expect(pdKeys(s)).toEqual(before); expect(rawNames(s)).toEqual(['1차']);
  await fire(B, 'beforeunload');
  expect(pdKeys(s)).toEqual(before); expect(rawNames(s)).toEqual(['1차']);
});
