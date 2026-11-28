// 공장 질감판(maps_v2 factory_kr): 질감 재질은 그대로 두고 색만 곱함(새 재질로 바꾸면 질감이 사라짐) · 판에 따라 곱 값 · 금지 구역 빨강 · 새 재질 이름(roof · ground)도 같은 길
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { SITE_TEX_GLB, SITE_TOP, TEX_TONE, dressTex, toneSite } from '../proto/site';

const mesh = (name: string, map = true) => { const mt = new THREE.MeshStandardMaterial({ name, map: map ? new THREE.Texture() : null }); return new THREE.Mesh(new THREE.BoxGeometry(), mt); };
describe('질감판', () => {
  it('자산 경로 = /proto-assets/assets/maps_v2/factory_kr (glb · 위 그림 두 벌)', () => {
    expect(SITE_TEX_GLB).toBe('/proto-assets/assets/maps_v2/factory_kr/factory_kr.glb');
    expect(SITE_TOP).toEqual({ light: '/proto-assets/assets/maps_v2/factory_kr/top_light.png', dark: '/proto-assets/assets/maps_v2/factory_kr/top_dark.png' });
  });
  it('질감 · 재질 종류 그대로 · 색만 어둠 곱 · 원본 재질은 건드리지 않음(복제)', () => {
    const g = new THREE.Group(), roof = mesh('roof'), ground = mesh('ground'), src = roof.material as THREE.MeshStandardMaterial, tex = src.map;
    g.add(roof, ground); dressTex(g);
    for (const m of [roof, ground]) {
      const mt = m.material as THREE.MeshStandardMaterial;
      expect(mt).toBeInstanceOf(THREE.MeshStandardMaterial); expect(mt.color.getHex()).toBe(TEX_TONE.dark); expect(m.userData.tex).toBe(true);
    }
    expect((roof.material as THREE.MeshStandardMaterial).map).toBe(tex);
    expect(roof.material).not.toBe(src); expect(src.color.getHex()).toBe(0xffffff);
  });
  it('밝은 판 = 곱 #ffffff, 다시 어둠 = #a9b2bd', () => {
    const g = new THREE.Group(), m = mesh('building'); g.add(m); dressTex(g);
    toneSite(g, true); expect((m.material as THREE.MeshStandardMaterial).color.getHex()).toBe(0xffffff);
    toneSite(g, false); expect((m.material as THREE.MeshStandardMaterial).color.getHex()).toBe(0xa9b2bd);
  });
  it('금지 구역 = 빨강 반투명(질감 없음)', () => {
    const g = new THREE.Group(), f = mesh('nogo_floor', false); g.add(f); dressTex(g);
    const mt = f.material as unknown as THREE.MeshBasicMaterial;
    expect(mt).toBeInstanceOf(THREE.MeshBasicMaterial); expect(mt.color.getHex()).toBe(0xff4d4f); expect(mt.opacity).toBe(0.07);
  });
});
