// 로봇 탭 역할별 배치(ROBOT-TAB 11-02 — runs/robot-tab-review-1102/claude.md Q3 순서). 화면만: API 호출·인자·서버 권한·STOP 범위는 그대로.
// 운영 관리자 = 내 로봇 고르기 + 한 대 집중(상태 한 줄 → 영상·라이다 → 지도 위 현재 위치 → 상세: 임무·배터리·장치·최근 사건), 남의 로봇은 아래 접힌 «다른 로봇 N대»(요약 그대로).
// 총괄 = 요약 → 큰 지도(전 로봇 위치) + 경보(주의 먼저) → 표 목록 + 거르기 → 행을 누르면 서랍 상세(읽기 전용). STOP 은 머리줄 하나(화면 안에 새로 두지 않음)
// TAB-SPLIT(11-10): 로봇 탭 = 실기만(목록·고르기·거르기·요약·지도·경보). 시뮬 로봇은 «시뮬» 탭에서만 — 머리줄 STOP 후보(App)는 그대로 시뮬 포함
import { useEffect, useState, type ReactNode } from 'react';
import type { Dashboard, Location, MapVersion } from '../../../contracts/ts';
import { api, type ApiFail } from '../api';
import { adminReal, lost, ownerName, robotStatus, type Robot, type Tone } from '../fake';
import { rt, useRt } from '../rt';
import { holderText } from '../drive';
import { NO_SIGNAL } from '../drivemedia';
import { PhoneRelay } from '../phoneRelay';
import { ServerDrive, stopLine } from '../serverdrive';
import { MapFrame, MapImage } from '../mapframe';
import { Guard } from '../App';
import { Shapes, floorsOf, isVersion, shape, toPixel, useFit, useTree } from './maps';
import { FallChip } from '../go2status';
import { Chip, Detail, Kpi, LINK, Operators, Pair, Seen, attn, inApp, linkText, pct, type Ctx } from '../screens';

/** 화면이 아는 위치: 구독 로봇은 실시간 state, 아니면 목록 요약(남의 로봇은 서버가 감춤 — 그리지 않음) */
const where = (x: Robot): Location | null => (x.unknown === 'summary' ? null : rt.get(x.id).state?.location ?? x.location ?? null);
const TONE_COLOR: Record<Tone, string> = { ok: 'var(--accent)', warn: 'var(--warn)', bad: 'var(--bad)', off: 'var(--muted)' };

/** 마지막 보고 n초 전: 연결 중이면 마지막 state 를 받은 때(단조 시계), 끊김이면 마지막 확인 시각(오늘 HH:MM:SS). 모르면 null */
export function agoS(x: Robot, now = Date.now()) {
  const l = rt.get(x.id);
  if (x.unknown === 'summary' || x.unknown === 'wait' || !l.state) return null;
  if (!x.unknown && l.state.connection === 'ONLINE') return Math.max(0, Math.round((rt.now() - l.stateAt) / 1000));
  const m = /^(\d\d):(\d\d):(\d\d)$/.exec(x.seenAt);
  if (!m) return null;
  const d = new Date(now); d.setHours(+m[1], +m[2], +m[3], 0);
  const s = Math.round((now - d.getTime()) / 1000);
  return s < 0 ? s + 86400 : s;   // 자정을 넘긴 마지막 확인
}
const agoText = (s: number | null) => (s == null ? '없음' : s < 120 ? `${s}초 전` : `${Math.floor(s / 60)}분 전`);
function Ago({ x }: { x: Robot }) {
  const [, tick] = useState(0);
  useEffect(() => { const i = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(i); }, []);
  return <span className="mono" data-ago>{agoText(agoS(x))}</span>;
}
/** 상태 한 줄의 한 칸: 작은 라벨 위, 같은 크기 값 아래(값 크기 하나 — 11-11 fleet polish) */
const Fact = ({ k, children }: { k: string; children: ReactNode }) => <div className="fl-fact"><span className="lbl">{k}</span>{children}</div>;

/** 끊김(서버 실시간 끊김 또는 한 번 받은 로봇의 연결 끊김) — 상태 줄이 빨강으로 맨 앞, 나머지 값은 회색(마지막 값) */
const isLost = (x: Robot) => x.unknown === 'link' || lost(x);

/** 상태 한 줄: 서버·로봇 연결 · 조종 · 정지 잠금 · 마지막 보고 (· 폰 경유가 있을 때만 폰 경유) */
function StateLine({ c, r }: { c: Ctx; r: Robot }) {
  const l = rt.get(r.id), s = r.unknown ? null : l.state, hidden = r.unknown === 'summary', bad = isLost(r);
  const server = LINK[rt.link().at] ?? { tone: 'off' as const, text: '연결 중' };
  // 한 번도 상태를 받지 못한 로봇(r.status 없음)의 OFFLINE 은 «연결 전» — 제목·상세(robotStatus·linkText)와 같은 판정(끊김 경보 아님)
  const robot = hidden ? { tone: 'off' as const, text: '확인 안 됨' } : !s ? { tone: 'off' as const, text: r.unknown === 'link' ? '모름(서버 끊김)' : '모름' }
    : s.connection === 'ONLINE' ? { tone: 'ok' as const, text: '연결' } : r.status ? { tone: 'bad' as const, text: '끊김' } : { tone: 'off' as const, text: '연결 전' };
  const stop = stopLine(l) ?? (hidden ? { tone: 'off' as const, text: '확인 안 됨' } : s?.latched == null ? { tone: 'off' as const, text: '모름' }
    : s.latched ? { tone: 'bad' as const, text: '잠김' } : { tone: 'ok' as const, text: '풀림' });
  const st = robotStatus(r);
  return <section className={`lv-card fl-state${bad ? ' bad' : ''}`} aria-label="로봇 상태" data-lost={bad || undefined}>
    <div className="fh-row"><h2>{r.name}</h2><span className="lbl">{r.sim ? '시뮬' : '실기'}</span>{st.text !== robot.text && <Chip {...st} />}
      {r.owner !== c.user.id && <span className="lbl" data-not-mine>{ownerName(r)} · 보는 중(요약만)</span>}</div>
    {bad && <p className="fh-msg" role="alert" data-lost-note>▲ {r.unknown === 'link' ? '서버 연결이 끊겼습니다' : '로봇 연결이 끊겼습니다'} — 아래 값은 마지막으로 받은 값이고 지금 상태는 알 수 없습니다.
      {r.mission ? ' 임무 «이어서»는 실행을 건 같은 화면에서만 할 수 있습니다.' : ''}</p>}
    <div className="fl-facts" data-state-line>
      <Fact k="서버"><Chip {...server} /></Fact><Fact k="로봇"><Chip {...robot} /></Fact>
      <Fact k="조종"><span data-holder>{holderText(l, c.user.id, r)}</span></Fact>
      <Fact k="정지 잠금"><span data-stop-state><Chip {...stop} /></span></Fact>
      <Fact k="마지막 보고"><Ago x={r} /></Fact>
      {!hidden && r.phoneRelay && <Fact k="폰 경유"><PhoneRelay key={r.id} report={r.phoneRelay} receivedAt={r.phoneRelayAt} compact /></Fact>}
    </div>
  </section>;
}

/** 영상·라이다 칸. 실기 시험 조종이 켜진 담당 실기만 서버 경유 패널(기존 serverdrive.tsx — 카메라·라이다는 «조종 화면 열기»), 그 밖은 받는 영상이 없으니
 *  빈 검은 칸 대신 «신호 없음 + 까닭» 한 줄(가짜 그림 0 — 지도에 자리를 준다, 11-11 fleet polish) */
function Media({ c, r }: { c: Ctx; r: Robot }) {
  // 서버가 담당·연결·전체 스위치를 확인한 목록 값을 따른다.
  const drive = !!r.serverDrive && !c.phone && !inApp() && !adminReal(c.user, r) && r.owner === c.user.id;
  const why = r.unknown === 'summary' ? '남의 로봇이라 받지 않습니다' : isLost(r) ? '연결이 끊겼습니다' : !r.online ? '로봇이 아직 연결되지 않았습니다'
    : r.serverDrive && !inApp() ? '로봇 연결과 서버 설정을 확인하세요' : '이 화면은 실기 영상을 아직 받지 않습니다';
  return drive ? <section className="lv-card fl-media" aria-label="영상·라이다"><h2>영상·라이다</h2><ServerDrive c={c} r={r} /></section>
    : <section className="lv-card fl-media" aria-label="영상·라이다"><h2>영상·라이다</h2>
      <p className="lv-note" data-no-signal="rgb lidar">{NO_SIGNAL.rgb} · {NO_SIGNAL.lidar} — {why}</p></section>;
}

/** 관제 지도(기존 지도 칸과 같은 GET /sites · /map-versions/{id}) + 로봇 위치 점. 판이 같은 위치만 그린다(지어내지 않음), 끊긴 로봇은 회색 점.
 *  prefer = 처음 보일 층(집중 로봇이 있는 층) */
function FleetMap({ robots, sel, cancel }: { robots: Robot[]; sel?: string; cancel?: AbortSignal }) {
  useRt();
  const t = useTree(cancel), places = floorsOf(t.tree), [pick, setPick] = useState('');
  const prefer = robots.map(where).find((l) => l?.floor_id)?.floor_id;
  const cur = places.find((p) => p.floor.id === pick) ?? places.find((p) => p.floor.id === prefer && p.floor.approved_version_id) ?? places.find((p) => p.floor.approved_version_id) ?? places[0];
  const many = new Set(places.map((p) => p.building.id)).size > 1;
  return <>
    {/* 층 3개까지는 단추 한 줄, 넘으면 고르기 칸 하나(단추가 지도보다 먼저 읽히지 않게 — 11-11 fleet polish) */}
    {places.length > 3 ? <label className="fh-row lbl">층<select className="fh-user fh-sel" aria-label="층" data-floor-pick value={cur?.floor.id} onChange={(e) => setPick(e.target.value)}>
      {places.map((p) => <option key={p.floor.id} value={p.floor.id}>{`${p.site.name} · ${p.building.name} ${p.floor.name}`}</option>)}</select></label>
      : places.length > 1 && <div className="fh-row" role="group" aria-label="층">{places.map((p) => <button key={p.floor.id} type="button" className="btn" aria-pressed={p === cur} onClick={() => setPick(p.floor.id)}>
      {many ? `${p.building.name} ${p.floor.name}` : p.floor.name}</button>)}</div>}
    {cur?.floor.approved_version_id ? <Marked key={cur.floor.approved_version_id} id={cur.floor.approved_version_id} robots={robots} sel={sel} cancel={cancel} />
      : cur ? <p className="lv-note">아직 지도가 없습니다.</p>
      : t.tree && <p className="lv-note">등록된 층이 없습니다. 지도 탭에서 장소·층을 만들면 여기에 보입니다.</p>}
    {t.err && <div className="fh-row"><p className="fh-msg" role="alert">층 목록을 받지 못했습니다. {t.err}</p><button type="button" className="btn" onClick={t.again}>다시 시도</button></div>}
    {!t.tree && !t.err && <p className="lv-note" role="status">층 목록을 불러오는 중…</p>}
  </>;
}

function Marked({ id, robots, sel, cancel }: { id: string; robots: Robot[]; sel?: string; cancel?: AbortSignal }) {
  const [v, setV] = useState<MapVersion | null>(null), [err, setErr] = useState(''), [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    api.version(id, cancel).then(shape(isVersion)).then((x) => { if (alive) { setV(x); setErr(''); } }, (e: ApiFail) => { if (alive && e.code !== 'CANCELED') setErr(e.message); });
    return () => { alive = false; };
  }, [n]);
  const fit = useFit(v ?? undefined);
  if (!v) return err ? <div className="fh-row"><p className="fh-msg" role="alert">지도를 받지 못했습니다. {err}</p><button type="button" className="btn" onClick={() => setN(n + 1)}>다시 시도</button></div>
    : <p className="lv-note" role="status">지도를 불러오는 중…</p>;
  const on = robots.flatMap((x) => { const l = where(x); return l && l.map_version_id === v.id && l.x != null && l.y != null ? [{ x, l: l as Location & { x: number; y: number } }] : []; });
  const off = robots.length - on.length, r = Math.max(v.width, v.height) / 70;
  return <div>
    <MapFrame {...fit} photo={v} role="img" aria-label={`판 ${v.number} 지도 — 로봇 ${on.length}대 표시`} data-map style={{ display: 'block', width: '100%', maxHeight: '60vh', borderRadius: 8 }}>
      <MapImage id={v.id} width={v.width} height={v.height} />
      <Shapes v={v} f={v.features} />
      {on.map(({ x, l }) => {
        const [px, py] = toPixel(v, l.x, l.y), stale = !x.online, c = stale ? TONE_COLOR.off : TONE_COLOR[robotStatus(x).tone];
        const yaw = l.yaw ?? null, [hx, hy] = yaw == null ? [px, py] : toPixel(v, l.x + Math.cos(yaw) * r * 2.2 * v.resolution, l.y + Math.sin(yaw) * r * 2.2 * v.resolution);
        return <g key={x.id} data-robot-dot={x.id} data-stale={stale || undefined}>
          {yaw != null && <line x1={px} y1={py} x2={hx} y2={hy} style={{ stroke: c }} strokeWidth={r * 0.6} strokeLinecap="round" />}
          <circle cx={px} cy={py} r={r} style={{ fill: c, stroke: x.id === sel ? 'var(--text)' : 'var(--bg)' }} strokeWidth={r * (x.id === sel ? 0.5 : 0.3)} />
          <text x={px} y={py - r * 1.6} fontSize={r * 2.2} textAnchor="middle" style={{ fill: 'var(--text)', stroke: 'var(--bg)', strokeWidth: r * 0.5, paintOrder: 'stroke' }}>{x.name}{stale ? ' (마지막)' : ''}</text>
        </g>;
      })}
    </MapFrame>
    {off > 0 && <p className="lv-note" data-map-off>{robots.length === 1 ? '이 판 위 현재 위치 없음 — 위치를 아직 받지 못했거나 다른 층·판에 있습니다.' : `이 판에 없는 로봇 ${off}대(위치 없음·다른 층).`}</p>}
  </div>;
}

/** 목록 요약 행(지금 PC 목록과 같은 칸) — 운영 관리자의 «다른 로봇» 접기 안 */
function SummaryRow({ c, x }: { c: Ctx; x: Robot }) {
  const a = attn(x);
  return <li><button type="button" aria-pressed={x.id === c.robot.id} onClick={() => c.pick(x.id)}>
    <Chip {...robotStatus(x)} /><b>{x.name}</b><FallChip x={x} /><span className="mono">{pct(x.battery)}</span><span className="fh-grow">{x.mission ?? ''}</span>
    <span className="lbl">{ownerName(x)} · 보는 중</span>
    <span className="lbl" data-link-text>{linkText(x)}</span>
    {a && <span className="lbl" data-attention>▲ {a}</span>}
    <Seen x={x} />
    <PhoneRelay report={x.phoneRelay} receivedAt={x.phoneRelayAt} compact />
  </button></li>;
}

/** 실기 보기(옛 시뮬 탭 «Go2 실기 보기» — 같은 주소·같은 조건: 폰 앱 밖·실기만). 상세 칸 아래 */
function RealView({ r }: { r: Robot }) {
  if (inApp() || r.sim) return null;   // 로봇 탭은 이미 실기만 — 서버 목록은 simulation 을 늘 보낸다
  return <section className="lv-card" aria-label="실기 보기" data-go2-replay>
    <div className="fh-row"><h2>실기 보기</h2><span className="fh-grow" />
      <a className="btn" data-go2-open href={`/sim/index.html?from=web&policy=go2-demo&robot=${encodeURIComponent(r.id)}`}>실기 보기 열기</a></div>
    <p className="lv-note">실기 보기 전용 · 위치 원점: 기동 시점 기준·미확인</p>
  </section>;
}
/** 상세 + 실기 보기 한 칸(격자 자리 detail — 총괄 서랍은 이 칸째 붙어 내린다) */
const Side = ({ r, children }: { r: Robot; children: ReactNode }) => <div className="fl-detail fl-side">{children}<RealView r={r} /></div>;

/** 로봇 탭은 실기만: 목록에서 시뮬(끝낸 슬롯 포함)을 빼고, App 에서 고른 로봇(머리줄 STOP 대상)이 시뮬이면 첫 실기로 바꾼다(운영 관리자 — 화면의 로봇 = STOP 대상). 실기 0대면 null.
 *  총괄이 고른 시뮬은 그대로 둔다: 총괄 머리줄 STOP·Space 는 내 시뮬뿐(실기 STOP 없음 — App)이라 실기로 바꾸면 이 탭에서 멈출 길이 사라진다(REVIEW-315 1). 서랍은 행을 눌러야 열리고 그때 실기를 고른다 */
function useReal(c: Ctx): Ctx | null {
  const robots = c.robots.filter((x) => !x.sim), keep = c.user.role === 'ORG_ADMIN' && !!c.robot.sim;
  const robot = keep ? c.robot : robots.find((x) => x.id === c.robot.id) ?? robots[0];
  useEffect(() => { if (robot && robot.id !== c.robot.id) c.pick(robot.id); }, [robot?.id, c.robot.id]);
  return robots.length ? { ...c, robot, robots } : null;
}
const NoReal = () => <section className="lv-card" style={{ flexBasis: '100%' }} aria-label="실기 로봇 없음" data-no-real><h2>실기 로봇이 없습니다</h2>
  <p className="lv-note">로봇 탭에는 실기 로봇만 보입니다. 시뮬 로봇은 «시뮬» 탭에서 보고 조종합니다.</p>
  <div className="fh-row"><a className="btn" href="#/sim">시뮬 탭 열기</a></div></section>;

export function OperatorRobot(c0: Ctx) {
  const c = useReal(c0);
  return c ? <Operator {...c} /> : <Pair user={c0.user} mine={[]} refresh={c0.refresh} cancel={c0.cancel}><NoReal /></Pair>;
}
export function AdminFleet(c0: Ctx) {
  const c = useReal(c0);
  const d = realDash(c0.dash.d, c0.robots);
  return c ? <Admin {...c} d={d} /> : <><Kpi user={c0.user} d={d} err={c0.dash.err} /><NoReal /><Operators user={c0.user} d={d} /></>;
}

/** 서버 요약(/dashboard)은 시뮬(끝낸 슬롯 포함)까지 센다 — 로봇 탭 요약·운영 관리자 표는 서버 값에서 받은 목록의 시뮬 몫만 뺀다(시뮬이 없으면 서버 값 그대로, 결재 대기는 늘 그대로).
 *  all = 끝낸 시뮬 슬롯(IDLE)까지 든 목록(App 이 로봇 탭에 슬롯 포함 목록을 넘긴다 — 로봇 0대 EmptyFleet 도 같음) */
export function realDash(d: Dashboard | null, all: Robot[]): Dashboard | null {
  const sims = all.filter((x) => x.sim), n = (f: (x: Robot) => boolean) => sims.filter(f).length, less = (v: number, k: number) => Math.max(0, v - k);
  return d && sims.length ? { ...d, robots_total: less(d.robots_total, sims.length), robots_online: less(d.robots_online, n((x) => x.online)),
    robots_running: less(d.robots_running, n((x) => x.online && !!x.mission && x.status !== 'PAUSED')), robots_attention: less(d.robots_attention, n((x) => !!x.attention?.length)),
    operators: d.operators.map((o) => ({ ...o, robot_count: less(o.robot_count, n((x) => x.owner === o.user_id)) })) } : d;
}

/** 운영 관리자(PC): 고르기(실기 2대 이상만) → 상태 한 줄 → 영상·라이다 · 지도 | 상세(임무·배터리·장치·최근 사건·관리)+실기 보기 → 다른 로봇 */
function Operator(c: Ctx) {
  useRt();
  const me = c.user.id, mine = c.robots.filter((x) => x.owner === me), others = c.robots.filter((x) => x.owner !== me), r = c.robot, own = r.owner === me;
  const bad = isLost(r);
  return <Pair user={c.user} mine={mine.map((x) => x.id)} refresh={c.refresh} cancel={c.cancel}>
    <div className="fh-focus" data-lost={bad || undefined} data-summary={!own || undefined}>
      {(mine.length > 1 || (!own && mine.length > 0)) && <section className="lv-card fl-pick" aria-label="내 로봇 고르기"><h2>내 실기 로봇 {mine.length}대</h2>
        <div className="fh-row" role="group" aria-label="실기">{mine.map((x) => <button key={x.id} type="button" className="btn" aria-pressed={x.id === r.id} onClick={() => c.pick(x.id)}><Chip {...robotStatus(x)} /><b>{x.name}</b><FallChip x={x} /></button>)}</div></section>}
      {!mine.length && <section className="lv-card fl-pick" aria-label="로봇 없음"><h2>담당 로봇이 없습니다</h2>
        <p className="lv-note">«+ 새 로봇 추가»에서 연결 코드로 실기를 등록하거나, 총괄에게 담당 지정을 요청하세요. 시뮬 로봇은 «시뮬» 탭에서 띄웁니다.</p>
        <div className="fh-row"><a className="btn" href="#/sim">시뮬 탭 열기</a></div></section>}
      <StateLine c={c} r={r} />
      {/* 남의 로봇은 서버가 실시간 값을 감춘다 — 영상·지도 칸 없이 요약 상세만 */}
      {own && <Media key={r.id} c={c} r={r} />}
      {own && <section className="lv-card fl-map" aria-label="지도"><h2>지도</h2><Guard><FleetMap robots={[r]} sel={r.id} cancel={c.cancel} /></Guard></section>}
      <Side r={r}><Detail key={`${r.id}-${r.owner}`} {...c} solo /></Side>
      {others.length > 0 && <details className="lv-card fh-fold fl-others" aria-label="다른 로봇" open={!own || undefined}>
        <summary>다른 로봇 {others.length}대 — 남의 로봇은 요약만</summary>
        <ul className="fh-list robots">{others.map((x) => <SummaryRow key={x.id} c={c} x={x} />)}</ul></details>}
    </div>
  </Pair>;
}

type Filter = { owner: string; state: '' | 'attn' | 'online' | 'off' };
const RANK: Record<Tone, number> = { bad: 0, warn: 1, ok: 2, off: 3 };
const needs = (x: Robot) => { const t = robotStatus(x).tone; return t === 'bad' || t === 'warn' || !!x.attention?.length; };

/** 총괄(PC): 요약 → 큰 지도 + 경보 → 표 목록(+거르기) → 서랍 상세(읽기 전용 — 실기 조종·STOP 없음, 담당 없는 실기에 담당 지정만 지금처럼). 운영 관리자 표 유지.
 *  서랍을 닫아도 고른 행은 그대로 — 표시만 접는다(총괄은 실기 STOP 이 없어 이 탭의 머리줄 STOP 은 떠 있는 내 시뮬만 — App) */
function Admin({ d, ...c }: Ctx & { d: Dashboard | null }) {
  useRt();
  const r = c.robot, { err } = c.dash, [drawer, setDrawer] = useState(false), [f, setF] = useState<Filter>({ owner: '', state: '' });
  const open = (id: string) => { c.pick(id); setDrawer(true); };
  const owners = [...new Map(c.robots.map((x) => [x.owner, ownerName(x)])).entries()];
  const rows = c.robots.filter((x) => (!f.owner || x.owner === (f.owner === '-' ? '' : f.owner))
    && (!f.state || (f.state === 'attn' ? needs(x) : f.state === 'online' ? x.online : !x.online)));
  const alerts = c.robots.filter(needs).sort((a, b) => RANK[robotStatus(a).tone] - RANK[robotStatus(b).tone]);
  const sel = (k: keyof Filter, label: string, opts: [string, string][]) => <label className="fh-row lbl">{label}
    <select className="fh-user fh-sel" value={f[k]} data-filter={k} onChange={(e) => setF({ ...f, [k]: e.target.value })}>{opts.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></label>;
  return <>
    <Kpi user={c.user} d={d} err={err} />
    <div className={`fh-fleet admin${drawer ? ' open' : ''}`}>
      <section className="lv-card fl-map" aria-label="지도"><h2>지도 — 전 로봇 위치</h2><Guard><FleetMap robots={c.robots} sel={drawer ? r.id : undefined} cancel={c.cancel} /></Guard></section>
      <section className="lv-card fl-alerts" aria-label="경보"><h2>경보{alerts.length ? ` ${alerts.length}` : ''}</h2>
        {!alerts.length ? <p className="lv-note">주의가 필요한 로봇이 없습니다.</p>
          : <ul className="fh-list">{alerts.map((x) => <li key={x.id}><button type="button" aria-pressed={drawer && x.id === r.id} onClick={() => open(x.id)}>
            <Chip {...robotStatus(x)} /><b>{x.name}</b><span className="lbl fh-wide">{attn(x) || robotStatus(x).text} · {ownerName(x)}</span></button></li>)}</ul>}
      </section>
      <section className="lv-card fl-list" aria-label="로봇 목록">
        <div className="fh-row"><h2>로봇 {rows.length === c.robots.length ? c.robots.length : `${rows.length}/${c.robots.length}`}대</h2><span className="fh-grow" />
          {sel('owner', '담당', [['', '전체'], ...owners.map(([id, name]): [string, string] => [id || '-', name])])}
          {sel('state', '상태', [['', '전체'], ['attn', '주의 필요'], ['online', '연결됨'], ['off', '끊김·연결 전']])}</div>
        <div className="fl-row fl-head" aria-hidden="true"><span>로봇</span><span>담당</span><span>연결</span><span>배터리</span><span>임무</span><span>마지막 보고</span></div>
        {!rows.length && <p className="lv-note">거른 조건에 맞는 로봇이 없습니다.</p>}
        <ul className="fh-list robots fl-table">{rows.map((x) => { const a = attn(x); return <li key={x.id}>
          <button type="button" className="fl-row" aria-pressed={x.id === r.id} onClick={() => open(x.id)}>
            <span><Chip {...robotStatus(x)} /><b>{x.name}</b><FallChip x={x} /></span>
            <span className="lbl">{ownerName(x)}</span>
            <span><span className="lbl" data-link-text>{linkText(x)}</span></span>
            <span className="mono">{pct(x.battery)}</span>
            <span>{x.mission ?? '—'}{a && <span className="lbl" data-attention> ▲ {a}</span>}</span>
            <span><Seen x={x} /><PhoneRelay report={x.phoneRelay} receivedAt={x.phoneRelayAt} compact /></span>
          </button></li>; })}</ul>
      </section>
      {/* 담당이 바뀌면 상세를 새로 받는다 — 옛 요청의 늦은 답은 내린 화면에 떨어져 버려진다 */}
      {drawer && <Side r={r}><Detail key={`${r.id}-${r.owner}`} {...c} close={() => setDrawer(false)} /></Side>}
    </div>
    <Operators user={c.user} d={d} />
  </>;
}
