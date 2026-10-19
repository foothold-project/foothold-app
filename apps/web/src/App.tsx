// 화면 틀(03 UX §3): PC = 머리줄 + 상태 띠 + 왼쪽 세로 메뉴 + 본문, 폰(768px 미만) = 머리줄 + 본문 + 하단 탭 3개.
// 머리줄 오른쪽 묶음(연결 점 · 알림 · 사용자 · STOP)은 모든 탭에서 같다. 사용자·로봇 목록은 받은 값(session.tsx 가 서버에서),
// 로봇 연결·상태·조종권·STOP 은 실시간 연결(rt.ts), 나머지는 가짜.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { User as ApiUser } from '../../contracts/ts';
import { BrandLogo } from './BrandLogo';
import { APPROVALS, ROBOTS, ROLE_NAME, USERS, lost, lostText, myRobots, robotStatus, robotsFor, type Robot, type User } from './fake';
import { PC_BOTTOM, PC_TABS, PHONE_TABS, labelOf, tabFromHash, tabsFor, type Tab, type TabId } from './menu';
import { rt, useRt, withLive, type Live } from './rt';
import { BODY, type Ctx } from './screens';
import { Settings } from './screens/settings';

/** STOP 결과 한 줄 — 서버가 받았는지와 로봇이 알린 잠금을 나눠 쓴다. 확인 안 된 «정지됨»은 쓰지 않는다(F-COM-01) */
function stopText(r: Robot, l: Live) {
  const s = l.stop, st = l.state;
  if (!s) return '';
  if (s.phase === 'sending') return `■ ${r.name} 정지 요청을 보내는 중입니다.`;
  if (s.phase === 'failed') return `▲ ${r.name} 정지 요청을 보내지 못했습니다. ${s.why ?? ''} 현장에서 로봇을 직접 멈추세요.`;
  if (s.phase === 'unsure') return `▲ ${r.name} 정지 요청을 보냈지만 서버 접수를 확인하지 못했습니다. ${s.why ?? ''} 현장에서 로봇을 직접 멈추세요.`;
  // 대체 경로로 보낸 뒤에는 다시 연결되어 요청 뒤 state 가 와야 로봇 확인을 본다
  if (s.phase === 'fallback' && !(st && l.stateAt > s.at)) return `■ ${r.name} 정지 요청됨(대체 경로) — 실시간 연결이 끊겨 로봇 확인은 보이지 않습니다. 현장을 확인하세요.`;
  if (!st || l.stateAt <= s.at) return `■ ${r.name} 정지 요청됨 — 서버가 받았습니다. 로봇 확인을 기다립니다.`;
  if (st.connection !== 'ONLINE') return `▲ ${r.name} 정지 요청 뒤 로봇 연결이 끊겼습니다. 지금 상태는 알 수 없습니다. 현장을 확인하세요.`;
  if (!st.latched) return `■ ${r.name} 정지 요청됨 — 로봇이 아직 잠금을 알리지 않았습니다.`;
  return st.applied && st.applied.every((v) => v === 0) ? `■ ${r.name} 정지 잠금 — 로봇이 잠금과 멈춤 출력을 알렸습니다.` : `▲ ${r.name} 정지 잠금 — 출력이 아직 멈추지 않았습니다. 현장을 확인하세요.`;
}

// 폭 768px 미만 = 폰(02 §1.3). 예외: 손가락 입력이고 가로이며 높이 480px 이하면 눕힌 폰 — 폰 조종 탭은 가로 화면(03 §5.7·§7).
// 마우스 쓰는 낮은 PC 창(1440×400 등)은 PC 틀 유지(10-19 조정 결정 R1)
const PHONE_Q = '(max-width: 767.98px), (pointer: coarse) and (orientation: landscape) and (max-height: 480px)';
const watchPhone = (f: () => void) => { const m = matchMedia(PHONE_Q); m.addEventListener('change', f); return () => m.removeEventListener('change', f); };
export const usePhone = () => useSyncExternalStore(watchPhone, () => matchMedia(PHONE_Q).matches);

/** STOP — 모든 탭·두 틀에 늘 보임. 폰 64px, PC 44px 이상(U7). 누르면 서버에 정지 요청(로봇이 0 + 잠금) */
export function Stop({ phone, onStop }: { phone: boolean; onStop: () => void }) {
  return <button type="button" className="fh-stop" aria-label="비상 정지" data-stop style={{ minHeight: phone ? 64 : 44, minWidth: phone ? 96 : 120 }} onClick={onStop}>
    <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 2h8l6 6v8l-6 6H8l-6-6V8z" fill="none" stroke="#FFFFFF" strokeWidth="2" /><rect x="8" y="8" width="8" height="8" fill="#FFFFFF" /></svg>
    <span className="fh-stop-t"><span>STOP</span>{!phone && <small>정지 요청</small>}</span>
  </button>;
}

/** user·robots = 서버 /me·/robots?scope=all 값(시험은 가짜 자료). 남의 로봇은 보기 전용(조종 비활성 + 이유, STOP 은 됨).
 *  logout 이 있으면 머리줄에 로그아웃. setMe = 내 정보가 서버에서 바뀌었을 때(설정 탭). cancel = 이 로그인 세션의 취소 신호(화면 요청용). note = 띠에 올릴 한 줄(로그아웃 실패 등). dev = 무엇이 가짜인지 알리는 개발용 표시 */
export function App({ user = USERS[0], robots: listed = ROBOTS, logout, setMe = () => {}, cancel, note, dev }: { user?: User; robots?: Robot[]; logout?: () => void; setMe?: (u: ApiUser) => void; cancel?: AbortSignal; note?: string; dev?: string }) {
  const phone = usePhone();
  useRt();
  const robots = listed.map(withLive), net = rt.link();
  // 상태 구독은 볼 수 있는 로봇만: 총괄 전체, 운영 관리자는 담당 로봇(남의 로봇은 목록 요약만 — 구독하면 서버가 연결을 닫는다)
  const mine = listed.filter((r) => user.role === 'ORG_ADMIN' || r.owner === user.id).map((r) => r.id).join();
  useEffect(() => { rt.connect(mine ? mine.split(',') : []); return () => rt.disconnect(); }, []);
  useEffect(() => rt.follow(mine ? mine.split(',') : []), [mine]);   // 목록 갱신으로 담당이 바뀌면 구독도(소켓은 그대로)
  // 원하는 탭(주소)과 보이는 탭을 나눈다: 보이는 탭은 렌더마다 지금 틀(PC/폰)에서 도출 — 폭이 바뀌어 틀에 없는 탭이면 첫 탭(B1)
  const [want, setWant] = useState(() => location.hash), tab = tabFromHash(want, phone), sub = want.split('/')[2];
  // 고를 수 있는 로봇: PC 는 전체(관제 보기, 내 로봇 먼저), 폰은 내 로봇만(B4). 고른 값이 범위 밖이면 첫 로봇
  const pool = phone ? myRobots(user, robots) : robotsFor(user, robots);
  // PC 조종 탭은 #/drive/<로봇 id> 이면 그 로봇 화면(F-TO-01). 폰은 머리줄에서 고른 로봇
  const open = !phone && tab === 'drive' && pool.some((r) => r.id === sub), path = open ? `#/drive/${sub}` : `#/${tab}`;
  const [rid, setRid] = useState(''), robot: Robot | undefined = pool.find((r) => r.id === (open ? sub : rid)) ?? pool[0];   // 0대면 undefined — 본문은 «로봇 없음»
  useEffect(() => { if (robot) setRid(robot.id); }, [robot?.id]);
  const [stopped, setStopped] = useState<Robot | null>(null), [light, setLight] = useState(false);   // stopped = 마지막으로 STOP 한 로봇
  // STOP 대상(F-COM-01) = 지금 화면이 가리키는 로봇: 폰은 머리줄에서 고른 로봇, PC 는 관제에서 고른 로봇·조종 화면의 로봇.
  // 그 밖(조종 목록·임무·기록 등)은 대상이 없어 STOP 이 «로봇 고르기»를 펼친다 — 내 조종권 로봇이 기본, 다시 누르면 그 로봇 정지
  const target = phone || open || tab === 'fleet' ? robot : null;
  const [choose, setChoose] = useState<string | null>(null);   // 펼침: 고른 로봇 id('' = 아직), null = 닫힘

  useEffect(() => { const f = () => setWant(location.hash); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  useEffect(() => { if (want !== path) { history.replaceState(null, '', path); setWant(path); } }, [path, want]);   // 주소·원하는 탭도 보이는 탭으로 맞춤
  const go = (t: TabId, id?: string) => { const h = `#/${t}${id ? `/${id}` : ''}`; setWant(h); location.hash = h; };
  const halt = (r: Robot) => { rt.stop(r.id); setStopped(r); setChoose(null); };
  const stop = () => { const r = target ?? pool.find((x) => x.id === choose); if (r) halt(r); else setChoose(pool.find((x) => rt.get(x.id).lease)?.id ?? ''); };
  // Space = STOP, 모든 화면(F-COM-01). 수정키·다른 키 처리보다 먼저, 초점 있는 단추가 눌리지 않게 막는다
  const stopKey = useRef(stop); stopKey.current = stop;
  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.code !== 'Space') return; e.preventDefault(); if (!e.repeat) stopKey.current(); };
    const up = (e: KeyboardEvent) => { if (e.code === 'Space') e.preventDefault(); };
    addEventListener('keydown', down, true); addEventListener('keyup', up, true);
    return () => { removeEventListener('keydown', down, true); removeEventListener('keyup', up, true); };
  }, []);

  const cur = tabsFor(phone).find((t) => t.id === tab)!;
  const problems = pool.filter(lost);
  const attention = pool.filter((r) => robotStatus(r).tone === 'warn' || robotStatus(r).tone === 'bad').length;
  const ctx: Ctx | null = robot ? { user, robot, robots: pool, pick: setRid, go, open, phone, light, setLight, setMe, cancel } : null;
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
        ? <select className="fh-user" aria-label="로봇 고르기" value={robot?.id ?? ''} onChange={(e) => setRid(e.target.value)}>
            {pool.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
        : <><BrandLogo h={24} /><div className="fh-sep" /><h1>{labelOf(cur, user.role)}</h1></>}
      <span className="fh-grow" />
      {net.at === 'open' ? <span className="fh-dot ok"><i aria-hidden="true">●</i>연결</span>
        : net.at === 'connecting' || net.at === 'idle' ? <span className="fh-dot"><i aria-hidden="true">○</i>연결 중</span>
        : <span className="fh-dot bad" data-link={net.at}><i aria-hidden="true">■</i>{net.at === 'denied' ? '연결 거부' : '연결 끊김'}</span>}
      {!phone && <span className="fh-dot" aria-label={`알림 ${attention}건`}><i aria-hidden="true">🔔</i>{attention}</span>}
      {!phone && <span className="fh-me">{user.name}({ROLE_NAME[user.role]})</span>}
      {!phone && logout && <button type="button" className="btn" onClick={logout}>로그아웃</button>}
      {phone && tab === 'history' && logout && <details className="fh-more"><summary aria-label="더 보기">⋯</summary>
        <div className="card"><button type="button" className="btn" onClick={logout}>로그아웃</button></div></details>}
      <Stop phone={phone} onStop={stop} />
    </header>
    {choose != null && !target && <div className="fh-pick" role="dialog" aria-label="정지할 로봇 고르기">
      <span>어느 로봇을 정지할까요?</span>
      <select className="fh-user" aria-label="정지할 로봇" value={choose} onChange={(e) => setChoose(e.target.value)}>
        {!choose && <option value="">로봇 고르기</option>}
        {pool.map((r) => <option key={r.id} value={r.id}>{r.name}{rt.get(r.id).lease ? ' (내가 조종 중)' : ''}</option>)}</select>
      <button type="button" className="fh-stop" disabled={!choose} onClick={stop}>정지</button>
      <button type="button" className="btn" onClick={() => setChoose(null)}>닫기</button>
    </div>}
    {dev && <p className="fh-dev" data-dev>{dev}</p>}
    <div className="fh-band" role="status" data-band>{[
      note && <span key="note">▲ {note}</span>,
      (net.at === 'lost' || net.at === 'denied') && <span key="link" data-link-band>▲ {net.why} 로봇 상태를 알 수 없습니다.{net.at === 'lost' ? ' 연결 재시도 중입니다.' : ''}
        {' '}<button type="button" className="btn" onClick={() => rt.reconnect()}>다시 연결</button></span>,
      stopped && <span key="stop" data-stop-band>{stopText(stopped, rt.get(stopped.id))}</span>,
      ...problems.map((r) => <span key={r.id}>▲ {lostText(r)} 현장에서 로봇 전원과 통신을 확인하세요.</span>),
    ].filter(Boolean)}</div>
    <div className="fh-body">
      {!phone && <nav className="fh-nav" aria-label="주 메뉴">{PC_TABS.map((t) => link(t, 'nav'))}<span className="fh-grow" />{link(PC_BOTTOM, 'nav')}</nav>}
      <main className="fh-main" aria-label={labelOf(cur, user.role)}>{ctx ? <Body key={`${tab}-${ctx.robot.id}-${user.id}`} {...ctx} />
        : tab === 'settings' ? <Settings user={user} light={light} setLight={setLight} setMe={setMe} cancel={cancel} />
        : <section className="lv-card" aria-label="로봇 없음"><h2>로봇이 없습니다</h2><p className="lv-note">{user.role === 'ORG_ADMIN' ? '등록된 로봇이 없습니다. 로봇을 등록하면 여기에 보입니다.' : '담당 로봇이 없습니다. 총괄 운영 관리자에게 로봇 배정을 요청하세요.'}</p></section>}
        <p id="fh-soon" className="lv-note" style={{ flexBasis: '100%' }}>흐린 단추는 아직 준비 중입니다.</p></main>
    </div>
    {phone && <nav className="fh-tabs" aria-label="주 메뉴">{PHONE_TABS.map((t) => link(t, 'tabb'))}</nav>}
  </div>;
}
