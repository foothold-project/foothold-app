// 로그인 칸 보기(u10_3 · U11-03): 오류 띠(위) · 틀린 칸 빨간 테(.inp[aria-invalid] 기존 frame.css) · 초점 · 비밀번호 보기 단추.
// 보기만 맡는다: 제출 · 로그인 요청 · 세션 처리는 session.tsx Login 그대로. 어느 칸이 틀렸는지(bad)도 Login 이 정한다.
// 서버 401 은 계정 · 비밀번호를 가르지 않으므로(api.py login) Login 은 서버 거절에 두 칸 모두(both)를 고른다(REVIEW-PR580 G1). 글은 받은 그대로 보인다.
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { api, type ApiFail } from './api';

/** both = 서버 401(계정 · 비밀번호를 가르지 않음): 두 칸 모두 표시, 초점은 계정 칸부터 */
export type LoginBad = 'username' | 'password' | 'both' | null;
export const ACCOUNT_ASK = '계정은 총괄에게 요청하세요.';
// 로그인 전 비밀번호 바꾸기 창(u10_2 시안 그대로): 서버 /me/password 는 로그인한 세션이 있어야 하므로
// 이 창은 아이디 · 지금 비밀번호로 로그인 → POST /me/password → 로그아웃 을 차례로 한다(새 API 없음).
// 8 자 이상 · 스페이스 금지는 이 창이 보내기 전에 막는다(서버 최소 길이는 1 · 빈칸 목록 u9_2). 임시 비밀번호도 로그인이 되므로 「지금 비밀번호」 칸에 넣으면 된다.
// 바꾸면 창을 닫고 로그인 카드에 시안 u10_4 의 초록 줄 「비밀번호를 바꿨습니다. 새 비밀번호로 로그인하세요」.
export const PW_RULE = '8 자 이상 입력하세요. 스페이스는 정지 키라서 쓸 수 없습니다.';
export const PW_TEMP = '임시 비밀번호를 받았다면 「현재 비밀번호」 칸에 입력하세요.';
export const PW_DONE = '비밀번호를 바꿨습니다. 새 비밀번호로 로그인하세요';
const KEY = <svg className="ic" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
  <circle cx="8" cy="15" r="4" /><path d="M11 12l9-9M17 6l3 3M15 8l2 2" /></svg>;

/** 로그인 아래 줄(u10_1 배치): 왼쪽 「비밀번호 바꾸기」 링크(누르면 u10_2 창) · 오른쪽 계정 요청 한 줄 */
export function LoginFoot({ done }: { done?: () => void }) {
  const [open, setOpen] = useState(false), link = useRef<HTMLButtonElement>(null);
  return <>
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
      <button ref={link} type="button" className="btn" data-pw-link aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 40, padding: '0 4px', border: 0, background: 'transparent', color: 'var(--accent)', fontWeight: 600 }}>
        {KEY}비밀번호 바꾸기</button>
      <span className="lbl" data-account-ask>{ACCOUNT_ASK}</span>
    </div>
    {open && createPortal(<PwChange close={() => setOpen(false)} done={() => { setOpen(false); done?.(); }} />, link.current?.closest('.fh.lg') ?? document.body)}
  </>;
}

type PwBad = 'id' | 'cur' | 'new' | 'again' | 'both' | null;   // both = 서버 401(아이디 · 지금 비밀번호를 가르지 않음)
/** 비밀번호 바꾸기 창의 값 확인 · 요청(PC u10_2 PwChange · 폰 u13_2 가 같이 쓴다). 보기는 각 창이 맡는다 */
export function usePwChange(done: () => void) {
  const [err, setErr] = useState(''), [bad, setBad] = useState<PwBad>(null), [busy, setBusy] = useState(false);
  const refs = { id: useRef<HTMLInputElement>(null), cur: useRef<HTMLInputElement>(null), new: useRef<HTMLInputElement>(null), again: useRef<HTMLInputElement>(null) };
  useEffect(() => { refs.id.current?.focus(); }, []);
  useEffect(() => { if (bad) refs[bad === 'both' ? 'id' : bad].current?.focus(); }, [bad, err]);
  const fail = (b: PwBad, m: string) => { setBad(b); setErr(m); };
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault(); e.stopPropagation();   // 로그인 카드 form 의 제출로 번지지 않게
    if (busy) return;
    const f = new FormData(e.currentTarget), id = String(f.get('pw-id') ?? '').trim(), cur = String(f.get('pw-cur') ?? ''), nw = String(f.get('pw-new') ?? ''), again = String(f.get('pw-again') ?? '');
    if (!id) return fail('id', '아이디를 입력하세요.');
    if (!cur) return fail('cur', '지금 비밀번호를 입력하세요.');
    if (nw.length < 8) return fail('new', '새 비밀번호는 8 자 이상 입력하세요.');
    if (/\s/.test(nw)) return fail('new', '스페이스는 정지 키라서 비밀번호에 쓸 수 없습니다.');
    if (nw === cur) return fail('new', '지금 비밀번호와 다른 값을 입력하세요.');
    if (nw !== again) return fail('again', '새 비밀번호가 서로 다릅니다.');
    setBusy(true); setBad(null); setErr('');
    try { await api.login(id, cur); }
    catch (x) { setBusy(false); return fail((x as ApiFail).status === 401 ? 'both' : null, (x as ApiFail).message); }   // 401 은 아이디 · 비밀번호를 가르지 않는다
    let ok = true;
    try { await api.password({ current_password: cur, new_password: nw }); }
    catch (x) { ok = false; setErr(`바꾸지 못했습니다. ${(x as ApiFail).message}`); }
    await api.logout().catch(() => {});   // 바꾸려고 연 세션은 바로 닫는다
    setBusy(false);
    if (ok) done();
  };
  return { err, bad, busy, refs, submit };
}

/** u10_2 창: 아이디 · 지금 비밀번호 · 새 비밀번호 · 다시. 취소 · X · Esc 로 닫힘(요청 없음) */
export function PwChange({ close, done }: { close: () => void; done: () => void }) {
  const { err, bad, busy, refs, submit } = usePwChange(done), title = useId();
  const field = (k: 'id' | 'cur' | 'new' | 'again', label: string, name: string, type: string, auto: string) => <label className="fh-field"><span className="lab">{label}</span>
    <input ref={refs[k]} className="inp" name={name} type={type} autoComplete={auto} aria-invalid={bad === k || (bad === 'both' && (k === 'id' || k === 'cur')) || undefined} /></label>;
  return <>
    <div className="lg-scrim" onClick={() => !busy && close()} />
    <form className="lg-modal" role="dialog" aria-modal="true" aria-labelledby={title} onSubmit={submit} noValidate onKeyDown={(e) => { if (e.key === 'Escape' && !busy) close(); }}>
      <div className="lg-row"><span className="ttl" id={title}>비밀번호 바꾸기</span>
        <button type="button" className="lg-x" aria-label="닫기" onClick={close} disabled={busy}><svg className="ic" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg></button></div>
      <div className="lg-mfields">
        {field('id', '아이디', 'pw-id', 'text', 'username')}
        {field('cur', '지금 비밀번호', 'pw-cur', 'password', 'current-password')}
        {field('new', '새 비밀번호', 'pw-new', 'password', 'new-password')}
        {field('again', '새 비밀번호 다시', 'pw-again', 'password', 'new-password')}
      </div>
      {err ? <p className="lg-merr" role="alert" data-pw-err>{err}</p> : null}
      <p className="lg-mnote">{PW_RULE}<br />{PW_TEMP}</p>
      <div className="lg-mbtns"><button type="button" className="mbtn sec" onClick={close} disabled={busy}>취소</button>
        <button type="submit" className="mbtn pri" disabled={busy}>{busy ? '바꾸는 중…' : '바꾸기'}</button></div>
    </form>
  </>;
}

/** tick = 제출마다 +1. 같은 칸이 다시 틀려도 초점을 다시 준다. note = 제출 전 받은 안내(예: 로그인이 끝났습니다)라 오류 빨강이 아닌 중립 띠 */
export function LoginFields({ msg, bad, tick, busy, note }: { msg?: string; bad: LoginBad; tick: number; busy: boolean; note?: boolean }) {
  const [see, setSee] = useState(false), user = useRef<HTMLInputElement>(null), pass = useRef<HTMLInputElement>(null);
  useEffect(() => { (bad === 'username' || bad === 'both' ? user : bad === 'password' ? pass : null)?.current?.focus(); }, [bad, tick]);
  return <>
    {msg && note && <p className="fh-msg" role="alert" data-login-note
      style={{ padding: '10px 12px', border: '1px solid var(--line2)', borderRadius: 8, background: 'var(--panel2)', color: 'var(--text)' }}>{msg}</p>}
    {msg && !note && <p className="fh-msg" role="alert" data-login-err
      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', border: '1px solid var(--bad)', borderRadius: 8, background: 'var(--bad-bg)', color: 'var(--text)' }}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--bad)" strokeWidth="2" strokeLinejoin="round" aria-hidden="true" style={{ flex: 'none' }}>
        <path d="M12 3L22 20H2z" /><path d="M12 10v4M12 17v.5" strokeLinecap="round" /></svg>
      {msg}</p>}
    <label className="fh-field"><span className="lbl">아이디</span>
      <input ref={user} className="inp" name="username" autoComplete="username" autoFocus aria-invalid={bad === 'username' || bad === 'both' || undefined} /></label>
    <label className="fh-field"><span className="lbl">비밀번호</span>
      <span style={{ position: 'relative', display: 'block' }}>
        <input ref={pass} className="inp" name="password" type={see ? 'text' : 'password'} autoComplete="current-password" aria-invalid={bad === 'password' || bad === 'both' || undefined}
          style={{ width: '100%', boxSizing: 'border-box', paddingRight: 48 }} />
        <button type="button" className="btn" data-pw-eye aria-pressed={see} aria-label={see ? '비밀번호 숨기기' : '비밀번호 보기'} onClick={() => setSee((v) => !v)}
          style={{ position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)', minWidth: 40, minHeight: 40, padding: 0, border: 0, background: 'transparent', color: 'var(--muted)' }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" />{see && <path d="M4 4l16 16" strokeLinecap="round" />}</svg>
        </button>
      </span></label>
    <button type="submit" className="btn pri" disabled={busy}>{busy ? '로그인 중…' : '로그인'}</button>
  </>;
}
