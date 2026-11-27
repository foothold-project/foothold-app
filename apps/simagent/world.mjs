// 헤드리스 월드: mobile/sim 의 같은 MuJoCo wasm · Go2 · 정책 · 월드 자산을 Node 에서 화면 없이 연다.
// 브라우저 쪽 main.js (DOM · three · Worker) 는 쓰지 않고, 이미 Node 겸용인 sim.js 핵심만 부른다.
// 자산 묶는 법은 mobile/scripts/scenario-headless.mjs 와 같다 (FH_SIM_SRC = RS-6 시뮬 자산 폴더).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSim, loadPolicy, ISAAC_LIKE, POLICY_DT } from '../../mobile/sim/sim.js';
import { decodeMap } from '../../mobile/sim/lidar.js';

const SIM = new URL('../../mobile/sim/', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, SIM));
const FEET = ['FL', 'FR', 'RL', 'RR'];
let mujoco; // wasm 모듈은 한 번만 불러 같은 프로세스에서 여러 월드가 나눠 쓴다

// mulberry32: 씨앗 하나로 출발 자리 흔들기. 같은 씨앗 = 같은 출발 = 같은 궤적 (MuJoCo · f32 정책은 결정적)
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export async function loadWorld({ simSrc, mapId, seed = 0 }) {
  if (!simSrc) throw new Error('simSrc (FH_SIM_SRC) 필요');
  if (!/^[a-z0-9-]+$/.test(mapId) || !JSON.parse(read('maps.json')).some((m) => m.id === mapId)) throw new Error(`목록에 없는 지도: ${mapId}`);
  if (!mujoco) {
    const { default: load } = await import(pathToFileURL(join(simSrc, 'node_modules/@mujoco/mujoco/mujoco.js')));
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

  const buf = readFileSync(join(simSrc, 'policy_v2.f32'));
  const policy = loadPolicy(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const r = rng(seed), [sx, sy, syaw] = map.spawn_xyyaw;
  const spawn = [sx + (r() - 0.5) * 0.02, sy + (r() - 0.5) * 0.02, syaw + (r() - 0.5) * 0.04];
  const sim = createSim(mj, '/go2/scene.xml', ISAAC_LIKE, policy, { floorZ: map.floor_z, spawn });
  const feet = FEET.map((n) => mj.mj_name2id(sim.m, mj.mjtObj.mjOBJ_GEOM.value, n));

  return {
    mj, sim, map, spawn,
    /** 정책 주기(50 Hz)로 sec 초 진행. cmd = [vx, vy, wz] (몸통 좌표) */
    run(sec, cmd = [0, 0, 0]) {
      sim.cmd = cmd.slice();
      for (let k = 0, n = Math.round(sec / POLICY_DT); k < n; k++) sim.step();
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
