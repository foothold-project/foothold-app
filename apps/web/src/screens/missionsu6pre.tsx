/** 시안 u15_2 «실제 로봇 시작 전 점검» 창과, 모의 실행(u6_6)이 같이 쓰는 실행 관문.
 *  관문 순서는 옛 실행 칸(missionrun RunCtl)과 같다: 실기 실행 기능 · 조종권 · 정지 잠금 · 배정 · 판 확인. 서버가 다시 본다.
 *  점검 줄은 모두 실제 값: 연결(화면 소켓 · 로봇 latency_ms) · 조종권(holder) · 로봇 상태(걸음 · 자세 · 배터리 · 관절 온도 최고) · 시작 자리(로봇 위치와 첫 지점 거리) */
import { useEffect, useState } from 'react';
import type { Assignment, RunSnapshot, Scenario } from '../../../contracts/ts';
import { ApiFail, api } from '../api';
import type { Robot, User } from '../fake';
import { rt, runSay, useLive, type RunReq } from '../rt';
import { useAssign, useRef0 } from './missionrun';
import { IC, Ic } from './missionsu6';

const DONE: RunSnapshot['status'][] = ['COMPLETED', 'FAILED', 'CANCELED'];
const GAIT: Record<string, string> = { classic: 'Classic', sport: 'Sport', start: 'START', ame2: 'AME-2' };
const POSE: Record<string, string> = { STANDING: '서 있음', LYING: '엎드림', TRANSITIONING: '자세 바꾸는 중', UNKNOWN: '자세 모름' };
/** 시작 자리 어긋남이 이보다 크면 주의(m) */
export const START_OFF_M = 0.5;

export type Row = { key: string; ok: boolean; label: string; text: string };
export type Act = { label: string; run: () => void; busy?: boolean } | null;

/** 한 로봇 · 한 임무의 실행 관문. go = 실행(run.start), act = 지금 막힌 관문을 푸는 한 단추(조종권 잡기 · 잠금 해제 · 배정) */
export function useRunGate(robot: Robot | undefined, scen: Scenario | undefined, user: User, cancel?: AbortSignal) {
  const id = robot?.id ?? '';
  useEffect(() => (id ? rt.watch(id) : undefined), [id]);
  const l = useLive(id), link = rt.link(), s = l.state, run = s?.run, on = !!run && !DONE.includes(run.status), q = l.runReq;
  const [n, setN] = useState(0), a0 = useAssign(id, scen?.id, cancel), [made, setMade] = useState<Assignment | null>(null);
  useEffect(() => setMade(null), [id, scen?.id]);
  const assign = made ?? a0, ref = useRef0(scen ?? null, assign);
  const [busy, setBusy] = useState(false), [err, setErr] = useState(''), [key, setKey] = useState(''), [mine, setMine] = useState('');
  void n;
  useEffect(() => { setErr(''); setKey(''); setMine(''); }, [id, scen?.id]);

  const rows: Row[] = [];
  const net = link.at === 'open', lat = s?.latency_ms;
  rows.push({ key: 'link', ok: net && s?.connection === 'ONLINE', label: '연결',
    text: !net ? link.why ?? '서버에 연결하는 중' : s?.connection !== 'ONLINE' ? '로봇이 끊겨 있음' : `서버 · 로봇${lat != null ? ` ${Math.round(lat)} ms` : ''}` });
  rows.push({ key: 'lease', ok: !!l.lease, label: '조종권',
    text: l.lease ? '나 · 다른 사람 없음' : l.holder?.type === 'USER' ? `${l.holder.name} 님이 조종 중` : l.holder ? '다른 실행이 쥐고 있음' : '아무도 없음 · 잡아야 시작' });
  const temps = (s?.robot_info?.temperature?.joints ?? []).filter((t): t is number => t != null), hot = temps.length ? Math.max(...temps) : null;
  const bat = s?.battery?.soc ?? robot?.battery ?? null;
  rows.push({ key: 'state', ok: !s?.latched && s?.status !== 'ERROR', label: '로봇 상태',
    text: [s?.gait?.gait ? GAIT[s.gait.gait] : null, s?.posture ? POSE[s.posture.state] : null, bat != null ? `배터리 ${Math.round(bat)} %` : null,
      hot != null ? `최고 관절 온도 ${Math.round(hot)} °C` : null, s?.latched ? '정지 잠금' : null, s?.status === 'ERROR' ? '오류' : null].filter(Boolean).join(' · ') || '상태를 받는 중' });
  const w0 = scen?.waypoints[0], at = s?.location;
  const off = w0 && at && at.x != null && at.y != null && at.floor_id === w0.floor_id ? Math.hypot(at.x - w0.x, at.y - w0.y) : null;
  rows.push({ key: 'start', ok: off != null && off <= START_OFF_M, label: '시작 자리',
    text: !w0 ? '지점 없음' : off == null ? (at?.floor_id && at.floor_id !== w0.floor_id ? '로봇이 다른 층에 있음' : '로봇 위치를 받지 못함') : off <= START_OFF_M ? `첫 지점과 ${off.toFixed(1)} m` : `지도와 ${off.toFixed(1)} m 어긋남` });

  // 실행을 막는 관문(옛 RunCtl 과 같은 순서). 시작 자리는 주의만(서버가 막지 않음)
  let why = '', act: Act = null;
  const may = !!robot && (user.role === 'ORG_ADMIN' || robot.owner === user.id);
  if (!robot || !scen) why = '로봇과 임무를 고르세요.';
  else if (!on && assign === null) {
    why = may ? '이 로봇에 이 임무의 배정이 없습니다.' : '이 로봇에 이 임무의 배정이 없습니다. 배정은 담당 로봇에만 할 수 있습니다.';
    // 답을 못 받은 시도를 다시 보내면 같은 key(서버가 첫 결과를 돌려줌 · 두 번 배정 안 됨). 서버가 답한 거절이면 key 를 비운다
    if (may) act = { label: busy ? '배정하는 중…' : '이 로봇에 배정', busy, run: () => {
      const k = key || crypto.randomUUID();
      setKey(k); setBusy(true); setErr('');
      api.assign({ scenario_id: scen.id, scenario_version: scen.version, robot_id: robot.id }, k, cancel).then((x) => { setBusy(false); setKey(''); setMade(x); setN((c) => c + 1); },
        (e: ApiFail) => { setBusy(false); if (e.code === 'CANCELED') return; if (e.said) setKey('');
          setErr(e.said ? `배정하지 못했습니다. ${e.message} (${e.code})` : `배정 요청의 답을 받지 못했습니다. ${e.message} 다시 누르면 같은 요청으로 보냅니다.`); });
    } };
  } else if (!on && assign?.status === 'PENDING') why = '배정이 결재를 기다립니다.';
  else if (!robot.sim) why = '실기는 아직 화면에서 임무를 실행할 수 없습니다 · 실기 실행 기능이 준비되지 않았습니다.';
  else if (!l.lease) {
    why = l.holder?.type === 'USER' ? `${l.holder.name} 님이 조종 중입니다.` : l.holder ? '다른 실행이 조종권을 쥐고 있습니다.' : '실행은 조종권이 있어야 보냅니다.';
    act = l.holder?.type === 'USER' ? { label: '조종권 요청', run: () => rt.request(robot.id), busy: !!l.outgoing } : l.holder ? null : { label: '조종권 잡기', run: () => rt.take(robot.id), busy: l.busy === 'take' };
  } else if (s?.latched) { why = '로봇이 정지 잠금 상태입니다.'; act = { label: '잠금 해제', run: () => rt.unlock(robot.id) }; }
  else if (!on && assign === undefined) why = '배정을 확인하는 중…';
  else if (!on && !ref) why = '배정 · 지도 판을 확인하는 중…';
  else if (on) why = '이 로봇은 이미 임무를 실행 중입니다.';

  const sending = !!q && (q.phase === 'sending' || q.phase === 'sent');
  // 이 화면이 보낸 실행만 «내 실행»(멈춤 · 결과 보기). 로봇이 다른 임무를 돌리는 중이면 그 실행은 건드리지 않는다
  const go = () => { if (!why && ref && robot) { const rid = crypto.randomUUID(); setMine(rid); rt.run(robot.id, 'start', { run_id: rid, ...ref }); } };
  const own = run && mine && run.run_id === mine ? run : null;
  const control = (op: RunReq['op']) => { if (robot && own) rt.run(robot.id, op, { run_id: own.run_id }); };
  const say = q?.phase === 'rejected' && robot ? runSay(q.code ?? '', robot.name) : err;
  return { rows, why, act, go, can: !why && !sending, sending, run, on, control, say, assigned: !!assign && assign.status === 'ACTIVE', lease: !!l.lease, mine, own, ownOn: !!own && !DONE.includes(own.status) };
}
export type Gate = ReturnType<typeof useRunGate>;

/** 시안 u15_2: 일정 칸 위에 뜨는 «○○ 실제 로봇으로 시작» 창 */
export function Preflight({ robot, scen, sub, user, cancel, close }: { robot: Robot; scen: Scenario; sub: string; user: User; cancel?: AbortSignal; close: () => void }) {
  const g = useRunGate(robot, scen, user, cancel);
  const started = !!g.own;
  return <>
    <div className="dim" onClick={close} />
    <div className="md" role="dialog" aria-label="실제 로봇 시작 전 점검" style={{ left: '560px', top: '120px', width: '800px', padding: '28px 32px 26px' }} data-preflight-box>
      <div style={{ display: 'flex', alignItems: 'flex-start' }}><div><h2>{robot.name} {robot.sim ? '시뮬 로봇' : '실제 로봇'}으로 시작</h2><div className="sb">{sub}</div></div>
        <button type="button" aria-label="닫기" onClick={close} data-preflight-x style={{ marginLeft: 'auto', width: '40px', height: '40px', borderRadius: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(255,255,255,.06)' }}><Ic d={IC.x} /></button></div>
      <div style={{ marginTop: '16px' }}>
        {g.rows.map((r, i) => <div key={r.key} className="ck" data-ck={r.key} data-ok={r.ok} style={i === g.rows.length - 1 ? { border: '0' } : undefined}>
          <span className={`o${r.ok ? '' : ' w'}`}><Ic d={r.ok ? IC.check : IC.warn} /></span>{r.label}<em className={r.ok ? undefined : 'up'} style={r.ok ? undefined : { color: '#f2b705' }}>{r.text}</em></div>)}
      </div>
      {!g.rows[3].ok && g.rows[3].text.includes('어긋남') && <div style={{ display: 'flex', gap: '16px', alignItems: 'center', marginTop: '4px' }}>
        <div style={{ flex: '1', fontSize: '13.5px', fontWeight: '600', lineHeight: '1.6', color: 'rgba(255,255,255,.8)' }}>로봇이 지도에서 생각하는 자리와 첫 지점이 다릅니다. 로봇을 첫 지점으로 옮긴 뒤 시작하세요.</div></div>}
      <div style={{ display: 'flex', gap: '10px', marginTop: '20px', alignItems: 'center' }}>
        <button type="button" className="btns" style={{ height: '52px', padding: '0 22px', fontSize: '15px' }} onClick={close} data-preflight-cancel>취소</button>
        {g.act && <button type="button" className="btns" style={{ height: '52px', padding: '0 22px', fontSize: '15px', borderColor: 'rgba(242,183,5,.5)', color: '#f2b705' }} disabled={g.act.busy} onClick={g.act.run} data-preflight-act><Ic d={IC.warn} />{g.act.label}</button>}
        <button type="button" className="btnp" style={{ height: '52px', flex: '1', fontSize: '15.5px' }} disabled={!g.can || !!started} onClick={g.go} data-preflight-go>{started ? '시작함' : g.sending ? '보내는 중…' : '실행'}</button></div>
      <div style={{ fontSize: '12.5px', fontWeight: '600', color: g.say ? '#ff4d4f' : 'var(--mu2)', marginTop: '10px', textAlign: 'right' }} role={g.say ? 'alert' : 'status'} data-preflight-why>
        {g.say || (started ? `${robot.name} 임무를 시작했습니다. 오늘 일정에서 진행을 봅니다.` : g.why)}</div>
    </div>
  </>;
}
