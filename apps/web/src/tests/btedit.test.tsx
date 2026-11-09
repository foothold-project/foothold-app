// 시나리오 → 시뮬 나무(btedit.tsx, SIM-REAL-SPLIT 11-09): scenarioTree 가 validateTree 통과·시뮬이 못 하는 일은 이유, simAt 좌표 같은 층만, 옛 «임무 편집» 저장본은 수만
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { MapFloor, MapVersion, Mission, ScenarioWrite } from '../../../contracts/ts';
import { SimPick, TERRAIN_REASON, simAt } from '../simstart';
import { check, oldMissions, scenarioTree, simId, treePoints, type Tree } from '../screens/btedit';
import FI from '../../../../mobile/sim/assets/factory-inspection/top.json';
import FZ from '../../../../mobile/sim/assets/factory-zone/top.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null, box: HTMLDivElement | undefined;
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); localStorage.clear(); });

const mission = (id: string, steps: Mission['steps'], latest_version = 1) => ({ id, name: id, steps, latest_version, archived_at: null }) as unknown as Mission;
const MS = [mission('m-photo', [{ action: 'PHOTO', params: { camera: 'rgb' } }]), mission('m-wait', [{ action: 'WAIT', params: { seconds: 30 } }]),
  mission('m-long', [{ action: 'WAIT', params: { seconds: 300 } }]), mission('m-op', [{ action: 'OPERATOR_CONFIRM', params: {} }]), mission('m-new', [{ action: 'PHOTO', params: {} }], 2)];
const wp = (x: number, y: number, mission_id: string | null = null, mission_version: number | null = mission_id ? 1 : null) =>
  ({ floor_id: 'f1', map_version_id: 'v1', x, y, yaw: 0, waypoint_ref: null, mission_id, mission_version });
const scen = (waypoints: ReturnType<typeof wp>[], finish: ScenarioWrite['finish'] = { mode: 'STAY', target: null }) => ({ name: '순찰', waypoints, finish }) as unknown as ScenarioWrite;

describe('scenarioTree — 시뮬 나무로 바꾸기', () => {
  it('이동·사진·대기·복귀 → validateTree 통과, 지점 순서 그대로', () => {
    const t = scenarioTree(scen([wp(1, 2), wp(3, 4, 'm-photo'), wp(5, 6, 'm-wait')], { mode: 'RETURN_TO_START', target: null }), MS) as Tree;
    expect(typeof t).toBe('object');
    expect(t.root.children!.map((n) => n.type)).toEqual(['goto', 'goto', 'photo', 'goto', 'wait', 'return_home']);
    expect(t.root.children![4].seconds).toBe(30);
    expect(check(t)).toBe('');
    expect(treePoints(t)).toEqual([{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }]);
  });
  it('끝 = 지정 지점으로 이동이면 마지막 goto', () => {
    const t = scenarioTree(scen([wp(1, 2)], { mode: 'GO_TO', target: { ...wp(9, 8), mission_id: null } as never }), MS) as Tree;
    expect(t.root.children![t.root.children!.length - 1]).toEqual({ type: 'goto', point: { x: 9, y: 8 } });
  });
  it('시뮬이 못 하는 일·모르는 임무는 이유', () => {
    expect(scenarioTree(scen([wp(1, 2, 'm-op')]), MS)).toMatch(/1번 지점: «운영자 확인»은 시뮬에서 실행할 수 없습니다/);
    expect(scenarioTree(scen([wp(1, 2), wp(1, 3, 'm-long')]), MS)).toMatch(/2번 지점: 대기 300초 — 시뮬은 한 번에 120초까지/);
    expect(scenarioTree(scen([wp(1, 2, 'm-new')]), MS)).toMatch(/옛 판 임무/);   // 고른 판 1 ≠ 최신 판 2 — 내용을 모른다
    expect(scenarioTree(scen([wp(1, 2, 'gone')]), MS)).toMatch(/옛 판 임무/);
    expect(scenarioTree(scen([]), MS)).toMatch(/children|순찰 지점/);   // 빈 시나리오는 validateTree·지점 검사가 거절
  });
  it('저장 키 id = 시뮬 main.js 형식([a-z0-9-] 32자 이내)', () => {
    expect(simId('SC_01H-ABC.xyz')).toBe('ssc01habcxyz');
    expect(simId('x'.repeat(60))).toHaveLength(32);
    expect(simId('A-b')).toMatch(/^[a-z0-9-]{1,32}$/);
  });
});

const floor = (p: Partial<MapFloor> = {}) => ({ id: 'f1', building_id: 'b1', name: '1층', level: 1, approved_version_id: 'v1', provenance: 'SIMULATION', ...p }) as MapFloor;
const ver = (sha: string, m: { origin: number[]; res: number; w: number; h: number }, p: Partial<MapVersion> = {}) =>
  ({ id: 'v1', provenance: 'SIMULATION', image_sha256: sha, origin: m.origin, resolution: m.res, width: m.w, height: m.h, ...p }) as MapVersion;
const FI_SHA = '8669ef9e9300c7a6372d02b230aaee98f984337bac9cebe5b1316be1e7d61721';
describe('simAt — 시뮬과 좌표가 같은 층만', () => {
  it('시뮬 세계 층: 사진 sha·격자가 시뮬 자산과 같으면 그 지도, 여러 층 지도면 그 층 id', () => {
    expect(simAt(floor(), ver(FI_SHA, FI.map))).toEqual({ map: 'factory-inspection', floor: '' });
    const f2 = FZ.floors[1];
    expect(simAt(floor(), ver(f2.image_sha256, f2.map))).toEqual({ map: 'factory-zone', floor: 'f2' });
  });
  it('지형 층 = custom + 지형 id', () => {
    const TV = { source: 'IMPORT', reason: TERRAIN_REASON } as const;
    expect(simAt(floor({ terrain_id: 'my-hill' }), ver('x', FI.map, TV))).toEqual({ map: 'custom', floor: '', terrain: 'my-hill' });
    expect(simAt(floor({ terrain_id: 'Bad Id' }), ver('x', FI.map, TV))).toMatch(/형식/);
    // 지형 id 가 있어도 지형 저장이 만든 판이 아니면(사람 판·고친 판·회전 있는 원점) 막음
    for (const p of [{ ...TV, provenance: 'HUMAN' }, { ...TV, source: 'EDIT' }, { ...TV, reason: '도면' }] as const)
      expect(simAt(floor({ terrain_id: 'my-hill' }), ver('x', FI.map, p))).toMatch(/만든 판이 아닙니다/);
    expect(simAt(floor({ terrain_id: 'my-hill' }), ver('x', { ...FI.map, origin: [-0.05, -0.05, 0.3] }, TV))).toMatch(/만든 판이 아닙니다/);
  });
  it('사람이 올린 지도·격자가 다른 판·모르는 사진은 이유(막음)', () => {
    expect(simAt(floor({ provenance: 'HUMAN' }), ver(FI_SHA, FI.map, { provenance: 'HUMAN' }))).toMatch(/시뮬 세계·지형과 이어져 있지 않아/);
    expect(simAt(floor(), ver(FI_SHA, { ...FI.map, res: 0.1 }))).toMatch(/이어져 있지 않아/);
    expect(simAt(floor(), ver('0'.repeat(64), FI.map))).toMatch(/이어져 있지 않아/);
  });
});

describe('옛 «임무 편집» 저장본', () => {
  it('scenario_id 없는 fh.btMission.* 만 세고 지우지 않는다 — 시뮬 탭에 한 줄, 편집기는 없음', () => {
    localStorage.setItem('fh.btMission.a1', JSON.stringify({ id: 'a1', name: '옛 것', map: 'warehouse', floor: '', tree: {} }));
    localStorage.setItem('fh.btMission.b2', 'not json');
    localStorage.setItem('fh.btMission.s1', JSON.stringify({ id: 's1', name: '시나리오', map: 'warehouse', floor: '', tree: {}, scenario_id: 'S1' }));
    expect(oldMissions()).toBe(2);
    box = document.createElement('div'); document.body.append(box);
    act(() => { root = createRoot(box!); root.render(<SimPick make />); });
    expect(box.querySelector('[data-old-bt]')?.textContent).toBe('이 브라우저에만 있는 옛 임무 2개');
    expect(box.textContent).not.toMatch(/임무 편집/);
    expect(localStorage.getItem('fh.btMission.a1')).not.toBeNull();
  });
  it('옛 저장본이 없으면 줄도 없다', () => {
    box = document.createElement('div'); document.body.append(box);
    act(() => { root = createRoot(box!); root.render(<SimPick make />); });
    expect(box.querySelector('[data-old-bt]')).toBeNull();
  });
});
