// @vitest-environment node
// 시안 공통의 밝은 판(light.pv.css): 쓰는 색이 모두 DESIGN.md 「밝음 1」 표(또는 시안 ui.css 밝은 유리 .g) 값이고, 자리마다 표의 역할 값
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// DESIGN.md(foothold-brand app-tone-1126) 밝음 1 표. 저장소 밖 정본이라 값을 여기 옮겨 두고, 정본이 있는 기기에서는 같은지도 본다
const LIGHT = { background: '#F6F7F6', surface: '#FFFFFF', 'on-surface': '#1F2421', 'on-surface-muted': '#5E6662', outline: '#DCE0DE',
  primary: '#18A07E', 'on-primary': '#1F2421', 'primary-text': '#0E7F63', danger: '#E04A2F', 'danger-text': '#B8361F', 'on-danger': '#FFFFFF', sim: '#2F6FE0' };
const DESIGN = '/home/jay/mai/wt/foothold-brand/app-tone-1126/DESIGN.md';
const css = readFileSync(join(__dirname, '..', 'proto', 'light.pv.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1].trim(), Object.fromEntries(m[2].split(';').filter((d) => d.includes(':')).map((d) => { const i = d.indexOf(':'); return [d.slice(0, i).trim(), d.slice(i + 1).trim()]; }))]);
const decl = (sel) => rules.find(([s]) => s === sel)?.[1] ?? {};
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)].join(',');

describe('시안 밝은 판 light.pv.css', () => {
  it('모든 규칙이 .pv.light 아래', () => {
    expect(rules.length).toBeGreaterThan(10);
    for (const [s] of rules) for (const one of s.split(',')) expect(one.trim().startsWith('.pv.light'), one).toBe(true);
  });
  it('쓰는 #색은 모두 밝음 1 표 값, rgba 색도 표 값(또는 흰색 · 시안 유리 그림자)에서 나온 것', () => {
    const table = new Set(Object.values(LIGHT));
    for (const h of css.match(/#[0-9A-Fa-f]{6}\b/g)) expect(table.has(h.toUpperCase()), h).toBe(true);
    const rgb = new Set([...Object.values(LIGHT).map(hex), '255,255,255', '20,30,50', '0,0,0']);
    for (const m of css.matchAll(/rgba\((\d+),(\d+),(\d+),/g)) expect(rgb.has(`${m[1]},${m[2]},${m[3]}`), m[0]).toBe(true);
  });
  it('자리마다 역할 값: 바탕 · 글자 · 흐린 글자 · 선 · 강조 글자 · 칸 · 주 단추(그라파이트 글자) · 경고 · 예행', () => {
    expect(decl('.pv.light')).toMatchObject({ background: LIGHT.background, color: LIGHT['on-surface'], '--mu2': LIGHT['on-surface-muted'], '--line': LIGHT.outline, '--pr3': LIGHT['primary-text'], '--pr': LIGHT.primary, '--red': LIGHT.danger });
    expect(decl('.pv.light .pane')).toMatchObject({ background: LIGHT.surface, 'border-color': LIGHT.outline });
    expect(decl('.pv.light .btnp')).toMatchObject({ background: LIGHT.primary, color: LIGHT['on-primary'] });
    expect(decl('.pv.light .allstop')).toMatchObject({ background: LIGHT.danger, color: LIGHT['on-danger'] });
    expect(decl('.pv.light .warntag')).toMatchObject({ background: LIGHT['danger-text'], color: '#FFFFFF' });
    expect(decl('.pv.light .rehearse').border).toBe(`1px dashed ${LIGHT.sim}`);
    expect(decl('.pv.light .tabs span.on').color).toBe(LIGHT['primary-text']);   // 민트 #18A07E 는 글자에 쓰지 않는다(대비 3.07)
  });
  it('밝은 유리 .g.dk = 시안 ui.css .g 값 그대로', () => {
    const ui = readFileSync(join(__dirname, '..', 'proto', 'ui.css'), 'utf8');
    const g = /\.g\{([^}]*)\}/.exec(ui)[1];
    const d = decl('.pv.light .g.dk');
    for (const k of ['background', 'border', 'box-shadow']) expect(g.replace(/\s+/g, ' ')).toContain(`${k}:${d[k]}`);
  });
  it.skipIf(!existsSync(DESIGN))('옮겨 둔 표 = DESIGN.md 정본 값', () => {
    const md = readFileSync(DESIGN, 'utf8');
    for (const [k, v] of Object.entries(LIGHT)) expect(md, k).toContain(`  ${k}: "${v}"`);
  });
});
