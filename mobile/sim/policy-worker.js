// Same-origin module Worker: only inference lives here, never physics or input.
import { loadOnnxPolicy, warmupInputs } from './policy-onnx.js';
let policy;
self.onmessage = async ({ data: { type, seq, model, contract, backend, inputs } }) => {
  try {
    if (type === 'init') {
      const ort = await import(`./ort/ort.${backend === 'webgpu' ? 'webgpu' : 'wasm'}.min.mjs`);
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
      ort.env.wasm.wasmPaths = new URL('./ort/', import.meta.url).href;
      policy = await loadOnnxPolicy(ort, model, contract, backend);
      await policy(...warmupInputs(contract));
      self.postMessage({ type: 'ready', seq });
    } else if (type === 'infer') {
      const outputs = await policy(...inputs);
      self.postMessage({ type: 'result', seq, outputs }, [...new Set(Object.values(outputs).map((v) => v.buffer))]);
    }
  } catch (error) {
    self.postMessage({ type: 'error', seq, error: error.message });
  }
};
