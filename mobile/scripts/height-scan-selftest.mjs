// Existing local MuJoCo only: FH_SIM_SRC=<sim dependencies> node mobile/scripts/height-scan-selftest.mjs
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getPolicyAdapter, POLICY_ADAPTERS } from '../sim/policy-adapters.js';

const adapter = getPolicyAdapter('foothold-v2'), grid = adapter.observations.height.grid;
assert.deepEqual(Object.keys(POLICY_ADAPTERS), ['foothold-v2']);
assert.throws(() => getPolicyAdapter('START'));
assert.throws(() => getPolicyAdapter('AME-2'));
assert.equal(grid.length, 187);
for (const [i, expected] of [[0, [-0.8, -0.5]], [16, [0.8, -0.5]], [17, [-0.8, -0.4]], [93, [0, 0]], [186, [0.8, 0.5]]]) assert.deepEqual(grid[i], expected, `xy index ${i}`);
if (!process.env.FH_SIM_SRC) throw new Error('FH_SIM_SRC required; use existing local MuJoCo');
const { default: load } = await import(pathToFileURL(resolve(process.env.FH_SIM_SRC, 'node_modules/@mujoco/mujoco/mujoco.js')));
const mj = await load();
const make = (extra = '') => {
  mj.FS.writeFile('/height-test.xml', `<mujoco><worldbody><geom name="floor" type="box" group="4" size="2 2 .02" pos="0 0 .014"/>
    <geom name="aws_robomaker_warehouse_Lamp_01_005/Lamp_01_collision_c0" type="box" group="1" size="1 1 .1" pos="0 0 10"/>
    <geom type="box" group="1" contype="0" conaffinity="0" size="1 1 .1" pos="0 0 2"/>
    <body pos="0 0 1"><joint type="free"/><geom type="sphere" group="1" size=".5"/></body>${extra}</worldbody></mujoco>`);
  const m = mj.MjModel.from_xml_path('/height-test.xml'), d = new mj.MjData(m);
  mj.mj_forward(m, d);
  return { m, d, scan: adapter.makeHeightScanner(mj, m, d) };
};
const flat = make(), step = make('<geom name="step" type="box" group="1" size=".4 1 .15" pos=".6 0 .184"/>');
try {
  const q = [0, 0, 0.434, 1, 0, 0, 0], out = new Float32Array(235), before = Array.from(flat.m.geom_group);
  flat.scan(q, out, 48);
  assert.ok(out.slice(48).every((v) => v === Math.fround(q[2] - 0.034 - 0.5)), 'flat equals previous floor-relative formula');
  assert.deepEqual(Array.from(flat.m.geom_group), before, 'lidar groups restored');
  step.scan(q, out, 48);
  assert.ok(Math.abs(out[48 + 5 * 17] + 0.1) < 1e-6, 'behind is floor');
  assert.ok(Math.abs(out[48 + 5 * 17 + 11] + 0.4) < 1e-6, 'ahead sees raised step with correct sign');
  assert.equal(out[48 + 11], out[48 + 17 + 11], 'x fastest across y rows');
  step.scan([0, 0, q[2], Math.SQRT1_2, 0, 0, Math.SQRT1_2], out, 48);
  assert.ok(Math.abs(out[48 + 5 * 17 + 11] + 0.1) < 1e-6, 'yaw rotates forward away from step');
  assert.ok(Math.abs(out[48 + 1 * 17 + 8] + 0.4) < 1e-6, 'negative local y rotates to world +x');
  flat.scan([100, 100, q[2], 1, 0, 0, 0], out, 48);
  assert.ok(out.slice(48).every((v) => v === 1), 'miss/gap is +1');
  flat.scan([0, 0, 5, 1, 0, 0, 0], out, 48);
  assert.ok(out.slice(48).every((v) => v === 1), 'clip +1');
  flat.scan([0, 0, -2, 1, 0, 0, 0], out, 48);
  assert.ok(out.slice(48).every((v) => v === -1), 'clip -1');
  console.log('height scan PASS: flat, step/sign, xy order, yaw, robot/proxy/ceiling-light exclusion, group restore, miss/gap, clip');
} finally {
  for (const s of [flat, step]) { s.scan.dispose(); s.d.delete(); s.m.delete(); }
}
