// @vitest-environment node
// 지도 탭 밝은 판(mapscen.css 의 .fh.light 줄) 색이 정본 foothold-brand app-tone-1126 DESIGN.md 「밝음 1」 표 값뿐인지 본다(옛 브랜드 종이 · 잉크 · 청록 토큰 아님)
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
describe('지도 탭 밝은 판 = DESIGN.md 밝음 1', () => {
  const TABLE = new Set(['#F6F7F6', '#FFFFFF', '#1F2421', '#5E6662', '#DCE0DE', '#18A07E', '#0E7F63', '#E04A2F', '#B8361F', '#2F6FE0', '#D9A21F']);
  const RGB = new Set(['246,247,246', '255,255,255', '31,36,33', '24,160,126', '224,74,47', '217,162,31']);
  it('mapscen.css', () => {
    const css = readFileSync(join(__dirname, '..', 'screens', 'mapscen.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[1].includes('.fh.light'));
    expect(rules.length).toBeGreaterThan(0);
    for (const m of rules) {
      for (const h of m[2].match(/#[0-9A-Fa-f]{3,8}\b/g) ?? []) expect(TABLE.has(h.toUpperCase()), `${m[1].trim()} ${h}`).toBe(true);
      for (const r of m[2].matchAll(/rgba?\((\d+),\s*(\d+),\s*(\d+)/g)) expect(RGB.has(`${r[1]},${r[2]},${r[3]}`), `${m[1].trim()} ${r[0]}`).toBe(true);
      expect(m[2], m[1]).not.toMatch(/var\(--(paper|ink|brand|rule|card|dim)/);
    }
    // 앱 공통 토큰을 모두 밝음 1 로 덮는다(빠지면 옛 브랜드 값이 새어 나옴)
    const all = rules.map((m) => m[2]).join(';');
    for (const k of ['--bg', '--panel', '--text', '--muted', '--line', '--accent', '--sh-pr3', '--sh-on-pr', '--paper', '--ink', '--rule']) expect(all, k).toMatch(new RegExp(`${k}:`));
  });
  it('u7_1 미리 보기 아래 글 받침: 밝은 판 = 흰색으로 옅어짐(어두운 띠 아님) · 제목 · 메타 · 버전 기록 = 밝음 1 글자', () => {
    const css = readFileSync(join(__dirname, '..', 'screens', 'u7', 'u7.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const at = (sel) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((m) => m[1].trim() === sel)?.[2] ?? '';
    expect(at('.proto.light .u7 .pv-fade')).toMatch(/rgba\(255,255,255,\.94\)/); expect(at('.proto.light .u7 .pv-fade')).not.toMatch(/12,15,20/);
    expect(at('.proto.light .u7 .pv-ttl')).toBe('color:#1F2421'); expect(at('.proto.light .u7 .pv-meta')).toBe('color:#5E6662');
    expect(at('.proto.light .u7 .pv-hist')).toMatch(/color:#1F2421/);
  });
  it('u7_1 층 겹친 그림 밝은 판: 면 · 선 · 글자가 흰 칸 위에 보이는 밝음 1 값(흰 선 · 흰 면 아님), 고른 층 = 민트', () => {
    const css = readFileSync(join(__dirname, '..', 'screens', 'u7', 'u7.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const at = (sel) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((m) => m[1].split(',').map((x) => x.trim()).includes(sel))?.[2] ?? '';
    for (const k of ['sk-l', 'sk-r', 'sk-t']) expect(at(`.proto.light .u7 .sk .${k}`), k).toMatch(/stroke:#5E6662/);
    expect(at('.proto.light .u7 .sk .sk-tx')).toBe('fill:#5E6662');
    expect(at('.proto.light .u7 .sk.on .sk-t')).toMatch(/fill:#18A07E/); expect(at('.proto.light .u7 .sk.on .sk-tx')).toBe('fill:#0E7F63');
  });
  it('u7_1 층 줄 썸네일 = 칸 바탕 위 선 그림: 어둠 = 반전 + screen, 밝음 = multiply(판 그림 원본은 그대로) · 틀 = 칸 바탕 하나', () => {
    const css = readFileSync(join(__dirname, '..', 'screens', 'u7', 'u7.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const at = (sel) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((m) => m[1].trim() === sel)?.[2] ?? '';
    expect(at('.u7 .frow .th .mx-thumb image')).toBe('filter:invert(1);mix-blend-mode:screen');
    expect(at('.proto.light .u7 .frow .th .mx-thumb image')).toBe('filter:none;mix-blend-mode:multiply');
    expect(at('.u7 .frow .th .mx-thumb')).toMatch(/background:transparent/);
  });
  it('u7.css 밝은 판(시안 u7_1 · u7_2 현장 · 층 줄 · 꼬리표)', () => {
    const css = readFileSync(join(__dirname, '..', 'screens', 'u7', 'u7.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[1].includes('.proto.light'));
    expect(rules.map((m) => m[1].trim())).toEqual(expect.arrayContaining(['.proto.light .u7 .site .av', '.proto.light .u7 .tag', '.proto.light .u7 .tag.m']));
    for (const m of rules) {
      for (const h of m[2].match(/#[0-9A-Fa-f]{3,8}\b/g) ?? []) expect(TABLE.has(h.toUpperCase()), `${m[1].trim()} ${h}`).toBe(true);
      for (const r of m[2].matchAll(/rgba?\((\d+),\s*(\d+),\s*(\d+)/g)) expect(RGB.has(`${r[1]},${r[2]},${r[3]}`), `${m[1].trim()} ${r[0]}`).toBe(true);
    }
  });
});
