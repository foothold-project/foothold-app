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
  // Pack four output rows together once, so the inner loop reads adjacent
  // weights instead of four distant rows. The source/export is never changed.
  const packed = Object.create(null);
  for (const [name, shape] of Object.entries(shapes)) {
    if (!name.endsWith('.weight') || shape.length < 2 || shape[0] % 4) continue;
    const cols = shape.slice(1).reduce((n, v) => n * v, 1), w = weights[name], out = new Float32Array(w.length);
    for (let i = 0; i < shape[0]; i += 4) for (let j = 0; j < cols; j++) for (let r = 0; r < 4; r++) out[i * cols + j * 4 + r] = w[(i + r) * cols + j];
    packed[name] = out;
  }
  // Reuse per-operator output buffers. No recurrent state or retained action.
  const scratch = new Map();
  const alloc = (key, n) => {
    if (!scratch.has(key)) scratch.set(key, new Float32Array(n));
    return scratch.get(key);
  };
  // Two packed groups (eight independent rows) share each input load, with
  // four/scalar tails. Each dot product keeps its original left-to-right
  // double accumulation and float32 operator boundary.
  function matmul(x, w, b, cols, rows, rowStart, activation, out) {
    for (let k = 0; k < x.length / cols; k++) {
      const xi = k * cols, yi = k * rows;
      let i = 0;
      for (; i + 7 < rows; i += 8) {
        const wi = (i + rowStart) * cols, next = wi + 4 * cols;
        let a = 0, c = 0, d = 0, e = 0, g = 0, h = 0, u = 0, v = 0;
        for (let j = 0; j < cols; j++) {
          const xj = x[xi + j], p = wi + j * 4, q = next + j * 4;
          a += w[p] * xj; c += w[p + 1] * xj; d += w[p + 2] * xj; e += w[p + 3] * xj;
          g += w[q] * xj; h += w[q + 1] * xj; u += w[q + 2] * xj; v += w[q + 3] * xj;
        }
        a = f(f(a) + b[i + rowStart]); c = f(f(c) + b[i + rowStart + 1]);
        d = f(f(d) + b[i + rowStart + 2]); e = f(f(e) + b[i + rowStart + 3]);
        g = f(f(g) + b[i + rowStart + 4]); h = f(f(h) + b[i + rowStart + 5]);
        u = f(f(u) + b[i + rowStart + 6]); v = f(f(v) + b[i + rowStart + 7]);
        out[yi + i] = activation ? elu(a) : a; out[yi + i + 1] = activation ? elu(c) : c;
        out[yi + i + 2] = activation ? elu(d) : d; out[yi + i + 3] = activation ? elu(e) : e;
        out[yi + i + 4] = activation ? elu(g) : g; out[yi + i + 5] = activation ? elu(h) : h;
        out[yi + i + 6] = activation ? elu(u) : u; out[yi + i + 7] = activation ? elu(v) : v;
      }
      for (; i + 3 < rows; i += 4) {
        const wi = (i + rowStart) * cols;
        let a = 0, c = 0, d = 0, e = 0;
        for (let j = 0; j < cols; j++) {
          const v = x[xi + j], p = wi + j * 4;
          a += w[p] * v; c += w[p + 1] * v;
          d += w[p + 2] * v; e += w[p + 3] * v;
        }
        a = f(f(a) + b[i + rowStart]); c = f(f(c) + b[i + rowStart + 1]);
        d = f(f(d) + b[i + rowStart + 2]); e = f(f(e) + b[i + rowStart + 3]);
        out[yi + i] = activation ? elu(a) : a; out[yi + i + 1] = activation ? elu(c) : c;
        out[yi + i + 2] = activation ? elu(d) : d; out[yi + i + 3] = activation ? elu(e) : e;
      }
      for (; i < rows; i++) {
        let sum = 0;
        const wi = (i + rowStart) * cols;
        for (let j = 0; j < cols; j++) sum += w[wi + j] * x[xi + j];
        const v = f(f(sum) + b[i + rowStart]);
        out[yi + i] = activation ? elu(v) : v;
      }
    }
    return out;
  }
  function linear(x, prefix, activation = false, rowStart = 0, rows = null, key = prefix) {
    const [allRows, cols] = shapes[prefix + '.weight'];
    rows ??= allRows;
    return matmul(x, packed[prefix + '.weight'] ?? weights[prefix + '.weight'], weights[prefix + '.bias'], cols, rows, rowStart, activation, alloc(key, x.length / cols * rows));
  }
  const mlp = (x, p) => linear(linear(linear(x, p + '.net.0', true), p + '.net.2', true), p + '.net.4');
  function conv(x, h, width, prefix, pad = 0, dilation = 1) {
    const w = packed[prefix + '.weight'], b = weights[prefix + '.bias'];
    const [oc, ic, kernel] = shapes[prefix + '.weight'];
    const oh = h + 2 * pad - dilation * (kernel - 1), ow = width + 2 * pad - dilation * (kernel - 1);
    const cols = ic * kernel * kernel, patches = alloc(prefix + '.patches', oh * ow * cols);
    // Precompute source indices once per layer, including dilation and padding.
    // Packing in C,H,W order matches the original summation and OIHW weights.
    const indexKey = prefix + '.indices';
    if (!scratch.has(indexKey)) {
      const indices = new Int32Array(patches.length);
      let p = 0;
      for (let i = 0; i < oh; i++) for (let j = 0; j < ow; j++) for (let c = 0; c < ic; c++) for (let a = 0; a < kernel; a++) for (let z = 0; z < kernel; z++) {
        const xx = i - pad + a * dilation, yy = j - pad + z * dilation;
        indices[p++] = xx >= 0 && xx < h && yy >= 0 && yy < width ? (xx * width + yy) * ic + c : -1;
      }
      scratch.set(indexKey, indices);
    }
    const indices = scratch.get(indexKey);
    for (let i = 0; i < patches.length; i++) patches[i] = indices[i] < 0 ? 0 : x[indices[i]];
    return matmul(patches, w, b, cols, oc, 0, true, alloc(prefix, oh * ow * oc));
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
      patch[dst] = mapping[src]; patch[dst + 1] = mapping[src + 1]; patch[dst + 2] = heights[i * 10 + j] = mapping[src + 2];
    }
    const spatial = conv(conv(heights, 12, 10, 'cnn_part.0', 2), 12, 10, 'cnn_part.2', 2);
    const fc = linear(patch, 'fc_part.0', true), localInput = alloc('localInput', 120 * 64);
    for (let i = 0; i < 120; i++) {
      for (let j = 0; j < 16; j++) localInput[i * 64 + j] = fc[i * 16 + j];
      for (let j = 0; j < 48; j++) localInput[i * 64 + 16 + j] = spatial[i * 48 + j];
    }
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
