// Deterministic teacher mean. Independently translated from ame2_export.py's
// NumPy reference; NHWC features, OIHW kernels, float32 at operator boundaries.
const f = Math.fround;
const elu = (x) => x >= 0 ? x : Math.expm1(x);
const pair = (name, shape) => [[name + '.weight', shape], [name + '.bias', [shape[0]]]];
const mlpLayout = (name, input, output) => [
  ...pair(name + '.net.0', [512, input]), ...pair(name + '.net.2', [512, 512]), ...pair(name + '.net.4', [output, 512]),
];
// Exact export order, not executable model instructions from the JSON file.
const layout = [
  ['log_std', [12]], ...pair('fc_part.0', [16, 3]),
  ...pair('cnn_part.0', [8, 1, 5, 5]), ...pair('cnn_part.2', [48, 8, 5, 5]),
  ...pair('local_proj.0', [96, 64]), ...mlpLayout('prop_encoder', 49, 128),
  ...pair('global_cnn.0', [8, 3, 3, 3]), ...pair('global_cnn.2', [32, 8, 3, 3]),
  ...pair('global_proj.0', [64, 32]), ...pair('gaze_head.0', [64, 192]), ...pair('gaze_head.2', [2, 64]),
  ...mlpLayout('query_mlp', 192, 96), ['mha.in_proj_weight', [288, 96]], ['mha.in_proj_bias', [288]],
  ...pair('mha.out_proj', [96, 96]), ...mlpLayout('output_mlp', 288, 12),
];
export function roundEven(x) {
  const lo = Math.floor(x), r = x - lo;
  return r === 0.5 ? lo + (lo % 2 !== 0 ? 1 : 0) : Math.round(x);
}
export function cropOffsets(centers) {
  return centers.map((v, i) => Math.max(0, Math.min(i ? 3 : 17, roundEven(f(v - (i ? 4.5 : 5.5))))));
}

export function loadAme2Policy(buffer, manifest) {
  if (manifest?.schema !== 'ame2-f32-v1' || buffer.byteLength !== 5007976 || manifest.bytes !== buffer.byteLength || !Array.isArray(manifest.tensors) || manifest.tensors.length !== layout.length) throw new Error('AME-2 배치표/가중치 길이 불일치');
  const weights = Object.create(null), shapes = Object.create(null);
  let offset = 0;
  for (const [i, t] of manifest.tensors.entries()) {
    if (t.name !== layout[i][0] || JSON.stringify(t.shape) !== JSON.stringify(layout[i][1])) throw new Error('AME-2 텐서 이름/shape/순서 불일치');
    const count = t.shape.reduce((a, b) => a * b, 1);
    if (t.dtype !== 'float32-le' || t.offset_bytes !== offset || t.nbytes !== count * 4 || weights[t.name]) throw new Error('AME-2 텐서 배치 오류');
    const a = new Float32Array(buffer, offset, count);
    if (!a.every(Number.isFinite)) throw new Error('AME-2 유한하지 않은 가중치');
    weights[t.name] = a; shapes[t.name] = t.shape; offset += t.nbytes;
  }
  if (offset !== buffer.byteLength || manifest.tensors.length !== 41) throw new Error('AME-2 텐서 수/길이 오류');
  // The manifest's MHA uses in_proj_weight/bias instead of .weight/.bias.
  weights['mha.in_proj.weight'] = weights['mha.in_proj_weight']; weights['mha.in_proj.bias'] = weights['mha.in_proj_bias']; shapes['mha.in_proj.weight'] = [288, 96];
  // Reuse per-operator output buffers. No recurrent state or retained action.
  const scratch = new Map();
  const alloc = (key, n) => {
    if (!scratch.has(key)) scratch.set(key, new Float32Array(n));
    return scratch.get(key);
  };
  function linear(x, prefix, activation = false, rowStart = 0, rows = null, key = prefix) {
    const w = weights[prefix + '.weight'], b = weights[prefix + '.bias'];
    const [allRows, cols] = shapes[prefix + '.weight'];
    rows ??= allRows;
    const batches = x.length / cols, out = alloc(key, batches * rows);
    for (let k = 0; k < batches; k++) for (let i = 0; i < rows; i++) {
      const wi = (i + rowStart) * cols, xi = k * cols;
      let sum = 0;
      for (let j = 0; j < cols; j++) sum += w[wi + j] * x[xi + j];
      const v = f(f(sum) + b[i + rowStart]);
      out[k * rows + i] = activation ? elu(v) : v;
    }
    return out;
  }
  const mlp = (x, p) => linear(linear(linear(x, p + '.net.0', true), p + '.net.2', true), p + '.net.4');
  function conv(x, h, width, prefix, pad = 0, dilation = 1) {
    const w = weights[prefix + '.weight'], b = weights[prefix + '.bias'];
    const [oc, ic, kernel] = shapes[prefix + '.weight'];
    const oh = h + 2 * pad - dilation * (kernel - 1), ow = width + 2 * pad - dilation * (kernel - 1);
    const out = alloc(prefix, oh * ow * oc);
    for (let i = 0; i < oh; i++) for (let j = 0; j < ow; j++) for (let o = 0; o < oc; o++) {
      let sum = 0;
      for (let c = 0; c < ic; c++) for (let a = 0; a < kernel; a++) {
        const xx = i - pad + a * dilation;
        if (xx < 0 || xx >= h) continue;
        for (let z = 0; z < kernel; z++) {
          const yy = j - pad + z * dilation;
          if (yy >= 0 && yy < width) sum += x[(xx * width + yy) * ic + c] * w[((o * ic + c) * kernel + a) * kernel + z];
        }
      }
      out[(i * ow + j) * oc + o] = elu(f(f(sum) + b[o]));
    }
    return out;
  }
  const cat = (key, ...arrays) => {
    const out = alloc(key, arrays.reduce((n, a) => n + a.length, 0));
    let start = 0;
    for (const a of arrays) { out.set(a, start); start += a.length; }
    return out;
  };
  const infer = (prop, mapping, forcedCenters = null) => {
    if (prop.length !== 49 || mapping.length !== 1131 || !prop.every(Number.isFinite) || !mapping.every(Number.isFinite)) throw new Error('AME-2 입력 크기/유한값 오류');
    const g = conv(conv(mapping, 29, 13, 'global_cnn.0'), 27, 11, 'global_cnn.2', 0, 2);
    const pooled = alloc('pooled', 32); pooled.fill(-Infinity);
    for (let i = 0; i < g.length; i++) pooled[i % 32] = Math.max(pooled[i % 32], g[i]);
    const global = linear(pooled, 'global_proj.0', true), proprio = mlp(prop, 'prop_encoder');
    const logits = linear(linear(cat('gazeInput', global, proprio), 'gaze_head.0', true), 'gaze_head.2');
    const centers = forcedCenters ?? Array.from(logits, (v, i) => {
      const e = f(Math.exp(-Math.abs(v))), denominator = f(1 + e);
      const r = f(v >= 0 ? 1 / denominator : e / denominator);
      return f(f(r * (i ? 3 : 17)) + (i ? 4.5 : 5.5));
    });
    const offsets = cropOffsets(centers), patch = alloc('patch', 360), heights = alloc('patchZ', 120);
    for (let i = 0; i < 12; i++) for (let j = 0; j < 10; j++) {
      const src = ((offsets[0] + i) * 13 + offsets[1] + j) * 3, dst = (i * 10 + j) * 3;
      patch.set(mapping.subarray(src, src + 3), dst); heights[i * 10 + j] = mapping[src + 2];
    }
    const spatial = conv(conv(heights, 12, 10, 'cnn_part.0', 2), 12, 10, 'cnn_part.2', 2);
    const fc = linear(patch, 'fc_part.0', true), localInput = alloc('localInput', 120 * 64);
    for (let i = 0; i < 120; i++) { localInput.set(fc.subarray(i * 16, (i + 1) * 16), i * 64); localInput.set(spatial.subarray(i * 48, (i + 1) * 48), i * 64 + 16); }
    const local = linear(localInput, 'local_proj.0', true), query = mlp(cat('queryInput', proprio, global), 'query_mlp');
    const q = linear(query, 'mha.in_proj', false, 0, 96, 'q');
    const k = linear(local, 'mha.in_proj', false, 96, 96, 'k'), v = linear(local, 'mha.in_proj', false, 192, 96, 'v');
    const attended = alloc('attended', 96), scores = alloc('scores', 120), probs = alloc('probs', 120);
    for (let head = 0; head < 32; head++) {
      const h = head * 3; let max = -Infinity;
      for (let i = 0; i < 120; i++) {
        const p = i * 96 + h;
        scores[i] = f(f(q[h] * k[p] + q[h + 1] * k[p + 1] + q[h + 2] * k[p + 2]) * f(3 ** -0.5));
        max = Math.max(max, scores[i]);
      }
      let sum = 0;
      for (let i = 0; i < 120; i++) { probs[i] = Math.exp(f(scores[i] - max)); sum += probs[i]; }
      sum = f(sum);
      for (let i = 0; i < 120; i++) probs[i] = f(probs[i] / sum);
      for (let c = 0; c < 3; c++) {
        let value = 0;
        for (let i = 0; i < 120; i++) value += probs[i] * v[i * 96 + h + c];
        attended[h + c] = value;
      }
    }
    const output = mlp(cat('outputInput', linear(attended, 'mha.out_proj'), proprio, global), 'output_mlp');
    if (!output.every(Number.isFinite)) throw new Error('AME-2 유한하지 않은 행동');
    infer.offsets = offsets;
    return output;
  };
  return infer;
}
