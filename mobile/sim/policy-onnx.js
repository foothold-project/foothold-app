// Shared B=1 deterministic FP32 actor runner. Contracts belong to each adapter.
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const size = (dims) => dims.reduce((a, b) => a * b, 1);
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
      contract.inputs.forEach(({ name, dims }, i) => {
        const input = args[i];
        if (input?.length !== size(dims) || !input.every(Number.isFinite)) throw new Error('ONNX 입력 크기/유한값 오류');
        // Own buffers: STOP/reset may change simulation state during session.run.
        feeds[name] = new ort.Tensor('float32', Float32Array.from(input), dims);
      });
      result = await session.run(feeds);
      for (const { name, dims, type = 'float32' } of contract.outputs) {
        const tensor = result[name];
        if (!tensor || tensor.type !== type || !same(tensor.dims, dims) || tensor.data.length !== size(dims) ||
            !Array.from(tensor.data, Number).every(Number.isFinite)) throw new Error('ONNX 출력 크기/유한값 오류');
      }
      // Optional diagnostic output; action conversion remains in the adapter.
      if (result.offsets) infer.offsets = Array.from(result.offsets.data, Number);
      return Float32Array.from(result[contract.action].data);
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
  const label = adapter.id === 'ame2-demo' ? 'AME-2' : adapter.id;
  const fallback = (reason) => notify(`${label} · 기본 계산 사용: ${reason} (f32 JS)`);
  if (backend === 'f32') { notify(`${label} · 기본 계산 사용 (f32 JS)`); return f32; }
  let onnx, data, workerReason = '', inWorker = false;
  const mainOnnx = async () => {
    let ort;
    try { ort = await importRuntime(new URL(`./ort/ort.${backend === 'webgpu' ? 'webgpu' : 'wasm'}.min.mjs`, import.meta.url).href); }
    catch { throw new Error('ONNX 런타임 없음'); }
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    ort.env.wasm.wasmPaths = new URL('./ort/', import.meta.url).href;
    const runner = await loadOnnxPolicy(ort, data, adapter.onnx, backend);
    try { await runner(...adapter.onnx.inputs.map(({ dims }) => new Float32Array(size(dims)))); }
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
    if (await digest(data) !== adapter.onnx.sha256) throw new Error('ONNX SHA-256 불일치');
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
  let failed = false;
  const policy = async (...args) => {
    if (failed) return f32(...args);
    try { return await onnx(...args); }
    catch (e) {
      if (inWorker) {
        await onnx.dispose().catch(() => {});
        inWorker = false; workerReason = e.message;
        try { onnx = await mainOnnx(); announce(); return await onnx(...args); }
        catch (error) { e = error; }
      }
      failed = true;
      fallback(`${workerReason ? `Worker 사용 불가: ${workerReason}; ` : ''}${e.message}`);
      await onnx.dispose().catch(() => {});
      return f32(...args);
    }
  };
  policy.async = true;
  // Only the Worker client applies the roundtrip deadline. Main ONNX/f32
  // recovery keeps its existing behavior: apply late results in the same generation.
  policy.cancel = () => onnx.cancel?.();
  policy.dispose = () => failed ? undefined : onnx.dispose();
  return policy;
}
