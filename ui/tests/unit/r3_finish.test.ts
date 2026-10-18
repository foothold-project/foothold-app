// R3 종료 방식(Mission.finish · ROOT 결정 cc2755b9 · 715 계약 1ce061ed): newRun 은 계획에 키가 있을 때만 같은 값 사본 · 없으면 키 0 ·
// 표기 = 값 그대로 / 계획 키 없음 «종료 방식 미지정» / Run 키 없음 «종료 방식 기록 없음»(계획 값으로 채움 0) · 사본은 원본 값 그대로(옛 사본은 ④ 요구) · 서버 409 사유 문구.
// 실제 run.ts·hist.ts 함수를 부름(소스 미러 0). 서버 대조 자체는 backend 시험(RL) 범위.
import { beforeEach, expect, test, vi } from 'vitest';
import type { DocWrite, Mission, Run } from '@contracts';
const T0 = vi.hoisted(() => ({ toasts: [] as string[] }));
vi.mock('../../src/app/shell', async (orig) => ({ ...(await orig<any>()), toast: (t: string) => { T0.toasts.push(t); } }));
const mem = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
const { dupMission, finishText, startRun, startText } = await import('../../src/data/run');
const { histRows } = await import('../../src/data/hist');
const { createWhy } = await import('../../src/screens/plan2d');
const { useLink } = await import('../../src/data/link');
const { qc, docsNow } = await import('../../src/data/shared');

const W = [{ x: 1, y: 2, name: 'a', mods: [] }] as Mission['wps'];
const mi = (o: Partial<Mission> = {}): Mission => ({ name: '계획', tmpl: 'base', memo: '', wps: structuredClone(W), ...o });
const put = (docs: unknown[]) => qc.setQueryData(['docs'], { docs, rev: 1, broken: null });
const env = (id: string, kind: string, doc: unknown, rev = 1) => ({ id, kind, rev, by: 'A', at: 't', doc });
const go = async (m: Mission, res: object = { ok: true }) => {
  put([env('m1', 'mission', m, 4)]); const sent: DocWrite[] = [];
  const r = await startRun(docsNow(), 'm1', async (w) => { sent.push(w); return res as any; }, { ask: async () => true });
  const w = sent[0]; return { r, sent, doc: w && w.op === 'put' ? (w.doc as Run) : undefined };
};
beforeEach(() => {
  mem.clear(); qc.clear(); T0.toasts = [];
  useLink.setState({ open: true, lastMsg: performance.now(), provider: 'simulation_gate', st: { applied: [0, 0, 0], live_map: { st: 'ok', bound: true, world_id: 'v5_single', floor_id: 'f1', world_src_sha256: 'd'.repeat(64), spawn_floor: 'f1' } } as any });
});

test('finish 사본: 계획 값 그대로 · 계획 키 없음 = Run 키 없음(채움·기본값 0) · 다른 Run 필드·mrev 그대로', async () => {
  for (const f of ['출발점 복귀', '마지막 지점 종료'] as const) {
    const { r, sent, doc } = await go(mi({ finish: f }));
    expect(r).toBeTruthy(); expect(sent).toHaveLength(1); expect(doc!.finish).toBe(f); expect(doc!.mrev).toBe(4);
  }
  const { doc } = await go(mi());
  expect(doc).toBeTruthy(); expect('finish' in doc!).toBe(false); expect(JSON.stringify(doc)).not.toContain('finish');
});

test('409 snapshot_mismatch(옛 사본·계획 바뀜) = 시작 안 됨 · «계획 사본이 다름» 문구 · 자동 재시도 0', async () => {
  const { r, sent } = await go(mi({ finish: '출발점 복귀' }), { ok: false, code: 409, reason: 'snapshot_mismatch', error: 'x' });
  expect(r).toBeNull(); expect(sent).toHaveLength(1);
  expect(T0.toasts[T0.toasts.length - 1]).toBe('다른 기기가 계획/양식을 바꿈(계획 사본이 다름) — 시작 안 됨 · 다시 열어 확인');
});

test('표기: 값 그대로 · 계획 키 없음 «종료 방식 미지정» · Run 키 없음 «종료 방식 기록 없음» — 계획에 값이 있어도 옛 Run 을 채우지 않음(legacy)', () => {
  expect(finishText(mi())).toBe('종료 방식 미지정'); expect(finishText(mi({ finish: '마지막 지점 종료' }))).toBe('마지막 지점 종료');
  const run = (o: Partial<Run> = {}) => ({ mode: '수동', mission: 'm1', tmpl: '기본', name: '계획', status: '진행', started: '2026-10-18T00:00:00Z', ended: '', memo: '',
    wps: [{ x: 1, y: 2, name: 'a', mods: [], st: '대기', at: '', why: '', chk: '', photos: [] }], ...o }) as Run;
  expect(finishText(run())).toBe('종료 방식 기록 없음'); expect(finishText(run({ finish: '출발점 복귀' }))).toBe('출발점 복귀');
  put([env('m1', 'mission', mi({ finish: '출발점 복귀' }), 4), env('r1', 'run', run()), env('r2', 'run', run({ finish: '마지막 지점 종료', started: '2026-10-18T01:00:00Z' }))]);
  const rows = histRows(docsNow(), { ok: true, photos: [], events: [] } as any, true).filter((x) => x.kind === '임무');
  expect(rows.find((x) => x.run === 'r1')).toMatchObject({ fin: '종료 방식 기록 없음 · 출발점 좌표 기록 없음' });
  expect(rows.find((x) => x.run === 'r1')!.sub).toContain(' · 종료 방식 기록 없음 · 방문 0/1');
  expect(rows.find((x) => x.run === 'r1')!.sub).toMatch(/ · 출발점 좌표 기록 없음$/);   // S11: 폰 기록 한 줄(MHistory r.sub)에도 R0 표기 · 계획 S 로 채움 0
  expect(rows.find((x) => x.run === 'r2')).toMatchObject({ fin: '마지막 지점 종료 · 출발점 좌표 기록 없음' });
});

test('사본(dup) = 새 임무: 원본 값 그대로 · 옛 원본(키 없음) 사본은 키 없음 → ④ 명시 선택 요구(id 없음) · 원본 id 있는 옛 임무는 요구 0', () => {
  const a = dupMission(mi({ finish: '마지막 지점 종료' })); expect(a.finish).toBe('마지막 지점 종료'); expect(createWhy(a, true, true)).toBe('');
  const b = dupMission(mi()); expect('finish' in b).toBe(false);
  expect(createWhy(b, true, true)).toBe('만들려면: ④ 종료 방식');
  expect(createWhy(mi(), false, true)).toBe('');
});

// ROOT 8 계획 출발점 S: newRun 은 계획에 start 가 있을 때만 깊은 사본(값 같음 · 참조 다름) · 없으면 키 0 · 표기는 «계획 출처 · 실측 아님»
test('start 사본: 계획 S 그대로 깊은 사본 · 없으면 Run 키 없음 · startText 는 계획 출처 표기(실측 단정 0)', async () => {
  const S = { x: 1.234, y: -5.6, map: { world_id: 'v5_single', floor_id: 'f1', rid: 'r1', key: 'k1' } } as NonNullable<Mission['start']>;
  const m = mi({ finish: '출발점 복귀', start: structuredClone(S) });
  const { doc } = await go(m);
  expect(doc!.start).toEqual(S); expect(doc!.start).not.toBe(m.start); expect(doc!.start!.map).not.toBe(m.start!.map);
  const { doc: d2 } = await go(mi({ finish: '출발점 복귀' }));
  expect('start' in d2!).toBe(false);
  expect(startText(doc!)).toBe('계획 출발점 X 1.23 · Y -5.60 (계획 출처 · 실측 아님)');
  expect(startText(d2!)).toBe('출발점 좌표 기록 없음');
});
