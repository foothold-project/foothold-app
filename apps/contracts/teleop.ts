// 손 조종 입력 → 속도 명령 한 식. 정본 apps/contracts/teleop.py 의 TS 짝 (같은 연산 순서 · tests/test_teleop.py 가 같은 표로 대조).
// 막대 = [전후, 옆, 돌기] -1..1, + 는 전진 · 왼쪽 · 왼쪽으로 돌기. 전후만 제곱 (s·|s|), 옆 · 돌기 직선, |s| < 문턱 이면 0.
// 출처: apps/agent/foothold_agent/policy/lowlevel.py remote_want · apps/agent/runner_cpp/src/core.cpp remote_want (실기 START 리모컨).

export const FORWARD_CURVE = 'square';
export interface TeleopCaps { max_vx: number; max_vx_back: number; max_vy: number; max_wz: number }
export const SIM_CEILING: TeleopCaps = { max_vx: 1.5, max_vx_back: 1.5, max_vy: 0.5, max_wz: 1.2 };
export const REAL_CEILING: TeleopCaps = { max_vx: 1.5, max_vx_back: 1.5, max_vy: 1.0, max_wz: 2.5 };
export const DEFAULT_DEADZONE = 0.1;
export type TeleopKey = 'forward' | 'back' | 'left' | 'right' | 'turn_left' | 'turn_right';
export const KEYMAP: Record<string, TeleopKey> = { KeyW: 'forward', ArrowUp: 'forward', KeyS: 'back', ArrowDown: 'back',
  KeyA: 'turn_left', KeyD: 'turn_right', ArrowLeft: 'left', ArrowRight: 'right' };
export type Stick = [number, number, number];
type Settings = Record<string, unknown> | null | undefined;

const num = (v: unknown, d: number) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d;

/** 조직 설정 실효값 (모델별 덮어쓰기를 합친 값) → 축별 상한. 시뮬 후진 = sim_max_vx. */
export function teleopCaps(settings: Settings, simulation: boolean): TeleopCaps {
  const c = simulation === true ? SIM_CEILING : REAL_CEILING;
  const n: Record<keyof TeleopCaps, string> = simulation === true
    ? { max_vx: 'sim_max_vx', max_vx_back: 'sim_max_vx', max_vy: 'sim_max_vy', max_wz: 'sim_max_wz' }
    : { max_vx: 'real_max_vx', max_vx_back: 'real_max_vx_back', max_vy: 'real_max_vy', max_wz: 'real_max_wz' };
  const pick = (k: keyof TeleopCaps) => Math.min(num(settings?.[n[k]], c[k]), c[k]);
  return { max_vx: pick('max_vx'), max_vx_back: pick('max_vx_back'), max_vy: pick('max_vy'), max_wz: pick('max_wz') };
}

export function deadzone(settings: Settings): number {
  return Math.min(num(settings?.['stick_deadzone'], DEFAULT_DEADZONE), 1.0);
}

function axis(v: unknown, gate: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  const x = Math.min(1.0, Math.max(-1.0, v));
  return Math.abs(x) < gate ? 0 : x;
}

/** 막대 → [vx m/s, vy m/s, wz rad/s]. 키보드 · 화면 조이스틱 · 폰 손잡이 · 리모컨 모두 이 식. */
export function stickVelocity(stick: Stick, caps: TeleopCaps, gate: number): Stick {
  const y = axis(stick[1], gate), t = axis(stick[2], gate);
  let f = axis(stick[0], gate);
  f = f * Math.abs(f);
  const vx = f * (f >= 0 ? caps.max_vx : caps.max_vx_back);
  return [vx + 0, y * caps.max_vy + 0, t * caps.max_wz + 0];
}

/** 누른 키 뜻 → 막대 위치 (화면 조이스틱이 그릴 위치). 전후 키 = 속도 key_vx 가 되는 위치, 옆 · 돌기 키 = 끝. 반대 키를 함께 누르면 0. */
export function keyStick(keys: Iterable<TeleopKey>, caps: TeleopCaps, keyVx: number): Stick {
  const k = new Set(keys), d = (a: TeleopKey, b: TeleopKey) => Number(k.has(a)) - Number(k.has(b));
  const f = d('forward', 'back'), top = f > 0 ? caps.max_vx : caps.max_vx_back;
  const sf = f === 0 || top <= 0 ? 0 : f * Math.sqrt(Math.min(num(keyVx, top), top) / top);
  return [sf + 0, d('left', 'right'), d('turn_left', 'turn_right')];
}
