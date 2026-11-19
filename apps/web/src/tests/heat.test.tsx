// 관절 온도 · 배터리 경고 (heat.ts · go2status HeatInfo): 5b 문턱 그대로 · reserve ≠ 0 은 위험 · «잠정» 표시 · 값 없으면 그리지 않음
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import type { Go2MotorTemps } from '../../../contracts/ts';
import { HeatInfo } from '../go2status';
import { batteryLevel, heatOf, jointHeat, minutesTo } from '../heat';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined, box: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); box?.remove(); root = undefined; });
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

it('배터리: 20 % · 10 % 단계와 서 있기 0.7 %/분 남은 분', () => {
  expect([21, 20, 11, 10, 3].map(batteryLevel)).toEqual(['ok', 'low20', 'low20', 'low10', 'low10']);
  expect(minutesTo(27)).toBe(38);        // 27 / 0.7 = 38.5
  expect(minutesTo(27, 10)).toBe(24);    // 17 / 0.7 = 24.2
  expect(minutesTo(5, 10)).toBe(0);
});

it('화면: 최고 관절 · 다리별 12 값 · 잠정 · 남은 분, 값이 없으면 아무것도 그리지 않음', () => {
  const c = [31, 32, 33, 31, 32, 33, 71, 40, 45, 30, 30, 30];
  const el = show(<HeatInfo temps={T(c)} soc={16} />);
  expect(el.querySelector('[data-heat]')!.getAttribute('data-heat')).toBe('danger');
  expect(el.querySelector('[data-heat-worst]')!.textContent).toBe('■위험 · 앉히기 권고 · 최고 RR hip 71 °C');
  expect(el.querySelector('[data-heat-legs]')!.textContent).toBe('FR 31·32·33  FL 31·32·33  RR 71·40·45  RL 30·30·30');
  expect(el.textContent).toContain('잠정 · 업체 열 판정 대기');
  expect(el.querySelector('[data-heat-battery]')!.textContent).toBe('▲20 % 이하 · 충전 준비 서 있기 기준 약 22 분 · 10 % 까지 8 분');
  act(() => root!.render(<HeatInfo temps={null} soc={null} />));
  expect(el.textContent).toBe('');
});
