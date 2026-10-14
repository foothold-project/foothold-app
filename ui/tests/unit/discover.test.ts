// 주변 관문 검색(D′) — 결과 재검증·늦은 결과 버림·discoverStop 순서. 가짜 네이티브(실폰 NSD 아님)
import { describe, expect, it, vi } from 'vitest';
import { cleanItems, errOf, foundOf, startNearby, stopNearby, type NearbyApi } from '../../src/data/discover';

const deferred = <T,>() => { let res!: (v: T) => void, rej!: (e: unknown) => void; const p = new Promise<T>((a, b) => { res = a; rej = b; }); return { p, res, rej }; };
const tick = () => new Promise((r) => setTimeout(r, 0));
const it1 = (o: object = {}) => ({ name: 'FOOTHOLD 관문 · d21e2e97', origin: 'https://192.168.21.242:8453', app: 'foothold-gate', api: 1, ...o });

describe('cleanItems', () => {
  it('사설 IPv4 https origin · app/api 일치만, 같은 origin 은 처음 것, 이름 정리', () => {
    const r = cleanItems([
      it1(), it1({ name: '두번째' }),                                    // 중복 → 처음 것
      it1({ origin: 'https://10.0.0.5:8453', name: 'a\u0000b\nc' }),    // 제어문자 제거
      it1({ origin: 'https://172.20.1.1:1', name: '' }),                // 빈 이름 허용(화면은 origin)
      it1({ origin: 'https://8.8.8.8:8453' }), it1({ origin: 'https://100.116.47.42:8453' }), it1({ origin: 'https://127.0.0.1:8453' }),
      it1({ origin: 'https://172.32.0.1:8453' }), it1({ origin: 'http://192.168.0.2:8453' }), it1({ origin: 'https://192.168.0.2:8453/x' }),
      it1({ origin: 'https://host.local:8453' }), it1({ origin: 'https://192.168.0.3:8453', app: 'other' }), it1({ origin: 'https://192.168.0.4:8453', api: 2 }),
      null, 'x', { origin: 5 },
    ]);
    expect(r).toEqual([
      { name: 'FOOTHOLD 관문 · d21e2e97', origin: 'https://192.168.21.242:8453' },
      { name: 'abc', origin: 'https://10.0.0.5:8453' },
      { name: '', origin: 'https://172.20.1.1:1' },
    ]);
    expect(cleanItems([it1({ name: 'x'.repeat(99) })])[0].name).toHaveLength(64);
    expect(cleanItems(Array.from({ length: 30 }, (_, i) => it1({ origin: `https://192.168.1.${i + 1}:8453` })))).toHaveLength(16);
    expect(cleanItems(undefined)).toEqual([]);
  });
  it('문구: 없음·why·stop failed·cancelled 조용히·busy/stale', () => {
    expect(foundOf({ items: [] }).msg).toMatch(/찾은 관문 없음/);
    expect(foundOf({ items: [it1()] }).msg).toBe('');
    expect(foundOf({ items: [], why: 'wifi' }).msg).toMatch(/Wi-Fi/);
    expect(foundOf({ items: [], why: 'hidden' }).msg).toMatch(/화면 밖/);
    expect(foundOf({ items: [], why: 'nsd' }).msg).toMatch(/주소 입력/);
    expect(foundOf({ items: [], why: 'cancelled' }).msg).toBe('');
    expect(foundOf({ items: [it1()], stop: 'failed' }).msg).toMatch(/검색 정리 실패/);
    expect(errOf({ code: 'busy' })).toMatch(/정리하는 중/);
    expect(errOf({ code: 'stale' })).toBe('');
  });
});

describe('startNearby', () => {
  const mk = () => { const d = deferred<unknown>(); const api: NearbyApi = { discover: vi.fn(() => d.p), stop: vi.fn() }; return { d, api }; };
  it('끝나면 결과 한 번, 끝난 뒤 stop 은 discoverStop 0', async () => {
    const { d, api } = mk(), done = vi.fn();
    const stop = startNearby(api, 5000, done); await tick();
    expect(api.discover).toHaveBeenCalledWith(5000);
    d.res({ items: [it1()] }); await tick();
    expect(done).toHaveBeenCalledTimes(1); expect(done.mock.calls[0][0].items).toHaveLength(1);
    stop(); await tick(); expect(api.stop).not.toHaveBeenCalled();
  });
  it('닫기(unmount) 뒤 늦은 결과 버림 · discoverStop 한 번 · 사유 없으면 done 0', async () => {
    const { d, api } = mk(), done = vi.fn();
    const stop = startNearby(api, 5000, done); await tick();
    stop(); stop(); await tick();
    expect(api.stop).toHaveBeenCalledTimes(1);
    d.res({ items: [it1()] }); await tick();
    expect(done).not.toHaveBeenCalled();
  });
  it('로그인 시작(stopNearby) → 사유로 끝냄, 늦은 결과 버림', async () => {
    const { d, api } = mk(), done = vi.fn();
    startNearby(api, 5000, done); await tick();
    stopNearby(); await tick();
    expect(done).toHaveBeenCalledTimes(1); expect(done.mock.calls[0][0].msg).toMatch(/로그인 시작/);
    d.res({ items: [it1()] }); await tick(); expect(done).toHaveBeenCalledTimes(1);
  });
  it('다시 검색: 앞 검색 discoverStop 이 끝난 뒤에 새 discover(동시 1)', async () => {
    const order: string[] = [], s = deferred<void>();
    const d1 = deferred<unknown>(), d2 = deferred<unknown>();
    const api: NearbyApi = { discover: vi.fn(() => { order.push('discover'); return order.length === 1 ? d1.p : d2.p; }), stop: vi.fn(() => { order.push('stop'); return s.p; }) };
    const done = vi.fn();
    startNearby(api, 5000, done); await tick();
    startNearby(api, 5000, done); await tick();
    expect(order).toEqual(['discover', 'stop']);   // 정리 끝나기 전 새 discover 0
    s.res(); await tick(); await tick();
    expect(order).toEqual(['discover', 'stop', 'discover']);
    d1.res({ items: [it1()] }); d2.res({ items: [] }); await tick();
    expect(done).toHaveBeenCalledTimes(1); expect(done.mock.calls[0][0].items).toEqual([]);   // 옛 결과 0
  });
  it('거부: busy 는 안내, stale 은 조용히', async () => {
    const api: NearbyApi = { discover: vi.fn(() => Promise.reject({ code: 'busy' })), stop: vi.fn() }, done = vi.fn();
    startNearby(api, 5000, done); await tick(); await tick();
    expect(done.mock.calls[0][0].msg).toMatch(/정리하는 중/);
    const api2: NearbyApi = { discover: vi.fn(() => Promise.reject({ code: 'stale' })), stop: vi.fn() }, done2 = vi.fn();
    startNearby(api2, 5000, done2); await tick(); await tick();
    expect(done2).not.toHaveBeenCalled();
  });
});
