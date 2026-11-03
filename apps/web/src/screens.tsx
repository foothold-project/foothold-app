// 탭 본문 — 03 UX §5 배치 뼈대 수준. 관제 요약·로봇 목록·상세는 서버 값(설정 탭은 screens/settings.tsx, 기록 탭은 screens/history.tsx, 지도 탭·관제 지도 칸은 screens/maps.tsx, 결재 탭은 screens/approvals.tsx, 임무 탭은 screens/missions.tsx), 폰 시나리오 카드는 서버 배정(screens/assign.tsx).
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { adminReal, driveBlock, ownerName, robotStatus, toRobot, type Robot, type Tone, type User } from './fake';
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
import { Trash } from './screens/trash';
import { AssignedCards, OUT, assignFor, mineOf } from './screens/assign';
import type { TabId } from './menu';
import { SimTab } from './screens/sim';
import { PhoneRelay } from './phoneRelay';
import { RobotInfo, pickInfo } from './go2status';
import { AdminFleet, OperatorRobot } from './screens/fleet';
import { AddRobot, Approval, AssignOwner, FieldCheck, ManageRobot } from './pairing';

/** go(t, id): id 를 주면 그 로봇 화면을 바로 연다(#/drive/<id>). open = PC 조종 탭에서 로봇 화면이 열림. robots = 서버가 준 로봇 목록 그대로 */
export type Ctx = { user: User; robot: Robot; robots: Robot[]; pick: (id: string) => void; go: (t: TabId, id?: string) => void; open: boolean; phone: boolean;
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
/** 아직 동작이 없는 단추: 비활성 + 본문 아래 «준비 중» 글에 이음(권한 때문인 비활성과 구분 — 권한은 DriveButton 처럼 자기 이유) */
// FOOTHOLD Android 앱(mobile/ 껍데기)의 WebView 는 UA 끝에 FootholdApp/<판> 을 붙인다 — 앱에선 전체화면 단추·홈 화면 안내·파일 내려받기가 맞지 않음
export const inApp = () => /\bFootholdApp\//.test(navigator.userAgent);
export const soon = { disabled: true, 'aria-describedby': 'fh-soon' } as const;
export const pct = (b: number | null) => (b == null ? '—' : `${b}%`);

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

/** 로봇 0대의 관제. 총괄: 요약·빈 목록 안내(children)·지도·운영 관리자 표. 운영 관리자: 등록·담당 요청·시뮬 띄우기 입구(요약 숫자 없이 — 한 대 집중 화면과 같게) */
export function EmptyFleet({ user, cancel, dash: { d, err }, refresh, children }: { user: User; cancel?: AbortSignal; dash: Dash; refresh: () => void; children: ReactNode }) {
  if (user.role !== 'ORG_ADMIN') return <Pair user={user} mine={[]} refresh={refresh} cancel={cancel}>
    <section className="lv-card" aria-label="로봇 없음"><h2>담당 로봇이 없습니다</h2>
      <p className="lv-note">«+ 새 로봇 추가»에서 연결 코드로 실기를 등록하거나, 총괄에게 담당 지정을 요청하세요. 시뮬 로봇은 «시뮬» 탭에서 띄웁니다.</p>
      <div className="fh-row"><a className="btn" href="#/sim">시뮬 탭 열기</a></div></section></Pair>;
  return <><Kpi user={user} d={d} err={err} />{children}<MapCard cancel={cancel} /><Operators user={user} d={d} /></>;
}

/** PC 웹 운영 관리자의 «새 로봇 추가»(폰과 같은 화면 — pairing.tsx). 펼치면 children(목록 칸) 자리에. 총괄은 실기를 연결하지 않아 없음 */
export function Pair({ user, mine, refresh, cancel, children }: { user: User; mine: string[]; refresh: () => void; cancel?: AbortSignal; children: ReactNode }) {
  const [on, setOn] = useState(false);
  if (user.role === 'ORG_ADMIN') return <>{children}</>;
  return on ? <AddRobot mine={mine} close={() => setOn(false)} refresh={refresh} cancel={cancel} />
    : <>{children}<div className="fh-row" style={{ flexBasis: '100%' }}><button type="button" className="btn" onClick={() => setOn(true)} data-pair-start>+ 새 로봇 추가</button></div></>;
}

/** 서버 주의 코드(05 §4 attention, 목록 값) → 짧은 글 */
const ATTN: Record<string, string> = { OFFLINE: '연결 끊김', STATE_STALE: '상태 늦음', BATTERY_LOW: '배터리 낮음', ERROR: '오류', STOP_LATCHED: '정지 잠금', DEVICE_ERROR: '장치 오류' };
export const attn = (x: Robot) => (x.attention ?? []).map((a) => ATTN[a] ?? a).join(' · ');
export const linkText = (x: Robot) => (x.unknown ? '연결 확인 중' : x.online ? '연결됨' : x.status ? '끊김' : '연결 전');

/** 관제 지도 칸 — 로봇 수와 상관없이. 칸 안 렌더 예외는 Guard 가 가둔다(STOP 은 머리줄) */
const MapCard = ({ cancel }: { cancel?: AbortSignal }) => <section className="lv-card fl-map" aria-label="지도"><h2>지도</h2><Guard><FloorMap cancel={cancel} /></Guard></section>;

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
export function Seen({ x }: { x: Robot }) {
  const [, tick] = useState(0);
  useEffect(() => { const i = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(i); }, []);
  return <span className="lbl mono" data-seen>마지막 수신 {received(x)}</span>;
}

/** 로봇 탭(03 §5.1, ROBOT-TAB 11-02 역할별): 운영 관리자 = 내 로봇 한 대 집중, 총괄 = 지도·경보·표 + 서랍 상세(screens/fleet.tsx) */
const Fleet = (c: Ctx) => (c.user.role === 'ORG_ADMIN' ? <AdminFleet {...c} /> : <OperatorRobot {...c} />);

export function Kpi({ user, d, err }: { user: User; d: Dashboard | null; err: string }) {
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

export function Operators({ user, d }: { user: User; d: Dashboard | null }) {
  if (user.role !== 'ORG_ADMIN') return null;
  return <section className="lv-card" aria-label="운영 관리자">
    <h2>운영 관리자{d ? ` ${d.operators.length}명` : ''}</h2>
    {d && !d.operators.length && <p className="lv-note">운영 관리자 계정이 없습니다.</p>}
    {d && !!d.operators.length && <ul className="fh-list">{d.operators.map((o) => <li key={o.user_id} className="fh-row">
      <span className="fh-grow">{o.display_name}</span><span className="mono">로봇 {o.robot_count}대</span></li>)}</ul>}
  </section>;
}

export const KIND: Record<Device['kind'], string> = { CAMERA_RGB: '카메라', CAMERA_DEPTH: '뎁스 카메라', LIDAR: '라이다', BATTERY: '배터리', OTHER: '기타' };
/** 장치 상태 코드(contracts DeviceStatusCode, #213): OK 는 숨김, 명시 허용(ACCEPTED)은 «허용된 상태 코드 n», 그 밖(ERROR·모르는 level)은 오류로 원시 코드 */
const codeText = ({ status_code: c }: Device) => {
  if (c?.raw == null || c.level === 'OK') return null;
  const ok = c.level === 'ACCEPTED';
  return <span className="lbl" data-status-code={ok ? 'ACCEPTED' : 'ERROR'}>{ok ? `허용된 상태 코드 ${c.raw}${c.reason === 'EXPLICIT_SERVER_ALLOWLIST' ? '(서버 명시 허용)' : ''}` : `상태 코드 ${c.raw}`}</span>;
};
const DEVICE: Record<Device['state'], { tone: Tone; text: string }> = { OK: { tone: 'ok', text: '정상' }, MISSING: { tone: 'warn', text: '연결 끊겨 확인 안 됨' }, ERROR: { tone: 'bad', text: '오류' } };
const m = (v: number | null) => (v == null ? '—' : `${v.toFixed(1)} m`);
const hms = (at: string) => new Date(at).toTimeString().slice(0, 8);
export const Line = ({ k, children }: { k: string; children: ReactNode }) => <div className="fh-row"><span className="lbl" style={{ minWidth: 48 }}>{k}</span>{children}</div>;

export const LINK: Record<string, { tone: Tone; text: string }> = { open: { tone: 'ok', text: '연결' }, lost: { tone: 'bad', text: '끊김' }, denied: { tone: 'bad', text: '거부' } };
/** 상세 서랍(02 F-FL-04) — 고를 때 GET /robots/{id}. 구독 로봇의 상태·위치·장치는 실시간 state 가 덮는다.
 *  요약 먼저(이름·실기/시뮬·서버/로봇 연결·잠금·조종권자·배터리·장치 문제·최근 문제), 장치·위치·사건 전체는 접는다 — 장치 문제·최근 문제·정지 단계는 접힌 밖에 늘 보인다.
 *  남의 로봇(운영 관리자)은 서버가 값을 감춰 «확인 안 됨», 값이 없으면 없다고 쓴다(지어내지 않음). 최근 사건은 /events(남의 로봇이면 요청 안 함). close = 총괄 서랍 닫기 */
export function Detail({ close, solo, ...c }: Ctx & { close?: () => void; solo?: boolean }) {
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
  const r = got ? withLive(toRobot(got)) : c.robot, hidden = r.unknown === 'summary', own = !r.sim && c.user.role !== 'ORG_ADMIN' && c.robot.owner === c.user.id;
  const s = r.unknown ? null : rt.get(r.id).state, loc = s ? s.location : r.location ?? null, devices = s ? s.devices : r.devices ?? [];
  const broken = hidden ? [] : devices.filter((v) => v.state !== 'OK');
  // 서버 연결·로봇 연결·잠금은 서로 다른 값 — 한 줄에 따로 보인다(합치지 않음). 집중 화면(solo)은 위 상태 한 줄에 있어 여기선 뺀다
  const server = LINK[rt.link().at] ?? { tone: 'off' as const, text: '연결 중' };
  const robot = hidden ? { tone: 'off' as const, text: '확인 안 됨' } : !s ? { tone: 'off' as const, text: '모름' } : s.connection === 'ONLINE' ? { tone: 'ok' as const, text: '연결' } : { tone: 'bad' as const, text: '끊김' };
  const lock = s?.latched == null ? { tone: 'off' as const, text: '모름' } : s.latched ? { tone: 'bad' as const, text: '잠김' } : { tone: 'ok' as const, text: '풀림' };
  const run = got?.current_run ? RUN[got.current_run.status] ?? got.current_run.status : '';
  const manage = <>
    <Line k="담당"><span>{ownerName(r)}</span></Line>
    <Line k="연결"><span>{linkText(r)}</span></Line>
    {!r.sim && <Line k="현장 승인"><Approval r={c.robot} /></Line>}
    {!r.sim && r.serial && <Line k="기체번호"><span className="mono">{r.serial}</span></Line>}
    {!hidden && attn(c.robot) && <Line k="주의"><span>{attn(c.robot)}</span></Line>}
    {/* 총괄: 담당 없는 실기에만 담당 지정(그 밖 실기 쓰기 없음 — 서버 403). 담당 운영(PC 웹): 현장 안전 확인·내 로봇 관리 */}
    {c.user.role === 'ORG_ADMIN' && !r.sim && !c.robot.owner && <AssignOwner r={c.robot} refresh={c.refresh} cancel={c.cancel} />}
    {own && <FieldCheck r={c.robot} refresh={c.refresh} cancel={c.cancel} />}
    {own && <ManageRobot r={c.robot} refresh={c.refresh} cancel={c.cancel} />}
  </>;
  const mission = solo ? <Line k="임무"><span data-mission>{r.mission ? `${r.mission}${run ? ` · ${run}` : ''}` : '진행 중인 임무 없음'}</span></Line>
    : r.mission && <Line k="임무"><span>{r.mission}</span></Line>;
  const info = pickInfo(r);   // 실기 Go2 자세·상태 번호·넘어짐 추정(표시만) — 배터리 옆, 시뮬은 숨김
  const battery = <><Line k="배터리"><span className="mono">{hidden ? '확인 안 됨' : r.battery == null ? '측정 안 됨' : `${r.battery}%`}</span></Line>{info && <RobotInfo {...info} />}</>;
  /* 총괄은 실기에 배정하지 않는다(로봇 탭 읽기 전용 — 시뮬은 유지, r1) */
  const assign = !adminReal(c.user, r) && <div className="fh-row"><button type="button" className="btn" disabled={!mineOf(c.user, c.robot)} aria-describedby={mineOf(c.user, c.robot) ? undefined : 'assign-from-detail'} data-assign-robot
    onClick={() => { if (keptPlan.kind !== 'scenarios') { keptPlan.kind = 'scenarios'; keptPlan.sel = null; } assignFor.robot = c.robot.id; c.go('mission'); }}>배정</button>
    {!mineOf(c.user, c.robot) && <span id="assign-from-detail" className="fh-why" data-why>{OUT}</span>}</div>;
  const events = (c.user.role === 'ORG_ADMIN' || c.robot.owner === c.user.id) && <RecentEvents robot={r.id} cancel={c.cancel} />;
  const more = <details className="fh-fold" data-detail-more open={solo || undefined}><summary>장치·위치{hidden ? '' : ` — 장치 ${devices.length}개`}</summary>
    {!hidden && <PhoneRelay key={r.id} report={r.phoneRelay} receivedAt={r.phoneRelayAt} />}
    <Line k="위치"><span>{hidden ? '확인 안 됨' : loc ? <><span className="mono">x {m(loc.x)} · y {m(loc.y)}</span> <span className="lbl">({hms(loc.updated_at)})</span></> : '위치 없음'}</span></Line>
    <Line k="장치">{hidden ? <span>확인 안 됨</span> : !devices.length ? <span>장치 정보 없음</span>
      : <ul className="fh-list" style={{ flex: 1 }} aria-label="장치">{devices.map((v) => <li key={v.key} className="fh-row">
          <span>{v.label}</span><span className="lbl fh-grow">{KIND[v.kind] ?? KIND.OTHER}</span><Chip {...(DEVICE[v.state] ?? DEVICE.ERROR)} />{codeText(v)}</li>)}</ul>}</Line>
  </details>;
  return <section className="lv-card fl-detail" aria-label="로봇 상세">
    <div className="fh-row"><h2>{r.name}</h2><Chip {...robotStatus(r)} /><span className="lbl">{r.sim ? '시뮬' : '실기'}</span>
      {close && <><span className="fh-grow" /><button type="button" className="btn" data-detail-close onClick={close}>닫기</button></>}</div>
    {!solo && <div className="fh-row" aria-label="연결·잠금" data-detail-links>
      <span className="lbl">서버</span><Chip {...server} /><span className="lbl">로봇</span><Chip {...robot} /><span className="lbl">잠금</span><Chip {...lock} /></div>}
    {broken.length > 0 && <p className="fh-msg" role="status" data-detail-alert>▲ 장치 문제: {broken.map((v) => `${v.label} ${(DEVICE[v.state] ?? DEVICE.ERROR).text}`).join(', ')}</p>}
    {/* 집중(solo, 운영 관리자): 임무 진행 → 배터리·장치 → 최근 사건 → 담당·관리. 서랍(총괄): 담당·관리 → 조종권자 → 임무·배터리 → 사건 → 장치(접힘) */}
    {solo ? <>{mission}{battery}{more}{events}<h3 className="lbl" style={{ margin: 0 }}>담당·관리</h3>{manage}{assign}</>
      : <>{manage}<Line k="조종"><span>{holderText(rt.get(r.id), c.user.id, r)}</span></Line>{mission}{battery}{assign}{events}{more}</>}
    {err && <p className="fh-msg" role="alert">{err}</p>}
  </section>;
}

/** 실행 단계(contracts CurrentRun.status) → 짧은 글. 일시정지 까닭은 서버 요약에 없어 쓰지 않는다 */
const RUN: Record<string, string> = { QUEUED: '대기열', PREPARING: '준비 중', MOVING: '이동 중', AT_WAYPOINT: '지점 도착', PERFORMING: '작업 중', WAIT_CONFIRM: '확인 기다림', PAUSED: '일시정지' };

/** 이 로봇에 배정된 시나리오(GET /assignments?robot_id=) — 폰 조종 화면의 시나리오 시트 */
export const Scenario = (c: Ctx) => <AssignedCards robot={c.robot} cancel={c.cancel} />;

export const BODY: Record<TabId, (c: Ctx) => JSX.Element> = { fleet: Fleet, drive: Drive, mission: Missions, approval: Approvals, history: History, map: Maps, trash: Trash, sim: SimTab, settings: Settings };
