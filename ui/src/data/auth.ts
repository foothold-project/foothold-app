// 로그인 전송층 — 화면은 이 모양(Auth)만 안다. 지금 구현은 웹 쿠키 관문(/api/login·/api/logout, 같은 출처) 하나.
// 네이티브 B(FhGate 계약 합의본)가 정해지면 이 파일의 `auth` 만 바꿔 끼운다(화면·link 는 그대로). 계약 v0 필드에 화면을 직접 묶지 않는다.
import { dropAll, hide } from './link';

export type LoginResult = { ok: true } | { ok: false; error: string };
export type Auth = {
  gated: boolean;   // 로그인이 있는 연결인가(아니면 이 PC 전용 주소 — 로그인 없음)
  login(user: string, pw: string, label: string): Promise<LoginResult>;
  logout(): Promise<void>;   // 실패해도 화면은 로그인으로 — 서버 세션은 만료·관문 재시작으로 끝남
};

const cookieAuth: Auth = {
  gated: location.protocol === 'https:',
  async login(user, pw, label) {
    try {
      const r = await fetch('api/login', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user, pw, device: label }) });
      const d = await r.json().catch(() => ({}));
      return r.ok && d.ok ? { ok: true } : { ok: false, error: d.error || `로그인 실패(HTTP ${r.status})` };
    } catch (e) { return { ok: false, error: `서버에 닿지 않음 · ${(e as Error).message || e}` }; }
  },
  async logout() { try { await fetch('api/logout', { method: 'POST', credentials: 'same-origin' }); } catch { /* 아래로 */ } },
};
export const auth: Auth = cookieAuth;

export const PHONE = /iPhone|iPad|Android|Mobile/i.test(navigator.userAgent);
const LOGIN = ['MLogin', 'PcLogin'];
export const isLogin = (name: string) => LOGIN.includes(name);
/** 로그인 뒤 돌아갈 곳: 이 앱의 해시 경로만(다른 주소·로그인 화면 제외) */
export const safeNext = (nx: string | null, phone = PHONE) =>
  nx && /^#\/[A-Za-z]+(\?[^#\s]*)?$/.test(nx) && !isLogin(nx.slice(2).split('?')[0]) ? nx : phone ? '#/MDrive' : '#/Main';
export const loginHash = (next = location.hash) => `#/${PHONE ? 'MLogin' : 'PcLogin'}?next=${encodeURIComponent(next)}`;

/** 로그아웃: 누름 폐기 · hidden(조종권 해제 · 0 · STOP 잠금은 서버) → 세션 끝 → 로그인 화면(새로 읽어 링크도 새로) */
export async function logoutNow() {
  dropAll(); hide();
  await auth.logout();
  location.replace(loginHash('')); location.reload();
}
