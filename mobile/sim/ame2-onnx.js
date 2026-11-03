// ame2-demo.onnx compatibility entry: named action/gaze_r outputs, no recurrent state.
import { POLICY_MODES } from './policy-modes.js';
import { loadOnnxPolicy, selectOnnxPolicy } from './policy-onnx.js';
export const AME2_ONNX_SHA256 = POLICY_MODES.ame2.onnx.sha256[POLICY_MODES.ame2.onnx.file];
export const loadAme2OnnxPolicy = (ort, model, backend = 'wasm') =>
  loadOnnxPolicy(ort, model, POLICY_MODES.ame2.onnx, backend);
export const selectAme2Policy = (f32, options) => selectOnnxPolicy(POLICY_MODES.ame2, f32, options);
