// FH_SIM_SRC=<RS-6 시뮬 자산 폴더> node --test apps/simagent/tests/
// 화면 · 브라우저 · 서버 · 실기 없음. 저장소 지도 collapsed-house-v2 를 Node 에서 MuJoCo wasm 으로 연다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWorld } from '../world.mjs';

const simSrc = process.env.FH_SIM_SRC;
const MAP = 'collapsed-house-v2';
const skip = simSrc ? false : 'FH_SIM_SRC 없음 (MuJoCo wasm · policy_v2.f32 · go2 자산)';

test('Node 에서 장면 컴파일', { skip }, async () => {
  const w = await loadWorld({ simSrc, mapId: MAP, seed: 1 });
  try {
    assert.equal(w.sim.m.nu, 12);
    assert.ok(w.sim.m.ngeom > 100, `geom ${w.sim.m.ngeom}`);
  } finally { w.dispose(); }
});

test('1 초 뒤 몸통 높이가 서 있는 범위', { skip }, async () => {
  const w = await loadWorld({ simSrc, mapId: MAP, seed: 1 });
  try {
    await w.run(1.0, [0, 0, 0]);
    const h = w.baseHeight();
    assert.ok(h > 0.25 && h < 0.45, `몸통 높이 ${h.toFixed(3)} m`);
    assert.ok(w.upright() > 0.9, `곧추섬 ${w.upright()}`);
    assert.ok(Math.abs(w.sim.t - 1.0) < 1e-9, `시뮬 시각 ${w.sim.t}`);
  } finally { w.dispose(); }
});

test('같은 씨앗은 같은 결과 · 다른 씨앗은 다른 결과', { skip }, async () => {
  const pose = async (seed) => {
    const w = await loadWorld({ simSrc, mapId: MAP, seed });
    try { await w.run(1.0, [0.5, 0, 0]); return Array.from(w.sim.d.qpos); } finally { w.dispose(); }
  };
  const a = await pose(7), b = await pose(7), c = await pose(8);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
});
