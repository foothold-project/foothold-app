/** 폰 로그인 = 시안 u13_1 (proto/screens/u13_1_login.html). 화면 마크업은 시안 body 를 옮긴 것(태그 · class · 순서 · 글 그대로),
 *  칸 div 는 input · 단추 div 는 button 으로만 바꿨다. 제출 · 로그인 요청 · 세션 처리 · 어느 칸이 틀렸는지는 session.tsx Login 그대로.
 *  시안에 없는 것(오류 · 안내 한 줄, 바꾼 뒤 알림)은 시안의 .msg 결로 그렸다(u13.app.css). 「비밀번호 바꾸기」 는 PC 와 같은 loginform PwChange 창(u10_2)을 연다.
 *  PC 로그인 카드는 session.tsx 몫 */
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import '../proto/ui.pv.css';
import '../proto/light.pv.css';
import './u13.css';
import './u13.app.css';
import { PW_RULE, usePwChange, type LoginBad } from '../loginform';

/** 시안 아래 줄 글(마침표 없이 시안 그대로) */
export const ACCOUNT_ASK_PHONE = '계정은 총괄에게 요청하세요';
const KEY = <><path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z" /><circle cx="16.5" cy="7.5" r=".5" fill="currentColor" /></>;
const OK = <path d="M20 6 9 17l-5-5" />;
const X = <><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>;
/** 시안 u13_3 위 알림 글(시안 그대로) */
export const PW_DONE_PHONE = '바꿨습니다. 새 비밀번호로 로그인하세요';
const WARN = <><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" /><path d="M12 9v4" /><path d="M12 17h.01" /></>;

/** note = 제출 전 받은 안내(로그인이 끝났습니다 등)라 오류 빨강이 아닌 중립 줄 */
export function PhoneLogin({ msg, bad, tick, busy, note, light, submit, done }: { done?: () => void; msg?: string; bad: LoginBad; tick: number; busy: boolean; note?: boolean; light: boolean; submit: (e: FormEvent<HTMLFormElement>) => void }) {
  const user = useRef<HTMLInputElement>(null), pass = useRef<HTMLInputElement>(null), [foc, setFoc] = useState(''), [open, setOpen] = useState(false), [changed, setChanged] = useState(false), link = useRef<HTMLButtonElement>(null);
  useEffect(() => { (bad === 'username' || bad === 'both' ? user : bad === 'password' ? pass : null)?.current?.focus(); }, [bad, tick]);
  const cls = (k: 'username' | 'password') => `inp${foc === k ? ' foc' : ''}${bad === k || bad === 'both' ? ' bad' : ''}`;
  const on = (k: string) => ({ onFocus: () => setFoc(k), onBlur: () => setFoc('') });
  return <main className={`proto pv u13${light ? ' light' : ''}`} aria-label="로그인" data-u13="login">
    <div className="bg" />
    <form className="g" onSubmit={submit} noValidate style={{ left: '50%', top: 'calc(50% + 16px)', transform: 'translate(-50%,-50%)', width: '330px', padding: '20px 20px 16px', borderRadius: '22px' }}>
      <div className="row" style={{ justifyContent: 'space-between' }}><span style={{ fontWeight: 900, letterSpacing: '.08em', fontSize: '13px' }}>FOOTHOLD</span><h1 style={{ fontSize: '19px', fontWeight: 800 }}>로그인</h1></div>
      {msg && note && <p className="msg u13-note" role="alert" data-login-note style={{ marginTop: '12px' }}>{msg}</p>}
      {msg && !note && <p className="msg err" role="alert" data-login-err style={{ marginTop: '12px' }}><svg className="ic" viewBox="0 0 24 24" style={{ width: '16px', height: '16px' }} aria-hidden="true">{WARN}</svg>{msg}</p>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '9px', marginTop: '12px' }}>
        <div><label className="lab" htmlFor="u13-user">아이디</label><input id="u13-user" ref={user} className={cls('username')} name="username" autoComplete="username" autoFocus
          aria-invalid={bad === 'username' || bad === 'both' || undefined} {...on('username')} /></div>
        <div><label className="lab" htmlFor="u13-pass">비밀번호</label><input id="u13-pass" ref={pass} className={cls('password')} name="password" type="password" autoComplete="current-password"
          aria-invalid={bad === 'password' || bad === 'both' || undefined} {...on('password')} /></div>
      </div>
      <button type="submit" className="prim" style={{ marginTop: '14px' }} id="go-login" disabled={busy}>{busy ? '로그인 중…' : '로그인'}</button>
      <div className="row" style={{ justifyContent: 'space-between', marginTop: '12px' }}>
        <button ref={link} type="button" className="link" id="go-pw" data-pw-link aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
          <svg className="ic" viewBox="0 0 24 24" style={{ width: '14px', height: '14px' }} aria-hidden="true">{KEY}</svg>비밀번호 바꾸기</button>
        <span style={{ fontSize: '11px', fontWeight: 600, color: '#5e6662' }} data-account-ask>{ACCOUNT_ASK_PHONE}</span></div>
    </form>
    {changed && !msg && <p className="msg ok" role="status" data-pw-changed style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', top: '10px', zIndex: 3, whiteSpace: 'nowrap' }}>
      <svg className="ic" viewBox="0 0 24 24" style={{ width: '15px', height: '15px' }} aria-hidden="true">{OK}</svg>{PW_DONE_PHONE}</p>}
    {open && <PhonePw close={() => { setOpen(false); link.current?.focus(); }} done={() => { setOpen(false); setChanged(true); done?.(); }} />}
  </main>;
}

/** 시안 u13_2 비밀번호 바꾸기 창(가림 .veil · 560 폭 .g · 두 줄 두 칸). 값 확인 · 요청은 PC 창과 같은 usePwChange.
 *  시안 밖: 오류 한 줄(.msg.err 결). 아래 안내 글은 PC 와 같은 규칙 글(시안의 «모든 기기에서 로그아웃» 은 서버 확인 전이라 쓰지 않음) */
function PhonePw({ close, done }: { close: () => void; done: () => void }) {
  const { err, bad, busy, refs, submit } = usePwChange(done), title = useId();
  const field = (k: 'id' | 'cur' | 'new' | 'again', label: string, name: string, type: string, auto: string) => <div><label className="lab" htmlFor={`u132-${k}`}>{label}</label>
    <input id={`u132-${k}`} ref={refs[k]} className={`inp${bad === k || (bad === 'both' && (k === 'id' || k === 'cur')) ? ' bad' : ''}`} name={name} type={type} autoComplete={auto}
      aria-invalid={bad === k || (bad === 'both' && (k === 'id' || k === 'cur')) || undefined} /></div>;
  return <>
    <div className="veil" onClick={() => !busy && close()} />
    <form className="g" role="dialog" aria-modal="true" aria-labelledby={title} onSubmit={submit} noValidate data-u13="password" onKeyDown={(e) => { if (e.key === 'Escape' && !busy) close(); }}
      style={{ left: '50%', top: '50%', transform: 'translate(-50%,-50%)', width: '560px', padding: '18px 20px', borderRadius: '22px', zIndex: 6 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}><span style={{ fontSize: '17px', fontWeight: 800 }} id={title}>비밀번호 바꾸기</span>
        <button type="button" className="link" id="go-x" aria-label="닫기" onClick={close} disabled={busy}><svg className="ic" viewBox="0 0 24 24" style={{ width: '20px', height: '20px' }} aria-hidden="true">{X}</svg></button></div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '9px 12px', marginTop: '12px' }}>
        {field('id', '아이디', 'pw-id', 'text', 'username')}
        {field('cur', '현재 비밀번호', 'pw-cur', 'password', 'current-password')}
        {field('new', '새 비밀번호', 'pw-new', 'password', 'new-password')}
        {field('again', '새 비밀번호 확인', 'pw-again', 'password', 'new-password')}
      </div>
      {err && <p className="msg err" role="alert" data-pw-err style={{ marginTop: '10px' }}><svg className="ic" viewBox="0 0 24 24" style={{ width: '16px', height: '16px' }} aria-hidden="true">{WARN}</svg>{err}</p>}
      <p style={{ fontSize: '11.5px', fontWeight: 600, color: '#5e6662', marginTop: '10px' }}>{PW_RULE}</p>
      <div style={{ display: 'flex', gap: '10px', marginTop: '12px' }}><button type="button" className="sec" style={{ flex: 1 }} id="go-cancel" onClick={close} disabled={busy}>취소</button>
        <button type="submit" className="prim" style={{ flex: 1 }} id="go-change" disabled={busy}>{busy ? '바꾸는 중…' : '바꾸기'}</button></div>
    </form>
  </>;
}
