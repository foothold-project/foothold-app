/** 시안 u6_3 · u6_4 · u6_5 만들기: 머리줄(이름 · 지도 · 로봇 · 걷기 모드 · 시간 칩 · 목록 / 노드 / 지도 고르기)과 오른쪽 «이 임무» 칸은 시안 DOM.
 *  가운데 편집 칸은 지금 짜기 편집기(ScenarioEdit · 지점 · 순서 · 할 일 · 저장 · 검사)를 시안 칸 안에 둔다. 시안 DOM 으로 다시 짜는 일은 남은 일(차이 목록) */
import { useMemo, useState } from 'react';
import type { Estimate } from '../../../contracts/ts';
import type { Robot, User } from '../fake';
import { floorName, Note, type Msg, type Place } from './maps';
import { ScenarioEdit, type Look } from './missions';
import { Guess, hm, hourOf, mins, MODES, type Plan } from './missiontab';
import { IC, Ic, Why, dist } from './missionsu6';
import { useTheme } from '../theme';

const GAIT_NOTE: Record<string, string> = { classic: '평지 기본', sport: '빠른 걷기', start: '험지 기본', ame2: '준비 중' };

export function MissionPlan({ id, floor, robot, gait, user, robots, cancel, places, treeAgain, p, close, saved, rehearse }: { id: string; floor: string; robot: string; gait: string; user: User; robots: Robot[];
  cancel?: AbortSignal; places: Place[]; treeAgain: () => void; p: Plan; close: () => void; saved: (id: string) => void; rehearse: () => void }) {
  const [look, setLook] = useState<Look>('list'), [cur, setCur] = useState(id), [n, setN] = useState(0), [msg, setMsg] = useState<Msg>(null), [slot, setSlot] = useState<HTMLElement | null>(null);
  const [name, setName] = useState(''), light = useTheme()[1];
  const place = places.find((x) => x.floor.id === floor), r = robots.find((x) => x.id === robot) ?? robots.find((x) => x.id === p.rid);
  const g = gait || p.gait, gName = MODES.find(([, v]) => v === g)?.[0];
  const seg = (v: Look, label: string, cls: string, d: React.ReactNode) => <button type="button" className={`${look === v ? 'on ' : ''}${cls}`} aria-pressed={look === v} data-look={v} onClick={() => setLook(v)}><Ic d={d} />{label}</button>;
  return <section aria-label="임무 편집" data-plan>
    <div className="hdr"><span className="ttl" style={{ fontSize: '26px', marginRight: '6px' }} data-plan-name>{name || (cur ? '임무' : '새 임무')}</span><span className="lab" style={{ marginRight: '8px' }}>{cur ? '편집 중' : '작성 중'}</span>
      <span className="g dk chip"><Ic d={IC.map} />{place ? floorName(place.floor.name) : '층 고르지 않음'}<small>{place?.floor.approved_version_id ? '승인 판' : ''}</small></span>
      <span className="g dk chip"><Ic d={IC.robot} />{r ? r.name : '로봇 고르지 않음'}<small>{r ? (r.sim ? '시뮬' : '실제') : ''}</small></span>
      <span className="g dk chip"><Ic d={IC.mount} />{gName ?? '걷기 모드 없음'}<small>{g ? GAIT_NOTE[g] : ''}</small></span>
      <span className="g dk chip"><Ic d={IC.clock} />{p.start} ~ {p.end}<small /></span>
      <div className="seg2 wseg" style={{ marginLeft: 'auto' }} role="group" aria-label="목록 · 노드 · 지도 보기">
        {seg('list', '목록', 'w-list', IC.list)}{seg('node', '노드', 'w-node', IC.node)}{seg('map', '지도', 'w-pin', IC.pin)}</div>
    </div>
    <div className="pane u6-editor" style={{ left: '24px', top: '156px', width: '1500px', bottom: '24px', padding: '0' }} aria-label="편집 칸">
      <div className="u6-editbar"><button type="button" className="btns" data-back-list onClick={close}>‹ 임무 목록</button><span ref={setSlot} style={{ display: 'contents' }} /></div>
      <div className={`u6-editbody fh u6-fh${light ? ' light' : ''}`}>
        <ScenarioEdit id={cur} n={n} user={user} robots={robots} cancel={cancel} places={places} treeAgain={treeAgain} floor={floor} slot={slot} side={<b>임무</b>} close={close} look={look}
          top={msg && <Note m={msg} />} done={(x, m) => { setMsg(m); if (x) { setName(x.name); saved(x.id); if (x.id !== cur) { setCur(x.id); setN((k) => k + 1); } } }} />
      </div>
    </div>
    <This p={p} robots={robots} rehearse={rehearse} />
  </section>;
}

/** 오른쪽 «이 임무»: 길이 · 걷기 + 할 일 · 예상 끝 · 끝 배터리(일정 칸에서 고른 로봇 · 걷기 모드로 받은 예상) · 모의 실행 전 · 같은 시간대 다른 로봇(오늘 일정) */
function This({ p, robots, rehearse }: { p: Plan; robots: Robot[]; rehearse: () => void }) {
  const e: Estimate | null = p.est, [ln, lu] = e ? dist(e.length_m) : ['—', ''];
  const a = hourOf(new Date(new Date().toDateString() + ' ' + p.start).toISOString()), b = hourOf(new Date(new Date().toDateString() + ' ' + p.end).toISOString());
  const lo = a - 0.5, hi = b + 0.5, f = (h: number) => `${Math.max(0, Math.min(1, (h - lo) / (hi - lo))) * 100}%`;
  const others = useMemo(() => (p.slots ?? []).filter((s) => hourOf(s.end) > a && hourOf(s.start) < b).slice(0, 4), [p.slots, a, b]);
  const sims = robots.filter((r) => r.sim);
  return <div className="pane" style={{ left: '1548px', top: '156px', right: '24px', bottom: '24px', padding: '22px' }} aria-label="이 임무">
    <div className="lab">이 임무</div>
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: '16px', rowGap: '14px', marginTop: '14px' }}>
      <div><div className="lab">길이</div><b className="num" style={{ fontSize: '22px' }}>{ln}</b><small className="mu2"> {lu}</small></div>
      <div><div className="lab">걷기 + 할 일</div><b className="num" style={{ fontSize: '22px' }}>{e ? `${mins(e.walk_s)} + ${mins(e.task_s)}` : '—'}</b><small className="mu2"> 분</small>{e && <Guess e={e} />}</div>
      <div><div className="lab">예상 끝</div><b className="num" style={{ fontSize: '22px' }}>{e ? hm(e.eta) : '—'}</b></div>
      <div><div className="lab">종료 시 배터리</div><b className="num" style={{ fontSize: '22px' }}>{e?.end_battery_pct != null ? Math.round(e.end_battery_pct) : '—'}</b><small className="mu2"> %</small></div>
    </div>
    {!e && <Why>예상은 저장한 임무를 일정 칸에서 로봇 · 걷기 모드와 함께 고르면 나옵니다.</Why>}
    <div style={{ marginTop: '18px', padding: '14px', borderRadius: '14px', border: '1.5px dashed rgba(159,182,255,.5)', background: 'rgba(159,182,255,.06)' }}>
      <div className="row" style={{ gap: '8px', fontSize: '14px', fontWeight: '800', color: '#4c9bff' }}><Ic d={IC.play} />모의 실행 전</div>
      <div className="lab" style={{ marginTop: '6px', lineHeight: '1.5', fontSize: '13px' }}>시뮬 로봇에서 이 임무를 실제로 돌려 지점 도착 · 할 일 결과를 봅니다. 겹침 · 충돌 · 중복은 서버에 값이 없어 보지 않습니다.</div></div>
    <div className="lab" style={{ margin: '20px 0 8px' }}>같은 시간대 다른 로봇</div>
    {others.map((s) => <div key={s.id} className="row" style={{ gap: '10px', height: '34px', fontSize: '13.5px', fontWeight: '700' }} data-plan-other={s.id}>
      <span style={{ width: '64px' }}>{robots.find((r) => r.id === s.robot_id)?.name ?? '다른 로봇'}</span>
      <span style={{ position: 'relative', flex: '1', height: '22px', borderRadius: '6px', background: 'rgba(255,255,255,.04)' }}>
        <i style={{ position: 'absolute', left: f(a), width: `calc(${f(b)} - ${f(a)})`, top: '-3px', bottom: '-3px', border: '1.5px solid rgba(0,195,137,.6)', borderRadius: '6px' }} />
        <i className={`bk ${s.kind === 'DRAFT' ? 'k2' : 'kp'}`} style={{ left: f(hourOf(s.start)), width: `calc(${f(hourOf(s.end))} - ${f(hourOf(s.start))})`, top: 0, height: '22px', padding: 0 }} /></span>
      <span className="lab" style={{ width: '70px', textAlign: 'right' }}>{hm(s.start)}</span></div>)}
    {p.slots && !others.length && <Why>이 시간대({p.start} ~ {p.end})에 다른 일정이 없습니다.</Why>}
    <button type="button" className="btnp" style={{ position: 'absolute', left: '22px', right: '22px', bottom: '22px', height: '54px', fontSize: '15.5px' }} disabled={!sims.length}
      title={sims.length ? undefined : '모의 실행은 시뮬 로봇으로 돌립니다. 이 조직에 시뮬 로봇이 없습니다.'} onClick={rehearse} data-plan-rehearse><Ic d={IC.play} />모의 실행 돌리기</button>
  </div>;
}
