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
  it('모든 규칙이 .proto.light 아래', () => {
    expect(rules.length).toBeGreaterThan(10);
    for (const [s] of rules) for (const one of s.split(',')) expect(one.trim().startsWith('.proto.light'), one).toBe(true);
  });
  it('쓰는 #색은 모두 밝음 1 표 값, rgba 색도 표 값(또는 흰색 · 시안 유리 그림자)에서 나온 것', () => {
    const table = new Set(Object.values(LIGHT));
    for (const h of css.match(/#[0-9A-Fa-f]{6}\b/g)) expect(table.has(h.toUpperCase()), h).toBe(true);
    const rgb = new Set([...Object.values(LIGHT).map(hex), '255,255,255', '20,30,50', '0,0,0']);
    for (const m of css.matchAll(/rgba\((\d+),(\d+),(\d+),/g)) expect(rgb.has(`${m[1]},${m[2]},${m[3]}`), m[0]).toBe(true);
  });
  it('자리마다 역할 값: 바탕 · 글자 · 흐린 글자 · 선 · 강조 글자 · 칸 · 주 단추(그라파이트 글자) · 경고 · 예행', () => {
    expect(decl('.proto.light')).toMatchObject({ background: LIGHT.background, color: LIGHT['on-surface'], '--mu2': LIGHT['on-surface-muted'], '--line': LIGHT.outline, '--pr3': LIGHT['primary-text'], '--pr': LIGHT.primary, '--red': LIGHT.danger });
    expect(decl('.proto.light .pane')).toMatchObject({ background: LIGHT.surface, 'border-color': LIGHT.outline });
    expect(decl('.proto.light .btnp')).toMatchObject({ background: LIGHT.primary, color: LIGHT['on-primary'] });
    expect(decl('.proto.light .allstop')).toMatchObject({ background: LIGHT['danger-text'], color: LIGHT['on-danger'] });
    expect(decl('.proto.light .warntag')).toMatchObject({ background: LIGHT['danger-text'], color: '#FFFFFF' });
    expect(decl('.proto.light .rehearse').border).toBe(`1px dashed ${LIGHT.sim}`);
    expect(decl('.proto.light .tabs span.on').color).toBe(LIGHT['primary-text']);   // 민트 #18A07E 는 글자에 쓰지 않는다(대비 3.07)
  });
  it('정지 단추(.stop · .allstop) 글자 대비: 18.66 px 굵게 이상이면 3.0, 아니면 4.5 이상', () => {
    const lum = (h) => { const c = hex(h).split(',').map((v) => { const x = +v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    const src = readFileSync(join(__dirname, '..', 'proto', 'ui.css'), 'utf8') + readFileSync(join(__dirname, '..', 'proto', 'pc.css'), 'utf8');
    for (const cls of ['stop', 'allstop']) {
      const base = new RegExp(`\\.${cls}\\{([^}]*)\\}`).exec(src)[1];
      const px = parseFloat(/font-size:([\d.]+)px/.exec(base)[1]), w = +/font-weight:(\d+)/.exec(base)[1];
      const large = px >= 18.66 && w >= 700, d = decl(`.proto.light .${cls}`);
      expect(ratio(d.background, d.color), `${cls} ${px}px ${w}`).toBeGreaterThanOrEqual(large ? 3 : 4.5);
    }
  });
  it('어둠 판 상태 표지(dark.pv.css): 경고 칸 #FF4D4F 12 % · 「과열」 #FF4D4F 바탕 검은 글자 · 예행 #4C9BFF 점선', () => {
    const dk = readFileSync(join(__dirname, '..', 'proto', 'dark.pv.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const r = Object.fromEntries([...dk.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1].trim(), m[2]]));
    expect(Object.keys(r)).toEqual(['.proto .warncell', '.proto .warntag', '.proto .rehearse']);
    expect(r['.proto .warncell']).toBe('background:rgba(255,77,79,.12);border:1px solid #FF4D4F');
    expect(r['.proto .warntag']).toBe('background:#FF4D4F;color:#000000');
    expect(r['.proto .rehearse']).toBe('border:1px dashed #4C9BFF;color:#4C9BFF');
    if (existsSync(DESIGN)) { const md = readFileSync(DESIGN, 'utf8'); expect(md).toContain('dark-danger: "#FF4D4F"'); expect(md).toContain('dark-sim: "#4C9BFF"'); }
  });
  it('밝은 유리 .g.dk = 시안 ui.css .g 값 그대로', () => {
    const ui = readFileSync(join(__dirname, '..', 'proto', 'ui.css'), 'utf8');
    const g = /\.g\{([^}]*)\}/.exec(ui)[1];
    const d = decl('.proto.light .g.dk');
    for (const k of ['background', 'border', 'box-shadow']) expect(g.replace(/\s+/g, ' ')).toContain(`${k}:${d[k]}`);
  });
  it.skipIf(!existsSync(DESIGN))('옮겨 둔 표 = DESIGN.md 정본 값', () => {
    const md = readFileSync(DESIGN, 'utf8');
    for (const [k, v] of Object.entries(LIGHT)) expect(md, k).toContain(`  ${k}: "${v}"`);
  });
});

describe('관제 u5 밝은 판(u5.css 의 .proto.light .u5 규칙)', () => {
  const u5 = readFileSync(join(__dirname, '..', 'proto', 'u5.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const light = [...u5.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[1].trim().startsWith('.proto.light'));
  it('밝은 규칙의 #색은 밝음 1 표 값(온도 주의 채움 #D9A21F 포함), 어둠 색(#ff4d4f · #f2b705 · #00c389 · 흰 78 %)은 없음', () => {
    expect(light.length).toBeGreaterThan(20);
    const ok = new Set([...Object.values(LIGHT), '#D9A21F']);
    for (const m of light) for (const h of m[2].match(/#[0-9A-Fa-f]{6}\b/g) ?? []) expect(ok.has(h.toUpperCase()), `${m[1]} ${h}`).toBe(true);
    const body = light.map((m) => m[2]).join(';').toLowerCase();
    for (const dark of ['#ff4d4f', '#f2b705', '#00c389', '232,235,240']) expect(body, dark).not.toContain(dark);
  });
  it('글자 칸: 수 칸 · 타일 줄 · 모드 = 흐린 글자, 수 = 글자, 위험 수치 = 경고 글자', () => {
    const d = (sel) => Object.fromEntries((light.find((m) => m[1].trim() === sel)?.[2] ?? '').split(';').filter((x) => x.includes(':')).map((x) => { const i = x.indexOf(':'); return [x.slice(0, i).trim(), x.slice(i + 1).trim()]; }));
    expect(d('.proto.light .u5 .cnt,.proto.light .u5 .tgl,.proto.light .u5 .md,.proto.light .u5 .ln').color).toBe(LIGHT['on-surface-muted']);
    expect(d('.proto.light .u5 .cnt b').color).toBe(LIGHT['on-surface']);
    expect(d('.proto.light .u5')['--u5-red']).toBe(LIGHT['danger-text']);
  });
});
