// 접속 프로필·주소 QR·로그인 전 관문 검사(①) — 순수 규칙. 비밀 0: 저장·QR·공유에는 관문 origin(https://호스트:포트)만.
// 계약 docs/CONTRACT-ui-improve-20261014.md ① · 모바일 mentor 안 A(probe)·B(localStorage 프로필)·C(평문 origin QR)
import { gateOrigin } from './auth';

export type Kind = 'lan' | 'tailscale' | 'other';
export type Profile = { id: string; name: string; kind: Kind; origin: string };
export const KIND_TXT: Record<Kind, string> = { lan: 'LAN', tailscale: 'Tailscale', other: '직접 입력' };
const KEY = 'fh.gate.profiles', MAX = 8;

/** 주소로 종류를 정한다(포트·주소를 고정하지 않음): 100.64.0.0/10·*.ts.net = Tailscale, 사설 대역·.local = LAN */
export function kindOf(origin: string): Kind {
  const h = new URL(origin).hostname, m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 100 && b >= 64 && b <= 127) return 'tailscale';
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'lan';
    return 'other';
  }
  return h.endsWith('.ts.net') ? 'tailscale' : h.endsWith('.local') ? 'lan' : 'other';
}

/** 저장본 읽기: 형식이 하나라도 틀리면 그 항목은 버림(origin 은 gateOrigin 재검사) */
export function parseProfiles(raw: string | null): Profile[] {
  let d: any; try { d = JSON.parse(raw || ''); } catch { return []; }
  if (!d || d.v !== 1 || !Array.isArray(d.profiles)) return [];
  const out: Profile[] = [];
  for (const p of d.profiles.slice(0, MAX)) {
    if (!p || typeof p.id !== 'string' || typeof p.name !== 'string' || typeof p.origin !== 'string' || !(p.kind in KIND_TXT)) continue;
    const g = gateOrigin(p.origin); if ('why' in g || g.origin !== p.origin || p.name.length > 40 || out.some((q) => q.origin === p.origin)) continue;
    out.push({ id: p.id.slice(0, 40), name: p.name, kind: p.kind, origin: p.origin });
  }
  return out;
}
/** 추가(같은 origin 이면 맨 앞으로) — 최대 8개, 오래된 것부터 밀려남 */
export function addProfile(list: Profile[], origin: string, now = Date.now()): Profile[] {
  const kind = kindOf(origin), old = list.find((p) => p.origin === origin);
  const p: Profile = old || { id: `p${now.toString(36)}`, name: `${KIND_TXT[kind]} · ${new URL(origin).host}`.slice(0, 40), kind, origin };
  return [p, ...list.filter((q) => q.origin !== origin)].slice(0, MAX);
}
export const loadProfiles = () => { try { return parseProfiles(localStorage.getItem(KEY)); } catch { return []; } };
export const saveProfiles = (l: Profile[]) => { try { localStorage.setItem(KEY, JSON.stringify({ v: 1, profiles: l })); return true; } catch { return false; } };

/** QR·붙여넣기 글 → 관문 origin. 평문 https origin 하나만(끝 «/» 허용). 그 밖(계정·토큰·질의·다른 형식)은 전부 거부 */
export function originFromText(t: string): { origin: string } | { why: string } {
  const s = (t || '').trim();
  if (!s || s.length > 200) return { why: '주소가 비었거나 너무 김' };
  return gateOrigin(s);
}

export { healthOk } from './health';
import type { Health } from './health';
export type { Health };

// 연결 단계: 형식 → 도달 → 인증서 → 관문 → 로그인 → 링크. «저장됨» ≠ «연결 확인됨»
export const STEPS = ['주소 형식', '도달', '인증서', 'FOOTHOLD 관문', '로그인', '링크'] as const;
export type StepSt = 'ok' | 'bad' | 'unk' | 'brw';   // brw = 웹 인증서 칸: 브라우저가 처리 — 사용자가 경고를 넘겼는지 JS 로 모름(확인됨 아님)
/** 검사 결과 → 앞 네 칸 상태. 실패 칸 뒤는 미확인. 인증서 «확인됨»은 네이티브 probe 성공(시스템+dev CA 검증)일 때만 */
export function stepsOf(h: Health | null, hasOrigin: boolean, web: boolean): StepSt[] {
  const out: StepSt[] = !hasOrigin ? ['bad', 'unk', 'unk', 'unk'] : !h ? ['ok', 'unk', 'unk', 'unk'] : h.ok ? ['ok', 'ok', 'ok', 'ok'] : (() => {
    const at = { reach: 1, tls: 2, gate: 3, busy: -1, none: -1 }[h.step];
    return at < 0 ? ['ok', 'unk', 'unk', 'unk'] : [0, 1, 2, 3].map((i) => (i < at ? 'ok' : i === at ? 'bad' : 'unk')) as StepSt[];
  })();
  if (web && hasOrigin) out[2] = 'brw';   // 웹은 https 로 열렸다는 사실만으로 인증서 신뢰를 확인됨으로 쓰지 않는다
  return out;
}
