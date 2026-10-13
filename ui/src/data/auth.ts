// 로그인 — 화면은 전송층(data/transport 의 T: 웹 쿠키 관문 또는 네이티브 B) 하나만 쓴다. 계약 필드에 화면을 직접 묶지 않는다.
import { closeLink, dropAll, hide } from './link';
import { T } from './transport';

export const auth = T;

/** 로컬 로그인 의도 번호: 로그인 요청·로그아웃·로그인 화면 떠남마다 +1. 응답은 «보낸 때 번호 == 지금 번호»일 때만 채택
 *  (전송층이 새 gen 을 돌려줘도 로그아웃·주소 변경 뒤 옛 로그인 결과가 화면을 되살리지 않게). 토큰은 UI 가 저장하지 않는다 */
export const intent = { n: 0 };

export const PHONE = /iPhone|iPad|Android|Mobile/i.test(navigator.userAgent);
const LOGIN = ['MLogin', 'PcLogin'];
export const isLogin = (name: string) => LOGIN.includes(name);
/** 로그인 뒤 돌아갈 곳: 이 앱의 해시 경로만(다른 주소·로그인 화면 제외) */
export const safeNext = (nx: string | null, phone = PHONE) =>
  nx && /^#\/[A-Za-z]+(\?[^#\s]*)?$/.test(nx) && !isLogin(nx.slice(2).split('?')[0]) ? nx : phone ? '#/MDrive' : '#/Main';
export const loginHash = (next = location.hash) => `#/${PHONE ? 'MLogin' : 'PcLogin'}?next=${encodeURIComponent(next)}`;

/** 로그아웃: 누름 폐기 · hidden(조종권 해제 · 0 · STOP 잠금은 서버) → 세션 끝 → 로그인 화면(새로 읽어 링크도 새로) */
// 새로 읽지 않는다: 링크는 닫힌 채(closeLink), 서버 종료 확인(logoutResult)·저장 안내를 같은 페이지에서 계속 받는다. 로그인 성공이 새로 읽는다
export async function logoutNow(): Promise<string | null> {
  const my = ++intent.n; dropAll(); hide(); closeLink();   // 누름 버림·20 Hz 멈춤 → hidden 최선 → WS 닫기 → 로그아웃(계약 §2 순서)
  const r = await auth.logout();
  if (my !== intent.n) return null;   // 그 사이 다른 로그아웃·주소 변경·로그인 → 옛 결과로 화면을 바꾸지 않음
  if (!r.ok) return r.note || '로그아웃 실패';   // 디스크 폐기 실패 등: 성공으로 단정하지 않음 · 조종 잠금(링크 닫힘) 유지
  location.replace(loginHash('')); return null;
}
