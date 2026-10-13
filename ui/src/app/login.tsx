// 로그인 화면 공통(MLogin·PcLogin): 원본 틀에 실제 로그인을 붙인다. 예시 계정·비밀번호는 지운다(live.js setupLogin 과 같은 규칙).
// 전송은 data/auth 의 `auth`(= transport T) 하나로만: 웹 쿠키 관문 또는 네이티브 B(앱 출처 + FhGate 있을 때만).
import { useEffect, useRef, useState } from 'react';
import { auth, gateOrigin, intent, safeNext } from '../data/auth';
import { useNote } from '../data/transport';
import { useRoute, whyProps } from './shell';

// 편집 줄 버튼: 로그인 화면 원본 토큰(로그인 버튼 accent·on-accent, 입력 테두리 line2)만 — .btn 은 이 화면 틀에 없음. 손가락 44 px
const EDB = { minHeight: 44, minWidth: 72, padding: '0 16px', borderRadius: 10, fontWeight: 600, fontSize: 15, cursor: 'pointer' } as const;
const FAILS = '5분 안에 5번 틀리면 잠시 잠김';   // phone_gate RateLimit(limit 5, window 300 s)

export function useLoginVals(phone: boolean) {
  const { q } = useRoute(), next = safeNext(q.get('next'), phone);
  const [msg, setMsg] = useState<{ t: string; ok?: boolean } | null>(null);
  const busy = useRef(false), id = useRef<HTMLInputElement>(null), pw = useRef<HTMLInputElement>(null), dv = useRef<HTMLInputElement>(null);
  const [where, setWhere] = useState('');
  const note = useNote((s) => s.note);   // 저장 안 됨·서버 종료 확인 중/못 함(로그아웃 뒤에도 같은 페이지라 이어서 받음)
  useEffect(() => {
    let live = true;
    auth.where().then((w) => live && setWhere(w));
    auth.hint().then((h) => live && h && setMsg((m) => m || { t: h }));   // 주소 없음·잠김: 첫 안내
    return () => { live = false; intent.n++; };   // 떠나면 진행 중 로그인·주소 변경 결과는 버림
  }, []);
  // 네이티브 B 만: «바꾸기» → 서버 카드 아래 편집 줄(같은 카드 틀·기존 .inp/.btn). 1차 형식 검사 = gateOrigin, 최종 검사 = 네이티브.
  // 바꾸면 세대가 바뀜(진행 중 로그인 결과 버림).
  const [ed, setEd] = useState<{ open: boolean; busy: boolean; err: string }>({ open: false, busy: false, err: '' });
  const gin = useRef<HTMLInputElement>(null), chg = useRef<HTMLAnchorElement | null>(null);
  const close = () => { setEd({ open: false, busy: false, err: '' }); chg.current?.focus(); };
  const change = async () => {
    if (!auth.setGate || ed.busy) return;
    const g = gateOrigin(gin.current?.value || '');
    if ('why' in g) { setEd((e) => ({ ...e, err: g.why })); gin.current?.focus(); return; }
    const my = ++intent.n; busy.current = false;
    setEd({ open: true, busy: true, err: '' });
    const err = await auth.setGate(g.origin);
    if (my !== intent.n) return;   // 그 사이 다른 요청·화면 떠남
    if (err) { setEd({ open: true, busy: false, err }); requestAnimationFrame(() => gin.current?.focus()); return; }
    setMsg({ t: '관문 주소 바뀜 — 다시 로그인', ok: true }); close();
    const w = await auth.where(); if (my === intent.n) setWhere(w);
  };
  const cur = where.startsWith('관문 · ') ? where.slice(5) : '';
  const gateEd = auth.setGate && ed.open ? (
    <div role="group" aria-label="관문 주소 바꾸기" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 14px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--panel)' }}>
      <label className="lbl" htmlFor="gate-origin" style={{ fontSize: 12 }}>관문 주소 · https://호스트:포트</label>
      <input id="gate-origin" ref={gin} className="inp" type="url" inputMode="url" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={200}
        defaultValue={cur} placeholder="https://관문주소:포트" disabled={ed.busy} aria-invalid={!!ed.err} aria-describedby="gate-err"
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); change(); } else if (e.key === 'Escape') { e.preventDefault(); close(); } }} />
      <div id="gate-err" role="alert" style={{ minHeight: 18, fontSize: 13, color: 'var(--bad, #FF5A4F)', overflowWrap: 'anywhere' }}>{ed.busy ? '주소 저장 중…' : ed.err}</div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        <button type="button" style={{ ...EDB, background: 'transparent', color: 'var(--accent)', border: '1px solid var(--line2)' }} onClick={close} disabled={ed.busy}>취소</button>
        <button type="button" style={{ ...EDB, background: 'var(--accent)', color: 'var(--on-accent)', border: 0 }} onClick={change} disabled={ed.busy}>주소 저장</button>
      </div>
    </div>) : null;
  const go = async (e: React.SyntheticEvent) => {
    e.preventDefault(); if (busy.current) return;
    if (!auth.gated) return setMsg({ t: '보호 주소(https://…:8453)에서만 로그인할 수 있습니다' });
    const u = id.current?.value.trim() || '', p = pw.current?.value || '';
    if (!u || !p) return setMsg({ t: '계정과 비밀번호를 넣으세요' });
    busy.current = true; setMsg({ t: '확인 중…' }); const my = ++intent.n;
    const r = await auth.login(u, p, dv.current ? dv.current.value : phone ? '휴대폰' : '');
    if (my !== intent.n) return;   // 그 사이 로그아웃·화면 떠남·새 요청 → 옛 결과 버림
    if (r.ok) { setMsg({ t: '로그인됨 — 여는 중', ok: true }); location.replace(next); location.reload(); return; }   // 새로 읽어 링크도 새 세션으로
    busy.current = false; setMsg({ t: r.error });
  };
  const ids = phone ? ['mid', 'mpw'] : ['id', 'pw'];
  return {
    formP: { onSubmit: go, noValidate: true },
    dotP: auth.gated ? {} : { style: { color: 'var(--warn)' } },
    srvA: where || '확인 중…',
    srvB: auth.kind === 'native' ? '앱이 관문 인증서를 확인(토큰은 기기에만)' : auth.gated ? '이 PC 의 자체 인증서 · 경고가 뜨면 관문 ca.crt 설치' : '보호 주소(https)가 아님 — 로그인 안 됨',
    chgP: auth.setGate ? { href: undefined, role: 'button', tabIndex: 0, ref: chg, 'aria-expanded': ed.open, 'aria-controls': 'gate-origin',
      onClick: (e: React.SyntheticEvent) => { e.preventDefault(); if (ed.busy) return; if (ed.open) close(); else { setEd({ open: true, busy: false, err: '' }); requestAnimationFrame(() => gin.current?.focus()); } },
      onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); (e.currentTarget as HTMLElement).click(); } } } : whyProps('연결할 서버는 이 주소 하나입니다'),
    gateEd,
    idIn: <input id={ids[0]} ref={id} className="inp" autoComplete="username" maxLength={64} />,
    pwIn: <input id={ids[1]} ref={pw} className="inp" type="password" autoComplete="current-password" maxLength={256} />,
    dvIn: <input id="dv" ref={dv} className="inp" maxLength={40} placeholder="예: 관제 노트북 · 기록에 남음" />,
    keepP: { title: '로그인은 12시간 유지(관문을 다시 켜면 다시 로그인)' },
    keepIn: { disabled: true, checked: true, readOnly: true, defaultChecked: undefined },
    keepT: '로그인 12시간 유지 · 관문 재시작 시 다시 로그인',
    msg: <div role="alert" style={{ minHeight: 20, fontSize: 13, color: msg?.ok ? 'var(--ok)' : 'var(--bad, #FF5A4F)' }}>{[msg?.t, note].filter(Boolean).join(' · ')}</div>,
    loginP: { href: undefined, role: 'button', tabIndex: 0, onClick: go, onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') go(e); } },
    viewP: { ...whyProps('보기 전용 계정은 없습니다 — 로그인 뒤 조종권을 받지 않으면 보기 전용(STOP 은 누구나)'), href: undefined },
    rl: FAILS,
  };
}
