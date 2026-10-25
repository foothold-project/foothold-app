// 탭 본문 — 03 UX §5 배치 뼈대 수준. 관제 요약·로봇 목록·상세는 서버 값(설정 탭은 screens/settings.tsx, 기록 탭은 screens/history.tsx, 지도 탭·관제 지도 칸은 screens/maps.tsx, 결재 탭은 screens/approvals.tsx, 임무 탭은 screens/missions.tsx), 폰 시나리오 카드는 서버 배정(screens/assign.tsx). 빈 칸(.fh-slot)은 다음 작업 자리.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { driveBlock, ownerName, robotStatus, toRobot, type Robot, type Tone, type User } from './fake';
import type { Dashboard, Device, RobotSummary, User as ApiUser } from '../../contracts/ts';
import { api, type ApiFail } from './api';
import { Drive, holderText } from './drive';
import { rt, useRt, withLive } from './rt';
import { Approvals } from './screens/approvals';
import { History, RecentEvents } from './screens/history';
import { FloorMap, Maps } from './screens/maps';
import { Guard } from './App';
import { Settings } from './screens/settings';
import { Missions, keptPlan } from './screens/missions';
import { AssignedCards, OUT, assignFor, mineOf } from './screens/assign';
import type { TabId } from './menu';
import { SimTab } from './screens/sim';

/** go(t, id): id 를 주면 그 로봇 화면을 바로 연다(#/drive/<id>). open = PC 조종 탭에서 로봇 화면이 열림. robots = 서버가 준 로봇 목록 그대로 */
export type Ctx = { user: User; robot: Robot; robots: Robot[]; pick: (id: string) => void; go: (t: TabId, id?: string) => void; open: boolean; phone: boolean; light: boolean; setLight: (v: boolean) => void;
  /** 내 정보가 서버에서 바뀜(설정 탭 — 이름) */
  setMe: (u: ApiUser) => void;
  /** 로봇 목록을 서버에서 다시 받음(등록·바꿈·지움·구독 회수 뒤) */
  refresh: () => void;
  /** 이 로그인 세션의 취소 신호 — 서버 요청에 넘겨 세션이 끝난 뒤의 답을 버린다(시험 렌더에는 없음) */
  cancel?: AbortSignal;
  /** 기록 탭에서 바로 보일 사건 id(알림 링크 #/history?event_id=…), 결재 탭에서 바로 열 결재 id(#/approvals?approval_id=…) */
  focus?: string;
  /** 관제 요약(App 이 한 곳에서 받음 — 결재 탭 배지도 이 값) */
  dash: Dash };

const ICON: Record<Tone, string> = { off: '○', ok: '●', warn: '▲', bad: '■' };
/** 상태 표시 하나: 모양 + 짧은 글(색만으로 구분 0). 원본 ui/src/app/chip.tsx 의 Chip 모양 */
export const Chip = ({ tone, text }: { tone: Tone; text: string }) => <span className={`lv-chip ${tone}`} data-tone={tone}><span aria-hidden="true">{ICON[tone]}</span><span>{text}</span></span>;
const Slot = ({ text, h }: { text: string; h?: number }) => <div className="fh-slot" style={h ? { minHeight: h } : undefined}>{text}</div>;
/** 아직 동작이 없는 단추: 비활성 + 본문 아래 «준비 중» 글에 이음(권한 때문인 비활성과 구분 — 권한은 DriveButton 처럼 자기 이유) */
export const soon = { disabled: true, 'aria-describedby': 'fh-soon' } as const;
const pct = (b: number | null) => (b == null ? '—' : `${b}%`);

/** 조종 단추: 못 하면 비활성 + 이유를 글로 함께(title 에만 두지 않음). wait = 권한은 있지만 지금 기다려야 하는 이유 */
export function DriveButton({ c, r, label, onClick, wait }: { c: Ctx; r: Robot; label: string; onClick: () => void; wait?: string }) {
  const why = driveBlock(c.user, r) ?? (wait || null), id = `why-${r.id}`;
  return <div className="fh-row">
    <button type="button" className="btn pri" disabled={!!why} aria-describedby={why ? id : undefined} onClick={onClick}>{label}</button>
    {why && <span id={id} className="fh-why" data-why>{why}</span>}
  </div>;
}

/** 관제 요약을 다시 받는 간격(05 §4 — 화면 WS 에 요약 메시지가 없다) */
export const DASH_MS = 10_000;
type Count = Exclude<keyof Dashboard, 'operators'>;
const COUNTS: Count[] = ['robots_total', 'robots_online', 'robots_running', 'robots_attention', 'approvals_pending'];
const isDash = (x: Dashboard | null) => !!x && Array.isArray(x.operators) && COUNTS.every((k) => Number.isInteger(x[k]) && x[k] >= 0);

/** 관제 요약. again = 지금 한 번 더 받기(결재 처리·요청 뒤 배지) */
export type Dash = { d: Dashboard | null; err: string; again: () => void };
/** 관제 요약(GET /dashboard, DASH_MS 마다) — 로봇 0대여도 보인다. 수치는 서버 값 그대로(운영 관리자는 서버가 담당 범위로 셈).
 *  못 받으면 «—» + 이유, 받은 뒤 실패하면 이전 값 그대로. App 이 한 번만 부른다(관제 칸·결재 탭 배지가 같은 값) */
export function useDash(cancel?: AbortSignal): Dash {
  const [d, setD] = useState<Dashboard | null>(null), [err, setErr] = useState(''), get = useRef(() => {}), gen = useRef(0);
  useEffect(() => {
    // 주기 조회와 처리 뒤 조회가 겹치면 마지막에 보낸 것만 쓴다 — 늦게 온 옛 요약이 새 배지를 덮지 않게
    get.current = () => { const g = ++gen.current; api.dashboard(cancel).then((x) => { if (g !== gen.current) return; if (!isDash(x)) return setErr('요약 형식이 맞지 않습니다.'); setD(x); setErr(''); }, (e: ApiFail) => { if (g === gen.current && e.code !== 'CANCELED') setErr(e.message); }); };
    get.current();
    const i = setInterval(get.current, DASH_MS);
    return () => clearInterval(i);
  }, []);
  return { d, err, again: () => get.current() };
}

/** 로봇 0대의 관제: 요약·운영 관리자 표 + 빈 목록 안내(children) */
export function EmptyFleet({ user, cancel, dash: { d, err }, children }: { user: User; cancel?: AbortSignal; dash: Dash; children: ReactNode }) {
  return <><Kpi user={user} d={d} err={err} />{children}<MapCard cancel={cancel} /><Operators user={user} d={d} /></>;
}

/** 관제 지도 칸 — 로봇 수와 상관없이. 칸 안 렌더 예외는 Guard 가 가둔다(STOP 은 머리줄) */
const MapCard = ({ cancel }: { cancel?: AbortSignal }) => <section className="lv-card" aria-label="지도"><h2>지도</h2><Guard><FloorMap cancel={cancel} /></Guard></section>;

/** 마지막 수신 = 그 로봇의 ONLINE 상태를 받은 시각(다시 그린 시각이 아님). OFFLINE 이면 마지막 ONLINE 을 받은 시각(seenAt),
 *  받은 상태가 없으면 목록을 받은 시각. rt 는 받은 시각을 단조 시계로 두므로 벽시계로 한 번 바꿔 받은 시각마다 기억한다(다시 그려도 초가 흔들리지 않게) */
const heard = new Map<string, [number, string]>();
function received(x: Robot) {
  const l = rt.get(x.id), at = l.stateAt;
  if (x.unknown === 'summary' || x.unknown === 'wait' || !l.state) return x.listedAt || x.seenAt || '—';
  if (l.state.connection !== 'ONLINE') return x.seenAt || x.listedAt || '—';
  const m = heard.get(x.id);
  if (m?.[0] === at) return m[1];
  const t = new Date(Date.now() - (rt.now() - at)).toTimeString().slice(0, 8);
  heard.set(x.id, [at, t]);
  return t;
}

/** 같은 값의 state 는 rt 가 다시 그리지 않으므로(10 Hz) 받은 시각 칸만 1 s 마다 다시 그린다 */
function Seen({ x }: { x: Robot }) {
  const [, tick] = useState(0);
  useEffect(() => { const i = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(i); }, []);
  return <span className="lbl mono" data-seen>마지막 수신 {received(x)}</span>;
}

function Fleet(c: Ctx) {
  const admin = c.user.role === 'ORG_ADMIN', r = c.robot, { d, err } = c.dash;
  return <>
    <Kpi user={c.user} d={d} err={err} />
    <section className="lv-card" aria-label="로봇 목록">
      <h2>로봇</h2>
      <ul className="fh-list robots">{c.robots.map((x) => { const t = robotStatus(x), mine = x.owner === c.user.id; return <li key={x.id}>
        <button type="button" aria-pressed={x.id === r.id} onClick={() => c.pick(x.id)}>
          <Chip {...t} /><b>{x.name}</b>{x.sim && <span className="lbl">시뮬</span>}<span className="mono">{pct(x.battery)}</span><span className="fh-grow">{x.mission ?? ''}</span>
          <span className="lbl">{ownerName(x)}{!admin && !mine ? ' · 보는 중' : ''}</span>
          <Seen x={x} />
        </button></li>; })}</ul>
    </section>
    <MapCard cancel={c.cancel} />
    {/* 담당이 바뀌면 상세를 새로 받는다 — 옛 요청의 늦은 답은 내린 화면에 떨어져 버려진다 */}
    <Detail key={`${r.id}-${r.owner}`} {...c} />
    <Operators user={c.user} d={d} />
  </>;
}

function Kpi({ user, d, err }: { user: User; d: Dashboard | null; err: string }) {
  const admin = user.role === 'ORG_ADMIN', n = (k: Count) => (d ? d[k] : '—');
  return <section className="card fh-kpi" aria-label="요약">
    <div><span>{admin ? '전체' : '내 로봇'}</span><b>{n('robots_total')}</b></div>
    <div><span>연결</span><b>{n('robots_online')}</b></div>
    <div><span>임무 중</span><b>{n('robots_running')}</b></div>
    <div className={d?.robots_attention ? 'bad' : ''}><span>주의 필요</span><b>{n('robots_attention')}</b></div>
    <div><span>{admin ? '결재 대기' : '내 요청'}</span><b>{n('approvals_pending')}</b></div>
    {err && <p className="fh-msg" role="alert">요약을 받지 못했습니다. {err}</p>}
  </section>;
}

function Operators({ user, d }: { user: User; d: Dashboard | null }) {
  if (user.role !== 'ORG_ADMIN') return null;
  return <section className="lv-card" aria-label="운영 관리자">
    <h2>운영 관리자{d ? ` ${d.operators.length}명` : ''}</h2>
    {d && !d.operators.length && <p className="lv-note">운영 관리자 계정이 없습니다.</p>}
    {d && !!d.operators.length && <ul className="fh-list">{d.operators.map((o) => <li key={o.user_id} className="fh-row">
      <span className="fh-grow">{o.display_name}</span><span className="mono">로봇 {o.robot_count}대</span></li>)}</ul>}
  </section>;
}

export const KIND: Record<Device['kind'], string> = { CAMERA_RGB: '카메라', CAMERA_DEPTH: '뎁스 카메라', LIDAR: '라이다', BATTERY: '배터리', OTHER: '기타' };
const DEVICE: Record<Device['state'], { tone: Tone; text: string }> = { OK: { tone: 'ok', text: '정상' }, MISSING: { tone: 'warn', text: '연결 끊겨 확인 안 됨' }, ERROR: { tone: 'bad', text: '오류' } };
const m = (v: number | null) => (v == null ? '—' : `${v.toFixed(1)} m`);
const hms = (at: string) => new Date(at).toTimeString().slice(0, 8);
export const Line = ({ k, children }: { k: string; children: ReactNode }) => <div className="fh-row"><span className="lbl" style={{ minWidth: 48 }}>{k}</span>{children}</div>;

/** 상세 서랍(02 F-FL-04) — 고를 때 GET /robots/{id}. 구독 로봇의 상태·위치·장치는 실시간 state 가 덮는다.
 *  남의 로봇(운영 관리자)은 서버가 값을 감춰 «확인 안 됨», 값이 없으면 없다고 쓴다(지어내지 않음). 최근 사건은 /events(남의 로봇이면 요청 안 함). 층·그래프는 아직 서버에 없다 */
function Detail(c: Ctx) {
  useRt();
  const [got, setGot] = useState<RobotSummary | null>(null), [err, setErr] = useState('');
  useEffect(() => {
    api.robot(c.robot.id, c.cancel).then(setGot, (e: ApiFail) => {
      if (e.code === 'CANCELED') return;
      if (e.status !== 404) return setErr(`상세를 받지 못했습니다. ${e.message}`);
      setErr('이 로봇을 찾을 수 없습니다. 지워졌을 수 있어 목록을 다시 받습니다.');
      c.refresh();
    });
  }, []);
  const r = got ? withLive(toRobot(got)) : c.robot, hidden = r.unknown === 'summary';
  const s = r.unknown ? null : rt.get(r.id).state, loc = s ? s.location : r.location ?? null, devices = s ? s.devices : r.devices ?? [];
  return <section className="lv-card" style={{ flexBasis: 360 }} aria-label="로봇 상세">
    <div className="fh-row"><h2>{r.name}</h2><Chip {...robotStatus(r)} /></div>
    <Line k="담당"><span>{ownerName(r)}</span></Line>
    <Line k="조종"><span>{holderText(rt.get(r.id), c.user.id, r)}</span></Line>
    {r.mission && <Line k="임무"><span>{r.mission}</span></Line>}
    <Line k="배터리"><span className="mono">{hidden ? '확인 안 됨' : r.battery == null ? '측정 안 됨' : `${r.battery}%`}</span></Line>
    <Line k="위치"><span>{hidden ? '확인 안 됨' : loc ? <><span className="mono">x {m(loc.x)} · y {m(loc.y)}</span> <span className="lbl">({hms(loc.updated_at)})</span></> : '위치 없음'}</span></Line>
    <Line k="장치">{hidden ? <span>확인 안 됨</span> : !devices.length ? <span>장치 정보 없음</span>
      : <ul className="fh-list" style={{ flex: 1 }} aria-label="장치">{devices.map((v) => <li key={v.key} className="fh-row">
          <span>{v.label}</span><span className="lbl fh-grow">{KIND[v.kind] ?? KIND.OTHER}</span><Chip {...(DEVICE[v.state] ?? DEVICE.ERROR)} /></li>)}</ul>}</Line>
    {(c.user.role === 'ORG_ADMIN' || c.robot.owner === c.user.id) && <RecentEvents robot={r.id} cancel={c.cancel} />}
    <div className="fh-row"><button type="button" className="btn" disabled={!mineOf(c.user, c.robot)} aria-describedby={mineOf(c.user, c.robot) ? undefined : 'assign-from-detail'} data-assign-robot
      onClick={() => { if (keptPlan.kind !== 'scenarios') { keptPlan.kind = 'scenarios'; keptPlan.sel = null; } assignFor.robot = c.robot.id; c.go('mission'); }}>배정</button>
      {!mineOf(c.user, c.robot) && <span id="assign-from-detail" className="fh-why" data-why>{OUT}</span>}</div>
    {err && <p className="fh-msg" role="alert">{err}</p>}
    <Slot text="지도·그래프 자리" />
  </section>;
}

/** 이 로봇에 배정된 시나리오(GET /assignments?robot_id=) — 폰 조종 화면의 시나리오 시트 */
export const Scenario = (c: Ctx) => <AssignedCards robot={c.robot} cancel={c.cancel} />;

export const BODY: Record<TabId, (c: Ctx) => JSX.Element> = { fleet: Fleet, drive: Drive, mission: Missions, approval: Approvals, history: History, map: Maps, sim: SimTab, settings: Settings };
