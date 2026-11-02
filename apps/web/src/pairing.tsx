// 실기 로봇 연결(ROBOT-PAIRING, 05 §3.1). 운영 관리자: 새 로봇 추가(QR·6자리 → 기체번호 확인 → 이름) → 현장 안전 확인(30분) → 내 로봇 관리(이름·연결 끊기·지우기).
// 총괄은 실기 로봇에 쓰기가 없다 — 담당 없는 실기의 담당 지정만(AssignOwner). 연결 키는 화면에 오지 않는다(노트북 연결 프로그램이 poll 로 한 번 받음).
// 담당 넘기기(TransferOwner): 내 로봇 관리 안 — 넘길 대상 목록(owner-candidates) → 같은 화면 확인 → PATCH owner_user_id.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { PairingClaimed, RobotOwnerCandidate, User as ApiUser } from '../../contracts/ts';
import { api, type ApiFail } from './api';
import type { Robot, Tone } from './fake';
import { Chip } from './screens';
import { OwnerSelect, robotFail } from './screens/settings';

type Cancel = { cancel?: AbortSignal };
/** 현장 안전 확인 필수 세 항목(서버 FIELD_APPROVAL_CHECKS 와 같은 id — 모르는 id·빠짐은 400) */
export const CHECKS = [
  { id: 'space_clear', label: '시험 공간 확보 — 로봇 주변에 사람·장애물이 없습니다.' },
  { id: 'emergency_stop_ready', label: '비상 정지 준비 — 리모컨·STOP 을 바로 누를 수 있습니다.' },
  { id: 'robot_verified', label: '로봇 확인 — 눈앞의 로봇이 이 이름·기체번호의 로봇입니다.' },
] as const;
const QR = /^foothold-pair:(\d{6})$/;

/** ms 마다 다시 그림(남은 시간) */
function useTick(ms: number) {
  const [, tick] = useState(0);
  useEffect(() => { const i = setInterval(() => tick((n) => n + 1), ms); return () => clearInterval(i); }, [ms]);
  return Date.now();
}
/** 현장 승인 남은 ms. ponytail: 이 기기 시계로 셈 — 서버와 시계가 어긋나면 그만큼 틀린다, 서버가 남은 초를 주면 그 값으로 */
export const approvalLeft = (until: string | null | undefined, now = Date.now()) => (until ? Math.max(0, Date.parse(until) - now) : 0);
const leftText = (ms: number) => (ms >= 60_000 ? `${Math.floor(ms / 60_000)}분 ${Math.floor(ms / 1000) % 60}초` : `${Math.ceil(ms / 1000)}초`);
/** 이 화면에서 승인을 본 로봇 — 사라지면(만료·해제·노트북 재연결) «다시 필요» */
const had = new Set<string>();
export function approvalChip(id: string, until: string | null | undefined, now = Date.now()): { tone: Tone; text: string } {
  const left = approvalLeft(until, now);
  if (left) { had.add(id); return { tone: 'ok', text: `현장 승인 ${leftText(left)} 남음` }; }
  return { tone: 'warn', text: had.has(id) ? '현장 확인 다시 필요' : '현장 확인 필요' };
}
/** 실기 로봇의 현장 승인 표시(1 s 마다) — 총괄·운영 모두 읽기 */
export function Approval({ r }: { r: Pick<Robot, 'id' | 'approvalUntil'> }) {
  const now = useTick(1000);
  return <span data-approval><Chip {...approvalChip(r.id, r.approvalUntil, now)} /></span>;
}

const NOT_FOUND = '코드가 맞지 않거나, 10분이 지났거나, 이미 쓴 코드입니다. 노트북 연결 프로그램 화면의 새 코드로 다시 하세요.';
const pairFail = (e: unknown) => {
  const f = e as ApiFail;
  if (f.code === 'PAIRING_NOT_FOUND' || f.status === 404) return NOT_FOUND;
  if (f.code === 'ROBOT_ALREADY_PAIRED') return '이 로봇은 다른 운영 관리자가 담당하고 있습니다. 담당 운영 관리자에게 넘겨받기 또는 삭제를 요청하세요.';
  if (f.status === 403) return '운영 관리자 계정으로 로그인해야 로봇을 연결할 수 있습니다.';
  return f.message;
};

/** 브라우저 카메라로 QR(foothold-pair:<6자리>) 읽기 — 내장 BarcodeDetector 만(새 라이브러리 없음). 안 되면 이유를 보이고 6자리 입력으로. 찾으면 카메라를 끈다 */
function Scan({ found, close }: { found: (code: string) => void; close: () => void }) {
  const v = useRef<HTMLVideoElement>(null), hit = useRef(found), [why, setWhy] = useState('');
  hit.current = found;
  useEffect(() => {
    const D = (window as { BarcodeDetector?: new (o: { formats: string[] }) => { detect: (s: HTMLVideoElement) => Promise<{ rawValue: string }[]> } }).BarcodeDetector;
    if (!D || !navigator.mediaDevices?.getUserMedia) { setWhy('이 브라우저는 QR 읽기를 지원하지 않습니다. 노트북 화면의 6자리 코드를 아래에 넣으세요.'); return; }
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
    }, () => setWhy('카메라를 쓸 수 없습니다(권한 거부·카메라 없음). 노트북 화면의 6자리 코드를 아래에 넣으세요.'));
    return () => { off = true; clearTimeout(timer); stream?.getTracks().forEach((t) => t.stop()); };
  }, []);
  return <div className="fh-form" data-scan>
    {why ? <p className="fh-why" role="status" data-scan-why>{why}</p>
      : <video ref={v} muted playsInline aria-label="QR 카메라" style={{ width: '100%', maxHeight: 280, background: '#000', borderRadius: 8 }} />}
    <button type="button" className="btn" onClick={close}>카메라 닫기</button>
  </div>;
}

type Step = { at: 'code' } | { at: 'serial' | 'name'; p: PairingClaimed } | { at: 'done'; name: string; again: boolean };

/** 새 로봇 추가(운영 관리자). mine = 지금 내 로봇 id(확정 답의 id 가 이미 있으면 재연결) */
export function AddRobot({ mine, close, refresh, cancel }: { mine: string[]; close: () => void; refresh: () => void } & Cancel) {
  const [step, setStep] = useState<Step>({ at: 'code' }), [msg, setMsg] = useState(''), [busy, setBusy] = useState(false);
  const [scan, setScan] = useState(false), [code, setCode] = useState(''), [name, setName] = useState('');
  const claim = async (c: string) => {
    setScan(false);
    if (busy) return;
    if (!/^\d{6}$/.test(c)) return setMsg('노트북 화면의 6자리 숫자 코드를 넣으세요.');
    setBusy(true); setMsg('');
    try {
      const p = await api.claimPairing(c, cancel);
      setName(`Go2-${p.robot_serial.replace(/\D/g, '').slice(-4)}`);   // 기본 이름 «Go2-끝4자리»
      setStep({ at: 'serial', p });
    } catch (e) { if ((e as ApiFail).code !== 'CANCELED') setMsg(pairFail(e)); }
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
  return <section className="lv-card" style={{ flexBasis: '100%' }} aria-label="새 로봇 추가" data-pair={step.at}>
    <div className="fh-row"><h2 className="fh-grow">새 로봇 추가</h2><button type="button" className="btn" onClick={close}>닫기</button></div>
    {step.at === 'code' && <>
      <p className="lv-note">노트북에서 연결 프로그램을 켜면 «Go2 기체번호 찾음»과 QR·6자리 코드가 보입니다(10분, 한 번만).</p>
      {scan ? <Scan found={(c) => { setCode(c); claim(c); }} close={() => setScan(false)} />
        : <button type="button" className="btn pri" disabled={busy} onClick={() => { setMsg(''); setScan(true); }}>QR 스캔</button>}
      <form className="fh-row" noValidate onSubmit={(e) => { e.preventDefault(); claim(code.trim()); }}>
        <label className="fh-field fh-grow"><span className="lbl">또는 6자리 코드</span>
          <input className="inp mono" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="000000" data-pair-code /></label>
        <button type="submit" className="btn" disabled={busy || code.length !== 6}>{busy ? '확인 중…' : '다음'}</button>
      </form>
      <p className="lbl">이미 등록한 로봇을 노트북에 다시 설치했으면 같은 방법으로 다시 연결하세요 — 같은 로봇으로 이어지고 옛 연결 키는 바로 폐기됩니다.</p>
    </>}
    {step.at === 'serial' && <>
      <p>노트북 화면의 기체번호와 같은지 확인하세요.</p>
      <b className="mono" style={{ fontSize: 24, overflowWrap: 'anywhere' }} data-pair-serial>{step.p.robot_serial}</b>
      <div className="fh-row"><button type="button" className="btn pri" onClick={() => setStep({ at: 'name', p: step.p })}>이 로봇 맞음</button>
        <button type="button" className="btn" onClick={restart}>다름 — 처음으로</button></div>
    </>}
    {step.at === 'name' && <form className="fh-form" noValidate onSubmit={(e) => confirm(e, step.p)}>
      <span className="lbl">기체번호 <span className="mono">{step.p.robot_serial}</span></span>
      <label className="fh-field"><span>로봇 이름</span><input className="inp" name="name" value={name} maxLength={128} autoComplete="off" onChange={(e) => setName(e.target.value)} /></label>
      <div className="fh-row"><button type="submit" className="btn pri" disabled={busy}>{busy ? '등록 중…' : '등록'}</button><button type="button" className="btn" onClick={restart}>처음으로</button></div>
      <span className="lbl">등록한 사람(나)이 이 로봇의 담당이 됩니다. 연결 키는 노트북 연결 프로그램이 받아 저장하며 화면에는 보이지 않습니다.</span>
    </form>}
    {step.at === 'done' && <>
      <p role="status" data-pair-done>{step.again
        ? `${step.name} — 기존 로봇에 다시 연결했습니다. 옛 연결 키는 폐기됐고, 진행 중이던 조종은 정지·잠금됐습니다.`
        : `${step.name} 로봇을 등록했습니다.`} 노트북 화면에 «연결됨»이 뜨면 «현장 안전 확인»을 하세요.</p>
      <button type="button" className="btn pri" onClick={() => { refresh(); close(); }}>내 로봇으로</button>
    </>}
    {msg && <p className="fh-msg" role="alert">{msg}</p>}
  </section>;
}

/** 현장 안전 확인(담당 운영). 세 항목을 모두 체크해야 보냄 → 30분 승인. 해제 = DELETE. 승인 상태는 목록 값(r.approvalUntil — 노트북 재연결 때 서버가 비움) + 방금 받은 답 */
export function FieldCheck({ r, refresh, cancel }: { r: Robot; refresh: () => void } & Cancel) {
  const now = useTick(1000), [got, setGot] = useState<{ until: string | null; from: string | null | undefined } | null>(null);
  const [checked, setChecked] = useState<string[]>([]), [msg, setMsg] = useState<{ text: string; ok?: boolean } | null>(null), [busy, setBusy] = useState(false);
  // 방금 받은 답은 목록 값이 바뀌기 전까지만 쓴다(그 뒤엔 서버 목록이 정본)
  const until = got && got.from === r.approvalUntil ? got.until : r.approvalUntil, left = approvalLeft(until, now);
  const run = async (f: () => Promise<string | null>, ok: string) => {
    if (busy) return;
    setBusy(true); setMsg(null);
    try { setGot({ until: await f(), from: r.approvalUntil }); setChecked([]); setMsg({ text: ok, ok: true }); refresh(); }
    catch (e) { if ((e as ApiFail).code !== 'CANCELED') setMsg({ text: (e as ApiFail).message }); }
    finally { setBusy(false); }
  };
  const grant = (e: FormEvent) => { e.preventDefault(); if (checked.length === CHECKS.length) run(async () => (await api.approveField(r.id, CHECKS.map((c) => c.id), cancel)).expires_at, '현장 승인을 등록했습니다.'); };
  const offline = !r.online;
  return <div className="fh-form" role="group" aria-label="현장 안전 확인" data-field-check>
    <div className="fh-row"><b className="fh-grow">현장 안전 확인</b><Chip {...approvalChip(r.id, until, now)} /></div>
    {left ? <div className="fh-row"><span className="fh-grow lbl">남은 시간이 끝나거나 노트북 연결 프로그램이 다시 연결되면 다시 확인해야 합니다.</span>
      <button type="button" className="btn" disabled={busy} onClick={() => run(async () => { await api.revokeField(r.id, cancel); return null; }, '현장 승인을 해제했습니다. 진행 중인 조종은 정지·잠금됩니다.')}>해제</button></div>
      : <form className="fh-form" noValidate onSubmit={grant}>
        {CHECKS.map((c) => <label key={c.id} className="fh-row" style={{ alignItems: 'flex-start' }}><input type="checkbox" name={c.id} checked={checked.includes(c.id)} disabled={offline}
          onChange={(e) => setChecked((l) => (e.target.checked ? [...l, c.id] : l.filter((x) => x !== c.id)))} /><span className="fh-grow">{c.label}</span></label>)}
        <div className="fh-row"><button type="submit" className="btn pri" disabled={busy || offline || checked.length !== CHECKS.length} aria-describedby={offline ? `field-why-${r.id}` : undefined}>현장 승인(30분)</button>
          {offline && <span id={`field-why-${r.id}`} className="fh-why" data-field-why>로봇이 연결된 뒤에 확인하세요 — 노트북 연결 프로그램이 연결될 때 승인이 해제됩니다.</span>}</div>
      </form>}
    {msg && <p className={`fh-msg${msg.ok ? ' ok' : ''}`} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>}
  </div>;
}

/** 담당 넘기기(담당 운영, 실기): 펼치면 대상 목록 → 한 명 고르기 → 같은 화면 확인(브라우저 confirm 없음) → PATCH {owner_user_id}.
 *  넘기면 서버가 폰 출입증 회수·현장 승인 해제 — 성공하면 목록을 다시 받아 이 로봇은 «다른 로봇»으로 내려간다. 실패는 서버 문구 그대로 */
function TransferOwner({ r, refresh, cancel }: { r: Robot; refresh: () => void } & Cancel) {
  const [open, setOpen] = useState(false), [list, setList] = useState<RobotOwnerCandidate[] | null>(null), [to, setTo] = useState('');
  const [ask, setAsk] = useState(false), [msg, setMsg] = useState<{ text: string; ok?: boolean } | null>(null), [busy, setBusy] = useState(false);
  const seq = useRef(0), askBox = useRef<HTMLDivElement>(null), sending = useRef(false);   // sending = 같은 틱 두 번 누름도 막음(busy 는 다시 그린 뒤에야 보임)
  useEffect(() => { if (ask) askBox.current?.focus(); }, [ask]);
  const load = () => {
    const n = ++seq.current;
    setList(null); setTo(''); setAsk(false); setMsg(null);
    api.ownerCandidates(r.id, cancel).then((l) => { if (n === seq.current) setList(l); },
      (e: ApiFail) => { if (n === seq.current && e.code !== 'CANCELED') setMsg({ text: `넘길 수 있는 운영 관리자 목록을 받지 못했습니다. ${e.message}` }); });
  };
  const toggle = () => { if (!open) load(); else seq.current++; setOpen(!open); };
  const who = list?.find((u) => u.user_id === to)?.display_name ?? '';
  const send = async () => {
    if (sending.current) return;
    sending.current = true; setBusy(true); setMsg(null);
    try { await api.saveRobot(r.id, { owner_user_id: to }, cancel); setAsk(false); setOpen(false); setMsg({ text: `담당을 ${who}(으)로 넘겼습니다.`, ok: true }); refresh(); }
    catch (e) { if ((e as ApiFail).code !== 'CANCELED') setMsg({ text: (e as ApiFail).message }); }
    finally { sending.current = false; setBusy(false); }
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
      <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{`${r.name} 담당을 ${who}(으)로 넘길까요? 넘기면 이 로봇의 폰 출입증과 현장 승인이 풀리고, 조종·배정은 새 담당만 할 수 있습니다.`}</span>
      <div className="fh-row"><button type="button" className="btn pri" disabled={busy} onClick={send}>넘기기</button>
        <button type="button" className="btn" disabled={busy} onClick={() => setAsk(false)}>취소</button></div></div>}
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
      <button type="button" className="btn pri" onClick={() => (ask === 'cut'
        ? run(() => api.disconnectRobot(r.id, cancel), '연결을 끊었습니다. 연결 키를 폐기했습니다.')
        : run(() => api.deleteRobot(r.id, cancel), `${r.name} 로봇을 지웠습니다.`))}>{ask === 'cut' ? '연결 끊기' : '지우기'}</button>
      <button type="button" className="btn" onClick={() => setAsk(null)}>취소</button></div>}
    {msg && <p className={`fh-msg${msg.ok ? ' ok' : ''}`} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>}
    {!r.sim && <TransferOwner r={r} refresh={refresh} cancel={cancel} />}
  </div>;
}

/** 총괄: 담당 없는 실기 로봇에만 담당 운영 관리자 지정(PATCH owner_user_id 한 필드). 연결 키·조종·현장 승인 권한은 주지 않는다 */
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
      <span className="lbl">담당 없는 실기 로봇만 지정할 수 있습니다. 연결·현장 확인·조종은 담당 운영 관리자가 합니다.</span></div>
    {ask && <div className="fh-row" role="group" aria-label="확인">
      <span>{`${r.name} 담당을 ${who}(으)로 지정할까요? 지정한 뒤에는 담당 운영 관리자만 바꿀 수 있습니다.`}</span>
      <button type="button" className="btn pri" onClick={save}>지정</button><button type="button" className="btn" onClick={() => setAsk(false)}>취소</button></div>}
    {msg && <p className={`fh-msg${msg.ok ? ' ok' : ''}`} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>}
  </div>;
}
