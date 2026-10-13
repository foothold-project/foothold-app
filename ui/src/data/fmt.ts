// 표시용 작은 도구 — web/live.js 의 같은 이름 함수와 같은 규칙(값이 없으면 «미확인»·«—», 예시값으로 채우지 않음).
import type { RunWaypoint } from '@contracts';

export const ok = (v: unknown): v is number => typeof v === 'number' && isFinite(v);
export const sgn = (v: unknown, d = 2, u = '') => (ok(v) ? (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(d) + u : '미확인');
// 서버 시각 «2026-10-13T12:46:00+0900»(콜론 없는 시간대)은 Safari 의 Date.parse 가 못 읽는다 → +09:00 으로 고쳐 읽는다. 못 읽으면 0.
export const tms = (at: unknown) => Date.parse(String(at || '').replace(/([+-]\d\d)(\d\d)$/, '$1:$2')) || 0;
export const fmtT = (at: unknown) => (at ? String(at).slice(5, 19).replace('T', ' ') : '—');
export const durTxt = (a: string, b?: string) => { const s = (tms(b) || Date.now()) - tms(a); return tms(a) ? `${Math.max(0, Math.round(s / 60000))}분` : '—'; };
export const wpName = (w: Pick<RunWaypoint, 'name'>, i: number) => `WP${i + 1}${w.name ? ` ${w.name}` : ''}`;
export const posTxt = (x: unknown, y: unknown) => (ok(x) && ok(y) ? `x ${sgn(x)} · y ${sgn(y)} m` : '위치 미확인');
export const LV: Record<string, string> = { ok: '●', warn: '▲', bad: '■' };
export const dayTxt = (at: string) => { const d = new Date(tms(at)), t = new Date(); const s = `${d.getMonth() + 1}월 ${d.getDate()}일`; return d.toDateString() === t.toDateString() ? `오늘 · ${s}` : s; };
export const csvOf = (head: string[], rows: unknown[][]) => [head.join(','), ...rows.map((r) => r.map((v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))).join(','))].join('\n');

// 브라우저 저장(이 기기만). 막혀 있어도 화면은 돈다.
export const store = {
  get<T>(k: string, d: T): T { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
};
// 원본 테마 규칙: 저장값(light/dark)이 있으면 그것, 없으면 시안 기본(PC 어두운 · 휴대폰 밝은)
export const themeClass = (pc: boolean) => { const t = store.get<string | null>('fh.live.theme', null); return (t ? t === 'light' : !pc) ? 'fh light' : 'fh'; };

// 내려받기(CSV 등). 실패는 돌려준 글로 알린다.
export function saveBlob(name: string, blob: Blob) {
  try {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000); return `내려받기 요청: ${name} · 안 보이면 브라우저 다운로드 목록·권한 확인`;
  } catch (e: any) { return `내려받기 실패: ${e?.message || e}`; }
}
