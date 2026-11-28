// 실행 기록 보기 · #571 reviewer 낮은 지적 Q1~Q5: 쪽 넘기기 · 2,000 건 상한 한 줄 · 표시만 결과 · 여는 초점 · 머리 다시 시도 · 날 넘긴 끝 시각.
import { act } from 'react';
import { createRoot, type Root as ReactRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Event as Ev } from '../../../contracts/ts';
import { RunReport } from '../screens/runreport';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RUN = 'run-1';
const local = (d: number, h: number, m: number) => new Date(2026, 10, d, h, m).toISOString();
const HIST = { id: RUN, scenario_version_id: 'sv1', floor_id: 'f1', map_version_id: 'm1', scenario_name: '공정 순찰 A', floor_name: '1층', scenario_name_snapshot: null, floor_name_snapshot: null,
  status: 'COMPLETED', started_at: local(27, 10, 0), ended_at: local(27, 10, 31) };
const wp = (id: string, code: string, at: string, data: Record<string, unknown>): Ev => ({ id, at, robot_at: null, category: 'RUN', code, severity: 'INFO', message: `${code} ${id}`,
  robot_id: 'r-a', user_id: null, run_id: RUN, data });
const ok = (body: unknown) => ({ status: 200, body });
const no = (status: number, message: string) => ({ status, body: { error: { code: 'X', message, detail: {} } } });

type Rep = { status: number; body: unknown };
let calls: { path: string; q: URLSearchParams }[] = [];
function serve(head: () => Rep, events: (q: URLSearchParams) => Rep) {
  calls = [];
  vi.stubGlobal('fetch', async (url: string) => {
    const [path, qs = ''] = url.replace(/^\/api\/v1/, '').split('?'), q = new URLSearchParams(qs);
    calls.push({ path, q });
    const r = path === `/runs/${RUN}/history` ? head() : path === '/events' ? events(q) : no(404, '없음');
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
  });
}
let root: ReactRoot | null = null, box: HTMLDivElement;
const flush = () => act(async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); });
async function render() {
  box = document.createElement('div'); document.body.append(box);
  const opener = document.createElement('button'); box.append(opener); opener.focus();
  const slot = document.createElement('div'); box.append(slot);
  act(() => { root = createRoot(slot); root.render(<RunReport id={RUN} close={() => {}} />); });
  await flush();
}
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); vi.unstubAllGlobals(); });
const $ = (s: string) => box.querySelector<HTMLElement>(s);
const cells = () => [...box.querySelectorAll('tbody tr')].map((tr) => [...tr.children].map((td) => td.textContent));
const btn = (t: string) => [...box.querySelectorAll('button')].find((b) => b.textContent === t) as HTMLButtonElement | undefined;

describe('Q1 사건 쪽 넘기기', () => {
  it('둘째 쪽의 지점도 보임 · 둘째 요청은 첫 쪽 cursor 를 붙임', async () => {
    serve(() => ok(HIST), (q) => (q.get('cursor') === 'c2'
      ? ok({ items: [wp('2', 'RUN_WAYPOINT_ARRIVED', local(27, 10, 9), { idx: 1, mission_name: '나' })], next_cursor: null })
      : ok({ items: [wp('1', 'RUN_WAYPOINT_ARRIVED', local(27, 10, 4), { idx: 0, mission_name: '가' })], next_cursor: 'c2' })));
    await render();
    const ev = calls.filter((c) => c.path === '/events');
    expect(ev.map((c) => [c.q.get('run_id'), c.q.get('cursor')])).toEqual([[RUN, null], [RUN, 'c2']]);
    expect(cells().map((x) => x[0])).toEqual(['1 · 가', '2 · 나']);
    expect($('[data-run-cut]')).toBeNull();
  });
  it('20 쪽을 다 받고도 더 있으면 「앞 2,000 건만」 한 줄 · 더 부르지 않음', async () => {
    let n = 0;
    serve(() => ok(HIST), () => ok({ items: [wp(`e${n}`, 'RUN_WAYPOINT_ARRIVED', local(27, 10, 1), { idx: n++, mission_name: '' })], next_cursor: `c${n}` }));
    await render();
    expect(calls.filter((c) => c.path === '/events')).toHaveLength(20);
    expect($('[data-run-cut]')!.textContent).toBe('사건이 많아 앞 2,000 건만 보았습니다. 뒤 지점은 빠졌을 수 있습니다.');
  });
});

describe('Q2 표시만 실행', () => {
  it('results.mode = DISPLAY_ONLY → 「표시만 · 실행 단계 없음」', async () => {
    serve(() => ok(HIST), () => ok({ items: [wp('1', 'RUN_WAYPOINT_RECORDED', local(27, 10, 4), { idx: 0, mission_name: '가', results: { mode: 'DISPLAY_ONLY' } })], next_cursor: null }));
    await render();
    expect(cells()[0][3]).toBe('표시만 · 실행 단계 없음');
  });
});

describe('t19 빈 칸은 줄표 대신 말', () => {
  it('도착 기록이 없는 지점의 구간 걸린 시간 = 「도착 전」', async () => {
    serve(() => ok(HIST), () => ok({ items: [wp('1', 'RUN_WAYPOINT_RECORDED', local(27, 10, 4), { idx: 0, mission_name: '가', results: { mode: 'DISPLAY_ONLY' } })], next_cursor: null }));
    await render();
    expect(cells()[0].slice(1, 3)).toEqual(['도착 기록 없음', '도착 전']);
  });
});

describe('Q3 여는 초점', () => {
  it('열면 초점이 보고서 제목으로', async () => {
    serve(() => ok(HIST), () => ok({ items: [], next_cursor: null }));
    await render();
    const t = document.activeElement as HTMLElement;
    expect(t.hasAttribute('data-run-title')).toBe(true);
    expect(t.textContent).toBe('실행 기록 · 공정 순찰 A');
  });
});

describe('Q4 실행 머리 다시 시도', () => {
  it('머리를 못 받으면 까닭 + 「다시 시도」 → 다시 받아 보임', async () => {
    let fail = true;
    serve(() => (fail ? no(500, '잠시 뒤 다시 시도하세요.') : ok(HIST)), () => ok({ items: [], next_cursor: null }));
    await render();
    expect($('[data-run-head-why]')!.textContent).toContain('잠시 뒤 다시 시도하세요.');
    fail = false;
    act(() => btn('다시 시도')!.click());
    await flush();
    expect(calls.filter((c) => c.path === `/runs/${RUN}/history`)).toHaveLength(2);
    expect($('[data-run-head-why]')).toBeNull();
    expect($('[data-run-status]')!.textContent).toBe('완료');
  });
});

describe('Q5 날 넘긴 실행', () => {
  it('끝이 다른 날이면 끝에도 날짜, 같은 날이면 시각만', async () => {
    serve(() => ok({ ...HIST, started_at: local(27, 23, 50), ended_at: local(28, 0, 20) }), () => ok({ items: [], next_cursor: null }));
    await render();
    expect($('[data-run-span]')!.textContent).toBe('11/27 23:50:00 ~ 11/28 00:20:00');
    act(() => root?.unmount()); root = null; box.remove();
    serve(() => ok(HIST), () => ok({ items: [], next_cursor: null }));
    await render();
    expect($('[data-run-span]')!.textContent).toBe('11/27 10:00:00 ~ 10:31:00');
  });
});
