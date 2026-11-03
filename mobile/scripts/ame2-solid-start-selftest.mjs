// REVIEW-271 B1: capped rays starting inside walls must retain the obstacle.
// Existing local MuJoCo only; FH_SIM_SRC required, no browser/server/policy.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeAme2Adapter, ame2Grid } from '../sim/ame2-adapter.js';
import { makeTerrainSampler } from '../sim/policy-adapters.js';

assert.ok(process.env.FH_SIM_SRC, 'FH_SIM_SRC required; no downloads');
const { default: load } = await import(pathToFileURL(resolve(process.env.FH_SIM_SRC, 'node_modules/@mujoco/mujoco/mujoco.js')));
const mj = await load(), adapter = makeAme2Adapter(makeTerrainSampler);
const scalar = makeAme2Adapter((mj, ...args) => makeTerrainSampler(new Proxy(mj, {
  get: (target, key) => key === 'mju_rayGeom' ? undefined : target[key],
}), ...args));
const hit = new mj.DoubleBuffer(3);
let cases = 0, retained = 0;
function insideBox(m, d, g, p) {
  const pos = d.geom_xpos, mat = d.geom_xmat, size = m.geom_size;
  const delta = p.map((v, i) => v - pos[3 * g + i]);
  return [0, 1, 2].every((i) => Math.abs(delta[0] * mat[9 * g + i] + delta[1] * mat[9 * g + 3 + i] + delta[2] * mat[9 * g + 6 + i]) < size[3 * g + i] - 1e-9);
}
function check(name, q, wall, cover, expectedCount) {
  const m = mj.MjModel.from_xml_path('/solid-start.xml'), d = new mj.MjData(m); mj.mj_forward(m, d);
  const groups = Array.from(m.geom_group), scans = [adapter, scalar].map((a) => a.makeHeightScanner(mj, m, d, { floorZ: 0 }));
  const out = scans.map(() => new Float32Array(1131));
  try {
    assert.equal(m.geom_type[wall], 6, `${name}: expected box wall`);
    scans.forEach((scan, i) => scan(q, out[i]));
    assert.deepEqual(out[0], out[1], `${name}: all 377 cells batched/scalar identical`);
    assert.deepEqual(Array.from(m.geom_group), groups, `${name}: geometry groups restored`);
    const yaw = adapter.yawOf(q), c = Math.cos(yaw), s = Math.sin(yaw), cells = [];
    for (let i = 0; i < ame2Grid.length; i++) {
      const [x, y] = ame2Grid[i], p = [q[0] + c * x - s * y, q[1] + s * x + c * y, q[2]];
      if (cover !== null) {
        assert.equal(m.geom_type[cover], 6, `${name}: expected box cover`);
        const distance = mj.mju_rayGeom(d.geom_xpos.slice(3 * cover, 3 * cover + 3), d.geom_xmat.slice(9 * cover, 9 * cover + 9), m.geom_size.slice(3 * cover, 3 * cover + 3), p, [0, 0, 1], 6, hit);
        if (distance < 0 || hit.GetView()[2] >= 0) continue;
        p[2] += distance - .001;
      }
      if (!insideBox(m, d, wall, p)) continue;
      assert.equal(out[0][3 * i + 2], 1.5, `${name}/${i}: wall retained when cover origin is solid`);
      cells.push(i);
    }
    if (expectedCount !== undefined) assert.equal(cells.length, expectedCount, `${name}: review reproduction cell count`);
    assert.ok(cells.length > 0, `${name}: must exercise a solid ray origin`);
    retained += cells.length; cases++;
    console.log(JSON.stringify({ name, retainedWallCells: cells.length, batchedScalarMaxAbs: 0 }));
  } finally { scans.forEach((s) => s.dispose()); d.delete(); m.delete(); }
}
const floor = '<geom group="4" type="plane" size="4 4 .01"/>', wall = '<geom group="1" type="box" pos=".9 0 .95" size=".2 3 .95"/>';
try {
  for (const [name, geometry, cover] of [
    ['wall only', floor + wall, null],
    ['wall top equals cover underside', floor + wall + '<geom group="1" type="box" pos=".9 0 2" size=".3 3 .1"/>', 2],
    ['pipe intersects wall', floor + wall + '<geom group="1" type="box" pos=".9 0 1.5" size=".3 3 .1"/>', 2],
    ['beam intersects column', floor + '<geom group="1" type="box" pos=".9 0 1.5" size=".18 .18 1.5"/><geom group="1" type="box" pos=".9 0 3" size=".18 3 .18"/>', 2],
  ]) {
    mj.FS.writeFile('/solid-start.xml', `<mujoco><worldbody>${geometry}<body pos="0 0 1"><freejoint/><geom group="1" type="box" size=".2 .2 .1"/></body></worldbody></mujoco>`);
    check(name, [0, 0, .35, 1, 0, 0, 0], 1, cover);
  }
  const dir = new URL('../sim/assets/factory-inspection/', import.meta.url), map = JSON.parse(readFileSync(new URL('map.json', dir)));
  for (const f of map.physics_assets ?? []) mj.FS.writeFile('/' + f, readFileSync(new URL(f, dir)));
  mj.FS.writeFile('/solid-start.xml', readFileSync(new URL('factory-inspection.xml', dir)));
  check('factory outer wall #7 / embedded box #302', [40.70054, 46.97936, .32887, .72889, 0, 0, .68463], 7, 302, 14);
  check('factory column #155 / beam #156', [29.74458, 25.77593, .29935, .98566, 0, 0, .16876], 155, 156, 12);
} finally { hit.delete(); }
console.log(`AME-2 solid-start PASS: ${cases} scenes, ${retained} wall cells retained at +1.5; batched/scalar identical, geometry groups restored`);
