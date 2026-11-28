// 시뮬 배터리 · 관절 온도: MuJoCo 가 계산한 관절 토크 · 속도를 시뮬 시간으로 적분한 값만 낸다 (고정값 · 시간 비례 감소 없음).
// 상수는 여기 한 곳. 근거:
//   [제원] Unitree Go2 제품 제원 (Air · Pro · X 표준 배터리 8000 mAh, 236.8 Wh · 전압 28~33.6 V).
//          정리본: MAI_UNIVERSE/03_PROJECTS/doyak-final/01_research/go2-hardware.md 2-6 절.
//   [실측] 우리 Go2 X 실기 기록 71 개 파일 (Jetson factory_record · start 기록, 2026-11-22~26,
//          /home/jay/data/overnight-1122/jetson-logs, 약 236 만 줄). 칸: LowState motor_state[i].tau_est · dq · temperature,
//          power_v · power_a. 맞춘 법은 아래 각 상수 옆.

// 배터리. 전력 P = standbyW + mechToElec × Σ|τ·ω| (W), 남은 에너지 E -= P·dt, SoC = 100·E/capacityWh.
export const BATTERY = {
  capacityWh: 236.8, // [제원] 표준 배터리 8000 mAh · 236.8 Wh (X 와 같음, EDU 15000 mAh 는 우리 기체 아님)
  standbyW: 38.8,    // [실측] 서 있고 관절이 멈춘 (max|dq| < 0.1 rad/s, Στ² > 30) 59.6 만 줄의 power_v·power_a 중앙값.
                     //        (엎드려 모터 힘 뺀 때는 9.0 W 이나 시뮬 몸은 늘 정책이 세워 둔다)
  mechToElec: 1.04,  // [실측] 서기 + 걷기 77 만 줄에서 P_elec = P0 + k·Σ|τ·dq| 최소제곱: P0 40.5 W · k 1.04
};

// 관절 모터 1 차 열 모형: dT/dt = heatKps·τ² − (T − 주변) / tauS. 정상 상태 T = 주변 + heatKps·tauS·τ².
// [실측] 같은 기록을 20 s 칸으로 나눠 관절 종류별로 ΔT/Δt = a·mean(τ²) − b·T + c 최소제곱 (2.7 만 표본): heatKps = a, tauS = 1/b.
// 종아리는 감속비가 커 같은 토크에 전류 (발열) 가 작다.
export const THERMAL = {
  hip: { heatKps: 1.0e-3, tauS: 3050 },
  thigh: { heatKps: 6.2e-4, tauS: 2260 },
  calf: { heatKps: 1.57e-4, tauS: 1850 },
};
export const AMBIENT_C = 25; // 주변 온도 기본값 (시뮬 시작 설정)

// MuJoCo 관절 순서 (mobile/sim/sim.js MJ_J: FL · FR · RL · RR × hip · thigh · calf) → 실기 SDK motor_state 순서
// (FR · FL · RR · RL × hip · thigh · calf, 계약 Go2Temperature.joints 와 웹 go2model JOINTS 순서).
const MJ_LEGS = ['FL', 'FR', 'RL', 'RR'], SDK_LEGS = ['FR', 'FL', 'RR', 'RL'];
export const SDK_FROM_MJ = SDK_LEGS.flatMap((leg) => [0, 1, 2].map((part) => MJ_LEGS.indexOf(leg) * 3 + part));
const KIND = ['hip', 'thigh', 'calf'];

export function createVitals({ socStart = 100, ambientC = AMBIENT_C } = {}) {
  if (!(Number.isFinite(socStart) && socStart >= 0 && socStart <= 100)) throw new Error('socStart 0~100');
  if (!(Number.isFinite(ambientC) && ambientC > -40 && ambientC < 80)) throw new Error('ambientC (-40, 80)');
  let energyWh = BATTERY.capacityWh * socStart / 100, powerW = BATTERY.standbyW;
  const temp = new Array(12).fill(ambientC);
  return {
    /** 물리 한 걸음: tau · omega = MuJoCo 순서 12 관절 (N·m · rad/s), dt = 시뮬 초 */
    add(tau, omega, dt) {
      if (!(dt > 0 && dt < 1) || tau?.length !== 12 || omega?.length !== 12) throw new Error('vitals.add 입력 모양');
      let mech = 0;
      for (let i = 0; i < 12; i++) {
        const t = tau[i], w = omega[i];
        if (!Number.isFinite(t) || !Number.isFinite(w)) throw new Error('vitals.add 유한값 아님');
        mech += Math.abs(t * w);
        const p = THERMAL[KIND[i % 3]];
        temp[i] += (p.heatKps * t * t - (temp[i] - ambientC) / p.tauS) * dt;
      }
      powerW = BATTERY.standbyW + BATTERY.mechToElec * mech;
      energyWh = Math.max(0, energyWh - powerW * dt / 3600);
    },
    /** 남은 충전량 % (0~100) */
    soc() { return 100 * energyWh / BATTERY.capacityWh; },
    /** 마지막 물리 걸음의 배터리 전력 (W) */
    powerW() { return powerW; },
    /** 관절 모터 온도 °C, SDK 순서 12 개 */
    jointTempsC() { return SDK_FROM_MJ.map((i) => temp[i]); },
  };
}
