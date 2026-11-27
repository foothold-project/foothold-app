// 임무 탭(W2 · U6-01 · U6-03 · U6-05 · 시연 판 u6_1): 왼쪽 임무 목록 · 가운데 지도 경로 · 오른쪽 일정 칸 · 아래 오늘 일정.
// 임무 = 서버 «시나리오»(지점 + 지점마다 할 일 + 끝 동작). 목록·할 일·경로·금지 구역 겹침·미리 확인·로봇은 이미 있는 자료로 채운다.
// 일정 · 가용 · 예상은 서버 계약(#531: GET /schedule · /robots/availability · POST /estimates · /schedule/slots)을 그대로 쓴다. 표 값(TABLE_UNMEASURED)은 «추정».
// 걷기 모드는 예상 · 일정 본문에만 들어가고 로봇에 보내지 않는다(#525 전). 모의 실행(예행)은 다음 단계라 회색.
// 지금 실행(오른쪽 칸 위): 이 임무가 배정된 로봇마다 실행 · 일시정지 · 이어 가기 · 취소(missionrun.tsx · 05 §6.5 서버 길).
// 짜기(새 임무 · 편집)는 시뮬 탭과 같은 ScenarioEdit(목록 ↔ 노드)를 이 탭 안에서 연다. STOP 은 App 머리줄 그대로 · 이 화면은 키·조종을 잡지 않는다.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Assignment, Estimate, MapVersion, Mission, RobotAvailability, Scenario, ScenarioPreview, ScenarioWaypoint, ScenarioWrite, ScheduleSlot } from '../../../contracts/ts';
import { api, type ApiFail } from '../api';
import { robotStatus, type Robot } from '../fake';
import { pct, type Ctx } from '../screens';
import { MapFrame, MapImage } from '../mapframe';
import { Note, floorName, floorsOf, isVersion, shape, toPixel, useFit, useTree, type Msg, type Place } from './maps';
import { FINISH, ScenarioEdit, bodyOf, isPlan, keptPlan } from './missions';
import { crosses, inPolygon, loadNoGo, noGoAt } from './zoneroute';
import { RunCtl } from './missionrun';
import './missiontab.css';

/** 고른 임무 id · 옛 주소(#/mission/<id> · ?scenario_id=)면 App 이 넣고, 목록에서 고르면 탭이 넣는다(다른 탭에 갔다 와도 그대로) */
export const keptMission: { sel: string } = { sel: '' };
/** 걷기 모드 넷(화면 이름 → 계약 값). 예상 · 일정 본문에만 쓰고 로봇에는 보내지 않는다(#525 전) */
const MODES = [['Classic', 'classic'], ['Sport', 'sport'], ['START', 'start'], ['AME-2', 'ame2']] as const;
type Gait = (typeof MODES)[number][1];
const KIND: Record<ScheduleSlot['kind'], string> = { CONFIRMED: '확정', DRAFT: '작성 중', BATTERY_SWAP: '배터리 교체' };
const STATE: Record<RobotAvailability['state'], string> = { FREE: '비어 있음', BUSY: '다른 일정', CHARGING: '충전 중', OFFLINE: '연결 끊김' };
const two = (n: number) => String(n).padStart(2, '0');
/** 오늘(이 브라우저 시간대) YYYY-MM-DD · 시간대 이름 */
const today = () => { const d = new Date(); return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`; };
const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
/** 오늘 HH:MM → ISO */
const isoAt = (hm: string) => { const [h, m] = hm.split(':').map(Number), d = new Date(); d.setHours(h, m, 0, 0); return d.toISOString(); };
const hm = (iso: string) => { const d = new Date(iso); return `${two(d.getHours())}:${two(d.getMinutes())}`; };
/** 지금 HH:MM */
const nowHm = () => hm(new Date().toISOString());
/** 처음 시작 = 다음 30분 칸, 마감 = 30분 뒤(사용자가 바꾸는 입력의 처음 값). 오늘 안에 칸이 없으면 23:30~23:59(지난 시각 한 줄이 막는다) */
const firstTimes = () => { const n = new Date(), d = new Date(n); d.setSeconds(0, 0); d.setMinutes(Math.floor(n.getMinutes() / 30) * 30 + 30);
  if (d.getDate() !== n.getDate()) return ['23:30', '23:59'];
  const e = new Date(d.getTime() + 30 * 60_000); return [hm(d.toISOString()), e.getDate() !== d.getDate() ? '23:59' : hm(e.toISOString())]; };
const mins = (s: number) => Math.round(s / 60);
/** 오늘 일정 기본 눈금 08~20시. 그 밖 일정이 있으면 그 일정까지 넓힌다 */
const DAY_FROM = 8, DAY_TO = 20;
/** 오늘 0시부터 잰 시(0~24로 자름 · 어제 시작 · 내일 끝인 칸도 오늘 안에 그린다) */
const hourOf = (iso: string) => { const d = new Date(iso), m = new Date(); m.setHours(0, 0, 0, 0); return Math.min(24, Math.max(0, (d.getTime() - m.getTime()) / 3_600_000)); };

type P = [number, number];
const I = (d: ReactNode) => <svg className="mt-i" viewBox="0 0 24 24" aria-hidden="true">{d}</svg>;
const ICON = {
  plus: I(<path d="M12 5v14M5 12h14" />),
  flag: I(<><path d="M5 21V4" /><path d="M5 4h11l-2 4 2 4H5" /></>),
  play: I(<path d="M7 5l12 7-12 7z" />),
  clock: I(<><circle cx="12" cy="12" r="8" /><path d="M12 8v4l3 2" /></>),
  warn: I(<><path d="M12 4l9 16H3z" /><path d="M12 10v4M12 17v.5" /></>),
};

/** 임무 탭. user·robots·cancel 은 App 이 준 값(로봇 0대여도 열린다) */
export function MissionTab(c: Pick<Ctx, 'user' | 'robots' | 'cancel'>) {
  const tree = useTree(c.cancel), places = useMemo(() => floorsOf(tree.tree), [tree.tree]);
  const [all, setAll] = useState<Scenario[] | null>(null), [err, setErr] = useState(''), [n, setN] = useState(0);
  const [jobs, setJobs] = useState<Record<string, Mission>>({});
  const [sel, setSel0] = useState<string>(keptMission.sel), setSel = (id: string) => { keptMission.sel = id; setSel0(id); }, [extra, setExtra] = useState<Scenario | null>(null), [lost, setLost] = useState(false);
  const [edit, setEdit] = useState<string | null>(null), [en, setEn] = useState(0), [msg, setMsg] = useState<Msg>(null), [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    let live = true;
    setErr('');
    api.allPlans('scenarios', c.cancel).then((l) => { if (live) setAll((l as Scenario[]).filter((x) => isPlan(x) && !x.archived_at)); },
      (e: ApiFail) => { if (live && e.code !== 'CANCELED') setErr(e.message); });
    api.allPlans('missions', c.cancel).then((l) => { if (live) setJobs(Object.fromEntries((l as Mission[]).filter((x) => isPlan(x) && 'steps' in x).map((x) => [x.id, x]))); }, () => {});
    return () => { live = false; };
  }, [n]);
  // 목록에 없는 임무(휴지통 · 다른 사람 것)를 옛 주소가 골랐으면 그 하나를 따로 받는다
  useEffect(() => {
    if (!all || !sel || all.some((x) => x.id === sel) || extra?.id === sel) return;
    let live = true;
    api.plan('scenarios', sel, null, c.cancel).then((x) => { if (live) { if (isPlan(x)) setExtra(x as Scenario); else setLost(true); } },
      (e: ApiFail) => { if (live && e.code !== 'CANCELED') { setLost(true); setSel(''); } });
    return () => { live = false; };
  }, [all, sel]);
  const list = useMemo(() => (all ? [...(extra && !all.some((x) => x.id === extra.id) ? [extra] : []), ...all] : []), [all, extra]);
  const cur = list.find((x) => x.id === sel) ?? (sel ? undefined : list[0]);
  const floorOf = (x?: Scenario) => x?.floor_ids?.[0] ?? x?.waypoints[0]?.floor_id ?? '';
  const plan = usePlan(cur, c.cancel);

  if (edit != null) {
    const close = () => { setEdit(null); setN((x) => x + 1); };
    return <section className="mx mt-edit" aria-label="임무 편집">
      <div className="mx-bar"><button type="button" className="btn" data-back-list onClick={close}>‹ 임무 목록</button><span ref={setSlot} style={{ display: 'contents' }} /></div>
      <ScenarioEdit id={edit} n={en} user={c.user} robots={c.robots} cancel={c.cancel} places={places} treeAgain={tree.again} floor={edit ? floorOf(list.find((x) => x.id === edit)) : floorOf(cur)}
        slot={slot} side={<b>임무</b>} close={close} top={msg && <Note m={msg} />}
        done={(x, m) => { setMsg(m); setN((k) => k + 1); if (x && x.id !== edit) { setEdit(x.id); setSel(x.id); } }} />
    </section>;
  }
  const open = (id: string) => { setMsg(null); if (!id) setEn((x) => x + 1); setEdit(id); };
  return <section className="mt" aria-label="임무">
    <div className="mt-top">
      <aside className="mt-card mt-list" aria-label="임무 목록">
        <div className="mt-head"><h2>임무</h2><button type="button" className="btn pri mt-new" data-new-mission onClick={() => open('')}>{ICON.plus}새 임무</button></div>
        {msg && <Note m={msg} />}
        {lost && <p className="fh-msg" role="alert" data-lost>주소의 임무를 찾을 수 없습니다. 지워졌을 수 있습니다 · 목록에서 고르세요.</p>}
        <ul className="mt-rows">{list.map((x) => { const on = x.id === cur?.id;
          return <li key={x.id} className="mt-row" data-on={on || undefined}>
            <button type="button" className="mt-pick" aria-pressed={on} data-mission={x.id} onClick={() => { setSel(x.id); setMsg(null); }}>
              <b>{x.name}</b>
              {x.archived_at && <span className="lbl" data-trash>휴지통</span>}
              {keptPlan.drafts[`scenarios:${x.id}`] && <span className="lbl">저장 안 한 편집</span>}
              {/* 걸리는 시간 합계(고른 임무 · 예상 받은 뒤만). 걷기 + 할 일로 나눈 값은 지도 아래 */}
              <span className="mt-dur" data-dur>{on && plan.est ? `${mins(plan.est.walk_s + plan.est.task_s)}분` : '—'}</span>
            </button>
            {on && <Steps x={x} jobs={jobs} edit={() => open(x.id)} />}
          </li>; })}</ul>
        {all && !list.length && !err && <p className="lv-note">임무가 없습니다. «새 임무»로 지도에 지점을 찍고 지점마다 할 일을 고르세요.</p>}
        {!all && !err && <p className="lv-note" role="status">임무 목록을 불러오는 중…</p>}
        {err && <div className="fh-row"><p className="fh-msg" role="alert">임무 목록을 받지 못했습니다. {err}</p><button type="button" className="btn" onClick={() => setN((x) => x + 1)}>다시 시도</button></div>}
      </aside>
      <RouteMap x={cur} places={places} cancel={c.cancel} est={plan.est} />
      <Side x={cur} robots={c.robots} p={plan} run={<Runs x={cur} robots={c.robots} cancel={c.cancel} />} />
    </div>
    <Day robots={c.robots} p={plan} names={(id) => list.find((x) => x.id === id)?.name} />
  </section>;
}

/** 고른 임무의 할 일 번호 목록(지점 순서) + 끝 동작 + 편집 */
function Steps({ x, jobs, edit }: { x: Scenario; jobs: Record<string, Mission>; edit: () => void }) {
  const f = x.finish?.mode ?? 'STAY';
  return <div className="mt-steps">
    <ol aria-label={`${x.name} 할 일`}>{x.waypoints.map((w, i) => { const m = jobs[w.mission_id];
      return <li key={i} data-step-no={i + 1}><span className="mt-no">{i + 1}</span><span className="mt-job">{m ? m.name : '할 일'}</span>
        {w.name && <span className="lbl">{w.name}</span>}</li>; })}</ol>
    <p className="mt-end" data-finish-mode={f}>{ICON.flag}{FINISH[f]}</p>
    <div className="fh-row"><button type="button" className="btn" data-edit-mission onClick={edit}>{x.archived_at ? '열기' : '편집'}</button>
      <span className="lv-note">목록 · 노드로 고칩니다.</span></div>
  </div>;
}

/** 가운데 지도: 고른 임무의 첫 층 · 지금 승인 판 위에 경로 · 지점 번호 · 접근 금지 겹침, 아래 줄 = 길이 · 걷기 + 할 일 · 미리 확인 */
function RouteMap({ x, places, cancel, est }: { x?: Scenario; places: Place[]; cancel?: AbortSignal; est: Estimate | null }) {
  const floor = x?.floor_ids?.[0] ?? x?.waypoints[0]?.floor_id ?? '', place = places.find((p) => p.floor.id === floor), vid = place?.floor.approved_version_id ?? null;
  const [maps, setMaps] = useState<Record<string, MapVersion>>({}), [mapErr, setMapErr] = useState(''), [mn, setMn] = useState(0);
  useEffect(() => {
    if (!vid || maps[vid]) return;
    let live = true;
    setMapErr('');
    api.version(vid, cancel).then(shape(isVersion)).then((v) => { if (live) setMaps((o) => ({ ...o, [vid]: v })); }, (e: ApiFail) => { if (live && e.code !== 'CANCELED') setMapErr(e.message); });
    return () => { live = false; };
  }, [vid, mn]);
  const v = vid ? maps[vid] : undefined, look = useFit(v);
  // 접근 금지 칸(시나리오 편집 지도와 같은 판정 · 서버 구역 칸, 못 받으면 구역 모양으로 지점만)
  const hasNoGo = !!v?.features.zones.some((z) => z.type === 'NO_GO');
  const [zg, setZg] = useState<{ id: string; no: Uint8Array | null } | null>(null);
  useEffect(() => {
    if (!v || !hasNoGo || zg?.id === v.id) return;
    let live = true;
    loadNoGo(v, cancel).then((no) => { if (live) setZg({ id: v.id, no }); }, () => { if (live) setZg({ id: v.id, no: null }); });
    return () => { live = false; };
  }, [v?.id, hasNoGo]);
  const cells = v && zg?.id === v.id && zg.no ? { w: v.width, h: v.height, no: zg.no } : null;
  // 미리 확인(저장 없이 POST /scenarios/preview · 편집 칸 «✓ 모두 갈 수 있음» 과 같은 판정)
  const [pv, setPv] = useState<{ id: string; r: ScenarioPreview | null; err: string } | null>(null);
  useEffect(() => {
    if (!x || !x.waypoints.length) return;
    let live = true;
    api.preview(bodyOf(x) as ScenarioWrite, cancel).then((r) => { if (live) setPv({ id: `${x.id}:${x.version}`, r, err: '' }); },
      (e: ApiFail) => { if (live && e.code !== 'CANCELED') setPv({ id: `${x.id}:${x.version}`, r: null, err: e.message }); });
    return () => { live = false; };
  }, [x?.id, x?.version]);
  const pr = pv && x && pv.id === `${x.id}:${x.version}` ? pv : null;

  const on = v && x ? x.waypoints.map((w, i) => ({ w, i })).filter(({ w }) => w.floor_id === floor) : [];
  const px = (w: { x: number; y: number }): P => toPixel(v!, w.x, w.y);
  const inNoGo = (w: ScenarioWaypoint) => !!v && (cells ? noGoAt(cells, px(w)) : v.features.zones.some((z) => z.type === 'NO_GO' && inPolygon(z.polygon, w.x, w.y)));
  const segs = on.slice(1).flatMap((b, k) => { const a = on[k]; return b.i === a.i + 1 ? [{ a: px(a.w), b: px(b.w), hit: !!cells && crosses(cells, px(a.w), px(b.w)) }] : []; });
  const hits = segs.filter((s) => s.hit).length + on.filter(({ w }) => inNoGo(w)).length;
  const r = v ? Math.max(v.width, v.height) / 70 : 1;
  const more = x ? x.waypoints.length - on.length : 0;

  return <div className="mt-card mt-map" aria-label="임무 지도">
    {!x ? <div className="mt-empty"><p className="lv-note">임무를 고르면 지도에 경로가 보입니다.</p></div>
      : !vid ? <div className="mt-empty"><p className="lv-note">{floor ? '이 임무의 층에 승인된 지도가 없습니다.' : '이 임무에는 지점이 없습니다. «편집»에서 지도에 지점을 찍으세요.'}</p></div>
      : !v ? <div className="mt-empty">{mapErr ? <div className="fh-row"><p className="fh-msg" role="alert">지도를 받지 못했습니다. {mapErr}</p><button type="button" className="btn" onClick={() => setMn((k) => k + 1)}>다시 시도</button></div>
          : <p className="lv-note" role="status">지도를 불러오는 중…</p>}</div>
      : <MapFrame {...look} photo={v} at={{ right: 10, top: 10 }} role="img" aria-label={`${x.name} 경로 · ${floorName(place!.floor.name)}`} data-map data-mission-map style={{ display: 'block', width: '100%', height: '100%' }}>
          <MapImage id={v.id} width={v.width} height={v.height} tint="var(--muted)" />
          {v.features.zones.filter((z) => z.type === 'NO_GO').map((z, i) => <polygon key={i} data-nogo points={z.polygon.map(([a, b]) => toPixel(v, a, b).join(',')).join(' ')}
            style={{ fill: 'var(--bad)', fillOpacity: 0.18, stroke: 'var(--bad)', strokeWidth: 2 }} vectorEffect="non-scaling-stroke"><title>{`접근 금지 구역 ${z.name}`}</title></polygon>)}
          {segs.map((s, i) => <line key={i} data-seg={i} data-hit={s.hit || undefined} x1={s.a[0]} y1={s.a[1]} x2={s.b[0]} y2={s.b[1]}
            style={{ stroke: s.hit ? 'var(--bad)' : 'var(--accent)', strokeWidth: 4, strokeLinecap: 'round', strokeDasharray: s.hit ? '6 5' : undefined }} vectorEffect="non-scaling-stroke" />)}
          {on.map(({ w, i }) => { const [a, b] = px(w), bad = inNoGo(w);
            return <g key={i} data-pt={i + 1} data-hit={bad || undefined}><circle cx={a} cy={b} r={r} style={{ fill: 'var(--panel)', stroke: bad ? 'var(--bad)' : 'var(--accent)', strokeWidth: 3 }} vectorEffect="non-scaling-stroke" />
              <text x={a} y={b + r * 0.42} fontSize={r * 1.15} fontWeight={700} textAnchor="middle" style={{ fill: bad ? 'var(--bad)' : 'var(--text)', pointerEvents: 'none' }}>{i + 1}</text></g>; })}
        </MapFrame>}
    {/* 지도 위 글자는 둘까지(이름표 규칙): 층 이름 · 금지 구역 겹침 */}
    {x && v && <div className="mt-tags">
      <span className="mt-tag">{floorName(place!.floor.name)}{more > 0 ? ` · 다른 층 지점 ${more}` : ''}</span>
      {hits > 0 && <span className="mt-tag bad" data-overlap>{ICON.warn}접근 금지 구역과 겹침 {hits}곳</span>}</div>}
    {x && <dl className="mt-facts" aria-label="경로 요약">
      <div><dt>길이</dt><dd data-length>{x.est_distance_m > 0 ? <>{x.est_distance_m >= 1000 ? (x.est_distance_m / 1000).toFixed(2) : Math.round(x.est_distance_m)}<small>{x.est_distance_m >= 1000 ? 'km' : 'm'}</small></> : '—'}</dd></div>
      <div><dt>걷기 + 할 일</dt><dd data-walk-task>{est ? <>{mins(est.walk_s)} + {mins(est.task_s)}<small>분</small><Guess e={est} /></> : '—'}</dd></div>
      <div><dt>미리 확인</dt><dd data-check>{!x.waypoints.length ? '지점 없음'
        : !pr ? <span role="status">확인하는 중…</span>
        : pr.r ? <span className={pr.r.reachable ? 'mt-ok' : 'mt-bad'}>{pr.r.reachable ? '✓ 모두 갈 수 있음' : '⚠ 갈 수 없는 지점이 있음'}</span>
        : <span className="mt-bad" title={pr.err}>확인하지 못했습니다</span>}</dd></div>
    </dl>}
  </div>;
}

/** 표 값(아직 재지 않음)이면 값 옆 «추정» */
const Guess = ({ e }: { e: Estimate }) => (e.estimate_source === 'TABLE_UNMEASURED' ? <small className="mt-guess" data-guess title="재지 않은 표 값으로 낸 예상입니다">추정</small> : null);

/** 일정 칸 상태: 시작 · 마감(오늘) · 로봇 · 걷기 모드 → 가용 · 예상 · 일정 추가 · 오늘 일정(겹침 표시) */
function usePlan(x: Scenario | undefined, cancel?: AbortSignal) {
  // 지금 시각은 분마다 다시 잰다(폼을 열어 둔 채 시각이 지나도 «지난 시각»이 걸리게)
  const [nowM, setNowM] = useState(nowHm);
  useEffect(() => { const t = setInterval(() => setNowM(nowHm()), 60_000); return () => clearInterval(t); }, []);
  const [[start, end], setTimes] = useState(firstTimes), past = start < nowM, ok = start < end && !past;
  const [rid, setRid] = useState(''), [gait, setGait] = useState<Gait | ''>('');
  const [avail, setAvail] = useState<RobotAvailability[] | null>(null), [availErr, setAvailErr] = useState('');
  const [estAt, setEstAt] = useState<{ key: string; e: Estimate | null; err: string } | null>(null);
  const [slots, setSlots] = useState<ScheduleSlot[] | null>(null), [dayErr, setDayErr] = useState(''), [dn, setDn] = useState(0);
  const [clash, setClash] = useState<string[]>([]), [msg, setMsg] = useState<Msg>(null), [busy, setBusy] = useState(false);
  const [made, setMade] = useState<{ key: string; id: string } | null>(null);   // 방금 넣은 칸 · 넣은 뒤 예상은 이 칸을 빼고 다시 받는다(exclude_slot_id)
  useEffect(() => {
    if (!ok) return;
    let live = true;
    setAvailErr('');
    api.availability(isoAt(start), isoAt(end), cancel).then((r) => { if (!live) return; setAvail(r.items);
      const me = r.items.find((a) => a.robot_id === rid); if (rid && (!me || !(me.state === 'FREE' || me.state === 'CHARGING'))) setRid(''); },
      (e: ApiFail) => { if (live && e.code !== 'CANCELED') setAvailErr(e.message); });
    return () => { live = false; };
  }, [start, end, dn]);
  useEffect(() => {
    let live = true;
    setDayErr('');
    api.schedule(today(), zone(), cancel).then((r) => { if (live) setSlots(r.slots); }, (e: ApiFail) => { if (live && e.code !== 'CANCELED') setDayErr(e.message); });
    return () => { live = false; };
  }, [dn]);
  const base = x && rid && gait && ok ? `${x.id}:${x.number}:${rid}:${gait}:${start}:${end}` : '';
  const skip = made && made.key === base ? made.id : null, key = base && `${base}:${skip ?? ''}`;
  useEffect(() => {
    if (!key || !x || !gait) return;
    let live = true;
    api.estimate({ scenario_id: x.id, scenario_version: x.number, robot_id: rid, gait, start: isoAt(start), ...(skip && { exclude_slot_id: skip }) }, cancel)
      .then((e) => { if (live) setEstAt({ key, e, err: '' }); }, (e: ApiFail) => { if (live && e.code !== 'CANCELED') setEstAt({ key, e: null, err: e.message }); });
    return () => { live = false; };
  }, [key]);
  const est = estAt && estAt.key === key ? estAt.e : null, estErr = estAt && estAt.key === key ? estAt.err : '';
  // 예상 끝이 고른 마감보다 늦으면 넣지 않는다(일정 칸이 실제보다 짧아짐).
  const late = !!est && hourOf(est.eta) * 60 > Number(end.slice(0, 2)) * 60 + Number(end.slice(3));
  const add = () => {
    if (!x || !rid || !gait || !ok || late) return;
    setBusy(true); setMsg(null);
    const at = base;
    api.addSlot({ robot_id: rid, scenario_id: x.id, scenario_version: x.number, gait, start: isoAt(start), end: isoAt(end), kind: 'CONFIRMED' }, crypto.randomUUID(), cancel)
      .then((r) => { setBusy(false); setClash([]); setMade({ key: at, id: r.id }); setMsg({ text: `일정에 넣었습니다 (${start}~${end}).`, ok: true }); setDn((k) => k + 1); },
        (e: ApiFail) => { if (e.code === 'CANCELED') return; setBusy(false);
          if (e.code === 'SCHEDULE_CONFLICT') { const ids = Array.isArray(e.detail?.slot_ids) ? (e.detail!.slot_ids as unknown[]).filter((v): v is string => typeof v === 'string') : [];
            setClash(ids); setMsg({ text: '같은 로봇의 다른 일정과 겹칩니다. 오늘 일정에 표시한 막대를 피해 시각이나 로봇을 바꾸세요.' }); setDn((k) => k + 1); }
          else setMsg({ text: `일정에 넣지 못했습니다. ${e.message}` }); });
  };
  return { start, end, ok, past, nowM, late, setStart: (v: string) => setTimes([v, end]), setEnd: (v: string) => setTimes([start, v]), rid, setRid, gait, setGait,
    avail, availErr, est, estErr, slots, dayErr, clash, msg, busy, add, again: () => setDn((k) => k + 1) };
}
type Plan = ReturnType<typeof usePlan>;

/** 오른쪽 칸: 고른 임무 · 시작/마감 · 이 시간에 쓸 수 있는 로봇 · 걷기 모드 · 예상 끝 · 여유 · 끝 배터리 · 모의 실행(회색) · 일정에 추가 */
function Side({ x, robots, p, run }: { x?: Scenario; robots: Robot[]; p: Plan; run?: ReactNode }) {
  const state = (a: RobotAvailability) => {
    if (a.state === 'BUSY') return `${a.busy_label ?? STATE.BUSY}${a.busy_until ? ` · ${hm(a.busy_until)}까지` : ''}`;
    if (a.state !== 'OFFLINE') return STATE[a.state];
    const r = robots.find((y) => y.id === a.robot_id);   // 연결 전 / 끊김은 관제 칩과 같은 판정(robotStatus)
    return r && !r.online ? robotStatus(r).text : STATE.OFFLINE;
  };
  // 예상이 있어야 마감 넘음을 볼 수 있다 · 예상 전 · 오류면 넣지 않는다
  const can = !!x && !x.archived_at && !!p.rid && !!p.gait && p.ok && !!p.est && !p.late && !p.busy;
  const e = p.est;
  return <aside className="mt-card mt-side" aria-label="일정에 추가">
    {run}
    <p className="lbl">일정에 추가</p>
    <h2 data-side-name>{x ? x.name : '임무를 고르세요'}</h2>
    <div className="mt-pair">
      <label className="mt-box"><span className="lbl">시작</span><input className="mt-time" type="time" step={600} data-start value={p.start} onChange={(ev) => ev.target.value && p.setStart(ev.target.value)} /></label>
      <label className="mt-box"><span className="lbl">마감</span><input className="mt-time" type="time" step={600} data-end value={p.end} onChange={(ev) => ev.target.value && p.setEnd(ev.target.value)} /></label>
    </div>
    {p.past ? <p className="fh-msg" role="alert" data-past>지난 시각은 고를 수 없습니다. 지금({p.nowM}) 뒤로 시작을 고르세요.</p>
      : !p.ok && <p className="fh-msg" role="alert">마감은 시작보다 뒤여야 합니다.</p>}
    <h3>이 시간에 쓸 수 있는 로봇</h3>
    {p.avail && !!p.avail.length && <ul className="mt-robots" aria-label="로봇">{p.avail.map((a) => { const free = a.state === 'FREE' || a.state === 'CHARGING';
      return <li key={a.robot_id}><button type="button" aria-pressed={p.rid === a.robot_id} data-robot={a.robot_id} data-state={a.state} disabled={!free} onClick={() => p.setRid(p.rid === a.robot_id ? '' : a.robot_id)}>
        <i className="mt-dot" data-state={a.state} aria-hidden="true" /><b>{a.robot_name}</b>
        <span className="lbl">{a.sim ? '시뮬' : '실기'} · {state(a)}</span><span className="fh-grow" /><span className="mono">{pct(a.battery_pct == null ? null : Math.round(a.battery_pct))}</span></button></li>; })}</ul>}
    {p.avail && !p.avail.length && <p className="lv-note">이 조직에 보이는 로봇이 없습니다.</p>}
    {!p.avail && !p.availErr && p.ok && <p className="lv-note" role="status">로봇 일정을 불러오는 중…</p>}
    {p.availErr && <div className="fh-row"><p className="fh-msg" role="alert">로봇 일정을 받지 못했습니다. {p.availErr}</p><button type="button" className="btn" onClick={p.again}>다시 시도</button></div>}
    <h3>걷기 모드</h3>
    {/* AME-2 는 서버가 확정 일정을 거절한다(GAIT_NOT_READY) · 흐리게 «준비 중» */}
    <div className="mt-seg" role="group" aria-label="걷기 모드">{MODES.map(([t, g]) => g === 'ame2'
      ? <button key={g} type="button" disabled data-mode={t} title="AME-2 는 아직 일정에 넣을 수 없습니다">{t}<small className="mt-soon">준비 중</small></button>
      : <button key={g} type="button" aria-pressed={p.gait === g} data-mode={t} onClick={() => p.setGait(p.gait === g ? '' : g)}>{t}</button>)}</div>
    <p className="lv-note">예상과 일정에만 씁니다. 로봇에 보내지 않습니다.</p>
    <dl className="mt-est" aria-label="예상">
      <div><dt>예상 끝</dt><dd><b data-est="eta">{e ? hm(e.eta) : '—'}</b>{e && <Guess e={e} />}</dd></div>
      <div><dt>다음 일정까지 여유</dt><dd><b data-est="margin" className={e?.margin_s != null && e.margin_s < 0 ? 'mt-bad' : undefined}>{!e ? '—' : e.margin_s == null ? '다음 일정 없음' : e.margin_s < 0 ? '겹침' : `${mins(e.margin_s)}분`}</b>{e && e.margin_s != null && e.margin_s >= 0 && <Guess e={e} />}</dd></div>
      <div><dt>종료 시 배터리</dt><dd><b data-est="battery">{e && e.end_battery_pct != null ? `${Math.round(e.end_battery_pct)}%` : '—'}</b>{e && e.end_battery_pct != null && <Guess e={e} />}</dd></div>
    </dl>
    {p.late && e && <p className="fh-msg mt-bad" role="alert" data-late>마감 넘음 · 예상 끝 {hm(e.eta)}</p>}
    {!e && <p className="lv-note" data-est-why>{p.estErr ? `예상을 받지 못했습니다. ${p.estErr}` : x ? '로봇과 걷기 모드를 고르면 예상이 나옵니다.' : '임무를 고르세요.'}</p>}
    <div className="mt-acts">
      <button type="button" className="btn" disabled aria-describedby="mt-why-run" data-rehearse>{ICON.play}모의 실행</button>
      <button type="button" className="btn pri" disabled={!can} aria-describedby={can ? undefined : 'mt-why'} data-schedule-add onClick={p.add}>{p.busy ? '넣는 중…' : '일정에 추가'}</button>
    </div>
    {p.msg && <p className={`fh-msg${p.msg.ok ? ' ok' : ''}`} role={p.msg.ok ? 'status' : 'alert'} data-add-msg>{p.msg.text}</p>}
    {!can && !p.busy && <p id="mt-why" className="lv-note" data-add-why>{x && p.rid && p.gait && p.ok && !p.est
      ? '예상을 받은 뒤에 넣을 수 있습니다(마감 넘음을 확인해야 함).' : '임무 · 시각 · 로봇 · 걷기 모드를 고르면 일정에 넣을 수 있습니다.'}</p>}
    <p id="mt-why-run" className="lv-note">모의 실행은 다음 단계에서 붙습니다.</p>
  </aside>;
}

/** 지금 실행: 이 임무가 ACTIVE 로 배정된 내 로봇마다 실행 칸(05 §6.5 서버 길). 실행 칸이 그 로봇의 조종권을 쥐고 있다(탭을 떠나면 돌려줌) */
function Runs({ x, robots, cancel }: { x?: Scenario; robots: Robot[]; cancel?: AbortSignal }) {
  const [all, setAll] = useState<Assignment[] | null>(null), [err, setErr] = useState(''), [n, setN] = useState(0);
  useEffect(() => {
    let live = true; setErr('');
    api.assignments(null, cancel).then((l) => { if (live) setAll(l.filter((a) => a.status === 'ACTIVE')); }, (e: ApiFail) => { if (live && e.code !== 'CANCELED') setErr(e.message); });
    return () => { live = false; };
  }, [n]);
  if (!x) return null;
  const mine = all?.filter((a) => a.scenario_id === x.id && robots.some((r) => r.id === a.robot_id)) ?? [];
  return <section className="mt-run" aria-label="지금 실행" data-run-list>
    <p className="lbl">지금 실행</p>
    {mine.map((a) => <RunCtl key={a.id} robot={robots.find((r) => r.id === a.robot_id)!} scen={x} assign={a} watch />)}
    {all && !mine.length && <p className="lv-note">이 임무가 배정된 로봇이 없습니다. 배정을 요청해 결재를 받으면 여기서 실행합니다.</p>}
    {!all && !err && <p className="lv-note" role="status">배정을 불러오는 중…</p>}
    {err && <div className="fh-row"><p className="fh-msg" role="alert">배정을 받지 못했습니다. {err}</p><button type="button" className="btn" onClick={() => setN((k) => k + 1)}>다시 시도</button></div>}
  </section>;
}

/** 아래 오늘 일정(GET /schedule): 로봇별 줄 · 시각 눈금 · 지금 선 · kind 별 막대(확정 = 채움, 작성 중 = 테두리, 배터리 교체 = 회색) · 일정 추가가 겹친 막대 표시 */
function Day({ robots, p, names }: { robots: Robot[]; p: Plan; names: (id: string) => string | undefined }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 60_000); return () => clearInterval(t); }, []);
  const slots = p.slots ?? [];
  // 눈금 = 08~20, 그 밖 일정이 있으면 그 일정까지(«일정 N건» = 그린 막대 수)
  const lo = Math.floor(Math.min(DAY_FROM, ...slots.map((x) => hourOf(x.start)))), hi = Math.ceil(Math.max(DAY_TO, ...slots.map((x) => hourOf(x.end))));
  const HOURS = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i), span = hi - lo;
  const pos = (iso: string) => (hourOf(iso) - lo) / span, at = pos(now.toISOString());
  // 줄 = 받은 로봇 + 일정에만 있는 로봇(가용 목록의 이름)
  const rows = [...robots.map((r) => ({ id: r.id, name: r.name })), ...[...new Set(slots.map((x) => x.robot_id))].filter((id) => !robots.some((r) => r.id === id))
    .map((id) => ({ id, name: p.avail?.find((a) => a.robot_id === id)?.robot_name ?? '다른 로봇' }))];
  const bar = (x: ScheduleSlot) => { const a = pos(x.start), b = Math.max(a, pos(x.end));
    const label = x.kind === 'BATTERY_SWAP' ? KIND.BATTERY_SWAP : (x.scenario_id && names(x.scenario_id)) || '임무';
    return <span key={x.id} className="mt-bar" data-slot={x.id} data-kind={x.kind} data-conflict={p.clash.includes(x.id) || undefined}
      style={{ left: `${a * 100}%`, width: `${(b - a) * 100}%` }} title={`${label} · ${hm(x.start)}~${hm(x.end)} · ${KIND[x.kind]}`}>{label}</span>; };
  return <section className="mt-card mt-day" aria-label="오늘 일정">
    <div className="mt-head"><h2>오늘 일정</h2><span className="lbl">로봇 {rows.length}대 · <span data-day-count>일정 {slots.length}건</span></span><span className="fh-grow" />
      <span className="mt-legend" data-legend>{(Object.keys(KIND) as ScheduleSlot['kind'][]).map((k) => <span key={k}><i data-kind={k} aria-hidden="true" />{KIND[k]}</span>)}</span></div>
    <div className="mt-grid">
      <div className="mt-axis" aria-hidden="true"><span /><div className="mt-track">{HOURS.map((x, i) => <span key={x} style={{ left: `${(i / (HOURS.length - 1)) * 100}%` }}>{two(x)}</span>)}</div></div>
      {rows.map((r) => <div key={r.id} className="mt-line" data-day-robot={r.id}><b>{r.name}</b><div className="mt-track">{HOURS.map((x, i) => <i key={x} style={{ left: `${(i / (HOURS.length - 1)) * 100}%` }} />)}
        {slots.filter((x) => x.robot_id === r.id).map(bar)}</div></div>)}
      {at >= 0 && at <= 1 && <div className="mt-now-wrap" aria-hidden="true"><span /><div className="mt-track"><i className="mt-now" data-now style={{ left: `${at * 100}%` }} /></div></div>}
    </div>
    {!rows.length && <p className="lv-note">로봇이 없습니다.</p>}
    {!p.slots && !p.dayErr && <p className="lv-note" role="status">오늘 일정을 불러오는 중…</p>}
    {p.dayErr && <div className="fh-row"><p className="fh-msg" role="alert">오늘 일정을 받지 못했습니다. {p.dayErr}</p><button type="button" className="btn" onClick={p.again}>다시 시도</button></div>}
  </section>;
}
