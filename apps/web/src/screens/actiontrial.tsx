import { useEffect, useRef, useState } from 'react';
import { rt, useLive } from '../rt';
import type { Robot } from '../fake';
import type { ActionResult, FactoryUnsupportedAction, LowlevelAction, LowlevelQuery, ScreenAction } from '../../../contracts/ts';
import lowlevelQuerySchema from '../../../contracts/schema/LowlevelQuery.json';
import lowlevelSchema from '../../../contracts/schema/LowlevelAction.json';
import factoryOffSchema from '../../../contracts/schema/FactoryUnsupportedAction.json';

type Name = ScreenAction['action'];
export const ACTION_NAMES: Record<Name, string> = {
  Sit: '앉기', RiseSit: '앉은 자세에서 일어서기', StandUp: '일어서기', StandDown: '엎드리기',
  BalanceStand: '균형 서기', RecoveryStand: '쓰러짐에서 일어나기', StopMove: '동작 정지 요청',
  Hello: '악수', Greet: '인사', Stretch: '기지개', Content: '기쁨 표현', Heart: '하트', Dance1: '춤 1', Dance2: '춤 2',
  Scrape: '발 긁기', Euler: '몸 기울이기', SpeedLevel: '속도 단계', SwitchJoystick: '조이스틱 입력', Pose: '자세 모드',
  StaticWalk: '정적 걸음', TrotRun: '뛰는 걸음', EconomicGait: '절약 걸음', FreeWalk: '자유 걸음',
  FreeAvoid: '자유 회피', ClassicWalk: '기본 걸음', CrossStep: '교차 걸음', SwitchAvoidMode: '회피 모드 바꾸기',
  AutoRecoverySet: '자동 일어나기 설정', AutoRecoveryGet: '자동 일어나기 조회', CheckMode: '현재 모드 조회', SelectMode: '모드 전환',
  Damp: '힘 빼기 · 주저앉음', FrontFlip: '앞 공중제비', LeftFlip: '왼쪽 공중제비', BackFlip: '뒤 공중제비',
  FrontJump: '앞으로 점프', FrontPounce: '앞으로 덮치기', HandStand: '물구나무', WalkUpright: '직립 걸음', FreeJump: '자유 점프', FreeBound: '자유 도약',
};
export const DANGEROUS = new Set<Name>(['FrontFlip', 'LeftFlip', 'BackFlip', 'FrontJump', 'FrontPounce', 'HandStand', 'WalkUpright', 'FreeJump', 'FreeBound', 'Damp']);
/** 저수준 (START · AME-2) 제어 중에도 누를 수 있는 동작 (계약 LowlevelAction · 동작표 「저수준」 열). 순정에서는 FACTORY_OFF 밖 전부 */
// 값 하나뿐인 목록은 생성기가 enum 대신 const 로 쓴다
const names = (s: { enum?: string[]; const?: string }) => s.enum ?? (s.const === undefined ? [] : [s.const]);
export const LOWLEVEL = new Set<Name>(names(lowlevelSchema) as LowlevelAction[]);
/** 저수준 중에도 켜는 읽기 전용 순정 조회 (계약 LowlevelQuery · 실행기 키 아님) */
export const LOWLEVEL_QUERY = new Set<Name>(names(lowlevelQuerySchema) as LowlevelQuery[]);
/** 순정에서 안 되는 동작 (SDK 번호 모름 · 계약 FactoryUnsupportedAction). START 중에만 켬 */
export const FACTORY_OFF = new Set<Name>(names(factoryOffSchema) as FactoryUnsupportedAction[]);
const FLAGS = new Set<Name>(['SwitchJoystick', 'Pose', 'HandStand', 'FreeBound', 'FreeJump', 'FreeAvoid', 'ClassicWalk', 'WalkUpright', 'CrossStep', 'AutoRecoverySet']);
const REASONS: Record<string, string> = {
  STARTED: '응답을 기다리고 있습니다', SDK_ACCEPTED: 'SDK 접수 성공 · 실제 동작 완료는 현장에서 확인하세요',
  BUSY: '다른 동작이나 자세 작업 중입니다', DUPLICATE: '이미 접수한 요청입니다', NOT_AUTHORIZED: '조종권 또는 현장 승인이 유효하지 않습니다',
  AUTHORITY_LOST: '조종권 또는 현장 승인이 만료되어 취소했습니다', STALE_STATE: '0.20초 이내의 새 로봇 상태가 필요합니다',
  MOVING: '이동 입력을 놓고 완전히 멈춘 뒤 다시 누르세요', CONFIRM_REQUIRED: '위험 동작 확인이 필요합니다',
  STANDING_REQUIRED: '서 있음과 정지가 확인되어야 합니다', INVALID_ARGUMENTS: '입력 범위를 확인하세요',
  STOPPED: 'STOP으로 취소했습니다', WATCHDOG: '감시 시간 초과로 취소했습니다', DISCONNECTED: '연결이 끊겨 취소했습니다',
  LEASE_CHANGED: '조종권이 바뀌어 취소했습니다', CLOSED: '연결을 종료해 취소했습니다', TIMEOUT: 'SDK 응답 시간이 초과됐습니다',
  SDK_REJECTED: 'SDK가 거부했습니다 · 지원 여부와 로봇 상태를 확인하세요', SDK_ERROR: 'SDK 호출에 실패했습니다',
  SDK_SEND_FAILED: '로봇 동작 서비스에 요청을 보내지 못했습니다', SDK_VERSION_MISMATCH: 'SDK와 로봇의 동작 규약이 맞지 않습니다',
  SDK_ARGUMENTS: 'SDK가 동작 인자를 거부했습니다', SDK_AUTHORITY: '로봇 동작 서비스의 조종권을 확인하세요', SDK_BUSY: 'SDK 조종권이 이미 사용 중입니다',
  UNSUPPORTED: '설치된 SDK 또는 로봇이 이 동작을 제공하지 않습니다',
  START_ACTIVE: 'START 저수준 제어로 바뀌어 순정 동작을 멈췄습니다', LOWLEVEL_UNSUPPORTED: '저수준 제어 중에는 이 동작을 쓸 수 없습니다', FACTORY_UNSUPPORTED: 'START 저수준 제어 중에만 쓸 수 있는 동작입니다',
  RUNNER_NOT_CONNECTED: 'START 실행기와 아직 연결되지 않았습니다 · 리모컨 키로 하세요', RUNNER_SENT: 'START 실행기에 보냈습니다 · 실제 동작은 현장에서 확인하세요',
  RUNNER_SEND_FAILED: 'START 실행기에 보내지 못했습니다', MODE_READ_ONLY: '안전한 전환 대상이 확인되지 않아 현재 모드 조회만 가능합니다',
};
export function actionResultText(result: ActionResult) {
  const status = { RUNNING: '대기', SUCCEEDED: '성공', REJECTED: '거부', FAILED: '실패' }[result.status];
  return `${ACTION_NAMES[result.action]}: ${status} — ${REASONS[result.code] ?? result.code}${result.sdk_code == null ? '' : ` (SDK ${result.sdk_code})`}${result.mode == null ? '' : ` · 현재 모드: ${result.mode}`}${result.enabled == null ? '' : ` · 자동 일어나기: ${result.enabled ? '켜짐' : '꺼짐'}`}`;
}

/** Plain trial controls inside the existing real-robot drive surface. */
export function ActionTrial({ robot: r, allowed, beforeSend = () => {} }: { robot: Robot; allowed: boolean; beforeSend?: () => void }) {
  const l = useLive(r.id), link = rt.link().at;
  const [confirm, setConfirm] = useState<Name | null>(null), [enabled, setEnabled] = useState(false);
  const [why, setWhy] = useState('');
  const [angles, setAngles] = useState(['0', '0', '0']), [level, setLevel] = useState('0'), [mode, setMode] = useState('');
  const [pending, setPending] = useState<{ id?: string; at: number } | null>(null), [message, setMessage] = useState('');
  const [clock, setClock] = useState(rt.now());
  useEffect(() => { const timer = setInterval(() => setClock(rt.now()), 250); return () => clearInterval(timer); }, []);
  const result = l.state?.action_result, recent = clock - l.stateAt <= 1000;
  const running = useRef({ id: '', at: 0 });
  if (result?.status === 'RUNNING' && running.current.id !== result.request_id) running.current = { id: result.request_id, at: rt.now() };
  const busy = !!pending || result?.status === 'RUNNING' && clock - running.current.at <= 5000 || l.state?.posture_result?.status === 'RUNNING';
  const reason = !allowed ? '서버가 이 로봇의 실기 조종을 허용하지 않았습니다.' : !l.lease ? '조종 시작 후 사용할 수 있습니다.'
    : link !== 'open' || l.state?.connection !== 'ONLINE' ? '로봇과 서버 연결을 확인하세요.' : !recent ? '새 로봇 상태를 기다리고 있습니다.'
    : busy ? '동작 결과를 기다리고 있습니다.' : '';
  // 저수준: 실행기 동작만. 서 있음 판정은 순정 상태 보고라 쓰지 않고 실행기가 정한다
  const lowlevel = l.state?.control === 'LOWLEVEL', off = (name: Name) => lowlevel ? !LOWLEVEL.has(name) && !LOWLEVEL_QUERY.has(name) : FACTORY_OFF.has(name);
  const standing = l.state?.posture?.state === 'STANDING' && l.state?.speed != null && l.state.speed <= .02
    && l.state?.applied?.every((x) => x === 0);
  useEffect(() => { setConfirm(null); }, [r.id, l.lease, link, l.state?.stop_gen, allowed]);
  useEffect(() => {
    if (pending?.id && result?.request_id === pending.id && result.status !== 'RUNNING') {
      setMessage(actionResultText(result)); setPending(null);
    } else if (pending && clock - pending.at > 5000) {
      setMessage('동작 결과를 확인하지 못했습니다. 현장에서 로봇을 확인하고 STOP을 누르세요. 자동 재전송하지 않습니다.'); setPending(null);
    }
  }, [clock, result, pending]);
  if (r.sim) return null;
  const send = (action: Name, confirmed = false) => {
    if (reason || action === 'SelectMode' || off(action)) return;
    let params: ScreenAction['params'] = {};
    if (action === 'Euler') {
      if (angles.some((v) => v.trim() === '' || !Number.isFinite(Number(v)) || Math.abs(Number(v)) > .5)) { setMessage('각도는 -0.5~0.5 rad로 입력하세요.'); return; }
      params = { roll: Number(angles[0]), pitch: Number(angles[1]), yaw: Number(angles[2]) };
    } else if (action === 'SpeedLevel') params = { level: Number(level) };
    else if (FLAGS.has(action)) params = { enabled };
    beforeSend(); setConfirm(null); setMessage('서버 접수를 기다리고 있습니다.'); setPending({ at: rt.now() });
    rt.action(r.id, action, params, confirmed, (why, id) => {
      if (why) { setMessage(`거부 — ${why}`); setPending(null); }
      else { setMessage('서버 접수 · 로봇의 SDK 결과를 기다리고 있습니다.'); setPending({ id, at: rt.now() }); }
    });
  };
  const buttons = (danger: boolean) => (Object.keys(ACTION_NAMES) as Name[]).filter((name) => DANGEROUS.has(name) === danger).map((name) =>
    // 회색이어도 터치는 받아 까닭을 보인다 (폰에는 hover 가 없음 · app-design 10:28). 동작은 보내지 않는다.
    <button key={name} type="button" className="btn" data-go2-action={name} disabled={!!reason || name === 'SelectMode' || danger && !standing && !lowlevel}
      aria-disabled={off(name) || undefined}
      onClick={() => off(name) ? setWhy(`${ACTION_NAMES[name]}: ${lowlevel ? '저수준 제어 중에는 쓸 수 없음' : '순정 번호 확인 전'}`) : danger ? setConfirm(name) : send(name)}>{ACTION_NAMES[name]} <small>{name}</small></button>);
  return <details data-action-trial><summary>동작 시험</summary>
    <p className="lbl">실기 미검증 · 단추를 누른 결과로 지원 여부를 확인합니다. SDK 접수 성공은 실제 동작 완료 확인이 아닙니다.</p>
    {reason && <p className="fh-why" role="status">{reason}</p>}
    {why && <p className="fh-why" role="status" data-off-why>{why}</p>}
    {!lowlevel && <p className="fh-why" data-factory-off>인사는 순정 SDK 번호 확인 전이라 꺼 둡니다. 순정 리모컨 L1+A 와 START 에서는 됩니다.</p>}
    {lowlevel && <p className="fh-why" data-lowlevel>저수준 (START) 제어 중입니다. START 실행기 동작과 읽기 전용 조회만 누를 수 있고 나머지는 꺼 둡니다.</p>}
    <div className="fh-row" style={{ flexWrap: 'wrap' }}>
      {['roll', 'pitch', 'yaw'].map((name, i) => <label key={name}>{name} (rad)
        <input className="inp" type="number" min={-.5} max={.5} step={.05} value={angles[i]} onChange={(e) => setAngles((prev) => prev.map((v, j) => j === i ? e.target.value : v))} /></label>)}
      <label>속도 단계 <select className="inp" value={level} onChange={(e) => setLevel(e.target.value)}><option value="-1">-1</option><option value="0">0</option><option value="1">1</option></select></label>
      <label><input type="checkbox" checked={enabled} onChange={(e) => { setEnabled(e.target.checked); setConfirm(null); }} /> 토글 동작 켜기 (체크 해제: 끄기)</label>
    </div>
    <div className="fh-row" style={{ flexWrap: 'wrap' }}>{buttons(false)}</div>
    <label>전환할 모드 이름 <input className="inp" value={mode} maxLength={32} onChange={(e) => setMode(e.target.value)} disabled /></label>
    <p className="lbl">모드 전환은 읽기 전용입니다. 고수준 동작 서비스 유지가 확인되지 않아 현재 모드 조회만 허용합니다.</p>
    <h3>위험</h3><p className="fh-why">넘어짐·충돌·주저앉음 위험. 주변 공간을 비우고 현장에서 확인하세요. 서 있음과 정지가 필요합니다.</p>
    <div className="fh-row" style={{ flexWrap: 'wrap' }}>{buttons(true)}</div>
    {confirm && <div role="group" aria-label="위험 동작 확인"><p>{ACTION_NAMES[confirm]} ({confirm}){FLAGS.has(confirm) ? ` · ${enabled ? '켜기' : '끄기'}` : ''}를 한 번 실행할까요?</p>
      <button className="btn" type="button" disabled={!!reason || off(confirm) || !standing && !lowlevel} onClick={() => send(confirm, true)}>위험을 확인했고 실행</button>{' '}
      <button className="btn" type="button" onClick={() => setConfirm(null)}>취소</button></div>}
    <p className="lbl" role="status" data-action-result>{message || (result ? actionResultText(result) : '아직 실행한 동작이 없습니다.')}</p>
  </details>;
}
