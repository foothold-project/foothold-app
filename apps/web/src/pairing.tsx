// 실기 로봇 연결(ROBOT-PAIRING, 05 §3.1). 운영 관리자: 새 로봇 추가(QR·6자리 → 이름(기본값·기체번호 작게) → 끝, RB-EASY-PAIR) → 내 로봇 관리(이름·연결 끊기·지우기).
// 총괄은 실기 로봇에 쓰기가 없다 — 담당 없는 실기의 담당 지정만(AssignOwner). 연결 키는 화면에 오지 않는다(노트북 연결 프로그램이 poll 로 한 번 받음).
// 담당 넘기기(TransferOwner): 내 로봇 관리 안 — 넘길 대상 목록(owner-candidates) → 같은 화면 확인 → PATCH owner_user_id.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { PairingClaimed, RobotInstallerInfo, RobotOwnerCandidate, User as ApiUser } from '../../contracts/ts';
import { api, type ApiFail } from './api';
import { PHONE_Q } from './App';
import type { Robot } from './fake';
import { Chip, inApp } from './screens';
import { OwnerSelect, robotFail } from './screens/settings';

type Cancel = { cancel?: AbortSignal };
const QR = /^foothold-pair:(\d{6})$/;

const NOT_FOUND = '코드가 맞지 않거나, 10분이 지났거나, 이미 쓴 코드입니다. 노트북 화면의 새 코드로 다시 하세요.';
const pairFail = (e: unknown) => {
  const f = e as ApiFail;
  if (f.code === 'PAIRING_NOT_FOUND' || f.status === 404) return NOT_FOUND;
  if (f.code === 'ROBOT_ALREADY_PAIRED') return '이 로봇은 다른 운영 관리자가 담당하고 있습니다. 담당 운영 관리자에게 넘겨받기 또는 삭제를 요청하세요.';
  if (f.status === 403) return '운영 관리자 계정으로 로그인해야 로봇을 연결할 수 있습니다.';
  return f.message;
};

/** 브라우저 카메라로 QR(foothold-pair:<6자리>) 읽기 — 내장 BarcodeDetector 만(새 라이브러리 없음). 안 되면 이유를 보이고 6자리 입력으로. 찾으면 카메라를 끈다 */
function Scan({ found, close, at }: { found: (code: string) => void; close: () => void; at: string }) {
  const v = useRef<HTMLVideoElement>(null), hit = useRef(found), [why, setWhy] = useState('');
  hit.current = found;
  useEffect(() => {
    const D = (window as { BarcodeDetector?: new (o: { formats: string[] }) => { detect: (s: HTMLVideoElement) => Promise<{ rawValue: string }[]> } }).BarcodeDetector;
    if (!D || !navigator.mediaDevices?.getUserMedia) { setWhy(`이 브라우저는 QR 읽기를 지원하지 않습니다. 노트북 화면의 6자리 코드를 ${at} 넣으세요.`); return; }
    let stream: MediaStream | null = null, timer = 0, off = false;
    const det = new D({ formats: ['qr_code'] });
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false }).then((s) => {
      if (off) { s.getTracks().forEach((t) => t.stop()); return; }
      stream = s;
      const el = v.current!;
      el.srcObject = s; el.play().catch(() => {});
      const look = async () => {
        if (off) return;
        try { for (const b of await det.detect(el)) { const m = QR.exec(b.rawValue.trim()); if (m) { off = true; stream?.getTracks().forEach((t) => t.stop()); hit.current(m[1]); return; } } } catch { /* 영상 준비 전 */ }
        timer = window.setTimeout(look, 300);
      };
      look();
    }, () => setWhy(`카메라를 쓸 수 없습니다(권한 거부·카메라 없음). 노트북 화면의 6자리 코드를 ${at} 넣으세요.`));
    return () => { off = true; clearTimeout(timer); stream?.getTracks().forEach((t) => t.stop()); };
  }, []);
  return <div className="fh-form" data-scan>
    {why ? <p className="fh-why" role="status" data-scan-why>{why}</p>
      : <video ref={v} muted playsInline aria-label="QR 카메라" style={{ width: '100%', maxHeight: 280, background: '#000', borderRadius: 8 }} />}
    <button type="button" className="btn" onClick={close}>카메라 닫기</button>
  </div>;
}

type Os = RobotInstallerInfo['items'][number]['platform'];
const OS_NAME: Record<Os, string> = { linux: 'Ubuntu 노트북', windows: '윈도우 노트북' };
/** 서버가 아직 만드는 중(첫 info 요청이 빌드를 시작 — not_built 는 곧 building) → 10초마다 다시 묻는다 */
const MAKING = new Set(['building', 'not_built']);
const WHY: Record<string, string> = {
  build_failed: '설치 파일을 만들지 못했습니다. 총괄 운영 관리자에게 알려 주세요.',
  invalid_artifact: '설치 파일을 만들지 못했습니다. 총괄 운영 관리자에게 알려 주세요.',
  build_tools_missing: '이 서버에서는 설치 파일을 만들 수 없습니다. 총괄 운영 관리자에게 알려 주세요.',
  limit_exceeded: '서버 저장 공간이 모자라 설치 파일을 만들지 못했습니다. 총괄 운영 관리자에게 알려 주세요.',
  disabled: '이 서버에서는 설치 파일 받기를 꺼 두었습니다.',
  not_supported_yet: '준비 중입니다. 곧 받을 수 있습니다.',
};
/** 이 브라우저의 운영체제(그 줄을 위에·강조). 모르면 null */
const myOs = (): Os | null => {
  const p = `${(navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ?? ''} ${navigator.userAgent}`;
  return /Windows/i.test(p) ? 'windows' : /Android/i.test(p) ? null : /Linux|X11|Ubuntu/i.test(p) ? 'linux' : null;
};

/** 새 로봇 추가 위 «노트북에 연결 프로그램이 없나요?» — 운영체제별 받기·만드는 중·이유. 실패해도 코드 입력은 그대로(카드 안 한 줄).
 *  폰(좁은 화면·앱)은 노트북 브라우저에서 받으라는 안내, 받기 링크는 작게 */
function Installer({ cancel, phone }: Cancel & { phone: boolean }) {
  const [items, setItems] = useState<RobotInstallerInfo['items'] | null>(null), [fail, setFail] = useState('');
  const mine = myOs();
  useEffect(() => {
    // 닫으면(언마운트) 대기 중 조회를 끊는다 — 다시 열어도 옛·새 요청이 겹치지 않게. 로그인 세션이 끝나도 끊김. 늦게 온 옛 답은 live 로 버림
    let live = true, timer = 0;
    const stop = new AbortController(), off = () => stop.abort();
    cancel?.addEventListener('abort', off);
    if (cancel?.aborted) stop.abort();
    const load = () => api.installerInfo(stop.signal).then((r) => {
      if (!live) return;
      setItems(r.items); setFail('');
      if (r.items.some((i) => !i.available && MAKING.has(i.reason))) timer = window.setTimeout(load, 10_000);
    }, (e: ApiFail) => { if (live && e.code !== 'CANCELED') setFail(`설치 파일 정보를 받지 못했습니다. ${e.message}`); });
    load();
    return () => { live = false; clearTimeout(timer); stop.abort(); cancel?.removeEventListener('abort', off); };
  }, []);
  const rows = [...(items ?? [])].sort((a, b) => Number(b.platform === mine) - Number(a.platform === mine));
  return <div className="fh-form" role="group" aria-label="설치 파일 받기" data-installer style={phone ? { padding: 8, borderRadius: 8, border: '1px solid var(--line)' } : undefined}>
    <b>노트북에 연결 프로그램이 없나요?</b>
    {phone && <p className="lv-note" data-installer-phone>노트북 브라우저에서 이 사이트에 로그인해 «+ 로봇 연결하기 → 새 로봇 추가» 에서 받으세요.</p>}
    {fail ? <p className="lbl" role="status" data-installer-fail>{fail}</p>
      : !items ? <p className="lbl" role="status">설치 파일을 확인하는 중…</p>
      : rows.map((i) => <div key={i.platform} className="fh-row" data-os={i.platform} data-mine={i.platform === mine || undefined}
        style={i.platform === mine ? { padding: 6, borderRadius: 6, border: '1px solid var(--accent)', background: 'var(--acc-bg)' } : undefined}>
        <span className="fh-grow" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{i.platform === mine ? <b>{OS_NAME[i.platform]} (이 노트북)</b> : OS_NAME[i.platform]}
          {i.platform === 'windows' && i.available && <span className="lbl" style={{ display: 'block' }}>처음 실행 때 ‘Windows의 PC 보호’ 가 뜨면 ‘추가 정보 → 실행’</span>}</span>
        {i.available
          ? <a className={phone ? 'lbl' : 'btn pri'} href={`/api/v1/robot-installer/${i.platform}`} download={i.filename}>받기 ({(i.size / 1048576).toFixed(1)} MB)</a>
          : <span className="lbl" data-why>{MAKING.has(i.reason) ? '만드는 중… 잠시 뒤 다시' : WHY[i.reason] ?? '아직 받을 수 없습니다.'}</span>}
      </div>)}
    <ol className="lbl" style={{ margin: 0, paddingLeft: 20 }} data-installer-steps>
      <li>받은 파일을 더블클릭해 설치</li><li>랜선을 로봇에 꽂기</li><li>{phone ? '노트북 화면의 코드를 아래에 넣기' : '노트북 화면의 코드를 «6자리 코드» 칸에 넣기'}</li></ol>
  </div>;
}

type Step = { at: 'code' } | { at: 'name'; p: PairingClaimed } | { at: 'done'; name: string; again: boolean };

/** 새 로봇 추가(운영 관리자). mine = 지금 내 로봇 id(확정 답의 id 가 이미 있으면 재연결).
 *  PC(넓은 화면·마우스)는 «설치 파일 받기 | 코드 넣기» 두 칸, 6자리 코드가 주 동작이고 QR(노트북 카메라)은 보조. 폰·앱은 한 줄로 QR 먼저(11-12) */
export function AddRobot({ mine, close, refresh, cancel }: { mine: string[]; close: () => void; refresh: () => void } & Cancel) {
  const [step, setStep] = useState<Step>({ at: 'code' }), [msg, setMsg] = useState(''), [busy, setBusy] = useState(false);
  const [scan, setScan] = useState(false), [code, setCode] = useState(''), [name, setName] = useState('');
  // 지금 확인 중인 코드 — 입력이 바뀌거나 화면이 닫히면 비워서, 늦게 온 옛 코드 답으로 이름 단계(바로 등록)에 가지 않게 한다
  const want = useRef('');
  useEffect(() => () => { want.current = ''; }, []);
  const claim = async (c: string) => {
    setScan(false);
    if (busy) return;
    if (!/^\d{6}$/.test(c)) return setMsg('노트북 화면의 6자리 숫자 코드를 넣으세요.');
    want.current = c; setBusy(true); setMsg('');
    try {
      const p = await api.claimPairing(c, cancel);
      if (want.current !== c) return;   // 확인 중 코드가 바뀜·화면 닫힘 — 옛 답 버림
      setName(`Go2-${p.robot_serial.replace(/\D/g, '').slice(-4)}`);   // 기본 이름 «Go2-끝4자리»
      setStep({ at: 'name', p });
    } catch (e) { if (want.current === c && (e as ApiFail).code !== 'CANCELED') setMsg(pairFail(e)); }
    finally { setBusy(false); }
  };
  const confirm = async (e: FormEvent, p: PairingClaimed) => {
    e.preventDefault();
    if (busy) return;
    const n = name.trim();
    if (!n) return setMsg('로봇 이름을 넣으세요.');
    setBusy(true); setMsg('');
    try {
      const r = await api.confirmPairing(p.pairing_id, n, cancel);   // 목록은 «내 로봇으로»에서 다시 받음 — 첫 로봇이면 목록 0→1 로 이 화면이 다시 그려져 안내가 사라짐
      setStep({ at: 'done', name: r.name, again: mine.includes(r.id) });
    } catch (err) {
      const f = err as ApiFail;
      if (f.code === 'CANCELED') return;
      if (f.status === 404) { setStep({ at: 'code' }); setCode(''); }   // 만료·남이 씀 — 처음부터
      setMsg(pairFail(err));
    } finally { setBusy(false); }
  };
  const restart = () => { setStep({ at: 'code' }); setCode(''); setMsg(''); };
  const phone = inApp() || !!globalThis.matchMedia?.(PHONE_Q).matches;   // 폰 틀(App PHONE_Q)·앱 — 짧게 열리는 카드라 폭 변화는 따라가지 않음
  const note = <p className="lv-note">노트북에서 FOOTHOLD 로봇 연결을 켜면 화면에 QR·6자리 코드가 나옵니다(10분 안에 한 번만 쓸 수 있습니다).</p>;
  const qr = scan ? <Scan found={(c) => { setCode(c); claim(c); }} close={() => setScan(false)} at={phone ? '아래에' : '«6자리 코드» 칸에'} />
    : <button type="button" className={phone ? 'btn pri' : 'btn'} disabled={busy} onClick={() => { setMsg(''); setScan(true); }}>QR 스캔</button>;
  const form = <form className="fh-row" noValidate onSubmit={(e) => { e.preventDefault(); claim(code.trim()); }}>
    <label className={phone ? 'fh-field fh-grow' : 'fh-field'}><span className="lbl">{phone ? '또는 6자리 코드' : '6자리 코드'}</span>
      <input className="inp mono" value={code} disabled={busy} onChange={(e) => { want.current = ''; setCode(e.target.value.replace(/\D/g, '').slice(0, 6)); }} inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="000000" data-pair-code /></label>
    <button type="submit" className={phone ? 'btn' : 'btn pri'} disabled={busy || code.length !== 6}>{busy ? '확인 중…' : '다음'}</button>
  </form>;
  const toMine = <button type="button" className="btn pri" onClick={() => { refresh(); close(); }}>내 로봇으로</button>;
  const again = <p className="lbl">이미 등록한 로봇을 노트북에 다시 설치했으면 같은 방법으로 다시 연결하세요 — 같은 로봇으로 이어지고 옛 연결 키는 바로 폐기됩니다.</p>;
  return <section className={phone ? 'lv-card' : 'lv-card pair-pc'} style={{ flexBasis: '100%' }} aria-label="새 로봇 추가" data-pair={step.at}>
    <div className="fh-row"><h2 className="fh-grow">새 로봇 추가</h2><button type="button" className="btn" onClick={close}>닫기</button></div>
    {step.at === 'code' && (phone ? <><Installer cancel={cancel} phone />{note}{qr}{form}{again}</>
      : <div className="pair-cols">
        <Installer cancel={cancel} phone={false} />
        <div className="fh-form" role="group" aria-label="코드 넣기"><b>노트북 화면의 코드 넣기</b>
          {/* 노트북에 설치된 연결 프로그램 창 띄우기(11-12 현민님 승인) — 설치 안 됐으면 아무 일도 없어 안내를 붙인다. 폰·앱 틀에는 없음 */}
          <div className="fh-form" style={{ gap: 6 }} data-agent-open><div className="fh-row"><a className="btn" href="foothold-robot://open">노트북 연결 프로그램 열기</a></div>
            <span className="lbl">안 열리면 아직 설치하지 않은 것입니다 — 설치 파일을 먼저 받으세요. 처음 한 번은 브라우저가 «열까요?» 하고 물으니 «열기»를 누르세요.</span></div>
          {note}{form}
          {scan ? qr : <div className="fh-row">{qr}<span className="lbl">노트북 카메라로 QR 을 읽을 때</span></div>}{again}</div>
      </div>)}
    {step.at === 'name' && <form className="fh-form pair-one" noValidate onSubmit={(e) => confirm(e, step.p)}>
      <span className="lbl">기체번호 <span className="mono" data-pair-serial>{step.p.robot_serial}</span> — 노트북 화면과 다르면 «처음으로»</span>
      <label className="fh-field"><span>로봇 이름</span><input className="inp" name="name" value={name} maxLength={128} autoComplete="off" onChange={(e) => setName(e.target.value)} /></label>
      <div className="fh-row"><button type="submit" className="btn pri" disabled={busy}>{busy ? '등록 중…' : '등록'}</button><button type="button" className="btn" onClick={restart}>처음으로</button></div>
      <span className="lbl">등록한 사람(나)이 이 로봇의 담당이 됩니다. 연결 키는 노트북 연결 프로그램이 받아 저장하며 화면에는 보이지 않습니다.</span>
    </form>}
    {step.at === 'done' && <>
      <p className="pair-one" role="status" data-pair-done>{step.again
        ? `${step.name} — 기존 로봇에 다시 연결했습니다. 옛 연결 키는 폐기됐고, 진행 중이던 조종은 정지·잠금됐습니다.`
        : `${step.name} 로봇을 등록했습니다.`} 노트북 화면에 «연결됨»이 뜨면 내 로봇에서 조종권을 잡으세요.</p>
      {phone ? toMine : <div className="fh-row">{toMine}</div>}
    </>}
    {msg && <p className="fh-msg" role="alert">{msg}</p>}
  </section>;
}

/** 담당 넘기기(담당 운영, 실기): 펼치면 대상 목록 → 한 명 고르기 → 같은 화면 확인(브라우저 confirm 없음) → PATCH {owner_user_id}.
 *  넘기면 서버가 폰 출입증 회수·조종권 회수 — 성공하면 목록을 다시 받아 이 로봇은 «다른 로봇»으로 내려간다. 실패는 서버 문구 그대로 */
/** 진행 중인 담당 넘기기: 로봇 id → 끝나면 풀리는 약속. 컴포넌트 밖에 두어 상세가 다시 그려져도(내 로봇 A→B→A) 같은 로봇의 두 번째 PATCH 를 막는다.
 *  로그인 세션이 끝나면 cancel 로 요청이 끊겨 finally 에서 풀린다 */
const transferring = new Map<string, Promise<void>>();
function TransferOwner({ r, refresh, cancel }: { r: Robot; refresh: () => void } & Cancel) {
  const [open, setOpen] = useState(false), [list, setList] = useState<RobotOwnerCandidate[] | null>(null), [to, setTo] = useState('');
  const [ask, setAsk] = useState(false), [msg, setMsg] = useState<{ text: string; ok?: boolean } | null>(null), [busy, setBusy] = useState(false);
  const seq = useRef(0), askBox = useRef<HTMLDivElement>(null);
  useEffect(() => { if (ask) askBox.current?.focus(); }, [ask]);
  // 다시 들어온 화면: 앞 화면이 보낸 넘기기가 끝날 때까지 잠금(끝나면 앞 화면이 목록을 다시 받는다)
  useEffect(() => {
    const p = transferring.get(r.id);
    if (!p) return;
    let live = true;
    setBusy(true); p.then(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [r.id]);
  const load = () => {
    const n = ++seq.current;
    setList(null); setTo(''); setAsk(false); setMsg(null);
    api.ownerCandidates(r.id, cancel).then((l) => { if (n === seq.current) setList(l); },
      (e: ApiFail) => { if (n === seq.current && e.code !== 'CANCELED') setMsg({ text: `넘길 수 있는 운영 관리자 목록을 받지 못했습니다. ${e.message}` }); });
  };
  const toggle = () => { if (!open) load(); else seq.current++; setOpen(!open); };
  const who = list?.find((u) => u.user_id === to)?.display_name ?? '';
  const send = async () => {
    if (transferring.has(r.id)) return;   // 같은 틱 두 번 누름·다시 그린 화면 모두
    let done = () => {};
    transferring.set(r.id, new Promise<void>((res) => { done = res; }));
    setBusy(true); setMsg(null);
    try { await api.saveRobot(r.id, { owner_user_id: to }, cancel); setAsk(false); setOpen(false); setMsg({ text: `담당을 ${who}(으)로 넘겼습니다.`, ok: true }); refresh(); }
    catch (e) { if ((e as ApiFail).code !== 'CANCELED') setMsg({ text: (e as ApiFail).message }); }
    finally { transferring.delete(r.id); done(); setBusy(false); }
  };
  return <div className="fh-form" data-transfer>
    <div className="fh-row"><button type="button" className="btn" aria-expanded={open} disabled={busy} onClick={toggle}>담당 넘기기</button></div>
    {open && list == null && !msg && <p className="lbl" role="status">넘길 수 있는 운영 관리자를 불러오는 중…</p>}
    {open && list == null && msg && <div className="fh-row"><button type="button" className="btn" onClick={load}>다시 불러오기</button></div>}
    {open && list?.length === 0 && <p className="lbl" role="status">넘길 수 있는 운영 관리자가 없습니다.</p>}
    {open && !!list?.length && <fieldset className="fh-field" style={{ border: 0, padding: 0, margin: 0 }} disabled={busy || ask}><legend>넘겨받을 운영 관리자</legend>
      {list.map((u) => <label key={u.user_id} className="fh-row"><input type="radio" name={`owner-to-${r.id}`} value={u.user_id} checked={to === u.user_id}
        onChange={() => setTo(u.user_id)} /><span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{u.display_name}</span></label>)}
      <div className="fh-row"><button type="button" className="btn" disabled={!to} onClick={() => setAsk(true)}>넘기기…</button></div></fieldset>}
    {open && ask && <div className="fh-form" role="group" aria-label="담당 넘기기 확인" tabIndex={-1} ref={askBox} style={{ padding: 8, borderRadius: 8 }}>
      <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{`${r.name} 담당을 ${who}(으)로 넘길까요? 넘기면 이 로봇의 폰 출입증과 조종권이 회수되고 로봇은 정지·잠금됩니다. 조종·배정은 새 담당만 할 수 있습니다.`}</span>
      <div className="fh-row"><button type="button" className="btn pri" disabled={busy} onClick={send}>넘기기</button>
        <button type="button" className="btn" disabled={busy} onClick={() => setAsk(false)}>취소</button></div></div>}
    {busy && <p className="lbl" role="status" data-transferring>담당을 넘기는 중…</p>}
    {msg && <p className={`fh-msg${msg.ok ? ' ok' : ''}`} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>}
  </div>;
}

/** 내 로봇 관리(담당 운영): 이름 바꾸기 · 연결 끊기(연결 키 폐기 + 진행 중 조종 정지·잠금) · 지우기 · 담당 넘기기(실기) */
export function ManageRobot({ r, refresh, cancel }: { r: Robot; refresh: () => void } & Cancel) {
  const [name, setName] = useState(r.name), [ask, setAsk] = useState<'cut' | 'delete' | null>(null);
  const [msg, setMsg] = useState<{ text: string; ok?: boolean } | null>(null), [busy, setBusy] = useState(false);
  const run = async (f: () => Promise<unknown>, ok: string) => {
    if (busy) return;
    setBusy(true); setAsk(null); setMsg(null);
    try { await f(); setMsg({ text: ok, ok: true }); refresh(); }
    catch (e) { if ((e as ApiFail).code !== 'CANCELED') setMsg({ text: robotFail(e) }); }
    finally { setBusy(false); }
  };
  const rename = (e: FormEvent) => {
    e.preventDefault();
    const v = name.trim();
    if (!v) return setMsg({ text: '로봇 이름을 넣으세요.' });
    if (v === r.name) return setMsg({ text: '바뀐 값이 없습니다.', ok: true });
    run(() => api.saveRobot(r.id, { name: v }, cancel), '이름을 바꿨습니다.');
  };
  return <div className="fh-form" role="group" aria-label="내 로봇 관리" data-manage>
    <b>내 로봇 관리</b>
    {r.serial && <span className="lbl">기체번호 <span className="mono">{r.serial}</span></span>}
    <form className="fh-row" noValidate onSubmit={rename}>
      <label className="fh-field fh-grow"><span className="lbl">로봇 이름</span><input className="inp" name="name" maxLength={128} value={name} onChange={(e) => setName(e.target.value)} /></label>
      <button type="submit" className="btn" disabled={busy}>이름 저장</button></form>
    <div className="fh-row">
      <button type="button" className="btn" disabled={busy} onClick={() => setAsk('cut')}>연결 끊기</button>
      <button type="button" className="btn" disabled={busy} onClick={() => setAsk('delete')}>로봇 지우기</button></div>
    {ask && <div className="fh-row" role="group" aria-label="확인">
      <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{ask === 'cut'
        ? `${r.name} 연결을 끊을까요? 연결 키가 폐기되고 진행 중인 조종은 정지·잠금됩니다. 다시 쓰려면 «새 로봇 추가»로 다시 연결합니다.`
        : `${r.name} 로봇을 지울까요? 연결 키가 폐기되고 되돌릴 수 없습니다. 기록은 남습니다.`}</span>
      <button type="button" className="btn bad" onClick={() => (ask === 'cut'
        ? run(() => api.disconnectRobot(r.id, cancel), '연결을 끊었습니다. 연결 키를 폐기했습니다.')
        : run(() => api.deleteRobot(r.id, cancel), `${r.name} 로봇을 지웠습니다.`))}>{ask === 'cut' ? '연결 끊기' : '지우기'}</button>
      <button type="button" className="btn" onClick={() => setAsk(null)}>취소</button></div>}
    {msg && <p className={`fh-msg${msg.ok ? ' ok' : ''}`} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>}
    {!r.sim && <TransferOwner r={r} refresh={refresh} cancel={cancel} />}
  </div>;
}

/** 총괄: 담당 없는 실기 로봇에만 담당 운영 관리자 지정(PATCH owner_user_id 한 필드). 연결 키·조종 권한은 주지 않는다 */
export function AssignOwner({ r, refresh, cancel }: { r: Robot; refresh: () => void } & Cancel) {
  const [ops, setOps] = useState<ApiUser[]>([]), [owner, setOwner] = useState(''), [ask, setAsk] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok?: boolean } | null>(null), [busy, setBusy] = useState(false);
  useEffect(() => { api.users(cancel).then((us) => setOps(us.filter((u) => u.role === 'OPERATOR' && !u.locked)), (e: ApiFail) => setMsg({ text: `운영 관리자 목록을 받지 못했습니다. ${e.message}` })); }, []);
  const who = ops.find((u) => u.id === owner)?.display_name ?? '';
  const save = async () => {
    if (busy) return;
    setBusy(true); setAsk(false); setMsg(null);
    try { await api.saveRobot(r.id, { owner_user_id: owner }, cancel); setMsg({ text: `담당을 ${who}(으)로 지정했습니다.`, ok: true }); refresh(); }
    catch (e) { if ((e as ApiFail).code !== 'CANCELED') setMsg({ text: robotFail(e) }); }
    finally { setBusy(false); }
  };
  return <div className="fh-form" role="group" aria-label="담당 지정" data-assign-owner>
    <OwnerSelect ops={ops} value={owner} onChange={(v) => { setOwner(v); setAsk(false); }} />
    <div className="fh-row"><button type="button" className="btn pri" disabled={busy || !owner} onClick={() => setAsk(true)}>담당 지정</button>
      <span className="lbl">담당 없는 실기 로봇만 지정할 수 있습니다. 연결·조종은 담당 운영 관리자가 합니다.</span></div>
    {ask && <div className="fh-row" role="group" aria-label="확인">
      <span>{`${r.name} 담당을 ${who}(으)로 지정할까요? 지정한 뒤에는 담당 운영 관리자만 바꿀 수 있습니다.`}</span>
      <button type="button" className="btn pri" onClick={save}>지정</button><button type="button" className="btn" onClick={() => setAsk(false)}>취소</button></div>}
    {msg && <p className={`fh-msg${msg.ok ? ' ok' : ''}`} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>}
  </div>;
}
