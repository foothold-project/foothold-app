// 폰 임무 공용 부품(시안 u1_1 · u1_11 · app-lead 11-28 22:40): state.run 하나로 판정 · 칩 글 · 막대 · 카드 이름. 단추 없음.
// 카드 이름 · 「오늘 n / m」 · 「예정 끝」 은 오늘 일정(GET /schedule)의 run_id 같은 칸과 그 시나리오 판(GET /scenarios/{id}?version=). 남은 거리는 서버 값이 없어 비움
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Location, MapVersion, RunSnapshot, Scenario, ScheduleDay, ScheduleSlot } from '../../../contracts/ts';
import { api } from '../api';
import { MissionCard, MissionMap, NextCard, missionChip, missionOn, useMission } from '../screens/u1mission';
import u1AppCss from '../screens/u1.app.css?raw';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const run = (status: RunSnapshot['status'], step = 1, done = 1, total = 4, wait_reason: RunSnapshot['wait_reason'] = null): RunSnapshot =>
  ({ run_id: 'run-2', status, step, progress: { done, total } as RunSnapshot['progress'], wait_reason, fail_code: null });
const slot = (id: string, start: string, end: string, run_id: string | null, scenario_id = 'sc-a', robot_id = 'r1'): ScheduleSlot =>
  ({ id, robot_id, scenario_id, scenario_version: 3, gait: null, start, end, kind: 'CONFIRMED', assignment_id: null, memo: '', created_by: 'u', created_at: start, run_state: null, run_id, run_code: null, confirmed_by: null });
const at = (h: number, m: number) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.toISOString(); };
const DAY = { slots: [
  slot('s3', at(14, 40), at(15, 5), null, 'sc-b'),
  slot('s1', at(9, 0), at(9, 30), 'run-1'),
  slot('s2', at(13, 50), at(14, 27), 'run-2'),
  slot('s4', at(16, 0), at(16, 30), null, 'sc-b'),
  slot('x1', at(10, 0), at(10, 30), 'run-9', 'sc-a', 'r2'),   // 다른 로봇 칸은 세지 않음
] } as unknown as ScheduleDay;
const wp = (name: string, x: number, y: number, map_version_id = 'mv-new-7') => ({ floor_id: 'f1', map_version_id, x, y, mission_id: 'm', mission_version: 1, name });
const SC = { id: 'sc-a', name: '공정 순찰 A', version: 3, map_version_ids: ['mv-new-7'], waypoints: [wp('입구', 1, 1), wp('게이지 읽기', 2, 1), wp('밸브', 2, 3), wp('복귀', 1, 3)] } as unknown as Scenario;
const SCB = { id: 'sc-b', name: '밸브 점검 B', version: 3, map_version_ids: ['mv-new-7'], waypoints: [wp('a', 0, 0), wp('b', 0, 0), wp('c', 0, 0), wp('d', 0, 0)] } as unknown as Scenario;
// 판 그림: 200 × 100 px · 0.1 m/px · 원점 (0, 0) — (x, y) m → (10x, 100 - 10y) px
const MV = { id: 'mv-new-7', width: 200, height: 100, resolution: 0.1, origin: [0, 0, 0] } as unknown as MapVersion;

let root: Root | null = null, box: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); vi.restoreAllMocks(); });
const $ = (s: string) => box.querySelector(s);
/** 쓰는 화면과 같은 꼴: 한 번 받은 일정 · 시나리오(useMission)를 카드와 지도가 같이 쓴다 */
function Both({ run, pose }: { run: RunSnapshot; pose?: Location | null }) {
  const m = useMission('r1', run.run_id);
  return <><MissionMap m={m} run={run} pose={pose} /><MissionCard m={m} run={run} /></>;
}
function apis(day: ScheduleDay | null = DAY, mv: MapVersion | null = MV) {
  const sch = vi.spyOn(api, 'schedule').mockImplementation(() => (day ? Promise.resolve(day) : Promise.reject(new Error('x'))) as never);
  const plan = vi.spyOn(api, 'plan').mockImplementation(((_k: string, id: string) => Promise.resolve(id === 'sc-b' ? SCB : SC)) as never);
  const ver = vi.spyOn(api, 'version').mockImplementation(() => (mv ? Promise.resolve(mv) : Promise.reject(new Error('x'))) as never);
  return { sch, plan, ver };
}
async function show(el: JSX.Element) {
  box = document.createElement('div'); document.body.append(box);
  await act(async () => { root = createRoot(box); root.render(el); });
}
async function mount(r: RunSnapshot, day: ScheduleDay | null = DAY, pose: Location | null = null, mv: MapVersion | null = MV) {
  const a = apis(day, mv);
  await show(<Both run={r} pose={pose} />);
  return a;
}

describe('판정 · 칩 글', () => {
  it('끝나지 않은 run 만 임무 화면', () => {
    expect(missionOn(null)).toBe(false);
    expect(missionOn(undefined)).toBe(false);
    for (const s of ['COMPLETED', 'FAILED', 'CANCELED'] as const) expect(missionOn(run(s))).toBe(false);
    for (const s of ['QUEUED', 'PREPARING', 'MOVING', 'AT_WAYPOINT', 'PERFORMING', 'WAIT_CONFIRM', 'PAUSED'] as const) expect(missionOn(run(s))).toBe(true);
  });
  it('시안 u1_1 「순찰 중」 · u1_11 「일시정지됨」', () => {
    for (const s of ['MOVING', 'AT_WAYPOINT', 'PERFORMING'] as const) expect(missionChip(run(s))).toEqual({ tone: 'ok', text: '순찰 중' });
    expect(missionChip(run('PAUSED'))).toEqual({ tone: 'warn', text: '일시정지됨' });
    expect(missionChip(run('QUEUED')).text).toBe('준비 중');
    expect(missionChip(run('PREPARING')).text).toBe('준비 중');
    expect(missionChip(run('WAIT_CONFIRM'))).toEqual({ tone: 'warn', text: '확인 기다림' });
  });
});

describe('임무 카드', () => {
  it('막대: 지점 수만큼 칸 · 끝난 칸만 채움', async () => {
    await mount(run('MOVING', 1, 1, 4));
    const bars = [...box.querySelectorAll('.u1-mission .mb i')];
    expect(bars).toHaveLength(4);
    expect(bars.map((b) => b.classList.contains('on'))).toEqual([true, false, false, false]);
  });

  it('이름 · 오늘 몇째 · 예정 끝(일정 칸 end) · 지금 지점 이름 — 남은 거리는 없음', async () => {
    const { sch, plan } = await mount(run('MOVING', 1, 1, 4));
    expect(sch).toHaveBeenCalledTimes(1);
    expect(plan).toHaveBeenCalledWith('scenarios', 'sc-a', 3, expect.anything());
    expect($('.u1-mission .mn')!.textContent).toBe('오늘 2 / 4');
    expect($('.u1-mission b')!.textContent).toBe('공정 순찰 A');
    expect($('.u1-mission .me')!.textContent).toBe('예정 끝 14:27');
    expect($('.u1-mission .ml')!.textContent).toBe('2 / 4 게이지 읽기');
    expect(box.textContent).not.toMatch(/m 남음|예상 끝/);
    expect(box.querySelector('button')).toBeNull();   // 단추 없음(서버 로봇 일시정지는 app-lx 계약 뒤)
  });

  it('일시정지(u1_11): 아래 줄은 멈춘 자리 · 노란 글', async () => {
    await mount(run('PAUSED', 1, 1, 4, 'STOPPED_BY_USER'));
    const ml = $('.u1-mission .ml')!;
    expect(ml.textContent).toBe('게이지 읽기 가기 전에 서 있음');
    expect(ml.classList.contains('pz')).toBe(true);
  });

  it('일정을 못 받거나 run_id 칸이 없으면 이름 칸은 「임무」 · 오늘 · 예정 끝 비움, 지점은 번호만', async () => {
    await mount(run('MOVING', 2, 2, 3), null);
    expect($('.u1-mission b')!.textContent).toBe('임무');
    expect($('.u1-mission .mn')).toBeNull();
    expect($('.u1-mission .me')).toBeNull();
    expect($('.u1-mission .ml')!.textContent).toBe('3 / 3');
  });

  it('지점 수 0(계획 전)이면 막대 없음 · 준비 중', async () => {
    await mount(run('PREPARING', 0, 0, 0));
    expect(box.querySelectorAll('.u1-mission .mb i')).toHaveLength(0);
    expect($('.u1-mission .ml')!.textContent).toBe('준비 중');
  });

  it('CSS: 시안 u1_1 카드 자리(왼쪽 아래 12px · 폭 300) · 막대 5px', () => {
    expect(u1AppCss).toMatch(/\.u1d \.u1-mission\{position:absolute;left:12px;bottom:12px;width:300px;padding:10px 14px 9px;border-radius:18px/);
    expect(u1AppCss).toMatch(/\.u1d \.u1-mission \.mb i\{flex:1;height:5px;border-radius:3px/);
  });
});

describe('바탕 2D 지도 · 경로(시안 u1_1 · 판은 run 의 시나리오에서 · id 박지 않음)', () => {
  const pose = (map_version_id: string) => ({ floor_id: 'f1', map_version_id, x: 1.5, y: 1, yaw: 0, confidence: 1, updated_at: new Date().toISOString() }) as Location;

  it('판 그림 · 경로 선 · 지금 지점 번호표 · 로봇 점', async () => {
    const { ver } = await mount(run('MOVING', 1, 1, 4), DAY, pose('mv-new-7'));
    expect(ver).toHaveBeenCalledTimes(1);
    expect(ver.mock.calls[0][0]).toBe('mv-new-7');                     // 시나리오 판에서 받은 id
    const svg = $('svg.u1-mmap')!;
    expect(svg.getAttribute('viewBox')).toBe('0 0 200 100');
    expect(svg.querySelector('image')!.getAttribute('href')).toBe(api.imageUrl('mv-new-7'));
    expect(svg.querySelector('polyline.rt')!.getAttribute('points')).toBe('10,90 20,90 20,70 10,70');
    expect(svg.querySelector('polyline.rt.done')!.getAttribute('points')).toBe('10,90 20,90');   // 지난 길(지금 지점까지)
    expect(svg.querySelectorAll('circle.wp')).toHaveLength(4);
    expect(svg.querySelector('[data-wp-now]')!.textContent).toBe('2게이지 읽기');
    const me = svg.querySelector('circle.me')!;
    expect([me.getAttribute('cx'), me.getAttribute('cy')]).toEqual(['15', '90']);
  });

  it('로봇이 다른 판에 있으면 로봇 점 없음 · 판을 못 받으면 지도 없음(카드는 그대로)', async () => {
    await mount(run('MOVING', 1, 1, 4), DAY, pose('mv-other'));
    expect($('svg.u1-mmap')).not.toBeNull();
    expect($('svg.u1-mmap circle.me')).toBeNull();
    act(() => root?.unmount()); root = null; box.remove(); vi.restoreAllMocks();
    await mount(run('MOVING', 1, 1, 4), DAY, null, null);
    expect($('svg.u1-mmap')).toBeNull();
    expect($('.u1-mission b')!.textContent).toBe('공정 순찰 A');
  });

  it('일정을 못 받으면 지도도 없음', async () => {
    const { ver } = await mount(run('MOVING', 1, 1, 4), null);
    expect(ver).not.toHaveBeenCalled();
    expect($('svg.u1-mmap')).toBeNull();
  });

  it('CSS: 지도는 화면 전체 바탕 · 손가락을 막지 않음', () => {
    expect(u1AppCss).toMatch(/\.u1d \.u1-mmap\{position:absolute;inset:0;width:100%;height:100%;[^}]*pointer-events:none/);
  });
});

describe('다음 일 카드(시안 u1_15)', () => {
  const later = (min: number) => new Date(Date.now() + min * 60000).toISOString();
  const day = (slots: ScheduleSlot[]) => ({ slots }) as unknown as ScheduleDay;

  it('지금 뒤 첫 칸: 다음 n / m · 이름 · 시작 · 지점 수 · 약 분 · 빈 막대', async () => {
    const st = later(30), d = new Date(st), hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    apis(day([slot('a', later(-120), later(-90), 'run-1'), slot('b', later(-60), later(-30), 'run-2'), slot('c', st, later(55), null, 'sc-b'), slot('d', later(90), later(120), null, 'sc-b')]));
    await show(<NextCard robot="r1" />);
    expect($('.u1-mission .mn')!.textContent).toBe('다음 3 / 4');
    expect($('.u1-mission b')!.textContent).toBe('밸브 점검 B');
    expect($('.u1-mission .me')!.textContent).toBe(`${hm} 시작`);
    expect($('.u1-mission .ml')!.textContent).toBe('지점 4 곳 · 약 25 분');
    expect([...box.querySelectorAll('.u1-mission .mb i')].map((i) => i.classList.contains('on'))).toEqual([false, false, false, false]);
    expect(box.querySelector('button')).toBeNull();
  });

  it('남은 칸이 없으면 카드 없음 · 배터리 교체 칸은 세지 않음', async () => {
    const swap = { ...slot('s', later(10), later(20), null), kind: 'BATTERY_SWAP' as const, scenario_id: null };
    apis(day([slot('a', later(-60), later(-30), 'run-1'), swap]));
    await show(<NextCard robot="r1" />);
    expect($('.u1-mission')).toBeNull();
  });
});
