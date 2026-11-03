// start 32x16 maps: compare #270's body probe with shared per-cell cover/B1 logic.
// FH_SIM_SRC required; no model/vector/browser/server and no gait verdict.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeStartDemoMap, startDemoGrid } from '../sim/start-demo-sensors.js';
import { makeTerrainSampler } from '../sim/policy-adapters.js';
assert.ok(process.env.FH_SIM_SRC, 'FH_SIM_SRC required');
const snapshot = async (file) => {
  let text = execFileSync('git', ['show', 'c4e9aa1:mobile/sim/' + file], { encoding: 'utf8' });
  for (const name of ['ame2-adapter.js', 'manual-settings.js', 'policy-modes.js']) text = text.replaceAll(`'./${name}'`, JSON.stringify(new URL('../sim/' + name, import.meta.url).href));
  return import('data:text/javascript;base64,' + Buffer.from(text).toString('base64'));
};
const old = await snapshot('start-demo-sensors.js'), oldSampler = (await snapshot('policy-adapters.js')).makeTerrainSampler;
const scalar = (mj, ...args) => makeTerrainSampler(new Proxy(mj, { get: (t, k) => k === 'mju_rayGeom' ? undefined : t[k] }), ...args);
const { default: load } = await import(pathToFileURL(resolve(process.env.FH_SIM_SRC, 'node_modules/@mujoco/mujoco/mujoco.js')));
const mj = await load(), rows = [];
function check(id, map, xml) {
  mj.FS.writeFile('/start-overhead.xml', xml);
  const m = mj.MjModel.from_xml_path('/start-overhead.xml'), d = new mj.MjData(m); mj.mj_forward(m, d);
  const scans = [old.makeStartDemoMap(mj,m,d,oldSampler), makeStartDemoMap(mj,m,d,makeTerrainSampler), makeStartDemoMap(mj,m,d,makeTerrainSampler,{fastVertical:false}), makeStartDemoMap(mj,m,d,scalar)];
  const groups = Array.from(m.geom_group), [sx,sy,yaw] = map.spawn_xyyaw;
  try {
    for (const ahead of id === 'flat' ? [0] : [0,1,2]) {
      const q = [sx+ahead*Math.cos(yaw),sy+ahead*Math.sin(yaw),map.floor_z+.3,Math.cos(yaw/2),0,0,Math.sin(yaw/2)];
      const [before,fast,native,fallback] = scans.map((s) => s(q).slice());
      assert.equal(fast.length,512); assert.deepEqual(fast,native,`${id}/${ahead}: #270 fast/native identical`);
      assert.deepEqual(fast,fallback,`${id}/${ahead}: fast/scalar identical`);
      assert.ok(fast.every((z) => Math.abs(z+.3)<1e-6),`${id}/${ahead}: floor remains -0.3, no ceiling cells`);
      assert.deepEqual(Array.from(m.geom_group),groups);
      rows.push({id,ahead,before:before.filter((z)=>z>0).length,after:fast.filter((z)=>z>0).length,min:Math.min(...fast),max:Math.max(...fast)});
      console.log(JSON.stringify(rows.at(-1)));
    }
  } finally { scans.forEach((s)=>s.dispose());d.delete();m.delete(); }
}
check('flat',{floor_z:0,spawn_xyyaw:[0,0,0]},'<mujoco><worldbody><geom type="plane" size="10 10 .01"/></worldbody></mujoco>');
for (const id of ['factory-inspection','factory-inspection-alt1','factory-zone']) {
  const dir = new URL('../sim/assets/'+id+'/',import.meta.url), map = JSON.parse(readFileSync(new URL('map.json',dir)));
  for (const f of map.physics_assets??[]) mj.FS.writeFile('/'+f,readFileSync(new URL(f,dir)));
  check(id,map,readFileSync(new URL(id+'.xml',dir)));
  assert.ok(rows.some((r)=>r.id===id&&r.before>0),`${id}: must reproduce the old ceiling error`);
}
// A cover cap inside a wall must retain +1 in start's clipped height channel.
for (const bottom of [1.9,1.4,2.82]) {
  const top = bottom === 2.82 ? 3 : 1.9;
  mj.FS.writeFile('/start-solid.xml',`<mujoco><worldbody><geom type="plane" size="10 10 .01"/><geom type="box" pos=".9 0 ${top/2}" size=".2 3 ${top/2}"/><geom type="box" pos=".9 0 ${bottom+.1}" size=".3 3 .1"/></worldbody></mujoco>`);
  const m=mj.MjModel.from_xml_path('/start-solid.xml'),d=new mj.MjData(m);mj.mj_forward(m,d);
  const scans=[makeStartDemoMap(mj,m,d,makeTerrainSampler),makeStartDemoMap(mj,m,d,makeTerrainSampler,{fastVertical:false}),makeStartDemoMap(mj,m,d,scalar)];
  try {
    const out=scans.map((s)=>s([0,0,.3,1,0,0,0]).slice());assert.deepEqual(out[0],out[1]);assert.deepEqual(out[0],out[2]);
    startDemoGrid.forEach(([x],i)=>{if(x>.7&&x<1.1)assert.equal(out[0][i],1,`wall/cover ${bottom}/${i}`);});
  } finally {scans.forEach((s)=>s.dispose());d.delete();m.delete();}
}
console.log('start-demo overhead PASS: flat -0.3, 3 factory maps at 0/1/2m, ceilings removed; fast/native/scalar identical; B1 wall intersections retained');
