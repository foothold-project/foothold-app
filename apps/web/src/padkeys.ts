// 조이스틱 전용 키 이름(gamepad.ts 가 보냄) ↔ 같은 뜻의 자판 키. 조종 길(serverdrive · drive · simdrive · screens/sim)이 키 표를 볼 때 쓴다(가져오는 것 없음 · 순환 없음)
import type { Tok } from './serverdrive';

/** 손잡이 낱말 → 조이스틱 전용 키 이름 */
export const PAD_CODE: Record<Tok, string> = { up: 'PadUp', down: 'PadDown', left: 'PadLeft', right: 'PadRight', rotl: 'PadRotL', rotr: 'PadRotR' };
/** 조이스틱 키 → 같은 뜻의 자판 키(세 조종 길 키 표 그대로: ↑ 전진 · ↓ 후진 · ← → 옆걸음 · A D 회전) */
export const PAD_ALIAS: Record<string, string> = { PadUp: 'ArrowUp', PadDown: 'ArrowDown', PadLeft: 'ArrowLeft', PadRight: 'ArrowRight', PadRotL: 'KeyA', PadRotR: 'KeyD' };
/** 키 표를 볼 때 쓰는 이름(조이스틱 키는 자판 키로) */
export const keyCode = (code: string) => PAD_ALIAS[code] ?? code;
