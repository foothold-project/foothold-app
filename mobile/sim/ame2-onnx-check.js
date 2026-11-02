// Shared offline parity measurement; the crop-test graph is never bundled.
export function fixedAme2Cases(check) {
  return Object.entries(check.cases).flatMap(([name, g]) => Array.from({ length: g.n }, (_, i) => ({
    name: `${name}/${i}`, prop: g.prop[i], mapping: g.mapping[i].flat(2),
    centers: g.forced_centers?.[i], torch_outputs: g.torch_outputs[i], offsets: g.crop_offsets[i],
  })));
}
export function errorMetrics(reference, actual) {
  let maxAbs = 0, maxRel = 0;
  for (let i = 0; i < reference.length; i++) {
    if (!Number.isFinite(actual[i])) throw new Error('non-finite output');
    const abs = Math.abs(reference[i] - actual[i]);
    maxAbs = Math.max(maxAbs, abs);
    maxRel = Math.max(maxRel, abs / Math.max(Math.abs(reference[i]), 1e-6));
  }
  return { maxAbs, maxRel };
}
export async function compareAme2Cases(ort, model, cropModel, f32, cases, backend) {
  const options = { executionProviders: [backend], ...(backend === 'cpu' ? { intraOpNumThreads: 1 } : {}) };
  const normal = await ort.InferenceSession.create(model, options);
  const forced = await ort.InferenceSession.create(cropModel, options);
  const pairs = Object.fromEntries(['torchJs', 'torchOnnx', 'jsOnnx'].map((k) => [k, { maxAbs: 0, maxRel: 0 }]));
  let count = 0;
  try {
    for (const sample of cases) {
      const prop = Float32Array.from(sample.prop), mapping = Float32Array.from(sample.mapping);
      const feeds = { prop: new ort.Tensor('float32', prop, [1,49]), mapping: new ort.Tensor('float32', mapping, [1,29,13,3]) };
      if (sample.centers) feeds.centers = new ort.Tensor('float32', Float32Array.from(sample.centers), [1,2]);
      const result = await (sample.centers ? forced : normal).run(feeds);
      try {
        const js = f32(prop, mapping, sample.centers), onnx = result.action.data;
        if (sample.offsets && JSON.stringify(sample.offsets) !== JSON.stringify(Array.from(result.offsets.data, Number))) throw new Error(`crop mismatch: ${sample.name}`);
        for (const [name, a, b] of [['torchJs',sample.torch_outputs,js], ['torchOnnx',sample.torch_outputs,onnx], ['jsOnnx',js,onnx]]) {
          const errors = errorMetrics(a, b);
          for (const key of ['maxAbs','maxRel']) pairs[name][key] = Math.max(pairs[name][key], errors[key]);
          // Absolute ceiling catches differences even near zero; relative is
          // reported separately with a 1e-6 denominator floor.
          if (errors.maxAbs > 1e-4) throw new Error(`${sample.name}/${name}: ${errors.maxAbs} > 1e-4`);
        }
        count++;
      } finally { for (const tensor of Object.values(result)) tensor.dispose(); }
    }
    return { count, pairs, thresholdMaxAbs: 1e-4, relativeDenominatorFloor: 1e-6 };
  } finally { await normal.release(); await forced.release(); }
}
