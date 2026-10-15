// 표시용 작은 도구 — web/live.js 의 같은 이름 함수와 같은 규칙(값이 없으면 «미확인»·«—», 예시값으로 채우지 않음).
import { T } from './transport';
import type { RunWaypoint } from '@contracts';

export const ok = (v: unknown): v is number => typeof v === 'number' && isFinite(v);
// 실행 번호(run_id) = 소문자 hex 정확히 32자 — 서버 RUN_ID_RE.fullmatch 와 같은 뜻(길이도 함께 봄: 끝 개행·대문자·31/33자 거부). follow /2·raw 라이다 공용
export const runId = (v: unknown): v is string => typeof v === 'string' && v.length === 32 && /^[0-9a-f]{32}$/.test(v);
export const num = (v: unknown, d = 2, u = '') => (ok(v) ? v.toFixed(d) + u : '미확인');
export const deg = (r: unknown) => (ok(r) ? (r * 180 / Math.PI).toFixed(0) + '°' : '미확인');
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

// 내려받기(CSV·JSON). 결과는 돌려준 글로 알린다(toast 만, 화면 이동 없음). null = 버림(문맥이 바뀜).
//  bundled B(앱 출처 + FhGate): 전송층 T.saveFile — 저장 창 결과 + 시작 epoch·gen·화면 그대로일 때만 «저장됨»(계약 d4e5002).
//  원격 A·플러그인 없는 앱(실제 Capacitor 이지만 전송층은 web): 저장 미지원 — a.download 를 앱에서 성공으로 쓰지 않는다.
//  웹 브라우저: 기존 a.download + «내려받기 요청».
export async function saveBlob(name: string, blob: Blob): Promise<string | null> {
  if ((globalThis as any).Capacitor?.isNativePlatform?.()) {
    if (!T.saveFile) return '이 앱 판에서는 파일 저장 미지원(저장 안 됨)';
    const h = location.hash;
    return T.saveFile(name, blob, () => location.hash === h);
  }
  try {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000); return `내려받기 요청: ${name} · 안 보이면 브라우저 다운로드 목록·권한 확인`;
  } catch (e: any) { return `내려받기 실패: ${e?.message || e}`; }
}
