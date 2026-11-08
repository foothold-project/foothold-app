// Geometry measurement only: existing offline worlds, no server/policy/robot.
// FH_SIM_SRC=<existing MuJoCo dependency> node mobile/scripts/ame2-overhead-probe.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getPolicyAdapter, makeTerrainSampler } from '../sim/policy-adapters.js';
const src=process.env.FH_SIM_SRC;
assert.ok(src,'FH_SIM_SRC required');
const {default:load}=await import(pathToFileURL(resolve(src,'node_modules/@mujoco/mujoco/mujoco.js')));
const mj=await load(), adapter=getPolicyAdapter('ame2-demo');
const cases={
  'warehouse':[[0,0],[0,2],[2,0]],
  'collapsed-house-v2':[[3.85,-9.35,.38],[4.7,-3.3,1.7],[-3.2,1.25,1.7]],
  'factory-zone':[[2,4],[8,4],[14,4]],
};
for(const [id,positions] of Object.entries(cases)) {
  const dir=new URL(`../sim/assets/${id}/`,import.meta.url);
  const map=JSON.parse(readFileSync(new URL('map.json',dir)));
  for(const file of map.physics_assets??[]) mj.FS.writeFile('/'+file,readFileSync(new URL(file,dir)));
  mj.FS.writeFile('/probe.xml',readFileSync(new URL(id+'.xml',dir)));
  const m=mj.MjModel.from_xml_path('/probe.xml'),d=new mj.MjData(m);mj.mj_forward(m,d);
  const high=makeTerrainSampler(mj,m,d,adapter.observations.height);
  const scan=adapter.makeHeightScanner(mj,m,d,{floorZ:map.floor_z});
  const raw=new Float64Array(377),mapping=new Float64Array(1131),hit=new mj.IntBuffer(1);
  try {
    for(const [x,y,bodyZ] of positions) {
      const z=bodyZ??map.floor_z+.4,q=[x,y,z,1,0,0,0];
      high(q,raw);scan(q,mapping);
      const upward=mj.mj_ray(m,d,[x,y,z],[0,0,1],[1,1,0,0,1,0],true,-1,hit,null);
      const ceiling=upward>=0?z+upward:null;
      // Saturation is an observable symptom; raw_above_body also includes
      // legitimate obstacles. ceiling_or_above identifies the intercepted slab.
      const row={scene:id,body:[x,y,z],upward_hit_z:ceiling,
        raw_above_body:raw.filter(h=>h>z).length,
        raw_ceiling_or_above:ceiling===null?0:raw.filter(h=>h>=ceiling-1e-6).length,
        raw_clip_high:raw.filter(h=>h-z+.27>=1.5).length,
        adapted_changed:raw.filter((h,i)=>Number.isFinite(h)&&Math.abs(mapping[3*i+2]-Math.max(-1.5,Math.min(1.5,h-z+.27)))>1e-6).length,
        adapted_ceiling_or_above:ceiling===null?0:Array.from({length:377},(_,i)=>mapping[3*i+2]+z-.27).filter(h=>h>=ceiling-1e-6).length,
        adapted_clip_high:Array.from({length:377},(_,i)=>mapping[3*i+2]).filter(h=>h===1.5).length};
      console.log(JSON.stringify(row));
    }
  } finally {hit.delete();scan.dispose();high.dispose();d.delete();m.delete();}
}
