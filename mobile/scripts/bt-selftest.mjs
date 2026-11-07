import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTreeRunner, validateTree, treeFromScenario, ACTION_SECONDS } from '../sim/bt.js';
import { createScenarioRunner, createPatrolRunner, bindScenarioInterrupts, validateScenarios, bodyFallen } from '../sim/scenario.js';
import { decodeMap } from '../sim/lidar.js';
const tree = (root, max_seconds = 100) => ({ format: 'fh_mission_tree/1', max_seconds, root });
const leaf = (message = 'x') => ({ type: 'sensor_log', message });
const group = (type, ...children) => ({ type, children });
let checks = 0;
function eq(a, b, msg) { assert.deepEqual(a, b, msg); checks++; }
for (const result of ['success', 'failure', 'abort']) {
  let starts = 0, halts = 0;
  const r = createTreeRunner(tree(leaf()), { actions: { sensor_log: () => { starts++; return { tick: () => result, halt: () => halts++ }; } } });
  eq(r.start(), true); eq(r.tick(.01), 'running'); eq(starts, 1); eq(r.tick(.01), result); eq(r.active, false); eq(r.tick(.1), result);
  if (result === 'abort') eq(halts, 1);
}
for (const type of ['sequence', 'fallback', 'reactive_fallback', 'retry']) for (const result of ['success', 'failure', 'abort']) {
  let started = [];
  const root = type === 'retry' ? { type, times: 2, child: leaf('first') } : group(type, leaf('first'), leaf('second'));
  const r = createTreeRunner(tree(root), { actions: { sensor_log: (n) => { started.push(n.message); return { tick: () => n.message === 'first' ? result : 'success', halt() {} }; } } });
  r.start(); for (let i = 0; i < 15 && r.active; i++) r.tick(.01);
  eq(r.status, result === 'abort' ? 'abort' : type === 'retry' ? result : type === 'sequence' && result === 'failure' ? 'failure' : 'success');
  if (result === 'abort') eq(started, ['first'], `${type} cannot catch abort`);
  if (type === 'retry') eq(started.length, result === 'failure' ? 2 : 1);
}
{ // A higher branch must become eligible after failing on earlier ticks.
  let high = false, halts = 0;
  const r = createTreeRunner(tree(group('reactive_fallback', group('sequence', { type: 'battery_low' }, leaf('high')), leaf('low'))), {
    conditions: { battery_low: () => high }, actions: { sensor_log: () => ({ tick: () => 'running', halt: () => halts++ }) },
  });
  r.start(); r.tick(.1); high = true; r.tick(.1); eq(halts, 1); eq(r.states.get('0.0.1').result, 'running'); r.cancel(); eq(halts, 2);
}
{
  let points = [];
  const r = createTreeRunner(tree({ type: 'for_each_point', points: [{ x: 2, y: 1 }, { x: 3, y: 4 }], child: { type: 'goto', point: 'current' } }), { actions: {
    goto: (_n, c) => { points.push(c.point.x); return { tick: () => 'success', halt() {} }; },
  } }); r.start(); for (let i = 0; i < 10 && r.active; i++) r.tick(.1); eq(points, [2, 3]); eq(r.status, 'success');
}
const invalid = [null, {}, { ...tree(leaf()), format: 'bad' }, { root: leaf(), format: 'fh_mission_tree/1' }, tree(leaf(), 3601), tree(leaf(), 0), tree({ type: 'unknown' }), tree({ type: 'sequence' }), tree({ type: 'fallback', children: [] }), tree({ type: 'goto' }), tree({ type: 'goto', point: 'current' }), tree({ type: 'retry', times: 0, child: leaf() }), tree({ type: 'retry', times: 4, child: leaf() }), tree({ type: 'retry', times: 1.5, child: leaf() }), tree({ type: 'retry', times: 2 }), tree({ type: 'for_each_point', points: [], child: leaf() }), tree({ type: 'review_is' }), tree({ type: 'map_mark' }), tree({ type: 'wait' }), tree({ type: 'wait', seconds: 121 }), tree({ type: 'sensor_log' }), tree({ type: 'photo', max_seconds: 6 }), tree({ type: 'photo', max_seconds: -1 }), tree(group('sequence', ...Array.from({ length: 200 }, () => leaf())))];
let deep = leaf(); for (let i = 0; i < 16; i++) deep = group('sequence', deep); invalid.push(tree(deep));
for (const value of invalid) { assert.throws(() => validateTree(value)); checks++; }
for (const times of [1, 3]) {
  let attempts = 0;
  const r = createTreeRunner(tree({ type: 'retry', times, child: leaf() }), { actions: { sensor_log: () => { attempts++; return { tick: () => 'failure', halt() {} }; } } });
  r.start(); for (let i = 0; i < 10 && r.active; i++) r.tick(.1); eq(attempts, times); eq(r.status, 'failure');
}
validateTree(tree(group('sequence', ...Array.from({ length: 199 }, () => leaf())), 3600)); checks++;
let maximumDepth = leaf(); for (let i = 0; i < 15; i++) maximumDepth = group('sequence', maximumDepth); validateTree(tree(maximumDepth)); checks++;
{
  let stopped = false, ticks = 0;
  const r = createTreeRunner(tree(leaf()), { isStopped: () => stopped, actions: { sensor_log: () => ({ tick: () => { ticks++; return 'running'; }, halt() {} }) } });
  r.start(); r.tick(.1); stopped = true; eq(r.tick(.1), 'abort'); eq(ticks, 0, 'STOP precedes action progress'); eq(r.start(), false);
}
const route = JSON.parse(readFileSync(new URL('../sim/assets/factory-inspection/scenarios.json', import.meta.url)))[1];
eq(treeFromScenario(route).root.children.map((n) => n.point), route.points);
const map = decodeMap(JSON.parse(readFileSync(new URL('../sim/assets/factory-inspection/map.json', import.meta.url))));
eq(validateScenarios([route, { ...route, id: 'invalid-tree', tree: tree({ type: 'bad' }) }, { ...route, id: 'null-tree', tree: null }, { ...route, id: 'false-tree', tree: false }], map).map((s) => s.id), [route.id]);
for (const type of Object.keys(ACTION_SECONDS)) {
  const node = type === 'goto' ? { type, point: { x: 0, y: 0 } } : type === 'wait' ? { type, seconds: 1 } : type === 'map_mark' ? { type, level: 'minor' } : { type, message: 'x' };
  let halted = 0;
  const r = createTreeRunner(tree(node, 3600), { actions: { [type]: () => ({ tick: () => 'running', halt: () => halted++ }) } });
  r.start(); r.tick(0); eq(r.tick(ACTION_SECONDS[type]), 'failure', `${type} action bounded`); eq(halted, 1);
}
{
  let halted = 0;
  const r = createTreeRunner(tree(leaf(), 1), { actions: { sensor_log: () => ({ tick: () => 'running', halt: () => halted++ }) } });
  r.start(); r.tick(.1); eq(r.tick(1), 'abort'); eq(halted, 1); eq(r.context.reason, '전체 시간 초과');
}
eq(bodyFallen([0, 0, 0, 1, 0, 0, 0]), false); eq(bodyFallen([0, 0, 0, Math.SQRT1_2, Math.SQRT1_2, 0, 0]), true);
function fixture(chosen = route, navigation = async (_m, _a, ps) => ps) {
  let stopped = false;
  const sim = { adapterId: 'nvidia-demo', cmd: [0, 0, 0], d: { qpos: [24, 21.5, .4, 1, 0, 0, 0] }, cancelPolicyStep() {} };
  const runner = createScenarioRunner(sim, () => stopped);
  let patrol;
  const lock = () => { stopped = true; patrol?.cancel(); sim.cmd = [0, 0, 0]; };
  patrol = createPatrolRunner({ sim, runner, isStopped: () => stopped, lock, planRoute: navigation, getMap: () => map, getFront: () => Infinity, home: () => ({ x: 24, y: 21.5 }) });
  const step = async (dt = .1, teleport = true) => { await Promise.resolve(); if (teleport && runner.active) { const p = runner.points[runner.index]; if (p) { sim.d.qpos[0] = p.x; sim.d.qpos[1] = p.y; } } patrol.tick(dt); };
  return { patrol, runner, sim, lock, step, chosen, stopped: () => stopped };
}
for (const action of ['goto', 'photo', 'operator_review']) for (const interruption of ['lock', 'stop', 'left', 'right', 'hidden', 'doc-freeze', 'blur', 'freeze', 'pagehide', 'home', 'reset']) {
  const node = action === 'goto' ? { type: action, point: route.points[1] } : { type: action };
  const f = fixture({ ...route, tree: tree(group('sequence', node, leaf('MUST NOT START'))) });
  f.patrol.start(f.chosen); await f.step(.02, false);
  if (action === 'goto') { await f.step(.02, false); assert.ok(f.sim.cmd.some((v) => v !== 0), 'moving before STOP'); checks++; }
  const els = Object.fromEntries(['left', 'right', 'stop', 'doc', 'win', 'home', 'reset'].map((k) => [k, new EventTarget()]));
  bindScenarioInterrupts({ runner: f.runner, mission: f.patrol, lock: f.lock, ...els, preserveOnHide: true });
  if (interruption === 'doc-freeze') els.doc.dispatchEvent(new Event('freeze'));
  else if (interruption === 'lock') f.lock();
  else if (interruption === 'hidden') { els.doc.hidden = true; els.doc.dispatchEvent(new Event('visibilitychange')); }
  else if (['blur', 'freeze', 'pagehide'].includes(interruption)) els.win.dispatchEvent(new Event(interruption));
  else els[interruption].dispatchEvent(new Event(['home', 'reset'].includes(interruption) ? 'click' : 'pointerdown'));
  const stoppedEvents = f.patrol.events.length;
  for (let i = 0; i < 5; i++) await f.step();
  eq(f.patrol.events.length, stoppedEvents, 'no effects after interruption');
  eq([f.patrol.active, f.runner.active, f.stopped(), f.sim.cmd], [false, false, true, [0, 0, 0]], `${action}/${interruption}`);
  eq(f.patrol.events.some((e) => e.message.includes('MUST NOT START')), false);
}
for (const mode of ['normal', 'minor', 'danger', 'battery', 'move', 'photo', 'fallen', 'timeout']) {
  const f = fixture(); if (['battery', 'move', 'photo', 'fallen'].includes(mode)) f.patrol.mock[mode] = true;
  f.patrol.start(route);
  for (let i = 0; i < 1500 && f.patrol.active; i++) {
    if (f.patrol.reviewPending && mode !== 'timeout') f.patrol.review(mode === 'minor' || mode === 'danger' ? mode : 'clear');
    await f.step(mode === 'timeout' && f.patrol.reviewPending ? 120 : .1);
  }
  eq(f.patrol.active, false, mode); assert.ok(f.patrol.summary); checks++;
  if (mode === 'normal' || mode === 'photo') eq([f.patrol.status, f.patrol.summary.visited], ['success', 4]);
  if (mode === 'minor') eq(f.patrol.summary.minor, 4);
  if (mode === 'danger') { eq(f.patrol.summary.danger, 1); assert.match(f.patrol.summary.reason, /위험 대피/); }
  if (mode === 'battery') { eq(f.patrol.summary.skipped, 4); assert.match(f.patrol.summary.reason, /배터리/); }
  if (mode === 'move') eq([f.patrol.summary.visited, f.patrol.summary.skipped], [3, 1]);
  if (mode === 'fallen') eq([f.patrol.status, f.stopped(), f.sim.cmd], ['abort', true, [0, 0, 0]]);
  if (mode === 'timeout') { assert.match(f.patrol.summary.reason, /무응답 복귀/); eq(f.patrol.events.some((e) => e.message === '이상 없음'), false); }
}
{
  const f = fixture({ ...route, tree: tree({ type: 'photo' }, .2) });
  f.patrol.start(f.chosen); await f.step(.1); await f.step(.1);
  eq([f.patrol.status, f.stopped(), f.sim.cmd], ['abort', true, [0, 0, 0]], 'mission deadline locks');
}
{ // A wait may complete exactly at its action deadline.
  const f = fixture({ ...route, tree: tree({ type: 'wait', seconds: 1, max_seconds: 1 }) });
  f.patrol.start(f.chosen); await f.step(0); await f.step(1);
  eq(f.patrol.status, 'success');
}
{ // A failed return must stop; it must never fall back into normal patrol.
  const f = fixture(route, async () => null); f.patrol.mock.battery = true; f.patrol.start(route);
  for (let i = 0; i < 30 && f.patrol.active; i++) await f.step();
  eq([f.patrol.status, f.stopped(), f.patrol.summary.visited], ['abort', true, 0]); assert.match(f.patrol.summary.reason, /복귀 실패/); checks++;
}
{ // Both photo attempts fail, then the operator is required.
  const f = fixture(); f.patrol.mock.photo = true; f.patrol.start(route); let armed = false;
  for (let i = 0; i < 200 && !f.patrol.reviewPending; i++) {
    await f.step();
    if (!armed && f.patrol.events.some((e) => e.message === '모의 촬영 실패')) { f.patrol.mock.photo = true; armed = true; }
  }
  eq(f.patrol.reviewPending, true); eq(f.patrol.events.filter((e) => e.message === '모의 촬영 실패').length, 2);
  assert.ok(f.patrol.events.some((e) => e.message.includes('재촬영 실패'))); checks++; f.lock();
}
console.log(`BT selftest PASS: ${checks} assertions; transitions/all actions, priority+halt, retry/abort, validation, point order, stationary STOP/lifecycle, deadlines, review timeout -> home`);
