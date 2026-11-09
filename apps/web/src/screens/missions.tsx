// 임무 탭(01 MS-01·02·03·09, 02 F-MS-01~04·§10, 03 §5.3, 05 §6.1~6.3 — S5a /actions·/missions·/scenarios·/scenarios/preview).
// 목록 [임무 | 시나리오](보관 제외 기본·보관 보기·더 보기) + 편집 칸. 저장할 때마다 새 판(PUT If-Match = 받은 본체 version), 옛 판은 읽기 전용(덮어쓰기 단추 없음).
// 시나리오 지도 그리기·좌표 변환은 지도 탭 함수(screens/maps·mapedit) 그대로. 배정 창·목록은 저장된 시나리오 칸 아래(screens/assign.tsx, S5b), 실행은 S7 뒤.
// STOP 은 App 머리줄 — 이 화면은 창 키·포인터를 잡지 않는다(지도 svg 포인터만).
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Action, Assignment, MapFloor, MapVersion, Terrain, Mission, MissionStep, MissionWrite, Scenario, ScenarioPoint, ScenarioPreview, ScenarioWaypoint, ScenarioWrite } from '../../../contracts/ts';
import { ApiFail, api, type Plan } from '../api';
import { idleSim, type Robot, type User } from '../fake';
import { KIND as DEVICE, type Ctx } from '../screens';
import { MapFrame, MapImage } from '../mapframe';
import { Note, Shapes, canon, floorsOf, isVersion, reasonBad, shape, toPixel, useFit, useTree, type Msg, type Place } from './maps';
import { DelX, fromScreen, inside, nameBad } from './mapedit';
import { AssignPanel, assignFor } from './assign';
import { TrashLink, trashFail } from './trash';
import { Hint, Menu, Pane, shut, type Side } from './mapscen';
import { ScenNodes, type StepKind } from './scennode';
import { saveSim, scenarioTree, simId } from './btedit';
import { keyOf, terrainUrl } from './terrain';
import { openUrl, simAt } from '../simstart';

type P = [number, number];
type AnyPlan = Mission | Scenario;
type AnyWrite = MissionWrite | ScenarioWrite;
const WHAT: Record<Plan, string> = { missions: '임무', scenarios: '시나리오' };
const ACT: Record<MissionStep['action'], string> = { PHOTO: '사진 찍기', WAIT: '대기', OPERATOR_CONFIRM: '운영자 확인', SENSOR_LOG: '센서 값 기록' };   // 카탈로그를 못 받았을 때 이름
const VALUE: Record<string, string> = { rgb: '카메라', depth: '뎁스 카메라', lidar: '라이다', battery: '배터리' };
const FINISH = { STAY: '마지막 지점에서 대기', RETURN_TO_START: '시작 지점으로 복귀', GO_TO: '지정 지점으로 이동' } as const;
/** 장치 종류 이름(서버 이유 문구의 CAMERA_RGB 같은 말도 바꿈 — U5) */
const devName = (k: string) => DEVICE[k as keyof typeof DEVICE] ?? k;
const plain = (s: string | null) => (s ?? '').replace(/CAMERA_RGB|CAMERA_DEPTH|LIDAR|BATTERY/g, devName);
const devices = (l: string[]) => (l.length ? l.map(devName).join(', ') : '없음');

// 받은 값 모양 검사 — 어긋난 응답은 오류 한 줄로(지도 탭 shape 와 같은 방식)
const str = (v: unknown) => typeof v === 'string', int = Number.isInteger, arr = Array.isArray;
const isPlan = (x: AnyPlan) => !!x && str(x.id) && str(x.name) && int(x.version) && int(x.number) && int(x.latest_version) && str(x.created_by)
  && ('steps' in x ? arr(x.steps) : arr(x.waypoints) && !!x.finish && arr(x.floor_ids) && arr(x.required_devices));
const isActs = (l: Action[]) => arr(l) && l.every((a) => !!a && str(a.key) && str(a.label) && typeof a.available === 'boolean' && arr(a.options) && !!a.params);
const isPreview = (r: ScenarioPreview) => !!r && typeof r.reachable === 'boolean' && arr(r.points) && arr(r.segments) && Number.isFinite(r.est_distance_m) && arr(r.required_devices);
const fit = <T,>(ok: (x: T) => boolean) => (x: T) => { if (!ok(x)) throw new ApiFail(0, 'BAD_SHAPE', '받은 임무·시나리오 형식이 맞지 않습니다. 잠시 뒤 다시 시도하세요.'); return x; };

/** 편집 칸이 다루는 본문(저장 요청 모양) */
function bodyOf(x: AnyPlan): AnyWrite {
  if ('steps' in x) return { name: x.name, steps: x.steps.map((s) => ({ action: s.action, params: { ...s.params } })) };
  return { name: x.name, waypoints: x.waypoints.map((w) => ({ ...w })), finish: { mode: x.finish?.mode ?? 'STAY', target: x.finish?.target ?? null }, notes: x.notes ?? '' };
}
const empty = (k: Plan): AnyWrite => (k === 'missions' ? { name: '', steps: [] } : { name: '', waypoints: [], finish: { mode: 'STAY', target: null }, notes: '' });
const same = (x: AnyPlan, b: AnyWrite) => canon(bodyOf(x)) === canon(b);
/** 저장 안 한 변경 수(단추 줄 표시) — 바뀐·늘거나 준 작업·지점 줄 + 이름·끝나면·메모가 바뀌었으면 1 */
export function changes(a: AnyWrite, b: AnyWrite) {
  const l = (x: AnyWrite): unknown[] => ('steps' in x ? x.steps : x.waypoints), p = l(a), q = l(b), rest = (x: AnyWrite) => canon({ ...x, steps: null, waypoints: null });
  let n = Math.abs(p.length - q.length);
  for (let i = 0; i < Math.min(p.length, q.length); i++) if (canon(p[i]) !== canon(q[i])) n++;
  return n + (rest(a) !== rest(b) ? 1 : 0);
}

/** 걸린 곳: at = 'name' · 'steps' · 'steps.2' · 'waypoints.3' · 'finish.target' (서버 detail.elements 앞부분과 같은 모양) */
type Bad = { at: string; text: string };
const atOf = (e: string) => /^(steps\.\d+|waypoints\.\d+|finish\.target|name)/.exec(e)?.[1] ?? e.split('.')[0];
const elementsOf = (e: ApiFail) => (arr(e.detail?.elements) ? (e.detail!.elements as unknown[]).filter(str).map((x) => atOf(x as string)) : []);

/** 저장 응답이 끊김 — 보낸 본문 + 대조 기준. known = 만들기 전 목록 ID(POST), next = 내 PUT 이 성공했다면 생긴 판 번호(그 번호는 한 번만 생긴다) */
type Unsure = { body: AnyWrite; id: string; known: string[] | null; next: number | null; match?: number };
/** 저장하지 않은 편집 — 다른 탭·다른 항목·폰 틀로 가도 남겨 다시 열면 이어 쓴다(지도 편집 kept 와 같은 생각, 확인창 없이). base = 편집을 시작한 판(If-Match 기준) */
type Draft = { body: AnyWrite; base: AnyPlan | null; unsure: Unsure | null };
type Adopt = 'all' | 'base' | 'none';
/** floor = 지도 탭에서 고른 층(''= 지도 고르기 화면), side = 오른쪽 창 [지도 요소 | 시나리오], find = sel 시나리오의 층을 찾아 열기(옛 #/mission/<id> 주소) — MAP-TAB-MERGE 11-03 */
export const keptPlan: { kind: Plan; sel: string | null; drafts: Record<string, Draft>; now: boolean; floor: string; side: Side; find: boolean } = { kind: 'scenarios', sel: null, drafts: {}, now: false, floor: '', side: 'map', find: false };
/** 로그아웃 때 비운다(session.tsx) */
export const clearPlans = () => { keptPlan.kind = 'scenarios'; keptPlan.sel = null; keptPlan.drafts = {}; keptPlan.now = false; keptPlan.floor = ''; keptPlan.side = 'map'; keptPlan.find = false; assignFor.robot = null; pane.robot = ''; };
addEventListener('beforeunload', (e) => { if (keptPlan.now || Object.keys(keptPlan.drafts).length) { e.preventDefault(); e.returnValue = ''; } });

/** 목록(오래된 것 먼저) + cursor 로 더 받기. 종류·보관 보기·거르기를 바꾸면 처음부터 — 앞 요청의 늦은 답은 버린다(결재 탭 useList 와 같다) */
function useList(kind: Plan, archived: boolean, only: { mine: boolean; floor: string } | undefined, cancel?: AbortSignal) {
  const [items, setItems] = useState<AnyPlan[]>([]), [next, setNext] = useState<string | null>(null), [busy, setBusy] = useState(true), [err, setErr] = useState(''), [n, setN] = useState(0), seq = useRef(0);
  const load = (cursor: string | null) => {
    const k = ++seq.current;
    setBusy(true); setErr('');
    if (!cursor) { setItems([]); setNext(null); }
    api.plans(kind, archived, cursor, cancel, only).then(fit((r: { items: AnyPlan[]; next_cursor: string | null }) => !!r && arr(r.items) && r.items.every(isPlan) && (r.next_cursor === null || str(r.next_cursor)))).then((r) => {
      if (k !== seq.current) return;
      setItems((o) => (cursor ? [...o, ...r.items.filter((x) => !o.some((y) => y.id === x.id))] : r.items)); setNext(r.next_cursor); setBusy(false);
    }, (e: ApiFail) => { if (k !== seq.current || e.code === 'CANCELED') return; setErr(e.message); setBusy(false); });
  };
  useEffect(() => { load(null); }, [kind, archived, only?.mine, only?.floor, n]);
  return { items, next, busy, err, more: () => load(next), again: () => setN((x) => x + 1) };
}

/** 시나리오별 배정된 로봇 이름(ACTIVE·결재 대기, 조직 전체 배정 목록에서). 목록을 받을 때마다 다시 — 받는 중 undefined, 못 받으면 null */
function useAssigned(on: boolean, busy: boolean, cancel?: AbortSignal) {
  const [by, setBy] = useState<Record<string, string[]> | null>();
  useEffect(() => {
    if (!on || busy) return;
    let live = true;
    api.assignments(null, cancel).then((l: Assignment[]) => {
      if (!arr(l) || !l.every((a) => !!a && (a.scenario_id === null || str(a.scenario_id)) && str(a.robot_name) && str(a.status))) throw new ApiFail(0, 'BAD_SHAPE', '');   // 지워진 시나리오 배정은 null(§5.1)
      const m: Record<string, string[]> = {};
      for (const a of l) if (a.scenario_id && (a.status === 'ACTIVE' || a.status === 'PENDING')) {
        const name = a.status === 'PENDING' ? `${a.robot_name}(결재 대기)` : a.robot_name;
        const k = a.scenario_id;
        if (!(m[k] ??= []).includes(name)) m[k].push(name);
      }
      if (live) setBy(m);
    }).catch((e: ApiFail) => { if (live && e.code !== 'CANCELED') setBy(null); });
    return () => { live = false; };
  }, [on, busy]);
  return by;
}

/** 지도 탭 오른쪽 «시나리오» 창의 목록(이 층 시나리오, 보관 제외 — MAP-TAB-MERGE 11-03). 서버 floor_id·mine 거르기 */
export const useScenarios = (floor: string, mine: boolean, cancel?: AbortSignal) => useList('scenarios', false, { mine, floor }, cancel);
export type ScenarioList = ReturnType<typeof useScenarios>;
/** 시나리오가 이 층에서 가리키는 지도 판이 지금 승인 판이 아니면 true(«지도 바뀜» — 저장할 때 서버가 STALE 로 알림, 여기는 표시만) */
export const oldMap = (x: Scenario, floor: string, approved: string | null) => !!approved && [...x.waypoints, ...(x.finish?.target ? [x.finish.target] : [])].some((w) => w.floor_id === floor && w.map_version_id !== approved);

/** ③ 오른쪽 «시나리오» 창: «+ 이 지도에 새 시나리오»·«임무 관리…»·«내 것만» + 이 층 목록(이름·지점·거리, 마우스를 올리면 지도에 경로) + 휴지통. open('') = 새로 */
export function ScenList({ sim, l, mine, setMine, floor, approved, open, hover, admin, robots, cancel, top }: { sim?: boolean; l: ScenarioList; mine: boolean; setMine: (m: boolean) => void; floor: string; approved: string | null;
  open: (id: string) => void; hover: (x: Scenario | null) => void; admin: () => void; robots: Robot[]; cancel?: AbortSignal; top?: ReactNode }) {
  const assigned = useAssigned(!sim, l.busy, cancel), items = l.items as Scenario[];   // 시뮬 시나리오는 배정하지 않는다(서버 409 SIM_SCENARIO_NO_ASSIGN) — 로봇 칸·배정 안내 없음
  const ask = !sim && assignFor.robot && <p className="fh-msg ok" role="status">{robots.find((r) => r.id === assignFor.robot)?.name ?? '로봇'}에 배정할 시나리오를 고르세요 — 고르면 배정 창이 열립니다.</p>;
  return <section className="mx-tab" aria-label="시나리오 목록 창">
    <div className="mx-in">
      <button type="button" className="btn pri" onClick={() => open('')}>+ 이 지도에 새 시나리오</button>
      <div className="fh-row"><label className="fh-row"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /><span>내 것만</span></label>
        <span className="fh-grow" /><button type="button" className="btn" onClick={admin}>임무 관리…</button></div>
      {top}{ask}
    </div>
    <ul className="mx-list" aria-label="시나리오 목록" onMouseLeave={() => hover(null)}>{items.map((x) => { const old = oldMap(x, floor, approved);
      return <li key={x.id} className="mx-row">
        <button type="button" className="mx-name mx-name2" data-plan={x.id} onClick={() => { hover(null); open(x.id); }} onMouseEnter={() => hover(x)} onFocus={() => hover(x)} onBlur={() => hover(null)}>
          <b>{x.name}</b>
          <small>지점 {x.waypoints.length}{x.est_distance_m > 0 ? ` · 약 ${Math.round(x.est_distance_m)} m` : ''}</small>
          <small>{old && <span className="lv-chip warn" data-old-map>지도 바뀜</span>}
            {/* 배정된 로봇이 있을 때만(빈 «없음» 줄은 뺐다 — MAPSCEN-UI) */}
            {assigned !== null && assigned?.[x.id]?.length ? <span className="lbl" data-col="robots">로봇 {assigned[x.id].join(', ')}</span> : null}
            {assigned === null && <span className="lbl" data-col="robots">로봇 ?</span>}
            {keptPlan.drafts[`scenarios:${x.id}`] && <span className="lbl">저장 안 한 편집</span>}</small>
        </button></li>; })}</ul>
    <div className="mx-in">
      {assigned === null && <p className="lv-note">배정된 로봇을 받지 못했습니다(«?»). 목록을 다시 받으면 다시 시도합니다.</p>}
      {!l.busy && !l.err && !items.length && <p className="lv-note">{mine ? '이 지도에 내 시나리오가 없습니다. «내 것만»을 끄면 다른 사람 것도 봅니다.' : '이 지도에는 시나리오가 없습니다. «+ 이 지도에 새 시나리오»로 지도에 지점을 찍어 만드세요.'}</p>}
      {l.err && <p className="fh-msg" role="alert">시나리오 목록을 받지 못했습니다. {l.err}</p>}
      {l.busy && <p className="lv-note" role="status">목록을 불러오는 중…</p>}
      {!l.busy && (l.next || l.err) && <div className="fh-row"><button type="button" className="btn" onClick={l.err && !l.items.length ? l.again : l.more}>{l.err ? '다시 시도' : '더 보기'}</button></div>}
    </div>
    <div className="mx-foot"><div className="fh-row"><TrashLink /><span className="lv-note fh-grow">다른 지도의 시나리오는 지도를 바꿔서 봅니다.</span></div></div>
  </section>;
}

/** ④ 시나리오 열림(지도 탭 안). places·treeAgain = 지도 탭의 장소 나무, floor = 지도 탭에서 고른 층(그 층 지도로 연다), side = 창 맨 위 [지도 요소 | 시나리오] 탭, close = «‹ 목록», slot = 위 단추 줄 오른쪽 자리 */
export function ScenarioEdit({ sim, id, n, user, robots, cancel, places, treeAgain, floor, slot, side, close, busy, done, top }: { sim?: boolean; id: string; n: number; user: User; robots: Robot[]; cancel?: AbortSignal; places: Place[]; treeAgain: () => void;
  floor: string; slot: HTMLElement | null; side: ReactNode; close: () => void; busy: boolean; done: (x: AnyPlan | null, m: Msg) => void; top?: ReactNode }) {
  const assigned = useAssigned(!!id && !sim, busy, cancel);
  useEffect(() => { keptPlan.kind = 'scenarios'; keptPlan.sel = id; }, [id]);
  return <Edit key={`scenarios-${id}-${id ? '' : n}`} kind="scenarios" sim={sim} id={id} user={user} robots={robots} cancel={cancel} places={places} treeAgain={treeAgain} slot={slot} pick={side} top={top} floor={floor} close={close}
    assignN={assigned && id ? assigned[id]?.length ?? 0 : undefined} done={done} />;
}

/** 임무 관리(시나리오 목록의 «임무 관리…» — 옛 임무 탭 목록): 단추 줄 «‹ 지도로»·«임무 이름 ▾»(목록·＋새·보관 보기) + 편집 */
export function MissionAdmin(c: Pick<Ctx, 'user' | 'cancel' | 'robots'> & { back: () => void }) {
  const [archived, setArchived] = useState(false), l = useList('missions', archived, undefined, c.cancel), tree = useTree(c.cancel);
  const [sel, setSel] = useState<string | null>(keptPlan.kind === 'missions' ? keptPlan.sel : null), [msg, setMsg] = useState<Msg>(null), [n, setN] = useState(0), [slot, setSlot] = useState<HTMLElement | null>(null);
  // 다른 탭에 갔다 와도 임무 관리·고른 임무 그대로(옛 임무 탭처럼) — «‹ 지도·시나리오»로 나갈 때만 시나리오로
  useEffect(() => { keptPlan.kind = 'missions'; keptPlan.sel = sel; }, [sel]);
  const places = useMemo(() => floorsOf(tree.tree), [tree.tree]);
  const open1 = sel ? l.items.find((x) => x.id === sel) : undefined, name = sel == null ? '임무 고르기' : sel ? open1?.name || '임무' : '새 임무', label = `임무 관리 › ${name}`;
  const menu = <Menu label={label} title={`임무: ${label}`}><section className="fh-form" aria-label="임무 목록" style={{ gap: 8 }}>
    <div className="fh-row"><button type="button" className="btn pri" onClick={(e) => { shut(e); setSel(''); setMsg(null); setN((x) => x + 1); }}>새 임무</button></div>
    <ul className="fh-list" aria-label="임무 목록">{l.items.map((x) => <li key={x.id}>
      <button type="button" aria-pressed={x.id === sel} data-plan={x.id} onClick={(e) => { shut(e); setSel(x.id); setMsg(null); }}>
        <b>{x.name}</b><span className="fh-grow" /><span className="lbl">{'steps' in x ? `작업 ${x.steps.length}` : ''}</span>
        {x.archived_at && <span className="lbl">보관됨</span>}{keptPlan.drafts[`missions:${x.id}`] && <span className="lbl">저장 안 한 편집</span>}
      </button></li>)}</ul>
    {!l.busy && !l.err && !l.items.length && <p className="lv-note">임무가 없습니다. «새 임무»로 사진·대기 같은 작업을 묶으세요.</p>}
    {l.err && <p className="fh-msg" role="alert">임무 목록을 받지 못했습니다. {l.err}</p>}
    {l.busy && <p className="lv-note" role="status">목록을 불러오는 중…</p>}
    {!l.busy && (l.next || l.err) && <div className="fh-row"><button type="button" className="btn" onClick={l.err && !l.items.length ? l.again : l.more}>{l.err ? '다시 시도' : '더 보기'}</button></div>}
    <hr />
    <label className="fh-row"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /><span>보관된 것도 보기</span></label>
  </section></Menu>;
  return <section className="mx" aria-label="임무 편집">
    <div className="mx-bar"><button type="button" className="btn" onClick={() => { keptPlan.kind = 'scenarios'; keptPlan.sel = null; c.back(); }}>‹ 지도·시나리오</button>{menu}<span ref={setSlot} style={{ display: 'contents' }} /></div>
    {sel == null ? <div className="mx-body"><div className="mx-map"><div className="mx-over">{msg && <Note m={msg} />}</div>
        <div className="mx-center"><p className="lv-note">위 «{label}»에서 임무를 고르거나 «새 임무»를 누르세요.</p></div></div></div>
      : <Edit key={`missions-${sel}-${sel ? '' : n}`} kind="missions" id={sel} user={c.user} robots={c.robots} cancel={c.cancel} places={places} treeAgain={tree.again} slot={slot} top={msg && <Note m={msg} />}
          done={(x, m) => { l.again(); setMsg(m); if (x && x.id !== sel) setSel(x.id); }} />}
  </section>;
}

const NOT_YET = '저장이 아직 확인되지 않았습니다. 서버가 처리하는 중일 수 있습니다. 잠시 뒤 «저장 확인»을 다시 누르세요.';
const MANY = '같은 내용의 새 항목이 여러 개 보여 이번 저장을 정할 수 없습니다. 목록에서 확인하세요.';
const CONFLICT = '다른 사람이 먼저 저장했습니다. 입력은 그대로 있습니다. «최신 내용 받기»를 누른 뒤 다시 저장하면 내 입력이 그다음 저장이 됩니다.';
const STALE = '지도가 바뀌었습니다. 지점은 그대로 두었습니다. «새 지도로 다시 확인»을 누르면 지금 승인된 지도로 다시 확인합니다.';
/** 작업·지점 줄 목록 — .fh-list 는 줄 전체가 단추인 목록 모양이라 안의 작은 단추까지 늘어난다 */
const LIST = { listStyle: 'none', margin: 0, padding: 0 } as const;
const day = (at: string) => new Date(at).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });

/** 편집 칸 하나. id '' = 새로 만들기. 최신 판을 받아 편집하고, 판 목록에서 옛 판을 고르면 읽기 전용으로 보인다.
 *  done(x, m) = 저장(x)·보관(null) 뒤 목록 다시 받기 + 안내 */
function Edit({ kind, sim, id, user, robots, cancel, places, treeAgain, done, slot, pick, top, assignN, floor, close }: { kind: Plan; sim?: boolean; id: string; user: User; robots: Robot[]; cancel?: AbortSignal; places: Place[]; treeAgain: () => void; done: (x: AnyPlan | null, m: Msg) => void;
  slot?: HTMLElement | null; pick?: ReactNode; top?: ReactNode; assignN?: number; floor?: string; close?: () => void }) {
  const key = `${kind}:${id}`, [kd] = useState(() => keptPlan.drafts[key] ?? null);
  const [latest, setLatest] = useState<AnyPlan | null>(null), [base, setBase] = useState<AnyPlan | null>(kd?.base ?? null), [body, setBody] = useState<AnyWrite | null>(kd?.body ?? (id ? null : empty(kind)));
  const [view, setView] = useState<AnyPlan | null>(null), [err, setErr] = useState<{ text: string; adopt: Adopt } | null>(null), [msg, setMsg] = useState<Msg>(kd ? { text: '저장하지 않은 편집을 이어서 씁니다.', ok: true } : null);
  const [bad, setBad] = useState<Bad[]>([]), [block, setBlock] = useState<string | null>(null), [recheck, setRecheck] = useState(0), [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false), [unsure, setUnsure] = useState<Unsure | null>(kd?.unsure ?? null), [checking, setChecking] = useState(false), [again, setAgain] = useState(false), live = useRef(true);
  const [srv, setSrv] = useState<{ key: string; r: ScenarioPreview } | null>(null), [ask, setAsk] = useState(false);
  /** 보낸(서버로 나간) 저장 — 응답 전에 칸이 내려가면 초안에 남겨 다시 열 때 확인부터 한다(두 번 저장 방지) */
  const sending = useRef<Unsure | null>(null);
  const what = WHAT[kind];

  /** 최신 판 받기. adopt = 받은 판으로 본문까지(처음 열 때), base = 기준 판만(입력 보존 — 409 뒤), none = 이어 쓰는 초안. 실패해도 그 목적 그대로 다시 받는다(입력을 덮지 않게) */
  const load = (adopt: Adopt) => api.plan(kind, id, null, cancel).then(fit(isPlan)).then((x) => {
    if (!live.current) return;
    setLatest(x); setErr(null);
    if (adopt === 'all') { setBase(x); setBody(bodyOf(x)); }
    if (adopt === 'base') { setBase(x); setConflict(false); setMsg({ text: '최신 내용을 받았습니다. 입력은 그대로입니다 — 저장하면 그다음 저장이 됩니다. 최신 내용은 «저장 기록»에서 고르면 볼 수 있습니다.', ok: true }); }
    if (adopt === 'none' && kd?.base && kd.base.version !== x.version) { setConflict(true); setMsg({ text: CONFLICT }); }
  }, (e: ApiFail) => { if (live.current && e.code !== 'CANCELED') setErr({ text: e.status === 404 ? `이 ${what}를 찾을 수 없습니다. 목록을 다시 받으세요.` : `${what}를 받지 못했습니다. ${e.message}`, adopt }); });
  useEffect(() => { live.current = true; if (id) load(kd ? 'none' : 'all'); if (kd?.unsure) check(kd.unsure); return () => { live.current = false; }; }, []);

  const archived = !!latest?.archived_at;
  const editable = !archived && (!id || !!latest), lock = busy || !!unsure;
  const dirty = !!body && (base ? !same(base, body) : canon(body) !== canon(empty(kind)));
  // 내려갈 때 남긴다(저장 안 한 편집·확인 전 저장·응답 기다리는 저장) — 저장되면 비운다
  const snap = useRef<Draft | null>(null), keep = useRef(false);
  snap.current = body && editable ? { body, base, unsure } : null; keep.current = dirty || !!unsure || busy;
  keptPlan.now = !!snap.current && keep.current;
  useEffect(() => () => {
    keptPlan.now = false;
    const d = snap.current, u = d && (d.unsure ?? sending.current);
    if (d && (u || keep.current)) keptPlan.drafts[key] = { ...d, unsure: u }; else delete keptPlan.drafts[key];
  }, []);

  const saved = (x: AnyPlan, text: string) => { snap.current = null; delete keptPlan.drafts[key];   // 새 항목은 곧 다른 key 로 다시 열려 이 칸이 다시 그려지지 않고 내려간다
    setUnsure(null); setLatest(x); setBase(x); setBody(bodyOf(x)); setBad([]); setConflict(false); setMsg({ text, ok: true }); done(x, id ? null : { text, ok: true }); };
  /** 확인 전 저장 대조: PUT = 내가 만들었을 판 번호(next)가 내 것·같은 내용이면, POST = 보내기 전 없던 내 항목 중 같은 내용이 정확히 하나면 성공. 그 밖은 확정하지 않는다 */
  const check = (u: Unsure) => {
    setChecking(true); setAgain(false);
    const hits = u.next != null
      ? api.plan(kind, u.id, u.next, cancel).then(fit(isPlan)).then((x) => (x.version_created_by === user.id && same(x, u.body) ? [x] : []), (e: ApiFail) => (e.status === 404 ? [] : Promise.reject(e)))
      : api.allPlans(kind, cancel).then((l) => l.filter((x) => isPlan(x) && !u.known!.includes(x.id) && x.created_by === user.id && same(x, u.body)));
    hits.then(async (h) => {
      if (!live.current) return;
      if (h.length !== 1) { setChecking(false); return setMsg({ text: h.length ? MANY : NOT_YET }); }
      // PUT 이 맞으면 최신 판을 다시 받아 기준으로(그 뒤 다른 판이 생겼으면 그것이 If-Match 기준이어야 한다)
      const x = u.next != null ? await api.plan(kind, u.id, null, cancel).then(fit(isPlan)) : h[0];
      if (!live.current) return;
      setChecking(false);
      saved(x, `저장된 것을 확인했습니다.${x.number !== h[0].number ? ' 그 뒤 다른 저장이 있어 최신 내용을 보입니다.' : ''}`);
    }).catch((e: ApiFail) => { if (!live.current || e.code === 'CANCELED') return; setChecking(false); setMsg({ text: `저장됐는지 확인하지 못했습니다. ${e.message} «저장 확인»을 다시 누르세요.` }); });
  };
  /** 저장 실패(응답을 받음) = 무엇이 + 어떻게 */
  const failed = (e: ApiFail, b: AnyWrite) => {
    if (e.code === 'VERSION_CONFLICT' || e.status === 428) { setConflict(true); setMsg({ text: CONFLICT }); return; }
    if (e.code === 'STALE') { setBad(elementsOf(e).map((at) => ({ at, text: '이 지점의 지도가 바뀌었습니다.' }))); setRecheck((x) => x + 1); setMsg({ text: STALE }); return; }
    if (e.status === 422) {
      const at = elementsOf(e), p = e.detail?.preview as ScenarioPreview | undefined;
      // 시나리오: 저장 때 서버가 다시 잰 결과가 앞 미리보기를 대신한다(없으면 앞 결과를 버리고 다시 확인 — 그동안 저장 막힘)
      if (kind === 'scenarios') { if (p && isPreview(p)) setSrv({ key: canon(b), r: p }); else setRecheck((x) => x + 1); }
      setBad(at.length ? at.map((a) => ({ at: a, text: a === 'name' ? '이름을 확인하세요(1~128자, 보이지 않는 글자 없이).' : kind === 'missions' ? '이 작업의 값을 확인하세요.' : '이 지점을 확인하세요.' })) : []);
      setMsg({ text: `${e.message} 표시한 곳을 고친 뒤 다시 저장하세요.` }); return;
    }
    if (e.status === 404) { setMsg({ text: `이 ${what}나 고른 층·임무를 찾을 수 없습니다. 목록을 다시 받으세요.` }); return; }
    setMsg({ text: `저장하지 못했습니다. ${e.message}` });
  };
  /** 보내기(저장). «그래도 다시 저장»(확인 뒤)도 여기로 — 확인 전엔 편집이 잠겨 보낸 내용 그대로 */
  const send = (b: AnyWrite) => {
    setBusy(true); setMsg(null); setBad([]);
    const u: Unsure = { body: b, id, known: null, next: base ? base.latest_version + 1 : null, match: base?.version };
    (base ? Promise.resolve() : api.allPlans(kind, cancel).then((l) => { u.known = l.map((x) => x.id); }))
      .then(() => {
        if (!live.current) throw new ApiFail(0, 'CANCELED', '');   // 목록을 받는 동안 내려감 — 보내지 않는다
        sending.current = u;
        return base ? api.savePlan(kind, base.id, base.version, b, cancel) : api.createPlan(kind, b, cancel);
      }).then(fit(isPlan))   // 빈·어긋난 성공 = 불확실(status 0)
      .then((x) => { sending.current = null; if (!live.current) { delete keptPlan.drafts[key]; return; } setBusy(false); saved(x, '저장했습니다.'); },
        (e: ApiFail) => {
          const was = sending.current === u;
          if (was) sending.current = null;
          // 내려간 뒤 끝남: 끊김이면 초안의 확인 전 저장을 그대로(다시 열면 확인부터), 서버가 거절했으면 생긴 것이 없으니 푼다
          if (!live.current) { const d = keptPlan.drafts[key]; if (d && was && e.status !== 0) d.unsure = null; return; }
          setBusy(false);
          if (e.code === 'CANCELED') return;
          if (!was) return setMsg({ text: `저장하지 못했습니다. 저장 전에 목록을 확인하지 못해 보내지 않았습니다. ${e.message} 다시 누르세요.` });
          if (e.status === 0) { setUnsure(u); setMsg({ text: '저장 응답을 받지 못했습니다. 저장됐을 수 있어 확인합니다. 입력은 그대로 있습니다.' }); check(u); return; }
          failed(e, b);
        });
  };
  const save = (e?: { preventDefault(): void }) => {
    e?.preventDefault();
    if (!body || lock || !editable) return;
    const b = kind === 'missions' ? missionBad(body as MissionWrite) : scenarioBad(body as ScenarioWrite);
    if (b.length) { setBad(b); setMsg({ text: b[0].text }); return; }
    if (block) return setMsg({ text: block });
    send(body);
  };
  // 임무 = 보관(되돌리는 API 없음), 시나리오 = 휴지통으로(§5.1 — 안내의 «되돌리기»·휴지통에서 복원). 둘 다 확인창을 거친다(U10). 옛 판은 계속 읽힌다
  const scen = kind === 'scenarios', drop = scen ? '삭제' : '보관';
  const archive = () => {
    setBusy(true); setMsg(null);
    api.archivePlan(kind, id, cancel).then(() => load('all').then(() => { if (!live.current) return; setBusy(false); snap.current = null; delete keptPlan.drafts[key];
      done(null, scen ? { text: '휴지통으로 옮겼습니다.', ok: true, act: { label: '되돌리기', run: restore } } : { text: '보관했습니다. «보관된 것도 보기»에서 저장 기록을 계속 볼 수 있습니다.', ok: true }); }),
      (e: ApiFail) => { if (!live.current || e.code === 'CANCELED') return; setBusy(false); setMsg({ text: e.status === 0 ? `${drop} 응답을 받지 못했습니다. 목록을 다시 받아 확인하세요.` : `${drop}하지 못했습니다. ${scen ? trashFail(e) : e.message}` }); if (e.status === 0) done(null, null); });
  };
  /** 휴지통에서 꺼내기(시나리오) — 서버가 본체 version 을 올리므로 최신 판을 다시 받는다 */
  const restore = () => {
    setBusy(true); setMsg(null);
    api.restore('scenario', id, cancel).then(() => load('all').then(() => { if (!live.current) return; setBusy(false); done(null, { text: '시나리오를 되돌렸습니다.', ok: true }); }),
      (e: ApiFail) => { if (!live.current || e.code === 'CANCELED') return; setBusy(false); setMsg({ text: `되돌리지 못했습니다. ${trashFail(e)}` }); });
  };
  const pickVersion = (n: number) => {
    if (!latest || n === latest.latest_version) return setView(null);
    api.plan(kind, id, n, cancel).then(fit(isPlan)).then((x) => live.current && setView(x), (e: ApiFail) => { if (live.current && e.code !== 'CANCELED') setMsg({ text: `${n}번째 저장 내용을 받지 못했습니다. ${e.message}` }); });
  };

  const retry = err && <div className="fh-row"><p className="fh-msg" role="alert">{err.text}</p><button type="button" className="btn" onClick={() => { setErr(null); load(err.adopt); }}>다시 받기</button></div>;
  const [moreSlot, setMoreSlot] = useState<HTMLElement | null>(null);
  if (!body) return <div className="mx-body"><div className="mx-map"><div className="mx-over">{top}{retry}</div>{!retry && <div className="mx-center"><p className="lv-note" role="status">불러오는 중…</p></div>}</div></div>;
  const shown = view ? bodyOf(view) : body, ro = !!view || !editable;
  const put = (b: AnyWrite) => { if (lock || ro) return; setBody(b); setBad([]); setMsg(null); };
  const nameBadNow = bad.find((b) => b.at === 'name');
  const verLabel = latest ? (view ? `${view.number}번째 저장 · 보기만` : `${latest.latest_version}번째 저장`) : '';
  // 저장 기록 고르기(옛 판은 읽기 전용) — 임무는 단추 줄 메뉴, 시나리오는 오른쪽 창 칸(MAP-TAB-MERGE ④). 목록엔 판 번호만 있어 «N번째 저장»으로 부른다
  const verSel = latest && <select className="inp" aria-label="저장 기록" value={view?.number ?? latest.latest_version} onChange={(e) => { pickVersion(Number(e.target.value)); shut(e); }}>
    {Array.from({ length: latest.latest_version }, (_, i) => latest.latest_version - i).map((n) => <option key={n} value={n}>{`${n}번째 저장${n === latest.latest_version ? ' (최신)' : ''}`}</option>)}</select>;
  const more = (scen || (!ro && id)) && <Menu label="···" title="더 보기" end className="more">
    {scen && <div ref={setMoreSlot} style={{ display: 'contents' }} />}
    {!ro && id && <button type="button" className="btn" disabled={lock || ask} onClick={(e) => { shut(e); setAsk(true); }}>{drop}</button>}
  </Menu>;
  const n = dirty && body ? changes(base ? bodyOf(base) : empty(kind), body) : 0;
  // 단추 줄(부모가 준 자리): 임무 = 저장 기록 메뉴·«···»·저장, 시나리오 = «저장 안 한 변경 N»·되돌리기·저장(«···»는 오른쪽 창 머리)
  const bar = slot && createPortal(<>
    {!scen && latest && <Menu label={verLabel} title={`저장 기록: ${verLabel}`}><label className="fh-field"><span>저장 기록(옛 기록은 읽기 전용)</span>{verSel}</label></Menu>}
    <span className="fh-grow" />
    {scen && !ro && n > 0 && <><span className="mx-tag" data-changes>저장 안 한 변경 {n}</span>
      <button type="button" className="btn" disabled={lock} title="마지막으로 저장한 내용으로 되돌립니다" onClick={() => put(base ? bodyOf(base) : empty(kind))}>되돌리기</button></>}
    {!scen && more}
    {!ro && <button type="button" className="btn pri" disabled={lock || (scen && !!block)} aria-describedby={scen && block ? 'plan-block' : undefined} title={scen && block ? block : undefined} onClick={save}>저장</button>}
  </>, slot);
  // 알림 띠(생길 때만) — 시나리오는 지도 위 왼쪽 위, 임무는 칸 맨 위
  const notices = <>
    {top}{retry}
    {view && <p className="lv-note" role="status" data-old>옛 기록({view.number}번째 저장)을 보는 중입니다(읽기 전용, {day(view.version_created_at)} 저장). 고치려면 «저장 기록»에서 최신을 고르세요.</p>}
    {!view && archived && (scen ? <div className="fh-row"><p className="lv-note fh-grow" data-readonly>휴지통에 있는 시나리오입니다. 고칠 수 없고 저장 기록은 볼 수 있습니다 — 복원하면 다시 고칩니다.</p>
        <button type="button" className="btn" disabled={busy} onClick={restore}>복원</button></div>
      : <p className="lv-note" data-readonly>보관된 {what}입니다. 고칠 수 없고 저장 기록은 볼 수 있습니다.</p>)}
    {!ro && ask && <div className="fh-row" role="group" aria-label={`${drop} 확인`}><span>{scen ? '이 시나리오를 휴지통으로 옮길까요? 목록에서 빠지고, 휴지통에서 복원하거나 완전 삭제할 수 있습니다.'
        : `이 ${what}를 보관할까요? 보관하면 되돌릴 수 없습니다 — 목록에서 빠지고 더는 고칠 수 없습니다. 저장 기록은 «보관된 것도 보기»에서 볼 수 있습니다.`}</span>
      <button type="button" className="btn pri" disabled={lock} onClick={() => { setAsk(false); archive(); }}>{scen ? '휴지통으로' : '보관하기'}</button>
      <button type="button" className="btn" onClick={() => setAsk(false)}>취소</button></div>}
    {busy && <p className="lv-note" role="status">저장하는 중…</p>}
    {msg && <Note m={msg} />}
    {!ro && conflict && <div className="fh-row" data-conflict><button type="button" className="btn" disabled={lock} onClick={() => load('base')}>최신 내용 받기</button></div>}
    {unsure && <div className="fh-row"><button type="button" className="btn" disabled={checking} onClick={() => check(unsure)}>저장 확인</button>
      <button type="button" className="btn" disabled={checking || again} onClick={() => setAgain(true)}>다시 저장</button>
      {checking && <span className="lv-note" role="status">저장됐는지 확인하는 중…</span>}</div>}
    {unsure && again && <div className="fh-row" role="group" aria-label="다시 저장 확인"><span>이미 저장됐을 수 있습니다. 다시 보내면 같은 {what}가 두 번 생길 수 있어요 — 목록에서 먼저 확인하세요.</span>
      <button type="button" className="btn pri" onClick={() => { const u = unsure; setUnsure(null); setAgain(false); send(u.body); }}>그래도 다시 저장</button>
      <button type="button" className="btn" onClick={() => setAgain(false)}>닫기</button></div>}
  </>;
  const h2 = <h2 className="mx-sr">{id ? shown.name || what : `새 ${what}`}</h2>;
  const nameField = <label className="fh-field"><span>이름</span><input className="inp" data-name maxLength={128} value={shown.name} readOnly={ro} aria-invalid={!!nameBadNow} onChange={(e) => put({ ...body, name: e.target.value })} /></label>;
  if (kind === 'missions') return <div className="mx-body" aria-label={`${what} 편집 칸`}>{bar}
    <div className="mx-scroll"><div className="fh-form" style={{ maxWidth: 760, width: '100%', margin: '0 auto' }}>{h2}{notices}
      {/* 저장 중·저장 확인 전에는 입력을 모두 막는다(보낸 내용과 초안이 달라지지 않게). STOP 은 App 머리줄 그대로 */}
      <fieldset disabled={lock && !ro} style={{ display: 'contents' }}>{nameField}
        <MissionForm value={shown as MissionWrite} set={ro ? undefined : (b) => put(b)} bad={view ? [] : bad} robots={robots} user={user} cancel={cancel} /></fieldset>
    </div></div></div>;
  // 배정은 저장된 판만 간다 — 저장 안 한 편집이 있으면 어느 판이 가는지 바로 위에 알린다
  // 시뮬 시나리오 = 배정·결재 없이 «시뮬에서 실행»(SIM-REAL-SPLIT 결정 ④)
  const assign = !sim && id && latest ? <>{!view && dirty && <p className="fh-why" role="status" data-unsaved-assign>저장하지 않은 편집이 있습니다 — 배정하면 마지막으로 저장한 내용({latest.latest_version}번째 저장)이 배정됩니다. 고친 내용을 배정하려면 먼저 «저장»을 누르세요.</p>}
    <AssignPanel scenario={id} name={latest.name} version={view?.number ?? latest.latest_version} archived={archived} user={user} robots={robots} cancel={cancel} /></> : null;
  return <div className="mx-body" aria-label={`${what} 편집 칸`}>{bar}{h2}
    <ScenarioForm key={view ? `v${view.number}` : 'draft'} value={shown as ScenarioWrite} set={ro ? undefined : (b) => put(b)} lock={lock} bad={view ? [] : bad} places={places} treeAgain={treeAgain}
      cancel={cancel} setBlock={setBlock} recheck={recheck} srv={view ? null : srv} saved={(view ?? (id ? latest : null)) as Scenario | null} robots={robots} user={user}
      picker={pick} moreSlot={moreSlot} over={notices} nameField={nameField} assign={assign} sim={sim ? { dirty } : undefined} assignN={assignN} floor={floor} close={close} more={more}
      verField={latest && <label className="fh-field"><span>저장 기록(옛 기록은 읽기 전용)</span>{verSel}</label>}
      blockNote={!ro && block && !lock ? <p id="plan-block" className="fh-why" data-block>{block}</p> : null} />
  </div>;
}

// ── 시뮬에서 실행(SIM-REAL-SPLIT 11-09) ──────────────────
/** 시뮬 사슬: 저장한 시나리오 → bt.js 나무(scenarioTree·validateTree) → 이 브라우저 fh.btMission.<id> → 시뮬 ?bt=<id>(시뮬 쪽 그대로). 이동은 simNav.go(시험이 바꿔 끼움) */
export const simNav = { go: (url: string) => location.assign(url) };
/** 지형 층: 서버 지도 판 격자 = 지형 크기로 만든 시뮬 격자(서버 terrain_grid·mobile/sim/terrain buildTerrain — 해상도 0.05, 원점 −가로/2·−세로/2)인지 */
const terrainFits = (t: Terrain, v: MapVersion) => { const [sx, sy] = t.spec.size, r = 0.05;
  return v.resolution === r && v.origin[0] === -sx / 2 && v.origin[1] === -sy / 2 && v.origin[2] === 0 && v.width === Math.ceil(sx / r) && v.height === Math.ceil(sy / r); };
const differs = (raw: string, spec: unknown) => { try { return canon(JSON.parse(raw)) !== canon(spec); } catch { return true; } };
const readLocal = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
/** 층(승인 판) → 시뮬 열 곳 + 지형 확인 — SimRun «시뮬에서 실행»·층 화면 «시뮬 열기»가 같은 규칙을 쓴다.
 *  at = simAt(문자열이면 못 여는 이유), terWhy = 지형 층 확인 이유('' = 됨), url = 열 주소(?bt 없이), prep() = 누르는 순간 지형 사본 쓰기 → 실패 이유 또는 '' */
function useSimAt(f?: MapFloor, v?: MapVersion, cancel?: AbortSignal) {
  const at = f && v ? simAt(f, v) : null, tid = at && typeof at !== 'string' ? at.terrain : undefined;
  const [ter, setTer] = useState<Terrain | string | null>(null);
  useEffect(() => { setTer(null); if (!tid) return; let live = true;
    api.terrain(tid, cancel).then((t) => { if (live) setTer(t); }, (e: ApiFail) => { if (live && e.code !== 'CANCELED') setTer(`지형을 받지 못했습니다. ${e.message}`); });
    return () => { live = false; }; }, [tid]);
  const local = tid ? readLocal(keyOf(tid)) : null;
  const terWhy = !v || !tid ? '' : !ter ? '지형을 받는 중입니다.' : typeof ter === 'string' ? ter
    : ter.map_version_id !== v.id ? '이 지형의 서버 지도는 지금 판이 아닙니다(지형 저장 뒤 다른 판이 올라옴) — «지형 만들기»에서 다시 저장하세요.'
    : !terrainFits(ter, v) ? '지형과 지도 좌표가 다릅니다(지형을 바꾼 뒤 지도를 다시 만들지 않음) — «지형 만들기»에서 다시 저장하세요.'
    : local != null && differs(local, ter.spec) ? '이 브라우저에 이 지형의 다른 편집본이 있어 덮지 않습니다 — «지형 만들기»에서 저장하거나 서버 판을 연 뒤 다시 누르세요.'
    : '';
  const prep = () => {
    if (!ter || typeof ter === 'string') return '';
    // 누르는 순간 다시 읽는다(렌더 뒤 다른 탭이 편집본·:base 를 만들었을 수 있음 — #303 보호): 둘 다 없을 때만 서버 판을 쓰고,
    // 편집본이 서버와 같으면 아무것도 안 쓰고, 그 밖(다른 편집본·편집본 없이 :base 만)은 쓰지도 옮기지도 않는다
    const k = keyOf(ter.spec.id), now = readLocal(k), base = readLocal(`${k}:base`);
    if (now == null ? base != null : differs(now, ter.spec)) return '방금 이 브라우저에 이 지형의 다른 편집본이 생겼습니다 — 덮지 않고 멈췄습니다. «지형 만들기»에서 저장하거나 서버 판을 연 뒤 다시 누르세요.';
    if (now == null) try { localStorage.setItem(k, JSON.stringify(ter.spec)); localStorage.setItem(`${k}:base`, String(ter.version)); }
    catch { return '이 브라우저 저장소에 지형을 쓰지 못했습니다(사생활 창일 수 있음).'; }
    return '';
  };
  const url = !at || typeof at === 'string' ? '' : tid ? terrainUrl(tid) : openUrl(at.map, at.floor, null);
  return { at, terWhy, prep, url };
}
function SimRun({ value, saved, dirty, place, v, missions, cancel }: { value: ScenarioWrite; saved: Scenario | null; dirty: boolean; place?: Place; v?: MapVersion; missions: Mission[] | null; cancel?: AbortSignal }) {
  const f = place?.floor, o = useSimAt(f, v, cancel), at = o.at, [err, setErr] = useState('');
  const pts = [...value.waypoints, ...(value.finish?.target ? [value.finish.target] : [])];
  const tree = missions ? scenarioTree(value, missions) : '임무 목록을 받는 중입니다.';
  const why = !saved ? '저장한 시나리오만 시뮬에서 실행합니다 — 먼저 «저장»을 누르세요.' : dirty ? '저장하지 않은 편집이 있습니다 — 저장한 뒤 실행하세요.'
    : !pts.length ? '지점이 없습니다.' : !f ? '층을 찾지 못했습니다.' : pts.some((p) => p.floor_id !== f.id) ? '여러 층 시나리오는 시뮬에서 실행할 수 없습니다.'
    : !v ? '지도를 불러오는 중입니다.' : pts.some((p) => p.map_version_id !== v.id) ? '지도가 바뀌었습니다 — 지금 지도로 다시 저장한 뒤 실행하세요.'
    : typeof at === 'string' ? at : typeof tree === 'string' ? tree : o.terWhy;
  const run = () => {
    if (why || !saved || !at || typeof at === 'string' || typeof tree === 'string') return;
    const id = simId(saved.id), no = o.prep();
    if (no) return setErr(no);
    if (!saveSim({ id, name: value.name, map: at.map, floor: at.floor, tree, scenario_id: saved.id })) return setErr('이 브라우저 저장소에 임무를 쓰지 못했습니다(사생활 창일 수 있음).');
    simNav.go(`${o.url}&bt=${id}`);
  };
  return <div className="mx-in" data-sim-run>
    <div className="fh-row"><button type="button" className="btn pri" disabled={!!why} aria-describedby={why ? 'sim-run-why' : undefined} onClick={run}>시뮬에서 실행</button>
      <span className="lv-note fh-grow">배정·결재 없이 이 브라우저 시뮬에서 엽니다.</span></div>
    {why && <p id="sim-run-why" className="fh-why" data-sim-run-why>{why}</p>}
    {err && <p className="fh-msg" role="alert">{err}</p>}
  </div>;
}

/** 층 화면 위 띠 «시뮬 열기»(SIM-TAB-CHOOSER 11-09): 승인 판을 simAt 규칙대로 — 시뮬 세계 층 = 그 map·floor, 지형 층 = map=custom&terrain=. 못 열면 꺼짐 + 이유.
 *  ponytail: 시작 위치 찍기는 없음(기본 시작 지점) — 시뮬 안 «여기서 다시 시작»으로 옮긴다. 층 지도에서 찍으려면 MapFrame 누름 → 판 좌표 + blocked() */
export function SimOpen({ f, v, wait, cancel }: { f: MapFloor; v: MapVersion | null; wait: boolean; cancel?: AbortSignal }) {
  const o = useSimAt(f, v ?? undefined, cancel), [err, setErr] = useState('');
  const why = !v ? (wait ? '지도를 불러오는 중입니다.' : '이 층에는 아직 지도가 없어 시뮬로 열 수 없습니다.') : typeof o.at === 'string' ? o.at : o.terWhy, say = err || why;
  return <>
    <button type="button" className="btn pri" disabled={!!why} aria-describedby={say ? 'sim-open-why' : undefined} data-sim-open
      onClick={() => { const no = o.prep(); setErr(no); if (!no) simNav.go(o.url); }}>시뮬 열기</button>
    {say && <span id="sim-open-why" className="mx-tag mx-why" role={err ? 'alert' : 'status'} title={say} data-sim-open-why>{say}</span>}
  </>;
}

// ── 임무 ──────────────────────────────────────────────
/** 저장 전 검사 — 서버(MissionWrite·작업 인자 범위)와 같게 */
function missionBad(v: MissionWrite): Bad[] {
  const out: Bad[] = [], nb = nameBad(v.name);
  if (nb) out.push({ at: 'name', text: nb });
  if (!v.steps.length) out.push({ at: 'steps', text: '작업을 하나 이상 추가하세요.' });
  if (v.steps.length > 100) out.push({ at: 'steps', text: '작업은 100개까지 넣을 수 있습니다.' });
  v.steps.forEach((s, i) => {
    const p = s.params ?? {}, sec = p.seconds;
    if ('seconds' in p && !(int(sec) && (sec as number) >= 1 && (sec as number) <= 3600)) out.push({ at: `steps.${i}`, text: `${i + 1}번 작업: 시간은 1~3600초 사이 정수로 입력하세요.` });
    if (s.action === 'OPERATOR_CONFIRM') {
      const t = String(p.prompt ?? ''), r = reasonBad(t, '확인 문구') ?? ([...t].length > 500 ? '확인 문구는 500자까지 쓸 수 있습니다.' : null);
      if (r) out.push({ at: `steps.${i}`, text: `${i + 1}번 작업: ${r}` });
    }
  });
  return out;
}
/** 작업 한 줄 요약(읽기 전용·옛 판) */
const stepText = (s: MissionStep) => { const p = s.params ?? {};
  return [p.camera ?? p.device, p.seconds, p.prompt].filter((x) => x != null).map((x) => (typeof x === 'number' ? `${x}초` : VALUE[String(x)] ?? `«${x}»`)).join(' · '); };

/** 장치·실행 확인에 고를 수 있는 로봇 — 담당 밖 로봇은 서버가 404, 끝낸 시뮬 슬롯은 고르지 않음 */
const pickable = (robots: Robot[], user: User) => robots.filter((r) => !idleSim(r) && (user.role === 'ORG_ADMIN' || r.owner === user.id));
/** 작업 카탈로그(GET /actions). 받은 로봇에 묶는다 — 로봇을 바꾼 뒤 새 답이 오기 전·못 받았을 때 acts 는 null(앞 로봇 카탈로그로 판단하지 않게). on = false 면 받지 않음 */
function useActs(robot: string, cancel?: AbortSignal, on = true) {
  const [cat, setCat] = useState<{ robot: string; l: Action[] } | null>(null), [err, setErr] = useState(''), [n, setN] = useState(0);
  useEffect(() => {
    if (!on) return;
    let live = true;
    setErr(''); setCat(null);
    api.actions(robot || null, cancel).then(fit(isActs)).then((l) => { if (live) setCat({ robot, l }); }, (e: ApiFail) => { if (live && e.code !== 'CANCELED') setErr(e.message); });
    return () => { live = false; };
  }, [robot, n, on]);
  return { acts: cat?.robot === robot && !err ? cat.l : null, err, again: () => setN((x) => x + 1) };
}

/** 작업 단계(01 MS-01·09): 카탈로그(GET /actions)에서 고르고 인자를 넣는다. 로봇을 고르면 그 로봇 장치로 할 수 없는 작업·선택지는 회색 + 이유(고를 수 없음) */
function MissionForm({ value, set, bad, robots, user, cancel }: { value: MissionWrite; set?: (v: MissionWrite) => void; bad: Bad[]; robots: Robot[]; user: User; cancel?: AbortSignal }) {
  // 카탈로그를 받기 전·못 받았을 때는 추가·선택지를 잠근다
  const [robot, setRobot] = useState(''), { acts, err, again } = useActs(robot, cancel), mineRobots = pickable(robots, user);
  const steps = value.steps, put = (s: MissionStep[]) => set?.({ ...value, steps: s }), actOf = (k: string) => acts?.find((a) => a.key === k);
  const swap = (i: number, s: MissionStep) => put(steps.map((o, k) => (k === i ? s : o)));
  const move = (i: number, d: number) => { const s = [...steps], [x] = s.splice(i, 1); s.splice(i + d, 0, x); put(s); };
  const add = (a: Action) => {
    const params = { ...a.params }, o = a.options.find((x) => x.value === params[x.param]);
    if (o && !o.available) { const ok = a.options.find((x) => x.available); if (ok) params[ok.param] = ok.value; }   // 기본 선택지를 이 로봇이 못 하면 할 수 있는 것으로
    put([...steps, { action: a.key, params }]);
  };
  const num = (s: string) => (s.trim() === '' ? NaN : Number(s));
  const listBad = bad.find((b) => b.at === 'steps');
  return <>
    <h3>작업 단계</h3>
    {set && <label className="fh-field"><span>장치 확인할 로봇(고르면 그 로봇이 못 하는 작업은 회색)</span>
      <select className="inp" value={robot} onChange={(e) => setRobot(e.target.value)}><option value="">고르지 않음</option>{mineRobots.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>}
    {err && <div className="fh-row"><p className="fh-msg" role="alert">작업 목록을 받지 못했습니다. {err} 받기 전에는 작업을 추가하거나 장치를 고를 수 없습니다.</p><button type="button" className="btn" onClick={again}>다시 받기</button></div>}
    <ol className="fh-form" style={LIST} aria-label="작업 단계">{steps.map((s, i) => {
      const a = actOf(s.action), p = s.params ?? {}, opt = a?.options.find((o) => o.value === p[o.param]), sb = bad.filter((b) => b.at === `steps.${i}`);
      return <li key={i} data-step={i} data-bad={sb.length ? '' : undefined} style={sb.length ? { outline: '2px solid var(--bad)', borderRadius: 8 } : undefined}>
        <div className="fh-row"><b>{i + 1}. {a?.label ?? ACT[s.action] ?? s.action}</b>{!set && <span className="lbl">{stepText(s)}</span>}<span className="fh-grow" />
          {set && <><button type="button" className="btn" aria-label={`${i + 1}번 작업 위로`} disabled={!i} onClick={() => move(i, -1)}>↑</button>
            <button type="button" className="btn" aria-label={`${i + 1}번 작업 아래로`} disabled={i === steps.length - 1} onClick={() => move(i, 1)}>↓</button>
            <button type="button" className="btn" aria-label={`${i + 1}번 작업 지우기`} onClick={() => put(steps.filter((_, k) => k !== i))}>지우기</button></>}</div>
        {set && <div className="fh-row" style={{ flexWrap: 'wrap' }}>
          {(s.action === 'PHOTO' || s.action === 'SENSOR_LOG') && (() => { const param = s.action === 'PHOTO' ? 'camera' : 'device', opts = a?.options.filter((o) => o.param === param);
            return <label className="fh-field"><span>{s.action === 'PHOTO' ? '카메라' : '장치'}</span>
              <select className="inp" value={String(p[param] ?? '')} disabled={!acts} onChange={(e) => swap(i, { ...s, params: { ...p, [param]: e.target.value } })}>
                {(opts ?? (s.action === 'PHOTO' ? ['rgb', 'depth'] : ['rgb', 'depth', 'lidar', 'battery']).map((value) => ({ value, available: true }))).map((o) =>
                  <option key={o.value} value={o.value} disabled={!o.available}>{VALUE[o.value]}{o.available ? '' : ' — 할 수 없음'}</option>)}</select></label>; })()}
          {'seconds' in p && <label className="fh-field"><span>{s.action === 'WAIT' ? '기다릴 시간(초, 1~3600)' : '기록 시간(초, 1~3600)'}</span>
            <input className="inp" type="number" min={1} max={3600} step={1} inputMode="numeric" value={Number.isFinite(p.seconds as number) ? String(p.seconds) : ''} onChange={(e) => swap(i, { ...s, params: { ...p, seconds: num(e.target.value) } })} /></label>}
          {s.action === 'OPERATOR_CONFIRM' && <label className="fh-field" style={{ flex: 1 }}><span>확인 문구(운영자에게 보일 질문)</span>
            <input className="inp" maxLength={500} value={String(p.prompt ?? '')} onChange={(e) => swap(i, { ...s, params: { ...p, prompt: e.target.value } })} /></label>}
        </div>}
        {set && a?.options.filter((o) => !o.available).map((o) => <span key={o.value} className="fh-why" data-why>{VALUE[o.value]}: {plain(o.why_unavailable)}</span>)}
        {opt && !opt.available && <p className="fh-msg" role="alert">고른 {VALUE[opt.value]}는 이 로봇으로 할 수 없습니다. 다른 선택지를 고르세요.</p>}
        {sb.map((b, k) => <p key={k} className="fh-msg" role="alert">{b.text}</p>)}
      </li>; })}</ol>
    {!steps.length && <p className="lv-note">아래에서 작업을 골라 추가하세요.</p>}
    {listBad && <p className="fh-msg" role="alert">{listBad.text}</p>}
    {set && acts && <div className="fh-form" role="group" aria-label="작업 추가">{acts.map((a) => <div key={a.key} className="fh-row">
      {!(a.key in ACT) ? <span className="fh-why" data-why>{a.label}: 지원 전 작업입니다. 이 화면에서는 아직 넣을 수 없습니다.</span> : <>   {/* 계약 밖 작업은 편집·전송하지 않는다 */}
        <button type="button" className="btn" disabled={!a.available || steps.length >= 100} aria-describedby={a.available ? undefined : `act-${a.key}`} onClick={() => add(a)}>＋ {a.label}</button>
        {!a.available && <span id={`act-${a.key}`} className="fh-why" data-why>{plain(a.why_unavailable)}</span>}</>}</div>)}</div>}
    {set && !acts && !err && <p className="lv-note" role="status">작업 목록을 불러오는 중…</p>}
  </>;
}

// ── 시나리오 ──────────────────────────────────────────
function scenarioBad(v: ScenarioWrite): Bad[] {
  const out: Bad[] = [], nb = nameBad(v.name);
  if (nb) out.push({ at: 'name', text: nb });
  if (v.waypoints.length > 200) out.push({ at: 'waypoints', text: '지점은 200개까지 찍을 수 있습니다.' });
  return out;
}
const MISSING = (v: ScenarioWrite) => (!v.waypoints.length ? '지도를 눌러 지점을 하나 이상 찍으세요.' : v.waypoints.some((w) => !w.mission_id) ? '모든 지점에 할 일을 고르세요.'
  : v.finish?.mode === 'GO_TO' && !v.finish.target ? '끝나고 갈 지점을 지도에서 찍으세요.' : null);
const TAP = 8;   // 화면 px — MapFrame SLOP 과 같다. 찍힌 지점을 누르고 이만큼 움직이기 전에 떼면 누름(고르기), 넘으면 끌어 옮기기
/** 단계 창 펼침·실행 확인할 로봇 — 다른 시나리오를 열어도 사람이 고른 그대로(로봇은 로그아웃 때 비움) */
const pane = { open: true, robot: '' };
/** 지점 할 일(11-04): 이동·사진 찍기·대기 셋. 이동 = 단계 없는 임무(멈추지 않고 지나감). 깊이 사진은 저장 형식이 없어 내지 않는다 */
const quickSteps = (k: string, seconds = 30): MissionStep[] => (k === 'MOVE' ? [] : k === 'PHOTO' ? [{ action: 'PHOTO', params: { camera: 'rgb' } }] : [{ action: 'WAIT', params: { seconds } }]);
const quickName = (s?: MissionStep) => (!s ? '이동' : s.action === 'PHOTO' ? '사진 찍기(RGB)' : `대기 ${s.params?.seconds}초`);
const isMove = (m: Mission) => !m.steps.length;
/** 임무가 셋 중 무엇인지. 그 밖(여러 단계·보관됨·내용 모르는 옛 판) = OTHER */
const kindOf = (m?: Mission) => (!m || m.archived_at ? 'OTHER' : isMove(m) ? 'MOVE' : m.steps.length === 1 && m.steps[0].action === 'PHOTO' && m.steps[0].params?.camera === 'rgb' ? 'PHOTO' : waitOf(m) ? 'WAIT' : 'OTHER');
/** 임무가 하는 일 짧게(지점 카드): «이동», «사진», «대기 30초» */
const doText = (m: Mission) => (isMove(m) ? '이동 — 멈추지 않고 지나감' : '') + m.steps.map((s) => (s.action === 'PHOTO' ? (s.params?.camera === 'depth' ? '뎁스 사진' : '사진') : s.action === 'WAIT' ? `대기 ${s.params?.seconds}초` : ACT[s.action] ?? s.action)).join(' → ');
/** 한 단계 대기 임무면 그 초 */
const waitOf = (m?: Mission) => (m && m.steps.length === 1 && m.steps[0].action === 'WAIT' && int(m.steps[0].params?.seconds) ? m.steps[0].params!.seconds as number : null);
/** 대기 초 바꾸기 — «적용»을 눌러야 그 초의 임무를 찾거나 만든다(글자마다 임무를 만들지 않게) */
function WaitSecs({ i, sec, apply }: { i: number; sec: number; apply: (n: number) => void }) {
  const [v, setV] = useState(String(sec)), n = Number(v), ok = int(n) && n >= 1 && n <= 3600;
  useEffect(() => setV(String(sec)), [sec]);
  return <div className="fh-row"><label className="fh-row"><span className="lbl">대기(초, 1~3600)</span>
    <input className="inp" type="number" min={1} max={3600} step={1} inputMode="numeric" aria-label={`${i + 1}번 지점 대기 초`} style={{ width: '6em' }} value={v} onChange={(e) => setV(e.target.value)} /></label>
    {n !== sec && <button type="button" className="btn" disabled={!ok} onClick={() => apply(n)}>적용</button>}
    {!ok && <span className="fh-why">1~3600 사이 정수로 입력하세요.</span>}</div>;
}
const elName = (e: string) => (e === 'finish.target' ? '끝 지점' : /^waypoints\.(\d+)/.test(e) ? `${Number(/^waypoints\.(\d+)/.exec(e)![1]) + 1}번 지점` : e);

/** 시나리오 편집(02 F-MS-02·03, 03 §5.3): ① 지도(승인 판이 있는 층) ② 지점(지도 눌러 추가·끌어 옮기기·고른 지점 오른쪽 위 X 로 지우기, 오른쪽 단계 창에서 순서·임무·지우기, 이름 붙은 지도 지점은 waypoint_ref) ③ 확인(서버 미리보기).
 *  set 없음 = 읽기 전용(옛 판·보관) — 미리보기 대신 저장된 거리·장치, 지도는 지점이 가리키는 판. setBlock = 저장을 막는 이유(갈 수 없는 지점·확인 전),
 *  recheck = 저장이 STALE·422 로 막혀 다시 미리보기, srv = 저장 422 에 서버가 실어 보낸 미리보기(그 본문의 결과) */
function ScenarioForm({ value, set, lock, bad, places, treeAgain, cancel, setBlock, recheck, srv, saved, robots, user, picker, moreSlot, over, nameField, assign, assignN, blockNote, floor, close, more, verField, sim }: { sim?: { dirty: boolean }; value: ScenarioWrite; set?: (v: ScenarioWrite) => void; lock: boolean; bad: Bad[]; places: Place[]; treeAgain: () => void;
  cancel?: AbortSignal; setBlock: (s: string | null) => void; recheck: number; srv: { key: string; r: ScenarioPreview } | null; saved: Scenario | null; robots: Robot[]; user: User;
  picker?: ReactNode; moreSlot: HTMLElement | null; over: ReactNode; nameField: ReactNode; assign: ReactNode; assignN?: number; blockNote: ReactNode; floor?: string; close?: () => void; more?: ReactNode; verField?: ReactNode }) {
  const pts = value.waypoints, finish = value.finish ?? { mode: 'STAY', target: null }, target = finish.target ?? null;
  // 처음 보이는 층 = 지도 탭에서 고른 층(MAP-TAB-MERGE) — 없으면 첫 지점의 층, 그것도 없으면 승인 판이 있는 첫 층
  const [cur, setCur] = useState(() => floor || (pts[0]?.floor_id ?? places.find((p) => p.floor.approved_version_id)?.floor.id ?? ''));
  useEffect(() => { if (!cur) setCur(pts[0]?.floor_id ?? places.find((p) => p.floor.approved_version_id)?.floor.id ?? ''); }, [places.length]);
  // 편집 = 지금 승인 판(STALE 은 미리보기·저장이 알린다), 읽기 전용(옛 판·보관) = 이 층 지점이 가리키는 판 — 과거 좌표를 다른 지도 위에 그리지 않는다
  const own = set ? undefined : [...pts, ...(target ? [target] : [])].find((p) => p.floor_id === cur)?.map_version_id;
  const place = places.find((p) => p.floor.id === cur), vid = own ?? place?.floor.approved_version_id ?? null;
  const [maps, setMaps] = useState<Record<string, MapVersion>>({}), [mapErr, setMapErr] = useState(''), [mapN, setMapN] = useState(0);
  useEffect(() => {
    if (!vid || maps[vid]) return;
    setMapErr('');
    api.version(vid, cancel).then(shape(isVersion)).then((x) => setMaps((m) => ({ ...m, [vid]: x })), (e: ApiFail) => { if (e.code !== 'CANCELED') setMapErr(e.message); });
  }, [vid, mapN]);
  const v = vid ? maps[vid] : undefined;
  const look = useFit(v);
  // 임무 고르기: 보관 안 된 임무의 최신 판. 이미 고른 옛 판·보관된 임무는 그 지점에만 그대로 보인다
  // unsure = 바로 고르기 생성 응답이 끊겨 만들어졌는지 모름 — 그 뒤 시작한 목록 받기가 성공할 때까지 새로 만들지 않는다(같은 임무 두 번 방지)
  const [missions, setMissions] = useState<Mission[] | null>(null), [mErr, setMErr] = useState(''), [mN, setMN] = useState(0), [unsure, setUnsure] = useState<'checking' | 'failed' | null>(null);
  useEffect(() => { let live = true;   // 앞서 보낸(생성 전) 목록 응답이 늦게 와도 확인으로 치지 않는다
    api.allPlans('missions', cancel).then((l) => { if (!live) return; setMissions(l.filter((x) => isPlan(x) && 'steps' in x)); setMErr(''); setUnsure(null); }, (e: ApiFail) => { if (live && e.code !== 'CANCELED') { setMErr(e.message); setUnsure((u) => u && 'failed'); } });
    return () => { live = false; }; }, [mN]);
  const active = (missions ?? []).filter((m) => !m.archived_at);
  // 실행 확인(정직 표시): 고른 로봇의 카탈로그 available·why_unavailable 그대로 — 저장은 막지 않는다
  const mineRobots = pickable(robots, user), [robot, setRobot] = useState(() => (mineRobots.some((r) => r.id === pane.robot) ? pane.robot : '')), cat = useActs(robot, cancel, !!set && !!robot);   // 로봇을 안 골랐으면 이유는 «고르지 않음» 하나
  const [making, setMaking] = useState(false), [qMsg, setQMsg] = useState(''), cur$ = useRef({ value, set, lock });
  cur$.current = { value, set, lock };
  const [sel, setSel] = useState<number | 'T' | null>(null), [placing, setPlacing] = useState<'point' | 'target'>('point'), [msg, setMsg] = useState('');
  // drag.at·moved = 누른 화면 자리·TAP 넘게 움직였는지(안 움직이고 떼면 누름 = 고르기만 — 지우기는 X)
  const svg = useRef<SVGSVGElement>(null), drag = useRef<{ i: number | 'T'; from: P; orig: ScenarioPoint; at: P; moved: boolean } | null>(null);
  const [open, setOpen] = useState(pane.open), [undo, setUndo] = useState<{ text: string; w: ScenarioWaypoint[]; f: typeof finish; key: string } | null>(null);
  useEffect(() => { if (lock) drag.current = null; }, [lock]);
  // 지도에서 고른 지점 = 단계 창의 그 줄(강조는 aria-pressed) — 보이게 굴린다
  useEffect(() => { if (sel != null) document.querySelector(sel === 'T' ? '[data-finish]' : `[data-wp="${sel}"]`)?.scrollIntoView?.({ block: 'nearest' }); }, [sel]);
  const floorName = (id: string) => { const p = places.find((x) => x.floor.id === id); return p ? `${p.building.name} ${p.floor.name}` : '모르는 층'; };
  const refName = (p: ScenarioPoint) => { const a = places.find((x) => x.floor.id === p.floor_id)?.floor.approved_version_id;
    return (maps[p.map_version_id] ?? (a ? maps[a] : undefined))?.features.waypoints.find((w) => w.id === p.waypoint_ref)?.name || '지도 지점'; };

  // ③ 미리보기: 본문이 바뀌면 잠깐 뒤 다시(마지막 요청만 반영). 결과는 그 본문(key)에만 맞다
  const k = canon(value), missing = MISSING(value), [pre, setPre] = useState<{ key: string; r?: ScenarioPreview; e?: ApiFail } | null>(null), [checking, setChecking] = useState(false), [n, setN] = useState(0), seq = useRef(0);
  useEffect(() => {
    if (!set || missing) { seq.current++; setChecking(false); return; }
    const g = ++seq.current;
    setChecking(true);
    const t = setTimeout(() => api.preview(value, cancel).then(fit(isPreview)).then((r) => { if (g === seq.current) { setPre({ key: k, r }); setChecking(false); } },
      (e: ApiFail) => { if (g === seq.current && e.code !== 'CANCELED') { setPre({ key: k, e }); setChecking(false); } }), 400);
    return () => clearTimeout(t);
  }, [k, recheck, n, !set]);
  useEffect(() => { if (srv) { seq.current++; setPre(srv); setChecking(false); } }, [srv]);
  const now = pre?.key === k && !checking ? pre : null, r = now?.r, pe = now?.e;
  const block = !set ? null : making ? '지점 임무를 만드는 중입니다.' : missing ?? (!now ? '경로를 확인하는 중입니다.' : pe ? (pe.code === 'STALE' ? STALE : pe.status === 422 ? '고른 임무를 쓸 수 없습니다(보관됐을 수 있음). 표시한 지점의 임무를 다시 고르세요.' : `경로를 확인하지 못했습니다. ${pe.message}`)
    : !r!.reachable ? '갈 수 없는 지점이 있어 저장할 수 없습니다. 빨간 지점을 옮기거나 지우세요.' : null);
  useEffect(() => { setBlock(block); }, [block]);
  const res = Object.fromEntries((r?.points ?? []).map((p) => [p.element, p]));
  const marks = new Set([...bad.map((b) => b.at), ...(pe ? elementsOf(pe) : []), ...(r?.points ?? []).filter((p) => !p.reachable).map((p) => p.element)]);
  // 지도가 바뀜(STALE): 나무를 다시 받은 뒤 지점의 판을 지금 승인 판으로 바꿔 다시 미리보기(좌표·지도 지점 참조는 그대로 — 새 판에 맞지 않으면 미리보기가 알린다)
  const [remap, setRemap] = useState(false);
  useEffect(() => {
    if (!remap || !set) return;
    setRemap(false);
    const fix = <T extends ScenarioPoint>(p: T): T => { const a = places.find((x) => x.floor.id === p.floor_id)?.floor.approved_version_id; return a ? { ...p, map_version_id: a } : p; };
    set({ ...value, waypoints: pts.map(fix), finish: target ? { ...finish, target: fix(target) } : finish });
    setN((x) => x + 1);
  }, [places]);

  const put = (w: ScenarioWaypoint[], f = finish) => { if (!lock) set?.({ ...value, waypoints: w, finish: f }); };
  // 새 지점의 기본 할 일 = 이동. 이동 임무가 아직 없거나 목록을 받기 전이면 비워 두고 아래 효과가 찾거나 만들어 잇는다
  const mv = active.find(isMove), dflt = { mission_id: mv?.id ?? '', mission_version: mv?.latest_version ?? 1 };
  /** 지도 누름 → 새 지점(또는 끝 지점). wp = 누른 지도 지점(이름 붙은 지점) — 그 ID 와 좌표를 그대로 */
  const place1 = (q: P, wp?: { id: string; x: number; y: number; yaw: number }) => {
    if (!v) return;
    const p: ScenarioPoint = wp ? { floor_id: cur, map_version_id: v.id, x: wp.x, y: wp.y, yaw: wp.yaw, waypoint_ref: wp.id } : { floor_id: cur, map_version_id: v.id, x: q[0], y: q[1], yaw: 0, waypoint_ref: null };
    if (placing === 'target') { put(pts, { mode: 'GO_TO', target: p }); setPlacing('point'); setSel('T'); return; }
    if (pts.length >= 200) return setMsg('지점은 200개까지 찍을 수 있습니다.');
    put([...pts, { ...p, ...dflt }]); setSel(pts.length);
  };
  const ptAt = (i: number | 'T') => (i === 'T' ? target : pts[i]);
  const down = (e: PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 || !set || lock || making || !v) return;
    const q = fromScreen(svg.current!, v, e.clientX, e.clientY), t = e.target as Element;
    const hit = t.closest('[data-pt]')?.getAttribute('data-pt');
    setMsg('');
    const del = t.closest('[data-del]')?.getAttribute('data-del');
    if (del != null) return drop(del === 'T' ? 'T' : Number(del));
    if (hit != null && placing === 'point') {
      const i = hit === 'T' ? 'T' : Number(hit), o = ptAt(i);
      setSel(i);
      if (o) { drag.current = { i, from: q, orig: o, at: [e.clientX, e.clientY], moved: false }; svg.current!.setPointerCapture?.(e.pointerId); }
      return;
    }
    const wk = t.closest('[data-key^="waypoints."]')?.getAttribute('data-key'), wp = wk ? v.features.waypoints[Number(wk.split('.')[1])] : undefined;
    if (wp) return place1(q, wp);
    if (!inside(v, q[0], q[1])) return setMsg('지도 범위 밖은 찍을 수 없습니다. 지도 그림 안을 누르세요.');
    place1(q);
  };
  const move = (e: PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d || lock || !v) return;
    if (!d.moved) { if (Math.hypot(e.clientX - d.at[0], e.clientY - d.at[1]) < TAP) return; d.moved = true; }
    const q = fromScreen(svg.current!, v, e.clientX, e.clientY), x = d.orig.x + q[0] - d.from[0], y = d.orig.y + q[1] - d.from[1];
    if (!inside(v, x, y)) return;   // 범위 밖으로는 옮기지 않는다(마지막 자리에 둠)
    // 지도 지점에 붙은 지점은 0.05 m 안 흔들림이면 그대로, 넘으면 참조를 떼고 새 좌표(서버는 0.05 m 넘으면 거절)
    const near = d.orig.waypoint_ref && Math.hypot(x - d.orig.x, y - d.orig.y) <= 0.05;
    const n: ScenarioPoint = near ? d.orig : { ...d.orig, x, y, waypoint_ref: null };
    if (d.i === 'T') put(pts, { mode: 'GO_TO', target: n }); else put(pts.map((o, j) => (j === d.i ? { ...o, ...n } : o)));
  };
  const end = () => { drag.current = null; };
  /** 지점(끝 지점 'T' 포함) 지우기 — 확인창 없이 «되돌리기» 한 번. 그 뒤 다른 편집이 생기면 되돌리기는 사라진다(key) */
  const drop = (i: number | 'T') => {
    if (lock) return;
    const w = i === 'T' ? pts : pts.filter((_, j) => j !== i), f = i === 'T' ? { ...finish, target: null } : finish;
    put(w, f); setSel(null);
    setUndo({ text: i === 'T' ? '끝 지점 지움' : `지점 ${i + 1} 지움`, w: pts, f: finish, key: canon({ ...value, waypoints: w, finish: f }) });
  };
  const back = undo && undo.key === k && !!set && !lock && !making ? undo : null;
  const shift = (i: number, dd: number) => { const s = [...pts], [x] = s.splice(i, 1); s.splice(i + dd, 0, x); put(s); setSel(i + dd); };
  /** 이동·사진·대기 고르기: 같은 내용의 보관 안 된 임무(최신 판)가 있으면 그것을, 없으면 임무를 만들어(POST /missions) 이 지점에 잇는다.
   *  만드는 동안 단계 창·지도 편집·저장을 막는다(지점 번호가 바뀌지 않게). 응답이 끊기면 임무 목록을 다시 받는다 — 다시 고르면 만들어진 것을 찾아 쓴다 */
  const quick = (i: number, steps: MissionStep[]) => {
    // 이을 지점은 순번이 아니라 그 지점 값 자체로 기억한다 — 응답을 기다리는 동안 순서가 바뀌어도 고른 지점에 잇는다(#235 B1). 없어졌으면 잇지 않는다
    const at = pts[i];
    const link = (m: Mission) => { const { value: b, set: s, lock: l } = cur$.current, j = b.waypoints.indexOf(at);
      if (!s || l) return;
      if (j < 0) return setQMsg('임무를 만들었지만 그 지점이 바뀌어 잇지 않았습니다. 지점에서 임무를 다시 고르세요.');
      s({ ...b, waypoints: b.waypoints.map((o, k) => (k === j ? { ...o, mission_id: m.id, mission_version: m.latest_version } : o)) }); };
    if (unsure) return;
    const hit = active.find((m) => canon(m.steps) === canon(steps));
    setQMsg('');
    if (hit) return link(hit);
    setMaking(true); grab.current = null;   // 만드는 동안 끌기 막음 — 잡은 줄도 비운다
    api.createPlan('missions', { name: quickName(steps[0]), steps }, cancel).then(fit(isPlan)).then((m) => { setMissions((l) => [...(l ?? []), m as Mission]); setMaking(false); link(m as Mission); },
      (e: ApiFail) => { if (e.code === 'CANCELED') return; setMaking(false);
        if (e.status === 0) { setUnsure('checking'); setMN((x) => x + 1); setQMsg('임무를 만들었는지 확인하지 못했습니다. 임무 목록을 다시 받습니다 — 다시 고르면 같은 내용의 임무가 있으면 그것을 씁니다.'); }
        else setQMsg(!steps.length ? (e.status === 422 ? '이동 임무를 만들지 못했습니다' : `이동 임무를 만들지 못했습니다. ${e.message}`) : `사진·대기 임무를 만들지 못했습니다. ${e.message}`); });
  };
  // 할 일이 빈 지점 = 이동으로 잇는다. 만들다 실패하면(qMsg) «다시 시도»를 누를 때까지 또 보내지 않는다 — 단, 확인 뒤 이동 임무가 보이면 그것을 잇는다
  useEffect(() => {
    if (!set || lock || making || unsure || !missions || (qMsg && !mv)) return;
    const i = pts.findIndex((w) => !w.mission_id);
    if (i >= 0) quick(i, quickSteps('MOVE'));
  }, [pts, missions, !set, lock, making, unsure, qMsg]);
  /** 지금 실행할 수 없는 이유(카탈로그 그대로). null = 로봇 안 고름·막는 것 없음·확인 중 */
  const cannot = (m: Mission) => {
    if (!robot) return null;   // 로봇을 고르지 않았으면 표시하지 않는다(MAPSCEN-UI — 고른 로봇이 있을 때만 ⚠)
    if (!cat.acts) return null;
    const l = m.steps.map((s) => { const a = cat.acts!.find((x) => x.key === s.action), o = a?.options.find((x) => x.value === s.params?.[x.param]);
      return !a ? '지원 전 작업입니다.' : (o ? o.available : a.available) ? null : plain(o ? o.why_unavailable : a.why_unavailable) || '이유를 받지 못했습니다.'; });
    return [...new Set(l.filter(Boolean))].join(' · ') || null;
  };
  const go = (i: number | 'T') => { const p = ptAt(i); setSel(i); if (p) setCur(p.floor_id); };

  const approved = places.filter((p) => p.floor.approved_version_id);
  const rr = v ? Math.max(v.width, v.height) / 60 : 1;
  const on = pts.map((p, i) => [p, i] as const).filter(([p]) => p.floor_id === cur);
  const fence = lock && !!set, one = typeof sel === 'number' ? sel : null;
  const [tab, setTab] = useState<'steps' | 'assign'>('steps'), grab = useRef<number | null>(null), tid = useId();
  // SCEN-NODE-PREVIEW·SCEN-LIFECYCLE-EDITOR 11-09: 오른쪽 창 [노드 | 목록] — 기본 노드(지도와 반반, «운영 흐름» 5단계·임무 = 이 시나리오). 목록 = 기존 편집(저장·배정 그대로, 노드 보기 중에도 숨기기만)
  const [paneLook, setPaneLook] = useState<'node' | 'list'>('node');
  const lookSeg = <span className="mx-seg" role="group" aria-label="노드·목록 보기">
    <button type="button" className="btn" aria-pressed={paneLook === 'node'} data-look="node" onClick={() => setPaneLook('node')}>노드</button>
    <button type="button" className="btn" aria-pressed={paneLook === 'list'} data-look="list" onClick={() => setPaneLook('list')}>목록</button></span>;
  // SCEN-SAVE-FIX 11-09: 이름 오류(저장 전 검사·서버 422)면 이름 칸을 가린 것(노드 보기·지점 상세·접힌 창)을 풀고 초점 — 안 그러면 «이름을 입력하세요»만 뜨고 고칠 칸이 안 보인다
  const seek = useRef(false);
  useEffect(() => { if (!bad.some((b) => b.at === 'name')) return; seek.current = true; setPaneLook('list'); setSel(null); pane.open = true; setOpen(true); }, [bad]);
  useEffect(() => { const el = seek.current ? document.querySelector<HTMLInputElement>('.mx-pane input[data-name]') : null; if (el && !el.closest('[hidden]')) { seek.current = false; el.focus(); } });
  /** 끌어서 순서 바꾸기(손잡이) — 키보드는 «더 보기»의 ↑↓ */
  const moveTo = (from: number, to: number) => { if (making || lock) return; const s2 = [...pts], [x] = s2.splice(from, 1); s2.splice(to, 0, x); put(s2); };
  const still = making || lock;   // fieldset 은 끌기 손잡이(span)를 잠그지 못해 직접 막는다
  // «···» 안 «층»(여러 층 시나리오만 — 다른 층 지점을 보고 찍는다). 승인 판 없는 층은 편집 때 고를 수 없다(읽기 전용은 지점이 있으면 그 판으로)
  const many = new Set([...pts.map((p) => p.floor_id), cur]).size > 1 || places.filter((p) => p.building.id === place?.building.id).length > 1;
  const mapPick = many && <label className="fh-field"><span>층(여러 층 시나리오)</span><select className="fh-user fh-sel" aria-label="지도" disabled={fence} value={cur} onChange={(e) => { setCur(e.target.value); shut(e); }}>
    {places.map((p) => { const c = pts.filter((w) => w.floor_id === p.floor.id).length;
      return <option key={p.floor.id} value={p.floor.id} disabled={!p.floor.approved_version_id && (!!set || !c)}>
        {`${p.site.name} › ${p.building.name} › ${p.floor.name}${c ? ` (지점 ${c})` : ''}${p.floor.approved_version_id ? '' : ' — 승인된 지도 없음'}`}</option>; })}</select></label>;
  const morePick = moreSlot && mapPick && createPortal(<>{mapPick}<hr /></>, moreSlot);
  // 실행 확인할 로봇(고르면 그 로봇이 못 하는 지점에 ⚠ — 화면 상태만, 저장 안 됨)
  const robotField = set && <label className="fh-field"><span>실행 확인할 로봇</span><select className="inp" value={robot} onChange={(ev) => { pane.robot = ev.target.value; setRobot(ev.target.value); }}>
    <option value="">고르지 않음</option>{mineRobots.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>;
  const where = (p: ScenarioPoint) => `${p.floor_id === cur ? '' : `${floorName(p.floor_id)} · `}${p.waypoint_ref ? `«${refName(p)}»` : `(${p.x.toFixed(1)}, ${p.y.toFixed(1)}) m`}`;
  // SCEN-LIFECYCLE-EDITOR: 시뮬 탭이면 지점마다 scenarioTree 로 한 번 더 — 거절(운영자 확인·센서 기록·120 s 넘는 대기·옛 판)이면 그 이유를 노드에 «시뮬에서 실행 못 함»
  const noSim = (p: ScenarioWaypoint) => { if (!sim || !missions) return undefined; const r = scenarioTree({ ...value, waypoints: [p], finish: undefined }, missions);
    return typeof r === 'string' ? r.replace(/^1번 지점: /, '') : undefined; };
  const nodeItems = pts.map((p) => { const m = missions?.find((x) => x.id === p.mission_id), fresh = m && m.latest_version === p.mission_version ? m : undefined;
    return { title: where(p), sub: m ? m.name : p.mission_id ? (missions ? '알 수 없는 임무' : '임무 확인 중') : '이동', kind: (p.mission_id ? kindOf(fresh) : 'MOVE') as StepKind, no: noSim(p) }; });
  const pick = (t: 'steps' | 'assign') => { setTab(t); if (t === 'assign') setSel(null); };
  const order = assign ? (['steps', 'assign'] as const) : (['steps'] as const);
  /** 탭 방향키(←→·Home·End) = 옆 탭을 고르고 포커스(roving tabIndex) */
  const arrow = (e: KeyboardEvent<HTMLElement>) => {
    const n = order.length, at = order.indexOf(tab as never), to = e.key === 'ArrowRight' ? (at + 1) % n : e.key === 'ArrowLeft' ? (at - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
    if (to < 0) return;
    e.preventDefault(); pick(order[to]); document.getElementById(`${tid}-${order[to]}`)?.focus();
  };
  const tabBtn = (t: 'steps' | 'assign', text: string) => <button type="button" role="tab" className="btn" id={`${tid}-${t}`} aria-controls={`${tid}-${t}-panel`} aria-selected={tab === t} tabIndex={tab === t ? 0 : -1} onClick={() => pick(t)}>{text}</button>;
  const tabs = <span className="fh-grow"><span className="mx-seg" role="tablist" aria-label="단계·배정" onKeyDown={arrow}>
    {tabBtn('steps', `단계 ${pts.length}`)}{assign && tabBtn('assign', `배정${assignN != null ? ` ${assignN}` : ''}`)}</span></span>;
  return <>
    {morePick}
    <div className="mx-map">
      {/* 지도 위 알림 띠(생길 때만) */}
      <div className="mx-over">
        {/* 임무 만들기·목록 알림 — 지점을 찍으면 그 지점이 골라져 단계 목록 칸이 접히므로 지도 위에 */}
        {set && mErr && <div className="fh-row"><p className="fh-msg" role="alert">임무 목록을 받지 못했습니다. {mErr}</p><button type="button" className="btn" onClick={() => setMN((x) => x + 1)}>다시 받기</button></div>}
        {qMsg && <div className="fh-row"><p className="fh-msg" role="alert">{qMsg}</p>{pts.some((w) => !w.mission_id) && <button type="button" className="btn" onClick={() => setQMsg('')}>다시 시도</button>}</div>}
        {making && <p className="lv-note" role="status">임무를 만드는 중…</p>}
        {set && unsure && <div className="fh-row" role="status" data-unsure><span className="lv-note fh-grow">{unsure === 'failed' ? '임무를 만들었는지 아직 확인하지 못했습니다' : '임무를 만들었는지 확인하는 중…'} — 확인될 때까지 임무를 새로 만들지 않습니다.</span>
          {unsure === 'failed' && <button type="button" className="btn" onClick={() => { setUnsure('checking'); setMN((x) => x + 1); }}>다시 확인</button>}</div>}
        {mapErr && <div className="fh-row"><p className="fh-msg" role="alert">지도를 받지 못했습니다. {mapErr}</p><button type="button" className="btn" onClick={() => { setMapErr(''); setMapN((x) => x + 1); }}>다시 받기</button></div>}
        {over}
        {/* 저장을 막는 이유·경로 확인 실패(다시 확인) — 노드 보기·창 접힘과 관계없이 지도 위에(SCEN-SAVE-FIX REVIEW-302). 확인 실패면 그 줄이 이유를 대신한다 */}
        {pe && <div className="fh-row" style={{ flexWrap: 'wrap' }}><p className="fh-msg" role="alert">{pe.code === 'STALE' ? STALE : pe.status === 422 ? '고른 임무를 쓸 수 없습니다(보관됐을 수 있음). 표시한 지점의 임무를 다시 고르세요.' : `경로를 확인하지 못했습니다. ${pe.message}`}</p>
          {pe.code === 'STALE' ? <button type="button" className="btn" disabled={lock} onClick={() => { setRemap(true); treeAgain(); }}>새 지도로 다시 확인</button>
            : pe.status !== 422 && <button type="button" className="btn" disabled={lock} onClick={() => setN((x) => x + 1)}>다시 확인</button>}</div>}
        {!pe && blockNote}
        {back && <div className="fh-row" role="status" data-undo><span>{back.text}</span>
          <button type="button" className="btn" onClick={() => { put(back.w, back.f); setUndo(null); }}>되돌리기</button></div>}
        {msg && <p className="fh-msg" role="alert">{msg}</p>}
      </div>
      {v ? <MapFrame ref={svg} {...look} photo={v} edit={!!set} at={{ right: 8, bottom: 8, alignItems: 'flex-end' }} role="img" aria-label={`${floorName(cur)} 지도`} data-map data-scenario-map onPointerDown={down} onPointerMove={move} onPointerUp={end} onPointerCancel={end}
          onContextMenu={(e) => { const h = (e.target as Element).closest('[data-pt]')?.getAttribute('data-pt'); if (h == null || !set || lock || making) return; e.preventDefault(); drop(h === 'T' ? 'T' : Number(h)); }}
          style={{ display: 'block', width: '100%', height: '100%', userSelect: 'none', ...(set && { cursor: 'crosshair' }) }}>
          <MapImage key={mapN} id={v.id} width={v.width} height={v.height} onError={() => setMapErr('지도 그림을 불러오지 못했습니다.')} />
          <Shapes v={v} f={v.features} />
          {on.length > 1 && <polyline points={on.map(([p]) => toPixel(v, p.x, p.y).join(',')).join(' ')} style={{ fill: 'none', stroke: 'var(--accent)', strokeWidth: 2, strokeDasharray: '6 4' }} vectorEffect="non-scaling-stroke" />}
          {on.map(([p, i]) => { const [x, y] = toPixel(v, p.x, p.y), b = marks.has(`waypoints.${i}`);
            return <g key={i} data-pt={i} data-bad={b ? '' : undefined}><circle cx={x} cy={y} r={sel === i ? rr * 1.3 : rr} style={{ fill: b ? 'var(--bad)' : 'var(--accent)', stroke: '#FFFFFF', strokeWidth: 2 }} vectorEffect="non-scaling-stroke" />
              <text x={x} y={y + rr * 0.45} fontSize={rr * 1.3} textAnchor="middle" style={{ fill: '#FFFFFF', pointerEvents: 'none' }}>{i + 1}</text></g>; })}
          {target && target.floor_id === cur && (() => { const [x, y] = toPixel(v, target.x, target.y), b = marks.has('finish.target');
            return <g data-pt="T" data-bad={b ? '' : undefined}><rect x={x - rr} y={y - rr} width={rr * 2} height={rr * 2} style={{ fill: b ? 'var(--bad)' : 'var(--ink-3)', stroke: '#FFFFFF', strokeWidth: 2 }} vectorEffect="non-scaling-stroke" />
              <text x={x} y={y + rr * 0.45} fontSize={rr * 1.1} textAnchor="middle" style={{ fill: '#FFFFFF', pointerEvents: 'none' }}>끝</text></g>; })()}
          {set && sel != null && (() => { const p = ptAt(sel); if (!p || p.floor_id !== cur) return null; const [x, y] = toPixel(v, p.x, p.y);
            return <DelX at={[x + rr, y - rr]} r={rr * 0.7} k={String(sel)} label={sel === 'T' ? '끝 지점 지우기' : `${sel + 1}번 지점 지우기`} />; })()}
        </MapFrame>
        : <div className="mx-center"><p className="lv-note">{!approved.length && (set || !pts.length) ? '승인된 지도가 있는 층이 없습니다. 지도 탭에서 지도를 먼저 올리세요.' : mapErr ? '지도를 받지 못했습니다.' : '지도를 불러오는 중…'}</p></div>}
      {set && v && (placing === 'target' ? <Hint text="지도를 누르면 끝나고 갈 지점을 놓습니다" more="이름 붙은 지도 지점을 누르면 그 지점을 씁니다." />
        : <Hint text="지도를 눌러 지점 추가 · 끌어 옮기기 · 우클릭으로 지우기" more="지도를 누르면 지점을 추가합니다. 이름 붙은 지도 지점을 누르면 그 지점을 씁니다. 찍힌 지점을 누르면 고르고, 끌면 옮깁니다. 지점을 우클릭하거나 고른 지점 오른쪽 위 X 로 지웁니다. 빨간 구역은 진입 금지입니다." />)}
    </div>
    {/* 오른쪽 창 [단계 N | 배정 N]: 단계 목록(손잡이로 끌어 순서) ↔ 고른 단계의 임무·대기 + «더 보기», 아래 끝나면·경로 */}
    <Pane open={open} setOpen={(o) => { pane.open = o; setOpen(o); }} bar={`단계 ${pts.length}`} label="단계 창" pick={picker} name={[value.name || (saved ? WHAT.scenarios : `새 ${WHAT.scenarios}`), place?.floor.name].filter(Boolean).join(' · ')}
      wide={paneLook === 'node'} head={<>{close && <button type="button" className="btn" data-back onClick={close}>‹ 목록</button>}{lookSeg}<span className="fh-grow" />{more}</>}>
      {/* 노드 보기 — 본문(지점·임무 이름)이 바뀌면 처음 배치로 다시(미리보기라 노드 편집은 남기지 않음) */}
      {sim && <SimRun value={value} saved={saved} dirty={sim.dirty} place={place} v={v} missions={missions} cancel={cancel} />}
      {paneLook === 'node' && <ScenNodes where={sim ? 'websim' : 'real'} items={nodeItems} end={FINISH[finish.mode ?? 'STAY']} on={one} pick={go}
        edit={(i) => { go(i); setTab('steps'); setPaneLook('list'); }} />}
      <div className="mx-pane-in" hidden={paneLook === 'node'}>
      {/* 이름·판·실행 확인 로봇 → [단계 N | 배정 N] (지점을 고르면 «‹ N번 지점») */}
      <fieldset disabled={fence} style={{ display: 'contents' }}><div className="mx-in" hidden={one != null && tab === 'steps'}>{nameField}{verField}{robotField}</div></fieldset>
      {one != null && tab === 'steps' ? <div className="mx-head"><button type="button" className="btn" aria-label="단계 목록으로" title="목록으로" onClick={() => setSel(null)}>‹</button><span className="fh-grow">{one + 1}번 지점</span></div>
        : <div className="mx-in" style={{ paddingTop: 0 }}>{tabs}</div>}
      <div className="mx-tab" role="tabpanel" id={`${tid}-steps-panel`} aria-labelledby={`${tid}-steps`} hidden={tab !== 'steps'}>
        <fieldset disabled={fence} style={{ display: 'contents' }}>
        <div className="mx-in" hidden={one != null}>
          {set && cat.err && <div className="fh-row"><p className="fh-msg" role="alert">실행할 수 있는지 확인하지 못했습니다. {cat.err}</p><button type="button" className="btn" onClick={cat.again}>다시 받기</button></div>}
          {!pts.length && <p className="lv-note">아직 단계가 없습니다. 지도를 눌러 지점을 찍으세요.</p>}
        </div>
        <fieldset disabled={making} style={{ display: 'contents' }}>
        <ol className="mx-list" aria-label="지점 순서">{pts.map((p, i) => {
          const e = `waypoints.${i}`, pr = res[e], b = marks.has(e), m = missions?.find((x) => x.id === p.mission_id);
          const fresh = m && m.latest_version === p.mission_version ? m : undefined;   // 고른 판 = 최신 판일 때만 내용을 안다
          const kind = p.mission_id ? kindOf(fresh) : 'MOVE', unknown = missions ? '알 수 없는 임무' : '임무 확인 중';
          const sec = set ? waitOf(fresh) : null, no = set && fresh ? cannot(fresh) : null, warn = no || (pr && !pr.reachable) || b;
          return <li key={i} data-wp={i} data-bad={b ? '' : undefined} hidden={one != null && one !== i}
            onDragOver={(ev) => { if (grab.current != null && !still) ev.preventDefault(); }} onDrop={(ev) => { ev.preventDefault(); const f = grab.current; grab.current = null; if (f != null && f !== i && !still) moveTo(f, i); }}>
            <div className="mx-row">
              {set && one == null && <span className="mx-grip" role="img" draggable={!still} aria-label={`${i + 1}번 단계 끌어 옮기기`} aria-disabled={still || undefined}
                title="끌어서 순서 바꾸기 — 키보드는 단계를 눌러 «더 보기»의 ↑↓"
                onDragStart={(ev) => { if (still) { ev.preventDefault(); grab.current = null; return; } grab.current = i; ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', String(i)); }} onDragEnd={() => { grab.current = null; }}><span aria-hidden="true">⋮⋮</span></span>}
              <button type="button" className="mx-name" aria-pressed={sel === i} onClick={() => go(i)}><span className="mx-num">{i + 1}</span><b>{where(p)}</b>
                <small>{m ? m.name : p.mission_id ? unknown : '이동'}</small>{warn && <span className="mx-warn" title={no ? `실행 불가 — ${no}` : '확인할 것이 있습니다'}>⚠</span>}</button>
              {set && <button type="button" className="mx-x" aria-label={`${i + 1}번 지점 지우기`} title="지우기" onClick={() => drop(i)}>✕</button>}
            </div>
            <div className="mx-in" hidden={sel !== i}>
              {/* 할 일 셋(11-04): 고르면 그 임무를 찾거나 만들어 잇는다(임무 목록을 받기 전에는 못 고름 — 같은 임무를 또 만들지 않게). 다른 임무가 묶인 옛 지점은 지우지 않고 이름을 보이며 셋 중 하나로 바꿀 수 있다 */}
              {set ? <label className="fh-field"><span>할 일</span><select className="inp" aria-label={`${i + 1}번 지점 할 일`} disabled={!missions || !!unsure} value={kind === 'OTHER' ? '' : kind} onChange={(ev) => quick(i, quickSteps(ev.target.value))}>
                  {kind === 'OTHER' && <option value="" hidden>다른 임무</option>}
                  <option value="MOVE">이동</option><option value="PHOTO">사진 찍기</option><option value="WAIT">대기</option></select></label>
                : <span className="lbl">{m ? m.name : unknown}</span>}
              {set && kind === 'OTHER' && <span className="lbl" data-other>지금 임무: {m?.name ?? unknown}{m?.archived_at ? ' (보관됨)' : m && !fresh ? ' (옛 내용)' : ''}</span>}
              {fresh && <span className="lbl" data-do>할 일: {doText(fresh)}</span>}
              {sec != null && <WaitSecs i={i} sec={sec} apply={(n) => quick(i, quickSteps('WAIT', n))} />}
              {no && <p className="fh-why" data-cannot>저장은 되지만 지금은 실행 불가 — {no}</p>}
              {pr && !pr.reachable && <p className="fh-msg" role="alert">갈 수 없음: {pr.reasons.join(' ')}</p>}
              {bad.filter((x) => x.at === e).map((x, j) => <p key={j} className="fh-msg" role="alert">{x.text}</p>)}
              <details className="fh-fold"><summary>더 보기</summary>
                <p className="lbl">자리: {floorName(p.floor_id)} · {p.waypoint_ref ? `«${refName(p)}»` : `(${p.x.toFixed(1)}, ${p.y.toFixed(1)}) m`}</p>
                {set && <div className="fh-row" style={{ flexWrap: 'wrap' }}><button type="button" className="btn" aria-label={`${i + 1}번 지점 위로`} disabled={!i} onClick={() => shift(i, -1)}>↑</button>
                  <button type="button" className="btn" aria-label={`${i + 1}번 지점 아래로`} disabled={i === pts.length - 1} onClick={() => shift(i, 1)}>↓</button>
                  <button type="button" className="btn" onClick={() => drop(i)}>이 지점 지우기</button></div>}
              </details>
            </div>
          </li>; })}</ol>
        </fieldset>
        </fieldset>
        <div className="mx-foot">
          <fieldset disabled={fence} style={{ display: 'contents' }}>
          <label className="fh-field"><span>끝나면</span><select className="inp" value={finish.mode ?? 'STAY'} disabled={!set} onChange={(ev) => { const mode = ev.target.value as keyof typeof FINISH; put(pts, { mode, target: mode === 'GO_TO' ? target : null }); if (mode === 'GO_TO' && !target) setPlacing('target'); else setPlacing('point'); }}>
            {(Object.keys(FINISH) as (keyof typeof FINISH)[]).map((m) => <option key={m} value={m}>{FINISH[m]}</option>)}</select></label>
          {finish.mode === 'GO_TO' && <div className="fh-row" style={{ flexWrap: 'wrap' }} data-finish data-bad={marks.has('finish.target') ? '' : undefined}>
            {target ? <button type="button" className="btn" aria-pressed={sel === 'T'} onClick={() => go('T')}>끝 지점: {floorName(target.floor_id)} · {target.waypoint_ref ? `«${refName(target)}»` : `(${target.x.toFixed(1)}, ${target.y.toFixed(1)}) m`}</button>
              : <span className="lv-note">끝나고 갈 지점을 아직 찍지 않았습니다.</span>}
            {set && <button type="button" className="btn" aria-pressed={placing === 'target'} onClick={() => setPlacing(placing === 'target' ? 'point' : 'target')}>{placing === 'target' ? '지점 찍기로 돌아가기' : '끝 지점 찍기'}</button>}
            {res['finish.target'] && !res['finish.target'].reachable && <p className="fh-msg" role="alert">끝 지점에 갈 수 없음: {res['finish.target'].reasons.join(' ')}</p>}
          </div>}
          </fieldset>
          {/* 경로 확인 한 줄(«✓ 모두 갈 수 있음 · 약 N m ⓘ», 문제면 같은 자리에 경고) + «경로 더 보기» */}
          {!set ? (saved ? <p className="lv-note">예상 거리 약 {Math.round(saved.est_distance_m)} m · 필요 장치: {devices(saved.required_devices)}</p> : null) : <div className="fh-form" style={{ gap: 6 }} aria-label="경로 확인" data-preview>
            {missing && <p className="lv-note">{missing}</p>}
            {!missing && checking && <p className="lv-note" role="status">경로를 확인하는 중…</p>}
            {r && <>
              <p className={r.reachable ? 'fh-msg ok' : 'fh-msg'} role={r.reachable ? 'status' : 'alert'} title="지점 사이 직선과 층 연결점까지 거리로 잰 대략 값입니다. 실제로 걷는 길은 실행할 때 로봇이 정합니다.">
                {r.reachable ? '✓ 모두 갈 수 있음' : '⚠ 갈 수 없는 지점이 있음'} · 약 {Math.round(r.est_distance_m)} m<span aria-hidden="true"> ⓘ</span></p>
              <details className="fh-fold"><summary>경로 더 보기</summary>
                <p>{r.reachable ? '모든 지점에 갈 수 있습니다.' : '갈 수 없는 지점이 있습니다. 빨간 지점을 옮기거나 지우세요.'}</p>
                <p>예상 거리 약 {Math.round(r.est_distance_m)} m <span className="lbl">— 지점 사이 직선과 층 연결점까지 거리로 잰 대략 값입니다. 실제로 걷는 길은 실행할 때 로봇이 정합니다.</span></p>
                <p>필요 장치: {devices(r.required_devices)}</p>
                {r.segments.some((s) => !s.reachable || s.via.length) && <ul className="fh-list" aria-label="구간">{r.segments.filter((s) => !s.reachable || s.via.length).map((s, j) =>
                  <li key={j} className="fh-row"><span>{elName(s.start)} → {elName(s.end)}</span><span className={s.reachable ? 'lbl' : 'fh-why'}>{s.reachable ? `${floorName(s.via[0]?.floor_id ?? '')} → ${floorName(s.via[1]?.floor_id ?? '')} 층 연결점을 거칩니다` : s.reason}</span></li>)}</ul>}
              </details>
            </>}
          </div>}
        </div>
      </div>
      {assign && <div className="mx-in" role="tabpanel" id={`${tid}-assign-panel`} aria-labelledby={`${tid}-assign`} hidden={tab !== 'assign'}>{assign}</div>}
      </div>
    </Pane>
  </>;
}
