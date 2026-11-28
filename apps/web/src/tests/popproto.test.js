// @vitest-environment node
// 시안 밖 · 새로 그림(머리줄 종 · 「나」 차림 · 결과 띠 · 정지 고르기 뒤 가림): 어둠 판 = 짙은 칸 · 흰 글, 밝은 판 = 밝음 1 값만
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(__dirname, '../proto/frame.pv.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1].trim(), m[2]]);
const last = (sel, prop) => { let v; for (const [s, b] of rules) if (s.split(',').map((x) => x.trim()).includes(sel)) { const m = b.match(new RegExp(`(?:^|;)${prop}:([^;]+)`)); if (m) v = m[1]; } return v; };
describe('머리줄 펼침 · 띠 꼴', () => {
  it('어둠 판: 종 칸 · 차림은 짙은 바탕 · 흰 글(흰 유리 아님)', () => {
    for (const sel of ['.proto .bar .ap-menu', '.proto .bar details.ap-bell>.card']) {
      expect(last(sel, 'background')).toContain('rgba(12,15,20,.95)');
      expect(last(sel, 'color')).toBe('#fff');
    }
  });
  it('밝은 판: 흰 판 · #DCE0DE 선 · 흑연 글, 밝은 규칙 색은 밝음 1 값뿐', () => {
    expect(last('.proto.light .bar details.ap-bell>.card', 'background')).toBe('#FFFFFF!important');
    expect(last('.proto.light .bar .ap-menu', 'color')).toBe('#1F2421');
    const TABLE = new Set(['#F6F7F6', '#FFFFFF', '#1F2421', '#5E6662', '#DCE0DE', '#18A07E', '#0E7F63', '#E04A2F', '#B8361F', '#2F6FE0', '#D9A21F']);
    const RGB = new Set(['246,247,246', '255,255,255', '31,36,33', '94,102,98', '24,160,126', '224,74,47', '217,162,31']);
    for (const [s, b] of rules.filter(([s]) => s.includes('.proto.light'))) {
      for (const h of b.match(/#[0-9A-Fa-f]{6}\b/g) ?? []) expect(TABLE.has(h.toUpperCase()), `${s} ${h}`).toBe(true);
      for (const r of b.matchAll(/rgba\((\d+),(\d+),(\d+),/g)) expect(RGB.has(`${r[1]},${r[2]},${r[3]}`), s).toBe(true);
    }
  });
  it('정지 고르기 뒤 = 시안 u11 .veil(어둡게 + 흐림) · 누름은 막지 않음(창 동작 그대로)', () => {
    const v = rules.find(([s]) => s === '.proto>.fh.ap-in:has(>.fh-pick)::before')[1];
    expect(v).toContain('background:rgba(8,10,14,.45)');
    expect(v).toContain('backdrop-filter:blur(10px)');
    expect(v).toContain('pointer-events:none');
  });
});
