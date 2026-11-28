// @vitest-environment node
// PC 틀 값(1920 × 1080 · 어둠 바탕 · 머리줄 아래 가림)은 PC 무대([data-layout=pc]) 안에서만 · 폰 시안(u13 · u14)으로 번지지 않음. 선택자 세기는 예전과 같음(:where)
import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (f) => readFileSync(join(__dirname, '..', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
it('PC 뿌리 · 가림은 PC 무대 안으로 좁힘 · 맨 .proto 규칙 없음', () => {
  const pc = read('proto/pc.pv.css'), u11 = read('proto/u11.css');
  expect(pc).toMatch(/\.proto:where\(\[data-layout=pc\]\),\.proto:where\(\[data-layout=pc\] \.proto\)\{width:1920px;height:1080px;/);
  expect(pc).not.toMatch(/(^|\})\s*\.proto\{width:1920px/);
  expect(u11).toMatch(/\.proto:where\(\[data-layout=pc\]\) \.veil\{position:absolute;inset:64px 0 0 0;/);
  expect(u11).not.toMatch(/(^|\})\s*\.proto \.veil\{/);
});
it('폰 u13 의 번짐 덮개(.veil)는 지움 · PC 에서도 쓰는 u135 덮개는 남김', () => {
  expect(read('screens/u13.app.css')).not.toContain('.proto.u13 .veil');
  expect(read('screens/u135.app.css')).toContain('.proto.u135 .veil{inset:0;');
});
