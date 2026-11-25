// Usage: node occgrid_reference.cjs /tmp/compiled/occgrid.js uslam_room.json
const fs = require('node:fs');
const { OccGrid } = require(process.argv[2]);
const fixture = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const grid = new OccGrid(fixture.size);
for (const {points, pose} of fixture.frames) {
  grid.add(new Float32Array(points.flat()), {x:pose[0], y:pose[1], z:pose[2]}, 8000, Infinity);
}
process.stdout.write(JSON.stringify({c0:grid.c0, r0:grid.r0, L:Buffer.from(grid.L.buffer).toString('base64')}));
