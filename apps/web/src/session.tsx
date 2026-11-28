// 로그인·세션(05 API §2). 열 때 GET /auth/session 으로 CSRF 를 다시 받아 세션을 잇고, 401 이면 로그인 화면.
// 로그인되면 역할은 /me, 로봇 목록은 /robots?scope=<listScope>(운영 관리자는 내게 배정된 로봇만, 총괄은 전체 — ADR-003 결정 2) → App.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { User as ApiUser } from '../../contracts/ts';
import { App } from './App';
import { api, onAuthLost, type ApiFail } from './api';
import { clearServerData, listScope, setServerData, toRobots, type Robot, type User } from './fake';
import { now } from './rt';
import { kept } from './screens/mapedit';
import { clearPlans } from './screens/missions';
import { useTheme } from './theme';

const ENDED = '로그인이 끝났습니다. 다시 로그인하세요.';
/** 운영 관리자의 로봇 목록(새로 배정된 로봇·목록 요약)을 다시 받는 간격 */
export const LIST_MS = 10_000;

const toUser = (u: ApiUser): User => ({ id: u.id, name: u.display_name, role: u.role });

/** cancel = 이 로그인 세션에 묶인 취소 신호(화면 요청에 넘김) — 세션이 끝나면 거둬, 늦게 온 답(앞 세션의 401 등)이 다음 세션의 인증을 건드리지 않게.
 *  fresh = 지금 robots 를 요청한 시각(now()) — 더 늦게 요청한 목록만 덮어쓴다. stale = 마지막 다시 받기가 실패(다시 성공하면 거둠 — 폰 홈 STOP 숨김을 막는다) */
type State = { at: 'wait' } | { at: 'login'; note?: string } | { at: 'app'; user: User; robots: Robot[]; fresh: number; n: number; cancel: AbortSignal; note?: string; stale?: boolean };

export function Root() {
  const [st, setSt] = useState<State>({ at: 'wait' }), fh = useTheme()[1] ? 'fh light' : 'fh';   // 로그인 전 화면도 고른 테마
  const live = useRef<AbortController | null>(null);   // 지금 로그인 세션의 취소 신호
  const toLogin = (note?: string) => { live.current?.abort(); live.current = null; setSt({ at: 'login', note }); };
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
    api.session().then(enter).catch((e: ApiFail) => toLogin(e.status === 401 ? undefined : e.message));
  }, []);
  const logout = () => api.logout().then(() => toLogin(),
    (e: ApiFail) => (e.status === 401 ? toLogin() : setSt((s) => (s.at === 'app' ? { ...s, note: `로그아웃하지 못했습니다. ${e.message}` } : s))));

  if (st.at === 'wait') return <div className={fh}><p className="lv-note" style={{ padding: 16 }} role="status">불러오는 중…</p></div>;
  if (st.at === 'login') return <Login note={st.note} enter={enter} />;
  // 내 이름이 바뀌면(설정 탭) 머리줄·이름 찾기도 새 값으로 — 같은 사용자라 App 은 그대로
  const setMe = (u: ApiUser) => setSt((s) => { if (s.at !== 'app' || s.user.id !== u.id) return s; const user = toUser(u); setServerData(user, s.robots); return { ...s, user }; });
  // 로봇을 등록·바꿈·지움, 구독 회수 → 바로 목록 다시 받기(실패하면 이전 목록 그대로, 401 은 로그인 화면)
  const refresh = () => { reload(st.user, `${st.user.id}-${st.n}`, st.cancel).catch(() => {}); };
  return <App key={`${st.user.id}-${st.n}`} user={st.user} robots={st.robots} fresh={st.fresh} refresh={refresh} stale={st.stale} logout={logout} setMe={setMe} cancel={st.cancel} note={st.note} />;
}

/** 시안 로그인 (proto u10_1 · u10_3 오류 한 줄 · u10_2 비밀번호 바꾸기 창 · u10_4 바뀜). 로그인 흐름 · 서버 문구는 그대로 */
function Login({ note, enter }: { note?: string; enter: () => Promise<void> }) {
  const [msg, setMsg] = useState(note), [busy, setBusy] = useState(false), [show, setShow] = useState(false);
  const [bad, setBad] = useState(false), [pwOpen, setPwOpen] = useState(false), [done, setDone] = useState(false), fh = useTheme()[1] ? 'fh light' : 'fh';
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    const f = new FormData(e.currentTarget), id = String(f.get('username')).trim(), pw = String(f.get('password'));
    if (!id || !pw) { setBad(!pw); return setMsg('아이디와 비밀번호를 입력하세요.'); }
    setBusy(true); setMsg(undefined); setBad(false); setDone(false);
    try { await api.login(id, pw); await enter(); }
    catch (err) { setMsg((err as ApiFail).message); setBad(true); setBusy(false); }
  };
  return <div className={`${fh} lg`}><div className="lg-bg" aria-hidden="true" /><main className="fh-login" aria-label="로그인">
    <form className="lg-card" onSubmit={submit} noValidate>
      <div className="lg-logo">FOOTHOLD</div>
      <h2>로그인</h2>
      <p className="lg-sub">총괄 · 운영자 계정으로 로그인합니다</p>
      <div className="lg-slot">
        {msg && <p className="lg-line lg-err" role="alert"><Warn />{msg}</p>}
        {!msg && done && <p className="lg-line lg-ok" role="status">비밀번호를 바꿨습니다. 새 비밀번호로 로그인하세요.</p>}
      </div>
      <div className="lg-fields">
        <label><span className="lg-lab">아이디</span><input className="lg-inp" name="username" autoComplete="username" autoFocus /></label>
        <label><span className="lg-lab">비밀번호</span><span className={`lg-inp lg-pw${bad ? ' bad' : ''}`}>
          <input name="password" type={show ? 'text' : 'password'} autoComplete="current-password" aria-invalid={bad || undefined} />
          <button type="button" className="lg-eye" aria-label={show ? '비밀번호 숨기기' : '비밀번호 보기'} onClick={() => setShow((v) => !v)}><Eye /></button>
        </span></label>
      </div>
      <button type="submit" className="btnp lg-go" disabled={busy}>{busy ? '로그인 중…' : '로그인'}</button>
      <div className="lg-foot">
        <button type="button" className="lg-link" onClick={() => setPwOpen(true)}><Key />비밀번호 바꾸기</button>
        <span>계정은 총괄에게 요청하세요</span>
      </div>
      <span className="lg-note">5분 안에 5번 틀리면 잠시 로그인할 수 없습니다.</span>
    </form>
  </main>
  {pwOpen && <ChangePw close={() => setPwOpen(false)} changed={() => { setPwOpen(false); setMsg(undefined); setBad(false); setDone(true); }} />}
  </div>;
}

/** 로그인 전 비밀번호 바꾸기: 지금 비밀번호로 로그인 → POST /me/password → 로그아웃. 앱 화면으로 들어가지 않는다 */
function ChangePw({ close, changed }: { close: () => void; changed: () => void }) {
  const [msg, setMsg] = useState<string>(), [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    const f = new FormData(e.currentTarget), id = String(f.get('cp-id')).trim(), cur = String(f.get('cp-cur')), n1 = String(f.get('cp-new')), n2 = String(f.get('cp-new2'));
    if (!id || !cur) return setMsg('아이디와 지금 비밀번호를 입력하세요.');
    if (n1.length < 8) return setMsg('새 비밀번호는 8 자 이상 입력하세요.');
    if (/\s/.test(n1)) return setMsg('스페이스는 정지 키라서 비밀번호에 쓸 수 없습니다.');
    if (n1 !== n2) return setMsg('새 비밀번호 두 칸이 같지 않습니다.');
    setBusy(true); setMsg(undefined);
    let inside = false;
    try {
      await api.login(id, cur); inside = true;
      await api.password({ current_password: cur, new_password: n1 });
      await api.logout().catch(() => {}); inside = false;
      changed();
    } catch (err) {
      if (inside) await api.logout().catch(() => {});
      setMsg((err as ApiFail).message); setBusy(false);
    }
  };
  return <div className="lg-scrim"><form className="lg-modal" role="dialog" aria-modal="true" aria-label="비밀번호 바꾸기" onSubmit={submit} noValidate>
    <div className="lg-mhead"><span className="lg-ttl">비밀번호 바꾸기</span><button type="button" className="lg-x" aria-label="닫기" onClick={close}><X /></button></div>
    <div className="lg-fields">
      <label><span className="lg-lab">아이디</span><input className="lg-inp" name="cp-id" autoComplete="username" autoFocus /></label>
      <label><span className="lg-lab">지금 비밀번호</span><input className="lg-inp" name="cp-cur" type="password" autoComplete="current-password" /></label>
      <label><span className="lg-lab">새 비밀번호</span><input className="lg-inp" name="cp-new" type="password" autoComplete="new-password" /></label>
      <label><span className="lg-lab">새 비밀번호 다시</span><input className="lg-inp" name="cp-new2" type="password" autoComplete="new-password" /></label>
    </div>
    <p className="lg-help">8 자 이상 입력하세요. 스페이스는 정지 키라서 쓸 수 없습니다.<br />임시 비밀번호를 받았다면 「지금 비밀번호」 칸에 입력하세요.</p>
    {msg && <p className="lg-line lg-err" role="alert"><Warn />{msg}</p>}
    <div className="lg-mbtns"><button type="button" className="lg-mbtn" onClick={close}>취소</button><button type="submit" className="btnp lg-mbtn" disabled={busy}>{busy ? '바꾸는 중…' : '바꾸기'}</button></div>
  </form></div>;
}

const Ic = ({ d, s = 18 }: { d: string[]; s?: number }) => <svg className="lg-ic" viewBox="0 0 24 24" width={s} height={s} aria-hidden="true">{d.map((x) => <path key={x} d={x} />)}</svg>;
const Warn = () => <Ic d={['m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3', 'M12 9v4', 'M12 17h.01']} />;
const Eye = () => <Ic d={['M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0', 'M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0']} />;
const Key = () => <Ic s={16} d={['M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z', 'M16.5 7.5h.01']} />;
const X = () => <Ic s={22} d={['M18 6 6 18', 'm6 6 12 12']} />;
