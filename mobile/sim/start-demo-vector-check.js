// Reconstruct the recorded physical state, then call the registered observation
// builder. Sensor recordings stay external; no model/vector values live here.
import { getPolicyMode } from './policy-modes.js';
export function startDemoVectorInputs(tv) {
  const mode = getPolicyMode('start-demo'), committed = {};
  mode.reset(committed);
  let memory = committed, maxObs = 0, maxHist = 0, maxDepth = 0, maxMap = 0, unusedRecordedMapDiff = 0;
  const feeds = [];
  for (let k = 0; k < tv.steps; k++) {
    const recorded = tv.inputs[k], o = recorded.obs45;
    const s = { observation: new Float32Array(45), mapping: new Float32Array(512),
      angB: o.slice(0,3), grav: o.slice(3,6), lastAction: o.slice(33), M2I: Array.from({ length: 12 }, (_, i) => (i%4)*3+Math.floor(i/4)),
      d: { qpos: new Float64Array(19), qvel: new Float64Array(18) }, startMapMode: tv.map_mode,
      heightScanner: (_q,out) => { out.set(recorded.gt_map); return out; },
      // Capture f5 is exposed as the newest delayed frame at step 10, etc.
      // The final capture has no consumer within this 20-step recording.
      depthScanner: () => Float32Array.from(tv.inputs[k === 0 ? 0 : Math.min(k+5,tv.steps-1)].depth2.slice(0,3600)),
    };
    for (let i = 0; i < 12; i++) { s.d.qpos[7+s.M2I[i]] = mode.action.defaultPose[i]+o[9+i]; s.d.qvel[6+s.M2I[i]] = o[21+i]; }
    const candidate = structuredClone(memory), built = mode.observe(s,o.slice(6,9),candidate);
    for (const [index, name] of [[0,'obs45'],[1,'hist'],[2,'depth2'],[8,'gt_map']]) {
      const error = Math.max(...recorded[name].map((x,i) => Math.abs(x-built[index][i])));
      // Export vectors retain a diagnostic map even when use_gt=false. The
      // app contract disables it with zeros; report that ignored-field delta.
      const unusedMap = name === 'gt_map' && !built[7][0];
      const effectiveError = unusedMap ? Math.max(...built[index].map(Math.abs)) : error;
      if (effectiveError > 1e-6) throw new Error(`start ${tv.map_mode} step ${k} ${name} ${effectiveError}`);
      if (index === 0) maxObs = Math.max(maxObs,error);
      else if (index === 1) maxHist = Math.max(maxHist,error);
      else if (index === 2) maxDepth = Math.max(maxDepth,error);
      else { maxMap = Math.max(maxMap,effectiveError); if (unusedMap) unusedRecordedMapDiff = Math.max(unusedRecordedMapDiff,error); }
    }
    for (const index of [5,6,7]) if (Boolean(built[index][0]) !== Boolean(recorded[mode.onnx.inputs[index].name][0])) throw new Error('start flag differs from recording');
    const feed = Object.fromEntries(mode.onnx.inputs.map((spec,i) => [spec.name,built[i].slice()]));
    feeds.push(feed);
    mode.commit(candidate,s); memory = candidate;
  }
  return { inputs: feeds, maxObs, maxHist, maxDepth, maxMap, unusedRecordedMapDiff };
}
