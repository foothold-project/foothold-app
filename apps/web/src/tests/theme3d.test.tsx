// 밝은 판 · 어두운 판(u11): 3D 장면의 바탕 · 격자 · 바닥 색은 화면 토큰(frame.css .fh / .fh.light)에서 읽고, 테마를 바꾸면 다시 칠한다.
// jsdom 엔 WebGL · 상속 CSS 변수가 없다: 가짜 그리개가 마지막 장면을 잡고, getComputedStyle 의 --토큰은 frame.css 원문 값을 data-theme 에 따라 돌려준다.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import frameCss from '../frame.css?raw';
import Voxel3D, { type Props as VoxelProps } from '../screens/voxel3d';
import type { Props as TerrainProps } from '../screens/terrain3d';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const gl: { scene: THREE.Scene | null } = { scene: null };
vi.mock('three', async (orig) => {
  const T = await orig<typeof import('three')>();
  class FakeRenderer {
    domElement = document.createElement('canvas');
    localClippingEnabled = false;
    setPixelRatio() {} setSize() {} dispose() {} forceContextLoss() {} setClearColor() {}
    render(scene: import('three').Scene) { gl.scene = scene; }
  }
  return { ...T, WebGLRenderer: FakeRenderer };
});

/** frame.css 의 .fh{…} · .fh.light{…} 토큰 값(값 고치지 않음 · 읽기만) */
const tokens = (sel: string) => Object.fromEntries([...new RegExp(`${sel.replace(/\./g, '\\.')}\\{([^}]*)\\}`).exec(frameCss)![1].matchAll(/(--[\w-]+):([^;]+)/g)].map((m) => [m[1], m[2].trim()]));
const DARK = tokens('.fh'), LIGHT = { ...DARK, ...tokens('.fh.light') };
const theme = (t: 'dark' | 'light') => act(() => { document.documentElement.dataset.theme = t; });
const hex = (c: THREE.Color | THREE.Texture | null) => `#${(c as THREE.Color).getHexString().toUpperCase()}`;
/** 장면의 격자(GridHelper) 선 색 */
const gridHex = (s: THREE.Scene) => { let h = ''; s.traverse((o) => { if (o instanceof THREE.GridHelper) { const a = o.geometry.getAttribute('color'); h = `#${new THREE.Color(a.getX(0), a.getY(0), a.getZ(0)).getHexString().toUpperCase()}`; } }); return h; };

let root: Root | null = null, box: HTMLDivElement;
beforeEach(() => {
  theme('dark');
  const real = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((el, p) => {
    const cs = real(el, p), t = document.documentElement.dataset.theme === 'light' ? LIGHT : DARK;
    return new Proxy(cs, { get: (o, k) => (k === 'getPropertyValue' ? (n: string) => (n.startsWith('--') ? t[n] ?? '' : o.getPropertyValue(n)) : Reflect.get(o, k)) });
  });
});
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); gl.scene = null; vi.restoreAllMocks(); });
const show = (el: JSX.Element) => { box = document.createElement('div'); box.className = 'fh'; document.body.append(box); act(() => { root = createRoot(box); root.render(el); }); };
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });

describe('3D 장면 색 = 테마 토큰', () => {
  it('저장 지도 3D(voxel3d): 바탕 = --bg · 격자 = --line, 밝음으로 바꾸면 다시 칠함', async () => {
    const v = { width: 40, height: 40, resolution: 0.1, origin: [0, 0, 0] } as unknown as VoxelProps['v'];
    show(<Voxel3D v={v} pages={[]} n={0} />);
    expect(box.querySelector('[data-voxel-3d-failed]')).toBeNull();
    expect(hex(gl.scene!.background)).toBe(DARK['--bg'].toUpperCase());
    expect(gridHex(gl.scene!)).toBe(DARK['--line'].toUpperCase());
    theme('light'); await flush();
    expect(hex(gl.scene!.background)).toBe(LIGHT['--bg'].toUpperCase());
    expect(gridHex(gl.scene!)).toBe(LIGHT['--line'].toUpperCase());
    theme('dark'); await flush();
    expect(hex(gl.scene!.background)).toBe(DARK['--bg'].toUpperCase());
  });

  it('지형 3D(terrain3d): 바탕 = --bg, 밝음으로 바꾸면 다시 칠함', async () => {
    const Real = (await import('../screens/terrain3d')).default;
    const spec = { schema: 'fh_custom_terrain/1', id: 't-a', name: '시험', size: [12, 12], spawn: [-5, 0, 0], items: [] } as unknown as TerrainProps['spec'];
    show(<Real spec={spec} sel={null} tool="select" state={[]} onSel={() => {}} onPose={() => {}} onFloor={() => {}} onKeyDown={() => {}} />);
    await flush();
    expect(box.querySelector('[data-terrain-3d-failed]')).toBeNull();
    expect(hex(gl.scene!.background)).toBe(DARK['--bg'].toUpperCase());
    const mid = (t: Record<string, string>) => `#${new THREE.Color(t['--line']).lerp(new THREE.Color(t['--muted']), 0.5).getHexString().toUpperCase()}`;
    expect(gridHex(gl.scene!)).toBe(mid(DARK));   // 격자 = --line 과 --muted 사이(밝은 판 흰 바닥 위에서도 보이게)
    theme('light'); await flush();
    expect(hex(gl.scene!.background)).toBe(LIGHT['--bg'].toUpperCase());
    expect(gridHex(gl.scene!)).toBe(mid(LIGHT));
  });
});
