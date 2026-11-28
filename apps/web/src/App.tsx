// 화면 틀(03 UX §3, 09 ADR-002 §3·§4): PC(총괄 웹) = 머리줄 + 상태 띠 + 왼쪽 세로 메뉴 + 본문(실기 조종 탭 없음 — 시뮬은 «시뮬» 탭),
// 폰(768px 미만) = 머리줄 + 본문 — 로봇 연결(#/drive) → 조종(#/drive/<로봇 id>) → 끝내기, 기록은 머리줄 ⋯ 에서. 아래 탭 줄은 없다.
// 머리줄 오른쪽 묶음(연결 점 · 알림 · 사용자 · STOP)은 모든 화면에서 같다. 사용자·로봇 목록은 받은 값(session.tsx 가 서버에서),
// 로봇 연결·상태·조종권·STOP 은 실시간 연결(rt.ts), 알림 종은 GET /notifications(screens/history.tsx), 지도는 /sites·/map-versions(screens/maps.tsx),
// 결재는 /approvals(screens/approvals.tsx — 탭 배지는 /dashboard approvals_pending), 나머지는 가짜.
import { Component, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { User as ApiUser } from '../../contracts/ts';
import { BrandLogo } from './BrandLogo';
import { ROBOTS, ROLE_NAME, USERS, idleSim, lost, lostText, myRobots, robotsFor, type Robot, type User } from './fake';
import { PC_BOTTOM, PC_TABS, PHONE_SCAN, labelOf, leaving, oldScenario, tabFromHash, tabsFor, type Tab, type TabId } from './menu';
import { rt, undelivered, useRt, withLive, type Live } from './rt';
import { BODY, EmptyFleet, inApp, useDash, type Ctx } from './screens';
import { RobotTab } from './screens/u4/robotu4';
import { pcBoard } from './pcboard';
import { Connect, NO_ROBOT, endDrive } from './drive';
import { sim, useSim } from './phone';
import { SimDrive, SimPip, stopText as simStopText, type Cam } from './simdrive';
import { SimWindow } from './simwin';
import { media } from './media';
import { RealDrive } from './realdrive';
import { Approvals } from './screens/approvals';
import { Bell, History } from './screens/history';
import { kept } from './screens/mapedit';
import { Maps } from './screens/maps';
import { MissionTab, keptMission } from './screens/missiontab';
import { MissionsU6 } from './screens/missionsu6';
import { Settings } from './screens/settings';
import { SettingsU9 } from './screens/settingsu9';
import { EmptyControl, useControlPick } from './screens/control';
import { SimTab } from './screens/sim';
import { Terrain } from './screens/terrain';
import { Trash } from './screens/trash';
import { ScanPanel, ScanStart } from './screens/scanentry';
import { ThemeNav, ThemePick, useTheme } from './theme';
import { BellFace, PcBar, STOP_FACE } from './proto/bar';
import { setStage } from './stage';
import { Control5 } from './proto/u5';

/** STOP 결과 한 줄 — 서버가 받았는지와 로봇이 알린 잠금을 나눠 쓴다. 확인 안 된 «정지됨»은 쓰지 않는다(F-COM-01) */
function stopText(r: Robot, l: Live) {
  const s = l.stop, st = l.state;
  if (!s) return '';
  if (s.phase === 'sending') return `■ ${r.name} 정지 요청을 보내는 중입니다.`;
  if (s.phase === 'failed') return `▲ ${r.name} 정지 요청을 보내지 못했습니다. ${s.why ?? ''} 현장에서 로봇을 직접 멈추세요.`;
  if (s.phase === 'unsure') return `▲ ${r.name} 정지 요청을 보냈지만 서버 접수를 확인하지 못했습니다. ${s.why ?? ''} 현장에서 로봇을 직접 멈추세요.`;
  const no = undelivered(s, st); if (no) return `▲ ${r.name} ${no}`;
  // 대체 경로로 보낸 뒤에는 다시 연결되어 요청 뒤 state 가 와야 로봇 확인을 본다
  if (s.phase === 'fallback' && !(st && l.stateAt > s.at)) return `■ ${r.name} 정지 요청됨(대체 경로) — 실시간 연결이 끊겨 로봇 확인은 보이지 않습니다. 현장을 확인하세요.`;
  if (!st || l.stateAt <= s.at) return `■ ${r.name} 정지 요청됨 — 서버가 받았습니다. 로봇 확인을 기다립니다.`;
  if (st.phone_relay && (st.connection !== 'ONLINE' || st.latched === null || st.applied === null))
    return `▲ ${r.name} 정지 요청됨 — 폰 경유 자료는 받았지만 직접 로봇 보고로 정지를 확인하지 못했습니다. 현장을 확인하세요.`;
  if (st.connection !== 'ONLINE') return `▲ ${r.name} 정지 요청 뒤 로봇 연결이 끊겼습니다. 지금 상태는 알 수 없습니다. 현장을 확인하세요.`;
  if (!st.latched) return `■ ${r.name} 정지 요청됨 — 로봇이 아직 잠금을 알리지 않았습니다.`;
  // applied 가 비었거나 없으면 출력 보고가 없는 것(현장 승인 관문이 닫힌 에이전트는 latched · applied [] 만 보냄). [].every 는 참이라 따로 거른다
  if (!st.applied?.length) return `▲ ${r.name} 정지 잠금 · 멈춤 출력은 확인되지 않았습니다 (현장 승인이 닫혀 있을 수 있음). 리모컨이나 현장에서 멈추세요.`;
  return st.applied.every((v) => v === 0) ? `■ ${r.name} 정지 잠금 · 로봇이 잠금과 멈춤 출력을 알렸습니다.` : `▲ ${r.name} 정지 잠금 · 출력이 아직 멈추지 않았습니다. 현장을 확인하세요.`;
}

/** 서버 끊김 폰 STOP(d2) 결과를 같은 결과끼리 한 줄로(로봇 이름만 나열 · 폰 말풍선 줄이기). 사유가 같으면 한 번, 다르면 로봇별로 짧게 뒤에.
 *  대체 경로로 접수됐지만 보낼 때 끊겨 있던 로봇(off)은 관제와 같은 «아직 닿지 않음 · 상태 모름» 줄. 로봇이 정지 뒤 상태를 알린 로봇은 기존 한 줄(stopText) */
function groupStops(rs: Robot[], live: (id: string) => Live, off: string[], now: (r: Robot) => Robot) {
  const of = (p: string) => rs.filter((r) => live(r.id).stop?.phase === p);
  const names = (l: Robot[]) => l.map((r) => r.name).join(' · ');
  const why = (l: Robot[]) => { const w = l.map((r) => (live(r.id).stop?.why ?? '').trim());
    if (w.every((x) => !x)) return ''; if (w.every((x) => x === w[0])) return ` 사유: ${w[0]}`;
    return ` 사유: ${l.map((r, i) => (w[i] ? `${r.name} ${w[i]}` : '')).filter(Boolean).join(' · ')}`; };
  const line = (k: string, t: string) => <span key={`stop-g-${k}`} data-stop-band data-stop-group={k}>{t}</span>;
  const sending = of('sending'), failed = of('failed'), unsure = of('unsure');
  // 대체 경로 접수인데 로봇 확인 전: 보낼 때 끊겨 있었으면 «아직 닿지 않음», 아니면 «정지 요청됨(대체 경로)»
  const fb = of('fallback').filter((r) => { const l = live(r.id); return !(l.state && l.stateAt > (l.stop?.at ?? 0)); });
  const away = fb.filter((r) => off.includes(r.id) && !now(r).online), lostOnes = away.filter((r) => lost(now(r))), unknown = away.filter((r) => !lost(now(r)));
  const fbOk = fb.filter((r) => !away.includes(r));
  const done = new Set([...sending, ...failed, ...unsure, ...fb].map((r) => r.id));
  return [
    sending.length && line('sending', `■ ${names(sending)} 정지 요청을 보내는 중입니다.`),
    failed.length && line('failed', `▲ ${names(failed)} 정지 요청을 보내지 못했습니다. 현장에서 직접 멈추세요.${why(failed)}`),
    unsure.length && line('unsure', `▲ ${names(unsure)} 정지 요청을 보냈지만 서버 접수를 확인하지 못했습니다. 현장에서 직접 멈추세요.${why(unsure)}`),
    lostOnes.length && <span key="stop-g-lost" data-stop-band data-stop-group="lost" data-stop-lost={lostOnes.map((r) => r.id).join(' ')}>▲ {lostSent({ ...lostOnes[0], name: names(lostOnes) })}</span>,
    unknown.length && <span key="stop-g-unknown" data-stop-band data-stop-group="unknown" data-stop-unsure={unknown.map((r) => r.id).join(' ')}>▲ {names(unknown)} 서버 접수 · 로봇 상태 모름 · 정지가 닿지 않을 수 있음 · 현장에서 확인하세요.</span>,
    fbOk.length && line('fallback', `■ ${names(fbOk)} 정지 요청됨(대체 경로) · 다시 연결됨 · 로봇의 정지 확인을 기다리는 중. 현장을 확인하세요.`),
    ...rs.filter((r) => !done.has(r.id)).map((r) => <span key={`stop-${r.id}`} data-stop-band>{stopText(r, live(r.id))}</span>),
  ].filter(Boolean);
}

// 폭 768px 미만 = 폰(02 §1.3). 예외: 손가락 입력이고 가로이며 높이 480px 이하면 눕힌 폰 — 폰 조종 탭은 가로 화면(03 §5.7·§7).
// 마우스 쓰는 낮은 PC 창(1440×400 등)은 PC 틀 유지(10-19 조정 결정 R1)
/** 알림 링크가 여는 항목(주소 매개변수 이름) */
const FOCUS: Partial<Record<TabId, string>> = { history: 'event_id', approval: 'approval_id' };
/** 임무 탭 주소(옛 #/mission·#/mission/<id>·?scenario_id= 포함)면 임무 탭이 그 임무를 고르게. 북마크·알림 링크가 깨지지 않게(W2). 임무 탭 주소였으면 true */
const toMission = (h: string) => { const id = oldScenario(h); if (id == null) return false; if (id) keptMission.sel = id; return true; };

export const PHONE_Q = '(max-width: 767.98px), (pointer: coarse) and (orientation: landscape) and (max-height: 480px)';
const watchQ = (q: string) => (f: () => void) => { const m = matchMedia(q); m.addEventListener('change', f); return () => m.removeEventListener('change', f); };
const COARSE = '(pointer: coarse)', watchPhone = watchQ(PHONE_Q), watchCoarse = watchQ(COARSE);
export const usePhone = () => useSyncExternalStore(watchPhone, () => matchMedia(PHONE_Q).matches);
const useCoarse = () => useSyncExternalStore(watchCoarse, () => matchMedia(COARSE).matches);   // 손가락 입력 — 마우스 총괄의 PC 틀 판정(11-11). 키보드 떼는 2-in-1 처럼 중간에 바뀌어도 따라감
// 전체화면(⋯ 메뉴): Fullscreen API 가 되는 브라우저(Android Chrome 등)만 단추. 아이폰은 웹 요소 전체화면을 막아 «홈 화면에 추가» 안내만.
// Android 앱(inApp)은 껍데기가 늘 전체화면이라 둘 다 없음. 루트 data-drive = 조종 화면(폰 조종·시뮬 조종) — 앱이 읽어 그때만 가로로 고정
// 화면 전환일 뿐이라 조종권·입력·STOP 경로는 건드리지 않는다
const watchFull = (f: () => void) => { document.addEventListener('fullscreenchange', f); return () => document.removeEventListener('fullscreenchange', f); };
const useFull = () => useSyncExternalStore(watchFull, () => !!document.fullscreenElement);
const canFull = () => !!document.fullscreenEnabled && typeof document.documentElement.requestFullscreen === 'function';
const installed = () => matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches || (navigator as { standalone?: boolean }).standalone === true;
const toggleFull = () => { (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {}); };

// 글 입력칸 = 띄어쓰기를 받는 곳(10-20 사용자 결정). readonly·disabled 는 글을 넣지 못하니 아님
const TYPED = new Set(['text', 'search', 'password', 'email', 'url', 'tel', 'number']);
export function typing(t: EventTarget | null) {
  if (t instanceof HTMLTextAreaElement) return !t.readOnly && !t.disabled;
  if (t instanceof HTMLInputElement) return TYPED.has(t.type) && !t.readOnly && !t.disabled;   // type 없음 = 'text'
  // contenteditable 은 브라우저 규칙대로(jsdom 은 isContentEditable 없음): 대소문자 무시, true·빈 값·plaintext-only = 편집,
  // false = 편집 아님, 잘못된 값·없음 = 상위를 따름
  for (let e = t instanceof Element ? t : null; e; e = e.parentElement) {
    const v = e.getAttribute('contenteditable')?.toLowerCase();
    if (v === '' || v === 'true' || v === 'plaintext-only') return true;
    if (v === 'false') return false;
  }
  return false;
}

/** 정지 단추 누름(RV-456 1) = pointerdown 즉시 — 스틱을 쥔 채 누른 두 번째 손가락엔 click 이 생기지 않는다. 주 단추(왼쪽·손가락)만.
 *  click 은 바로 그 누름(같은 pointerId 가 이 단추에서 눌러 이 단추에서 뗀 지 0.3초 안)일 때만 넘긴다(한 누름 = 한 번 — 고르기 창이 열린 뒤 click 이 곧바로 정지하지 않게).
 *  취소·뗌 없음(단추가 사라짐)·다른 손가락·늦은 click 은 다시 정지 — 두 번 나가도 0건은 없게(RV-457 1). 키보드 Enter(detail 0)는 늘 정지.
 *  data-stop-press = 초점이 이 단추에 있으면 Space 도 이 단추의 정지(App 전역 Space, RV-457 3) */
export function useStopPress(f: () => void) {
  const p = useRef<{ id: number; up: number | null } | null>(null);
  return {
    'data-stop-press': '',
    onPointerDown: (e: { button: number; pointerId: number }) => { if (e.button !== 0) return; p.current = { id: e.pointerId, up: null }; f(); },
    onPointerUp: (e: { pointerId: number }) => { if (p.current?.id === e.pointerId) p.current.up = performance.now(); },
    onPointerCancel: () => { p.current = null; },
    onClick: (e: { detail: number; nativeEvent: Event }) => {
      const q = p.current, id = (e.nativeEvent as { pointerId?: number }).pointerId; p.current = null;
      if (!(e.detail && q?.up != null && (id == null || id === q.id) && performance.now() - q.up < 300)) f();
    },
  };
}

/** STOP — 모든 탭·두 틀에 늘 보임(총괄은 정지할 시뮬 로봇이 있을 때만 — 실기 STOP 은 운영자 폰. 폰 홈은 멈출 것이 없다고 확인될 때만 숨김 — App calm). 폰 64px, PC 44px 이상(U7). 누르면 서버에 정지 요청(로봇이 0 + 잠금) */
/** STOP 고르기의 «모두 정지» 값(로봇 id 와 겹치지 않음) */
const ALL = '\u0000all';
const LINE = { flexBasis: '100%' };   // 고르기 창 안 한 줄(줄바꿈 칸)
/** 끊긴 로봇 정지: 서버는 받아 두지만 로봇에는 아직 닿지 않음(R1) · 붙은 로봇의 «정지 요청됨»과 같게 보이지 않게 */
/** 실시간 링크 끊김 · 첫 state 전 로봇 정지(A1): 닿았는지 화면이 모른다 */
const unsureStop = (r: Robot) => `${r.name} 상태 모름 · 정지가 닿지 않을 수 있음 · 현장에서 확인하세요`;
// #529 H2: 서버는 에이전트가 없으면 STOP 을 받아 두지 않는다. 나중에 전달된다고 약속하지 않는다. 다시 붙으면 로봇은 잠긴 채 시작(연결 STOP · SF-02)
const LOST_TAIL = '다시 연결되면 로봇은 잠긴 상태로 시작합니다. 지금 멈춰야 하면 리모컨이나 현장에서 멈추세요.';
const lostStop = (r: Robot) => `${r.name} 연결 끊김 · 정지를 보낼 수 없습니다. ${LOST_TAIL}`;
const lostSent = (r: Robot) => `${r.name} 연결이 끊겨 정지를 보내지 못했습니다. ${LOST_TAIL}`;
/** #529 H1: 서버 경유 조종이 꺼진 실기. 서버는 이 로봇의 stop 을 에이전트로 보내지 않는다(realtime blocked_agent_control). 목록 값 server_drive_allowed 로 가름(보수적) */
// r2 H1: server_drive_allowed 는 조종 허용이라 STOP 판정에 쓰지 않는다(인증 갱신 지연에도 false · 서버는 STOP 을 전달). 빼지 않고 보내며 안내 한 줄만
const noServerStop = (r: Robot) => !r.sim && r.serverDrive !== true;
/** 서버가 받은 정지(WS 접수 · 대체 경로). 거절 · 불확실 · 보내는 중이면 그 결과 글이 앞선다(r2 M2) */
const taken = (l: Live) => l.stop?.phase === 'sent' || l.stop?.phase === 'fallback';
/** 서버 경유 정지가 꺼진 실기(SWITCH_OFF): 서버가 STOP 을 PHONE_DIRECT_REQUIRED 로 거절한다 · 현장 폰에서만 (Codex #535 M4) */
const phoneOnly = (r: Robot) => !r.sim && !!r.serverDriveBlocked?.includes('SWITCH_OFF');

export function Stop({ phone, onStop }: { phone: boolean; onStop: () => void }) {
  return <button type="button" className="fh-stop" aria-label="비상 정지" data-stop style={{ minHeight: phone ? 64 : 44, minWidth: phone ? 96 : 120 }} {...useStopPress(onStop)}>
    <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 2h8l6 6v8l-6 6H8l-6-6V8z" fill="none" stroke="#FFFFFF" strokeWidth="2" /><rect x="8" y="8" width="8" height="8" fill="#FFFFFF" /></svg>
    <span className="fh-stop-t"><span>STOP</span>{!phone && <small>정지 요청</small>}</span>
  </button>;
}

/** 화면 일부의 렌더 예외가 머리줄·STOP 까지 내리지 않게 가둔다(SF-01). STOP 은 늘 이 경계 밖. quiet = 아무것도 그리지 않음(머리줄 알림 종) */
export class Guard extends Component<{ children: ReactNode; quiet?: boolean }, { broken: boolean }> {
  state = { broken: false };
  static getDerivedStateFromError() { return { broken: true }; }
  render() {
    if (!this.state.broken) return this.props.children;
    return this.props.quiet ? null : <section className="lv-card" role="alert" aria-label="화면 오류"><h2>이 화면을 그리지 못했습니다</h2>
      <p className="lv-note">다른 탭으로 옮겼다가 돌아오거나 새로고침하세요. STOP 은 그대로 쓸 수 있습니다.</p></section>;
  }
}

/** user·robots = 서버 /me·/robots?scope=<listScope> 값(시험은 가짜 자료) — 운영 관리자는 내게 배정된 로봇만. 남은 남의 로봇은 보는 중(조종 비활성 + 이유, STOP 은 됨). fresh = 그 목록을 요청한 시각(rt.now()).
 *  logout 이 있으면 머리줄에 로그아웃. setMe = 내 정보가 서버에서 바뀌었을 때(설정 탭). refresh = 로봇 목록 다시 받기. cancel = 이 로그인 세션의 취소 신호(화면 요청용).
 *  note = 띠에 올릴 한 줄(로그아웃 실패 등). */
/** PC 무대 = 시안 1920 × 1080. 창 크기에 맞춰 비율 그대로 줄이거나 늘리고(transform scale) 남는 쪽은 바탕색. 어떤 창에서도 스크롤 바 없음 */
export const STAGE_W = 1920, STAGE_H = 1080;
export function stageFit(w: number, h: number) { const s = Math.min(w / STAGE_W, h / STAGE_H); return { s, x: (w - STAGE_W * s) / 2, y: (h - STAGE_H * s) / 2 }; }
function useStage() {
  const [v, setV] = useState(() => stageFit(innerWidth, innerHeight));
  useEffect(() => { const on = () => setV(stageFit(innerWidth, innerHeight)); addEventListener('resize', on); return () => removeEventListener('resize', on); }, []);
  return v;
}

export function App({ user = USERS[0], robots: listed = ROBOTS, fresh = 0, refresh = () => {}, stale = false, logout, setMe = () => {}, cancel, note }: { user?: User; robots?: Robot[]; fresh?: number; refresh?: () => void; stale?: boolean; logout?: () => void; setMe?: (u: ApiUser) => void; cancel?: AbortSignal; note?: string }) {
  const stage = useStage();
  // 마우스 쓰는 총괄은 좁은 창(PC 200% 확대·반쪽 창)에서도 PC 틀 — 지도·시뮬·설정은 폰 틀에 없다(11-11 현민님, WCAG 1.4.4)
  const coarse = useCoarse(), phone = usePhone() && !(user.role === 'ORG_ADMIN' && !coarse), full = useFull();
  useRt();
  const robots = listed.map(withLive), net = rt.link();
  // 상태 구독은 볼 수 있는 로봇만: 총괄 전체, 운영 관리자는 담당 로봇(남의 로봇은 목록 요약만 — 구독하면 서버가 연결을 닫는다)
  const mine = listed.filter((r) => user.role === 'ORG_ADMIN' || r.owner === user.id).map((r) => r.id).join();
  useEffect(() => { rt.connect(mine ? mine.split(',') : []); return () => rt.disconnect(); }, []);
  useEffect(() => rt.follow(mine ? mine.split(',') : [], fresh), [mine, fresh]);   // 목록 갱신으로 담당이 바뀌면 구독도(소켓은 그대로)
  // 원하는 탭(주소)과 보이는 탭을 나눈다: 보이는 탭은 렌더마다 지금 틀(PC/폰)에서 도출 — 폭이 바뀌어 틀에 없는 탭이면 첫 탭(B1)
  const [want, setWant] = useState(() => (toMission(location.hash), location.hash)), tab = tabFromHash(want, phone), sub = want.split('/')[2];
  // 알림 링크 #/history?event_id=<id> — 기록 탭이면 그 사건을 위에 보인다, #/approvals?approval_id=<id> — 결재 탭이면 그 결재를 연다(주소에도 남김)
  const fk = FOCUS[tab], focus = fk ? new URLSearchParams(want.split('?')[1] ?? '').get(fk) ?? undefined : undefined;
  // 고를 수 있는 로봇: PC 는 받은 목록(총괄 전체, 운영 관리자 내 로봇), 폰은 내 로봇(총괄은 전체 · 11/28). 끝낸 시뮬 슬롯(idleSim)은 둘 다 뺀다. 고른 값이 범위 밖이면 첫 로봇
  const pool = (phone ? myRobots(user, robots) : robotsFor(user, robots)).filter((r) => !idleSim(r));
  // 기록 탭 로봇 거르기·배정 해제는 끝낸 시뮬 슬롯도 찾아야 한다(지난 시뮬 기록·슬롯에 남은 배정) — PC 의 그 두 탭만 슬롯을 남긴 목록(새 배정·임무 로봇 고르기는 그 화면이 뺀다)
  // 로봇 탭도 슬롯을 남긴 목록 — 화면은 시뮬을 모두 빼고, 요약(서버 /dashboard 는 슬롯도 셈)에서 그 몫을 뺀다(REVIEW-315 2)
  const withSlots = phone ? pool : robotsFor(user, robots);
  // 폰 #/drive/<로봇 id> = 그 로봇 조종 화면(시뮬 로봇은 서버 경유 조종 화면을 열지 않음 — 직결만), #/drive = 로봇 연결(ADR-002 §3.1). PC 에는 조종 화면이 없다
  const open = phone && tab === 'drive' && pool.some((r) => r.id === sub && !r.sim), path = open ? `#/drive/${sub}` : `#/${tab}${focus ? `?${fk}=${encodeURIComponent(focus)}` : ''}`;
  // 시뮬 직결 조종 화면(#/drive 그대로 — 시뮬 로봇은 서버 경유 조종 화면을 쓰지 않는다). 로그아웃·화면 내림이면 직결을 닫고 비운다
  // 작은 창(RB-SIM-PIP): 시뮬 조종 화면 나가기(반납 확인) 뒤 연결·영상은 그대로 구석에 — small = 그때 보던 영상. 시뮬 직결이 끝나면(끝내기·닫기·끊고 처음으로) 거둔다
  const sv = useSim(), simUp = phone && sv.step === 'drive' && !sv.real, [small, setSmall] = useState<Cam | null>(null);
  const simOpen = phone && tab === 'drive' && !open && sv.step === 'drive' && !(simUp && small);
  useEffect(() => { if (!simUp) setSmall(null); }, [simUp]);
  // 두 영상 채널은 조종 화면·작은 창이 바뀌는 사이에도 받는다(일회 토큰 — 받는 칸이 0 이 되면 닫혀 부모 연결을 다시 열어야 함). 구독은 안 함(App 다시 그림 0)
  useEffect(() => { if (!simUp) return; media.want('external', 1); media.want('rgb', 1); return () => { media.want('external', -1); media.want('rgb', -1); }; }, [simUp]);
  useEffect(() => () => sim.clear(), []);
  useEffect(() => sim.as(user.name), [user.name]);   // 폰 · 시뮬 탭 hello.display_name(#537) · 받는 쪽 LEASE_HELD 안내의 «OO 님»
  const [rid, setRid] = useState(''), robot: Robot | undefined = pool.find((r) => r.id === (open ? sub : rid)) ?? pool[0];   // 0대면 undefined — 본문은 «로봇 없음»
  useEffect(() => { if (robot) setRid(robot.id); }, [robot?.id]);
  const dash = useDash(cancel);   // 관제 칸과 결재 탭 배지가 같은 값(한 곳에서 받음)
  const [stopped, setStopped] = useState<Robot[]>([]), [ctlOff, setCtlOff] = useState<string[]>([]), [relatch, setRelatch] = useState<string[]>([]), [simStop, setSimStop] = useState(false), [, light] = useTheme();   // stopped = 마지막으로 STOP 한 로봇(관제 «모두 정지»면 여러 대)
  // STOP 대상(F-COM-01) = 지금 화면이 가리키는 로봇: 폰은 조종 화면의 로봇(내 로봇이 한 대뿐이면 어느 화면이든 그 로봇), PC 는 로봇 탭에서 고른 로봇.
  // 그 밖(로봇 연결·시나리오·기록 등)은 대상이 없어 STOP 이 «로봇 고르기»를 펼친다 — 내 조종권 로봇이 기본, 다시 누르면 그 로봇 정지
  // 총괄도 실기 STOP(11/28 · 서버 #544 · #547): 실기는 운영 관리자처럼 후보. 시뮬은 내가 띄운 것만(IDLE 슬롯은 담당을 비운 채 남는다)
  const mayStop = (r: Robot) => !idleSim(r) && (user.role !== 'ORG_ADMIN' || !r.sim || r.owner === user.id);
  // 관제 탭(D1 · app-design-lx 05:12): 타일에서 고른 로봇(관제 안 고름 — 로봇 탭의 rid 가 아님)이 정지 가능하면 그 로봇이 대상(한 번 누름).
  // 고른 것이 없으면 대상 없음 → 첫 누름 = 고르기, 맨 위 «모두 정지(N 대)» = 정지 가능한 연결된 로봇 전부(같은 자리 두 번째 누름·Enter 로 보냄)
  const ctl = !phone && tab === 'control', ctlSel = useControlPick(), ctlPick = ctl ? pool.find((r) => r.id === ctlSel && mayStop(r)) : undefined;
  const target = open || (!phone && tab === 'fleet') ? robot : ctlPick ?? (phone && pool.length === 1 ? pool[0] : null);
  const stops = pool.filter(mayStop), canStop = target ? mayStop(target) : user.role !== 'ORG_ADMIN' || !!stops.length;
  // r2 H1: 관제 고르기 · 모두 정지 후보에서 서버 경유 여부로 빼지 않는다. 꺼져 있을 수 있는 실기는 안내 한 줄(보냄 · 결과는 정지 띠)
  const here = stops;
  const noSrv = ctl ? stops.filter((r) => noServerStop(r) && !phoneOnly(r) && (r.online || lost(r) || r.unknown === 'link' || r.unknown === 'wait')) : [];
  // 모두 정지 = 정지 가능한 로봇 중 붙어 있거나 실시간으로 끊김이 확인된 로봇(lost · 연결 전과 구독 밖 요약 로봇은 뺌, R1 · app-lx: 서버는 끊긴 로봇 정지를 받아 두고 다시 붙으면 먼저 멈춤).
  // 끊긴 로봇은 고르기 창 · 정지띠에서 «아직 닿지 않음»으로 따로 보인다(서버 delivered 값 전까지 화면 online 으로 가름). 연결 전(상태 0)은 뺀다
  // A1: 실시간 링크 끊김 · 거부(unknown 'link')와 첫 state 전('wait')도 넣는다. 그 줄은 «상태 모름»으로 따로
  const every = ctl ? here.filter((r) => !phoneOnly(r) && (r.online || lost(r) || r.unknown === 'link' || r.unknown === 'wait')) : [], cut = every.filter((r) => lost(r)), unsure = every.filter((r) => !r.online && !lost(r));
  // 관제에서 떠 있는 내 시뮬(Sonnet 3)은 모두 정지에 든다. 목록에 아직 없으면(띄우는 중) 한 대로 더 센다
  const mySim = ctl ? sim.live() : null, simX = !!mySim && !every.some((r) => r.id === mySim.robot_id), allN = every.length + (simX ? 1 : 0);
  // R2: 고른 타일을 이 계정이 못 세우면 «고른 로봇 없음» 흐름 + 고르기 맨 위 한 줄
  const cantPick = ctl && ctlSel && !ctlPick ? pool.find((r) => r.id === ctlSel) : undefined;
  // 후속 1: 화면의 실기 중 이 계정이 못 세우는 것(총괄 = 실기 STOP 없음, 10-25). 있으면 라벨을 실제 대상대로 · 그 수를 한 줄로. 0 대면 줄 없음
  const realOff = ctl ? pool.filter((r) => !r.sim && !mayStop(r) && (r.online || lost(r) || r.unknown === 'link' || r.unknown === 'wait')) : [];
  // t21 · 07:09: 연결 전 로봇(상태 보고 0 · 마지막 상태 없음, 구독 밖 요약 로봇은 아님)은 모두 정지 수에 넣지 않고 그 수만 한 줄로. 총괄도 같음
  const pre = ctl ? pool.filter((r) => !r.online && !r.unknown && !lost(r)) : [];
  const fieldOnly = ctl ? stops.filter((r) => phoneOnly(r) && (r.online || lost(r) || r.unknown === 'link' || r.unknown === 'wait')) : [], off = realOff.length + fieldOnly.length;
  const simOnly = !!off && every.every((r) => r.sim), allName = simOnly ? '내 시뮬 모두 정지' : off ? '멈출 수 있는 로봇 모두 정지' : '모두 정지';
  // 떠 있거나 띄우는 중인 내 시뮬(sim.live())이 있으면 STOP·Space 는 그 슬롯으로 — 폰 조종 화면, PC 로봇 탭에서 고른 정지 가능한 로봇은 예외(그 로봇)
  const toSim = !open && !!sim.live() && (ctl ? !target && !stops.length : phone || !target || !canStop);   // 관제는 고르기(D1) · 정지 가능 로봇이 하나도 없을 때만 시뮬로 바로
  // 폰 홈(로봇 연결) 머리의 STOP 은 멈출 것이 하나도 없다고 확인될 때만 숨긴다(10-28 사용자). 멈출 것 = 연결된 로봇·조종권자가 있는 로봇(내 조종권·반납 확인 중·실행 포함)·끝나지 않은 실행·
  // 떠 있는 내 시뮬(띄우는 중·끝내는 중·정리 대상). 모르면 보인다 — 실시간 끊김·첫 상태 전·로봇 목록 다시 받기 실패(stale)·시뮬 목록 전(처음으로 뒤 포함)·관리자 오류(설정 없음은 시뮬이 없다는 뜻이라 예외)
  const calm = phone && tab === 'drive' && !open && !simOpen && !toSim && net.at === 'open' && !stale
    && pool.every((r) => !r.unknown && !r.online && !r.mission && !rt.get(r.id).holder && !rt.get(r.id).releasing)
    && sv.listed && (!sv.managerError || sv.managerError === 'SIM_DISABLED') && !sv.mine.length && !sv.cleanup.length;
  const [choose, setChoose] = useState<string | null>(null);   // 펼침: 고른 로봇 id('' = 아직), null = 닫힘
  // 고른 로봇이 후보에서 빠지면(지움·실기로 바뀜) 고르기 전으로, 총괄에게 정지할 시뮬이 없어지면 고르기를 닫는다(STOP 경로 0). 운영 관리자 STOP 은 그대로
  useEffect(() => { if (choose != null && !canStop) setChoose(null); else if (choose === ALL ? !allN : choose && !here.some((r) => r.id === choose)) setChoose(''); });
  // 서버가 구독을 거둠(담당 바뀜·로봇 지움): 그 로봇 조종 화면을 닫고 이유를 띠에, 목록은 다시 받는다. STOP 은 그대로 둔다
  const rv = rt.revoked(), [gone, setGone] = useState('');
  useEffect(() => {
    if (!rv) return;
    const hit = listed.find((r) => r.id === rv.robot), name = hit?.name ?? '로봇', closing = open && sub === rv.robot;
    if (hit?.sim) { refresh(); return; }   // 시뮬 슬롯은 끝내기·다시 띄우기마다 담당이 비었다 채워진다 — 띠 없이 목록만
    if (closing) go('drive');
    setGone(rv.reason === 'ROBOT_DELETED' ? `${name} 로봇이 지워져 목록에서 뺍니다.${closing ? ' 조종 화면을 닫았습니다.' : ''}`
      : `${name} 로봇의 담당이 바뀌어 이제 조종할 수 없습니다.${closing ? ' 조종 화면을 닫았습니다.' : ''} 필요하면 총괄 운영 관리자에게 문의하세요.`);
    refresh();
  }, [rv?.n]);
  // 서버가 sub 를 거절(404 — 목록의 어떤 로봇을 실시간으로 모름): 다른 구독은 그대로, 그 로봇은 «확인 안 됨». 처음이면 목록을 다시 받는다
  const ms = rt.missed(), [missed, setMissed] = useState('');
  useEffect(() => {
    if (!ms) return;
    setMissed(`목록의 로봇 중 실시간 상태를 받을 수 없는 로봇이 있습니다(지워졌거나 담당이 바뀌었을 수 있음).${ms.again ? ' 다음 목록 갱신 때 다시 확인합니다.' : ' 목록을 다시 받습니다.'}`);
    if (!ms.again) refresh();
  }, [ms?.n]);

  // 지도 편집을 저장하지 않았으면 다른 탭으로 가는 주소 바꿈(메뉴·뒤로 가기)을 되돌리고 그 화면에 묻는다
  useEffect(() => {
    const f = (e: HashChangeEvent) => {
      const h = location.hash, ask = leaving.ask;
      // 편집 중인 탭 = 떠나는 주소의 탭(시뮬 탭도 지도·시나리오 편집 — SIM-REAL-SPLIT). 이전 주소를 모르면 지도 탭
      const back = (e.oldURL && new URL(e.oldURL).hash) || '#/map';
      // 옛 시나리오 주소도 지도 탭을 다시 그리고 층을 옮기므로 같은 확인을 거친다(REVIEW-260 B1) — 취소하면 지금 편집·선택 그대로
      if (ask && (tabFromHash(h, false) !== tabFromHash(back, false) || oldScenario(h) != null)) { history.replaceState(null, '', back); ask(() => { location.hash = h; }); return; }
      if (toMission(h)) setMapN((x) => x + 1);   // 임무 탭 주소면 임무 탭을 다시 그려 그 임무를 고른다
      away.current = null; setWant(h);
    };
    addEventListener('hashchange', f); return () => removeEventListener('hashchange', f);
  }, []);
  const [mapN, setMapN] = useState(0);
  // 폰에서 담당 밖 로봇 주소(#/drive/<남의 로봇 id>)는 로봇 연결로 돌리며 한 줄 알린다 — 말없이 돌아가지 않게
  const [foreign, setForeign] = useState(false);
  useEffect(() => { if (phone && tab === 'drive' && sub && !pool.some((r) => r.id === sub)) setForeign(true); }, [want]);
  // 폭이 바뀌어(창 줄이기·태블릿 돌리기) 고른 탭이 새 배치에 없으면 첫 탭을 보이되 그 주소를 기억해 두고, 그 탭이 있는 배치로 돌아오면 되돌린다.
  // 그 사이 사용자가 탭을 직접 고르면(주소 바꿈·메뉴·go) 기억을 지운다 — 고름이 이김
  const away = useRef<{ h: string; phone: boolean } | null>(null), was = useRef(phone);
  useEffect(() => {
    const flip = was.current !== phone; was.current = phone;
    const k = away.current;
    if (flip && k && tabFromHash(k.h, phone) === tabFromHash(k.h, k.phone)) { away.current = null; history.replaceState(null, '', k.h); setWant(k.h); return; }
    if (want === path) return;
    if (flip && !k && tabFromHash(want, !phone) !== tabFromHash(want, phone)) away.current = { h: want, phone: !phone };
    history.replaceState(null, '', path); setWant(path);   // 주소·원하는 탭도 보이는 탭으로 맞춤
  }, [path, want, phone]);
  const go = (t: TabId, id?: string) => { const h = `#/${t}${id ? `/${id}` : ''}`; away.current = null; setWant(h); location.hash = h; };
  useEffect(() => { if (!phone && kept.d) go('map'); }, [phone]);   // 폰 틀에서 PC 로 돌아오면 남겨 둔 지도 편집으로
  // 끝내기(drive.tsx endDrive) = 입력 0 → 조종권 반납 → 서버가 반납을 확인하면(rt releasing 이 지워지면) 로봇 연결로.
  // 거절·무응답이면 이 화면에 머물러 [다시 시도]·[연결 화면]. 연결 화면으로 가도 반납 확인 중은 그 로봇 카드에 남는다
  const rel = robot ? rt.get(robot.id).releasing : null, done = robot ? rt.get(robot.id).released : 0, seen = useRef<[string, number] | null>(null);
  useEffect(() => {
    if (open && robot && seen.current?.[0] === robot.id && seen.current[1] < done) go('drive');
    seen.current = robot ? [robot.id, done] : null;
  });
  // t21-1: 끊긴 채 보낸 정지는 그 로봇이 다시 붙으면(서버가 받아 둔 정지를 먼저 전함) 확인된 것. 다음 STOP 전까지 «아직 닿지 않음»을 다시 띄우지 않는다
  // #529 H2: 다시 붙음(ONLINE)만으로는 지우지 않는다. 이 STOP 뒤 같은 소켓에서 끊기기 전보다 새 세대의 잠김(rt stop.latched)을 받아야 «다시 연결 · 잠긴 채 시작»
  // r2 M2: 기준 세대(g0)가 없으면 원래 잠김과 가를 수 없어 확인으로 치지 않음 · 거절 · 불확실이면 그 결과 글이 앞선다
  useEffect(() => { const ok = ctlOff.filter((id) => { const l = rt.get(id); return !!l.stop?.latched && l.stop.g0 >= 0 && taken(l); }); if (ok.length) { setCtlOff(ctlOff.filter((id) => !ok.includes(id))); setRelatch([...relatch, ...ok]); } });
  const halt = (rs: Robot[], all = false) => { for (const r of rs) rt.stop(r.id); if (all && mySim) sim.stop(); setStopped(rs); setCtlOff(ctl ? rs.filter((r) => !r.online).map((r) => r.id) : []); setRelatch([]); setSimStop(all && !!mySim); setChoose(null); setNoWay(''); setGrouped(false); };   // 로봇마다 기존 정지(rt.stop) 그대로 · 시뮬은 기존 sim.stop
  // 서버 실시간이 끊긴 STOP(d2 11-28 · B1~B3): 대상이 정해지지 않았으면 고르기 창 대신 정지할 수 있는 로봇 모두에 기존 정지(rt.stop · HTTP 대체 경로 포함)를 보내고
  // 결과는 로봇마다 한 줄(stopText). 보낼 로봇이 하나도 없을 때만 «로봇에 닿을 길 없음» 한 줄(via none) · 서버가 다시 붙으면 «보내지 못했음» 으로 바꿔 닫을 때까지 둔다
  // grouped = 서버 끊김 폰 STOP 결과를 같은 결과끼리 한 줄로(로봇 이름만 나열 · 폰 말풍선 줄이기)
  const [grouped, setGrouped] = useState(false), [offAt, setOffAt] = useState<string[]>([]);   // offAt = 보낼 때 끊겨 있던 로봇
  /** 서버 끊김 폰 STOP: 정지 가능한 로봇 모두에 기존 정지(rt.stop · HTTP 대체 포함), 결과는 묶음 줄 */
  const haltDown = (rs: Robot[]) => { halt(rs); setGrouped(true); setOffAt(rs.filter((r) => !r.online).map((r) => r.id)); };
  const [noWay, setNoWay] = useState<'' | 'down' | 'back'>(''), down = net.at !== 'open' && net.at !== 'connecting' && net.at !== 'idle';
  useEffect(() => { if (!down && noWay === 'down') setNoWay('back'); }, [down]);
  const stop = () => {
    // Q1(11-28): 폰 · 서버 끊김 · 대상 없음 · 시뮬 화면 밖에서 내 시뮬이 떠 있으면 내 시뮬(sim.stop · 직결이면 직결 먼저)과 정지 가능한 실기(B1) 둘 다
    const real = stops.filter((r) => !r.sim);
    if (toSim && phone && down && !open && !simOpen && real.length) { try { haltDown(real); } finally { setSimStop(true); sim.stop(); } return; }   // 실기 먼저 · 한쪽이 던져도 다른 쪽은 나간다
    if (toSim) { setNoWay(''); return sim.stop(); }   // 시뮬이 고르기 밖이면 그 슬롯만(직결이면 에이전트, 연결 전·끊김이면 정리). 다른 로봇으로 새지 않음
    if (!canStop) return;
    if (phone && down && !target) {   // 관제 탭(PC)은 W1 의 «모두 정지» 고르기 그대로
      if (stops.length) { haltDown(stops); return; } setStopped([]); setChoose(null); setNoWay('down'); return; }
    if (!target && choose === ALL && allN) return halt(every, true);
    const r = target ?? here.find((x) => x.id === choose); if (r) halt([r]); else setChoose(allN ? ALL : here.find((x) => rt.get(x.id).lease || rt.get(x.id).releasing)?.id ?? ''); };
  // Space = STOP, 모든 화면(F-COM-01) — 단, 초점이 글 입력칸이면 띄어쓰기로 둔다(10-20 사용자 결정, 화면 STOP 단추는 그대로).
  // 수정키·다른 키 처리보다 먼저, 초점 있는 단추가 눌리지 않게 막는다
  const stopKey = useRef(stop); stopKey.current = stop;
  const pickPress = useStopPress(stop), barStop = useStopPress(stop);
  // Sonnet 5: Enter 를 누른 채 두면 키 반복 keydown · 그 click(detail 0)이 고르기를 연 뒤 곧바로 모두 정지로 가지 않게. 반복은 새 누름이 아니다
  const held = useRef(false), pickBtn = useRef<HTMLButtonElement>(null), bySpace = useRef(false);   // bySpace = 전역 Space 가 지금 누르는 click(#529 M3)
  // A4: 고르기가 «모두 정지»가 되면(처음 열림 · 다른 로봇에서 되돌림) 정지 단추에 초점. Enter 반복이 머리 STOP 으로 가지 않게
  const opened = useRef(false);
  useEffect(() => { if (choose === ALL && !opened.current) pickBtn.current?.focus(); opened.current = choose != null; }, [choose]);
  const pickKeys = { onKeyDown: (e: { key: string; repeat: boolean; preventDefault: () => void }) => { if (e.key !== 'Enter') return; held.current = e.repeat; if (e.repeat) e.preventDefault(); },
    onKeyUp: (e: { key: string }) => { if (e.key === 'Enter') held.current = false; }, onBlur: () => { held.current = false; },
    onClick: (e: { detail: number; nativeEvent: Event }) => { if (!e.detail && held.current && !bySpace.current) return; pickPress.onClick(e); } };
  useEffect(() => {
    // 초점이 정지 단추(useStopPress)면 그 단추의 정지(시뮬 정지·서버 경유 STOP — 고르기 창·뒤의 다른 로봇으로 새지 않게, RV-457 3)
    const own = (t: EventTarget | null) => (t instanceof HTMLElement && t.closest<HTMLElement>('[data-stop-press]')) || null;
    const down = (e: KeyboardEvent) => { if (e.code !== 'Space' || typing(e.target)) return; e.preventDefault(); if (!e.repeat) { const b = own(e.target); if (b) { bySpace.current = true; try { b.click(); } finally { bySpace.current = false; } } else stopKey.current(); } };
    const up = (e: KeyboardEvent) => { if (e.code === 'Space' && !typing(e.target)) e.preventDefault(); };
    addEventListener('keydown', down, true); addEventListener('keyup', up, true);
    return () => { removeEventListener('keydown', down, true); removeEventListener('keyup', up, true); };
  }, []);

  const cur = tabsFor(phone).find((t) => t.id === tab)!, title = !phone ? labelOf(cur, user.role) : tab === 'history' ? '기록' : open || simOpen ? '조종' : '로봇 연결';
  const [scan, setScan] = useState(false), more = useRef<HTMLDetailsElement>(null);   // ⋯ 지도 스캔 칸(로봇 연결 화면에서만)
  const shut = (e: { currentTarget: Element }, f: () => void) => { e.currentTarget.closest('details')?.removeAttribute('open'); f(); };
  const problems = pool.filter(lost);
  const ctx: Ctx | null = robot ? { user, robot, robots: tab === 'history' || tab === 'map' || tab === 'fleet' ? withSlots : pool, pick: setRid, go, open, phone, setMe, refresh, cancel, focus, dash } : null;
  const Body = BODY[tab];
  const none = <section className="lv-card" aria-label="로봇 없음"><h2>로봇이 없습니다</h2><p className="lv-note">{user.role === 'ORG_ADMIN' ? '등록된 로봇이 없습니다. 운영 관리자가 실기 로봇을 연결하거나 «시뮬» 탭에서 띄우면 여기에 보입니다.' : NO_ROBOT}</p></section>;

  const navTab = tab === 'terrain' ? 'map' : tab;   // 지형 만들기는 지도 탭 안 화면(11-19)
  const link = (t: Tab, cls: string) => {
    const badge = t.id === 'approval' ? dash.d?.approvals_pending ?? 0 : 0;   // 서버 수 그대로: 총괄 = 조직 전체 대기, 운영 관리자 = 내 대기 요청
    return <a key={t.id} className={`${cls}${t.id === navTab ? ' cur' : ''}`} href={`#/${t.id}`} aria-current={t.id === navTab ? 'page' : undefined}
      aria-label={badge ? `${labelOf(t, user.role)} ${badge}건` : undefined} onClick={() => { if (!leaving.ask) { away.current = null; setWant(`#/${t.id}`); } }}>
      {t.icon}{labelOf(t, user.role)}{badge > 0 && <span className="fh-badge" aria-hidden="true">{badge}</span>}</a>;
  };

  const pickEl = choose != null && !target && canStop && (here.length || allN ? <div className="fh-pick" role="dialog" aria-label="정지할 로봇 고르기">
      {cantPick && <span style={LINE} data-cant-stop>{cantPick.name} 은 이 계정으로 정지할 수 없어 {simOnly ? '내 시뮬 정지' : off ? '멈출 수 있는 로봇 정지' : '전체 정지'}를 엽니다</span>}
      <span>어느 로봇을 정지할까요?</span>
      <select className="fh-user" aria-label="정지할 로봇" value={choose} onChange={(e) => setChoose(e.target.value)}>
        {!!allN && <option value={ALL}>{allName} ({allN} 대{cut.length ? ` · 끊김 ${cut.length}` : ''}{unsure.length ? ` · 상태 모름 ${unsure.length}` : ''})</option>}
        {!choose && <option value="">로봇 고르기</option>}
        {here.map((r) => <option key={r.id} value={r.id}>{r.name}{rt.get(r.id).lease ? ' (내가 조종 중)' : rt.get(r.id).releasing ? ' (반납 확인 중)' : ''}</option>)}</select>
      <button type="button" className="fh-stop" disabled={!choose} ref={pickBtn} {...pickPress} {...pickKeys}>정지</button>
      <button type="button" className="btn" onClick={() => setChoose(null)}>닫기</button>
      {noSrv.map((r) => <span key={r.id} style={LINE} data-stop-noserver={r.id}>실기 {r.name} 는 서버 경유 조종이 꺼져 있을 수 있습니다 · 정지는 보내고 결과는 아래 띠에 보입니다. 닿지 않으면 현장 폰이나 현장에서 멈추세요</span>)}
      {!!fieldOnly.length && <span style={LINE} data-phone-only>{fieldOnly.map((r) => r.name).join(' · ')} 은 서버 경유 정지가 꺼져 있어 여기서 멈출 수 없습니다 · 현장 폰에서 멈추세요</span>}
      {!!realOff.length && <span style={LINE} data-cant-real>실기 로봇 {realOff.length} 대는 이 계정으로 멈출 수 없습니다 · 운영자 폰이나 현장에서 멈추세요</span>}
      {choose === ALL && !!pre.length && <span style={LINE} data-stop-pre>연결 전 로봇 {pre.length} 대 · 정지를 보낼 수 없음</span>}
      {choose === ALL && cut.map((r) => <span key={r.id} style={LINE} data-stop-lost={r.id}>▲ {lostStop(r)}</span>)}
      {choose === ALL && unsure.map((r) => <span key={r.id} style={LINE} data-stop-unsure={r.id}>▲ {unsureStop(r)}</span>)}
    </div> : <div className="fh-pick" role="alertdialog" aria-label="멈출 로봇 없음" data-no-stop>
      <span>▲ 이 앱으로 멈출 로봇이 없습니다 — 현장에서 로봇을 직접 멈추세요.</span>
      <button type="button" className="btn" onClick={() => setChoose(null)}>닫기</button>
    </div>);
  const bandEl = <div className="fh-band" role="status" data-band>{[
      note && <span key="note">▲ {note}</span>,
      gone && <span key="revoked" data-revoked>▲ {gone} <button type="button" className="btn" onClick={() => setGone('')}>닫기</button></span>,
      foreign && <span key="foreign" data-foreign>▲ {user.role === 'ORG_ADMIN' ? '목록에 없는 로봇입니다. 로봇 목록을 다시 받은 뒤 고르세요.' : '담당 로봇이 아닙니다. 내 로봇만 열 수 있습니다.'} <button type="button" className="btn" onClick={() => setForeign(false)}>닫기</button></span>,
      missed && <span key="missed" data-missed>▲ {missed} <button type="button" className="btn" onClick={() => setMissed('')}>닫기</button></span>,
      (net.at === 'lost' || net.at === 'denied') && <span key="link" data-link-band>▲ {net.why} 로봇 상태를 알 수 없습니다.{net.at === 'lost' ? ' 연결 재시도 중입니다.' : ''}
        {' '}<button type="button" className="btn" onClick={() => rt.reconnect()}>다시 연결</button></span>,
      noWay === 'down' && <span key="none" data-stop-none>▲ 로봇에 닿을 길 없음 · 현장에서 멈추세요. 서버 연결이 끊겼고 이 폰은 로봇과 직결되어 있지 않아 정지 명령을 보내지 못했습니다.</span>,
      noWay === 'back' && <span key="none" data-stop-none data-stop-none-back>▲ 서버 다시 연결됨 · 앞선 정지는 보내지 못했음 · 로봇 상태를 확인하세요. <button type="button" className="btn" onClick={() => setNoWay('')}>닫기</button></span>,
      // A2: 관제에서 보낸 정지(한 대 · 모두)가 보낼 때 붙지 않은 로봇이고 서버가 받았으면(sent) «아직 닿지 않음 · 상태 모름». 보내는 중 · 대체 경로 · 실패 · 불확실, 정지 뒤 끊김은 기존 글 그대로
      ...(grouped ? groupStops(stopped, (id) => rt.get(id), offAt, (r) => pool.find((x) => x.id === r.id) ?? r) : []),
      ...(grouped ? [] : stopped).map((r) => { const s = rt.get(r.id).stop, now = pool.find((x) => x.id === r.id) ?? r;
        if (relatch.includes(r.id) && now.online) return <span key={`stop-${r.id}`} data-stop-band data-stop-relatched={r.id}>■ {r.name} 다시 연결 · 잠긴 채 시작</span>;
        return ctlOff.includes(r.id) && s?.phase === 'sent' ? lost(now) || now.online ? <span key={`stop-${r.id}`} data-stop-band data-stop-lost={r.id}>▲ {lostSent(r)}</span>
          : <span key={`stop-${r.id}`} data-stop-band data-stop-unsure={r.id}>▲ {unsureStop(r)}.</span>
          : <span key={`stop-${r.id}`} data-stop-band>{stopText(r, rt.get(r.id))}</span>; }),
      // A3: 모두 정지에 센 내 시뮬의 결과(직결 · 정리 · 보낼 길 없음)
      simStop && !!simStopText(sim.get()) && <span key="sim-stop" data-stop-band data-sim-stop-band>{simStopText(sim.get())}</span>,
      ...problems.map((r) => <span key={r.id}>▲ {lostText(r)} 현장에서 로봇 전원과 통신을 확인하세요.</span>),
    ].filter(Boolean)}</div>;
  const mainEl = <main className="fh-main" aria-label={title}><Guard key={tab}>{simOpen ? sv.real ? <RealDrive /> : <SimDrive shrink={setSmall} />
        : phone && scan && tab === 'drive' && !open ? <ScanPanel key={user.id} user={user} robots={pool} close={() => setScan(false)} cancel={cancel} />   // ⋯ 지도 스캔(u14_2)
        : tab === 'settings' ? phone ? <Settings key={user.id} user={user} setMe={setMe} refresh={refresh} cancel={cancel} />
          : <SettingsU9 key={user.id} user={user} setMe={setMe} refresh={refresh} cancel={cancel} logout={logout} />   // PC = 시안 u9   // 로봇 목록이 바뀌어도 다시 그리지 않음(한 번만 보이는 토큰 칸 유지)
        : tab === 'terrain' ? <Terrain />   // 로봇과 무관 — 로봇 0대여도, 로봇을 바꿔도 다시 그리지 않음
        : ctx ? <Body key={`${tab}-${tab === 'control' || tab === 'fleet' || tab === 'approval' || tab === 'trash' ? '' : tab === 'map' || tab === 'missions' ? mapN : ctx.robot.id}-${user.id}`} {...ctx} />   // 관제·지도·결재는 로봇을 골라도 다시 그리지 않음(층·지도 그림·고른 결재 유지 — 상세 서랍은 자기 key)
        : tab === 'drive' ? <Connect user={user} robots={pool} go={go} refresh={refresh} cancel={cancel} />   // 로봇 0대여도 시뮬 로봇 띄우기 자리
        : tab === 'control' ? <EmptyControl />   // 로봇 0대 관제 = 한 줄 + 로봇 탭 링크
        : tab === 'fleet' ? phone || pcBoard.on ? <EmptyFleet user={user} cancel={cancel} dash={dash} robots={withSlots} refresh={refresh} /> : <RobotTab c={null} user={user} refresh={refresh} cancel={cancel} />   // 로봇 0대여도 관제 요약·운영 관리자 표
        : tab === 'history' ? <History key={`history-${user.id}`} user={user} robots={withSlots} go={go} phone={phone} cancel={cancel} focus={focus} />   // 로봇 0대여도 계정·내 행동 기록과 알림 링크
        : tab === 'missions' ? <MissionTab key={`missions-${mapN}-${user.id}`} user={user} robots={pool} cancel={cancel} />   // 로봇 0대여도 임무 목록·짜기
        : tab === 'map' ? <Maps key={`map-${mapN}-${user.id}`} user={user} cancel={cancel} dash={dash} robots={withSlots} />   // 로봇 0대여도 장소·지도·시나리오
        : tab === 'approval' ? <Approvals key={`approval-${user.id}`} user={user} cancel={cancel} focus={focus} dash={dash} />   // 로봇 0대여도 결재
        : tab === 'sim' ? <SimTab user={user} robots={robots} refresh={refresh} />   // 로봇 0대여도 시뮬 띄우기
        : tab === 'trash' ? <Trash key={`trash-${user.id}`} cancel={cancel} />   // 로봇 0대여도 휴지통
        : none}</Guard>
        <p id="fh-soon" className="lv-note" style={{ flexBasis: '100%' }}>흐린 단추는 아직 준비 중인 기능입니다(권한 때문인 비활성은 단추 옆에 이유가 따로 나옵니다).</p></main>;
  if (!phone) {
    // PC = 시안 틀(.proto · proto/bar): 머리줄 .bar 그대로, 그 아래 STOP 결과 띠 · 정지 고르기는 모든 화면 위. 시안으로 옮긴 탭은 .proto 바로 아래 화면, 아직이면 옛 본문
    // 시안으로 옮긴 탭: 관제(u5). 로봇 0 대 · 시뮬 창 · 상세 서랍이면 옛 본문
    const proto5 = tab === 'control' && !!ctx && !simOpen && !open;
    /** 경보 칸 «K-05 정지» = 그 로봇 한 대에 기존 정지(halt · rt.stop), STOP 단추가 대상 로봇에 하는 것과 같은 길 */
    const stopOne = (id: string) => { const r = stops.find((x) => x.id === id); if (r) halt([r]); };
    const goTab = (id: string) => { const h = `#/${id}`; if (!leaving.ask) { away.current = null; setWant(h); } location.hash = h; };
    const u6 = tab === 'missions' && !simOpen;   // 임무 = 시안 u6
    const barTabs = [...PC_TABS.filter((t) => !t.hidden), PC_BOTTOM].map((t) => ({ id: t.id, label: labelOf(t, user.role) }));
    setStage(stage);   // 끌기 좌표 도우미(stage.ts)가 이 무대 배율을 쓴다
    return <div className="fit" data-fit style={{ position: 'fixed', inset: 0, overflow: 'hidden', background: light ? '#F6F7F6' : '#000000' }}>
      <div className={`proto${light ? ' light' : ''}`} data-layout="pc" data-scale={stage.s.toFixed(4)} style={{ position: 'absolute', left: 0, top: 0, width: STAGE_W, height: STAGE_H, transform: `translate(${stage.x}px,${stage.y}px) scale(${stage.s})`, transformOrigin: '0 0' }}>
      <PcBar light={light} tabs={barTabs} cur={navTab} go={goTab} role={user.role} name={user.name} roleName={ROLE_NAME[user.role]} online={pool.filter((r) => r.online).length} net={net.at}
        bell={<Guard quiet><Bell cancel={cancel} face={(n) => <BellFace unread={n} />} pop={`fh${light ? ' light' : ''}`} /></Guard>}
        stop={(canStop || toSim) && <button type="button" className="allstop" aria-label="비상 정지" data-stop style={{ minHeight: 44 }} {...barStop}>{STOP_FACE}</button>}
        approvals={user.role === 'ORG_ADMIN' ? { n: dash.d ? dash.d.approvals_pending : null, why: dash.err ? `요약을 받지 못했습니다. ${dash.err}` : undefined } : undefined}
        driving={pool.filter((r) => !!rt.get(r.id).lease).map((r) => r.name)}
        menu={<>{logout && <button type="button" className="btn" onClick={logout}>로그아웃</button>}<ThemeNav /></>} />
      {proto5 ? <><Guard key="u5"><Control5 {...ctx!} stop={stopOne} mayStop={(id) => stops.some((r) => r.id === id)} /></Guard>
        <div className={`fh ap-in${light ? ' light' : ''}`}><h1 className="ap-sr">{title}</h1>{pickEl}{bandEl}</div></>
        : u6 ? <>
        <main className="fh-main" aria-label={title} style={{ display: 'contents' }}><Guard key={tab}><MissionsU6 key={`missions-${mapN}-${user.id}`} user={user} robots={pool} cancel={cancel} /></Guard></main>
        <div className={`fh ap-in${light ? ' light' : ''}`}><h1 className="ap-sr">{title}</h1>{pickEl}{bandEl}</div></>
        : <div className={`fh ap-in old${light ? ' light' : ''}`}>
        <h1 className="ap-sr">{title}</h1>
        {pickEl}
        {bandEl}
        <div className="fh-body">{mainEl}</div>
      </div>}
      {!inApp() && <Guard quiet><SimWindow /></Guard>}
    </div></div>;
  }
  setStage(null);
  return <div className={`fh${light ? ' light' : ''}${phone ? ' phone' : ''}`} data-layout={phone ? 'phone' : 'pc'} data-drive={open || simOpen ? '' : undefined}>
    {/* 시뮬 조종 화면(10-26): 머리줄은 STOP 만 — 영상 위 오른쪽 위에 뜬다(drive.css .fh-head[data-bare]). 시뮬 끝내기·연결 표시는 조종 화면 메뉴·알약으로 */}
    <header className="fh-head" data-bare={simOpen || undefined}>{simOpen ? (canStop || toSim) && <Stop phone onStop={stop} /> : <>
      {phone
        ? <>{open ? <button type="button" className="btn" disabled={!!rel} onClick={() => robot && endDrive(robot.id, go)}>끝내기</button>
          : tab === 'history' && <button type="button" className="btn" onClick={() => go('drive')}>로봇 연결</button>}<h1>{title}</h1></>
        : <><BrandLogo h={24} /><div className="fh-sep" /><h1>{title}</h1></>}
      <span className="fh-grow" />
      {(() => {   // 좁은 폰은 점만 보이고 글은 화면 읽기용으로 남는다(frame.css .fh-dot-t)
        const [cls, dot, t] = net.at === 'open' ? ['ok', '●', '연결'] : net.at === 'connecting' || net.at === 'idle' ? ['', '○', '연결 중'] : ['bad', '■', net.at === 'denied' ? '연결 거부' : '연결 끊김'];
        return <span className={`fh-dot${cls ? ` ${cls}` : ''}`} data-link={cls === 'bad' ? net.at : undefined} title={t}><i aria-hidden="true">{dot}</i><span className="fh-dot-t">{t}</span></span>;
      })()}
      {!phone && <Guard quiet><Bell cancel={cancel} /></Guard>}
      {!phone && <span className="fh-me">{user.name}({ROLE_NAME[user.role]})</span>}
      {!phone && logout && <button type="button" className="btn" onClick={logout}>로그아웃</button>}
      {phone && <details className="fh-more" ref={more}><summary aria-label="더 보기">⋯</summary>
        <div className="card">{inApp() ? null : canFull() ? <button type="button" className="btn" aria-pressed={full} data-full onClick={(e) => shut(e, toggleFull)}>{full ? '전체화면 끄기' : '전체화면'}</button>
          : !installed() && <p className="lbl" data-full-tip>공유 → «홈 화면에 추가»로 열면 주소창 없이 넓게 보입니다.</p>}
          {tab === 'drive' && !open && <ScanStart user={user} robots={pool} label={PHONE_SCAN} start={() => { more.current?.removeAttribute('open'); setScan(true); }} />}
          {tab !== 'history' && <button type="button" className="btn" onClick={(e) => shut(e, () => go('history'))}>기록</button>}
          {logout && <button type="button" className="btn" onClick={(e) => shut(e, logout)}>로그아웃</button>}
          <ThemePick /></div></details>}
      {(canStop || toSim) && !calm && <Stop phone={phone} onStop={stop} />}
    </>}</header>
    {open && robot && rel && (rel.why
      ? <div className="fh-pick" role="alertdialog" aria-label="조종권 반납 확인 못함" data-end-fail>
          <span>조종권 반납을 확인하지 못했습니다. {rel.why} 확인되면 로봇 연결로 넘어갑니다.</span>
          <button type="button" className="btn pri" onClick={() => rt.release(robot.id)}>다시 시도</button>
          <button type="button" className="btn" onClick={() => go('drive')}>연결 화면</button></div>
      : <div className="fh-pick" role="status" data-ending>조종권을 반납하는 중입니다…</div>)}
    {/* 후보 0(운영 관리자 로봇 0대 등 — 모르면 STOP 은 보인다)이면 빈 고르기 대신 이 앱으로 멈출 것이 없다고 바로 알린다 */}
    {pickEl}
    {bandEl}
    <div className="fh-body">
      {!phone && <nav className="fh-nav" aria-label="주 메뉴">{PC_TABS.filter((t) => !t.hidden).map((t) => link(t, 'nav'))}<span className="fh-grow" /><ThemeNav />{link(PC_BOTTOM, 'nav')}</nav>}
      {mainEl}
    </div>
    {/* 서버 경유 실기 조종 중(open)이면 크게 보기는 막는다 — 실기 조종권을 반납하지 않은 채 화면을 바꾸지 않게. STOP·Space 대상은 위 규칙 그대로(실기 조종 화면 = 그 로봇) */}
    {simUp && small && <Guard quiet><SimPip cam={small} held={open} big={() => { setSmall(null); go('drive'); }} /></Guard>}
    {/* 브라우저 시뮬 창(RB-WEBSIM-PIP): PC 웹만 — 폰 틀·앱 안은 옛 그대로 페이지 이동(simwin.tsx) */}
    {!phone && !inApp() && <Guard quiet><SimWindow /></Guard>}
  </div>;
}
