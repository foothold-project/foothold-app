// 조종 입력 손잡이(막대·누름 버튼) — live.js stick()/holdBtn() 과 같은 규칙. 값·폐기는 data/link.ts 누름 저장소가 정한다.
import { useEffect, useRef } from 'react';
import { cancel, driveBlock, lift, move, onDrop, press, sendOp, useLink, type Axes } from '../data/link';
import { toast } from './shell';

/** 첫 누름: 조종 가능하면 누름, 아니면 «조종권 받기»만(손 떼고 다시 눌러야 움직임) 또는 막힌 이유 */
function tryPress(id: string, pid: number, p: Axes) {
  const st = useLink.getState().st, no = driveBlock();
  if (!no) return press(id, pid, p);
  if (st && (useLink.getState().viewOnly || st.role === 'view') && st.role !== 'view_other' && !st.sim_block && useLink.getState().open) { sendOp('take'); toast('조종권 받기 요청 — 손 떼고 다시 누르세요'); }
  else toast(no);
  return false;
}

/** 막대: axes = 세로 축(fx)·가로 축(fy 옆걸음 / fw 회전). 손잡이는 DOM transform 으로 움직임 */
export function useStick(id: string, axes: ['fx' | null, 'fy' | 'fw' | null]) {
  const knob = useRef<HTMLSpanElement | null>(null);
  useEffect(() => onDrop(() => { if (knob.current) knob.current.style.transform = ''; }), []);
  const val = (e: React.PointerEvent<HTMLElement>): Axes => {
    const r = e.currentTarget.getBoundingClientRect(), R = Math.min(r.width, r.height) / 2 - 8;
    let dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    if (!axes[0]) dy = 0; if (axes[0] && !axes[1]) dx = 0;
    const L = Math.hypot(dx, dy), k = L > R ? R / L : 1; dx *= k; dy *= k;
    if (knob.current) knob.current.style.transform = `translate(${dx}px,${dy}px)`;
    return { fx: axes[0] ? -dy / R : 0, fy: axes[1] === 'fy' ? -dx / R : 0, fw: axes[1] === 'fw' ? -dx / R : 0 };
  };
  const end = () => { if (knob.current) knob.current.style.transform = ''; };
  const props = {   // touch-action 은 live.css([data-live-drive] [role=group]) — 여기 style 을 주면 시안 크기 style 을 통째로 덮음
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      const t = e.currentTarget; if (tryPress(id, e.pointerId, { fx: 0, fy: 0, fw: 0 })) { t.setPointerCapture(e.pointerId); move(id, e.pointerId, val(e)); }
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => { if (!move(id, e.pointerId, val(e))) return; },
    onPointerUp: (e: React.PointerEvent<HTMLElement>) => { lift(id, e.pointerId); end(); },
    onPointerCancel: (e: React.PointerEvent<HTMLElement>) => cancel(id, e.pointerId),
    onLostPointerCapture: (e: React.PointerEvent<HTMLElement>) => cancel(id, e.pointerId),
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  };
  return { props, knob };
}

/** 누르는 동안만 보내는 버튼(PC) */
export function holdProps(id: string, p: Axes) {
  return {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => { if (e.button === 0 && tryPress(id, e.pointerId, p)) { e.currentTarget.setPointerCapture(e.pointerId); e.currentTarget.classList.add('lv-on'); } },
    onPointerUp: (e: React.PointerEvent<HTMLElement>) => { lift(id, e.pointerId); e.currentTarget.classList.remove('lv-on'); },
    onPointerCancel: (e: React.PointerEvent<HTMLElement>) => { cancel(id, e.pointerId); e.currentTarget.classList.remove('lv-on'); },
    onLostPointerCapture: (e: React.PointerEvent<HTMLElement>) => { cancel(id, e.pointerId); e.currentTarget.classList.remove('lv-on'); },
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  };
}

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
