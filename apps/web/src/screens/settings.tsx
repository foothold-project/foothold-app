// 설정 탭(02 F-ST-01·02, 03 UX §5) — 개인 설정·내 정보·조직 기준값(서버 값). 계정 관리(05 §2 /users)·로봇 등록(05 §3)은 총괄에게만 보인다(01 AU-04: 권한 없는 기능은 숨김).
import { useEffect, useState, type FormEvent } from 'react';
import type { OrgSettings, RobotSummary, Session, User as ApiUser } from '../../../contracts/ts';
import { api, expireAuth, type ApiFail } from '../api';
import { ROLE_NAME, type Role, type User } from '../fake';
import { Chip, type Ctx } from '../screens';

type Msg = { text: string; ok?: boolean } | null;
/** 긴 이름·아이디(128자)는 칸 안에서 줄을 바꾼다 */
const WRAP = { minWidth: 0, overflowWrap: 'anywhere' } as const;
const Note = ({ msg }: { msg: Msg }) => (msg ? <p style={WRAP} className={`fh-msg${msg.ok ? ' ok' : ''}`} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p> : null);

/** 로봇이 0대여도 열리는 탭이라 Ctx 전체가 아니라 필요한 것만 받는다 */
export function Settings(c: Pick<Ctx, 'user' | 'light' | 'setLight' | 'setMe' | 'refresh' | 'cancel'>) {
  const admin = c.user.role === 'ORG_ADMIN';
  return <>
    <section className="lv-card" aria-label="개인 설정">
      <h2>개인 설정</h2>
      <div className="fh-row"><span>화면 밝기</span><button type="button" className="btn" aria-pressed={c.light} onClick={() => c.setLight(!c.light)}>{c.light ? '밝게' : '어둡게'}</button></div>
    </section>
    <MyInfo user={c.user} setMe={c.setMe} cancel={c.cancel} />
    <OrgLimits admin={admin} cancel={c.cancel} />
    {admin && <Accounts me={c.user} cancel={c.cancel} />}
    {admin && <Robots refresh={c.refresh} cancel={c.cancel} />}
  </>;
}

/** 조직 기준값(05 API §8 GET·PATCH /org/settings). 범위는 계약(apps/contracts/models.py OrgSettingsPatch)과 같게 — 검사는 서버가 한다 */
const LIMITS: { key: keyof OrgSettings; label: string; unit: string; min: number; max: number; step: number }[] = [
  { key: 'battery_low_pct', label: '배터리 부족 기준', unit: '%', min: 5, max: 50, step: 1 },
  { key: 'run_min_battery_pct', label: '실행 시작 최소 배터리', unit: '%', min: 10, max: 90, step: 1 },
  { key: 'deviation_m', label: '경로 이탈 거리', unit: 'm', min: 0.5, max: 5, step: 0.1 },
  { key: 'lease_request_timeout_s', label: '조종권 요청 응답 시간', unit: '초', min: 5, max: 30, step: 1 },
  { key: 'link_loss_wait_s', label: '연결 끊김 대기 시간', unit: '초', min: 0, max: 30, step: 1 },
];
/** 화면 요청은 모두 로그인 세션의 취소 신호(cancel)를 넘긴다 — 세션이 끝난 뒤 온 답(401 포함)은 api 가 버린다 */
type Cancel = { cancel?: AbortSignal };
const range = (f: (typeof LIMITS)[number]) => `${f.min}~${f.max} ${f.unit}`;
const NO_EDIT = '조직 기준값은 총괄 운영 관리자만 바꿀 수 있습니다.';

function OrgLimits({ admin, cancel }: { admin: boolean } & Cancel) {
  const [saved, setSaved] = useState<OrgSettings | null>(null), [draft, setDraft] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ text: string; ok?: boolean } | null>(null), [busy, setBusy] = useState(false);
  const show = (s: OrgSettings) => { setSaved(s); setDraft(Object.fromEntries(LIMITS.map((f) => [f.key, String(s[f.key])]))); };
  useEffect(() => { api.settings(cancel).then(show, (e: Error) => setMsg({ text: e.message })); }, []);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!saved || busy) return;
    const patch = Object.fromEntries(LIMITS.filter((f) => draft[f.key] !== String(saved[f.key])).map((f) => [f.key, draft[f.key].trim() === '' ? NaN : Number(draft[f.key])]));
    if (!Object.keys(patch).length) return setMsg({ text: '바뀐 값이 없습니다.', ok: true });
    setBusy(true);
    try { show(await api.saveSettings(patch, cancel)); setMsg({ text: '저장했습니다. 다음 실행부터 적용됩니다.', ok: true }); }
    catch (err) {
      // 서버 범위 검사(400 VALIDATION)는 어느 칸인지 알려 주지 않으므로 범위를 벗어난 칸을 함께 적는다
      const bad = LIMITS.filter((f) => f.key in patch && !(patch[f.key] >= f.min && patch[f.key] <= f.max && (f.step < 1 || Number.isInteger(patch[f.key]))));
      setMsg({ text: `${(err as Error).message}${bad.length ? ` 허용 범위: ${bad.map((f) => `${f.label} ${range(f)}${f.step < 1 ? '' : '(정수)'}`).join(', ')}` : ''}` });
    } finally { setBusy(false); }
  };
  return <section className="lv-card" aria-label="조직 기준값">
    <h2>조직 기준값</h2>
    {saved && <form className="fh-form" onSubmit={save} noValidate>
      {LIMITS.map((f) => <label key={f.key} className="fh-field"><span>{f.label} <span className="lbl">({range(f)})</span></span>
        <input className="inp" name={f.key} type="number" inputMode="decimal" min={f.min} max={f.max} step={f.step} readOnly={!admin} aria-describedby={admin ? undefined : 'why-org'}
          value={draft[f.key]} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} /></label>)}
      <div className="fh-row">
        <button type="submit" className="btn pri" disabled={!admin || busy} aria-describedby={admin ? undefined : 'why-org'}>저장</button>
        {!admin && <span id="why-org" className="fh-why" data-why>{NO_EDIT}</span>}
      </div>
    </form>}
    {msg && <p className={`fh-msg${msg.ok ? ' ok' : ''}`} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>}
  </section>;
}

// ── 내 정보(모두, 05 §2 PATCH /me · POST /me/password) ──
export const PW_DONE = '비밀번호를 바꿨습니다. 모든 기기에서 로그아웃됐습니다. 새 비밀번호로 다시 로그인하세요.';

function MyInfo({ user, setMe, cancel }: { user: User; setMe: (u: ApiUser) => void } & Cancel) {
  const [name, setName] = useState(user.name), [msg, setMsg] = useState<Msg>(null), [busy, setBusy] = useState(false);
  const rename = async (e: FormEvent) => {
    e.preventDefault();
    const v = name.trim();
    if (busy) return;
    if (!v) return setMsg({ text: '이름을 입력하세요.' });
    if (v === user.name) return setMsg({ text: '바뀐 값이 없습니다.', ok: true });
    setBusy(true);
    try { const u = await api.saveMe({ display_name: v }, cancel); setMe(u); setName(u.display_name); setMsg({ text: '이름을 바꿨습니다.', ok: true }); }
    catch (err) { setMsg({ text: (err as ApiFail).message }); }
    finally { setBusy(false); }
  };
  // 성공하면 서버가 지금 기기까지 모든 세션을 끝낸다(05 §2) — 다음 요청이 401 이 되기 전에 바로 로그인 화면으로
  const change = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    const f = new FormData(e.currentTarget), cur = String(f.get('current')), next = String(f.get('next'));
    if (!cur || !next) return setMsg({ text: '현재 비밀번호와 새 비밀번호를 입력하세요.' });
    if (next !== String(f.get('again'))) return setMsg({ text: '새 비밀번호 두 칸이 서로 다릅니다.' });
    setBusy(true); setMsg(null);
    try { await api.password({ current_password: cur, new_password: next }, cancel); expireAuth(PW_DONE); }
    catch (err) { setMsg({ text: (err as ApiFail).message }); setBusy(false); }
  };
  return <section className="lv-card" aria-label="내 정보">
    <h2>내 정보</h2>
    <form className="fh-form" onSubmit={rename} noValidate>
      <label className="fh-field"><span>내 이름</span><input className="inp" name="display_name" maxLength={128} value={name} onChange={(e) => setName(e.target.value)} /></label>
      <div className="fh-row"><button type="submit" className="btn pri" disabled={busy}>이름 저장</button></div>
    </form>
    <form className="fh-form" onSubmit={change} noValidate aria-label="비밀번호 바꾸기">
      <h2>비밀번호 바꾸기</h2>
      <label className="fh-field"><span>현재 비밀번호</span><input className="inp" name="current" type="password" autoComplete="current-password" maxLength={1024} /></label>
      <label className="fh-field"><span>새 비밀번호</span><input className="inp" name="next" type="password" autoComplete="new-password" maxLength={1024} /></label>
      <label className="fh-field"><span>새 비밀번호 다시</span><input className="inp" name="again" type="password" autoComplete="new-password" maxLength={1024} /></label>
      <span className="lbl">띄어쓰기는 입력되지 않습니다(띄어쓰기=STOP).</span>
      <div className="fh-row"><button type="submit" className="btn pri" disabled={busy}>비밀번호 바꾸기</button><span className="lbl">바꾸면 모든 기기에서 로그아웃됩니다.</span></div>
    </form>
    <Note msg={msg} />
  </section>;
}

// ── 계정 관리(총괄, 05 §2 /users · /users/{id}/sessions) ──
/** 409 는 code 로 이 화면에 맞는 문구(05 §1.4 — code 는 분기용). 그 밖은 서버 문장 그대로 */
export const LAST_ADMIN = '남은 총괄 계정이 이 계정 하나뿐이라 잠그거나 지우거나 운영 관리자로 바꿀 수 없습니다. 다른 총괄 계정을 먼저 만드세요.';
export const HAS_ROBOTS = '담당 로봇이 있어 지울 수 없습니다. 로봇의 담당자를 먼저 바꾸세요.';
export const TAKEN = '같은 아이디가 이미 있습니다(지운 계정 포함). 다른 아이디를 쓰세요.';
const failText = (e: unknown, conflict?: string) => {
  const f = e as ApiFail;
  return f.code === 'LAST_ORG_ADMIN' ? LAST_ADMIN : f.code === 'VERSION_CONFLICT' && conflict ? conflict : f.message;
};
const SELF = '내 계정은 잠그거나 지우거나 역할을 바꿀 수 없습니다. 다른 총괄에게 부탁하세요.';

const ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
/** 임시 비밀번호 12자(헷갈리는 0·O·1·l·I 뺌). 서버는 1~1024자만 검사한다(05 §1.2 — 최소 길이·복잡도 정책은 미정) */
export const tempPassword = () => Array.from(crypto.getRandomValues(new Uint32Array(12)), (n) => ABC[n % ABC.length]).join('');

function Accounts({ me, cancel }: { me: User } & Cancel) {
  const [list, setList] = useState<ApiUser[] | null>(null), [sel, setSel] = useState(''), [msg, setMsg] = useState<Msg>(null);
  const [adding, setAdding] = useState(false), [made, setMade] = useState<{ name: string; username: string; pw: string } | null>(null);
  useEffect(() => { api.users(cancel).then(setList, (e: ApiFail) => setMsg({ text: e.message })); }, []);
  // 내 이름은 «내 정보»에서만 바꾼다(편집기 하나) — 목록의 내 줄은 그 값
  const rows = list?.map((u) => (u.id === me.id ? { ...u, display_name: me.name } : u)), cur = rows?.find((u) => u.id === sel);
  const put = (u: ApiUser) => setList((l) => l && l.map((x) => (x.id === u.id ? u : x)));
  return <>
    <section className="lv-card" aria-label="계정">
      <div className="fh-row"><h2 className="fh-grow">계정{rows ? ` (${rows.length})` : ''}</h2>
        {!adding && <button type="button" className="btn pri" onClick={() => { setAdding(true); setMade(null); setMsg(null); }}>새 계정</button>}</div>
      {adding && <NewAccount cancel={cancel} close={() => setAdding(false)} done={(u, pw) => { setList((l) => [...(l ?? []), u]); setAdding(false); setMade({ name: u.display_name, username: u.username, pw }); setSel(u.id); }} />}
      {made && <TempPassword {...made} close={() => setMade(null)} />}
      {rows && <ul className="fh-list">{rows.map((u) => <li key={u.id}>
        <button type="button" aria-pressed={u.id === sel} style={{ flexWrap: 'wrap' }} onClick={() => { setSel(u.id); setMsg(null); }}>
          <span style={WRAP}><b>{u.display_name}</b> <span className="mono">{u.username}</span></span><span className="fh-grow">{ROLE_NAME[u.role]}{u.id === me.id ? ' · 나' : ''}</span>
          {u.locked && <Chip tone="bad" text="잠김" />}<span className="lbl">로봇 {u.robot_ids.length}대</span>
        </button></li>)}</ul>}
      <Note msg={msg} />
    </section>
    {cur && <Account key={cur.id} u={cur} self={cur.id === me.id} put={put} cancel={cancel}
      gone={(text) => { setList((l) => l && l.filter((x) => x.id !== cur.id)); setSel(''); setMsg({ text, ok: true }); }} />}
  </>;
}

function NewAccount({ close, done, cancel }: { close: () => void; done: (u: ApiUser, pw: string) => void } & Cancel) {
  const [msg, setMsg] = useState<Msg>(null), [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    const f = new FormData(e.currentTarget), username = String(f.get('username')).trim(), display_name = String(f.get('display_name')).trim();
    if (!username || !display_name) return setMsg({ text: '아이디와 이름을 입력하세요.' });
    const pw = tempPassword();
    setBusy(true);
    try { done(await api.createUser({ username, display_name, role: String(f.get('role')) as Role, temp_password: pw }, cancel), pw); }
    catch (err) { setMsg({ text: failText(err, TAKEN) }); setBusy(false); }
  };
  return <form className="fh-form" onSubmit={submit} noValidate aria-label="새 계정">
    <label className="fh-field"><span>아이디</span><input className="inp" name="username" autoComplete="off" maxLength={128} autoFocus /></label>
    <label className="fh-field"><span>이름</span><input className="inp" name="display_name" autoComplete="off" maxLength={128} /></label>
    <label className="fh-field"><span>역할</span><select className="inp" name="role" defaultValue="OPERATOR">
      <option value="OPERATOR">{ROLE_NAME.OPERATOR}</option><option value="ORG_ADMIN">{ROLE_NAME.ORG_ADMIN}</option></select></label>
    <div className="fh-row"><button type="submit" className="btn pri" disabled={busy}>만들기</button><button type="button" className="btn" onClick={close}>취소</button>
      <span className="lbl">임시 비밀번호는 만들 때 한 번만 보입니다.</span></div>
    <Note msg={msg} />
  </form>;
}

/** 만든 직후 한 번만 보임 — 닫으면 화면 어디에도 남지 않는다 */
function TempPassword({ name, username, pw, close }: { name: string; username: string; pw: string; close: () => void }) {
  return <Once label="임시 비밀번호" value={pw} close={close} text={`${name}(${username}) 계정을 만들었습니다. 임시 비밀번호를 본인에게 전하고, 첫 로그인 뒤 «내 정보»에서 바꾸게 하세요.`} />;
}
/** 한 번만 보이는 비밀 값(임시 비밀번호·로봇 토큰) + 복사. 값은 부른 쪽 상태에만 있고 닫으면 버린다 */
function Once({ label, value, text, close, more }: { label: string; value: string; text: string; close: () => void; more?: string }) {
  const [msg, setMsg] = useState<Msg>(null);
  const copy = () => (navigator.clipboard ? navigator.clipboard.writeText(value) : Promise.reject()).then(
    () => setMsg({ text: '복사했습니다.', ok: true }), () => setMsg({ text: '복사하지 못했습니다. 글자를 직접 골라 복사하세요.' }));
  return <div className="card fh-form" role="group" aria-label={label} style={{ padding: 12 }}>
    <span style={WRAP}>{text}</span>
    <div className="fh-row"><input className="inp mono" readOnly value={value} aria-label={label} style={{ flex: '1 1 160px', width: 'auto', minWidth: 0 }} onFocus={(e) => e.currentTarget.select()} />
      <button type="button" className="btn pri" onClick={copy}>복사</button><button type="button" className="btn" onClick={close}>닫기</button></div>
    <span className="lbl">닫으면 다시 볼 수 없습니다.{more ? ` ${more}` : ''}</span>
    <Note msg={msg} />
  </div>;
}

function Account({ u, self, put, gone, cancel }: { u: ApiUser; self: boolean; put: (u: ApiUser) => void; gone: (text: string) => void } & Cancel) {
  const [name, setName] = useState(u.display_name), [role, setRole] = useState<Role>(u.role);
  const [ask, setAsk] = useState<'lock' | 'delete' | null>(null), [msg, setMsg] = useState<Msg>(null), [busy, setBusy] = useState(false);
  const run = async (f: () => Promise<string>, conflict?: string) => {
    if (busy) return;
    setBusy(true); setAsk(null);
    try { setMsg({ text: await f(), ok: true }); } catch (err) { setMsg({ text: failText(err, conflict) }); } finally { setBusy(false); }
  };
  const save = (e: FormEvent) => {
    e.preventDefault();
    const v = name.trim(), patch = { ...(v !== u.display_name && { display_name: v }), ...(role !== u.role && { role }) };
    if (!v) return setMsg({ text: '이름을 입력하세요.' });
    if (!Object.keys(patch).length) return setMsg({ text: '바뀐 값이 없습니다.', ok: true });
    run(async () => { const n = await api.saveUser(u.id, patch, cancel); put(n); setName(n.display_name); setRole(n.role); return '저장했습니다.'; });
  };
  const lock = (locked: boolean) => run(async () => { put(await api.saveUser(u.id, { locked }, cancel)); return locked ? '잠갔습니다. 이 계정의 로그인이 모두 끝났습니다.' : '잠금을 풀었습니다.'; });
  const del = () => { if (busy) return; setBusy(true); setAsk(null); api.deleteUser(u.id, cancel).then(() => gone(`${u.display_name} 계정을 지웠습니다.`), (err) => { setMsg({ text: failText(err, HAS_ROBOTS) }); setBusy(false); }); };
  const why = self ? SELF : null, noDel = self ? SELF : u.robot_ids.length ? HAS_ROBOTS : null;
  return <section className="lv-card" aria-label="계정 상세">
    <div className="fh-row"><h2 className="fh-grow" style={WRAP}>{u.display_name}</h2><span className="mono" style={WRAP}>{u.username}</span>{u.locked ? <Chip tone="bad" text="잠김" /> : <Chip tone="ok" text="사용 중" />}</div>
    {self ? <p className="lv-note">내 이름은 위 «내 정보»에서 바꿉니다.</p> : <form className="fh-form" onSubmit={save} noValidate>
      <label className="fh-field"><span>이름</span><input className="inp" name="display_name" maxLength={128} value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label className="fh-field"><span>역할</span><select className="inp" name="role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
        <option value="OPERATOR">{ROLE_NAME.OPERATOR}</option><option value="ORG_ADMIN">{ROLE_NAME.ORG_ADMIN}</option></select></label>
      <div className="fh-row"><button type="submit" className="btn pri" disabled={busy}>저장</button></div>
    </form>}
    <div className="fh-row">
      {u.locked ? <button type="button" className="btn" disabled={busy || !!why} aria-describedby={why ? 'why-self' : undefined} onClick={() => lock(false)}>잠금 풀기</button>
        : <button type="button" className="btn" disabled={busy || !!why} aria-describedby={why ? 'why-self' : undefined} onClick={() => setAsk('lock')}>잠그기</button>}
      <button type="button" className="btn" disabled={busy || !!noDel} aria-describedby={self ? 'why-self' : noDel ? 'why-del' : undefined} onClick={() => setAsk('delete')}>지우기</button>
    </div>
    {self && <span id="why-self" className="fh-why" data-why>{SELF}</span>}
    {!self && noDel && <span id="why-del" className="fh-why" data-why>{noDel}</span>}
    {ask && <div className="fh-row" role="group" aria-label="확인">
      <span>{ask === 'lock' ? `${u.display_name} 계정을 잠글까요? 이 사람의 로그인이 모두 끝납니다.` : `${u.display_name} 계정을 지울까요? 이 사람의 로그인이 모두 끝나고 되돌릴 수 없습니다.`}</span>
      <button type="button" className="btn pri" onClick={() => (ask === 'lock' ? lock(true) : del())}>{ask === 'lock' ? '잠그기' : '지우기'}</button>
      <button type="button" className="btn" onClick={() => setAsk(null)}>취소</button>
    </div>}
    <Note msg={msg} />
    <Devices key={String(u.locked)} u={u} cancel={cancel} />
  </section>;
}

const when = (at: string) => new Date(at).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });
/** 로그인 기기(세션) — 지금 쓰는 것만. 끝난 것은 기록 탭에 남는다 */
function Devices({ u, cancel }: { u: ApiUser } & Cancel) {
  const [list, setList] = useState<Session[] | null>(null), [msg, setMsg] = useState<Msg>(null), [busy, setBusy] = useState('');
  const load = () => api.sessions(u.id, cancel).then((l) => setList(l.filter((s) => !s.revoked_at && new Date(s.expires_at) > new Date())), (e: ApiFail) => setMsg({ text: e.message }));
  useEffect(() => { load(); }, []);
  const end = (s: Session) => {
    if (busy) return;
    setBusy(s.id);
    api.endSession(u.id, s.id, cancel).then(() => { setMsg({ text: `${s.device_label} 로그인을 끝냈습니다.`, ok: true }); return load(); }, (e: ApiFail) => setMsg({ text: e.message })).finally(() => setBusy(''));
  };
  return <div className="fh-form" aria-label="로그인 기기">
    <h2>로그인 기기{list ? ` (${list.length})` : ''}</h2>
    {list && !list.length && <p className="lv-note">로그인한 기기가 없습니다.</p>}
    {list && !!list.length && <ul className="fh-form" style={{ listStyle: 'none', margin: 0, padding: 0 }}>{list.map((s) => <li key={s.id} className="fh-row">
      <b style={WRAP}>{s.device_label}</b><span className="lbl">{s.client === 'web' ? '웹' : '앱'}</span><span className="fh-grow lbl">마지막 사용 {when(s.last_seen_at)}</span>
      <button type="button" className="btn" disabled={!!busy} onClick={() => end(s)}>로그아웃시키기</button></li>)}</ul>}
    <Note msg={msg} />
  </div>;
}

// ── 로봇(총괄, 05 §3 POST·PATCH·DELETE /robots · agent-token) ──
/** 409 는 code 로 이 화면에 맞는 문구(05 §1.4). 지울 때 조종권·넘김·진행 중 실행이 있으면 VERSION_CONFLICT(apps/server) */
export const ROBOT_IN_USE = '누군가 조종 중이거나 조종권을 넘기는 중, 또는 실행 중이라 지울 수 없습니다. 조종을 끝내거나 실행을 멈춘 뒤 다시 누르세요.';
export const ROBOT_GONE = '이 로봇은 이미 지워졌습니다. 목록을 다시 받았습니다.';
export const ROBOT_BUSY = '서버가 이 로봇의 다른 변경을 처리하는 중입니다. 잠시 뒤 다시 누르세요.';
const LOST_TOKEN = '잃어버리면 [토큰 다시 받기]로 새로 받으세요.';
const robotFail = (e: unknown) => {
  const f = e as ApiFail;
  return f.code === 'VERSION_CONFLICT' ? ROBOT_IN_USE : f.status === 404 ? ROBOT_GONE : f.code === 'SERVER_BUSY' ? ROBOT_BUSY : f.message;
};
type Token = { text: string; value: string };

/** 담당 고르기: 잠기지 않은 운영 관리자 + «담당 없음». 지금 담당이 목록에 없으면(잠김 등) 그 이름도 둔다 */
function OwnerSelect({ ops, value, onChange, current }: { ops: ApiUser[]; value: string; onChange?: (v: string) => void; current?: RobotSummary['owner'] }) {
  const extra = current && !ops.some((u) => u.id === current.id) ? [current] : [];
  return <label className="fh-field"><span>담당 운영 관리자</span><select className="inp" name="owner" value={value} onChange={(e) => onChange?.(e.target.value)}>
    <option value="">담당 없음</option>
    {ops.map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}
    {extra.map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}</select></label>;
}

function Robots({ refresh, cancel }: { refresh: () => void } & Cancel) {
  const [list, setList] = useState<RobotSummary[] | null>(null), [ops, setOps] = useState<ApiUser[]>([]), [sel, setSel] = useState('');
  const [msg, setMsg] = useState<Msg>(null), [adding, setAdding] = useState(false), [token, setToken] = useState<Token | null>(null);
  const load = () => api.robots('all', cancel).then(setList, (e: ApiFail) => setMsg({ text: e.message }));
  useEffect(() => {
    load();
    api.users(cancel).then((us) => setOps(us.filter((u) => u.role === 'OPERATOR' && !u.locked)), (e: ApiFail) => setMsg({ text: `담당자 목록을 받지 못했습니다. ${e.message}` }));
  }, []);
  // 바꾼 뒤에는 이 목록과 관제·조종 목록(App)을 함께 다시 받는다
  const changed = () => { load(); refresh(); };
  const cur = list?.find((r) => r.id === sel);
  return <>
    <section className="lv-card" aria-label="로봇">
      <div className="fh-row"><h2 className="fh-grow">로봇{list ? ` (${list.length})` : ''}</h2>
        {!adding && <button type="button" className="btn pri" onClick={() => { setAdding(true); setToken(null); setMsg(null); }}>로봇 등록</button>}</div>
      {adding && <NewRobot ops={ops} cancel={cancel} close={() => setAdding(false)} done={(r, value) => {
        setAdding(false); setSel(r.id); changed();
        setToken({ value, text: `${r.name} 로봇을 등록했습니다. 아래 토큰을 로봇 에이전트 설정에 넣으면 연결됩니다.` });
      }} />}
      {token && <Once label="로봇 토큰" value={token.value} text={token.text} more={LOST_TOKEN} close={() => setToken(null)} />}
      {list && !list.length && <p className="lv-note">등록된 로봇이 없습니다.</p>}
      {list && !!list.length && <ul className="fh-list">{list.map((r) => <li key={r.id}>
        <button type="button" aria-pressed={r.id === sel} style={{ flexWrap: 'wrap' }} onClick={() => { setSel(r.id); setMsg(null); }}>
          <b style={WRAP}>{r.name}</b><span className="fh-grow">{r.owner?.display_name ?? '담당 없음'}</span></button></li>)}</ul>}
      <Note msg={msg} />
    </section>
    {cur && <RobotEdit key={cur.id} r={cur} ops={ops} cancel={cancel} changed={changed} showToken={(value) => setToken({ value, text: `${cur.name} 로봇의 새 토큰입니다. 예전 토큰은 더 이상 쓸 수 없습니다. 로봇 에이전트 설정을 이 토큰으로 바꾸세요.` })}
      gone={(text) => { setSel(''); setToken(null); setMsg({ text, ok: true }); changed(); }} />}
  </>;
}

function NewRobot({ ops, close, done, cancel }: { ops: ApiUser[]; close: () => void; done: (r: RobotSummary, token: string) => void } & Cancel) {
  const [msg, setMsg] = useState<Msg>(null), [busy, setBusy] = useState(false), [owner, setOwner] = useState('');
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    const name = String(new FormData(e.currentTarget).get('name')).trim();
    if (!name) return setMsg({ text: '로봇 이름을 입력하세요.' });
    setBusy(true);
    // 토큰은 이 함수 안에서 바로 넘기고 다른 곳에 두지 않는다(05 §3 — 응답에서 한 번만)
    try { const r = await api.createRobot({ name, owner_user_id: owner || null }, cancel); done(r.robot, r.agent_token); }
    catch (err) { setMsg({ text: robotFail(err) }); setBusy(false); }
  };
  return <form className="fh-form" onSubmit={submit} noValidate aria-label="로봇 등록">
    <label className="fh-field"><span>로봇 이름</span><input className="inp" name="name" autoComplete="off" maxLength={128} autoFocus /></label>
    <OwnerSelect ops={ops} value={owner} onChange={setOwner} />
    <div className="fh-row"><button type="submit" className="btn pri" disabled={busy}>등록</button><button type="button" className="btn" onClick={close}>취소</button>
      <span className="lbl">로봇 토큰은 등록할 때 한 번만 보입니다.</span></div>
    <Note msg={msg} />
  </form>;
}

function RobotEdit({ r, ops, changed, gone, showToken, cancel }: { r: RobotSummary; ops: ApiUser[]; changed: () => void; gone: (text: string) => void; showToken: (t: string) => void } & Cancel) {
  const [name, setName] = useState(r.name), [owner, setOwner] = useState(r.owner?.id ?? '');
  const [ask, setAsk] = useState<'token' | 'delete' | null>(null), [msg, setMsg] = useState<Msg>(null), [busy, setBusy] = useState(false);
  const run = async (f: () => Promise<string | void>) => {
    if (busy) return;
    setBusy(true); setAsk(null); setMsg(null);
    try { const t = await f(); if (t) setMsg({ text: t, ok: true }); }
    catch (err) {
      if ((err as ApiFail).status === 404) return gone(ROBOT_GONE);
      setMsg({ text: robotFail(err) });
    } finally { setBusy(false); }
  };
  const save = (e: FormEvent) => {
    e.preventDefault();
    const v = name.trim(), was = r.owner?.id ?? '', patch = { ...(v !== r.name && { name: v }), ...(owner !== was && { owner_user_id: owner || null }) };
    if (!v) return setMsg({ text: '로봇 이름을 입력하세요.' });
    if (!Object.keys(patch).length) return setMsg({ text: '바뀐 값이 없습니다.', ok: true });
    run(async () => { await api.saveRobot(r.id, patch, cancel); changed(); return '저장했습니다.'; });
  };
  const reissue = () => run(async () => showToken((await api.robotToken(r.id, cancel)).agent_token));
  const del = () => run(async () => { await api.deleteRobot(r.id, cancel); gone(`${r.name} 로봇을 지웠습니다.`); });
  return <section className="lv-card" aria-label="로봇 설정">
    <div className="fh-row"><h2 className="fh-grow" style={WRAP}>{r.name}</h2><span className="lbl">{r.model}</span></div>
    <form className="fh-form" onSubmit={save} noValidate>
      <label className="fh-field"><span>로봇 이름</span><input className="inp" name="name" maxLength={128} value={name} onChange={(e) => setName(e.target.value)} /></label>
      <OwnerSelect ops={ops} value={owner} onChange={setOwner} current={r.owner} />
      <span className="lbl">담당을 바꾸거나 없애면 예전 담당자의 조종이 끝나고 로봇이 정지합니다.</span>
      <div className="fh-row"><button type="submit" className="btn pri" disabled={busy}>저장</button></div>
    </form>
    <div className="fh-row">
      <button type="button" className="btn" disabled={busy} onClick={() => setAsk('token')}>토큰 다시 받기</button>
      <button type="button" className="btn" disabled={busy} onClick={() => setAsk('delete')}>로봇 지우기</button>
    </div>
    {ask && <div className="fh-row" role="group" aria-label="확인">
      <span style={WRAP}>{ask === 'token' ? `${r.name} 토큰을 새로 받을까요? 예전 토큰은 바로 못 쓰게 되어 새 토큰을 넣을 때까지 로봇이 연결되지 않습니다.`
        : `${r.name} 로봇을 지울까요? 로봇이 더 이상 연결되지 않고 되돌릴 수 없습니다. 기록은 남습니다.`}</span>
      <button type="button" className="btn pri" onClick={ask === 'token' ? reissue : del}>{ask === 'token' ? '토큰 다시 받기' : '지우기'}</button>
      <button type="button" className="btn" onClick={() => setAsk(null)}>취소</button>
    </div>}
    <Note msg={msg} />
  </section>;
}
