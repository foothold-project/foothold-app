// C(10-15 프리셋): 서버 시작 대조 응답(reason_code·mcas_dropped)과 화면 문구 · cut16 공통 표본 · 시작 Run 의 양식 이름 자르기
import { beforeEach, expect, test, vi } from 'vitest';
import type { DocWrite, Mission, Run } from '@contracts';
const toasts: string[] = [], last = () => toasts[toasts.length - 1];
vi.mock('../../src/app/shell', async (orig) => ({ ...(await orig<typeof import('../../src/app/shell')>()), toast: (t: unknown) => { if (typeof t === 'string') toasts.push(t); } }));
const mem = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
const { cutName, mcasTxt, runEdit, startRun } = await import('../../src/data/run');
const { qc, docsNow, saveDoc } = await import('../../src/data/shared');
const { T } = await import('../../src/data/transport');

const env = (id: string, kind: string, doc: unknown, rev = 1) => ({ id, kind, rev, by: 'A', at: 't', doc });
const put = (docs: unknown[]) => qc.setQueryData(['docs'], { docs, rev: 1, broken: null });
const mi = (o: Partial<Mission> = {}): Mission => ({ name: '계획', tmpl: 'base', memo: '', wps: [{ x: 1, y: 2, name: 'a', mods: [] }], ...o });
const RUN: Run = { mode: '수동', mission: 'm1', tmpl: '지점 확인 다녀오기', name: '계획', status: '진행', started: 't', ended: '', memo: '',
  wps: [{ x: 1, y: 2, name: 'a', mods: [], st: '대기', at: '', why: '', chk: '', photos: [] }], mrev: 1 };
const reply = (status: number, body: unknown) => { T.postDocs = async () => ({ status, body: JSON.stringify(body) }); };
beforeEach(() => { toasts.length = 0; mem.clear(); });

// server/runcas.py cut16 시험(tests/backend/test_runcas.py CUT)과 같은 입력·기대값
const CUT: [string, number, string][] = [['한'.repeat(56) + '🤖나나', 57, '한'.repeat(56)], ['한'.repeat(56) + '🤖나나', 60, '한'.repeat(56) + '🤖나나'], ['🤖'.repeat(30), 59, '🤖'.repeat(29)],
  ['a' + '😀'.repeat(29), 60, 'a' + '😀'.repeat(29)], ['a' + '😀'.repeat(30), 60, 'a' + '😀'.repeat(29)], ['가'.repeat(61), 60, '가'.repeat(60)], ['', 60, '']];
test('cutName = 서버 cut16 공통 표본', () => { for (const [s, n, w] of CUT) expect(cutName(s, n)).toBe(w); });

test('saveDoc: reason_code → reason · mcas_dropped → mcasDropped · code 는 HTTP 숫자 그대로', async () => {
  reply(409, { error: 'e', cur: null, reason_code: 'mission_changed' });
  expect(await saveDoc({ op: 'put', kind: 'run', id: null, doc: RUN } as DocWrite)).toEqual({ ok: false, code: 409, error: 'e', cur: null, reason: 'mission_changed' });
  reply(409, { error: '다른 기기가 먼저 고침', cur: null });
  const r = await saveDoc({ op: 'put', kind: 'run', id: null, doc: RUN } as DocWrite); expect(r.ok === false && r.code === 409 && !('reason' in r)).toBe(true);
  reply(200, { ok: true, id: 'r1', rev: 2, kind: 'run', name: '', new: false, mcas_dropped: true });
  expect(await saveDoc({ op: 'put', id: 'r1', rev: 1, doc: RUN } as DocWrite)).toMatchObject({ ok: true, id: 'r1', rev: 2, mcasDropped: true });
  reply(200, { ok: true, id: 'r1', rev: 2, kind: 'run', name: '', new: false });
  expect('mcasDropped' in (await saveDoc({ op: 'put', id: 'r1', rev: 1, doc: RUN } as DocWrite))).toBe(false);
});

test('startRun: C 409 사유만 «다른 기기가 계획/양식을 바꿈», 진행 1개 409·400 은 기존 문구 · 자동 재시도 0', async () => {
  for (const reason of ['mission_gone', 'mission_changed', 'tmpl_changed', 'snapshot_mismatch']) {
    put([env('m1', 'mission', mi(), 3)]); toasts.length = 0; let n = 0;
    const r = await startRun(docsNow(), 'm1', async () => { n++; return { ok: false, code: 409, error: '서버 이유', reason }; }, { ask: async () => true });
    expect(r).toBeNull(); expect(n).toBe(1); expect(last()).toBe('다른 기기가 계획/양식을 바꿈 — 시작 안 됨 · 다시 열어 확인(서버 이유)');
  }
  put([env('m1', 'mission', mi(), 3)]); toasts.length = 0;
  await startRun(docsNow(), 'm1', async () => ({ ok: false, code: 409, error: '이미 진행 중인 수동 임무가 있음 — 먼저 끝내세요' }), { ask: async () => true });
  expect(last()).toBe('시작 안 됨 · 이미 진행 중인 수동 임무가 있음 — 먼저 끝내세요');
  await startRun(docsNow(), 'm1', async () => ({ ok: false, code: 400, error: 'mcas 는 서버만', reason: 'mcas_forbidden' }), { ask: async () => true });
  expect(last()).toBe('시작 안 됨 · mcas 는 서버만');
});

test('startRun 보내는 Run: 양식 이름은 cutName(60) · mcas 안 보냄', async () => {
  const nm = '양'.repeat(59) + '🤖';
  put([env('t1', 'tmpl', { name: nm, desc: '', mods: [] }), env('m1', 'mission', mi({ tmpl: 't1' }), 3)]); const sent: DocWrite[] = [];
  await startRun(docsNow(), 'm1', async (w) => { sent.push(w); return { ok: true, id: 'r1', rev: 1 }; }, { ask: async () => true });
  const d = (sent[0] as any).doc as Run; expect(d.tmpl).toBe('양'.repeat(59)); expect('mcas' in d).toBe(false); expect(d.mrev).toBe(3);
});

test('runEdit: 서버가 mcas 를 떼면 기록됨 + 표시 해제 알림 · 결과 편집은 저장 문서(mcas 포함) 그대로 echo', async () => {
  put([env('r1', 'run', { ...RUN, mcas: 1 })]); let body: any = null;
  T.postDocs = async (b) => { body = b; return { status: 200, body: JSON.stringify({ ok: true, id: 'r1', rev: 2, kind: 'run', name: '', new: false, mcas_dropped: true }) }; };
  await runEdit('r1', (d) => { d.memo = 'm'; }, '메모');
  expect(body.doc.mcas).toBe(1); expect(last()).toBe('메모 · 기록됨(운영자 기록 · 모든 기기 공유) · 서버 시작 대조 표시 해제(근거 필드가 바뀜)');
  put([env('r1', 'run', { ...RUN, mcas: 1 })]); reply(200, { ok: true, id: 'r1', rev: 2, kind: 'run', name: '', new: false });
  await runEdit('r1', (d) => { d.memo = 'm'; }, '메모'); expect(last()).toBe('메모 · 기록됨(운영자 기록 · 모든 기기 공유)');
});

test('mcasTxt: 미대조 · 내장 기본 · 팀 양식 · 계획 판이 바뀌면 양식 종류 모름', () => {
  put([env('m1', 'mission', mi(), 1)]);
  expect(mcasTxt(docsNow(), RUN)).toBe('서버 미대조 — 이 기기 캐시 기준으로 시작');
  expect(mcasTxt(docsNow(), { ...RUN, mcas: 1 })).toBe('시작 때 서버가 계획 판·스냅샷 대조 · 양식: 내장 기본(이름 대조)');
  put([env('m1', 'mission', mi({ tmpl: '' }), 1)]); expect(mcasTxt(docsNow(), { ...RUN, mcas: 1 })).toMatch(/양식: 내장 기본\(이름 대조\)$/);
  put([env('m1', 'mission', mi({ tmpl: 't1' }), 1)]); expect(mcasTxt(docsNow(), { ...RUN, mcas: 1 })).toMatch(/양식: 이름·존재만\(본문 개정 미검증\)$/);
  put([env('m1', 'mission', mi(), 2)]); expect(mcasTxt(docsNow(), { ...RUN, mcas: 1 })).toMatch(/양식: 이름·존재만$/);
});
