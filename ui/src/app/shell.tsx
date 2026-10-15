// 앱 틀: 해시 경로(#/화면?값) · 알림(toast) · STOP 버튼과 Space 단축키.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { answerAsk, dropAll, linkView, sendStop, showSimStop, stopSim, useAsk, useLink } from '../data/link';
import { STOP_TIP } from '../data/facts';

// ---- 경로 ----
const sub = (f: () => void) => { addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); };
export function useRoute() {
  const h = useSyncExternalStore(sub, () => location.hash);
  const [path, qs = ''] = h.replace(/^#\/?/, '').split('?');
  const q = new URLSearchParams(qs);
  // 같은 화면에서 값만 바꿀 때: 기록을 쌓지 않고 바꿈(live.js history.replaceState 와 같음)
  const setQ = (k: string, v: string) => { q.set(k, v); history.replaceState(null, '', `#/${path}?${q}`); dispatchEvent(new HashChangeEvent('hashchange')); };
  return { name: path || '', q, setQ };
}

// ---- 전체화면 안 표시(10-15): 네이티브 전체화면이면 그 요소 밖 DOM 은 안 보인다 → 확인창·알림을 현재 fullscreenElement 안으로 옮겨 그린다 ----
const fsSub = (f: () => void) => { document.addEventListener('fullscreenchange', f); return () => document.removeEventListener('fullscreenchange', f); };
const fsEl = () => { const e = document.fullscreenElement; return e && e !== document.documentElement && e !== document.body ? e : null; };   // 문서 전체(MDrive)면 원래 자리도 보임
export const InFs = ({ children }: { children: React.ReactNode }) => { const h = useSyncExternalStore(fsSub, fsEl, () => null); /* 서버 렌더(시험) = 전체화면 없음 */ return h ? createPortal(children, h) : <>{children}</>; };

// ---- 알림 ----
const useToastS = create<{ t: string; n: number }>(() => ({ t: '', n: 0 }));
const show = (t: string) => useToastS.setState((s) => ({ t, n: s.n + 1 }));
/** 글 하나 또는 (저장처럼) 나중에 오는 결과 글 — 결과가 와야 띄운다 */
export const toast = (t: string | null | Promise<string | null>) => { if (t instanceof Promise) t.then((x) => x && show(x)); else if (t) show(t); };
/** 페이지 안 확인창(N1 «조종 시작» · 수동 진행 시작, 비차단). 화면을 덮지 않아 STOP(버튼·Space)은 그대로 눌리고, 누르면 이 창이 바로 닫힘(취소).
 *  초점은 «취소»(Enter 습관으로 시작되지 않게) · Escape = 취소 · 숨김/이탈/새 STOP/상태 변화도 취소(link.cancelStart·결속). */
// 확인창 단추 색은 여기서 정함(.btn 은 화면 테마 따라 밝은 MHome 에서 글자가 배경에 묻힘 — 670 QA P1). 창 배경은 늘 어두움
const ASK_B: React.CSSProperties = { minHeight: 36, padding: '6px 14px', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const ASK_NO: React.CSSProperties = { ...ASK_B, background: '#1C252D', color: '#E6EBEF', border: '1px solid #6B7a88' };
const ASK_OK: React.CSSProperties = { ...ASK_B, background: '#E6EBEF', color: '#0A0E12', border: '1px solid #E6EBEF' };
export function StartAsk() {
  const text = useAsk((s) => s.text), ok = useAsk((s) => s.ok), no = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (text === null) return;
    no.current?.focus();
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); answerAsk(false); } };
    addEventListener('keydown', k); return () => removeEventListener('keydown', k);
  }, [text]);
  if (text === null) return null;
  const [head, ...rows] = text.split('\n');
  return <InFs><div role="alertdialog" aria-modal="false" aria-labelledby="fh-ask-h" data-start-ask="1" style={{ position: 'fixed', left: '50%', top: 56, transform: 'translateX(-50%)', zIndex: 60,
    width: 'min(380px, calc(100vw - 32px))', padding: '12px 14px', borderRadius: 10, background: 'rgba(8,11,14,.96)', color: '#E6EBEF', border: '1px solid #3a4652', fontSize: 13, boxShadow: '0 6px 24px rgba(0,0,0,.45)' }}>
    <div id="fh-ask-h" style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>{head}</div>
    {rows.map((r) => <div key={r} style={{ lineHeight: 1.45 }}>{r}</div>)}
    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10 }}>
      <button type="button" style={ASK_NO} ref={no} onClick={() => answerAsk(false)}>취소</button>
      <button type="button" style={ASK_OK} data-ask-ok="1" onClick={() => answerAsk(true)}>{ok || '조종 시작'}</button>
    </div>
    <style>{'[data-start-ask] button:focus-visible{outline:2px solid #8CC8FF;outline-offset:2px}'}</style>
  </div></InFs>;
}
export function Toast() {
  const { t, n } = useToastS();
  useEffect(() => { if (!t) return; const id = setTimeout(() => useToastS.setState({ t: '' }), 3500); return () => clearTimeout(id); }, [n]);
  return t ? <InFs><div role="status" data-live-toast="1" style={{ position: 'fixed', left: '50%', top: 96, transform: 'translateX(-50%)', zIndex: 50, maxWidth: '90vw', padding: '8px 14px', borderRadius: 8, background: 'rgba(8,11,14,.92)', color: '#E6EBEF', fontSize: 13, pointerEvents: 'none' }}>{t}</div></InFs> : null;
}

// ---- STOP: 누르는 순간(pointerdown) 보냄. 명령 0 요청일 뿐 몸 정지가 아님 ----
export const stopNow = () => { if (!sendStop()) toast(useLink.getState().provider !== 'simulation_gate' ? '실기 모드 — Go2 비상 정지 미연결(명령 미지원) · 로봇 리모컨으로 정지하세요' : '링크 끊김 — STOP 을 보내지 못함(서버 와치독이 명령 0 유지)'); };
// 글자 입력 중(입력칸·여러 줄·고르기·편집 가능 영역·한글 조합 중)인 키는 단축키로 쓰지 않는다. STOP 버튼은 언제나 동작.
const typing = (e: KeyboardEvent) => { const t = e.target as HTMLElement | null; return !!(e.isComposing || e.keyCode === 229 || (t && t.nodeType === 1 && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)))); };
export function useStopKey() {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (!typing(e) && e.code === 'Space') { e.preventDefault(); stopNow(); } };
    addEventListener('keydown', k); return () => removeEventListener('keydown', k);
  }, []);
}
/** live.js stopBtn(): 누르는 순간(pointerdown)·Enter 에 STOP. 이름표 없는 보조 STOP 버튼에도 쓴다 */
export const stopOn = { onPointerDown: stopNow, onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter') stopNow(); } } as const;
export const stopProps = { 'aria-label': '비상 정지', title: STOP_TIP, ...stopOn } as const;   // B2 R05: 효과 설명 한 문구(facts)
/** live.js openDrawer(): 오른쪽(PC)·머리줄 아래 서랍. Esc·닫기로 닫음. (휴대폰 가로 조종 화면 배치는 묶음 3 에서) */
export function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const x = useRef<HTMLButtonElement>(null), close = useRef(onClose); close.current = onClose;   // 다시 그릴 때마다 초점을 뺏지 않게 처음 한 번만
  const [bot, setBot] = useState(12);
  useEffect(() => {
    dropAll();   // 메뉴·서랍이 열리는 순간 조종 입력 폐기(네이티브 blur 를 가정하지 않음) — 모든 화면 공통
    x.current?.focus(); const k = (e: KeyboardEvent) => { if (e.key === 'Escape') close.current(); };
    // 서랍 아래쪽(휴대폰 하단)에 있는 STOP 을 덮지 않게 그 위에서 끝냄 — 머리줄 STOP(PC)은 top 84 위라 해당 없음
    const fit = () => { const t = [...document.querySelectorAll('[aria-label="비상 정지"]')].map((e) => e.getBoundingClientRect()).filter((r) => r.width && r.top > 184).map((r) => r.top); setBot(t.length ? Math.max(12, innerHeight - Math.min(...t) + 8) : 12); };
    fit(); addEventListener('keydown', k); addEventListener('resize', fit); return () => { removeEventListener('keydown', k); removeEventListener('resize', fit); };
  }, []);
  return <div className="lv-drawer" role="dialog" aria-label={title} style={{ right: 12, top: 84, bottom: bot, width: 'min(440px,calc(100vw - 24px))' }}>
    <div className="lv-row"><h2>{title}</h2><button ref={x} type="button" aria-label={`${title} 닫기 (Esc)`} onClick={onClose}>닫기</button></div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>{children}</div></div>;
}
/** live.js why(): 미연결 기능 버튼 — 누르면 이유만 알리고 아무것도 하지 않는다 */
export const whyProps = (text: string) => ({ 'aria-disabled': 'true' as const, title: text, className: 'lv-why', onClick: (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); toast(text); } });

/** Gazebo 끄기(로봇 STOP 아님) — 관제·조종·지도 화면 공용. STOP 과 떨어진 줄에 둔다. 서버가 거부하면(다른 기기 조종 중 등) 이유를 늘 보이게(화면에서 조건 완화 0) */
export function SimOff({ className = 'btn', style }: { className?: string; style?: React.CSSProperties }) {
  const L = useLink(), st = L.st, x = st?.sim_stop;
  if (L.provider !== 'simulation_gate' || !linkView(L).linkOk || !showSimStop(st) || !x) return null;
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', ...style }}>
    <button type="button" className={className} disabled={x.busy} title={x.why || 'Gazebo 시뮬 끄기(로봇 STOP 아님)'} style={{ opacity: x.ok ? undefined : 0.55 }}
      onClick={async () => { const t = await stopSim(st); if (t) toast(t); }}>{x.busy ? 'Gazebo 종료 확인 중' : 'Gazebo 끄기(시뮬 종료)'}</button>
    {!x.ok && !x.busy && x.why && <small role="status" style={{ color: 'var(--warn, #FFB547)', fontSize: 11 }}>{`끄기 안 됨 · ${x.why}`}</small>}</span>;
}
