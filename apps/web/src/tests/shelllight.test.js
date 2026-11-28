// @vitest-environment node
// 껍데기 밝은 판(shell.css html .fh.light) 값이 정본 DESIGN.md 「밝음 1」 표 값뿐인지 · 바깥 바탕 · 민트 단추 글자 대비
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(__dirname, '../shell.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const block = (sel) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((m) => m[1].trim() === sel)?.[2] ?? '';
const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

describe('껍데기 밝은 판 = DESIGN.md 밝음 1', () => {
  const light = block('html .fh.light');
  it('색은 밝음 1 표 값뿐 · 옛 토큰(var(--paper) 등) 없음', () => {
    const TABLE = new Set(['#F6F7F6', '#FFFFFF', '#1F2421', '#5E6662', '#DCE0DE', '#18A07E', '#0E7F63']);
    const RGB = new Set(['255,255,255', '24,160,126', '31,36,33']);
    expect(light).not.toMatch(/var\(--/);
    for (const h of light.match(/#[0-9A-Fa-f]{6}/g)) expect(TABLE.has(h.toUpperCase())).toBe(true);
    for (const m of light.matchAll(/rgba\((\d+),(\d+),(\d+),/g)) expect(RGB.has(`${m[1]},${m[2]},${m[3]}`)).toBe(true);
  });
  it('바깥 바탕 · body = #F6F7F6 (무대 양옆 띠와 같은 값)', () => {
    expect(light).toMatch(/--sh-bg: #F6F7F6;/);
    expect(css).toMatch(/body:has\(\.fh\.light\) \{ background: #F6F7F6; \}/);
  });
  it('민트 단추 #18A07E 위 글자 흑연 4.5:1 이상', () => {
    const on = light.match(/--sh-on-pr: (#[0-9a-fA-F]{6})/)[1];
    expect(on.toLowerCase()).toBe('#1f2421');
    expect(ratio('#18a07e', on.toLowerCase())).toBeGreaterThanOrEqual(4.5);
  });
});
