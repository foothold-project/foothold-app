// PC 로봇 탭 행 찾기(시험 공용, 부작용 없음)
// 시안 u4 로봇 탭(robotu4.tsx)이 있으면 그 목록 줄(.rail .rcard), 없으면 옛 PC 관제 부품(pcBoard.on — W1 u5 로 옮겨 갈 부품)의 행
const u4 = (box: ParentNode) => [...box.querySelectorAll<HTMLElement>('.u4 .rail .rcard')];
/** 그 로봇의 줄. 옛 부품: 총괄 표 «로봇 목록»·운영 관리자 «내 로봇 고르기»·«다른 로봇» 접기, 한 대뿐이면 «로봇 연결 상태» */
export const fleetRow = (box: ParentNode, name: string) => {
  const rail = u4(box);
  if (rail.length) return rail.find((b) => b.getAttribute('data-r') === name)!;
  return [...box.querySelectorAll<HTMLElement>('[aria-label="로봇 목록"] button, [aria-label="내 로봇 고르기"] button, [aria-label="다른 로봇"] button')].find((b) => b.textContent!.includes(name))
    ?? [...box.querySelectorAll<HTMLElement>('[aria-label="로봇 연결 상태"]')].find((s) => s.querySelector('h2')?.textContent === name)!;
};
/** 목록에 보이는 로봇 이름(줄 순서) */
export const fleetNames = (box: ParentNode) => {
  const rail = u4(box);
  if (rail.length) return rail.map((b) => b.getAttribute('data-r'));
  const pick = [...box.querySelectorAll('[aria-label="로봇 목록"] b, [aria-label="내 로봇 고르기"] b')].map((b) => b.textContent);
  const solo = pick.length ? [] : [...box.querySelectorAll('[aria-label="로봇 연결 상태"] h2')].filter((h) => !h.parentElement!.querySelector('[data-not-mine]')).map((h) => h.textContent);
  return [...pick, ...solo, ...[...box.querySelectorAll('[aria-label="다른 로봇"] b')].map((b) => b.textContent)];
};
