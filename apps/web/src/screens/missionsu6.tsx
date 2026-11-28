/** 임무 탭 PC = 시안 u6 (proto/screens/u6_1 ~ u6_9). 화면 마크업은 시안 body 를 기계적으로 옮긴 것(태그 · class · 순서 · 글 그대로),
 *  시안 머리줄(.bar)은 앱 머리줄 몫이라 뺐다. 고정 글 자리만 서버 값으로 바꾸고, 서버에 값이 없는 자리는 비우거나 잠그고 까닭 한 줄.
 *  일정 · 가용 · 예상은 폰 판(missiontab.tsx)과 같은 훅(usePlan · useRoute · useMissionList), 배정 · 실행은 시안 u15_2 창(missionsu6pre.tsx).
 *  탭 안의 모든 단추는 시안 화면 흐름(u6_1 ~ u6_9 · u15_1 · u15_2)으로만 간다 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import '../proto/ui.pv.css';
import '../proto/pc.pv.css';
import '../proto/dark.pv.css';
import '../proto/light.pv.css';
import './missionsu6.css';
import './missionsu6.app.css';
import type { Estimate, RobotAvailability, Scenario, ScheduleSlot } from '../../../contracts/ts';
import { api, type ApiFail } from '../api';
import { robotStatus, type Robot } from '../fake';
import type { Ctx } from '../screens';
import { MapFrame, MapImage, toView } from '../mapframe';
import { rt, useLive } from '../rt';
import { toMap } from './mapedit';
import { floorName, floorsOf, useTree, type Place } from './maps';
import { FINISH } from './missions';
import { DAY_FROM, DAY_TO, Guess, KIND, MODES, STATE, hm, hourOf, isoAt, mins, two, useMissionList, usePlan, useRoute, type Plan, type Route } from './missiontab';
import { MissionPlan } from './missionsu6plan';
import { Rehearse, Result } from './missionsu6run';
import { Preflight } from './missionsu6pre';
import { useTheme } from '../theme';

/** 화면(시안 장): 목록 · 일정(u6_1 · u6_8 · u6_9) / 새 임무 고르기(u6_2) / 만들기(u6_3 · 4 · 5) / 모의 실행(u6_6) / 보고서(u6_7) */
export type View = { at: 'main' } | { at: 'setup' } | { at: 'plan'; id: string; floor: string; robot: string; gait: string } | { at: 'rehearse' } | { at: 'result'; run: string; robot: string };

export function MissionsU6(c: Pick<Ctx, 'user' | 'robots' | 'cancel'> & { initial?: View }) {
  const light = useTheme()[1];
  const tree = useTree(c.cancel), places = useMemo(() => floorsOf(tree.tree), [tree.tree]);
  const m = useMissionList(c.cancel), plan = usePlan(m.cur, c.cancel), route = useRoute(m.cur, places, c.cancel);
  const [view, setView] = useState<View>(c.initial ?? { at: 'main' });
  const main = () => { setView({ at: 'main' }); m.again(); };
  // 고장 재배정(u6_9): «이 배정으로 모의 실행» → u6_6 → u6_7 에서 통과하면 «이 배정으로 일정 바꾸기»(→ u6_8). 화면을 옮겨도 안이 남게 여기서 든다
  const fix = useReassign(c.robots, plan, c.cancel), [fixOff, setFixOff] = useState(false), [pend, setPend] = useState(false);
  return <div className={`proto u6${light ? ' light' : ''}`} data-u6={view.at}>
    {view.at === 'main' && <Main c={c} m={m} plan={plan} route={route} go={setView} fix={fix} fixOff={fixOff} setFixOff={setFixOff}
      rehearseFix={(sid) => { m.setSel(sid); setPend(true); setView({ at: 'rehearse' }); }} />}
    {view.at === 'setup' && <Setup robots={c.robots} places={places} cancel={c.cancel} p={plan} close={main}
      make={(floor, robot, gait) => setView({ at: 'plan', id: '', floor, robot, gait })} />}
    {view.at === 'plan' && <MissionPlan id={view.id} floor={view.floor} robot={view.robot} gait={view.gait} user={c.user} robots={c.robots} cancel={c.cancel} places={places}
      p={plan} jobs={m.jobs} names={(id) => (id ? m.list.find((y) => y.id === id)?.name : undefined)} close={main} saved={(id) => { m.setSel(id); m.again(); }} rehearse={() => setView({ at: 'rehearse' })} />}
    {view.at === 'rehearse' && m.cur && <Rehearse x={m.cur} route={route} robots={c.robots} user={c.user} cancel={c.cancel} p={plan} close={main}
      result={(run, robot) => setView({ at: 'result', run, robot })} />}
    {view.at === 'result' && m.cur && <Result x={m.cur} route={route} run={view.run} robot={c.robots.find((r) => r.id === view.robot)} cancel={c.cancel} close={main}
      again={() => setView({ at: 'rehearse' })} edit={() => setView({ at: 'plan', id: m.cur!.id, floor: route.floor, robot: '', gait: '' })}
      fix={pend && fix.items.length ? fix : null} applyFix={async () => { if (await fix.apply()) { setPend(false); main(); } }} />}
  </div>;
}

type List = ReturnType<typeof useMissionList>;
/** 시안 아이콘(lucide 그대로) */
export const IC = {
  plus: <><path d="M5 12h14" /><path d="M12 5v14" /></>,
  flag: <path d="M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528" />,
  check: <path d="M20 6 9 17l-5-5" />,
  warn: <><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" /><path d="M12 9v4" /><path d="M12 17h.01" /></>,
  clock: <><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></>,
  play: <path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z" />,
  map: <><path d="M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z" /><path d="M15 5.764v15" /><path d="M9 3.236v15" /></>,
  robot: <><path d="M4 13h11l3-3h2v4l-2 1H5z" /><path d="M6 15l-1 4M10 15v4M14 15v4M17 15l1 4" /></>,
  bolt: <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" />,
  mount: <path d="m8 3 4 8 5-5 5 15H2L8 3z" />,
  cube: <><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" /><path d="m3.3 7 8.7 5 8.7-5" /><path d="M12 22V12" /></>,
  arrow: <><path d="M5 12h14" /><path d="m12 5 7 7-7 7" /></>,
  list: <><path d="M3 5h.01" /><path d="M3 12h.01" /><path d="M3 19h.01" /><path d="M8 5h13" /><path d="M8 12h13" /><path d="M8 19h13" /></>,
  node: <><rect width="8" height="8" x="3" y="3" rx="2" /><path d="M7 11v4a2 2 0 0 0 2 2h4" /><rect width="8" height="8" x="13" y="13" rx="2" /></>,
  pin: <><path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0" /><circle cx="12" cy="10" r="3" /></>,
  grip: <><circle cx="9" cy="12" r="1" /><circle cx="9" cy="5" r="1" /><circle cx="9" cy="19" r="1" /><circle cx="15" cy="12" r="1" /><circle cx="15" cy="5" r="1" /><circle cx="15" cy="19" r="1" /></>,
  wrench: <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z" />,
  doc: <><path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" /><path d="M14 2v5a1 1 0 0 0 1 1h5" /><path d="M10 9H8" /><path d="M16 13H8" /><path d="M16 17H8" /></>,
  x: <><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>,
  pause: <><rect x="14" y="3" width="5" height="18" rx="1" /><rect x="5" y="3" width="5" height="18" rx="1" /></>,
  battery: <><path d="M10 14v-4" /><path d="M22 14v-4" /><path d="M6 14v-4" /><rect x="2" y="6" width="16" height="12" rx="2" /></>,
};
export const Ic = ({ d, s = 16, style }: { d: ReactNode; s?: number; style?: React.CSSProperties }) => <svg className="ic" viewBox="0 0 24 24" style={{ width: `${s}px`, height: `${s}px`, ...style }} aria-hidden="true">{d}</svg>;
/** 칸 안 한 줄 안내(서버 값 없음 까닭 · 오류 · 빈 목록) */
export const Why = ({ children, alert, ...rest }: { children: ReactNode; alert?: boolean } & Record<`data-${string}`, unknown>) => <p className="lab u6-why" role={alert ? 'alert' : undefined} {...rest}>{children}</p>;
/** 시안 칸에 다 안 들어가는 목록은 쪽으로 넘긴다(스크롤 없음). 한 쪽이면 아무것도 그리지 않는다 */
export const Pager = ({ n, per, at, go, label }: { n: number; per: number; at: number; go: (i: number) => void; label: string }) => {
  const pages = Math.ceil(n / per);
  if (pages <= 1) return null;
  return <span className="row u6-pager" data-u6-pager={label}>
    <button type="button" className="btns" aria-label={`${label} 앞 쪽`} disabled={at === 0} onClick={() => go(at - 1)}>‹</button>
    <span className="lab num">{at + 1} / {pages}</span>
    <button type="button" className="btns" aria-label={`${label} 다음 쪽`} disabled={at >= pages - 1} onClick={() => go(at + 1)}>›</button>
  </span>;
};
/** 0.1 km 단위(1 km 넘으면) · m */
export const dist = (m: number) => (m >= 1000 ? [(m / 1000).toFixed(2), 'km'] : [String(Math.round(m)), 'm']);

/** 경로 지도(시안 .map 의 .stage 자리): 서버 승인 판 위에 경로 · 지점 번호 · 접근 금지 구역 · 겹침. 사진 그림 자리에 실제 지도를 그린다 */
export function RouteStage({ x, route, rehearse, children, pick, pickAt, sel }: { x?: Scenario; route: Route; rehearse?: boolean; children?: ReactNode;
  /** 지도 누름 → 지도 좌표(m) · 그 자리 화면 좌표(칸 안 px). 편집기(u6_3 · u6_5)만 */ pick?: (m: [number, number], at: [number, number], ctx: boolean) => void;
  /** 지점 누름(번호) */ pickAt?: (i: number) => void; sel?: number | null }) {
  const { v, vid, look, mapErr, retry, on, segs, inNoGo, px, r, place, floor } = route;
  const svg = useRef<SVGSVGElement | null>(null);
  const hit = (e: React.MouseEvent, ctx: boolean) => {
    if (!pick || !v || !svg.current) return;
    if ((e.target as Element).closest('[data-pt]')) return;
    if (ctx) e.preventDefault();
    const [qx, qy] = toView(svg.current, e.clientX, e.clientY), b = svg.current.closest('.map, .stage, .pane')!.getBoundingClientRect();
    pick(toMap(v, qx, qy), [e.clientX - b.left, e.clientY - b.top], ctx);
  };
  const line = rehearse ? '#4c9bff' : '#00c389';
  if (!x) return <Why>임무를 고르면 지도에 경로가 보입니다.</Why>;
  if (!vid) return <Why>{floor ? '이 임무의 층에 승인된 지도가 없습니다.' : '이 임무에는 지점이 없습니다. 만들기에서 지도에 지점을 찍으세요.'}</Why>;
  if (!v) return mapErr ? <p className="lab u6-why" role="alert">지도를 받지 못했습니다. {mapErr} <button type="button" className="btns" onClick={retry}>다시 시도</button></p>
    : <Why>지도를 불러오는 중…</Why>;
  return <MapFrame ref={svg} {...look} photo={v} at={{ right: 10, bottom: 10 }} role={pick ? 'application' : 'img'} aria-label={`${x.name || '임무'} 경로 · ${floorName(place!.floor.name)}`} data-map data-mission-map className={`u6-stage${rehearse ? ' u6-reh' : ''}`}
    onClick={pick ? (e) => hit(e, false) : undefined} onContextMenu={pick ? (e) => hit(e, true) : undefined}>
    <MapImage id={v.id} width={v.width} height={v.height} tint="#8d9590" />
    {v.features.zones.filter((z) => z.type === 'NO_GO').map((z, i) => <polygon key={i} data-nogo points={z.polygon.map(([a, b]) => px({ x: a, y: b }).join(',')).join(' ')}
      style={{ fill: '#e04a2f', fillOpacity: 0.16, stroke: '#e04a2f', strokeWidth: 1.5, strokeDasharray: '4 3' }} vectorEffect="non-scaling-stroke"><title>{`접근 금지 구역 ${z.name}`}</title></polygon>)}
    {segs.map((s, i) => <g key={i}><line x1={s.a[0]} y1={s.a[1]} x2={s.b[0]} y2={s.b[1]} style={{ stroke: 'rgba(255,255,255,.85)', strokeWidth: 7, strokeLinecap: 'round' }} vectorEffect="non-scaling-stroke" />
      <line data-seg={i} data-hit={s.hit || undefined} x1={s.a[0]} y1={s.a[1]} x2={s.b[0]} y2={s.b[1]}
        style={{ stroke: s.hit ? '#ff4d4f' : line, strokeWidth: 4, strokeLinecap: 'round', strokeDasharray: s.hit || rehearse ? '6 5' : undefined }} vectorEffect="non-scaling-stroke" /></g>)}
    {on.map(({ w, i }) => { const [a, b] = px(w), bad = inNoGo(w);
      return <g key={i} data-pt={i + 1} data-hit={bad || undefined} aria-pressed={pickAt ? sel === i : undefined} onClick={pickAt ? () => pickAt(i) : undefined} style={pickAt ? { cursor: 'pointer' } : undefined}>
        {sel === i && <circle cx={a} cy={b} r={r * 1.9} style={{ fill: 'rgba(0,195,137,.22)', stroke: '#00c389', strokeWidth: 2.5 }} vectorEffect="non-scaling-stroke" />}
        <circle cx={a} cy={b} r={r} style={{ fill: '#fff', stroke: bad ? '#ff4d4f' : line, strokeWidth: 3 }} vectorEffect="non-scaling-stroke" />
        <text x={a} y={b + r * 0.38} fontSize={r * 1.05} fontWeight={800} textAnchor="middle" style={{ fill: '#1f2421', pointerEvents: 'none' }}>{i + 1}</text></g>; })}
    {children}
  </MapFrame>;
}

/** u6_1 · u6_8 · u6_9: 왼쪽 임무 목록 · 가운데 지도 · 오른쪽 일정에 추가(또는 배정 · 실행, 고장 재배정) · 아래 오늘 일정 */
function Main({ c, m, plan: p, route, go, fix, fixOff, setFixOff, rehearseFix }: { c: Pick<Ctx, 'user' | 'robots' | 'cancel'>; m: List; plan: Plan; route: Route; go: (v: View) => void;
  fix: Fix; fixOff: boolean; setFixOff: (v: boolean) => void; rehearseFix: (scenario: string) => void }) {
  const x = m.cur, [pick, setPick] = useState<string | null>(null), [pre, setPre] = useState(false);
  const showFix = !fixOff && fix.items.length > 0, rob = c.robots.find((r) => r.id === p.rid), av = p.avail?.find((a) => a.robot_id === p.rid);
  // u6_8: 방금 넣은 칸, 또는 오늘 일정에서 누른 칸 → «실제 로봇 시작 전 점검»(u15_2)
  const made = pick ?? (p.msg?.ok ? p.made : null), slot = made ? p.slots?.find((y) => y.id === made) : undefined;
  const sx = slot?.scenario_id ? m.all?.find((y) => y.id === slot.scenario_id) : undefined, sr = slot ? c.robots.find((r) => r.id === slot.robot_id) : undefined;
  return <>
    <List x={x} m={m} p={p} edit={(id) => go({ at: 'plan', id, floor: route.floor, robot: p.rid, gait: p.gait })} add={() => go({ at: 'setup' })} />
    <div className="map" style={{ left: '388px', top: '88px', width: '1112px', height: '600px' }} aria-label="임무 지도">
      <div className="stage" style={{ inset: 0 }}><RouteStage x={x} route={route}>{rob && <RobotPill robot={rob} route={route} label={`${rob.name}${av ? ` ${stateText(av, c.robots)}` : ''}`} />}
        {showFix && c.robots.filter((r) => r.status === 'ERROR' && r.id !== rob?.id).map((r) => <RobotPill key={r.id} robot={r} route={route} bad label={`${r.name} 정지 · 오류`} />)}</RouteStage></div>
      <Chips />
      {x && route.v && <div className="u6-tags">
        <span className="g pill" data-floor-tag>{floorName(route.place!.floor.name)}{route.more > 0 ? ` · 다른 층 지점 ${route.more}` : ''}</span>
        {route.hits > 0 && <span className="g pill" data-overlap><span style={{ color: '#e04a2f', gap: '6px' }} className="row"><Ic d={IC.warn} s={15} />접근 금지 구역과 겹침 {route.hits} 곳</span></span>}</div>}
      {fix.running && <div className="g dk rrun u6-rrun" data-live-run><Ic d={IC.robot} s={16} />실제 로봇 실행 중 <span className="lab">{fix.running}</span></div>}
      {x && <Stat x={x} route={route} est={p.est} />}
    </div>
    {showFix ? <Fix f={fix} close={() => setFixOff(true)} names={(id) => m.list.find((y) => y.id === id)?.name} rehearse={rehearseFix} />
      : <Side x={slot && sx ? sx : x} robots={c.robots} p={p} slot={slot} rehearse={() => go({ at: 'rehearse' })} made={!!slot} preflight={() => setPre(true)} unpick={() => setPick(null)} />}
    <Day robots={c.robots} p={p} names={(id) => m.list.find((y) => y.id === id)?.name} fix={showFix ? fix : null} made={made} pick={(id) => { setPick(id); setPre(false); }} />
    {pre && slot && sr && sx && <Preflight robot={sr} scen={sx} user={c.user} cancel={c.cancel} close={() => setPre(false)}
      sub={`${sx.name} · ${route.place && sx.floor_ids[0] === route.place.floor.id ? floorName(route.place.floor.name) : '층'} · ${hm(slot.start)} ~ ${hm(slot.end)}`} />}
    {p.msg?.ok && x && <div className="g toast" role="status" data-add-msg>
      <Ic d={IC.check} s={20} style={{ color: '#00c389' }} />{p.msg.text}</div>}
  </>;
}

/** 지도 위 칩(시안 경로 · 구역 · 혼잡 시간). 혼잡 시간은 서버 값이 없어 잠근다 */
function Chips() {
  return <div className="chips" aria-label="지도 보기">
    <span className="g">경로</span><span className="g">구역</span>
    <span className="g dk" aria-disabled="true" title="혼잡 시간은 서버에 값이 없습니다" data-locked>혼잡 시간</span></div>;
}

/** 지도 아래 요약(길이 · 걷기 + 할 일 · 미리 확인) */
function Stat({ x, route, est }: { x: Scenario; route: Route; est: Estimate | null }) {
  const [n, u] = dist(x.est_distance_m), pr = route.pr;
  return <div className="g dk stat" aria-label="경로 요약">
    <div><div className="lab">길이</div><span data-length>{x.est_distance_m > 0 ? <><b className="num">{n}</b> <small>{u}</small></> : <b className="num">—</b>}</span></div>
    <div><div className="lab">걷기 + 할 일</div><span data-walk-task>{est ? <><b className="num">{mins(est.walk_s)} + {mins(est.task_s)}</b> <small>분</small><Guess e={est} /></> : <b className="num">—</b>}</span></div>
    <div><div className="lab">미리 확인</div><b style={{ fontSize: '16px' }} className="row u6-check" data-check>{!x.waypoints.length ? '지점 없음'
      : !pr ? <span role="status">확인하는 중…</span>
      : pr.r ? <><span style={{ color: pr.r.reachable ? '#00c389' : '#ff4d4f', display: 'flex' }}><Ic d={pr.r.reachable ? IC.check : IC.warn} s={17} /></span>{pr.r.reachable ? ' 모두 갈 수 있음' : ' 갈 수 없는 지점이 있음'}</>
      : <span className="bad" title={pr.err}>확인하지 못했습니다</span>}</b></div>
  </div>;
}

/** 왼쪽 임무 목록: 고른 임무는 .mcard(할 일 번호 · 끝 동작 · 만들기로 열기), 나머지는 .mrow(지점 수 · 길이 · 오늘 일정 수) */
function List({ x, m, p, edit, add }: { x?: Scenario; m: List; p: Plan; edit: (id: string) => void; add: () => void }) {
  const [page, setPage] = useState(0);
  const steps = x ? Math.min(x.waypoints.length, 5) : 0;
  // 칸 높이 508 = 고른 카드(100 + 할 일 30) + 줄 78
  const per = Math.max(1, Math.floor((508 - (x ? 104 + steps * 30 : 0)) / 78)) + (x ? 1 : 0);
  const shown = m.list.slice(page * per, page * per + per);
  useEffect(() => { const i = m.list.findIndex((y) => y.id === x?.id); if (i >= 0 && Math.floor(i / per) !== page) setPage(Math.floor(i / per)); }, [x?.id, per]);   // eslint-disable-line react-hooks/exhaustive-deps
  const today = (id: string) => (p.slots ?? []).filter((s) => s.scenario_id === id).length;
  return <div className="pane" style={{ left: '24px', top: '88px', width: '340px', height: '600px', padding: '20px 18px' }} aria-label="임무 목록">
    <div className="row" style={{ justifyContent: 'space-between', marginBottom: '14px' }}><span className="ttl">임무</span>
      <span className="row" style={{ gap: '8px' }}><Pager n={m.list.length} per={per} at={page} go={setPage} label="임무 목록" />
        <button type="button" className="btnp newm" style={{ height: '38px', padding: '0 14px', fontSize: '14px' }} data-new-mission onClick={add}><Ic d={IC.plus} />새 임무</button></span></div>
    {m.lost && <Why alert data-lost>주소의 임무를 찾을 수 없습니다. 지워졌을 수 있습니다 · 목록에서 고르세요.</Why>}
    {shown.map((y) => { const on = y.id === x?.id, n = today(y.id), [d, u] = dist(y.est_distance_m);
      const dur = <span className="mu2 num" style={{ fontSize: '13px' }} data-dur>{on && p.est ? `${mins(p.est.walk_s + p.est.task_s)} 분` : ''}</span>;
      return on ? <div key={y.id} className="mcard" style={{ margin: '4px 0 8px' }}>
        <button type="button" className="row" style={{ justifyContent: 'space-between', marginBottom: '8px', width: '100%' }} aria-pressed data-mission={y.id} onClick={() => m.setSel(y.id)}>
          <b style={{ fontSize: '16px' }}>{y.name}</b>{y.archived_at && <span className="lab" data-trash>휴지통</span>}{dur}</button>
        <ol aria-label={`${y.name} 할 일`}>{y.waypoints.slice(0, 5).map((w, i) => <li key={i} className="step" data-step-no={i + 1}><b className={i === 0 ? 'on' : ''}>{i + 1}</b>{m.jobs[w.mission_id]?.name ?? '할 일'}
          {w.name && <span className="mu2" style={{ marginLeft: 'auto', fontSize: '13px' }}>{w.name}</span>}</li>)}</ol>
        {y.waypoints.length > 5 && <div className="step mu2">그 밖 지점 {y.waypoints.length - 5}</div>}
        <div className="step mu2" style={{ fontWeight: '600' }}><Ic d={IC.flag} /><span data-finish-mode={y.finish?.mode ?? 'STAY'}>{FINISH[y.finish?.mode ?? 'STAY']}</span>
          <button type="button" className="btns u6-edit" data-edit-mission onClick={() => edit(y.id)}>{y.archived_at ? '열기' : '편집'}</button></div>
      </div>
        : <button key={y.id} type="button" className="mrow" aria-pressed={false} data-mission={y.id} onClick={() => m.setSel(y.id)}>
          <div><div>{y.name}{y.archived_at && <span className="lab" data-trash> 휴지통</span>}</div>
            <div className="mmeta num">{y.waypoints.length} 지점{y.est_distance_m > 0 ? ` · ${d} ${u}` : ''}{n ? ` · 오늘 ${n} 번` : ''}</div></div>
          <span className="mu2 num" style={{ fontSize: '13px', alignSelf: 'flex-start', marginTop: '14px' }} data-dur /></button>; })}
    {m.all && !m.list.length && !m.err && <Why>임무가 없습니다. «새 임무»로 지도에 지점을 찍고 지점마다 할 일을 고르세요.</Why>}
    {!m.all && !m.err && <Why>임무 목록을 불러오는 중…</Why>}
    {m.err && <p className="lab u6-why" role="alert">임무 목록을 받지 못했습니다. {m.err} <button type="button" className="btns" onClick={m.again}>다시 시도</button></p>}
  </div>;
}

/** 가용 한 줄 글: 바쁨 = 까닭 · 언제까지, 연결 전 · 끊김 = 관제 칩과 같은 판정(robotStatus) */
export function stateText(a: RobotAvailability, robots: Robot[]) {
  if (a.state === 'BUSY') return `${a.busy_label ?? STATE.BUSY}${a.busy_until ? ` · ${hm(a.busy_until)}까지` : ''}`;
  if (a.state !== 'OFFLINE') return STATE[a.state];
  const r = robots.find((y) => y.id === a.robot_id);
  return r && !r.online ? robotStatus(r).text : STATE.OFFLINE;
}
const ROBOTS_PER = 4;

/** 오른쪽 일정에 추가(u6_1 · u6_8): 시작 · 마감 · 쓸 수 있는 로봇 · 걷기 모드 · 예상 끝 · 여유 · 끝 배터리 · 모의 실행 · 일정에 추가 */
function Side({ x, robots, p, slot, rehearse, made, preflight, unpick }: { x?: Scenario; robots: Robot[]; p: Plan; slot?: ScheduleSlot; rehearse: () => void; made: boolean; preflight: () => void; unpick: () => void }) {
  const [page, setPage] = useState(0);
  const can = !!x && !x.archived_at && !!p.rid && !!p.gait && p.ok && !!p.est && !p.late && !p.busy;
  const e = slot ? null : p.est, avail = p.avail ?? [], sims = robots.filter((r) => r.sim);
  // u6_8: 오늘 일정에서 고른(또는 방금 넣은) 칸이면 그 칸의 시각 · 로봇 · 걷기 모드를 보인다(읽기만 · 「새로 넣기 ›」 로 돌아감)
  const rid = slot ? slot.robot_id : p.rid, gait = slot ? slot.gait ?? '' : p.gait;
  const time = (k: 'start' | 'end') => (slot ? <span data-slot-time={k}>{hm(slot[k])}</span> : <TimeBox k={k} value={k === 'start' ? p.start : p.end} set={k === 'start' ? p.setStart : p.setEnd} />);
  const why = slot ? null : p.past ? <Why alert data-past>지난 시각은 고를 수 없습니다. 지금({p.nowM}) 뒤로 시작을 고르세요.</Why>
    : !p.ok ? <Why alert>마감은 시작보다 뒤여야 합니다.</Why>
    : p.late && e ? <p className="lab u6-why bad mt-bad" role="alert" data-late>마감 넘음 · 예상 끝 {hm(e.eta)}</p>
    : p.msg && !p.msg.ok ? <Why alert data-add-msg>{p.msg.text}</Why>
    : !e ? <><Why data-est-why>{p.estErr ? `예상을 받지 못했습니다. ${p.estErr}` : x ? '로봇과 걷기 모드를 고르면 예상이 나옵니다.' : '임무를 고르세요.'}</Why>
      {x && p.rid && p.gait && <Why data-add-why>예상을 받은 뒤에 넣을 수 있습니다(마감 넘음을 확인해야 함).</Why>}</>
    : !can && !p.busy ? <Why data-add-why>임무 · 시각 · 로봇 · 걷기 모드를 고르면 일정에 넣을 수 있습니다.</Why> : null;
  return <div className="pane" style={{ left: '1524px', top: '88px', width: '372px', height: '600px', padding: '20px' }} aria-label="일정에 추가">
    <div className="row" style={{ justifyContent: 'space-between' }}><div className="lab">일정에 추가</div>
      {slot && <button type="button" className="lab u6-link" data-unpick onClick={unpick}>새로 넣기 ›</button>}</div>
    <div className="ttl" style={{ marginTop: '4px' }} data-side-name>{x ? x.name : '임무를 고르세요'}</div>
    <div className="row" style={{ gap: '8px', marginTop: '14px' }}>
      <label className="fld"><div className="lab">시작</div><b className="num">{time('start')}</b></label>
      <label className="fld"><div className="lab">마감</div><b className="num">{time('end')}</b></label></div>
    <div className="row" style={{ margin: '14px 0 8px', justifyContent: 'space-between' }}><div className="lab">이 시간에 쓸 수 있는 로봇</div>
      <Pager n={avail.length} per={ROBOTS_PER} at={page} go={setPage} label="로봇" /></div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }} aria-label="로봇">
      {avail.slice(page * ROBOTS_PER, page * ROBOTS_PER + ROBOTS_PER).map((a) => { const free = a.state === 'FREE' || a.state === 'CHARGING', on = rid === a.robot_id;
        return <button key={a.robot_id} type="button" className={`rob ${on ? 'on' : free ? '' : 'off'}`} aria-pressed={on} data-robot={a.robot_id} data-state={a.state} disabled={!free || !!slot}
          onClick={() => p.setRid(on ? '' : a.robot_id)}>
          <i style={{ width: '8px', height: '8px', borderRadius: '50%', background: on ? '#00c389' : '#5e6662' }} />{a.robot_name}
          <small>{a.sim ? '시뮬' : '실제'} · {stateText(a, robots)}</small>
          {free ? <span className="r num">{a.battery_pct == null ? '—' : `${Math.round(a.battery_pct)} %`}</span>
            : <span className="r mu2"><Ic d={IC.clock} /></span>}</button>; })}
      {p.avail && !p.avail.length && <Why>이 조직에 보이는 로봇이 없습니다.</Why>}
      {!p.avail && !p.availErr && p.ok && <Why>로봇 일정을 불러오는 중…</Why>}
      {p.availErr && <p className="lab u6-why" role="alert">로봇 일정을 받지 못했습니다. {p.availErr} <button type="button" className="btns" onClick={p.again}>다시 시도</button></p>}
    </div>
    <div className="lab" style={{ margin: '12px 0 8px' }}>걷기 모드</div>
    {/* AME-2 는 서버가 확정 일정을 거절한다(GAIT_NOT_READY) · 흐리게 «준비 중». 예상과 일정에만 쓰고 로봇에 보내지 않는다 */}
    <div className="mseg" role="group" aria-label="걷기 모드">{MODES.map(([t, g]) => g === 'ame2'
      ? <button key={g} type="button" disabled data-mode={t} title="AME-2 는 아직 일정에 넣을 수 없습니다">{t}<small className="u6-soon">준비 중</small></button>
      : <button key={g} type="button" className={gait === g ? 'on' : ''} aria-pressed={gait === g} disabled={!!slot} data-mode={t} onClick={() => p.setGait(p.gait === g ? '' : g)}>{t}</button>)}</div>
    <div className={`row u6-est${e ? '' : ' none'}`} style={{ marginTop: '12px', justifyContent: 'space-between' }} aria-label="예상">
      <div><div className="lab">예상 끝</div><b className="num" style={{ fontSize: '22px' }} data-est="eta">{e ? hm(e.eta) : '—'}</b>{e && <Guess e={e} />}</div>
      <div><div className="lab" title="다음 일정까지 여유">여유</div><b className={`num${e?.margin_s != null && e.margin_s < 0 ? ' bad mt-bad' : ''}`} style={{ fontSize: e && (e.margin_s == null || e.margin_s < 0) ? '15px' : '22px' }} data-est="margin">
        {!e ? '—' : e.margin_s == null ? '다음 일정 없음' : e.margin_s < 0 ? '겹침' : <>{mins(e.margin_s)}<small className="mu2"> 분</small></>}</b>{e && e.margin_s != null && e.margin_s >= 0 && <Guess e={e} />}</div>
      <div><div className="lab">종료 시 배터리</div><b className="num" style={{ fontSize: '22px' }} data-est="battery">{e && e.end_battery_pct != null ? <>{Math.round(e.end_battery_pct)}<small className="mu2"> %</small></> : '—'}</b>
        {e && e.end_battery_pct != null && <Guess e={e} />}</div>
    </div>
    <div className="u6-whyslot">{why}</div>
    <div className="row" style={{ position: 'absolute', left: '20px', right: '20px', bottom: '20px', gap: '8px' }}>
      {made ? <button type="button" className="btnp preflight" style={{ flex: '1', height: '52px', fontSize: '15.5px' }} data-preflight onClick={preflight}><Ic d={IC.check} s={17} />실제 로봇 시작 전 점검</button> : <>
        <button type="button" className="btns" style={{ flex: 'none', width: '118px', height: '52px', fontSize: '14.5px' }} data-rehearse disabled={!x || !sims.length}
          title={!sims.length ? '모의 실행은 시뮬 로봇으로 돌립니다. 이 조직에 시뮬 로봇이 없습니다.' : undefined} onClick={rehearse}><Ic d={IC.play} />모의 실행</button>
        <button type="button" className="btnp put" style={{ flex: '1', height: '52px', fontSize: '15.5px' }} disabled={!can} data-schedule-add onClick={p.add}>{p.busy ? '넣는 중…' : '일정에 추가'}</button></>}
    </div>
  </div>;
}

/** 시각 칸(HH:MM 24 시간). 시안 글꼴 그대로 보이게 브라우저 시각 고르개 대신 글 칸 · 다 쓴 값(00:00 ~ 23:59)만 넘긴다 */
function TimeBox({ k, value, set }: { k: 'start' | 'end'; value: string; set: (v: string) => void }) {
  const [d, setD] = useState(value);
  useEffect(() => setD(value), [value]);
  return <input className="num" type="text" inputMode="numeric" maxLength={5} pattern="[0-2][0-9]:[0-5][0-9]" {...{ [`data-${k}`]: '' }} aria-label={k === 'start' ? '시작(시:분)' : '마감(시:분)'}
    value={d} onChange={(ev) => { const v = ev.target.value; setD(v); if (/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) set(v); }} onBlur={() => setD(value)} />;
}

/** 일정 칸 막대 모양: 끝남 kd · 진행 중 kr · 예정(기본) · 작성 중 k2 · 배터리 교체 k3 · 겹침 kx · 재배정안 k4 */
const look = (s: ScheduleSlot, now: number) => (s.kind === 'DRAFT' ? 'k2' : s.kind === 'BATTERY_SWAP' ? 'k3' : Date.parse(s.end) <= now ? 'kd' : Date.parse(s.start) <= now ? 'kr' : 'kp');
const LEGEND: [string, React.CSSProperties][] = [['끝남', { border: '1px solid rgba(255,255,255,.14)' }], ['진행 중', { background: 'rgba(18,184,134,.42)', border: '1px solid #12b886' }],
  ['예정', { border: '1px solid rgba(255,255,255,.3)' }], ['작성 중', { border: '1px dashed #12b886' }], ['배터리 교체', { border: '1px solid rgba(255,255,255,.12)', background: 'rgba(255,255,255,.06)' }]];
const ROWS = 5;

/** 아래 오늘 일정(GET /schedule): 로봇 줄 · 시각 눈금(08~20, 밖 일정이 있으면 넓힘) · 지금 선 · 막대 · 겹침 · 방금 넣은 칸 · 재배정안 */
function Day({ robots, p, names, fix, made, pick }: { robots: Robot[]; p: Plan; names: (id: string) => string | undefined; fix: Fix | null; made: string | null; pick: (id: string) => void }) {
  const [now, setNow] = useState(() => new Date()), [page, setPage] = useState(0);
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 60_000); return () => clearInterval(t); }, []);
  const slots = p.slots ?? [];
  const lo = Math.floor(Math.min(DAY_FROM, ...slots.map((x) => hourOf(x.start)))), hi = Math.ceil(Math.max(DAY_TO, ...slots.map((x) => hourOf(x.end))));
  const HOURS = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i), span = hi - lo;
  const f = (iso: string) => (hourOf(iso) - lo) / span, at = f(now.toISOString());
  const X = (k: number) => `calc(78px + (100% - 112px) * ${k})`, W = (k: number) => `calc((100% - 112px) * ${k})`;
  const all = [...robots.map((r) => ({ id: r.id, name: r.name, bad: r.status === 'ERROR' })), ...[...new Set(slots.map((x) => x.robot_id))].filter((id) => !robots.some((r) => r.id === id))
    .map((id) => ({ id, name: p.avail?.find((a) => a.robot_id === id)?.robot_name ?? '다른 로봇', bad: false }))];
  const rows = all.slice(page * ROWS, page * ROWS + ROWS);
  const bar = (x: ScheduleSlot, top: number) => { const a = f(x.start), b = Math.max(a, f(x.end)), clash = p.clash.includes(x.id) || !!fix?.items.some((i) => i.slot.id === x.id);
    const label = x.kind === 'BATTERY_SWAP' ? KIND.BATTERY_SWAP : (x.scenario_id && names(x.scenario_id)) || '임무';
    // 시안: 배터리 교체 칸은 빗금만(글 없음). 너무 좁은 칸(약 40px 아래)은 글을 빼고 이름은 title · aria-label 로
    const text = x.kind === 'BATTERY_SWAP' || (b - a) * 1736 < 40 ? '' : label;
    return <div key={x.id} className={`bk ${clash ? 'kx' : look(x, now.getTime())}${made === x.id ? ' u6-made' : ''}`} data-slot={x.id} data-kind={x.kind} data-conflict={clash || undefined} data-x={a} data-w={b - a}
      style={{ left: X(a), width: W(b - a), top: `${top}px`, ...(x.scenario_id ? { cursor: 'pointer' } : {}) }} title={`${label} · ${hm(x.start)}~${hm(x.end)} · ${KIND[x.kind]}`}
      {...(x.scenario_id ? { role: 'button', tabIndex: 0, onClick: () => pick(x.id), onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(x.id); } } } : {})} aria-label={label}>{text}</div>; };
  const plans = fix?.items.flatMap((i) => (i.to ? [{ ...i.slot, id: `fix-${i.slot.id}`, robot_id: i.to }] : [])) ?? [];
  return <div className="pane tl" aria-label="오늘 일정">
    <div className="row" style={{ justifyContent: 'space-between' }}>
      <span className="row" style={{ gap: '12px' }}><span className="ttl" style={{ fontSize: '18px' }}>오늘 일정</span>
        <span className="lab">로봇 {all.length} 대 · <span data-day-count>임무 {slots.length} 건</span></span><Pager n={all.length} per={ROWS} at={page} go={setPage} label="로봇 줄" /></span>
      <span className="row lab" style={{ gap: '16px' }} data-legend>{LEGEND.map(([t, s]) => <span key={t} className="leg"><i style={s} />{t}</span>)}
        {plans.length > 0 && <span className="leg"><i style={{ border: '1.5px dashed #4c9bff' }} />재배정안</span>}</span>
    </div>
    <div className="tlg">
      {HOURS.map((h, i) => <div key={h} style={{ position: 'absolute', left: X(i / span), top: '0', bottom: '0', borderLeft: '1px solid rgba(255,255,255,.06)', fontSize: '12px', color: '#9aa19d', paddingLeft: '5px' }} className="num u6-hour">{Math.abs(i / span - at) * span < 0.45 ? '' : two(h)}</div>)}
      {rows.map((r, k) => <div key={r.id} data-day-robot={r.id} style={{ display: 'contents' }}>
        <div style={{ position: 'absolute', left: '0', top: `${34 + k * 46}px`, fontSize: '14px', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '6px', ...(r.bad ? { color: '#ff4d4f' } : {}) }}>{r.name}{r.bad && <Ic d={IC.warn} s={15} />}</div>
        {slots.filter((x) => x.robot_id === r.id).map((x) => bar(x, 30 + k * 46))}
        {plans.filter((x) => x.robot_id === r.id).map((x) => <div key={x.id} className="bk k4" data-fix-plan={x.id} style={{ left: X(f(x.start)), width: W(Math.max(0, f(x.end) - f(x.start))), top: `${30 + k * 46}px` }}>{(x.scenario_id && names(x.scenario_id)) || '임무'}</div>)}
      </div>)}
      {at >= 0 && at <= 1 && <>
        <div style={{ position: 'absolute', left: X(at), top: '22px', bottom: '0', width: '2px', background: '#12b886' }} data-now />
        <div className="num" style={{ position: 'absolute', left: `calc(${X(at)} - 24px)`, top: '-2px', width: '50px', height: '22px', borderRadius: '7px', background: 'rgba(18,184,134,.18)', border: '1px solid #12b886', color: '#5ef0bf', fontSize: '12px', fontWeight: '700', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{hm(now.toISOString())}</div></>}
    </div>
    {!all.length && <Why>로봇이 없습니다.</Why>}
    {!p.slots && !p.dayErr && <Why>오늘 일정을 불러오는 중…</Why>}
    {p.dayErr && <p className="lab u6-why" role="alert">오늘 일정을 받지 못했습니다. {p.dayErr} <button type="button" className="btns" onClick={p.again}>다시 시도</button></p>}
  </div>;
}

/** 고장 로봇의 남은 일 다시 배정(u6_9). 고장 = 서버 상태 ERROR 인 로봇. 남은 일 = 오늘 일정에서 아직 끝나지 않은 그 로봇 칸(배터리 교체 · 실행 중 칸 뺌).
 *  받을 로봇 = 그 칸 시간에 GET /robots/availability 가 FREE 로 준 다른 로봇(처음 것, 직접 고르기로 바꿈). 바꾸기 = 새 칸 POST /schedule/slots 뒤 옛 칸 DELETE */
type FixItem = { slot: ScheduleSlot; free: RobotAvailability[]; to: string; battery: number | null };
export type Fix = ReturnType<typeof useReassign>;
function useReassign(robots: Robot[], p: Plan, cancel?: AbortSignal) {
  const bad = robots.filter((r) => r.status === 'ERROR'), badIds = bad.map((r) => r.id).join(',');
  const left = (p.slots ?? []).filter((s) => bad.some((r) => r.id === s.robot_id) && Date.parse(s.end) > Date.now() && s.kind !== 'BATTERY_SWAP' && s.scenario_id && !s.run_id);
  const key = left.map((s) => s.id).join(',');
  const [items, setItems] = useState<FixItem[]>([]), [busy, setBusy] = useState(false), [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    if (!left.length) { setItems([]); return; }
    let live = true;
    Promise.all(left.map(async (slot) => {
      const free = (await api.availability(slot.start, slot.end, cancel).then((r) => r.items, () => [] as RobotAvailability[])).filter((a) => a.state === 'FREE' && !bad.some((r) => r.id === a.robot_id));
      return { slot, free, to: free[0]?.robot_id ?? '', battery: null } as FixItem;
    })).then((l) => live && setItems(l));
    return () => { live = false; };
  }, [key, badIds]);   // eslint-disable-line react-hooks/exhaustive-deps
  // 받을 로봇의 끝 배터리 = 그 칸을 그 로봇 · 그 걷기 모드로 낸 예상(걷기 모드가 없는 칸은 예상을 못 낸다)
  const toKey = items.map((i) => `${i.slot.id}:${i.to}`).join(',');
  useEffect(() => {
    let live = true;
    items.forEach((i, k) => {
      if (!i.to || !i.slot.gait || !i.slot.scenario_id || i.slot.scenario_version == null) return;
      api.estimate({ scenario_id: i.slot.scenario_id, scenario_version: i.slot.scenario_version, robot_id: i.to, gait: i.slot.gait, start: i.slot.start }, cancel)
        .then((e) => live && setItems((l) => l.map((y, j) => (j === k && y.to === i.to ? { ...y, battery: e.end_battery_pct } : y))), () => {});
    });
    return () => { live = false; };
  }, [toKey]);   // eslint-disable-line react-hooks/exhaustive-deps
  const pick = (id: string, to: string) => setItems((l) => l.map((y) => (y.slot.id === id ? { ...y, to, battery: null } : y)));
  const apply = async () => {
    setBusy(true); setMsg(null);
    let done = 0;
    for (const i of items.filter((y) => y.to)) {
      const s = i.slot;
      try {
        await api.addSlot({ robot_id: i.to, scenario_id: s.scenario_id, scenario_version: s.scenario_version, gait: s.gait, start: s.start, end: s.end, kind: s.kind }, crypto.randomUUID(), cancel);
        await api.dropSlot(s.id, cancel); done += 1;
      } catch (e) { setMsg({ ok: false, text: `${done ? `${done} 건은 바꿨고, ` : ''}${hm(s.start)} 칸을 바꾸지 못했습니다. ${(e as ApiFail).message}` }); setBusy(false); p.again(); return false; }
    }
    setBusy(false); setMsg({ ok: true, text: `남은 일 ${done} 건을 다시 배정했습니다.` }); p.again(); return true;
  };
  const running = robots.find((r) => !r.sim && r.status === 'RUNNING')?.name ?? '';
  return { bad, items, pick, apply, busy, msg, running };
}

/** 오른쪽 고장 칸(u6_9): 고장 로봇 · 남은 일 · 받을 로봇 · 끝 배터리 · 직접 고르기 · 바꾸기 */
function Fix({ f, close, names, rehearse }: { f: Fix; close: () => void; names: (id: string) => string | undefined; rehearse: (scenario: string) => void }) {
  const [hand, setHand] = useState(false);
  const r = f.bad.find((b) => f.items.some((i) => i.slot.robot_id === b.id)) ?? f.bad[0];
  return <div className="pane" style={{ left: '1524px', top: '88px', width: '372px', height: '600px', padding: '20px' }} aria-label="남은 일 다시 배정" data-fix>
    <div className="row" style={{ gap: '8px', color: '#ff4d4f', fontSize: '13.5px', fontWeight: '800' }}><Ic d={IC.wrench} s={17} />{r.name} 고장{r.seenAt ? ` · ${r.seenAt.slice(0, 5)}` : ''}</div>
    <div className="ttl" style={{ marginTop: '6px' }}>남은 일 {f.items.length} 건 다시 배정</div>
    <div className="lab" style={{ marginTop: '6px', lineHeight: '1.5' }}>{robotStatus(r).text} 상태로 멈췄습니다. 오늘 남은 일을 그 시간에 비어 있는 로봇에게 나눠 맡깁니다.</div>
    {f.items.slice(0, 3).map((i) => { const to = i.free.find((a) => a.robot_id === i.to);
      return <div key={i.slot.id} style={{ marginTop: '12px', padding: '14px', borderRadius: '14px', border: '1.5px dashed rgba(159,182,255,.5)', background: 'rgba(159,182,255,.05)' }} data-fix-item={i.slot.id}>
        <div className="row" style={{ justifyContent: 'space-between' }}><b style={{ fontSize: '15px' }}>{(i.slot.scenario_id && names(i.slot.scenario_id)) || '임무'}</b><span className="num lab">{hm(i.slot.start)} ~ {hm(i.slot.end)}</span></div>
        <div className="row" style={{ gap: '8px', marginTop: '8px', fontSize: '14px', fontWeight: '700' }}><span className="mu2" style={{ textDecoration: 'line-through' }}>{r.name}</span><Ic d={IC.arrow} />
          {hand ? <select className="u6-select" aria-label="받을 로봇" value={i.to} onChange={(e) => f.pick(i.slot.id, e.target.value)}>
            <option value="">고르지 않음</option>{i.free.map((a) => <option key={a.robot_id} value={a.robot_id}>{a.robot_name}</option>)}</select>
            : <span style={{ color: '#4c9bff' }} data-fix-to>{to?.robot_name ?? '비어 있는 로봇 없음'}</span>}
          <span className="lab" style={{ marginLeft: 'auto' }}>{i.battery != null ? `끝에 배터리 ${Math.round(i.battery)} %` : i.slot.gait ? '' : '걷기 모드 없는 칸 · 예상 없음'}</span></div></div>; })}
    {f.items.length > 3 && <Why>그 밖 {f.items.length - 3} 건은 바꾸기를 누르면 같은 방식으로 함께 바뀝니다.</Why>}
    {f.msg && <Why alert={!f.msg.ok} data-fix-msg>{f.msg.text}</Why>}
    <div className="row" style={{ position: 'absolute', left: '20px', right: '20px', bottom: '20px', gap: '8px' }}>
      <button type="button" className="btns" style={{ width: '118px', height: '52px', fontSize: '14.5px' }} aria-pressed={hand} onClick={() => setHand((h) => !h)} data-fix-hand>직접 고르기</button>
      <button type="button" className="btnp" style={{ flex: '1', height: '52px', fontSize: '15px' }} disabled={f.busy || !f.items.some((i) => i.to)} onClick={() => rehearse(f.items.find((i) => i.to)!.slot.scenario_id!)} data-fix-apply><Ic d={IC.play} />이 배정으로 모의 실행</button>
    </div>
    <div className="lab" style={{ position: 'absolute', left: '20px', right: '20px', bottom: '80px' }}>모의 실행이 통과해야 일정에 들어갑니다.</div>
    <button type="button" className="lab u6-link" style={{ position: 'absolute', right: '20px', top: '20px' }} onClick={close} data-fix-later>나중에</button>
  </div>;
}

/** u6_2 새 임무: 지도(승인 판이 있는 층) · 로봇(고른 시간 가용) · 걷기 모드를 고르고 «임무 만들기» */
function Setup({ robots, places, cancel, p, close, make }: { robots: Robot[]; places: Place[]; cancel?: AbortSignal; p: Plan; close: () => void; make: (floor: string, robot: string, gait: string) => void }) {
  const maps = places.filter((x) => x.floor.approved_version_id);
  const [floor, setFloor] = useState(''), [robot, setRobot] = useState(''), [gait, setGait] = useState<string>('start'), [mp, setMp] = useState(0), [rp, setRp] = useState(0);
  const f = floor || maps[0]?.floor.id || '', avail = p.avail ?? [];
  const r = avail.find((a) => a.robot_id === robot);
  void cancel;
  const MODE: Record<string, [string, string]> = { classic: ['Classic Mode', '기본 걷기. 평평한 바닥에서 가장 조용하고 매끄럽습니다.'], sport: ['Sport Mode', '빠른 걷기. 넓은 통로에서 걸리는 시간을 줄입니다.'], start: ['START Mode', '험지 걷기 (Foothold). 계단 · 경사 · 틈이 있는 길을 그대로 지납니다.'] };
  const card = (x: Place, big: boolean) => { const on = x.floor.id === f;
    return <button key={x.floor.id} type="button" aria-pressed={on} data-setup-map={x.floor.id} onClick={() => setFloor(x.floor.id)} className="u6-mapcard"
      style={{ position: 'relative', borderRadius: '18px', overflow: 'hidden', ...(on ? { border: '1.5px solid rgba(0,195,137,.7)', boxShadow: '0 0 0 4px rgba(0,195,137,.12)' } : { border: '1px solid var(--line)' }), background: 'rgba(255,255,255,.03)' }}>
      <div style={{ height: big ? '370px' : '150px', position: 'relative', overflow: 'hidden' }}><img src={api.imageUrl(x.floor.approved_version_id!)} alt="" className="u6-mapimg" /></div>
      {on && <span style={{ position: 'absolute', right: '14px', top: '14px', color: '#00c389', width: '34px', height: '34px', borderRadius: '50%', background: 'rgba(12,15,20,.6)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Ic d={IC.check} s={22} /></span>}
      <div style={{ padding: '14px 16px', textAlign: 'left' }}><b style={{ fontSize: '16px' }}>{floorName(x.floor.name)}</b><div className="lab" style={{ marginTop: '4px' }}>{x.site.name} · {x.building.name}</div></div></button>; };
  const first = maps.find((x) => x.floor.id === f), rest = maps.filter((x) => x.floor.id !== f).slice(mp * 2, mp * 2 + 2);
  const t0 = Math.floor(hm2h(p.start)) - 2;   // 시안: 고른 시각 앞뒤 2 시간(150px = 4 시간)
  return <>
    <div className="hdr"><span className="ttl" style={{ fontSize: '26px' }}>새 임무</span><span className="lab" style={{ marginLeft: '8px', fontSize: '14px' }}>지도 · 로봇 · 걷기 모드를 고르면 임무를 만들 수 있습니다</span>
      <span className="g dk chip" style={{ marginLeft: 'auto' }}><Ic d={IC.clock} s={17} />{p.start} ~ {p.end}<small>이 시간에 맞춰 고릅니다</small></span></div>
    <div className="pane" style={{ left: '24px', top: '156px', width: '620px', bottom: '120px', padding: '22px' }} aria-label="지도">
      <div className="row" style={{ gap: '10px', marginBottom: '16px' }}><span style={{ color: '#00c389' }}><Ic d={IC.map} s={20} /></span><span className="ttl">지도</span>
        <span style={{ marginLeft: 'auto' }}><Pager n={Math.max(0, maps.length - 1)} per={2} at={mp} go={setMp} label="지도" /></span></div>
      {first && card(first, true)}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px', marginTop: '14px' }}>{rest.map((x) => card(x, false))}</div>
      {!maps.length && <Why>승인된 지도가 있는 층이 없습니다. 지도 탭에서 지도를 올리고 승인하세요.</Why>}
    </div>
    <div className="pane" style={{ left: '668px', top: '156px', width: '600px', bottom: '120px', padding: '22px' }} aria-label="로봇">
      <div className="row" style={{ gap: '10px', marginBottom: '6px' }}><span style={{ color: '#00c389' }}><Ic d={IC.robot} s={20} /></span><span className="ttl">로봇</span>
        <span style={{ marginLeft: 'auto' }}><Pager n={avail.length} per={6} at={rp} go={setRp} label="로봇" /></span></div>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: '14px' }}><span className="lab">{p.start} ~ {p.end} 에 비어 있는 로봇만 고를 수 있습니다</span></div>
      <div className="row lab num" style={{ margin: '-6px 0 6px' }}><span style={{ width: '304px' }} /><span style={{ width: '150px', display: 'flex', justifyContent: 'space-between' }}>{[0, 2, 4].map((k) => <span key={k}>{two((t0 + k + 24) % 24)}</span>)}</span></div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {avail.slice(rp * 6, rp * 6 + 6).map((a) => { const free = a.state === 'FREE' || a.state === 'CHARGING', on = robot === a.robot_id;
          return <button key={a.robot_id} type="button" className={`rob ${on ? 'on' : free ? '' : 'off'}`} style={{ height: '76px' }} disabled={!free} aria-pressed={on} data-setup-robot={a.robot_id} onClick={() => setRobot(on ? '' : a.robot_id)}>
            <Ic d={IC.robot} s={20} /><div style={{ width: '250px', textAlign: 'left' }}>{a.robot_name}<small style={{ display: 'block', marginTop: '2px' }}>{a.sim ? '실제 로봇 없이 화면 속에서만' : `${stateText(a, robots)}${a.battery_pct == null ? '' : ` · ${Math.round(a.battery_pct)} %`}`}</small></div>
            <Mini t0={t0} a={hm2h(p.start)} b={hm2h(p.end)} slots={(p.slots ?? []).filter((x) => x.robot_id === a.robot_id)} />
            <span className="r"><span style={{ height: '24px', padding: '0 9px', borderRadius: '8px', fontSize: '12px', fontWeight: '800', display: 'flex', alignItems: 'center', ...(a.sim ? { border: '1.5px dashed #4c9bff', color: '#4c9bff' } : { border: '1.5px solid #00c389', color: '#00c389' }) }}>{a.sim ? '시뮬' : '실제'}</span></span></button>; })}
        {p.avail && !avail.length && <Why>이 조직에 보이는 로봇이 없습니다.</Why>}
        {!p.avail && <Why>{p.availErr ? `로봇 일정을 받지 못했습니다. ${p.availErr}` : '로봇 일정을 불러오는 중…'}</Why>}
      </div>
      <div className="row lab" style={{ gap: '10px', marginTop: '18px', lineHeight: '1.55', fontSize: '13.5px', padding: '14px 16px', borderRadius: '14px', background: 'rgba(255,255,255,.03)', border: '1px solid var(--line)' }}>
        <Ic d={IC.bolt} s={18} /><span>실제 로봇을 고르면 임무를 만드는 동안 조종하는 대로 실제 로봇이 움직입니다. 시뮬은 화면 속에서만 움직입니다 (모의 실행).</span></div>
    </div>
    <div className="pane" style={{ left: '1292px', top: '156px', right: '24px', bottom: '120px', padding: '22px' }} aria-label="걷기 모드">
      <div className="row" style={{ gap: '10px', marginBottom: '16px' }}><span style={{ color: '#00c389' }}><Ic d={IC.mount} s={20} /></span><span className="ttl">걷기 모드</span></div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {(['classic', 'sport', 'start'] as const).map((g) => { const on = gait === g;
          return <button key={g} type="button" className="rob" aria-pressed={on} data-setup-gait={g} onClick={() => setGait(g)}
            style={{ height: 'auto', padding: '22px 20px', alignItems: 'flex-start', ...(on ? { borderColor: 'rgba(0,195,137,.55)', background: 'rgba(0,195,137,.09)' } : {}) }}>
            <span style={{ marginTop: '1px', color: on ? '#00c389' : '#9aa19d' }}><Ic d={IC.mount} s={19} /></span>
            <div style={{ flex: '1', textAlign: 'left' }}><b style={{ fontSize: '15.5px' }}>{MODE[g][0]}</b><div className="lab" style={{ marginTop: '5px', lineHeight: '1.5', fontSize: '13.5px' }}>{MODE[g][1]}</div>
              <div className="row" style={{ gap: '8px', marginTop: '12px', paddingTop: '12px', borderTop: '1px solid var(--line)' }}><span className="lab">이 지도에서</span><b className="num" style={{ fontSize: '17px' }}>—</b><small className="mu2">분</small>
                <span className="lab" style={{ marginLeft: 'auto' }} data-setup-why>임무를 만든 뒤 예상</span></div></div></button>; })}
      </div>
      <div className="row lab" style={{ position: 'absolute', left: '22px', right: '22px', bottom: '22px', gap: '10px', lineHeight: '1.55', fontSize: '13.5px', padding: '14px 16px', borderRadius: '14px', background: 'rgba(255,255,255,.03)', border: '1px solid var(--line)' }}>
        <Ic d={IC.clock} s={18} /><span>모드는 로봇이 서 있을 때만 바뀝니다. 임무 중에는 고른 모드로 끝까지 걷습니다.</span></div>
    </div>
    <div className="pane" style={{ left: '24px', right: '24px', bottom: '24px', height: '80px', display: 'flex', alignItems: 'center', gap: '18px', padding: '0 24px' }} aria-label="고른 것">
      <span className="row" style={{ gap: '10px', fontSize: '15px', fontWeight: '700' }}><Ic d={IC.map} s={18} />{first ? floorName(first.floor.name) : '지도 없음'}<span className="mu2">·</span>
        <Ic d={IC.robot} s={18} />{r ? `${r.robot_name} ${r.sim ? '시뮬' : '실제'}` : '로봇 고르지 않음'}<span className="mu2">·</span><Ic d={IC.mount} s={18} />{MODE[gait][0]}</span>
      <span className="lab row" style={{ gap: '6px' }}><Ic d={IC.cube} />물리 계산 MuJoCo</span>
      <button type="button" className="btns" style={{ marginLeft: 'auto', width: '120px', height: '50px', fontSize: '14.5px' }} onClick={close} data-setup-close>닫기</button>
      <button type="button" className="btnp start" style={{ width: '220px', height: '50px', fontSize: '15.5px' }} disabled={!first} data-setup-make onClick={() => make(f, robot, gait)}>임무 만들기<Ic d={IC.arrow} s={17} /></button>
    </div>
  </>;
}

const hm2h = (t: string) => { const [h, m] = t.split(':').map(Number); return h + m / 60; };
/** 시안 u6_2 로봇 줄의 작은 시간표: 고른 시간대(초록 테두리)와 그 로봇의 오늘 일정 칸(GET /schedule) · 150px = 4 시간 */
function Mini({ t0, a, b, slots }: { t0: number; a: number; b: number; slots: ScheduleSlot[] }) {
  const K = 37.5, x = (h: number) => Math.max(0, Math.min(150, (h - t0) * K));
  return <span style={{ position: 'relative', width: '150px', height: '20px', borderRadius: '5px', background: 'rgba(255,255,255,.05)', flex: 'none' }} aria-hidden="true" data-mini>
    <i style={{ position: 'absolute', left: `${x(a)}px`, width: `${Math.max(2, x(b) - x(a))}px`, top: 0, bottom: 0, border: '1.5px solid #00c389', borderRadius: '4px', zIndex: 1 }} />
    {slots.map((y) => { const l = x(hourOf(y.start)), w = x(hourOf(y.end)) - l; return w > 0 ? <i key={y.id} style={{ position: 'absolute', left: `${l}px`, width: `${w}px`, top: '4px', bottom: '4px', borderRadius: '3px', background: '#5e6662' }} /> : null; })}
  </span>;
}

/** 시안 u6_1 지도 위 「● K-01 관제실 대기」: 일정 칸에서 고른 로봇의 지금 자리(실시간 state.location, 그 층일 때만) */
export function RobotPill({ robot, route, label, bad }: { robot: Robot; route: Route; label: string; /** 시안 u6_9 고장 로봇: 빨간 점 · 빨간 글 */ bad?: boolean }) {
  const tone = bad ? '#e04a2f' : '#00c389';
  useEffect(() => rt.watch(robot.id), [robot.id]);
  const l = useLive(robot.id), at = l.state?.location;
  if (!route.v || !at || at.x == null || at.y == null || at.floor_id !== route.floor) return null;
  const [a, b] = route.px({ x: at.x, y: at.y }), r = route.r, fs = r * 1.05, w = label.length * fs * 0.95 + r * 2.6, h = r * 2.2;
  return <g data-robot-pill={robot.id} style={{ pointerEvents: 'none' }}>
    <circle cx={a} cy={b} r={r} style={{ fill: bad ? tone : '#fff', stroke: bad ? '#fff' : tone, strokeWidth: 3 }} vectorEffect="non-scaling-stroke" />
    <rect x={a - w / 2} y={b - r * 4.2} width={w} height={h} rx={h * 0.3} style={{ fill: 'rgba(255,255,255,.85)', stroke: 'rgba(255,255,255,.95)' }} />
    <circle cx={a - w / 2 + r * 1.1} cy={b - r * 4.2 + h / 2} r={r * 0.32} style={{ fill: tone }} />
    <text x={a - w / 2 + r * 1.8} y={b - r * 4.2 + h / 2 + fs * 0.36} fontSize={fs} fontWeight={700} style={{ fill: bad ? tone : '#1f2421' }}>{label}</text></g>;
}
