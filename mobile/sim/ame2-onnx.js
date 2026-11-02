// Fixed B=1 FP32 actor mean. Same observations/actions as the f32 implementation.
export const AME2_ONNX_SHA256 = '398acb0c73369e84946a34c0109bca1edd0560cc14ee286fd36b9caf7e2da69b';
export async function loadAme2OnnxPolicy(ort, model, backend = 'wasm') {
  if (!['wasm', 'webgpu', 'cpu'].includes(backend)) throw new Error('AME-2 ONNX backend');
  const session = await ort.InferenceSession.create(model, {
    executionProviders: [backend], graphOptimizationLevel: 'all',
    ...(backend === 'cpu' ? { intraOpNumThreads: 1, interOpNumThreads: 1 } : {}),
  });
  if (JSON.stringify(session.inputNames) !== '["prop","mapping"]' || !session.outputNames.includes('action')) {
    await session.release(); throw new Error('AME-2 ONNX 입출력 이름 불일치');
  }
  const infer = async (prop, mapping) => {
    if (prop.length !== 49 || mapping.length !== 1131 || !prop.every(Number.isFinite) || !mapping.every(Number.isFinite)) throw new Error('AME-2 입력 크기/유한값 오류');
    // Own buffers: STOP/reset must be able to clear observations while run awaits.
    const result = await session.run({ prop: new ort.Tensor('float32', Float32Array.from(prop), [1, 49]),
      mapping: new ort.Tensor('float32', Float32Array.from(mapping), [1, 29, 13, 3]) });
    try {
      const action = result.action;
      if (action.type !== 'float32' || JSON.stringify(action.dims) !== '[1,12]' || !action.data.every(Number.isFinite)) throw new Error('AME-2 ONNX 행동 크기/유한값 오류');
      infer.offsets = Array.from(result.offsets.data, Number);
      return Float32Array.from(action.data);
    } finally { for (const tensor of Object.values(result)) tensor.dispose(); }
  };
  infer.async = true;
  infer.dispose = () => session.release();
  return infer;
}

// Loading failure and run failure both stay visible; no silent engine change.
// f32 is already verified by main.js and remains the explicit rollback choice.
export async function selectAme2Policy(f32, { backend = 'wasm', notify = () => {},
  importRuntime = (url) => import(url), fetchModel = (url) => fetch(url),
  digest = async (buffer) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)), (v) => v.toString(16).padStart(2, '0')).join(''),
} = {}) {
  if (backend === 'f32') { notify('AME-2 · f32 JS'); return f32; }
  let onnx;
  try {
    if (!['wasm', 'webgpu'].includes(backend)) throw new Error('지원하지 않는 추론 설정');
    const ort = await importRuntime(new URL(`./ort/ort.${backend === 'webgpu' ? 'webgpu' : 'wasm'}.min.mjs`, import.meta.url).href);
    ort.env.wasm.numThreads = 1; // no COOP/COEP dependency, including APK WebView
    ort.env.wasm.proxy = false;
    ort.env.wasm.wasmPaths = new URL('./ort/', import.meta.url).href;
    const response = await fetchModel(new URL('./ame2_actor.onnx', import.meta.url));
    if (!response.ok) throw new Error(`ONNX 파일 없음 (${response.status})`);
    const data = await response.arrayBuffer();
    if (await digest(data) !== AME2_ONNX_SHA256) throw new Error('ONNX SHA-256 불일치');
    onnx = await loadAme2OnnxPolicy(ort, data, backend);
    // Catch deferred initialization/kernel failure before enabling controls.
    await onnx(new Float32Array(49), new Float32Array(1131));
  } catch (e) {
    await onnx?.dispose().catch(() => {});
    notify(`AME-2 · f32 되돌림: ${e.message}`);
    return f32;
  }
  notify(`AME-2 · ONNX ${backend.toUpperCase()}`);
  let failed = false;
  const policy = async (prop, mapping) => {
    if (failed) return f32(prop, mapping);
    try { return await onnx(prop, mapping); }
    catch (e) {
      failed = true;
      notify(`AME-2 · f32 되돌림: ${e.message}`);
      await onnx.dispose().catch(() => {});
      return f32(prop, mapping);
    }
  };
  policy.async = true;
  policy.dispose = () => failed ? undefined : onnx.dispose();
  return policy;
}
