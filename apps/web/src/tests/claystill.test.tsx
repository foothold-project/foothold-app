// 지도 탭 층 썸네일 3D(팀장 00:14): 모형이 있는 판만 hero 카메라 정지 그림 · 그리개(WebGL 문맥) 하나 · 같은 판 · 크기 · 판 빛이면 다시 그리지 않음 · 못 그리면 평면도
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MapVersion } from '../../../contracts/ts';
import { api } from '../api';
import { clayStill, resetStill, stillGl } from '../screens/claystill';
import { modelBytes, resetModels } from '../screens/map3d';
import { Thumb } from '../screens/maps';

const fake = vi.hoisted(() => ({ on: true, made: 0, renders: 0 }));
vi.mock('three', async (orig) => {
  const t = await orig<typeof import('three')>();
  class GL {
    domElement = Object.assign(document.createElement('canvas'), { toDataURL: () => `data:image/png;base64,R${fake.renders}` });
    outputColorSpace = ''; localClippingEnabled = false; toneMapping = 0; toneMappingExposure = 1; shadowMap = { enabled: false, type: 0 };
    constructor() { fake.made++; }
    setPixelRatio() {} setSize() {} setClearColor() {} clear() {} dispose() {} forceContextLoss() {} render() { fake.renders++; }
  }
  return { ...t, WebGLRenderer: function (this: unknown) { if (!fake.on) throw new Error('no webgl'); return new GL(); } };
});
vi.mock('three/examples/jsm/loaders/GLTFLoader.js', async (orig) => {
  const m = await orig<typeof import('three/examples/jsm/loaders/GLTFLoader.js')>();
  const T = await import('three');
  class L extends m.GLTFLoader { parseAsync() { const g = new T.Group(); g.add(new T.Mesh(new T.BoxGeometry(200, 3, 30), new T.MeshStandardMaterial())); return Promise.resolve({ scene: g } as never); } }
  return { ...m, GLTFLoader: L };
});

const V = (id: string, sha: string | null) => ({ id, floor_id: 'f1', number: 1, status: 'APPROVED', image_sha256: 'ab'.repeat(32), width: 100, height: 80, resolution: 0.05, origin: [0, 0, 0],
  model_sha256: sha, model_floor_z: 0, features: { zones: [], waypoints: [], connectors: [], edits: [] } }) as unknown as MapVersion;

let model: { mockRejectedValueOnce(e: unknown): unknown } & Parameters<typeof expect>[0];
beforeEach(() => { fake.on = true; fake.made = 0; fake.renders = 0; resetStill(); resetModels(); model = vi.spyOn(api, 'model').mockResolvedValue(new ArrayBuffer(8)); });
afterEach(() => { vi.restoreAllMocks(); resetStill(); });

describe('claystill', () => {
  it('모형 없는 판은 그리지 않고 null(평면도) · 모형을 묻지도 않음', async () => {
    expect(await clayStill(V('a', null), 300, 184, true)).toBeNull();
    expect(model).not.toHaveBeenCalled(); expect(fake.made).toBe(0);
  });
  it('썸네일이 여럿이어도 그리개(WebGL 문맥) 하나 · 같은 판 · 크기 · 판 빛이면 다시 그리지 않음 · 판 빛이 바뀌면 다시', async () => {
    const [a, b, c] = await Promise.all([clayStill(V('a', 'aa'), 300, 184, true), clayStill(V('b', 'bb'), 300, 184, true), clayStill(V('c', 'cc'), 300, 184, true)]);
    expect([a, b, c].every((u) => u?.startsWith('data:image/png'))).toBe(true);
    expect(fake.made).toBe(1); expect(stillGl()).toBe(1); expect(fake.renders).toBe(3);
    expect(await clayStill(V('a', 'aa'), 300, 184, true)).toBe(a); expect(fake.renders).toBe(3);   // 같은 것 = 기억한 그림
    await clayStill(V('a', 'aa'), 300, 184, false); expect(fake.renders).toBe(4); expect(fake.made).toBe(1);   // 어둠 판 = 다시 그림 · 그리개는 그대로
  });
  it('미리 보기와 썸네일이 같은 모형을 함께 열면 /model 은 한 번만', async () => {
    await Promise.all([modelBytes('a', 'aa'), clayStill(V('a', 'aa'), 300, 184, true)]);
    expect(model).toHaveBeenCalledTimes(1);
  });
  it('WebGL 이 없거나 모형을 못 받으면 null(평면도) · 실패는 기억하지 않아 다음에 다시', async () => {
    fake.on = false;
    expect(await clayStill(V('a', 'aa'), 300, 184, true)).toBeNull();
    resetStill(); fake.on = true; model.mockRejectedValueOnce(new Error('404'));
    expect(await clayStill(V('b', 'bb'), 300, 184, true)).toBeNull();
    expect(await clayStill(V('b', 'bb'), 300, 184, true)).toMatch(/^data:image\/png/);
  });
});

describe('층 썸네일(Thumb)', () => {
  let root: Root, box: HTMLDivElement;
  const mount = async (v: MapVersion) => { box = document.createElement('div'); document.body.append(box); await act(async () => { root = createRoot(box); root.render(<Thumb id={v.id} v={v} />); }); for (let k = 0; k < 4; k++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  afterEach(() => { act(() => root.unmount()); box.remove(); });
  it('모형 있음 = 3D 정지 그림(img) · 평면도 없음', async () => {
    await mount(V('a', 'aa'));
    const img = box.querySelector<HTMLImageElement>('[data-thumb3d] img');
    expect(img?.getAttribute('src')).toMatch(/^data:image\/png/); expect(box.querySelector('svg')).toBeNull();
  });
  it('모형 없음 = 지금 평면도(svg) · 3D 그림 없음', async () => {
    await mount(V('b', null));
    expect(box.querySelector('[data-thumb3d]')).toBeNull(); expect(box.querySelector('[data-thumb="b"] svg')).not.toBeNull();
  });
  it('3D 를 못 그리면(WebGL 없음) 평면도 그대로', async () => {
    fake.on = false; await mount(V('c', 'cc'));
    expect(box.querySelector('[data-thumb3d]')).toBeNull(); expect(box.querySelector('[data-thumb="c"] svg')).not.toBeNull();
  });
});
