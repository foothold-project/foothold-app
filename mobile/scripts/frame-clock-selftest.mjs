import assert from 'node:assert/strict';
import { createFrameClock } from '../sim/frame-clock.js';
const flush = () => new Promise((r) => setImmediate(r));
for (const async of [false, true]) for (const fps of [60, 30, 5]) {
  let ticks = 0, decisions = 0, physical = 0;
  const clock = createFrameClock({ dt: .02, prepare: () => decisions++, step: () => {
    const advance = () => { physical += 4; ticks++; };
    if (async) return Promise.resolve().then(advance);
    advance();
  } });
  clock.reset(0);
  for (let i = 1; i <= fps * 2; i++) { clock.frame(i * 1000 / fps); await flush(); }
  assert.equal(ticks, 100); assert.equal(physical, decisions * 4); assert.equal(clock.stats.dropped, 0);
  console.log(JSON.stringify({ async, fps, wall: 2, physics: ticks * .02, ratio: ticks * .02 / 2, decisions, physical }));
}
// While inference waits, physical state and decision preparation stay frozen.
let release, ticks = 0, decisions = 0, attempts = 0;
const clock = createFrameClock({ dt: .02, prepare: () => decisions++, step: () => {
  attempts++;
  if (attempts === 1) return new Promise((r) => { release = r; });
  ticks++;
} });
clock.reset(0); clock.frame(100); clock.frame(200);
assert.equal(decisions, 1); assert.equal(ticks, 0);
release(false); await flush();
assert.equal(ticks, 10); assert.equal(decisions, 10, 'expired inference retries the same decision, including heading/stall timers');
// Cap long stalls explicitly; retain debt after per-frame work budget exhaustion.
const capped = createFrameClock({ dt: .02, maxSteps: 2, step: () => {} });
capped.reset(0); capped.frame(2000);
assert.equal(capped.stats.dropped, 1.5); assert.equal(capped.stats.drops, 1); assert.equal(capped.stats.slow, true);
assert.ok(capped.stats.debt > .45);
// STOP/reset invalidates pending debt and prevents late completion from draining it.
let complete, applied = 0;
const stopped = createFrameClock({ dt: .02, step: () => new Promise((r) => { complete = r; }), onStep: () => applied++ });
stopped.reset(0); stopped.frame(100); stopped.reset(100); complete(true); await flush();
assert.equal(applied, 0); assert.equal(stopped.stats.debt, 0);
stopped.frame(1100, true); assert.equal(stopped.stats.debt, 0);
console.log('frame clock PASS: fixed timestamps, sync/async, sequential catch-up, decision/physics count, cancellation, bounded debt and explicit slow status');
