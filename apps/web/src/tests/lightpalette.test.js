// @vitest-environment node
// 밝은 판 색(u11.css · login.css 의 밝은 규칙)이 정본 foothold-brand app-tone-1126 DESIGN.md 「밝음 1」 표 값뿐인지 본다. 옛 브랜드 토큰(종이 · 잉크 · 청록) 아님
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
describe('밝은 판 색 = DESIGN.md 밝음 1 (u11.css · login.css 의 밝은 규칙)', () => {
  const TABLE = new Set(['#F6F7F6', '#FFFFFF', '#1F2421', '#5E6662', '#DCE0DE', '#18A07E', '#0E7F63', '#E04A2F', '#B8361F', '#2F6FE0', '#D9A21F']);
  const RGB = new Set(['246,247,246', '255,255,255', '31,36,33', '24,160,126', '224,74,47', '217,162,31']);
  for (const [file, light] of [['../proto/u11.css', '.proto.light'], ['../login.css', '.fh.lg.light']]) it(file, () => {
    const css = readFileSync(join(__dirname, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[1].includes(light));
    expect(rules.length).toBeGreaterThan(5);
    for (const m of rules) {
      for (const h of m[2].match(/#[0-9A-Fa-f]{6}\b/g) ?? []) expect(TABLE.has(h.toUpperCase()), `${m[1].trim()} ${h}`).toBe(true);
      for (const r of m[2].matchAll(/rgba\((\d+),\s*(\d+),\s*(\d+),/g)) expect(RGB.has(`${r[1]},${r[2]},${r[3]}`), `${m[1].trim()} ${r[0]}`).toBe(true);
      expect(m[2], m[1]).not.toMatch(/var\(--(paper|ink|brand|rule|card)/);   // 옛 브랜드 토큰(종이 · 잉크 · 청록) 아님
    }
  });
});
