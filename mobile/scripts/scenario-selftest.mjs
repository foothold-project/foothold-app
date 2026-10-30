import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeMap, cell } from '../sim/lidar.js';
import { validateScenarios, createScenarioRunner, bindScenarioInterrupts, frontDistance, MAX_VX, MAX_WZ, STALL_S } from '../sim/scenario.js';

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
let routes = 0, samples = 0;
for (const { id } of read('../sim/maps.json')) {
  const defaultMap = decodeMap(read(`../sim/assets/${id}/map.json`));
  const list = read(`../sim/assets/${id}/scenarios.json`);
  for (const s of list) {
    const map = defaultMap;   // Match main.js: default routes never change map/spawn by floor_id.
    if (s.floor_id) assert.equal(s.floor_id, map.floor_id, `${id}: default route must match default spawn floor`);
    validateScenarios([s], map);
    assert.throws(() => validateScenarios([{ id: 'bad', name: 'bad', points: [{ x: Infinity, y: 0 }] }], map));
    assert.throws(() => validateScenarios([{ id: 'bad', name: 'bad', points: [{ x: map.origin[0] - 1, y: 0 }] }], map));
    routes++;
    // Check every leg from spawn, including a 35 cm body clearance around it.
    let prev = { x: map.spawn_xyyaw[0], y: map.spawn_xyyaw[1] };
    for (const p of s.points) {
      const steps = Math.ceil(Math.hypot(p.x - prev.x, p.y - prev.y) / (map.res / 2));
      for (let k = 0; k <= steps; k++) {
        const x = prev.x + (p.x - prev.x) * k / steps, y = prev.y + (p.y - prev.y) * k / steps;
        for (let dx = -0.35; dx <= 0.351; dx += map.res) for (let dy = -0.35; dy <= 0.351; dy += map.res) {
          assert.equal(cell(map, x + dx, y + dy), 254, `${s.id}: blocked/outside at ${x + dx},${y + dy}`); samples++;
        }
      }
      prev = p;
    }
    const sim = { cmd: [0, 0, 0], fell: false, d: { qpos: [map.spawn_xyyaw[0], map.spawn_xyyaw[1], 0.4, 1, 0, 0, 0] } };
    const runner = createScenarioRunner(sim, () => false);
    runner.start(s.points);
    let yaw = 0, last = 0;
    const distance = s.points.reduce((sum, p, i) => { const q = i ? s.points[i - 1] : { x: map.spawn_xyyaw[0], y: map.spawn_xyyaw[1] }; return sum + Math.hypot(p.x - q.x, p.y - q.y); }, 0);
    const limit = Math.max(10000, Math.ceil(distance / MAX_VX / 0.02) * 3);
    for (let k = 0; k < limit && runner.active; k++) {
      runner.tick();
      assert.ok(runner.index >= last && runner.index <= last + 1, 'waypoints must advance in order'); last = runner.index;
      const [vx, vy, wz] = sim.cmd;
      assert.ok(vx >= 0 && vx <= MAX_VX && vy === 0 && Math.abs(wz) <= MAX_WZ);
      sim.d.qpos[0] += Math.cos(yaw) * vx * 0.02; sim.d.qpos[1] += Math.sin(yaw) * vx * 0.02;
      yaw += wz * 0.02; sim.d.qpos[3] = Math.cos(yaw / 2); sim.d.qpos[6] = Math.sin(yaw / 2);
    }
    assert.equal(runner.status, '완료'); assert.equal(runner.index, s.points.length); assert.deepEqual(sim.cmd, [0, 0, 0]);
  }
}

const rays = new Float64Array(360).fill(Infinity);
rays[180] = 0.1; assert.equal(frontDistance(rays), Infinity);
rays[359] = 0.4; assert.equal(frontDistance(rays), 0.4);
for (const ev of ['left', 'right', 'stop', 'stopClick', 'hidden', 'pagehide', 'freeze', 'blur', 'home', 'reset']) {
  let stopped = false;
  const sim = { cmd: [0, 0, 0], fell: false, d: { qpos: [0, 0, 0.4, 1, 0, 0, 0] } };
  const runner = createScenarioRunner(sim, () => stopped);
  const els = Object.fromEntries(['left', 'right', 'stop', 'doc', 'win', 'home', 'reset'].map((k) => [k, new EventTarget()]));
  bindScenarioInterrupts({ runner, lock: () => { stopped = true; sim.cmd = [0, 0, 0]; }, ...els });
  runner.start([{ x: 2, y: 0 }]); runner.tick(); assert.ok(sim.cmd[0] > 0);
  if (ev === 'hidden') { els.doc.hidden = true; els.doc.dispatchEvent(new Event('visibilitychange')); }
  else if (['pagehide', 'freeze', 'blur'].includes(ev)) els.win.dispatchEvent(new Event(ev));
  else if (ev === 'stopClick') els.stop.dispatchEvent(new Event('click'));
  else els[ev].dispatchEvent(new Event(['home', 'reset'].includes(ev) ? 'click' : 'pointerdown'));
  assert.equal(runner.active, false, ev); assert.equal(stopped, true, ev); assert.deepEqual(sim.cmd, [0, 0, 0], ev);
  stopped = false; runner.tick(); assert.deepEqual(sim.cmd, [0, 0, 0], `${ev}: no automatic resume`);
}
for (const reason of ['막힘', '넘어짐', '중단']) {
  let stopped = false;
  const sim = { cmd: [0, 0, 0], fell: false, d: { qpos: [0, 0, 0.4, 1, 0, 0, 0] } };
  const r = createScenarioRunner(sim, () => stopped);
  r.start([{ x: 2, y: 0 }]); r.tick();
  if (reason === '넘어짐') sim.fell = true;
  if (reason === '중단') stopped = true;
  r.tick(reason === '막힘' ? 0.6 : Infinity);
  assert.equal(r.status, reason); assert.deepEqual(sim.cmd, [0, 0, 0]); assert.equal(r.active, false);
  stopped = true; assert.equal(r.start([{ x: 2, y: 0 }]), false);
}
// 찍은 곳 가기(goal): 막대 누름 = 취소만(잠금 없음 — 손 조종 우선), STOP·흐림 등은 시나리오와 같이 잠금
for (const ev of ['left', 'right', 'stop', 'blur']) {
  let stopped = false;
  const sim = { cmd: [0, 0, 0], fell: false, d: { qpos: [0, 0, 0.4, 1, 0, 0, 0] } };
  const runner = createScenarioRunner(sim, () => stopped);
  const els = Object.fromEntries(['left', 'right', 'stop', 'doc', 'win', 'home', 'reset'].map((k) => [k, new EventTarget()]));
  bindScenarioInterrupts({ runner, lock: () => { stopped = true; sim.cmd = [0, 0, 0]; }, ...els });
  runner.start([{ x: 2, y: 0 }], true); runner.tick(); assert.ok(sim.cmd[0] > 0 && runner.goal);
  (ev === 'blur' ? els.win : els[ev]).dispatchEvent(new Event(ev === 'blur' ? 'blur' : 'pointerdown'));
  assert.equal(runner.active, false, ev); assert.deepEqual(sim.cmd, [0, 0, 0], ev);
  assert.equal(stopped, ev === 'stop' || ev === 'blur', `goal ${ev}: lock only for STOP/lifecycle`);
  assert.equal(runner.status, ev === 'left' || ev === 'right' ? '손 조종' : '중단');
}
{ // 5초 진전 없음(앞으로 가는 중에만 셈) = 막힘, 앞 막힘은 앞으로 갈 때만 — 벽을 보고 뒤쪽 목표로 도는 것은 허용
  const sim = { cmd: [0, 0, 0], fell: false, d: { qpos: [0, 0, 0.4, 1, 0, 0, 0] } };
  const r = createScenarioRunner(sim, () => false);
  r.start([{ x: 2, y: 0 }], true);
  for (let k = 0; k < Math.round(STALL_S / 0.02) - 2; k++) r.tick(Infinity, 0.02);
  assert.equal(r.active, true, 'not stalled before 5 s');
  for (let k = 0; k < 5; k++) r.tick(Infinity, 0.02);
  assert.equal(r.status, '막힘'); assert.deepEqual(sim.cmd, [0, 0, 0]);
  r.start([{ x: -2, y: 0 }], true); r.tick(0.1, 0.02);
  assert.equal(r.active, true, 'turning toward a goal behind is not blocked'); assert.equal(sim.cmd[0], 0); assert.ok(Math.abs(sim.cmd[2]) > 0);
  for (let k = 0; k < 1000; k++) r.tick(0.1, 0.02);   // 돌기만 하는 동안은 진전 없음 시간을 세지 않는다
  assert.equal(r.active, true);
  r.start([{ x: 0.2, y: 0 }], true); r.tick();   // 이미 0.3 m 안 = 바로 도착·명령 0
  assert.equal(r.status, '완료'); assert.deepEqual(sim.cmd, [0, 0, 0]);
}
console.log(`scenario selftest OK: ${routes} routes, ${samples} free/clearance cells, ordered arrival, command bounds, 10 input/lifecycle interruptions, block/fall/STOP guards, goal hand-cancel/no-lock, 5 s stall, turn-not-blocked`);
