import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSim,ISAAC_LIKE } from '../sim/sim.js';
import { loadAme2Policy } from '../sim/ame2-network.js';
import { loadAme2OnnxPolicy } from '../sim/ame2-onnx.js';
import { compareAme2Walk } from '../sim/ame2-onnx-walk.js';
assert.ok(process.env.FH_SIM_SRC && process.env.AME2_EXPORT && process.env.AME2_ORT_NODE);
const src=process.env.FH_SIM_SRC,dir=process.env.AME2_EXPORT;
const {default:load}=await import(pathToFileURL(resolve(src,'node_modules/@mujoco/mujoco/mujoco.js')));
const mj=await load();mj.FS.mkdir('/go2');mj.FS.mkdir('/go2/assets');
for(const f of readdirSync(join(src,'assets/unitree_go2/assets')))if(f.endsWith('.obj'))mj.FS.writeFile('/go2/assets/'+f,readFileSync(join(src,'assets/unitree_go2/assets',f)));
mj.FS.writeFile('/go2/go2.xml',readFileSync(join(src,'assets/unitree_go2/go2.xml')));
const data=readFileSync(join(dir,'ame2_actor.f32'));
const f32=loadAme2Policy(data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength),JSON.parse(readFileSync(join(dir,'ame2_actor.json'))));
const ort=await import(pathToFileURL(resolve(process.env.AME2_ORT_NODE)));
const onnx=await loadAme2OnnxPolicy(ort,readFileSync(join(dir,'ame2_actor.onnx')),'cpu');
try {
  const result=await compareAme2Walk(mj,createSim,ISAAC_LIKE,f32,onnx,async(path)=>readFileSync(new URL('../sim/'+path,import.meta.url)));
  writeFileSync('runs/ame2-onnx/walk-node.json',JSON.stringify(result));
  writeFileSync('runs/ame2-onnx/observations.json',JSON.stringify(result.observations));
  console.log(JSON.stringify(result.records.map(({trajectories,...summary})=>summary)));
} finally {await onnx.dispose();}

// Controlled delayed inference exercises actual simulation, not a mocked latch.
mj.FS.writeFile('/go2/flat.xml','<mujoco><include file="go2.xml"/><worldbody><geom type="plane" size="10 10 .01"/></worldbody></mujoco>');
let complete,calls=0;
const delayed=()=>{calls++;return new Promise(r=>{complete=r;});};delayed.async=true;
const sim=createSim(mj,'/go2/flat.xml',ISAAC_LIKE,delayed,{floorZ:0,spawn:[0,0,0]},'ame2-demo',{ame2DelaySteps:4});
try {
  for(const action of ['clearPolicyState','reset','dispose']) {
    const pending=sim.step();await Promise.resolve();
    assert.equal(sim.step(),false,'no overlapping inference');
    const time=sim.d.time;
    sim[action]();
    complete(new Float32Array(12).fill(1));
    assert.equal(await pending,false,'late action discarded');
    if(action!=='dispose') {assert.equal(sim.t,0);assert.equal(sim.d.time,action==='reset'?0:time);}
  }
  assert.equal(calls,3);
  console.log('AME2 ONNX async PASS: no overlap, immediate clear/reset/dispose, stale results discarded without physics');
} catch(e){throw e;}
