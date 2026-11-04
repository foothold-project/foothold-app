// Exact native-ray oracle for the indexed support cache; no policy changes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeWalkSurface } from './walk-surface.js';
import { decodeMap } from './lidar.js';
import { findPath, inflate } from './astar.js';
const previous = execFileSync('git', ['show', '6861d0c:mobile/sim/walk-surface.js'], { encoding: 'utf8' });
const { makeWalkSurface: nativeSurface } = await import('data:text/javascript;base64,' + Buffer.from(previous).toString('base64'));
const baseline = execFileSync('git', ['show', '084b434:mobile/sim/astar.js'], { encoding: 'utf8' });
const { findPath: basePath } = await import('data:text/javascript;base64,' + Buffer.from(baseline).toString('base64'));
const { default: load } = await import(pathToFileURL(resolve(process.env.FH_SIM_SRC, 'node_modules/@mujoco/mujoco/mujoco.js')));
const mj = await load();
for (const [id, floor, count] of [['warehouse', '', 30], ['factory-inspection', '', 12], ['factory-zone', 'f1', 12], ['factory-zone', 'f2', 12], ['collapsed-house-v2', '', 0]]) {
  const dir = resolve('mobile/sim/assets', id), map = decodeMap(JSON.parse(readFileSync(resolve(dir, floor ? `map-${floor}.json` : 'map.json'))));
  for (const file of map.physics_assets ?? []) mj.FS.writeFile('/' + file, readFileSync(resolve(dir, file)));
  mj.FS.writeFile('/index-test.xml', readFileSync(resolve(dir, id + '.xml')));
  const m = mj.MjModel.from_xml_path('/index-test.xml'), d = new mj.MjData(m); mj.mj_forward(m, d);
  const surface = makeWalkSurface(mj, m, d), oracle = nativeSurface(mj, m, d), groups = Array.from(m.geom_group);
  const ceiling = floor === 'f1' ? 1.6 : floor === 'f2' ? 7.6 : Infinity;
  surface.attach(map, ceiling);
  try {
    const grid = await inflate(map), clear = [];
    for (let i = 0; i < grid.length; i++) if (!grid[i]) clear.push(i);
    const point = (i) => ({ x: map.origin[0] + (i % map.w + .5) * map.res, y: map.origin[1] + (map.h - Math.floor(i / map.w) - .5) * map.res });
    let samples = 0, maxDifference = 0;
    for (let k = 0; k < clear.length; k += Math.ceil(clear.length / 2048)) {
      const i = clear[k], p = point(i), actual = map.cellHeight(i), expected = oracle.floorAt(p.x, p.y, ceiling, Math.SQRT1_2, map.floor_z);
      assert.ok((Number.isNaN(actual) && Number.isNaN(expected)) || Math.abs(actual - expected) < 1e-8, `${id}/${floor} height ${JSON.stringify({ p, actual, expected })}`);
      if (Number.isFinite(actual)) maxDifference = Math.max(maxDifference, Math.abs(actual - expected));
      samples++;
    }
    for (let k = 0; k < count; k++) {
      const from = point(clear[Math.floor(clear.length * (k + .13) / count)]), to = point(clear[Math.floor(clear.length * ((k * 7 + 3) % count + .71) / count)]);
      assert.deepEqual(await findPath(map, from, to), await basePath(map, from, to), `${id}/${floor} flat A* path ${k}`);
    }
    assert.deepEqual(Array.from(m.geom_group), groups, 'temporary pick exclusions restored');
    console.log(JSON.stringify({ indexParity: id, floor, samples, maxDifference, paths: count }));
  } finally { surface.dispose(); oracle.dispose(); d.delete(); m.delete(); }
}
console.log('walk surface index PASS: native height oracle, flat baseline A* path equality, restored groups');
