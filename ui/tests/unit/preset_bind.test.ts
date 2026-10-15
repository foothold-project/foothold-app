// 프리셋 1단계(10-15): 좌표 출처 = 찍은/가져온 시점 결속 · Run 출처 보존 · 시작 정책(불일치 차단 · 미확인은 기록만) · 옛 계획/옛 앱 호환
import { beforeEach, expect, test, vi } from 'vitest';
import type { DocWrite, MapSrc, Mission, Run } from '@contracts';
const mem = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
const { addPlan, gtHere, planMap, rekey, runHere, startPolicy, startRun, wkey } = await import('../../src/data/run');
const { useLink } = await import('../../src/data/link');
const { qc, docsNow } = await import('../../src/data/shared');

const W1 = [{ x: 1, y: 2, name: 'a', mods: [] }, { x: -3.5, y: 4, name: 'b', mods: [] }] as Mission['wps'];
const L1: MapSrc = { src: 'gt', world_id: 'v5_building', floor_id: 'l1', key: wkey(W1) };
const mi = (o: Partial<Mission> = {}): Mission => ({ name: '계획', tmpl: 'base', memo: '', wps: structuredClone(W1), ...o });
// 링크 상태: 신선한 status + live_map(연결 건물이면 floor 판정)
const live = (lv: Record<string, unknown> | null, fresh = true) => useLink.setState({ open: true, lastMsg: fresh ? performance.now() : performance.now() - 5000, provider: 'simulation_gate', st: { live_map: lv, applied: [0, 0, 0] } as any });
const onL = (cur: string | null, state = 'on_floor', world = 'v5_building') => live({ st: 'ok', world_id: world, floor_id: 'l1', floor: { rev: 1, state, current: cur, reason: '' } });
beforeEach(() => { mem.clear(); onL('l1'); });

test('지금 지도: 연결 건물은 on_floor current 만 · transit/unknown·끊김·미수신은 이유', () => {
  expect(gtHere().map).toMatchObject({ world_id: 'v5_building', floor_id: 'l1' });
  onL('l2'); expect(gtHere().map?.floor_id).toBe('l2');                       // 시작층(floor_id l1)이 아니라 서버 현재층
  onL(null, 'transit'); expect(gtHere().why).toBe('층 이동 중');
  onL(null, 'unknown'); expect(gtHere().why).toBe('현재층 미확인');
  live({ st: 'ok', world_id: 'rooms_a', floor_id: 'f1' }); expect(gtHere().map).toMatchObject({ world_id: 'rooms_a', floor_id: 'f1' });   // 단층: floor 판정 없음
  live({ st: 'stale', world_id: 'rooms_a', floor_id: 'f1' }); expect(gtHere().why).toBe('지금 지도 미수신');
  live(null); expect(gtHere().why).toBe('지금 지도 미수신');
  onL('l1'); live({ st: 'ok', world_id: 'v5_building', floor_id: 'l1', floor: { state: 'on_floor', current: 'l1' } }, false); expect(gtHere().why).toBe('연결 끊김');
});

test('시작 정책 표: 일치 = 결속 · world/층 불일치 = 차단 · 출처 없음/지문 어긋남/층 이동 중 = 기록만', () => {
  const ok = startPolicy(mi({ map: L1 }), gtHere());
  expect(ok.block).toBeNull(); expect(ok.map).toEqual(L1);
  onL('l2'); const fl = startPolicy(mi({ map: L1 }), gtHere());
  expect(fl.block).toMatch(/다른 지도.*l1.*l2/); expect(fl.map).toBeNull();
  onL('l1', 'on_floor', 'v5_single'); expect(startPolicy(mi({ map: L1 }), gtHere()).block).toMatch(/v5_building.*v5_single/);
  onL('l1');
  const old = startPolicy(mi(), gtHere());                                       // 옛 계획(map 없음)
  expect([old.block, old.map]).toEqual([null, null]); expect(old.line).toMatch(/기록만 — 출처 기록 없음/);
  const moved = startPolicy(mi({ map: L1, wps: [...structuredClone(W1), { x: 9, y: 9, name: 'c', mods: [] }] }), gtHere());   // 옛 앱이 map 을 보존한 채 지점 추가
  expect([moved.block, moved.map]).toEqual([null, null]); expect(moved.line).toMatch(/출처 기록 뒤 좌표가 바뀜/);
  onL(null, 'transit'); const tr = startPolicy(mi({ map: L1 }), gtHere());
  expect([tr.block, tr.map]).toEqual([null, null]); expect(tr.line).toMatch(/지금 층 이동 중/);
});

test('지문: 순서 무관 · 좌표 바뀌면 다름 · 이름만 바꾸면 그대로', () => {
  expect(wkey([...W1].reverse())).toBe(wkey(W1));
  expect(wkey([{ ...W1[0], x: 1.01 }, W1[1]])).not.toBe(wkey(W1));
  expect(planMap(mi({ map: L1, wps: W1.map((w) => ({ ...w, name: '새 이름' })) })).map).toEqual(L1);
});

test('찍는 시점 결속: 빈 계획 = 지금 지도 · 같은 지도 = 유지 · 다른/모르는 지도 = drop · 이미 미확인 = none', () => {
  expect(addPlan(mi({ wps: [] }), gtHere()).act).toBe('bind');
  expect(addPlan(mi({ map: L1 }), gtHere()).act).toBe('keep');
  onL('l2'); expect(addPlan(mi({ map: L1 }), gtHere())).toMatchObject({ act: 'drop' });
  onL(null, 'transit'); expect(addPlan(mi({ map: L1 }), gtHere()).why).toMatch(/지금 지도 미확인\(층 이동 중\)/);
  expect(addPlan(mi(), gtHere()).act).toBe('none');
});

test('rekey: 유효 출처면 새 지문 · 이미 어긋난 출처는 지움(옛 지문을 새 좌표에 맞춰 «확인»으로 올리지 않음)', () => {
  const a = mi({ map: L1 }); rekey(a, () => { a.wps.splice(0, 1); });
  expect(a.map).toEqual({ ...L1, key: wkey(a.wps) }); expect(planMap(a).map).toBeTruthy();
  const b = mi({ map: { ...L1, key: 'deadbeef' } }); rekey(b, () => { b.wps.splice(0, 1); });
  expect(b.map).toBeUndefined();
});

test('runHere: 기록 출처가 지금 지도와 같을 때만 거리·겹치기', () => {
  const R = { wps: W1.map((w) => ({ ...w, st: '대기', at: '', why: '', chk: '', photos: [] })), map: L1 } as unknown as Run;
  expect(runHere(R).ok).toBe(true);
  onL('l2'); expect(runHere(R)).toMatchObject({ ok: false, why: expect.stringMatching(/다른 지도/) });
  onL('l1'); expect(runHere({ ...R, map: undefined } as Run)).toMatchObject({ ok: false, why: expect.stringMatching(/시작 때 출처 미확인/) });
});

// ---- startRun(모든 진입점 공통): 보내는 Run 문서와 확인창 사이 변화 ----
const put = (docs: unknown[]) => qc.setQueryData(['docs'], { docs, rev: 1, broken: null });
const env = (id: string, kind: string, doc: unknown, rev = 1) => ({ id, kind, rev, by: 'A', at: 't', doc });
const go = async (m: Mission, onAsk?: () => void) => {
  put([env('m1', 'mission', m, 4)]); const sent: DocWrite[] = [];
  (globalThis as any).confirm = vi.fn(() => { onAsk?.(); return true; });
  const r = await startRun(docsNow(), 'm1', async (w) => { sent.push(w); return { ok: true, id: 'r1', rev: 1, kind: 'run', name: '', new: true } as any; });
  return { r, sent, ask: String(((globalThis as any).confirm as any).mock.calls[0]?.[0] ?? '') };
};

test('startRun 일치: 확인 1회에 이름·지도·지점 수 · Run 에 map·mrev', async () => {
  const { sent, ask } = await go(mi({ map: L1 }));
  expect(ask).toMatch(/«계획».*\n· 지도 v5_building · l1 \(GT\) · 지금 시뮬과 같음\n· 지점 2개/);
  expect(sent).toHaveLength(1); const doc = (sent[0] as any).doc as Run;
  expect(doc.map).toEqual(L1); expect(doc.mrev).toBe(4); expect(doc.wps.map((w) => [w.x, w.y])).toEqual([[1, 2], [-3.5, 4]]);
});
test('startRun 옛 계획: 기록만으로 시작(map 없음·mrev 있음) · 불일치: 확인창 없이 차단', async () => {
  const a = await go(mi()); expect(a.ask).toMatch(/지도 미확인 · 기록만/);
  const d = (a.sent[0] as any).doc as Run; expect('map' in d).toBe(false); expect(d.mrev).toBe(4);
  onL('l2'); const b = await go(mi({ map: L1 }));
  expect(b.r).toBeNull(); expect(b.sent).toHaveLength(0); expect(b.ask).toBe('');
});
test('startRun 확인하는 사이 계획 판·층이 바뀌면 보내지 않음', async () => {
  const a = await go(mi({ map: L1 }), () => put([env('m1', 'mission', mi({ map: L1 }), 5)]));
  expect(a.r).toBeNull(); expect(a.sent).toHaveLength(0);
  const b = await go(mi({ map: L1 }), () => onL(null, 'transit'));
  expect(b.r).toBeNull(); expect(b.sent).toHaveLength(0);
});
