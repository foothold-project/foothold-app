import assert from 'node:assert/strict';
import { createScenarioRunner, bindScenarioInterrupts, BLOCK_RANGE, STALL_S } from '../sim/scenario.js';
import { ame2WorldGoal, ame2GoalObservation, ame2Joystick } from '../sim/ame2-adapter.js';
const make = () => ({ adapterId: 'ame2-demo', cmd: [0, 0, 0, 1], d: { qpos: [0, 0, .4, 1, 0, 0, 0] }, cancelPolicyStep() { this.cancelled = true; } });
const close = (a, b) => { assert.equal(a.length, b.length); a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-12, `${i}: ${v} != ${b[i]}`)); };
for (const goal of [false, true]) {
  const s = make(), r = createScenarioRunner(s, () => false);
  r.start([{ x: 5, y: 1, mark: 0 }, { x: 5, y: 5, mark: 1 }], goal);
  const c = r.tick(Infinity, .02);
  close(c, [10 / Math.sqrt(26), 2 / Math.sqrt(26), 1, 0]);
  assert.ok(Math.hypot(c[0], c[1]) <= 2);
  assert.ok(Math.abs(c[1] / c[0] - .2) < 1e-12, 'aim at first A* point, never across corner');
  r.tick(BLOCK_RANGE, .02); assert.equal(r.status, '막힘'); assert.deepEqual(s.cmd, [0, 0, 0, 1]);
  assert.equal(s.cancelled, true);
  r.start([{ x: .4, y: 0 }, { x: 1, y: 0 }], goal);
  close(r.tick(Infinity, .02), [.4, 0, 0, 1]);
  s.d.qpos[0] = .4; r.tick(Infinity, .02); assert.equal(r.index, 1);
  s.d.qpos[0] = 1; r.tick(Infinity, .02); assert.equal(r.status, '완료'); assert.deepEqual(s.cmd, [0, 0, 0, 1]);
}
for (const [x, y, yaw] of [[1.5, 0, 0], [1, 1, Math.PI / 4], [-1.5, 0, Math.PI]]) {
  const commands = [];
  for (const limits of [{}, { vx: .1, wz: .1 }, { vx: 1.5, wz: 1 }, { caps: { vx: 0, wz: 0 } }]) {
    const s = make(), r = createScenarioRunner(s, () => false, limits);
    r.start([{ x, y }], true);
    const command = r.tick(Infinity, .02);
    close(command, [x, y, Math.sin(yaw), Math.cos(yaw)]);
    for (let k = 0; k < 30; k++) close(r.tick(Infinity, .02), command);
    commands.push(command);
  }
  commands.forEach((c) => close(c, commands[0]));
}
{
  const s = make(), r = createScenarioRunner(s, () => false, { caps: { vx: 0 } });
  r.start([{ x: 1, y: 0 }]); r.tick(BLOCK_RANGE, .02);
  assert.equal(r.status, '막힘', 'direct goals retain obstacle guard even without a velocity scale');
}
{ // World points/heading remain fixed while the body translates and rotates.
  const s = make(), r = createScenarioRunner(s, () => false);
  const points = [{ x: 0, y: 1 }, { x: 0, y: 2 }, { x: -1, y: 2, yaw: -.4 }];
  r.start(points);
  close(r.tick(Infinity, .02), [0, 1, 1, 0]);
  s.d.qpos[1] = .5; s.d.qpos[3] = s.d.qpos[6] = Math.SQRT1_2;
  close(r.tick(Infinity, .02), [.5, 0, 0, 1]);
  s.d.qpos[1] = 1;
  close(r.tick(Infinity, .02), [1, 0, 1, 0]); assert.equal(r.index, 1);
  s.d.qpos[1] = 2;
  close(r.tick(Infinity, .02), [0, 1, Math.sin(-.4 - Math.PI / 2), Math.cos(-.4 - Math.PI / 2)]);
  assert.equal(r.index, 2); assert.deepEqual(points[0], { x: 0, y: 1 });
}
{ // Last segment uses the original incoming world path, not robot->point.
  const s = make(), r = createScenarioRunner(s, () => false);
  r.start([{ x: 1, y: 0 }, { x: 1, y: 1 }]);
  s.d.qpos[0] = 1; s.d.qpos[1] = .1; r.tick(Infinity, .02);
  s.d.qpos[0] = 1.4; close(r.tick(Infinity, .02), [-.4, .9, 1, 0]);
}
{ // At/beyond 2 m never triggers the observation's random far-goal yaw.
  const random = Math.random;
  Math.random = () => { throw new Error('automatic heading must not be redrawn'); };
  try {
    for (let k = 0; k < 10000; k++) {
      const q = make().d.qpos, yaw = k * .031;
      q[3] = Math.cos(yaw / 2); q[6] = Math.sin(yaw / 2);
      const c = ame2WorldGoal(q, { x: 3 * Math.cos(k), y: 3 * Math.sin(k) }, -.7);
      assert.ok(Math.hypot(c[0], c[1]) <= 2);
      assert.equal(ame2GoalObservation(c), c);
    }
  } finally { Math.random = random; }
  close(ame2Joystick(null, 0, [1, 0, 1], .02).command, [1, 0, Math.sin(.02), Math.cos(.02)]);
  close(ame2Joystick(null, 0, [-1, 0, 0], .02).command, [-1, 0, 0, 1]);
}
{
  const s = make(); let stopped = false;
  const r = createScenarioRunner(s, () => stopped);
  r.start([{ x: -5, y: 0 }]); const c = r.tick(.1, .02);
  assert.equal(r.active, true); close(c, [-2, 0, 0, -1]);
  stopped = true; r.tick(); assert.equal(r.status, '중단'); assert.deepEqual(s.cmd, [0, 0, 0, 1]);
  assert.equal(r.start([{ x: 1, y: 0 }]), false);
  stopped = false; r.tick(); assert.equal(r.active, false);
  r.start([{ x: 2, y: 0 }]);
  for (let i = 0; i < (STALL_S + .1) / .02; i++) r.tick(Infinity, .02);
  assert.equal(r.status, '막힘'); assert.deepEqual(s.cmd, [0, 0, 0, 1]);
}
for (const goal of [false, true]) for (const ev of ['left', 'right', 'stop', 'blur']) {
  const s = make(); let stopped = false;
  const runner = createScenarioRunner(s, () => stopped);
  const els = Object.fromEntries(['left', 'right', 'stop', 'doc', 'win', 'home', 'reset'].map((k) => [k, new EventTarget()]));
  bindScenarioInterrupts({ runner, lock: () => { stopped = true; }, ...els });
  runner.start([{ x: 1, y: 1 }], goal); runner.tick();
  (ev === 'blur' ? els.win : els[ev]).dispatchEvent(new Event(ev === 'blur' ? 'blur' : 'pointerdown'));
  assert.equal(runner.active, false); assert.equal(s.cancelled, true); assert.deepEqual(s.cmd, [0, 0, 0, 1]);
  assert.equal(stopped, !goal || ev === 'stop' || ev === 'blur');
}
console.log('AME-2 scenario contracts PASS: direct world goals <=2m, front/45/180 nonzero XY, speed-independent, world/path/explicit yaw, no far-yaw redraw, ordered reach, front/stall/STOP/manual cancellation');
