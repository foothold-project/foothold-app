// Wall time is debt, not a policy interval: await each decision before advancing
// its fixed decimation. Drain after async completion too (not one tick per RAF).
// 15 ticks = .3s at 50Hz: covers 5FPS (.2s) plus recovery headroom. Keep
// at most .5s queued debt; longer stalls report exactly how much was discarded.
export function createFrameClock({ dt, step, prepare = () => {}, onStep = () => {}, onError = () => {}, maxSteps = 15, maxDebt = 0.5 }) {
  let debt = 0, last = null, budget = 0, pending = false, epoch = 0, dropped = 0, drops = 0, prepared = false;
  function drain() {
    while (!pending && budget > 0 && debt + 1e-10 >= dt) {
      debt = Math.max(0, debt - dt); budget--;
      const generation = epoch;
      let result;
      try { if (!prepared) { prepare(); prepared = true; } result = step(); } catch (e) { reset(); onError(e); return; }
      const complete = (applied) => {
        if (generation !== epoch) return;
        if (applied === false) debt += dt; // cancelled/expired inference advanced no physics
        else { prepared = false; onStep(); }
      };
      if (result?.then) {
        pending = true;
        Promise.resolve(result).then(complete, (e) => { if (generation === epoch) { reset(); onError(e); } })
          .finally(() => { pending = false; drain(); });
        return;
      }
      complete(result);
    }
  }
  function reset(now = last) { epoch++; prepared = false; debt = 0; budget = 0; last = now; }
  return {
    reset,
    frame(now, paused = false) {
      const elapsed = last === null ? 0 : Math.max(0, (now - last) / 1000);
      last = now;
      if (paused) { reset(now); return; }
      debt += elapsed;
      if (debt > maxDebt) { dropped += debt - maxDebt; debt = maxDebt; drops++; }
      budget = maxSteps;
      drain();
    },
    get stats() { return { debt, pending, dropped, drops, slow: debt >= 0.1 || dropped > 0 }; },
  };
}
