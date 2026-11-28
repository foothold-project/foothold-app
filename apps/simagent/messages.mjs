// fh-agent/2 에이전트 → 서버 메시지 (정본: apps/contracts/models.py AgentHello · AgentState).
// 실기 에이전트의 상태 기계 (apps/agent/foothold_agent/link/session.py) 는 아직 옮기지 않았다.
// 여기서는 잠김(latched) 상태의 hello · state 모양만 만든다. lease · cmd · stop 처리는 다음 단계.
export const PROTO = 'fh-agent/2';

export function helloMessage({ agentVersion, stopGen = 0, latched = true, mapVersions = [], lastFloorId = null }) {
  return {
    t: 'hello', proto: PROTO, agent_version: agentVersion, robot_model: 'unitree_go2', firmware: null,
    devices: [], map_versions: mapVersions, last_floor_id: lastFloorId,
    latched, stop_gen: stopGen, lease_id: null, run: null,
  };
}

export function yawOf(q) {
  const [w, x, y, z] = [q[3], q[4], q[5], q[6]];
  return Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
}

/** sim = mobile/sim/sim.js createSim 결과. 잠겨 있으면 적용 명령은 0 */
export function stateMessage(sim, { latched = true, stopGen = 0, stopRef = 0, floorId = null, mode = 'SIM_MUJOCO' } = {}) {
  const q = sim.d.qpos;
  return {
    t: 'state',
    pose: { floor_id: floorId, x: q[0], y: q[1], yaw: yawOf(q), confidence: 1 },
    speed: Math.hypot(sim.linB[0], sim.linB[1]),
    battery: { soc: null },
    latched, stop_gen: stopGen, stop_ref: stopRef,
    applied: latched ? [0, 0, 0] : sim.cmd.slice(0, 3),
    mode,
  };
}
