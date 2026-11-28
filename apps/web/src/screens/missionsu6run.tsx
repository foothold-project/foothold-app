/** 시안 u6_6 모의 실행 · u6_7 보고서. 모의 실행 = 시뮬 로봇에서 시나리오를 실제로 돌리는 run.start(05 §6.5, 파란 점선 rehearse).
 *  진행은 그 로봇 state.run(상태 · 지점 n/N), 보고서는 끝난 실행 기록(GET /runs/{id}/history · /events?run_id=)만 쓴다.
 *  시작 · 멈춤 · 이어 가기는 u15_2 와 같은 관문(useRunGate: 배정 · 조종권 · 잠금)을 이 칸 단추로 푼다(옛 실행 칸 없음).
 *  겹침 · 충돌 · 중복 · 혼잡 · 배속 · 물리 점검 · 추천은 서버에 값이 없다(서버 요청 3 절). 값이 오기 전까지 비우고 까닭 한 줄 */
import { useEffect, useRef, useState } from 'react';
import type { Event as Ev, RunHistory, RunSnapshot, Scenario } from '../../../contracts/ts';
import { ApiFail, api } from '../api';
import type { Robot } from '../fake';
import { RUN_FAIL, RUN_STATUS } from '../run';
import { useLive } from '../rt';
import type { Ctx } from '../screens';
import { floorName } from './maps';
import { hm, type Plan, type Route } from './missiontab';
import { IC, Ic, Pager, RouteStage, Why, type Fix } from './missionsu6';
import { useRunGate } from './missionsu6pre';
import { result, stops, took } from './runreport';

const DONE = ['COMPLETED', 'FAILED', 'CANCELED'];
export const NO = '서버에 값 없음';
const band = { color: 'rgba(159,182,255,.75)', fontWeight: 600 } as const;

/** 지금 이 화면의 모의 실행 로봇: 시뮬 로봇 중 실행이 도는 것, 없으면 첫 시뮬 로봇 */
function useSimRobot(robots: Robot[]) {
  const sims = robots.filter((r) => r.sim);
  return sims;
}

/** 시뮬 로봇 한 대의 위치 점(그 층 · 그 지도 판일 때만) */
function Dot({ robot, route }: { robot: Robot; route: Route }) {
  const l = useLive(robot.id), at = l.state?.location ?? robot.location;
  if (!route.v || !at || at.x == null || at.y == null || at.floor_id !== route.floor) return null;
  const [x, y] = route.px({ x: at.x, y: at.y });
  return <g data-sim-dot={robot.id}><circle cx={x} cy={y} r={route.r * 1.6} style={{ fill: 'rgba(76,155,255,.25)' }} />
    <circle cx={x} cy={y} r={route.r * 0.8} style={{ fill: '#1d3b7a', stroke: '#4c9bff', strokeWidth: 2.5 }} vectorEffect="non-scaling-stroke" /></g>;
}

/** u6_6 모의 실행 중 */
export function Rehearse({ x, route, robots, user, cancel, p, close, result: toResult }: { x: Scenario; route: Route; robots: Robot[]; user: Ctx['user']; cancel?: AbortSignal; p: Plan; close: () => void; result: (run: string, robot: string) => void }) {
  const sims = useSimRobot(robots), sim = sims[0], g = useRunGate(sim, x, user, cancel);
  return <>
    <div className="band" data-band><Ic d={IC.play} />모의 실행 · 시뮬<span style={band}>실제 로봇은 움직이지 않습니다</span></div>
    <div className="map" style={{ left: '24px', top: '128px', width: '1476px', height: '692px', border: '1.5px dashed rgba(159,182,255,.5)' }} aria-label="모의 실행 지도">
      <div className="stage" style={{ inset: 0 }}><RouteStage x={x} route={route} rehearse>{sims.map((r) => <Dot key={r.id} robot={r} route={route} />)}</RouteStage></div>
      <div className="chips"><span className="g dk" style={{ gap: '8px' }}><Ic d={IC.robot} />시뮬 로봇 {sims.length} 대</span>
        <span className="g dk" style={{ gap: '10px' }}><i style={{ width: '22px', borderTop: '3px solid #00c389' }} />실제<i style={{ width: '22px', borderTop: '3px dashed #4c9bff' }} />모의 실행</span></div>
    </div>
    <Progress sims={sims} x={x} own={g.own?.run_id ?? g.mine} />
    <div className="pane" style={{ left: '1524px', top: '128px', right: '24px', bottom: '24px', padding: '22px' }} aria-label="모의 실행">
      <div className="lab">모의 실행 · {x.name}</div>
      <div className="ttl" style={{ marginTop: '4px' }}>{p.start} ~ {p.end} · 시뮬 로봇 {sims.length} 대</div>
      <div className="lab" style={{ margin: '18px 0 8px' }}>배속</div>
      <div className="mseg" aria-disabled="true" title="배속은 서버에 값이 없어 바꿀 수 없습니다" data-locked><span className="on">1 배</span><span>10 배</span><span>30 배</span><span>60 배</span></div>
      <div className="row" style={{ justifyContent: 'space-between', margin: '20px 0 6px' }}><span className="lab">지금까지 점검</span><span className="lab">생기면 지도에 표시</span></div>
      {['겹침', '충돌', '중복', '혼잡'].map((t) => <div key={t} className="chk" data-chk={t}><span className="mu2"><Ic d={IC.clock} /></span><div>{t}</div><span className="v mu2">{NO}</span></div>)}
      {sim && <Battery robot={sim} />}
      <Why data-rehearse-why>겹침 · 충돌 · 중복 · 혼잡 · 배속은 서버에 아직 값이 없어 비워 둡니다. 실행 상태 · 지점 진행 · 배터리만 실제 값입니다.</Why>
      {!sim && <Why alert>이 조직에 시뮬 로봇이 없어 모의 실행을 돌릴 수 없습니다.</Why>}
      {sim && !g.on && (g.why || g.say) && <div className="u6-whyslot" style={{ bottom: '92px' }}>
        <p className={`lab u6-why${g.say ? ' bad' : ''}`} role={g.say ? 'alert' : 'status'} data-rehearse-gate>{g.say || g.why}</p>
        {g.act && <button type="button" className="btns" style={{ height: '40px', padding: '0 14px', borderColor: 'rgba(242,183,5,.5)', color: '#f2b705' }} disabled={g.act.busy} onClick={g.act.run} data-rehearse-act><Ic d={IC.warn} />{g.act.label}</button>}</div>}
      <div className="row" style={{ position: 'absolute', left: '22px', right: '22px', bottom: '22px', gap: '8px' }}>
        {g.ownOn ? <button type="button" className="btns" style={{ width: '110px', height: '54px', fontSize: '14.5px' }} disabled={g.sending || !g.lease} title={g.lease ? undefined : '멈춤 · 이어 가기는 조종권이 있어야 보냅니다'} data-rehearse-pause
            onClick={() => g.control(g.own!.status === 'PAUSED' ? 'resume' : 'pause')}>{g.own!.status === 'PAUSED' ? '이어 가기' : '멈춤'}</button>
          : <button type="button" className="btns" style={{ width: '110px', height: '54px', fontSize: '14.5px' }} disabled={!g.can} data-rehearse-start onClick={g.go}><Ic d={IC.play} />{g.sending ? '보내는 중…' : '시작'}</button>}
        <Done robot={sim} run={g.own} go={toResult} /></div>
    </div>
    <button type="button" className="u6-close lab u6-link" onClick={close} data-rehearse-close>‹ 임무 목록</button>
  </>;
}

function Battery({ robot }: { robot: Robot }) {
  const l = useLive(robot.id), b = l.state?.battery?.soc ?? robot.battery;
  return <div className="chk" data-chk="배터리"><span className={b == null ? 'mu2' : 'ok'}><Ic d={IC.battery} /></span><div>배터리</div><span className={`v ${b == null ? 'mu2' : 'ok'}`}>{b == null ? NO : `지금 ${Math.round(b)} %`}</span></div>;
}

/** 결과 바로 보기: 이 화면에서 본 실행이 끝났을 때(끝난 실행 id 로 보고서) */
function Done({ robot: r, run, go }: { robot?: Robot; run: RunSnapshot | null; go: (run: string, robot: string) => void }) {
  const ok = !!r && !!run && DONE.includes(run.status);
  return <button type="button" className="btns endr" style={{ flex: '1', height: '54px', fontSize: '14.5px' }} disabled={!ok} title={ok ? undefined : '실행이 끝나면 보고서를 봅니다'}
    onClick={() => run && r && go(run.run_id, r.id)} data-to-result>결과 바로 보기</button>;
}

/** 아래 진행 칸: 시뮬 로봇마다 지점 진행(state.run.progress) · 상태 · 이 화면에서 본 경과 */
function Progress({ sims, x, own }: { sims: Robot[]; x: Scenario; own: string }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);
  return <div className="pane" style={{ left: '24px', top: '844px', width: '1476px', bottom: '24px', padding: '18px 24px', border: '1.5px dashed rgba(159,182,255,.4)' }} aria-label="모의 실행 진행">
    <div className="row" style={{ gap: '16px', marginBottom: '10px' }}><span className="row num" style={{ gap: '8px', fontSize: '24px', fontWeight: '800', color: '#4c9bff' }}><Ic d={IC.clock} s={22} />{hm(now.toISOString())}</span>
      <span className="lab">지금 시각 · 지점 진행은 로봇이 보낸 실행 상태</span>
      <span className="row" style={{ marginLeft: 'auto', gap: '10px', fontSize: '13.5px', fontWeight: '600', color: '#c9cfd8' }}><Ic d={IC.cube} />물리 점검 · {NO}</span></div>
    <div style={{ position: 'relative' }}>{sims.slice(0, 3).map((r, k) => <Row key={r.id} r={r} name={x.name} now={now.getTime()} own={k === 0 ? own : ''} />)}</div>
    {!sims.length && <Why>시뮬 로봇이 없습니다.</Why>}
  </div>;
}
/** 이 화면이 보낸 실행(own)만 이 임무의 진행. 로봇이 다른 실행 중이면 그렇다고만 적는다 */
function Row({ r, name, now, own }: { r: Robot; name: string; now: number; own: string }) {
  const l = useLive(r.id), cur = l.state?.run, other = !!cur && cur.run_id !== own && !DONE.includes(cur.status), run = cur && cur.run_id === own ? cur : null, seen = useRef<{ id: string; at: number } | null>(null);
  if (run && seen.current?.id !== run.run_id) seen.current = { id: run.run_id, at: now };
  const f = run && run.progress.total ? run.progress.done / run.progress.total : 0, s = seen.current ? Math.round((now - seen.current.at) / 1000) : 0;
  return <div className="row" style={{ height: '30px', gap: '14px' }} data-progress={r.id}><span style={{ width: '64px', fontSize: '13.5px', fontWeight: '800' }}>{r.name}</span>
    <span style={{ position: 'relative', flex: '1', height: '20px', borderRadius: '6px', background: 'rgba(255,255,255,.04)' }}>
      <i style={{ position: 'absolute', left: 0, width: '100%', top: 0, bottom: 0, borderRadius: '6px', border: '1.5px dashed #4c9bff', background: 'rgba(159,182,255,.12)' }} />
      <i style={{ position: 'absolute', left: 0, width: `${f * 100}%`, top: 0, bottom: 0, borderRadius: '6px', background: 'rgba(159,182,255,.35)' }} /></span>
    <span className="lab" style={{ width: '300px' }} data-progress-text>{other ? `다른 실행 중 · 이 모의 실행 아님` : run ? `${RUN_STATUS[run.status]} · ${run.progress.done}/${run.progress.total} · 본 지 ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}${run.wait_reason === 'LINK_LOST' ? ' · 연결 끊김으로 멈춤' : ''}` : `실행 없음 · ${name}`}</span></div>;
}

type Got<T> = { ok: T } | { why: string } | null;
const fail = (e: unknown) => (e instanceof ApiFail ? e.message : '서버에 닿지 못했습니다. 잠시 뒤 다시 시도하세요.');

/** u6_7 모의 실행 보고서: 끝난 실행 기록 · 지점 도착 · 단계 결과 · 실패 까닭. 추천은 서버에 없음 */
export function Result({ x, route, run, robot, cancel, close, again, edit, fix, applyFix }: { x: Scenario; route: Route; run: string; robot?: Robot; cancel?: AbortSignal; close: () => void; again: () => void; edit: () => void;
  fix?: Fix | null; applyFix?: () => void }) {
  const [h, setH] = useState<Got<RunHistory>>(null), [evs, setEvs] = useState<Got<Ev[]>>(null), [n, setN] = useState(0), [page, setPage] = useState(0);
  useEffect(() => {
    let live = true; setH(null); setEvs(null);
    api.runHistory(run, cancel).then((r) => live && setH({ ok: r }), (e) => live && setH({ why: fail(e) }));
    api.events(new URLSearchParams({ run_id: run, limit: '100' }), cancel).then((r) => live && setEvs({ ok: r.items }), (e) => live && setEvs({ why: fail(e) }));
    return () => { live = false; };
  }, [run, n]);   // eslint-disable-line react-hooks/exhaustive-deps
  const r = h && 'ok' in h ? h.ok : null, list = evs && 'ok' in evs ? stops(evs.ok) : [];
  const failEv = evs && 'ok' in evs ? evs.ok.find((e) => e.code === 'RUN_FAILED' || e.code === 'RUN_CANCELED') : undefined;
  const failCode = failEv && typeof (failEv.data as Record<string, unknown>)?.fail_code === 'string' ? String((failEv.data as Record<string, unknown>).fail_code) : '';
  const pass = r?.status === 'COMPLETED', badN = list.filter((s) => s.results?.steps?.some((t) => t.status === 'FAILED')).length;
  const total = x.waypoints.length, arrived = list.filter((s) => s.arrived).length;
  const shown = list.slice(page * 5, page * 5 + 5);
  return <>
    <div className="band" data-band><Ic d={IC.play} />모의 실행 끝 · 시뮬<span style={band}>결과를 보고 다음 단계를 고르세요</span></div>
    <div className="map" style={{ left: '24px', top: '128px', width: '820px', bottom: '24px', border: '1.5px dashed rgba(159,182,255,.5)' }} aria-label="모의 실행 지도">
      <div className="stage" style={{ inset: 0 }}><RouteStage x={x} route={route} rehearse /></div>
      <div className="g dk pill" style={{ left: '16px', top: '16px' }}><Ic d={IC.pin} /><span data-result-tag>도착 {arrived} / {total}{badN ? ` · 실패 지점 ${badN}` : ''}</span></div>
    </div>
    <div className="pane" style={{ left: '868px', top: '128px', width: '560px', bottom: '24px', padding: '24px' }} aria-label="모의 실행 보고서">
      <div className="row" style={{ gap: '10px' }}><span className={pass ? 'ok' : 'bad'}><Ic d={IC.doc} s={20} /></span><span className="ttl">모의 실행 보고서</span>
        {r && <span data-verdict style={{ marginLeft: 'auto', height: '32px', padding: '0 12px', borderRadius: '10px', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13.5px', fontWeight: '800',
          ...(pass ? { color: '#00c389', background: 'rgba(0,195,137,.12)', border: '1px solid rgba(0,195,137,.45)' } : { color: '#ff4d4f', background: 'rgba(255,77,79,.12)', border: '1px solid rgba(255,77,79,.45)' }) }}>
          <Ic d={pass ? IC.check : IC.x} />{pass ? '통과' : RUN_STATUS[r.status] ?? r.status}</span>}</div>
      {!h && <Why>실행 기록을 받는 중…</Why>}
      {h && 'why' in h && <p className="lab u6-why" role="alert">실행 기록을 받지 못했습니다. {h.why} <button type="button" className="btns" onClick={() => setN((k) => k + 1)}>다시 시도</button></p>}
      {r && <>
        <div className="row" style={{ justifyContent: 'space-between', margin: '20px 0 6px' }}>
          <div><div className="lab">걸린 시간</div><b className="num" style={{ fontSize: '22px' }} data-took>{r.ended_at ? took(Date.parse(r.ended_at) - Date.parse(r.started_at)) : '끝나지 않음'}</b></div>
          <div><div className="lab">도착 지점</div><b className="num" style={{ fontSize: '22px' }}>{arrived}</b><small className="mu2"> / {total}</small></div>
          <div><div className="lab">실패 지점</div><b className="num" style={{ fontSize: '22px' }}>{badN}</b><small className="mu2"> 곳</small></div>
          <div><div className="lab">층</div><b style={{ fontSize: '16px' }}>{floorName(r.floor_name)}</b></div></div>
        {!pass && <div className="row" style={{ gap: '14px', padding: '14px 0', borderBottom: '1px solid var(--line)' }} data-fail><span className="bad"><Ic d={IC.warn} /></span>
          <div style={{ flex: '1' }}><div style={{ fontSize: '15px', fontWeight: '800' }}>{RUN_STATUS[r.status] ?? r.status}</div><div className="lab" style={{ marginTop: '3px' }}>{failCode ? RUN_FAIL[failCode] ?? failCode : '까닭 기록 없음'}</div></div>
          <span className="bad" style={{ fontSize: '14px', fontWeight: '800' }}>통과 못 함</span></div>}
        {shown.map((s) => { const bad = s.results?.steps?.some((t) => t.status === 'FAILED');
          return <div key={s.idx} className="row" style={{ gap: '14px', padding: '14px 0', borderBottom: '1px solid var(--line)' }} data-stop={s.idx + 1}>
            <span className={bad ? 'bad' : s.arrived ? 'ok' : 'wn'}><Ic d={bad ? IC.warn : s.arrived ? IC.check : IC.clock} /></span>
            <div style={{ flex: '1' }}><div style={{ fontSize: '15px', fontWeight: '800' }}>{s.idx + 1} · {s.name || '지점'}</div><div className="lab" style={{ marginTop: '3px' }}>{s.arrived ? `${hm(s.arrived)} 도착` : '도착 기록 없음'} · {result(s.results)}</div></div>
            <span className={bad ? 'bad' : 'ok'} style={{ fontSize: '14px', fontWeight: '800' }}>{bad ? '실패' : s.arrived ? '도착' : ''}</span></div>; })}
        {evs && 'ok' in evs && !list.length && <Why>이 실행에는 지점 기록이 없습니다.</Why>}
        {evs && 'why' in evs && <p className="lab u6-why" role="alert">지점 기록을 받지 못했습니다. {evs.why}</p>}
        <div style={{ marginTop: '10px' }}><Pager n={list.length} per={5} at={page} go={setPage} label="지점" /></div>
        <Why>겹침 · 충돌 · 중복 · 혼잡 · 물리 점검은 서버에 아직 값이 없어 보고서에 넣지 않습니다.</Why>
        <div className="lab row" style={{ gap: '6px', position: 'absolute', left: '24px', bottom: '24px' }}><Ic d={IC.doc} />보고서는 기록 탭에 남습니다 · {hm(r.started_at)} 모의 실행{robot ? ` · ${robot.name}` : ''}</div>
      </>}
    </div>
    <div className="pane" style={{ left: '1452px', top: '128px', right: '24px', bottom: '24px', padding: '24px' }} aria-label="추천">
      <div className="ttl" style={{ fontSize: '18px' }}>추천</div>
      <div className="lab" style={{ margin: '4px 0 16px' }}>통과 못 함 항목을 피하는 방법</div>
      <Why data-rec-why>추천(출발 늦추기 · 다른 길 · 다른 로봇)은 서버에 아직 값이 없습니다. 경로를 직접 고치거나 다시 모의 실행하세요.</Why>
      {fix && <Why data-fix-note>{pass ? `고장 로봇의 남은 일 ${fix.items.length} 건을 이 배정으로 바꿀 수 있습니다.` : '모의 실행이 통과해야 재배정을 일정에 넣습니다.'}</Why>}
      {fix?.msg && !fix.msg.ok && <Why alert>{fix.msg.text}</Why>}
      {fix && pass ? <button type="button" className="btnp again" style={{ position: 'absolute', left: '24px', right: '24px', bottom: '84px', height: '54px', fontSize: '15px' }} disabled={fix.busy} onClick={applyFix} data-fix-apply><Ic d={IC.check} />{fix.busy ? '바꾸는 중…' : '이 배정으로 일정 바꾸기'}</button>
        : <button type="button" className="btnp again" style={{ position: 'absolute', left: '24px', right: '24px', bottom: '84px', height: '54px', fontSize: '15px' }} onClick={again} data-again><Ic d={IC.play} />다시 모의 실행</button>}
      <button type="button" className="btns fix" style={{ position: 'absolute', left: '24px', right: '24px', bottom: '22px', height: '50px', fontSize: '14.5px' }} onClick={edit} data-fix-route><Ic d={IC.pin} />경로 직접 고치기</button>
    </div>
    <button type="button" className="u6-close lab u6-link" onClick={close}>‹ 임무 목록</button>
  </>;
}

