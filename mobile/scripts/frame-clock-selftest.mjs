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
  clock.reset(); clock.frame(0);
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
clock.reset(); clock.frame(0); clock.frame(100); clock.frame(200);
assert.equal(decisions, 1); assert.equal(ticks, 0);
release(false); await flush();
assert.equal(ticks, 10); assert.equal(decisions, 10, 'expired inference retries the same decision, including heading/stall timers');
// Start does not spin through busy-slot rejections while an expired Worker
// request drains. Keep both debt and the prepared command until a later RAF.
let startAttempts=0,startPrepared=0,startApplied=0;
const startClock=createFrameClock({dt:.02,yieldOnRejected:true,prepare:()=>startPrepared++,step:()=>{
  startAttempts++;if(startAttempts===1)return Promise.resolve(false);startApplied++;
}});
startClock.frame(0);startClock.frame(100);await flush();
assert.equal(startAttempts,1);assert.equal(startPrepared,1);assert.equal(startApplied,0);
assert.ok(Math.abs(startClock.stats.debt-.1)<1e-9);
startClock.frame(116);await flush();
assert.equal(startApplied,5);assert.equal(startPrepared,5,'retry keeps the original prepared observation/command');
// Cap long stalls explicitly; retain debt after per-frame work budget exhaustion.
const capped = createFrameClock({ dt: .02, maxSteps: 2, step: () => {} });
capped.reset(); capped.frame(0); capped.frame(2000);
assert.equal(capped.stats.dropped, 1.5); assert.equal(capped.stats.drops, 1); assert.equal(capped.stats.slow, true);
assert.ok(capped.stats.debt > .45);
// A drop describes current backlog, not a permanent warning on future runs.
for (let t = 2016; t <= 12016; t += 16) capped.frame(t);
assert.equal(capped.stats.dropped, 0); assert.equal(capped.stats.drops, 0); assert.equal(capped.stats.slow, false);
capped.frame(15016); assert.ok(capped.stats.dropped > 0);
capped.reset();
assert.equal(capped.stats.dropped, 0); assert.equal(capped.stats.drops, 0); assert.equal(capped.stats.slow, false);
// REVIEW-255 B1: nvidia-demo runs neutral decisions while STOP-locked. Hide for
// 30s after reset, then return: do not turn that gap into a .5s burst.
let resumed = 0;
const hidden = createFrameClock({ dt: .02, step: () => { resumed++; } });
hidden.frame(0); for (let t = 16; t <= 160; t += 16) hidden.frame(t);
const beforeHide = resumed;
hidden.reset(); hidden.frame(31000); hidden.frame(31016);
assert.ok(resumed - beforeHide <= 1); assert.equal(hidden.stats.dropped, 0);
for (let t = 31032; t < 41032; t += 16) hidden.frame(t);
assert.equal(hidden.stats.slow, false); assert.equal(hidden.stats.drops, 0);
// Even an occasional hidden RAF must not seed the resumed clock origin.
hidden.reset(); hidden.frame(42000, true); hidden.frame(72000, true);
const beforeVisible = resumed; hidden.frame(102000); hidden.frame(102016);
assert.ok(resumed - beforeVisible <= 1); assert.equal(hidden.stats.slow, false);
console.log('REVIEW-255 B1 PASS: 30s hide -> return burst 0, 10s normal -> slow false; reset/recovery clear drop counters');
// Async completion clears the warning before onStep paints the UI, too.
let asyncClock, lastSlow;
asyncClock = createFrameClock({ dt: .02, step: () => Promise.resolve(), onStep: () => { lastSlow = asyncClock.stats.slow; } });
asyncClock.frame(0); asyncClock.frame(2000); await flush();
assert.ok(asyncClock.stats.dropped > 0); assert.equal(asyncClock.stats.slow, true);
asyncClock.frame(2016); await flush();
assert.equal(asyncClock.stats.dropped, 0); assert.equal(asyncClock.stats.drops, 0);
assert.equal(asyncClock.stats.slow, false); assert.equal(lastSlow, false);
// STOP/reset invalidates pending debt and prevents late completion from draining it.
let complete, applied = 0;
const stopped = createFrameClock({ dt: .02, step: () => new Promise((r) => { complete = r; }), onStep: () => applied++ });
stopped.reset(); stopped.frame(0); stopped.frame(100); stopped.reset(); complete(true); await flush();
assert.equal(applied, 0); assert.equal(stopped.stats.debt, 0);
stopped.frame(1100, true); assert.equal(stopped.stats.debt, 0);
console.log('frame clock PASS: fixed timestamps, sync/async, sequential catch-up, decision/physics count, cancellation, bounded debt and explicit slow status');
