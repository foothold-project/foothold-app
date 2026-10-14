// 로그인 화면 공통(MLogin·PcLogin): 원본 틀에 실제 로그인을 붙인다. 예시 계정·비밀번호는 지운다(live.js setupLogin 과 같은 규칙).
// 전송은 data/auth 의 `auth`(= transport T) 하나로만: 웹 쿠키 관문 또는 네이티브 B(앱 출처 + FhGate 있을 때만).
import { useEffect, useRef, useState } from 'react';
import { auth, gateOrigin, intent, safeNext } from '../data/auth';
import { useNote } from '../data/transport';
import { useRoute, whyProps } from './shell';
import { addProfile, KIND_TXT, loadProfiles, originFromText, saveProfiles, stepsOf, type Health, type Profile, type StepSt } from '../data/gate_profile';
import { canScan, ConnSteps, QrScan, ShareGate, SMALL } from './gateconn';

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
  // «바꾸기» → 서버 카드 아래 편집 줄(같은 카드 틀·기존 .inp). 웹·네이티브 공통: 저장한 프로필 · 붙여넣기 · QR 스캔(카메라 있을 때) · 이 관문 주소 QR/공유.
  // 1차 형식 검사 = gateOrigin. 네이티브는 setGate(최종 검사·세대 변경), 웹은 그 주소의 로그인 화면으로 이동(교차 출처 요청 0). 저장 ≠ 연결 확인.
  const [ed, setEd] = useState<{ open: boolean; busy: boolean; err: string }>({ open: false, busy: false, err: '' });
  const [profs, setProfs] = useState<Profile[]>(loadProfiles), [scan, setScan] = useState(false), [urls, setUrls] = useState<string[]>([]);
  const [hl, setHl] = useState<Health | null>(null), [loginBad, setLoginBad] = useState(false);
  const gin = useRef<HTMLInputElement>(null), chg = useRef<HTMLAnchorElement | null>(null);
  // 로그인 불요 검사 1회(재시도 0). 검사 번호는 로그인 intent 와 따로 — 로그인 시도가 검사 결과를 «확인 중» 으로 남기지 않게. 떠나거나 새 검사면 옛 결과 버림
  const hc = useRef(0);
  const check = async () => { const my = ++hc.current; setHl(null); const h = await auth.health(); if (my === hc.current) setHl(h); };
  useEffect(() => { check(); return () => { hc.current++; }; }, []);
  useEffect(() => {   // 보낼 주소: 웹은 지금 주소 + 관문이 아는 LAN 주소(/api/hosts, 로그인 불요), 네이티브는 지금 관문
    if (auth.kind === 'native') { setUrls(where.startsWith('관문 · ') ? [where.slice(5)] : []); return; }
    const own = gateOrigin(location.origin); const base = 'origin' in own ? [own.origin] : [];
    setUrls(base);
    fetch('api/hosts', { cache: 'no-store', credentials: 'omit' }).then((r) => (r.ok ? r.json() : null)).then((d) => {
      const more = Array.isArray(d?.urls) ? d.urls.map((u: unknown) => originFromText(String(u))).filter((g: any) => 'origin' in g).map((g: any) => g.origin as string) : [];
      setUrls([...new Set([...base, ...more])]);
    }).catch(() => {});
  }, [where]);
  const close = () => { setScan(false); setEd({ open: false, busy: false, err: '' }); chg.current?.focus(); };
  const keep = (o: string) => { const l = addProfile(profs, o); setProfs(l); return saveProfiles(l); };
  const change = async () => {
    if (ed.busy) return;
    const g = gateOrigin(gin.current?.value.trim() || '');
    if ('why' in g) { setEd((e) => ({ ...e, err: g.why })); gin.current?.focus(); return; }
    if (!auth.setGate) {   // 웹: 같은 주소면 그대로, 다른 주소면 확인 뒤 그 관문의 로그인 화면으로
      const kept = keep(g.origin) ? '이 기기에 저장됨' : '저장 안 됨(브라우저 저장소 막힘)';
      if (g.origin === location.origin) { setMsg({ t: `지금 연 주소입니다 · ${kept}`, ok: true }); close(); return; }
      if (confirm(`${g.origin} 로 이동할까요?\n· 그 관문의 로그인 화면이 열립니다\n· ${kept} — 연결 확인은 이동한 뒤`)) location.assign(`${g.origin}/#/${phone ? 'MLogin' : 'PcLogin'}`);
      return;
    }
    const my = ++intent.n; busy.current = false;
    setEd({ open: true, busy: true, err: '' });
    const err = await auth.setGate(g.origin);
    if (my !== intent.n) return;   // 그 사이 다른 요청·화면 떠남
    if (err) { setEd({ open: true, busy: false, err }); requestAnimationFrame(() => gin.current?.focus()); return; }
    keep(g.origin); setLoginBad(false);
    setMsg({ t: '관문 주소 저장됨 — 아래 단계에서 연결 확인 뒤 로그인', ok: true }); close();
    const w = await auth.where(); if (my === intent.n) setWhere(w);
    check();
  };
  const paste = async () => {
    try { const t = await navigator.clipboard.readText(), g = originFromText(t); if ('why' in g) return setEd((e) => ({ ...e, err: `붙여넣은 글 · ${g.why}` })); if (gin.current) gin.current.value = g.origin; setEd((e) => ({ ...e, err: '' })); }
    catch (e) { setEd((x) => ({ ...x, err: `붙여넣기 안 됨(${(e as Error).name || e}) — 입력칸을 길게 눌러 붙여넣기` })); }
  };
  const cur = where.startsWith('관문 · ') ? where.slice(5) : auth.kind === 'web' ? location.origin : '';
  const hasOrigin = auth.kind === 'web' ? auth.gated : !!cur;
  const st4 = stepsOf(hl, hasOrigin, auth.kind === 'web'), steps: StepSt[] = [...st4, loginBad ? 'bad' : 'unk', 'unk'];
  const stepWhy = !hasOrigin ? (auth.kind === 'web' ? '보호 주소(https)가 아님 — 관문 주소로 여세요' : '관문 주소 없음 — «바꾸기»') : hl && !hl.ok ? hl.why : hl ? '로그인·링크는 로그인 뒤 조종 화면에서 확인' : '확인 중…';
  const editor = ed.open ? (
    <div role="group" aria-label="관문 주소 바꾸기" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 14px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--panel)' }}>
      {profs.length > 0 && <div role="list" aria-label="저장한 접속 프로필" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span className="lbl" style={{ fontSize: 12 }}>저장한 주소(이 기기 · 주소만)</span>
        {profs.map((p) => <div role="listitem" key={p.id} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button type="button" style={{ ...SMALL, flex: 1, textAlign: 'left', color: 'inherit', overflowWrap: 'anywhere' }} onClick={() => { if (gin.current) gin.current.value = p.origin; setEd((e) => ({ ...e, err: '' })); }}>
            {`${KIND_TXT[p.kind]} · ${p.origin}${p.origin === cur ? ' · 지금' : ''}`}</button>
          <button type="button" aria-label={`${p.origin} 지우기`} style={{ ...SMALL, minWidth: 44, padding: 0 }} onClick={() => { const l = profs.filter((q) => q.id !== p.id); setProfs(l); saveProfiles(l); }}>✕</button>
        </div>)}</div>}
      <label className="lbl" htmlFor="gate-origin" style={{ fontSize: 12 }}>관문 주소 · https://호스트:포트</label>
      <input id="gate-origin" ref={gin} className="inp" type="url" inputMode="url" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={200}
        defaultValue={cur} placeholder="https://관문주소:포트" disabled={ed.busy} aria-invalid={!!ed.err} aria-describedby="gate-err"
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); change(); } else if (e.key === 'Escape') { e.preventDefault(); close(); } }} />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {typeof navigator !== 'undefined' && !!navigator.clipboard?.readText && <button type="button" style={SMALL} disabled={ed.busy} onClick={paste}>붙여넣기</button>}
        {canScan() && !scan && <button type="button" style={SMALL} disabled={ed.busy} onClick={() => setScan(true)}>QR 스캔</button>}
      </div>
      {scan && <QrScan onOrigin={(o) => { setScan(false); if (gin.current) gin.current.value = o; setEd((e) => ({ ...e, err: '' })); }} onClose={(w) => { setScan(false); if (w) setEd((e) => ({ ...e, err: w })); }} />}
      <div id="gate-err" role="alert" style={{ minHeight: 18, fontSize: 13, color: 'var(--bad, #FF5A4F)', overflowWrap: 'anywhere' }}>{ed.busy ? '주소 저장 중…' : ed.err}</div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        <button type="button" style={{ ...EDB, background: 'transparent', color: 'var(--accent)', border: '1px solid var(--line2)' }} onClick={close} disabled={ed.busy}>취소</button>
        <button type="button" style={{ ...EDB, background: 'var(--accent)', color: 'var(--on-accent)', border: 0 }} onClick={change} disabled={ed.busy}>{auth.setGate ? '주소 저장' : '이 주소로 열기'}</button>
      </div>
      {urls.length > 0 && <details><summary style={{ cursor: 'pointer', minHeight: 32, fontSize: 13, color: 'var(--accent)' }}>이 관문 주소 보내기(QR·공유)</summary><ShareGate urls={urls} /></details>}
    </div>) : null;
  const gateEd = <><ConnSteps st={steps} why={stepWhy} ms={hl?.ok ? hl.ms : null} />{editor}</>;
  const go = async (e: React.SyntheticEvent) => {
    e.preventDefault(); if (busy.current) return;
    if (!auth.gated) return setMsg({ t: '보호 주소(https://관문주소:포트)에서만 로그인할 수 있습니다' });
    const u = id.current?.value.trim() || '', p = pw.current?.value || '';
    if (!u || !p) return setMsg({ t: '계정과 비밀번호를 넣으세요' });
    busy.current = true; setMsg({ t: '확인 중…' }); const my = ++intent.n;
    const r = await auth.login(u, p, dv.current ? dv.current.value : phone ? '휴대폰' : '');
    if (my !== intent.n) return;   // 그 사이 로그아웃·화면 떠남·새 요청 → 옛 결과 버림
    if (r.ok) { setMsg({ t: '로그인됨 — 여는 중', ok: true }); location.replace(next); location.reload(); return; }   // 새로 읽어 링크도 새 세션으로
    busy.current = false; setLoginBad(true); setMsg({ t: r.error });
  };
  const ids = phone ? ['mid', 'mpw'] : ['id', 'pw'];
  return {
    formP: { onSubmit: go, noValidate: true },
    dotP: auth.gated ? {} : { style: { color: 'var(--warn)' } },
    srvA: where || '확인 중…',
    srvB: auth.kind === 'native' ? '앱이 관문 인증서를 확인(토큰은 기기에만)' : auth.gated ? '이 PC 의 자체 인증서 · 경고가 뜨면 관문 ca.crt 설치' : '보호 주소(https)가 아님 — 로그인 안 됨',
    chgP: { href: undefined, role: 'button', tabIndex: 0, ref: chg, 'aria-expanded': ed.open, 'aria-controls': 'gate-origin',
      onClick: (e: React.SyntheticEvent) => { e.preventDefault(); if (ed.busy) return; if (ed.open) close(); else { setEd({ open: true, busy: false, err: '' }); requestAnimationFrame(() => gin.current?.focus()); } },
      onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); (e.currentTarget as HTMLElement).click(); } } },
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
