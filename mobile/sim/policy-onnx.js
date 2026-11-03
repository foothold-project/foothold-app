// Shared B=1 deterministic FP32 actor runner. Contracts belong to each adapter.
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const size = (dims) => dims.reduce((a, b) => a * b, 1);
// Tensor buffers are owned by each request, including bool [1] flags.
export function inputData(input, { dims, type = 'float32' }) {
  if (input?.length !== size(dims)) throw new Error('ONNX 입력 크기 오류');
  if (type === 'bool') {
    if (!Array.from(input).every((v) => v === true || v === false || v === 0 || v === 1)) throw new Error('ONNX bool 입력 오류');
    return Uint8Array.from(input, Number);
  }
  const constructors = { float32: Float32Array, float64: Float64Array, int32: Int32Array, int64: BigInt64Array };
  const ArrayType = constructors[type];
  if (!ArrayType || !Array.from(input, Number).every(Number.isFinite)) throw new Error('ONNX 입력 자료형/유한값 오류');
  const data = ArrayType.from(input, type === 'int64' ? BigInt : Number);
  if (!Array.from(data, Number).every(Number.isFinite)) throw new Error('ONNX 입력 범위 오류');
  return data;
}
export const warmupInputs = (contract) => contract.inputs.map((spec) => inputData(Array(size(spec.dims)).fill(0), spec));

// Inference is speculative. Only the simulation's applyAction commits feedback.
// Epoch/revision tokens reject reset, cancellation and repeated/stale commits.
export function withPolicyState(run, contract) {
  let epoch = 0, revision = 0, state;
  const candidates = new WeakMap();
  const reset = () => {
    epoch++; revision = 0;
    state = Object.fromEntries((contract.state ?? []).map((pair) => {
      const spec = contract.inputs.find((x) => x.name === pair.in);
      if (!spec || !contract.outputs.some((x) => x.name === pair.out && same(x.dims, spec.dims) && (x.type ?? 'float32') === (spec.type ?? 'float32'))) throw new Error('ONNX 상태 계약 오류');
      return [pair.in, inputData(Array(size(spec.dims)).fill(0), spec)];
    }));
  };
  reset();
  const policy = async (...args) => {
    const token = { epoch, revision };
    const inputs = contract.inputs.map((spec, i) => state[spec.name] ?? args[i]);
    const outputs = await run(...inputs);
    if (!outputs || token.epoch !== epoch || token.revision !== revision) return null;
    candidates.set(outputs, token);
    return outputs;
  };
  policy.commit = (outputs) => {
    const token = candidates.get(outputs);
    if (!token || token.epoch !== epoch || token.revision !== revision) return false;
    const next = {};
    for (const pair of contract.state ?? []) {
      next[pair.in] = inputData(outputs[pair.out], contract.inputs.find((x) => x.name === pair.in));
    }
    state = next; revision++; candidates.delete(outputs);
    return true;
  };
  policy.reset = () => { reset(); run.cancel?.(); };
  policy.cancel = () => { epoch++; run.cancel?.(); };
  policy.dispose = () => { epoch++; return run.dispose?.(); };
  policy.async = true;
  return policy;
}
export async function loadOnnxPolicy(ort, model, contract, backend = 'wasm') {
  if (!['wasm', 'webgpu', 'cpu'].includes(backend)) throw new Error('지원하지 않는 추론 설정');
  const session = await ort.InferenceSession.create(model, {
    executionProviders: [backend], graphOptimizationLevel: 'all',
    ...(backend === 'cpu' ? { intraOpNumThreads: 1, interOpNumThreads: 1 } : {}),
  });
  if (!same(session.inputNames, contract.inputs.map((x) => x.name)) ||
      !contract.outputs.every((x) => session.outputNames.includes(x.name))) {
    await session.release(); throw new Error('ONNX 입출력 이름 불일치');
  }
  let pending = false;
  const infer = async (...args) => {
    if (pending) throw new Error('ONNX 추론 중복 요청');
    pending = true;
    const feeds = {};
    let result;
    try {
      contract.inputs.forEach((spec, i) => {
        feeds[spec.name] = new ort.Tensor(spec.type ?? 'float32', inputData(args[i], spec), spec.dims);
      });
      result = await session.run(feeds);
      for (const { name, dims, type = 'float32' } of contract.outputs) {
        const tensor = result[name];
        if (!tensor || tensor.type !== type || !same(tensor.dims, dims) || tensor.data.length !== size(dims) ||
            !Array.from(tensor.data, Number).every(Number.isFinite)) throw new Error('ONNX 출력 크기/유한값 오류');
      }
      return Object.fromEntries(contract.outputs.map(({ name }) => [name, result[name].data.slice()]));
    } finally {
      for (const tensor of Object.values(result ?? {})) tensor.dispose();
      for (const tensor of Object.values(feeds)) tensor.dispose();
      pending = false;
    }
  };
  infer.async = true;
  infer.dispose = () => session.release();
  return infer;
}

export async function selectOnnxPolicy(adapter, f32, { backend = 'wasm', notify = () => {},
  worker = true, workerOptions = {},
  importRuntime = (url) => import(url), fetchModel = (url) => fetch(url),
  digest = async (buffer) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)), (v) => v.toString(16).padStart(2, '0')).join(''),
} = {}) {
  const label = adapter.statusLabel ?? adapter.label ?? adapter.id;
  const fallback = (reason) => {
    notify(`${label} · ${f32 ? 'JS f32 되돌림 중' : '정책 잠금'} · ${reason}`);
    if (!f32) throw new Error(`${label} ONNX 사용 불가: ${reason}`);
  };
  if (backend === 'f32') { fallback('JS f32 직접 선택'); return f32; }
  let onnx, data, workerReason = '', inWorker = false;
  const mainOnnx = async () => {
    let ort;
    try { ort = await importRuntime(new URL(`./ort/ort.${backend === 'webgpu' ? 'webgpu' : 'wasm'}.min.mjs`, import.meta.url).href); }
    catch { throw new Error('ONNX 런타임 없음'); }
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    ort.env.wasm.wasmPaths = new URL('./ort/', import.meta.url).href;
    const runner = await loadOnnxPolicy(ort, data, adapter.onnx, backend);
    try { await runner(...warmupInputs(adapter.onnx)); }
    catch (error) { await runner.dispose().catch(() => {}); throw error; }
    return runner;
  };
  const announce = () => notify(`${label} · ONNX ${backend.toUpperCase()} · ${inWorker ? 'Worker' : workerReason === 'Worker 늦음' ? 'Worker 늦음 → 화면 계산' : `화면 계산${workerReason ? ` (Worker 사용 불가: ${workerReason})` : ''}`}`);
  try {
    if (!adapter.onnx) throw new Error('ONNX 계약 없음');
    if (!['wasm', 'webgpu'].includes(backend)) throw new Error('지원하지 않는 추론 설정');
    // Fetch first so an unbundled model has a clear reason even without ORT.
    const response = await fetchModel(new URL(adapter.onnx.file, import.meta.url));
    if (!response.ok) throw new Error(`ONNX 파일 없음 (${response.status})`);
    // SPA hosts may return index.html with HTTP 200 for an absent model.
    if (/^text\/html(?:\s*;|\s*$)/i.test(response.headers.get('content-type') ?? '')) throw new Error('ONNX 파일 없음');
    data = await response.arrayBuffer();
    if (await digest(data) !== (typeof adapter.onnx.sha256 === 'string' ? adapter.onnx.sha256 : adapter.onnx.sha256[adapter.onnx.file])) throw new Error('ONNX SHA-256 불일치');
    if (worker) {
      try {
        const { loadWorkerPolicy } = await import('./policy-worker-client.js');
        onnx = await loadWorkerPolicy(data, adapter.onnx, backend, { ...workerOptions, deadlineMs: adapter.timing.policyDt * 1000,
          // A fatal error can arrive after a caller timed out or STOP cancelled
          // it. Surface it even if the next inference is waiting for new input.
          onFailure: (error) => { if (inWorker) notify(`${label} · Worker 사용 불가: ${error.message} · 다음 계산에서 복구`); },
        });
        inWorker = true;
      } catch (error) { workerReason = error.message; }
    }
    if (!onnx) onnx = await mainOnnx();
  } catch (e) {
    await onnx?.dispose().catch(() => {});
    fallback(`${workerReason ? `Worker 사용 불가: ${workerReason}; ` : ''}${e.message}`);
    return f32;
  }
  announce();
  let failed = false, failureReason = '';
  const runFallback = (...args) => {
    if (!f32) throw new Error(`${label} ONNX 사용 불가: ${failureReason}`);
    return f32(...args);
  };
  const policy = async (...args) => {
    if (failed) return runFallback(...args);
    try { return await onnx(...args); }
    catch (e) {
      if (inWorker) {
        await onnx.dispose().catch(() => {});
        inWorker = false; workerReason = e.message;
        try { onnx = await mainOnnx(); announce(); return await onnx(...args); }
        catch (error) { e = error; }
      }
      failed = true; failureReason = e.message;
      await onnx.dispose().catch(() => {});
      fallback(`${workerReason ? `Worker 사용 불가: ${workerReason}; ` : ''}${e.message}`);
      return runFallback(...args);
    }
  };
  policy.async = true;
  // Only the Worker client applies the roundtrip deadline. Main ONNX/f32
  // recovery keeps its existing behavior: apply late results in the same generation.
  policy.cancel = () => onnx.cancel?.();
  policy.dispose = () => failed ? undefined : onnx.dispose();
  return withPolicyState(policy, adapter.onnx);
}
