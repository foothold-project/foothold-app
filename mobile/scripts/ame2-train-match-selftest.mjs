// Local contracts and MuJoCo only; no training code, checkpoint or server.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { AME2_JOINT_ORDER, makeAme2ActionDelay, ame2GoalObservation, ame2Torque } from '../sim/ame2-adapter.js';
import { getPolicyAdapter } from '../sim/policy-adapters.js';
import { createSim, ISAAC_LIKE, MJ_J } from '../sim/sim.js';
const adapter = getPolicyAdapter('ame2-demo');
const expected = ['FL','FR','RL','RR'];
assert.deepEqual(AME2_JOINT_ORDER, ['hip','thigh','calf'].flatMap((part) => expected.map((leg) => `${leg}_${part}_joint`)));
assert.deepEqual(Array.from(adapter.action.defaultPose), [.1,-.1,.1,-.1,.8,.8,1,1,-1.5,-1.5,-1.5,-1.5]);
assert.deepEqual([adapter.action.kp,adapter.action.kd,adapter.action.scale,adapter.action.targetClip], [25,.5,.25,100]);
assert.equal(adapter.observations.height.noise, 0);
assert.equal(adapter.observations.height.rayOffset, 20);
// Exhaust both torque directions, both velocity directions, zero and knee/cutoff.
for (let j = 0; j < 12; j++) {
  const ratio = j < 8 ? 1 : 30.1 / 15.70;
  for (const speed of [-31,-30,-21.75,-13.5,-1,0,1,13.5,21.75,30,31]) for (const tau of [-100,-1,0,1,100]) {
    const dq = speed / ratio;
    const plateau = (tau * dq > 0 ? 20.2 : 23.4) * ratio;
    const bound = plateau * Math.max(0, Math.min(1,(30 - Math.abs(speed)) / 16.5));
    assert.ok(Math.abs(ame2Torque(tau,dq,j) - Math.max(-bound,Math.min(bound,tau))) < 1e-12);
  }
}
const originalRandom = Math.random;
try {
  for (const delay of [0,1,2,3,4]) {
    Math.random = () => (delay + .1) / 5;
    const queue = makeAme2ActionDelay([10,20], delay); queue.reset();
    assert.equal(queue.steps, delay);
    for (let i = 0; i < 12; i++) assert.deepEqual(Array.from(queue.apply([i,i+100])), i < delay ? [10,20] : [i-delay,i-delay+100]);
    queue.clear(); assert.equal(queue.steps, delay);
    assert.deepEqual(Array.from(queue.apply([90,91])), delay ? [10,20] : [90,91]);
    Math.random = () => .999;
    queue.reset(); assert.equal(queue.steps, delay, 'fixed delay on reset');
    const defaultQueue = makeAme2ActionDelay([0]); defaultQueue.reset(); assert.equal(defaultQueue.steps, 0, 'demo default has no randomized delay');
    const fixed = makeAme2ActionDelay([0],delay); fixed.reset(); assert.equal(fixed.steps,delay);
  }
  for (const invalid of [-1,5,1.5,NaN,'1']) assert.throws(() => makeAme2ActionDelay([0],invalid));
  for (const c of [[0,0,0,1],[-1,0,1,0],[0,2,0,-1],[1.2,1.6,0,1]]) assert.deepEqual(ame2GoalObservation(c),c);
  Math.random = () => .25;
  const far = ame2GoalObservation([3,4,0,1]);
  assert.deepEqual(far.slice(0,2),[1.2,1.6]); assert.ok(Math.abs(far[2]+1)<1e-12 && Math.abs(far[3])<1e-12);
  Math.random = () => .5;
  assert.deepEqual(ame2GoalObservation([0,-2.0001,1,0]),[0,-2,0,1]);
} finally { Math.random = originalRandom; }
// Export metadata functions tested without importing torch or any source module.
execFileSync('python3',['-c', `import ast,json\np='mobile/scripts/ame2_export.py'\ntree=ast.parse(open(p).read()); funcs=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in ('checkpoint_joint_names','input_contract')]\nns={}; exec(compile(ast.Module(body=funcs,type_ignores=[]),p,'exec'),ns)\nnames=json.loads('${JSON.stringify(AME2_JOINT_ORDER)}')\nassert ns['checkpoint_joint_names']({}) is None\nassert ns['checkpoint_joint_names']({'go2_env_state':{'critic_contract':{'joint_names':names}}}) == names\nassert ns['input_contract'](names)['output']['joint_names']==names\nassert not any('time input' in x for x in ns['input_contract'](names)['unknown'])\nassert 'joint name order absent from checkpoint' in ns['input_contract']()['unknown']\ntry: ns['checkpoint_joint_names']({'go2_env_state':{'critic_contract':{'joint_names':['bad']}}}); assert False\nexcept ValueError: pass`]);
const src = process.env.FH_SIM_SRC;
assert.ok(src, 'FH_SIM_SRC required');
const { default: load } = await import(pathToFileURL(resolve(src,'node_modules/@mujoco/mujoco/mujoco.js')));
const mj = await load(); mj.FS.mkdir('/go2'); mj.FS.mkdir('/go2/assets');
for (const f of readdirSync(join(src,'assets/unitree_go2/assets'))) if (f.endsWith('.obj')) mj.FS.writeFile('/go2/assets/'+f,readFileSync(join(src,'assets/unitree_go2/assets',f)));
mj.FS.writeFile('/go2/go2.xml',readFileSync(join(src,'assets/unitree_go2/go2.xml')));
mj.FS.writeFile('/go2/flat.xml','<mujoco><include file="go2.xml"/><worldbody><geom type="plane" size="10 10 .01"/></worldbody></mujoco>');
// Exercise the actual observe -> policy connection, not just the goal helper.
let goalObs;
const goalSim=createSim(mj,'/go2/flat.xml',ISAAC_LIKE,(obs)=>{goalObs=obs.slice();return new Float32Array(12);},{floorZ:0,spawn:[0,0,0]},adapter.id,{ame2DelaySteps:0});
try {
  Math.random=()=>.25; goalSim.cmd=[3,4,0,1]; goalSim.step();
  assert.ok(Math.abs(goalObs[45]-1.2)<1e-6&&Math.abs(goalObs[46]-1.6)<1e-6,'policy receives 2m-clipped far goal');
  assert.ok(Math.abs(goalObs[47]+1)<1e-6&&Math.abs(goalObs[48])<1e-6,'policy receives sampled far-goal yaw');
  assert.deepEqual(goalSim.cmd,[3,4,0,1],'observation encoding preserves command');
} finally {Math.random=originalRandom;goalSim.dispose();}
// Verify actual actuator torques at all 4 substeps (not just queue helpers).
for (const delay of [0,1,2,3,4]) {
  let tick=0, substep=0, previous;
  const traced = new Proxy(mj,{get(target,key) {
    if(key !== 'mj_step') return target[key];
    return (m,d) => {
      const actionTick = Math.floor((substep-delay)/4);
      for(let i=0;i<12;i++) {
        const j=AME2_JOINT_ORDER.indexOf(MJ_J[i]);
        const targetAngle=adapter.action.defaultPose[j]+(actionTick<0?0:((actionTick+1)*.1+j*.01)*.25);
        const torque=ame2Torque(25*(targetAngle-d.qpos[7+i])-.5*d.qvel[6+i],d.qvel[6+i],j);
        assert.ok(Math.abs(d.ctrl[i]-torque)<1e-10,`delay ${delay} substep ${substep} motor ${i}`);
      }
      substep++; return mj.mj_step(m,d);
    };
  }});
  // Use doubles for exact expected processed targets, distinct action per joint.
  const sim=createSim(traced,'/go2/flat.xml',ISAAC_LIKE,(obs)=>{previous=obs.slice();const a=Array.from({length:12},(_,j)=>(tick+1)*.1+j*.01);tick++;return a;},{floorZ:0,spawn:[0,0,0]},adapter.id,{ame2DelaySteps:delay});
  try {
    for(let k=0;k<3;k++) sim.step();
    assert.ok(Math.abs(previous[33]-.2)<1e-6,'previous submitted raw action, independent of delay');
    sim.clearPolicyState();tick=0;substep=0;sim.step();assert.ok(previous.slice(33,45).every(v=>v===0),'STOP clears raw and delayed actions');
    sim.reset();tick=0;substep=0;sim.step();assert.ok(previous.slice(33,45).every(v=>v===0),'reset clears history');
  } finally {sim.dispose();}
}
// The unchanged default policy path must be bit-identical to the dev baseline.
const baseline = execFileSync('git',['show','0d97c97:mobile/sim/sim.js'],{encoding:'utf8'}).replace("'./policy-adapters.js'",JSON.stringify(new URL('../sim/policy-adapters.js',import.meta.url).href));
const {createSim: before} = await import('data:text/javascript;base64,'+Buffer.from(baseline).toString('base64'));
const observations=[[],[]], makePolicy=(i)=>(obs)=>{observations[i].push(Array.from(obs));return Float32Array.from({length:12},(_,j)=>Math.sin(j+observations[i].length)*.1);};
const a=before(mj,'/go2/flat.xml',ISAAC_LIKE,makePolicy(0)), b=createSim(mj,'/go2/flat.xml',ISAAC_LIKE,makePolicy(1));
try {
  for(let k=0;k<30;k++) {a.cmd=[.6,0,.2];b.cmd=[.6,0,.2];a.step();b.step();assert.deepEqual(a.d.qpos,b.d.qpos);assert.deepEqual(a.d.qvel,b.d.qvel);assert.deepEqual(a.d.ctrl,b.d.ctrl);}
  assert.deepEqual(observations[0],observations[1]);
} finally {a.dispose();b.dispose();}
console.log('AME-2 train-match PASS: confirmed joint/default/export contract; 49 inputs/no time; goal threshold/yaw; Go2HV signed envelope; delay 0…4 per-substep torques/reset/STOP; foothold-v2 bit-identical 30 ticks');
