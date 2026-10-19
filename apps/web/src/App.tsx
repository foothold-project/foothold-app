// 화면 틀(03 UX §3): PC = 머리줄 + 상태 띠 + 왼쪽 세로 메뉴 + 본문, 폰(768px 미만) = 머리줄 + 본문 + 하단 탭 3개.
// 머리줄 오른쪽 묶음(연결 점 · 알림 · 사용자 · STOP)은 모든 탭에서 같다. 가짜 데이터만 — 서버 호출 0.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { BrandLogo } from './BrandLogo';
import { APPROVALS, ROBOTS, ROLE_NAME, USERS, robotStatus, robotsFor } from './fake';
import { PC_BOTTOM, PC_TABS, PHONE_TABS, labelOf, tabFromHash, tabsFor, type Tab, type TabId } from './menu';
import { BODY, type Ctx } from './screens';

const PHONE_Q = '(max-width: 767.98px)';
const watchPhone = (f: () => void) => { const m = matchMedia(PHONE_Q); m.addEventListener('change', f); return () => m.removeEventListener('change', f); };
export const usePhone = () => useSyncExternalStore(watchPhone, () => matchMedia(PHONE_Q).matches);

/** STOP — 모든 탭·두 틀에 늘 보임. 폰 64px, PC 44px 이상(U7). 아직 로봇과 잇지 않아 누르면 띠에 알리기만 한다 */
export function Stop({ phone, onStop }: { phone: boolean; onStop: () => void }) {
  return <button type="button" className="fh-stop" aria-label="비상 정지" data-stop style={{ minHeight: phone ? 64 : 44, minWidth: phone ? 96 : 120 }} onClick={onStop}>
    <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 2h8l6 6v8l-6 6H8l-6-6V8z" fill="none" stroke="#FFFFFF" strokeWidth="2" /><rect x="8" y="8" width="8" height="8" fill="#FFFFFF" /></svg>
    <span className="fh-stop-t"><span>STOP</span>{!phone && <small>정지 요청</small>}</span>
  </button>;
}

export function App({ initialUser = USERS[0].id }: { initialUser?: string }) {
  const phone = usePhone();
  const [tab, setTab] = useState<TabId>(() => tabFromHash(location.hash, phone));
  const [uid, setUid] = useState(initialUser), user = USERS.find((u) => u.id === uid) ?? USERS[0];
  const [rid, setRid] = useState(() => robotsFor(user)[0].id), robot = ROBOTS.find((r) => r.id === rid)!;
  const [stopped, setStopped] = useState(false), [light, setLight] = useState(false);

  useEffect(() => { const f = () => setTab(tabFromHash(location.hash, phone)); f(); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, [phone]);
  const go = (t: TabId) => { setTab(t); location.hash = `#/${t}`; };
  const switchUser = (id: string) => { setUid(id); setRid(robotsFor(USERS.find((u) => u.id === id)!)[0].id); };

  const tabs = tabsFor(phone), cur = tabs.find((t) => t.id === tab)!;
  const problems = ROBOTS.filter((r) => r.state === 'offline');
  const attention = ROBOTS.filter((r) => robotStatus(r).tone !== 'ok' && robotStatus(r).tone !== 'off').length;
  const ctx: Ctx = { user, robot, pick: setRid, go, phone, light, setLight };
  const Body = BODY[tab];

  const link = (t: Tab, cls: string) => {
    const badge = t.id === 'approval' && user.role === 'ORG_ADMIN' ? APPROVALS.length : 0;   // ponytail: 운영자 배지(결과 나온 안 본 요청)는 요청 상태가 생기면
    return <a key={t.id} className={`${cls}${t.id === tab ? ' cur' : ''}`} href={`#/${t.id}`} aria-current={t.id === tab ? 'page' : undefined}
      aria-label={badge ? `${labelOf(t, user.role)} ${badge}건` : undefined} onClick={() => setTab(t.id)}>
      {t.icon}{labelOf(t, user.role)}{badge > 0 && <span className="fh-badge" aria-hidden="true">{badge}</span>}</a>;
  };

  return <div className={`fh${light ? ' light' : ''}${phone ? ' phone' : ''}`} data-layout={phone ? 'phone' : 'pc'}>
    <header className="fh-head">
      {phone
        ? <select className="fh-user" aria-label="로봇 고르기" value={rid} onChange={(e) => setRid(e.target.value)}>
            {robotsFor(user).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
        : <><BrandLogo h={24} /><div className="fh-sep" /><h1>{labelOf(cur, user.role)}</h1></>}
      <span className="fh-grow" />
      <span className="fh-dot ok"><i aria-hidden="true">●</i>연결</span>
      {!phone && <span className="fh-dot" aria-label={`알림 ${attention}건`}><i aria-hidden="true">🔔</i>{attention}</span>}
      {!phone && <select className="fh-user" aria-label="사용자" value={uid} onChange={(e) => switchUser(e.target.value)}>
        {USERS.map((u) => <option key={u.id} value={u.id}>{u.name}({ROLE_NAME[u.role]})</option>)}</select>}
      <Stop phone={phone} onStop={() => setStopped(true)} />
    </header>
    <div className="fh-band" role="status" data-band>{[
      stopped && <span key="stop">■ 정지 요청됨 — 이 시험 화면은 아직 로봇에 보내지 않습니다.</span>,
      ...problems.map((r) => <span key={r.id}>▲ {r.name} 연결이 끊겼습니다. 로봇은 정지·잠금 상태입니다. 현장에서 로봇 전원을 확인하세요.</span>),
    ].filter(Boolean)}</div>
    <div className="fh-body">
      {!phone && <nav className="fh-nav" aria-label="주 메뉴">{PC_TABS.map((t) => link(t, 'nav'))}<span className="fh-grow" />{link(PC_BOTTOM, 'nav')}</nav>}
      <main className="fh-main" aria-label={labelOf(cur, user.role)}><Body key={`${tab}-${rid}-${uid}`} {...ctx} /></main>
    </div>
    {phone && <nav className="fh-tabs" aria-label="주 메뉴">{PHONE_TABS.map((t) => link(t, 'tabb'))}</nav>}
  </div>;
}
