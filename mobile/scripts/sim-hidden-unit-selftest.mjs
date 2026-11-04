import assert from 'node:assert/strict';
import { bindScenarioInterrupts, createScenarioRunner } from '../sim/scenario.js';
import { createFrameClock } from '../sim/frame-clock.js';

for (const preserveOnHide of [false, true]) for (const goal of [false, true]) for (const event of ['hidden', 'blur', 'freeze', 'pagehide', 'stop', 'home', 'reset']) {
  let stopped = false, steps = 0;
  const sim = { cmd: [0, 0, 0], d: { qpos: [0, 0, .4, 1, 0, 0, 0] } };
  const runner = createScenarioRunner(sim, () => stopped);
  const els = Object.fromEntries(['left', 'right', 'stop', 'doc', 'win', 'home', 'reset'].map(k => [k, new EventTarget()]));
  bindScenarioInterrupts({ runner, preserveOnHide, lock: () => { stopped = true; }, ...els });
  const clock = createFrameClock({ dt: .02, prepare: () => runner.tick(Infinity, .02), step: () => { steps++; sim.d.qpos[0] += sim.cmd[0] * .02; } });
  runner.start([{ x: 20, y: 0 }], goal);
  clock.frame(0); clock.frame(100);
  const index = runner.index, x = sim.d.qpos[0], before = steps;
  if (event === 'hidden') { els.doc.hidden = true; els.doc.dispatchEvent(new Event('visibilitychange')); }
  else if (['blur', 'freeze', 'pagehide'].includes(event)) els.win.dispatchEvent(new Event(event));
  else els[event].dispatchEvent(new Event(event === 'stop' ? 'pointerdown' : 'click'));
  const retained = preserveOnHide && ['hidden', 'blur', 'freeze'].includes(event);
  assert.equal(runner.active, retained, `${preserveOnHide}/${goal}/${event}`);
  assert.equal(stopped, !retained);
  if (retained) {
    // main resets the frame clock before RAF can stop: no hidden debt or stall time.
    clock.reset(); clock.frame(310100);
    assert.equal(steps, before); assert.equal(sim.d.qpos[0], x); assert.equal(runner.index, index);
    clock.frame(310120);
    assert.equal(steps, before + 1); assert.ok(sim.d.qpos[0] > x); assert.equal(runner.active, true);
  }
}
console.log('PASS: sim autonomy retained through hidden/blur/freeze + 310s pause; default safety, STOP/home/reset/pagehide unchanged');
