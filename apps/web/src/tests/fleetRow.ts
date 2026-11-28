// PC 로봇 탭 행 찾기(시험 공용, 부작용 없음)
/** PC 로봇 탭(u4 틀 11/28)에서 그 로봇의 왼쪽 목록 행(.rcard). 목록에 없으면 세 칸 조종 화면 · 상태 한 줄 머리 */
export const fleetRow = (box: ParentNode, name: string) =>
  [...box.querySelectorAll<HTMLElement>('[data-robot-row]')].find((b) => b.querySelector('.rc-main > b')?.textContent === name)
  ?? [...box.querySelectorAll<HTMLElement>('[aria-label="로봇 연결 상태"], [data-pc-drive]')].find((s) => s.querySelector('h2')?.textContent === name)!;
/** PC 로봇 탭 왼쪽 목록에 보이는 로봇 이름(행 순서): 내 로봇 → 다른 로봇(운영 관리자) · 거른 목록(총괄) */
export const fleetNames = (box: ParentNode) => [...box.querySelectorAll('[data-robot-row] .rc-main > b')].map((b) => b.textContent);
