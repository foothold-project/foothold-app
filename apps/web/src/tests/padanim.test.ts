// 충전 · 점검 바닥 표시 위로 오르는 층(팀장 11-29 01:37): 층 크기 · 박 단계 · 움직임 줄이기 · 관제 타일과 로봇 탭이 같은 함수
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { PAD_BEATS, PAD_RISE, padGroup, padStep, padTick } from '../proto/padanim';
import tileSrc from '../proto/tileview.ts?raw';
import go2Src from '../screens/u4/go2view.ts?raw';
import u4Src from '../screens/u4/robotu4.tsx?raw';

const layers = (g: THREE.Object3D) => g.getObjectByName('rise')!.children;
const shown = (g: THREE.Object3D) => layers(g).filter((l) => l.visible).length;

describe('바닥 표시 오르는 층', () => {
  it('층 크기 = 바닥 1 · 0.98 · 0.96 · 0.94 (원 중심 기준) · 층마다 위로 · 진하기는 오를수록 낮음', () => {
    expect(PAD_RISE.scale).toEqual([1, 0.98, 0.96, 0.94]);
    for (const kind of ['charge', 'check'] as const) {
      const g = padGroup(kind), ls = layers(g);
      expect(ls.length).toBe(3);
      ls.forEach((l, i) => {
        expect(l.scale.x).toBe(PAD_RISE.scale[i + 1]); expect(l.scale.z).toBe(PAD_RISE.scale[i + 1]); expect(l.position.x).toBe(0); expect(l.position.z).toBe(0);
        expect(l.position.y).toBeCloseTo(PAD_RISE.dy * (i + 1), 9);
        expect(l.children.length).toBe(2);   // 바닥과 같은 꼴 둘
      });
      const op = ls.map((l) => ((l.children[0] as THREE.LineLoop).material as THREE.LineBasicMaterial).opacity);
      expect(op[0]).toBeGreaterThan(op[1]); expect(op[1]).toBeGreaterThan(op[2]);
      // 낮은 채도: 바닥 색보다 회색 쪽
      const base = new THREE.Color(((g.children[0] as THREE.LineLoop).material as THREE.LineBasicMaterial).color), up = ((ls[0].children[0] as THREE.LineLoop).material as THREE.LineBasicMaterial).color;
      expect(up.getHSL({ h: 0, s: 0, l: 0 }).s).toBeLessThan(base.getHSL({ h: 0, s: 0, l: 0 }).s);
    }
  });

  it('박 단계: 한 박마다 한 층씩 끊어서(0 → 1 → 2 → 3 → 다시 0) · 박 안에서는 그대로', () => {
    const b = PAD_RISE.beat;
    expect(PAD_BEATS).toBe(4);
    expect([0, 0.5, 1.5, 2.5, 3.5, 4.5].map((k) => padStep(k * b))).toEqual([0, 0, 1, 2, 3, 0]);
    expect(padStep(b * 1.01)).toBe(padStep(b * 1.99));   // 이음 없이 계단
    const g = padGroup('charge');
    padTick(g, 2.5 * b, false); expect(shown(g)).toBe(2); expect(layers(g)[0].visible && layers(g)[1].visible && !layers(g)[2].visible).toBe(true);
    padTick(g, 3.5 * b, false); expect(shown(g)).toBe(3);
    padTick(g, 4.5 * b, false); expect(shown(g)).toBe(0);
  });

  it('밝은 판 색 = 밝음 1 (충전 #18A07E · 점검 #5E6662) · 오른 층도 그 색에서 회색 쪽', () => {
    const col = (g: THREE.Object3D) => ((g.children[0] as THREE.LineLoop).material as THREE.LineBasicMaterial).color.getHex();
    expect(col(padGroup('charge', true))).toBe(0x18a07e); expect(col(padGroup('check', true))).toBe(0x5e6662); expect(col(padGroup('check'))).toBe(0xa9b8c6);
    expect(col(layers(padGroup('check', true))[0])).not.toBe(0x5e6662);
  });

  it('움직임 줄이기면 바닥 꼴만(오른 층 없음 · 바닥 둘은 그대로)', () => {
    const g = padGroup('check');
    padTick(g, 3.5 * PAD_RISE.beat, true);
    expect(shown(g)).toBe(0); expect(g.children[0].visible && g.children[1].visible).toBe(true);
  });

  it('관제 타일 · 로봇 탭 큰 무대가 같은 함수(padGroup · padTick) · 로봇 탭은 tilePad 규칙', () => {
    expect(tileSrc).toContain("import { padGroup, padTick } from './padanim';");
    expect(tileSrc).toContain('padTick(this.pads[look.pad], this.t)');
    expect(go2Src).toContain("import { padGroup, padTick } from '../../proto/padanim';");
    expect(go2Src).toContain('padTick(pads[k], t)');
    expect(u4Src).toContain('g.current.pad = pad;');
    expect(u4Src).toContain("const pad = tilePad({ sim, charging: !!a0?.charging, job: a0?.maint ? { kind: 'maint', text: '' } : null });");
  });
});
