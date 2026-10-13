// 생성된 화면 틀(*.view.tsx)이 쓰는 작은 도우미 — web/dc.js 실행기와 같은 규칙.
import type { CSSProperties, ReactNode } from 'react';

/** {{값}} → <span class="sc-interp">. null·true/false 는 안 그림(dc.js 와 같음) */
export const iv = (x: unknown): ReactNode =>
  x == null || typeof x === 'boolean' ? null : <span className="sc-interp">{String(x)}</span>;
/** SVG 글자 안: <tspan> (dc.js 10-12 승인 수정과 같음) */
export const ivs = (x: unknown): ReactNode =>
  x == null || typeof x === 'boolean' ? null : <tspan className="sc-interp">{String(x)}</tspan>;
/** 속성 안 {{값}}: null → 빈 글자 */
export const str = (x: unknown): string => (x == null ? '' : String(x));
export const arr = (x: unknown): any[] => (Array.isArray(x) ? x : []);
export const fn = (x: unknown) => (typeof x === 'function' ? (x as (e: any) => void) : undefined);
/** 값이 들어간 style 글자 → React style 객체 */
export function css(s: string): CSSProperties {
  const o: Record<string, string> = {};
  for (const d of s.split(';')) {
    const i = d.indexOf(':'); if (i < 0) continue;
    const k = d.slice(0, i).trim(), v = d.slice(i + 1).trim(); if (!k) continue;
    o[k.startsWith('--') ? k : k.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
  }
  return o as CSSProperties;
}
