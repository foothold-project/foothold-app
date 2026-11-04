import assert from 'node:assert/strict';
import { findPath, inflate, visible } from './astar.js';
const grid = () => ({ w: 80, h: 60, res: .1, origin: [0, 0], px: new Uint8Array(4800).fill(254) });
const a = { x: 1.05, y: 3.05 }, b = { x: 6.05, y: 3.05 };
{
  const map = grid(); let calls = 0;
  // An XY wall forces A*: height work must stay on the returned corridor.
  for (let r = 15; r < 45; r++) map.px[r * map.w + 35] = 0;
  map.heightAt = () => { calls++; return 0; };
  const plain = { ...map, heightAt: undefined };
  assert.deepEqual(await findPath(map, a, b), await findPath(plain, a, b));
  assert.ok(calls < 1500, `height queries bounded by route corridor: ${calls}`);
}
{
  const map = grid();
  // The planar shortcut crosses a 1 m cliff. A valid height-aware detour
  // exists around the top, and must still be found by the fallback.
  map.heightAt = (x, y) => x > 3 && x < 4 && y < 4 ? 1 : 0;
  const path = await findPath(map, a, b), inflated = await inflate(map);
  assert.ok(path && path.length > 1);
  let previous = a;
  for (const point of path) { assert.ok(visible(map, inflated, previous, point)); previous = point; }
  map.heightAt = (x) => x > 3 && x < 4 ? 1 : 0;
  assert.equal(await findPath(map, a, b), null, 'an impassable cliff stays impassable');
  map.heightAt = () => NaN;
  assert.equal(await findPath(map, a, b), null, 'missing support never passes corridor validation');
}
{
  const map = grid();
  for (let r = 0; r < map.h; r++) map.px[r * map.w + 30] = 0;
  const from = { x: 3.25, y: 3.05 }, to = { x: 6.05, y: 3.05 };
  let near = 0, far = 0;
  map.heightAt = (x) => { if (x < 3.6) near++; else far++; return 0; };
  map.prepareNavigation = () => true;
  const path = await findPath(map, from, to);
  assert.ok(path); assert.ok(near > 0, 'margin SNAP still inspects support');
  assert.equal(far, 0, 'proven flat search does not inspect heights outside SNAP');
  map.heightAt = () => NaN;
  assert.equal(await findPath(map, from, to), null, 'flat proof never bypasses missing SNAP support');
}
console.log('astar terrain PASS: corridor query bound, exact flat route, height detour fallback, cliffs/NaN rejected, height-aware margin SNAP with flat search');
