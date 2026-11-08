// AME2_EXPORT + AME2_ORT_NODE=<private onnxruntime-node entry>.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadAme2Policy } from '../sim/ame2-network.js';
import { fixedAme2Cases, compareAme2Cases } from '../sim/ame2-onnx-check.js';
const dir = process.env.AME2_EXPORT;
assert.ok(dir && process.env.AME2_ORT_NODE);
const ort = await import(pathToFileURL(resolve(process.env.AME2_ORT_NODE)));
const read = (name) => readFileSync(join(dir,name));
const bytes = read('ame2_actor.f32');
const f32 = loadAme2Policy(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), JSON.parse(read('ame2_actor.json')));
const fixed = fixedAme2Cases(JSON.parse(read('check.json')));
console.log(JSON.stringify({ environment:'Node CPU', node:process.version, fixed:await compareAme2Cases(ort, readFileSync(join(process.env.FH_AME2_SRC || dir, 'ame2-demo.onnx')), read('ame2_actor_crop_test.onnx'), f32, fixed, 'cpu') }));
if (existsSync(join(dir,'onnx-observations.json'))) console.log(JSON.stringify({ environment:'Node CPU', recorded:await compareAme2Cases(ort, readFileSync(join(process.env.FH_AME2_SRC || dir, 'ame2-demo.onnx')), read('ame2_actor_crop_test.onnx'), f32, JSON.parse(read('onnx-observations.json')), 'cpu') }));
