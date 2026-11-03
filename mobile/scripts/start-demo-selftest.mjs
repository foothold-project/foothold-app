// Local MuJoCo/ORT/assets only. Run under the shared heavy-test flock.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { POLICY_MODES, makeTerrainSampler } from '../sim/policy-modes.js';
import { createSim, ISAAC_LIKE } from '../sim/sim.js';
import { loadOnnxPolicy, withPolicyState } from '../sim/policy-onnx.js';
import { makeStartDemoMap, makeStartDemoDepth, startDemoGrid } from '../sim/start-demo-sensors.js';
import { createScenarioRunner } from '../sim/scenario.js';
import { manualSettings, manualCommand } from '../sim/manual-settings.js';
const src = process.env.FH_SIM_SRC;
const { default: load } = await import(pathToFileURL(resolve(src,'node_modules/@mujoco/mujoco/mujoco.js')));
const mj = await load(), mode = POLICY_MODES.start, report = { sensors: {}, standing: {}, commands: {} };
const near = (x,y,tol=1e-6) => assert.ok(Math.abs(x-y)<tol,`${x} != ${y}`);
const sensorScene = (extra='',floor='<geom type="plane" size="100 100 .01"/>') => {
  mj.FS.writeFile('/sensors.xml',`<mujoco><worldbody>${floor}${extra}
    <geom type="box" size="2 2 .02" pos="0 0 .2" contype="0" conaffinity="0"/>
    <body pos=".4 0 .3"><freejoint/><geom type="sphere" size=".1" group="1"/></body></worldbody></mujoco>`);
  const m=mj.MjModel.from_xml_path('/sensors.xml'),d=new mj.MjData(m);mj.mj_forward(m,d);
  const map=makeStartDemoMap(mj,m,d,makeTerrainSampler),depth=makeStartDemoDepth(mj,m,d);
  return {m,d,map,depth,dispose(){map.dispose();depth.dispose();d.delete();m.delete();}};
};
const flat=sensorScene(),roof=sensorScene('<geom type="box" size="20 20 .1" pos="0 0 1.6"/>'),wall=sensorScene('<geom type="box" size=".02 10 10" pos=".75 0 10"/>');
const voidScene=sensorScene('',''),step=sensorScene('<geom type="box" size=".15 1 .1" pos=".6 0 .1"/>');
try {
  const q=[0,0,.3,1,0,0,0];
  for(const scene of [flat,roof]) assert.ok(scene.map(q).every((v)=>Math.abs(v+.3)<1e-6),'flat ground; ignore roof/robot/proxy');
  report.sensors.mapRange=[Math.min(...roof.map(q)),Math.max(...roof.map(q))];
  assert.ok(voidScene.map(q).every((v)=>v===-1));assert.ok(voidScene.depth(q).every((v)=>v===1),'no hit depth is 1');
  near(step.map(q)[20*16],-.1);near(step.map(q)[0],-.3);
  assert.ok(step.map([0,0,.3,Math.SQRT1_2,0,0,Math.SQRT1_2]).every((v)=>Math.abs(v+.3)<1e-6),'map yaw rotates local grid away from step');
  assert.ok(flat.map([1000,1000,.3,1,0,0,0]).every((v)=>v===-1),'miss is -1');
  near(startDemoGrid[0][0],-.475);near(startDemoGrid[0][1],-.375);near(startDemoGrid[16][0],-.425);near(startDemoGrid[16][1],-.375);
  const center=30*60+30, angle=35*Math.PI/180;
  const fd=flat.depth(q).slice(),wd=wall.depth(q).slice();
  near(fd[center],(.42/Math.sin(angle)-.2)/2.8); near(wd[center],(.48/Math.cos(angle)-.2)/2.8);
  // Wall is behind all rays after yaw=pi; roll/pitch follows the body too.
  near(wall.depth([0,0,.3,0,0,0,1])[center],fd[center]);
  assert.ok(fd.every((v)=>v>=0&&v<=1));
  report.sensors.depthFlatCenter=fd[center];report.sensors.depthWallCenter=wd[center];
  const times={map:[],depth:[]};
  for(let k=0;k<40;k++){roof.map(q);flat.depth(q);times.map.push(roof.map.ms);times.depth.push(flat.depth.ms);}
  for(const [name,values] of Object.entries(times)){values.sort((a,b)=>a-b);report.sensors[name+'Ms']={median:values[20],max:values.at(-1)};}
}finally{flat.dispose();roof.dispose();wall.dispose();voidScene.dispose();step.dispose();}
// Counter-valued frames expose the one-frame delay at ticks 0/5/10/15.
let captures=0,maps=0;
const state={t:0,observation:new Float32Array(45),lastAction:new Float32Array(12),M2I:Array.from({length:12},(_,i)=>(i%4)*3+Math.floor(i/4)),d:{qpos:new Float64Array(19),qvel:new Float64Array(18)},angB:[0,0,0],grav:[0,0,-1],startMapMode:'gt',mapping:new Float32Array(512),heightScanner:(_q,out)=>{maps++;return out.fill(-.3);},depthScanner:()=>{captures++;return new Float32Array(3600).fill(frame);}};
for(let i=0;i<12;i++)state.d.qpos[7+state.M2I[i]]=mode.action.defaultPose[i];
let memory={},frame=0;mode.reset(memory);
for(let k=0;k<16;k++){
  frame=Math.floor(k/5);
  state.t=k*.02;
  const before=captures;
  const candidate=structuredClone(memory),inputs=mode.observe(state,[k/20,0,0],candidate);
  const retry=mode.observe(state,[k/20,0,0],structuredClone(memory));assert.deepEqual(retry,inputs,'discarded retry does not shift buffers');
  assert.equal(captures,before+(k===0?1:0),'later captures wait until accepted applyAction; initial capture reused on retry');
  near(inputs[2][0],Math.max(0,frame-1));near(inputs[2][3600],Math.max(0,frame-2));
  assert.equal(inputs[5][0],k%5===0);assert.equal(inputs[6][0],k===0);
  near(inputs[1][6],k/20);near(inputs[1][51],Math.max(0,(k-1)/20));
  if(k===0)report.jointOrderMax=Math.max(...inputs[0].slice(9,21).map(Math.abs));
  mode.commit(candidate,state);memory=candidate;
}
assert.equal(captures,4);assert.equal(maps,16,'retry reuses the exact same physical sensor snapshot');
mode.reset({},state);assert.equal(state.startSensorCache,null,'reset/STOP invalidates raw samples');
assert.deepEqual([...mode.act(new Float32Array(12))],[...mode.action.defaultPose]);
near(mode.act(new Float32Array(12).fill(100))[8],-1.5+.25*17);
near(mode.torque(100,0,8),45.43);near(mode.torque(100,0,0),23.5);near(mode.torque(100,15.7,8),0);
near(mode.torque(0,31.4,8),-45.43);near(mode.torque(0,-31.4,8),45.43);
const settings=manualSettings({},mode.command);
for(const axes of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1],[1,0,1]])report.commands[axes.join(',')]=manualCommand(axes,settings);
assert.deepEqual(Object.values(report.commands),[[1.5,0,0],[-1,0,0],[0,.5,0],[0,-.5,0],[0,0,1.2],[0,0,-1.2],[1.5,0,1]]);
for(const [angle,expected] of [[.1,[1.5,0,.15]],[.2,[.8,0,.3]],[.6,[0,0,.9]],[1,[0,0,1.2]]]){
  const sim={adapterId:mode.id,d:{qpos:[0,0,0,1,0,0,0]},cmd:[0,0,0]},runner=createScenarioRunner(sim,()=>false,{vx:1.5,wz:1.2});
  runner.start([{x:3*Math.cos(angle),y:3*Math.sin(angle)}]);const command=runner.tick();command.forEach((v,i)=>near(v,expected[i]));
}
// Actual robot physics: three policies, zero command, 1500 decisions = 30 s.
mj.FS.mkdir('/go2');mj.FS.mkdir('/go2/assets');
for(const name of readdirSync(join(src,'assets/unitree_go2/assets')))if(name.endsWith('.obj'))mj.FS.writeFile('/go2/assets/'+name,readFileSync(join(src,'assets/unitree_go2/assets',name)));
mj.FS.writeFile('/go2/go2.xml',readFileSync(join(src,'assets/unitree_go2/go2.xml')));
mj.FS.writeFile('/go2/flat.xml','<mujoco><include file="go2.xml"/><worldbody><geom type="plane" size="100 100 .01"/></worldbody></mujoco>');
const ort=await import(pathToFileURL(resolve(process.env.POLICY_ORT_NODE)));
for(const [key,adapter] of Object.entries(POLICY_MODES).filter(([,mode])=>mode.onnx)){
  const root=key==='start'?process.env.FH_START_SRC:key==='ame2'?process.env.FH_AME2_SRC:process.env.FH_POLICY_ONNX_SRC;
  const policy=withPolicyState(await loadOnnxPolicy(ort,readFileSync(join(root,adapter.onnx.file)),adapter.onnx,'cpu'),adapter.onnx);
  const sim=createSim(mj,'/go2/flat.xml',ISAAC_LIKE,policy,undefined,adapter.id);
  let minZ=Infinity,maxCalf=0,maxMapError=0;
  try{
    if(key==='ame2'){
      const map=sim.heightScanner([0,0,.27,1,0,0,0],new Float32Array(1131));
      report.ame2FlatZMax=Math.max(...Array.from({length:377},(_,i)=>Math.abs(map[i*3+2])));
      assert.ok(report.ame2FlatZMax<1e-6);
    }
    sim.hold(.5);const initial=sim.d.qpos.slice(0,3);
    for(let k=0;k<1500;k++){
      sim.cmd=adapter.stop.input.slice();assert.equal(await sim.step(),true);
      minZ=Math.min(minZ,sim.d.qpos[2]);
      for(const i of [2,5,8,11])maxCalf=Math.max(maxCalf,Math.abs(sim.d.ctrl[i]));
      if(key==='start'&&k===1499)for(const value of sim.mapping)maxMapError=Math.max(maxMapError,Math.abs(value+sim.d.qpos[2]));
    }
    report.standing[key]={seconds:sim.t,minZ,finalZ:sim.d.qpos[2],driftXY:Math.hypot(sim.d.qpos[0]-initial[0],sim.d.qpos[1]-initial[1]),maxCalf,mapError:maxMapError};
    assert.ok([...sim.d.qpos,...sim.d.qvel].every(Number.isFinite));
    if(key==='start'){
      // Controlled saturation in real ctrl buffer verifies XML's 23.5 cap is off.
      sim.reset();sim.d.qpos[7+sim.M2I[8]]-=4;sim.physStep();
      report.calfSaturation=sim.d.ctrl[sim.M2I[8]];near(report.calfSaturation,45.43);
    }
  }finally{sim.dispose();await policy.dispose();}
}
if(process.env.START_DEMO_REPORT)writeFileSync(process.env.START_DEMO_REPORT,JSON.stringify(report,null,2));
console.log('start-demo PASS',JSON.stringify(report));
