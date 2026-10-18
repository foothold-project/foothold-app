// 영속 초안(persistDraft) 의미 반례 — 가짜 localStorage·가짜 T(whoami). 실제 관문·브라우저 호출 아님.
import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGIN = 'https://gate.test:8453';
type Who = { gated: boolean; whoami: () => Promise<{ status: number; body: string }> };
const okWho = (account = 'oh'): Who => ({ gated: true, whoami: async () => ({ status: 200, body: JSON.stringify({ account, device: 'abcdef', label: null, exp: 9 }) }) });

function store(over: Partial<Storage> = {}) {
  const m = new Map<string, string>();
  const s: any = {
    m,
    get length() { return m.size; },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
    removeItem: (k: string) => { m.delete(k); },
    clear: () => m.clear(),
    ...over,
  };
  return s as Storage & { m: Map<string, string> };
}

let onStorage: ((e: any) => void) | null = null;
/** 새로 읽기(reload) 흉내: 모듈을 새로 불러온다. storage 는 넘긴 것 그대로 */
async function boot(ls: Storage | null, T: Who, origin = ORIGIN) {
  vi.resetModules();
  vi.stubGlobal('localStorage', ls);
  vi.stubGlobal('location', { origin, protocol: origin.split(':')[0] + ':' });
  vi.stubGlobal('addEventListener', (n: string, f: (e: any) => void) => { if (n === 'storage') onStorage = f; });
  vi.doMock('../../src/data/transport', () => ({ T }));
  return await import('../../src/data/persistDraft');
}
afterEach(() => { vi.unstubAllGlobals(); vi.doUnmock('../../src/data/transport'); vi.restoreAllMocks(); onStorage = null; });

const K = 'mission:PcPlan' as const;
const WP = { x: 1, y: 2, name: '', mods: ['사진'] };
const MAP = { src: 'gt', world_id: 'v5_building', floor_id: 'f1', key: '0123abcd' };
const DR = { id: 'm1', rev: 3, d: { name: 'A', tmpl: 'base', memo: '', wps: [WP], map: MAP, finish: '출발점 복귀', start: { x: 0.5, y: -1, map: MAP } } };
const DD = DR.d as Record<string, unknown>;
const pdKeys = (s: { m: Map<string, string> }) => [...s.m.keys()].filter((k) => k.startsWith('fh.pd.v1:'));
/** 저장 키 = fh.pd.v1:<지금 storage nonce>:<key> */
const ownKey = (s: Storage, n = s.getItem('fh.pd.v1.nonce')) => `fh.pd.v1:${n}:${K}`;

describe('persistDraft', () => {
  it('whoami 유효 → 보관 → 새로 읽기 뒤 같은 계정이면 복구', async () => {
    const s = store();
    let P = await boot(s, okWho());
    expect(P.get(K)).toBeNull();                        // 확인 전 off
    expect(P.put(K, DR, P.snapshot().gen)).toBe(false);
    expect(await P.check()).toBe('ready');
    expect(P.put(K, DR, P.snapshot().gen)).toBe(true);
    P = await boot(s, okWho());
    expect(P.get(K)).toBeNull();                        // nonce 만으로는 복구 0
    await P.init();
    expect(P.get(K)).toEqual(DR);
    const g = P.snapshot().gen; P.drop(); await P.check(); P.put(K, DR, P.snapshot().gen);
    expect(P.remove(K, g)).toBe(false);                 // 옛 문맥의 cleanup 이 새 문맥 초안을 지우지 않음
    expect(P.get(K)).toEqual(DR);
    expect(P.remove(K, P.snapshot().gen)).toBe(true); expect(P.get(K)).toBeNull();
  });

  it('401·확인 실패 → off, 복구·보관 0', async () => {
    const s = store();
    let P = await boot(s, okWho());
    await P.check(); P.put(K, DR, P.snapshot().gen);
    P = await boot(s, { gated: true, whoami: async () => ({ status: 401, body: '{"error":"로그인 필요"}' }) });
    expect(await P.check()).toBe('off');
    expect(P.get(K)).toBeNull();
    expect(P.put(K, DR, P.snapshot().gen)).toBe(false);
    P = await boot(s, { gated: true, whoami: async () => { throw new Error('net'); } });
    expect(await P.check()).toBe('off');
    expect(P.snapshot().note).toContain('계정 확인 못 함');
  });

  it('다른 계정 → 복구 0 + 쓸어냄', async () => {
    const s = store();
    let P = await boot(s, okWho('oh'));
    await P.check(); P.put(K, DR, P.snapshot().gen);
    P = await boot(s, okWho('kim'));
    await P.check();
    expect(P.get(K)).toBeNull();
    expect(pdKeys(s)).toEqual([]);
  });

  it('drop: nonce 교체·보관본 삭제·gen+1, 새로 읽어도 복구 0', async () => {
    const s = store();
    let P = await boot(s, okWho());
    await P.check(); P.put(K, DR, P.snapshot().gen);
    const n0 = s.getItem('fh.pd.v1.nonce'), g0 = P.snapshot().gen;
    P.drop();
    expect(s.getItem('fh.pd.v1.nonce')).not.toBe(n0);
    expect(pdKeys(s)).toEqual([]);
    expect(P.snapshot()).toMatchObject({ status: 'off', gen: g0 + 1 });
    P = await boot(s, okWho()); await P.check();
    expect(P.get(K)).toBeNull();
  });

  it('늦은 whoami 응답은 drop 뒤 되살리지 않음 · 옛 gen 의 put 거부', async () => {
    const s = store();
    let release!: () => void;
    const T: Who = { gated: true, whoami: () => new Promise((r) => { release = () => r({ status: 200, body: '{"account":"oh"}' }); }) };
    const P = await boot(s, T);
    const p = P.check();
    expect(P.snapshot().status).toBe('checking');
    P.drop(); release();
    expect(await p).toBe('off');
    expect(P.snapshot().status).toBe('off');
    // 다시 확인 → ready, 그러나 폐기 전 gen 으로 put 거부
    const P2 = await boot(s, okWho()); await P2.check();
    const g = P2.snapshot().gen; P2.drop(); await P2.check();
    expect(P2.put(K, DR, g)).toBe(false);
    expect(P2.put(K, DR, P2.snapshot().gen)).toBe(true);
  });

  it('다른 탭 nonce 교체: storage 이벤트·get 때 재대조 둘 다 이 탭 폐기', async () => {
    const s = store();
    const P = await boot(s, okWho());
    await P.check(); P.put(K, DR, P.snapshot().gen);
    s.m.set('fh.pd.v1.nonce', 'other-tab');             // 이벤트 없이 바뀜
    expect(P.get(K)).toBeNull();
    expect(P.snapshot().status).toBe('off');
    await P.check(); const g = P.snapshot().gen;
    expect(onStorage).toBeTypeOf('function');
    onStorage!({ key: 'fh.pd.v1.nonce' });
    expect(P.snapshot()).toMatchObject({ status: 'off', gen: g + 1 });
    expect(P.put(K, DR, g)).toBe(false);
  });

  it('http(관문 없음) → whoami 없이 ready, origin 문맥 명시 · 다른 origin 보관본 거부', async () => {
    const s = store(), who = vi.fn();
    const H = 'http://192.0.2.1:8790';
    let P = await boot(s, { gated: false, whoami: who as any }, H);
    expect(await P.check()).toBe('ready');
    expect(who).not.toHaveBeenCalled();
    expect(P.snapshot().note).toContain(H);
    expect(P.put(K, DR, P.snapshot().gen)).toBe(true);
    const raw = s.getItem(ownKey(s))!;
    expect(JSON.parse(raw)).toMatchObject({ acct: 'ungated', origin: H });
    P = await boot(s, { gated: false, whoami: who as any }, 'http://192.0.2.2:8790');   // 같은 저장소를 다른 origin 이 읽는 반례
    await P.check();
    expect(P.get(K)).toBeNull();
  });

  it('만료·크기·금지 키·구조·opt-in 밖 키', async () => {
    const s = store();
    let P = await boot(s, okWho());
    await P.check(); const g = P.snapshot().gen;
    expect(P.put(K, { ...DR, d: { ...DD, pw: 'x' } }, g)).toBe(false);
    expect(P.put(K, { ...DR, d: { ...DD, wps: [{ ...WP, token: 't' }] } }, g)).toBe(false);
    expect(P.put(K, { ...DR, d: [1] }, g)).toBe(false);
    expect(P.put(K, { ...DR, d: null }, g)).toBe(false);
    expect(P.put(K, { ...DR, rev: 1.5 }, g)).toBe(false);
    expect(P.put(K, { ...DR, d: { ...DD, memo: 'x'.repeat(P.PD_MAX_BYTES) } }, g)).toBe(false);
    expect(P.put('note:x' as any, DR, g)).toBe(false);
    expect(P.get('note:x' as any)).toBeNull();
    expect(pdKeys(s)).toEqual([]);
    expect(P.put(K, DR, g)).toBe(true);
    s.m.set('fh.pd.v1:junk', '{');
    const t0 = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(t0 + P.PD_TTL_MS + 1);
    P = await boot(s, okWho()); await P.check();
    expect(P.get(K)).toBeNull();
    expect(pdKeys(s)).toEqual([]);                      // 만료·깨짐·opt-in 밖 쓸어냄
  });

  it('mission 구조: {}·wps 깨짐·map/start/finish 위반·깨진 JSON 거절, 최소 mission 허용', async () => {
    const s = store();
    const P = await boot(s, okWho());
    await P.check(); const g = P.snapshot().gen;
    const bad: unknown[] = [
      {}, { ...DD, wps: 'x' }, { ...DD, wps: [{ ...WP, x: NaN }] }, { ...DD, wps: [{ ...WP, y: '2' }] }, { ...DD, wps: [{ ...WP, mods: ['날기'] }] },
      { ...DD, wps: [{ ...WP, mods: undefined }] }, { ...DD, wps: [null] }, { ...DD, wps: Array(201).fill(WP) }, { ...DD, name: 1 }, { ...DD, tmpl: undefined },
      { ...DD, map: { ...MAP, src: 'slam' } }, { ...DD, map: { ...MAP, key: 1 } }, { ...DD, finish: '아무데나' },
      { ...DD, start: { x: 1, y: Infinity, map: MAP } }, { ...DD, start: { x: 1, y: 2 } }, { ...DD, start: { x: 1, y: 2, map: { ...MAP, rid: 3 } } },
    ];
    for (const d of bad) expect(P.put(K, { ...DR, d }, g)).toBe(false);
    expect(pdKeys(s)).toEqual([]);
    expect(P.put(K, { id: null, rev: null, d: { name: '', tmpl: 'base', memo: '', wps: [] } }, g)).toBe(true);
    s.m.set(ownKey(s), '{"v":1,');               // 깨진 JSON
    expect(P.get(K)).toBeNull();
    const e = JSON.parse(JSON.stringify({ v: 1, nonce: s.getItem('fh.pd.v1.nonce'), acct: 'oh', origin: ORIGIN, key: K, at: Date.now(), id: null, rev: null, d: {} }));
    s.m.set(ownKey(s), JSON.stringify(e));       // 문맥은 맞고 d = {}
    expect(P.get(K)).toBeNull();
    s.m.set(ownKey(s), JSON.stringify({ ...e, d: { ...DD, wps: [{ x: 1 }] } }));
    expect(P.get(K)).toBeNull();
    s.m.set(ownKey(s), JSON.stringify({ ...e, d: DD }));
    expect(P.get(K)).toEqual({ id: null, rev: null, d: DD });
  });

  it('같은 gen 안 겹친 check: 늦은 옛 답이 새 결과를 뒤집지 않음(양방향)', async () => {
    const s = store(), hold: ((r: { status: number; body: string }) => void)[] = [];
    const T: Who = { gated: true, whoami: () => new Promise((r) => { hold.push(r); }) };
    const P = await boot(s, T);
    const a = P.check(), b = P.check();
    hold[1]({ status: 200, body: '{"account":"oh"}' }); expect(await b).toBe('ready');
    hold[0]({ status: 401, body: '{}' }); await a;
    expect(P.snapshot().status).toBe('ready');           // 옛 401 이 ready 를 off 로 뒤집지 않음
    const c = P.check(), d = P.check();
    hold[3]({ status: 401, body: '{}' }); expect(await d).toBe('off');
    hold[2]({ status: 200, body: '{"account":"oh"}' }); await c;
    expect(P.snapshot().status).toBe('off');             // 옛 성공이 off 를 ready 로 되살리지 않음
    expect(P.get(K)).toBeNull();
  });

  it('R1: 쓰기 실패(mem) 뒤에도 nonce 대조 — 타탭 교체 뒤 옛 cleanup/get 이 새 문맥 초안을 지우거나 옛 초안을 주지 않음', async () => {
    const s = store();
    const P = await boot(s, okWho());
    await P.check(); const g = P.snapshot().gen;
    const setItem = s.setItem;
    s.setItem = () => { throw new Error('QuotaExceededError'); };
    expect(P.put(K, DR, g)).toBe(true); expect(P.snapshot().mem).toBe(true);
    s.setItem = setItem;
    // 탭 B: 폐기 → nonce N2 + 새 초안(이 탭에 이벤트는 아직 안 옴)
    s.m.set('fh.pd.v1.nonce', 'N2');
    const bKey = ownKey(s, 'N2'), bRaw = JSON.stringify({ v: 1, nonce: 'N2', acct: 'oh', origin: ORIGIN, key: K, at: Date.now(), id: null, rev: null, d: DD });
    s.m.set(bKey, bRaw);
    expect(P.remove(K, g)).toBe(false);                 // 옛 문맥 cleanup
    expect(s.m.get(bKey)).toBe(bRaw);                   // B 초안 그대로
    expect(P.snapshot()).toMatchObject({ status: 'off', gen: g + 1 });
    expect(P.get(K)).toBeNull();                        // 옛 메모리 초안도 안 줌
    expect(P.put(K, DR, g)).toBe(false);
  });

  it('R1: 자기 nonce 키만 지움 — 같은 문맥 remove 가 다른 nonce 키를 건드리지 않음', async () => {
    const s = store();
    const P = await boot(s, okWho());
    await P.check(); const g = P.snapshot().gen;
    P.put(K, DR, g);
    s.m.set('fh.pd.v1:OTHER:' + K, 'x');                 // 다른 nonce 소유(가상)
    expect(P.remove(K, g)).toBe(true);
    expect(s.m.has(ownKey(s))).toBe(false); expect(s.m.get('fh.pd.v1:OTHER:' + K)).toBe('x');
  });

  it('R2: check 대기 중 이벤트 없는 nonce 교체 → 같은 gen 재결속 0(gen+1·off·B 초안 보존·옛 atGen 무효), 다음 check 는 새 gen 에서 결속', async () => {
    const s = store();
    let release!: (r: { status: number; body: string }) => void, slow = false;
    const T: Who = { gated: true, whoami: () => (slow ? new Promise((r) => { release = r; }) : Promise.resolve({ status: 200, body: '{"account":"oh"}' })) };
    const P = await boot(s, T);
    const S = await import('../../src/data/scratch');
    await P.check(); const g = P.snapshot().gen; P.put(K, DR, g);
    S.drafts.set(K, DR); const n = S.ctx.n;
    slow = true; const p = P.check();
    s.m.set('fh.pd.v1.nonce', 'N2');
    const bKey = ownKey(s, 'N2'); s.m.set(bKey, 'B');
    release({ status: 200, body: '{"account":"oh"}' });
    expect(await p).toBe('off');
    expect(P.snapshot()).toMatchObject({ status: 'off', gen: g + 1 });
    expect(S.ctx.n).toBe(n + 1); expect(S.drafts.size).toBe(0);   // scratch 까지 전파
    expect(s.m.get(bKey)).toBe('B');
    expect(P.put(K, DR, g)).toBe(false); expect(P.remove(K, g)).toBe(false);
    slow = false;
    expect(await P.check()).toBe('ready');              // 새 gen 에서 N2 로 처음 결속
    expect(P.snapshot().gen).toBe(g + 1);
    expect(P.put(K, DR, g + 1)).toBe(true);
    expect(s.m.has(ownKey(s, 'N2'))).toBe(true);
  });

  it('R2 최초 결속: null→null 정상 / null→N2(대기 중 새 탭) 거부·새 탭 키 보존 / 읽기 불가 mem 정상', async () => {
    // 정상: 빈 storage(null) → 응답 때도 null → 새 nonce 만들어 결속
    let s = store();
    let P = await boot(s, okWho());
    expect(await P.check()).toBe('ready');
    expect(s.getItem('fh.pd.v1.nonce')).toBeTypeOf('string');
    expect(P.put(K, DR, P.snapshot().gen)).toBe(true);
    // 거부: 시작 때 null(읽음·없음) → 대기 중 새 탭이 N2 + 초안 → 결속·sweep 0
    s = store();
    let release!: (r: { status: number; body: string }) => void;
    P = await boot(s, { gated: true, whoami: () => new Promise((r) => { release = r; }) });
    const g = P.snapshot().gen, p = P.check();
    s.m.set('fh.pd.v1.nonce', 'N2');
    const bKey = ownKey(s, 'N2'), bRaw = JSON.stringify({ v: 1, nonce: 'N2', acct: 'kim', origin: ORIGIN, key: K, at: Date.now(), id: null, rev: null, d: DD });
    s.m.set(bKey, bRaw);
    release({ status: 200, body: '{"account":"oh"}' });   // 옛 응답(다른 계정이었을 수도)
    expect(await p).toBe('off');
    expect(P.snapshot()).toMatchObject({ status: 'off', gen: g + 1 });
    expect(s.m.get(bKey)).toBe(bRaw);                    // sweep 0 — 새 탭 초안 보존
    expect(s.getItem('fh.pd.v1.nonce')).toBe('N2');      // nonce 덮어쓰기 0
    expect(P.put(K, DR, g)).toBe(false); expect(P.remove(K, g)).toBe(false);
    // 정상: 읽기 불가(undefined) → mem 결속
    const boom = () => { throw new Error('SecurityError'); };
    P = await boot(store({ getItem: boom as any, setItem: boom as any }), okWho());
    expect(await P.check()).toBe('ready');
    expect(P.snapshot().mem).toBe(true);
    expect(P.put(K, DR, P.snapshot().gen)).toBe(true);
  });

  it('R2: check 시작 전 이벤트 없이 바뀐 nonce 도 재결속 0', async () => {
    const s = store();
    const P = await boot(s, okWho());
    await P.check(); const g = P.snapshot().gen;
    s.m.set('fh.pd.v1.nonce', 'N2');
    expect(await P.check()).toBe('off');
    expect(P.snapshot().gen).toBe(g + 1);
  });

  it('R2: 계정 전환(nonce 그대로) → gen+1·off·scratch 폐기, 같은 문맥 재확인은 gen 그대로 ready', async () => {
    const s = store();
    let who = 'oh';
    const T: Who = { gated: true, whoami: async () => ({ status: 200, body: JSON.stringify({ account: who }) }) };
    const P = await boot(s, T);
    const S = await import('../../src/data/scratch');
    await P.check(); const g = P.snapshot().gen; P.put(K, DR, g);
    expect(await P.check()).toBe('ready');              // 같은 문맥 재확인
    expect(P.snapshot().gen).toBe(g); expect(P.get(K)).toEqual(DR);
    S.useSel.setState({ r1: 1 }); const n = S.ctx.n;
    who = 'kim';
    expect(await P.check()).toBe('off');
    expect(P.snapshot()).toMatchObject({ status: 'off', gen: g + 1 });
    expect(P.snapshot().note).toContain('계정');
    expect(S.ctx.n).toBe(n + 1); expect(S.useSel.getState()).toEqual({});
    expect(P.put(K, DR, g)).toBe(false);
    expect(await P.check()).toBe('ready');              // 새 gen 에서 kim 으로 결속 — oh 보관본은 쓸어냄
    expect(P.get(K)).toBeNull(); expect(pdKeys(s)).toEqual([]);
  });

  it('R2: 401 뒤 같은 문맥 재확인은 재결속(gen 그대로), 401 뒤 다른 계정은 폐기', async () => {
    const s = store();
    let r = { status: 200, body: '{"account":"oh"}' };
    const P = await boot(s, { gated: true, whoami: async () => r });
    await P.check(); const g = P.snapshot().gen; P.put(K, DR, g);
    r = { status: 401, body: '{}' }; expect(await P.check()).toBe('off');
    r = { status: 200, body: '{"account":"oh"}' }; expect(await P.check()).toBe('ready');
    expect(P.snapshot().gen).toBe(g); expect(P.get(K)).toEqual(DR);
    r = { status: 401, body: '{}' }; await P.check();
    r = { status: 200, body: '{"account":"kim"}' }; expect(await P.check()).toBe('off');
    expect(P.snapshot().gen).toBe(g + 1);
  });

  it('깨진 보관본(구조 위반) → null', async () => {
    const s = store();
    const P = await boot(s, okWho());
    await P.check(); P.put(K, DR, P.snapshot().gen);
    const e = JSON.parse(s.getItem(ownKey(s))!);
    for (const bad of [{ ...e, v: 2 }, { ...e, key: 'mission:X' }, { ...e, d: 'str' }, { ...e, id: 7 }, { ...e, at: 'x' }]) {
      s.m.set(ownKey(s), JSON.stringify(bad));
      expect(P.get(K)).toBeNull();
    }
  });

  it('storage 차단 → 탭 메모리만 + 안내, 새로 읽으면 없음', async () => {
    const boom = () => { throw new Error('SecurityError'); };
    const s = store({ getItem: boom as any, setItem: boom as any });
    let P = await boot(s, okWho());
    expect(await P.check()).toBe('ready');
    expect(P.snapshot().mem).toBe(true);
    expect(P.snapshot().note).toContain('탭 메모리');
    expect(P.put(K, DR, P.snapshot().gen)).toBe(true);
    expect(P.get(K)).toEqual(DR);
    P.drop(); expect(P.get(K)).toBeNull();
    P = await boot(null, okWho()); await P.check();
    expect(P.get(K)).toBeNull();
  });

  it('가득(setItem 실패) → 메모리로 보관, 안내', async () => {
    const s = store();
    const P = await boot(s, okWho());
    await P.check();
    s.setItem = () => { throw new Error('QuotaExceededError'); };
    expect(P.put(K, DR, P.snapshot().gen)).toBe(true);
    expect(P.snapshot().mem).toBe(true);
    expect(P.get(K)).toEqual(DR);
  });

  it('dropScratch(로그아웃·관문 변경·세션 끝·로그인 성공 경로) → 영속 초안 폐기, ctx.n 은 한 번만 +1', async () => {
    const s = store();
    const P = await boot(s, okWho());
    const S = await import('../../src/data/scratch');
    await P.check(); P.put(K, DR, P.snapshot().gen);
    S.drafts.set(K, DR); S.useSel.setState({ r1: 2 });
    const g = P.snapshot().gen, n = S.ctx.n;
    S.dropScratch();
    expect(P.snapshot()).toMatchObject({ status: 'off', gen: g + 1 });
    expect(S.ctx.n).toBe(n + 1);
    expect(S.drafts.size).toBe(0); expect(S.useSel.getState()).toEqual({});
    expect(pdKeys(s)).toEqual([]);
  });

  it('PD 단독 폐기(다른 탭 nonce·storage 이벤트) → scratch 탭 메모리·sel·ctx 도 폐기(확인 전 off 여도)', async () => {
    const s = store();
    const P = await boot(s, okWho());
    const S = await import('../../src/data/scratch');
    S.drafts.set(K, DR); S.useSel.setState({ r1: 2 });
    let n = S.ctx.n;
    onStorage!({ key: 'fh.pd.v1.nonce' });              // status off 상태에서도
    expect(S.ctx.n).toBe(n + 1); expect(S.drafts.size).toBe(0); expect(S.useSel.getState()).toEqual({});
    await P.check(); S.drafts.set(K, DR); n = S.ctx.n;
    s.m.set('fh.pd.v1.nonce', 'other-tab');             // 이벤트 없이 — get 재대조
    expect(P.get(K)).toBeNull();
    expect(S.ctx.n).toBe(n + 1); expect(S.drafts.size).toBe(0);
    onStorage!({ key: 'unrelated' }); expect(S.ctx.n).toBe(n + 1);   // 무관 키는 폐기 0
  });
});
