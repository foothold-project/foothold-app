// Offline unit/fake-HTTP tests. No service, credentials, model, or robot needed.
import assert from 'node:assert/strict';
import { POLICY_ADAPTERS } from '../sim/policy-adapters.js';
import { loadSimSettings, simSettings } from '../sim/settings.js';
import { createScenarioRunner, frontDistance, BLOCK_RANGE, MAX_VX, MAX_WZ } from '../sim/scenario.js';
import { makeLidar, mapRay, MAX_RANGE } from '../sim/lidar.js';

assert.equal(POLICY_ADAPTERS['foothold-v2'].command.joystickScale[0], 1.5);
assert.equal(POLICY_ADAPTERS['foothold-v2'].command.inRange([1.5, 0, 0]), true);
assert.equal(POLICY_ADAPTERS['foothold-v2'].command.inRange([1.51, 0, 0]), false);
const caps = { vx: 1, wz: 1 };
const robot = () => ({ cmd: [0, 0, 0], d: { qpos: [0, 0, 0.4, 1, 0, 0, 0] } });
const forward = [{ x: 10, y: 0 }], turn = [{ x: 0, y: 10 }];
function commands(options) {
  const sim = robot(), runner = createScenarioRunner(sim, () => false, options);
  runner.start(forward); const vx = runner.tick()[0];
  runner.start(turn); const wz = runner.tick()[2];
  runner.start([{ x: 0, y: -10 }]); assert.equal(runner.tick()[2], -wz);
  return [vx, wz];
}
assert.deepEqual(commands(), [MAX_VX, MAX_WZ]);
assert.deepEqual(commands(simSettings({}, caps)), [0.4, 0.6]);
assert.deepEqual(commands(simSettings({ sim_runner_vx: 0.1, sim_runner_wz: 0.1 }, caps)), [0.1, 0.1]);
assert.deepEqual(commands(simSettings({ sim_runner_vx: 1, sim_runner_wz: 1 }, caps)), [1, 1]);
assert.deepEqual(commands(simSettings({ sim_runner_vx: 1, sim_runner_wz: 1, sim_max_vx: 0.3, sim_max_wz: 0.5 }, caps)), [0.3, 0.5]);
assert.deepEqual(commands(simSettings({ sim_runner_vx: 0.4, sim_runner_wz: 0.6, sim_max_vx: 1, sim_max_wz: 0.5 }, caps)), [0.4, 0.5], 'server defaults respect the narrower cap');
assert.deepEqual(commands(simSettings({ sim_runner_vx: 1, sim_runner_wz: 1, sim_max_vx: 0.8, sim_max_wz: 0.5 }, { vx: 0.25, wz: 0.2 })), [0.25, 0.2]);
assert.deepEqual(commands(simSettings({ sim_runner_wz: 0.1, sim_max_wz: 0.05 }, caps)), [0.4, 0.05]);
assert.deepEqual(commands(simSettings({ sim_max_wz: 0 }, caps)), [0.4, 0]);
for (const bad of [undefined, null, '0.3', true, NaN, Infinity, -Infinity, -1, 0, 0.09, 1.51]) {
  assert.deepEqual(commands({ vx: bad, wz: 0.2 }), [0.4, 0.2], `bad runner vx ${bad}`);
  assert.deepEqual(commands({ vx: 0.2, wz: bad }), [0.2, 0.6], `bad runner wz ${bad}`);
  assert.deepEqual(commands(simSettings({ sim_runner_vx: bad, sim_runner_wz: 0.2 }, caps)), [0.4, 0.2]);
  assert.deepEqual(commands(simSettings({ sim_runner_vx: 0.2, sim_runner_wz: bad }, caps)), [0.2, 0.6]);
}
for (const bad of [undefined, null, '12', true, NaN, Infinity, -Infinity, 0, 0.99, 30.01]) {
  const result = simSettings({ sim_runner_vx: 0.2, sim_runner_wz: 0.3, lidar_view_m: bad }, caps);
  assert.equal(result.viewRange, 12); assert.deepEqual(commands(result), [0.2, 0.3]);
}
assert.equal(simSettings({ lidar_view_m: 1 }, caps).viewRange, 1);
assert.equal(simSettings({ lidar_view_m: 30 }, caps).viewRange, 30);
for (const bad of [undefined, null, '0.3', true, NaN, Infinity, -1, 1.51]) {
  assert.deepEqual(commands(simSettings({ sim_max_vx: bad, sim_max_wz: bad }, caps)), [0.4, 0.6]);
}
for (const malformed of [null, undefined, 'text', [], 7]) assert.deepEqual(commands(simSettings(malformed, caps)), [0.4, 0.6]);

// Forward boundary extends independently of unchanged angular limits/defaults.
const fastCaps = { vx: 1.5, wz: 1 };
assert.deepEqual(commands(simSettings({ sim_runner_vx: 1.5, sim_max_vx: 1.5 }, fastCaps)), [1.5, 0.6]);
assert.deepEqual(commands(simSettings({ sim_max_vx: 1.5 }, fastCaps)), [0.4, 0.6]);
assert.deepEqual(commands(simSettings({ sim_runner_vx: 1.51, sim_max_vx: 1.5 }, fastCaps)), [0.4, 0.6]);
assert.deepEqual(commands({ vx: 1.51, caps: fastCaps }), [0.4, 0.6]);
assert.deepEqual(commands(simSettings({ sim_runner_vx: 1.5, sim_max_vx: 1.51 }, fastCaps)), [1.5, 0.6]);
assert.deepEqual(commands(simSettings({ sim_runner_vx: 1.5, sim_max_vx: 1.2 }, fastCaps)), [1.2, 0.6]);
assert.deepEqual(commands({ vx: 1.5, caps: { vx: 1.2 } }), [1.2, 0.6]);

const web = new URL('https://example.invalid/sim/index.html?from=web');
let calls = 0, request;
const org = { sim_runner_vx: 0.2, sim_runner_wz: 0.3, lidar_view_m: 30 };
const fetchSettings = async (path, options) => { calls++; request = { path, options }; return { ok: true, json: async () => org }; };
for (const url of ['https://localhost/sim/index.html?from=server', 'https://localhost/sim/index.html', 'file:///sim/index.html?from=web']) {
  assert.deepEqual(await loadSimSettings(new URL(url), fetchSettings), {});
}
assert.equal(calls, 0, 'bundled app and offline do not request settings');
assert.deepEqual(await loadSimSettings(web, fetchSettings), org);
assert.equal(calls, 1); assert.equal(request.path, '/api/v1/org/settings');
assert.deepEqual(Object.keys(request.options).sort(), ['cache', 'credentials', 'redirect', 'signal']);
assert.equal(request.options.credentials, 'same-origin'); assert.equal(request.options.cache, 'no-store');
assert.equal(request.options.redirect, 'error');
for (const status of [401, 403, 404, 500]) {
  assert.deepEqual(await loadSimSettings(web, async () => ({ ok: false, status, json() { throw Error('must not parse errors'); } })), {});
}
assert.deepEqual(await loadSimSettings(web, async () => { throw Error('offline'); }), {});
assert.deepEqual(await loadSimSettings(web, async () => ({ ok: true, json: async () => { throw Error('bad JSON'); } })), {});
let finishLate, aborted;
const timeoutResult = await loadSimSettings(web, async (_path, { signal }) => {
  aborted = signal;
  return new Promise((resolve) => { finishLate = resolve; });
}, 10);
assert.deepEqual(timeoutResult, {}); assert.equal(aborted.aborted, true);
finishLate({ ok: true, json: async () => org });
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(timeoutResult, {}, 'late timed-out response is discarded');
assert.deepEqual(await loadSimSettings(web, async () => ({ ok: true, json: () => new Promise(() => {}) }), 10), {}, 'JSON timeout');

// An HTTP response during a run is used at the next start, for both speed axes.
for (const [points, axis, before, after] of [[forward, 0, 0.4, 0.2], [turn, 2, 0.6, 0.3]]) {
  const settings = {}, sim = robot(), runner = createScenarioRunner(sim, () => false, settings);
  let finish;
  const loading = loadSimSettings(web, () => new Promise((resolve) => { finish = resolve; }))
    .then((value) => Object.assign(settings, simSettings(value, caps)));
  runner.start(points); assert.equal(runner.tick()[axis], before);
  await Promise.resolve(); finish({ ok: true, json: async () => org }); await loading;
  assert.equal(runner.tick()[axis], before, 'running speed does not change');
  runner.cancel(); runner.start(points); assert.equal(runner.tick()[axis], after, 'next run uses response');
}
{
  const settings = { vx: 1, wz: 1, caps: { vx: 1, wz: 1 } }, sim = robot();
  const runner = createScenarioRunner(sim, () => false, settings);
  runner.start(turn); assert.equal(runner.tick()[2], 1);
  settings.caps.wz = 0.25;
  assert.equal(runner.tick()[2], 1, 'late cap waits for next run too');
  runner.cancel(); runner.start(turn); assert.equal(runner.tick()[2], 0.25);
}

// Fake mj_multiRay obeys the real cutoff. Safety output must be identical while
// displayed map/scene hits change, including at the exact 0.6 m block boundary.
class Buffer {
  constructor(n) { this.data = new Float64Array(n); }
  GetView() { return this.data; }
}
let source = new Float64Array(360).fill(20), cutoff;
const mj = { DoubleBuffer: Buffer, IntBuffer: Buffer,
  mj_multiRay(_m, _d, _pos, _vec, _group, _static, _body, _gid, dist, _normal, _n, max) {
    cutoff = max; dist.data.set(source.map((hit) => hit > max ? -1 : hit));
  } };
const display = {}, scan = makeLidar(mj, {}, {}, 360, display);
for (const distance of [0.59, BLOCK_RANGE, 0.61, 2, MAX_RANGE, 20, -1]) {
  source.fill(20); source[0] = distance; source[180] = 0.1;
  delete display.viewRange;
  const baseline = scan(0, 0, 0, 0).slice(), baselineFront = frontDistance(baseline);
  for (const range of [1, 12, 30, NaN, '1', 0, 31]) {
    display.viewRange = range;
    const safety = scan(0, 0, 0, 0), view = [1, 12, 30].includes(range) ? range : 12;
    assert.deepEqual(safety, baseline, `view ${range} leaves safety scan unchanged`);
    assert.equal(frontDistance(safety), baselineFront);
    assert.equal(cutoff, Math.max(12, view));
    assert.equal(scan.viewRays[0], distance < 0 || distance > view ? Infinity : distance);
    assert.equal(scan.viewRays[1], view >= 20 ? 20 : Infinity);
    const sim = robot(), runner = createScenarioRunner(sim, () => false);
    runner.start(forward); runner.tick(frontDistance(safety));
    assert.equal(runner.status, baselineFront <= BLOCK_RANGE ? '막힘' : '실행 중');
  }
}
// Map rays honor the same display range without changing occupancy data.
const map = { w: 40, h: 1, origin: [0, 0], res: 1, px: new Uint8Array(40).fill(254) };
map.px[20] = 0;
assert.equal(mapRay(map, 0.5, 0.5, 0), Infinity);
assert.equal(mapRay(map, 0.5, 0.5, 0, 1), Infinity);
assert.equal(mapRay(map, 0.5, 0.5, 0, 30), 19.5);
assert.equal(mapRay(map, 0.5, 0.5, 0, NaN), Infinity);
console.log('settings sim PASS: defaults, per-field validation, small/large speeds, organization/adapter caps, same-origin HTTP/failure/timeout, next-run snapshot, 1/12/30 m display and identical safety scan/block decisions');
