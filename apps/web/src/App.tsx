// 화면 틀(03 UX §3): PC = 머리줄 + 상태 띠 + 왼쪽 세로 메뉴 + 본문, 폰(768px 미만) = 머리줄 + 본문 + 하단 탭 3개.
// 머리줄 오른쪽 묶음(연결 점 · 알림 · 사용자 · STOP)은 모든 탭에서 같다. 가짜 데이터만 — 서버 호출 0.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { BrandLogo } from './BrandLogo';
import { APPROVALS, ROBOTS, ROLE_NAME, USERS, lostText, myRobots, robotStatus, robotsFor } from './fake';
import { PC_BOTTOM, PC_TABS, PHONE_TABS, labelOf, tabFromHash, tabsFor, type Tab, type TabId } from './menu';
import { drive } from './fakeDrive';
import { BODY, type Ctx } from './screens';

// 폭 768px 미만 = 폰(02 §1.3). 가로로 눕힌 폰(높이 480px 이하 가로)도 폰 틀 — 폰 조종 탭은 가로 화면(03 §5.7·§7)
const PHONE_Q = '(max-width: 767.98px), (orientation: landscape) and (max-height: 480px)';
const watchPhone = (f: () => void) => { const m = matchMedia(PHONE_Q); m.addEventListener('change', f); return () => m.removeEventListener('change', f); };
export const usePhone = () => useSyncExternalStore(watchPhone, () => matchMedia(PHONE_Q).matches);

/** STOP — 모든 탭·두 틀에 늘 보임. 폰 64px, PC 44px 이상(U7). 누르면 가짜 중재기에 정지(0 + 잠금) */
export function Stop({ phone, onStop }: { phone: boolean; onStop: () => void }) {
  return <button type="button" className="fh-stop" aria-label="비상 정지" data-stop style={{ minHeight: phone ? 64 : 44, minWidth: phone ? 96 : 120 }} onClick={onStop}>
    <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 2h8l6 6v8l-6 6H8l-6-6V8z" fill="none" stroke="#FFFFFF" strokeWidth="2" /><rect x="8" y="8" width="8" height="8" fill="#FFFFFF" /></svg>
    <span className="fh-stop-t"><span>STOP</span>{!phone && <small>정지 요청</small>}</span>
  </button>;
}

export function App({ initialUser = USERS[0].id }: { initialUser?: string }) {
  const phone = usePhone();
  // 원하는 탭(주소)과 보이는 탭을 나눈다: 보이는 탭은 렌더마다 지금 틀(PC/폰)에서 도출 — 폭이 바뀌어 틀에 없는 탭이면 첫 탭(B1)
  const [want, setWant] = useState(() => location.hash), tab = tabFromHash(want, phone), sub = want.split('/')[2];
  const [uid, setUid] = useState(initialUser), user = USERS.find((u) => u.id === uid) ?? USERS[0];
  // 고를 수 있는 로봇: PC 는 전체(관제 보기), 폰은 내 로봇만(B4). 고른 값이 범위 밖이면 첫 로봇
  const pool = phone ? myRobots(user) : robotsFor(user);
  // PC 조종 탭은 #/drive/<로봇 id> 이면 그 로봇 화면(F-TO-01). 폰은 머리줄에서 고른 로봇
  const open = !phone && tab === 'drive' && pool.some((r) => r.id === sub), path = open ? `#/drive/${sub}` : `#/${tab}`;
  const [rid, setRid] = useState(''), robot = pool.find((r) => r.id === (open ? sub : rid)) ?? pool[0];   // ponytail: 담당 로봇 0대 운영자는 가짜 자료에 없음 — 실제 자료 붙일 때 빈 화면 처리
  const [stopped, setStopped] = useState(''), [light, setLight] = useState(false);   // stopped = 마지막으로 STOP 한 로봇 이름

  useEffect(() => { const f = () => setWant(location.hash); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  useEffect(() => { if (want !== path) { history.replaceState(null, '', path); setWant(path); } }, [path, want]);   // 주소·원하는 탭도 보이는 탭으로 맞춤
  const go = (t: TabId, id?: string) => { const h = `#/${t}${id ? `/${id}` : ''}`; setWant(h); location.hash = h; };
  const stop = () => { drive.stop(robot.id, user.id); setStopped(robot.name); };   // F-COM-01: 지금 화면이 가리키는 로봇

  const cur = tabsFor(phone).find((t) => t.id === tab)!;
  const problems = pool.filter((r) => !r.online);
  const attention = ROBOTS.filter((r) => robotStatus(r).tone === 'warn' || robotStatus(r).tone === 'bad').length;
  const ctx: Ctx = { user, robot, pick: setRid, go, open, stop, phone, light, setLight };
  const Body = BODY[tab];

  const link = (t: Tab, cls: string) => {
    const badge = t.id === 'approval' && user.role === 'ORG_ADMIN' ? APPROVALS.length : 0;   // ponytail: 운영자 배지(결과 나온 안 본 요청)는 요청 상태가 생기면
    return <a key={t.id} className={`${cls}${t.id === tab ? ' cur' : ''}`} href={`#/${t.id}`} aria-current={t.id === tab ? 'page' : undefined}
      aria-label={badge ? `${labelOf(t, user.role)} ${badge}건` : undefined} onClick={() => setWant(`#/${t.id}`)}>
      {t.icon}{labelOf(t, user.role)}{badge > 0 && <span className="fh-badge" aria-hidden="true">{badge}</span>}</a>;
  };

  return <div className={`fh${light ? ' light' : ''}${phone ? ' phone' : ''}`} data-layout={phone ? 'phone' : 'pc'}>
    <header className="fh-head">
      {phone
        ? <select className="fh-user" aria-label="로봇 고르기" value={robot.id} onChange={(e) => setRid(e.target.value)}>
            {pool.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
        : <><BrandLogo h={24} /><div className="fh-sep" /><h1>{labelOf(cur, user.role)}</h1></>}
      <span className="fh-grow" />
      <span className="fh-dot ok"><i aria-hidden="true">●</i>연결</span>
      {!phone && <span className="fh-dot" aria-label={`알림 ${attention}건`}><i aria-hidden="true">🔔</i>{attention}</span>}
      {!phone && <select className="fh-user" aria-label="사용자" value={uid} onChange={(e) => setUid(e.target.value)}>
        {USERS.map((u) => <option key={u.id} value={u.id}>{u.name}({ROLE_NAME[u.role]})</option>)}</select>}
      <Stop phone={phone} onStop={stop} />
    </header>
    <div className="fh-band" role="status" data-band>{[
      stopped && <span key="stop">■ {stopped} 정지 요청됨 — 이 시험 화면은 아직 로봇에 보내지 않습니다.</span>,
      ...problems.map((r) => <span key={r.id}>▲ {lostText(r)} 현장에서 로봇 전원과 통신을 확인하세요.</span>),
    ].filter(Boolean)}</div>
    <div className="fh-body">
      {!phone && <nav className="fh-nav" aria-label="주 메뉴">{PC_TABS.map((t) => link(t, 'nav'))}<span className="fh-grow" />{link(PC_BOTTOM, 'nav')}</nav>}
      <main className="fh-main" aria-label={labelOf(cur, user.role)}><Body key={`${tab}-${robot.id}-${uid}`} {...ctx} />
        <p id="fh-soon" className="lv-note" style={{ flexBasis: '100%' }}>흐린 단추는 아직 준비 중입니다.</p></main>
    </div>
    {phone && <nav className="fh-tabs" aria-label="주 메뉴">{PHONE_TABS.map((t) => link(t, 'tabb'))}</nav>}
  </div>;
}
