// 충전 · 점검 바닥 표시 위로 오르는 층(팀장 11-29 01:37): 층 크기 · 박 단계 · 움직임 줄이기 · 관제 타일과 로봇 탭이 같은 함수
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { PAD_BEATS, PAD_PLAN, PAD_PLANS, PAD_RISE, PAD_TOP, PAD_TOP_C, padGroup, padPlan, padRise, padStep, padTick } from '../proto/padanim';
import tileSrc from '../proto/tileview.ts?raw';
import go2Src from '../screens/u4/go2view.ts?raw';

const layers = (g: THREE.Object3D) => g.getObjectByName('rise')!.children;
const shown = (g: THREE.Object3D) => layers(g).filter((l) => l.visible).length;

describe('바닥 표시 오르는 층', () => {
  it('기본은 확정 안 C = 11 층 · 꼭대기 0.40 m(몸까지) · 크기 0.90 · 진하기 0.5 → 0.18 · 회색 줄 · 박 0.24 s (팀장 03:14)', () => {
    expect(PAD_PLAN).toBe('C'); expect(PAD_PLANS).toEqual({ A: 5, B: 7, C: 11 });
    expect(PAD_RISE.scale.length).toBe(12); expect(PAD_RISE.scale[11]).toBeCloseTo(0.9, 9);
    expect(PAD_RISE.dy * 11).toBeCloseTo(PAD_TOP_C.dy, 9); expect(PAD_RISE.dy).toBeLessThanOrEqual(padRise(7).dy + 1e-3);   // B 만큼 촘촘
    expect(PAD_RISE.op[1]).toBeCloseTo(0.5, 9); expect(PAD_RISE.op[11]).toBeCloseTo(0.18, 9);
    expect(PAD_RISE.desat).toBe(1); expect(PAD_RISE.beat).toBe(0.24);
    for (const kind of ['charge', 'check'] as const) {
      const ls = layers(padGroup(kind)); expect(ls.length).toBe(11);
      expect(((ls[0].children[0] as THREE.LineLoop).material as THREE.LineBasicMaterial).color.getHex()).toBe(PAD_RISE.grey);
    }
    // 안 A 는 옛 값 그대로(5 층 · 0.05 m 간격)
    const a = padRise(PAD_PLANS.A); [1, 0.98, 0.96, 0.94, 0.92, 0.9].forEach((v, i) => expect(a.scale[i]).toBeCloseTo(v, 9)); expect(a.dy).toBeCloseTo(0.05, 9);
  });

  it('안 B = 7 층 · 꼭대기 높이(0.25 m) · 꼭대기 크기(0.90)는 A 와 같고 더 촘촘 · 진하기는 오를수록 낮음', () => {
    const top = (g: THREE.Object3D) => { const ls = layers(g), l = ls[ls.length - 1]; return [ls.length, l.position.y, l.scale.x]; };
    for (const kind of ['charge', 'check'] as const) {
      const [na, ya, sa] = top(padGroup(kind, false, { ...PAD_RISE, ...padRise(PAD_PLANS.A) }));
      const [nb, yb, sb] = top(padGroup(kind, false, { ...PAD_RISE, ...padRise(PAD_PLANS.B) }));
      expect([na, nb]).toEqual([5, 7]);
      expect(ya).toBeCloseTo(PAD_TOP.dy, 9); expect(yb).toBeCloseTo(PAD_TOP.dy, 9);
      expect(sa).toBeCloseTo(0.9, 9); expect(sb).toBeCloseTo(0.9, 9);
      expect(padRise(7).dy).toBeLessThan(padRise(5).dy);
      const op = padRise(7).op.slice(1); op.slice(1).forEach((v, i) => expect(v).toBeLessThan(op[i]));
    }
    // B 도 한 바퀴 = 바닥 + 7 박
    const g = padGroup('check', false, { ...PAD_RISE, ...padRise(7) });
    padTick(g, 7.5 * PAD_RISE.beat, false); expect(shown(g)).toBe(7);
    padTick(g, 8.5 * PAD_RISE.beat, false); expect(shown(g)).toBe(0);
    padTick(g, 7.5 * PAD_RISE.beat, true); expect(shown(g)).toBe(0);
  });

  it('주소 값 ?pad=B (또는 #… ?pad=B) 로 안을 덮어씀 · 다른 값 · 없음은 PAD_PLAN', () => {
    const at = (u: string) => { history.replaceState(null, '', u); return padPlan(); };
    expect(at('/?pad=B')).toBe('B'); expect(at('/#/fleet?pad=B')).toBe('B'); expect(at('/#/control?pad=A')).toBe('A');
    expect(at('/?pad=D')).toBe(PAD_PLAN); expect(at('/#/control')).toBe(PAD_PLAN);
  });

  it('층마다 원 중심 기준으로 작아지며 위로 · 진하기는 오를수록 낮음 · 낮은 채도', () => {
    for (const kind of ['charge', 'check'] as const) {
      const g = padGroup(kind), ls = layers(g);
      ls.forEach((l, i) => {
        expect(l.scale.x).toBe(PAD_RISE.scale[i + 1]); expect(l.scale.z).toBe(PAD_RISE.scale[i + 1]); expect(l.position.x).toBe(0); expect(l.position.z).toBe(0);
        expect(l.position.y).toBeCloseTo(PAD_RISE.dy * (i + 1), 9);
        expect(l.children.length).toBe(2);   // 바닥과 같은 꼴 둘
      });
      const op = ls.map((l) => ((l.children[0] as THREE.LineLoop).material as THREE.LineBasicMaterial).opacity);
      op.slice(1).forEach((v, i) => expect(v).toBeLessThan(op[i]));
      // 낮은 채도: 바닥 색보다 회색 쪽
      const base = new THREE.Color(((g.children[0] as THREE.LineLoop).material as THREE.LineBasicMaterial).color), up = ((ls[0].children[0] as THREE.LineLoop).material as THREE.LineBasicMaterial).color;
      expect(up.getHSL({ h: 0, s: 0, l: 0 }).s).toBeLessThan(base.getHSL({ h: 0, s: 0, l: 0 }).s);
    }
  });

  it('박 단계: 한 박마다 한 층씩 끊어서(0 → 1 → … → 11 → 다시 0) · 박 안에서는 그대로', () => {
    const b = PAD_RISE.beat;
    expect(PAD_BEATS).toBe(12);
    expect([0, 0.5, 1.5, 2.5, 5.5, 11.5, 12.5].map((k) => padStep(k * b))).toEqual([0, 0, 1, 2, 5, 11, 0]);
    expect(padStep(b * 1.01)).toBe(padStep(b * 1.99));   // 이음 없이 계단
    const g = padGroup('charge');
    padTick(g, 2.5 * b, false); expect(shown(g)).toBe(2); expect(layers(g)[0].visible && layers(g)[1].visible && !layers(g)[2].visible).toBe(true);
    padTick(g, 3.5 * b, false); expect(shown(g)).toBe(3);
    padTick(g, 11.5 * b, false); expect(shown(g)).toBe(11);
    padTick(g, 12.5 * b, false); expect(shown(g)).toBe(0);
  });

  it('밝은 판 색 = 밝음 1 (충전 #18A07E · 점검 #5E6662) · 오른 층도 그 색에서 회색 쪽', () => {
    const col = (g: THREE.Object3D) => ((g.children[0] as THREE.LineLoop).material as THREE.LineBasicMaterial).color.getHex();
    expect(col(padGroup('charge', true))).toBe(0x18a07e); expect(col(padGroup('check', true))).toBe(0x5e6662); expect(col(padGroup('check'))).toBe(0xa9b8c6);
    expect(col(layers(padGroup('check', true))[0])).not.toBe(0x5e6662);
  });

  it('움직임 줄이기면 바닥 꼴만(오른 층 없음 · 바닥 둘은 그대로)', () => {
    const g = padGroup('check');
    padTick(g, 5.5 * PAD_RISE.beat, true);
    expect(shown(g)).toBe(0); expect(g.children[0].visible && g.children[1].visible).toBe(true);
  });

  it('관제 타일 · 로봇 탭 큰 무대가 같은 함수(padGroup · padTick) · 로봇 탭 padMesh = padGroup 한 줄', () => {
    expect(tileSrc).toContain("import { padGroup, padTick } from './padanim';");
    expect(tileSrc).toContain('padTick(this.pads[+light][look.pad], this.t)');
    // 관제 타일도 밝은 판이면 밝음 1 색(점검 #5E6662) 바닥 표시를 고름
    expect(tileSrc).toContain("this.pads = [false, true].map((l) => ({ charge: padGroup('charge', l), check: padGroup('check', l) }));");
    expect(tileSrc).toContain("i === +light");
    const lightCheck = padGroup('check', true);
    expect(((lightCheck.children[0] as THREE.LineLoop).material as THREE.LineBasicMaterial).color.getHex()).toBe(0x5e6662);
    expect(go2Src).toContain("import { padGroup, padTick } from '../../proto/padanim';");
    expect(go2Src).toContain("export const padMesh = (kind: PadKind, light = false): THREE.Group => padGroup(kind === 'maint' ? 'check' : kind, light);");
    expect(go2Src).toContain('if (padG) padTick(padG, t);');
  });
});
