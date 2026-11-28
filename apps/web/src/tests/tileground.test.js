// @vitest-environment node
// 타일 앉기 · 충전(시안 pose 'down') 바닥 맞춤 = 로봇 탭 go2view 의 ground 와 같은 함수(꼭짓점 기준 · go2ground.test 가 최저점 y≈0 을 봄)
import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
it('tileview 의 down 자세는 go2view ground 를 씀(박스 근사 사본 없음)', () => {
  const src = readFileSync(join(__dirname, '../proto/tileview.ts'), 'utf8');
  expect(src).toContain("import { ground } from '../screens/u4/go2view';");
  expect(src).toMatch(/applyDown\(b\); ground\(b\.root\);/);
  expect(src).not.toMatch(/setFromObject\(b\.root\)\.min\.y/);
});
