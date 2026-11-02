// Local headless MuJoCo only. FH_SIM_SRC / AME2_EXPORT point to existing assets.
// FH_SIM_MODULE optionally selects the exact baseline sim.js for comparison.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as current from '../sim/sim.js';
import { getPolicyAdapter, makeTerrainSampler } from '../sim/policy-adapters.js';

const src = process.env.FH_SIM_SRC, ame = process.env.AME2_EXPORT;
assert.ok(src && ame, 'FH_SIM_SRC and AME2_EXPORT required (existing local assets)');
const code = process.env.FH_SIM_MODULE ? await import(pathToFileURL(resolve(process.env.FH_SIM_MODULE))) : current;
const { default: load } = await import(pathToFileURL(resolve(src, 'node_modules/@mujoco/mujoco/mujoco.js')));
const mj = await load();
mj.FS.mkdir('/go2'); mj.FS.mkdir('/go2/assets');
for (const f of readdirSync(join(src, 'assets/unitree_go2/assets'))) if (f.endsWith('.obj')) mj.FS.writeFile(`/go2/assets/${f}`, readFileSync(join(src, 'assets/unitree_go2/assets', f)));
mj.FS.writeFile('/go2/go2.xml', readFileSync(join(src, 'assets/unitree_go2/go2.xml')));
mj.FS.writeFile('/go2/scene.xml', '<mujoco><include file="go2.xml"/><include file="world.xml"/></mujoco>');
const dir = new URL('../sim/assets/collapsed-house-v2/', import.meta.url);
const map = JSON.parse(readFileSync(new URL('map.json', dir)));
for (const f of map.physics_assets) {
  const bytes = readFileSync(new URL(f, dir));
  mj.FS.writeFile(`/go2/${f}`, bytes); mj.FS.writeFile(`/go2/assets/${f}`, bytes);
}
mj.FS.writeFile('/go2/world.xml', readFileSync(new URL('collapsed-house-v2.xml', dir)));
for (const id of ['foothold-v2', 'ame2-demo']) {
  const adapter = getPolicyAdapter(id), root = id === 'foothold-v2' ? src : ame;
  const b = readFileSync(join(root, adapter.network.file));
  const infer = adapter.loadPolicy(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), adapter.network.manifest ? JSON.parse(readFileSync(join(root, adapter.network.manifest))) : undefined);
  const policy = (obs, mapping) => {
    assert.ok(obs.every(Number.isFinite) && (!mapping || mapping.every(Number.isFinite)), `${id}: finite observations`);
    const action = infer(obs, mapping);
    assert.equal(action.length, 12); assert.ok(action.every(Number.isFinite), `${id}: finite actions`);
    return action;
  };
  const sim = code.createSim(mj, '/go2/scene.xml', code.ISAAC_LIKE, policy, { floorZ: map.floor_z, spawn: map.spawn_xyyaw }, id);
  const scan = makeTerrainSampler(mj, sim.m, sim.d, { grid: [[0, 0], [-.1881, -.04675], [-.1881, .04675], [.1881, -.04675], [.1881, .04675]], rayOffset: 0 });
  const support = new Float64Array(5);
  let exception = null, minZ = Infinity, priorStop = null;
  try {
    sim.hold(.5);
    for (let i = 0; i < 1000 && !sim.fell; i++) {
      sim.cmd = id === 'foothold-v2' ? [.6, 0, 0] : [.6, 0, 0, 1];
      try { sim.step(); } catch (e) { exception = e.message; break; }
      assert.ok(sim.d.qpos.every(Number.isFinite) && sim.d.qvel.every(Number.isFinite) && sim.d.ctrl.every(Number.isFinite));
      minZ = Math.min(minZ, sim.z);
      // sim.z is not a policy input, so the same commands produce the exact
      // old stopping pose until the old UI would have paused on sim.fell.
      if (i + 1 === (id === 'foothold-v2' ? 248 : 266)) {
        scan(sim.d.qpos, support);
        priorStop = { seconds: sim.t, fell: sim.fell, clearance: sim.z, centreClearance: sim.d.qpos[2] - support[0], highestClearance: sim.d.qpos[2] - Math.max(...support), grav: sim.grav[2] };
        console.log(JSON.stringify({ test: 'prior-stop-pose', policy: id, ...priorStop }));
        assert.ok(priorStop.centreClearance >= .18 && priorStop.highestClearance < .18 && priorStop.grav < -.5, `${id}: reproduce high-nose support false positive`);
        assert.equal(sim.fell, !!process.env.FH_SIM_MODULE, `${id}: old stopping pose must remain unlatched after fix`);
      }
    }
    scan(sim.d.qpos, support);
    const row = { test: 'house-entry-forward', policy: id, seconds: +sim.t.toFixed(2), fell: sim.fell, clearance: sim.z, grav: sim.grav, xyz: Array.from(sim.d.qpos.slice(0, 3)), support: Array.from(support), minZ, exception };
    console.log(JSON.stringify(row));
    assert.equal(exception, null); assert.ok(priorStop, `${id}: reached old stopping pose`);
    // Report a later physical fall as a policy limitation; never assert that
    // this command succeeds in climbing the house or reaches a goal.
    if (sim.fell && !process.env.FH_SIM_MODULE) assert.ok(sim.z < .18 || sim.grav[2] > -.5, `${id}: actual low body or tilt must still stop`);
  } finally { scan.dispose(); sim.dispose(); }

  // Isolate support selection from gait quality, including a rotated step.
  for (const yaw of [0, Math.PI / 2]) {
    const step = yaw ? 'pos="0 .4 .125" size="2 .3 .125"' : 'pos=".4 0 .125" size=".3 2 .125"';
    mj.FS.writeFile('/go2/world.xml', `<mujoco><worldbody><geom group="1" type="plane" size="3 3 .1"/><geom group="1" type="box" ${step}/></worldbody></mujoco>`);
    const pose = code.createSim(mj, '/go2/scene.xml', code.ISAAC_LIKE, policy, { floorZ: 0, spawn: [-.5, -.5, yaw] }, id);
    try {
      assert.equal(pose.fell, false);
      pose.d.qpos[0] = pose.d.qpos[1] = 0; mj.mj_forward(pose.m, pose.d); pose.hold(0);
      assert.equal(pose.fell, !!process.env.FH_SIM_MODULE, `${id}: upright trunk approaching step yaw=${yaw}`);
      pose.reset(); pose.d.qpos[0] = -.5; pose.d.qpos[1] = -.5; pose.d.qpos[2] = .17;
      mj.mj_forward(pose.m, pose.d); pose.hold(0);
      assert.equal(pose.fell, true, `${id}: slumped body still stops`);
      pose.reset(); pose.d.qpos[0] = -.5; pose.d.qpos[1] = -.5; pose.d.qpos[2] = .4;
      pose.d.qpos[3] = Math.cos(61 * Math.PI / 360); pose.d.qpos[4] = Math.sin(61 * Math.PI / 360); pose.d.qpos[5] = pose.d.qpos[6] = 0;
      mj.mj_forward(pose.m, pose.d); pose.hold(0);
      assert.equal(pose.fell, true, `${id}: tilt over 60 degrees still stops`);
      pose.d.qpos[3] = 1; pose.d.qpos[4] = 0; mj.mj_forward(pose.m, pose.d); pose.hold(0);
      assert.equal(pose.fell, true, `${id}: fall stays latched`);
      pose.reset(); pose.d.qpos[0] = -.5; pose.d.qpos[1] = -.5; pose.d.qpos[2] = .19;
      mj.mj_forward(pose.m, pose.d); pose.hold(0);
      assert.equal(pose.fell, false, `${id}: body above unchanged 18cm limit`);
      pose.reset(); pose.d.qpos[3] = Math.cos(59 * Math.PI / 360); pose.d.qpos[4] = Math.sin(59 * Math.PI / 360); pose.d.qpos[5] = pose.d.qpos[6] = 0;
      mj.mj_forward(pose.m, pose.d); pose.hold(0);
      assert.equal(pose.fell, false, `${id}: tilt below unchanged 60 degree limit`);
      pose.reset(); pose.d.qpos[3] = 0; pose.d.qpos[4] = 1; pose.d.qpos[5] = pose.d.qpos[6] = 0;
      mj.mj_forward(pose.m, pose.d); pose.hold(0);
      assert.equal(pose.fell, true, `${id}: inverted body still stops`);
    } finally { pose.dispose(); }
  }
  // Restore the actual house before the next adapter.
  mj.FS.writeFile('/go2/world.xml', readFileSync(new URL('collapsed-house-v2.xml', dir)));
}
console.log('climb-stop PASS: both old stop poses, finite inference/physics, rotated step, low-body/tilt/latch; no gait success verdict');
