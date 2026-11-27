// 밝은 판(u11) · 폰 조종 화면: 영상이 없을 때 영상 칸 · 페이지 바탕은 테마 토큰(밝음에서 어두운 고정색이 아님),
// 영상 위 판 단추(«조종 끝내기» 등)는 판 색 · 글자 색을 함께 고정(밝음 .btn 바탕 위 흰 글자 = 안 보임), STOP 은 두 테마 4.5:1 이상.
import { describe, expect, it } from 'vitest';
import drive from '../drive.css?raw';
import frame from '../frame.css?raw';
import brand from '../brand.css?raw';

/** 한 규칙의 본문(선택자 그대로 일치하는 첫 규칙) */
const rule = (css: string, sel: string) => {
  const i = css.split('\n').map((l) => l.trim()).find((l) => l.startsWith(sel + '{'));
  return i ? i.slice(sel.length + 1, i.lastIndexOf('}')) : null;
};
const hex = (h: string) => { const v = h.replace('#', ''); return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16)); };
const lum = ([r, g, b]: number[]) => { const f = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const ratio = (a: number[], b: number[]) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const over = (fg: number[], a: number, bg: number[]) => fg.map((c, i) => c * a + bg[i] * (1 - a));
const token = (css: string, scope: RegExp, name: string) => { const m = css.match(scope)?.[0].match(new RegExp(`${name}:(#[0-9A-Fa-f]{6})`)); return m ? hex(m[1]) : null; };

describe('폰 조종 화면 · 밝은 판', () => {
  it('밝음: 영상 칸 · 영상 없음 칸 · 페이지 바탕은 토큰(var(--…))', () => {
    expect(rule(drive, '.fh.light .dv-stage')).toMatch(/background:var\(--/);
    expect(rule(drive, '.fh.light .dv-video')).toMatch(/background:var\(--[^)]*\);color:var\(--/);
    expect(rule(drive, 'html:has(.fh.light .dv.ph),.fh.light:has(.dv.ph)')).toMatch(/^background:var\(--/);
  });
  it('어두움 값은 그대로(영상 칸 #05080A)', () => {
    expect(rule(drive, '.dv-stage')).toContain('background:#05080A');
    expect(rule(drive, 'html:has(.dv.ph),.fh:has(.dv.ph)')).toBe('background:#05080A');
  });
  it('영상 위 판의 보통 단추(«조종 끝내기»)는 판 색 + 밝은 글자를 함께 · 글자 대비 4.5:1 이상(밝은 바탕 위에서도)', () => {
    const r = rule(drive, '.dv-hud .btn:not(.pri)');
    expect(r).toMatch(/background:rgba\(8,11,14,\.66\)/);
    expect(r).toMatch(/color:#E6EBEF/);
    const light = token(frame, /\.fh\.light\{[^}]*\}/, '--panel2')!;   // 영상 없을 때 밝음 바탕
    const plate = over([8, 11, 14], 0.66, light);
    expect(ratio(hex('#E6EBEF'), plate)).toBeGreaterThanOrEqual(4.5);
  });
  it('밝음: 조이스틱 글자(«전후» · «회전»)도 밝은 영상 칸 위에서 4.5:1 이상', () => {
    const light = token(frame, /\.fh\.light\{[^}]*\}/, '--panel2')!;
    const a = Number((rule(drive, '.fh.light .dv-stick') ?? '').match(/background:rgba\(8,11,14,(\.\d+)\)/)?.[1] ?? rule(drive, '.dv-stick')!.match(/background:rgba\(8,11,14,(\.\d+)\)/)![1]);
    expect(ratio(hex('#E6EBEF'), over([8, 11, 14], a, light))).toBeGreaterThanOrEqual(4.5);
  });
  it('STOP: 채움 · 글자는 두 테마 같은 고정 쌍, 대비 4.5:1 이상(테마가 STOP 채움을 덮지 않음)', () => {
    const r = rule(frame, '.fh-stop')!;
    const bg = hex(r.match(/background:(#[0-9a-fA-F]{6})/)![1]), fg = hex(r.match(/;color:(#[0-9a-fA-F]{6})/)![1]);
    expect(ratio(fg, bg)).toBeGreaterThanOrEqual(4.5);
    expect(brand + drive).not.toMatch(/\.fh-stop[^{]*\{[^}]*background/);
  });
});
