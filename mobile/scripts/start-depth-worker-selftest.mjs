// sync-web first; run headless under the shared heavy-test flock.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(pathToFileURL(process.env.FH_PLAYWRIGHT));
const root = resolve('mobile/www');
const server = createServer((req, res) => {
  if (req.url === '/') return res.setHeader('Content-Type', 'text/html').end('<!doctype html><title>Depth parity</title>');
  const file = resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
  if (!file.startsWith(root + sep)) return res.writeHead(403).end();
  try {
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json' })[extname(file)] ?? 'application/octet-stream');
    res.end(readFileSync(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.FH_CHROME ?? '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const result = await page.evaluate(async () => {
    const { default: load } = await import('/sim/mujoco/mujoco.js');
    const { makeStartDemoDepth } = await import('/sim/start-demo-sensors.js');
    const { makeStartDepthWorker } = await import('/sim/start-depth-worker-client.js');
    const { createSim, ISAAC_LIKE } = await import('/sim/sim.js');
    const { withPolicyState } = await import('/sim/policy-onnx.js');
    const { START_DEMO_ONNX } = await import('/sim/start-demo-adapter.js');
    const check = (ok, text) => { if (!ok) throw Error(text); };
    const bytesEqual = (a, b) => {
      const aa = new Uint8Array(a.buffer, a.byteOffset, a.byteLength), bb = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
      check(aa.length === bb.length && aa.every((x, i) => x === bb[i]), 'Float32 bytes differ');
    };
    const mj = await load(); mj.FS.mkdir('/go2'); mj.FS.mkdir('/go2/assets');
    const bytes = async (url) => new Uint8Array(await (await fetch(url)).arrayBuffer());
    const xml = await (await fetch('/sim/assets/unitree_go2/go2.xml')).text();
    mj.FS.writeFile('/go2/go2.xml', xml);
    await Promise.all([...xml.matchAll(/<mesh file="([\w.]+)"/g)].map(async ([, file]) => mj.FS.writeFile('/go2/assets/' + file, await bytes('/sim/assets/unitree_go2/assets/' + file))));
    const rows = [];
    let seed = 270; const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    for (const id of ['warehouse', 'factory-inspection', 'element-course']) {
      const base = '/sim/assets/' + id + '/', map = await (await fetch(base + 'map.json')).json();
      for (const file of map.physics_assets ?? []) {
        const data = await bytes(base + file); mj.FS.writeFile('/go2/' + file, data); mj.FS.writeFile('/go2/assets/' + file, data);
      }
      mj.FS.writeFile('/go2/world.xml', await bytes(base + id + '.xml'));
      mj.FS.writeFile('/go2/scene.xml', '<mujoco><include file="go2.xml"/><include file="world.xml"/></mujoco>');
      const m = mj.MjModel.from_xml_path('/go2/scene.xml'), d = new mj.MjData(m); mj.mj_forward(m, d);
      const native = makeStartDemoDepth(mj, m, d), packets = [];
      const worker = makeStartDepthWorker(mj, m, d, { createWorker(url) {
        const w = new Worker(url, { type: 'module' }), post = w.postMessage.bind(w);
        w.postMessage = (packet, transfer) => { packets.push({ type: packet.type, keys: Object.keys(packet), pose: packet.pose?.length, transfer: transfer.length }); post(packet, transfer); };
        return w;
      } });
      const calc = [], roundtrip = [];
      try {
        for (let i = 0; i < 36; i++) {
          const yaw = i < 12 ? i * Math.PI / 6 : (random() * 2 - 1) * Math.PI;
          const pitch = i < 12 ? (i % 3 - 1) * .3 : (random() * 2 - 1) * .4, roll = i < 12 ? (i % 2 ? 1 : -1) * .2 : (random() * 2 - 1) * .3;
          const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2), cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2), cr = Math.cos(roll / 2), sr = Math.sin(roll / 2);
          const q = [map.spawn_xyyaw[0] + (i < 12 ? (i % 4) * .5 : (random() * 2 - 1) * 8), map.spawn_xyyaw[1] + (i < 12 ? Math.floor(i / 4) * .5 : (random() * 2 - 1) * 8), map.floor_z + (i < 12 ? .3 : .15 + random() * .5),
            cr * cp * cy + sr * sp * sy, sr * cp * cy - cr * sp * sy, cr * sp * cy + sr * cp * sy, cr * cp * sy - sr * sp * cy];
          bytesEqual(native(q), await worker(q));
          check(worker.roundtripMs > 0, 'unexpected native fallback: ' + worker.workerError); calc.push(worker.ms); roundtrip.push(worker.roundtripMs);
        }
        check(packets.filter((p) => p.type === 'init').length === 1, 'scene sent once');
        check(packets.filter((p) => p.type === 'scan').length === 36, 'all captures dispatched');
        check(packets.slice(1).every((p) => p.pose === 7 && p.transfer === 1 && p.keys.sort().join() === 'pose,seq,type'), 'only pose transferred per capture');
        const q = [map.spawn_xyyaw[0], map.spawn_xyyaw[1], map.floor_z + .3, 1, 0, 0, 0];
        let silent;
        for (const options of [
          { createWorker: null },
          { createWorker() { throw Error('unsupported'); } },
          { initTimeoutMs: 5, createWorker: () => ({ postMessage() {}, terminate() {} }) },
          { scanTimeoutMs: 5, createWorker: () => (silent = { scans: 0, terminated: 0, postMessage(p) { if (p.type === 'init') queueMicrotask(() => this.onmessage({ data: { type: 'ready', seq: p.seq } })); else this.scans++; }, terminate() { this.terminated++; } }) },
          { createWorker: () => ({ postMessage(p) { queueMicrotask(() => this.onmessage({ data: p.type === 'init' ? { type: 'ready', seq: p.seq } : { type: 'error', seq: p.seq, error: 'scan failure' } })); }, terminate() {} }) },
        ]) {
          const fallback = makeStartDepthWorker(mj, m, d, options);
          try {
            bytesEqual(native(q), await fallback(q));
            const next = q.slice(); next[0] += .5;
            bytesEqual(native(next), await fallback(next));
            if (options.scanTimeoutMs) {
              check(fallback.workerError === 'Depth Worker scan timeout', 'silent scan times out');
              check(silent.scans === 1 && silent.terminated === 1, 'timeout terminates Worker and subsequent scans stay native');
            }
          } finally { fallback.dispose(); }
        }
        rows.push({ map: id, poses: 36, rays: 129600, byteDifference: 0, calc, roundtrip });
      } finally { worker.dispose(); native.dispose(); d.delete(); m.delete(); }
    }
    // Hold the exact captured sample beyond 20 ms. Inference has its own
    // deadline; depth must wait, and cancellation must never advance physics.
    for (const phase of ['initial', 'commit']) for (const cancel of ['cancelPolicyStep', 'reset', 'clearPolicyState', 'dispose']) {
      let transport;
      const seen = [];
      const policy = withPolicyState((...inputs) => {
        seen.push(inputs.map((x) => Array.from(x)));
        return { action: new Float32Array(12), h_prop_next: Float32Array.from(inputs[3], (x) => x + 1), h_terr_next: Float32Array.from(inputs[4], (x) => x + 1) };
      }, START_DEMO_ONNX);
      const sim = createSim(mj, '/go2/scene.xml', ISAAC_LIKE, policy, undefined, 'start-demo', { depthWorkerOptions: { createWorker: () => (transport = {
        scans: [], postMessage(p) { if (p.type === 'init') queueMicrotask(() => this.onmessage({ data: { type: 'ready', seq: p.seq } })); else this.scans.push(p); }, terminate() {},
        reply() { const p = this.scans.shift(); this.onmessage({ data: { type: 'result', seq: p.seq, frame: new Float32Array(3600).fill(.5), ms: 1 } }); },
      }) } });
      const waiting = async () => { while (!transport.scans.length) await new Promise((r) => setTimeout(r, 1)); };
      try {
        sim.cmd = [.4, 0, 0];
        let step = sim.step(); await waiting();
        check(sim.step() === false, 'one pending tick, no queue');
        sim.cmd = [.9, 0, 0];
        if (phase === 'commit') {
          transport.reply(); check(await step, 'initial accepted');
          check(seen[0][0][6] === Math.fround(.4), 'initial camera wait retains tick command');
          for (let i = 1; i < 5; i++) check(await sim.step(), 'intervening tick accepted');
          step = sim.step(); await waiting();
        } else check(seen.length === 0, 'first observation waits for depth');
        const time = sim.t, q = Array.from(sim.d.qpos);
        await new Promise((r) => setTimeout(r, 30));
        check(sim.t === time && q.every((x, i) => x === sim.d.qpos[i]), 'no physics while depth pending');
        sim[cancel]();
        if (cancel === 'dispose') { await step.catch(() => {}); }
        else { transport.reply(); check(await step === false, 'cancelled capture cannot advance'); }
        check(sim.t === (cancel === 'reset' ? 0 : time), 'no stale physics');
        if (cancel === 'cancelPolicyStep') {
          const rejected = seen.at(-1), calls = seen.length;
          check(await sim.step(), 'retry exact cached capture without a new scan');
          if (phase === 'commit') check(JSON.stringify(rejected) === JSON.stringify(seen.at(-1)), 'cancellation preserves GRU/history/depth inputs');
          check(seen.length === calls + 1 && transport.scans.length === 0, 'one retry inference, no duplicate capture');
        }
        if (cancel === 'reset' || cancel === 'clearPolicyState') {
          const retry = sim.step(); await waiting(); transport.reply(); check(await retry, 'fresh initial capture after reset');
          const inputs = seen.at(-1);
          check(inputs[3].every((x) => x === 0) && inputs[4].every((x) => x === 0) && inputs[6][0], 'reset clears recurrent state and first-frame flag');
        }
      } finally { if (cancel !== 'dispose') sim.dispose(); }
    }
    return { rows, lifecycle: '8 initial/commit cancellation cases PASS', fallback: 'no Worker/create/init timeout/scan timeout/scan error; continued native scans PASS' };
  });
  assert.equal(result.rows.length, 3);
  if (process.env.START_DEPTH_WORKER_REPORT) writeFileSync(process.env.START_DEPTH_WORKER_REPORT, JSON.stringify(result, null, 2));
  console.log('Depth Worker PASS', JSON.stringify({ ...result, rows: result.rows.map(({ calc, roundtrip, ...row }) => row) }));
} finally { await browser?.close(); await new Promise((r) => server.close(r)); }
