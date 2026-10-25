// 시나리오 실행 화면 조각(05 §13.10·02 F-MS-06·10 ADR-003 §11) — 폰 조종 화면(simdrive.tsx)과 PC «시뮬» 탭(screens/sim.tsx)이 같이 쓴다.
// 상태·요청은 phone.ts(sim.runStart·runControl). 판정(시작 관문·감시·자동 취소·취소 권한)은 에이전트 — 이 파일은 받은 상태를 쉬운 말과 단추로만 바꾼다.
// 시뮬만·한 층만·배정·결재·실행 전 점검 없음(10-25). STOP·시뮬 정지는 이 조각 밖(App 머리줄·SimStop)이라 실행 중에도 그대로 보이고 눌린다.
import { useEffect, useState } from 'react';
import type { RunSnapshot, Scenario, SimWorldFloor } from '../../contracts/ts';
import { api } from './api';
import { RUN_END, runMoving, sim, type Sim } from './phone';

export const RUN_STATUS: Record<RunSnapshot['status'], string> = { QUEUED: '출발 준비', PREPARING: '준비 중', MOVING: '이동 중', AT_WAYPOINT: '지점 도착',
  PERFORMING: '작업 중', WAIT_CONFIRM: '확인 대기', PAUSED: '일시정지', COMPLETED: '완료', FAILED: '실패', CANCELED: '취소됨' };
/** 실패·취소 이유(run.update.fail_code). 모르는 코드는 일반 실패로(§13.10.3) */
export const RUN_FAIL: Record<string, string> = {
  NAV_GOAL_REJECTED: '로봇이 이동 목표를 받지 않았습니다.', NAV_TIMEOUT: '정해진 시간 안에 지점에 닿지 못했습니다.', LOCALIZATION_LOST: '로봇이 지도 위 자기 위치를 잃었습니다.',
  BATTERY_LOW: '배터리가 부족합니다.', DEVICE_MISSING: '필요한 장치가 없습니다.', OPERATOR_ABORT: '사람이 취소했습니다.',
  PAUSE_TIMEOUT: '일시정지가 10분을 넘어 자동으로 취소됐습니다.', FLOOR_TRANSITION_FAILED: '층 이동에 실패했습니다.',
  NAV_UNAVAILABLE: '이 로봇에는 자율 이동(내비게이션)이 준비되지 않았습니다.', MAP_VERSION_MISMATCH: '시나리오 지도 판이 로봇 지도와 다릅니다.',
  FLOOR_TRANSITION_UNSUPPORTED: '여러 층을 지나는 시나리오는 아직 실행할 수 없습니다.', PLAN_UNAVAILABLE: '시나리오 자료를 받지 못했습니다.',
  AGENT_RESTARTED: '로봇 프로그램이 다시 시작되어 실행을 닫았습니다.',
};
export const failText = (code: string | null) => (code && RUN_FAIL[code]) || '실행을 마치지 못했습니다.';
/** 일시정지 이유(wait_reason) */
export const RUN_WAIT: Record<string, string> = {
  LINK_LOST: '화면 연결이 끊겨 멈췄습니다(로봇 정지·잠금).', STOPPED_BY_USER: 'STOP 으로 멈췄습니다(잠금 유지).',
  RECORDING_UNAVAILABLE: '실행 기록을 저장하지 못해 멈췄습니다 — 이어갈 수 없습니다. 취소하세요.', '': '일시정지했습니다(로봇 정지·잠금).',
};
const mmss = (s: number) => `${Math.floor(s / 60)}분 ${(s % 60).toString().padStart(2, '0')}초`;

/** 이 월드 지도(층)를 지나는 보관 안 된 시나리오 */
export function useScenarios(floors: SimWorldFloor[], on: boolean) {
  const ids = floors.map((f) => f.floor_id).join(' ');
  const [list, setList] = useState<'wait' | 'fail' | Scenario[]>('wait'), [again, setAgain] = useState(0);
  useEffect(() => {
    if (!on) return;
    const c = new AbortController(), set = new Set(ids.split(' '));
    setList('wait');
    api.allPlans('scenarios', c.signal).then((xs) => setList(xs.filter((x) => !x.archived_at && x.floor_ids.some((f) => set.has(f)))), () => { if (!c.signal.aborted) setList('fail'); });
    return () => c.abort();
  }, [on, ids, again]);
  return { list, retry: () => setAgain((n) => n + 1) };
}

/** 고른 시나리오를 지금 시작할 수 없는 이유(없으면 '') — 화면 쪽 안내일 뿐, 실제 관문은 에이전트 */
export function startBlock(s: Sim, sc: Scenario | undefined, floors: SimWorldFloor[]) {
  const l = s.link, w = l?.welcome;
  if (!l || l.at !== 'open' || !w) return '로봇에 연결된 뒤 실행할 수 있습니다.';
  if (w.capabilities?.run_contract !== 'scenario/1') return '이 로봇은 시나리오 실행을 지원하지 않습니다.';
  if (l.navOff) return '이 로봇에는 자율 이동(내비게이션)이 준비되지 않아 실행할 수 없습니다.';
  if (l.run && !RUN_END.includes(l.run.status)) return '이미 실행 중인 시나리오가 있습니다.';
  if (!sc) return '실행할 시나리오를 고르세요.';
  const f = floors.find((x) => x.floor_id === sc.floor_ids[0]);
  if (sc.floor_ids.length !== 1) return '한 층 시나리오만 실행할 수 있습니다.';
  if (!f || sc.map_version_ids.length !== 1 || sc.map_version_ids[0] !== f.map_version_id) return '시나리오 지도 판이 이 월드 지도와 달라 실행할 수 없습니다.';
  if (!l.lease) return '먼저 «조종 시작»을 누르세요.';
  if (l.st?.latched !== false) return '먼저 «잠금 해제»를 누르세요.';
  return '';
}
export const startFloor = (sc: Scenario, floors: SimWorldFloor[]) => floors.find((x) => x.floor_id === sc.floor_ids[0])!;

/** 실행 안내 줄·단추·개발자 정보. 화면마다 자기 틀(폰 dv-act·PC 카드)에 넣는다 */
export function runView(s: Sim): { notes: string[]; acts: JSX.Element[]; dev: JSX.Element | null; label: string } {
  const l = s.link, r = l?.run;
  if (!l || !r || sim.dismissed(r.run_id)) return { notes: [], acts: [], dev: null, label: '' };
  const mine = sim.runMine(r), end = RUN_END.includes(r.status), paused = r.status === 'PAUSED', open = l.at === 'open', busy = l.busy === 'run';
  const total = r.progress.total, at = total ? ` · 지점 ${Math.min(r.step + 1, total)}/${total}` : '';
  const label = !open && !end ? '연결 끊김' : RUN_STATUS[r.status] ?? '상태 확인 중';
  const left = paused ? sim.pauseLeft(r) : null, record = r.wait_reason === 'RECORDING_UNAVAILABLE';
  const b = (key: string, text: string, f: () => void, pri = false, off = busy) =>
    <button key={key} type="button" className={pri ? 'btn pri' : 'btn'} disabled={off} data-run-act={key} onClick={f}>{text}</button>;
  const notes = [
    end ? (r.status === 'COMPLETED' ? `시나리오를 마쳤습니다 — 지점 ${r.progress.done}/${total}` : `시나리오 ${label} — ${failText(r.fail_code)}`) : `시나리오 ${label}${at}`,
    !end && l.arrived,
    !open && !end && `화면 연결이 끊겼습니다 — 로봇은 스스로 멈추고 실행은 일시정지됩니다.${mine ? ' 다시 연결한 뒤 이 화면에서 이어갈 수 있습니다.' : ''}`,
    open && paused && RUN_WAIT[r.wait_reason ?? ''],
    open && paused && left !== null && `약 ${mmss(left)} 뒤 자동으로 취소됩니다.`,
    open && paused && mine && !record && (!l.lease ? '이어서: «조종 시작» → STOP 확인 뒤 «잠금 해제» → 손을 뗀 채 «이어서». 수동으로 움직이려면 «잠금 해제»까지만 하세요(실행은 일시정지로 남음).'
      : l.st?.latched !== false ? '이어서: «잠금 해제» → 손을 뗀 채 «이어서».' : '손을 뗀 채 «이어서»를 누르면 남은 지점부터 다시 갑니다.'),
    open && paused && !mine && '다른 화면에서 건 실행입니다 — 이어서는 그 화면에서만 할 수 있습니다. 취소는 로봇 담당자·총괄만 됩니다.',
    open && runMoving(r) && (mine ? '실행 중에는 수동 조종이 막혀 있습니다. 수동으로 바꾸려면 «일시정지» → 로봇이 멈춘 뒤 «조종 시작» → «잠금 해제».'
      : '다른 화면에서 실행 중입니다 — 멈추려면 STOP.'),
  ].filter(Boolean) as string[];
  const acts = !open ? [] : end ? [b('close', '닫기', () => sim.dismiss(r.run_id), false, false)]
    : paused ? [mine && !record && l.lease && l.st?.latched === false && b('resume', '이어서', () => sim.runControl('resume'), true), b('abort', '취소', () => sim.runControl('abort'))].filter(Boolean) as JSX.Element[]
    : mine ? [b('pause', '일시정지', () => sim.runControl('pause'), true), b('abort', '취소', () => sim.runControl('abort'))] : [];
  const dev = <details className="lbl" data-run-dev><summary>개발자 정보</summary>
    <span className="mono">run {r.run_id} · {r.status} · step {r.step} · {r.progress.done}/{total}{r.wait_reason ? ` · ${r.wait_reason}` : ''}{r.fail_code ? ` · ${r.fail_code}` : ''}</span></details>;
  return { notes, acts, dev, label };
}
