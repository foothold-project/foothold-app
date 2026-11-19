// RB-GO2-REAL-RENDER(11-19) public/go2: 변환한 Go2 메시(부품 다 있음·3 MB 이하)·라이선스 원문(pins 의 SHA)·README, 받으면 상자 → 실제 모양(파일 읽기라 .js — 앱 tsconfig 에 node 타입 없음).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createElement as h } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Go2Figure, JOINTS, parseGo2, resetGo2Cache } from '../go2model';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const repo = process.cwd() + '/../../', read = (p) => readFileSync(repo + p);
const glb = () => new Uint8Array(read('apps/web/public/go2/go2.glb')).buffer;   // jsdom 쪽 ArrayBuffer 로
const pins = JSON.parse(read('deploy/go2-mesh-pins.json').toString()).files;
let root = null, box;
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); resetGo2Cache(); vi.unstubAllGlobals(); });

describe('public/go2 메시', () => {
  it('부품 5개(몸통·엉덩이·허벅지·거울 허벅지·종아리) 모양이 다 있고 3 MB 이하', async () => {
    const m = await parseGo2(glb());
    for (const p of ['trunk', 'hip', 'thigh', 'thigh_mirror', 'calf']) expect([...m.keys()].some((k) => k.startsWith(`${p}-`))).toBe(true);
    expect(read('apps/web/public/go2/go2.glb').length).toBeLessThan(3 * 1024 * 1024);
  });

  it('라이선스 원문 = pins 의 SHA-256, README 에 출처·원본 SHA·변환 스크립트', () => {
    const lic = read('apps/web/public/go2/LICENSE-Unitree-BSD-3-Clause.txt');
    expect(createHash('sha256').update(lic).digest('hex')).toBe(pins['LICENSE-Unitree-BSD-3-Clause.txt'].sha256);
    const readme = read('apps/web/public/go2/README.md').toString();
    expect(readme).toContain('unitreerobotics/unitree_ros'); expect(readme).toContain('apps/web/scripts/go2_mesh.py');
    for (const f of ['trunk', 'hip', 'thigh', 'thigh_mirror', 'calf']) expect(readme).toContain(pins[`${f}.dae`].sha256.slice(0, 8));
  });

  it('메시를 받으면 상자 그림에서 실제 모양(mesh)으로 바뀐다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: async () => glb() })));
    box = document.createElement('div'); document.body.append(box);
    act(() => { root = createRoot(box); root.render(h(Go2Figure, { pose: { q: JOINTS.map(() => 0.3), wxyz: [1, 0, 0, 0] } })); });
    expect(box.querySelector('[data-go2-model]').dataset.go2Model).toBe('box');
    await act(async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); });
    expect(box.querySelector('[data-go2-model]').dataset.go2Model).toBe('mesh');
    expect(box.querySelectorAll('[data-go2-joint]')).toHaveLength(12);
  });
});
