// 로그인 칸 보기(u10_3 · U11-03): 오류 띠(위) · 틀린 칸 빨간 테(.inp[aria-invalid] 기존 frame.css) · 초점 · 비밀번호 보기 단추.
// 보기만 맡는다: 제출 · 로그인 요청 · 세션 처리는 session.tsx Login 그대로. 어느 칸이 틀렸는지(bad)도 Login 이 정한다.
// 서버 401 은 계정 · 비밀번호를 가르지 않으므로(api.py login) Login 은 서버 거절에 비밀번호 칸만 고른다. 글은 받은 그대로 보인다.
import { useEffect, useRef, useState } from 'react';

export type LoginBad = 'username' | 'password' | null;
export const ACCOUNT_ASK = '계정은 총괄에게 요청하세요.';

/** tick = 제출마다 +1. 같은 칸이 다시 틀려도 초점을 다시 준다 */
export function LoginFields({ msg, bad, tick, busy }: { msg?: string; bad: LoginBad; tick: number; busy: boolean }) {
  const [see, setSee] = useState(false), user = useRef<HTMLInputElement>(null), pass = useRef<HTMLInputElement>(null);
  useEffect(() => { (bad === 'username' ? user : bad === 'password' ? pass : null)?.current?.focus(); }, [bad, tick]);
  return <>
    {msg && <p className="fh-msg" role="alert" data-login-err
      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', border: '1px solid var(--bad)', borderRadius: 8, background: 'var(--bad-bg)', color: 'var(--text)' }}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--bad)" strokeWidth="2" strokeLinejoin="round" aria-hidden="true" style={{ flex: 'none' }}>
        <path d="M12 3L22 20H2z" /><path d="M12 10v4M12 17v.5" strokeLinecap="round" /></svg>
      {msg}</p>}
    <label className="fh-field"><span className="lbl">계정</span>
      <input ref={user} className="inp" name="username" autoComplete="username" autoFocus aria-invalid={bad === 'username' || undefined} /></label>
    <label className="fh-field"><span className="lbl">비밀번호</span>
      <span style={{ position: 'relative', display: 'block' }}>
        <input ref={pass} className="inp" name="password" type={see ? 'text' : 'password'} autoComplete="current-password" aria-invalid={bad === 'password' || undefined}
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
