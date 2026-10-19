// 탭 본문 — 03 UX §5 배치 뼈대 수준. 관제만 가짜 데이터로 목록·요약을 채운다. 빈 칸(.fh-slot)은 다음 작업 자리.
import { APPROVALS, FLOORS, ROBOTS, SCENARIOS, driveBlock, eventsFor, floorName, robotStatus, robotsFor, userName, type Robot, type Tone, type User } from './fake';
import { Drive } from './drive';
import type { TabId } from './menu';

/** go(t, id): id 를 주면 그 로봇 화면을 바로 연다(#/drive/<id>). open = PC 조종 탭에서 로봇 화면이 열림. stop = 머리줄 STOP 과 같음 */
export type Ctx = { user: User; robot: Robot; pick: (id: string) => void; go: (t: TabId, id?: string) => void; open: boolean; phone: boolean; light: boolean; setLight: (v: boolean) => void };

const ICON: Record<Tone, string> = { off: '○', ok: '●', warn: '▲', bad: '■' };
/** 상태 표시 하나: 모양 + 짧은 글(색만으로 구분 0). 원본 ui/src/app/chip.tsx 의 Chip 모양 */
export const Chip = ({ tone, text }: { tone: Tone; text: string }) => <span className={`lv-chip ${tone}`} data-tone={tone}><span aria-hidden="true">{ICON[tone]}</span><span>{text}</span></span>;
const Slot = ({ text, h }: { text: string; h?: number }) => <div className="fh-slot" style={h ? { minHeight: h } : undefined}>{text}</div>;
/** 아직 동작이 없는 단추: 비활성 + 본문 아래 «준비 중» 글에 이음(권한 때문인 비활성과 구분 — 권한은 DriveButton 처럼 자기 이유) */
const soon = { disabled: true, 'aria-describedby': 'fh-soon' } as const;
const pct = (b: number | null) => (b == null ? '' : `${b}%`);

/** 조종 단추: 못 하면 비활성 + 이유를 글로 함께(title 에만 두지 않음). wait = 권한은 있지만 지금 기다려야 하는 이유 */
export function DriveButton({ c, r, label, onClick, wait }: { c: Ctx; r: Robot; label: string; onClick: () => void; wait?: string }) {
  const why = driveBlock(c.user, r) ?? (wait || null), id = `why-${r.id}`;
  return <div className="fh-row">
    <button type="button" className="btn pri" disabled={!!why} aria-describedby={why ? id : undefined} onClick={onClick}>{label}</button>
    {why && <span id={id} className="fh-why" data-why>{why}</span>}
  </div>;
}

function Fleet(c: Ctx) {
  const list = robotsFor(c.user), need = ROBOTS.filter((r) => robotStatus(r).tone === 'bad' || robotStatus(r).tone === 'warn').length;
  const r = c.robot, s = robotStatus(r);
  return <>
    <section className="card fh-kpi" aria-label="요약">
      <div><span>전체</span><b>{ROBOTS.length}</b></div>
      <div><span>임무 중</span><b>{ROBOTS.filter((x) => x.mission).length}</b></div>
      <div className={need ? 'bad' : ''}><span>주의 필요</span><b>{need}</b></div>
      <div><span>{c.user.role === 'ORG_ADMIN' ? '결재 대기' : '내 요청'}</span><b>{c.user.role === 'ORG_ADMIN' ? APPROVALS.length : APPROVALS.filter((a) => a.by === c.user.id).length}</b></div>
    </section>
    <section className="lv-card" aria-label="로봇 목록">
      <h2>로봇</h2>
      <ul className="fh-list">{list.map((x) => { const t = robotStatus(x), mine = x.owner === c.user.id; return <li key={x.id}>
        <button type="button" aria-pressed={x.id === r.id} onClick={() => c.pick(x.id)}>
          <Chip {...t} /><b>{x.name}</b><span className="mono">{pct(x.battery)}</span><span className="fh-grow">{x.mission ?? ''}</span>
          {c.user.role === 'OPERATOR' && !mine && <span className="lbl">{userName(x.owner)}</span>}
        </button></li>; })}</ul>
    </section>
    <section className="lv-card" aria-label="지도">
      <div className="fh-row"><h2>지도</h2>{FLOORS.map((f, i) => <button key={f.id} type="button" className="btn" aria-pressed={i === 1} {...soon}>{f.name} · {ROBOTS.filter((x) => x.floor === f.id).length}대</button>)}</div>
      <Slot text="지도 자리" h={240} />
    </section>
    <section className="lv-card" aria-label="로봇 상세">
      <div className="fh-row"><h2>{r.name}</h2><Chip {...s} /></div>
      <DriveButton c={c} r={r} label="조종하기" onClick={() => c.go('drive', r.id)} />
      <p className="lv-note">{floorName(r.floor)}{r.mission ? ` · ${r.mission}` : ''}{r.battery != null ? ` · 배터리 ${r.battery}%` : ''}</p>
      <Slot text="위치·그래프·최근 사건 자리" />
    </section>
    {c.user.role === 'ORG_ADMIN' && <section className="lv-card" aria-label="운영 관리자"><h2>운영 관리자</h2><Slot text="운영자별 로봇 수 자리" h={80} /></section>}
  </>;
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

const KINDS = ['전체', '임무', '이탈', '연결', '조종권', '결재', '안전', '계정'];
function History(c: Ctx) {
  const ev = eventsFor(c.user).filter((e) => !c.phone || e.robot === c.robot.id);   // 폰은 고른 내 로봇만
  return <section className="lv-card" style={{ flexBasis: '100%' }} aria-label="기록">
    {!c.phone && <div className="fh-row">{KINDS.map((k, i) => <button key={k} type="button" className="btn" aria-pressed={i === 0} {...soon}>{k}</button>)}</div>}
    <ul className="fh-list">{ev.map((e) => <li key={e.id} className="fh-row"><span className="mono">{e.at}</span><Chip tone={e.tone} text={ROBOTS.find((r) => r.id === e.robot)!.name} /><span>{e.text}</span></li>)}</ul>
    {!ev.length && <p className="lv-note">이 로봇의 기록이 아직 없습니다.</p>}
  </section>;
}

function MapTab() {
  return <>
    <section className="lv-card" style={{ flex: '0 1 220px' }} aria-label="장소">
      <h2>본관</h2>
      <ul className="fh-list">{FLOORS.map((f) => <li key={f.id}><button type="button" {...soon}>{f.name}</button></li>)}</ul>
    </section>
    <section className="lv-card" aria-label="지도 보기">
      <div className="fh-row"><button type="button" className="btn" aria-pressed="true" {...soon}>보기</button><button type="button" className="btn" {...soon}>편집</button></div>
      <Slot text="지도 자리" h={360} />
    </section>
  </>;
}

function Settings(c: Ctx) {
  return <>
    <section className="lv-card" aria-label="개인 설정">
      <h2>개인 설정</h2>
      <div className="fh-row"><span>화면 밝기</span><button type="button" className="btn" aria-pressed={c.light} onClick={() => c.setLight(!c.light)}>{c.light ? '밝게' : '어둡게'}</button></div>
    </section>
    {c.user.role === 'ORG_ADMIN' && <section className="lv-card" aria-label="조직 설정"><h2>계정 · 로봇 배정 · 조직</h2><Slot text="조직 설정 자리" /></section>}
  </>;
}

function Scenario(c: Ctx) {
  return <>{SCENARIOS.filter((s) => s.robot === c.robot.id).map((s) => <section key={s.id} className="lv-card">
    <div className="fh-row"><h2 className="fh-grow">{s.name}</h2><button type="button" className="btn pri" aria-label={`${s.name} 실행`} {...soon}>▶</button></div>
    <p className="lv-note">지점 {s.points} · {s.meters} m{s.last ? ` · ${s.last}` : ''}</p>
  </section>)}
  {!SCENARIOS.some((s) => s.robot === c.robot.id) && <p className="lv-note">이 로봇에 배정된 시나리오가 없습니다.</p>}</>;
}

export const BODY: Record<TabId, (c: Ctx) => JSX.Element> = { fleet: Fleet, drive: Drive, mission: Mission, approval: Approval, history: History, map: MapTab, settings: Settings, scenario: Scenario };
