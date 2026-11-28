// 옛 PC 관제 부품 스위치(부작용 없음 · 다른 모듈을 부르지 않는다 — 시험이 먼저 불러도 import 순환이 없게)
/** 옛 PC 관제 부품(관제 요약 KPI · 운영 관리자 표 · 상세 서랍 · 조종 준비 · 다른 로봇, screens/fleet.tsx). PC 로봇 탭은 시안 u4(RobotTab)이고,
 *  이 부품은 W1 u5(관제)로 옮겨 갈 때까지 그대로 export 해 둔다. on = 앱 맥락 안에서 PC 에도 이 부품을 그린다(부품 시험용) */
export const pcBoard = { on: false };
