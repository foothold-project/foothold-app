// MuJoCo command limits only; real robot limits remain with the agent.
const TUNE = { sim_max_vx: [0.2, 1.5], sim_min_vx: [0, 0.5], sim_max_vy: [0, 0.5], sim_max_wz: [0, 1.2], sim_key_vx: [0.1, 1.5], stick_deadzone: [0, 0.5] };
// Handoff §1.5. start is prepared data only, registered in the mode task.
// NVIDIA reverse deliberately preserves the old symmetric joystick envelope;
// negative vx and nonzero lateral commands are outside its training range.
export const MODE_COMMAND_CAPS = Object.freeze({
  nvidia: Object.freeze({ forward: 1.5, reverse: 1.5, lateral: 0.5, turnInPlace: 1, turnWalking: 1 }),
  start: Object.freeze({ forward: 1.5, reverse: 1, lateral: 0.5, turnInPlace: 1.2, turnWalking: 1 }),
});
export function commandCaps(command) {
  if (command.caps) return { ...command.caps };
  const [forward, lateral, turn] = command.joystickScale;
  return { forward, reverse: forward, lateral, turnInPlace: turn, turnWalking: turn };
}
export function modeCapText(command) {
  if (command.kind === 'nearby_goal') return '이 모드 상한 · 목표 2 m · 정책 속도 ≤1.2 m/s';
  const c = commandCaps(command);
  return `이 모드 상한 · 앞${c.forward} 뒤${c.reverse} 옆${c.lateral} m/s · 회전${c.turnInPlace}/이동${c.turnWalking} rad/s`;
}
export function manualSettings(org, command) {
  // Retain array callers while modes migrate to command.caps (five directions).
  const legacy = Array.isArray(command), spec = legacy ? { joystickScale: command } : command;
  const goal = spec.kind === 'nearby_goal', tune = {};
  for (const [key, [lo, hi]] of Object.entries(TUNE)) {
    const v = org?.[key];
    // Goal sticks are target ratios/heading rate, not organization body speeds.
    if (goal && key !== 'stick_deadzone') continue;
    if (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi) tune[key] = v;
  }
  if (tune.sim_max_vx != null) {
    if (tune.sim_min_vx > tune.sim_max_vx) delete tune.sim_min_vx;
    if (tune.sim_key_vx > tune.sim_max_vx) delete tune.sim_key_vx;
  }
  const mode = commandCaps(spec), min = (value, key) => Math.min(value, tune[key] ?? value);
  const directions = {
    forward: min(mode.forward, 'sim_max_vx'), reverse: min(mode.reverse, 'sim_max_vx'),
    lateral: min(mode.lateral, 'sim_max_vy'), turnInPlace: min(mode.turnInPlace, 'sim_max_wz'), turnWalking: min(mode.turnWalking, 'sim_max_wz'),
  };
  return { caps: [directions.forward, directions.lateral, directions.turnInPlace],
    key: Math.min(directions.forward, tune.sim_key_vx ?? directions.forward), dead: tune.stick_deadzone ?? 0,
    ...(!legacy && { directions }) };
}
export function manualAxis(value, axis, settings, keyboard = false, moving = false) {
  const magnitude = Math.abs(value), dead = keyboard ? 0 : settings.dead;
  if (magnitude <= dead) return 0;
  const d = settings.directions;
  const cap = !d ? settings.caps[axis] : axis === 0 ? (value < 0 ? d.reverse : d.forward)
    : axis === 1 ? d.lateral : moving ? d.turnWalking : d.turnInPlace;
  const limit = keyboard && axis === 0 ? Math.min(cap, settings.key) : cap;
  return Math.sign(value) * Math.min(1, (magnitude - dead) / (1 - dead)) * limit;
}
// Recompute turn when translation changes, even while the right stick is held.
export function manualCommand(axes, settings, keyboard = false) {
  const vx = manualAxis(axes[0], 0, settings, keyboard), vy = manualAxis(axes[1], 1, settings, keyboard);
  return [vx, vy, manualAxis(axes[2], 2, settings, keyboard, vx !== 0 || vy !== 0)];
}
