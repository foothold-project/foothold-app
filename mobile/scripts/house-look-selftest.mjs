// Local dependencies only; verifies the shipped loose pieces through the real
// 187-ray policy scanner, then repeats the unchanged warehouse flat regression.
// FH_SIM_SRC=<existing dependencies> node mobile/scripts/house-look-selftest.mjs
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getPolicyAdapter, makeTerrainSampler } from '../sim/policy-adapters.js';
import { createSim, ISAAC_LIKE, loadPolicy } from '../sim/sim.js';
const src = process.env.FH_SIM_SRC;
assert.ok(src, 'FH_SIM_SRC required');
const { default: load } = await import(pathToFileURL(resolve(src, 'node_modules/@mujoco/mujoco/mujoco.js')));
const mj = await load();
mj.FS.mkdir('/go2'); mj.FS.mkdir('/go2/assets');
for (const f of readdirSync(join(src, 'assets/unitree_go2/assets'))) if (f.endsWith('.obj')) mj.FS.writeFile(`/go2/assets/${f}`, readFileSync(join(src, 'assets/unitree_go2/assets', f)));
mj.FS.writeFile('/go2/go2.xml', readFileSync(join(src, 'assets/unitree_go2/go2.xml')));
const weights = readFileSync(join(src, 'policy_v2.f32'));
const policy = loadPolicy(weights.buffer.slice(weights.byteOffset, weights.byteOffset + weights.byteLength));
function world(id) {
  const dir = new URL(`../sim/assets/${id}/`, import.meta.url), map = JSON.parse(readFileSync(new URL('map.json', dir)));
  for (const f of map.physics_assets ?? []) { const b = readFileSync(new URL(f, dir)); mj.FS.writeFile(`/go2/${f}`, b); mj.FS.writeFile(`/go2/assets/${f}`, b); }
  mj.FS.writeFile('/go2/world.xml', readFileSync(new URL(`${id}.xml`, dir)));
  mj.FS.writeFile('/go2/scene.xml', '<mujoco><include file="go2.xml"/><include file="world.xml"/></mujoco>');
  return map;
}
world('collapsed-house-v2');
const m = mj.MjModel.from_xml_path('/go2/scene.xml'), d = new mj.MjData(m);
mj.mj_forward(m,d);
const cfg = getPolicyAdapter().observations.height, sample = makeTerrainSampler(mj,m,d,cfg);
const heights = new Float64Array(187), obs = new Float32Array(187);
const scan = getPolicyAdapter().makeHeightScanner(mj,m,d);
const details = [];
try {
  assert.equal(cfg.grid.length,187);
  const name = (g) => mj.mj_id2name(m,mj.mjtObj.mjOBJ_GEOM.value,g);
  const loose = Array.from({length:m.ngeom},(_,g)=>g).filter(g=>name(g)?.startsWith('loose_'));
  assert.ok(loose.length>100);
  for (const g of loose.filter((_,i)=>i%11===0)) {
    const x=m.geom_pos[g*3], y=m.geom_pos[g*3+1], z=m.geom_pos[g*3+2]+.7;
    const q=[x,y,z,1,0,0,0]; sample(q,heights);scan(q,obs);
    assert.ok(heights.every(Number.isFinite));
    const center=5*17+8;
    // Remove this *actual contact piece* and repeat: center ray must drop.
    // No visual-only mesh or rays-only proxy may supply this observation.
    const before=heights[center], type=m.geom_contype[g], affinity=m.geom_conaffinity[g];
    m.geom_contype[g]=0;m.geom_conaffinity[g]=0;
    const without=makeTerrainSampler(mj,m,d,cfg);const other=new Float64Array(187);
    try {without(q,other);} finally {without.dispose();m.geom_contype[g]=type;m.geom_conaffinity[g]=affinity;}
    if (before-other[center]>.01) details.push({name:name(g),height:before,dropWithoutPiece:before-other[center]});
    for(let i=0;i<187;i++) assert.ok(Math.abs(obs[i]-Math.max(-1,Math.min(1,z-heights[i]-.5)))<1e-6);
  }
  assert.ok(details.length>=5, `piece rays observed: ${details.length}`);
  const perimeter=Array.from({length:m.ngeom},(_,g)=>g).filter(g=>name(g)?.startsWith('perimeter_contact_'));
  assert.ok(perimeter.length>50);
  let perimeterHits=0;
  for(const g of perimeter.filter(g=>Math.abs(m.geom_pos[g*3])>8.4||Math.abs(m.geom_pos[g*3+1])>6.8).filter((_,i)=>i%5===0)) {
    const q=[m.geom_pos[g*3],m.geom_pos[g*3+1],m.geom_pos[g*3+2]+m.geom_size[g*3+2]+.4,1,0,0,0];
    sample(q,heights);const before=heights[5*17+8];
    const type=m.geom_contype[g],affinity=m.geom_conaffinity[g];m.geom_contype[g]=0;m.geom_conaffinity[g]=0;
    const without=makeTerrainSampler(mj,m,d,cfg),other=new Float64Array(187);
    try {without(q,other);} finally {without.dispose();m.geom_contype[g]=type;m.geom_conaffinity[g]=affinity;}
    if(before-other[5*17+8]>.01)perimeterHits++;
  }
  assert.ok(perimeterHits>=3);
  console.log(JSON.stringify({heightScan:'PASS',rays:187,looseContacts:loose.length,independentPieceHits:details,perimeterContacts:perimeter.length,perimeterHits}));
} finally {scan.dispose();sample.dispose();d.delete();m.delete();}
const map=world('warehouse');
for(let run=0;run<3;run++) {
  const sim=createSim(mj,'/go2/scene.xml',ISAAC_LIKE,policy,{floorZ:map.floor_z,spawn:[0,-2,0]});
  try {
    sim.hold(.5);const start=Array.from(sim.d.qpos.slice(0,2));sim.cmd=[.6,0,0];
    for(let i=0;i<140;i++)sim.step();
    const distance=Math.hypot(sim.d.qpos[0]-start[0],sim.d.qpos[1]-start[1]);
    assert.equal(sim.fell,false);assert.ok(distance>1.2);
    console.log(JSON.stringify({warehouseRun:run+1,seconds:sim.t,distance,fell:sim.fell}));
  } finally {sim.dispose();}
}
console.log('house-look PASS: real loose-piece 187-ray observations; warehouse flat 3/3');
