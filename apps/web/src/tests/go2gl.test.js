// RV-403 4 Go2 그림 자원: 열고 닫기를 되풀이해도 모양·재질에 그리개 해제 리스너가 쌓이지 않고, 떠날 때 그 화면이 만든 것은 모두 해제된다.
// 진짜 WebGL 이 없는 jsdom 이라 three 그리개만 가짜로 — three 처럼 처음 그린 모양·재질에 dispose 리스너를 달고, 해제되면 뗀다(파일 읽기라 .js).
import { readFileSync } from 'node:fs';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const live = new Set(), seen = [];
vi.mock('three', async (orig) => {
  const T = await orig();
  class WebGLRenderer {
    constructor() { this.domElement = document.createElement('canvas'); this.on = new Set(); }
    setPixelRatio() {} setSize() {} forceContextLoss() {}
    render(scene) {
      scene.traverse((o) => [o.geometry, ...[].concat(o.material ?? [])].filter(Boolean).forEach((x) => {
        if (this.on.has(x)) return;
        const off = () => { x.removeEventListener('dispose', off); this.on.delete(x); live.delete(x); };
        x.addEventListener('dispose', off); this.on.add(x); live.add(x); seen.push(x);
      }));
    }
    dispose() {}   // three 도 그리개 dispose 는 모양·재질 리스너를 떼지 않는다 — 모양·재질 dispose 로만 떨어짐
  }
  return { ...T, WebGLRenderer };
});
const { Go2Figure, JOINTS, resetGo2Cache } = await import('../go2model');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const glb = () => new Uint8Array(readFileSync(process.cwd() + '/../../apps/web/public/go2/go2.glb')).buffer;
afterEach(() => { resetGo2Cache(); vi.unstubAllGlobals(); });
const listeners = (x) => x._listeners?.dispose?.length ?? 0;

describe('Go2 그림 자원', () => {
  it('열고 닫기 3번: 닫을 때마다 남은 모양·재질 0, 리스너는 모양마다 1개를 넘지 않음, 캐시는 배열만 같이 씀', async () => {
    vi.stubGlobal('WebGLRenderingContext', function () {});
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: async () => glb() })));
    const arrays = [];
    for (let n = 0; n < 3; n++) {
      const box = document.createElement('div'); document.body.append(box);
      let root;
      act(() => { root = createRoot(box); root.render(h(Go2Figure, { pose: { q: JOINTS.map(() => 0.3), wxyz: [1, 0, 0, 0] } })); });
      await act(async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); });
      expect(box.querySelector('[data-go2-model]').dataset.go2Model).toBe('mesh');
      expect(box.querySelector('[data-go2-sketch]')).toBeNull();   // WebGL 있음 = 선 그림 없음
      act(() => root.render(h(Go2Figure, { pose: { q: JOINTS.map(() => 0.4), wxyz: [1, 0, 0, 0] } })));   // 한 번 더 그림
      const meshGeo = [...live].filter((x) => x.isBufferGeometry && x.attributes.position.count > 500);
      expect(meshGeo.length).toBeGreaterThanOrEqual(10);
      for (const x of live) expect(listeners(x)).toBe(1);
      arrays.push(meshGeo.map((g) => g.attributes.position.array));
      act(() => root.unmount()); box.remove();
      expect(live.size).toBe(0);
    }
    for (const x of seen) expect(listeners(x)).toBe(0);
    // 그림마다 모양 객체는 새로, 꼭짓점 배열은 캐시 것을 같이 씀
    expect(new Set(seen.filter((x) => x.isBufferGeometry)).size).toBe(seen.filter((x) => x.isBufferGeometry).length);
    expect(arrays[1].every((a) => arrays[0].includes(a))).toBe(true);
  });
});
