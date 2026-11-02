// Offline native geometry and observation regression; no gait verdict.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getPolicyAdapter, makeTerrainSampler } from '../sim/policy-adapters.js';
const {default:load}=await import(pathToFileURL(resolve(process.env.FH_SIM_SRC,'node_modules/@mujoco/mujoco/mujoco.js')));
const mj=await load(), adapter=getPolicyAdapter('ame2-demo');
// Freeze the PR's original 20m scanner for an independent before/after check.
const source=execFileSync('git',['show','2c0fc2f:mobile/sim/ame2-adapter.js'],{encoding:'utf8'})
  .replace("'./ame2-network.js'",JSON.stringify(new URL('../sim/ame2-network.js',import.meta.url).href));
const {makeAme2Adapter}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const before=makeAme2Adapter(makeTerrainSampler);
let cells=0, rooflessScans=0;
function checkScene(name,geometry,expected,{same=false,q=[0,0,.4,1,0,0,0]}={}) {
  mj.FS.writeFile('/overhead.xml',`<mujoco><compiler angle="radian"/><worldbody>${geometry}
    <geom group="1" type="box" contype="0" conaffinity="0" pos="0 0 .8" size="3 3 .1"/>
    <body pos="0 0 1"><freejoint/><geom group="1" type="box" size=".2 .2 .1"/></body></worldbody></mujoco>`);
  const m=mj.MjModel.from_xml_path('/overhead.xml'),d=new mj.MjData(m);mj.mj_forward(m,d);
  const groups=Array.from(m.geom_group), scan=adapter.makeHeightScanner(mj,m,d,{floorZ:0}), old=before.makeHeightScanner(mj,m,d,{floorZ:0});
  const actual=new Float64Array(1131), prior=new Float64Array(1131);
  try {
    scan(q,actual);old(q,prior);
    for(let i=0;i<377;i++) {
      const [x,y]=adapter.observations.height.grid[i],yaw=adapter.yawOf(q);
      const z=expected(q[0]+Math.cos(yaw)*x-Math.sin(yaw)*y,q[1]+Math.sin(yaw)*x+Math.cos(yaw)*y);
      assert.ok(Math.abs(actual[3*i+2]-Math.max(-1.5,Math.min(1.5,z-q[2]+.27)))<1e-9,`${name}/${i}`);cells++;
    }
    assert.deepEqual(Array.from(m.geom_group),groups,'upward and downward scans restore geometry groups');
    if(same) {assert.deepEqual(actual,prior,`${name}: uncovered map unchanged`);rooflessScans++;}
    else assert.ok(prior.some((v,i)=>i%3===2&&Math.abs(v-actual[i])>.1),`${name}: original scanner must see the roof`);
  } finally {scan.dispose();old.dispose();d.delete();m.delete();}
}
const floor='<geom group="4" type="plane" size="4 4 .01"/>';
const roof='<geom group="1" type="box" pos="0 0 2" size="3 3 .1"/>';
checkScene('enclosed floor',floor+roof,()=>0);
checkScene('low overhead beam',floor+'<geom group="1" type="box" pos="0 0 .65" size="3 3 .05"/>',()=>0);
const step='<geom group="1" type="box" pos=".75 0 .1" size=".45 3 .1"/>';
checkScene('roof above step',floor+step+roof,x=>x>=.3&&x<=1.2?.2:0);
checkScene('roofless high wall',floor+'<geom group="1" type="box" pos=".75 0 1" size=".45 3 1"/>',x=>x>=.3&&x<=1.2?2:0,{same:true});
// A per-cell upward probe would erase this thin training-style step ahead.
checkScene('roofless elevated stair plate',floor+'<geom group="1" type="box" pos="1.1 0 .99" size=".15 .4 .01"/>',x=>x>=.95&&x<=1.25?1:0,{same:true});
checkScene('body inside solid obstacle',floor+'<geom group="1" type="box" pos="0 0 .3" size="3 3 .5"/>',()=>.8,{same:true});
checkScene('yawed roof above step',floor+step+roof,x=>x>=.3&&x<=1.2?.2:0,{q:[0,0,.4,Math.SQRT1_2,0,0,Math.SQRT1_2]});
// Original training terrain remains bit-identical at supported positions and yaw.
const dir=new URL('../sim/assets/ame2-train-terrain/',import.meta.url);
mj.FS.writeFile('/training.xml',readFileSync(new URL('ame2-train-terrain.xml',dir)));
const meta=JSON.parse(readFileSync(new URL('metadata.json',dir)));
const m=mj.MjModel.from_xml_path('/training.xml'),d=new mj.MjData(m);mj.mj_forward(m,d);
const scan=adapter.makeHeightScanner(mj,m,d,{floorZ:0}),old=before.makeHeightScanner(mj,m,d,{floorZ:0});
const support=makeTerrainSampler(mj,m,d,{grid:[[0,0]],rayOffset:20}),height=new Float64Array(1);
try {
  for(const tile of meta.tiles) for(const dx of [0,.85,1.5]) for(const yaw of [0,Math.PI/2]) {
    const [cx,cy]=tile.center,q=[cx+dx,cy,5,Math.cos(yaw/2),0,0,Math.sin(yaw/2)];
    support(q,height);if(!Number.isFinite(height[0]))continue;
    q[2]=height[0]+.4;
    const actual=new Float64Array(1131),prior=new Float64Array(1131);scan(q,actual);old(q,prior);
    assert.deepEqual(actual,prior,`${tile.id}/${dx}/${yaw}: roofless training scene unchanged`);rooflessScans++;
  }
} finally {scan.dispose();old.dispose();support.dispose();d.delete();m.delete();}
console.log(`AME-2 overhead PASS: ${cells} analytical cell checks, ${rooflessScans} bit-identical uncovered scans; roofs removed, high walls/stair plates retained, normal/geometry exclusion/yaw`);
