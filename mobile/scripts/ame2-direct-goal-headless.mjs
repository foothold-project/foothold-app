// Real model-boundary goal traces and numeric gait measurements, separately.
// Existing local assets only; run under the shared heavy-test flock.
// FH_SIM_SRC, AME2_EXPORT, FH_AME2_ONNX, FH_ORT_WEB required.
// Optional output directory argv[2]; no server, robot, download, or gait verdict.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createSim, ISAAC_LIKE } from '../sim/sim.js';
import { loadAme2Policy } from '../sim/ame2-network.js';
import { loadAme2OnnxPolicy, AME2_ONNX_SHA256 } from '../sim/ame2-onnx.js';
import { createScenarioRunner, frontDistance, REACH_RADIUS } from '../sim/scenario.js';
import { planRoute } from '../sim/astar.js';
import { decodeMap, makeLidar } from '../sim/lidar.js';
const src = process.env.FH_SIM_SRC, dir = process.env.AME2_EXPORT;
const out = resolve(process.argv[2] ?? 'runs/ame2-direct-goal'); mkdirSync(out, { recursive: true });
const replayOnly = process.argv.includes('--replay-only');
const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const { default: load } = await import(pathToFileURL(resolve(src, 'node_modules/@mujoco/mujoco/mujoco.js')));
const mj = await load(); mj.FS.mkdir('/go2'); mj.FS.mkdir('/go2/assets');
for (const f of readdirSync(join(src, 'assets/unitree_go2/assets'))) if (f.endsWith('.obj')) mj.FS.writeFile('/go2/assets/' + f, readFileSync(join(src, 'assets/unitree_go2/assets', f)));
mj.FS.writeFile('/go2/go2.xml', readFileSync(join(src, 'assets/unitree_go2/go2.xml')));
const weights = readFileSync(join(dir, 'ame2_actor.f32'));
const f32 = loadAme2Policy(weights.buffer.slice(weights.byteOffset, weights.byteOffset + weights.byteLength), JSON.parse(readFileSync(join(dir, 'ame2_actor.json'))));
const ort = await import(pathToFileURL(resolve(process.env.FH_ORT_WEB, 'dist/ort.wasm.min.mjs'))); ort.env.wasm.numThreads = 1;
const model = readFileSync(process.env.FH_AME2_ONNX);
assert.equal(createHash('sha256').update(model).digest('hex'), AME2_ONNX_SHA256);
const onnx = await loadAme2OnnxPolicy(ort, model, 'wasm');
const yawOf = (q) => Math.atan2(2 * (q[3] * q[6] + q[4] * q[5]), 1 - 2 * (q[5] ** 2 + q[6] ** 2));
const evidence = replayOnly ? JSON.parse(readFileSync(join(out, 'goal-inputs.json'))) : { schema: 'ame2-direct-goal/1', head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sourceHashes: Object.fromEntries(['scenario.js', 'ame2-adapter.js', 'sim.js', 'policy-adapters.js'].map((file) => [file, createHash('sha256').update(readFileSync(new URL('../sim/' + file, import.meta.url))).digest('hex')])),
  note: 'Local MuJoCo, ISAAC_LIKE, fixed action delay 0, ONNX WASM single thread; no gait verdict. Goal is captured at the actual policy call, prop[45:49]. All measured ticks retained.',
  inputChecks: [], gait: [], runs: [], controlledTransitions: [] };
if (replayOnly) evidence.controlledTransitions = [];
const save = () => writeFileSync(join(out, 'goal-inputs.json'), JSON.stringify(evidence, null, 2) + '\n');
function scene(id) {
  const map = decodeMap(read(`../sim/assets/${id}/map.json`));
  for (const f of map.physics_assets ?? []) { const b = readFileSync(new URL(`../sim/assets/${id}/${f}`, import.meta.url)); mj.FS.writeFile('/go2/' + f, b); mj.FS.writeFile('/go2/assets/' + f, b); }
  mj.FS.writeFile('/go2/world.xml', readFileSync(new URL(`../sim/assets/${id}/${id}.xml`, import.meta.url)));
  mj.FS.writeFile('/go2/scene.xml', '<mujoco><include file="go2.xml"/><include file="world.xml"/></mujoco>');
  return map;
}
function expected(q, p, heading) {
  const yaw = yawOf(q), distance = Math.hypot(p.x - q[0], p.y - q[1]);
  const angle = Math.atan2(p.y - q[1], p.x - q[0]) - yaw;
  return [Math.min(2, distance) * Math.cos(angle), Math.min(2, distance) * Math.sin(angle), Math.sin(heading - yaw), Math.cos(heading - yaw)];
}
function capture(sim, runner, origin, prop, trace, front) {
  const p = runner.points[runner.index], next = runner.points[runner.index + 1], previous = runner.points[runner.index - 1] ?? origin;
  const heading = Number.isFinite(p.yaw) ? p.yaw : next ? Math.atan2(next.y - p.y, next.x - p.x) : Math.atan2(p.y - previous.y, p.x - previous.x);
  const q = Array.from(sim.d.qpos.slice(0, 7)), goal = Array.from(prop.slice(45, 49));
  const want = expected(q, p, heading), maxError = Math.max(...goal.map((v, i) => Math.abs(v - want[i])));
  assert.ok(maxError < 2e-7, `actual model input differs from world goal: ${maxError}`);
  assert.deepEqual(goal, Array.from(Float32Array.from(sim.cmd)));
  assert.ok(Math.hypot(goal[0], goal[1]) <= 2 + 2e-7);
  trace.push({ tick: trace.length, seconds: +sim.t.toFixed(2), index: runner.index, worldGoal: p, worldHeading: heading, pose: q, goal, expected: want, maxError, front: Number.isFinite(front) ? front : null });
}
try {
  for (const [backend, policy] of [['f32', f32], ['onnx-wasm', onnx]]) {
    for (const test of replayOnly ? [] : [0, 45, 180, 'warehouse', 'collapsed-house-v2']) {
      const id = typeof test === 'number' ? 'warehouse' : test, map = scene(id), trace = [];
      let sim, runner, front = Infinity;
      const origin = { x: map.spawn_xyyaw[0], y: map.spawn_xyyaw[1] };
      const wrapped = (prop, mapping) => { capture(sim, runner, origin, prop, trace, front); return policy(prop, mapping); }; wrapped.async = !!policy.async;
      sim = createSim(mj, '/go2/scene.xml', ISAAC_LIKE, wrapped, { floorZ: map.floor_z, spawn: map.spawn_xyyaw }, 'ame2-demo', { ame2DelaySteps: 0 });
      try {
        sim.hold(.5); origin.x = sim.d.qpos[0]; origin.y = sim.d.qpos[1];
        const angle = typeof test === 'number' ? yawOf(sim.d.qpos) + test * Math.PI / 180 : null;
        const destinations = angle === null ? read(`../sim/assets/${id}/scenarios.json`)[0].points : [{ x: origin.x + 1.5 * Math.cos(angle), y: origin.y + 1.5 * Math.sin(angle) }];
        const points = await planRoute(map, origin, destinations); assert.ok(points?.length);
        runner = createScenarioRunner(sim, () => false); runner.start(points, angle !== null);
        const scan = makeLidar(mj, sim.m, sim.d, 360), transitions = []; let steps = 0, last = 0;
        while (runner.active && sim.t < 240) {
          if (!(steps % 5)) { const q = sim.d.qpos; front = frontDistance(scan(q[0], q[1], q[2] + .1, yawOf(q))); }
          runner.tick(front, .02);
          if (runner.index > last) {
            for (let i = last; i < runner.index; i++) { const distance = Math.hypot(points[i].x - sim.d.qpos[0], points[i].y - sim.d.qpos[1]); assert.ok(distance <= REACH_RADIUS); transitions.push({ from: i, to: i + 1, seconds: +sim.t.toFixed(2), distance }); }
            last = runner.index;
          }
          if (!runner.active) break;
          await sim.step(); steps++; assert.ok(sim.d.qpos.every(Number.isFinite));
        }
        const status = runner.active ? '시간 제한' : runner.status;
        const name = typeof test === 'number' ? `click-${test}` : read(`../sim/assets/${id}/scenarios.json`)[0].id;
        const row = { backend, map: id, name, inputTicks: trace.length, maxError: Math.max(...trace.map((t) => t.maxError)), firstGoal: trace[0]?.goal, transitions: transitions.length };
        evidence.inputChecks.push(row);
        const gait = { backend, map: id, name, arrived: +(status === '완료'), seconds: +sim.t.toFixed(2), blocked: +(status === '막힘'), reached: runner.index, pathPoints: points.length, status, finalDistance: Math.hypot(destinations.at(-1).x - sim.d.qpos[0], destinations.at(-1).y - sim.d.qpos[1]) };
        evidence.gait.push(gait); evidence.runs.push({ backend, map: id, name, points, transitions, trace }); save();
        console.log(JSON.stringify({ input: row, gait }));
      } finally { runner?.cancel(); sim.dispose(); }
    }
    // Controlled pose replay exercises EVERY waypoint transition, independently
    // of the gait result; all calls still go through createSim.step -> observe.
    // This is input wiring evidence only, never counted as walking/arrival.
    for (const id of ['warehouse', 'collapsed-house-v2']) {
      const map = scene(id), origin = { x: map.spawn_xyyaw[0], y: map.spawn_xyyaw[1] }, trace = [];
      let sim, runner;
      const wrapped = (prop, mapping) => { capture(sim, runner, origin, prop, trace, Infinity); return policy(prop, mapping); }; wrapped.async = !!policy.async;
      sim = createSim(mj, '/go2/scene.xml', ISAAC_LIKE, wrapped, { floorZ: map.floor_z, spawn: map.spawn_xyyaw }, 'ame2-demo', { ame2DelaySteps: 0 });
      try {
        const points = await planRoute(map, origin, read(`../sim/assets/${id}/scenarios.json`)[0].points);
        runner = createScenarioRunner(sim, () => false); runner.start(points);
        const poseAt = (x, y) => { sim.reset(); sim.d.qpos[0] = x; sim.d.qpos[1] = y; mj.mj_forward(sim.m, sim.d); };
        for (let i = 0; i < points.length; i++) {
          // Position 0.4m before the current target, outside arrival radius.
          const prev = points[i - 1] ?? origin, p = points[i], a = Math.atan2(p.y - prev.y, p.x - prev.x);
          poseAt(p.x - .4 * Math.cos(a), p.y - .4 * Math.sin(a));
          runner.tick(Infinity, 0); assert.equal(runner.index, i); await sim.step();
          poseAt(p.x, p.y);
          runner.tick(Infinity, 0); assert.equal(runner.index, i + 1);
          if (runner.active) await sim.step();
        }
        evidence.controlledTransitions.push({ backend, map: id, points, trace }); save();
      } finally { runner?.cancel(); sim.dispose(); }
    }
  }
  // Same controlled world poses produce bit-identical goal slots before the
  // actual synchronous f32 and asynchronous ONNX policies, despite actions.
  // Reset yaw/pose exactly before each model call to exclude gait drift.
  for (const id of ['warehouse', 'collapsed-house-v2']) {
    const a = evidence.controlledTransitions.find((r) => r.backend === 'f32' && r.map === id);
    const b = evidence.controlledTransitions.find((r) => r.backend === 'onnx-wasm' && r.map === id);
    assert.deepEqual(a.trace.map((t) => t.goal), b.trace.map((t) => t.goal));
  }
  for (const a of evidence.inputChecks.filter((r) => r.backend === 'f32')) {
    const b = evidence.inputChecks.find((r) => r.backend === 'onnx-wasm' && r.map === a.map && r.name === a.name);
    assert.deepEqual(a.firstGoal, b.firstGoal);
  }
  writeFileSync(join(out, 'INPUTS.md'), '| Backend | Map / target | Actual input ticks | Max goal error | Waypoint transitions |\n|---|---|---:|---:|---:|\n' + evidence.inputChecks.map((r) => `| ${r.backend} | ${r.map} / ${r.name} | ${r.inputTicks} | ${r.maxError.toExponential(3)} | ${r.transitions} |`).join('\n') + '\n\nAll actual model-input goals are compared independently with world waypoint/yaw conversion. Float32 tolerance: 2e-7. First goals match bit-for-bit between f32/ONNX in all five runs. Controlled pose replay across every waypoint produces bit-identical f32/ONNX goal slots; those traces are separate from gait measurements in goal-inputs.json.\n');
  writeFileSync(join(out, 'GAIT.md'), '| Backend | Map / target | Arrived (0/1) | Time (s) | Blocked (0/1) | Reached / path points |\n|---|---|---:|---:|---:|---:|\n' + evidence.gait.map((r) => `| ${r.backend} | ${r.map} / ${r.name} | ${r.arrived} | ${r.seconds} | ${r.blocked} | ${r.reached} / ${r.pathPoints} |`).join('\n') + '\n');
  console.log('Input wiring checks PASS; numeric walking results recorded separately.');
} finally { await onnx.dispose(); }
