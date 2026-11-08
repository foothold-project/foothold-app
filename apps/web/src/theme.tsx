import { useSyncExternalStore } from 'react';

// 화면 틀의 테마(.fh = 어두움, .fh.light = 밝음)를 <html data-theme> 로 옮긴다.
// 공식 토큰 CSS 가 :root[data-theme] 로 값을 고르기 때문. .fh 가 없는 화면(Report, 인쇄용)은 밝음.
// MutationObserver 콜백은 마이크로태스크라 그리기 전에 반영된다.
export function syncTheme() {
  const set = () => {
    const fh = document.querySelector('.fh'), t = !fh || fh.classList.contains('light') ? 'light' : 'dark';
    if (document.documentElement.dataset.theme !== t) document.documentElement.dataset.theme = t;
  };
  new MutationObserver(set).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  set();
}

/** 사용자가 고른 화면 테마(10-28). 이 기기에만 기억(localStorage fh.theme) — 못 읽으면 기본값 어두움(지금 모습) */
export type ThemePref = 'dark' | 'light' | 'system';
const KEY = 'fh.theme';
export const THEMES: [ThemePref, string][] = [['dark', '어두움'], ['light', '밝음'], ['system', '기기 설정 따름']];
let picked: ThemePref | null = null;   // 이 탭에서 고른 값 — 저장에 실패해도 지금 화면엔 반영
const subs = new Set<() => void>();
const media = () => (typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : null);

export function themePref(): ThemePref {
  if (picked) return picked;
  try { const v = localStorage.getItem(KEY); return v === 'light' || v === 'system' ? v : 'dark'; } catch { return 'dark'; }
}
export function setThemePref(p: ThemePref) {
  picked = p;
  try { localStorage.setItem(KEY, p); } catch { /* 기억 못 해도 이 탭에는 반영 */ }
  subs.forEach((f) => f());
}
export const isLight = (p = themePref()) => p === 'light' || (p === 'system' && !!media()?.matches);

function subscribe(f: () => void) {
  const m = media();
  subs.add(f); m?.addEventListener?.('change', f);   // «기기 설정 따름»은 기기 설정이 바뀌면 바로 따라감
  return () => { subs.delete(f); m?.removeEventListener?.('change', f); };
}
/** [고른 값, 지금 밝음인지] — .fh 틀에 `light` 를 붙이는 곳(App·로그인)과 고르는 칸이 쓴다 */
export const useTheme = () => [useSyncExternalStore(subscribe, themePref), useSyncExternalStore(subscribe, () => isLight())] as const;

/** 고르는 칸 — 폰 «⋯ 더 보기» */
export function ThemePick() {
  const [p] = useTheme();
  return <select className="fh-user fh-sel" aria-label="화면 밝기" data-theme-pick value={p} onChange={(e) => setThemePref(e.target.value as ThemePref)}>
    {THEMES.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select>;
}

const I = (d: JSX.Element) => <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">{d}</svg>;
const LOOK: Record<ThemePref, [JSX.Element, string]> = {
  dark: [I(<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />), '어두움'],
  light: [I(<><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>), '밝음'],
  system: [I(<><circle cx="12" cy="12" r="8" /><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" /></>), '기기 설정'],
};
/** PC 왼쪽 메뉴 «설정» 위(11-02) — 누를 때마다 어두움 → 밝음 → 기기 설정 따름. 보이는 글은 지금 값, 화면 읽기는 «화면 밝기 …» */
export function ThemeNav() {
  const [p] = useTheme(), i = THEMES.findIndex(([v]) => v === p), [next, nextName] = THEMES[(i + 1) % THEMES.length];
  const name = THEMES[i][1];
  return <button type="button" className="nav" data-theme-pick={p} aria-label={`화면 밝기 ${name}`} title={`화면 밝기: ${name} — 누르면 ${nextName}`}
    onClick={() => setThemePref(next)}>{LOOK[p][0]}{LOOK[p][1]}</button>;
}
