// Compatibility exports for existing AME-2 parity/trajectory tools.
import { getPolicyAdapter } from './policy-adapters.js';
import { loadOnnxPolicy, selectOnnxPolicy } from './policy-onnx.js';
export const AME2_ONNX_SHA256 = getPolicyAdapter('ame2-demo').onnx.sha256;
export const loadAme2OnnxPolicy = (ort, model, backend = 'wasm') =>
  loadOnnxPolicy(ort, model, getPolicyAdapter('ame2-demo').onnx, backend);
export const selectAme2Policy = (f32, options) => selectOnnxPolicy(getPolicyAdapter('ame2-demo'), f32, options);
