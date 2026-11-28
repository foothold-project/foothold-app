// 화면 언어(시안 u9_6 「언어」 · 한국어 / English). 이 기기에만 기억(localStorage fh.lang, theme.tsx 와 같은 방식 · 사용자별 서버 값은 계약에 없음).
// 화면 코드는 한국어 글 그대로 두고, 그려진 글(글 마디 · aria-label · title · placeholder)을 사전(lang.en.ts)으로 바꿔 끼운다.
// 원래 글은 마디마다 기억해 한국어로 돌아갈 때 되돌리고, React 가 글을 바꾸면 MutationObserver 가 그리기 전에 다시 바꾼다.
// translate="no" 안(시안 언어 보기 칸처럼 일부러 한 언어로 둔 곳)과 사전에 없는 글(서버 값 · 이름)은 건드리지 않는다. 숫자와 단위는 그대로.
import { useSyncExternalStore } from 'react';
import { EN, EN_RULES } from './lang.en';

export type Lang = 'ko' | 'en';
const KEY = 'fh.lang';
let picked: Lang | null = null;
const subs = new Set<() => void>();
let used = false;   // 영어를 한 번도 고르지 않았으면 지켜보기만 하고 아무 일도 하지 않음

export function langPref(): Lang {
  if (picked) return picked;
  try { return localStorage.getItem(KEY) === 'en' ? 'en' : 'ko'; } catch { return 'ko'; }
}
export function setLang(l: Lang) {
  picked = l;
  try { localStorage.setItem(KEY, l); } catch { /* 기억 못 해도 이 탭에는 반영 */ }
  subs.forEach((f) => f());
}
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
export const useLang = () => useSyncExternalStore(subscribe, langPref);

/** 한 줄 바꾸기: 앞뒤 빈칸은 그대로 두고 가운데 글을 사전 → 규칙 순으로. 없으면 null(그대로) */
export function en(s: string): string | null {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s)!, core = m[2];
  if (!core || !/[가-힣]/.test(core)) return null;
  let out = EN[core];
  if (out == null) for (const [re, f] of EN_RULES) { const g = re.exec(core); if (g) { out = f(g); break; } }
  return out == null ? null : m[1] + out + m[3];
}

const ATTRS = ['aria-label', 'title', 'placeholder'] as const;
type Pair = { ko: string; en: string };
const texts = new WeakMap<Text, Pair>();
const attrs = new WeakMap<Element, Map<string, Pair>>();
const skip = (n: Node) => !!(n.nodeType === 1 ? (n as Element) : n.parentElement)?.closest('[translate="no"],script,style');

function fixText(t: Text, l: Lang) {
  const cur = t.data, rec = texts.get(t);
  if (rec && (cur === rec.en || cur === rec.ko)) { const want = l === 'en' ? rec.en : rec.ko; if (cur !== want) t.data = want; return; }
  if (l === 'ko') return;
  const e = en(cur);
  if (e == null) { texts.delete(t); return; }
  texts.set(t, { ko: cur, en: e }); t.data = e;
}
function fixAttrs(el: Element, l: Lang) {
  for (const a of ATTRS) {
    const cur = el.getAttribute(a); if (cur == null) continue;
    let m = attrs.get(el); const rec = m?.get(a);
    if (rec && (cur === rec.en || cur === rec.ko)) { const want = l === 'en' ? rec.en : rec.ko; if (cur !== want) el.setAttribute(a, want); continue; }
    if (l === 'ko') continue;
    const e = en(cur); if (e == null) continue;
    if (!m) attrs.set(el, (m = new Map()));
    m.set(a, { ko: cur, en: e }); el.setAttribute(a, e);
  }
}
/** root 아래 모든 글 · 속성을 지금 언어로 */
export function applyLang(root: Node, l: Lang = langPref()) {
  if (root.nodeType === 3) { if (!skip(root)) fixText(root as Text, l); return; }
  if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
  if (root.nodeType === 1) { if (skip(root)) return; fixAttrs(root as Element, l); }
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: (n) => (n.nodeType === 1 && (n as Element).matches('[translate="no"],script,style') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = w.nextNode(); n; n = w.nextNode()) (n.nodeType === 3 ? fixText(n as Text, l) : fixAttrs(n as Element, l));
}

/** main.tsx 에서 한 번: 언어를 고르면 문서 전체를, 그 뒤 바뀐 곳만 그리기 전에(마이크로태스크) 바꾼다 */
export function syncLang(root: HTMLElement = document.body) {
  const all = () => { const l = langPref(); document.documentElement.lang = l; if (l === 'en') used = true; if (used) applyLang(root, l); };
  const ob = new MutationObserver((recs) => {
    const l = langPref();
    if (l === 'ko' && !used) return;
    for (const r of recs) {
      if (r.type === 'characterData') applyLang(r.target, l);
      else if (r.type === 'attributes') { if (!skip(r.target)) fixAttrs(r.target as Element, l); }
      else r.addedNodes.forEach((n) => applyLang(n, l));
    }
  });
  ob.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: [...ATTRS] });
  subs.add(all); all();
  return () => { ob.disconnect(); subs.delete(all); };
}
