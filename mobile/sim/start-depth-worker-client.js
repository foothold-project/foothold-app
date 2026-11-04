import { makeStartDemoDepth } from './start-demo-sensors.js';

// Preserve the native ray implementation and its compiled geometry exactly.
// Send one MJB snapshot at startup; subsequent requests contain only the pose.
export function makeStartDepthWorker(mj, m, d, {
  createWorker = typeof Worker === 'function' ? (url) => new Worker(url, { type: 'module' }) : null,
  initTimeoutMs = 15000,
  scanTimeoutMs = 15000,
} = {}) {
  const native = makeStartDemoDepth(mj, m, d);
  if (!createWorker) return native;
  let worker, active = null, seq = 0, disposed = false, failed = false, failure = null;
  const fail = (error) => {
    failure = error;
    failed = true;
    worker?.terminate();
    if (active) { active.reject(error); active = null; }
  };
  const request = (packet, transfer) => new Promise((resolve, reject) => {
    active = { seq: ++seq, resolve, reject };
    try { worker.postMessage({ ...packet, seq }, transfer); }
    catch (error) { fail(error); }
  });
  let ready;
  try {
    worker = createWorker(new URL('./start-depth-worker.js', import.meta.url));
    worker.onerror = (event) => { event.preventDefault?.(); fail(new Error(event.message || 'Depth Worker failed')); };
    worker.onmessageerror = () => fail(new Error('Depth Worker message failed'));
    worker.onmessage = ({ data }) => {
      if (!active || data.seq !== active.seq) return;
      if (data.type === 'error') { fail(new Error(data.error)); return; }
      const current = active; active = null; current.resolve(data);
    };
    const path = '/start-depth-worker.mjb';
    let model;
    try { mj.mj_saveModel(m, path, null); model = mj.FS.readFile(path); }
    finally { try { mj.FS.unlink(path); } catch { /* no snapshot on old bindings */ } }
    const timer = setTimeout(() => fail(new Error('Depth Worker init timeout')), initTimeoutMs);
    ready = request({ type: 'init', model }, [model.buffer]).finally(() => clearTimeout(timer));
  } catch (error) { fail(error); ready = Promise.reject(error); }
  // Failure to create/load a module Worker keeps the existing main path.
  ready = ready.catch(() => {});
  const scan = async (q) => {
    const captured = Array.from(q.slice(0, 7)), pose = Float64Array.from(captured);
    await ready;
    if (disposed) throw new Error('Depth scanner disposed');
    if (failed) { const out = native(captured); scan.ms = native.ms; scan.roundtripMs = 0; return out; }
    const started = performance.now();
    const timer = setTimeout(() => fail(new Error('Depth Worker scan timeout')), scanTimeoutMs);
    try {
      const result = await request({ type: 'scan', pose }, [pose.buffer]);
      scan.ms = result.ms; scan.roundtripMs = performance.now() - started;
      return result.frame;
    } catch (error) {
      if (disposed) throw error;
      // The failed capture uses exactly its original pose, never an old frame.
      const out = native(captured); scan.ms = native.ms; scan.roundtripMs = performance.now() - started; return out;
    } finally { clearTimeout(timer); }
  };
  scan.async = true;
  Object.defineProperty(scan, 'workerError', { get: () => failure?.message ?? null });
  scan.ready = ready;
  scan.dispose = () => { disposed = true; fail(new Error('Depth scanner disposed')); native.dispose(); };
  return scan;
}
