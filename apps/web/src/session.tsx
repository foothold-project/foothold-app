// 로그인·세션(05 API §2). 열 때 GET /auth/session 으로 CSRF 를 다시 받아 세션을 잇고, 401 이면 로그인 화면.
// 로그인되면 역할은 /me, 로봇 목록은 /robots?scope=all(운영 관리자도 전체 — 남의 로봇은 보기 전용, 02 §1.1) → App.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { User as ApiUser } from '../../contracts/ts';
import { App } from './App';
import { BrandLogo } from './BrandLogo';
import { api, onAuthLost, type ApiFail } from './api';
import { clearServerData, setServerData, toRobot, type Robot, type User } from './fake';
import { now } from './rt';

/** 무엇이 서버 값이고 무엇이 가짜인지(개발용 표시) — 영상·지도·임무가 서버에서 오면 지운다 */
export const DEV_NOTE = '개발용 표시: 계정·로봇 목록·관제 요약·로봇 등록·조직 기준값·기록·알림과 로봇 연결·상태·배터리·장치·조종권·잠금·STOP 은 서버 값입니다. 영상·지도·층·임무·결재는 아직 가짜입니다.';
const ENDED = '로그인이 끝났습니다. 다시 로그인하세요.';
/** 운영 관리자가 구독하지 못하는 남의 로봇 요약(조종권자 등)을 다시 받는 간격 */
export const LIST_MS = 10_000;

const toUser = (u: ApiUser): User => ({ id: u.id, name: u.display_name, role: u.role });

/** cancel = 이 로그인 세션에 묶인 취소 신호(화면 요청에 넘김) — 세션이 끝나면 거둬, 늦게 온 답(앞 세션의 401 등)이 다음 세션의 인증을 건드리지 않게.
 *  fresh = 지금 robots 를 요청한 시각(now()) — 더 늦게 요청한 목록만 덮어쓴다 */
type State = { at: 'wait' } | { at: 'login'; note?: string } | { at: 'app'; user: User; robots: Robot[]; fresh: number; n: number; cancel: AbortSignal; note?: string };

export function Root() {
  const [st, setSt] = useState<State>({ at: 'wait' });
  const live = useRef<AbortController | null>(null);   // 지금 로그인 세션의 취소 신호
  const toLogin = (note?: string) => { live.current?.abort(); live.current = null; setSt({ at: 'login', note }); };
  // 로그인 화면이 되면(로그아웃·401·세션 없음) 이전 사용자·로봇을 비운다. 실시간 연결·조종권은 App 이 내려가며 돌려주고 닫는다.
  // 조직 기준값은 설정 화면 상태라 App 이 내려가며 같이 사라진다
  useEffect(() => { if (st.at === 'login') clearServerData(); }, [st.at]);
  const enter = async () => {
    const me = toUser(await api.me());
    const fresh = now(), robots = (await api.robots('all')).map(toRobot);
    setServerData(me, robots);
    live.current?.abort();
    const g = live.current = new AbortController();
    setSt((s) => ({ at: 'app', user: me, robots, fresh, n: (s.at === 'app' ? s.n : 0) + 1, cancel: g.signal }));
  };
  /** 목록 다시 받기 — 이 로그인 세션(사용자·n)에 묶는다: 세션이 바뀌었거나 더 늦게 요청한 목록이 이미 왔으면 버린다 */
  const reload = (session: string, cancel: AbortSignal) => {
    const fresh = now();
    return api.robots('all', cancel).then((rs) => {
      const robots = rs.map(toRobot);
      setSt((s) => {
        if (s.at !== 'app' || `${s.user.id}-${s.n}` !== session || fresh <= s.fresh) return s;
        setServerData(s.user, robots);
        return { ...s, robots, fresh };
      });
    });
  };
  // 남의 로봇은 실시간 구독이 안 돼(서버가 4403) 목록 요약을 주기적으로 다시 받는다. 실패하면 이전 값 + 받은 시각 그대로(401 은 로그인 화면).
  // 갱신은 이 로그인 세션(사용자·n)에 묶는다: 세션이 바뀌면 진행 중인 요청을 거두고 늦은 답은 버린다. 앞 요청이 안 끝났으면 다음은 건너뜀
  const session = st.at === 'app' && st.user.role !== 'ORG_ADMIN' ? `${st.user.id}-${st.n}` : '';
  useEffect(() => {
    if (!session) return;
    const gone = new AbortController();
    let busy = false;
    const i = setInterval(() => {
      if (busy) return;
      busy = true;
      reload(session, gone.signal).catch(() => {}).finally(() => { busy = false; });
    }, LIST_MS);
    return () => { clearInterval(i); gone.abort(); };
  }, [session]);
  useEffect(() => {
    onAuthLost((why) => toLogin(why ?? ENDED));
    api.session().then(enter).catch((e: ApiFail) => toLogin(e.status === 401 ? undefined : e.message));
  }, []);
  const logout = () => api.logout().then(() => toLogin(),
    (e: ApiFail) => (e.status === 401 ? toLogin() : setSt((s) => (s.at === 'app' ? { ...s, note: `로그아웃하지 못했습니다. ${e.message}` } : s))));

  if (st.at === 'wait') return <div className="fh"><p className="lv-note" style={{ padding: 16 }} role="status">불러오는 중…</p></div>;
  if (st.at === 'login') return <Login note={st.note} enter={enter} />;
  // 내 이름이 바뀌면(설정 탭) 머리줄·이름 찾기도 새 값으로 — 같은 사용자라 App 은 그대로
  const setMe = (u: ApiUser) => setSt((s) => { if (s.at !== 'app' || s.user.id !== u.id) return s; const user = toUser(u); setServerData(user, s.robots); return { ...s, user }; });
  // 로봇을 등록·바꿈·지움, 구독 회수 → 바로 목록 다시 받기(실패하면 이전 목록 그대로, 401 은 로그인 화면)
  const refresh = () => { reload(`${st.user.id}-${st.n}`, st.cancel).catch(() => {}); };
  return <App key={`${st.user.id}-${st.n}`} user={st.user} robots={st.robots} fresh={st.fresh} refresh={refresh} logout={logout} setMe={setMe} cancel={st.cancel} note={st.note} dev={DEV_NOTE} />;
}

function Login({ note, enter }: { note?: string; enter: () => Promise<void> }) {
  const [msg, setMsg] = useState(note), [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    const f = new FormData(e.currentTarget), id = String(f.get('username')).trim(), pw = String(f.get('password'));
    if (!id || !pw) return setMsg('계정과 비밀번호를 입력하세요.');
    setBusy(true); setMsg(undefined);
    try { await api.login(id, pw); await enter(); }
    catch (err) { setMsg((err as ApiFail).message); setBusy(false); }
  };
  return <div className="fh"><main className="fh-login" aria-label="로그인">
    <form onSubmit={submit} noValidate>
      <BrandLogo kind="primary" h={40} />
      <div className="fh-field"><h2>로그인</h2><span className="lbl">현장 서버에 연결해 로봇을 보고 조종합니다</span></div>
      <label className="fh-field"><span className="lbl">계정</span><input className="inp" name="username" autoComplete="username" autoFocus /></label>
      <label className="fh-field"><span className="lbl">비밀번호</span><input className="inp" name="password" type="password" autoComplete="current-password" /></label>
      {msg && <p className="fh-msg" role="alert">{msg}</p>}
      <button type="submit" className="btn pri" disabled={busy}>{busy ? '로그인 중…' : '로그인'}</button>
      <span className="lbl">5분 안에 5번 틀리면 잠시 로그인할 수 없습니다.</span>
    </form>
  </main></div>;
}
