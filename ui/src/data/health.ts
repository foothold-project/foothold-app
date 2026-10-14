// 관문 검사 판정(의존 0) — transport 가 gate_profile→auth→transport 순환 import 를 만들지 않게 따로 둔다
export type Health = { ok: true; ms: number } | { ok: false; step: 'reach' | 'tls' | 'gate' | 'busy' | 'none'; why: string };
/** 로그인 불요 검사 응답 판정 — 200 + 본문이 정확히 {app:'foothold-gate', api:정수≥1} 일 때만 «FOOTHOLD 관문» */
export function healthOk(status: number, body: string): boolean {
  if (status !== 200) return false;
  let d: any; try { d = JSON.parse(body); } catch { return false; }
  return !!d && typeof d === 'object' && !Array.isArray(d) && Object.keys(d).length === 2 && d.app === 'foothold-gate' && Number.isInteger(d.api) && d.api >= 1;
}

