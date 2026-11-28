// 헤드리스 월드: mobile/sim 의 같은 MuJoCo wasm · Go2 · 정책 · 월드 자산을 Node 에서 화면 없이 연다.
// 브라우저 쪽 main.js (DOM · three · Worker) 는 쓰지 않고, 이미 Node 겸용인 sim.js 핵심만 부른다.
// 자산 묶는 법은 mobile/scripts/scenario-headless.mjs 와 같다 (FH_SIM_SRC = RS-6 시뮬 자산 폴더).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSim, ISAAC_LIKE } from '../../mobile/sim/sim.js';
import { decodeMap } from '../../mobile/sim/lidar.js';
import { POLICY_MODES } from '../../mobile/sim/policy-modes.js';
import { loadOnnxPolicy, withPolicyState } from '../../mobile/sim/policy-onnx.js';

// 결과 서버 시뮬은 실기와 같은 START m15500 만 쓴다 (팀장 11/28 11:50). policy_v2 (nvidia-demo) 는 쓰지 않는다.
// 입력 · 출력 계약은 m13000 과 같다 (contract.json 대조): start-demo-adapter.js 의 관측 조립을 그대로 쓰고 파일만 바꾼다.
export const START_M15500 = {
  off: { file: 'start-m15500_map_off.onnx', sha256: 'be6c8b103d3b39503447ee71076ec199e5ed0688c3540ccfe449a96d6e2a9a41' },
  reconstruction: { file: 'start-m15500_map_on.onnx', sha256: 'df91c2d772c7d054e33c74fca479e79550cfd228d7682402f7eef4a0865e279f' },
};
let ort; // onnxruntime-node 는 한 번만

// MuJoCo wasm 입구. 개발 묶음 (mobile 과 같은 npm 배치) 과 배포 묶음 FH_SIM_ASSETS (deploy/prepare_sim.py: mujoco/) 둘 다.
export function mujocoEntry(simSrc) {
  const candidates = [join(simSrc, 'node_modules/@mujoco/mujoco/mujoco.js'), join(simSrc, 'mujoco/mujoco.js')];
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error(`MuJoCo wasm 을 찾지 못함: ${candidates.join(' · ')}`);
  return found;
}

const SIM = new URL('../../mobile/sim/', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, SIM));
const FEET = ['FL', 'FR', 'RL', 'RR'];
let mujoco; // wasm 모듈은 한 번만 불러 같은 프로세스에서 여러 월드가 나눠 쓴다

// mulberry32: 씨앗 하나로 출발 자리 흔들기. 같은 씨앗 = 같은 출발 = 같은 궤적 (MuJoCo · f32 정책은 결정적)
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export async function loadWorld({ simSrc, mapId, seed = 0, policyDir = process.env.FH_SIM_POLICY_DIR ?? simSrc,
  startMap = process.env.FH_SIM_START_MAP ?? 'off', ortNode = process.env.FH_SIM_ORT_NODE, spawnXyYaw = null }) {
  if (!simSrc) throw new Error('simSrc (FH_SIM_SRC) 필요');
  const pick = START_M15500[startMap];
  if (!pick) throw new Error(`FH_SIM_START_MAP 은 off · reconstruction 중 하나: ${startMap}`);
  if (!ortNode) throw new Error('FH_SIM_ORT_NODE (onnxruntime-node 입구 파일) 필요');
  if (!/^[a-z0-9-]+$/.test(mapId) || !JSON.parse(read('maps.json')).some((m) => m.id === mapId)) throw new Error(`목록에 없는 지도: ${mapId}`);
  if (!mujoco) {
    const { default: load } = await import(pathToFileURL(mujocoEntry(simSrc)));
    mujoco = await load();
    mujoco.FS.mkdir('/go2'); mujoco.FS.mkdir('/go2/assets');
    const meshes = join(simSrc, 'assets/unitree_go2/assets');
    for (const f of readdirSync(meshes)) if (f.endsWith('.obj')) mujoco.FS.writeFile(`/go2/assets/${f}`, readFileSync(join(meshes, f)));
    mujoco.FS.writeFile('/go2/go2.xml', readFileSync(join(simSrc, 'assets/unitree_go2/go2.xml')));
  }
  const mj = mujoco;
  const map = decodeMap(JSON.parse(read(`assets/${mapId}/map.json`)));
  for (const f of map.physics_assets ?? []) { const b = read(`assets/${mapId}/${f}`); mj.FS.writeFile(`/go2/${f}`, b); mj.FS.writeFile(`/go2/assets/${f}`, b); }
  mj.FS.writeFile('/go2/world.xml', read(`assets/${mapId}/${mapId}.xml`));
  mj.FS.writeFile('/go2/scene.xml', '<mujoco><include file="go2.xml"/><include file="world.xml"/></mujoco>');

  const model = readFileSync(join(policyDir, pick.file));
  const sha = createHash('sha256').update(model).digest('hex');
  if (sha !== pick.sha256) throw new Error(`정책 파일 sha256 이 m15500 이 아님: ${pick.file} ${sha.slice(0, 8)}`);
  ort ??= await import(pathToFileURL(resolve(ortNode)));
  const adapter = POLICY_MODES.start, contract = { ...adapter.onnx, file: pick.file };
  const policy = withPolicyState(await loadOnnxPolicy(ort, model, contract, 'cpu'), contract);
  const r = rng(seed), [sx, sy, syaw] = spawnXyYaw ?? map.spawn_xyyaw;
  const spawn = [sx + (r() - 0.5) * 0.02, sy + (r() - 0.5) * 0.02, syaw + (r() - 0.5) * 0.04];
  const sim = createSim(mj, '/go2/scene.xml', ISAAC_LIKE, policy, { floorZ: map.floor_z, spawn }, adapter.id, { startMapMode: startMap });
  const feet = FEET.map((n) => mj.mj_name2id(sim.m, mj.mjtObj.mjOBJ_GEOM.value, n));

  return {
    mj, sim, map, spawn, policy: { model: 'start-m15500', file: pick.file, sha256: sha, startMap },
    /** 정책 주기(50 Hz)로 sec 초 진행. cmd = [vx, vy, wz] (몸통 좌표). ONNX 라 step 은 비동기 */
    async run(sec, cmd = [0, 0, 0]) {
      sim.cmd = cmd.slice();
      for (let k = 0, n = Math.round(sec / adapter.timing.policyDt); k < n; k++) await sim.step();
    },
    /** 몸통 높이 = 몸통 z − 네 발 중심 z 평균 (지형 높이와 무관) */
    baseHeight() {
      const g = sim.d.geom_xpos;
      return sim.d.qpos[2] - feet.reduce((acc, i) => acc + g[i * 3 + 2], 0) / feet.length;
    },
    /** 몸통 위 방향과 월드 위 방향의 내적 (1 = 곧추섬) */
    upright() { return -sim.grav[2]; },
    dispose() { sim.dispose(); },
  };
}
