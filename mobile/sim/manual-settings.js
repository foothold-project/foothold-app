// Same per-field and cross-field validation as web phone.simTune (#241).
// These are MuJoCo command axes, not real robot limits or AME-2 body speed.
const TUNE = { sim_max_vx: [0.2, 1], sim_min_vx: [0, 0.5], sim_max_vy: [0, 0.3], sim_max_wz: [0, 0.5], sim_key_vx: [0.1, 1], stick_deadzone: [0, 0.5] };
export function manualSettings(org, scale) {
  const tune = {};
  for (const [key, [lo, hi]] of Object.entries(TUNE)) {
    const v = org?.[key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi) tune[key] = v;
  }
  if (tune.sim_max_vx != null) {
    if (tune.sim_min_vx > tune.sim_max_vx) delete tune.sim_min_vx;
    if (tune.sim_key_vx > tune.sim_max_vx) delete tune.sim_key_vx;
  }
  const caps = scale.map((value, i) => Math.min(value, tune[['sim_max_vx', 'sim_max_vy', 'sim_max_wz'][i]] ?? value));
  return { caps, key: Math.min(caps[0], tune.sim_key_vx ?? caps[0]), dead: tune.stick_deadzone ?? 0 };
}
export function manualAxis(value, axis, settings, keyboard = false) {
  const magnitude = Math.abs(value), dead = keyboard ? 0 : settings.dead;
  if (magnitude <= dead) return 0;
  return Math.sign(value) * Math.min(1, (magnitude - dead) / (1 - dead)) * (keyboard && axis === 0 ? settings.key : settings.caps[axis]);
}
