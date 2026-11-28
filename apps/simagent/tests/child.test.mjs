// child.mjs 한 줄 JSON 계약 (README.md). 실제 자식 프로세스를 띄워 stdin/stdout 으로만 잰다.
// FH_SIM_SRC 필요. 서버 · 실기 없음.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { BATTERY } from '../vitals.mjs';

const simSrc = process.env.FH_SIM_SRC;
const skip = simSrc ? false : 'FH_SIM_SRC 없음';
const here = fileURLToPath(new URL('../', import.meta.url));

function startChild(args = []) {
  const p = spawn(process.execPath, ['child.mjs', '--map', 'collapsed-house-v2', ...args], { cwd: here, env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const states = [], waiters = [];
  let stderr = '';
  p.stderr.on('data', (b) => { stderr += b; });
  createInterface({ input: p.stdout }).on('line', (line) => {
    const s = JSON.parse(line); s._rx = performance.now(); states.push(s);
    for (const w of waiters.splice(0)) if (!w.done) w.check();
  });
  const until = (pred, ms = 8000) => new Promise((resolve, reject) => {
    const w = { done: false, check() { const hit = states.find((s) => s._rx >= w.from && pred(s)); if (hit) { w.done = true; clearTimeout(w.t); resolve(hit); } else waiters.push(w); } };
    w.from = performance.now(); w.t = setTimeout(() => { w.done = true; reject(new Error('시간 초과: ' + pred)); }, ms);
    w.check();
  });
  const send = (o) => p.stdin.write((typeof o === 'string' ? o : JSON.stringify(o)) + '\n');
  const exited = new Promise((r) => p.on('exit', (code, signal) => r({ code, signal, at: performance.now() })));
  return { p, states, until, send, exited, stderr: () => stderr };
}

test('시작은 STOP 상태 · v2_live/state/1 · 20 Hz 안팎', { skip, timeout: 30000 }, async () => {
  const c = startChild();
  try {
    const first = await c.until(() => true);
    assert.equal(first.schema, 'v2_live/state/1');
    assert.equal(first.stop_requested, true);
    assert.equal(first.policy_running, true);
    assert.deepEqual(first.cmd_applied, [0, 0, 0]);
    const t0 = performance.now(); const n0 = c.states.length;
    await new Promise((r) => setTimeout(r, 1000));
    const hz = (c.states.length - n0) / ((performance.now() - t0) / 1000);
    assert.ok(hz > 15 && hz < 25, `상태 ${hz.toFixed(1)} Hz`);
    const last = c.states.at(-1);
    assert.ok(last.sim_t > first.sim_t, 'sim_t 증가');
    assert.ok(last.upright > 0.9 && last.fallen === false);
  } finally { c.p.kill(); }
});

test('resume 뒤 cmd 는 적용 · STOP 은 즉시 0 · STOP 중 cmd 무시', { skip, timeout: 30000 }, async () => {
  const c = startChild();
  try {
    await c.until(() => true);
    c.send({ t: 'cmd', v: [0.6, 0, 0] });
    const ignored = await c.until(() => true);
    assert.deepEqual(ignored.cmd_applied, [0, 0, 0], 'STOP 중에는 cmd 무시');
    c.send({ t: 'resume' });
    await c.until((s) => s.stop_requested === false);
    const timer = setInterval(() => c.send({ t: 'cmd', v: [0.6, 0, 0] }), 50);
    const moving = await c.until((s) => s.cmd_applied[0] === 0.6);
    await new Promise((r) => setTimeout(r, 1500));
    clearInterval(timer);
    const sent = performance.now(); c.send({ t: 'stop' });
    const stopped = await c.until((s) => s.stop_requested === true);
    assert.deepEqual(stopped.cmd_applied, [0, 0, 0]);
    assert.ok(stopped._rx - sent < 150, `STOP → 상태 ${(stopped._rx - sent).toFixed(0)} ms`);
    assert.ok(Math.hypot(stopped.x - moving.x, stopped.y - moving.y) > 0.5, '앞으로 걸음');
  } finally { c.p.kill(); }
});

test('잘못된 줄은 STOP 으로 잠그고 stderr 에 알린다', { skip, timeout: 30000 }, async () => {
  const c = startChild();
  try {
    await c.until(() => true);
    c.send({ t: 'resume' });
    await c.until((s) => s.stop_requested === false);
    for (const bad of ['not json', '{"t":"cmd","v":[1e9,0,0]}', '{"t":"cmd","v":[0.6,0]}', '{"t":"warp"}', '[]']) {
      c.send({ t: 'resume' });
      await c.until((s) => s.stop_requested === false);
      c.send(bad);
      const s = await c.until((x) => x.stop_requested === true);
      assert.deepEqual(s.cmd_applied, [0, 0, 0], bad);
    }
    assert.match(c.stderr(), /bad_line/);
  } finally { c.p.kill(); }
});

test('cmd 가 0.5 s 넘게 안 오면 (부모 늦음) 0 으로', { skip, timeout: 30000 }, async () => {
  const c = startChild();
  try {
    await c.until(() => true);
    c.send({ t: 'resume' });
    await c.until((s) => s.stop_requested === false);
    c.send({ t: 'cmd', v: [0.6, 0, 0] });
    const on = await c.until((s) => s.cmd_applied[0] === 0.6);
    const off = await c.until((s) => s.cmd_applied[0] === 0 && s.ttl_expired === true);
    const gap = off._rx - on._rx;
    assert.ok(gap > 300 && gap < 800, `끊김 → 0 ${gap.toFixed(0)} ms`);
  } finally { c.p.kill(); }
});

test('부모가 사라지면 (stdin 닫힘) 자식도 1 s 안에 끝난다', { skip, timeout: 30000 }, async () => {
  const c = startChild();
  await c.until(() => true);
  const closed = performance.now(); c.p.stdin.end();
  const r = await c.exited;
  assert.ok(r.at - closed < 1000, `${(r.at - closed).toFixed(0)} ms`);
  assert.equal(r.code, 0);
});

test('reset 은 새 episode · STOP 상태 · 출발 자리', { skip, timeout: 30000 }, async () => {
  const c = startChild();
  try {
    const first = await c.until(() => true);
    c.send({ t: 'reset' });
    const r = await c.until((s) => s.episode === first.episode + 1 && s.reset_in_progress === false);
    assert.equal(r.stop_requested, true);
    assert.ok(Math.hypot(r.x - first.x, r.y - first.y) < 0.1);
    assert.ok(c.states.some((s) => s.reset_in_progress === true));
  } finally { c.p.kill(); }
});

test('시뮬 배터리 · 관절 온도는 MuJoCo 토크 · 속도를 적분한 값 (서 있으면 대기 전력 언저리)', { skip, timeout: 30000 }, async () => {
  const c = startChild(['--battery-start', '80', '--ambient-c', '30']);
  try {
    const a = await c.until(() => true);
    await new Promise((r) => setTimeout(r, 1500));
    const b = c.states.at(-1);
    assert.ok(a.battery_soc <= 80 && a.battery_soc > 79.9, `시작 ${a.battery_soc}`);
    const rate = (a.battery_soc - b.battery_soc) / (b.sim_t - a.sim_t); // %/s
    const standby = 100 * BATTERY.standbyW / 3600 / BATTERY.capacityWh;
    assert.ok(rate >= standby * 0.999 && rate < standby * 3, `줄어듦 ${rate} · 대기만 ${standby}`);
    assert.ok(Array.isArray(b.joint_temp_c) && b.joint_temp_c.length === 12);
    for (const t of b.joint_temp_c) assert.ok(Number.isFinite(t) && t >= 30 && t < 31, `관절 온도 ${t}`);
    // 남은 분: 80 % × 236.8 Wh ÷ (서 있는 전력, 대기 언저리) → 약 290 분
    const full = Math.floor(0.8 * BATTERY.capacityWh / BATTERY.standbyW * 60);
    assert.ok(Number.isInteger(b.battery_minutes_left) && b.battery_minutes_left <= full && b.battery_minutes_left > full / 3, `남은 분 ${b.battery_minutes_left}`);
    // 자세: 몸 사원수에서 낸 roll · pitch (rad). 서 있으니 작고, 넘어짐 아님
    assert.ok(Math.abs(b.roll) < 0.2 && Math.abs(b.pitch) < 0.2, `roll ${b.roll} pitch ${b.pitch}`);
    assert.equal(b.fallen, false);
  } finally { c.p.kill(); }
});
