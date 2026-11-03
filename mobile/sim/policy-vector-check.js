// Shared Node/browser checks use the same runner and commit boundary as the app.
import { withPolicyState, warmupInputs } from './policy-onnx.js';
import { startDemoVectorInputs } from './start-demo-vector-check.js';
const maxAbs = (a, b) => {
  if (a?.length !== b.length) throw new Error('시험 출력 크기 불일치');
  return Math.max(...b.map((v, i) => Math.abs(v - a[i])));
};
export async function checkPolicyVectors(raw, contract, tv) {
  await raw(...warmupInputs(contract)); // Warmup must not advance recurrent state.
  const policy = withPolicyState(raw, contract);
  const error = {};
  const built = tv.model === 'start-demo' ? startDemoVectorInputs(tv) : null;
  const inputs = built?.inputs ?? tv.inputs, times = [];
  try {
    for (let k = 0; k < tv.steps; k++) {
      // Poison recorded hidden state: feedback must come from committed outputs.
      const args = contract.inputs.map((spec) => (contract.state ?? []).some((p) => p.in === spec.name)
        ? Array(inputs[k][spec.name].length).fill(777) : inputs[k][spec.name]);
      const started = performance.now();
      const out = await policy(...args);
      times.push(performance.now()-started);
      for (const { name } of contract.outputs) {
        const diff = maxAbs(out[name], tv.expected[k][name]);
        if (!Number.isFinite(diff)) throw new Error(`step ${k} ${name} nonfinite`);
        error[name] = Math.max(error[name] ?? 0, diff);
      }
      if (error.action > tv.tolerance) throw new Error(`step ${k} action ${error.action} > ${tv.tolerance}`);
      if (k === 0) {
        const retry = await policy(...args);
        if (maxAbs(retry.action, out.action) !== 0) throw new Error('동일 스텝 재호출이 상태를 변경함');
      }
      if (!policy.commit(out) || policy.commit(out)) throw new Error('상태 확정은 행동당 한 번이어야 함');
    }
    policy.reset();
    const first = contract.inputs.map((spec) => inputs[0][spec.name]);
    const out = await policy(...first);
    if (maxAbs(out.action, tv.expected[0].action) > tv.tolerance) throw new Error('리셋 상태 오류');
    policy.cancel();
    if (policy.commit(out)) throw new Error('취소 뒤 결과 확정됨');
    times.sort((a,b) => a-b);
    return { ...error, ...(built ? { observation: { obs45: built.maxObs, hist: built.maxHist, depth2: built.maxDepth, gt_map: built.maxMap, unusedRecordedMapDiff: built.unusedRecordedMapDiff } } : {}),
      timingMs: { median: times[times.length>>1], max: times.at(-1), deadline: 20, overDeadline: times.filter((x) => x > 20).length } };
  } finally { await policy.dispose(); }
}
export function checkF32Vectors(f32, tv) {
  let max = 0;
  for (let k = 0; k < tv.steps; k++) max = Math.max(max, maxAbs(f32(tv.inputs[k].prop, tv.inputs[k].mapping), tv.expected[k].action));
  return max; // Measurement only, not an ONNX parity verdict.
}
