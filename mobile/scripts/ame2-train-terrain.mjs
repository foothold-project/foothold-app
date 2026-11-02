// Independently authored geometry from training source TEXT; no training imports.
// Run from any directory; generated JSON/XML contain no external assets or paths.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const out = fileURLToPath(new URL('../sim/assets/ame2-train-terrain/', import.meta.url));
mkdirSync(out, { recursive: true });
let seed = 11022026;
const random = () => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 2 ** 32; };
const uniform = (lo, hi) => lo + (hi - lo) * random();
const boxes = [], tiles = [];
function box(name, x, y, top, sx, sy, sz, color) {
  boxes.push({ name, pos: [x, y, top - sz / 2], size: [sx, sy, sz], color });
}
const stairColor = [.55, .61, .68], wallColor = [.78, .48, .25], floorColor = [.25, .28, .32];
// terrains_go2.py:105,135-144; custom_terrains.py:296-390.
// Three fixed difficulty samples retain the exact 12 m tile and parameter ranges.
for (const [level, difficulty] of [0, .5, 1].entries()) {
  const cx = level * 14, cy = 0, width = [.22, .26, .30][level];
  const rise = .03 + .14 * difficulty;
  const count = Math.floor((12 - 2 * 2 - 2) / (2 * width)) + 2;
  const lift = count * rise; // translate the training pit's spawn datum to z=0
  const prefix = `stairs-${level}`;
  box(`${prefix}-border-n`, cx, cy + 5, lift, 12, 2, lift, floorColor);
  box(`${prefix}-border-s`, cx, cy - 5, lift, 12, 2, lift, floorColor);
  box(`${prefix}-border-e`, cx + 5, cy, lift, 2, 8, lift, floorColor);
  box(`${prefix}-border-w`, cx - 5, cy, lift, 2, 8, lift, floorColor);
  for (let k = 0; k < count - 1; k++) {
    const passageX = uniform(.6, 1.4), passageY = uniform(.6, 1.4);
    const thick = uniform(.02, rise), top = lift - (k + 1) * rise;
    const offset = 4 - (k + .5) * width;
    const wy = width + uniform(-.02, .02), wx = width + uniform(-.02, .02);
    for (const side of [-1, 1]) {
      box(`${prefix}-ns-${k}-${side}`, cx, cy + side * offset, top, passageX, wy, thick, stairColor);
      box(`${prefix}-ew-${k}-${side}`, cx + side * offset, cy, top, wx, passageY, thick, stairColor);
      if (random() < .35) {
        const h = uniform(.3, 1), t = uniform(.05, .2);
        box(`${prefix}-wall-${k}-${side}`, cx + offset, cy + side * (passageY / 2 + t / 2), top + h, width, t, h, wallColor);
      }
    }
  }
  box(`${prefix}-spawn`, cx, cy, 0, 2, 2, .1, stairColor);
  tiles.push({ id: prefix, kind: 'stair_up', difficulty, center: [cx, cy], size: [12, 12],
    step_height: rise, step_width: width, num_steps: count, spawn: [cx, cy, 0], floor_z: 0,
    goals: [[cx + 5, cy]], border_size: 2, platform_size: 2, passage_width_range: [.6, 1.4],
    wall_height_range: [.3, 1], holes: true });
}
// terrains_go2.py:212-222; custom_terrains.py:847-888.
for (const [level, difficulty] of [0, .5, 1].entries()) {
  const cx = level * 14, cy = 14, gap = .08 + .62 * difficulty;
  const delta = [-1, 0, 1][level] * .3 * gap;
  const prefix = `gap-${level}`, start = cx + 1, end = start + gap;
  box(`${prefix}-start`, cx - 2.5, cy, 0, 7, 12, 2, stairColor);
  box(`${prefix}-landing`, (end + cx + 6) / 2, cy, delta, cx + 6 - end, 12, 2, stairColor);
  const floor = level === 1 ? null : [-.4, -.7, -1][level];
  if (floor !== null) box(`${prefix}-floor`, cx, cy, floor, 12, 12, .1, floorColor);
  tiles.push({ id: prefix, kind: 'gap', difficulty, center: [cx, cy], size: [12, 12], gap_width: gap,
    gap_start: start, gap_end: end, landing_height: delta, platform_height: 2, floor_z: 0,
    lower_floor_z: floor, spawn: [cx, cy, 0], goals: [[cx + 4, cy]] });
}
const meshes = {}, models = [];
// Same cuboids drive the renderer and MuJoCo; all faces have outward winding.
const faces = [0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,3,7,6,3,6,2,0,4,7,0,7,3,1,2,6,1,6,5];
for (const b of boxes) {
  const [x,y,z] = b.size.map((v) => v / 2);
  meshes[b.name] = { p: [-x,-y,-z,x,-y,-z,x,y,-z,-x,y,-z,-x,-y,z,x,-y,z,x,y,z,-x,y,z], i: faces };
  models.push({ name: b.name, mesh: b.name, pos: b.pos, quat: [1,0,0,0], color: b.color });
}
const write = (name, data) => writeFileSync(out + name, JSON.stringify(data, null, 2) + '\n');
writeFileSync(out + 'scene.json', JSON.stringify({ meshes, models }) + '\n');
writeFileSync(out + 'ame2-train-terrain.xml', '<mujoco model="ame2-train-terrain"><worldbody>\n' + boxes.map((b) =>
  `  <geom name="${b.name}" group="1" type="box" size="${b.size.map((v) => v / 2).join(' ')}" pos="${b.pos.join(' ')}"/>`).join('\n') + '\n</worldbody></mujoco>\n');
// Navigation only marks known flat support. Stair holes/gaps are unknown, not
// advertised as traversable by a 2-D route. AME-2 remains manually controlled.
const res = .1, origin = [-6, -6, 0], w = 400, h = 260;
const pixels = Buffer.alloc(w * h, 205);
for (let row = 0; row < h; row++) for (let col = 0; col < w; col++) {
  const x = origin[0] + (col + .5) * res, y = origin[1] + (h - row - .5) * res;
  if (tiles.some((t) => t.kind === 'stair_up' ? Math.abs(x - t.center[0]) < 1 && Math.abs(y - t.center[1]) < 1
    : Math.abs(y - t.center[1]) < 6 && x >= t.center[0] - 6 && x < t.gap_start)) pixels[row * w + col] = 254;
}
write('map.json', { res, origin, w, h, floor_z: 0, spawn_xyyaw: [0,0,0], spawn_z: .4, px: pixels.toString('base64') });
// Match make-top.mjs: 0.3m padding, 24px/m. Bake top.png with that script.
writeFileSync(out + 'top.json', JSON.stringify({ bounds: [-6.3,-6.3,34.3,20.3], px: [974,638], map: { origin, res, w, h } }) + '\n');
write('scenarios.json', [{ id: 'spawn-patch', name: '시작 평판 확인 · 초안', points: [{x:.6,y:0}] }]);
write('metadata.json', { draft: true, seed: 11022026, source: 'training source text; independent fixed samples',
  evidence: ['terrains_go2.py:105,135-144,212-222', 'custom_terrains.py:296-390,847-888'],
  types: ['stair_up', 'gap'], difficulty_samples: [0,.5,1], tiles,
  boxes: boxes.length, triangles: boxes.length * 12,
  limits: 'Two of twelve terrain types; deterministic draws, not the original training seed/distribution. No slope/roughness or curriculum. Spawn at stairs-0; other tiles are reachable only by manual scene navigation or test reset. No walking verdict.' });
console.log(`AME-2 training terrain: ${tiles.length} tiles, ${boxes.length} boxes (${boxes.length * 12} triangles)`);
