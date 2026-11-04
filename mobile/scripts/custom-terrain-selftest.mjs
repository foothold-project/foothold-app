// Node MuJoCo WASM + nvidia f32; run under the shared heavy-test flock.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SCHEMA, validateTerrain, buildTerrain, loadCustomTerrain } from '../sim/terrain/index.js';
import { decodeMap, cell } from '../sim/lidar.js';
import { findPath, fits } from '../sim/astar.js';
import { createSim, ISAAC_LIKE } from '../sim/sim.js';
import { POLICY_MODES, getPolicyMode } from '../sim/policy-modes.js';
import { makeTerrainSampler } from '../sim/policy-adapters.js';

const base = () => ({schema:SCHEMA,id:'test',name:'시험',size:[12,10],spawn:[-4,-3,0],items:[]});
const box = () => ({kind:'box',x:0,y:0,yaw:.3,sx:1,sy:1,h:.3});
const stairs = () => ({kind:'stairs',x:0,y:0,yaw:0,width:1.5,steps:4,rise:.12,run:.3});
const ramp = () => ({kind:'ramp',x:-1,y:0,yaw:.25,length:2,width:1.3,h:.6});
const gap = () => ({kind:'gap',x:2,y:0,yaw:.4,length:.5,width:2});
export const examples = [
  {...base(),id:'flat-box',items:[box()]},
  {...base(),id:'stairs-012',items:[stairs()]},
  {...base(),id:'ramp-gap',items:[ramp(),gap()]},
];
let validations=0;
const reject = (change,pattern) => {const spec=base();change(spec);const result=validateTerrain(spec);assert.ok(result.errors.some(e=>pattern.test(e.msg)),JSON.stringify(result));assert.throws(()=>buildTerrain(spec));validations++;};
assert.equal(validateTerrain(null).errors.length,1);
for(const value of [null,{},[],42,'x']) assert.ok(validateTerrain(value).errors.length);
reject(s=>s.schema='wrong',/schema/);reject(s=>s.id='../xml',/id/);reject(s=>s.id='a'.repeat(33),/id/);
reject(s=>s.name='',/이름/);reject(s=>s.size=[3,10],/4~30/);reject(s=>s.size=[10,31],/4~30/);
reject(s=>s.size=[NaN,10],/4~30/);reject(s=>s.spawn=[Infinity,0,0],/유한/);
reject(s=>s.spawn=[-5.7,0,0],/가장자리/);reject(s=>s.items=null,/목록/);
reject(s=>s.items=Array.from({length:61},box),/60개/);
reject(s=>s.items=[{kind:'unknown'}],/종류/);
reject(s=>s.items=[{...box(),yaw:NaN}],/유한/);
reject(s=>s.items=[{...box(),sx:0}],/양의/);reject(s=>s.items=[{...box(),h:1.01}],/1.0/);
reject(s=>s.items=[{...box(),x:5.8,yaw:Math.PI/4}],/전체/);
reject(s=>s.items=[{...stairs(),steps:2.5}],/정수/);
for(const rise of [.019,.251]) reject(s=>s.items=[{...stairs(),rise}],/단 높이/);
reject(s=>s.items=[{...stairs(),run:.149}],/단 깊이/);
reject(s=>s.items=[{...stairs(),steps:10}],/전체 높이/);
reject(s=>s.items=[{...ramp(),length:.5,h:.8}],/30°/);
for(const item of [box(),stairs(),ramp(),gap()]) reject(s=>{s.items=[item];s.spawn=[item.x,item.y,0];},/0.45/);
const warningCases=[{...stairs(),rise:.18},{...ramp(),h:.9},{...gap(),length:.7}];
for(const item of warningCases){const result=validateTerrain({...base(),items:[item]});assert.equal(result.errors.length,0);assert.equal(result.warnings.length,1);assert.equal(result.warnings[0].item,0);validations++;}
assert.equal(validateTerrain({...base(),items:[{...box(),h:1}]}).errors.length,0);
assert.equal(validateTerrain({...base(),items:[{...stairs(),steps:4,rise:.25,run:.15}]}).errors.length,0);
assert.equal(validateTerrain({...base(),items:[{...ramp(),length:1,h:Math.tan(Math.PI/6)}]}).errors.length,0);
assert.deepEqual(validateTerrain({...base(),items:[box()],spawn:[.5*Math.cos(.3)+.45*Math.cos(.3),.5*Math.sin(.3)+.45*Math.sin(.3),0]}).errors,[]);
const storage = raw => ({getItem:()=>raw});
for(const [raw,id,reason] of [[null,'test',/저장된/],['{','test',/JSON/],[JSON.stringify(base()),'other',/다릅니다/],[JSON.stringify({...base(),size:[1,1]}),'test',/바닥/]]) assert.throws(()=>loadCustomTerrain(storage(raw),id),reason);
assert.throws(()=>loadCustomTerrain(storage(''),null),/id/);
assert.throws(()=>loadCustomTerrain({getItem(){throw Error('blocked');}},'test'),/저장소/);
assert.deepEqual(loadCustomTerrain(storage(JSON.stringify(base())),'test'),buildTerrain(base()));

const src=process.env.FH_SIM_SRC;assert.ok(src,'FH_SIM_SRC required');
const {default:load}=await import(pathToFileURL(resolve(src,'node_modules/@mujoco/mujoco/mujoco.js')));
const mj=await load();mj.FS.mkdir('/go2');mj.FS.mkdir('/go2/assets');
for(const file of readdirSync(join(src,'assets/unitree_go2/assets')))if(file.endsWith('.obj'))mj.FS.writeFile('/go2/assets/'+file,readFileSync(join(src,'assets/unitree_go2/assets',file)));
mj.FS.writeFile('/go2/go2.xml',readFileSync(join(src,'assets/unitree_go2/go2.xml')));
const adapter=getPolicyMode(POLICY_MODES.nvidia.id),weights=readFileSync(join(src,adapter.network.file));
const policy=()=>adapter.loadPolicy(weights.buffer.slice(weights.byteOffset,weights.byteOffset+weights.byteLength));
function open(built,spawn) {
  mj.FS.writeFile('/go2/world.xml',built.xml);
  mj.FS.writeFile('/go2/scene.xml','<mujoco><include file="go2.xml"/><include file="world.xml"/></mujoco>');
  return createSim(mj,'/go2/scene.xml',ISAAC_LIKE,policy(),{floorZ:0,spawn},adapter.id);
}
const records=[];
for(const spec of examples){
  assert.deepEqual(validateTerrain(spec),{errors:[],warnings:[]});
  const built=buildTerrain(spec);assert.deepEqual(built,buildTerrain(spec),'deterministic build');
  const map=decodeMap(built.map),path=await findPath(map,{x:spec.spawn[0],y:spec.spawn[1]},{x:4,y:3});
  for(let c=0;c<map.w;c++){assert.equal(map.px[c],205);assert.equal(map.px[(map.h-1)*map.w+c],205);}
  for(let r=0;r<map.h;r++){assert.equal(map.px[r*map.w],205);assert.equal(map.px[r*map.w+map.w-1],205);}
  assert.equal(await fits(map,{x:spec.size[0]/2-.03,y:0}),false,'outer cell cannot be a goal');
  assert.equal(await fits(map,{x:spec.size[0]/2-.3,y:0}),false,'border clearance is inflated');
  assert.ok(path?.length,'A* route to distant point');
  for(const o of spec.items)assert.equal(cell(map,o.x,o.y),0,'raised/gap footprint occupied');
  const sim=open(built,spec.spawn);
  const sampler=makeTerrainSampler(mj,sim.m,sim.d,{grid:[[0,0]],rayOffset:20}),out=new Float64Array(1);
  const height=(x,y)=>{sampler([x,y,.4,1,0,0,0],out);return out[0];};
  const close=(a,b)=>assert.ok(Math.abs(a-b)<2e-6,`${spec.id}: height ${a} != ${b}`);
  try{
    close(height(-4,-3),0);
    close(height(spec.size[0]/2-.025,0),.2);
    close(height(0,-spec.size[1]/2+.025),.2);
    for(const o of spec.items){
      if(o.kind==='box')close(height(o.x,o.y),o.h);
      if(o.kind==='stairs')for(let k=0;k<o.steps;k++)close(height(o.x-(o.steps*o.run+1)/2+(k+.5)*o.run,o.y),(k+1)*o.rise);
      if(o.kind==='ramp')for(const t of [-.4,0,.4])close(height(o.x+Math.cos(o.yaw)*o.length*t,o.y+Math.sin(o.yaw)*o.length*t),o.h*(t+.5));
      if(o.kind==='gap'){
        close(height(o.x,o.y),-.5);
        for(const sign of [-1,1]){const x=o.x+sign*Math.cos(o.yaw)*(o.length/2+.02),y=o.y+sign*Math.sin(o.yaw)*(o.length/2+.02);close(height(x,y),0);}
      }
    }
    sim.hold(.5);let minZ=Infinity,maxTilt=0;
    for(let k=0;k<150;k++){sim.cmd=[0,0,0];await sim.step();const q=sim.d.qpos;assert.ok(q.every(Number.isFinite));minZ=Math.min(minZ,q[2]);maxTilt=Math.max(maxTilt,Math.acos(Math.max(-1,Math.min(1,1-2*(q[4]**2+q[5]**2)))));}
    const fallen=Number(minZ<.18||maxTilt>Math.PI/3);
    assert.equal(fallen,0,'3 s stationary posture');
    records.push({id:spec.id,seconds:3,fallen,minZ,maxTiltDeg:maxTilt*180/Math.PI,pathPoints:path.length,geoms:sim.m.ngeom});
  }finally{sampler.dispose();sim.dispose();}
}
// Drive toward the boundary with an active policy: the visible curb must
// physically stop the original 8-second fall-off reproduction.
const edgeSpec={...base(),spawn:[4,0,0]},edgeSim=open(buildTerrain(edgeSpec),edgeSpec.spawn);
let edgeMinZ=Infinity,edgeMaxX=-Infinity;
try{edgeSim.hold(.5);for(let k=0;k<400;k++){edgeSim.cmd=[.6,0,0];await edgeSim.step();edgeMinZ=Math.min(edgeMinZ,edgeSim.d.qpos[2]);edgeMaxX=Math.max(edgeMaxX,edgeSim.d.qpos[0]);}
  assert.ok(edgeMinZ>.18&&edgeMaxX<6,JSON.stringify({edgeMinZ,edgeMaxX}));
}finally{edgeSim.dispose();}
// Rotated and overlapping gaps must preserve union subtraction, including near
// boundaries; cast at their centres and exact unaffected support points.
const gapRecords=[];
for(const items of [[{...gap(),x:0,y:0,yaw:Math.PI/4},{...gap(),x:.1,y:0,yaw:-.3}],Array.from({length:60},(_,i)=>({...gap(),x:(i%10)-4.5,y:Math.floor(i/10)-2.5,length:.2,width:.2,yaw:i*.1}))]){
  const spec={...base(),spawn:[-5,-4,0],items},started=performance.now(),built=buildTerrain(spec),buildMs=performance.now()-started;
  const openStart=performance.now(),sim=open(built,spec.spawn),openMs=performance.now()-openStart;
  gapRecords.push({gaps:items.length,supportPieces:built.scene.models.length-5,buildMs,openMs});
  const sampler=makeTerrainSampler(mj,sim.m,sim.d,{grid:[[0,0]],rayOffset:20}),out=new Float64Array(1);
  try{for(const o of items){sampler([o.x,o.y,.4,1,0,0,0],out);assert.ok(Math.abs(out[0]+.5)<2e-6);}}finally{sampler.dispose();sim.dispose();}
}
const sixty={...base(),size:[20,20],spawn:[-8,-8,0],items:Array.from({length:60},(_,i)=>({...box(),x:(i%10)*1.2-5.4,y:Math.floor(i/10)*1.2-3,h:.1,sx:.4,sy:.4}))};
let t=performance.now();const built=buildTerrain(sixty),buildMs=performance.now()-t,sim=open(built,sixty.spawn),times=[];
try{sim.hold(.5);for(let k=0;k<50;k++){t=performance.now();await sim.step();times.push(performance.now()-t);}}finally{sim.dispose();}
times.sort((a,b)=>a-b);
const result={validations,examples:records,edgeBoundary:{seconds:8,minZ:edgeMinZ,maxX:edgeMaxX},gapRecords,sixtyItems:{buildMs,policyStepMsMedian:times[25],policyStepMsP95:times[47],samples:50,policyDtMs:20}};
if(process.env.TERRAIN_REPORT)writeFileSync(process.env.TERRAIN_REPORT,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
console.log('custom terrain PASS: validation/storage, shared geometry heights, gaps, 3 examples × 3 s nvidia, A*, 60-item timing');
