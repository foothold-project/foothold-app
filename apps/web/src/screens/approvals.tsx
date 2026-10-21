// 결재 탭(01 AP-01~04·AP-08·MP-05, 02 F-AP-02~04, 03 §5.4·U10, 05 §7 — S4a /approvals).
// 총괄 = «결재함»(조직 전체, 대기 기본 — 끝난 것도 볼 수 있음), 운영 관리자 = «내 요청»(서버가 본인 것만). 같은 틀에 단추만 다르다(U6).
// 전후 비교는 지도 탭의 판 비교(screens/mapdiff.tsx Compare)를 그대로 — 대상 판을 기준 판과. 시나리오 배정·긴급 실행 사후 확인은 아직(모르는 종류 = «지원 전 종류», 처리 단추 없음).
// 이 칸은 창 전체 키를 잡지 않는다 — STOP 단추·Space = STOP 은 App 머리줄 그대로(확인·처리 중에도).
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Approval, ApprovalDetail, ApprovalList, MapVersion } from '../../../contracts/ts';
import { ApiFail, api } from '../api';
import type { Tone } from '../fake';
import { Chip, Line, type Ctx } from '../screens';
import { when } from './history';
import { Compare } from './mapdiff';
import { Note, isVersion, reasonBad, shape, type Msg } from './maps';

const KIND: Record<string, string> = { MAP_REVISION: '지도 수정', MAP_ROLLBACK: '지도 되돌리기' };
const known = (k: string) => k in KIND;
const STATUS: Record<string, { tone: Tone; text: string }> = {
  PENDING: { tone: 'warn', text: '대기' }, APPROVED: { tone: 'ok', text: '승인' }, REJECTED: { tone: 'bad', text: '반려' },
  CANCELED: { tone: 'off', text: '취소' }, STALE: { tone: 'bad', text: '적용 불가(지도가 바뀜)' } };
const status = (s: string) => STATUS[s] ?? { tone: 'off' as Tone, text: '알 수 없는 상태' };

// 받은 값 모양 검사 — 어긋난 응답이 화면(머리줄·STOP 포함)을 깨뜨리지 않게 오류 한 줄로만
const str = (v: unknown) => typeof v === 'string';
const isApproval = (a: Approval) => !!a && str(a.id) && str(a.kind) && str(a.status) && !!a.requester && str(a.requester.id) && str(a.requester.display_name)
  && str(a.reason) && str(a.created_at) && !!a.target && str(a.target.id);
const isList = (l: ApprovalList) => !!l && Array.isArray(l.items) && l.items.every(isApproval) && (l.next_cursor === null || str(l.next_cursor));
const isDetail = (d: ApprovalDetail) => isApproval(d) && (!known(d.kind) || (!!d.preview && str(d.preview.floor_name) && Number.isInteger(d.preview.target_version_number)));
const fit = <T,>(ok: (x: T) => boolean) => (x: T) => { if (!ok(x)) throw new ApiFail(0, 'BAD_SHAPE', '받은 결재 형식이 맞지 않습니다. 잠시 뒤 다시 시도하세요.'); return x; };
/** 층 · 기준 판 → 대상 판 */
const what = (p: ApprovalDetail['preview']) => `${p.floor_name} · ${p.base_version_number != null ? `판 ${p.base_version_number}` : '빈 지도'} → 판 ${p.target_version_number}`;

type View = 'PENDING' | 'ALL';
/** 목록(오래된 것 먼저) + cursor 로 더 받기. 보기를 바꾸면 처음부터 — 앞 요청의 늦은 답은 버린다. again = 처음 쪽 다시(처리 뒤) */
function useList(first: View, cancel?: AbortSignal) {
  const [view, setView] = useState(first), [items, setItems] = useState<Approval[]>([]), [next, setNext] = useState<string | null>(null);
  const [busy, setBusy] = useState(true), [err, setErr] = useState(''), [n, setN] = useState(0), seq = useRef(0);
  const load = (cursor: string | null) => {
    const k = ++seq.current;
    setBusy(true); setErr('');
    api.approvals(view === 'PENDING' ? 'PENDING' : null, cursor, cancel).then(fit(isList)).then((r) => {
      if (k !== seq.current) return;
      setItems((o) => (cursor ? [...o, ...r.items.filter((x) => !o.some((y) => y.id === x.id))] : r.items)); setNext(r.next_cursor); setBusy(false);
    }, (e: ApiFail) => { if (k !== seq.current || e.code === 'CANCELED') return; setErr(e.message); setBusy(false); });   // 더 받기 실패면 받은 목록·cursor 그대로(다시 시도)
  };
  useEffect(() => { load(null); }, [view, n]);
  return { view, items, next, busy, err, more: () => load(next), again: () => setN((x) => x + 1), show: (v: View) => { if (v !== view) { setItems([]); setNext(null); setView(v); } } };
}

/** 결재 탭. focus = 알림 링크로 연 결재 id(#/approvals?approval_id=…) — 목록 보기와 상관없이 그 항목을 연다 */
export function Approvals(c: Pick<Ctx, 'user' | 'cancel' | 'focus' | 'dash'>) {
  const admin = c.user.role === 'ORG_ADMIN', l = useList(admin ? 'PENDING' : 'ALL', c.cancel);
  const [sel, setSel] = useState(c.focus ?? ''), [k, setK] = useState(0), [msg, setMsg] = useState<Msg>(null);
  useEffect(() => { if (c.focus) { setSel(c.focus); setMsg(null); } }, [c.focus]);
  // 목록 항목의 층·판 번호는 상세에만 있다 — 항목마다 한 번, 동시에 PRE 개까지 받는다(바뀌지 않는 값). 고른 항목은 상세 칸이 받은 것을 쓴다(seen) — 받는 중인 줄을 고르면 그 요청을 같이 기다린다(flight).
  // 실패한 항목은 그 줄의 층·판만 비우고 목록을 다시 받을 때 또 시도한다. ponytail: 항목 수만큼 요청, 서버 목록에 preview 가 오면 뺀다
  const [pre, setPre] = useState<Record<string, ApprovalDetail>>({}), asked = useRef(new Set<string>()), failed = useRef(new Set<string>()), flying = useRef(0), flight = useRef(new Map<string, Promise<ApprovalDetail>>()), [tick, setTick] = useState(0);
  const seen = (d: ApprovalDetail) => { asked.current.add(d.id); setPre((o) => ({ ...o, [d.id]: d })); };
  useEffect(() => { failed.current.clear(); }, [l.items]);
  useEffect(() => {
    for (const a of l.items) {
      if (flying.current >= PRE) break;
      if (!known(a.kind) || a.id === sel || asked.current.has(a.id) || failed.current.has(a.id)) continue;
      asked.current.add(a.id); flying.current++;
      const q = api.approval(a.id, c.cancel).then(fit(isDetail));
      flight.current.set(a.id, q);
      q.then((d) => setPre((o) => ({ ...o, [a.id]: d })), () => { asked.current.delete(a.id); failed.current.add(a.id); })
        .finally(() => { flight.current.delete(a.id); flying.current--; setTick((t) => t + 1); });
    }
  }, [l.items, tick]);
  // 처리 응답은 늦게 올 수 있다 — 그 사이 다른 항목을 골랐으면 고른 것·입력은 그대로 두고 목록·배지만 새로
  const now = useRef({ sel, items: l.items, view: l.view });
  now.current = { sel, items: l.items, view: l.view };
  /** id 처리가 끝남(성공) — 목록·배지를 새로, 아직 그 항목을 보고 있으면 안내 + 결재함 대기 보기면 다음 대기 항목으로(F-AP-02) */
  const done = (id: string, m: Msg) => {
    l.again(); c.dash.again();
    const { sel, items, view } = now.current;
    if (sel !== id) return;
    setMsg(m);
    const i = items.findIndex((x) => x.id === sel), rest = [...items.slice(i + 1), ...items.slice(0, Math.max(i, 0))];
    const go = admin && view === 'PENDING' ? rest.find((x) => x.status === 'PENDING' && x.requester.id !== c.user.id) : undefined;
    if (go) setSel(go.id); else if (admin && view === 'PENDING') setSel(''); else setK((x) => x + 1);
  };
  /** 처리 결과가 불확실하거나 상태가 달라짐 — 목록·배지만 새로(상세는 자기가 다시 받는다) */
  const recheck = () => { l.again(); c.dash.again(); };
  const title = admin ? '결재함' : '내 요청';
  return <>
    <section className="lv-card" style={{ flex: '0 1 360px' }} aria-label={title}>
      <div className="fh-row"><h2 className="fh-grow">{title}</h2>
        <span className="fh-row" role="group" aria-label="보기">{([['PENDING', '대기'], ['ALL', '전체']] as [View, string][]).map(([v, t]) =>
          <button key={v} type="button" className="btn" aria-pressed={l.view === v} onClick={() => l.show(v)}>{t}</button>)}</span></div>
      <ul className="fh-list" aria-label="결재 목록">{l.items.map((a) => { const p = pre[a.id]?.preview; return <li key={a.id}>
        <button type="button" aria-pressed={a.id === sel} onClick={() => { setSel(a.id); setMsg(null); }} data-approval={a.id}>
          <Chip {...status(a.status)} /><b>{KIND[a.kind] ?? '지원 전 종류'}</b><span className="fh-grow">{p ? what(p) : ''}</span>
          <span className="lbl">{admin ? `${a.requester.display_name} · ` : ''}{when(a.created_at)}</span></button></li>; })}</ul>
      {!l.busy && !l.err && !l.items.length && <p className="lv-note">{l.view === 'PENDING' ? (admin ? '대기 중인 결재가 없습니다.' : '대기 중인 내 요청이 없습니다.')
        : admin ? '결재 요청이 없습니다.' : '아직 결재를 요청한 적이 없습니다. 지도 탭에서 편집을 저장하거나 옛 판으로 되돌리면 결재 요청이 됩니다.'}</p>}
      {l.err && <p className="fh-msg" role="alert">결재 목록을 받지 못했습니다. {l.err}</p>}
      {l.busy && <p className="lv-note" role="status">결재 목록을 불러오는 중…</p>}
      {!l.busy && (l.next || l.err) && <div className="fh-row"><button type="button" className="btn" onClick={l.err && !l.items.length ? l.again : l.more}>{l.err ? '다시 시도' : '더 보기'}</button></div>}
    </section>
    <section className="lv-card" aria-label="내용">
      <Note m={msg} />
      {sel ? <Detail key={`${sel}-${k}`} id={sel} me={c.user.id} admin={admin} cancel={c.cancel} done={done} recheck={recheck} seen={seen} first={flight.current.get(sel)} />
        : <p className="lv-note">목록에서 항목을 고르면 바뀐 곳 비교와 이유가 보입니다.</p>}
    </section>
  </>;
}

const PRE = 4;
const DONE = { approve: '승인했습니다.', reject: '반려했습니다. 요청자가 반려 이유를 봅니다.', cancel: '요청을 취소했습니다.' };
type Act = keyof typeof DONE;

/** 결재 하나: 내용·전후 비교·이유 + 처리 단추. 총괄(남의 요청) = 승인(의견 선택, 확인 없음)·반려(이유 필수 + 확인, U10), 요청자 = 취소만(서버도 자기 요청 승인·반려는 403).
 *  done = 처리 성공(부른 쪽이 목록·배지를 새로 받고 다음 항목으로), recheck = 결과가 불확실·이미 끝남 — 목록·배지만 새로(이 칸은 스스로 다시 받음), seen = 받은 내용(목록 줄의 층·판), first = 목록이 받는 중인 이 상세(처음 한 번은 그것을 기다림)
 *  다시 받는 동안과 다시 받기에 실패한 동안은 처리 단추를 잠근다 — 지금 상태를 확인한 뒤에만 처리(STOP 은 머리줄 그대로) */
function Detail({ id, me, admin, cancel, done, recheck, seen, first }: { id: string; me: string; admin: boolean; cancel?: AbortSignal; done: (id: string, m: Msg) => void; recheck: () => void; seen: (d: ApprovalDetail) => void; first?: Promise<ApprovalDetail> }) {
  const [d, setD] = useState<ApprovalDetail | null>(null), [err, setErr] = useState(''), [n, setN] = useState(0), [loading, setLoading] = useState(true), then = useRef('');
  const [v, setV] = useState<MapVersion | null>(null), [vErr, setVErr] = useState(''), [vn, setVn] = useState(0);
  const [comment, setComment] = useState(''), [reason, setReason] = useState(''), [rejecting, setRejecting] = useState(false), [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false), sending = useRef(false), [msg, setMsg] = useState<Msg>(null);
  useEffect(() => {
    let live = true;   // 다시 받기가 겹치면 지난 요청의 늦은 답은 버린다
    setLoading(true);
    (n === 0 && first ? first : api.approval(id, cancel).then(fit(isDetail))).then((x) => {
      if (!live) return;
      setD(x); setErr(''); setLoading(false); seen(x);
      if (then.current) { setMsg({ text: then.current }); then.current = ''; }   // «다시 불러왔습니다»는 받은 뒤에야
    }, (e: ApiFail) => {
      if (!live || e.code === 'CANCELED') return;
      setLoading(false); then.current = '';
      setErr(e.status === 404 ? '이 결재 요청을 볼 수 없습니다. 내 요청이 아니거나 찾을 수 없는 요청입니다. 목록에서 다시 고르세요.' : `결재 내용을 받지 못했습니다. ${e.message}`);
    });
    return () => { live = false; };
  }, [n]);
  // 전후 비교 = 지도 탭 비교 그대로: 대상 판(target)을 그 기준 판(base_ref = 대상 판의 기준 판)과
  const target = d && known(d.kind) ? d.target.id : '';
  useEffect(() => {
    if (!target) return;
    let live = true;
    setVErr('');
    api.version(target, cancel).then(shape(isVersion)).then((x) => { if (live) setV(x); }, (e: ApiFail) => { if (live && e.code !== 'CANCELED') setVErr(e.status === 404 ? '요청한 지도 판을 찾을 수 없습니다.' : `요청한 지도 판을 받지 못했습니다. ${e.message}`); });
    return () => { live = false; };
  }, [target, vn]);
  if (!d) return err ? <div className="fh-row"><p className="fh-msg" role="alert">{err}</p><button type="button" className="btn" onClick={() => setN(n + 1)}>다시 시도</button></div>
    : <p className="lv-note" role="status">결재 내용을 불러오는 중…</p>;

  const mine = d.requester.id === me, open = d.status === 'PENDING', p = known(d.kind) ? d.preview : null, lock = busy || loading || !!err;
  const again = () => { setLoading(true); setN(n + 1); recheck(); };
  const run = async (a: Act) => {
    if (sending.current || loading || err) return;   // 두 번 누름(화면이 잠기기 전 두 번째 누름도)·상태 확인 전
    sending.current = true; setBusy(true); setMsg(null);
    try {
      const body = comment.trim() || null;
      await (a === 'approve' ? api.approve(d.id, body, cancel) : a === 'reject' ? api.reject(d.id, reason.trim(), cancel) : api.cancelApproval(d.id, cancel)).then(fit(isApproval));   // 빈·어긋난 200 = 불확실(status 0)
      done(d.id, { text: a === 'approve' && p ? `승인했습니다. 이제 ${p.floor_name}의 승인 판은 판 ${p.target_version_number}입니다. 다음 실행부터 이 판을 씁니다.` : DONE[a], ok: true });
    } catch (x) {
      const f = x as ApiFail;
      if (f.code === 'CANCELED') return;
      // 요청을 보낸 뒤 답이 끊기면(헤더 전·본문 중·마감·깨진 본문) 처리됐을 수도 있다 — 지금 상태를 다시 받아 보여 준다
      if (f.status === 0) setMsg({ text: '처리 응답을 받지 못했습니다. 처리됐을 수 있어 지금 상태를 다시 불러옵니다. 상태를 확인한 뒤 다시 누르세요.' });
      // 서버가 STALE 로 끝내고 알림까지 남긴 뒤 409 — 다시 받으면 «적용 불가»로 보인다
      else if (f.code === 'APPROVAL_STALE') setMsg({ text: `승인하지 못했습니다. ${f.message}` });
      else if (f.code === 'ALREADY_DECIDED') { setMsg({ text: `${f.message} 지금 상태를 다시 불러오는 중입니다.` }); then.current = `${f.message} 지금 상태를 다시 불러왔습니다.`; }
      else if (f.status === 404) setMsg({ text: '이 결재 요청을 찾을 수 없습니다. 목록을 다시 받습니다.' });
      else { setMsg({ text: `처리하지 못했습니다. ${f.message}` }); return; }
      setRejecting(false); again();
    } finally { sending.current = false; setBusy(false); setAsk(false); }
  };
  const approve = () => {
    if (/[\p{Cc}\p{Cf}]/u.test(comment)) return setMsg({ text: '의견에 탭 같은 보이지 않는 글자는 쓸 수 없습니다(이모지 일부도 이런 글자를 품습니다). 지우고 다시 입력하세요.' });
    run('approve');
  };
  const reject = (e: FormEvent) => {
    e.preventDefault();
    const why = reasonBad(reason, '반려 이유');
    if (why) return setMsg({ text: why });
    setMsg(null); setAsk(true);
  };

  return <div className="fh-form" aria-label="결재 내용">
    <div className="fh-row"><h2 className="fh-grow">{KIND[d.kind] ?? '지원 전 종류'} · {d.requester.display_name} · {when(d.created_at)}</h2><Chip {...status(d.status)} /></div>
    {p ? <b>{what(p)}{open ? ' (요청)' : ''}</b> : <p className="lv-note">이 화면에서 아직 처리할 수 없는 종류의 결재입니다.</p>}
    {d.status === 'STALE' && <p className="fh-msg" role="alert">요청 이후 지도가 바뀌어 이 요청은 더 이상 적용할 수 없습니다. {mine ? '새 승인 판에서 다시 요청하세요.' : '요청자가 새 승인 판에서 다시 요청해야 합니다.'}</p>}
    {p && (v ? <Compare v={v} list={p.base_version_number != null && d.base_ref ? [{ id: d.base_ref.id, number: p.base_version_number }] : []} cancel={cancel}
        gone={() => { setV(null); setVErr('비교할 판을 찾을 수 없습니다.'); }} />
      : vErr ? <div className="fh-row"><p className="fh-msg" role="alert">{vErr}</p><button type="button" className="btn" onClick={() => setVn(vn + 1)}>다시 시도</button></div>
      : <p className="lv-note" role="status">요청한 지도 판을 불러오는 중…</p>)}
    <Line k="요청 이유"><span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{d.reason}</span></Line>
    {d.decider && <Line k="처리"><span>{d.decider.display_name}{d.decided_at ? ` · ${when(d.decided_at)}` : ''}</span></Line>}
    {d.decision_comment && <Line k={d.status === 'REJECTED' ? '반려 이유' : '의견'}><span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{d.decision_comment}</span></Line>}
    {open && mine && <div className="fh-row"><button type="button" className="btn" disabled={lock} onClick={() => run('cancel')}>요청 취소</button></div>}
    {open && admin && !mine && p && <>
      <label className="fh-field"><span>의견(선택)</span><input className="inp" maxLength={2000} value={comment} disabled={lock} onChange={(e) => setComment(e.target.value)} /></label>
      <div className="fh-row"><button type="button" className="btn" disabled={lock || ask} aria-pressed={rejecting} onClick={() => { setRejecting(!rejecting); setAsk(false); setMsg(null); }}>반려</button>
        <button type="button" className="btn pri" disabled={lock || ask} onClick={approve}>승인</button></div>
      {rejecting && <form className="fh-form" onSubmit={reject} noValidate aria-label="반려">
        <label className="fh-field"><span>반려 이유</span><input className="inp" maxLength={2000} value={reason} autoFocus disabled={lock || ask} onChange={(e) => setReason(e.target.value)} /></label>
        <div className="fh-row"><button type="submit" className="btn pri" disabled={lock || ask}>반려하기</button><button type="button" className="btn" disabled={busy} onClick={() => { setRejecting(false); setAsk(false); }}>닫기</button></div>
      </form>}
      {ask && <div className="fh-row" role="group" aria-label="확인"><span>이 요청을 반려할까요? 반려하면 되돌릴 수 없고, 요청자가 고쳐서 다시 요청해야 합니다.</span>
        <button type="button" className="btn pri" disabled={lock} onClick={() => run('reject')}>반려</button>
        <button type="button" className="btn" disabled={busy} onClick={() => setAsk(false)}>취소</button></div>}
    </>}
    {busy && <p className="lv-note" role="status">처리하는 중…</p>}
    {loading && <p className="lv-note" role="status">지금 상태를 다시 불러오는 중…</p>}
    {err && <div className="fh-row"><p className="fh-msg" role="alert">{err} 상태를 확인하기 전에는 처리할 수 없습니다.</p><button type="button" className="btn" onClick={again}>다시 시도</button></div>}
    <Note m={msg} />
  </div>;
}
