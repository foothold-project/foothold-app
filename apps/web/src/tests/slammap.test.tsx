// RV-485 막는 것: 판(revision)·세션이 바뀌면 같은 좌표·tile_seq 조각이라도 2D 그림을 새로 칠해야 한다(odom 없는 경우 포함).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../api';
import { SlamView, useSlamLive } from '../screens/slammap';
import type { MappingProgress, MappingGridTile } from '../../../contracts/ts';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined, box: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); box?.remove(); vi.restoreAllMocks(); });
function Hook({ p }: { p: MappingProgress }) { const pic = useSlamLive('robot', p); return <SlamView pic={pic} empty="empty" />; }
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
    box = document.createElement('div'); document.body.append(box); root = createRoot(box);
    await act(async () => { root!.render(<Hook p={progress(a[0], a[1], pose)} />); });
    expect(draws[draws.length - 1]).toBe(FREE);
    cell = 2;
    await act(async () => { root!.render(<Hook p={progress(b[0], b[1], pose)} />); });
    expect(draws[draws.length - 1]).toBe(WALL);
  });
