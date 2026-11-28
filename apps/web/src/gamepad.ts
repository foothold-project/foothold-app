// 조이스틱(게임패드 · 시안 u9_7 「조이스틱 · 연결됨 · 1 순위 · 왼쪽 스틱 이동 · 오른쪽 스틱 돌기」).
// 스틱 값 → 손잡이 규칙(robotact stickTok · 한 스틱 한 축 · 문턱 0.3) → 조이스틱 전용 키 이름(PadUp …)의 keydown / keyup.
// 세 조종 길(serverdrive · drive · simdrive · PC 시뮬 탭)은 이 키를 keyCode() 로 같은 자판 키로 읽으므로 키보드와 한 길을 지난다:
// 입력 세대 · 준비(ready) · 막힘 표 · STOP 뒤 「떼고 다시」 · 창 초점 잃음 = 0 이 그대로 걸린다. 자판 키와 이름이 달라 둘이 서로 지우지 않는다.
// 쓰는 조이스틱은 연결된 것 중 번호가 가장 앞인 하나(1 순위). 브라우저는 단추를 한 번 눌러야 조이스틱을 보여 준다.
import { useSyncExternalStore } from 'react';
import { stickTok } from './robotact';
import type { Tok } from './serverdrive';
import { PAD_CODE } from './padkeys';
export { PAD_ALIAS, PAD_CODE, keyCode } from './padkeys';

type Pad = Pick<Gamepad, 'id' | 'index' | 'connected' | 'axes'>;
const pads = (): Pad[] => {
  try { return [...(navigator.getGamepads?.() ?? [])].filter((p): p is Gamepad => !!p && p.connected).sort((a, b) => a.index - b.index); } catch { return []; }
};
/** 1 순위 조이스틱(없으면 null) */
export const firstPad = (): Pad | null => pads()[0] ?? null;
/** 표준 배치: 왼쪽 스틱 axes 0 · 1, 오른쪽 스틱 axes 2(가로) */
export function padToks(p: Pad): Tok[] {
  const a = (i: number) => (Number.isFinite(p.axes[i]) ? p.axes[i] : 0);
  return [...new Set([...stickTok('L', a(0), a(1)), ...stickTok('R', a(2), a(3))])];
}

const held = new Set<string>();
const fire = (type: 'keydown' | 'keyup', code: string) => dispatchEvent(new KeyboardEvent(type, { code, bubbles: true, cancelable: true }));
/** 한 번 읽기: 바뀐 키만 뗌 → 누름 순서로 보낸다 */
export function pollPad() {
  const p = typeof document !== 'undefined' && document.visibilityState === 'hidden' ? null : firstPad();
  const now = new Set((p ? padToks(p) : []).map((t) => PAD_CODE[t]));
  for (const c of [...held]) if (!now.has(c)) { held.delete(c); fire('keyup', c); }
  for (const c of now) if (!held.has(c)) { held.add(c); fire('keydown', c); }
}

const subs = new Set<() => void>();
let snap: { id: string } | null = null;
const read = () => { const p = firstPad(); if ((p?.id ?? null) !== (snap?.id ?? null)) snap = p ? { id: p.id } : null; return snap; };
/** 연결 상태(설정 › 조작). null = 연결 안 됨 */
export const usePad = () => useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, read);

/** main.tsx 에서 한 번: 연결되면 50 ms 마다(조종 명령 주기와 같음) 읽고, 끊기면 누른 키를 모두 뗀다 */
export function syncGamepad(ms = 50) {
  let t: ReturnType<typeof setInterval> | null = null;
  const change = () => {
    const on = !!firstPad();
    if (on && !t) t = setInterval(pollPad, ms);
    if (!on && t) { clearInterval(t); t = null; }
    pollPad(); subs.forEach((f) => f());
  };
  addEventListener('gamepadconnected', change); addEventListener('gamepaddisconnected', change);
  change();
  return () => { removeEventListener('gamepadconnected', change); removeEventListener('gamepaddisconnected', change); if (t) clearInterval(t); t = null; };
}
