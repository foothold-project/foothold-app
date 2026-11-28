// @vitest-environment node
// 머리줄 알림 칸: 닫힌 details 안 카드는 배치하지 않는다(display:none). 배치되면 605px 카드가 세로 넘침 칸으로 잡힌다(기록 · 임무 탭)
import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

it('닫힌 알림 칸 카드 = display:none · 열린 칸 규칙은 그대로', () => {
  const css = readFileSync(join(__dirname, '../proto/frame.pv.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  expect(css).toMatch(/details\.ap-bell:not\(\[open\]\)>\.card\{display:none!important\}/);
  expect(css).not.toMatch(/details\.ap-bell\[open\]>\.card\{[^}]*display:none/);
});
