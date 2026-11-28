import { describe, expect, it } from 'vitest';
import quadCss from '../quad.css?raw';
import brandCss from '../brand.css?raw';
import tokensCss from '../../public/brand/tokens/foothold.tokens.css?raw';

// 시뮬 보기 4칸의 지도 칸: 지도가 없으면 영상 칸처럼 검은 바탕이 아니라 테마 바탕(밝은 판에서 흰 계열) 위에 글
const flat = quadCss.replace(/\s+/g, '');
// 실제 색은 공식 토큰(public/brand/tokens, brand.css 가 --panel2=--paper-2 · --muted=--ink-2 로 이음)
const token = (theme: string, name: string) => {
  const block = tokensCss.split(`:root[data-theme="${theme}"]{`)[1].split('}')[0];
  return block.match(new RegExp(`--${name}:(#[0-9a-fA-F]{6})`))![1];
};
const lum = (hex: string) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

describe('시뮬 지도 칸이 비었을 때', () => {
  it('지도 칸 빈 글만 테마 바탕 · 흐린 글 토큰 (영상 칸의 고정 어두운 바탕은 그대로)', () => {
    expect(flat).toContain('[data-sim-quad].qt[data-tile="map"].qd-empty{background:var(--panel2);color:var(--muted)}');
    expect(flat).toContain('.qb{position:relative;flex:1;aspect-ratio:16/10;min-height:0;background:#05080A}');
  });
  it('두 테마 모두 글 대비 4.5:1 이상', () => {
    const bridge = brandCss.replace(/\s+/g, '');
    expect(bridge).toContain('--panel2:var(--paper-2);');
    expect(bridge).toContain('--muted:var(--b-ink-2);');   // .proto 안 옛 .fh 글자색을 위해 :root 에서 먼저 잡아 둔 ink-2
    expect(bridge).toContain('--b-ink-2:var(--ink-2);');
    for (const theme of ['dark', 'light']) expect(ratio(token(theme, 'ink-2'), token(theme, 'paper-2')), theme).toBeGreaterThanOrEqual(4.5);
  });
  it('영상 위 3D 칸(점군 · 라이다)의 빈 글은 어두운 바탕(#05080A) 위 4.5:1 이상, 어두움 판 --ink-2 값으로 두 테마 같게', () => {
    const ink = token('dark', 'ink-2');
    expect(flat).toContain(`[data-cloud]>.qd-empty,[data-lidar-map]>.qd-empty{color:${ink}}`);
    expect(ratio(ink, '#05080A')).toBeGreaterThanOrEqual(4.5);
  });
});
