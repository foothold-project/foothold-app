// MuJoCo simulation only: posture does not cancel policy/physics; reset is manual.
// FH_SIM_SRC=<existing dependencies> node mobile/scripts/sim-no-fall-selftest.mjs
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSim, ISAAC_LIKE } from '../sim/sim.js';
import { createScenarioRunner } from '../sim/scenario.js';
const src=process.env.FH_SIM_SRC;
assert.ok(src,'FH_SIM_SRC required');
const {default:load}=await import(pathToFileURL(resolve(src,'node_modules/@mujoco/mujoco/mujoco.js')));
const mj=await load();mj.FS.mkdir('/go2');mj.FS.mkdir('/go2/assets');
for(const f of readdirSync(join(src,'assets/unitree_go2/assets')))if(f.endsWith('.obj'))mj.FS.writeFile('/go2/assets/'+f,readFileSync(join(src,'assets/unitree_go2/assets',f)));
mj.FS.writeFile('/go2/go2.xml',readFileSync(join(src,'assets/unitree_go2/go2.xml')));
let ticks=0;
for(const id of ['foothold-v2','ame2-demo']) for(const [name,z,roll,ground] of [
  ['low-body',.12,0,true],['sideways',.4,Math.PI/2,true],['inverted',.4,Math.PI,true],['void',.4,0,false],
]) {
  mj.FS.writeFile('/go2/test.xml',`<mujoco><include file="go2.xml"/><worldbody>${ground?'<geom type="plane" group="1" size="10 10 .01"/>':''}</worldbody></mujoco>`);
  let calls=0;
  const sim=createSim(mj,'/go2/test.xml',ISAAC_LIKE,(obs,map)=>{
    assert.ok(obs.every(Number.isFinite)&&(!map||map.every(Number.isFinite)));calls++;
    return new Float32Array(12).fill(.1);
  },{floorZ:0,spawn:[0,0,0]},id,{ame2DelaySteps:0});
  try {
    const q=sim.d.qpos;q[2]=z;q[3]=Math.cos(roll/2);q[4]=Math.sin(roll/2);q[5]=q[6]=0;
    mj.mj_forward(sim.m,sim.d);sim.hold(0);
    sim.cmd=id==='ame2-demo'?[1,0,0,1]:[.6,0,0];
    const command=sim.cmd.slice();
    for(let k=0;k<30;k++) {
      sim.step();assert.equal(calls,k+1);assert.ok(Math.abs(sim.t-(k+1)*.02)<1e-12);
      assert.ok(sim.d.qpos.every(Number.isFinite)&&sim.d.qvel.every(Number.isFinite)&&sim.d.ctrl.every(Number.isFinite));
      assert.deepEqual(sim.cmd,command);assert.equal(Object.hasOwn(sim,'fell'),false);ticks++;
    }
    assert.ok(Math.abs(sim.d.time-.6)<1e-12,`${id}/${name}: physics keeps stepping`);
    sim.reset();assert.equal(sim.t,0);assert.ok(Math.abs(sim.d.qpos[2]-.4)<1e-12);
    assert.deepEqual(Array.from(sim.d.qpos.slice(3,7)),[1,0,0,0]);assert.equal(Object.hasOwn(sim,'fell'),false);
  } finally {sim.dispose();}
}
// The waypoint runner also accepts and retains a low, inverted pose.
const mock={cmd:[0,0,0],d:{qpos:[0,0,.1,0,1,0,0]}};
let stopped=false;
const runner=createScenarioRunner(mock,()=>stopped);
assert.equal(runner.start([{x:2,y:0}],true),true);
for(let k=0;k<10;k++){runner.tick(Infinity,.02);assert.equal(runner.active,true);assert.ok(mock.cmd[0]>0);}
stopped=true;runner.tick();assert.equal(runner.status,'중단');assert.deepEqual(mock.cmd,[0,0,0]);
// Deleted UI gates must not remain as dormant branches on a removed property.
for(const file of ['../sim/main.js','../sim/scenario.js'])assert.doesNotMatch(readFileSync(new URL(file,import.meta.url),'utf8'),/sim\.fell|넘어져서|넘어졌습니다/);
assert.doesNotMatch(readFileSync(new URL('../sim/index.html',import.meta.url),'utf8'),/#reset\.fell/);
console.log(`sim no-fall PASS: ${ticks} policy/physics ticks across low/sideways/inverted/void poses for both adapters; command retained, no fall state, manual reset, waypoint continuity and STOP cancellation`);
