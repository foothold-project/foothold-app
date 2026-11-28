// 현장 모형을 못 받으면 그 실패를 기억하지 않는다: 다음 loadSite 가 질감판을 새로 받는다(받은 것은 한 번만)
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';

const calls: string[] = [];
let fail = true;
vi.mock('three/examples/jsm/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class {
    setDRACOLoader() { return this; }
    load(url: string, ok: (g: { scene: THREE.Group }) => void, _p: unknown, bad: () => void) {
      calls.push(url);
      queueMicrotask(() => (fail ? bad() : ok({ scene: new THREE.Group() })));
    }
  },
}));

describe('loadSite 실패 다시 받기', () => {
  it('둘 다 실패 → null, 다음 부름은 질감판부터 새로 받음 · 받은 뒤에는 다시 받지 않음', async () => {
    const { loadSite, SITE_TEX_GLB, SITE_GLB } = await import('../proto/site');
    expect(await loadSite()).toBeNull();
    expect(calls).toEqual([SITE_TEX_GLB, SITE_GLB]);
    fail = false;
    const g = await loadSite();
    expect(g).not.toBeNull(); expect(g!.userData.tex).toBe(true);
    expect(calls).toEqual([SITE_TEX_GLB, SITE_GLB, SITE_TEX_GLB]);
    await loadSite();
    expect(calls.length).toBe(3);
  });
});
