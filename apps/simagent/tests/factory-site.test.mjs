// 공장 터 (factory-site) 앱 시뮬 자산: 지도 목록 · 격자 · 시작 칸. FH_SIM_SRC · 정책이 있으면 m15500 으로 열어 서 본다.
// FH_SIM_SRC=<시뮬 자산> FH_SIM_ORT_NODE=<onnxruntime-node 입구> FH_SIM_POLICY_DIR=<m15500 폴더> node --test apps/simagent/tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cell, decodeMap } from '../../../mobile/sim/lidar.js';
import { loadWorld } from '../world.mjs';

const SIM = new URL('../../../mobile/sim/', import.meta.url);
const read = (rel) => JSON.parse(readFileSync(new URL(rel, SIM)));
const { FH_SIM_SRC: simSrc, FH_SIM_ORT_NODE: ortNode, FH_SIM_POLICY_DIR: policyDir } = process.env;
const skip = simSrc && ortNode && policyDir ? false : 'FH_SIM_SRC · FH_SIM_ORT_NODE · FH_SIM_POLICY_DIR 없음';

test('factory-site 는 지도 목록에 한 번 · 격자 0.5 m 1800 x 1120 · 시작 칸 비어 있음', () => {
  assert.equal(read('maps.json').filter((m) => m.id === 'factory-site').length, 1);
  const map = decodeMap(read('assets/factory-site/map.json'));
  assert.deepEqual([map.res, map.w, map.h, map.origin], [0.5, 1800, 1120, [0, -560, 0]]);
  assert.equal(map.px.length, 1800 * 1120);
  const [x, y] = map.spawn_xyyaw;
  assert.equal(cell(map, x, y), 254);
  assert.equal(cell(map, 366, -240), 0); // 제어실 안
  assert.equal(cell(map, 450, -284.5), 254); // 주 동서 도로
  assert.equal(cell(map, -1, -1), 205); // 지도 밖
});

test('m15500 으로 공장 터를 열고 2 초 뒤 서 있음', { skip }, async () => {
  const w = await loadWorld({ simSrc, mapId: 'factory-site', seed: 1, policyDir, ortNode, startMap: 'off' });
  try {
    assert.ok(w.sim.m.ngeom > 1000, `geom ${w.sim.m.ngeom}`);
    await w.run(2.0, [0, 0, 0]);
    const h = w.baseHeight();
    assert.ok(h > 0.25 && h < 0.45, `몸통 높이 ${h.toFixed(3)} m`);
    assert.ok(w.upright() > 0.9, `곧추섬 ${w.upright()}`);
  } finally { w.dispose(); }
});
