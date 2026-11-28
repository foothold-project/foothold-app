// 로그인·세션(05 API §2). 열 때 GET /auth/session 으로 CSRF 를 다시 받아 세션을 잇고, 401 이면 로그인 화면.
// 로그인되면 역할은 /me, 로봇 목록은 /robots?scope=<listScope>(운영 관리자는 내게 배정된 로봇만, 총괄은 전체 — ADR-003 결정 2) → App.
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { User as ApiUser } from '../../contracts/ts';
import { App, STAGE_H, STAGE_W, usePhone, useStage } from './App';
import './login.css';
import { api, onAuthLost, type ApiFail } from './api';
import { clearServerData, listScope, setServerData, toRobots, type Robot, type User } from './fake';
import { now } from './rt';
import { kept } from './screens/mapedit';
import { clearPlans } from './screens/missions';
import { useTheme } from './theme';
import { LoginFields, LoginFoot, PW_DONE, type LoginBad } from './loginform';

const ENDED = '로그인이 끝났습니다. 다시 로그인하세요.';
/** 운영 관리자의 로봇 목록(새로 배정된 로봇·목록 요약)을 다시 받는 간격 */
export const LIST_MS = 10_000;

const toUser = (u: ApiUser): User => ({ id: u.id, name: u.display_name, role: u.role });

/** cancel = 이 로그인 세션에 묶인 취소 신호(화면 요청에 넘김) — 세션이 끝나면 거둬, 늦게 온 답(앞 세션의 401 등)이 다음 세션의 인증을 건드리지 않게.
 *  fresh = 지금 robots 를 요청한 시각(now()) — 더 늦게 요청한 목록만 덮어쓴다. stale = 마지막 다시 받기가 실패(다시 성공하면 거둠 — 폰 홈 STOP 숨김을 막는다) */
type State = { at: 'wait' } | { at: 'login'; note?: string } | { at: 'app'; user: User; robots: Robot[]; fresh: number; n: number; cancel: AbortSignal; note?: string; stale?: boolean };

export function Root() {
  const [st, setSt] = useState<State>({ at: 'wait' });   // 로그인 전 화면(Wait · Login)도 고른 테마를 각자 읽는다
  const live = useRef<AbortController | null>(null);   // 지금 로그인 세션의 취소 신호
  const [failed, setFailed] = useState(false);   // 로그인 화면의 글이 안내(세션 끝남)가 아니라 실패(서버 연결 · 500)인가
  const toLogin = (note?: string, fail = false) => { live.current?.abort(); live.current = null; setSt({ at: 'login', note }); setFailed(fail); };
  // 로그인 화면이 되면(로그아웃·401·세션 없음) 이전 사용자·로봇을 비운다. 실시간 연결·조종권은 App 이 내려가며 돌려주고 닫는다.
  // 조직 기준값은 설정 화면 상태라 App 이 내려가며 같이 사라진다
  useEffect(() => { if (st.at === 'login') { clearServerData(); kept.d = null; kept.job = null; clearPlans(); } }, [st.at]);   // 남겨 둔 지도·임무 편집·저장 요청도
  const enter = async () => {
    const me = toUser(await api.me());
    const fresh = now(), robots = toRobots(await api.robots(listScope(me)));
    setServerData(me, robots);
    live.current?.abort();
    const g = live.current = new AbortController();
    setSt((s) => ({ at: 'app', user: me, robots, fresh, n: (s.at === 'app' ? s.n : 0) + 1, cancel: g.signal }));
  };
  /** 목록 다시 받기 — 이 로그인 세션(사용자·n)에 묶는다: 세션이 바뀌었거나 더 늦게 요청한 목록이 이미 왔으면 버린다 */
  const reload = (user: User, session: string, cancel: AbortSignal) => {
    const fresh = now();
    return api.robots(listScope(user), cancel).then((rs) => {
      const robots = toRobots(rs);
      setSt((s) => {
        if (s.at !== 'app' || `${s.user.id}-${s.n}` !== session || fresh <= s.fresh) return s;
        setServerData(s.user, robots);
        return { ...s, robots, fresh, stale: false };
      });
    }, (e) => {
      setSt((s) => (s.at !== 'app' || `${s.user.id}-${s.n}` !== session || fresh <= s.fresh ? s : { ...s, stale: true }));
      throw e;
    });
  };
  // 운영 관리자는 새로 배정된 로봇을 실시간으로 알 수 없어 목록을 주기적으로 다시 받는다. 실패하면 이전 값 + 받은 시각 그대로(401 은 로그인 화면).
  // 갱신은 이 로그인 세션(사용자·n)에 묶는다: 세션이 바뀌면 진행 중인 요청을 거두고 늦은 답은 버린다. 앞 요청이 안 끝났으면 다음은 건너뜀
  const session = st.at === 'app' && st.user.role !== 'ORG_ADMIN' ? `${st.user.id}-${st.n}` : '';
  useEffect(() => {
    const user = st.at === 'app' ? st.user : null;
    if (!session || !user) return;
    const gone = new AbortController();
    let busy = false;
    const i = setInterval(() => {
      if (busy) return;
      busy = true;
      reload(user, session, gone.signal).catch(() => {}).finally(() => { busy = false; });
    }, LIST_MS);
    return () => { clearInterval(i); gone.abort(); };
  }, [session]);
  useEffect(() => {
    onAuthLost((why) => toLogin(why ?? ENDED));
    api.session().then(enter).catch((e: ApiFail) => toLogin(e.status === 401 ? undefined : e.message, e.status !== 401));   // 401 밖(연결 실패 · 500)은 오류 띠
  }, []);
  const logout = () => api.logout().then(() => toLogin(),
    (e: ApiFail) => (e.status === 401 ? toLogin() : setSt((s) => (s.at === 'app' ? { ...s, note: `로그아웃하지 못했습니다. ${e.message}` } : s))));

  if (st.at === 'wait') return <Wait />;
  if (st.at === 'login') return <Login note={st.note} failed={failed} enter={enter} />;
  // 내 이름이 바뀌면(설정 탭) 머리줄·이름 찾기도 새 값으로 — 같은 사용자라 App 은 그대로
  const setMe = (u: ApiUser) => setSt((s) => { if (s.at !== 'app' || s.user.id !== u.id) return s; const user = toUser(u); setServerData(user, s.robots); return { ...s, user }; });
  // 로봇을 등록·바꿈·지움, 구독 회수 → 바로 목록 다시 받기(실패하면 이전 목록 그대로, 401 은 로그인 화면)
  const refresh = () => { reload(st.user, `${st.user.id}-${st.n}`, st.cancel).catch(() => {}); };
  return <App key={`${st.user.id}-${st.n}`} user={st.user} robots={st.robots} fresh={st.fresh} refresh={refresh} stale={st.stale} logout={logout} setMe={setMe} cancel={st.cancel} note={st.note} />;
}

function Login({ note, failed, enter }: { note?: string; failed?: boolean; enter: () => Promise<void> }) {
  const [msg, setMsg] = useState(note), [busy, setBusy] = useState(false), [changed, setChanged] = useState(false), fh = useTheme()[1] ? 'fh light' : 'fh', [bad, setBad] = useState<LoginBad>(null), [tick, setTick] = useState(0);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    const f = new FormData(e.currentTarget), id = String(f.get('username')).trim(), pw = String(f.get('password'));
    setTick((n) => n + 1);
    if (!id || !pw) { setBad(!id ? 'username' : 'password'); return setMsg('계정과 비밀번호를 입력하세요.'); }
    setBusy(true); setMsg(undefined); setBad(null); setChanged(false);
    try { await api.login(id, pw); await enter(); }
    catch (err) { setBad((err as ApiFail).status === 401 ? 'both' : null); setMsg((err as ApiFail).message); setBusy(false); }   // 서버 401 은 계정 · 비밀번호를 가르지 않는다(api.py login)
  };
  // 시안 로그인 카드(u10_1 · u10_3): 유리 카드 · FOOTHOLD 글자 · 제목 · 「총괄 · 운영자 계정으로 로그인합니다」. 칸 · 오류 · 비밀번호 바꾸기 안내는 loginform 그대로
  return <LgStage fh={fh} label="로그인">
    <form className="lg-card" onSubmit={submit} noValidate>
      <div className="lg-logo">FOOTHOLD</div>
      <h2>로그인</h2>
      <p className="lg-sub">총괄 · 운영자 계정으로 로그인합니다</p>
      <div className="lg-fields">{changed && !msg && <p className="lg-ok" role="status" data-pw-changed><svg className="ic" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10" /><path d="m9 12 2 2 4-4" /></svg>{PW_DONE}</p>}
        <LoginFields msg={msg} bad={bad} tick={tick} busy={busy} note={tick === 0 && !failed} /></div>
      <LoginFoot done={() => { setMsg(undefined); setBad(null); setChanged(true); }} />
      <span className="lg-note">5분 안에 5번 틀리면 잠시 로그인할 수 없습니다.</span>
    </form>
  </LgStage>;
}

/** 로그인 무대(시안 u10_1 바탕 · 카드 자리). PC = 1920 × 1080 을 창에 맞춤(팀장 «어떤 모니터도 fit» · 앱 틀과 같은 useStage). 폰은 기존 흐름 그대로 */
function LgStage({ fh, label, children }: { fh: string; label: string; children: ReactNode }) {
  const phone = usePhone(), stage = useStage();
  const page = <div className={`${fh} lg`} data-scale={phone ? undefined : stage.s.toFixed(4)}
    style={phone ? undefined : { position: 'absolute', left: 0, top: 0, width: STAGE_W, height: STAGE_H, minHeight: 0, transformOrigin: '0 0', transform: `translate(${stage.x}px,${stage.y}px) scale(${stage.s})` }}>
    <div className="lg-bg" aria-hidden="true" /><main className="fh-login" aria-label={label}>{children}</main></div>;
  return phone ? page : <div className="fit" data-fit style={{ position: 'fixed', inset: 0, overflow: 'hidden', background: fh.includes('light') ? '#F6F7F6' : '#000000' }}>{page}</div>;
}

/** 첫 확인(세션 · 로봇 목록 받는 중) = 시안 밖 · 새로 그림: 로그인과 같은 바탕 · 같은 카드 자리에 FOOTHOLD 글자 · 「불러오는 중…」 · 시안 u11 .tbar 결 진행 줄 */
function Wait() {
  const fh = useTheme()[1] ? 'fh light' : 'fh';
  return <LgStage fh={fh} label="불러오는 중">
    <div className="lg-card" data-wait><div className="lg-logo">FOOTHOLD</div>
      <p className="lg-sub" role="status" style={{ marginTop: 26 }}>불러오는 중…</p>
      <div className="lg-wait" aria-hidden="true"><i /></div></div>
  </LgStage>;
}
