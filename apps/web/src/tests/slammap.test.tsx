// RV-485 막는 것: 판(revision)·세션이 바뀌면 같은 좌표·tile_seq 조각이라도 2D 그림을 새로 칠해야 한다(odom 없는 경우 포함).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiFail, api } from '../api';
import { FakeVox } from './fakeVox';
import { SlamView, useSlamLive } from '../screens/slammap';
import type { MappingProgress, MappingGridTile } from '../../../contracts/ts';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined, box: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); box?.remove(); vi.restoreAllMocks(); });
function Hook({ p }: { p: MappingProgress }) { const pic = useSlamLive('robot', p); return <SlamView pic={pic} empty="empty" />; }
function Live({ p, link }: { p: MappingProgress; link: number }) { const pic = useSlamLive('robot', p, link); return <><SlamView pic={pic} empty="empty" />{pic.gap && <p data-gap />}</>; }
const S1 = '11111111-1111-4111-8111-111111111111', S2 = '33333333-3333-4333-8333-333333333333';
const progress = (sid: string, rev: number, pose: boolean): MappingProgress => ({ session_id: sid, floor_id: '22222222-2222-4222-8222-222222222222', status: 'RUNNING', phase: 'STARTED', source: 'point_lio', revision: rev, update_seq: rev,
  voxels: { revision: rev, seq: 1, reset: true, frame_id: 'map', added: [[rev, 0, 0]] },
  odom: pose ? { provider: 'point_lio', source: '/aft_mapped_to_init', frame_id: 'map', stamp: { sec: 1, nanosec: 0 }, x: 0, y: 0, z: 0, yaw: 0 } : null });
const tile = (rev: number, cell: number): MappingGridTile => ({ revision: rev, tile_seq: 1, x: 0, y: 0, frame_id: 'map', floor_z: 0, cells: Array(4096).fill(cell) });
const FREE = 0xffffffff, WALL = 0xff1a1414;   // COL[1]·COL[2] 첫 화소

for (const [name, a, b] of [['revision', [S1, 1], [S1, 2]], ['session', [S1, 1], [S2, 1]]] as const)
  for (const pose of [true, false]) it(`${name} 이 바뀌면 같은 좌표·tile_seq 의 2D 그림을 다시 칠함; pose=${pose}`, async () => {
    const images = new Map<HTMLCanvasElement, number>(), draws: number[] = [];
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      const cv = this;
      return { setTransform() {}, fillRect() {}, createImageData(w: number, h: number) { return { data: new Uint8ClampedArray(w * h * 4) }; },
        putImageData(d: any) { images.set(cv, new Uint32Array(d.data.buffer)[0]); },
        drawImage(img: HTMLCanvasElement) { draws.push(images.get(img)!); }, save() {}, restore() {}, translate() {}, rotate() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {}, stroke() {} } as any;
    });
    let cell = 1;
    vi.spyOn(api, 'slamTiles').mockImplementation(async (_r, sid, revision) => ({ session_id: sid, revision, update_seq: 1, tiles: [tile(revision, cell)], next_cursor: null }));
    vi.spyOn(api, 'slamVoxels').mockImplementation(async (_r, sid, revision) => ({ session_id: sid, revision, seq: 0, reset: true, reset_seq: 0, resolution: 0.05, frame_id: null, added: [], removed: [], next_cursor: null }));
    box = document.createElement('div'); document.body.append(box); root = createRoot(box);
    await act(async () => { root!.render(<Hook p={progress(a[0], a[1], pose)} />); });
    expect(draws[draws.length - 1]).toBe(FREE);
    cell = 2;
    await act(async () => { root!.render(<Hook p={progress(b[0], b[1], pose)} />); });
    expect(draws[draws.length - 1]).toBe(WALL);
  });

// 11-25 RB-SLAM-WEB4: 3D 상자는 GET …/voxels?revision&since&cursor 로만 — 진행 자료 voxels 는 «새로 왔음» 신호. 판 바뀜·409·여러 쪽·다시 연결 때 빠짐·옛 판 없음
describe('3D 상자 = 서버 voxels cursor', () => {
  const C = (x: number): [number, number, number] => [x, 0, 0];
  const rng = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => C(a + i));
  /** 진행 자료: 신호(seq)만 — 증분 내용은 비워 둬서, 놓인 칸은 모두 voxels API 에서 온 것임을 확인 */
  const sig = (sid: string, rev: number, seq: number): MappingProgress => ({ session_id: sid, floor_id: '22222222-2222-4222-8222-222222222222', status: 'RUNNING', phase: 'STARTED', source: 'point_lio',
    revision: rev, update_seq: 1, voxels: { revision: rev, seq, frame_id: 'map', added: [] }, odom: null });
  let calls: { rev: number; since: number; cursor: string | null }[] = [], store: FakeVox, fail: ((c: (typeof calls)[0]) => ApiFail | null) | null = null;
  const boxes = () => Number(box.querySelector<HTMLElement>('[data-slam-boxes]')!.dataset.slamBoxes);
  function setup(size = 3) {
    calls = []; fail = null; store = new FakeVox(S1, size);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    vi.spyOn(api, 'slamTiles').mockImplementation(async (_r, sid, revision) => ({ session_id: sid, revision, update_seq: 1, tiles: [], next_cursor: null }));
    vi.spyOn(api, 'slamVoxels').mockImplementation(async (_r, _s, rev, since, cursor) => {
      const c = { rev, since, cursor }; calls.push(c);
      const f = fail?.(c); if (f) throw f;
      return store.page(rev, since, cursor);
    });
    box = document.createElement('div'); document.body.append(box); root = createRoot(box);
  }
  const show = (p: MappingProgress, link = 0) => act(async () => { root!.render(<Live p={p} link={link} />); for (let i = 0; i < 20; i++) await Promise.resolve(); });

  it('여러 쪽 cursor 를 끝까지 그대로 따라가 한 번에 다 놓고, 다음은 첫 쪽 seq 이후만 (removed 반영)', async () => {
    setup(3);
    store.report({ revision: 1, seq: 1, reset: true, frame_id: 'map', added: rng(0, 5) });
    store.report({ revision: 1, seq: 2, frame_id: 'map', added: rng(5, 8) });   // 신호로는 안 온 증분
    await show(sig(S1, 1, 2));
    expect(boxes()).toBe(8);
    expect(calls).toEqual([{ rev: 1, since: 0, cursor: null }, { rev: 1, since: 0, cursor: '3' }, { rev: 1, since: 0, cursor: '6' }]);
    store.report({ revision: 1, seq: 3, frame_id: 'map', removed: [C(0), C(1)], added: [C(20)] });
    await show(sig(S1, 1, 3));
    expect(boxes()).toBe(7);
    expect(calls.slice(3)).toEqual([{ rev: 1, since: 2, cursor: null }]);
  });

  it('쪽을 받는 사이 칸이 바뀌면 첫 쪽 seq 부터 한 번 더 받아 빠짐없음', async () => {
    setup(2);
    store.report({ revision: 1, seq: 1, reset: true, frame_id: 'map', added: rng(0, 4) });
    fail = (c) => { if (c.cursor === '2') { fail = null; store.report({ revision: 1, seq: 2, frame_id: 'map', added: [C(100)], removed: [C(3)] }); } return null; };
    await show(sig(S1, 1, 1));
    expect(calls.map((c) => [c.since, c.cursor])).toEqual([[0, null], [0, '2'], [1, null]]);
    expect(boxes()).toBe(4);   // 0,1,2 + 100 (3 은 지움)
  });

  it('판이 바뀌면 옛 판 칸을 버리고 새 판을 since=0 부터 · 409 판 바뀜이면 비움', async () => {
    setup();
    store.report({ revision: 1, seq: 1, reset: true, frame_id: 'map', added: rng(0, 5) });
    await show(sig(S1, 1, 1));
    expect(boxes()).toBe(5);
    store.report({ revision: 2, seq: 1, reset: true, frame_id: 'map', added: [C(9)] });   // 서버는 판 2, 진행 자료는 아직 판 1
    await show(sig(S1, 1, 2));
    expect(calls.slice(-1)[0]).toEqual({ rev: 1, since: 1, cursor: null });
    expect(boxes()).toBe(0);   // 409 MAPPING_REVISION_CONFLICT — 옛 판 칸이 남지 않음
    await show(sig(S1, 2, 1));
    expect(calls.slice(-1)[0]).toEqual({ rev: 2, since: 0, cursor: null });
    expect(boxes()).toBe(1);
  });

  for (const code of ['MAPPING_VOXEL_RESET_CONFLICT', 'MAPPING_VOXEL_SEQUENCE_CONFLICT', 'MAPPING_VOXEL_CURSOR_INVALID'])
    it(`${code} 면 다음 신호에 cursor·since 없이 처음부터 — reset 으로 한 번 비우고 새 전체`, async () => {
      setup(3);
      store.report({ revision: 1, seq: 1, reset: true, frame_id: 'map', added: rng(0, 5) });
      await show(sig(S1, 1, 1));
      store.report({ revision: 1, seq: 2, reset: true, frame_id: 'map', added: rng(10, 14) });   // reset — 옛 0~4 는 없어짐
      fail = (c) => (c.cursor ? new ApiFail(code === 'MAPPING_VOXEL_CURSOR_INVALID' ? 422 : 409, code, '') : null);
      await show(sig(S1, 1, 2));
      fail = null;
      await show(sig(S1, 1, 2));
      expect(calls.slice(-2)).toEqual([{ rev: 1, since: 0, cursor: null }, { rev: 1, since: 0, cursor: '3' }]);
      expect(boxes()).toBe(4);
    });

  it('다시 연결(link 바뀜)이면 처음부터 받아 끊긴 동안의 reset·삭제까지 옛 칸이 남지 않음 · 끊김 오류 뒤에도 처음부터', async () => {
    setup();
    store.report({ revision: 1, seq: 1, reset: true, frame_id: 'map', added: rng(0, 5) });
    await show(sig(S1, 1, 1));
    store.report({ revision: 1, seq: 2, reset: true, frame_id: 'map', added: [C(7)] });
    await show(sig(S1, 1, 2), 1);
    expect(calls.slice(-1)[0]).toEqual({ rev: 1, since: 0, cursor: null });
    expect(boxes()).toBe(1);
    fail = () => new ApiFail(0, 'NETWORK', '');
    store.report({ revision: 1, seq: 3, frame_id: 'map', added: [C(8)] });
    await show(sig(S1, 1, 3), 1);
    fail = null;
    await show(sig(S1, 1, 3), 1);   // 같은 신호라도 다시
    expect(calls.slice(-1)[0]).toEqual({ rev: 1, since: 0, cursor: null });
    expect(boxes()).toBe(2);
  });

  it('서버가 이 세션 3D 를 처음부터 줄 수 없으면(MAPPING_VOXELS_RESET_REQUIRED) 비우고 gap · 진행 자료 증분을 직접 놓지 않음', async () => {
    setup();
    fail = () => new ApiFail(409, 'MAPPING_VOXELS_RESET_REQUIRED', '');
    await show({ ...sig(S1, 1, 4), voxels: { revision: 1, seq: 4, frame_id: 'map', added: rng(0, 3) } });
    expect(boxes()).toBe(0);
    expect(box.querySelector('[data-gap]')).toBeTruthy();
  });
});
