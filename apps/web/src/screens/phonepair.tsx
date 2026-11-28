/** 폰 로봇 붙이기 확인 · 완료 = 시안 u2_2 · u2_3 (proto/screens/u2_2_confirm.html · u2_3_done.html). 마크업은 시안 body 를 옮긴 것(태그 · class · 순서 · 인라인 style 그대로), 단추 div · span 은 button.
 *  흐름 · 요청은 pairing.tsx AddRobot 그대로(claim 답 → 이름 form → confirm → 끝 · ScanStart). 이 파일은 꼴만 그린다. PC 와 코드 단계(u2_1)는 pairing.tsx 옛 카드 그대로.
 *  글은 시안 그대로이되 앱 사실과 다른 글은 앱 사실로: 시안은 폰이 QR 을 띄우고 로봇이 읽는 흐름이라 «로봇이 QR 을 읽었습니다» · «로봇 몸통 아래 기체번호» 를
 *  «코드를 확인했습니다» · «노트북 화면의 기체번호» 로, 완료 제목은 서버가 준 이름 그대로 «… 로봇을 등록했습니다.», 안내는 노트북 «연결됨» 뒤 조종권.
 *  받은 값만: 확인 칸은 claim 답(기체번호 · 만료 시각), 완료 오른쪽 칸은 confirm 답(서버 연결 · 상태 · 배터리 · 담당). 기종 · 현장 Wi-Fi · 모드 · 연결 점검 결과는 답에 없어 줄째 뺐다.
 *  시안 밖(같은 결로 새로 그림): «처음으로»(시안 .sec), 오류 한 줄(u2.app.css .u2-msg), 확인 칸 아래 줄 «서버가 코드를 확인함 · HH:MM 까지 등록» */
import type { FormEvent } from 'react';
import '../proto/ui.pv.css';
import '../proto/light.pv.css';
import './u2.css';
import './u2.app.css';
import { STATUS_NAME, ownerName, type Robot, type User } from '../fake';
import { useTheme } from '../theme';
import { ScanStart } from './scanentry';

const ASSET = '/proto-assets/assets/real/go2_34_tight.png';
const BACK = <svg className="ic" viewBox="0 0 24 24" style={{ width: '18px', height: '18px' }} aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg>;
const OK = (s: number, color?: string) => <svg className="ic" viewBox="0 0 24 24" style={{ width: `${s}px`, height: `${s}px`, ...(color ? { color } : {}) }} aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M8 12.5l2.6 2.6L16 9.5" /></svg>;
/** 시안 단계 막대(.steps + «n / 3») · 읽는 이에게는 «3 단계 중 n 단계» */
const Steps = ({ n }: { n: number }) => <span role="img" aria-label={`3 단계 중 ${n} 단계`} data-pair-steps style={{ display: 'contents' }}>
  <span className="steps">{[1, 2, 3].map((i) => <i key={i} className={i <= n ? 'on' : undefined} data-on={i <= n || undefined} />)}</span>
  <span style={{ fontSize: '11.5px', fontWeight: 700, opacity: 0.6 }}>{n} / 3</span></span>;
const hm = (iso: string) => { const d = new Date(iso); return isNaN(d.getTime()) ? '' : d.toTimeString().slice(0, 5); };

/** 확인(u2_2): 이름 form. submit = AddRobot confirm, restart = 코드 단계로, close = 닫기 */
export function PairName({ serial, expires, name, setName, busy, msg, submit, restart, close }: { serial: string; expires: string; name: string; setName: (v: string) => void;
  busy: boolean; msg: string; submit: (e: FormEvent) => void; restart: () => void; close: () => void }) {
  const light = useTheme()[1], until = hm(expires);
  return <section className={`proto pv u2 u22${light ? ' light' : ''}`} aria-label="새 로봇 추가" data-pair="name">
    <div className="bgcam" />
    <div className="g dk top"><button type="button" className="bk" aria-label="닫기" onClick={close}>{BACK}</button><b>로봇 연결</b><Steps n={2} /></div>
    <div className="g pill" style={{ left: '50%', top: '17px', transform: 'translateX(-50%)', color: 'var(--ink)' }}>{OK(16, 'var(--pr)')}코드를 확인했습니다</div>
    <form className="u2-form" noValidate onSubmit={submit}>
      <div className="g" style={{ left: '12px', top: '68px', bottom: '12px', width: '404px', padding: '20px 22px', borderRadius: '22px' }}>
        <div style={{ display: 'flex', gap: '18px' }}>
          <div style={{ width: '104px', height: '104px', borderRadius: '18px', background: 'linear-gradient(180deg,#f4f6f8,#e3e7ec)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--ink)', flex: 'none', boxShadow: 'inset 0 1px 0 #fff' }}>
            <img src={ASSET} alt="" style={{ width: '96px', height: '96px', objectFit: 'contain', filter: 'drop-shadow(0 6px 8px rgba(20,30,50,.18))' }} /></div>
          <div style={{ flex: 1 }}>
            <div className="h">이 로봇이 맞나요?</div>
            <div className="sub">노트북 화면의 기체번호와 같은지 보세요. 다르면 «처음으로».</div>
            <dl className="kv" data-pair-check><div><dt>기체번호</dt><dd data-pair-serial>{serial}</dd></div><div><dt>담당</dt><dd>나 (등록하는 사람)</dd></div></dl>
          </div></div>
        <div className="chk" style={{ position: 'absolute', left: '14px', right: '14px', bottom: '14px', paddingTop: '8px', borderTop: '1px solid rgba(20,30,50,.08)' }}>
          <div className="ok">{OK(16)}서버가 코드를 확인함<small>{until && `${until} 까지 등록`}</small></div>
        </div>
      </div>
      <div className="g" style={{ right: '12px', top: '68px', bottom: '12px', width: '404px', padding: '20px 22px', borderRadius: '22px' }}>
        <div className="h">이름</div>
        <div className="sub">관제 화면과 알림에 이 이름으로 보입니다. 연결한 사람이 담당자가 됩니다.</div>
        <input className="field" style={{ marginTop: '14px' }} name="name" aria-label="로봇 이름" value={name} maxLength={128} autoComplete="off" onChange={(e) => setName(e.target.value)} />
        {msg && <p className="u2-msg" role="alert">{msg}</p>}
        <button type="button" className="sec" style={{ left: '22px', bottom: '22px', width: '112px', height: '52px' }} disabled={busy} onClick={restart}>처음으로</button>
        <button type="submit" className="prim" style={{ left: '146px', right: '22px', bottom: '22px', height: '52px' }} disabled={busy}>{busy ? '연결하는 중…' : '연결하기'}</button>
      </div>
    </form>
  </section>;
}

const IC = {
  server: <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />,
  robot: <><path d="M12 20v2" /><path d="M12 2v2" /><path d="M17 20v2" /><path d="M17 2v2" /><path d="M2 12h2" /><path d="M2 17h2" /><path d="M2 7h2" /><path d="M20 12h2" /><path d="M20 17h2" /><path d="M20 7h2" /><path d="M7 20v2" /><path d="M7 2v2" /><rect x="4" y="4" width="16" height="16" rx="2" /><rect x="8" y="8" width="8" height="8" rx="1" /></>,
  battery: <><rect x="3" y="7" width="16" height="10" rx="2" /><path d="M21 10.5v3" /></>,
  owner: <><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></>,
};
const Row = ({ ic, k, v, em = '' }: { ic: JSX.Element; k: string; v: string; em?: string }) =>
  <div><svg className="ic" viewBox="0 0 24 24" style={{ width: '16px', height: '16px' }} aria-hidden="true">{ic}</svg><span>{k}</span>{v}<em>{em}</em></div>;

/** 완료(u2_3): 등록 안내(data-pair-done) · 지도 스캔(ScanStart 그대로) · 내 로봇 보기(= 옛 «내 로봇으로») · 오른쪽 = confirm 답 */
export function PairDone({ name, again, robot, user, scan, toMine, close }: { name: string; again: boolean; robot: Robot; user?: User; scan: () => void; toMine: () => void; close: () => void }) {
  const light = useTheme()[1];
  return <section className={`proto pv u2 u23${light ? ' light' : ''}`} aria-label="새 로봇 추가" data-pair="done">
    <div className="bgmap" />
    <div className="g top"><button type="button" className="bk" aria-label="닫기" onClick={close}>{BACK}</button><b>로봇 연결</b><Steps n={3} /></div>
    <div className="g" style={{ left: '12px', top: '68px', bottom: '12px', width: '404px', padding: '22px', borderRadius: '22px' }}>
      <div style={{ width: '46px', height: '46px', borderRadius: '50%', background: 'linear-gradient(180deg,#18a07e,#0e7f63)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', boxShadow: '0 8px 18px rgba(14,127,99,.35)' }}>
        <svg className="ic" viewBox="0 0 24 24" style={{ width: '24px', height: '24px', strokeWidth: 2.4 }} aria-hidden="true"><path d="M6 12.5l4 4L18 8" /></svg></div>
      <div role="status" data-pair-done>
        <div className="h" style={{ marginTop: '14px' }}>{again ? `${name} · 기존 로봇에 다시 연결했습니다.` : `${name} 로봇을 등록했습니다.`}</div>
        <div className="sub">{again ? '옛 연결 키는 폐기됐고, 진행 중이던 조종은 정지·잠금됐습니다. ' : ''}노트북 화면에 «연결됨»이 뜨면 내 로봇에서 조종권을 잡으세요.</div>
      </div>
      {user && <ScanStart user={user} robots={[robot]} label="이 현장 지도 스캔하기" start={scan} look={{ cls: 'scanb', noCls: 'sub u2-no',
        style: { position: 'absolute', left: '22px', right: '22px', bottom: '84px', height: '44px', borderRadius: '14px', border: '1px solid rgba(14,127,99,.35)', background: 'rgba(14,127,99,.07)', color: '#0e7f63', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '7px', fontSize: '14px', fontWeight: 800 },
        icon: <svg className="ic" viewBox="0 0 24 24" style={{ width: '17px', height: '17px' }} aria-hidden="true"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" /><path d="M7 12h10" /></svg> }} />}
      <button type="button" className="prim" style={{ left: '22px', right: '22px', bottom: '22px', height: '52px' }} onClick={toMine}>내 로봇 보기</button>
    </div>
    <div className="g kv2" style={{ left: '428px', right: '12px', top: '68px', bottom: '12px', padding: '12px 18px', borderRadius: '22px' }} aria-label="연결한 로봇">
      <Row ic={IC.server} k="서버" v={robot.online ? '연결됨' : '아직 연결 전'} em={robot.online ? '' : '노트북 연결 뒤'} />
      {robot.status && <Row ic={IC.robot} k="로봇" v={STATUS_NAME[robot.status]} />}
      {robot.battery != null && <Row ic={IC.battery} k="배터리" v={`${robot.battery} %`} />}
      <Row ic={IC.owner} k="담당" v={ownerName(robot)} em={user && robot.owner === user.id ? '연결한 사람' : ''} />
    </div>
  </section>;
}
