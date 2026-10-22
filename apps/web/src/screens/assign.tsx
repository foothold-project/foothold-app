// 시나리오 배정(01 MS-04, 02 F-MS-05, 05 §6.4 — S5b /assignments). 임무 탭 시나리오 편집 칸 아래 배정 창 + 배정 목록(이 시나리오 / 로봇별), 폰 시나리오 시트 카드.
// 총괄 = 바로 ACTIVE, 운영 관리자 = PENDING «결재 대기»(시나리오 배정 결재). 보내기는 Idempotency-Key — 답을 못 받으면 «확인 중»으로 두고 목록을 다시 받아 판정, 같은 시도를 다시 보낼 땐 같은 키.
// 해제(DELETE)는 결재 없이(F-MS-05). 실행 단추는 실행기 전(S7)이라 «준비 중». STOP 은 App 머리줄 — 이 칸은 창 키를 잡지 않는다.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Assignment, AssignmentCreate } from '../../../contracts/ts';
import { ApiFail, api } from '../api';
import type { Robot, Tone, User } from '../fake';
import { Chip, soon, type Ctx } from '../screens';
import { Note, type Msg } from './maps';

const STATUS: Record<Assignment['status'], { tone: Tone; text: string }> = {
  ACTIVE: { tone: 'ok', text: '배정됨' }, PENDING: { tone: 'warn', text: '결재 대기' }, REJECTED: { tone: 'bad', text: '반려됨' }, REMOVED: { tone: 'off', text: '해제됨' } };
const status = (s: string) => STATUS[s as Assignment['status']] ?? { tone: 'off' as Tone, text: '알 수 없는 상태' };
/** 남의 로봇·범위 밖 — 회색 단추의 이유와 서버 403·404 에 같은 문구 */
export const OUT = '담당 로봇만 배정하거나 해제할 수 있습니다(남의 로봇이거나 볼 수 있는 범위 밖).';
const EXISTS = '이 로봇에는 이미 같은 시나리오 판이 배정되어 있거나 결재를 기다리고 있습니다. 아래 목록에서 확인하세요.';
const ARCHIVED = '보관된 시나리오는 배정할 수 없습니다.';
const live = (a: Assignment) => a.status === 'ACTIVE' || a.status === 'PENDING';
/** 서버가 답했는지 모름(끊김·마감·깨진 본문·5xx) — 처리됐을 수 있다 */
const unsure = (e: ApiFail) => (e.status === 0 && e.code !== 'CANCELED') || e.status >= 500;
const mineOf = (u: User, r: Robot) => u.role === 'ORG_ADMIN' || r.owner === u.id;

const str = (v: unknown) => typeof v === 'string';
const isAssignment = (a: Assignment) => !!a && str(a.id) && str(a.scenario_id) && Number.isInteger(a.scenario_version) && str(a.robot_id) && str(a.status) && str(a.scenario_name) && str(a.robot_name) && str(a.created_by);
const fit = <T,>(ok: (x: T) => boolean) => (x: T) => { if (!ok(x)) throw new ApiFail(0, 'BAD_SHAPE', '받은 배정 형식이 맞지 않습니다. 잠시 뒤 다시 시도하세요.'); return x; };
const isList = (l: Assignment[]) => Array.isArray(l) && l.every(isAssignment);
const newKey = () => (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);

/** 배정 목록 — robot 없음 = 조직 전체(scenario 로 거름). load() 는 받은 목록을 돌려준다(확인 중 판정) — 늦게 온 앞 요청의 답은 버린다 */
function useAssignments(robot: string | null, scenario: string | null, cancel?: AbortSignal) {
  const [items, setItems] = useState<Assignment[] | null>(null), [err, setErr] = useState(''), [busy, setBusy] = useState(true), seq = useRef(0), cur = useRef({ robot, scenario });
  cur.current = { robot, scenario };   // 앞 렌더에서 잡힌 load(처리 뒤 다시 받기)도 지금 보기로
  const load = () => {
    const k = ++seq.current, { robot, scenario } = cur.current;
    setBusy(true); setErr('');
    return api.assignments(robot, cancel).then(fit(isList)).then((l) => {
      const got = l.filter((a) => !scenario || a.scenario_id === scenario);
      if (k === seq.current) { setItems(got); setBusy(false); }
      return got;
    }, (e: ApiFail) => { if (k === seq.current && e.code !== 'CANCELED') { setErr(e.message); setBusy(false); } throw e; });
  };
  useEffect(() => { setItems(null); load().catch(() => {}); }, [robot, scenario]);
  return { items, err, busy, load };
}

/** 한 시도 = 보낸 본문 + 키 + 보내기 전에 있던 배정 ID(확인 중 판정에 새로 생긴 것만 보려고) */
type Try = { body: AssignmentCreate; key: string; known: string[] };

/** 배정 창 + 목록(시나리오 편집 칸 아래). version = 지금 보는 판(옛 판을 보면 그 판), archived = 보관된 시나리오 */
export function AssignPanel({ scenario, name, version, archived, user, robots, cancel }: { scenario: string; name: string; version: number; archived: boolean; user: User; robots: Robot[]; cancel?: AbortSignal }) {
  const [by, setBy] = useState(''), l = useAssignments(by || null, by ? null : scenario, cancel), [all, setAll] = useState(false);
  const [open, setOpen] = useState(false), [robot, setRobot] = useState(''), [memo, setMemo] = useState(''), [msg, setMsg] = useState<Msg>(null);
  const [phase, setPhase] = useState<'idle' | 'sending' | 'checking' | 'unsure'>('idle'), attempt = useRef<Try | null>(null);
  const [removing, setRemoving] = useState<Record<string, 'sending' | 'checking'>>({}), [canceled, setCanceled] = useState<Set<string>>(new Set());
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  // 이 판이 이미 ACTIVE·PENDING 인 로봇(이 시나리오 목록을 볼 때만 안다 — 로봇별 보기면 서버 409 가 막는다)
  const taken = new Map((by ? [] : l.items ?? []).filter((a) => live(a) && a.scenario_version === version).map((a) => [a.robot_id, a.status]));
  const why = (r: Robot) => (!mineOf(user, r) ? OUT : taken.has(r.id) ? (taken.get(r.id) === 'PENDING' ? '이 판은 이미 결재를 기다리고 있습니다.' : '이 판이 이미 배정되어 있습니다.') : null);
  const lock = phase !== 'idle';
  const nameOf = (id: string) => robots.find((r) => r.id === id)?.name ?? '로봇';

  const done = (a: Assignment) => {
    attempt.current = null; setPhase('idle'); setOpen(false); setRobot(''); setMemo('');
    setMsg(a.status === 'PENDING' ? { text: `결재 대기 — ${a.robot_name}에 «${a.scenario_name}» 판 ${a.scenario_version} 배정을 요청했습니다. 총괄 운영 관리자가 승인하면 적용됩니다.`, ok: true, mine: true }
      : { text: `${a.robot_name}에 «${a.scenario_name}» 판 ${a.scenario_version}을 배정했습니다. 바로 적용됩니다.`, ok: true });
    l.load().catch(() => {});
  };
  /** 확인 중: 그 로봇 목록을 다시 받아 보내기 전 없던 내 배정(같은 판·ACTIVE·PENDING)이 있으면 그것이 결과. 없거나 못 받으면 확정하지 않는다 */
  const check = (t: Try) => {
    setPhase('checking');
    api.assignments(t.body.robot_id, cancel).then(fit(isList)).then((list) => {
      if (!alive.current) return;
      const hit = list.find((a) => !t.known.includes(a.id) && a.created_by === user.id && a.scenario_id === t.body.scenario_id && a.scenario_version === t.body.scenario_version && live(a));
      if (hit) return done(hit);
      setPhase('unsure');
      setMsg({ text: '배정이 아직 목록에 없습니다. 서버가 처리하는 중일 수 있습니다. «다시 확인»을 누르거나 «같은 요청 다시 보내기»를 누르세요 — 같은 요청 번호로 보내 두 번 배정되지 않습니다.' });
    }, (e: ApiFail) => { if (!alive.current || e.code === 'CANCELED') return; setPhase('unsure'); setMsg({ text: `배정됐는지 확인하지 못했습니다. ${e.message} «다시 확인»을 누르세요.` }); });
  };
  const send = (t: Try) => {
    setPhase('sending'); setMsg(null);
    api.assign(t.body, t.key, cancel).then(fit(isAssignment)).then((a) => { if (alive.current) done(a); }, (e: ApiFail) => {
      if (!alive.current || e.code === 'CANCELED') return;
      if (unsure(e)) { setMsg({ text: '배정 응답을 받지 못했습니다. 처리됐을 수 있어 목록으로 확인하는 중입니다(확인 중).' }); check(t); return; }
      attempt.current = null; setPhase('idle');
      if (e.code === 'ASSIGNMENT_EXISTS') setMsg({ text: EXISTS });
      else if (e.code === 'SCENARIO_ARCHIVED') setMsg({ text: `${ARCHIVED} 보관되지 않은 시나리오를 고르세요.` });
      else if (e.status === 403 || e.status === 404) setMsg({ text: OUT });
      else { setMsg({ text: `배정하지 못했습니다. ${e.message}` }); return; }
      l.load().catch(() => {});
    });
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (lock) return;
    const r = robots.find((x) => x.id === robot);
    if (!r) return setMsg({ text: '배정할 로봇을 고르세요.' });
    const w = why(r);
    if (w) return setMsg({ text: w });
    if (/[\p{Cc}\p{Cf}]/u.test(memo)) return setMsg({ text: '메모에 탭 같은 보이지 않는 글자는 쓸 수 없습니다(이모지 일부도 이런 글자를 품습니다). 지우고 다시 입력하세요.' });
    const body: AssignmentCreate = { scenario_id: scenario, scenario_version: version, robot_id: r.id, memo: memo.trim() };
    // 보내기 전 그 로봇의 배정 ID — 확인 중에 새로 생긴 것만 결과로 본다
    setPhase('sending'); setMsg(null);
    api.assignments(r.id, cancel).then(fit(isList)).then((list) => {
      if (!alive.current) return;
      const t = attempt.current = { body, key: newKey(), known: list.map((a) => a.id) };
      send(t);
    }, (x: ApiFail) => { if (!alive.current || x.code === 'CANCELED') return; setPhase('idle'); setMsg({ text: `배정하지 못했습니다. 보내기 전에 그 로봇의 배정 목록을 받지 못해 보내지 않았습니다. ${x.message}` }); });
  };

  const remove = (a: Assignment) => {
    if (removing[a.id]) return;
    const was = a.status, mark = (s?: 'sending' | 'checking') => setRemoving((o) => { const n = { ...o }; if (s) n[a.id] = s; else delete n[a.id]; return n; });
    const ok = () => {
      if (was === 'PENDING') setCanceled((s) => new Set(s).add(a.id));
      setMsg({ text: was === 'PENDING' ? `${a.robot_name}의 «${a.scenario_name}» 배정 요청을 해제했습니다. 결재 요청도 취소됐습니다.` : `${a.robot_name}에서 «${a.scenario_name}» 판 ${a.scenario_version} 배정을 해제했습니다.`, ok: true });
    };
    mark('sending'); setMsg(null);
    api.unassign(a.id, cancel).then(() => { if (!alive.current) return; mark(); ok(); l.load().catch(() => {}); }, (e: ApiFail) => {
      if (!alive.current || e.code === 'CANCELED') return;
      if (!unsure(e)) { mark(); setMsg({ text: e.status === 403 || e.status === 404 ? OUT : `해제하지 못했습니다. ${e.message}` }); l.load().catch(() => {}); return; }
      // 확인 중: 목록을 다시 받아 그 배정이 해제됐는지로만 판정
      mark('checking');
      api.assignments(a.robot_id, cancel).then(fit(isList)).then((list) => {
        if (!alive.current) return;
        mark();
        const now = list.find((x) => x.id === a.id);
        if (!now || now.status === 'REMOVED') ok();
        else setMsg({ text: `해제가 확인되지 않았습니다(지금 ${status(now.status).text}). 해제는 다시 눌러도 안전합니다 — 다시 누르세요.` });
        l.load().catch(() => {});
      }, (x: ApiFail) => { if (!alive.current || x.code === 'CANCELED') return; mark(); setMsg({ text: `해제됐는지 확인하지 못했습니다. ${x.message} 목록을 다시 받은 뒤 확인하세요.` }); });
    });
  };

  const shown = (l.items ?? []).filter((a) => all || live(a) || removing[a.id] || canceled.has(a.id));
  const blocked = archived ? ARCHIVED : null;
  return <section className="fh-form" aria-label="배정" data-assign>
    <div className="fh-row"><h3 className="fh-grow">배정</h3>
      <button type="button" className="btn pri" disabled={!!blocked || open} aria-describedby={blocked ? 'assign-why' : undefined} onClick={() => { setOpen(true); setMsg(null); }}>로봇에 배정</button>
      {blocked && <span id="assign-why" className="fh-why" data-why>{blocked}</span>}</div>
    {open && <form className="fh-form" onSubmit={submit} noValidate aria-label="배정 창">
      <p className="lv-note">«{name}» 판 {version}을 배정합니다. {user.role === 'ORG_ADMIN' ? '총괄은 바로 적용됩니다.' : '운영 관리자는 결재 요청이 되고, 총괄이 승인하면 적용됩니다.'}</p>
      <fieldset disabled={lock} style={{ display: 'contents' }}>
        <div className="fh-form" role="group" aria-label="로봇 고르기">{robots.map((r) => { const w = why(r); return <div key={r.id} className="fh-row">
          <button type="button" className="btn" aria-pressed={robot === r.id} disabled={!!w} aria-describedby={w ? `assign-${r.id}` : undefined} data-robot={r.id} onClick={() => setRobot(r.id)}>{r.name}</button>
          {w && <span id={`assign-${r.id}`} className="fh-why" data-why>{w}</span>}</div>; })}
          {!robots.length && <p className="lv-note">고를 수 있는 로봇이 없습니다.</p>}</div>
        <label className="fh-field"><span>메모(선택{user.role === 'ORG_ADMIN' ? '' : ' — 결재 요청 이유로 보입니다'})</span><input className="inp" maxLength={2000} value={memo} onChange={(e) => setMemo(e.target.value)} /></label>
      </fieldset>
      <div className="fh-row">
        {phase === 'unsure' ? <>
          <button type="button" className="btn pri" onClick={() => attempt.current && send(attempt.current)}>같은 요청 다시 보내기</button>
          <button type="button" className="btn" onClick={() => attempt.current && check(attempt.current)}>다시 확인</button>
          <button type="button" className="btn" onClick={() => { attempt.current = null; setPhase('idle'); setOpen(false); setMsg({ text: '배정 결과를 확정하지 못한 채 창을 닫았습니다. 아래 목록에서 배정됐는지 확인하세요.' }); l.load().catch(() => {}); }}>닫기</button>
        </> : <>
          <button type="submit" className="btn pri" disabled={lock || !robot}>{user.role === 'ORG_ADMIN' ? '배정' : '결재 요청'}</button>
          <button type="button" className="btn" disabled={lock} onClick={() => { setOpen(false); setMsg(null); }}>닫기</button></>}
        {phase === 'sending' && <span className="lv-note" role="status">보내는 중…</span>}
        {phase === 'checking' && <span className="lv-note" role="status" data-checking>확인 중 — 목록을 다시 받는 중…</span>}
      </div>
    </form>}
    <Note m={msg} />
    <div className="fh-row">
      <label className="fh-row"><span>보기</span><select className="inp" aria-label="배정 보기" value={by} onChange={(e) => setBy(e.target.value)}>
        <option value="">이 시나리오</option>{robots.map((r) => <option key={r.id} value={r.id}>{r.name}(로봇별)</option>)}</select></label>
      <label className="fh-row"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /><span>해제·반려된 것도 보기</span></label></div>
    <ul className="fh-list" aria-label="배정 목록">{shown.map((a) => { const r = robots.find((x) => x.id === a.robot_id), w = r ? (mineOf(user, r) ? null : OUT) : OUT, busy = removing[a.id];
      return <li key={a.id} className="fh-row" data-assignment={a.id}>
        <Chip {...(busy === 'checking' ? { tone: 'warn' as Tone, text: '확인 중' } : status(a.status))} />
        <b>{by ? `${a.scenario_name} · 판 ${a.scenario_version}` : `${a.robot_name} · 판 ${a.scenario_version}`}</b>
        {canceled.has(a.id) && <span className="lbl" data-canceled>결재 취소됨</span>}
        <span className="lbl fh-grow" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{a.memo}</span>
        {live(a) && <><button type="button" className="btn" disabled={!!w || !!busy} aria-describedby={w ? `unassign-${a.id}` : undefined} onClick={() => remove(a)}>{busy === 'sending' ? '해제하는 중…' : '해제'}</button>
          {w && <span id={`unassign-${a.id}`} className="fh-why" data-why>{w}</span>}</>}
      </li>; })}</ul>
    {l.items && !shown.length && !l.err && <p className="lv-note">{by ? `${nameOf(by)}에 배정된 시나리오가 없습니다.` : '이 시나리오는 아직 어느 로봇에도 배정되지 않았습니다.'}</p>}
    {l.busy && <p className="lv-note" role="status">배정 목록을 불러오는 중…</p>}
    {l.err && <div className="fh-row"><p className="fh-msg" role="alert">배정 목록을 받지 못했습니다. {l.err}</p><button type="button" className="btn" onClick={() => { l.load().catch(() => {}); }}>다시 시도</button></div>}
  </section>;
}

/** 폰 시나리오 시트: 이 로봇에 배정된 시나리오 카드(ACTIVE·결재 대기). 실행은 실행기 전이라 «준비 중» 비활성 */
export function AssignedCards(c: Pick<Ctx, 'robot' | 'cancel'>) {
  const l = useAssignments(c.robot.id, null, c.cancel), cards = (l.items ?? []).filter(live);
  return <>
    <h2>배정된 시나리오</h2>
    {cards.map((a) => <section key={a.id} className="lv-card" data-card={a.id}>
      <div className="fh-row"><h2 className="fh-grow">{a.scenario_name}</h2><Chip {...status(a.status)} /></div>
      <p className="lv-note">판 {a.scenario_version}{a.memo ? ` · ${a.memo}` : ''}</p>
      <div className="fh-row"><button type="button" className="btn pri" aria-label={`${a.scenario_name} 실행(준비 중)`} {...soon}>▶ 실행(준비 중)</button></div>
    </section>)}
    {l.items && !cards.length && !l.err && <p className="lv-note">이 로봇에 배정된 시나리오가 없습니다.</p>}
    {l.busy && <p className="lv-note" role="status">배정된 시나리오를 불러오는 중…</p>}
    {l.err && <div className="fh-row"><p className="fh-msg" role="alert">배정된 시나리오를 받지 못했습니다. {l.err}</p><button type="button" className="btn" onClick={() => { l.load().catch(() => {}); }}>다시 시도</button></div>}
  </>;
}
