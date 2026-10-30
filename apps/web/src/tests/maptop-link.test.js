// 시뮬 «실제 모습» 연결 대조(파일 읽기라 .js — 앱 tsconfig 에 node 타입 없음): mapframe SIM_TOP 의 sha256 = 서버가 등록하는 월드 그림(apps/simmgr/worlds), 사진 범위 = make-top.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SIM_TOP, topOf } from '../mapframe';

const repo = process.cwd() + '/../../', read = (p) => readFileSync(repo + p);
const sha = (b) => createHash('sha256').update(b).digest('hex');
const pngSize = (b) => [b.readUInt32BE(16), b.readUInt32BE(20)];
const worlds = JSON.parse(read('apps/simmgr/worlds/worlds.json').toString()).worlds;

describe('연결 대조', () => {
  it('SIM_TOP 의 sha256 = 서버가 등록하는 월드 그림, 사진의 지도 판(origin·해상도·크기)·사진 크기 = 그 그림·make-top 범위', () => {
    const found = new Map();
    for (const [key, w] of Object.entries(worlds)) {
      const dir = 'apps/simmgr/worlds/' + w.gt_map.replace(/[^/]+$/, ''), yaml = read('apps/simmgr/worlds/' + w.gt_map).toString();
      const png = read(dir + (yaml.match(/^image:\s*(\S+)/m)[1])), id = SIM_TOP.get(sha(png));
      if (!id) continue;
      found.set(key, id);
      const top = JSON.parse(read(`mobile/sim/assets/${id}/top.json`).toString());
      const floor = top.floors?.find((f) => f.image_sha256 === sha(png));
      if (key.startsWith('factory_zone/')) expect(floor?.id).toBe(key.split('/')[1]);
      const map = JSON.parse(read(`mobile/sim/assets/${id}/${floor ? floor.map_file : 'map.json'}`).toString());
      const plate = floor ? floor.map : top.map;
      expect(topOf({ provenance: 'SIMULATION', image_sha256: sha(png), origin: map.origin, resolution: map.res, width: map.w, height: map.h })?.href).toContain(`/mobile/sim/assets/${id}/${floor ? floor.top : 'top.png'}`);
      expect(plate).toEqual({ origin: map.origin, res: map.res, w: map.w, h: map.h });
      expect([map.w, map.h]).toEqual(pngSize(png));
      expect(JSON.parse(yaml.match(/^origin:\s*(.+)$/m)[1])).toEqual(map.origin);
      expect(+yaml.match(/^resolution:\s*(\S+)/m)[1]).toBe(map.res);
      const [x0, y0, x1, y1] = top.bounds;
      expect(pngSize(read(`mobile/sim/assets/${id}/${floor ? floor.top : 'top.png'}`))).toEqual([Math.round((x1 - x0) * 24), Math.round((y1 - y0) * 24)]);
    }
    expect(Object.fromEntries(found)).toEqual({ 'warehouse/f1': 'warehouse', 'factory_inspection/f1': 'factory-inspection', 'factory_inspection_alt1/f1': 'factory-inspection-alt1',
      'factory_zone/f1': 'factory-zone', 'factory_zone/f2': 'factory-zone', 'element_course/f1': 'element-course', 'collapsed_house_v2/f1': 'collapsed-house-v2' });

  });
  it('공장은 한 지도이며 층별 판·사진·시나리오를 보존한다', () => {
    const maps = JSON.parse(read('mobile/sim/maps.json').toString());
    expect(maps.filter((m) => m.id.startsWith('factory-zone'))).toEqual([{ id: 'factory-zone', name: '2층 공장 · 초안' }]);
    for (const old of ['factory-zone-f1', 'factory-zone-f2']) expect(existsSync(repo + `mobile/sim/assets/${old}`)).toBe(false);
    const dir = 'mobile/sim/assets/factory-zone/', top = JSON.parse(read(dir + 'top.json').toString());
    expect(top.floors.map((f) => [f.id, f.name, f.z, f.top])).toEqual([
      ['f1', '1층', [-1, 2], 'top-f1.png'], ['f2', '2층', [2, 8], 'top-f2.png']]);
    const defaults = JSON.parse(read(dir + 'scenarios.json').toString());
    expect(defaults).toEqual(JSON.parse(read(dir + 'scenarios-f1.json').toString()));
    expect(defaults.length).toBeGreaterThan(0);
    expect(defaults.every((s) => s.floor_id === 'f1')).toBe(true);
    for (const f of top.floors) {
      const map = JSON.parse(read(dir + f.map_file).toString()), scenarios = JSON.parse(read(dir + f.scenarios_file).toString());
      expect(map.floor_id).toBe(f.id); expect(map.floor_z).toBe(f.floor_z);
      expect(map.spawn_xyyaw).toEqual(f.spawn_xyyaw);
      expect(Buffer.from(map.px, 'base64').length).toBe(f.map.w * f.map.h);
      expect(scenarios.every((s) => s.floor_id === f.id)).toBe(true);
      expect(scenarios.length).toBeGreaterThan(0);
      if (f.id === 'f2') expect(scenarios.every((s) => !defaults.some((d) => d.id === s.id))).toBe(true);
      expect(pngSize(read(dir + f.top))).toEqual(top.px);
    }
    expect(pngSize(read(dir + 'top.png'))).toEqual(top.px);
    for (const { id } of maps.filter((m) => m.id !== 'factory-zone')) {
      expect(JSON.parse(read(`mobile/sim/assets/${id}/top.json`).toString()).floors).toBeUndefined();
    }
  });

});

