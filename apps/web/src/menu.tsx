// 메뉴 정의는 이 파일 한 곳에만 둔다(03 UX §3.1 · 02 기능 §1). 탭 이름·순서·아이콘을 바꾸려면 여기만 고친다.
// 아이콘 선은 원본 화면(ui/src/screens/PcSettings.view.tsx 주 메뉴)에서 옮겼다. 결재 아이콘만 새로 그림.
import type { Role } from './fake';

export type TabId = 'fleet' | 'drive' | 'mission' | 'approval' | 'history' | 'map' | 'settings' | 'scenario';
export type Tab = { id: TabId; label: string | Record<Role, string>; icon: JSX.Element };

const I = (d: JSX.Element) => <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">{d}</svg>;
const ICON = {
  fleet: I(<><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></>),
  drive: I(<><circle cx="12" cy="12" r="8" /><path d="M12 7l-1.5 1.5M12 7l1.5 1.5M12 17l-1.5-1.5M12 17l1.5-1.5M7 12l1.5-1.5M7 12l1.5 1.5M17 12l-1.5-1.5M17 12l-1.5 1.5" /></>),
  mission: I(<><path d="M4 19l5-14 5 9 3-4 3 9" /><circle cx="9" cy="5" r="1.5" /></>),
  approval: I(<><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 12l3 3 5-6" /></>),
  history: I(<><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 8h8M8 12h8M8 16h5" /></>),
  map: I(<><path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z" /><path d="M9 4v14M15 6v14" /></>),
  settings: I(<><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1" /></>),
};

/** PC 왼쪽 세로 메뉴 6탭. 설정은 PC_BOTTOM 으로 맨 아래 따로 */
export const PC_TABS: Tab[] = [
  { id: 'fleet', label: '관제', icon: ICON.fleet },
  { id: 'drive', label: '조종', icon: ICON.drive },
  { id: 'mission', label: '임무', icon: ICON.mission },
  { id: 'approval', label: { ORG_ADMIN: '결재', OPERATOR: '내 요청' }, icon: ICON.approval },
  { id: 'history', label: '기록', icon: ICON.history },
  { id: 'map', label: '지도', icon: ICON.map },
];
export const PC_BOTTOM: Tab = { id: 'settings', label: '설정', icon: ICON.settings };

/** 폰 하단 탭 3개 */
export const PHONE_TABS: Tab[] = [
  { id: 'drive', label: '조종', icon: ICON.drive },
  { id: 'scenario', label: '시나리오', icon: ICON.mission },
  { id: 'history', label: '기록', icon: ICON.history },
];

export const tabsFor = (phone: boolean) => (phone ? PHONE_TABS : [...PC_TABS, PC_BOTTOM]);
export const labelOf = (t: Tab, role: Role) => (typeof t.label === 'string' ? t.label : t.label[role]);
/** 주소(#/<id>[/<로봇 id>][?…])에서 탭 고르기 — 이 틀에 없는 탭이면 첫 탭 */
export function tabFromHash(hash: string, phone: boolean): TabId {
  const id = hash.replace(/^#\/?/, '').split(/[/?]/)[0], all = tabsFor(phone);   // #/drive/<로봇 id> 도 조종 탭, #/history?event_id=… 도 기록 탭
  return (all.find((t) => t.id === id) ?? all[0]).id;
}
