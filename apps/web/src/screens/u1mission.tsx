// 폰 임무 공용 부품(시안 u1_1 · u1_11 · u1_15 · app-lead 11-28 22:40 · 22:45): state.run 하나로 판정 · 칩 글 · 진행 막대 · 카드 이름 · 바탕 2D 지도 · 경로 · 다음 일. 단추 없음
// (서버 로봇의 일시정지 · 이어 가기는 app-lx 총괄 take 계약 뒤 · 내 시뮬은 simdrive 의 sim.runControl 그대로).
// 카드 이름 · 「오늘 n / m」 · 「예정 끝」 = 오늘 일정(GET /schedule)에서 이 로봇의 run_id 같은 칸 + 그 시나리오 판. 남은 거리는 서버 값이 없어 그리지 않는다.
// 지도 판은 id 를 박지 않고 그 시나리오의 map_version_ids 에서 받는다(app-lx 가 새 판을 등록 중)
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Location, MapVersion, RunSnapshot, Scenario, ScenarioWaypoint, ScheduleSlot } from '../../../contracts/ts';
import { api } from '../api';
import type { Tone } from '../fake';
import { MapImage } from '../mapframe';

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
/** 지도 m → 판 그림 px(screens/maps.tsx toPixel 과 같은 식 · 그 파일은 지도 탭 전체를 끌어와 폰 조종 화면에 넣지 않는다) */
const px = (v: Pick<MapVersion, 'origin' | 'resolution' | 'height'>, x: number, y: number) => {
  const [ox, oy, yaw] = v.origin, dx = x - ox, dy = y - oy, c = Math.cos(yaw), s = Math.sin(yaw);
  return [(c * dx + s * dy) / v.resolution, v.height - (-s * dx + c * dy) / v.resolution].map((n) => Math.round(n * 10) / 10);
};

export type Mission = { n: number; of: number; slot: ScheduleSlot; name: string; wps: ScenarioWaypoint[]; mv: string | null };
type Choose = (mine: ScheduleSlot[]) => number;

/** 오늘 이 로봇 칸(배터리 교체 칸 빼고, 시작 순) 중 pick 이 고른 칸 + 그 시나리오 판. key 가 바뀔 때만 다시 받는다 */
function useSlot(robot: string, key: string, pick: Choose) {
  const [s, setS] = useState<Mission | null>(null);
  useEffect(() => {
    setS(null);
    if (!key) return;   // 임무 없음 = 받지 않음
    const ac = new AbortController();
    api.schedule(day(), Intl.DateTimeFormat().resolvedOptions().timeZone, ac.signal).then((d) => {
      const mine = d.slots.filter((x) => x.robot_id === robot && x.kind !== 'BATTERY_SWAP').sort((a, b) => a.start.localeCompare(b.start));
      const i = pick(mine), x = mine[i];
      if (!x?.scenario_id) return;
      return api.plan('scenarios', x.scenario_id, x.scenario_version, ac.signal).then((p) => {
        const sc = p as Scenario;
        if (!ac.signal.aborted) setS({ n: i + 1, of: mine.length, slot: x, name: sc.name, wps: sc.waypoints ?? [], mv: sc.map_version_ids?.[0] ?? sc.waypoints?.[0]?.map_version_id ?? null });
      });
    }).catch(() => {});
    return () => ac.abort();
  }, [robot, key]);   // eslint-disable-line react-hooks/exhaustive-deps
  return s;
}
/** 지금 실행(run_id)의 일정 칸 · 시나리오. 카드와 지도가 같이 쓴다 */
export const useMission = (robot: string, runId: string) => useSlot(robot, runId, (mine) => mine.findIndex((x) => x.run_id === runId));

function Card({ head, title, right, total, done, line, pz, dots }: { head?: string; title: string; right?: string; total: number; done: number; line: string; pz?: boolean; dots?: ReactNode }) {
  return <div className="g dk u1-mission">
    <div className="row mh">
      <span className="row">{head && <span className="mn">{head}</span>}<b>{title}</b></span>
      {right && <span className="me">{right}</span>}
    </div>
    {total > 0 && <div className="row mb">{Array.from({ length: total }, (_, i) => <i key={i} className={i < done ? 'on' : undefined} />)}</div>}
    <div className="row mf"><span className={`ml${pz ? ' pz' : ''}`}>{line}</span>{dots}</div>
  </div>;
}

/** 왼쪽 아래 임무 카드(시안 u1_1 · u1_11) */
export function MissionCard({ m, run, dots, hold }: { m: Mission | null; run: RunSnapshot; dots?: ReactNode; hold?: string }) {
  const { done, total } = run.progress, at = Math.min(run.step + 1, total), wp = m?.wps[run.step]?.name || '', paused = run.status === 'PAUSED';
  const line = hold ? hold   // 정지 잠금 등 안전 글이 임무 줄보다 먼저(drive.tsx lockFirst)
    : !total ? missionChip(run).text
    : paused ? `${wp || `${at} / ${total} 지점`} 가기 전에 서 있음`
    : `${at} / ${total}${wp ? ` ${wp}` : ''}`;
  return <Card head={m ? `오늘 ${m.n} / ${m.of}` : undefined} title={m?.name || '임무'} right={m ? `예정 끝 ${hhmm(m.slot.end)}` : undefined} total={total} done={done} line={line} pz={paused || !!hold} dots={dots} />;
}

/** 바탕 2D 지도(시안 u1_1 평면): 시나리오 판 그림 + 경로(지난 길 따로) + 지점 점 + 지금 지점 번호표 + 로봇 점(같은 판일 때만) */
/** 왼쪽 시점 단추(시안 u1_1 · U1-08 따라 · 위 · 3D). follow = 로봇 둘레(판의 반 · 판 밖으로 안 나감) · top = 판 전체 */
export type MapSight = 'follow' | 'top';
export function MissionMap({ m, run, pose, view = 'top' }: { m: Mission | null; run: RunSnapshot; pose?: Location | null; view?: MapSight }) {
  const mv = m?.mv ?? null, [v, setV] = useState<MapVersion | null>(null);
  useEffect(() => {
    setV(null);
    if (!mv) return;
    const ac = new AbortController();
    api.version(mv, ac.signal).then((x) => { if (!ac.signal.aborted) setV(x); }, () => {});
    return () => ac.abort();
  }, [mv]);
  // 판 그림 1 px 이 화면에서 몇 px 인가(slice). 점 · 글 크기를 화면 px 로 맞춘다(작은 판이 크게 늘어나도 글이 커지지 않게). 못 재면 1
  const el = useRef<SVGSVGElement>(null), [k, setK] = useState(1);
  const me = v && pose && pose.map_version_id === v.id && pose.x != null && pose.y != null ? px(v, pose.x, pose.y) : null;
  const box = !v ? [0, 0, 1, 1] : view === 'follow' && me
    ? (() => { const w = v.width / 2, h = v.height / 2, cl = (a: number, lo: number) => Math.min(Math.max(a, 0), lo); return [cl(me[0] - w / 2, v.width - w), cl(me[1] - h / 2, v.height - h), w, h]; })()
    : [0, 0, v.width, v.height];
  useLayoutEffect(() => {
    const b = el.current?.getBoundingClientRect();
    if (v && b && b.width && b.height) setK(Math.max(b.width / box[2], b.height / box[3]));
  });
  if (!m || !v) return null;
  const on = m.wps.map((w, i) => [w, i] as const).filter(([w]) => w.map_version_id === v.id);
  const pts = (l: typeof on) => l.map(([w]) => px(v, w.x, w.y).join(',')).join(' ');
  const now = on.find(([, i]) => i === run.step);
  return <svg ref={el} className="u1-mmap" viewBox={box.map((n) => +n.toFixed(2)).join(' ')} preserveAspectRatio="xMidYMid slice" aria-hidden="true" data-mission-map>
    <MapImage id={v.id} width={v.width} height={v.height} />
    <polyline className="rt" points={pts(on)} />
    <polyline className="rt done" points={pts(on.filter(([, i]) => i <= run.step))} />
    {on.map(([w, i]) => { const [x, y] = px(v, w.x, w.y); return <circle key={i} className={`wp${i < run.progress.done ? ' on' : ''}`} cx={x} cy={y} r={5 / k} />; })}
    {now && (() => { const [x, y] = px(v, now[0].x, now[0].y); return <text className="lbl" x={x + 10 / k} y={y - 10 / k} style={{ fontSize: `${13 / k}px`, strokeWidth: `${3 / k}px` }} data-wp-now><tspan className="no">{now[1] + 1}</tspan>{now[0].name ?? ''}</text>; })()}
    {me && <circle className="me" cx={me[0]} cy={me[1]} r={9 / k} />}
  </svg>;
}

/** 지금 뒤 첫 칸(실행 전) · 그 시나리오. on 이 거짓이면 받지 않는다 */
export function useNext(robot: string, on = true) {
  const [key] = useState(() => String(Date.now()));
  return useSlot(robot, on ? key : '', (mine) => mine.findIndex((x) => !x.run_id && Date.parse(x.start) > Date.now()));
}

/** 다음 일 카드(시안 u1_15). 「밸브 4 곳」 의 할 일 이름은 서버 값이 없어 「지점 n 곳」 */
export function NextCard({ m, dots }: { m: Mission | null; dots?: ReactNode }) {
  if (!m) return null;
  const mins = Math.round((Date.parse(m.slot.end) - Date.parse(m.slot.start)) / 60000);
  return <Card head={`다음 ${m.n} / ${m.of}`} title={m.name} right={`${hhmm(m.slot.start)} 시작`} total={m.wps.length} done={0} line={`지점 ${m.wps.length} 곳 · 약 ${mins} 분`} dots={dots} />;
}

/** 왼쪽 아래 카드 자리(시안 u1_1 · u1_15): 지금 임무 ↔ 다음 일. 다음 칸이 있을 때만 넘기기 점(시안 .row 점 · 시안은 세 장, 앞 일 카드는 자료가 없어 두 장) */
export function MissionCards({ robot, m, run, hold }: { robot: string; m: Mission | null; run: RunSnapshot; hold?: string }) {
  const next = useNext(robot), [page, setPage] = useState(0), at = next ? page : 0;
  const dots = next ? <span className="row dots" role="group" aria-label="카드 넘기기">{['지금 임무', '다음 일'].map((t, i) =>
    <button key={t} type="button" aria-label={t} aria-pressed={at === i} className={at === i ? 'on' : undefined} onClick={() => setPage(i)} />)}</span> : undefined;
  return at === 1 ? <NextCard m={next} dots={dots} /> : <MissionCard m={m} run={run} dots={dots} hold={hold} />;
}
