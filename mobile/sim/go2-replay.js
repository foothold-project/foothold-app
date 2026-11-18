// Display-only SDK replay. This module has no command transport or physics step.
// 받는 길: 실시간 연결(/api/v1/ws 구독, 서버가 0.1 s 마다 state) — 안 되면 0.2 s GET 으로 돌아감. 둘 다 같은 robot_info 를 같은 검사로 받는다.
// 위치: 로봇이 보내는 값은 «켤 때 기준»(BOOT_ORIGIN_UNVERIFIED)이라 지도와 무관 — 맞추기 전에는 시작 자리에 관절·자세만, 사람이 «지금 여기»를 맞추면 그 뒤 이동량만 더한다.
export const GO2_JOINTS = ['FR', 'FL', 'RR', 'RL'].flatMap((leg) => ['hip', 'thigh', 'calf'].map((part) => `${leg}_${part}_joint`));
const defaults = GO2_JOINTS.map((name) => name.includes('hip') ? .1 * (name[1] === 'R' ? -1 : 1) : name.includes('thigh') ? (name.startsWith('F') ? .8 : 1) : -1.5);
export const go2ReplayMode = {
  id: 'go2-demo', label: 'Go2 실기 보기', onnx: null, fallback: null, depth: null,
  observe: () => [], map: () => null, act: (_a, out = new Float64Array(12)) => { out.set(defaults); return out; }, torque: () => 0,
  action: { joints: GO2_JOINTS, defaultPose: defaults },
  command: { kind: 'none', caps: { forward: 0, reverse: 0, lateral: 0, turnInPlace: 0, turnWalking: 0 }, inRange: (c) => c.every((v) => v === 0) },
  timing: { physicsDt: .005, decimation: 4, policyDt: .02 }, delay: 0, stop: { input: [0, 0, 0], pause: true }, reset: () => {},
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function replayRequirement(url) {
  return ['http:', 'https:'].includes(url.protocol) && url.searchParams.get('from') === 'web' && UUID.test(url.searchParams.get('robot') ?? '')
    ? '' : '웹에서 로봇을 골라 열어야 함';
}
export function createReplaySim(mj, path, world) {
  const m = mj.MjModel.from_xml_path(path), d = new mj.MjData(m);
  const addresses = GO2_JOINTS.map((name) => {
    const id = mj.mj_name2id(m, mj.mjtObj.mjOBJ_JOINT.value, name);
    if (id < 0) throw new Error(`관절 없음: ${name}`);
    return m.jnt_qposadr[id];
  });
  const sim = { m, d, world, adapterId: 'go2-demo', cmd: [0, 0, 0], t: 0, linB: [0, 0, 0], angB: [0, 0, 0],
    policyMs: 0, physMs: 0, step: () => false, physStep: () => false, hold: () => {}, cancelPolicyStep: () => {}, clearPolicyState: () => {} };
  sim.reset = () => {
    mj.mj_resetData(m, d);
    const [x, y, yaw] = world.spawn;
    d.qpos.set([x, y, world.floorZ + .4, Math.cos(yaw / 2), 0, 0, Math.sin(yaw / 2)]);
    addresses.forEach((a, i) => { d.qpos[a] = defaults[i]; });
    mj.mj_forward(m, d);
  };
  /** q = GO2_JOINTS 순서 12개, wxyz·xyz = 이미 시뮬 세계로 옮긴 몸 자세·위치 */
  sim.applyReplay = (q, wxyz, xyz) => {
    addresses.forEach((a, i) => { d.qpos[a] = q[i]; });
    d.qpos.set(xyz, 0); d.qpos.set(wxyz, 3);
    d.qvel.fill(0); d.ctrl.fill(0);
    mj.mj_forward(m, d);
  };
  sim.dispose = () => { d.delete(); m.delete(); };
  sim.reset();
  return sim;
}

const finiteVector = (a, n) => Array.isArray(a) && a.length === n && a.every(Number.isFinite);
const fresh = (v) => Number.isFinite(v?.age_s) && v.age_s >= 0 && Number.isFinite(Date.parse(v.received_at));
/** robot_info → 표본 { seq, born, clock, age, q, wxyz, xyz } — 모양이 틀리거나 위치 출처가 다르면 null(그 표본만 버림).
 *  seq = 세 값의 받은 시각 중 가장 늦은 것(ms): 이보다 작거나 같은 표본 = 역순·중복. born = 가장 이른 받은 시각,
 *  clock = 서버가 보낼 때의 로봇 시계(받은 시각 + 나이, 셋 중 작은 것). 받은 시각은 로봇 쪽 시계라 브라우저 시계와 바로 비교하지 않는다 */
export function sampleOf(info, latency = 0) {
  const { joints, quaternion, position } = info ?? {};
  if (!joints || !finiteVector(joints.positions, 12) || !Array.isArray(joints.names) || joints.names.length !== 12 ||
      new Set(joints.names).size !== 12 || !joints.names.every((n) => GO2_JOINTS.includes(n)) || !fresh(joints) ||
      !quaternion || !finiteVector(quaternion.wxyz, 4) || Math.abs(Math.hypot(...quaternion.wxyz) - 1) > .1 || !fresh(quaternion) ||
      position?.origin !== 'BOOT_ORIGIN_UNVERIFIED' || !finiteVector(position.xyz, 3) || !fresh(position)) return null;
  const norm = Math.hypot(...quaternion.wxyz), parts = [joints, quaternion, position], at = parts.map((v) => Date.parse(v.received_at));
  return { seq: Math.max(...at), born: Math.min(...at), clock: Math.min(...parts.map((v, i) => at[i] + 1000 * v.age_s)),
    age: Math.max(joints.age_s, quaternion.age_s, position.age_s) + latency,
    q: GO2_JOINTS.map((n) => joints.positions[joints.names.indexOf(n)]), wxyz: quaternion.wxyz.map((v) => v / norm), xyz: position.xyz.slice() };
}

export const yawOf = ([w, x, y, z]) => Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
const stand = (z) => Math.min(.6, Math.max(.1, z));   // 켤 때 기준 높이 = 몸 높이로 본다(이상한 값은 0.1~0.6 m 로 자름)
/** 켤 때 기준 표본 → 시뮬 세계. align 없음 = 위치 미정: 시작 자리에 관절·자세만(지도 위 실제 위치처럼 옮기지 않음).
 *  align = { raw: 맞출 때 표본 [x, y, z, yaw], x, y, yaw, floor } → 맞춘 자리 + 그 뒤 이동량(돌려서). 높이는 맞출 때 한 번 정하고 매 프레임 바닥에 끌어맞추지 않는다 */
export function placeSample(s, world, align) {
  if (!align) return { xyz: [world.spawn[0], world.spawn[1], world.floorZ + stand(s.xyz[2])], wxyz: s.wxyz };
  const [x0, y0, z0, yaw0] = align.raw, turn = align.yaw - yaw0, c = Math.cos(turn), sn = Math.sin(turn);
  const dx = s.xyz[0] - x0, dy = s.xyz[1] - y0, hw = Math.cos(turn / 2), hz = Math.sin(turn / 2), [w, x, y, z] = s.wxyz;
  return { xyz: [align.x + c * dx - sn * dy, align.y + sn * dx + c * dy, align.floor + stand(z0) + s.xyz[2] - z0],
    wxyz: [hw * w - hz * z, hw * x - hz * y, hw * y + hz * x, hw * z + hz * w] };
}
/** 맞춤 저장본(이 브라우저에만, 로봇+지도별) — 깨졌으면 null */
export function readAlign(storage, key) {
  try {
    const a = JSON.parse(storage.getItem(key) ?? 'null');
    return a && finiteVector(a.raw, 4) && [a.x, a.y, a.yaw, a.floor].every(Number.isFinite) && typeof a.at === 'string' ? a : null;
  } catch { return null; }
}

const lerp = (a, b, k) => a + (b - a) * k;
/** 두 표본 사이(k = 0~1). 자세는 짧은 쪽으로 nlerp */
function between(a, b, k) {
  const sign = a.wxyz.reduce((s, v, i) => s + v * b.wxyz[i], 0) < 0 ? -1 : 1, w = a.wxyz.map((v, i) => lerp(v, sign * b.wxyz[i], k)), n = Math.hypot(...w);
  return { q: a.q.map((v, i) => lerp(v, b.q[i], k)), wxyz: w.map((v) => v / n), xyz: a.xyz.map((v, i) => lerp(v, b.xyz[i], k)) };
}
const MAX_DELAY_MS = 250;   // 보간 지연 상한 — 받는 간격(실시간 0.1 s·GET 0.2 s)만큼만 늦게 그린다
const clockText = (ms) => { const d = new Date(ms); return [d.getHours(), d.getMinutes(), d.getSeconds()].map((v) => String(v).padStart(2, '0')).join(':'); };

export function createReplayReader(sim, url, { fetcher = globalThis.fetch, now = () => performance.now(), wall = () => Date.now(), WebSocket: WS = globalThis.WebSocket } = {}) {
  const requirement = replayRequirement(url), rid = url.searchParams.get('robot');
  const started = now();
  let buf = [], lastSeq = -Infinity, gap = 0, lastFresh = null, lastWall = null, pending = false, error = '', align = null, drawn = null;
  let verified = false, ws = null, wsUp = false, wsAt = -Infinity, wsRetryAt = -Infinity, pingAt = -Infinity, n = 0;
  // 로봇 시계 − 브라우저 now() 의 상한(ms). 마지막 GET 으로만 잰다: 서버가 보낸 때 ≥ 요청 시작이라 이 값으로 잰 나이는 실제보다 작지 않다.
  // 없으면(아직 GET 표본 없음) 실시간 표본은 신선하다고 보지 않는다. ponytail: 실시간만 오래 받는 동안 로봇 시계가 앞으로 뛰면 그만큼 젊게 보임(서버 나이 아래로는 안 내려감) — 문제면 실시간 중에도 가끔 GET 으로 다시 잰다
  let skew = null;
  /** 새 표본 하나 — 역순·중복·옛 값(1 초 넘음)은 버린다. t = 받은 시각(이어 그리기), lastFresh = 받은 시각 − 나이(신선도).
   *  latency = GET 왕복(s). null = 실시간: 나이 = 서버 나이와 «지금 − 가장 이른 받은 시각(브라우저 시계로 옮김)» 중 큰 것 */
  const push = (info, latency) => {
    const s = sampleOf(info, latency ?? 0), at = now();
    if (s && latency === null) s.age = skew === null ? Infinity : Math.max(s.age, (at + skew - s.born) / 1000);
    if (!s || s.seq <= lastSeq || s.age > 1) return false;
    s.t = Math.max(at, (buf.at(-1)?.t ?? -Infinity) + 1);
    if (buf.length && s.t - buf.at(-1).t > 1000) buf = [];   // 끊겼다 다시 받음 — 옛 표본과 잇지 않는다
    if (buf.length) gap = gap ? gap * .8 + (s.t - buf.at(-1).t) * .2 : s.t - buf.at(-1).t;
    buf = [...buf.slice(-2), s]; lastSeq = s.seq; lastFresh = at - 1000 * s.age; lastWall = wall() - 1000 * s.age; error = '';
    return true;
  };
  const closeWs = () => { const s = ws; ws = null; wsUp = false; if (s) { s.onopen = s.onmessage = s.onclose = s.onerror = null; s.close(); } };
  const send = (body) => ws?.readyState === 1 && ws.send(JSON.stringify({ ...body, id: String(++n), proto: 'fh-rt/1' }));
  const openWs = () => {
    if (!WS) return;
    let s;
    try { s = new WS(`${url.protocol === 'https:' ? 'wss' : 'ws'}://${url.host}/api/v1/ws`); } catch { wsRetryAt = now() + 5000; return; }
    ws = s;
    s.onopen = () => send({ t: 'sub', robots: [rid], streams: ['state'] });
    s.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m?.t === 'reply' && m.ok === false && m.error?.code !== 'NETWORK') { closeWs(); wsRetryAt = now() + 10000; return; }   // 구독 거절 → GET 으로(10 s 뒤 다시)
      if (m?.t === 'subscription.revoked' && m.robot === rid) { closeWs(); wsRetryAt = now() + 10000; return; }
      if (m?.t !== 'state' || m.robot !== rid) return;
      wsUp = true;
      if (push(m.robot_info, null)) wsAt = now();   // 늙은·빈 표본은 «실시간 받는 중»으로 치지 않는다 — GET 대체가 계속 돈다
    };
    s.onclose = () => { if (ws === s) { ws = null; wsUp = false; wsRetryAt = now() + 3000; } };
  };
  return {
    /** 0.2 s 마다(보이는 동안): 처음엔 GET 으로 실기인지 확인, 그 뒤 실시간 연결을 열고 — 실시간이 1 s 넘게 조용하면 GET 으로 받는다 */
    async poll() {
      if (requirement) return;
      const t = now();
      if (verified && !ws && t >= wsRetryAt) openWs();
      if (wsUp && t - pingAt >= 1000) { pingAt = t; send({ t: 'ping' }); }
      if ((wsUp && t - wsAt < 1000) || pending) return;
      pending = true;
      const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 1500);
      try {
        const response = await fetcher(`/api/v1/robots/${encodeURIComponent(rid)}`, { method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: abort.signal });
        if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? '로봇 상태 조회 권한 확인 필요' : `로봇 상태 조회 실패 (${response.status})`);
        const robot = await response.json();
        if (robot.simulation !== false) { verified = false; closeWs(); throw new Error('실기 로봇을 골라야 함'); }
        verified = true;
        const s = sampleOf(robot.robot_info);
        if (s) skew = s.clock - t;
        push(robot.robot_info, Math.max(0, now() - t) / 1000);
      } catch (e) { error = e.name === 'AbortError' ? '로봇 상태 조회 시간 초과' : e.message; }
      finally { clearTimeout(timer); pending = false; }
    },
    /** 그리는 프레임마다: 받는 간격만큼 늦은 시각을 두 표본 사이로 이어 그린다(앞질러 짐작하지 않음). 새 표본이 없으면 마지막 자세 그대로(동결) */
    frame() {
      if (!buf.length) return false;
      const at = now() - Math.min(MAX_DELAY_MS, gap), b = buf.findIndex((s) => s.t >= at);
      const pose = b < 0 ? buf.at(-1) : b === 0 ? buf[0] : between(buf[b - 1], buf[b], (at - buf[b - 1].t) / (buf[b].t - buf[b - 1].t));
      const placed = placeSample(pose, sim.world, align), key = [...pose.q, ...placed.wxyz, ...placed.xyz].join();
      if (key === drawn) return false;
      sim.applyReplay(pose.q, placed.wxyz, placed.xyz); drawn = key;
      return true;
    },
    /** 맞출 때 쓰는 지금 표본(켤 때 기준) [x, y, z, yaw] — 받은 것이 없으면 null */
    raw() { const s = buf.at(-1); return s ? [...s.xyz, yawOf(s.wxyz)] : null; },
    setAlign(a) { align = a; drawn = null; },
    get live() { return wsUp && now() - wsAt < 1000; },
    status() {
      if (requirement) return requirement;
      const age = (now() - (lastFresh ?? started)) / 1000;
      const last = lastWall === null ? '아직 받은 상태 없음' : `마지막 수신 ${clockText(lastWall)}(${age < 10 ? age.toFixed(1) : Math.floor(age)}초 전)`;
      const state = lastFresh === null && age <= 1 ? '상태 기다리는 중' : age > 1 ? `상태 끊김 · 마지막 자세로 멈춤 · ${last}` : `상태 수신 중 · ${last}`;
      const path = this.live ? '실시간 연결' : '실시간 연결 안 됨 — 0.2초마다 확인';
      return `실기 보기(조종 안 됨) · ${state} · ${path}${error ? ' · ' + error : ''}`;
    },
    close: closeWs,
  };
}
