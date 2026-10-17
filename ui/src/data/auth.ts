// 로그인 — 화면은 전송층(data/transport 의 T: 웹 쿠키 관문 또는 네이티브 B) 하나만 쓴다. 계약 필드에 화면을 직접 묶지 않는다.
import { closeLink, dropAll, hide } from './link';
import { T } from './transport';
import { dropScratch } from './scratch';

export const auth = T;
T.onEnded(dropScratch);   // 네이티브 세션 끝(이 세대) → 탭 보관 초안·선택 버림. 웹은 WS 4401(main.tsx authEnd)

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
  const my = ++intent.n; dropAll(); hide(); closeLink(); dropScratch();   // 누름 버림·초안/지점 선택 버림·20 Hz 멈춤 → hidden 최선 → WS 닫기 → 로그아웃(계약 §2 순서)
  const r = await auth.logout();
  if (my !== intent.n) return null;   // 그 사이 다른 로그아웃·주소 변경·로그인 → 옛 결과로 화면을 바꾸지 않음
  if (!r.ok) return r.note || '로그아웃 실패';   // 디스크 폐기 실패 등: 성공으로 단정하지 않음 · 조종 잠금(링크 닫힘) 유지
  location.replace(loginHash('')); return null;
}

/** 관문 주소 1차 검사 — 네이티브 FhGateCore.gateOrigin(정본·최종 검사)과 같은 규칙: https · ASCII · 사용자정보/경로/질의/조각 없음 ·
 *  호스트 소문자 · localhost 금지 · 포트 0~65535(443·앞자리 0 표기 금지 — 정규화와 다름) · 끝 «/» 하나 허용. 통과 → 정규화 origin, 아니면 이유 */
const LABEL = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?';
const ORIGIN = new RegExp(`^https://(${LABEL}(?:\\.${LABEL})*|\\[[0-9a-f:.]+\\])(?::(0|[1-9][0-9]{0,4}))?/?$`);
export function gateOrigin(raw: string): { origin: string } | { why: string } {
  if (!raw || /[\s#@*\\]/.test(raw) || /[^\x21-\x7e]/.test(raw)) return { why: '공백·#·@·*·\\·한글 등이 든 주소는 받지 않음' };
  if (!raw.startsWith('https://')) return { why: 'https:// 로 시작하는 주소만(소문자)' };
  const m = ORIGIN.exec(raw);
  if (!m) return { why: '«https://호스트:포트» 만 — 경로·질의·대문자 없이' };
  const port = m[2] == null ? null : Number(m[2]);
  if (port != null && (port > 65535 || port === 443)) return { why: port === 443 ? '443 은 적지 않음(기본 포트)' : '포트 범위 밖(0~65535)' };
  if (m[1] === 'localhost' || m[1].endsWith('.localhost')) return { why: 'localhost 는 안 됨 — 관문의 실제 주소' };
  return { origin: raw.replace(/\/$/, '') };
}
