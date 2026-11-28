// Conservative camera culling must preserve all 3600 native MuJoCo rays, and
// the static-geometry index (per-geometry rays, JS for world-aligned boxes and
// planes) must give the same frame bit for bit as mj_multiRay with and without
// culling. 'many-boxes' is a generated 6000-box yard (some boxes turned, so
// both the JS and the native per-geometry paths are used); factory-site (~6300
// boxes) runs when its assets are present.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeStartDemoDepth, makeStartDemoMap, rayBoxAligned, rayPlaneAligned } from '../sim/start-demo-sensors.js';
import { makeTerrainSampler } from '../sim/policy-modes.js';
const src=process.env.FH_SIM_SRC;
const { default:load }=await import(pathToFileURL(resolve(src,'node_modules/@mujoco/mujoco/mujoco.js')));
const mj=await load();mj.FS.mkdir('/go2');mj.FS.mkdir('/go2/assets');
mj.FS.writeFile('/go2/go2.xml',readFileSync(join(src,'assets/unitree_go2/go2.xml')));
for(const file of readdirSync(join(src,'assets/unitree_go2/assets')))if(file.endsWith('.obj'))mj.FS.writeFile('/go2/assets/'+file,readFileSync(join(src,'assets/unitree_go2/assets',file)));
let max=0,n=0,maxMap=0,mapCells=0;
const poses=Number(process.env.START_DEMO_PARITY_POSES??12);
let seed=270;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
// World-aligned box / plane in JS == mju_rayGeom (types 6 / 0), bit for bit.
{
  const I=Float64Array.of(1,0,0,0,1,0,0,0,1);let s=7;const r=()=>{s=(Math.imul(s,1664525)+1013904223)>>>0;return s/4294967296;};
  let rays=0,hits=0;
  for(let k=0;k<100000;k++){
    const plane=k%2===1,pos=Float64Array.of(r()*900,-r()*560,plane?0:r()*.5),size=plane?(k%4===1?Float64Array.of(0,0,.05):Float64Array.of(1+r()*20,1+r()*20,.05)):Float64Array.of(.25+r()*30,.25+r()*30,.1+r()*.5);
    const p=Float64Array.of(pos[0]+(r()-.5)*8,pos[1]+(r()-.5)*8,pos[2]+.1+r()*.5),v=Float64Array.of(r()-.5,r()-.5,-r()*.9),L=Math.hypot(...v);for(let i=0;i<3;i++)v[i]/=L;
    const native=mj.mju_rayGeom(pos,I,size,p,v,plane?0:6,null),js=(plane?rayPlaneAligned:rayBoxAligned)(pos,size,p,v);
    assert.ok(Object.is(native,js),`ray ${k}: native ${native} js ${js}`);rays++;if(native>=0)hits++;
  }
  console.log(`aligned box/plane rays: ${rays} (${hits} hits) identical to mju_rayGeom`);
}
// (x, y, yaw) next to walls / equipment / open ground, from the 0.5 m and 0.05 m grids.
const FIXED={
  'factory-site':[[350,-260,-1.5708],[350,-258.8,1.5708],[392.8571,-142.8571,1.5708],[392.8571,-100,0],[450,-284.5,0],[884.5,-194.2857,3.1416],
    [564.2857,-261.4286,-1.5708],[188.5,-520.7,0],[263.1,-483.4,1.1781],[822.6,-483.4,0],[39.3,-371.5,4.3197],[76.6,-371.5,4.3197],[113.9,-371.5,4.3197]],
  'plant-a':[[2,2,.7],[10,5,3],[20,8,-1.2],[30,15,2.2],[1,1,2.3562],[4.7,1,5.1051],[15.8,1,1.1781],[19.5,1,3.927],[26.9,1,1.1781],[30.6,1,3.927]],
};
// 6000 boxes on a 100 x 60 grid (1.5 m pitch, 0.5~1.1 m wide), every 7th turned by a fixed yaw.
const manyBoxes=()=>{
  const boxes=[];for(let i=0;i<100;i++)for(let j=0;j<60;j++){const k=i*60+j,w=.25+(k%5)*.06,h=.2+(k%7)*.1;
    boxes.push(`<geom type="box" size="${w} ${w} ${h}" pos="${i*1.5} ${j*1.5} ${h}"${k%7===0?` euler="0 0 ${(k%13)*7}"`:''}/>`);}
  return `<mujoco><worldbody><geom name="ground" type="box" size="100 60 .1" pos="75 45 -.1"/>${boxes.join('')}</worldbody></mujoco>`;
};
FIXED['many-boxes']=[[.75,.75,0],[.75,.75,.785],[30.75,20.25,1.5708],[60.75,44.25,3.1416],[148.5,88.5,-2.356],[75.75,45.75,.3]];
const scenes=['warehouse','factory-inspection','element-course','plant-a','many-boxes',
  ...(existsSync(new URL('../sim/assets/factory-site/map.json',import.meta.url))?['factory-site']:[])];
for(const id of scenes){
  const root=new URL('../sim/assets/'+id+'/',import.meta.url),map=id==='many-boxes'?{spawn_xyyaw:[.75,.75,0],floor_z:0}:JSON.parse(readFileSync(new URL('map.json',root)));
  for(const file of map.physics_assets??[]){const data=readFileSync(new URL(file,root));mj.FS.writeFile('/go2/'+file,data);mj.FS.writeFile('/go2/assets/'+file,data);}
  mj.FS.writeFile('/go2/world.xml',id==='many-boxes'?manyBoxes():readFileSync(new URL(id+'.xml',root)));
  mj.FS.writeFile('/go2/scene.xml','<mujoco><include file="go2.xml"/><include file="world.xml"/></mujoco>');
  const m=mj.MjModel.from_xml_path('/go2/scene.xml'),d=new mj.MjData(m);mj.mj_forward(m,d);
  const native=makeStartDemoDepth(mj,m,d,{cull:false}),filtered=makeStartDemoDepth(mj,m,d),legacy=makeStartDemoDepth(mj,m,d,{index:false});
  const nativeMap=makeStartDemoMap(mj,m,d,makeTerrainSampler,{fastVertical:false}),fastMap=makeStartDemoMap(mj,m,d,makeTerrainSampler);
  const groups=Array.from(m.geom_group);
  let sceneMax=0;
  try{
    for(const [x,y,yaw] of FIXED[id]??[]){
      const q=[x,y,map.floor_z+.3,Math.cos(yaw/2),0,0,Math.sin(yaw/2)];
      const expected=Array.from(native(q)),actual=filtered(q),old=legacy(q);
      for(let j=0;j<3600;j++){assert.ok(Object.is(expected[j],actual[j])&&Object.is(expected[j],old[j]),`${id} (${x}, ${y}) ray ${j}`);n++;}
    }
    for(let i=0;i<poses;i++){
      const yaw=i<12?i*Math.PI/6:(random()*2-1)*Math.PI,pitch=i<12?(i%3-1)*.3:(random()*2-1)*.4,roll=i<12?(i%2?1:-1)*.2:(random()*2-1)*.3;
      const cy=Math.cos(yaw/2),sy=Math.sin(yaw/2),cp=Math.cos(pitch/2),sp=Math.sin(pitch/2),cr=Math.cos(roll/2),sr=Math.sin(roll/2);
      const q=[map.spawn_xyyaw[0]+(i<12?(i%4)*.5:(random()*2-1)*8),map.spawn_xyyaw[1]+(i<12?Math.floor(i/4)*.5:(random()*2-1)*8),map.floor_z+(i<12?.3:.15+random()*.5),
        cr*cp*cy+sr*sp*sy,sr*cp*cy-cr*sp*sy,cr*sp*cy+sr*cp*sy,cr*cp*sy-sr*sp*cy];
      const expected=Array.from(native(q)),actual=filtered(q),old=legacy(q);
      for(let j=0;j<3600;j++)assert.ok(Object.is(actual[j],old[j]),`${id} pose ${i} ray ${j}: index vs mj_multiRay cull`);
      const expectedMap=nativeMap(q),actualMap=fastMap(q);
      for(let j=0;j<3600;j++){const error=Math.abs(expected[j]-actual[j]);max=Math.max(max,error);sceneMax=Math.max(sceneMax,error);n++;}
      for(let j=0;j<512;j++){maxMap=Math.max(maxMap,Math.abs(expectedMap[j]-actualMap[j]));mapCells++;}
      assert.deepEqual(Array.from(m.geom_group),groups,'all geometry groups restored');
    }
  }finally{native.dispose();filtered.dispose();legacy.dispose();nativeMap.dispose();fastMap.dispose();d.delete();m.delete();}
  console.log(`${id}: depth culling max ${sceneMax}`);
}
assert.equal(max,0);
assert.equal(maxMap,0);
console.log(`start-demo sensor parity PASS: ${n} depth rays max ${max}, ${mapCells} height cells max ${maxMap}, ${scenes.length} scenes × ${poses} full-body poses + fixed poses vs native`);
