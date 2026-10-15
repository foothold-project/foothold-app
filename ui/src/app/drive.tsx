// 조종 입력 손잡이(막대·누름 버튼) — live.js stick()/holdBtn() 과 같은 규칙. 값·폐기는 data/link.ts 누름 저장소가 정한다.
import { useEffect, useRef, useState } from 'react';
import { T } from '../data/transport';
import { cancel, driveBlock, hide, lift, move, onDrop, owns, press, pressGen, pressing, startBlock, startDrive, useLink, type Axes } from '../data/link';
import { DIR_TAG } from '../data/facts';
import { toast } from './shell';

/** 첫 누름: 조종 가능하면 누름, 아니면 «조종 시작» 확인 흐름(N1 — 이 누름은 움직이지 않음, 끝나면 손 떼고 새로) 또는 막힌 이유 */
/** 입력은 두 곳까지(같은 곳 겹침·세 번째 입력 → 전부 멈춤) — link.press 정책 */
export const MULTI = '동시 입력은 두 곳까지 — 모두 멈춤. 손 떼고 다시 누르세요';

/** U2 막힌 방향(후진·옆걸음·제자리 회전·저속): 서버가 0 으로 막고 이유(«… 미검증 — …»)를 status.reason 에 준다.
 *  누르는 동안 그 이유가 처음 보이면 토스트 1회(같은 누름에서 같은 이유 반복 0 · 손 떼면 다시 1회). 허용 범위·발행은 그대로(표시만).
 *  순수 판정: (지난번 말한 이유, 지금 누르는 중, 서버 이유) → [다음 기억, 띄울 글 | null] */
export function dirWhy(said: string, on: boolean, reason: string | null | undefined): [string, string | null] {
  if (!on) return ['', null];
  const r = reason || '';
  return /미검증/.test(r) && r !== said ? [r, `${r} · ${DIR_TAG}`] : [said, null];
}
/** U2 보완 A3: 상태 구독 리스너 — 빠르게 떼고 다시 눌러(사이에 status 가 안 와) on 이 끊기지 않아도 새 누름(pressGen 변화)이면 다시 1회 */
export function dirListener(say: (t: string) => void) {
  let said = '', g = -1;
  return (s: { st: { reason?: string | null } | null }) => {
    const n0 = pressGen(); if (n0 !== g) { g = n0; said = ''; }
    const [n, t] = dirWhy(said, pressing(), s.st?.reason); said = n; if (t) say(t);
  };
}
export function useDirWhy() {
  useEffect(() => useLink.subscribe(dirListener(toast)), []);
}

function tryPress(id: string, pid: number, p: Axes) {
  const no = driveBlock();
  if (!no) { if (press(id, pid, p)) return true; toast(MULTI); return false; }
  const sb = startBlock();
  if (!sb) void startDrive().then((t) => { if (t) toast(t); });
  else toast(no.startsWith('보기 전용') ? `조종 시작 안 됨 · ${sb}` : no);   // 보기 전용인데 시작도 막힘(다른 기기 등) → «조종 시작을 누르세요» 대신 막힌 이유
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
 *  돌아오면 보기 전용부터(«조종 시작» 확인 뒤 새 누름만). 발행자는 link.ts 20 Hz 하나 그대로 */
export function useDriveScreen() { useEffect(() => () => hide(), []); }

/** 휴대폰 가로 화면 맞춤(live.js fitPhone): 시안 844×390 배치 그대로, 안전 영역 안에 비율 축소·가로 늘림 */
/** R03 세로 띠: 축소하지 않는 아래 줄. 세로에서는 조종 틀이 띠의 «실제» 높이(안전 줄 줄바꿈·safe-area 포함, U2 보완 A2)만큼 위에서 끝난다.
 *  BAND_H 는 띠를 아직 못 잴 때만 쓰는 대체값(버튼 48 + STOP 64 + 틈 8×3) */
export const BAND_H = 136;
export const PORTRAIT = '(orientation: portrait)';   // 띠 표시·틀 안 STOP 숨김(CSS)과 같은 조건 하나
const bandH = (pb: number) => { const h = document.querySelector('.drv-band')?.getBoundingClientRect().height; return h && h > 0 ? h : BAND_H + pb; };   // 띠 padding 이 safe-area 를 이미 포함
export function useFitPhone() {
  const root = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const probe = document.createElement('div'); probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
    const tip = document.createElement('div'); tip.textContent = '가로로 돌리면 막대가 크게 보입니다 · STOP 은 아래 줄'; tip.setAttribute('role', 'note'); tip.className = 'lv-tip';
    tip.style.cssText = 'position:fixed;left:50%;top:38%;transform:translateX(-50%);z-index:60;padding:6px 12px;border-radius:8px;background:rgba(26,18,6,.92);color:#FFB547;font:600 13px/1.4 system-ui,sans-serif;pointer-events:none';
    // 세로 안내(tip)는 가운데 빈 영상 칸(top 38%) — 아래 막대·버튼 줄을 덮지 않게(실 APK 세로 412x842)
    document.body.append(probe, tip); const bg = document.body.style.background; document.body.style.background = '#05080A';
    const fit = () => {
      const el = root.current; if (!el) return;
      const cs = getComputedStyle(probe), px = (k: 'paddingLeft' | 'paddingTop' | 'paddingRight' | 'paddingBottom') => parseFloat(cs[k]) || 0;
      const por = matchMedia(PORTRAIT).matches;
      const l = px('paddingLeft'), t = px('paddingTop'), W = innerWidth - l - px('paddingRight'), H = innerHeight - t - (por ? bandH(px('paddingBottom')) : px('paddingBottom'));
      const k = Math.min(1, H / 390, W / 700);
      Object.assign(el.style, { position: 'fixed', left: `${l}px`, top: `${t}px`, width: `${W / k}px`, height: `${H / k}px`, transform: k < 1 ? `scale(${k})` : '', transformOrigin: '0 0' });
      el.dataset.liveFit = `${Math.round(W)}x${Math.round(H)}@${k.toFixed(2)}`;
      tip.style.display = por ? 'block' : 'none';
    };
    // 띠 높이가 바뀌면(글 줄바꿈·글꼴·dev 전환) 다시 맞춤 — 창 크기 변화 없이도
    const band = document.querySelector('.drv-band'), ro = band && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fit) : null; if (band) ro?.observe(band);
    addEventListener('resize', fit); visualViewport?.addEventListener('resize', fit); fit();
    const raf = requestAnimationFrame(() => requestAnimationFrame(fit));
    return () => { ro?.disconnect(); cancelAnimationFrame(raf); removeEventListener('resize', fit); visualViewport?.removeEventListener('resize', fit); probe.remove(); tip.remove(); document.body.style.background = bg; };
  }, []);
  return root;
}

/** ⑥ 앱↔관문 왕복(로그인 불요 관문 검사) — 화면이 보일 때만 5 s 마다 1회, 겹치지 않게. 로봇 링크 속도·대역폭이 아님 */
export function useGateRtt(): { txt: string; ok: boolean; why: string } {
  const [r, setR] = useState({ txt: '앱↔관문 확인 중', ok: false, why: '' });
  useEffect(() => {
    let live = true, busy = false;
    const tick = async () => {
      if (busy || document.visibilityState !== 'visible') return;
      busy = true; const h = await T.health(); busy = false;
      if (live) setR(h.ok ? { txt: `앱↔관문 ${Math.round(h.ms)} ms`, ok: true, why: '로그인 불요 관문 검사 HTTP 왕복 · 로봇 링크 속도 아님' }
        : { txt: h.step === 'none' ? '앱↔관문 미측정' : '앱↔관문 확인 못 함', ok: false, why: h.why });
    };
    tick(); const id = setInterval(tick, 5000);
    return () => { live = false; clearInterval(id); };
  }, []);
  return r;
}
