// 로그인 화면 공통(MLogin·PcLogin): 원본 틀에 실제 로그인을 붙인다. 예시 계정·비밀번호는 지운다(live.js setupLogin 과 같은 규칙).
// 전송은 data/auth 의 `auth`(= transport T) 하나로만: 웹 쿠키 관문 또는 네이티브 B(앱 출처 + FhGate 있을 때만).
import { useEffect, useRef, useState } from 'react';
import { auth, intent, safeNext } from '../data/auth';
import { useNote } from '../data/transport';
import { useRoute, whyProps } from './shell';

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
  // 네이티브만: 관문 주소 바꾸기 → 세대 바뀜(진행 중 로그인 결과 버림)
  // ponytail: prompt 입력, 화면 시안의 주소 입력 칸이 정해지면 그쪽으로
  const change = async () => {
    const o = prompt('관문 주소(https://주소:포트)'); if (!o || !auth.setGate) return;
    const my = ++intent.n; busy.current = false;
    const err = await auth.setGate(o.trim());
    if (my !== intent.n) return;   // 그 사이 다른 요청·화면 떠남
    setMsg(err ? { t: err } : { t: '관문 주소 바뀜 — 다시 로그인', ok: true });
    const w = await auth.where(); if (my === intent.n) setWhere(w);
  };
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
    chgP: auth.setGate ? { href: undefined, role: 'button', tabIndex: 0, onClick: (e: React.SyntheticEvent) => { e.preventDefault(); change(); } } : whyProps('연결할 서버는 이 주소 하나입니다'),
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
