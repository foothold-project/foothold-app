// PC 무대(1920 × 1080 을 창에 맞춰 transform scale) 위에서 화면 px ↔ 무대 px.
// 끌기 · 창 옮기기처럼 포인터 좌표(clientX)를 무대 안 left · top · 길이로 쓰는 곳은 이 도우미로 바꿔 쓴다. 무대가 없으면(폰 틀) 그대로
export type Fit = { s: number; x: number; y: number };
let fit: Fit & { on: boolean } = { s: 1, x: 0, y: 0, on: false };
export const setStage = (f: Fit | null) => { fit = f ? { ...f, on: true } : { s: 1, x: 0, y: 0, on: false }; };
export const stageOn = () => fit.on;
/** 무대 너비 · 높이(무대가 없으면 창 크기) */
export const vw = () => (fit.on ? 1920 : innerWidth);
export const vh = () => (fit.on ? 1080 : innerHeight);
/** 포인터 화면 좌표 → 무대 좌표 */
export const sx = (e: { clientX: number }) => (e.clientX - fit.x) / fit.s;
export const sy = (e: { clientY: number }) => (e.clientY - fit.y) / fit.s;
/** 화면 px 길이 → 무대 px 길이 */
export const spx = (d: number) => d / fit.s;
/** getBoundingClientRect 를 무대 좌표로 */
export function stageRect(el: Element) {
  const b = el.getBoundingClientRect(), s = fit.s;
  return { left: (b.left - fit.x) / s, top: (b.top - fit.y) / s, right: (b.right - fit.x) / s, bottom: (b.bottom - fit.y) / s, width: b.width / s, height: b.height / s };
}
