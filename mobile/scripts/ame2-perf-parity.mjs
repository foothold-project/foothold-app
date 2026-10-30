// Compare optimized code with the pre-change source, without copying weights.
// FH_SIM_SRC=<dependencies> AME2_EXPORT=<private export> node ... <baseline-dir>
// baseline-dir: ame2-network.js, policy-adapters.js (from git show <base>:mobile/sim/...).
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeTerrainSampler, getPolicyAdapter } from '../sim/policy-adapters.js';
import { loadAme2Policy } from '../sim/ame2-network.js';

const baseline = resolve(process.argv[2]), src = process.env.FH_SIM_SRC, exported = process.env.AME2_EXPORT;
assert.ok(src && exported, 'FH_SIM_SRC and AME2_EXPORT required');
const beforeModule = async (name) => {
  const source = readFileSync(join(baseline, name), 'utf8').replace("'./ame2-adapter.js'", JSON.stringify(new URL('../sim/ame2-adapter.js', import.meta.url).href));
  return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
};
const beforeNetwork = await beforeModule('ame2-network.js'), beforeAdapters = await beforeModule('policy-adapters.js');
const bytes = readFileSync(join(exported, 'ame2_actor.f32'));
const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const manifest = JSON.parse(readFileSync(join(exported, 'ame2_actor.json')));
const before = beforeNetwork.loadAme2Policy(buffer, manifest), after = loadAme2Policy(buffer, manifest);
const checks = JSON.parse(readFileSync(join(exported, 'check.json')));
let cases = 0, maxAbs = 0;
for (const group of Object.values(checks.cases)) for (let i = 0; i < group.n; i++) {
  const p = Float32Array.from(group.prop[i]), m = Float32Array.from(group.mapping[i].flat(2));
  const a = after(p, m, group.forced_centers?.[i]), b = before(p, m, group.forced_centers?.[i]);
  assert.deepEqual(after.offsets, before.offsets);
  for (let j = 0; j < 12; j++) maxAbs = Math.max(maxAbs, Math.abs(a[j] - b[j]));
  assert.deepEqual(a, b, `network ${cases++}`);
}
assert.equal(cases, 274);
console.log(JSON.stringify({ networkCases: cases, maxAbs, bitIdentical: true }));

const { default: load } = await import(pathToFileURL(resolve(src, 'node_modules/@mujoco/mujoco/mujoco.js')));
const mj = await load();
mj.FS.mkdir('/go2'); mj.FS.mkdir('/go2/assets');
for (const f of readdirSync(join(src, 'assets/unitree_go2/assets'))) if (f.endsWith('.obj')) mj.FS.writeFile(`/go2/assets/${f}`, readFileSync(join(src, 'assets/unitree_go2/assets', f)));
mj.FS.writeFile('/go2/go2.xml', readFileSync(join(src, 'assets/unitree_go2/go2.xml')));
let rays = 0, scans = 0, voids = 0;
const compare = (m, d, q) => {
  const originalGroups = Array.from(m.geom_group);
  for (const id of ['foothold-v2', 'ame2-demo']) {
    const adapter = getPolicyAdapter(id), cfg = adapter.observations.height;
    const oldSample = beforeAdapters.makeTerrainSampler(mj, m, d, cfg), newSample = makeTerrainSampler(mj, m, d, cfg);
    const oldScan = beforeAdapters.getPolicyAdapter(id).makeHeightScanner(mj, m, d, { floorZ: 0 });
    const newScan = adapter.makeHeightScanner(mj, m, d, { floorZ: 0 });
    try {
      const a = new Float64Array(cfg.grid.length), b = a.slice();
      oldSample(q, a); newSample(q, b);
      assert.deepEqual(a, b, `${id} raw heights/NaN`);
      voids += Array.from(a).filter(Number.isNaN).length; rays += a.length; scans++;
      const x = new Float32Array(adapter.observations.mappingSize ?? cfg.grid.length), y = x.slice();
      oldScan(q, x); newScan(q, y); assert.deepEqual(x, y, `${id} converted/void fallback`);
      assert.deepEqual(Array.from(m.geom_group), originalGroups, 'groups restored');
    } finally { oldSample.dispose(); newSample.dispose(); oldScan.dispose(); newScan.dispose(); }
  }
};
for (const { id } of JSON.parse(readFileSync(new URL('../sim/maps.json', import.meta.url)))) {
  const dir = new URL(`../sim/assets/${id}/`, import.meta.url), map = JSON.parse(readFileSync(new URL('map.json', dir)));
  for (const file of map.physics_assets ?? []) {
    const data = readFileSync(new URL(file, dir)); mj.FS.writeFile(`/go2/${file}`, data); mj.FS.writeFile(`/go2/assets/${file}`, data);
  }
  mj.FS.writeFile('/go2/world.xml', readFileSync(new URL(`${id}.xml`, dir)));
  mj.FS.writeFile('/go2/scene.xml', '<mujoco><include file="go2.xml"/><include file="world.xml"/></mujoco>');
  const m = mj.MjModel.from_xml_path('/go2/scene.xml'), d = new mj.MjData(m);
  try {
    mj.mj_forward(m, d);
    for (let i = 0; i < 12; i++) {
      const [sx, sy] = map.spawn_xyyaw;
      const angle = i * .37;
      compare(m, d, [sx + (i % 3 - 1) * .7, sy + (i % 4 - 1.5) * .6, map.floor_z + (i === 11 ? 3 : .4), Math.cos(angle / 2), 0, 0, Math.sin(angle / 2)]);
    }
    compare(m, d, [10000, 10000, .4, 1, 0, 0, 0]);
    console.log(`height parity ${id}: PASS`);
  } finally { d.delete(); m.delete(); }
}
// Mixed valid/missing rays and the all-missing virtual floor, explicit fixture.
mj.FS.writeFile('/void.xml', '<mujoco><worldbody><geom type="box" group="4" size=".3 3 .01" pos="-.3 0 -.01"/></worldbody></mujoco>');
const m = mj.MjModel.from_xml_path('/void.xml'), d = new mj.MjData(m);
try { mj.mj_forward(m, d); compare(m, d, [0, 0, .4, 1, 0, 0, 0]); compare(m, d, [100, 100, .4, 1, 0, 0, 0]); }
finally { d.delete(); m.delete(); }
// Exercise the native hfield and primitive branches, rotations, finite plane
// edges, invisible geoms/materials, body and lidar-proxy exclusions.
mj.FS.writeFile('/shapes.xml', `<mujoco><asset>
  <hfield name="hill" nrow="3" ncol="3" size="2 2 .5 .1"/>
  <material name="invisible" rgba="1 1 1 0"/></asset><worldbody>
  <geom type="hfield" hfield="hill" group="4" pos="0 0 -1"/>
  <geom type="sphere" size=".15" pos=".2 0 .1" group="4"/>
  <geom type="capsule" size=".08 .2" pos=".6 0 .1" euler="20 30 40" group="4"/>
  <geom type="ellipsoid" size=".15 .12 .2" pos="1 -.2 .1" euler="10 20 30" group="4"/>
  <geom type="cylinder" size=".15 .08" pos=".8 .3 .2" euler="30 10 20" group="4"/>
  <geom type="box" size=".1 .2 .1" pos="-.3 0 .2" euler="10 30 45" group="4"/>
  <geom type="plane" size=".2 .2 .01" pos="1.2 .1 .3" euler="0 10 0" group="4"/>
  <geom type="box" size="3 3 .01" pos="0 0 .6" rgba="1 1 1 0" group="4"/>
  <geom type="box" size="3 3 .01" pos="0 0 .7" material="invisible" group="4"/>
  <geom type="box" size="3 3 .01" pos="0 0 .8" contype="0" conaffinity="0" group="1"/>
  <body pos="0 0 .7"><geom type="sphere" size=".5" group="1"/></body>
  </worldbody></mujoco>`);
const shapes = mj.MjModel.from_xml_path('/shapes.xml');
shapes.hfield_data.set([0, .2, .4, .1, .8, .3, .4, .5, .1]);
const shapeData = new mj.MjData(shapes);
try {
  mj.mj_forward(shapes, shapeData);
  for (let i = 0; i < 12; i++) compare(shapes, shapeData, [0, 0, .4 + (i % 3) * .2, Math.cos(i / 6), 0, 0, Math.sin(i / 6)]);
  const missingBinding = Object.create(mj); missingBinding.mj_rayMesh = undefined;
  const cfg = getPolicyAdapter('ame2-demo').observations.height;
  const oldScan = beforeAdapters.makeTerrainSampler(mj, shapes, shapeData, cfg), fallback = makeTerrainSampler(missingBinding, shapes, shapeData, cfg);
  try {
    const a = new Float64Array(377), b = a.slice(), q = [0, 0, .4, 1, 0, 0, 0];
    oldScan(q, a); fallback(q, b); assert.deepEqual(a, b, 'missing native binding uses exact scalar fallback');
  } finally { oldScan.dispose(); fallback.dispose(); }
} finally { shapeData.delete(); shapes.delete(); }
// A binding failure must also restore exclusion groups.
const mockModel = { ngeom: 2, geom_bodyid: [0, 1], geom_contype: [1, 1], geom_conaffinity: [1, 1], geom_group: [4, 1] };
let disposed = false;
const scan = makeTerrainSampler({ IntBuffer: class { delete() { disposed = true; } }, mj_ray() { throw Error('ray failure'); } }, mockModel, {}, { grid: [[0, 0]], rayOffset: .501 });
assert.throws(() => scan([0, 0, .4, 1, 0, 0, 0], []), /ray failure/);
assert.deepEqual(mockModel.geom_group, [4, 1]); scan.dispose(); assert.equal(disposed, true);
console.log(JSON.stringify({ scans, rays, voids, rawAndConvertedBitIdentical: true, exceptionRestoresGroups: true }));
