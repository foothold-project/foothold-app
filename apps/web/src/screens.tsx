// 탭 본문 — 03 UX §5 배치 뼈대 수준. 관제 요약·로봇 목록·상세는 서버 값(설정 탭은 screens/settings.tsx, 기록 탭은 screens/history.tsx, 지도 탭·관제 지도 칸은 screens/maps.tsx), 그 밖은 가짜. 빈 칸(.fh-slot)은 다음 작업 자리.
import { useEffect, useState, type ReactNode } from 'react';
import { APPROVALS, ROBOTS, SCENARIOS, driveBlock, ownerName, robotStatus, toRobot, userName, type Robot, type Tone, type User } from './fake';
import type { Dashboard, Device, RobotSummary, User as ApiUser } from '../../contracts/ts';
import { api, type ApiFail } from './api';
import { Drive, holderText } from './drive';
import { rt, useRt, withLive } from './rt';
import { History, RecentEvents } from './screens/history';
import { FloorMap, Maps } from './screens/maps';
import { Guard } from './App';
import { Settings } from './screens/settings';
import type { TabId } from './menu';

/** go(t, id): id 를 주면 그 로봇 화면을 바로 연다(#/drive/<id>). open = PC 조종 탭에서 로봇 화면이 열림. robots = 서버가 준 로봇 목록 그대로 */
export type Ctx = { user: User; robot: Robot; robots: Robot[]; pick: (id: string) => void; go: (t: TabId, id?: string) => void; open: boolean; phone: boolean; light: boolean; setLight: (v: boolean) => void;
  /** 내 정보가 서버에서 바뀜(설정 탭 — 이름) */
  setMe: (u: ApiUser) => void;
  /** 로봇 목록을 서버에서 다시 받음(등록·바꿈·지움·구독 회수 뒤) */
  refresh: () => void;
  /** 이 로그인 세션의 취소 신호 — 서버 요청에 넘겨 세션이 끝난 뒤의 답을 버린다(시험 렌더에는 없음) */
  cancel?: AbortSignal;
  /** 기록 탭에서 바로 보일 사건 id(알림 링크 #/history?event_id=…) */
  focus?: string };

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

/** 관제 요약(GET /dashboard, DASH_MS 마다) — 로봇 0대여도 보인다. 수치는 서버 값 그대로(운영 관리자는 서버가 담당 범위로 셈).
 *  못 받으면 «—» + 이유, 받은 뒤 실패하면 이전 값 그대로 */
function useDash(cancel?: AbortSignal) {
  const [d, setD] = useState<Dashboard | null>(null), [err, setErr] = useState('');
  useEffect(() => {
    const get = () => api.dashboard(cancel).then((x) => { if (!isDash(x)) return setErr('요약 형식이 맞지 않습니다.'); setD(x); setErr(''); }, (e: ApiFail) => { if (e.code !== 'CANCELED') setErr(e.message); });
    get();
    const i = setInterval(get, DASH_MS);
    return () => clearInterval(i);
  }, []);
  return [d, err] as const;
}

/** 로봇 0대의 관제: 요약·운영 관리자 표 + 빈 목록 안내(children) */
export function EmptyFleet({ user, cancel, children }: { user: User; cancel?: AbortSignal; children: ReactNode }) {
  const [d, err] = useDash(cancel);
  return <><Kpi user={user} d={d} err={err} />{children}<Operators user={user} d={d} /></>;
}

function Fleet(c: Ctx) {
  const admin = c.user.role === 'ORG_ADMIN', r = c.robot, [d, err] = useDash(c.cancel);
  return <>
    <Kpi user={c.user} d={d} err={err} />
    <section className="lv-card" aria-label="로봇 목록">
      <h2>로봇</h2>
      <ul className="fh-list">{c.robots.map((x) => { const t = robotStatus(x), mine = x.owner === c.user.id; return <li key={x.id}>
        <button type="button" aria-pressed={x.id === r.id} onClick={() => c.pick(x.id)}>
          <Chip {...t} /><b>{x.name}</b><span className="mono">{pct(x.battery)}</span><span className="fh-grow">{x.mission ?? ''}</span>
          <span className="lbl">{ownerName(x)}{!admin && !mine ? ' · 보기 전용' : ''}</span>
        </button></li>; })}</ul>
    </section>
    <section className="lv-card" aria-label="지도">
      <h2>지도</h2>
      <Guard><FloorMap cancel={c.cancel} /></Guard>
    </section>
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

const KIND: Record<Device['kind'], string> = { CAMERA_RGB: '카메라', CAMERA_DEPTH: '뎁스 카메라', LIDAR: '라이다', BATTERY: '배터리', OTHER: '기타' };
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
  return <section className="lv-card" aria-label="로봇 상세">
    <div className="fh-row"><h2>{r.name}</h2><Chip {...robotStatus(r)} /></div>
    <DriveButton c={c} r={r} label="조종하기" onClick={() => c.go('drive', r.id)} />
    <Line k="담당"><span>{ownerName(r)}</span></Line>
    <Line k="조종"><span>{holderText(rt.get(r.id), c.user.id, r)}</span></Line>
    {r.mission && <Line k="임무"><span>{r.mission}</span></Line>}
    <Line k="배터리"><span className="mono">{hidden ? '확인 안 됨' : r.battery == null ? '측정 안 됨' : `${r.battery}%`}</span></Line>
    <Line k="위치"><span>{hidden ? '확인 안 됨' : loc ? <><span className="mono">x {m(loc.x)} · y {m(loc.y)}</span> <span className="lbl">({hms(loc.updated_at)})</span></> : '위치 없음'}</span></Line>
    <Line k="장치">{hidden ? <span>확인 안 됨</span> : !devices.length ? <span>장치 정보 없음</span>
      : <ul className="fh-list" style={{ flex: 1 }} aria-label="장치">{devices.map((v) => <li key={v.key} className="fh-row">
          <span>{v.label}</span><span className="lbl fh-grow">{KIND[v.kind] ?? KIND.OTHER}</span><Chip {...(DEVICE[v.state] ?? DEVICE.ERROR)} /></li>)}</ul>}</Line>
    {(c.user.role === 'ORG_ADMIN' || c.robot.owner === c.user.id) && <RecentEvents robot={r.id} cancel={c.cancel} />}
    {err && <p className="fh-msg" role="alert">{err}</p>}
    <Slot text="지도·그래프 자리" />
  </section>;
}

function Mission() {
  return <>
    <section className="lv-card" aria-label="목록">
      <div className="fh-row"><button type="button" className="btn" aria-pressed="true" {...soon}>시나리오</button><button type="button" className="btn" {...soon}>임무</button><span className="fh-grow" /><button type="button" className="btn pri" {...soon}>새 시나리오</button></div>
      <ul className="fh-list">{SCENARIOS.map((s) => <li key={s.id}><button type="button" {...soon}><b>{s.name}</b><span>{ROBOTS.find((r) => r.id === s.robot)?.name}</span><span className="lbl">{s.last}</span></button></li>)}</ul>
    </section>
    <section className="lv-card" aria-label="편집">
      <h2>① 지도</h2><Slot text="층 고르기 자리" h={60} />
      <h2>② 지점</h2><Slot text="지도 눌러 지점 추가 자리" />
      <h2>③ 확인</h2><Slot text="거리·필요 장치 자리" h={60} />
    </section>
  </>;
}

function Approval(c: Ctx) {
  const admin = c.user.role === 'ORG_ADMIN', list = admin ? APPROVALS : APPROVALS.filter((a) => a.by === c.user.id);
  return <>
    <section className="lv-card" aria-label={admin ? '결재함' : '내 요청'}>
      <h2>{admin ? '결재함' : '내 요청'} ({list.length})</h2>
      <ul className="fh-list">{list.map((a) => <li key={a.id}><button type="button" {...soon}><b>{a.kind}</b><span className="fh-grow">{a.target}</span><span className="lbl">{userName(a.by)} {a.at}</span></button></li>)}</ul>
    </section>
    <section className="lv-card" aria-label="내용">
      <Slot text="바뀐 곳 비교 자리" h={240} />
      <div className="fh-row">{admin ? <><button type="button" className="btn" {...soon}>반려</button><button type="button" className="btn pri" {...soon}>승인</button></>
        : <><button type="button" className="btn" {...soon}>요청 취소</button><button type="button" className="btn" {...soon}>고쳐서 다시 요청</button></>}</div>
    </section>
  </>;
}

function Scenario(c: Ctx) {
  return <>{SCENARIOS.filter((s) => s.robot === c.robot.id).map((s) => <section key={s.id} className="lv-card">
    <div className="fh-row"><h2 className="fh-grow">{s.name}</h2><button type="button" className="btn pri" aria-label={`${s.name} 실행`} {...soon}>▶</button></div>
    <p className="lv-note">지점 {s.points} · {s.meters} m{s.last ? ` · ${s.last}` : ''}</p>
  </section>)}
  {!SCENARIOS.some((s) => s.robot === c.robot.id) && <p className="lv-note">이 로봇에 배정된 시나리오가 없습니다.</p>}</>;
}

export const BODY: Record<TabId, (c: Ctx) => JSX.Element> = { fleet: Fleet, drive: Drive, mission: Mission, approval: Approval, history: History, map: Maps, settings: Settings, scenario: Scenario };
