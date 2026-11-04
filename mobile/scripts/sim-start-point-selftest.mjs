// Sync www first; FH_PLAYWRIGHT=<existing playwright-core/index.mjs> node mobile/scripts/sim-start-point-selftest.mjs
// Real headless MuJoCo page, paused RAF for exact poses; ephemeral localhost only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodeMap, cell } from '../sim/lidar.js';
import { inflate } from '../sim/astar.js';

const read = (p) => JSON.parse(readFileSync(new URL(`../sim/assets/${p}`, import.meta.url)));
const warehouse = decodeMap(read('warehouse/map.json'));
const house = decodeMap(read('collapsed-house-v2/map.json'));
const floors = read('factory-zone/top.json').floors;
const f1 = decodeMap(read(`factory-zone/${floors[0].map_file}`));
const f2 = decodeMap(read(`factory-zone/${floors[1].map_file}`));
// Choose real map cells near spawn, rounding just as the launch address does.
async function points(map) {
  const grid = await inflate(map), found = {};
  for (let i = 0; i < grid.length; i++) {
    const x = +(map.origin[0] + (i % map.w + .5) * map.res).toFixed(2);
    const y = +(map.origin[1] + (map.h - 1 - Math.floor(i / map.w) + .5) * map.res).toFixed(2);
    const d = Math.hypot(x - map.spawn_xyyaw[0], y - map.spawn_xyyaw[1]);
    const kind = map.px[i] === 0 ? 'wall' : map.px[i] !== 254 ? 'unknown' : grid[i] ? 'inflated' : 'free';
    if (kind !== 'unknown' && (d < 1 || d > 4)) continue;
    if (!found[kind]) found[kind] = [x, y];
    if (Object.keys(found).length === 4) break;
  }
  assert.ok(found.free, 'fixture has a clear cell away from default spawn');
  return found;
}
const wp = await points(warehouse), fp = await points(f2);
assert.ok(wp.wall && wp.inflated && wp.unknown);
assert.equal(cell(warehouse, ...wp.inflated), 254, 'inflate-only fixture is a raw free cell');

const { chromium } = await import(pathToFileURL(process.env.FH_PLAYWRIGHT));
const root = resolve('mobile/www'), forbidden = [8453, 8792, 5190, 5191, 5195, 8870, 9430, 9761];
const server = createServer((req, res) => {
  const file = resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
  if (!file.startsWith(root + sep)) return res.writeHead(403).end();
  try {
    const body = readFileSync(file);
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.html': 'text/html', '.css': 'text/css', '.png': 'image/png' })[extname(file)] ?? 'application/octet-stream');
    res.end(body);
  } catch { res.writeHead(404).end(); }
});
// Retry the OS-assigned port before accepting connections if it is reserved.
do {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  if (!forbidden.includes(server.address().port)) break;
  await new Promise((r) => server.close(r));
} while (true);
let browser;
const errors = [], failures = [], rows = [];
const closeTo = (actual, expected, tolerance = 1e-10) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
try {
  browser = await chromium.launch({ executablePath: process.env.FH_CHROME || '/usr/bin/google-chrome', headless: true,
    args: ['--no-sandbox', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  async function check(name, query, map, { xy = map.spawn_xyyaw.slice(0, 2), yaw = map.spawn_xyyaw[2], floor = null, reason = '', custom = false, scenario = '' } = {}, exercise) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    page.on('pageerror', (e) => { errors.push(`${name}: ${e.message}`); console.error(errors.at(-1)); });
    try {
      await page.addInitScript(() => { requestAnimationFrame = (cb) => { window.__frame = cb; return 1; }; Math.random = () => 0; });
      const params = new URLSearchParams({ map: 'warehouse', policyBackend: 'f32', ...query });
      await page.goto(`http://127.0.0.1:${server.address().port}/sim/index.html?${params}`);
      await page.waitForFunction(() => window.__sim?.ready || window.__sim?.err, null, { timeout: 60000, polling: 100 }).catch(async (e) => {
        console.error(name, errors, await page.evaluate(() => ({ ready: window.__sim?.ready, error: window.__sim?.err })));
        throw e;
      });
      assert.equal(await page.evaluate(() => __sim.err), null, name);
      const state = await page.evaluate(() => {
        __frame(performance.now());
        const initial = Array.from(__sim.sim.d.qpos.slice(0, 7));
        // The constructor's reset contract must use the accepted address exactly.
        __sim.sim.reset();
        return { start: __sim.start(), floor: __sim.floor(), initial, q: Array.from(__sim.sim.d.qpos.slice(0, 7)),
          note: document.getElementById('goalNote').textContent, visible: !document.getElementById('goalNote').hidden,
          scenario: document.getElementById('scenarioSelect').value };
      });
      assert.deepEqual(state.start.xy, xy, name); assert.equal(state.start.yaw, yaw, name);
      assert.equal(state.start.floor, floor); assert.equal(state.start.floorZ, map.floor_z); assert.equal(state.start.custom, custom);
      assert.equal(state.floor.here, floor === 'f2' ? 1 : 0);
      // reset is exact; the existing 0.5 s PD hold can shift the settled pose.
      xy.forEach((v, i) => { closeTo(state.q[i], v); closeTo(state.initial[i], v, .15); });
      // Custom starts now use the native supporting surface (even warehouse
      // meshes differ from rounded map.floor_z by sub-micrometres). Defaults
      // retain the exact previous datum; reset retains the measured floor.
      const support = custom ? state.start.spawnFloorZ : map.floor_z;
      if (!custom) closeTo(state.start.spawnFloorZ, map.floor_z);
      closeTo(state.q[2], support + .4); closeTo(state.initial[2], support + .3, .12);
      closeTo(state.q[3], Math.cos(yaw / 2)); closeTo(state.q[6], Math.sin(yaw / 2));
      if (reason) {
        assert.match(state.start.reason, new RegExp(reason));
        assert.match(state.note, /^고른 시작 위치를 쓸 수 없어 기본 위치에서 시작\(.+\)$/); assert.equal(state.visible, true);
      } else { assert.equal(state.start.reason, ''); assert.equal(state.note, ''); assert.equal(state.visible, false); }
      if (scenario) assert.equal(state.scenario, scenario);
      if (exercise) await exercise(page, state.start);
      rows.push({ name, ...state.start, initial: state.initial.slice(0, 3) });
      console.log(JSON.stringify(rows.at(-1)));
    } catch (e) { failures.push(`${name}: ${e.stack}`); console.error(failures.at(-1)); }
    finally { await page.close(); }
  }

  await check('default', {}, warehouse);
  await check('warehouse custom xy/default yaw; single-floor ignores floor', { floor: 'f2', start: wp.free.join(',') }, warehouse, { xy: wp.free, custom: true }, async (page) => {
    await page.evaluate(async () => {
      __sim.sim.d.qpos[0] += 2;
      document.getElementById('reset').click();
      await document.getElementById('go').onclick();
    });
    const result = await page.evaluate(() => ({ xy: Array.from(__sim.sim.d.qpos.slice(0, 2)), stopped: __sim.stopped() }));
    wp.free.forEach((v, i) => closeTo(result.xy[i], v, .15)); assert.equal(result.stopped, false);
  });
  await check('warehouse custom yaw', { start: [...wp.free, -1.23].join(',') }, warehouse, { xy: wp.free, yaw: -1.23, custom: true });
  await check('omitted yaw uses nonzero map default', { map: 'collapsed-house-v2', start: house.spawn_xyyaw.slice(0, 2).join(',') }, house, { custom: true });
  await check('wall fallback', { start: wp.wall.join(',') }, warehouse, { reason: '장애물' });
  await check('unknown-cell fallback', { start: wp.unknown.join(',') }, warehouse, { reason: '모르는 칸' });
  await check('inflate-only fallback', { start: wp.inflated.join(',') }, warehouse, { reason: '0.45 m' });
  await check('outside fallback', { start: `${warehouse.origin[0] - .01},0` }, warehouse, { reason: '지도 밖' });
  await check('upper bound excluded', { start: `${warehouse.origin[0] + warehouse.w * warehouse.res},0` }, warehouse, { reason: '지도 밖' });
  for (const start of ['NaN,0', 'Infinity,0', '0,0,NaN', '1e309,0', '', ',0', '0,,0', '1', '0,0,0,0', '0x10,0']) {
    await check(`malformed ${JSON.stringify(start)}`, { start }, warehouse, { reason: '유한한 숫자' });
  }
  await check('factory default', { map: 'factory-zone' }, f1, { floor: 'f1', scenario: 'f1-short-loop' });
  await check('unknown floor uses first', { map: 'factory-zone', floor: 'missing' }, f1, { floor: 'f1', scenario: 'f1-short-loop' });
  await check('unknown floor validates start on first', { map: 'factory-zone', floor: 'missing', start: '2,4' }, f1, { floor: 'f1', custom: true });
  await check('f2 default', { map: 'factory-zone', floor: 'f2' }, f2, { floor: 'f2', scenario: 'f2-short-loop' });
  await check('f2 invalid start falls back on f2', { map: 'factory-zone', floor: 'f2', start: 'NaN,4' }, f2, { floor: 'f2', reason: '유한한 숫자' });
  // f1 spawn is not free on f2: validation must use the selected floor's map.
  assert.notEqual(cell(f2, ...f1.spawn_xyyaw), 254);
  await check('f2 rejects f1-only cell', { map: 'factory-zone', floor: 'f2', start: f1.spawn_xyyaw.slice(0, 2).join(',') }, f2, { floor: 'f2', reason: '장애물|모르는 칸' });
  await check('f2 custom/start-reset/cross-floor scenario', { map: 'factory-zone', floor: 'f2', start: [...fp.free, .7].join(',') }, f2,
    { floor: 'f2', xy: fp.free, yaw: .7, custom: true, scenario: 'f2-short-loop' }, async (page, start) => {
      await page.evaluate(async () => {
        await document.getElementById('go').onclick();
        const select = document.getElementById('scenarioSelect'); select.value = 'f1-short-loop'; select.onchange();
        await document.getElementById('scenarioRun').onclick();
      });
      const moved = await page.evaluate(() => ({ here: __sim.floor().here, xy: Array.from(__sim.sim.d.qpos.slice(0, 2)), active: __sim.scenario.active }));
      assert.equal(moved.here, 0); assert.equal(moved.active, true);
      f1.spawn_xyyaw.slice(0, 2).forEach((v, i) => closeTo(moved.xy[i], v, .15));
      const reset = await page.evaluate(() => {
        document.getElementById('reset').click();
        return { start: __sim.start(), here: __sim.floor().here, view: __sim.floor().view, q: Array.from(__sim.sim.d.qpos.slice(0, 7)), stopped: __sim.stopped(), active: __sim.scenario.active };
      });
      assert.deepEqual(reset.start, start); assert.equal(reset.here, 1); assert.equal(reset.view, 1);
      assert.equal(reset.stopped, true); assert.equal(reset.active, false);
      fp.free.forEach((v, i) => closeTo(reset.q[i], v, .15)); closeTo(reset.q[2], 2.3, .12);
      closeTo(2 * Math.atan2(reset.q[6], reset.q[3]), .7, .02);
      await page.evaluate(async () => { await document.getElementById('go').onclick(); });
      assert.equal(await page.evaluate(() => __sim.stopped()), false);
    });
  assert.deepEqual(errors, []);
  assert.deepEqual(failures, []);
  console.log(`sim start point PASS: ${rows.length} real-page cases, exact reset pose, selected-floor scenario/map/height, cross-floor spawn preserved, pageerrors 0`);
} finally { await browser?.close(); await new Promise((r) => server.close(r)); }
