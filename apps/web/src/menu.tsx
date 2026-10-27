// 메뉴 정의는 이 파일 한 곳에만 둔다(09 ADR-002 §3·§4 — 03 UX §3.1 · 02 기능 §1 을 대체). 탭 이름·순서·아이콘을 바꾸려면 여기만 고친다.
// 아이콘 선은 원본 화면(ui/src/screens/PcSettings.view.tsx 주 메뉴)에서 옮겼다. 결재 아이콘만 새로 그림.
import type { Role } from './fake';

export type TabId = 'fleet' | 'drive' | 'sim' | 'mission' | 'approval' | 'history' | 'map' | 'settings';
export type Tab = { id: TabId; label: string | Record<Role, string>; icon: JSX.Element; hidden?: boolean };   // hidden = 메뉴에 안 보임(주소·알림 링크로는 열림)

const I = (d: JSX.Element) => <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">{d}</svg>;
const ICON = {
  fleet: I(<><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></>),
  drive: I(<><circle cx="12" cy="12" r="8" /><path d="M12 7l-1.5 1.5M12 7l1.5 1.5M12 17l-1.5-1.5M12 17l1.5-1.5M7 12l1.5-1.5M7 12l1.5 1.5M17 12l-1.5-1.5M17 12l-1.5 1.5" /></>),
  mission: I(<><path d="M4 19l5-14 5 9 3-4 3 9" /><circle cx="9" cy="5" r="1.5" /></>),
  approval: I(<><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 12l3 3 5-6" /></>),
  history: I(<><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 8h8M8 12h8M8 16h5" /></>),
  map: I(<><path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z" /><path d="M9 4v14M15 6v14" /></>),
  sim: I(<><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>),
  settings: I(<><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1" /></>),
};

/** 총괄 웹(PC) 왼쪽 세로 메뉴. 설정은 PC_BOTTOM 으로 맨 아래 따로 — 로봇 · 시나리오 · 지도 · 시뮬 · 기록 · 설정.
 *  결재 탭은 숨김(10-27 결재 없이 바로 반영 — 새 결재가 안 생김). 옛 결재·알림 링크 #/approvals 는 주소로 그대로 열린다.
 *  실기 조종은 폰만, 시뮬은 PC «시뮬» 탭(10 ADR-003 §1 결정 3). 옛 주소 #/drive 는 첫 탭(로봇)으로 */
export const PC_TABS: Tab[] = [
  { id: 'fleet', label: '로봇', icon: ICON.fleet },
  { id: 'approval', label: { ORG_ADMIN: '결재', OPERATOR: '내 요청' }, icon: ICON.approval, hidden: true },
  { id: 'mission', label: '시나리오', icon: ICON.mission },
  { id: 'map', label: '지도', icon: ICON.map },
  { id: 'sim', label: '시뮬', icon: ICON.sim },
  { id: 'history', label: '기록', icon: ICON.history },
];
export const PC_BOTTOM: Tab = { id: 'settings', label: '설정', icon: ICON.settings };

/** 폰 화면: 조종(#/drive = 로봇 연결, #/drive/<로봇 id> = 조종) + 기록(⋯ 메뉴에서). 아래 탭 줄은 없다 */
export const PHONE_TABS: Tab[] = [
  { id: 'drive', label: '조종', icon: ICON.drive },
  { id: 'history', label: '기록', icon: ICON.history },
];
/** 폰 조종 화면 아래 줄 — 화면을 바꾸지 않고 시트로 연다(ADR-002 §3.2) */
export type SheetId = 'pose' | 'scenario' | 'goal' | 'policy';
export const PHONE_SHEETS: { id: SheetId; label: string }[] = [
  { id: 'pose', label: '자세' }, { id: 'scenario', label: '시나리오' }, { id: 'goal', label: '지도·목표' }, { id: 'policy', label: '정책' },
];

export const tabsFor = (phone: boolean) => (phone ? PHONE_TABS : [...PC_TABS, PC_BOTTOM]);
export const labelOf = (t: Tab, role: Role) => (typeof t.label === 'string' ? t.label : t.label[role]);
/** 주소(#/<id>[/<로봇 id>][?…])에서 탭 고르기 — 이 틀에 없는 탭이면 첫 탭(PC 의 옛 #/drive → 로봇, 폰의 #/map → 조종) */
export function tabFromHash(hash: string, phone: boolean): TabId {
  const id = hash.replace(/^#\/?/, '').split(/[/?]/)[0], all = tabsFor(phone);   // 폰 #/drive/<로봇 id> 도 조종, #/history?event_id=… 도 기록 탭
  return (all.find((t) => t.id === (id === 'approvals' ? 'approval' : id)) ?? all[0]).id;   // 서버 알림 링크는 #/approvals?approval_id=…
}

/** 떠나기 전에 물어볼 화면(저장하지 않은 지도 편집). ask(go) = 그 화면이 확인을 띄우고, 나가기를 고르면 go().
 *  App 은 탭 이동(메뉴·주소 바꿈)을 이것으로 막고, 지도 탭은 층 바꾸기·보기 전환에 쓴다 */
export const leaving: { ask: ((go: () => void) => void) | null } = { ask: null };
