// FH_SIM_SRC=<local deps> node mobile/scripts/walk-surface-selftest.mjs
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { makeWalkSurface, MAX_STEP, MIN_UP } from '../sim/walk-surface.js';
import { findPath, fits, inflate, visible } from '../sim/astar.js';
import { decodeMap } from '../sim/lidar.js';

const grid = () => ({ w: 40, h: 30, res: .1, origin: [-2, -1.5], px: new Uint8Array(1200).fill(254) });
const a = { x: -1.05, y: .05 }, b = { x: 1.05, y: .05 };
{
  const map = grid(), from = { x: 1.05, y: .05 }, to = { x: 1, y: 0 };
  map.heightAt = (x, y) => x < 1 || y < 0 ? NaN : 0;
  assert.equal(visible(map, await inflate(map), from, to), true, 'negative segment stops in the endpoint cell at its inclusive lower corner');
  assert.deepEqual(await findPath(map, from, to), [to]);
}
for (const [height, allowed] of [[MAX_STEP, true], [MAX_STEP + .001, false], [1.2, false]]) {
  const map = grid(); map.heightAt = (x) => x < 0 ? 0 : height;
  assert.equal(await fits(map, b), true, 'XY clearance stays identical to web simstart');
  assert.equal(visible(map, await inflate(map), a, b), allowed);
  assert.equal(!!await findPath(map, a, b), allowed, 'A* and smoothing both enforce steps');
}
{
  const map = grid(); map.heightAt = (x) => x < -.5 ? 0 : x < 0 ? .125 : x < .5 ? .25 : .375;
  assert.ok(await findPath(map, a, b), 'existing 12.5 cm stair treads connect');
  map.heightAt = () => NaN;
  assert.equal(await findPath(map, a, b), null, 'no supporting surface');
}
{
  const map = { ...grid(), w: 200, px: new Uint8Array(6000).fill(254) }, seen = new Set();
  map.heightAt = (x, y) => {
    const key = `${Math.floor(x / map.res)},${Math.floor(y / map.res)}`;
    if (!seen.has(key)) { seen.add(key); const end = performance.now() + .4; while (performance.now() < end) {} }
    return 0;
  };
  let inputTurns = 0;
  const timer = setInterval(() => inputTurns++, 1);
  try {
    assert.ok(await findPath(map, a, { x: 15.05, y: .05 }));
    assert.ok(inputTurns > 1, 'uncached height queries on a long straight path yield to input');
  } finally { clearInterval(timer); }
}
const { default: load } = await import(pathToFileURL(resolve(process.env.FH_SIM_SRC, 'node_modules/@mujoco/mujoco/mujoco.js')));
const mj = await load();
mj.FS.writeFile('/walk-test.xml', `<mujoco><worldbody>
  <geom type="plane" size="5 5 .1" group="1"/>
  <geom type="box" size=".5 .5 .6" pos="0 0 .6" group="1"/>
  <geom type="box" size=".5 .5 .05" pos="2 0 2" group="1"/>
  <geom type="box" size=".4 .4 .4" pos="-2 0 2" group="1" contype="0" conaffinity="0"/>
  <geom type="box" size=".5 .5 .6" pos="-3 0 .6" group="1"/>
  <geom type="box" size=".5 .5 .02" pos="-3 0 1.2" group="1"/>
  <body pos="0 0 2"><freejoint/><geom type="sphere" size=".2" group="0"/></body>
</worldbody></mujoco>`);
const m = mj.MjModel.from_xml_path('/walk-test.xml'), d = new mj.MjData(m);
mj.mj_forward(m, d);
const surface = makeWalkSurface(mj, m, d), before = Array.from(m.geom_group);
assert.ok(Math.abs(surface.floorAt(0, 0) - 1.2) < 1e-9, 'actual raised support, robot excluded');
assert.equal(surface.floorAt(-2, 0), 0, 'noncontact visual proxy excluded');
assert.ok(Math.abs(surface.floorAt(-3, 0) - 1.22) < 1e-9, 'overlapping support slab is not misclassified as a ceiling');
assert.equal(surface.floorAt(2, 0, 1.6), 0, 'selected lower floor excludes overhead slab');
assert.equal(surface.floorAt(2, 0), 0, 'overhead top is not a floor, even without an explicit ceiling');
assert.equal(surface.pick([2, 0, 4], [0, 0, -1], { floor_z: 0 }).z, 0, 'top-view click ignores the whole overhead slab');
assert.ok(surface.pick([4, 0, .6], [-1, 0, 0], { floor_z: 0 }).up < MIN_UP, 'wall sides remain rejection hits');
assert.ok(surface.raycast([0, 0, 3], [0, 0, -1]).up >= MIN_UP);
assert.ok(surface.raycast([2, 0, 1], [0, 0, 1]).up < 0, 'ceiling underside rejected');
assert.equal(surface.raycast([0, 0, 3], [0, 0, 1]), null);
assert.deepEqual(Array.from(m.geom_group), before, 'temporary exclusions restored');
surface.dispose(); d.delete(); m.delete();
{
  const dir = new URL('../sim/assets/collapsed-house-v2/', import.meta.url);
  const map = decodeMap(JSON.parse(readFileSync(new URL('map.json', dir))));
  mj.FS.mkdir('/native-house');
  for (const file of map.physics_assets) mj.FS.writeFile('/native-house/' + file, readFileSync(new URL(file, dir)));
  mj.FS.writeFile('/native-house/world.xml', readFileSync(new URL('collapsed-house-v2.xml', dir)));
  const model = mj.MjModel.from_xml_path('/native-house/world.xml'), data = new mj.MjData(model);
  mj.mj_forward(model, data);
  const terrain = makeWalkSurface(mj, model, data); terrain.attach(map);
  try {
    const from = { x: map.spawn_xyyaw[0], y: map.spawn_xyyaw[1] }, inflated = await inflate(map);
    for (const to of [{ x: 3.85, y: -4.85 }, { x: 4.7, y: -3.3 }, { x: .65, y: 1.25 }]) {
      console.log(JSON.stringify({ houseSupport: to, height: terrain.floorAt(to.x, to.y, Infinity, MIN_UP, map.floor_z),
        top: terrain.raycast([to.x, to.y, 2], [0, 0, -1]), up: terrain.raycast([to.x, to.y, map.floor_z + .4], [0, 0, 1]) }));
      const path = await findPath(map, from, to);
      if (!path) {
        const heightAt = map.heightAt; delete map.heightAt;
        const rawPath = await findPath(map, from, to); map.heightAt = heightAt;
        const samples = [];
        for (let y = -9.35; y <= -4.85 + 1e-6; y += .1) {
          const p = { x: 3.85, y }, hit = terrain.raycast([p.x, p.y, 2], [0, 0, -1]);
          samples.push({ y: +y.toFixed(2), height: map.heightAt(p.x, p.y), fits: await fits(map, p), top: hit?.z, up: hit?.up });
        }
        console.log(JSON.stringify({ rawPath: !!rawPath, samples }));
      }
      assert.ok(path, `default outdoor spawn to raised house interior: ${JSON.stringify(to)}`);
      assert.ok(map.heightAt(to.x, to.y) > 1, 'native indoor support height');
      const legs = [from, ...path].map((a, i, all) => i === all.length - 1 || visible(map, inflated, a, all[i + 1]));
      assert.ok(legs.every(Boolean), JSON.stringify({ from, path, legs }));
    }
  } finally { terrain.dispose(); data.delete(); model.delete(); }
}
console.log('walk surface PASS: real elevated support, robot/proxy exclusions, ceiling, normal, native buffers; A*/smoothing 15 cm steps and missing support');
