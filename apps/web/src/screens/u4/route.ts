// 로봇 탭 지도 칸 · 임무 칸의 임무 경로. 서버 값만 쓴다:
// 진행 = 실시간 state.run(없으면 목록 current_run), 임무 이름 = 목록 current_run.scenario_name,
// 경로 = 이 로봇의 ACTIVE 배정 가운데 그 이름과 같은 것이 꼭 하나일 때 그 배정 판(효력 판)의 시나리오 지점들.
// 실행(run)이 어느 배정인지 서버가 알려 주지 않아(RunSnapshot · CurrentRun 에 시나리오 id 없음) 이름이 겹치거나 없으면 경로를 그리지 않고 까닭을 남긴다.
import { useEffect, useState } from 'react';
import type { Progress, RunSnapshot, Scenario, ScenarioWaypoint } from '../../../../contracts/ts';
import { api } from '../../api';
import type { Robot } from '../../fake';

const DONE = ['COMPLETED', 'FAILED', 'CANCELED', 'ABORTED'];
export type Run = { name: string; status: RunSnapshot['status'] | 'ABORTED'; progress: Progress };

/** 지금 도는 임무(끝난 것 · 없음 = null). 진행은 실시간 값이 먼저 */
export function runOf(r: Robot, live: RunSnapshot | null | undefined): Run | null {
  const cur = r.run;
  if (!cur || DONE.includes(cur.status)) return null;
  if (live && DONE.includes(live.status)) return null;
  return { name: cur.scenario_name, status: live?.status ?? cur.status, progress: live?.progress ?? cur.progress };
}

export type Route = { wps: ScenarioWaypoint[] } | { why: string };
/** 경로 지점(받는 중 = null) */
export function useRoute(robot: string, name: string | null, cancel?: AbortSignal): Route | null {
  const [x, setX] = useState<Route | null>(null);
  useEffect(() => {
    setX(null);
    if (!name) return;
    let live = true;
    api.assignments(robot, cancel).then(async (l) => {
      const hit = l.filter((a) => a.status === 'ACTIVE' && a.scenario_id && a.scenario_name === name);
      if (hit.length !== 1) return live && setX({ why: hit.length ? '같은 이름의 배정이 여럿이라 경로를 고를 수 없습니다' : '이 임무의 배정을 찾지 못했습니다' });
      const a = hit[0], v = a.effective_scenario_version ?? a.scenario_version;
      const s = await api.plan('scenarios', a.scenario_id!, v ?? null, cancel) as Scenario;
      if (live) setX({ wps: s.waypoints });
    }).catch(() => { if (live) setX({ why: '경로를 받지 못했습니다' }); });
    return () => { live = false; };
  }, [robot, name]);
  return x;
}

/** 다음 지점 번호(0부터) = 끝낸 수. 지점 수와 진행 총수가 다르면 어느 지점인지 모름(null) */
export const nextIdx = (p: Progress, n: number) => (p.total === n && p.done < n ? p.done : null);

/** 남은 직선 거리(m): 지금 자리 → 다음 지점 → … 끝, 이 판 위 지점만. 다른 판 지점이 남았으면 more */
export function remaining(at: { x: number; y: number }, wps: ScenarioWaypoint[], from: number, vid: string) {
  let m = 0, p = at, more = false;
  for (const w of wps.slice(from)) {
    if (w.map_version_id !== vid) { more = true; continue; }
    m += Math.hypot(w.x - p.x, w.y - p.y); p = w;
  }
  return { m, more };
}

/** 받침 (으)로 */
export const ro = (s: string) => {
  const c = s.charCodeAt(s.length - 1) - 0xac00;
  return c < 0 || c > 11171 ? '로' : c % 28 === 0 || c % 28 === 8 ? '로' : '으로';
};
