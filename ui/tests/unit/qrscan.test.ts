// QR 스캔 수명 — 닫기·숨김 뒤 늦은 결과 0, detect 동시 1·수락 1. 가짜 카메라/검출기(실폰 아님)
import { describe, expect, it, vi } from 'vitest';
import { startScan, type ScanDeps } from '../../src/data/qrscan';

const parse = (t: string) => (t.startsWith('https://') ? { origin: t } : { why: '주소 아님' });
const deferred = <T,>() => { let res!: (v: T) => void, rej!: (e: unknown) => void; const p = new Promise<T>((a, b) => { res = a; rej = b; }); return { p, res, rej }; };
const track = () => ({ stop: vi.fn() });
const mk = (o: Partial<ScanDeps> = {}) => {
  const tr = track(), cb = { onOrigin: vi.fn(), onClose: vi.fn(), setMsg: vi.fn() };
  const d: ScanDeps = { getMedia: async () => ({ getTracks: () => [tr] }) as any, video: { srcObject: null, readyState: 4, play: async () => {} },
    makeDet: () => ({ detect: async () => [] }), parse, every: 10, ...cb, ...o };
  return { d, tr, cb };
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('startScan', () => {
  it('detector 보류 → 닫기 → 풀기: 주소 변경·안내 0, 카메라 꺼짐', async () => {
    const q = deferred<any[]>(), det = { detect: vi.fn(() => q.p) }, { d, tr, cb } = mk({ makeDet: () => det });
    const stop = startScan(d); await wait(30);
    expect(det.detect).toHaveBeenCalledTimes(1);   // 보류 중엔 동시 1개
    expect(stop()).toBe(true); expect(tr.stop).toHaveBeenCalled();
    q.res([{ rawValue: 'https://gate.test:8453' }]); await wait(30);
    expect(cb.onOrigin).not.toHaveBeenCalled(); expect(cb.onClose).not.toHaveBeenCalled();
    expect(cb.setMsg.mock.calls.map((c) => c[0])).toEqual(['관문 주소 QR 을 비추세요']);
    expect(stop()).toBe(false);   // 두 번째 stop 은 닫기 안내 0 근거
  });
  it('한 번만 수락 — 여러 코드가 와도 onOrigin 1회, 그 뒤 detect 0', async () => {
    const det = { detect: vi.fn(async () => [{ rawValue: 'https://a.test' }, { rawValue: 'https://b.test' }]) }, { d, cb } = mk({ makeDet: () => det });
    startScan(d); await wait(60);
    expect(cb.onOrigin.mock.calls).toEqual([['https://a.test']]); expect(det.detect).toHaveBeenCalledTimes(1);
  });
  it('getUserMedia 늦은 거절·늦은 성공: 닫은 뒤면 안내 0, 늦게 온 카메라는 바로 끔', async () => {
    const g1 = deferred<any>(), a = mk({ getMedia: () => g1.p }); a.d.onClose = a.cb.onClose;
    startScan(a.d)(); g1.rej(Object.assign(new Error('no'), { name: 'NotAllowedError' })); await wait(10);
    expect(a.cb.onClose).not.toHaveBeenCalled();
    const g2 = deferred<any>(), tr = track(), b = mk({ getMedia: () => g2.p });
    startScan(b.d)(); g2.res({ getTracks: () => [tr] }); await wait(10);
    expect(tr.stop).toHaveBeenCalled(); expect(b.cb.setMsg).not.toHaveBeenCalled();
  });
  it('play 늦은 오류: 닫은 뒤면 안내 0 · 살아 있으면 안내 1', async () => {
    const p1 = deferred<void>(), a = mk(); a.d.video.play = () => p1.p;
    const s = startScan(a.d); await wait(5); s(); p1.rej(new Error('x')); await wait(10);
    expect(a.cb.onClose).not.toHaveBeenCalled();
    const b = mk(); b.d.video.play = async () => { throw Object.assign(new Error('x'), { name: 'NotAllowedError' }); };
    startScan(b.d); await wait(10);
    expect(b.cb.onClose).toHaveBeenCalledTimes(1);
  });
  it('주소 아닌 QR 은 안내만, 수락 0', async () => {
    const { d, cb } = mk({ makeDet: () => ({ detect: async () => [{ rawValue: 'WIFI:S:x;;' }] }) });
    const s = startScan(d); await wait(30); s();
    expect(cb.onOrigin).not.toHaveBeenCalled(); expect(cb.setMsg).toHaveBeenCalledWith('관문 주소가 아닌 QR — 주소 아님');
  });
});
