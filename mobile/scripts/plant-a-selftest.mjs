// 공정동 A(plant-a): Go2 + 월드 MJCF 를 앱과 같은 MuJoCo(wasm) 로 컴파일하고, 층마다 스폰 위에서
// 아래로 광선 = floor_z, 그 층 스폰에 세워 0.5 s 버티면 그 층 바닥 위에 서 있는지. 걷기 · 계단 오르기는 보지 않는다.
// 서버 · 브라우저 · 다운로드 · 로봇 없음.  FH_SIM_SRC=<local dependencies> node mobile/scripts/plant-a-selftest.mjs
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSim, loadPolicy, ISAAC_LIKE } from '../sim/sim.js';

const src = process.env.FH_SIM_SRC;
assert.ok(src, 'FH_SIM_SRC required (existing local dependencies)');
const { default: load } = await import(pathToFileURL(resolve(src, 'node_modules/@mujoco/mujoco/mujoco.js')));
const mj = await load();
const dir = new URL('../sim/assets/plant-a/', import.meta.url);
const read = (file) => JSON.parse(readFileSync(new URL(file, dir)));
assert.ok(JSON.parse(readFileSync(new URL('../sim/maps.json', import.meta.url))).some((m) => m.id === 'plant-a'), 'listed in maps.json');
const { floors } = read('top.json');
assert.deepEqual(floors.map((f) => f.id), ['l1', 'l2', 'l3']);
mj.FS.mkdir('/go2'); mj.FS.mkdir('/go2/assets');
for (const f of readdirSync(join(src, 'assets/unitree_go2/assets'))) if (f.endsWith('.obj')) mj.FS.writeFile(`/go2/assets/${f}`, readFileSync(join(src, 'assets/unitree_go2/assets', f)));
mj.FS.writeFile('/go2/go2.xml', readFileSync(join(src, 'assets/unitree_go2/go2.xml')));
mj.FS.writeFile('/go2/world.xml', readFileSync(new URL('plant-a.xml', dir)));
mj.FS.writeFile('/go2/scene.xml', '<mujoco model="go2 plant-a"><include file="go2.xml"/><include file="world.xml"/></mujoco>');
const bytes = readFileSync(join(src, 'policy_v2.f32'));
const policy = loadPolicy(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
const m = mj.MjModel.from_xml_path('/go2/scene.xml'), d = new mj.MjData(m), hit = new mj.IntBuffer(1);
const worldGeoms = (readFileSync(new URL('plant-a.xml', dir), 'utf8').match(/<geom /g) ?? []).length;
try {
  mj.mj_forward(m, d);
  for (const f of floors) {
    const [x, y] = f.spawn_xyyaw, top = f.floor_z + 1;
    const distance = mj.mj_ray(m, d, [x, y, top], [0, 0, -1], [0, 1, 0, 0, 0, 0], true, -1, hit, null);
    assert.ok(Math.abs(top - distance - f.floor_z) < 1e-5, `${f.id}: spawn floor ray ${top - distance} != ${f.floor_z}`);
  }
  console.log(JSON.stringify({ compiled: true, ngeom: m.ngeom, worldGeoms }));
} finally { hit.delete(); d.delete(); m.delete(); }

for (const f of floors) {
  const map = read(f.map_file);
  assert.equal(map.floor_z, f.floor_z);
  const sim = createSim(mj, '/go2/scene.xml', ISAAC_LIKE, policy, { floorZ: f.floor_z, spawn: map.spawn_xyyaw });
  try {
    sim.hold(.5);
    const base = Array.from(sim.d.qpos.slice(0, 3));
    assert.ok(Math.abs(base[2] - f.floor_z - .3) < .2, `${f.id}: standing on its floor (${base[2]})`);
    assert.ok(Math.hypot(base[0] - map.spawn_xyyaw[0], base[1] - map.spawn_xyyaw[1]) < .2, `${f.id}: stayed at spawn`);
    console.log(JSON.stringify({ floor: f.id, floorZ: f.floor_z, base }));
  } finally { sim.dispose(); }
}
