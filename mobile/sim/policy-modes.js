// Stable mode keys survive model id changes. Unsupported capabilities are null.
import { createPolicyModeAdapters } from './policy-adapters.js';
import { makeTerrainSampler } from './policy-adapters.js';
import { makeStartDemoMode } from './start-demo-adapter.js';
export { makeTerrainSampler } from './policy-adapters.js';

const required = ['id', 'label', 'onnx', 'observe', 'map', 'depth', 'command', 'act', 'torque', 'timing', 'delay', 'stop', 'reset', 'fallback'];
export function registerPolicyModes(modes) {
  const ids = new Set();
  for (const [key, mode] of Object.entries(modes)) {
    for (const field of required) {
      if (!mode || !Object.hasOwn(mode, field) || mode[field] === undefined) throw new Error(`정책 모드 ${key}: ${field} 없음`);
    }
    if (!mode.id || !mode.label || ids.has(mode.id)) throw new Error(`정책 모드 ${key}: 이름 오류/중복`);
    ids.add(mode.id);
    for (const field of ['observe', 'map', 'act', 'torque', 'reset']) {
      if (typeof mode[field] !== 'function') throw new Error(`정책 모드 ${key}: ${field} 함수 필요`);
    }
    if (mode.depth !== null && typeof mode.depth !== 'function') throw new Error(`정책 모드 ${key}: depth 오류`);
    if (!['body_velocity', 'nearby_goal'].includes(mode.command?.kind) || !mode.command.caps || typeof mode.command.inRange !== 'function') throw new Error(`정책 모드 ${key}: command 오류`);
    for (const axis of ['forward', 'reverse', 'lateral', 'turnInPlace', 'turnWalking']) {
      if (!Number.isFinite(mode.command.caps[axis]) || mode.command.caps[axis] < 0) throw new Error(`정책 모드 ${key}: command.caps.${axis} 없음`);
    }
    if (!mode.timing || !mode.stop || (mode.onnx !== null && (!mode.onnx.files || !mode.onnx.sha256 || !Array.isArray(mode.onnx.inputs) || !Array.isArray(mode.onnx.outputs) || !mode.onnx.action || !Array.isArray(mode.onnx.state)))) throw new Error(`정책 모드 ${key}: 계약 오류`);
    if (mode.onnx !== null) {
      for (const file of Object.values(mode.onnx.files)) {
        if (typeof file !== 'string' || !/^[a-f0-9]{64}$/.test(mode.onnx.sha256[file])) throw new Error(`정책 모드 ${key}: ONNX sha256 없음`);
      }
      for (const spec of [...mode.onnx.inputs, ...mode.onnx.outputs]) {
        if (!spec.name || !Array.isArray(spec.dims) || !spec.dims.length || !spec.dims.every((n) => Number.isInteger(n) && n > 0) || !spec.type) throw new Error(`정책 모드 ${key}: ONNX 입출력 칸 없음`);
      }
    }
  }
  return Object.freeze({ ...modes });
}

function completeMode(mode) {
  // Keep the single-file name for the existing runner while exposing named files.
  mode.onnx.files = { default: mode.onnx.file };
  mode.onnx.sha256 = { [mode.onnx.file]: mode.onnx.sha256 };
  mode.onnx.state ??= [];
  for (const spec of [...mode.onnx.inputs, ...mode.onnx.outputs]) spec.type ??= 'float32';
  mode.depth = null;
  mode.delay = 0;
  mode.fallback = mode.network;
  mode.reset = () => {}; // Neither policy has recurrent observation memory.
  mode.observe = (sim, cmd, mem, ...legacy) => {
    // Old measurement snapshots still use observe(obs, sim, last, scanner, mem).
    if (ArrayBuffer.isView(sim)) return mode.observeInto(sim, cmd, mem, ...legacy);
    sim.cmd = cmd;
    mode.observeInto(sim.observation, sim, sim.lastAction, sim.heightScanner, mem);
    return mode.inputs ? mode.inputs(sim, mem, sim.observation) : [sim.observation, sim.mapping];
  };
  mode.act = (a, out = new Float64Array(mode.action.size)) => {
    for (let i = 0; i < mode.action.size; i++) {
      const target = a[i] * mode.action.scale + mode.action.defaultPose[i];
      out[i] = mode.action.targetClip ? Math.max(-mode.action.targetClip, Math.min(mode.action.targetClip, target)) : target;
    }
    return out;
  };
  mode.torque = mode.action.torque ?? ((tau, dq) => {
    const { effort, velocityLimit } = mode.action;
    const hi = Math.min(Math.max(effort * (1 - dq / velocityLimit), 0), effort);
    const lo = Math.max(Math.min(effort * (-1 - dq / velocityLimit), 0), -effort);
    return Math.min(Math.max(tau, lo), hi);
  });
  return mode;
}
const { nvidia: nvidiaDemoMode, ame2: ame2DemoMode } = createPolicyModeAdapters();
ame2DemoMode.command.caps = { forward: 1, reverse: 1, lateral: 1, turnInPlace: 1, turnWalking: 1, goalDistance: 2, policySpeed: 1.2 };
export const POLICY_MODES = registerPolicyModes({
  nvidia: completeMode(nvidiaDemoMode),
  start: makeStartDemoMode(makeTerrainSampler),
  ame2: completeMode(ame2DemoMode),
});
export const POLICY_ADAPTERS = Object.freeze(Object.fromEntries(Object.values(POLICY_MODES).map((mode) => [mode.id, mode])));
export const DEFAULT_POLICY_ID = POLICY_MODES.nvidia.id;
const aliases = Object.freeze({ 'foothold-v2': 'nvidia-demo' });
export function getPolicyMode(id = DEFAULT_POLICY_ID) {
  const canonical = Object.hasOwn(aliases, id) ? aliases[id] : id;
  const mode = Object.values(POLICY_MODES).find((mode) => mode.id === canonical);
  if (!mode) throw new Error(`알 수 없는 정책 모드: ${id}`);
  return mode;
}
