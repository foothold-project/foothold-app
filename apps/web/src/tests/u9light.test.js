// @vitest-environment node
// 설정 u9 밝은 판: 조이스틱 · 폰 터치 그림의 흰 선 · 흰 채움을 밝은 판에서 바꾸는 규칙이 있고, 밝은 규칙 색은 DESIGN.md 밝음 1 값뿐
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(__dirname, '../screens/settingsu9.app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const light = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[1].includes('.proto.light.u9'));
describe('설정 u9 밝은 판', () => {
  it('그림의 흰 선 · 흰 채움 · 어둠 판 민트 · 빨강을 밝은 판 값으로 바꾸는 규칙', () => {
    const sel = light.map((m) => m[1]).join('\n');
    for (const s of ['[stroke^="rgba(255,255,255"]', '[fill^="rgba(255,255,255"]', '[stroke="#00c389"]', '[fill="#ff4d4f"]']) expect(sel).toContain(s);
  });
  it('밝은 규칙 값은 밝음 1 표 색뿐', () => {
    const TABLE = new Set(['#F6F7F6', '#FFFFFF', '#1F2421', '#5E6662', '#DCE0DE', '#18A07E', '#0E7F63', '#E04A2F', '#B8361F', '#2F6FE0', '#D9A21F']);
    const RGB = new Set(['246,247,246', '255,255,255', '31,36,33', '94,102,98', '24,160,126', '224,74,47', '217,162,31']);
    for (const [, , body] of light) {
      for (const h of body.match(/#[0-9A-Fa-f]{6}\b/g) ?? []) expect(TABLE.has(h.toUpperCase())).toBe(true);
      for (const r of body.matchAll(/rgba\((\d+),(\d+),(\d+),/g)) expect(RGB.has(`${r[1]},${r[2]},${r[3]}`)).toBe(true);
    }
  });
});
