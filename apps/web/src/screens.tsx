// 탭 본문 — 03 UX §5 배치 뼈대 수준. 관제 로봇 목록·설정의 조직 기준값은 서버 값, 그 밖은 가짜. 빈 칸(.fh-slot)은 다음 작업 자리.
import { useEffect, useState, type FormEvent } from 'react';
import type { OrgSettings } from '../../contracts/ts';
import { api } from './api';
import { APPROVALS, FLOORS, ROBOTS, SCENARIOS, driveBlock, eventsFor, floorName, robotStatus, userName, type Robot, type Tone, type User } from './fake';
import { Drive } from './drive';
import type { TabId } from './menu';

/** go(t, id): id 를 주면 그 로봇 화면을 바로 연다(#/drive/<id>). open = PC 조종 탭에서 로봇 화면이 열림. robots = 서버가 준 로봇 목록 그대로 */
export type Ctx = { user: User; robot: Robot; robots: Robot[]; pick: (id: string) => void; go: (t: TabId, id?: string) => void; open: boolean; phone: boolean; light: boolean; setLight: (v: boolean) => void };

const ICON: Record<Tone, string> = { off: '○', ok: '●', warn: '▲', bad: '■' };
/** 상태 표시 하나: 모양 + 짧은 글(색만으로 구분 0). 원본 ui/src/app/chip.tsx 의 Chip 모양 */
export const Chip = ({ tone, text }: { tone: Tone; text: string }) => <span className={`lv-chip ${tone}`} data-tone={tone}><span aria-hidden="true">{ICON[tone]}</span><span>{text}</span></span>;
const Slot = ({ text, h }: { text: string; h?: number }) => <div className="fh-slot" style={h ? { minHeight: h } : undefined}>{text}</div>;
/** 아직 동작이 없는 단추: 비활성 + 본문 아래 «준비 중» 글에 이음(권한 때문인 비활성과 구분 — 권한은 DriveButton 처럼 자기 이유) */
export const soon = { disabled: true, 'aria-describedby': 'fh-soon' } as const;
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
  const list = c.robots, need = list.filter((r) => robotStatus(r).tone === 'bad' || robotStatus(r).tone === 'warn').length;
  const r = c.robot, s = robotStatus(r);
  return <>
    <section className="card fh-kpi" aria-label="요약">
      <div><span>전체</span><b>{list.length}</b></div>
      <div><span>임무 중</span><b>{list.filter((x) => x.mission).length}</b></div>
      <div className={need ? 'bad' : ''}><span>주의 필요</span><b>{need}</b></div>
      <div><span>{c.user.role === 'ORG_ADMIN' ? '결재 대기' : '내 요청'}</span><b>{c.user.role === 'ORG_ADMIN' ? APPROVALS.length : APPROVALS.filter((a) => a.by === c.user.id).length}</b></div>
    </section>
    <section className="lv-card" aria-label="로봇 목록">
      <h2>로봇</h2>
      <ul className="fh-list">{list.map((x) => { const t = robotStatus(x), mine = x.owner === c.user.id; return <li key={x.id}>
        <button type="button" aria-pressed={x.id === r.id} onClick={() => c.pick(x.id)}>
          <Chip {...t} /><b>{x.name}</b><span className="mono">{pct(x.battery)}</span><span className="fh-grow">{x.mission ?? ''}</span>
          {c.user.role === 'OPERATOR' && !mine && <span className="lbl">{userName(x.owner)} · 보기 전용</span>}
        </button></li>; })}</ul>
    </section>
    <section className="lv-card" aria-label="지도">
      <div className="fh-row"><h2>지도</h2>{FLOORS.map((f, i) => <button key={f.id} type="button" className="btn" aria-pressed={i === 1} {...soon}>{f.name} · {list.filter((x) => x.floor === f.id).length}대</button>)}</div>
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

/** 로봇이 0대여도 열리는 탭이라 Ctx 전체가 아니라 필요한 것만 받는다 */
export function Settings(c: Pick<Ctx, 'user' | 'light' | 'setLight'>) {
  const admin = c.user.role === 'ORG_ADMIN';
  return <>
    <section className="lv-card" aria-label="개인 설정">
      <h2>개인 설정</h2>
      <div className="fh-row"><span>화면 밝기</span><button type="button" className="btn" aria-pressed={c.light} onClick={() => c.setLight(!c.light)}>{c.light ? '밝게' : '어둡게'}</button></div>
    </section>
    <OrgLimits admin={admin} />
    {admin && <section className="lv-card" aria-label="조직 설정"><h2>계정 · 로봇 배정</h2><Slot text="계정·로봇 배정 자리" /></section>}
  </>;
}

/** 조직 기준값(05 API §8 GET·PATCH /org/settings). 범위는 계약(apps/contracts/models.py OrgSettingsPatch)과 같게 — 검사는 서버가 한다 */
const LIMITS: { key: keyof OrgSettings; label: string; unit: string; min: number; max: number; step: number }[] = [
  { key: 'battery_low_pct', label: '배터리 부족 기준', unit: '%', min: 5, max: 50, step: 1 },
  { key: 'run_min_battery_pct', label: '실행 시작 최소 배터리', unit: '%', min: 10, max: 90, step: 1 },
  { key: 'deviation_m', label: '경로 이탈 거리', unit: 'm', min: 0.5, max: 5, step: 0.1 },
  { key: 'lease_request_timeout_s', label: '조종권 요청 응답 시간', unit: '초', min: 5, max: 30, step: 1 },
  { key: 'link_loss_wait_s', label: '연결 끊김 대기 시간', unit: '초', min: 0, max: 30, step: 1 },
];
const range = (f: (typeof LIMITS)[number]) => `${f.min}~${f.max} ${f.unit}`;
const NO_EDIT = '조직 기준값은 총괄 운영 관리자만 바꿀 수 있습니다.';

function OrgLimits({ admin }: { admin: boolean }) {
  const [saved, setSaved] = useState<OrgSettings | null>(null), [draft, setDraft] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ text: string; ok?: boolean } | null>(null), [busy, setBusy] = useState(false);
  const show = (s: OrgSettings) => { setSaved(s); setDraft(Object.fromEntries(LIMITS.map((f) => [f.key, String(s[f.key])]))); };
  useEffect(() => { api.settings().then(show, (e: Error) => setMsg({ text: e.message })); }, []);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!saved || busy) return;
    const patch = Object.fromEntries(LIMITS.filter((f) => draft[f.key] !== String(saved[f.key])).map((f) => [f.key, draft[f.key].trim() === '' ? NaN : Number(draft[f.key])]));
    if (!Object.keys(patch).length) return setMsg({ text: '바뀐 값이 없습니다.', ok: true });
    setBusy(true);
    try { show(await api.saveSettings(patch)); setMsg({ text: '저장했습니다. 다음 실행부터 적용됩니다.', ok: true }); }
    catch (err) {
      // 서버 범위 검사(400 VALIDATION)는 어느 칸인지 알려 주지 않으므로 범위를 벗어난 칸을 함께 적는다
      const bad = LIMITS.filter((f) => f.key in patch && !(patch[f.key] >= f.min && patch[f.key] <= f.max && (f.step < 1 || Number.isInteger(patch[f.key]))));
      setMsg({ text: `${(err as Error).message}${bad.length ? ` 허용 범위: ${bad.map((f) => `${f.label} ${range(f)}${f.step < 1 ? '' : '(정수)'}`).join(', ')}` : ''}` });
    } finally { setBusy(false); }
  };
  return <section className="lv-card" aria-label="조직 기준값">
    <h2>조직 기준값</h2>
    {saved && <form className="fh-form" onSubmit={save} noValidate>
      {LIMITS.map((f) => <label key={f.key} className="fh-field"><span>{f.label} <span className="lbl">({range(f)})</span></span>
        <input className="inp" name={f.key} type="number" inputMode="decimal" min={f.min} max={f.max} step={f.step} readOnly={!admin} aria-describedby={admin ? undefined : 'why-org'}
          value={draft[f.key]} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} /></label>)}
      <div className="fh-row">
        <button type="submit" className="btn pri" disabled={!admin || busy} aria-describedby={admin ? undefined : 'why-org'}>저장</button>
        {!admin && <span id="why-org" className="fh-why" data-why>{NO_EDIT}</span>}
      </div>
    </form>}
    {msg && <p className={`fh-msg${msg.ok ? ' ok' : ''}`} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>}
  </section>;
}

function Scenario(c: Ctx) {
  return <>{SCENARIOS.filter((s) => s.robot === c.robot.id).map((s) => <section key={s.id} className="lv-card">
    <div className="fh-row"><h2 className="fh-grow">{s.name}</h2><button type="button" className="btn pri" aria-label={`${s.name} 실행`} {...soon}>▶</button></div>
    <p className="lv-note">지점 {s.points} · {s.meters} m{s.last ? ` · ${s.last}` : ''}</p>
  </section>)}
  {!SCENARIOS.some((s) => s.robot === c.robot.id) && <p className="lv-note">이 로봇에 배정된 시나리오가 없습니다.</p>}</>;
}

export const BODY: Record<TabId, (c: Ctx) => JSX.Element> = { fleet: Fleet, drive: Drive, mission: Mission, approval: Approval, history: History, map: MapTab, settings: Settings, scenario: Scenario };
