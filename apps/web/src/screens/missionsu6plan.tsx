/** 시안 u6_3 · u6_4 · u6_5 만들기와 u15_1 시간 넘김 알림. 머리줄(이름 · 지도 · 로봇 · 걷기 모드 · 시간 칩 · 목록 / 노드 / 지도) · 가운데 · 왼쪽 · 오른쪽 «이 임무» 모두 시안 DOM.
 *  편집 상태 · 저장 · 저장 확인 · 충돌 · 휴지통 · 저장 기록은 지도 탭 편집 칸과 같은 훅(missions.tsx usePlanEdit) */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Estimate, Mission, ScenarioWrite } from '../../../contracts/ts';
import type { Robot, User } from '../fake';
import { floorName, Note, type Msg, type Place } from './maps';
import { usePlanEdit } from './missions';
import { Guess, hm, hourOf, mins, MODES, type Plan } from './missiontab';
import { IC, Ic, Why, dist } from './missionsu6';
import { blockOf, EditMap, ListPane, MapSteps, NodePane, useDraftRoute, type Look } from './missionsu6edit';
import { RouteStage } from './missionsu6';

const GAIT_NOTE: Record<string, string> = { classic: '평지 기본', sport: '빠른 걷기', start: '험지 기본', ame2: '준비 중' };

type Props = { id: string; floor: string; robot: string; gait: string; user: User; robots: Robot[]; cancel?: AbortSignal; places: Place[]; p: Plan; jobs: Record<string, Mission>;
  /** 일정 칸 임무 이름(시나리오 목록에서 · ScheduleSlot.scenario_name 이 오면 그것) */ names: (id: string | null) => string | undefined;
  close: () => void; saved: (id: string) => void; rehearse: () => void };

/** 저장으로 새 id 가 생기면 그 id 로 다시 연다(지도 탭 편집 칸과 같음) */
export function MissionPlan(props: Props) {
  const [cur, setCur] = useState(props.id), [msg, setMsg] = useState<Msg>(null), [look, setLook] = useState<Look>('list');
  const { p, robot, gait } = props;
  // 새 임무 고르기(u6_2)에서 고른 로봇 · 걷기 모드를 일정 칸 값으로(예상 · 시간 넘김 판정이 그 값으로 나온다)
  useEffect(() => { if (robot && p.rid !== robot) p.setRid(robot); if (gait && p.gait !== gait) p.setGait(gait as Plan['gait']); }, [robot, gait]);   // eslint-disable-line react-hooks/exhaustive-deps
  return <Body key={cur} {...props} id={cur} look={look} setLook={setLook} msg={msg}
    done={(x, m) => { setMsg(m); if (x) { props.saved(x.id); if (x.id !== cur) setCur(x.id); } }} />;
}

function Body({ id, floor, user, robots, cancel, places, p, jobs, names, close, rehearse, look, setLook, msg, done }: Props & { look: Look; setLook: (l: Look) => void; msg: Msg; done: (x: { id: string } | null, m: Msg) => void }) {
  const e = usePlanEdit('scenarios', id, user, cancel, (x, m) => done(x, m));
  const body = e.body as ScenarioWrite | null, ro = !!e.view || !e.editable;
  const { x, route, checking } = useDraftRoute(body, id, floor, places, cancel);
  const block = blockOf(body, route, checking);
  useEffect(() => { e.setBlock(block); }, [block]);   // eslint-disable-line react-hooks/exhaustive-deps
  const [sel, setSel] = useState<number | 'end' | null>(null), [adding, setAdding] = useState(false), [pending, setPending] = useState<Mission | null>(null), [last, setLast] = useState<number | null>(null);
  // 시안처럼 처음엔 첫 할 일을 골라 자세히를 보인다(한 번만)
  const first = useRef(true);
  useEffect(() => { if (first.current && body?.waypoints.length) { first.current = false; setSel(0); } }, [body]);   // eslint-disable-line react-hooks/exhaustive-deps
  const put = (b: ScenarioWrite) => {
    if (e.lock || ro || !body) return;
    if (b.waypoints.length > body.waypoints.length) setLast(b.waypoints.length - 1); else setLast(null);
    e.setBody(b); e.setBad([]); e.setMsg(null);
  };
  const ed = body && { body, put, ro, jobs };
  const r = robots.find((y) => y.id === p.rid), g = p.gait, gName = MODES.find(([, v]) => v === g)?.[0];
  const place = route.place ?? places.find((y) => y.floor.id === floor);
  const seg = (v: Look, label: string, cls: string, d: React.ReactNode) => <button type="button" className={`${look === v ? 'on ' : ''}${cls}`} aria-pressed={look === v} data-look={v} onClick={() => setLook(v)}><Ic d={d} />{label}</button>;
  const nameBad = e.bad.find((b) => b.at === 'name');
  const pick = (i: number | null) => { setSel(i); };
  const map = ed && <EditMap e={ed} x={x} route={route} sel={typeof sel === 'number' ? sel : null} setSel={pick} pending={pending ?? null}
    setPending={(m) => { setPending(m); setAdding(false); }} robot={r} />;
  return <section aria-label="임무 편집" data-plan>
    <div className="hdr">
      <input className="ttl" data-name aria-label="임무 이름" placeholder="새 임무" maxLength={128} readOnly={ro} aria-invalid={!!nameBad} value={body?.name ?? ''}
        onChange={(ev) => body && put({ ...body, name: ev.target.value })} style={{ fontSize: '26px', marginRight: '6px', background: 'none', border: '0', color: 'inherit', outline: 'none', width: `${Math.max(4, (body?.name ?? '').length + 1)}em`, maxWidth: '420px', padding: 0 }} />
      <span className="lab" style={{ marginRight: '8px' }}>{e.view ? `${e.view.number}번째 저장 · 보기만` : e.archived ? '휴지통' : !id ? '작성 중' : e.dirty ? '고치는 중' : '저장됨'}</span>
      <span className="g dk chip"><Ic d={IC.map} />{place ? floorName(place.floor.name) : '층 고르지 않음'}<small>{route.v ? `판 ${route.v.number}` : ''}</small></span>
      <span className="g dk chip"><Ic d={IC.robot} />{r ? r.name : '로봇 고르지 않음'}<small>{r ? (r.sim ? '시뮬' : '실제') : ''}</small></span>
      <span className="g dk chip"><Ic d={IC.mount} />{gName ?? '걷기 모드 없음'}<small>{g ? GAIT_NOTE[g] : ''}</small></span>
      <span className="g dk chip"><Ic d={IC.clock} />{p.start} ~ {p.end}<small /></span>
      <div className="row" style={{ marginLeft: 'auto', gap: '10px' }}>
        {/* 시안 밖 · 새로 그림: 목록으로 돌아가기(시안 u6_3 에는 없음) */}<button type="button" className="btns" style={{ height: '44px', padding: '0 16px', fontSize: '14.5px' }} onClick={close} data-back-list>‹ 임무 목록</button>
        {!ro && body && <button type="button" className="btnp" style={{ height: '44px', padding: '0 18px', fontSize: '14.5px' }} disabled={e.lock || !!block || (!e.dirty && !!id)} title={block ?? undefined} onClick={() => e.save()} data-save>
          <Ic d={IC.check} />{e.busy ? '저장하는 중…' : '저장'}</button>}
        <div className="seg2 wseg" role="group" aria-label="목록 · 노드 · 지도 보기">{seg('list', '목록', 'w-list', IC.list)}{seg('node', '노드', 'w-node', IC.node)}{seg('map', '지도', 'w-pin', IC.pin)}</div></div>
    </div>
    {!body ? <div className="pane" style={{ left: '24px', top: '156px', width: '1500px', bottom: '24px', padding: '22px' }}>
      {e.err ? <p className="lab u6-why" role="alert">{e.err.text} <button type="button" className="btns" onClick={() => { e.setErr(null); e.load(e.err!.adopt); }}>다시 받기</button></p> : <Why>불러오는 중…</Why>}</div>
      : look === 'list' ? <>
        <ListPane e={ed!} route={route} sel={sel} setSel={setSel} adding={adding} setAdding={(b) => { setAdding(b); setPending(null); }} />
        <div className="map" style={{ left: '548px', top: '156px', width: '976px', height: '900px', maxHeight: 'calc(100% - 180px)' }} aria-label="편집 지도">{map}
          {adding && <div className="g dk pill" style={{ left: '16px', bottom: '16px' }} data-add-hint><Ic d={IC.pin} />지도를 누르면 그 자리에 할 일을 고릅니다</div>}</div></>
      : look === 'node' ? <NodePane e={ed!} x={x} route={route} p={p} setSel={(i) => { setSel(i); setLook('list'); }} pickJob={(m) => { setPending(m); setLook('map'); }}
        mini={<div className="stage" style={{ inset: 0 }}><RouteStage x={x} route={route} still /></div>} />
      : <div className="map" style={{ left: '24px', top: '156px', width: '1500px', bottom: '24px' }} aria-label="편집 지도">{map}
        <MapSteps e={ed!} route={route} pending={pending} />
        <div className="g dk" style={{ position: 'absolute', left: '50%', bottom: '20px', transform: 'translateX(-50%)', zIndex: 3, display: 'flex', gap: '18px', alignItems: 'center', padding: '10px 18px', borderRadius: '14px', fontSize: '13.5px', fontWeight: '600', whiteSpace: 'nowrap' }}>
          <span className="row" style={{ gap: '4px' }}><kbd className="u6-kbd">누름</kbd>&nbsp;· <kbd className="u6-kbd">우클릭</kbd>&nbsp;이 자리에 할 일</span>
          {pending && <button type="button" className="lab u6-link" onClick={() => setPending(null)}>고르기 그만</button>}</div>
        {r && <span className="g dk pill" style={{ right: '20px', top: '20px', zIndex: 3, opacity: .55 }} aria-disabled="true" title="키보드 조종은 이 칸에 아직 없습니다(실기 안전 관문 · 속도 설정을 옮기기 전)" data-kbd-drive><Ic d={IC.robot} />키보드로 {r.name} 조종</span>}
      </div>}
    <Notices e={e} msg={msg} block={!ro && body ? block : null} />
    <This p={p} robots={robots} rehearse={rehearse} ready={!!id && !e.dirty && !e.lock} names={names} />
    {p.est && p.late && body && <Over p={p} est={p.est} last={last} drop={() => { if (last != null) { put({ ...body, waypoints: body.waypoints.filter((_, k) => k !== last) }); setLast(null); } }} jobs={jobs} body={body} />}
  </section>;
}

/** 저장 · 확인 · 충돌 · 휴지통 알림 줄(옛 편집 칸 알림 띠와 같은 분기 · 지도 위 왼쪽 위) */
function Notices({ e, msg, block }: { e: ReturnType<typeof usePlanEdit>; msg: Msg; block: string | null }) {
  const any = msg || e.msg || e.view || e.archived || e.conflict || e.unsure || e.busy || block;
  if (!any) return null;
  return <div className="g dk" style={{ left: '560px', top: '168px', maxWidth: '940px', padding: '10px 14px', borderRadius: '14px', zIndex: 6, display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '13.5px', fontWeight: '600' }} data-notices>
    {msg && <Note m={msg} />}
    {e.view && <span data-old>옛 기록({e.view.number}번째 저장)을 보는 중입니다(읽기 전용).</span>}
    {!e.view && e.archived && <span className="row" style={{ gap: '8px' }} data-readonly>휴지통에 있는 시나리오입니다. 고칠 수 없습니다. 복원하면 다시 고칩니다.<button type="button" className="btns" disabled={e.busy} onClick={e.restore}>복원</button></span>}
    {e.busy && <span role="status">저장하는 중…</span>}
    {e.msg && <Note m={e.msg} />}
    {block && <span className="mu2" id="plan-block" data-block>{block}</span>}
    {e.conflict && <span><button type="button" className="btns" disabled={e.lock} onClick={() => e.load('base')} data-conflict>최신 내용 받기</button></span>}
    {e.unsure && <span className="row" style={{ gap: '8px' }}><button type="button" className="btns" disabled={e.checking} onClick={() => e.check(e.unsure!)}>저장 확인</button>
      <button type="button" className="btns" disabled={e.checking || e.again} onClick={() => e.setAgain(true)}>다시 저장</button>{e.checking && <span role="status">저장됐는지 확인하는 중…</span>}</span>}
    {e.unsure && e.again && <span className="row" style={{ gap: '8px' }} role="group" aria-label="다시 저장 확인">이미 저장됐을 수 있습니다. 다시 보내면 같은 임무가 두 번 생길 수 있어요.
      <button type="button" className="btnp" onClick={() => { const u = e.unsure!; e.setUnsure(null); e.setAgain(false); e.send(u.body); }}>그래도 다시 저장</button>
      <button type="button" className="btns" onClick={() => e.setAgain(false)}>닫기</button></span>}
  </div>;
}

/** 시안 u15_1: 고른 시간대를 넘기면 노란 알림 · 방금 넣은 작업 빼기 · 끝 늘리기 · 다른 로봇과 나누기(서버 값 필요 · 서버에 요청함) */
function Over({ p, est, last, drop, jobs, body }: { p: Plan; est: Estimate; last: number | null; drop: () => void; jobs: Record<string, Mission>; body: ScenarioWrite }) {
  const eta = new Date(est.eta), over = Math.round((eta.getTime() - new Date(new Date().toDateString() + ' ' + p.end).getTime()) / 60000);
  const up = new Date(eta); up.setMinutes(Math.ceil(eta.getMinutes() / 10) * 10, 0, 0); const upHm = hm(up.toISOString());
  const w = last != null ? body.waypoints[last] : undefined;
  return <div className="toastw" style={{ left: '560px', top: '168px', width: '860px' }} role="alert" data-time-over>
    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}><span style={{ width: '36px', height: '36px', borderRadius: '11px', background: 'rgba(242,183,5,.18)', color: '#f2b705', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Ic d={IC.clock} /></span>
      <div style={{ flex: '1' }}><div style={{ fontSize: '16.5px', fontWeight: '800' }}>고른 시간대 {p.start} ~ {p.end} 을 {over} 분 넘깁니다</div>
        <div style={{ fontSize: '13px', fontWeight: '600', marginTop: '3px' }} className="u6-sub">{w ? `방금 넣은 「${jobs[w.mission_id]?.name ?? '할 일'}」 까지 더하면 ` : ''}예상 끝이 {hm(est.eta)} 입니다. 저장은 되지만 일정에 넣을 때 다시 묻습니다.</div></div></div>
    <div style={{ display: 'flex', gap: '8px', marginTop: '12px', marginLeft: '48px' }}>
      <button type="button" className="chipb" disabled={!w} title={w ? undefined : '이번에 넣은 작업이 없습니다'} onClick={drop} data-over-drop>방금 넣은 작업 빼기</button>
      <button type="button" className="chipb" onClick={() => p.setEnd(upHm)} data-over-extend>끝을 {upHm} 으로 늘리기</button>
      <button type="button" className="chipb" disabled title="나눌 로봇 · 나눈 뒤 예상은 서버 값이 필요합니다(요청 중)" data-over-split>다른 로봇과 나누기</button></div>
  </div>;
}

/** 오른쪽 «이 임무»: 길이 · 걷기 + 할 일 · 예상 끝 · 끝 배터리(일정 칸에서 고른 로봇 · 걷기 모드로 받은 예상) · 모의 실행 전 · 같은 시간대 다른 로봇(오늘 일정) */
function This({ p, robots, rehearse, ready, names }: { p: Plan; robots: Robot[]; rehearse: () => void; ready: boolean; names: (id: string | null) => string | undefined }) {
  const e: Estimate | null = p.est, [ln, lu] = e ? dist(e.length_m) : ['없음', ''];
  const a = hourOf(new Date(new Date().toDateString() + ' ' + p.start).toISOString()), b = hourOf(new Date(new Date().toDateString() + ' ' + p.end).toISOString());
  const lo = a - 0.5, hi = b + 0.5, f = (h: number) => `${Math.max(0, Math.min(1, (h - lo) / (hi - lo))) * 100}%`;
  const mine = robots.find((r) => r.id === p.rid);   // 시안 첫 줄: 고른 로봇 · 이 임무(예상 끝까지)
  const others = useMemo(() => (p.slots ?? []).filter((s) => hourOf(s.end) > a && hourOf(s.start) < b).slice(0, mine ? 3 : 4), [p.slots, a, b, mine]);
  const sims = robots.filter((r) => r.sim);
  return <div className="pane" style={{ left: '1548px', top: '156px', right: '24px', bottom: '24px', padding: '22px' }} aria-label="이 임무">
    <div className="lab">이 임무</div>
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: '16px', rowGap: '14px', marginTop: '14px' }}>
      <div><div className="lab">길이</div><b className="num" style={{ fontSize: '22px' }}>{ln}</b><small className="mu2"> {lu}</small></div>
      <div><div className="lab">걷기 + 할 일</div><b className="num" style={{ fontSize: '22px' }}>{e ? `${mins(e.walk_s)} + ${mins(e.task_s)}` : '없음'}</b>{e && <small className="mu2"> 분</small>}{e && <Guess e={e} />}</div>
      <div><div className="lab">예상 끝</div><b className="num" style={{ fontSize: '22px' }} data-plan-eta>{e ? hm(e.eta) : '없음'}</b></div>
      <div><div className="lab">종료 시 배터리</div><b className="num" style={{ fontSize: '22px' }}>{e?.end_battery_pct != null ? Math.round(e.end_battery_pct) : '없음'}</b>{e?.end_battery_pct != null && <small className="mu2"> %</small>}</div>
    </div>
    {!e && <Why>예상은 저장한 임무를 로봇 · 걷기 모드와 함께 고르면 나옵니다.</Why>}
    <div style={{ marginTop: '18px', padding: '14px', borderRadius: '14px', border: '1.5px dashed rgba(159,182,255,.5)', background: 'rgba(159,182,255,.06)' }}>
      <div className="row" style={{ gap: '8px', fontSize: '14px', fontWeight: '800', color: '#4c9bff' }}><Ic d={IC.play} />모의 실행 전</div>
      <div className="lab" style={{ marginTop: '6px', lineHeight: '1.5', fontSize: '13px' }}>시뮬 로봇에서 이 임무를 실제로 돌려 지점 도착 · 할 일 결과를 봅니다.</div></div>
    <div className="lab" style={{ margin: '20px 0 8px' }}>같은 시간대 다른 로봇</div>
    {mine && <div className="row" style={{ gap: '10px', height: '34px', fontSize: '13.5px', fontWeight: '700' }} data-plan-mine>
      <span style={{ width: '64px' }}>{mine.name}</span>
      <span style={{ position: 'relative', flex: '1', height: '22px', borderRadius: '6px', background: 'rgba(255,255,255,.04)' }}>
        <i style={{ position: 'absolute', left: f(a), width: `calc(${f(b)} - ${f(a)})`, top: '-3px', bottom: '-3px', border: '1.5px solid rgba(0,195,137,.6)', borderRadius: '6px' }} />
        <i className="bk k2" style={{ left: f(a), width: `calc(${f(p.est ? Math.min(b, hourOf(p.est.eta)) : b)} - ${f(a)})`, top: 0, height: '22px', padding: 0 }} /></span>
      <span className="lab" style={{ width: '70px', textAlign: 'right' }}>이 임무</span></div>}
    {others.map((s) => <div key={s.id} className="row" style={{ gap: '10px', height: '34px', fontSize: '13.5px', fontWeight: '700' }} data-plan-other={s.id}>
      <span style={{ width: '64px' }}>{robots.find((r) => r.id === s.robot_id)?.name ?? '다른 로봇'}</span>
      <span style={{ position: 'relative', flex: '1', height: '22px', borderRadius: '6px', background: 'rgba(255,255,255,.04)' }}>
        <i style={{ position: 'absolute', left: f(a), width: `calc(${f(b)} - ${f(a)})`, top: '-3px', bottom: '-3px', border: '1.5px solid rgba(0,195,137,.6)', borderRadius: '6px' }} />
        <i className={`bk ${s.kind === 'DRAFT' ? 'k2' : 'kp'}`} style={{ left: f(hourOf(s.start)), width: `calc(${f(hourOf(s.end))} - ${f(hourOf(s.start))})`, top: 0, height: '22px', padding: 0 }} /></span>
      <span className="lab" style={{ width: '70px', textAlign: 'right', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={names(s.scenario_id) ?? undefined}>{names(s.scenario_id) ?? hm(s.start)}</span></div>)}
    {(mine || others.length > 0) && <div className="row lab num" style={{ gap: '10px', fontSize: '11.5px' }}><span style={{ width: '64px' }} /><span style={{ flex: '1', display: 'flex', justifyContent: 'space-between' }}>
      {[0, 1, 2, 3].map((k) => <span key={k}>{hhmm(lo + (k * (hi - lo)) / 3)}</span>)}</span><span style={{ width: '70px' }} /></div>}
    {p.slots && !others.length && !mine && <Why>이 시간대({p.start} ~ {p.end})에 다른 일정이 없습니다.</Why>}
    <button type="button" className="btnp" style={{ position: 'absolute', left: '22px', right: '22px', bottom: '22px', height: '54px', fontSize: '15.5px' }} disabled={!sims.length || !ready}
      title={!sims.length ? '모의 실행은 시뮬 로봇으로 돌립니다. 이 조직에 시뮬 로봇이 없습니다.' : !ready ? '저장한 뒤 모의 실행합니다.' : undefined} onClick={rehearse} data-plan-rehearse><Ic d={IC.play} />모의 실행 돌리기</button>
  </div>;
}

const hhmm = (h: number) => { const t = Math.round(((h % 24) + 24) % 24 * 60); return `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };
