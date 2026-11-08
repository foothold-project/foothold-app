// Local Node 22 + MuJoCo, no services or robot. FH_SIM_SRC required.
// --baseline=world.xml records evidence without asserting the repaired supports.
// --output=path writes the full 10cm world table and grouped >10cm differences.
// --dynamics additionally records a standing robot and manual/automatic entry.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSim, ISAAC_LIKE, loadPolicy } from '../sim/sim.js';
import { decodeMap, cell, makeLidar } from '../sim/lidar.js';
import { findPath, fits } from '../sim/astar.js';
import { createScenarioRunner, frontDistance } from '../sim/scenario.js';

const arg = (name) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const src = process.env.FH_SIM_SRC;
assert.ok(src, 'FH_SIM_SRC required');
const dir = new URL('../sim/assets/collapsed-house-v2/', import.meta.url);
const scene = JSON.parse(readFileSync(new URL('scene.json', dir)));
const map = decodeMap(JSON.parse(readFileSync(new URL('map.json', dir))));
if(!arg('baseline'))assert.ok(map.physics_assets.length<=8,'compatible with main.js terrain-file limit');
const { default: load } = await import(pathToFileURL(resolve(src, 'node_modules/@mujoco/mujoco/mujoco.js')));
const mj = await load();
mj.FS.mkdir('/go2'); mj.FS.mkdir('/go2/assets');
for (const f of map.physics_assets) for (const prefix of ['/go2/', '/go2/assets/']) mj.FS.writeFile(prefix+f, readFileSync(new URL(f, dir)));
if(arg('baseline-height'))for(const prefix of ['/go2/','/go2/assets/'])mj.FS.writeFile(prefix+'height.png',readFileSync(arg('baseline-height')));
mj.FS.writeFile('/go2/world.xml', readFileSync(arg('baseline') ?? new URL('collapsed-house-v2.xml', dir)));
const triangles = [];
for (const model of scene.models) {
  const mesh = scene.meshes[model.mesh], p = mesh.p, q = model.quat;
  // All exported house assets currently have identity rotations. Fail if that changes.
  assert.deepEqual(q, [1, 0, 0, 0]);
  for (let i = 0; i < mesh.i.length; i += 3) {
    triangles.push([0, 1, 2].map(j => p.slice(mesh.i[i+j]*3, mesh.i[i+j]*3+3).map((v,k) => v+model.pos[k])));
  }
}
function intersection(t, x, y) {
  const [a,b,c] = t, det = (b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1]);
  if (Math.abs(det)<1e-12) return -Infinity;
  const u=((b[1]-c[1])*(x-c[0])+(c[0]-b[0])*(y-c[1]))/det;
  const v=((c[1]-a[1])*(x-c[0])+(a[0]-c[0])*(y-c[1]))/det;
  return u>=-1e-8&&v>=-1e-8&&u+v<=1+1e-8 ? u*a[2]+v*b[2]+(1-u-v)*c[2] : -Infinity;
}
// Avoid exact box edges: MuJoCo and the visual barycentric tolerance differ
// there by floating point ulps, creating whole artificial boundary rows.
const n=260, res=.1, origin=-12.9999, visual=new Float64Array(n*n).fill(-.02), low=visual.slice();
for (const t of triangles) {
  const lo=[0,1].map(k=>Math.min(...t.map(p=>p[k]))), hi=[0,1].map(k=>Math.max(...t.map(p=>p[k])));
  for(let r=Math.max(0,Math.ceil((lo[1]-origin)/res-.5));r<=Math.min(n-1,Math.floor((hi[1]-origin)/res-.5));r++)
    for(let c=Math.max(0,Math.ceil((lo[0]-origin)/res-.5));c<=Math.min(n-1,Math.floor((hi[0]-origin)/res-.5));c++) {
      const z=intersection(t,origin+(c+.5)*res,origin+(r+.5)*res), i=r*n+c;
      visual[i]=Math.max(visual[i],z);
      if(Math.max(...t.map(p=>p[2]))<=1.30) low[i]=Math.max(low[i],z);
    }
}
const m=mj.MjModel.from_xml_path('/go2/world.xml'), d=new mj.MjData(m), hit=new mj.IntBuffer(1);
mj.mj_forward(m,d);
function ray(x,y,z=8,groups=[1,1,0,0,1,0]) {
  const distance=mj.mj_ray(m,d,[x,y,z],[0,0,-1],groups,true,-1,hit,null);
  return {z:distance<0?null:z-distance,geom:hit.GetView()[0]<0?null:mj.mj_id2name(m,mj.mjtObj.mjOBJ_GEOM.value,hit.GetView()[0])};
}
const rows=[];
for(let r=0;r<n;r++) for(let c=0;c<n;c++) {
  const i=r*n+c,x=origin+(c+.5)*res,y=origin+(r+.5)*res,h=ray(x,y),l=ray(x,y,1.31);
  rows.push({x,y,visible:visual[i],collision:h.z,gap:visual[i]-h.z,geom:h.geom,lowVisible:low[i],lowCollision:l.z,lowGap:low[i]-l.z});
}
function groups(key,sign=1) {
  const left=new Set(rows.flatMap((p,i)=>sign*p[key]>.10?[i]:[])), out=[];
  while(left.size) {
    const queue=[left.values().next().value];left.delete(queue[0]);
    for(let j=0;j<queue.length;j++) {const i=queue[j],r=Math.floor(i/n),c=i%n;
      for(const k of [r>0?i-n:-1,r<n-1?i+n:-1,c>0?i-1:-1,c<n-1?i+1:-1]) if(left.delete(k)) queue.push(k);
    }
    const points=queue.map(i=>rows[i]), max=points.reduce((a,b)=>sign*a[key]>sign*b[key]?a:b);
    out.push({cells:queue.length,bounds:[Math.min(...points.map(p=>p.x)),Math.min(...points.map(p=>p.y)),Math.max(...points.map(p=>p.x)),Math.max(...points.map(p=>p.y))],maxGap:sign*max[key],worst:max});
  }
  return out.sort((a,b)=>b.cells-a.cells);
}
const supports=[[4.60,-6.00],[4.60,-5.95],[4.60,-5.90],[5.05,-6.00]].map(([x,y])=>{
  const visible=Math.max(-.02,...triangles.map(t=>intersection(t,x,y)).filter(z=>z<=1.30)),collision=ray(x,y,1.31);
  if(!arg('baseline')) assert.ok(Math.abs(visible-collision.z)<.02,`support at ${x},${y}: ${visible} vs ${collision.z}`);
  return {x,y,visible,...collision,gap:visible-collision.z};
});
const path=await findPath(map,{x:3.85,y:-9.35},{x:3.85,y:-4.85});
assert.ok(path?.length,'entrance route remains open');
const entrance=[];
for(let i=0;i<16;i++) {const x=3.85,y=-9.35+i*.3; assert.equal(cell(map,x,y),254);assert.ok(await fits(map,{x,y}));entrance.push({x,y,raw:cell(map,x,y)});}
const result={grid:{res,n,origin},summary:{missing:rows.filter(p=>p.gap>.1).length,maxGap:Math.max(...rows.map(p=>p.gap)),lowMissing:rows.filter(p=>p.lowGap>.1).length,lowMaxGap:Math.max(...rows.map(p=>p.lowGap)),excess:rows.filter(p=>p.gap<-.1).length},groups:groups('gap'),lowGroups:groups('lowGap'),excessGroups:groups('gap',-1),supports,path,entrance,rows};
const dustId=mj.mj_name2id(m,mj.mjtObj.mjOBJ_GEOM.value,'dust_floor');
result.mapComparison={checked:0,mismatches:[]};
for(let r=0;r<map.h;r+=10)for(let c=0;c<map.w;c+=10) {
  const x=map.origin[0]+(c+.5)*map.res,y=map.origin[1]+(r+.5)*map.res;
  if(Math.abs(x)<=8.4&&Math.abs(y)<=6.8||Math.abs(x-3.85)<.95&&y<-3.4&&y>-10)continue;
  // Group 4 also contains rubble. Sample the named dust heightfield directly
  // so the occupancy threshold cannot move up with the obstacle being tested.
  const distance=mj.mj_rayHfield(m,d,dustId,[x,y,8],[0,0,-1],null);
  const contact=ray(x,y).z,dust=distance<0?-.02:8-distance,threshold=dust+.15;
  // Quantization and dust-triangle raster error can move threshold-edge cells.
  if(Math.abs(contact-threshold)<.01)continue;
  const expected=contact>threshold?0:254,actual=cell(map,x,y);
  result.mapComparison.checked++;
  if(expected!==actual)result.mapComparison.mismatches.push({x,y,contact,dust,expected,actual});
}
const lidar=makeLidar(mj,m,d);
result.stopProbes=[[4.2,-6,1.6,0],[3.85,-7.2,1,Math.PI/2]].map(([x,y,z,yaw])=>{
  const front=frontDistance(lidar(x,y,z+.1,yaw));
  const mock={cmd:[0,0,0],d:{qpos:[x,y,z,Math.cos(yaw/2),0,0,Math.sin(yaw/2)]}};
  const runner=createScenarioRunner(mock,()=>false);runner.start([{x:x+2*Math.cos(yaw),y:y+2*Math.sin(yaw)}]);runner.tick(front,.02);
  return {x,y,z,yaw,front,automaticStatus:runner.status,automaticCommand:mock.cmd,manualCommand:[.4,0,0]};
});
result.summary.maxExcess=Math.max(...rows.map(p=>-p.gap));
const exterior=rows.filter(p=>Math.abs(p.x)>8.4||Math.abs(p.y)>6.8);
result.summary.exteriorExcess=exterior.filter(p=>p.gap<-.1).length;
result.summary.exteriorMaxExcess=Math.max(...exterior.map(p=>-p.gap));
if(arg('output'))writeFileSync(arg('output'),JSON.stringify(result));
if(!arg('baseline')) {
  assert.deepEqual(result.mapComparison.mismatches,[],'exterior map occupancy follows actual loaded contacts');
  // A heightfield interpolates discontinuous rock edges. Permit at most five
  // 10cm samples, each within one 2.5cm cell of actual material at that height;
  // broad boxes across empty space cannot satisfy this footprint check.
  const excess=exterior.filter(p=>p.gap<-.1);
  assert.ok(excess.length<=5,'exterior >10cm excess stays confined to sparse fragment edges');
  for(const p of excess) {
    let nearby=-.02;
    for(const dx of [-.025,0,.025])for(const dy of [-.025,0,.025])
      for(const t of triangles)nearby=Math.max(nearby,intersection(t,p.x+dx,p.y+dy));
    assert.ok(nearby>=p.collision-.02,`exterior contact bridges a gap wider than 2.5cm at ${p.x},${p.y}`);
  }
  // Original low house supports, including faces hidden underneath the roof.
  const supports=rows.filter(p=>p.lowVisible>.6&&p.lowVisible<1.22);
  assert.ok(supports.length>1000);
  assert.ok(supports.every(p=>p.lowGap<.02),'all sampled low house support faces have physical support');
}
hit.delete();d.delete();m.delete();
if(process.argv.includes('--dynamics')) {
  for(const f of readdirSync(join(src,'assets/unitree_go2/assets'))) if(f.endsWith('.obj')) mj.FS.writeFile(`/go2/assets/${f}`,readFileSync(join(src,'assets/unitree_go2/assets',f)));
  mj.FS.writeFile('/go2/go2.xml',readFileSync(join(src,'assets/unitree_go2/go2.xml')));
  mj.FS.writeFile('/go2/scene.xml','<mujoco><include file="go2.xml"/><include file="world.xml"/></mujoco>');
  const w=readFileSync(join(src,'policy_v2.f32')), policy=loadPolicy(w.buffer.slice(w.byteOffset,w.byteOffset+w.byteLength));
  result.dynamics=[];
  for(const mode of ['support','manual','automatic']) {
    const sim=createSim(mj,'/go2/scene.xml',ISAAC_LIKE,policy,{floorZ:mode==='support'?1.148:-.02,spawn:mode==='support'?[4.4,-5.85,0]:[3.85,-9.35,Math.PI/2]});
    try {
      const feet=['FL','FR','RL','RR'].map(name=>mj.mj_name2id(sim.m,mj.mjtObj.mjOBJ_GEOM.value,name));
      assert.ok(feet.every(g=>g>=0));
      const scan=makeLidar(mj,sim.m,sim.d),runner=createScenarioRunner(sim,()=>false);
      if(mode==='automatic')runner.start([{x:3.85,y:-4.85}]);
      const trajectory=[];let maxPenetration=0,minFront=Infinity,front=Infinity;
      for(let k=0;k<(mode==='support'?150:600);k++) {
        const q=sim.d.qpos;
        // Match the app's 10Hz lidar, rather than doing a 360-ray scan on
        // every 50Hz policy tick. Standing support evidence needs no lidar.
        if(mode!=='support'&&k%5===0)front=frontDistance(scan(q[0],q[1],q[2]+.1,2*Math.atan2(q[6],q[3])));
        minFront=Math.min(minFront,front);
        if(mode==='automatic') {runner.tick(front,.02);if(!runner.active)break;}
        else sim.cmd=mode==='manual'?[.4,0,0]:[0,0,0];
        sim.step();assert.ok(sim.d.qpos.every(Number.isFinite));
        if(k%10===0) {
          const foot=feet.map(g=>{const p=Array.from(sim.d.geom_xpos.slice(g*3,g*3+3));const visible=Math.max(-.02,...triangles.map(t=>intersection(t,p[0],p[1])).filter(z=>z<=1.30));const penetration=visible-(p[2]-sim.m.geom_size[g*3]);maxPenetration=Math.max(maxPenetration,penetration);return {p,visible,penetration};});
          trajectory.push({t:sim.t,q:Array.from(sim.d.qpos.slice(0,7)),foot});
        }
      }
      result.dynamics.push({mode,seconds:sim.t,status:runner.status,minFront,maxPenetration,final:Array.from(sim.d.qpos.slice(0,7)),trajectory});
    }finally{sim.dispose();}
  }
}
if(arg('output'))writeFileSync(arg('output'),JSON.stringify(result));
console.log(JSON.stringify({...result,rows:undefined,groups:result.groups.slice(0,8),lowGroups:result.lowGroups.slice(0,8),excessGroups:result.excessGroups.slice(0,8),dynamics:result.dynamics?.map(({trajectory,...r})=>r)},null,2));
