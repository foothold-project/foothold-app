// 폰 임무 공용 부품(시안 u1_1 · u1_11 · app-lead 11-28 22:40): state.run 하나로 판정 · 칩 글 · 진행 막대 · 카드 이름. 단추 없음
// (서버 로봇의 일시정지 · 이어 가기는 app-lx 총괄 take 계약 뒤 · 내 시뮬은 simdrive 의 sim.runControl 그대로).
// 카드 이름 · 「오늘 n / m」 · 「예정 끝」 = 오늘 일정(GET /schedule)에서 이 로봇의 run_id 같은 칸 + 그 시나리오 판. 남은 거리는 서버 값이 없어 그리지 않는다
import { useEffect, useState } from 'react';
import type { RunSnapshot, Scenario, ScheduleSlot } from '../../../contracts/ts';
import { api } from '../api';
import type { Tone } from '../fake';

const DONE: RunSnapshot['status'][] = ['COMPLETED', 'FAILED', 'CANCELED'];
/** 끝나지 않은 실행이 있으면 임무 화면 */
export const missionOn = (r: RunSnapshot | null | undefined): r is RunSnapshot => !!r && !DONE.includes(r.status);
/** 로봇 칩 글(시안 u1_1 「순찰 중」 · u1_11 「일시정지됨」) */
export const missionChip = (r: RunSnapshot): { tone: Tone; text: string } =>
  r.status === 'PAUSED' ? { tone: 'warn', text: '일시정지됨' }
    : r.status === 'WAIT_CONFIRM' ? { tone: 'warn', text: '확인 기다림' }
    : r.status === 'QUEUED' || r.status === 'PREPARING' ? { tone: 'ok', text: '준비 중' }
    : { tone: 'ok', text: '순찰 중' };

const two = (n: number) => String(n).padStart(2, '0');
const day = () => { const d = new Date(); return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`; };
const hhmm = (iso: string) => { const d = new Date(iso); return `${two(d.getHours())}:${two(d.getMinutes())}`; };
type Slot = { n: number; of: number; end: string; name: string; wps: string[] };

/** 오늘 이 로봇 칸들 중 run_id 칸의 순서 · 끝 · 시나리오 이름 · 지점 이름. run_id 가 바뀔 때만 다시 받는다 */
function useSlot(robot: string, runId: string) {
  const [s, setS] = useState<Slot | null>(null);
  useEffect(() => {
    setS(null);
    const ac = new AbortController();
    api.schedule(day(), Intl.DateTimeFormat().resolvedOptions().timeZone, ac.signal).then((d) => {
      const mine = d.slots.filter((x: ScheduleSlot) => x.robot_id === robot && x.kind !== 'BATTERY_SWAP').sort((a, b) => a.start.localeCompare(b.start));
      const i = mine.findIndex((x) => x.run_id === runId), x = mine[i];
      if (!x?.scenario_id) return;
      return api.plan('scenarios', x.scenario_id, x.scenario_version, ac.signal).then((p) => {
        const sc = p as Scenario;
        if (!ac.signal.aborted) setS({ n: i + 1, of: mine.length, end: x.end, name: sc.name, wps: (sc.waypoints ?? []).map((w) => w.name ?? '') });
      });
    }).catch(() => {});
    return () => ac.abort();
  }, [robot, runId]);
  return s;
}

/** 왼쪽 아래 임무 카드(시안 u1_1 · u1_11) */
export function MissionCard({ robot, run }: { robot: string; run: RunSnapshot }) {
  const m = useSlot(robot, run.run_id), { done, total } = run.progress;
  const at = Math.min(run.step + 1, total), wp = m?.wps[run.step] || '', paused = run.status === 'PAUSED';
  const line = !total ? missionChip(run).text
    : paused ? `${wp || `${at} / ${total} 지점`} 가기 전에 서 있음`
    : `${at} / ${total}${wp ? ` ${wp}` : ''}`;
  return <div className="g dk u1-mission" data-mission={run.status}>
    <div className="row mh">
      <span className="row">{m && <span className="mn">오늘 {m.n} / {m.of}</span>}<b>{m?.name || '임무'}</b></span>
      {m && <span className="me">예정 끝 {hhmm(m.end)}</span>}
    </div>
    {total > 0 && <div className="row mb">{Array.from({ length: total }, (_, i) => <i key={i} className={i < done ? 'on' : undefined} />)}</div>}
    <div className={`ml${paused ? ' pz' : ''}`}>{line}</div>
  </div>;
}
