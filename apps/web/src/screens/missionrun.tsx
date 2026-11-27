// 임무 실행 단추(팀장 05:09 «시작 · 일시정지 · 이어 가기 모든 기기» · 05 §6.5 서버 실시간 길 run.start · run.control).
// 관문(담당 · 조종권 · 배정 · 멈춤 확인)은 서버가 본다. 여기는 지금 상태에 맞는 주 단추 하나, 조종권 · 잠금 해제로 잇기, 보내는 중 · 거절 문구,
// 그리고 state.run 이 실제로 바뀐 뒤에만 성공 문구. STOP 은 머리줄 그대로(이 칸은 STOP 자리를 쓰지 않는다).
import { useEffect, useState } from 'react';
import type { Assignment, RunSnapshot, Scenario } from '../../../contracts/ts';
import { api } from '../api';
import type { Robot } from '../fake';
import { rt, runSay, useLive, type RunReq } from '../rt';
import './missiontab.css';   // .mr 틀(폰 시나리오 시트에서도)

const DONE = ['COMPLETED', 'FAILED', 'CANCELED'];
const STATUS: Record<RunSnapshot['status'], string> = {
  QUEUED: '줄 서는 중', PREPARING: '준비 중', MOVING: '이동 중', AT_WAYPOINT: '지점 도착', PERFORMING: '할 일 하는 중', WAIT_CONFIRM: '확인 기다림',
  PAUSED: '일시정지', COMPLETED: '끝남', FAILED: '실패', CANCELED: '취소됨',
};
const OK: Record<RunReq['op'], string> = { start: '임무를 시작했습니다.', pause: '임무를 일시정지했습니다.', resume: '임무를 이어 갑니다.', abort: '임무를 취소했습니다.' };
/** 로봇 결과만이 아니라 state.run 이 그 명령대로 바뀌었는가 */
const shows = (q: RunReq, r: RunSnapshot | null | undefined) => !!r && r.run_id === q.run_id
  && (q.op === 'start' ? true : q.op === 'pause' ? r.status === 'PAUSED' : q.op === 'resume' ? r.status !== 'PAUSED' && !DONE.includes(r.status) : r.status === 'CANCELED');

/** 이 로봇 · 이 임무의 ACTIVE 배정(없으면 null, 받는 중 undefined) */
export function useAssign(robot: string, scen: string | undefined, cancel?: AbortSignal) {
  const [a, setA] = useState<Assignment | null | undefined>(undefined);
  useEffect(() => {
    if (!scen) return setA(null);
    let live = true; setA(undefined);
    api.assignments(robot, cancel).then((l) => { if (live) setA(l.find((x) => x.status === 'ACTIVE' && x.scenario_id === scen) ?? null); }, () => { if (live) setA(null); });
    return () => { live = false; };
  }, [robot, scen]);
  return a;
}

/** 배정의 판(효력 판)이 화면의 판과 다르면 그 판의 층 · 지도 판을 받는다 */
function useRef0(scen: Scenario | null | undefined, a: Assignment | null | undefined) {
  const v = a ? a.effective_scenario_version ?? a.scenario_version : null;
  const [x, setX] = useState<Scenario | null>(null);
  useEffect(() => {
    setX(null);
    if (!scen || v == null || v === scen.version) return;
    let live = true;
    api.plan('scenarios', scen.id, v).then((s) => { if (live) setX(s as Scenario); }, () => {});
    return () => { live = false; };
  }, [scen?.id, scen?.version, v]);
  const s = scen && v === scen.version ? scen : x;
  return a && s && v != null && s.floor_ids[0] && s.map_version_ids[0]
    ? { assignment_id: a.id, scenario_id: s.id, scenario_version: v, floor_id: s.floor_ids[0], map_version_id: s.map_version_ids[0] } : null;
}

/** robot 한 대의 실행 칸. watch = 이 칸이 그 로봇의 조종 화면 노릇(조종권을 쥐고 있게, 닫으면 돌려줌). 폰 조종 화면 안에서는 이미 조종 화면이라 false */
export function RunCtl({ robot, scen, assign, watch = false }: { robot: Robot; scen?: Scenario | null; assign: Assignment | null | undefined; watch?: boolean }) {
  useEffect(() => (watch ? rt.watch(robot.id) : undefined), [robot.id, watch]);
  const l = useLive(robot.id), r = l.state?.run, on = !!r && !DONE.includes(r.status), q = l.runReq;
  const ref = useRef0(scen, assign), [ask, setAsk] = useState(false);
  const busy = !!q && (q.phase === 'sending' || q.phase === 'sent' || (q.phase === 'done' && !shows(q, r)));
  const send = (op: RunReq['op']) => { setAsk(false); if (op === 'start') { if (ref) rt.run(robot.id, 'start', { run_id: crypto.randomUUID(), ...ref }); } else if (r) rt.run(robot.id, op, { run_id: r.run_id }); };

  // 앞 단계: 조종권 · 잠금 해제 · 배정. 단추를 회색으로 두지 않고 그다음 할 일로 잇는다
  let gate: JSX.Element | null = null;
  // N1: 실기는 서버가 현장 승인 · 서버 조종 켬 전에는 run.start · run.control 을 RUN_NOT_ALLOWED 로 거절(#537 blocked_agent_control). 단추 대신 까닭 한 줄
  if (!robot.sim) gate = <span>실기는 아직 화면에서 임무를 실행할 수 없습니다 · 현장 승인과 서버 조종이 켜진 뒤에 됩니다. 멈추려면 STOP.</span>;
  else if (!l.lease) gate = l.holder && l.holder.type === 'USER'
    ? <><span>{l.holder.name} 님이 조종 중입니다.</span><button type="button" className="btn" disabled={!!l.outgoing} onClick={() => rt.request(robot.id)}>조종권 요청</button></>
    : l.holder ? <span>다른 실행이 조종권을 쥐고 있습니다. 끝나거나 멈춘 뒤 다시 보세요.</span>
    : <><span>실행 단추는 조종권이 있어야 보냅니다.</span><button type="button" className="btn pri" disabled={l.busy === 'take'} onClick={() => rt.take(robot.id)}>조종권 잡기</button></>;
  else if (l.state?.latched) gate = <><span>로봇이 정지 잠금 상태입니다.</span><button type="button" className="btn pri" onClick={() => rt.unlock(robot.id)}>잠금 해제</button></>;
  else if (!on && assign === null) gate = <span>이 로봇에 이 임무의 배정이 없습니다. PC 임무 탭에서 로봇에 배정하세요.</span>;
  else if (!on && !ref) gate = <span role="status">배정 · 지도 판을 확인하는 중…</span>;

  const say = q?.phase === 'rejected' ? runSay(q.code ?? '', robot.name) : busy ? '보내는 중…' : q?.phase === 'done' ? OK[q.op] : '';
  const main = on ? (r!.status === 'PAUSED' ? ['resume', '이어 가기'] : ['pause', '일시정지']) : ['start', '실행'];
  return <div className="mr" data-run-ctl={robot.id}>
    <div className="mr-head"><b>{robot.name}</b>{r && <span className="lbl" data-run-status>{STATUS[r.status]}{on ? ` · ${r.progress.done}/${r.progress.total}` : ''}</span>}</div>
    {gate ? <p className="mr-gate" data-run-gate>{gate}</p>
      : <div className="mr-row">
        <button type="button" className="btn pri" data-run-main={main[0]} disabled={busy} onClick={() => send(main[0] as RunReq['op'])}>{main[1]}</button>
        {on && !ask && <button type="button" className="btn" disabled={busy} onClick={() => setAsk(true)}>취소</button>}
      </div>}
    {ask && on && !gate && <p className="mr-gate" data-run-confirm><span>임무를 취소할까요? 로봇은 그 자리에서 멈춥니다.</span>
      <button type="button" className="btn" onClick={() => send('abort')}>취소 확정</button><button type="button" className="btn" onClick={() => setAsk(false)}>아니오</button></p>}
    {say && <p className={q?.phase === 'rejected' ? 'fh-msg' : 'lv-note'} role={q?.phase === 'rejected' ? 'alert' : 'status'} data-run-say>{say}</p>}
  </div>;
}
