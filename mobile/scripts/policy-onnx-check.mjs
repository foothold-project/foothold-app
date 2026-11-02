// Pure shared parity/latency check, usable in Node and headless ORT Web.
import { errorMetrics } from '../sim/ame2-onnx-check.js';
export async function comparePolicyCases(f32, onnx, cases) {
  const pairs = Object.fromEntries(['numpyJs', 'numpyOnnx', 'jsOnnx'].map((key) => [key, { maxAbs: 0, maxRel: 0 }]));
  const exceeded = [];
  for (const sample of cases) {
    const input = Float32Array.from(sample.observation);
    const js = f32(input), actual = await onnx(input);
    for (const [key, a, b] of [['numpyJs', sample.numpy_outputs, js], ['numpyOnnx', sample.numpy_outputs, actual], ['jsOnnx', js, actual]]) {
      if (a.length !== 12 || b.length !== 12 || !Array.from(a).every(Number.isFinite)) throw Error('invalid action');
      const errors = errorMetrics(a, b);
      for (const metric of ['maxAbs', 'maxRel']) pairs[key][metric] = Math.max(pairs[key][metric], errors[metric]);
      if (errors.maxAbs > 1e-4) exceeded.push({ name: sample.name, key, ...errors });
    }
  }
  return { count: cases.length, pairs, exceeded, thresholdMaxAbs: 1e-4, pass: exceeded.length === 0 };
}
export async function benchmarkPolicy(f32, onnx, input) {
  const jsTimes = [], onnxTimes = [];
  for (let i = 0; i < 110; i++) {
    let t = performance.now(); await onnx(input); if (i >= 10) onnxTimes.push(performance.now() - t);
    t = performance.now(); f32(input); if (i >= 10) jsTimes.push(performance.now() - t);
  }
  const stats = (a) => { a.sort((a, b) => a - b); return { n: a.length, p50: a[50], p95: a[95] }; };
  return { f32: stats(jsTimes), onnx: stats(onnxTimes) };
}
