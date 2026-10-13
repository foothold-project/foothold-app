// 조종 입력 손잡이(막대·누름 버튼) — live.js stick()/holdBtn() 과 같은 규칙. 값·폐기는 data/link.ts 누름 저장소가 정한다.
import { useEffect, useRef } from 'react';
import { cancel, driveBlock, hide, lift, move, onDrop, owns, press, sendOp, useLink, type Axes } from '../data/link';
import { toast } from './shell';

/** 첫 누름: 조종 가능하면 누름, 아니면 «조종권 받기»만(손 떼고 다시 눌러야 움직임) 또는 막힌 이유 */
/** 입력은 두 곳까지(같은 곳 겹침·세 번째 입력 → 전부 멈춤) — link.press 정책 */
export const MULTI = '동시 입력은 두 곳까지 — 모두 멈춤. 손 떼고 다시 누르세요';

function tryPress(id: string, pid: number, p: Axes) {
  const st = useLink.getState().st, no = driveBlock();
  if (!no) { if (press(id, pid, p)) return true; toast(MULTI); return false; }
  if (st && (useLink.getState().viewOnly || st.role === 'view') && st.role !== 'view_other' && !st.sim_block && useLink.getState().open) { sendOp('take'); toast('조종권 받기 요청 — 손 떼고 다시 누르세요'); }
  else toast(no);
  return false;
}

/** 막대: axes = 세로 축(fx)·가로 축(fy 옆걸음 / fw 회전). 손잡이는 DOM transform 으로 움직임.
 *  손잡이·값은 «이 손가락이 지금 이 막대를 소유»(owns)일 때만 바꾼다 — 폐기·STOP 뒤 낡은 손가락·hover·다른 손가락의 up 은 그림도 명령도 못 바꿈 */
export function useStick(id: string, axes: ['fx' | null, 'fy' | 'fw' | null]) {
  const knob = useRef<HTMLSpanElement | null>(null), cap = useRef<{ el: HTMLElement; pid: number } | null>(null);
  const reset = () => { if (knob.current) knob.current.style.transform = ''; };
  const free = () => { const c = cap.current; cap.current = null; reset(); if (c) try { c.el.releasePointerCapture(c.pid); } catch { /* 이미 풀림 */ } };
  useEffect(() => onDrop(free), []);   // 폐기(STOP·숨김·메뉴·전체화면·화면 떠남) → 손잡이 0 + 포착 해제
  const val = (e: React.PointerEvent<HTMLElement>): [Axes, string] => {
    const r = e.currentTarget.getBoundingClientRect(), R = Math.max(1, Math.min(r.width, r.height) / 2 - 8);
    let dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    if (!axes[0]) dy = 0; if (axes[0] && !axes[1]) dx = 0;
    const L = Math.hypot(dx, dy), k = L > R ? R / L : 1; dx *= k; dy *= k;
    return [{ fx: axes[0] ? -dy / R : 0, fy: axes[1] === 'fy' ? -dx / R : 0, fw: axes[1] === 'fw' ? -dx / R : 0 }, `translate(${dx}px,${dy}px)`];
  };
  const go = (e: React.PointerEvent<HTMLElement>) => { const [p, t] = val(e); if (move(id, e.pointerId, p) && knob.current) knob.current.style.transform = t; };
  const props = {   // touch-action 은 live.css([data-live-drive] [role=group]) — 여기 style 을 주면 시안 크기 style 을 통째로 덮음
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      const t = e.currentTarget; if (!tryPress(id, e.pointerId, { fx: 0, fy: 0, fw: 0 })) return;
      t.setPointerCapture(e.pointerId); cap.current = { el: t, pid: e.pointerId }; go(e);
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => { if (owns(id, e.pointerId)) go(e); },
    onPointerUp: (e: React.PointerEvent<HTMLElement>) => { if (!owns(id, e.pointerId)) return; lift(id, e.pointerId); free(); },
    onPointerCancel: (e: React.PointerEvent<HTMLElement>) => cancel(id, e.pointerId),
    onLostPointerCapture: (e: React.PointerEvent<HTMLElement>) => cancel(id, e.pointerId),
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  };
  return { props, knob };
}

/** 누르는 동안만 보내는 버튼(PC). 같은 소유 규칙 — 폐기되면 눌림 표시·포착도 해제 */
export function useHold(id: string, p: Axes) {
  const cap = useRef<{ el: HTMLElement; pid: number } | null>(null);
  const free = () => { const c = cap.current; cap.current = null; if (c) { c.el.classList.remove('lv-on'); try { c.el.releasePointerCapture(c.pid); } catch { /* 이미 풀림 */ } } };
  useEffect(() => onDrop(free), []);
  return {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0 || !tryPress(id, e.pointerId, p)) return;
      const t = e.currentTarget; t.setPointerCapture(e.pointerId); t.classList.add('lv-on'); cap.current = { el: t, pid: e.pointerId };
    },
    onPointerUp: (e: React.PointerEvent<HTMLElement>) => { if (!owns(id, e.pointerId)) return; lift(id, e.pointerId); free(); },
    onPointerCancel: (e: React.PointerEvent<HTMLElement>) => cancel(id, e.pointerId),
    onLostPointerCapture: (e: React.PointerEvent<HTMLElement>) => cancel(id, e.pointerId),
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  };
}

/** 조종 화면 수명: 화면을 떠나면(SPA 경로 전환 = pagehide 아님) 숨김과 같게 — 누름 폐기 + hidden(조종 중이면) + 보기 전용.
 *  돌아오면 보기 전용부터(«조종권 받기» 뒤 새 누름만). 발행자는 link.ts 20 Hz 하나 그대로 */
export function useDriveScreen() { useEffect(() => () => hide(), []); }

/** 휴대폰 가로 화면 맞춤(live.js fitPhone): 시안 844×390 배치 그대로, 안전 영역 안에 비율 축소·가로 늘림 */
export function useFitPhone() {
  const root = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const probe = document.createElement('div'); probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
    const tip = document.createElement('div'); tip.textContent = '가로로 돌려 쓰세요 · 세로에서는 작게 보입니다'; tip.setAttribute('role', 'note');
    tip.style.cssText = 'position:fixed;left:50%;bottom:8px;transform:translateX(-50%);z-index:60;padding:6px 12px;border-radius:8px;background:rgba(26,18,6,.92);color:#FFB547;font:600 13px/1.4 system-ui,sans-serif;pointer-events:none';
    document.body.append(probe, tip); const bg = document.body.style.background; document.body.style.background = '#05080A';
    const fit = () => {
      const el = root.current; if (!el) return;
      const cs = getComputedStyle(probe), px = (k: 'paddingLeft' | 'paddingTop' | 'paddingRight' | 'paddingBottom') => parseFloat(cs[k]) || 0;
      const l = px('paddingLeft'), t = px('paddingTop'), W = innerWidth - l - px('paddingRight'), H = innerHeight - t - px('paddingBottom');
      const k = Math.min(1, H / 390, W / 700);
      Object.assign(el.style, { position: 'fixed', left: `${l}px`, top: `${t}px`, width: `${W / k}px`, height: `${H / k}px`, transform: k < 1 ? `scale(${k})` : '', transformOrigin: '0 0' });
      el.dataset.liveFit = `${Math.round(W)}x${Math.round(H)}@${k.toFixed(2)}`;
      tip.style.display = innerHeight > innerWidth ? 'block' : 'none';
    };
    addEventListener('resize', fit); visualViewport?.addEventListener('resize', fit); fit();
    const raf = requestAnimationFrame(() => requestAnimationFrame(fit));
    return () => { cancelAnimationFrame(raf); removeEventListener('resize', fit); visualViewport?.removeEventListener('resize', fit); probe.remove(); tip.remove(); document.body.style.background = bg; };
  }, []);
  return root;
}
