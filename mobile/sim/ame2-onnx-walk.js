// Same browser/Node trajectory experiment. No gait verdict; numerical records only.
export const AME2_WALK_MAPS = ['factory-inspection','factory-inspection-alt1','factory-zone','warehouse','element-course','ame2-train-terrain'];
export async function compareAme2Walk(mj, createSim, phys, f32, onnx, readBytes, { ticks = 300 } = {}) {
  const records = [], observations = [];
  for (const id of AME2_WALK_MAPS) {
    const root = `assets/${id}/`, map = JSON.parse(new TextDecoder().decode(await readBytes(root + 'map.json')));
    for (const file of map.physics_assets ?? []) {
      const data = await readBytes(root + file); mj.FS.writeFile('/go2/'+file,data); mj.FS.writeFile('/go2/assets/'+file,data);
    }
    mj.FS.writeFile('/go2/world.xml', await readBytes(root + id + '.xml'));
    mj.FS.writeFile('/go2/scene.xml', '<mujoco><include file="go2.xml"/><include file="world.xml"/></mujoco>');
    // Fixed delay 0 and 4 exercise both endpoints without reset RNG confounds.
    for (const delay of [0,4]) {
      const trajectories = [];
      for (const [name, policy] of [['f32',f32], ['onnx',onnx]]) {
        let tick = 0;
        const wrapped = (prop, mapping) => {
          if (name === 'f32' && delay === 0 && tick % 25 === 0) observations.push({name:`${id}/${tick}`,prop:Array.from(prop),mapping:Array.from(mapping)});
          tick++;
          return policy(prop,mapping);
        };
        wrapped.async = name === 'onnx';
        const sim = createSim(mj,'/go2/scene.xml',phys,wrapped,{floorZ:map.floor_z,spawn:map.spawn_xyyaw},'ame2-demo',{ame2DelaySteps:delay});
        const trajectory = [];
        try {
          sim.hold(.5);
          for (let k=0;k<ticks;k++) {
            // Three fixed nearby commands: no far-goal random heading.
            sim.cmd = k < ticks/3 ? [1,0,0,1] : k < 2*ticks/3 ? [.5,.3,Math.sin(.2),Math.cos(.2)] : [0,0,0,1];
            await sim.step();
            if (!sim.d.qpos.every(Number.isFinite) || !sim.d.qvel.every(Number.isFinite)) throw new Error(`${id}/${name}: non-finite state`);
            trajectory.push({t:sim.t,qpos:Array.from(sim.d.qpos),gravity:sim.grav.slice()});
          }
        } finally { sim.dispose(); }
        trajectories.push({name,trajectory});
      }
      let maxPositionM=0,maxQuaternion=0,maxJointRad=0,maxGravity=0,sumPosition2=0;
      for(let k=0;k<ticks;k++) {
        const a=trajectories[0].trajectory[k], b=trajectories[1].trajectory[k];
        const pos=Math.hypot(...a.qpos.slice(0,3).map((v,i)=>v-b.qpos[i]));
        maxPositionM=Math.max(maxPositionM,pos);sumPosition2+=pos**2;
        // Quaternion sign is equivalent; compare its closer representative.
        const sign=a.qpos.slice(3,7).reduce((n,v,i)=>n+v*b.qpos[i+3],0)<0?-1:1;
        for(let i=3;i<7;i++)maxQuaternion=Math.max(maxQuaternion,Math.abs(a.qpos[i]-sign*b.qpos[i]));
        for(let i=7;i<19;i++)maxJointRad=Math.max(maxJointRad,Math.abs(a.qpos[i]-b.qpos[i]));
        for(let i=0;i<3;i++)maxGravity=Math.max(maxGravity,Math.abs(a.gravity[i]-b.gravity[i]));
      }
      records.push({id,delay,ticks,seconds:ticks*.02,maxPositionM,rmsPositionM:Math.sqrt(sumPosition2/ticks),maxQuaternion,maxJointRad,maxGravity,trajectories});
    }
  }
  return { records, observations, verdict:'Numerical trajectories only; user judges gait' };
}
