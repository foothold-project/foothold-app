// Reconstruct the recorded physical state, then call the registered observation
// builder. Sensor recordings stay external; no model/vector values live here.
import { getPolicyMode } from './policy-modes.js';
export function startDemoVectorInputs(tv) {
  const mode = getPolicyMode('start-demo'), committed = {};
  mode.reset(committed);
  let memory = committed, maxObs = 0, maxHist = 0;
  const feeds = [];
  for (let k = 0; k < tv.steps; k++) {
    const recorded = tv.inputs[k], o = recorded.obs45;
    const s = { observation: new Float32Array(45), mapping: new Float32Array(512),
      angB: o.slice(0,3), grav: o.slice(3,6), lastAction: o.slice(33), M2I: Array.from({ length: 12 }, (_, i) => (i%4)*3+Math.floor(i/4)),
      d: { qpos: new Float64Array(19), qvel: new Float64Array(18) }, startMapMode: tv.map_mode,
      heightScanner: (_q,out) => { out.set(recorded.gt_map); return out; }, depthScanner: () => Float32Array.from(recorded.depth2.slice(3600)),
    };
    for (let i = 0; i < 12; i++) { s.d.qpos[7+s.M2I[i]] = mode.action.defaultPose[i]+o[9+i]; s.d.qvel[6+s.M2I[i]] = o[21+i]; }
    const candidate = structuredClone(memory), built = mode.observe(s,o.slice(6,9),candidate);
    for (const [index, name] of [[0,'obs45'],[1,'hist']]) {
      const error = Math.max(...recorded[name].map((x,i) => Math.abs(x-built[index][i])));
      if (error > 1e-6) throw new Error(`start ${tv.map_mode} step ${k} ${name} ${error}`);
      if (index === 0) maxObs = Math.max(maxObs,error); else maxHist = Math.max(maxHist,error);
    }
    for (const index of [5,6,7]) if (Boolean(built[index][0]) !== Boolean(recorded[mode.onnx.inputs[index].name][0])) throw new Error('start flag differs from recording');
    const feed = { ...recorded, obs45: built[0].slice(), hist: built[1].slice() };
    feeds.push(feed);
    mode.commit(candidate,s); memory = candidate;
  }
  return { inputs: feeds, maxObs, maxHist };
}
