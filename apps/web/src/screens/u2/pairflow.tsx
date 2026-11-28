// 로봇 추가 흐름 = 시안 u2_1_scan → u2_2_confirm → u2_3_done (막힘 u2_4_check_blocked). 시안 body 를 그대로 옮기고 고정 글 자리만 서버 값.
// 짝 맺기 API 는 기존 그대로: 6 자리 = POST /pairing/claim, 「연결하기」 = POST /pairing/{id}/confirm. 연결 키는 로봇 쪽 연결 프로그램만 받는다.
// QR 칸: 폰이 QR 을 띄우는 offer 경로(#603)가 바탕에 들어오면 켠다. 그전에는 QR 그림을 꾸며 넣지 않는다.
// u2_5_net_blocked(현장 Wi-Fi 로그인 필요)는 서버 · 로봇이 그 상태를 알려 주는 값이 없어 아직 들어갈 길이 없다(서버 값 요청).
import { Fragment, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { PairingClaimed, RobotSummary } from '../../../../contracts/ts/index';
import { api, ApiFail } from '../../api';
import { ROLE_NAME, type User } from '../../fake';
import { MAKING, OS_NAME, WHY, myOs, useInstallers } from '../../pairing';
import '../../proto/u2.pv.css';
import './u2.css';

const ROBOT_IMG = '/proto-assets/assets/real/go2_34_tight.png';
const NOPE = '확인 안 됨';
const NOT_FOUND = '코드가 맞지 않거나, 10분이 지났거나, 이미 쓴 코드입니다. 노트북 화면의 새 코드로 다시 하세요.';
const failText = (e: unknown) => {
  const f = e as ApiFail;
  if (f.code === 'PAIRING_NOT_FOUND' || f.status === 404) return NOT_FOUND;
  if (f.code === 'ROBOT_ALREADY_PAIRED') return '이 로봇은 다른 운영 관리자가 담당하고 있습니다. 담당 운영 관리자에게 넘겨받기 또는 삭제를 요청하세요.';
  if (f.status === 403) return '운영 관리자 계정으로 로그인해야 로봇을 연결할 수 있습니다.';
  return f.message;
};
/** 서버에 닿지 못함(망 끊김 · 시간 초과) = 시안 u2_4 「서버가 응답하지 않습니다」 */
const lost = (e: unknown) => { const f = e as ApiFail; return f.status === 0 && (f.code === 'NETWORK' || f.code === 'TIMEOUT'); };

type At = { at: 'scan' } | { at: 'confirm'; p: PairingClaimed } | { at: 'done'; r: RobotSummary } | { at: 'blocked'; back: At };

const Ok = () => <svg className="ic" viewBox="0 0 24 24" style={{ width: '16px', height: '16px' }}><circle cx="12" cy="12" r="9" /><path d="M8 12.5l2.6 2.6L16 9.5" /></svg>;
const Wait = () => <svg className="ic" viewBox="0 0 24 24" style={{ width: '16px', height: '16px' }}><circle cx="12" cy="12" r="9" /></svg>;
const Bad = () => <svg className="ic" viewBox="0 0 24 24" style={{ width: '16px', height: '16px' }}><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.5M12 16.2v.01" /></svg>;
const Wifi = ({ s = 16 }: { s?: number }) => <svg className="ic" viewBox="0 0 24 24" style={{ width: `${s}px`, height: `${s}px` }}><path d="M12 20h.01" /><path d="M2 8.82a15 15 0 0 1 20 0" /><path d="M5 12.859a10 10 0 0 1 14 0" /><path d="M8.5 16.429a5 5 0 0 1 7 0" /></svg>;

function Top({ n, dark, back, title }: { n?: number; dark?: boolean; back: () => void; title?: string }) {
  return <div className={`g${dark ? ' dk' : ''} top`}><span className="bk" role="button" tabIndex={0} aria-label="뒤로" data-u2-back onClick={back}><svg className="ic" viewBox="0 0 24 24" style={{ width: '18px', height: '18px' }}><path d="M15 6l-6 6 6 6" /></svg></span>
    <b>{title ?? '로봇 연결'}</b>
    {n != null && <><span className="steps">{[1, 2, 3].map((i) => <i key={i} className={i <= n ? 'on' : ''} />)}</span><span style={{ fontSize: '11.5px', fontWeight: '700', opacity: '.6' }}>{n} / 3</span></>}</div>;
}

/** 폰 틀(844 × 390) 을 창 가운데에 맞춰 크게. 로봇 탭(.proto) 밖 body 로 띄워 시안 u4 css 가 섞이지 않게 한다 */
function Frame({ children, close, at }: { children: ReactNode; close: () => void; at: string }) {
  const [s, setS] = useState(1);
  useEffect(() => {
    const fit = () => setS(Math.min((innerWidth * 0.86) / 844, (innerHeight * 0.86) / 390));
    fit(); addEventListener('resize', fit); return () => removeEventListener('resize', fit);
  }, []);
  return createPortal(<div className="u2-veil" onClick={(e) => { if (e.target === e.currentTarget) close(); }} data-u2-veil>
    <div className="u2-box" style={{ width: 844 * s, height: 390 * s }}>
      <div className="u2" style={{ transform: `scale(${s})` }} role="dialog" aria-label="로봇 연결" data-u2={at}>{children}</div>
    </div></div>, document.body);
}

export function PairFlow({ user, mine, close, done, cancel }: { user: User; mine: string[]; close: () => void; done: (id: string | null) => void; cancel?: AbortSignal }) {
  const [st, setSt] = useState<At>({ at: 'scan' }), [code, setCode] = useState(''), [name, setName] = useState(''), [busy, setBusy] = useState(false), [msg, setMsg] = useState('');
  const want = useRef(''), inp = useRef<HTMLInputElement>(null), inst = useInstallers(cancel), os = myOs();
  const rows = [...(inst.items ?? [])].sort((a, b) => Number(b.platform === os) - Number(a.platform === os));
  useEffect(() => () => { want.current = ''; }, []);
  useEffect(() => { if (st.at === 'scan') inp.current?.focus(); }, [st.at]);
  const me = user.role === 'ORG_ADMIN' ? '나 · 총괄' : `나 · ${ROLE_NAME[user.role]}`;
  const claim = async (c: string) => {
    if (busy || !/^\d{6}$/.test(c)) return;
    want.current = c; setBusy(true); setMsg('');
    try {
      const p = await api.claimPairing(c, cancel);
      if (want.current !== c) return;
      setName(`Go2-${p.robot_serial.replace(/\D/g, '').slice(-4)}`);
      setSt({ at: 'confirm', p });
    } catch (e) {
      if (want.current !== c || (e as ApiFail).code === 'CANCELED') return;
      if (lost(e)) setSt({ at: 'blocked', back: { at: 'scan' } }); else setMsg(failText(e));
    } finally { setBusy(false); }
  };
  const confirm = async (e: FormEvent | null, p: PairingClaimed) => {
    e?.preventDefault();
    if (busy) return;
    const n = name.trim();
    if (!n) return setMsg('로봇 이름을 넣으세요.');
    setBusy(true); setMsg('');
    try { setSt({ at: 'done', r: await api.confirmPairing(p.pairing_id, n, cancel) }); }
    catch (err) {
      const f = err as ApiFail;
      if (f.code === 'CANCELED') return;
      if (lost(err)) return setSt({ at: 'blocked', back: st });
      if (f.status === 404) { setSt({ at: 'scan' }); setCode(''); }
      setMsg(failText(err));
    } finally { setBusy(false); }
  };

  if (st.at === 'scan') return <Frame close={close} at="u2_1_scan">
    <div className="bgcam" /><Top n={1} dark back={close} />
    <div className="g" style={{ left: '12px', top: '68px', bottom: '12px', width: '404px', borderRadius: '22px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }} data-u2-qr>
      {/* QR 자리: offer 가 들어오면 QR. 그전에는 6 자리 코드를 띄우는 로봇 연결 프로그램 받기(옛 추가 창의 설치 파일 받기를 이 칸으로) */}
      <div style={{ background: '#fff', borderRadius: '14px', padding: '14px 16px', boxShadow: 'inset 0 0 0 1px rgba(0,0,0,.05)', width: '360px', textAlign: 'left' }} data-installer>
        <div style={{ fontSize: '13px', fontWeight: '800' }}>노트북에 연결 프로그램이 없나요?</div>
        {inst.fail ? <div className="u2-why" role="status" data-installer-fail>{inst.fail}</div>
          : !inst.items ? <div className="u2-why" role="status">설치 파일을 확인하는 중</div>
          : rows.map((i) => <div key={i.platform} className="u2-os" data-os={i.platform} data-mine={i.platform === os || undefined}>
            <span>{OS_NAME[i.platform]}{i.platform === os ? ' (이 노트북)' : ''}
              {i.platform === 'windows' && i.available && <small>처음 실행 때 「Windows의 PC 보호」 가 뜨면 「추가 정보 → 실행」</small>}</span>
            {i.available ? <a href={`/api/v1/robot-installer/${i.platform}`} download={i.filename}>받기 ({(i.size / 1048576).toFixed(1)} MB)</a>
              : <em data-why>{MAKING.has(i.reason) ? '만드는 중 · 잠시 뒤 다시' : WHY[i.reason] ?? '아직 받을 수 없습니다.'}</em>}</div>)}
        <ol className="u2-why" data-installer-steps><li>받은 파일을 더블클릭해 설치</li><li>랜선을 로봇에 꽂기</li><li>노트북 화면의 6 자리 코드를 오른쪽 칸에 넣기</li></ol>
        <div className="u2-why" data-agent-open><a href="foothold-robot://open">노트북 연결 프로그램 열기</a> · 안 열리면 아직 설치하지 않은 것입니다</div>
      </div>
      <div className="row" style={{ gap: '6px', justifyContent: 'center', fontSize: '11.5px', fontWeight: '700', color: 'var(--mu)', marginTop: '10px' }}><svg className="ic" viewBox="0 0 24 24" style={{ width: '14px', height: '14px' }}><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></svg>코드는 10 분 · 1 회용</div>
    </div>
    <div className="g dk" style={{ left: '428px', right: '12px', top: '68px', bottom: '12px', padding: '16px 18px', borderRadius: '22px' }}>
      <div className="stp"><i>1</i>현장 Wi-Fi 고르기</div>
      <div className="field2" data-u2-wifi><Wifi />{NOPE}<span style={{ marginLeft: 'auto', fontSize: '11px', fontWeight: '600', opacity: '.6' }}>노트북 연결 프로그램에서</span></div>
      <div className="stp" style={{ marginTop: '14px' }}><i>2</i>폰 화면을 로봇 얼굴 카메라에 비추기</div>
      <div className="howto">
        <svg className="ph" viewBox="0 0 84 46"><rect x="1.5" y="1.5" width="81" height="43" rx="8" fill="#e9edf1" stroke="rgba(255,255,255,.7)" strokeWidth="1.5" /><rect x="8" y="7" width="32" height="32" rx="3" fill="#fff" />
          <g fill="#1b2027"><rect x="10" y="9" width="9" height="9" /><rect x="29" y="9" width="9" height="9" /><rect x="10" y="28" width="9" height="9" /><rect x="22" y="21" width="3" height="3" /><rect x="29" y="28" width="3" height="3" /><rect x="34" y="33" width="3" height="3" /><rect x="22" y="30" width="4" height="4" /></g>
          <rect x="46" y="9" width="30" height="5" rx="2.5" fill="#c3cad1" /><rect x="46" y="19" width="22" height="5" rx="2.5" fill="#c3cad1" /></svg>
        <div className="beam"><span>약 30 cm</span></div>
        <div className="bot"><img src={ROBOT_IMG} alt="" /><b className="cam" /></div>
        <div className="wait"><span style={{ width: '16px', height: '16px', borderRadius: '50%', border: '2.2px solid rgba(24,160,126,.25)', borderTopColor: 'var(--pr)', flex: 'none' }} /><span>{busy ? '확인 중' : 'QR 준비 중'}<small>{busy ? '코드를 서버에 묻는 중' : '아래 6 자리로 연결'}</small></span></div>
      </div>
      <form className="row" style={{ gap: '12px', marginTop: '12px', alignItems: 'flex-end' }} noValidate onSubmit={(e) => { e.preventDefault(); claim(code); }}>
        <label style={{ position: 'relative', cursor: 'text' }}><div className="lab" style={{ marginTop: '0' }}>노트북 화면의 6 자리 코드</div>
          <div className="digits" data-u2-digits>{[0, 1, 2, 3, 4, 5].map((i) => <Fragment key={i}><b className={i === code.length && !busy ? 'cur' : ''}>{code[i] ?? ''}</b>{i === 2 && <i />}</Fragment>)}</div>
          <input ref={inp} className="u2-code" value={code} disabled={busy} inputMode="numeric" autoComplete="one-time-code" maxLength={6} aria-label="6 자리 코드" data-pair-code
            onChange={(e) => { want.current = ''; setMsg(''); const v = e.target.value.replace(/\D/g, '').slice(0, 6); setCode(v); if (v.length === 6) claim(v); }} /></label>
      </form>
      {msg && <p className="u2-msg" role="alert">{msg}</p>}
    </div>
  </Frame>;

  if (st.at === 'confirm') {
    const p = st.p;
    return <Frame close={close} at="u2_2_confirm">
      <div className="bgcam" /><Top n={2} dark back={() => { setSt({ at: 'scan' }); setCode(''); setMsg(''); }} />
      <div className="g pill" style={{ left: '50%', top: '17px', transform: 'translateX(-50%)', color: 'var(--ink)' }}><svg className="ic" viewBox="0 0 24 24" style={{ width: '16px', height: '16px', color: 'var(--pr)' }}><circle cx="12" cy="12" r="9" /><path d="M8 12.5l2.6 2.6L16 9.5" /></svg>로봇이 코드를 확인했습니다</div>
      <div className="g" style={{ left: '12px', top: '68px', bottom: '12px', width: '404px', padding: '20px 22px', borderRadius: '22px' }}>
        <div style={{ display: 'flex', gap: '18px' }}>
          <div style={{ width: '104px', height: '104px', borderRadius: '18px', background: 'linear-gradient(180deg,#f4f6f8,#e3e7ec)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--ink)', flex: 'none', boxShadow: 'inset 0 1px 0 #fff' }}>
            <img src={ROBOT_IMG} alt="Go2" style={{ width: '96px', height: '96px', objectFit: 'contain', filter: 'drop-shadow(0 6px 8px rgba(20,30,50,.18))' }} /></div>
          <div style={{ flex: '1' }}>
            <div className="h">이 로봇이 맞나요?</div>
            <div className="sub">로봇 몸통 아래 기체번호와 같은지 보세요.</div>
            <dl className="kv" data-pair-check><dt>기종</dt><dd data-u2-model>{NOPE}</dd><dt>기체번호</dt><dd data-pair-serial>{p.robot_serial}</dd><dt>담당</dt><dd>{me}</dd></dl>
          </div></div>
        <div className="chk" style={{ position: 'absolute', left: '14px', right: '14px', bottom: '14px', paddingTop: '8px', borderTop: '1px solid rgba(20,30,50,.08)' }}>
          <div className="ok"><Ok />로봇 연결 코드 확인<small /></div>
          <div className="wait"><Wait />Wi-Fi 추가 로그인<small>{NOPE}</small></div>
          <div className="ok"><Ok />서버 연결됨<small /></div>
        </div>
      </div>
      <form className="g" style={{ right: '12px', top: '68px', bottom: '12px', width: '404px', padding: '20px 22px', borderRadius: '22px' }} noValidate onSubmit={(e) => confirm(e, p)}>
        <div className="h">이름</div>
        <div className="sub">관제 화면과 알림에 이 이름으로 보입니다. 연결한 사람이 담당자가 됩니다.</div>
        <input className="field u2-name" style={{ marginTop: '14px', width: '100%' }} name="name" value={name} maxLength={128} autoComplete="off" aria-label="로봇 이름" onChange={(e) => setName(e.target.value)} />
        {msg && <p className="u2-msg" role="alert" style={{ color: '#b3262a' }}>{msg}</p>}
        <button type="submit" className="prim" style={{ left: '22px', right: '22px', bottom: '22px', height: '52px' }} disabled={busy} data-u2-connect>{busy ? '연결 중' : '연결하기'}</button>
      </form>
    </Frame>;
  }

  if (st.at === 'done') {
    const r = st.r, again = mine.includes(r.id), soc = r.battery?.soc;
    return <Frame close={() => done(r.id)} at="u2_3_done">
      <div className="bgmap" /><Top n={3} back={() => done(r.id)} />
      <div className="g" style={{ left: '12px', top: '68px', bottom: '12px', width: '404px', padding: '22px', borderRadius: '22px' }}>
        <div style={{ width: '46px', height: '46px', borderRadius: '50%', background: 'linear-gradient(180deg,#18a07e,#0e7f63)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', boxShadow: '0 8px 18px rgba(14,127,99,.35)' }}><svg className="ic" viewBox="0 0 24 24" style={{ width: '24px', height: '24px', strokeWidth: '2.4' }}><path d="M6 12.5l4 4L18 8" /></svg></div>
        <div className="h" style={{ marginTop: '14px' }} data-pair-done>{`${r.name} 을 연결했습니다`}</div>
        <div className="sub">{again ? '같은 로봇에 다시 연결했습니다. 옛 연결 키는 폐기됐고, 진행 중이던 조종은 정지 · 잠금됐습니다.' : '관제 화면 로봇 목록에도 추가되었습니다. 문제가 생기면 단계별로 점검해 알려 드립니다.'}</div>
        <div className="scanb" style={{ position: 'absolute', left: '22px', right: '22px', bottom: '84px', height: '44px', borderRadius: '14px', border: '1px solid rgba(14,127,99,.35)', background: 'rgba(14,127,99,.07)', color: '#0e7f63', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '7px', fontSize: '14px', fontWeight: '800' }}
          role="button" tabIndex={0} data-u2-scanmap onClick={() => { done(r.id); location.hash = '#/map'; }}><svg className="ic" viewBox="0 0 24 24" style={{ width: '17px', height: '17px' }}><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" /><path d="M7 12h10" /></svg>이 현장 지도 스캔하기</div>
        <div className="prim" style={{ left: '22px', right: '22px', bottom: '22px', height: '52px' }} role="button" tabIndex={0} data-u2-mine onClick={() => done(r.id)}>내 로봇 보기</div>
      </div>
      <div className="g kv2" style={{ left: '428px', right: '12px', top: '68px', bottom: '12px', padding: '12px 18px', borderRadius: '22px' }} data-u2-kv>
        <div><Wifi /><span>현장</span>{NOPE}<em /></div>
        <div><svg className="ic" viewBox="0 0 24 24" style={{ width: '16px', height: '16px' }}><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" /></svg><span>서버</span>연결됨<em /></div>
        <div><svg className="ic" viewBox="0 0 24 24" style={{ width: '16px', height: '16px' }}><path d="M12 20v2" /><path d="M12 2v2" /><path d="M17 20v2" /><path d="M17 2v2" /><path d="M2 12h2" /><path d="M2 17h2" /><path d="M2 7h2" /><path d="M20 12h2" /><path d="M20 17h2" /><path d="M20 7h2" /><path d="M7 20v2" /><path d="M7 2v2" /><rect x="4" y="4" width="16" height="16" rx="2" /><rect x="8" y="8" width="8" height="8" rx="1" /></svg><span>로봇</span>{r.connection === 'ONLINE' ? '로봇 프로그램 실행 중' : '로봇 프로그램 연결 기다리는 중'}<em /></div>
        <div><svg className="ic" viewBox="0 0 24 24" style={{ width: '16px', height: '16px' }}><path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z" /><path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12" /><path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17" /></svg><span>모드</span>{NOPE}<em /></div>
        <div><svg className="ic" viewBox="0 0 24 24" style={{ width: '16px', height: '16px' }}><rect x="3" y="7" width="16" height="10" rx="2" /><path d="M21 10.5v3" /></svg><span>배터리</span>{soc != null ? `${Math.round(soc)} %` : NOPE}<em /></div>
        <div><svg className="ic" viewBox="0 0 24 24" style={{ width: '16px', height: '16px' }}><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg><span>담당</span>{me}<em>연결한 사람</em></div>
      </div>
    </Frame>;
  }

  // 막힘(u2_4): 서버에 닿지 못함. 「다시 점검」 = 막힌 단계로 돌아가 다시
  const back = st.back;
  return <Frame close={close} at="u2_4_check_blocked">
    <div className="bgmap" /><Top back={() => setSt(back)} title="로봇 연결 순서 점검" />
    <div className="g" style={{ left: '12px', top: '68px', bottom: '12px', width: '404px', padding: '22px', borderRadius: '22px' }}>
      <div style={{ width: '46px', height: '46px', borderRadius: '50%', background: 'rgba(224,74,47,.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--red)' }}><svg className="ic" viewBox="0 0 24 24" style={{ width: '24px', height: '24px' }}><path d="M12 7v6M12 16.5v.01" /></svg></div>
      <div className="h" style={{ marginTop: '14px' }}>서버가 응답하지 않습니다</div>
      <div className="sub">이 컴퓨터에서 서버에 닿지 못했습니다. 망 연결을 확인한 뒤 다시 점검하세요. 그동안 앱으로는 조종할 수 없고 리모컨은 쓸 수 있습니다.</div>
      <div className="prim" style={{ left: '22px', right: '22px', bottom: '22px', height: '52px' }} role="button" tabIndex={0} data-u2-retry
        onClick={() => { setSt(back); if (back.at === 'scan' && code.length === 6) claim(code); }}>다시 점검</div>
    </div>
    <div className="g" style={{ left: '428px', right: '12px', top: '68px', bottom: '12px', padding: '12px 10px', borderRadius: '22px' }}>
      <div className="chk"><div className="wait"><Wait />Wi-Fi (Jetson)<small>{NOPE}</small></div><div className="bad"><Bad />서버<small>응답 없음</small></div>
        {['foothold-robot', '걷기 정책', '몸통', '센서', '배터리 · 관절'].map((k) => <div key={k} className="wait"><Wait />{k}<small /></div>)}</div>
    </div>
  </Frame>;
}
