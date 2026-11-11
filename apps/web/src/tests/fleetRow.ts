// PC 로봇 탭 행 찾기(시험 공용, 부작용 없음)
/** PC 로봇 탭에서 그 로봇의 행(ROBOT-TAB 11-02): 총괄 표 «로봇 목록»·운영 관리자 «내 로봇 고르기»·«다른 로봇» 접기.
 *  운영 관리자 내 로봇이 한 대뿐이면 고르기가 숨어(이미 골라짐) 그 로봇의 «로봇 연결 상태»(머리·큰 상태 안내) — 눌러도 아무 일 없음 */
export const fleetRow = (box: ParentNode, name: string) =>
  [...box.querySelectorAll<HTMLElement>('[aria-label="로봇 목록"] button, [aria-label="내 로봇 고르기"] button, [aria-label="다른 로봇"] button')].find((b) => b.textContent!.includes(name))
  ?? [...box.querySelectorAll<HTMLElement>('[aria-label="로봇 연결 상태"]')].find((s) => s.querySelector('h2')?.textContent === name)!;
/** PC 로봇 탭에 보이는 로봇 이름(행 순서): 총괄 표 또는 운영 관리자 고르기·상태 한 줄(한 대)·다른 로봇 */
export const fleetNames = (box: ParentNode) => {
  const pick = [...box.querySelectorAll('[aria-label="로봇 목록"] b, [aria-label="내 로봇 고르기"] b')].map((b) => b.textContent);
  const solo = pick.length ? [] : [...box.querySelectorAll('[aria-label="로봇 연결 상태"] h2')].filter((h) => !h.parentElement!.querySelector('[data-not-mine]')).map((h) => h.textContent);
  return [...pick, ...solo, ...[...box.querySelectorAll('[aria-label="다른 로봇"] b')].map((b) => b.textContent)];
};
