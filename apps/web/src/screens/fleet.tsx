// 로봇 탭 역할별 배치(ROBOT-TAB 11-02 — runs/robot-tab-review-1102/claude.md Q3 순서). 화면만: API 호출·인자·서버 권한·STOP 범위는 그대로.
// 운영 관리자 = 내 로봇 고르기 + 한 대 집중(상태 한 줄 → 영상·라이다 → 지도 위 현재 위치 → 상세: 임무·배터리·장치·최근 사건), 남의 로봇은 아래 접힌 «다른 로봇 N대»(요약 그대로).
// 총괄 = 요약 → 큰 지도(전 로봇 위치) + 경보(주의 먼저) → 표 목록 + 거르기 → 행을 누르면 서랍 상세(읽기 전용). STOP 은 머리줄 하나(화면 안에 새로 두지 않음)
// TAB-SPLIT(11-10): 로봇 탭 = 실기만(목록·고르기·거르기·요약·지도·경보). 시뮬 로봇은 «시뮬» 탭에서만 — 머리줄 STOP 후보(App)는 그대로 시뮬 포함
// RB-PC-DRIVE-3COL(11-19): 서버가 조종을 허용한 내 실기(canDrive — 한 번 허용된 뒤 로봇만 끊기면 keepDrive 로 유지)를 고르면 본문이 곧 세 칸 조종 화면(pcdrive.tsx) — «← 목록»으로 이 화면, «조종 화면 열기»로 다시. 모달 없음
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Dashboard, Location, MapVersion } from '../../../contracts/ts';
import { api, type ApiFail } from '../api';
import { lost, ownerName, robotStatus, type Robot, type Tone } from '../fake';
import { rt, useRt } from '../rt';
import { holderText } from '../drive';
import { NO_SIGNAL } from '../drivemedia';
import { PhoneRelay, useRelayExpiry } from '../phoneRelay';
import { canDrive, keepDrive, stopLine } from '../serverdrive';
import { PcDrive } from '../pcdrive';
import { ActionTrial } from './actiontrial';
import { MapFrame, MapImage } from '../mapframe';
import { Guard } from '../App';
import { Shapes, floorsOf, isVersion, shape, toPixel, useFit, useTree } from './maps';
import { FallChip, pickInfo, sdeg } from '../go2status';
import { ReadyCheck } from './readycheck';
import { RobotTiles } from './robottiles';
import { useSimAt } from './missions';
import { ManageRobot } from '../pairing';
import { Deck, Head, RailCard, Stage, Views, type Tab } from './robotframe';
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
/** 큰 상태 안내의 갈래(서버 값만): 연결됨 · 끊김(로봇) · 서버 끊김 · 첫 상태 기다림 · 연결 전 · 남의 로봇 요약 */
type Kind = 'on' | 'lost' | 'server' | 'wait' | 'pre' | 'summary';
const kindOf = (r: Robot): Kind => (r.unknown === 'summary' ? 'summary' : r.unknown === 'link' ? 'server' : r.unknown === 'wait' ? 'wait' : r.online ? 'on' : r.status ? 'lost' : 'pre');

const SYM: Record<'ok' | 'plug' | 'cut', ReactNode> = {
  ok: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  plug: <path d="M9 3v5M15 3v5M6.5 8h11v3.5a5.5 5.5 0 0 1-11 0zM12 17v4" />,
  cut: <path d="M9 3v5M15 3v5M6.5 8h11v3.5a5.5 5.5 0 0 1-11 0zM12 17v4M3 3l18 18" />,
};
const Sym = ({ k, tone }: { k: keyof typeof SYM; tone: Tone }) => <span className="fl-sym" data-tone={tone} aria-hidden="true">
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{SYM[k]}</svg></span>;

/** 머리(이름·실기·담당·«로봇 설정») + 큰 상태 안내(갈래 문구 + «연결 방법»·«조종 화면 열기») + 상태 한 줄(서버·로봇·조종 중인 사람·정지 잠금·마지막 보고 · 폰 경유) */
function StateLine({ c, r, own, guide, settings, drive }: { c: Ctx; r: Robot; own: boolean; guide: () => void; settings: () => void; drive: () => void }) {
  const l = rt.get(r.id), s = r.unknown ? null : l.state, hidden = r.unknown === 'summary', bad = isLost(r), k = kindOf(r), ok = keepDrive(c, r);
  const server = LINK[rt.link().at] ?? { tone: 'off' as const, text: '연결 중' };
  // 한 번도 상태를 받지 못한 로봇(r.status 없음)의 OFFLINE 은 «연결 전» — 제목·상세(robotStatus·linkText)와 같은 판정(끊김 경보 아님)
  const robot = hidden ? { tone: 'off' as const, text: '확인 안 됨' } : !s ? { tone: 'off' as const, text: r.unknown === 'link' ? '모름(서버 끊김)' : '모름' }
    : s.connection === 'ONLINE' ? { tone: 'ok' as const, text: '연결' } : r.status ? { tone: 'bad' as const, text: '끊김' } : { tone: 'off' as const, text: '연결 전' };
  const stop = stopLine(l) ?? (hidden ? { tone: 'off' as const, text: '확인 안 됨' } : s?.latched == null ? { tone: 'off' as const, text: '모름' }
    : s.latched ? { tone: 'bad' as const, text: '잠김' } : { tone: 'ok' as const, text: '풀림' });
  const st = robotStatus(r);
  const [sym, tone, title, copy]: [keyof typeof SYM, Tone, string, string] = {
    on: ['ok', 'ok', '로봇이 연결되었습니다', ok ? '«조종 화면 열기»로 카메라·라이다를 보며 조종할 수 있습니다.' : '서버가 아직 조종을 허용하지 않았습니다 — 오른쪽 «조종 준비»를 보세요.'],
    lost: ['cut', 'bad', '로봇과의 연결이 끊겼습니다', '통신을 확인하세요. 연결이 돌아와도 조종 입력을 자동으로 다시 보내지 않습니다.'],
    server: ['cut', 'bad', '서버와의 연결이 끊겼습니다', '네트워크를 확인하세요. 다시 연결되어도 조종 입력을 자동으로 다시 보내지 않습니다.'],
    wait: ['plug', 'off', '로봇 상태를 확인하는 중입니다', '서버에서 이 로봇의 첫 상태를 기다리고 있습니다.'],
    pre: ['plug', 'off', '로봇 연결을 기다리고 있습니다', '서버는 연결됐지만 로봇에서 받은 정보가 없습니다.'],
    summary: ['plug', 'off', `${ownerName(r)}님 담당 로봇입니다`, '남의 로봇은 서버가 요약만 보냅니다.'],
  }[k] as [keyof typeof SYM, Tone, string, string];
  return <section className="fl-state" aria-label="로봇 연결 상태" data-lost={bad || undefined}>
    <div className="fl-top">
      <div className="fl-title">
        <div className="fh-row"><h2>{r.name}</h2><span className="lbl fl-tag">{r.sim ? '시뮬' : '실기'}</span>{st.text !== robot.text && <Chip {...st} />}
          {r.owner !== c.user.id && <span className="lbl" data-not-mine>{ownerName(r)} · 보는 중(요약만)</span>}</div>
        <span className="lbl">담당 <b>{ownerName(r)}</b></span>
      </div>
      {own && <button type="button" className="btn fl-ghost" onClick={settings} data-open-settings>로봇 설정</button>}
    </div>
    <div className={`lv-card fl-status${bad ? ' bad' : ''}`} data-kind={k}>
      <div className="fl-lead">
        <Sym k={sym} tone={tone} />
        <div className="fh-grow"><h3>{title}</h3><p className="lv-note">{copy}{bad && r.mission ? ' 임무 «이어서»는 실행을 건 같은 화면에서만 할 수 있습니다.' : ''}</p></div>
        {own && <div className="fh-row fl-acts"><button type="button" className="btn" onClick={guide} data-open-guide>연결 방법</button>
          <button type="button" className="btn pri" disabled={!ok} aria-describedby={ok ? undefined : 'fl-step-drive'} onClick={drive} data-open-drive>조종 화면 열기</button></div>}
      </div>
      <div className="fl-facts" data-state-line>
        <Fact k="서버"><Chip {...server} /></Fact><Fact k="로봇"><Chip {...robot} /></Fact>
        <Fact k="조종 중인 사람"><span data-holder>{holderText(l, c.user.id, r)}</span></Fact>
        <Fact k="정지 잠금"><span data-stop-state><Chip {...stop} /></span></Fact>
        <Fact k="마지막 보고"><Ago x={r} /></Fact>
        {!hidden && r.phoneRelay && <Fact k="폰 경유"><PhoneRelay key={r.id} report={r.phoneRelay} receivedAt={r.phoneRelayAt} compact /></Fact>}
      </div>
      {bad && <p className="fh-msg fl-lostnote" role="alert" data-lost-note>{r.unknown === 'link' ? '서버 연결이 끊겼습니다' : '로봇 연결이 끊겼습니다'} — 아래 값은 마지막으로 받은 정보입니다. 현재 위치와 정지 상태는 확인할 수 없습니다.</p>}
    </div>
  </section>;
}

type View = 'map' | 'rgb' | 'lidar' | 'depth';
const VIEW: [View, string][] = [['map', '지도'], ['rgb', '카메라'], ['lidar', '라이다'], ['depth', '뎁스']];
/** 로봇 관측: 지도·카메라·라이다·뎁스 한 칸(보기 고르기). 카메라·라이다는 서버 경유 조종 화면(serverdrive.tsx)만 받는다 — 여기는 받는 영상이 없으니
 *  가짜 그림 없이 «신호 없음 + 까닭» 한 줄. 끊기면 지도(마지막 위치)만 회색 */
function Observe({ c, r }: { c: Ctx; r: Robot }) {
  const [v, setV] = useState<View>('map'), k = kindOf(r);
  const why = isLost(r) ? '연결이 끊겼습니다' : !r.online ? '로봇이 아직 연결되지 않았습니다'
    : canDrive(c, r) ? '«조종 화면 열기»를 누르면 조종 화면에서 받습니다' : '서버 경유 조종이 허용되면 조종 화면에서 받습니다';
  const pill = k === 'on' ? { tone: 'ok' as const, text: '수신 중' } : k === 'lost' || k === 'server' ? { tone: 'bad' as const, text: '수신 끊김' } : { tone: 'off' as const, text: '정보 수신 대기' };
  return <section className="lv-card fl-obs" aria-label="로봇 관측">
    <div className="fh-row"><h2 className="fh-grow">로봇 관측</h2><Chip {...pill} /></div>
    <div className="fl-tabs" role="group" aria-label="보기">{VIEW.map(([id, t]) => <button key={id} type="button" aria-pressed={v === id} onClick={() => setV(id)} data-view={id}>{t}</button>)}</div>
    {v === 'map' ? <section className="fl-map" aria-label="지도"><Guard><FleetMap robots={[r]} sel={r.id} cancel={c.cancel} /></Guard></section>
      : <p className="lv-note fl-nosig" data-no-signal={v}>{NO_SIGNAL[v]} — {why}</p>}
  </section>;
}

const m1 = (v: number | null | undefined) => (v == null ? '—' : v.toFixed(1));
/** 로봇 상태: 배터리 · 본체 자세 · 현재 위치(서버 값만 — 없으면 «—»와 까닭, 끊기면 «마지막 수신값») */
function Telemetry({ r }: { r: Robot }) {
  useRelayExpiry(r.phoneRelay, r.phoneRelayAt);
  const k = kindOf(r), stale = k === 'lost' || k === 'server', info = pickInfo(r), v = info?.v ?? null, loc = where(r);
  const sub = (has: boolean, none: string) => (!has ? none : stale ? '마지막 수신값' : '');
  const pose = !v ? '—' : v.fallen ? <Chip tone="warn" text="넘어짐 의심" /> : v.fallen === false ? '넘어지지 않음' : '모름';
  const code = v && (v.code == null ? '상태 번호 모름' : v.code === 0 ? '상태 번호 0(정상 범위)' : `상태 번호 ${v.code}`);
  const cell = (t: string, val: ReactNode, small: ReactNode, attr: string) => <div className="fl-tele-cell" data-tele={attr}><span className="lbl">{t}</span><b>{val}</b>{small && <small className="lbl">{small}</small>}</div>;
  return <section className="fl-tele" aria-label="로봇 상태" data-stale={stale || undefined}>
    <div className="fh-row"><h2 className="fh-grow">로봇 상태</h2><span className="lbl">{k === 'on' ? '수신 중' : stale ? '현재 상태가 아닙니다' : '수신 후 표시됩니다'}</span></div>
    <div className="fl-tele-grid">
      {cell('배터리', r.battery == null ? '—' : `${r.battery}%`, sub(r.battery != null, '측정값 없음'), 'battery')}
      {cell('본체 자세', pose, v ? [`roll ${sdeg(v.roll) ?? '모름'} · pitch ${sdeg(v.pitch) ?? '모름'}`, code, info?.via].filter(Boolean).join(' · ') : info?.why ?? '수신 안 됨', 'pose')}
      {cell('현재 위치', loc ? `x ${m1(loc.x)} · y ${m1(loc.y)} m` : '—', loc ? `${new Date(loc.updated_at).toTimeString().slice(0, 8)} 기준${stale ? ' · 마지막 수신값' : ''}` : '지도 위치 없음', 'where')}
    </div>
    <p className="lv-note">{stale ? '현재 자세와 넘어짐 여부는 알 수 없습니다.' : v ? '넘어짐은 기울기로 추정한 표시입니다(안전 판단에 쓰지 않음).' : '넘어짐 여부는 자세 정보를 받은 뒤 확인할 수 있습니다.'}</p>
  </section>;
}

const DRIVE_BLOCKED: Record<NonNullable<Robot['serverDriveBlocked']>[number], string> = {
  SWITCH_OFF: '서버에서 실기 조종이 꺼져 있습니다(관리자만 켤 수 있음)',
  NO_OWNER: '담당자가 없습니다',
  NO_SERIAL: '로봇 기체번호가 등록되지 않았습니다',
  AGENT_OFFLINE: '로봇 쪽 노트북 프로그램이 연결되지 않았습니다',
};

/** 조종 준비: 서버 연결 → 로봇 연결 → 조종 가능(허용 판단은 server_drive_allowed 만, 이유 목록은 표시만). 허용되면 조종은 세 칸 조종 화면(«조종 화면 열기»)에서 */
function Prepare({ c, r, guide }: { c: Ctx; r: Robot; guide: () => void }) {
  const k = kindOf(r), net = rt.link().at === 'open', on = k === 'on', ok = canDrive(c, r);
  const ready = ok && on;   // 서버 허용 값이 남아 있어도 로봇이 끊기면 완료로 보이지 않는다(목록 갱신 전). 패널(STOP 포함)은 ok 면 그대로 둔다
  const pill = k === 'lost' || k === 'server' ? { tone: 'bad' as const, text: '재연결 필요' } : ready ? { tone: 'ok' as const, text: '조종 가능' } : on ? { tone: 'warn' as const, text: '서버 허용 대기' } : { tone: 'off' as const, text: '연결 대기' };
  const blocked = !r.serverDrive ? r.serverDriveBlocked?.filter((reason) => DRIVE_BLOCKED[reason]) : null;
  const step = (n: number, done: boolean, cur: boolean, t: string, p: ReactNode, more?: ReactNode, id?: string) => <li className={`fl-step${done ? ' done' : cur ? ' cur' : ''}`} data-step={n}>
    <span className="fl-mark" aria-hidden="true">{done ? '✓' : n}</span><div><h3>{t}</h3><p className="lv-note" id={id}>{p}</p>{more}</div></li>;
  return <section className="lv-card fl-prep" aria-label="조종 준비">
    <div className="fh-row"><h2 className="fh-grow">조종 준비</h2><Chip {...pill} /></div>
    <ol className="fl-steps">
      {step(1, net, !net, '서버 연결', net ? '관제 서버와 연결되어 있습니다.' : '서버 연결이 끊겼습니다. 네트워크를 확인하세요.')}
      {step(2, on, net && !on, '로봇 연결', on ? '로봇 상태를 받고 있습니다.' : k === 'wait' ? '로봇 상태를 확인하는 중입니다.' : k === 'lost' ? '네트워크와 노트북 연결 프로그램을 확인하세요.' : '노트북 연결 프로그램을 확인하세요.',
        !on && <button type="button" className="btn fl-small" onClick={guide}>연결 방법 보기</button>)}
      {step(3, ready, on && !ok, '조종 가능', blocked?.length ? blocked.map((reason, i) => <span key={reason} data-drive-block={reason}>{i > 0 && <br />}{DRIVE_BLOCKED[reason]}</span>) : ready ? '서버가 담당·기체번호·서버 전체 스위치·로봇 연결을 확인했습니다.'
        : on ? '서버가 아직 조종을 허용하지 않았습니다 — 담당·기체번호·서버 전체 스위치 중 맞지 않는 것이 있습니다.' : '로봇이 연결되면 서버가 담당·기체번호·서버 전체 스위치를 자동으로 확인합니다.', undefined, 'fl-step-drive')}
    </ol>
    {!ok && !r.sim && <ActionTrial robot={r} allowed={false} />}
    <ReadyCheck r={r} server={net} again={c.refresh} />
  </section>;
}

/** 화면 위 창(로봇 설정·연결 방법). 모달이 아니다 — 머리줄 STOP 이 늘 보이고 눌려야 해서 바깥을 inert 하지 않는다. Esc·닫기로 닫고 연 단추로 초점을 돌린다.
 *  닫아도 안을 지우지 않는다(담당 넘기기 진행·결과 문구 유지) */
function Sheet({ title, open, close, children }: { title: string; open: boolean; close: () => void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null), back = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    back.current = document.activeElement as HTMLElement | null; box.current?.focus();
    return () => back.current?.focus();
  }, [open]);
  return <div className="fl-sheet" role="dialog" aria-label={title} hidden={!open} tabIndex={-1} ref={box} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }}>
    <div className="fh-row fl-sheet-head"><h2 className="fh-grow">{title}</h2><button type="button" className="btn" onClick={close}>닫기</button></div>
    <div className="fl-sheet-body">{children}</div>
  </div>;
}
const Guide = ({ r }: { r: Robot }) => <ol className="fl-guide">
  <li><b>로봇과 노트북 연결</b><span className="lv-note">현장에서 쓰는 연결 방식(유선·현장 네트워크)으로 Go2 와 노트북을 잇습니다.</span></li>
  <li><b>노트북 연결 프로그램 켜기</b><span className="lv-note">«Go2 기체번호 찾음»에 보이는 번호가 이 로봇{r.serial ? <> (<span className="mono">{r.serial}</span>)</> : ''}과 같은지 확인합니다.</span></li>
  <li><b>로봇 상태 받기 확인</b><span className="lv-note">연결 프로그램에 «연결됨»이 뜨고 이 화면의 «로봇»이 «연결», «마지막 보고»가 초 단위로 바뀌면 됩니다.</span></li>
  <li><b>노트북을 다시 설치했으면</b><span className="lv-note">«+ 새 로봇 추가»에서 QR·6자리 코드로 다시 연결합니다 — 같은 로봇으로 이어지고 옛 연결 키는 폐기됩니다.</span></li>
</ol>;

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
      : cur ? <p className="lv-note">아직 지도가 없습니다. 지도 탭에서 지도를 만들어 주세요.</p>
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

/** 실기 보기(옛 시뮬 탭 «Go2 실기 보기» — 같은 조건: 폰 앱 밖·실기만). 상세 칸 아래.
 *  지도 고르기(RB-REPLAY-LIVE 11-18): 승인 판이 있는 층 → 층 화면 «시뮬 열기»와 같은 규칙(useSimAt)으로 그 지형을 연다(못 열면 꺼짐 + 이유). 기본 = 로봇이 있는 층, 없으면 «지도 없이»(기본 지형) */
function RealView({ r }: { r: Robot }) {
  if (inApp() || r.sim) return null;   // 로봇 탭은 이미 실기만 — 서버 목록은 simulation 을 늘 보낸다
  return <RealViewPick r={r} />;
}
function RealViewPick({ r }: { r: Robot }) {
  const t = useTree(), places = floorsOf(t.tree).filter((x) => x.floor.approved_version_id), here = where(r)?.floor_id ?? '';
  const [pick, setPick] = useState<string | null>(null), fid = pick ?? (places.some((x) => x.floor.id === here) ? here : '');
  const p = places.find((x) => x.floor.id === fid), vid = p?.floor.approved_version_id ?? '';
  const [v, setV] = useState<MapVersion | null>(null), [verr, setVerr] = useState(''), [err, setErr] = useState('');
  useEffect(() => {
    setV(null); setVerr('');
    if (!vid) return;
    let live = true;
    api.version(vid).then(shape(isVersion)).then((x) => { if (live) setV(x); }, (e: ApiFail) => { if (live && e.code !== 'CANCELED') setVerr(`지도를 받지 못했습니다. ${e.message}`); });
    return () => { live = false; };
  }, [vid]);
  const o = useSimAt(p?.floor, v?.id === vid ? v : undefined);
  const name = p ? `${p.site.name} · ${p.building.name} ${p.floor.name}` : '', me = `&policy=go2-demo&robot=${encodeURIComponent(r.id)}`;
  const why = !p ? (t.err ? '지도 목록을 받지 못해 지도 없이 엽니다.' : '') : verr || (!v || v.id !== vid ? '지도를 불러오는 중입니다.' : typeof o.at === 'string' ? o.at : o.terWhy);
  const href = !p ? `/sim/index.html?from=web${me}` : why ? undefined : `${o.url}${me}&mapName=${encodeURIComponent(name)}`;
  return <section className="lv-card" aria-label="실기 보기" data-go2-replay>
    <div className="fh-row"><h2>실기 보기</h2><span className="fh-grow" />
      <label className="fh-row lbl">지도<select className="fh-user fh-sel" aria-label="실기 보기 지도" data-go2-map value={fid} onChange={(e) => { setPick(e.target.value); setErr(''); }}>
        <option value="">지도 없이(기본 지형)</option>
        {places.map((x) => <option key={x.floor.id} value={x.floor.id}>{`${x.site.name} · ${x.building.name} ${x.floor.name}`}</option>)}</select></label>
      <a className="btn" data-go2-open href={href} aria-disabled={href ? undefined : true}
        onClick={(e) => { const no = !href ? '-' : p ? o.prep() : ''; if (no) { e.preventDefault(); if (no !== '-') setErr(no); } }}>실기 보기 열기</a></div>
    {(err || why) && <p className="fh-why" role={err ? 'alert' : 'status'} data-go2-why>{err || why}</p>}
    <p className="lv-note" data-go2-note>로봇 움직임을 화면으로 보기만 합니다(조종 안 됨) · 처음에는 위치가 지도와 맞지 않을 수 있습니다 — 열린 화면에서 «로봇 지금 여기 맞추기»로 한 번 맞추세요</p>
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

/** u4 틀 한 벌(11/28 · 시안 u4_1 · u4_4 · u4_5): 왼쪽 .rail · 머리 .hdr · 가운데 .stage3d · 오른쪽 .right.
 *  driving = 조종이 허용된 로봇의 «조종» — 가운데 · 오른쪽 자리에 기존 세 칸 조종 화면(PcDrive) 그대로(조종 · STOP 경로 시험을 지킴, u4 조종 칸 이식은 다음 단위).
 *  r 이 없으면(총괄이 고른 시뮬 — 머리줄 STOP 대상 유지) 가운데에 «로봇을 고르세요» 한 줄 */
function Frame({ c, r, tab, setTab, rail, settings, driving, views, check }: { c: Ctx; r: Robot | null; tab: Tab; setTab: (t: Tab) => void; rail: ReactNode;
  settings?: () => void; driving: ReactNode; views: ReactNode; check: ReactNode }) {
  return <div className="u4" data-robot-frame data-tab={tab}>
    {rail}
    {!r ? <section className="u4-pane stage3d" style={{ gridColumn: 'stage / right', gridRow: 'hdr / stage' }} data-robot-none>
      <p className="s3-none">왼쪽 목록에서 로봇을 고르세요</p></section>
      : <>
        <Head c={c} r={r} tab={tab} setTab={setTab} settings={settings} />
        {driving ? <div className="right" style={{ gridColumn: 'stage / right' }} data-robot-side>{driving}</div>
          : <><Stage key={r.id} r={r} />
            <div className="right" data-robot-side>{tab === 'drive' ? <>{views}
              {/* 점검 칸(상태 한 줄 · 조종 준비 · 상세)은 «조종»에서도 접어 둔다 — 고른 로봇의 상세 · 관리 단추를 잃지 않게 */}
              <More>{check}</More></>
              : <div className="u4-pane chk" aria-label="순서 점검">{check}</div>}</div></>}
      </>}
  </div>;
}

/** «조종»에서 점검 칸을 접어 두는 자리(펼치기 단추 · 접혀도 칸은 DOM 에 남아 고른 로봇의 상세 · 관리를 잃지 않음) */
function More({ children }: { children: ReactNode }) {
  const [on, setOn] = useState(false);
  return <section className="u4-pane u4-more" data-robot-more><button type="button" className="u4-more-btn" aria-expanded={on} onClick={() => setOn(!on)}>점검 칸 {on ? '접기' : '펼치기'}</button>
    <div hidden={!on}>{children}</div></section>;
}

/** 운영 관리자(PC): 왼쪽 = 내 실기 + «다른 로봇»(남의 로봇은 요약만) · 조종 = 보기(지도 · 영상 까닭) · 조종 줄 · 조종 칸, 허용된 내 실기는 바로 조종 화면(«← 목록»으로 보기) ·
 *  점검 = 상태 한 줄 · 로봇 상태 · 조종 준비 · 상세 · 실기 보기 · 로봇 설정(이름 · 담당 넘기기 · 연결 끊기 · 지우기 — pairing.tsx 그대로) · 연결 방법은 화면 위 창 */
function Operator(c: Ctx) {
  useRt();
  const me = c.user.id, mine = c.robots.filter((x) => x.owner === me), others = c.robots.filter((x) => x.owner !== me), r = c.robot, own = r.owner === me;
  const [sheet, setSheet] = useState<'' | 'settings' | 'guide'>(''), [list, setList] = useState(false), [tab, setTab] = useState<Tab>('drive');
  useEffect(() => { setSheet(''); setList(false); }, [r.id]);   // 로봇을 고르면 바로 조종 화면(허용된 로봇만)
  const guide = () => setSheet('guide'), ok = own && keepDrive(c, r);
  const why = isLost(r) ? '로봇 연결이 끊겼습니다' : !r.online ? '로봇이 아직 연결되지 않았습니다' : !own ? '남의 로봇은 조종할 수 없습니다'
    : ok ? '«조종 화면 열기»를 누르면 조종 화면에서 받습니다' : '서버 경유 조종이 허용되면 조종 화면에서 받습니다';
  return <Pair user={c.user} mine={mine.map((x) => x.id)} refresh={c.refresh} cancel={c.cancel}>{(add) => <>
    <Frame c={c} r={r} tab={tab} setTab={(t) => { setTab(t); if (t === 'drive') setList(false); }} settings={own ? () => setSheet('settings') : undefined}
      rail={<aside className="u4-pane rail" aria-label="로봇 목록" data-robot-rail>
        <div className="rail-top"><h2 className="ttl">로봇</h2>{add}</div>
        {!mine.length ? <div className="rail-sub" data-no-mine><b>담당 로봇이 없습니다</b><p className="lv-note">«+ 새 로봇 추가»에서 연결 코드로 실기를 등록하거나, 총괄에게 담당 지정을 요청하세요. 시뮬 로봇은 «시뮬» 탭에서 띄웁니다.</p>
          <a className="btn" href="#/sim">시뮬 탭 열기</a></div>
          : <ul className="rail-list" aria-label="내 로봇 고르기">{mine.map((x) => <RailCard key={x.id} x={x} on={x.id === r.id} open={c.pick} />)}</ul>}
        {others.length > 0 && <details className="fl-others" aria-label="다른 로봇" open>
          <summary className="rail-sub">다른 로봇 {others.length}대 · 남의 로봇은 요약만</summary>
          <ul className="rail-list">{others.map((x) => <RailCard key={x.id} x={x} on={x.id === r.id} open={c.pick} watching />)}</ul></details>}
      </aside>}
      driving={ok && !list && tab === 'drive' && <PcDrive key={r.id} c={c} r={r} back={() => setList(true)} floorMap={<Guard><FleetMap robots={[r]} sel={r.id} cancel={c.cancel} /></Guard>} />}
      views={<><Views key={r.id} r={r} why={why} map={<Guard><FleetMap robots={[r]} sel={r.id} cancel={c.cancel} /></Guard>}
          drive={ok && <button type="button" className="btn pri" onClick={() => setList(false)} data-open-drive>조종 화면 열기</button>} />
        <Deck why={why} /></>}
      check={<div className="fh-focus" data-lost={isLost(r) || undefined} data-summary={!own || undefined}>
        <StateLine c={c} r={r} own={own} guide={guide} settings={() => setSheet('settings')} drive={() => { setTab('drive'); setList(false); }} />
        {own && <Observe key={r.id} c={c} r={r} />}
        {own && <Telemetry r={r} />}
        <Side r={r}>{own && <Prepare key={r.id} c={c} r={r} guide={guide} />}<Detail key={`${r.id}-${r.owner}`} {...c} solo /></Side>
      </div>} />
    {own && <Sheet title="로봇 설정" open={sheet === 'settings'} close={() => setSheet('')}><ManageRobot key={`${r.id}-${r.owner}`} r={r} refresh={c.refresh} cancel={c.cancel} /></Sheet>}
    {own && <Sheet title="로봇 연결 방법" open={sheet === 'guide'} close={() => setSheet('')}><Guide r={r} /></Sheet>}
  </>}</Pair>;
}

type Filter = { owner: string; state: '' | 'attn' | 'online' | 'off' };
const RANK: Record<Tone, number> = { bad: 0, warn: 1, ok: 2, off: 3 };
const needs = (x: Robot) => { const t = robotStatus(x).tone; return t === 'bad' || t === 'warn' || !!x.attention?.length; };

/** 총괄(PC): 왼쪽 = 요약 수 · 담당 · 상태 거르기 · 경보(주의 먼저) · 로봇 목록. 조종 = 보기(전 로봇 위치 지도 · 층 고르기) · 서버가 허용한 실기는 «조종 화면»(운영 관리자와 같은 세 칸 조종 — #547),
 *  점검 = 상세(담당 지정 · 내 로봇 관리) · 실기 보기. 아래 = 로봇 타일(u5_4) · 운영 관리자 표. 총괄이 고른 시뮬(머리줄 STOP 대상)은 그대로 두고 가운데는 «고르세요» */
function Admin({ d, ...c }: Ctx & { d: Dashboard | null }) {
  useRt();
  const { err } = c.dash, [f, setF] = useState<Filter>({ owner: '', state: '' }), [drive, setDrive] = useState(false), [tab, setTab] = useState<Tab>('drive');
  const r = c.robot.sim ? null : c.robot;
  const open = (id: string) => { c.pick(id); setDrive(false); };
  const can = !!r && keepDrive(c, r);
  const owners = [...new Map(c.robots.map((x) => [x.owner, ownerName(x)])).entries()];
  const rows = c.robots.filter((x) => (!f.owner || x.owner === (f.owner === '-' ? '' : f.owner))
    && (!f.state || (f.state === 'attn' ? needs(x) : f.state === 'online' ? x.online : !x.online)));
  const alerts = c.robots.filter(needs).sort((a, b) => RANK[robotStatus(a).tone] - RANK[robotStatus(b).tone]);
  const sel = (k: keyof Filter, label: string, opts: [string, string][]) => <label className="fh-row lbl">{label}
    <select className="fh-user fh-sel" value={f[k]} data-filter={k} onChange={(e) => setF({ ...f, [k]: e.target.value })}>{opts.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></label>;
  const nodrive = '서버 경유 조종이 이 로봇에 켜져 있지 않습니다 (서버 조종 스위치 · 로봇 연결 · 담당 확인). 조종은 서버가 허용한 뒤에 엽니다.';
  const why = !r ? '' : isLost(r) ? '로봇 연결이 끊겼습니다' : !r.online ? '로봇이 아직 연결되지 않았습니다' : can ? '«조종 화면»을 누르면 조종 화면에서 받습니다' : nodrive;
  return <Pair user={c.user} mine={c.robots.filter((x) => x.owner === c.user.id).map((x) => x.id)} refresh={c.refresh} cancel={c.cancel}>{(add) => <>
    <Frame c={c} r={r} tab={tab} setTab={(t) => { setTab(t); if (t !== 'drive') setDrive(false); }}
      rail={<aside className="u4-pane rail" aria-label="로봇 목록" data-robot-rail>
        <div className="rail-top"><h2 className="ttl">로봇 {rows.length === c.robots.length ? c.robots.length : `${rows.length}/${c.robots.length}`}대</h2>{add}</div>
        <Kpi user={c.user} d={d} err={err} />
        <div className="rail-filt">{sel('owner', '담당', [['', '전체'], ...owners.map(([id, name]): [string, string] => [id || '-', name])])}
          {sel('state', '상태', [['', '전체'], ['attn', '주의 필요'], ['online', '연결됨'], ['off', '끊김·연결 전']])}</div>
        <section className="rail-alerts" aria-label="경보"><h3>경보{alerts.length ? ` ${alerts.length}` : ''}</h3>
          {!alerts.length ? <p className="lv-note">주의가 필요한 로봇이 없습니다.</p>
            : <ul>{alerts.map((x) => <li key={x.id}><button type="button" onClick={() => open(x.id)} data-alert={x.id}>
              <Chip {...robotStatus(x)} /><b>{x.name}</b><span className="lbl">{attn(x) || robotStatus(x).text}</span></button></li>)}</ul>}</section>
        {!rows.length && <p className="lv-note">거른 조건에 맞는 로봇이 없습니다.</p>}
        <ul className="rail-list">{rows.map((x) => <RailCard key={x.id} x={x} on={x.id === r?.id} open={open} />)}</ul>
      </aside>}
      driving={drive && can && r && tab === 'drive' && <PcDrive key={r.id} c={c} r={r} back={() => setDrive(false)} floorMap={<Guard><FleetMap robots={[r]} sel={r.id} cancel={c.cancel} /></Guard>} />}
      views={r && <><Views r={r} why={why} map={<Guard><FleetMap robots={c.robots} sel={r.id} cancel={c.cancel} /></Guard>}
          drive={can && <button type="button" className="btn pri" data-admin-drive onClick={() => setDrive(true)}>조종 화면</button>} />
        <Deck why={why} nodrive={!can} /></>}
      check={r && <Side r={r}><Detail key={`${r.id}-${r.owner}`} {...c} /></Side>} />
    <section className="lv-card" aria-label="로봇 한눈에" style={{ flexBasis: '100%' }}><RobotTiles robots={rows} open={(id) => { open(id); setTab('check'); }} /></section>
    <Operators user={c.user} d={d} />
  </>}</Pair>;
}
