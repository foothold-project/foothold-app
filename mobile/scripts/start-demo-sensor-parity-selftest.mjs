// Conservative camera culling must preserve all 3600 native MuJoCo rays.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeStartDemoDepth } from '../sim/start-demo-sensors.js';
const src=process.env.FH_SIM_SRC;
const { default:load }=await import(pathToFileURL(resolve(src,'node_modules/@mujoco/mujoco/mujoco.js')));
const mj=await load();mj.FS.mkdir('/go2');mj.FS.mkdir('/go2/assets');
mj.FS.writeFile('/go2/go2.xml',readFileSync(join(src,'assets/unitree_go2/go2.xml')));
for(const file of readdirSync(join(src,'assets/unitree_go2/assets')))if(file.endsWith('.obj'))mj.FS.writeFile('/go2/assets/'+file,readFileSync(join(src,'assets/unitree_go2/assets',file)));
let max=0,n=0;
for(const id of ['warehouse','factory-inspection','element-course']){
  const root=new URL('../sim/assets/'+id+'/',import.meta.url),map=JSON.parse(readFileSync(new URL('map.json',root)));
  for(const file of map.physics_assets??[]){const data=readFileSync(new URL(file,root));mj.FS.writeFile('/go2/'+file,data);mj.FS.writeFile('/go2/assets/'+file,data);}
  mj.FS.writeFile('/go2/world.xml',readFileSync(new URL(id+'.xml',root)));
  mj.FS.writeFile('/go2/scene.xml','<mujoco><include file="go2.xml"/><include file="world.xml"/></mujoco>');
  const m=mj.MjModel.from_xml_path('/go2/scene.xml'),d=new mj.MjData(m);mj.mj_forward(m,d);
  const native=makeStartDemoDepth(mj,m,d,{cull:false}),filtered=makeStartDemoDepth(mj,m,d);
  const groups=Array.from(m.geom_group);
  let sceneMax=0;
  try{
    for(let i=0;i<12;i++){
      const yaw=i*Math.PI/6,pitch=(i%3-1)*.3,roll=(i%2?1:-1)*.2;
      const cy=Math.cos(yaw/2),sy=Math.sin(yaw/2),cp=Math.cos(pitch/2),sp=Math.sin(pitch/2),cr=Math.cos(roll/2),sr=Math.sin(roll/2);
      const q=[map.spawn_xyyaw[0]+(i%4)*.5,map.spawn_xyyaw[1]+Math.floor(i/4)*.5,map.floor_z+.3,
        cr*cp*cy+sr*sp*sy,sr*cp*cy-cr*sp*sy,cr*sp*cy+sr*cp*sy,cr*cp*sy-sr*sp*cy];
      const expected=native(q),actual=filtered(q);
      for(let j=0;j<3600;j++){const error=Math.abs(expected[j]-actual[j]);max=Math.max(max,error);sceneMax=Math.max(sceneMax,error);n++;}
      assert.deepEqual(Array.from(m.geom_group),groups,'all geometry groups restored');
    }
  }finally{native.dispose();filtered.dispose();d.delete();m.delete();}
  console.log(`${id}: depth culling max ${sceneMax}`);
}
assert.equal(max,0);
console.log(`start-demo sensor parity PASS: ${n} rays, 3 scenes × 12 full-body poses, filtered vs unfiltered native max ${max}`);
