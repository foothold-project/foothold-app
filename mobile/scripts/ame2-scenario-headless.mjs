// Native MuJoCo + existing ONNX CPU; measurements only, no gait verdict.
// FH_SIM_SRC, AME2_EXPORT, AME2_ORT_NODE required. No server or robot.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createSim, ISAAC_LIKE, loadPolicy } from '../sim/sim.js';
import { loadAme2OnnxPolicy } from '../sim/ame2-onnx.js';
import { createScenarioRunner, REACH_RADIUS } from '../sim/scenario.js';
import { planRoute } from '../sim/astar.js';
import { decodeMap, makeLidar } from '../sim/lidar.js';
import { frontDistance } from '../sim/scenario.js';
const src = process.env.FH_SIM_SRC, dir = process.env.AME2_EXPORT;
const { default: load } = await import(pathToFileURL(resolve(src, 'node_modules/@mujoco/mujoco/mujoco.js')));
const mj = await load(); mj.FS.mkdir('/go2'); mj.FS.mkdir('/go2/assets');
for (const f of readdirSync(join(src, 'assets/unitree_go2/assets'))) if (f.endsWith('.obj')) mj.FS.writeFile('/go2/assets/' + f, readFileSync(join(src, 'assets/unitree_go2/assets', f)));
mj.FS.writeFile('/go2/go2.xml', readFileSync(join(src, 'assets/unitree_go2/go2.xml')));
const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const ort = await import(pathToFileURL(resolve(process.env.AME2_ORT_NODE)));
if (ort.env?.wasm) ort.env.wasm.numThreads = 1;
const onnx = await loadAme2OnnxPolicy(ort, readFileSync(join(dir, 'ame2_actor.onnx')), process.env.AME2_ORT_BACKEND ?? 'cpu');
const baseline = execFileSync('git', ['show', `${process.env.FH_SCENARIO_BASE || 'd9b6f38'}:mobile/sim/scenario.js`], { encoding: 'utf8' })
  .replaceAll("'./lidar.js'", JSON.stringify(new URL('../sim/lidar.js', import.meta.url).href))
  .replaceAll("'./settings.js'", JSON.stringify(new URL('../sim/settings.js', import.meta.url).href));
const before = await import('data:text/javascript;base64,' + Buffer.from(baseline).toString('base64'));
const weights = readFileSync(join(src, 'policy_v2.f32'));
const f32 = loadPolicy(weights.buffer.slice(weights.byteOffset, weights.byteOffset + weights.byteLength));
try {
  for (const id of ['warehouse', 'collapsed-house-v2']) {
    const map = decodeMap(read(`../sim/assets/${id}/map.json`)), route = read(`../sim/assets/${id}/scenarios.json`)[0];
    for (const f of map.physics_assets ?? []) { const data = readFileSync(new URL(`../sim/assets/${id}/${f}`, import.meta.url)); mj.FS.writeFile('/go2/' + f, data); mj.FS.writeFile('/go2/assets/' + f, data); }
    mj.FS.writeFile('/go2/world.xml', readFileSync(new URL(`../sim/assets/${id}/${id}.xml`, import.meta.url)));
    mj.FS.writeFile('/go2/scene.xml', '<mujoco><include file="go2.xml"/><include file="world.xml"/></mujoco>');
    const sim = createSim(mj, '/go2/scene.xml', ISAAC_LIKE, onnx, { floorZ: map.floor_z, spawn: map.spawn_xyyaw }, 'ame2-demo', { ame2DelaySteps: 0 });
    sim.hold(.5);
    const points = await planRoute(map, { x: sim.d.qpos[0], y: sim.d.qpos[1] }, route.points);
    assert.ok(points);
    const scan = makeLidar(mj, sim.m, sim.d, 360), runner = createScenarioRunner(sim, () => false);
    runner.start(points);
    let steps = 0, front = Infinity, last = 0, horizon = 0;
    const arrived = [], started = performance.now();
    while (runner.active && sim.t < 240) {
      if (!(steps % 5)) { const q = sim.d.qpos; front = frontDistance(scan(q[0], q[1], q[2] + .1, 2 * Math.atan2(q[6], q[3]))); }
      runner.tick(front, .02);
      if (runner.index > last) {
        for (let i = last; i < runner.index; i++) arrived.push({ pathPoint: i + 1, stage: points[i].mark + 1, seconds: +sim.t.toFixed(2), distance: +Math.hypot(points[i].x - sim.d.qpos[0], points[i].y - sim.d.qpos[1]).toFixed(4) });
        last = runner.index;
      }
      assert.equal(sim.cmd.length, 4); horizon = Math.max(horizon, Math.hypot(sim.cmd[0], sim.cmd[1]));
      assert.ok(horizon <= 2 + 1e-12);
      assert.ok(arrived.every((p) => p.distance <= REACH_RADIUS));
      if (!runner.active) break;
      await sim.step(); steps++;
      assert.ok(sim.d.qpos.every(Number.isFinite));
    }
    const reached = runner.index, status = runner.status;
    if (runner.active) runner.cancel('시간 제한');
    console.log(JSON.stringify({ policy: 'ame2-demo', map: id, route: route.id, status, pathPoints: points.length, reached, stages: route.points.length,
      stagesReached: arrived.filter((p) => p.pathPoint === points.length || points[p.pathPoint]?.mark !== p.stage - 1).length,
      seconds: +sim.t.toFixed(2), blocked: status === '막힘' ? 1 : 0, finalPose: Array.from(sim.d.qpos.slice(0, 7)), best: runner.best, turn: runner.turn, stall: runner.stall, horizon, arrived, wallSeconds: +(performance.now() - started).toFixed(2) / 1000 }));
    // STOP invalidates pending asynchronous inference before any physics can apply.
    let complete;
    const delayed = () => new Promise((r) => { complete = r; }); delayed.async = true;
    const stopSim = createSim(mj, '/go2/scene.xml', ISAAC_LIKE, delayed, { floorZ: map.floor_z, spawn: map.spawn_xyyaw }, 'ame2-demo');
    let stopped = false;
    const stopRunner = createScenarioRunner(stopSim, () => stopped);
    stopRunner.start(points); stopRunner.tick(Infinity, .02);
    const pending = stopSim.step(); await Promise.resolve();
    const time = stopSim.d.time; stopped = true; stopRunner.tick(); stopSim.clearPolicyState();
    complete(new Float32Array(12).fill(1)); assert.equal(await pending, false);
    assert.equal(stopSim.d.time, time); assert.deepEqual(stopSim.cmd, [0, 0, 0, 1]); stopSim.dispose(); sim.dispose();
    // Compare full default-policy scenario command and physics traces, every tick.
    let prior;
    for (const [label, makeRunner] of [['before', before.createScenarioRunner], ['after', createScenarioRunner]]) {
      const robot = createSim(mj, '/go2/scene.xml', ISAAC_LIKE, f32, { floorZ: map.floor_z, spawn: map.spawn_xyyaw }); robot.hold(.5);
      const lidar = makeLidar(mj, robot.m, robot.d, 360), r = makeRunner(robot, () => false), trace = [];
      r.start(points); let n = 0, f = Infinity;
      while (r.active && robot.t < 240) {
        if (!(n % 5)) { const q = robot.d.qpos; f = frontDistance(lidar(q[0], q[1], q[2] + .1, 2 * Math.atan2(q[6], q[3]))); }
        r.tick(f, .02); trace.push([r.index, r.status, robot.cmd.slice(), Array.from(robot.d.qpos), Array.from(robot.d.qvel)]);
        if (!r.active) break; robot.step(); n++;
      }
      if (label === 'before') prior = trace; else assert.deepEqual(trace, prior, `${id}: nvidia-demo scenario unchanged`);
      console.log(JSON.stringify({ policy: 'nvidia-demo', map: id, label, ticks: trace.length, status: r.status, reached: r.index, seconds: +robot.t.toFixed(2), traceDifferences: label === 'after' ? 0 : undefined }));
      robot.dispose();
    }
  }
  console.log('Contract checks: direct goal <=2m (replaces joystick <=1m horizon), ordered reach <=0.3m, STOP pending physics delta 0, default traces identical');
} finally { await onnx.dispose(); }
