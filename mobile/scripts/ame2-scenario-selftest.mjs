import assert from 'node:assert/strict';
import { createScenarioRunner, BLOCK_RANGE, STALL_S } from '../sim/scenario.js';
const make = () => ({ adapterId: 'ame2-demo', cmd: [0, 0, 0, 1], d: { qpos: [0, 0, .4, 1, 0, 0, 0] }, cancelPolicyStep() { this.cancelled = true; } });
for (const goal of [false, true]) {
  const s = make(), r = createScenarioRunner(s, () => false);
  r.start([{ x: 5, y: 1, mark: 0 }, { x: 5, y: 5, mark: 1 }], goal);
  const c = r.tick(Infinity, .02);
  assert.equal(c.length, 4); assert.ok(Math.abs(Math.hypot(c[0], c[1]) - 1) < 1e-12);
  assert.ok(Math.abs(c[1] / c[0] - .2) < 1e-12, 'aim at first A* point, never across corner');
  r.tick(BLOCK_RANGE, .02); assert.equal(r.status, '막힘'); assert.deepEqual(s.cmd, [0, 0, 0, 1]);
  assert.equal(s.cancelled, true);
  r.start([{ x: .4, y: 0 }, { x: 1, y: 0 }], goal);
  assert.ok(Math.abs(r.tick(Infinity, .02)[0] - .4) < 1e-12, 'near target is its actual position');
  s.d.qpos[0] = .4; r.tick(Infinity, .02); assert.equal(r.index, 1);
  s.d.qpos[0] = 1; r.tick(Infinity, .02); assert.equal(r.status, '완료'); assert.deepEqual(s.cmd, [0, 0, 0, 1]);
}
{
  const s = make(), r = createScenarioRunner(s, () => false);
  s.d.qpos[3] = s.d.qpos[6] = Math.SQRT1_2;
  r.start([{ x: 0, y: .5 }]);
  const c = r.tick(Infinity, .02);
  assert.ok(Math.abs(c[0] - .5) < 1e-12 && Math.abs(c[1]) < 1e-12, 'world point rotates into yaw frame');
}
{
  const s = make(); let stopped = false;
  const r = createScenarioRunner(s, () => stopped);
  r.start([{ x: -5, y: 0 }]); const c = r.tick(.1, .02);
  assert.equal(r.active, true); assert.deepEqual(c.slice(0, 2), [0, 0]); assert.ok(c[2] > 0);
  stopped = true; r.tick(); assert.equal(r.status, '중단'); assert.deepEqual(s.cmd, [0, 0, 0, 1]);
  assert.equal(r.start([{ x: 1, y: 0 }]), false);
  stopped = false; r.tick(); assert.equal(r.active, false);
  r.start([{ x: 2, y: 0 }]);
  for (let i = 0; i < (STALL_S + .1) / .02; i++) r.tick(Infinity, .02);
  assert.equal(r.status, '막힘'); assert.deepEqual(s.cmd, [0, 0, 0, 1]);
}
console.log('AME-2 scenario contracts PASS: path/goal shared, <=1m next waypoint, ordered reach/complete, front/stall cancellation, STOP/no resume, turning behind');
