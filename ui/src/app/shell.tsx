// 앱 틀: 해시 경로(#/화면?값) · 알림(toast) · STOP 버튼과 Space 단축키.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { create } from 'zustand';
import { dropAll, sendStop } from '../data/link';

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

// ---- 알림 ----
const useToastS = create<{ t: string; n: number }>(() => ({ t: '', n: 0 }));
const show = (t: string) => useToastS.setState((s) => ({ t, n: s.n + 1 }));
/** 글 하나 또는 (저장처럼) 나중에 오는 결과 글 — 결과가 와야 띄운다 */
export const toast = (t: string | Promise<string>) => { if (typeof t === 'string') show(t); else t.then(show); };
export function Toast() {
  const { t, n } = useToastS();
  useEffect(() => { if (!t) return; const id = setTimeout(() => useToastS.setState({ t: '' }), 3500); return () => clearTimeout(id); }, [n]);
  return t ? <div role="status" data-live-toast="1" style={{ position: 'fixed', left: '50%', top: 96, transform: 'translateX(-50%)', zIndex: 50, maxWidth: '90vw', padding: '8px 14px', borderRadius: 8, background: 'rgba(8,11,14,.92)', color: '#E6EBEF', fontSize: 13, pointerEvents: 'none' }}>{t}</div> : null;
}

// ---- STOP: 누르는 순간(pointerdown) 보냄. 명령 0 요청일 뿐 몸 정지가 아님 ----
export const stopNow = () => { if (!sendStop()) toast('링크 끊김 — STOP 을 보내지 못함(서버 와치독이 명령 0 유지)'); };
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
export const stopProps = { 'aria-label': '비상 정지', ...stopOn } as const;
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
