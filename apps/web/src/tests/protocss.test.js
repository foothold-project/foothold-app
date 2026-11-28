// @vitest-environment node
// 시안 공통 css 사본(ui.pv.css · pc.pv.css): 원본과 규칙 수 · 순서 · 값이 같고, 선택자만 .proto 한 겹(body · :root 는 .proto 자체)
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(__dirname, '..', 'proto');
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const rules = (css) => [...strip(css).matchAll(/(@import[^\n]*;)|([^{}@;]+)\{([^{}]*)\}/g)].map((m) => m[1] ? ['@import', m[1]] : [m[2].trim(), m[3]]);
// pc.css 의 body(1920 × 1080 · 어둠 바탕) 는 PC 무대와 그 안 화면에만(폰 시안 u13 · u14 로 번지지 않게 · protoscope.test)
const PC_ROOT = '.proto:where([data-layout=pc]),.proto:where([data-layout=pc] .proto)';
const scoped = (sel, name, body = '') => sel.split(',').map((s) => s.trim()).map((s) => (s === 'body' && name === 'pc' && body.startsWith('width:1920px') ? PC_ROOT : s === 'body' || s === ':root' ? '.proto' : `.proto ${s}`)).join(',');

describe('시안 공통 css 의 .proto 사본', () => {
  for (const name of ['ui', 'pc']) {
    it(`${name}.pv.css = ${name}.css 에 .proto 접두어만`, () => {
      const src = rules(readFileSync(join(dir, `${name}.css`), 'utf8'));
      const pv = rules(readFileSync(join(dir, `${name}.pv.css`), 'utf8'));
      expect(src.length).toBeGreaterThan(10);
      expect(pv.map(([s]) => s)).toEqual(src.map(([s, b]) => (s === '@import' ? s : scoped(s, name, b))));
      expect(pv.map(([, b]) => b)).toEqual(src.map(([, b]) => b));
    });
  }
  it('사본 밖으로 새는 선택자 없음(모든 규칙이 .proto 로 시작)', () => {
    for (const name of ['ui', 'pc']) for (const [s] of rules(readFileSync(join(dir, `${name}.pv.css`), 'utf8')))
      if (s !== '@import') for (const one of s.split(',')) expect(one.trim().startsWith('.proto'), one).toBe(true);
  });
});
