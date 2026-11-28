// PC 로봇 탭 행 찾기(시험 공용, 부작용 없음)
/** PC 로봇 탭(시안 u4 · robotu4.tsx)에서 그 로봇의 목록 줄(.rail .rcard) */
export const fleetRow = (box: ParentNode, name: string) =>
  [...box.querySelectorAll<HTMLElement>('.u4 .rail .rcard')].find((b) => b.getAttribute('data-r') === name)!;
/** PC 로봇 탭 목록에 보이는 로봇 이름(줄 순서) */
export const fleetNames = (box: ParentNode) => [...box.querySelectorAll('.u4 .rail .rcard')].map((b) => b.getAttribute('data-r'));
