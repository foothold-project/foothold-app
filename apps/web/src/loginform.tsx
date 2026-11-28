// 로그인 칸 보기(u10_3 · U11-03): 오류 띠(위) · 틀린 칸 빨간 테(.inp[aria-invalid] 기존 frame.css) · 초점 · 비밀번호 보기 단추.
// 보기만 맡는다: 제출 · 로그인 요청 · 세션 처리는 session.tsx Login 그대로. 어느 칸이 틀렸는지(bad)도 Login 이 정한다.
// 서버 401 은 계정 · 비밀번호를 가르지 않으므로(api.py login) Login 은 서버 거절에 두 칸 모두(both)를 고른다(REVIEW-PR580 G1). 글은 받은 그대로 보인다.
import { useEffect, useId, useRef, useState } from 'react';
import { usePhone } from './App';

/** both = 서버 401(계정 · 비밀번호를 가르지 않음): 두 칸 모두 표시, 초점은 계정 칸부터 */
export type LoginBad = 'username' | 'password' | 'both' | null;
export const ACCOUNT_ASK = '계정은 총괄에게 요청하세요.';
// 비밀번호 바꾸기는 로그인한 세션이 있어야 한다(서버 /me/password) · 웹 입구는 PC 설정 › 내 정보 하나. 폰 틀엔 설정 탭이 없다(menu.tsx PHONE_TABS).
// 로그인 전에 바꾸는 창(u10_2 시안 그대로)은 #471 뒤. 서버에 없는 약속(8 자 이상 · 임시 비밀번호)은 쓰지 않는다.
export const PW_HINT_PC = '로그인한 뒤 설정 › 내 정보에서 바꿉니다.';
export const PW_HINT_PHONE = '폰 화면에는 설정이 없습니다. PC 에서 로그인한 뒤 설정 › 내 정보에서 바꿉니다.';

/** 로그인 아래 줄(u10_4 배치): 왼쪽 「비밀번호 바꾸기」 링크 · 오른쪽 계정 요청 한 줄. 링크는 요청 없이 바꾸는 자리를 회색 띠로 알린다 */
export function LoginFoot() {
  const [open, setOpen] = useState(false), phone = usePhone(), id = useId();
  return <>
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
      <button type="button" className="btn" data-pw-link aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 40, padding: '0 4px', border: 0, background: 'transparent', color: 'var(--accent)', fontWeight: 600 }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
          <circle cx="8" cy="15" r="4" /><path d="M11 12l9-9M17 6l3 3M15 8l2 2" /></svg>
        비밀번호 바꾸기</button>
      <span className="lbl" data-account-ask>{ACCOUNT_ASK}</span>
    </div>
    {open && <p className="fh-msg" role="status" id={id} data-pw-hint
      style={{ margin: 0, padding: '10px 12px', border: '1px solid var(--line2)', borderRadius: 8, background: 'var(--panel2)', color: 'var(--text)' }}>{phone ? PW_HINT_PHONE : PW_HINT_PC}</p>}
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
    <label className="fh-field"><span className="lbl">계정</span>
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
