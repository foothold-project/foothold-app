/** 설정 탭 = 시안 u9 (proto/screens/u9_1 ~ u9_9). 화면 마크업은 시안 body 를 기계적으로 옮긴 것(태그 · class · 순서 · 글 그대로),
 *  시안 머리줄(.bar)은 앱 머리줄 몫이라 뺐다. 고정 글 자리만 서버 값으로 바꾸고, 서버에 값이 없는 자리는 「서버에 값 없음」 또는 까닭 한 줄 */
import { useEffect, useState, type DependencyList, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import '../proto/ui.pv.css';
import '../proto/pc.pv.css';
import '../proto/dark.pv.css';
import '../proto/light.pv.css';
import './settingsu9.css';
import './settingsu9.app.css';
import { api, expireAuth, type ApiFail } from '../api';
import type { User } from '../fake';
import type { Ctx } from '../screens';
import { failText, PW_DONE, Settings, TAKEN, tempPassword } from './settings';
import { setThemePref, useTheme, type ThemePref } from '../theme';

export type Page = 'account' | 'users' | 'network' | 'crowd' | 'robot' | 'safety' | 'alerts' | 'clip' | 'controls' | 'display' | 'demo' | 'system';

export function SettingsU9(c: Pick<Ctx, 'user' | 'setMe' | 'refresh' | 'cancel'> & { logout?: () => void; initial?: Page; pw?: boolean }) {
  const admin = c.user.role === 'ORG_ADMIN', [page, setPage] = useState<Page>(c.initial ?? 'account'), [pw, setPw] = useState(!!c.pw), light = useTheme()[1];
  const at = page === 'demo' ? 'display' : page;
  const ni = (id: string) => ({ className: at === id || (id === 'demo' && false) ? 'ni on' : 'ni', id: `nav-${id}`, role: 'tab', 'aria-selected': at === id, tabIndex: at === id ? 0 : -1,
    hidden: id === 'users' && !admin, onClick: () => setPage(id as Page) });
  return <div className={`proto u9${light ? ' light' : ''}`} data-u9={at}>
    <Nav ni={ni} />
    {at === 'account' && <Account user={c.user} admin={admin} cancel={c.cancel} logout={c.logout} openPw={() => setPw(true)} />}
    {at === 'users' && admin && <Users me={c.user} cancel={c.cancel} />}
    {at === 'network' && <Network cancel={c.cancel} />}
    {at === 'alerts' && <Alerts cancel={c.cancel} />}
    {at === 'display' && <Display admin={admin} />}
    {at === 'controls' && <Controls />}
    {at === 'crowd' && <Crowd />}
    {LEGACY[at] && <>
      <div className="hd"><span className="ttl">{LEGACY[at][0]}</span><p>이 묶음은 시안 그림이 아직 없어 지금 앱 판으로 보입니다.</p></div>
      <div className="pane u9-legacy" style={{ left: '368px', top: '160px', width: '1528px', height: '896px' }} aria-label={LEGACY[at][0]}>
        <Settings user={c.user} setMe={c.setMe} refresh={c.refresh} cancel={c.cancel} only={LEGACY[at][1]} /></div></>}
    {pw && <PwModal close={() => setPw(false)} cancel={c.cancel} />}
  </div>;
}

// 시안 u9 (proto/screens/u9_*.html) body 를 JSX 로 기계 변환한 판. 아래에서 고정 글 자리만 서버 값으로 바꾼다


/** 서버에 값이 없는 자리 */
export const NO = '서버에 값 없음';
/** 시안 그림이 없는 묶음(로봇 · 안전 · 기록과 클립 · 시스템): 지금 앱 판(settings.tsx)의 그 묶음을 시안 칸 안에 그린다.
 *  알림 · 조작 시안에 자리가 없는 조직 기준값 · 시뮬 속도 칸은 «로봇» 묶음에 함께 둔다(값 고치기를 잃지 않게) */
const LEGACY: Record<string, [string, string[]]> = { robot: ['로봇', ['robot', 'alert', 'ctl']], safety: ['안전', ['safety']], clip: ['기록과 클립', ['clip']], system: ['시스템', ['sys']] };
const ROLE: Record<string, string> = { ORG_ADMIN: '총괄', OPERATOR: '운영자' };
/** 내 최근 활동에 보이는 계정 사건(서버 event code) */
const ACT: Record<string, string> = { LOGIN: '로그인', LOGOUT: '로그아웃', PASSWORD_CHANGED: '비밀번호 바꿈' };
/** 머리글자: 마지막 낱말의 첫 글자(시안 「운영자 A」 → A, 「나」 → 나) */
const initial = (name: string) => [...(name.trim().split(/\s+/).pop() ?? '')][0] ?? '';
/** 사용자 표 「마지막 접속」: 2 분 안 = 지금, 오늘 = HH:MM, 어제 = 어제, 그 밖 = M/D */
const ago = (iso: string, now = new Date()) => { const w = when(iso, false, now); return now.getTime() - Date.parse(iso) < 120000 ? '지금' : w.includes(' ') ? w.split(' ')[0] : w; };
/** 바꾼 기록에 보이는 계정 사건(서버 event code). 로그인 · 토큰 갱신은 뺀다 */
const CHANGE = ['USER_CREATED', 'USER_UPDATED', 'USER_ARCHIVED', 'PASSWORD_CHANGED', 'SESSION_REVOKED'];
const NO_NET = '현장 네트워크를 저장하는 서버 기능이 아직 없어 추가할 수 없습니다.';
const NO_SWITCH = '켜고 끄는 값을 저장하는 서버 기능이 아직 없어 시안 기본값(켬)으로 보입니다.';
const NO_CROWD = '혼잡 시간을 저장하는 서버 기능이 아직 없어 추가할 수 없습니다.';
const NO_TEMP = '임시 비밀번호를 다시 만드는 서버 기능이 아직 없습니다. 새 계정을 만들 때만 임시 비밀번호를 줍니다.';
const two = (n: number) => String(n).padStart(2, '0');
const md = (iso: string) => { const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()}`; };
/** 시안 시각 꼴: 오늘이면 HH:MM(today=true 면 「오늘 HH:MM」), 어제면 「어제 HH:MM」(yesterday=false 면 M/D, 시안 최근 활동), 그 밖은 M/D HH:MM */
export const when = (iso: string, today = false, now = new Date(), yesterday = true) => {
  const d = new Date(iso), hm = `${two(d.getHours())}:${two(d.getMinutes())}`, day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const gap = Math.round((day(now) - day(d)) / 86400000);
  return gap === 0 ? (today ? `오늘 ${hm}` : hm) : gap === 1 && yesterday ? `어제 ${hm}` : `${md(iso)} ${hm}`;
};
/** 서버에서 한 번 받기(deps 가 바뀌면 다시). err = 서버 문장 */
function useLoad<T>(get: () => Promise<T>, deps: DependencyList) {
  const [st, set] = useState<{ v?: T; err?: string }>({});
  useEffect(() => {
    let live = true;
    get().then((v) => live && set({ v }), (e) => live && set({ err: (e as ApiFail).message ?? String(e) }));
    return () => { live = false; };
  }, deps);   // eslint-disable-line react-hooks/exhaustive-deps
  return st;
}
/** 시안 칸에 다 안 들어가는 목록은 쪽으로 넘긴다(스크롤 없음). 한 쪽이면 아무것도 그리지 않는다 */
const Pager = ({ n, per, at, go }: { n: number; per: number; at: number; go: (i: number) => void }) => {
  const pages = Math.ceil(n / per);
  if (pages <= 1) return null;
  return <span className="row u9-pager" style={{ gap: '8px' }} data-u9-pager>
    <button type="button" className="btns sb" aria-label="앞 쪽" disabled={at === 0} onClick={() => go(at - 1)}>‹</button>
    <span className="mu2">{at + 1} / {pages}</span>
    <button type="button" className="btns sb" aria-label="다음 쪽" disabled={at >= pages - 1} onClick={() => go(at + 1)}>›</button>
  </span>;
};
/** 칸 안 한 줄 안내(빈 목록 · 서버 값 없음 까닭 · 오류) */
const Why = ({ children, alert }: { children: ReactNode; alert?: boolean }) => <p className="mu2 u9-why" role={alert ? 'alert' : undefined} data-why>{children}</p>;

export const Nav = ({ ni }: { ni: (id: string) => object }) => <div className="pane nav"><h5>나</h5>
  <div {...ni('account')}><svg className="ic" viewBox="0 0 24 24" style={{width:"19px",height:"19px"}}><path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z" /><circle cx="16.5" cy="7.5" r=".5" fill="currentColor" /></svg>계정</div><h5>현장</h5>
  <div {...ni('users')}><svg className="ic" viewBox="0 0 24 24" style={{width:"19px",height:"19px"}}><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><path d="M16 3.128a4 4 0 0 1 0 7.744" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><circle cx="9" cy="7" r="4" /></svg>사용자와 권한<span className="only">총괄만</span></div>
  <div {...ni('network')}><svg className="ic" viewBox="0 0 24 24" style={{width:"19px",height:"19px"}}><path d="M12 20h.01" /><path d="M2 8.82a15 15 0 0 1 20 0" /><path d="M5 12.859a10 10 0 0 1 14 0" /><path d="M8.5 16.429a5 5 0 0 1 7 0" /></svg>현장 연결</div>
  <div {...ni('crowd')}><svg className="ic" viewBox="0 0 24 24" style={{width:"19px",height:"19px"}}><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></svg>현장 혼잡 시간</div><h5>로봇과 안전</h5>
  <div {...ni('robot')}><svg className="ic" viewBox="0 0 24 24" style={{width:"19px",height:"19px"}}><path d="M4 13h11l3-3h2v4l-2 1H5z" /><path d="M6 15l-1 4M10 15v4M14 15v4M17 15l1 4" /></svg>로봇</div>
  <div {...ni('safety')}><svg className="ic" viewBox="0 0 24 24" style={{width:"19px",height:"19px"}}><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" /></svg>안전</div>
  <div {...ni('alerts')}><svg className="ic" viewBox="0 0 24 24" style={{width:"19px",height:"19px"}}><path d="M10.268 21a2 2 0 0 0 3.464 0" /><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326" /></svg>알림</div>
  <div {...ni('clip')}><svg className="ic" viewBox="0 0 24 24" style={{width:"19px",height:"19px"}}><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M7 3v18" /><path d="M3 7.5h4" /><path d="M3 12h18" /><path d="M3 16.5h4" /><path d="M17 3v18" /><path d="M17 7.5h4" /><path d="M17 16.5h4" /></svg>기록과 클립</div><h5>화면과 조작</h5>
  <div {...ni('controls')}><svg className="ic" viewBox="0 0 24 24" style={{width:"19px",height:"19px"}}><path d="M10 5H3" /><path d="M12 19H3" /><path d="M14 3v4" /><path d="M16 17v4" /><path d="M21 12h-9" /><path d="M21 19h-5" /><path d="M21 5h-7" /><path d="M8 10v4" /><path d="M8 12H3" /></svg>조작</div>
  <div {...ni('display')}><svg className="ic" viewBox="0 0 24 24" style={{width:"19px",height:"19px"}}><rect width="20" height="14" x="2" y="3" rx="2" /><line x1="8" x2="16" y1="21" y2="21" /><line x1="12" x2="12" y1="17" y2="21" /></svg>표시</div>
  <div {...ni('demo')}><svg className="ic" viewBox="0 0 24 24" style={{width:"19px",height:"19px"}}><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" /><circle cx="12" cy="12" r="3" /></svg>데모 로봇 표시<span className="only">총괄만</span></div><h5>기기</h5>
  <div {...ni('system')}><svg className="ic" viewBox="0 0 24 24" style={{width:"19px",height:"19px"}}><path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" /><circle cx="12" cy="12" r="3" /></svg>시스템</div></div>;

function Account({ user, admin, cancel, logout, openPw }: { user: User; admin: boolean; cancel?: AbortSignal; logout?: () => void; openPw: () => void }) {
  const me = useLoad(() => api.me(cancel), [user.id]);
  const evs = useLoad(() => api.events(new URLSearchParams({ user_id: user.id, category: 'ACCOUNT', limit: '100' }), cancel), [user.id]);
  const mine = (evs.v?.items ?? []).filter((e) => e.code in ACT);
  const login = mine.find((e) => e.code === 'LOGIN'), pwAt = mine.find((e) => e.code === 'PASSWORD_CHANGED');
  const [actPage, setActPage] = useState(0), acts = mine.slice(actPage * 6, actPage * 6 + 6);
  return <>
  <div className="hd"><span className="ttl">계정</span>
    <p>내 계정과 비밀번호. 로그인한 기기 목록은 총괄만 볼 수 있습니다.</p></div>
  <div className="pane" style={{left:"368px",top:"160px",width:"860px",height:"410px"}} aria-label="내 계정">
    <div className="ph"><span className="ttl">내 계정</span><span style={{marginLeft:"auto",display:"flex",gap:"10px",alignItems:"center"}} /></div>
    <div className="row" style={{gap:"18px",paddingBottom:"22px"}}><span style={{width:"72px",height:"72px",borderRadius:"22px",background:"linear-gradient(180deg,#34404f,#222a35)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:"24px",fontWeight:800,boxShadow:"inset 0 1px 0 rgba(255,255,255,.15),0 8px 20px rgba(0,0,0,.3)"}} data-u9-av>{initial(user.name)}</span>
      <div>
        <div className="row" style={{gap:"10px",fontSize:"22px",fontWeight:800}}>{user.name}<span className={admin ? 'rp lead' : 'rp'}>{ROLE[user.role]}</span></div>
        <div className="mu2" style={{fontSize:"14px",fontWeight:600,marginTop:"6px"}} data-u9-me>아이디 {me.v?.username ?? (me.err ? NO : '')} · 마지막 로그인 {login ? when(login.at, true) : evs.v || evs.err ? NO : ''}</div></div></div>
    <div className="rw"><svg className="ic" viewBox="0 0 24 24" style={{width:"20px",height:"20px"}}><rect width="18" height="11" x="3" y="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
      <div>비밀번호<small data-u9-pw-at>{pwAt ? `${md(pwAt.at)} 에 바꿈` : evs.v || evs.err ? NO : ''}</small></div>
      <div className="r"><button type="button" className="btns sb" id="go-pw" onClick={openPw}><svg className="ic" viewBox="0 0 24 24" style={{width:"16px",height:"16px"}}><path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z" /><circle cx="16.5" cy="7.5" r=".5" fill="currentColor" /></svg>비밀번호 바꾸기</button></div></div>
    <div className="rw"><svg className="ic" viewBox="0 0 24 24" style={{width:"20px",height:"20px"}}><circle cx="12" cy="12" r="10" /><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" /><path d="M2 12h20" /></svg>
      <div>이름 표시<small>다른 사람 화면에는 「{user.name}」 로 보입니다</small></div></div>
    <div className="rw"><svg className="ic" viewBox="0 0 24 24" style={{width:"20px",height:"20px"}}><path d="m16 17 5-5-5-5" /><path d="M21 12H9" /><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /></svg>
      <div>로그아웃<small>이 PC 에서만 로그아웃됩니다</small></div>
      <div className="r"><button type="button" className="btns sb" id="go-logout" onClick={logout} disabled={!logout}>로그아웃</button></div></div></div>
  <div className="pane" style={{left:"368px",top:"594px",width:"860px",height:"462px"}} aria-label="최근 활동">
    <div className="ph"><span className="ttl">최근 활동</span><span style={{marginLeft:"auto",display:"flex",gap:"10px",alignItems:"center"}}><Pager n={mine.length} per={6} at={actPage} go={setActPage} /></span></div>
    {evs.err && <Why>{evs.err}</Why>}
    {evs.v && !mine.length && <Why>최근 활동이 없습니다.</Why>}
    {acts.map((e) => <div key={e.id} className="rw" style={{minHeight:"52px",fontSize:"14px"}} data-u9-act><span className="mu2" style={{width:"120px",fontWeight:600}}>{when(e.at, true, undefined, false)}</span>{ACT[e.code]}<span className="mu2" style={{marginLeft:"auto",fontWeight:600,fontSize:"13.5px"}}>{e.code === 'PASSWORD_CHANGED' ? '모든 기기에서 로그아웃됨' : ''}</span></div>)}</div>
  {admin && <Devices cancel={cancel} pc={<><svg className="ic" viewBox="0 0 24 24" style={{width:"19px",height:"19px"}}><path d="M18 5a2 2 0 0 1 2 2v8.526a2 2 0 0 0 .212.897l1.068 2.127a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45l1.068-2.127A2 2 0 0 0 4 15.526V7a2 2 0 0 1 2-2z" /><path d="M20.054 15.987H3.946" /></svg></>} phone={<><svg className="ic" viewBox="0 0 24 24" style={{width:"19px",height:"19px"}}><rect width="14" height="20" x="5" y="2" rx="2" ry="2" /><path d="M12 18h.01" /></svg></>} />}
  </>;
}

/** 로그인 기기(총괄만): 모든 사용자의 살아 있는 세션. 서버가 지금 이 기기의 세션 id 를 주지 않아 「이 기기」 표는 달지 않는다 */
function Devices({ cancel, pc, phone }: { cancel?: AbortSignal; pc: ReactNode; phone: ReactNode }) {
  const [n, setN] = useState(0), [at, setAt] = useState(0), [msg, setMsg] = useState('');
  const rows = useLoad(async () => {
    const users = await api.users(cancel), now = Date.now();
    const per = await Promise.all(users.map(async (u) => (await api.sessions(u.id, cancel)).filter((x) => !x.revoked_at && Date.parse(x.expires_at) > now).map((x) => ({ u, x }))));
    return per.flat().sort((p, q) => Date.parse(q.x.last_seen_at) - Date.parse(p.x.last_seen_at));
  }, [n]);
  const cut = async (uid: string, sid: string) => {
    setMsg('');
    try { await api.endSession(uid, sid, cancel); setN(n + 1); } catch (e) { setMsg((e as ApiFail).message); }
  };
  const list = rows.v ?? [];
  return <div className="pane" style={{left:"1252px",top:"160px",width:"644px",height:"896px"}} aria-label="로그인 기기">
    <div className="ph"><span className="ttl">로그인 기기</span><span className="only">총괄만</span><span style={{marginLeft:"auto",display:"flex",gap:"10px",alignItems:"center"}}><Pager n={list.length} per={8} at={at} go={setAt} /></span></div>
    {rows.err && <Why>{rows.err}</Why>}
    {rows.v && !list.length && <Why>로그인한 기기가 없습니다.</Why>}
    {list.slice(at * 8, at * 8 + 8).map(({ u, x }) => <div key={x.id} className="rw" style={{minHeight:"76px"}} data-u9-dev><span className="av2">{x.client === 'web' ? pc : phone}</span>
      <div>{x.client === 'web' ? 'PC' : '폰'} · {u.display_name}<small>{when(x.last_seen_at)}</small></div>
      <div className="r"><button type="button" className="btns sb" onClick={() => cut(u.id, x.id)}>끊기</button></div></div>)}
    {msg && <Why alert>{msg}</Why>}
    <p className="mu2" style={{fontSize:"13px",fontWeight:600,marginTop:"16px",lineHeight:1.6}}>끊은 기기는 다시 로그인해야 쓸 수 있습니다. 조종 중인 기기를 끊으면 그 로봇은 그 자리에 멈춥니다.</p></div>;
}

function Users({ me, cancel }: { me: User; cancel?: AbortSignal }) {
  const [n, setN] = useState(0), [at, setAt] = useState(0), [logAt, setLogAt] = useState(0), [adding, setAdding] = useState(false), [why, setWhy] = useState('');
  const data = useLoad(async () => {
    const [users, robots] = await Promise.all([api.users(cancel), api.robots('all', cancel)]);
    const seen = await Promise.all(users.map(async (u) => (await api.sessions(u.id, cancel)).reduce((m, x) => (x.last_seen_at > m ? x.last_seen_at : m), '')));
    return { users, names: Object.fromEntries(robots.map((r) => [r.id, r.name])), seen };
  }, [n]);
  const log = useLoad(() => api.events(new URLSearchParams({ category: 'ACCOUNT', limit: '100' }), cancel), [n]);
  const users = data.v?.users ?? [], who = Object.fromEntries(users.map((u) => [u.id, u.display_name]));
  const changes = (log.v?.items ?? []).filter((e) => CHANGE.includes(e.code));
  return <>
  <div className="hd"><span className="ttl">사용자와 권한</span><span className="only" style={{height:"26px",fontSize:"12.5px"}}>총괄만</span>
    <p>계정은 총괄과 운영자 두 가지입니다. 권한은 총괄이 가장 넓습니다.</p></div>
  <div className="pane" style={{left:"368px",top:"160px",width:"940px",height:"640px"}} aria-label="사용자">
    <div className="ph"><span className="ttl">사용자</span><span style={{marginLeft:"auto",display:"flex",gap:"10px",alignItems:"center"}}><Pager n={users.length} per={6} at={at} go={setAt} /><button type="button" className="btnp sb" onClick={() => setAdding(true)}><svg className="ic" viewBox="0 0 24 24" style={{width:"16px",height:"16px"}}><path d="M5 12h14" /><path d="M12 5v14" /></svg>사용자 추가</button></span></div>
    {data.err && <Why alert>{data.err}</Why>}
    <table className="tbl"><tbody>
      <tr><th>이름</th><th>역할</th><th>아이디</th><th>담당 로봇</th><th>마지막 접속</th><th /></tr>
      {users.slice(at * 6, at * 6 + 6).map((u) => { const i = users.indexOf(u), last = data.v!.seen[i]; return <tr key={u.id} data-u9-user>
        <td><span className="row" style={{gap:"12px"}}><span className="av2">{initial(u.display_name)}</span>{u.display_name}</span></td><td><span className={u.role === 'ORG_ADMIN' ? 'rp lead' : 'rp'}>{ROLE[u.role]}</span></td><td className="m">{u.username}</td>
        <td className="m">{u.robot_ids.length ? u.robot_ids.map((r) => data.v!.names[r] ?? r).join(' · ') : '없음'}</td><td className="m">{last ? ago(last) : NO}</td>
        <td style={{textAlign:"right"}}>{u.id !== me.id && <button type="button" className="btns sb" style={{display:"inline-flex"}} aria-disabled="true" onClick={() => setWhy(NO_TEMP)}><svg className="ic" viewBox="0 0 24 24" style={{width:"15px",height:"15px"}}><path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z" /><circle cx="16.5" cy="7.5" r=".5" fill="currentColor" /></svg>임시 비밀번호</button>}</td></tr>; })}</tbody></table>
    {why ? <Why alert>{why}</Why>
    : <p className="mu2" style={{fontSize:"13px",fontWeight:600,marginTop:"18px",lineHeight:1.6}}>임시 비밀번호는 12 자로 만들어 한 번만 보여 줍니다. 받은 사람은 처음 로그인할 때 바꿔야 합니다.</p>}</div>
  <div className="pane" style={{left:"1332px",top:"160px",width:"564px",height:"640px"}} aria-label="권한">
    <div className="ph"><span className="ttl">권한</span><span style={{marginLeft:"auto",display:"flex",gap:"10px",alignItems:"center"}} /></div>
    <table className="tbl pt">
      <tr><th>할 수 있는 일</th><th style={{textAlign:"center",width:"90px"}}>총괄</th><th style={{textAlign:"center",width:"90px"}}>운영자</th></tr>
      <tr><td>로봇 연결</td><td style={{textAlign:"center"}} className="yes"><svg className="ic" viewBox="0 0 24 24" style={{width:"20px",height:"20px"}}><path d="M20 6 9 17l-5-5" /></svg></td><td style={{textAlign:"center"}} className="yes"><svg className="ic" viewBox="0 0 24 24" style={{width:"20px",height:"20px"}}><path d="M20 6 9 17l-5-5" /></svg></td></tr>
      <tr><td>조종 · 동작</td><td style={{textAlign:"center"}} className="yes"><svg className="ic" viewBox="0 0 24 24" style={{width:"20px",height:"20px"}}><path d="M20 6 9 17l-5-5" /></svg></td><td style={{textAlign:"center"}} className="yes"><svg className="ic" viewBox="0 0 24 24" style={{width:"20px",height:"20px"}}><path d="M20 6 9 17l-5-5" /></svg></td></tr>
      <tr><td>정지 (어느 로봇이든)</td><td style={{textAlign:"center"}} className="yes"><svg className="ic" viewBox="0 0 24 24" style={{width:"20px",height:"20px"}}><path d="M20 6 9 17l-5-5" /></svg></td><td style={{textAlign:"center"}} className="yes"><svg className="ic" viewBox="0 0 24 24" style={{width:"20px",height:"20px"}}><path d="M20 6 9 17l-5-5" /></svg></td></tr>
      <tr><td>임무 만들기 · 모의 실행</td><td style={{textAlign:"center"}} className="yes"><svg className="ic" viewBox="0 0 24 24" style={{width:"20px",height:"20px"}}><path d="M20 6 9 17l-5-5" /></svg></td><td style={{textAlign:"center"}} className="yes"><svg className="ic" viewBox="0 0 24 24" style={{width:"20px",height:"20px"}}><path d="M20 6 9 17l-5-5" /></svg></td></tr>
      <tr><td>지도 만들기</td><td style={{textAlign:"center"}} className="yes"><svg className="ic" viewBox="0 0 24 24" style={{width:"20px",height:"20px"}}><path d="M20 6 9 17l-5-5" /></svg></td><td style={{textAlign:"center"}} className="yes"><svg className="ic" viewBox="0 0 24 24" style={{width:"20px",height:"20px"}}><path d="M20 6 9 17l-5-5" /></svg></td></tr>
      <tr><td>사용자와 권한</td><td style={{textAlign:"center"}} className="yes"><svg className="ic" viewBox="0 0 24 24" style={{width:"20px",height:"20px"}}><path d="M20 6 9 17l-5-5" /></svg></td><td style={{textAlign:"center"}} className="no"><span style={{display:"inline-block",width:"14px",height:"2px",borderRadius:"1px",background:"#4a5260",verticalAlign:"middle"}} /></td></tr>
      <tr><td>로그인 기기 보기 · 끊기</td><td style={{textAlign:"center"}} className="yes"><svg className="ic" viewBox="0 0 24 24" style={{width:"20px",height:"20px"}}><path d="M20 6 9 17l-5-5" /></svg></td><td style={{textAlign:"center"}} className="no"><span style={{display:"inline-block",width:"14px",height:"2px",borderRadius:"1px",background:"#4a5260",verticalAlign:"middle"}} /></td></tr>
      <tr><td>데모 로봇 표시 끄기</td><td style={{textAlign:"center"}} className="yes"><svg className="ic" viewBox="0 0 24 24" style={{width:"20px",height:"20px"}}><path d="M20 6 9 17l-5-5" /></svg></td><td style={{textAlign:"center"}} className="no"><span style={{display:"inline-block",width:"14px",height:"2px",borderRadius:"1px",background:"#4a5260",verticalAlign:"middle"}} /></td></tr></table>
    <p className="mu2" style={{fontSize:"13px",fontWeight:600,marginTop:"18px",lineHeight:1.6}}>총괄은 운영자가 하는 일을 모두 합니다. 남이 담당한 로봇의 조종권은 뺏지 않고 요청합니다.</p></div>
  <div className="pane" style={{left:"368px",top:"824px",width:"1528px",height:"232px"}} aria-label="바꾼 기록">
    <div className="ph"><span className="ttl">바꾼 기록</span><span style={{marginLeft:"auto",display:"flex",gap:"10px",alignItems:"center"}}><Pager n={changes.length} per={3} at={logAt} go={setLogAt} /></span></div>
    {log.err && <Why alert>{log.err}</Why>}
    {log.v && !changes.length && <Why>바꾼 기록이 없습니다.</Why>}
    {changes.slice(logAt * 3, logAt * 3 + 3).map((e) => <div key={e.id} className="rw" style={{minHeight:"48px",fontSize:"14px"}} data-u9-change><span className="mu2" style={{width:"130px",fontWeight:600}}>{when(e.at, false, undefined, false)}</span><span style={{width:"60px"}}>{(e.user_id && who[e.user_id]) ?? ''}</span><span style={{fontWeight:600}}>{e.message}</span></div>)}</div>
  {adding && <AddUser cancel={cancel} close={() => setAdding(false)} done={() => setN(n + 1)} />}
  </>;
}

/** 사용자 추가(시안에 창 그림이 없어 u9_2 비밀번호 창과 같은 꼴). 임시 비밀번호 12 자는 여기서 만들어 서버에 보내고 한 번만 보인다 */
function AddUser({ close, done, cancel }: { close: () => void; done: () => void; cancel?: AbortSignal }) {
  const [msg, setMsg] = useState(''), [busy, setBusy] = useState(false), [role, setRole] = useState<'OPERATOR' | 'ORG_ADMIN'>('OPERATOR'), [made, setMade] = useState<{ name: string; pw: string } | null>(null);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    const f = new FormData(e.currentTarget), username = String(f.get('username')).trim(), display_name = String(f.get('display_name')).trim();
    if (!username || !display_name) return setMsg('아이디와 이름을 입력하세요.');
    const pw = tempPassword();
    setBusy(true);
    try { const u = await api.createUser({ username, display_name, role, temp_password: pw }, cancel); setMade({ name: `${u.display_name}(${u.username})`, pw }); done(); }
    catch (err) { setMsg(failText(err, TAKEN)); }
    finally { setBusy(false); }
  };
  return <>
  <div className="scrim" onClick={close} />
  <form className="g modal" style={{width:"560px"}} role="dialog" aria-modal="true" aria-label="사용자 추가" onSubmit={submit} onKeyDown={(e) => { if (e.key === 'Escape') close(); }} noValidate>
    <div className="row" style={{justifyContent:"space-between"}}><span className="ttl">사용자 추가</span></div>
    {made ? <div style={{display:"flex",flexDirection:"column",gap:"16px",marginTop:"22px"}}>
      <p className="lab" style={{lineHeight:1.6}}>{made.name} 계정을 만들었습니다. 임시 비밀번호를 본인에게 전하세요. 이 창을 닫으면 다시 볼 수 없습니다.</p>
      <div className="inp"><input aria-label="임시 비밀번호" readOnly value={made.pw} onFocus={(e) => e.currentTarget.select()} /></div>
      <div style={{display:"flex",gap:"10px"}}><button type="button" className="btnp mbtn" style={{flex:1}} onClick={close}>닫기</button></div></div>
    : <><div style={{display:"flex",flexDirection:"column",gap:"16px",marginTop:"22px"}}>
      <label><div className="lab">이름</div><div className="inp"><input name="display_name" autoComplete="off" maxLength={128} autoFocus /></div></label>
      <label><div className="lab">아이디</div><div className="inp"><input name="username" autoComplete="off" maxLength={128} /></div></label>
      <div><div className="lab">역할</div><div className="seg2" role="radiogroup" aria-label="역할" style={{display:"inline-flex"}}>{(['OPERATOR', 'ORG_ADMIN'] as const).map((r) => <span key={r} role="radio" tabIndex={0} aria-checked={role === r} className={role === r ? 'on' : ''} onClick={() => setRole(r)}>{ROLE[r]}</span>)}</div></div></div>
    {msg ? <p role="alert" style={{fontSize:"13px",color:"#b8361f",fontWeight:700,marginTop:"14px"}}>{msg}</p>
    : <p style={{fontSize:"13px",color:"#5e6662",fontWeight:600,marginTop:"14px",lineHeight:1.6}}>임시 비밀번호는 12 자로 만들어 한 번만 보여 줍니다. 받은 사람은 처음 로그인할 때 바꿔야 합니다.</p>}
    <div style={{display:"flex",gap:"10px",marginTop:"22px"}}>
      <button type="button" className="mbtn sec" style={{flex:1}} onClick={close}>취소</button>
      <button type="submit" className="btnp mbtn" style={{flex:1}} disabled={busy}>만들기</button></div></>}</form>
  </>;
}

function Network({ cancel }: { cancel?: AbortSignal }) {
  const [why, setWhy] = useState('');
  // 서버 점검 값이 따로 없어, 이 화면이 직접 재는 것만 쓴다: 앱 → 서버 API 한 번 오가는 시간(GET /me)
  const ping = useLoad(async () => { const t = performance.now(); await api.me(cancel); return { ms: Math.round(performance.now() - t), at: new Date().toISOString() }; }, []);
  return <>
  <div className="hd"><span className="ttl">현장 연결</span>
    <p>저장된 현장 네트워크와 서버. 연결 상태는 모든 탭 위쪽 줄에도 늘 보입니다.</p></div>
  <div className="pane" style={{left:"368px",top:"160px",width:"900px",height:"600px"}} aria-label="현장 네트워크 목록">
    <div className="ph"><span className="ttl">현장 네트워크 목록</span><span style={{marginLeft:"auto",display:"flex",gap:"10px",alignItems:"center"}}><button type="button" className="btnp sb" aria-disabled="true" onClick={() => setWhy(NO_NET)}><svg className="ic" viewBox="0 0 24 24" style={{width:"16px",height:"16px"}}><path d="M5 12h14" /><path d="M12 5v14" /></svg>네트워크 추가</button></span></div>
    <Why alert={!!why}>{why || `저장된 현장 네트워크: ${NO}. 현장 네트워크를 저장하는 서버 기능이 아직 없습니다.`}</Why>
    <p className="mu2" style={{fontSize:"13px",fontWeight:600,marginTop:"18px",lineHeight:1.6}}>로봇 한 대의 연결 상태와 바꾸기는 로봇 탭에서 봅니다.</p></div>
  <div className="pane" style={{left:"1292px",top:"160px",width:"604px",height:"600px"}} aria-label="서버">
    <div className="ph"><span className="ttl">서버</span><span style={{marginLeft:"auto",display:"flex",gap:"10px",alignItems:"center"}}>{ping.v ? <span className="okb">정상</span> : ping.err ? <span className="mu2">연결 안 됨</span> : null}</span></div>
    <div className="row" style={{gap:"14px",paddingBottom:"18px"}}><span className="av2" style={{width:"48px",height:"48px"}}><svg className="ic" viewBox="0 0 24 24" style={{width:"22px",height:"22px"}}><rect width="20" height="8" x="2" y="2" rx="2" ry="2" /><rect width="20" height="8" x="2" y="14" rx="2" ry="2" /><line x1="6" x2="6.01" y1="6" y2="6" /><line x1="6" x2="6.01" y1="18" y2="18" /></svg></span>
      <div style={{fontSize:"17px",fontWeight:800}}>{location.host}
        <div className="mu2" style={{fontSize:"13px",fontWeight:600,marginTop:"3px"}}>{ping.v ? `마지막 점검 ${when(ping.v.at)}` : ping.err ?? ''}</div></div></div>
    <div className="rw" style={{minHeight:"58px"}}><span className="mu2"><svg className="ic" viewBox="0 0 24 24" style={{width:"20px",height:"20px"}}><path d="M20 6 9 17l-5-5" /></svg></span>
      <div>로봇과 앱이 연결됨<small>{NO}</small></div></div>
    <div className="rw" style={{minHeight:"58px"}}><span className="mu2"><svg className="ic" viewBox="0 0 24 24" style={{width:"20px",height:"20px"}}><path d="M20 6 9 17l-5-5" /></svg></span>
      <div>Wi-Fi 추가 로그인 필요 없음<small>{NO}</small></div></div>
    <div className="rw" style={{minHeight:"58px"}}><span className={ping.v ? 'yes' : 'mu2'}><svg className="ic" viewBox="0 0 24 24" style={{width:"20px",height:"20px"}}><path d="M20 6 9 17l-5-5" /></svg></span>
      <div>서버까지 연결됨<small data-u9-ping>{ping.v ? `${ping.v.ms} ms` : ping.err ?? ''}</small></div></div></div>
  <div className="pane" style={{left:"368px",top:"784px",width:"900px",height:"272px"}} aria-label="현장 확인">
    <div className="ph"><span className="ttl">현장 확인</span><span style={{marginLeft:"auto",display:"flex",gap:"10px",alignItems:"center"}} /></div>
    <div className="row" style={{gap:"16px",alignItems:"flex-start"}}>
      <div style={{flex:1,fontSize:"15px",fontWeight:700}}>로봇을 처음 연결할 때 현장 담당자가 승인
        <div className="mu2" style={{fontSize:"13.5px",fontWeight:600,marginTop:"8px",lineHeight:1.6}}>{NO}. 켜고 끄는 값은 서버 권한 결정을 기다립니다. 정해지면 켤 때 로봇 옆 사람이 폰에서 승인해야 연결됩니다.</div></div><span className="sw lock" role="switch" aria-checked="false" aria-disabled="true" aria-label="현장 담당자 승인" /></div></div>
  <div className="pane" style={{left:"1292px",top:"784px",width:"604px",height:"272px"}} aria-label="끊겼을 때">
    <div className="ph"><span className="ttl">끊겼을 때</span><span style={{marginLeft:"auto",display:"flex",gap:"10px",alignItems:"center"}} /></div>
    <p className="mu2" style={{fontSize:"13.5px",fontWeight:600,marginBottom:"14px"}}>점검에서 문제가 하나라도 생기면 이유와 해결 버튼을 보여 줍니다.</p>
    <Why>{NO}. 망 · 기기 간 차단 · Wi-Fi 추가 로그인을 점검하는 서버 기능이 아직 없어, 끊긴 까닭과 해결 단추를 보일 수 없습니다.</Why></div>
  </>;
}

/** 알림(u9_5). 관절 온도 단계 · 이상 감지 기준 · 배터리 위험 10 % 는 시안 경보 값 그대로(서버 값 없음, 시안 결정).
 *  배터리 주의 = 조직 설정 battery_low_pct. 켜고 끄는 스위치는 서버 값이 없어 잠근다(lock) */
function Alerts({ cancel }: { cancel?: AbortSignal }) {
  const org = useLoad(() => api.settings(cancel), []);
  const low = org.v?.battery_low_pct;
  return <>
  <div className="hd"><span className="ttl">알림</span>
    <p>언제 알릴지 정합니다. 단계마다 숫자와 글을 함께 보여 줍니다.</p></div>
  <div className="pane" style={{left:"368px",top:"160px",width:"1528px",height:"280px"}}>
    <div className="ph"><span className="ttl">관절 온도</span><span style={{marginLeft:"auto",display:"flex",gap:"10px",alignItems:"center"}}><span className="mu2" style={{fontSize:"13.5px",fontWeight:600}}>최고 관절 온도 기준</span></span></div>
    <div style={{position:"relative",height:"100px",marginTop:"4px"}}>
      <div style={{position:"absolute",left:"0.0px",width:"556.0px",top:"44px",height:"44px",borderRadius:"10px",background:"#00c389",opacity:0.55,boxShadow:"inset 0 1px 0 rgba(255,255,255,.3)"}} />
      <div style={{position:"absolute",left:"14.0px",top:"55px",fontSize:"15px",fontWeight:800,color:"#fff",textShadow:"0 1px 2px rgba(0,0,0,.3)"}}>보통</div>
      <div style={{position:"absolute",left:"560.0px",width:"276.0px",top:"44px",height:"44px",borderRadius:"10px",background:"#f2b705",opacity:0.65,boxShadow:"inset 0 1px 0 rgba(255,255,255,.3)"}} />
      <div style={{position:"absolute",left:"574.0px",top:"55px",fontSize:"15px",fontWeight:800,color:"#fff",textShadow:"0 1px 2px rgba(0,0,0,.3)"}}>주의</div>
      <div style={{position:"absolute",left:"840.0px",width:"276.0px",top:"44px",height:"44px",borderRadius:"10px",background:"#ff4d4f",opacity:0.55,boxShadow:"inset 0 1px 0 rgba(255,255,255,.3)"}} />
      <div style={{position:"absolute",left:"854.0px",top:"55px",fontSize:"15px",fontWeight:800,color:"#fff",textShadow:"0 1px 2px rgba(0,0,0,.3)"}}>경고</div>
      <div style={{position:"absolute",left:"1120.0px",width:"276.0px",top:"44px",height:"44px",borderRadius:"10px",background:"#ff4d4f",opacity:0.95,boxShadow:"inset 0 1px 0 rgba(255,255,255,.3)"}} />
      <div style={{position:"absolute",left:"1134.0px",top:"55px",fontSize:"15px",fontWeight:800,color:"#fff",textShadow:"0 1px 2px rgba(0,0,0,.3)"}}>위험</div>
      <div style={{position:"absolute",left:"558.0px",top:"0",fontSize:"22px",fontWeight:800,transform:"translateX(-50%)"}}>50 °C</div>
      <div style={{position:"absolute",left:"558.0px",top:"34px",width:"2px",height:"64px",background:"rgba(255,255,255,.55)"}} />
      <div style={{position:"absolute",left:"838.0px",top:"0",fontSize:"22px",fontWeight:800,transform:"translateX(-50%)"}}>60 °C</div>
      <div style={{position:"absolute",left:"838.0px",top:"34px",width:"2px",height:"64px",background:"rgba(255,255,255,.55)"}} />
      <div style={{position:"absolute",left:"1118.0px",top:"0",fontSize:"22px",fontWeight:800,transform:"translateX(-50%)"}}>70 °C</div>
      <div style={{position:"absolute",left:"1118.0px",top:"34px",width:"2px",height:"64px",background:"rgba(255,255,255,.55)"}} /></div>
    <div className="row" style={{gap:"28px",marginTop:"22px",fontSize:"14.5px",fontWeight:700}}><span className="row" style={{gap:"8px"}}><svg className="ic" viewBox="0 0 24 24" style={{width:"18px",height:"18px"}}><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" /><path d="M12 9v4" /><path d="M12 17h.01" /></svg>모터 보호 기능이 작동하면 온도와 상관없이 위험</span><span className="row mu2" style={{gap:"8px",fontWeight:600}}><svg className="ic" viewBox="0 0 24 24" style={{width:"18px",height:"18px"}}><circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" /></svg>알림은 로봇을 세우지 않고, 멈출지 물어봅니다.</span></div></div>
  <div className="pane" style={{left:"368px",top:"464px",width:"560px",height:"300px"}}>
    <div className="ph"><span className="ttl">이상 감지</span><span style={{marginLeft:"auto",display:"flex",gap:"10px",alignItems:"center"}} /></div>
    <div className="rw" style={{minHeight:"76px"}}><svg className="ic" viewBox="0 0 24 24" style={{width:"22px",height:"22px"}}><path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z" /></svg>
      <div>급상승<small>2 분 안에 10 °C 넘게 오르면</small></div>
      <div className="r"><span className="sw on lock" role="switch" aria-checked="true" aria-disabled="true" title={NO_SWITCH} /></div></div>
    <div className="rw" style={{minHeight:"76px"}}><svg className="ic" viewBox="0 0 24 24" style={{width:"22px",height:"22px"}}><path d="M4 13h11l3-3h2v4l-2 1H5z" /><path d="M6 15l-1 4M10 15v4M14 15v4M17 15l1 4" /></svg>
      <div>한 관절만 뜨거움<small>같은 다리 다른 관절보다 15 °C 높으면</small></div>
      <div className="r"><span className="sw on lock" role="switch" aria-checked="true" aria-disabled="true" title={NO_SWITCH} /></div></div></div>
  <div className="pane" style={{left:"952px",top:"464px",width:"500px",height:"300px"}}>
    <div className="ph"><span className="ttl">배터리</span><span style={{marginLeft:"auto",display:"flex",gap:"10px",alignItems:"center"}} /></div>
    <div className="row" style={{gap:"16px",minHeight:"76px",borderTop:"1px solid var(--line)"}}><span style={{position:"relative",width:"58px",height:"28px",border:"2px solid #c9ced6",borderRadius:"7px",padding:"3px"}}><i style={{display:"block",height:"100%",width:`${low ?? 0}%`,borderRadius:"3px",background:"#f2b705"}} /></span><i style={{width:"4px",height:"8px",borderRadius:"2px",background:"#c9ced6",marginLeft:"-14px"}} />
      <div style={{fontSize:"24px",fontWeight:800}} data-u9-low>{low != null ? `${low} %` : org.err ? NO : ''}</div>
      <div style={{fontSize:"15px",fontWeight:700}}>주의 · 반복 알림</div></div>
    <div className="row" style={{gap:"16px",minHeight:"76px",borderTop:"1px solid var(--line)"}}><span style={{position:"relative",width:"58px",height:"28px",border:"2px solid #c9ced6",borderRadius:"7px",padding:"3px"}}><i style={{display:"block",height:"100%",width:"10%",borderRadius:"3px",background:"#ff4d4f"}} /></span><i style={{width:"4px",height:"8px",borderRadius:"2px",background:"#c9ced6",marginLeft:"-14px"}} />
      <div style={{fontSize:"24px",fontWeight:800}}>10 %</div>
      <div style={{fontSize:"15px",fontWeight:700}}>위험 · 반복 알림</div></div></div>
  <div className="pane" style={{left:"1476px",top:"464px",width:"420px",height:"300px"}}>
    <div className="ph"><span className="ttl">받는 곳</span><span style={{marginLeft:"auto",display:"flex",gap:"10px",alignItems:"center"}} /></div>
    <div className="rw"><svg className="ic" viewBox="0 0 24 24" style={{width:"20px",height:"20px"}}><path d="M18 5a2 2 0 0 1 2 2v8.526a2 2 0 0 0 .212.897l1.068 2.127a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45l1.068-2.127A2 2 0 0 0 4 15.526V7a2 2 0 0 1 2-2z" /><path d="M20.054 15.987H3.946" /></svg>
      <div>PC 위쪽 알림 종<small>모든 알림</small></div>
      <div className="r"><span className="sw on lock" role="switch" aria-checked="true" aria-disabled="true" title={NO_SWITCH} /></div></div>
    <div className="rw"><svg className="ic" viewBox="0 0 24 24" style={{width:"20px",height:"20px"}}><rect width="14" height="20" x="5" y="2" rx="2" ry="2" /><path d="M12 18h.01" /></svg>
      <div>담당자 폰<small>주의 등급 이상</small></div>
      <div className="r"><span className="sw on lock" role="switch" aria-checked="true" aria-disabled="true" title={NO_SWITCH} /></div></div>
    <div className="rw"><svg className="ic" viewBox="0 0 24 24" style={{width:"20px",height:"20px"}}><path d="M10.268 21a2 2 0 0 0 3.464 0" /><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326" /></svg>
      <div>소리<small>경고 · 위험</small></div>
      <div className="r"><span className="sw on lock" role="switch" aria-checked="true" aria-disabled="true" title={NO_SWITCH} /></div></div></div>
  <div className="pane" style={{left:"368px",top:"788px",width:"1528px",height:"268px"}}>
    <div className="ph"><span className="ttl">이렇게 알립니다</span><span style={{marginLeft:"auto",display:"flex",gap:"10px",alignItems:"center"}}><span className="mu2" style={{fontSize:"13.5px",fontWeight:600}}>단계와 숫자를 함께 보여 주고, 정지는 권하기만 합니다</span></span></div>
    <div className="row" style={{gap:"24px",alignItems:"stretch",marginTop:"20px"}} aria-hidden="true" data-u9-example>
      <div style={{position:"relative",width:"470px",padding:"22px 20px 18px",borderRadius:"16px",background:"rgba(242,183,5,.08)",border:"1px solid #f2b705",boxShadow:"inset 0 1px 0 rgba(255,255,255,.08)"}}><span style={{position:"absolute",left:"16px",top:"-12px",height:"24px",padding:"0 10px",borderRadius:"8px",background:"#f2b705",color:"#fff",fontSize:"12px",fontWeight:800,display:"flex",alignItems:"center"}}>주의</span>
        <div className="row" style={{gap:"12px"}}><b style={{fontSize:"17px",color:"#ffffff"}}>K-02</b><span className="mu2" style={{fontSize:"13.5px",fontWeight:600}}>오른쪽 앞다리 무릎</span><b style={{marginLeft:"auto",fontSize:"26px",color:"#ffffff"}}>52 °C</b></div>
        <div className="row" style={{gap:"10px",marginTop:"14px"}}><span className="mu2" style={{fontSize:"13px",fontWeight:600}}>계속 걷는 중</span><span className="btns" style={{marginLeft:"auto",height:"36px",padding:"0 14px",fontSize:"13px"}}>멈춤</span></div></div>
      <div style={{position:"relative",width:"470px",padding:"22px 20px 18px",borderRadius:"16px",background:"rgba(255,77,79,.08)",border:"1px solid #ff4d4f",boxShadow:"inset 0 1px 0 rgba(255,255,255,.08)"}}><span style={{position:"absolute",left:"16px",top:"-12px",height:"24px",padding:"0 10px",borderRadius:"8px",background:"#ff4d4f",color:"#fff",fontSize:"12px",fontWeight:800,display:"flex",alignItems:"center"}}>경고</span>
        <div className="row" style={{gap:"12px"}}><b style={{fontSize:"17px",color:"#ff4d4f"}}>K-03</b><span className="mu2" style={{fontSize:"13.5px",fontWeight:600}}>왼쪽 뒷다리 무릎</span><b style={{marginLeft:"auto",fontSize:"26px",color:"#ff4d4f"}}>63 °C</b></div>
        <div className="row" style={{gap:"10px",marginTop:"14px"}}><span className="mu2" style={{fontSize:"13px",fontWeight:600}}>같은 다리 다른 관절보다 16 °C 높음</span><span className="btns" style={{marginLeft:"auto",height:"36px",padding:"0 14px",fontSize:"13px"}}>멈춤</span></div></div>
      <div style={{position:"relative",width:"470px",padding:"22px 20px 18px",borderRadius:"16px",background:"rgba(255,77,79,.16)",border:"1px solid #ff4d4f",boxShadow:"inset 0 1px 0 rgba(255,255,255,.08)"}}><span style={{position:"absolute",left:"16px",top:"-12px",height:"24px",padding:"0 10px",borderRadius:"8px",background:"#ff4d4f",color:"#fff",fontSize:"12px",fontWeight:800,display:"flex",alignItems:"center"}}>위험</span>
        <div className="row" style={{gap:"12px"}}><b style={{fontSize:"17px",color:"#ff4d4f"}}>K-05</b><span className="mu2" style={{fontSize:"13.5px",fontWeight:600}}>배터리</span><b style={{marginLeft:"auto",fontSize:"26px",color:"#ff4d4f"}}>9 %</b></div>
        <div className="row" style={{gap:"10px",marginTop:"14px"}}><span className="mu2" style={{fontSize:"13px",fontWeight:600}}>반복 알림 중</span><span className="btns" style={{marginLeft:"auto",height:"36px",padding:"0 14px",fontSize:"13px"}}>멈춤</span></div></div></div></div>
  </>;
}


/** 표시(u9_6 총괄 · u9_9 운영자). 화면 밝기 = 머리 메뉴 밝기와 같은 값(theme.tsx). 언어는 한국어만, 데모 표시는 서버 값이 없어 잠금 */
function Display({ admin }: { admin: boolean }) {
  const [pref] = useTheme();
  const pick = (t: ThemePref) => ({ role: 'radio', tabIndex: 0, 'aria-checked': pref === t, onClick: () => setThemePref(t), onKeyDown: (e: KeyboardEvent) => { if (e.key === 'Enter') setThemePref(t); } });
  return <>
  <div className="hd"><span className="ttl">표시</span>
    <p>화면 밝기 · 언어 · 데모 표시. 여기서만 바꿉니다.</p></div>
  <div className="pane" style={{left:"368px",top:"160px",width:"1040px",height:"560px"}}>
    <div className="ph"><span className="ttl">화면 밝기</span><span style={{marginLeft:"auto",display:"flex",gap:"10px",alignItems:"center"}} /></div>
    <div style={{display:"flex",gap:"16px"}} role="radiogroup" aria-label="화면 밝기">
      <div className={pref === 'light' ? 'pv on' : 'pv'} {...pick('light')} aria-label="밝게">
        <div className="pvs"><div style={{position:"absolute",inset:"0",background:"rgba(246,247,246,.25)"}} /><div className="tb" style={{background:"rgba(255,255,255,.85)"}}><i style={{width:"40px",background:"#1f2421",opacity:".7"}} /><i style={{width:"22px",background:"#1f2421",opacity:".35"}} /><i style={{width:"22px",background:"#1f2421",opacity:".35"}} /></div><div className="cd" style={{background:"linear-gradient(180deg,rgba(255,255,255,.8),rgba(255,255,255,.55))",boxShadow:"0 4px 10px rgba(0,0,0,.2)"}} /><div className="st2" /></div>
        <div className="row" style={{gap:"10px",marginTop:"14px",fontSize:"15px",fontWeight:800}}><span className={pref === 'light' ? 'radio on' : 'radio'} />밝게<span className="mu2" style={{fontSize:"13px",fontWeight:600,marginLeft:"auto"}}>현장 폰 기본</span></div></div>
      <div className={pref === 'dark' ? 'pv on' : 'pv'} {...pick('dark')} aria-label="어둡게">
        <div className="pvs"><div style={{position:"absolute",inset:"0",background:"rgba(12,15,20,.62)"}} /><div className="tb" style={{background:"rgba(12,15,20,.85)"}}><i style={{width:"40px",background:"#ffffff",opacity:".7"}} /><i style={{width:"22px",background:"#ffffff",opacity:".35"}} /><i style={{width:"22px",background:"#ffffff",opacity:".35"}} /></div><div className="cd" style={{background:"linear-gradient(180deg,rgba(28,32,40,.8),rgba(18,20,26,.6))",boxShadow:"0 4px 10px rgba(0,0,0,.2)"}} /><div className="st2" /></div>
        <div className="row" style={{gap:"10px",marginTop:"14px",fontSize:"15px",fontWeight:800}}><span className={pref === 'dark' ? 'radio on' : 'radio'} />어둡게<span className="mu2" style={{fontSize:"13px",fontWeight:600,marginLeft:"auto"}}>관제 PC 기본</span></div></div>
      <div className={pref === 'system' ? 'pv on' : 'pv'} {...pick('system')} aria-label="기기 설정 따르기">
        <div className="pvs"><div style={{position:"absolute",inset:"0",background:"linear-gradient(115deg,rgba(246,247,246,.25) 50%,rgba(12,15,20,.62) 50%)"}} /><div className="tb" style={{background:"linear-gradient(90deg,rgba(255,255,255,.85) 50%,rgba(12,15,20,.85) 50%)"}}><i style={{width:"40px",background:"#1f2421",opacity:".7"}} /><i style={{width:"22px",background:"#1f2421",opacity:".35"}} /><i style={{width:"22px",background:"#1f2421",opacity:".35"}} /></div><div className="cd" style={{background:"linear-gradient(180deg,rgba(255,255,255,.8),rgba(255,255,255,.55))",boxShadow:"0 4px 10px rgba(0,0,0,.2)"}} /><div className="st2" /></div>
        <div className="row" style={{gap:"10px",marginTop:"14px",fontSize:"15px",fontWeight:800}}><span className={pref === 'system' ? 'radio on' : 'radio'} />기기 설정 따르기<span className="mu2" style={{fontSize:"13px",fontWeight:600,marginLeft:"auto"}}>기기 설정대로</span></div></div></div>
    <p className="mu2" style={{fontSize:"13px",fontWeight:600,marginTop:"18px"}}>바꾸면 모든 화면에 바로 적용됩니다.</p></div>
  <div className="pane" style={{left:"1432px",top:"160px",width:"464px",height:"560px"}}>
    <div className="ph"><span className="ttl">언어</span><span style={{marginLeft:"auto",display:"flex",gap:"10px",alignItems:"center"}} /></div>
    <div style={{display:"flex",flexDirection:"column",gap:"12px"}}>
      <div className="pv on" style={{padding:"20px",flex:"none"}}>
        <div className="row" style={{gap:"14px",fontSize:"17px",fontWeight:800}}><span className="radio on" />한국어<span className="mu2" style={{marginLeft:"auto",fontSize:"13px",fontWeight:600}}>지금</span></div>
        <div className="row" style={{gap:"10px",marginTop:"16px",height:"52px",padding:"0 14px",borderRadius:"12px",background:"linear-gradient(180deg,rgba(255,77,79,.22),rgba(255,77,79,.12))",border:"1px solid rgba(255,77,79,.45)",fontSize:"14px",fontWeight:800}}><svg className="ic" viewBox="0 0 24 24" style={{width:"17px",height:"17px"}}><path d="M8 3h8l5 5v8l-5 5H8l-5-5V8z" /><rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" stroke="none" /></svg>정지됨<span style={{fontSize:"12.5px",fontWeight:600,opacity:".75"}}>로봇이 멈췄습니다</span></div></div>
      <div className="pv" style={{padding:"20px",flex:"none"}} aria-disabled="true">
        <div className="row" style={{gap:"14px",fontSize:"17px",fontWeight:800}}><span className="radio" />English</div>
        <div className="row" style={{gap:"10px",marginTop:"16px",height:"52px",padding:"0 14px",borderRadius:"12px",background:"linear-gradient(180deg,rgba(255,77,79,.22),rgba(255,77,79,.12))",border:"1px solid rgba(255,77,79,.45)",fontSize:"14px",fontWeight:800}}><svg className="ic" viewBox="0 0 24 24" style={{width:"17px",height:"17px"}}><path d="M8 3h8l5 5v8l-5 5H8l-5-5V8z" /><rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" stroke="none" /></svg>Stopped<span style={{fontSize:"12.5px",fontWeight:600,opacity:".75"}}>The robot has stopped</span></div></div></div>
    <p className="mu2" style={{fontSize:"13px",fontWeight:600,marginTop:"16px"}} data-why>English 화면 글은 아직 없습니다. 지금은 한국어만 씁니다.</p></div>
  <div className="pane" style={{left:"368px",top:"744px",width:"1528px",height:"312px"}} aria-label="데모 로봇 표시">
    <div className="ph"><span className="ttl">데모 로봇 표시</span><span className="only">총괄만</span><span style={{marginLeft:"auto",display:"flex",gap:"10px",alignItems:"center"}} /></div>
    <div className="row" style={{gap:"28px",alignItems:"center"}}>
      <div style={{width:"560px",fontSize:"15px",fontWeight:700}}>데모 로봇에 「데모」 표시
        <div className="mu2" style={{fontSize:"13.5px",fontWeight:600,marginTop:"8px",lineHeight:1.6}}>발표할 때는 끄세요. 끄면 표시만 사라지고 데모 로봇은 실제 로봇과 같은 모양으로 보입니다.</div>
        {admin ? <div className="why" style={{marginTop:"10px"}} data-why>켜고 끄는 값을 저장하는 서버 기능이 아직 없습니다.</div> : <div className="why" style={{marginTop:"10px",color:"#f2b705"}}>총괄만 바꿀 수 있습니다</div>}</div>
      <div className="row" style={{gap:"14px",flex:1}}>
        <div style={{flex:1}}><div className="lab">켬</div><div style={{flex:1,height:"170px",borderRadius:"14px",position:"relative",overflow:"hidden",background:"url(/proto-assets/assets/real/pc_route.jpg?v=1128042956) 86% 66%/260%",boxShadow:"0 8px 20px rgba(0,0,0,.3)"}}><div className="g dk" style={{left:"10px",bottom:"10px",height:"36px",padding:"0 10px",borderRadius:"11px",display:"flex",alignItems:"center",gap:"8px",fontSize:"13px",fontWeight:800}}>K-07<span style={{height:"20px",padding:"0 7px",borderRadius:"6px",fontSize:"11px",fontWeight:800,background:"rgba(242,183,5,.9)",color:"#1d1406",display:"flex",alignItems:"center"}}>데모</span><span style={{fontSize:"11.5px",fontWeight:600,opacity:".75"}}>순찰 중</span></div></div></div>
        <div style={{flex:1}}><div className="lab">끔</div><div style={{flex:1,height:"170px",borderRadius:"14px",position:"relative",overflow:"hidden",background:"url(/proto-assets/assets/real/pc_route.jpg?v=1128042956) 86% 66%/260%",boxShadow:"0 8px 20px rgba(0,0,0,.3)"}}><div className="g dk" style={{left:"10px",bottom:"10px",height:"36px",padding:"0 10px",borderRadius:"11px",display:"flex",alignItems:"center",gap:"8px",fontSize:"13px",fontWeight:800}}>K-07<span style={{fontSize:"11.5px",fontWeight:600,opacity:".75"}}>순찰 중</span></div></div></div></div><span className="sw on lock" role="switch" aria-checked="true" aria-disabled="true" aria-label="데모 로봇에 「데모」 표시" /></div></div>
  </>;
}

/** 조작(u9_7). 키 목록은 시안 글 그대로(키 동작은 로봇 탭 몫, 여기서 바꾸지 않음). 켜고 끄는 값 · 조이스틱 · 음성은 앱 · 서버에 아직 없어 잠금 + 까닭 */
function Controls() {
  return <>
  <div className="hd"><span className="ttl">조작</span>
    <p>키보드 · 조이스틱 · 음성 · 폰 터치. 규칙은 PC 와 폰이 같습니다.</p></div>
  <div className="pane" style={{left:"368px",top:"160px",width:"840px",height:"896px"}} aria-label="키보드">
    <div className="kb">
      <div className="ph"><span className="ttl">키보드</span><span style={{marginLeft:"auto",display:"flex",gap:"10px",alignItems:"center"}}><span className="sw on lock" role="switch" aria-checked="true" aria-disabled="true" title={NO_SWITCH} /></span></div>
      <div className="rw"><span className="keys"><kbd>↑</kbd></span>
        <div>앞으로<small>누르는 동안 걷습니다</small></div></div>
      <div className="rw"><span className="keys"><kbd>←</kbd><kbd>→</kbd></span>
        <div>돌기<small>그 자리에서 왼쪽 · 오른쪽</small></div></div>
      <div className="rw"><span className="keys"><kbd>↓</kbd></span>
        <div>뒤로<small>아직 막혀 있습니다 · 누르면 까닭 한 줄</small></div></div>
      <div className="rw"><span className="keys"><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></span>
        <div>방향키와 같음<small>W 앞 · A 왼쪽 · D 오른쪽 · S 뒤 (막힘)</small></div></div>
      <div className="rw"><span className="keys"><kbd>Space</kbd></span>
        <div>정지<small>어느 화면에서나 · 이동 입력보다 먼저</small></div></div>
      <div className="rw"><span className="keys"><kbd>Shift</kbd><kbd>1</kbd></span>
        <div>Classic Mode<small>멈춰 있을 때만 · 한 번 확인</small></div></div>
      <div className="rw"><span className="keys"><kbd>Shift</kbd><kbd>2</kbd></span>
        <div>Sport Mode<small>멈춰 있을 때만 · 한 번 확인</small></div></div>
      <div className="rw"><span className="keys"><kbd>Shift</kbd><kbd>3</kbd></span>
        <div>START Mode<small>멈춰 있을 때만 · 한 번 확인</small></div></div>
      <div className="rw"><span className="keys"><kbd>Shift</kbd><kbd>4</kbd></span>
        <div>AME-2 Mode<small>멈춰 있을 때만 · 한 번 확인</small></div></div>
      <div style={{marginTop:"22px",padding:"18px 20px",borderRadius:"14px",background:"rgba(255,255,255,.04)",border:"1px solid var(--line)"}}>
        <div className="row" style={{gap:"10px",fontSize:"15px",fontWeight:800}}><svg className="ic" viewBox="0 0 24 24" style={{width:"19px",height:"19px"}}><circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" /></svg>입력이 겹치면</div>
        <div className="mu2" style={{fontSize:"13.5px",fontWeight:600,marginTop:"8px",lineHeight:1.7}}>정지가 이동보다 우선합니다. 리모컨이 앱보다 우선합니다. 한 로봇은 한 번에 입력 하나만 받습니다.</div></div></div></div>
  <div className="pane" style={{left:"1232px",top:"160px",width:"664px",height:"282px"}} aria-label="조이스틱">
    <div className="ph"><span className="ttl">조이스틱</span><span style={{marginLeft:"auto",display:"flex",gap:"10px",alignItems:"center"}}><span className="mu2" style={{fontSize:"13px",fontWeight:600}} data-why>앱에 아직 없음</span><span className="sw on lock" role="switch" aria-checked="true" aria-disabled="true" title={NO_SWITCH} /></span></div>
    <div className="row" style={{gap:"20px",alignItems:"center"}}>
      <div style={{flex:1}}>
        <div className="row" style={{gap:"14px",fontSize:"15px",fontWeight:700}}><span className="av2" style={{width:"48px",height:"48px"}}><svg className="ic" viewBox="0 0 24 24" style={{width:"24px",height:"24px"}}><line x1="6" x2="10" y1="11" y2="11" /><line x1="8" x2="8" y1="9" y2="13" /><line x1="15" x2="15.01" y1="12" y2="12" /><line x1="18" x2="18.01" y1="10" y2="10" /><path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z" /></svg></span>왼쪽 스틱 이동 · 오른쪽 스틱 돌기</div>
        <div className="mu2" style={{fontSize:"13.5px",fontWeight:600,marginTop:"12px",lineHeight:1.6}} data-why>조이스틱 입력을 받는 기능이 앱에 아직 없습니다.</div></div><svg viewBox="0 0 220 130" style={{width:"220px",height:"130px"}}><path d="M50 20h120a42 42 0 0 1 42 42v8a40 40 0 0 1-72 24l-6-8H86l-6 8a40 40 0 0 1-72-24v-8a42 42 0 0 1 42-42z" fill="rgba(255,255,255,.05)" stroke="rgba(255,255,255,.3)" strokeWidth="1.6" /><circle cx="62" cy="60" r="20" fill="rgba(0,195,137,.18)" stroke="#00c389" strokeWidth="1.6" /><circle cx="62" cy="60" r="7" fill="#00c389" /><circle cx="152" cy="74" r="16" fill="rgba(255,255,255,.06)" stroke="rgba(255,255,255,.4)" strokeWidth="1.6" /><circle cx="152" cy="74" r="6" fill="rgba(255,255,255,.5)" /></svg></div></div>
  <div className="pane" style={{left:"1232px",top:"467px",width:"664px",height:"282px"}} aria-label="음성">
    <div className="ph"><span className="ttl">음성</span><span style={{marginLeft:"auto",display:"flex",gap:"10px",alignItems:"center"}}><span className="sw on lock" role="switch" aria-checked="true" aria-disabled="true" title={NO_SWITCH} /></span></div>
    <div className="row" style={{gap:"20px",alignItems:"center"}}>
      <div style={{flex:1}}>
        <div className="row" style={{gap:"14px",fontSize:"15px",fontWeight:700}}><span className="av2" style={{width:"48px",height:"48px"}}><svg className="ic" viewBox="0 0 24 24" style={{width:"24px",height:"24px"}}><path d="M12 19v3" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><rect x="9" y="2" width="6" height="13" rx="3" /></svg></span>누르는 동안 듣기</div>
        <div className="mu2" style={{fontSize:"13.5px",fontWeight:600,marginTop:"12px",lineHeight:1.6}} data-why>음성 명령 기능이 앱에 아직 없습니다.</div></div>
      <div className="row" style={{gap:"5px",height:"90px",width:"220px",justifyContent:"center",opacity:.35}} aria-hidden="true"><i style={{width:"7px",height:"14px",borderRadius:"4px",background:"linear-gradient(180deg,#00c389,#00c389)",opacity:0.5277777777777778}} /><i style={{width:"7px",height:"26px",borderRadius:"4px",background:"linear-gradient(180deg,#00c389,#00c389)",opacity:0.5944444444444444}} /><i style={{width:"7px",height:"44px",borderRadius:"4px",background:"linear-gradient(180deg,#00c389,#00c389)",opacity:0.6944444444444444}} /><i style={{width:"7px",height:"66px",borderRadius:"4px",background:"linear-gradient(180deg,#00c389,#00c389)",opacity:0.8166666666666667}} /><i style={{width:"7px",height:"80px",borderRadius:"4px",background:"linear-gradient(180deg,#00c389,#00c389)",opacity:0.8944444444444444}} /><i style={{width:"7px",height:"58px",borderRadius:"4px",background:"linear-gradient(180deg,#00c389,#00c389)",opacity:0.7722222222222223}} /><i style={{width:"7px",height:"36px",borderRadius:"4px",background:"linear-gradient(180deg,#00c389,#00c389)",opacity:0.65}} /><i style={{width:"7px",height:"52px",borderRadius:"4px",background:"linear-gradient(180deg,#00c389,#00c389)",opacity:0.7388888888888889}} /><i style={{width:"7px",height:"72px",borderRadius:"4px",background:"linear-gradient(180deg,#00c389,#00c389)",opacity:0.8500000000000001}} /><i style={{width:"7px",height:"48px",borderRadius:"4px",background:"linear-gradient(180deg,#00c389,#00c389)",opacity:0.7166666666666667}} /><i style={{width:"7px",height:"28px",borderRadius:"4px",background:"linear-gradient(180deg,#00c389,#00c389)",opacity:0.6055555555555556}} /><i style={{width:"7px",height:"40px",borderRadius:"4px",background:"linear-gradient(180deg,#00c389,#00c389)",opacity:0.6722222222222223}} /><i style={{width:"7px",height:"22px",borderRadius:"4px",background:"linear-gradient(180deg,#00c389,#00c389)",opacity:0.5722222222222222}} /><i style={{width:"7px",height:"12px",borderRadius:"4px",background:"linear-gradient(180deg,#00c389,#00c389)",opacity:0.5166666666666667}} /></div></div></div>
  <div className="pane" style={{left:"1232px",top:"774px",width:"664px",height:"282px"}}>
    <div className="ph"><span className="ttl">모바일 (폰 터치)</span><span style={{marginLeft:"auto",display:"flex",gap:"10px",alignItems:"center"}}><span className="sw on lock" role="switch" aria-checked="true" aria-disabled="true" title={NO_SWITCH} /></span></div>
    <div className="row" style={{gap:"20px",alignItems:"center"}}>
      <div style={{flex:1}}>
        <div className="row" style={{gap:"14px",fontSize:"15px",fontWeight:700}}><span className="av2" style={{width:"48px",height:"48px"}}><svg className="ic" viewBox="0 0 24 24" style={{width:"24px",height:"24px"}}><rect width="14" height="20" x="5" y="2" rx="2" ry="2" /><path d="M12 18h.01" /></svg></span>왼쪽 스틱 이동 · 동작 단추</div>
        <div className="mu2" style={{fontSize:"13.5px",fontWeight:600,marginTop:"12px",lineHeight:1.6}}>정지 버튼은 늘 오른쪽 아래에 있습니다.</div></div><svg viewBox="0 0 220 120" style={{width:"220px",height:"120px"}}><rect x="6" y="10" width="208" height="100" rx="18" fill="rgba(255,255,255,.05)" stroke="rgba(255,255,255,.3)" strokeWidth="1.6" /><circle cx="48" cy="76" r="22" fill="rgba(255,255,255,.06)" stroke="rgba(255,255,255,.35)" strokeWidth="1.4" /><circle cx="48" cy="76" r="9" fill="rgba(255,255,255,.7)" /><rect x="166" y="74" width="38" height="28" rx="7" fill="#ff4d4f" /><rect x="166" y="20" width="38" height="46" rx="7" fill="rgba(255,255,255,.08)" stroke="rgba(255,255,255,.25)" /></svg></div></div>
  </>;
}

/** 현장 혼잡 시간(u9_8). 혼잡 시간 · 중복 점검 기준 · 바꾼 기록을 저장하는 서버 값이 없다. 시간 눈금 · 요일 칸만 그리고 막대는 그리지 않는다 */
function Crowd() {
  const [why, setWhy] = useState('');
  return <>
  <div className="hd"><span className="ttl">현장 혼잡 시간</span>
    <p>사람이 많은 시간입니다. 총괄이 정하며 바꾼 기록이 남습니다.</p></div>
  <div className="pane" style={{left:"368px",top:"160px",width:"1528px",height:"620px"}} aria-label="혼잡 시간">
    <div className="ph"><span className="ttl">혼잡 시간</span><span style={{marginLeft:"auto",display:"flex",gap:"10px",alignItems:"center"}}><button type="button" className="btnp sb" aria-disabled="true" onClick={() => setWhy(NO_CROWD)}><svg className="ic" viewBox="0 0 24 24" style={{width:"16px",height:"16px"}}><path d="M5 12h14" /><path d="M12 5v14" /></svg>시간 추가</button></span></div>
    <div style={{position:"relative",height:"22px",marginBottom:"8px"}}><span style={{position:"absolute",left:"48.0px",transform:"translateX(-50%)",fontSize:"12.5px",fontWeight:600,color:"#9aa19d"}}>06:00</span><span style={{position:"absolute",left:"223.0px",transform:"translateX(-50%)",fontSize:"12.5px",fontWeight:600,color:"#9aa19d"}}>08:00</span><span style={{position:"absolute",left:"398.0px",transform:"translateX(-50%)",fontSize:"12.5px",fontWeight:600,color:"#9aa19d"}}>10:00</span><span style={{position:"absolute",left:"573.0px",transform:"translateX(-50%)",fontSize:"12.5px",fontWeight:600,color:"#9aa19d"}}>12:00</span><span style={{position:"absolute",left:"748.0px",transform:"translateX(-50%)",fontSize:"12.5px",fontWeight:600,color:"#9aa19d"}}>14:00</span><span style={{position:"absolute",left:"923.0px",transform:"translateX(-50%)",fontSize:"12.5px",fontWeight:600,color:"#9aa19d"}}>16:00</span><span style={{position:"absolute",left:"1098.0px",transform:"translateX(-50%)",fontSize:"12.5px",fontWeight:600,color:"#9aa19d"}}>18:00</span><span style={{position:"absolute",left:"1273.0px",transform:"translateX(-50%)",fontSize:"12.5px",fontWeight:600,color:"#9aa19d"}}>20:00</span><span style={{position:"absolute",left:"1448.0px",transform:"translateX(-50%)",fontSize:"12.5px",fontWeight:600,color:"#9aa19d"}}>22:00</span></div>
    <div className="row" style={{gap:"20px",marginBottom:"10px"}}><span style={{width:"28px",fontSize:"15px",fontWeight:800}}>월</span>
      <div className="tl2" style={{width:"1400px"}} /></div>
    <div className="row" style={{gap:"20px",marginBottom:"10px"}}><span style={{width:"28px",fontSize:"15px",fontWeight:800}}>화</span>
      <div className="tl2" style={{width:"1400px"}} /></div>
    <div className="row" style={{gap:"20px",marginBottom:"10px"}}><span style={{width:"28px",fontSize:"15px",fontWeight:800}}>수</span>
      <div className="tl2" style={{width:"1400px"}} /></div>
    <div className="row" style={{gap:"20px",marginBottom:"10px"}}><span style={{width:"28px",fontSize:"15px",fontWeight:800}}>목</span>
      <div className="tl2" style={{width:"1400px"}} /></div>
    <div className="row" style={{gap:"20px",marginBottom:"10px"}}><span style={{width:"28px",fontSize:"15px",fontWeight:800}}>금</span>
      <div className="tl2" style={{width:"1400px"}} /></div>
    <div className="row" style={{gap:"20px",marginBottom:"10px"}}><span style={{width:"28px",fontSize:"15px",fontWeight:800}}>토</span>
      <div className="tl2" style={{width:"1400px"}} /></div>
    <div className="row" style={{gap:"20px",marginBottom:"10px"}}><span style={{width:"28px",fontSize:"15px",fontWeight:800}}>일</span>
      <div className="tl2" style={{width:"1400px"}} /></div>
    <p className="mu2" style={{fontSize:"13px",fontWeight:600,marginTop:"10px"}} role={why ? 'alert' : undefined} data-why>{why || `혼잡 시간: ${NO}. 사람이 많은 시간을 저장하는 서버 기능이 아직 없어 막대를 그리지 않습니다.`}</p></div>
  <div className="pane" style={{left:"368px",top:"804px",width:"880px",height:"252px"}}>
    <div className="ph"><span className="ttl">중복 점검 기준</span><span style={{marginLeft:"auto",display:"flex",gap:"10px",alignItems:"center"}} /></div>
    <div className="row" style={{gap:"24px"}}>
      <div className="step" aria-disabled="true"><span>−</span><b style={{fontSize:"15px"}} data-u9-dup>{NO}</b><span>+</span></div>
      <div style={{fontSize:"14.5px",fontWeight:700}}>같은 곳을 이 시간 안에 다시 점검하면 겹친다고 알려 줍니다
        <div className="mu2" style={{fontSize:"13px",fontWeight:600,marginTop:"6px"}} data-why>기준 시간을 저장하는 서버 기능이 아직 없습니다(시안 기본 4 시간).</div></div></div></div>
  <div className="pane" style={{left:"1272px",top:"804px",width:"624px",height:"252px"}}>
    <div className="ph"><span className="ttl">바꾼 기록</span><span style={{marginLeft:"auto",display:"flex",gap:"10px",alignItems:"center"}} /></div>
    <Why>{NO}</Why></div>
  </>;
}

/** 비밀번호 바꾸기 창(u9_2). 성공하면 서버가 모든 세션을 끝내므로 바로 로그인 화면(PW_DONE). 시안 글 「8 자 이상」 을 여기서 지킨다(서버는 1 자부터 받음) */
function PwModal({ close, cancel }: { close: () => void; cancel?: AbortSignal }) {
  const [msg, setMsg] = useState(''), [busy, setBusy] = useState(false), [foc, setFoc] = useState('current'), [bad, setBad] = useState('');
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    const f = new FormData(e.currentTarget), cur = String(f.get('current')), next = String(f.get('next'));
    if (!cur) { setBad('current'); return setMsg('지금 비밀번호를 입력하세요.'); }
    if (next.length < 8) { setBad('next'); return setMsg('새 비밀번호는 8 자 이상이어야 합니다.'); }
    if (next !== String(f.get('again'))) { setBad('again'); return setMsg('새 비밀번호 두 칸이 서로 다릅니다.'); }
    setBusy(true); setMsg(''); setBad('');
    try { await api.password({ current_password: cur, new_password: next }, cancel); expireAuth(PW_DONE); }
    catch (err) { setMsg((err as ApiFail).message); setBusy(false); }
  };
  const inp = (name: string, ac: string) => <div className={`inp ${foc === name ? 'foc' : ''}${bad === name ? ' bad' : ''}`}><input className="dots" name={name} type="password" autoComplete={ac} maxLength={1024} autoFocus={name === 'current'} onFocus={() => setFoc(name)} onBlur={() => setFoc('')} /></div>;
  return <>
  <div className="scrim" onClick={close} />
  <form className="g modal" style={{width:"560px"}} role="dialog" aria-modal="true" aria-label="비밀번호 바꾸기" onSubmit={submit} onKeyDown={(e) => { if (e.key === 'Escape') close(); }} noValidate>
    <div className="row" style={{justifyContent:"space-between"}}><span className="ttl">비밀번호 바꾸기</span><button type="button" id="go-x" aria-label="닫기" onClick={close}><svg className="ic" viewBox="0 0 24 24" style={{width:"22px",height:"22px"}}><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg></button></div>
    <div style={{display:"flex",flexDirection:"column",gap:"16px",marginTop:"22px"}}>
      <label>
        <div className="lab">지금 비밀번호</div>
        {inp('current', 'current-password')}</label>
      <label>
        <div className="lab">새 비밀번호</div>
        {inp('next', 'new-password')}</label>
      <label>
        <div className="lab">새 비밀번호 다시</div>
        {inp('again', 'new-password')}</label></div>
    {msg ? <p role="alert" style={{fontSize:"13px",color:"#b8361f",fontWeight:700,marginTop:"14px",lineHeight:1.6}}>{msg}</p>
    : <p style={{fontSize:"13px",color:"#5e6662",fontWeight:600,marginTop:"14px",lineHeight:1.6}}>8 자 이상 입력하세요. 스페이스는 정지 키라서 쓸 수 없습니다.<br />바꾸면 모든 기기에서 로그아웃됩니다. 새 비밀번호로 다시 들어오세요.</p>}
    <div style={{display:"flex",gap:"10px",marginTop:"22px"}}>
      <button type="button" className="mbtn sec" style={{flex:1}} id="go-cancel" onClick={close}>취소</button>
      <button type="submit" className="btnp mbtn" style={{flex:1}} id="go-change" disabled={busy}>바꾸기</button></div></form>
  </>;
}
