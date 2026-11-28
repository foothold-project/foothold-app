// 시뮬 배터리 · 관절 온도 모형 (vitals.mjs). 물리 없이 토크 · 속도 입력만으로 잰다. FH_SIM_SRC 필요 없음.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BATTERY, THERMAL, SDK_FROM_MJ, POWER_WINDOW_S, createVitals } from '../vitals.mjs';

const DT = 0.005; // 시뮬 물리 주기 (start 정책 200 Hz)
const STAND_TAU = [0.1, 0.8, -4.5, -0.1, 0.8, -4.5, 0.1, 1.0, -4.5, -0.1, 1.0, -4.5]; // 서 있을 때 실기 tau_est 크기 (N·m)
const zeros = () => new Array(12).fill(0);
function run(v, seconds, tau, dq) { for (let k = 0, n = Math.round(seconds / DT); k < n; k++) v.add(tau(k), dq(k), DT); }

test('서 있기만 (관절 속도 0) 하면 SoC 는 대기 전력만큼만 준다', () => {
  const v = createVitals({ socStart: 100 });
  run(v, 600, () => STAND_TAU, zeros);
  const expected = 100 - 100 * BATTERY.standbyW * 600 / 3600 / BATTERY.capacityWh;
  assert.ok(Math.abs(v.soc() - expected) < 1e-9, `${v.soc()} vs ${expected}`);
});

test('걸으면 (토크 × 속도 일) 서 있을 때보다 더 준다', () => {
  const stand = createVitals({ socStart: 100 }), walk = createVitals({ socStart: 100 });
  run(stand, 600, () => STAND_TAU, zeros);
  // 트롯 비슷한 2 Hz 관절 흔들림: 실기 걷기 로그의 기계 일률 중앙값 (약 50 W) 과 같은 자리
  const tauW = (k) => STAND_TAU.map((t, i) => t + 6 * Math.sin(2 * Math.PI * 2 * k * DT + i));
  const dqW = (k) => STAND_TAU.map((_, i) => 3 * Math.cos(2 * Math.PI * 2 * k * DT + i));
  run(walk, 600, tauW, dqW);
  assert.ok(walk.soc() < stand.soc() - 1, `걷기 ${walk.soc()} · 서기 ${stand.soc()}`);
  assert.ok(walk.powerW() > BATTERY.standbyW);
});

test('시작 SoC 는 설정값 · 0~100 안 · 다 쓰면 0 에서 멈춤', () => {
  assert.equal(createVitals({ socStart: 72 }).soc(), 72);
  const v = createVitals({ socStart: 1 });
  run(v, 3600, () => STAND_TAU, zeros);
  assert.equal(v.soc(), 0);
  assert.throws(() => createVitals({ socStart: 101 }));
  assert.throws(() => createVitals({ socStart: -1 }));
});

test('토크 0 이면 관절 온도는 주변 온도로 수렴한다', () => {
  const v = createVitals({ ambientC: 25 });
  run(v, 1800, () => STAND_TAU.map((t) => t * 4), zeros); // 데운다
  const hot = v.jointTempsC();
  assert.ok(Math.max(...hot) > 30, `데워짐 ${Math.max(...hot)}`);
  run(v, 8 * 3600, zeros, zeros);
  for (const c of v.jointTempsC()) assert.ok(Math.abs(c - 25) < 0.05, `식음 ${c}`);
});

test('토크가 일정하면 온도는 주변 + 발열 × 시정수 × τ² 로 간다 (1 차 모형)', () => {
  const v = createVitals({ ambientC: 20 });
  const tau = new Array(12).fill(3);
  run(v, 10 * 3600, () => tau, zeros); // 시정수 (최대 약 3000 s) 의 열 배 넘게
  const t = v.jointTempsC();
  for (let i = 0; i < 12; i++) {
    const p = THERMAL[['hip', 'thigh', 'calf'][i % 3]];
    const sdk = SDK_FROM_MJ.indexOf(i);
    assert.ok(Math.abs(t[sdk] - (20 + p.heatKps * p.tauS * 9)) < 0.05, `관절 ${i}: ${t[sdk]}`);
  }
});

test('관절 온도는 SDK 순서 (FR · FL · RR · RL × 엉덩이 · 허벅지 · 종아리) 로 낸다', () => {
  const v = createVitals({ ambientC: 25 });
  const tau = zeros(); tau[0] = 10; // MuJoCo 순서 0 = FL 엉덩이
  run(v, 600, () => tau, zeros);
  const t = v.jointTempsC();
  assert.equal(t.length, 12);
  assert.ok(t[3] > 26, `SDK 3 = FL 엉덩이 ${t[3]}`);
  for (let i = 0; i < 12; i++) if (i !== 3) assert.equal(t[i], 25);
});

test('같은 입력이면 같은 출력 (결정적)', () => {
  const go = () => { const v = createVitals({ socStart: 90, ambientC: 22 });
    run(v, 120, (k) => STAND_TAU.map((t, i) => t + Math.sin(k * 0.01 + i)), (k) => STAND_TAU.map((_, i) => Math.cos(k * 0.013 + i)));
    return [v.soc(), ...v.jointTempsC()]; };
  assert.deepEqual(go(), go());
});

test('유한하지 않은 토크 · 속도 입력은 거부한다 (값을 지어내지 않음)', () => {
  const v = createVitals({});
  const bad = zeros(); bad[2] = NaN;
  assert.throws(() => v.add(bad, zeros(), DT));
  assert.throws(() => v.add(zeros(), zeros(), 0));
  assert.throws(() => v.add(zeros().slice(1), zeros(), DT));
});

test('남은 분: 물리 걸음 전에는 모름 (null) · 서 있기만 하면 남은 에너지 ÷ 대기 전력', () => {
  const v = createVitals({ socStart: 80 });
  assert.equal(v.minutesLeft(), null);
  run(v, 600, () => STAND_TAU, zeros);
  const wh = BATTERY.capacityWh * v.soc() / 100;
  assert.equal(v.minutesLeft(), Math.floor(wh / BATTERY.standbyW * 60));
  assert.ok(Number.isInteger(v.minutesLeft()));
});

test('남은 분: 걷다 서면 최근 평균 전력 창 (지수 평균 시정수) 을 따라 늘어난다', () => {
  const v = createVitals({ socStart: 100 });
  const tauW = (k) => STAND_TAU.map((t, i) => t + 6 * Math.sin(2 * Math.PI * 2 * k * DT + i));
  const dqW = (k) => STAND_TAU.map((_, i) => 3 * Math.cos(2 * Math.PI * 2 * k * DT + i));
  run(v, 300, tauW, dqW);
  const walking = v.minutesLeft();
  run(v, POWER_WINDOW_S, () => STAND_TAU, zeros);
  const oneWindow = v.minutesLeft();
  run(v, 6 * POWER_WINDOW_S, () => STAND_TAU, zeros);
  const settled = v.minutesLeft(), standOnly = Math.floor(BATTERY.capacityWh * v.soc() / 100 / BATTERY.standbyW * 60);
  assert.ok(walking < oneWindow && oneWindow < settled, `${walking} < ${oneWindow} < ${settled}`);
  assert.ok(Math.abs(settled - standOnly) <= 1, `${settled} vs ${standOnly}`);
});

test('남은 분: 다 쓰면 0', () => {
  const v = createVitals({ socStart: 1 });
  run(v, 3600, () => STAND_TAU, zeros);
  assert.equal(v.minutesLeft(), 0);
});
