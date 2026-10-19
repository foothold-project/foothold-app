// 로그인·세션(05 API §2). 열 때 GET /auth/session 으로 CSRF 를 다시 받아 세션을 잇고, 401 이면 로그인 화면.
// 로그인되면 역할은 /me, 로봇 목록은 /robots?scope=all(운영 관리자도 전체 — 남의 로봇은 보기 전용, 02 §1.1) → App.
import { useEffect, useState, type FormEvent } from 'react';
import type { RobotSummary, User as ApiUser } from '../../contracts/ts';
import { App } from './App';
import { BrandLogo } from './BrandLogo';
import { api, onAuthLost, type ApiFail } from './api';
import { clearServerData, setServerData, type Robot, type User } from './fake';
import { resetDrive } from './fakeDrive';

/** 무엇이 서버 값이고 무엇이 가짜인지(개발용 표시) — 실시간 연결이 붙으면 지운다 */
export const DEV_NOTE = '개발용 표시: 계정·역할·로봇 목록·조직 기준값은 서버 값입니다. 로봇 상태·영상·조종·임무·결재·기록·지도는 실시간 연결 전이라 가짜입니다.';
const ENDED = '로그인이 끝났습니다. 다시 로그인하세요.';

const toUser = (u: ApiUser): User => ({ id: u.id, name: u.display_name, role: u.role });
const clock = (at?: string) => (at ? new Date(at).toLocaleTimeString('ko-KR', { hour12: false }) : '');
export const toRobot = (r: RobotSummary): Robot => ({
  id: r.id, name: r.name, owner: r.owner?.id ?? '', ownerName: r.owner?.display_name, floor: r.location?.floor_id ?? '',
  battery: r.battery?.soc ?? null, online: r.connection === 'ONLINE', seenAt: clock(r.location?.updated_at ?? r.battery?.updated_at), status: r.status,
  mission: r.current_run ? `${r.current_run.scenario_name} ${r.current_run.progress.done}/${r.current_run.progress.total}` : undefined,
});

type State = { at: 'wait' } | { at: 'login'; note?: string } | { at: 'app'; user: User; robots: Robot[]; n: number; note?: string };

export function Root() {
  const [st, setSt] = useState<State>({ at: 'wait' });
  const toLogin = (note?: string) => setSt({ at: 'login', note });
  // 로그인 화면이 되면(로그아웃·401·세션 없음) 이전 사용자·로봇·가짜 조종 상태를 비운다. 효과에서 하는 까닭: 내려간
  // App(조종 화면)의 정리 효과가 먼저 돌아 쓰던 중재기에 조종권을 돌려준 뒤에 갈아 끼워야 한다(PR #9 R2-B1).
  // 조직 기준값은 설정 화면 상태라 App 이 내려가며 같이 사라진다
  useEffect(() => { if (st.at === 'login') { clearServerData(); resetDrive(); } }, [st.at]);
  const enter = async () => {
    const me = toUser(await api.me());
    const robots = (await api.robots('all')).map(toRobot);
    setServerData(me, robots);
    resetDrive();   // 가짜 조종 중재기를 서버 로봇 목록으로 새로(조종권·잠금 규칙은 그대로)
    setSt((s) => ({ at: 'app', user: me, robots, n: (s.at === 'app' ? s.n : 0) + 1 }));
  };
  useEffect(() => {
    onAuthLost(() => toLogin(ENDED));
    api.session().then(enter).catch((e: ApiFail) => toLogin(e.status === 401 ? undefined : e.message));
  }, []);
  const logout = () => api.logout().then(() => toLogin(),
    (e: ApiFail) => (e.status === 401 ? toLogin() : setSt((s) => (s.at === 'app' ? { ...s, note: `로그아웃하지 못했습니다. ${e.message}` } : s))));

  if (st.at === 'wait') return <div className="fh"><p className="lv-note" style={{ padding: 16 }} role="status">불러오는 중…</p></div>;
  if (st.at === 'login') return <Login note={st.note} enter={enter} />;
  return <App key={`${st.user.id}-${st.n}`} user={st.user} robots={st.robots} logout={logout} note={st.note} dev={DEV_NOTE} />;
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
