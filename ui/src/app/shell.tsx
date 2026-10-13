// 앱 틀: 해시 경로(#/화면?값) · 알림(toast) · STOP 버튼과 Space 단축키.
import { useEffect, useSyncExternalStore } from 'react';
import { create } from 'zustand';
import { sendStop } from '../data/link';

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
export const toast = (t: string) => useToastS.setState((s) => ({ t, n: s.n + 1 }));
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
/** live.js why(): 미연결 기능 버튼 — 누르면 이유만 알리고 아무것도 하지 않는다 */
export const whyProps = (text: string) => ({ 'aria-disabled': 'true' as const, title: text, className: 'lv-why', onClick: (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); toast(text); } });
