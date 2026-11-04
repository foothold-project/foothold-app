import load from './mujoco/mujoco.js';
import { makeStartDemoDepth } from './start-demo-sensors.js';

let scan;
self.onmessage = async ({ data: { type, seq, model, pose } }) => {
  try {
    if (type === 'init') {
      const mj = await load();
      mj.FS.writeFile('/scene.mjb', model);
      const vfs = new mj.MjVFS();
      let m;
      try { m = mj.MjModel.from_binary_path('/scene.mjb', vfs); }
      finally { vfs.delete(); mj.FS.unlink('/scene.mjb'); }
      const d = new mj.MjData(m);
      mj.mj_forward(m, d);
      scan = makeStartDemoDepth(mj, m, d);
      self.postMessage({ type: 'ready', seq });
    } else if (type === 'scan') {
      // The scanner owns a reusable output; transfer a copy, not its storage.
      const frame = scan(pose).slice();
      self.postMessage({ type: 'result', seq, frame, ms: scan.ms }, [frame.buffer]);
    }
  } catch (error) { self.postMessage({ type: 'error', seq, error: error.message }); }
};
