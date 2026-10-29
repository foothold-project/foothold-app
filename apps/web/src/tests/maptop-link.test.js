// 시뮬 «실제 모습» 연결 대조(파일 읽기라 .js — 앱 tsconfig 에 node 타입 없음): mapframe SIM_TOP 의 sha256 = 서버가 등록하는 월드 그림(apps/simmgr/worlds), 사진 범위 = make-top.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SIM_TOP } from '../mapframe';

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
      found.set(id, key);
      const top = JSON.parse(read(`mobile/sim/assets/${id}/top.json`).toString()), map = JSON.parse(read(`mobile/sim/assets/${id}/map.json`).toString());
      expect(top.map).toEqual({ origin: map.origin, res: map.res, w: map.w, h: map.h });
      expect([map.w, map.h]).toEqual(pngSize(png));
      expect(JSON.parse(yaml.match(/^origin:\s*(.+)$/m)[1])).toEqual(map.origin);
      expect(+yaml.match(/^resolution:\s*(\S+)/m)[1]).toBe(map.res);
      const [x0, y0, x1, y1] = top.bounds;
      expect(pngSize(read(`mobile/sim/assets/${id}/top.png`))).toEqual([Math.round((x1 - x0) * 24), Math.round((y1 - y0) * 24)]);
    }
    expect(Object.fromEntries(found)).toEqual({ warehouse: 'warehouse/f1', 'factory-inspection': 'factory_inspection/f1', 'factory-inspection-alt1': 'factory_inspection_alt1/f1',
      'factory-zone-f1': 'factory_zone/f1', 'factory-zone-f2': 'factory_zone/f2', 'element-course': 'element_course/f1', 'collapsed-house-v2': 'collapsed_house_v2/f1' });   // 표의 모든 sha 가 실제 월드 그림(낡은 줄 없음). rubble 은 사진 없음
  });
});

