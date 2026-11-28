// @vitest-environment node
// 로봇 탭 u4 밝은 판(u4.css 의 .proto.light 규칙) 색이 정본 DESIGN.md 「밝음 1」 표 값뿐인지 · 흰 칸 위 동작 글자가 흰 글자가 아닌지 본다
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
describe('로봇 탭 u4 밝은 판 = DESIGN.md 밝음 1', () => {
  const TABLE = new Set(['#F6F7F6', '#FFFFFF', '#1F2421', '#5E6662', '#DCE0DE', '#18A07E', '#0E7F63', '#E04A2F', '#B8361F', '#2F6FE0', '#D9A21F']);
  const RGB = new Set(['246,247,246', '255,255,255', '31,36,33', '24,160,126', '224,74,47', '217,162,31']);
  const css = readFileSync(join(__dirname, '..', 'screens', 'u4', 'u4.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[1].includes('.proto.light'));
  it('표 값만 · 옛 브랜드 토큰 없음', () => {
    expect(rules.length).toBeGreaterThan(3);
    for (const m of rules) {
      for (const h of m[2].match(/#[0-9A-Fa-f]{3,8}\b/g) ?? []) expect(TABLE.has(h.toUpperCase()), `${m[1].trim()} ${h}`).toBe(true);
      for (const r of m[2].matchAll(/rgba?\((\d+),\s*(\d+),\s*(\d+)/g)) expect(RGB.has(`${r[1]},${r[2]},${r[3]}`), `${m[1].trim()} ${r[0]}`).toBe(true);
      expect(m[2], m[1]).not.toMatch(/var\(--(paper|ink|brand|rule|card|dim)/);
    }
  });
  it('흰 칸 위 동작 단추 글자 = 글자색(흰 글자 · 그림자 아님), 3D 무대 위 띠 = 어두운 유리 + 흰 글자', () => {
    const at = (sel) => rules.find((m) => m[1].split(',').map((x) => x.trim()).includes(sel))?.[2] ?? '';
    expect(at('.proto.light .u4 .act div')).toMatch(/color:#1F2421/);
    expect(at('.proto.light .u4 .stage3d .g.dk')).toMatch(/rgba\(31,36,33,\.62\)/);
    expect(at('.proto.light .u4 .stage3d .g.dk')).toMatch(/color:#FFFFFF/);
  });
});
