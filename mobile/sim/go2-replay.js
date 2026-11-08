// Display-only SDK replay. This module has no command transport or physics step.
export const GO2_JOINTS = ['FR', 'FL', 'RR', 'RL'].flatMap((leg) => ['hip', 'thigh', 'calf'].map((part) => `${leg}_${part}_joint`));
const defaults = GO2_JOINTS.map((name) => name.includes('hip') ? .1 * (name[1] === 'R' ? -1 : 1) : name.includes('thigh') ? (name.startsWith('F') ? .8 : 1) : -1.5);
export const go2ReplayMode = {
  id: 'go2-demo', label: 'Go2 실기 보기', onnx: null, fallback: null, depth: null,
  observe: () => [], map: () => null, act: (_a, out = new Float64Array(12)) => { out.set(defaults); return out; }, torque: () => 0,
  action: { joints: GO2_JOINTS, defaultPose: defaults },
  command: { kind: 'none', caps: { forward: 0, reverse: 0, lateral: 0, turnInPlace: 0, turnWalking: 0 }, inRange: (c) => c.every((v) => v === 0) },
  timing: { physicsDt: .005, decimation: 4, policyDt: .02 }, delay: 0, stop: { input: [0, 0, 0], pause: true }, reset: () => {},
};
export function replayRequirement(url) {
  return ['http:', 'https:'].includes(url.protocol) && url.searchParams.get('from') === 'web' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(url.searchParams.get('robot') ?? '')
    ? '' : '웹에서 로봇을 골라 열어야 함';
}
export function createReplaySim(mj, path, world) {
  const m = mj.MjModel.from_xml_path(path), d = new mj.MjData(m);
  const addresses = new Map(GO2_JOINTS.map((name) => {
    const id = mj.mj_name2id(m, mj.mjtObj.mjOBJ_JOINT.value, name);
    if (id < 0) throw new Error(`관절 없음: ${name}`);
    return [name, m.jnt_qposadr[id]];
  }));
  const sim = { m, d, adapterId: 'go2-demo', cmd: [0, 0, 0], t: 0, linB: [0, 0, 0], angB: [0, 0, 0],
    policyMs: 0, physMs: 0, step: () => false, physStep: () => false, hold: () => {}, cancelPolicyStep: () => {}, clearPolicyState: () => {} };
  sim.reset = () => {
    mj.mj_resetData(m, d);
    const [x, y, yaw] = world.spawn;
    d.qpos.set([x, y, world.floorZ + .4, Math.cos(yaw / 2), 0, 0, Math.sin(yaw / 2)]);
    GO2_JOINTS.forEach((name, i) => { d.qpos[addresses.get(name)] = defaults[i]; });
    mj.mj_forward(m, d);
  };
  sim.applyReplay = (joints, quaternion, position) => {
    joints.names.forEach((name, i) => { d.qpos[addresses.get(name)] = joints.positions[i]; });
    d.qpos.set(quaternion.wxyz, 3);
    if (position) d.qpos.set(position.xyz, 0); // Raw Sport origin: no map alignment or correction.
    d.qvel.fill(0); d.ctrl.fill(0);
    mj.mj_forward(m, d);
  };
  sim.dispose = () => { d.delete(); m.delete(); };
  sim.reset();
  return sim;
}
const finiteVector = (a, n) => Array.isArray(a) && a.length === n && a.every(Number.isFinite);
export function createReplayReader(sim, url, { fetcher = globalThis.fetch, now = () => performance.now() } = {}) {
  const requirement = replayRequirement(url);
  const started = now();
  let lastFresh = null, stamp = null, pending = false, error = '';
  const fresh = (value, latency) => Number.isFinite(value?.age_s) && value.age_s >= 0 && value.age_s + latency <= 1 && Number.isFinite(Date.parse(value.received_at));
  return {
    async poll() {
      if (requirement || pending) return;
      pending = true;
      const requested = now();
      const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 1500);
      try {
        const response = await fetcher(`/api/v1/robots/${encodeURIComponent(url.searchParams.get('robot'))}`, { method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: abort.signal });
        if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? '로봇 상태 조회 권한 확인 필요' : `로봇 상태 조회 실패 (${response.status})`);
        const robot = await response.json(), { joints, quaternion, position } = robot.robot_info ?? {};
        const latency = Math.max(0, now() - requested) / 1000;
        if (robot.simulation !== false) throw new Error('실기 로봇을 골라야 함');
        if (!joints || !finiteVector(joints.positions, 12) || !Array.isArray(joints.names) || joints.names.length !== 12 ||
            new Set(joints.names).size !== 12 || !joints.names.every((n) => GO2_JOINTS.includes(n)) ||
            !quaternion || !finiteVector(quaternion.wxyz, 4) || Math.abs(Math.hypot(...quaternion.wxyz) - 1) > .1 || !fresh(joints, latency) || !fresh(quaternion, latency) ||
            position?.origin !== 'BOOT_ORIGIN_UNVERIFIED' || !finiteVector(position.xyz, 3) || !fresh(position, latency)) return;
        const next = `${joints.received_at}|${quaternion.received_at}|${position.received_at}`;
        if (next === stamp) return; // Repeated HTTP success is not a new sensor sample.
        const norm = Math.hypot(...quaternion.wxyz);
        sim.applyReplay(joints, { ...quaternion, wxyz: quaternion.wxyz.map((v) => v / norm) }, position);
        stamp = next; lastFresh = now() - 1000 * (Math.max(joints.age_s, quaternion.age_s, position.age_s) + latency); error = '';
      } catch (e) { error = e.name === 'AbortError' ? '로봇 상태 조회 시간 초과' : e.message; }
      finally { clearTimeout(timer); pending = false; }
    },
    status() {
      if (requirement) return requirement;
      const age = (now() - (lastFresh ?? started)) / 1000;
      const state = lastFresh === null && age <= 1 ? '상태 기다리는 중' : age > 1 ? `상태 끊김 ${Math.floor(age)}초` : '상태 수신 중';
      return `실기 보기 전용 · ${state}${error ? ' · ' + error : ''} · 위치 원점: 기동 시점 기준·미확인`;
    },
  };
}
