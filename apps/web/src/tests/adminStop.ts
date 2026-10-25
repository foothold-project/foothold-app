// 10-25: 총괄은 실기 로봇 STOP 이 없다(실기 STOP 은 운영 관리자 폰). 탭 시험의 «STOP 그대로» 도우미가 총괄 화면(PC 머리줄 «이름(총괄)», 실기만 있는 목록)이면
// STOP 단추가 없는지만 보고 true — 운영 관리자 화면은 false(기존 확인 그대로)
import { expect } from 'vitest';
export function adminNoStop(box: ParentNode) {
  if (!box.querySelector('.fh-me')?.textContent?.endsWith('(총괄)')) return false;
  expect(box.querySelector('[data-stop]')).toBeNull();
  return true;
}
