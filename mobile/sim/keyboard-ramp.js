// ponytail: seconds from zero to full translation/turn, and full command to rest.
export const START_KEYBOARD_RAMP = Object.freeze({ translation: 1, turn: 0.5, release: 0.4 });

// Normalized keyboard axes only; manualCommand still owns units and mode caps.
export function createKeyboardRamp(config) {
  const value = [0, 0, 0], target = [0, 0, 0];
  const approach = (from, to, distance) => from + Math.sign(to - from) * Math.min(Math.abs(to - from), distance);
  return {
    enabled: !!config,
    target(axes) { target.splice(0, 3, ...axes); return config ? value.slice() : target.slice(); },
    reset() { value.fill(0); target.fill(0); },
    advance(dt) {
      if (!config) return target.slice();
      for (let i = 0; i < 3; i++) {
        let remaining = Math.max(0, dt);
        // Opposite keys brake through zero before accelerating the other way.
        if (value[i] * target[i] < 0) {
          const braking = Math.min(remaining, Math.abs(value[i]) * config.release);
          value[i] = approach(value[i], 0, braking / config.release);
          remaining -= braking;
        }
        const seconds = Math.abs(target[i]) < Math.abs(value[i]) ? config.release : i === 2 ? config.turn : config.translation;
        value[i] = approach(value[i], target[i], remaining / seconds);
        if (Math.abs(value[i]) < 1e-10) value[i] = 0;
      }
      return value.slice();
    },
  };
}
