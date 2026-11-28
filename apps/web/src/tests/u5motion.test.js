// @vitest-environment node
// 관제 u5 움직임 = 시안 u5_* 값(배터리 채움 fill 2.6s · 점검 점 blink 1.6s · ease-in-out) · 움직임 줄이기 설정이면 멈춤
import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const css = readFileSync(join(__dirname, '../proto/u5.css'), 'utf8');
it('시안과 같은 이름 · 시간 · 곡선', () => {
  expect(css).toContain('animation:fill 2.6s ease-in-out infinite');
  expect(css).toContain('@keyframes fill{0%{width:var(--b0)}85%,100%{width:calc(100% - 3px)}}');
  expect(css).toContain('animation:blink 1.6s ease-in-out infinite');
  expect(css).toContain('@keyframes blink{50%{opacity:.25}}');
});
it('움직임 줄이기 = 두 움직임 멈춤(배터리는 지금 값 폭)', () => {
  expect(css).toMatch(/@media \(prefers-reduced-motion:reduce\)\{\.u5 \.bt i\{animation:none;width:var\(--b0\)\}\.u5 \.stb\.chk i\{animation:none\}\}/);
});
