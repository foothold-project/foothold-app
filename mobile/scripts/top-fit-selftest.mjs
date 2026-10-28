import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { topFrame } from '../sim/top-fit.js';
const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
let cases = 0;
for (const { id } of read('../sim/maps.json')) {
  const map = read(`../sim/assets/${id}/map.json`);
  for (const aspect of [360 / 800, 800 / 360, 1, 1920 / 1080]) for (const angle of [0, .5, Math.PI / 2]) {
    const f = topFrame(map, aspect, angle);
    assert.equal(f.cx, map.origin[0] + map.w * map.res / 2);
    for (const x of [map.origin[0], map.origin[0] + map.w * map.res]) for (const y of [map.origin[1], map.origin[1] + map.h * map.res]) {
      const dx = x - f.cx, dy = y - f.cy;
      assert.ok(Math.abs(dx * Math.cos(angle) + dy * Math.sin(angle)) < f.width / 2);
      assert.ok(Math.abs(-dx * Math.sin(angle) + dy * Math.cos(angle)) < f.height / 2);
    }
    cases++;
  }
}
console.log(`whole-map orthographic framing OK: ${cases} viewport/rotation cases, all corners visible`);
