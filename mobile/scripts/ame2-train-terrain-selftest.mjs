import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeTerrainSampler } from '../sim/policy-adapters.js';
import { decodeMap, cell } from '../sim/lidar.js';
const dir = new URL('../sim/assets/ame2-train-terrain/', import.meta.url);
const read = (name) => JSON.parse(readFileSync(new URL(name,dir)));
const metadata=read('metadata.json'), scene=read('scene.json'), map=decodeMap(read('map.json'));
const top=read('top.json'), png=readFileSync(new URL('top.png',dir));
assert.deepEqual([png.readUInt32BE(16),png.readUInt32BE(20)],top.px);
assert.deepEqual(top.px,[Math.round((top.bounds[2]-top.bounds[0])*24),Math.round((top.bounds[3]-top.bounds[1])*24)]);
assert.equal(JSON.parse(readFileSync(new URL('../sim/maps.json',import.meta.url)))[0].id,'warehouse','default scene stays warehouse');
assert.deepEqual(metadata.types,['stair_up','gap']); assert.equal(metadata.tiles.length,6);
assert.equal(scene.models.length,metadata.boxes); assert.ok(metadata.triangles<3000);
const xml=readFileSync(new URL('ame2-train-terrain.xml',dir),'utf8');
const geoms=[...xml.matchAll(/<geom name="([^"]+)" group="1" type="box" size="([^"]+)" pos="([^"]+)"\/>/g)];
assert.equal(geoms.length,scene.models.length);
// Renderer dimensions/positions must match collision dimensions, including holes.
for(const [i,g] of geoms.entries()) {
  const md=scene.models[i], mesh=scene.meshes[md.mesh], size=g[2].split(' ').map(Number), pos=g[3].split(' ').map(Number);
  assert.equal(md.name,g[1]);assert.deepEqual(md.pos,pos);
  for(let axis=0;axis<3;axis++) {
    const values=mesh.p.filter((_,j)=>j%3===axis);
    assert.ok(Math.abs(Math.max(...values)-size[axis])<1e-12);
    assert.ok(Math.abs(Math.min(...values)+size[axis])<1e-12);
  }
}
assert.equal(cell(map,0,0),254);assert.notEqual(cell(map,1.04,14),254,'gap never marked navigable');
const {default:load}=await import(pathToFileURL(resolve(process.env.FH_SIM_SRC,'node_modules/@mujoco/mujoco/mujoco.js')));
const mj=await load();mj.FS.writeFile('/terrain.xml',xml);
const m=mj.MjModel.from_xml_path('/terrain.xml'), d=new mj.MjData(m);mj.mj_forward(m,d);
let checks=0;
const height=(x,y)=>{
  const sampler=makeTerrainSampler(mj,m,d,{grid:[[0,0]],rayOffset:20}), out=new Float64Array(1);
  try {sampler([x,y,.4,1,0,0,0],out);return out[0];} finally {sampler.dispose();}
};
const close=(actual,expected)=>{assert.ok(Math.abs(actual-expected)<1e-9,`${actual} vs ${expected}`);checks++;};
try {
  for(const t of metadata.tiles) {
    assert.deepEqual(t.size,[12,12]);close(height(...t.center),0);
    if(t.kind==='gap') {
      close(t.gap_width,.08+.62*t.difficulty);close(t.gap_end-t.gap_start,t.gap_width);
      close(height(t.gap_start-.01,t.center[1]),0);
      close(height(t.gap_end+.01,t.center[1]),t.landing_height);
      const gapHeight=height((t.gap_start+t.gap_end)/2,t.center[1]);
      if(t.lower_floor_z===null) assert.ok(Number.isNaN(gapHeight),'no invisible gap collision plane');
      else close(gapHeight,t.lower_floor_z);
      assert.ok(Math.abs(t.landing_height)<=.3*t.gap_width+1e-12);
    } else {
      close(t.step_height,.03+.14*t.difficulty);assert.ok(t.step_width>=.22&&t.step_width<=.30);
      assert.equal(t.num_steps,Math.floor(6/(2*t.step_width))+2);
      const lift=t.num_steps*t.step_height;
      for(let k=0;k<t.num_steps-1;k++) close(height(t.center[0]+4-(k+.5)*t.step_width,t.center[1]),lift-(k+1)*t.step_height);
      close(height(t.center[0]+5,t.center[1]),lift);
    }
  }
} finally {d.delete();m.delete();}
console.log(`AME-2 train-terrain PASS: six 12m tiles, source range endpoints, ${checks} native height/dimension checks, gaps preserved, renderer/collision agreement (${metadata.triangles} triangles)`);
