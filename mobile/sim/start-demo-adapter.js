// m13000 export contract. External models/vectors are never part of the bundle source.
import { MODE_COMMAND_CAPS } from './manual-settings.js';
import { START_KEYBOARD_RAMP } from './keyboard-ramp.js';
import { makeStartDemoMap } from './start-demo-sensors.js';
import { makeStartDepthWorker } from './start-depth-worker-client.js';
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const joints = ['hip', 'thigh', 'calf'].flatMap((p) => ['FL', 'FR', 'RL', 'RR'].map((l) => `${l}_${p}_joint`));
const defaults = Float64Array.of(.1, -.1, .1, -.1, .8, .8, 1, 1, -1.5, -1.5, -1.5, -1.5);
const tensor = (name, dims, type = 'float32') => ({ name, dims, type });
export const START_DEMO_ONNX = {
  file: 'start-m13000_map_on.onnx',
  files: { gt: 'start-m13000_map_on.onnx', reconstruction: 'start-m13000_map_on.onnx', off: 'start-m13000_map_off.onnx' },
  sha256: {
    'start-m13000_map_on.onnx': '4799677acdc9fbc22da28fd56fefa3181f24b38b198e3bea02270c1c1cd11d93',
    'start-m13000_map_off.onnx': '8317548f51a046afb537c212eec47a12b2888b6ea049fa84361d83aa8c30849f',
  },
  inputs: [tensor('obs45', [1,45]), tensor('hist', [1,10,45]), tensor('depth2', [1,2,60,60]),
    tensor('h_prop', [1,128]), tensor('h_terr', [1,128]), tensor('depth_tick', [1], 'bool'),
    tensor('first_after_reset', [1], 'bool'), tensor('use_gt', [1], 'bool'), tensor('gt_map', [1,32,16])],
  outputs: [tensor('action', [1,12]), tensor('h_prop_next', [1,128]), tensor('h_terr_next', [1,128]), tensor('recon_map', [1,32,16])],
  action: 'action', state: [{ out: 'h_prop_next', in: 'h_prop' }, { out: 'h_terr_next', in: 'h_terr' }],
};
export function startDemoTorque(tau, dq, i) {
  const effort = i < 8 ? 23.5 : 45.43, velocity = i < 8 ? 30 : 15.70;
  return clamp(tau, Math.max(-effort, effort * (-1 - dq / velocity)), Math.min(effort, effort * (1 - dq / velocity)));
}
export function startDemoMapMode(mode = 'gt') {
  if (!Object.hasOwn(START_DEMO_ONNX.files, mode)) throw new Error(`알 수 없는 start 지도 모드: ${mode}`);
  return mode;
}
// 시험 벡터 실측 기준, 인계 문서 v0.3 설명과 다름: current first,
// then the previous nine observations. Only the speculative candidate changes.
export function startDemoHistory(previous, obs) {
  const hist = new Float32Array(450);
  if (previous) hist.set(previous.subarray(0,405),45);
  else for (let i = 1; i < 10; i++) hist.set(obs,i*45);
  hist.set(obs);
  return hist;
}
function sensorSample(s, name, sample) {
  // A rejected Worker result retries the same physical state. Raw sensor
  // samples may be reused; observation/history/GRU candidates still commit
  // only in applyAction. Recordings without a simulation clock never cache.
  if (!Number.isFinite(s.t)) return sample();
  const key = [s.t,...s.d.qpos.slice(0,7)], previous = s.startSensorCache;
  if (!previous || !key.every((x,i) => x === previous.key[i])) s.startSensorCache = { key };
  const cache = s.startSensorCache;
  if (cache[name]) return cache[name];
  const value = sample();
  return cache[name] = value?.then ? value.then((frame) => (cache[name] = frame.slice())) : value.slice();
}
export function makeStartDemoMode(makeTerrainSampler) {
  return {
    id: 'start-demo', label: 'start(시연)', statusLabel: 'start', onnx: START_DEMO_ONNX,
    observations: { size: 45, bodySize: 45, mappingSize: 512 },
    action: { size: 12, joints, defaultPose: defaults, scale: .25, kp: 25, kd: .5, torque: startDemoTorque },
    timing: { physicsDt: .005, decimation: 4, policyDt: .02 }, delay: 0,
    command: { kind: 'body_velocity', caps: MODE_COMMAND_CAPS.start, keyboardRamp: START_KEYBOARD_RAMP, inRange: (c) => c.length === 3 && c.every(Number.isFinite) && c[0] >= -1.3 && c[0] <= 1.5 && Math.abs(c[1]) <= .5 && Math.abs(c[2]) <= (c[0] || c[1] ? 1 : 1.2) },
    stop: { input: [0,0,0], pause: false }, fallback: null,
    act(a, out = new Float64Array(12)) {
      for (let i = 0; i < 12; i++) out[i] = defaults[i] + .25 * clamp(a[i], -17, 17);
      return out;
    },
    torque: startDemoTorque,
    reset(mem, s) { Object.assign(mem, { step: 0, hist: null, depth2: null, captured: null, capturePending: false }); if (s) s.startSensorCache = null; },
    makeHeightScanner(mj, m, d) { return makeStartDemoMap(mj, m, d, makeTerrainSampler); },
    makeDepthScanner: makeStartDepthWorker,
    map(s) { s.mapping.set(sensorSample(s,'map',() => s.heightScanner(s.d.qpos,s.mapping))); return s.mapping; },
    depth(s) { return sensorSample(s,'depth',() => s.depthScanner(s.d.qpos)); },
    prepare(s, mem) { if (!mem.depth2) return this.depth(s); },
    observe(s, cmd, mem) {
      const obs = s.observation;
      obs.set(s.angB, 0); obs.set(s.grav, 3); obs.set(cmd, 6);
      for (let i = 0; i < 12; i++) {
        const j = s.M2I[i];
        obs[9+i] = s.d.qpos[7+j] - defaults[i]; obs[21+i] = s.d.qvel[6+j]; obs[33+i] = s.lastAction[i];
      }
      mem.hist = startDemoHistory(mem.hist, obs);
      const tick = mem.step % 5 === 0;
      if (tick) {
        if (!mem.depth2) {
          const frame = this.depth(s).slice();
          mem.depth2 = new Float32Array(7200); mem.depth2.set(frame); mem.depth2.set(frame, 3600); mem.captured = frame;
        }
        // Like hist, the recorded depth pair is newest first: tick 15 = [f10,f5].
        else { mem.depth2.copyWithin(3600, 0, 3600); mem.depth2.set(mem.captured, 0); }
        // f(k) is not consumed until tick k+5. Capture after the Worker result
        // is accepted, still at this observation pose and before any physics.
        // A rejected result therefore neither captures nor advances a frame.
        mem.capturePending = mem.step !== 0;
      }
      const useGt = s.startMapMode === 'gt';
      const map = useGt ? this.map(s) : new Float32Array(512);
      return [obs, mem.hist, mem.depth2, new Float32Array(128), new Float32Array(128), [tick], [mem.step === 0], [useGt], map];
    },
    commit(mem,s) {
      const finish = (frame) => {
        if (frame) mem.captured = frame.slice();
        mem.capturePending = false; mem.step++;
      };
      if (mem.capturePending) {
        const frame = this.depth(s);
        if (frame?.then) return frame.then(finish);
        finish(frame);
      } else finish();
    },
  };
}
