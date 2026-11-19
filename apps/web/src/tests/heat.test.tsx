// 관절 온도 · 배터리 경고 (heat.ts · go2status HeatInfo): 5b 문턱 그대로 · reserve ≠ 0 은 위험 · «잠정» 표시 · 값 없으면 그리지 않음
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import type { Go2MotorTemps } from '../../../contracts/ts';
import { HeatInfo } from '../go2status';
import { STAND_DRAIN_PCT_PER_MIN, WALK_DRAIN_PCT_PER_MIN, batteryLevel, heatOf, jointHeat, legOutliers, minutesTo } from '../heat';
import { rt } from '../rt';
import { FakeWS, state } from './fakeWs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined, box: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); box?.remove(); root = undefined; rt.disconnect(); });
const show = (el: JSX.Element) => { box = document.createElement('div'); document.body.append(box); root = createRoot(box); act(() => root!.render(el)); return box; };

const NAMES = ['FR', 'FL', 'RR', 'RL'].flatMap((l) => ['hip', 'thigh', 'calf'].map((p) => `${l}_${p}_joint`)) as Go2MotorTemps['names'];
const T = (celsius: number[], reserve: boolean[] | null = Array(12).fill(false)): Go2MotorTemps => ({ received_at: '2026-11-19T00:00:00Z', age_s: 0, names: NAMES, celsius, reserve_nonzero: reserve });

it('문턱: 49 정상 · 50 주의 · 60 경고 · 70 위험 · reserve 는 온도와 상관없이 위험', () => {
  expect([49.9, 50, 59, 60, 69, 70].map((c) => jointHeat(c, false))).toEqual(['ok', 'caution', 'caution', 'warn', 'warn', 'danger']);
  expect(jointHeat(31, true)).toBe('danger');
  expect(jointHeat(31, null)).toBe('ok');
});

it('11/19 01:27 사건 꼴: RR hip 71 °C → 위험, 가장 나쁜 관절 RR hip', () => {
  const c = Array(12).fill(35); c[6] = 71;
  expect(heatOf(T(c)).worst).toMatchObject({ name: 'RR_hip_joint', c: 71, heat: 'danger' });
  const r = Array(12).fill(false); r[0] = true;   // 보호 신호가 더 뜨거운 관절보다 앞선다
  const c2 = Array(12).fill(35); c2[5] = 65;
  expect(heatOf(T(c2, r)).worst.name).toBe('FR_hip_joint');
});

it('배터리: 20 % · 10 % 단계와 서 있기 0.55 · 걷기 0.86 %/분 남은 분', () => {
  expect([21, 20, 11, 10, 3].map(batteryLevel)).toEqual(['ok', 'low20', 'low20', 'low10', 'low10']);
  expect([STAND_DRAIN_PCT_PER_MIN, WALK_DRAIN_PCT_PER_MIN]).toEqual([0.55, 0.86]);   // (93-82)/20 · (27-21)/7
  expect(minutesTo(27)).toBe(49);        // 27 / 0.55 = 49.1 (서 있기)
  expect(minutesTo(27, 10)).toBe(30);    // 17 / 0.55 = 30.9
  expect(minutesTo(27, 0, WALK_DRAIN_PCT_PER_MIN)).toBe(31);    // 27 / 0.86 = 31.4 (걷기)
  expect(minutesTo(27, 10, WALK_DRAIN_PCT_PER_MIN)).toBe(19);   // 17 / 0.86 = 19.8
  expect(minutesTo(5, 10)).toBe(0);
});

it('화면: 최고 관절 · 다리별 12 값 · 잠정 · 남은 분, 값이 없으면 아무것도 그리지 않음', () => {
  const c = [31, 32, 33, 31, 32, 33, 71, 40, 45, 30, 30, 30];
  const el = show(<HeatInfo temps={T(c)} soc={16} />);
  expect(el.querySelector('[data-heat]')!.getAttribute('data-heat')).toBe('danger');
  expect(el.querySelector('[data-heat-worst]')!.textContent).toBe('■위험 · 앉히기 권고 · 최고 RR hip 71 °C');
  expect(el.querySelector('[data-heat-legs]')!.textContent).toBe('FR 31·32·33  FL 31·32·33  RR 71·40·45  RL 30·30·30');
  expect(el.textContent).toContain('잠정 · 업체 열 판정 대기');
  expect(el.querySelector('[data-heat-battery]')!.textContent).toBe('▲20 % 이하 · 충전 준비 서 있기 약 29 분 · 걸으면 약 18 분 · 10 % 까지 10 · 6 분');
  act(() => root!.render(<HeatInfo temps={null} soc={null} />));
  expect(el.textContent).toBe('');
});

it('이상 체크 (같은 다리): 다른 두 관절보다 15 °C 넘게 높을 때만 · 15 딱은 아님', () => {
  const c = [31, 32, 33, 31, 32, 33, 71, 40, 45, 30, 30, 30];
  expect(legOutliers(heatOf(T(c)).joints).map((j) => j.name)).toEqual(['RR_hip_joint']);
  const el = show(<HeatInfo temps={T(c)} soc={null} />);
  expect(el.querySelector('[data-heat-gap]')!.textContent).toBe('▲같은 다리보다 15 °C 넘게 높음 · RR hip');
  const d = [31, 32, 33, 31, 32, 33, 60, 45, 40, 30, 30, 30];   // 60 - 45 = 15, 넘지 않음
  expect(legOutliers(heatOf(T(d)).joints)).toEqual([]);
  act(() => root!.render(<HeatInfo temps={T(d)} soc={null} />));
  expect(el.querySelector('[data-heat-gap]')).toBeNull();
});

it('실시간: 자세·배터리는 그대로 두고 온도 · reserve 만 바뀌어도 다시 그린다', () => {
  rt.connect(['r']);
  const w = FakeWS.last; w.open();
  const ri = (c: number[], r = Array(12).fill(false)) => ({ source: 'GO2_DDS' as const, attitude: { roll: 0, pitch: 0 }, error_code: 0, fallen: false,
    fallen_source: 'imu_tilt_estimate' as const, motor_temps: T(c, r) });
  const base = Array(12).fill(35);
  w.recv(state('r', { robot_info: ri(base) }));
  let n = 0; const off = rt.subscribe(() => { n += 1; });
  w.recv(state('r', { robot_info: ri(base) }));
  expect(n).toBe(0);                                   // 같은 값이면 그리지 않음 (10 Hz 그대로 그리지 않는 원래 동작)
  const hot = [...base]; hot[6] = 71;
  w.recv(state('r', { robot_info: ri(hot) }));
  expect(n).toBe(1);
  expect(rt.get('r').state?.robot_info?.motor_temps?.celsius[6]).toBe(71);
  const r = Array(12).fill(false); r[6] = true;
  w.recv(state('r', { robot_info: ri(hot, r) }));
  expect(n).toBe(2);                                   // reserve 만 바뀜
  off();
});
