// Independent analytic shapes vs native MuJoCo rays, scene triangles and grid.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildTerrain, SCHEMA } from '../sim/terrain/index.js';
import { cell, decodeMap } from '../sim/lidar.js';

const spec={schema:SCHEMA,id:'geometry',name:'Geometry',size:[12,12],spawn:[-4,-4,0],items:[
  {kind:'box',x:-2,y:-1,yaw:.47,sx:1.3,sy:1.1,h:.4},
  {kind:'stairs',x:2,y:-1,yaw:-.38,width:1.2,steps:4,rise:.12,run:.3},
  {kind:'ramp',x:-2,y:2,yaw:.28,length:2,width:1.3,h:.6},
  {kind:'gap',x:2,y:2,yaw:-.55,length:.55,width:1.7},
]};
const {default:load}=await import(pathToFileURL(resolve(process.env.FH_SIM_SRC,'node_modules/@mujoco/mujoco/mujoco.js')));
const mj=await load(),built=buildTerrain(spec),map=decodeMap(built.map);
mj.FS.writeFile('/geometry.xml',built.xml);
const m=mj.MjModel.from_xml_path('/geometry.xml'),d=new mj.MjData(m),hit=new mj.IntBuffer(1);
mj.mj_forward(m,d);
const triangles=[];
for(const md of built.scene.models){
  assert.equal(md.flat_shading,true);
  const mesh=built.scene.meshes[md.mesh],yaw=2*Math.atan2(md.quat[3],md.quat[0]),c=Math.cos(yaw),s=Math.sin(yaw),vertices=[];
  for(let k=0;k<mesh.p.length;k+=3)vertices.push([md.pos[0]+c*mesh.p[k]-s*mesh.p[k+1],md.pos[1]+s*mesh.p[k]+c*mesh.p[k+1],md.pos[2]+mesh.p[k+2]]);
  for(let k=0;k<mesh.i.length;k+=3)triangles.push(mesh.i.slice(k,k+3).map(i=>vertices[i]));
}
function sceneHeight(x,y){
  let height=-Infinity;
  for(const [a,b,c] of triangles){
    const ux=b[0]-a[0],uy=b[1]-a[1],vx=c[0]-a[0],vy=c[1]-a[1],det=ux*vy-uy*vx;
    if(Math.abs(det)<1e-12)continue;
    const dx=x-a[0],dy=y-a[1],u=(dx*vy-dy*vx)/det,v=(ux*dy-uy*dx)/det;
    if(u>=-1e-9&&v>=-1e-9&&u+v<=1+1e-9)height=Math.max(height,a[2]+u*(b[2]-a[2])+v*(c[2]-a[2]));
  }
  return height;
}
function expected(x,y){
  if(Math.abs(x)>5.95||Math.abs(y)>5.95)return .2;
  let height=0;
  for(const o of spec.items){
    const c=Math.cos(o.yaw),s=Math.sin(o.yaw),u=c*(x-o.x)+s*(y-o.y),v=-s*(x-o.x)+c*(y-o.y);
    const length=o.kind==='box'?o.sx:o.kind==='stairs'?o.steps*o.run+1:o.length,width=o.kind==='box'?o.sy:o.width;
    // Stay clear of raster conservatism and vertical-face ray ambiguity.
    if(Math.abs(Math.abs(u)-length/2)<.065&&Math.abs(v)<width/2+.065||Math.abs(Math.abs(v)-width/2)<.065&&Math.abs(u)<length/2+.065)return null;
    if(Math.abs(u)>=length/2||Math.abs(v)>=width/2)continue;
    if(o.kind==='box')height=o.h;
    if(o.kind==='gap')height=-.5;
    if(o.kind==='ramp')height=(u/length+.5)*o.h;
    if(o.kind==='stairs'){
      const progress=(u+length/2)/o.run;
      if(progress<o.steps&&Math.abs(progress-Math.round(progress))*o.run<.02)return null;
      height=Math.min(o.steps,Math.floor(progress)+1)*o.rise;
    }
  }
  return height;
}
let checks=0,maxPhysicsError=0,maxSceneError=0;
try{
  for(let row=0;row<149;row++)for(let col=0;col<149;col++){
    const x=-5.92+col*.08,y=-5.92+row*.08,want=expected(x,y);if(want===null)continue;
    const distance=mj.mj_ray(m,d,[x,y,3],[0,0,-1],[0,1,0,0,0,0],true,-1,hit,null);
    assert.ok(distance>=0);const physics=3-distance,scene=sceneHeight(x,y);
    maxPhysicsError=Math.max(maxPhysicsError,Math.abs(physics-want));maxSceneError=Math.max(maxSceneError,Math.abs(scene-want));
    assert.ok(Math.abs(physics-want)<2e-6,`${x},${y}: physics ${physics} != ${want}`);
    assert.ok(Math.abs(scene-want)<1e-9,`${x},${y}: scene ${scene} != ${want}`);
    assert.equal(cell(map,x,y),want===0?254:0,`${x},${y}: grid`);checks++;
  }
  for(const [x,y] of [[5.975,0],[-5.975,0],[0,5.975],[0,-5.975]]){
    assert.equal(cell(map,x,y),205);assert.ok(Math.abs(sceneHeight(x,y)-.2)<1e-9);
    assert.ok(Math.abs(3-mj.mj_ray(m,d,[x,y,3],[0,0,-1],[0,1,0,0,0,0],true,-1,hit,null)-.2)<1e-6);
  }
}finally{hit.delete();d.delete();m.delete();}
// Immutable before/after fixture: spread, rotated gaps with no touching pairs.
const gaps={...spec,items:Array.from({length:60},(_,i)=>({kind:'gap',x:(i%10)-4.5,y:Math.floor(i/10)-2.5,yaw:i*.1,length:.2,width:.2}))};
const beforeSource=execFileSync('git',['show','92a7eda:mobile/sim/terrain/index.js'],{encoding:'utf8'});
const before=await import('data:text/javascript;base64,'+Buffer.from(beforeSource).toString('base64'));
const old=before.buildTerrain(gaps),after=buildTerrain(gaps);
const pieces={before:old.scene.models.length-1,after:after.scene.models.length-5};
assert.ok(pieces.after<pieces.before/2,JSON.stringify(pieces));
const report={checks,maxPhysicsError,maxSceneError,border:'4 native/scene 0.2 m curb heights and unknown cells',sixtyGapPieces:pieces};
if(process.env.TERRAIN_GEOMETRY_REPORT)writeFileSync(process.env.TERRAIN_GEOMETRY_REPORT,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));console.log('custom terrain geometry PASS: analytic = native physics = rendered triangles = grid');
