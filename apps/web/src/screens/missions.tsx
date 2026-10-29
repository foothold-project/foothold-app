// 임무 탭(01 MS-01·02·03·09, 02 F-MS-01~04·§10, 03 §5.3, 05 §6.1~6.3 — S5a /actions·/missions·/scenarios·/scenarios/preview).
// 목록 [임무 | 시나리오](보관 제외 기본·보관 보기·더 보기) + 편집 칸. 저장할 때마다 새 판(PUT If-Match = 받은 본체 version), 옛 판은 읽기 전용(덮어쓰기 단추 없음).
// 시나리오 지도 그리기·좌표 변환은 지도 탭 함수(screens/maps·mapedit) 그대로. 배정 창·목록은 저장된 시나리오 칸 아래(screens/assign.tsx, S5b), 실행은 S7 뒤.
// STOP 은 App 머리줄 — 이 화면은 창 키·포인터를 잡지 않는다(지도 svg 포인터만).
import { useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent } from 'react';
import type { Action, Assignment, MapVersion, Mission, MissionStep, MissionWrite, Scenario, ScenarioPoint, ScenarioPreview, ScenarioWaypoint, ScenarioWrite } from '../../../contracts/ts';
import { ApiFail, api, type Plan } from '../api';
import { idleSim, type Robot, type User } from '../fake';
import { KIND as DEVICE, type Ctx } from '../screens';
import { MapFrame, MapImage } from '../mapframe';
import { Note, Shapes, canon, floorsOf, isVersion, reasonBad, shape, toPixel, useFit, useTree, type Msg, type Place } from './maps';
import { DelX, fromScreen, inside, nameBad } from './mapedit';
import { AssignPanel, assignFor } from './assign';
import './missions.css';

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

/** 걸린 곳: at = 'name' · 'steps' · 'steps.2' · 'waypoints.3' · 'finish.target' (서버 detail.elements 앞부분과 같은 모양) */
type Bad = { at: string; text: string };
const atOf = (e: string) => /^(steps\.\d+|waypoints\.\d+|finish\.target|name)/.exec(e)?.[1] ?? e.split('.')[0];
const elementsOf = (e: ApiFail) => (arr(e.detail?.elements) ? (e.detail!.elements as unknown[]).filter(str).map((x) => atOf(x as string)) : []);

/** 저장 응답이 끊김 — 보낸 본문 + 대조 기준. known = 만들기 전 목록 ID(POST), next = 내 PUT 이 성공했다면 생긴 판 번호(그 번호는 한 번만 생긴다) */
type Unsure = { body: AnyWrite; id: string; known: string[] | null; next: number | null; match?: number };
/** 저장하지 않은 편집 — 다른 탭·다른 항목·폰 틀로 가도 남겨 다시 열면 이어 쓴다(지도 편집 kept 와 같은 생각, 확인창 없이). base = 편집을 시작한 판(If-Match 기준) */
type Draft = { body: AnyWrite; base: AnyPlan | null; unsure: Unsure | null };
type Adopt = 'all' | 'base' | 'none';
export const keptPlan: { kind: Plan; sel: string | null; drafts: Record<string, Draft>; now: boolean } = { kind: 'scenarios', sel: null, drafts: {}, now: false };
/** 로그아웃 때 비운다(session.tsx) */
export const clearPlans = () => { keptPlan.kind = 'scenarios'; keptPlan.sel = null; keptPlan.drafts = {}; keptPlan.now = false; assignFor.robot = null; pane.robot = ''; };
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
      if (!arr(l) || !l.every((a) => !!a && str(a.scenario_id) && str(a.robot_name) && str(a.status))) throw new ApiFail(0, 'BAD_SHAPE', '');
      const m: Record<string, string[]> = {};
      for (const a of l) if (a.status === 'ACTIVE' || a.status === 'PENDING') {
        const name = a.status === 'PENDING' ? `${a.robot_name}(결재 대기)` : a.robot_name;
        if (!(m[a.scenario_id] ??= []).includes(name)) m[a.scenario_id].push(name);
      }
      if (live) setBy(m);
    }).catch((e: ApiFail) => { if (live && e.code !== 'CANCELED') setBy(null); });
    return () => { live = false; };
  }, [on, busy]);
  return by;
}

/** 임무 탭(03 §5.3): 왼쪽 [임무 | 시나리오] 목록, 오른쪽 편집. 누구나 남의 것도 고친다(10-27 — 서버가 허용) */
export function Missions(c: Pick<Ctx, 'user' | 'cancel' | 'robots'>) {
  const [kind, setKind] = useState<Plan>(keptPlan.kind), [archived, setArchived] = useState(false), [mine, setMine] = useState(false), [floor, setFloor] = useState('');
  const scen = kind === 'scenarios', l = useList(kind, archived, scen ? { mine, floor } : undefined, c.cancel), assigned = useAssigned(scen, l.busy, c.cancel);
  const [sel, setSel] = useState<string | null>(keptPlan.sel), [msg, setMsg] = useState<Msg>(() => (assignFor.robot && !keptPlan.sel ? { text: `${c.robots.find((r) => r.id === assignFor.robot)?.name ?? '로봇'}에 배정할 시나리오를 고르세요 — 고르면 배정 창이 열립니다.`, ok: true } : null)), [n, setN] = useState(0), tree = useTree(c.cancel);
  useEffect(() => { keptPlan.kind = kind; keptPlan.sel = sel; }, [kind, sel]);
  const places = useMemo(() => floorsOf(tree.tree), [tree.tree]), floorText = (ids: string[]) => ids.map((id) => places.find((p) => p.floor.id === id)?.floor.name).filter(Boolean).join(' · ');
  const show = (k: Plan) => { if (k !== kind) { setKind(k); setSel(null); setMsg(null); } };
  return <>
    <section className="lv-card" style={{ flex: '0 1 380px' }} aria-label="임무 목록">
      <div className="fh-row">
        <span className="fh-row" role="group" aria-label="종류">{(['missions', 'scenarios'] as Plan[]).map((k) => <button key={k} type="button" className="btn" aria-pressed={kind === k} onClick={() => show(k)}>{WHAT[k]}</button>)}</span>
        <span className="fh-grow" />
        <button type="button" className="btn pri" onClick={() => { setSel(''); setMsg(null); setN((x) => x + 1); }}>새 {WHAT[kind]}</button>
      </div>
      <label className="fh-row"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /><span>보관된 것도 보기</span></label>
      {/* 시나리오 거르기(F-MS-04) — 서버 mine·floor_id 로 */}
      {scen && <div className="fh-row" role="group" aria-label="거르기">
        <label className="fh-row"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /><span>내 것만</span></label>
        <label className="fh-row"><span className="lbl">지도</span><select className="fh-user" aria-label="지도별" value={floor} onChange={(e) => setFloor(e.target.value)}>
          <option value="">전체</option>{places.map((p) => <option key={p.floor.id} value={p.floor.id}>{`${p.site.name} ${p.building.name} ${p.floor.name}`}</option>)}</select></label>
      </div>}
      <ul className="fh-list" aria-label={`${WHAT[kind]} 목록`}>{l.items.map((x) => <li key={x.id}>
        <button type="button" aria-pressed={x.id === sel} data-plan={x.id} onClick={() => { setSel(x.id); setMsg(null); }}>
          <b>{x.name}</b>
          {'waypoints' in x && <span className="lbl">{floorText(x.floor_ids)}</span>}
          <span className="fh-grow" /><span className="mono">판 {x.latest_version}</span>
          <span className="lbl">{'steps' in x ? `작업 ${x.steps.length}` : `지점 ${x.waypoints.length}`}</span>
          {/* 마지막 실행은 실행 API(S7) 전이라 서버 값이 없다 — 지어내지 않고 «—». fh-wide = 좁으면 둘째 줄로 */}
          {'waypoints' in x && <span className="fh-wide fh-row"><span className="lbl" data-col="robots">로봇 {assigned === undefined ? '…' : assigned ? assigned[x.id]?.join(', ') || '없음' : '?'}</span><span className="lbl" data-col="last-run">마지막 실행 —</span></span>}
          {x.archived_at && <span className="lbl">보관됨</span>}
          {keptPlan.drafts[`${kind}:${x.id}`] && <span className="lbl">저장 안 한 편집</span>}
        </button></li>)}</ul>
      {scen && assigned === null && <p className="lv-note">배정된 로봇을 받지 못했습니다(«?»). 목록을 다시 받으면 다시 시도합니다.</p>}
      {!l.busy && !l.err && !l.items.length && <p className="lv-note">{scen && (mine || floor) ? '조건에 맞는 시나리오가 없습니다. 거르기를 바꿔 보세요.' : kind === 'missions' ? '임무가 없습니다. «새 임무»로 사진·대기 같은 작업을 묶으세요.' : '시나리오가 없습니다. «새 시나리오»로 지도에 지점을 찍어 만드세요.'}</p>}
      {l.err && <p className="fh-msg" role="alert">{WHAT[kind]} 목록을 받지 못했습니다. {l.err}</p>}
      {l.busy && <p className="lv-note" role="status">목록을 불러오는 중…</p>}
      {!l.busy && (l.next || l.err) && <div className="fh-row"><button type="button" className="btn" onClick={l.err && !l.items.length ? l.again : l.more}>{l.err ? '다시 시도' : '더 보기'}</button></div>}
    </section>
    <section className="lv-card" aria-label={`${WHAT[kind]} 편집`}>
      <Note m={msg} />
      {sel == null ? <p className="lv-note">목록에서 {WHAT[kind]}를 고르거나 «새 {WHAT[kind]}»를 누르세요.</p>
        : <Edit key={`${kind}-${sel}-${sel ? '' : n}`} kind={kind} id={sel} user={c.user} robots={c.robots} cancel={c.cancel} places={places} treeAgain={tree.again}
            done={(x, m) => { l.again(); setMsg(m); if (x && x.id !== sel) setSel(x.id); }} newMission={() => { setKind('missions'); setSel(''); setMsg(null); setN((x) => x + 1); }} />}
    </section>
  </>;
}

const NOT_YET = '저장이 아직 확인되지 않았습니다. 서버가 처리하는 중일 수 있습니다. 잠시 뒤 «저장 확인»을 다시 누르세요.';
const MANY = '같은 내용의 새 항목이 여러 개 보여 이번 저장을 정할 수 없습니다. 목록에서 확인하세요.';
const CONFLICT = '다른 사람이 먼저 새 판을 저장했습니다. 입력은 그대로 있습니다. «최신 판 받기»를 누른 뒤 다시 저장하면 내 입력이 그다음 판이 됩니다.';
const STALE = '지도가 바뀌었습니다. 지점은 그대로 두었습니다. «새 지도로 다시 확인»을 누르면 지금 승인된 지도로 다시 확인합니다.';
/** 작업·지점 줄 목록 — .fh-list 는 줄 전체가 단추인 목록 모양이라 안의 작은 단추까지 늘어난다 */
const LIST = { listStyle: 'none', margin: 0, padding: 0 } as const;
const day = (at: string) => new Date(at).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });

/** 편집 칸 하나. id '' = 새로 만들기. 최신 판을 받아 편집하고, 판 목록에서 옛 판을 고르면 읽기 전용으로 보인다.
 *  done(x, m) = 저장(x)·보관(null) 뒤 목록 다시 받기 + 안내 */
function Edit({ kind, id, user, robots, cancel, places, treeAgain, done, newMission }: { kind: Plan; id: string; user: User; robots: Robot[]; cancel?: AbortSignal; places: Place[]; treeAgain: () => void; done: (x: AnyPlan | null, m: Msg) => void; newMission?: () => void }) {
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
    if (adopt === 'base') { setBase(x); setConflict(false); setMsg({ text: `최신 판(판 ${x.number})을 받았습니다. 입력은 그대로입니다 — 저장하면 다음 판(판 ${x.number + 1})이 됩니다. 최신 판 내용은 «판»에서 고르면 볼 수 있습니다.`, ok: true }); }
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
      saved(x, `저장된 것을 확인했습니다(판 ${h[0].number}).${x.number !== h[0].number ? ` 그 뒤 새 판(판 ${x.number})이 저장되어 최신 판을 보입니다.` : ''}`);
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
      .then((x) => { sending.current = null; if (!live.current) { delete keptPlan.drafts[key]; return; } setBusy(false); saved(x, `저장했습니다(판 ${x.number}).`); },
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
  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!body || lock || !editable) return;
    const b = kind === 'missions' ? missionBad(body as MissionWrite) : scenarioBad(body as ScenarioWrite);
    if (b.length) { setBad(b); setMsg({ text: b[0].text }); return; }
    if (block) return setMsg({ text: block });
    send(body);
  };
  // 보관 — 되돌리는(보관 해제) API 가 없어 확인창을 거친다(U10, 조정 결정). 옛 판은 계속 읽힌다
  const archive = () => {
    setBusy(true); setMsg(null);
    api.archivePlan(kind, id, cancel).then(() => load('all').then(() => { if (!live.current) return; setBusy(false); snap.current = null; delete keptPlan.drafts[key]; done(null, { text: `보관했습니다. «보관된 것도 보기»에서 옛 판을 계속 볼 수 있습니다.`, ok: true }); }),
      (e: ApiFail) => { if (!live.current || e.code === 'CANCELED') return; setBusy(false); setMsg({ text: e.status === 0 ? '보관 응답을 받지 못했습니다. 목록을 다시 받아 확인하세요.' : `보관하지 못했습니다. ${e.message}` }); if (e.status === 0) done(null, null); });
  };
  const pickVersion = (n: number) => {
    if (!latest || n === latest.latest_version) return setView(null);
    api.plan(kind, id, n, cancel).then(fit(isPlan)).then((x) => live.current && setView(x), (e: ApiFail) => { if (live.current && e.code !== 'CANCELED') setMsg({ text: `판 ${n} 내용을 받지 못했습니다. ${e.message}` }); });
  };

  const retry = err && <div className="fh-row"><p className="fh-msg" role="alert">{err.text}</p><button type="button" className="btn" onClick={() => { setErr(null); load(err.adopt); }}>다시 받기</button></div>;
  if (!body) return retry || <p className="lv-note" role="status">불러오는 중…</p>;
  const shown = view ? bodyOf(view) : body, ro = !!view || !editable;
  const put = (b: AnyWrite) => { if (lock || ro) return; setBody(b); setBad([]); setMsg(null); };
  const nameBadNow = bad.find((b) => b.at === 'name');
  return <div className="fh-form" aria-label={`${what} 편집 칸`}>
    {retry}
    <div className="fh-row"><h2 className="fh-grow">{id ? shown.name || what : `새 ${what}`}</h2>
      {latest && <label className="fh-row"><span>판</span><select className="inp" aria-label="판" value={view?.number ?? latest.latest_version} onChange={(e) => pickVersion(Number(e.target.value))}>
        {Array.from({ length: latest.latest_version }, (_, i) => latest.latest_version - i).map((n) => <option key={n} value={n}>{`판 ${n}${n === latest.latest_version ? ' (최신)' : ''}`}</option>)}</select></label>}</div>
    {view && <p className="lv-note" role="status" data-old>옛 판(판 {view.number})을 보는 중입니다(읽기 전용, {day(view.version_created_at)} 저장). 고치려면 «판»에서 최신 판을 고르세요.</p>}
    {!view && archived && <p className="lv-note" data-readonly>보관된 {what}입니다. 고칠 수 없고 옛 판은 볼 수 있습니다.</p>}
    {/* 저장 중·저장 확인 전에는 입력을 모두 막는다(보낸 내용과 초안이 달라지지 않게). STOP 은 App 머리줄 그대로 */}
    <fieldset disabled={lock && !ro} style={{ display: 'contents' }}>
      <label className="fh-field"><span>이름</span><input className="inp" maxLength={128} value={shown.name} readOnly={ro} aria-invalid={!!nameBadNow} onChange={(e) => put({ ...body, name: e.target.value })} /></label>
      {kind === 'missions'
        ? <MissionForm value={shown as MissionWrite} set={ro ? undefined : (b) => put(b)} bad={view ? [] : bad} robots={robots} user={user} cancel={cancel} />
        : <ScenarioForm key={view ? `v${view.number}` : 'draft'} value={shown as ScenarioWrite} set={ro ? undefined : (b) => put(b)} lock={lock} bad={view ? [] : bad} places={places} treeAgain={treeAgain}
            cancel={cancel} setBlock={setBlock} recheck={recheck} srv={view ? null : srv} saved={(view ?? (id ? latest : null)) as Scenario | null} newMission={newMission} robots={robots} user={user} />}
    </fieldset>
    {!ro && <form className="fh-form" onSubmit={save} noValidate aria-label="저장">
      <div className="fh-row"><button type="submit" className="btn pri" disabled={lock || (kind === 'scenarios' && !!block)} aria-describedby={kind === 'scenarios' && block ? 'plan-block' : undefined}>{id ? '새 판으로 저장' : '저장'}</button>
        {conflict && <button type="button" className="btn" disabled={lock} onClick={() => load('base')}>최신 판 받기</button>}
        {id && <button type="button" className="btn" disabled={lock || ask} onClick={() => setAsk(true)}>보관</button>}</div>
      {ask && <div className="fh-row" role="group" aria-label="보관 확인"><span>이 {what}를 보관할까요? 보관하면 되돌릴 수 없습니다 — 목록에서 빠지고 더는 고칠 수 없습니다. 옛 판은 «보관된 것도 보기»에서 볼 수 있습니다.</span>
        <button type="button" className="btn pri" disabled={lock} onClick={() => { setAsk(false); archive(); }}>보관하기</button>
        <button type="button" className="btn" onClick={() => setAsk(false)}>취소</button></div>}
      {kind === 'scenarios' && block && !lock && <span id="plan-block" className="fh-why" data-block>{block}</span>}
      {busy && <p className="lv-note" role="status">저장하는 중…</p>}
    </form>}
    <Note m={msg} />
    {unsure && <>
      <div className="fh-row"><button type="button" className="btn" disabled={checking} onClick={() => check(unsure)}>저장 확인</button>
        <button type="button" className="btn" disabled={checking || again} onClick={() => setAgain(true)}>다시 저장</button>
        {checking && <span className="lv-note" role="status">저장됐는지 확인하는 중…</span>}</div>
      {again && <div className="fh-row" role="group" aria-label="다시 저장 확인"><span>이미 저장됐을 수 있습니다. 다시 보내면 같은 {what}가 두 번 생길 수 있어요 — 목록에서 먼저 확인하세요.</span>
        <button type="button" className="btn pri" onClick={() => { const u = unsure; setUnsure(null); setAgain(false); send(u.body); }}>그래도 다시 저장</button>
        <button type="button" className="btn" onClick={() => setAgain(false)}>닫기</button></div>}
    </>}
    {/* 배정은 저장된 판만 간다 — 저장 안 한 편집이 있으면 어느 판이 가는지 바로 위에 알린다 */}
    {kind === 'scenarios' && id && latest && !view && dirty && <p className="fh-why" role="status" data-unsaved-assign>저장하지 않은 편집이 있습니다 — 배정하면 저장된 판 {latest.latest_version}이 배정됩니다. 고친 내용을 배정하려면 먼저 «새 판으로 저장»을 누르세요.</p>}
    {kind === 'scenarios' && id && latest && <AssignPanel scenario={id} name={latest.name} version={view?.number ?? latest.latest_version} archived={archived} user={user} robots={robots} cancel={cancel} />}
  </div>;
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
const MISSING = (v: ScenarioWrite) => (!v.waypoints.length ? '지도를 눌러 지점을 하나 이상 찍으세요.' : v.waypoints.some((w) => !w.mission_id) ? '모든 지점에 임무를 고르세요.'
  : v.finish?.mode === 'GO_TO' && !v.finish.target ? '끝나고 갈 지점을 지도에서 찍으세요.' : null);
const TAP = 8;   // 화면 px — MapFrame SLOP 과 같다. 찍힌 지점을 누르고 이만큼 움직이기 전에 떼면 누름(고르기), 넘으면 끌어 옮기기
/** 단계 창 펼침·실행 확인할 로봇 — 다른 시나리오를 열어도 사람이 고른 그대로(로봇은 로그아웃 때 비움) */
const pane = { open: true, robot: '' };
/** 지점에서 바로 고르는 한 단계 임무(10-26). 깊이 사진은 저장 형식이 없어 내지 않는다 */
const quickSteps = (k: string, seconds = 30): MissionStep[] => (k === 'PHOTO' ? [{ action: 'PHOTO', params: { camera: 'rgb' } }] : [{ action: 'WAIT', params: { seconds } }]);
const quickName = (s: MissionStep) => (s.action === 'PHOTO' ? '사진 찍기(RGB)' : `대기 ${s.params?.seconds}초`);
/** 임무가 하는 일 짧게(지점 카드): «사진», «대기 30초» */
const doText = (m: Mission) => m.steps.map((s) => (s.action === 'PHOTO' ? (s.params?.camera === 'depth' ? '뎁스 사진' : '사진') : s.action === 'WAIT' ? `대기 ${s.params?.seconds}초` : ACT[s.action] ?? s.action)).join(' → ');
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
 *  recheck = 저장이 STALE·422 로 막혀 다시 미리보기, srv = 저장 422 에 서버가 실어 보낸 미리보기(그 본문의 결과), newMission = 임무 목록으로 가서 새 임무 열기 */
function ScenarioForm({ value, set, lock, bad, places, treeAgain, cancel, setBlock, recheck, srv, saved, newMission, robots, user }: { value: ScenarioWrite; set?: (v: ScenarioWrite) => void; lock: boolean; bad: Bad[]; places: Place[]; treeAgain: () => void;
  cancel?: AbortSignal; setBlock: (s: string | null) => void; recheck: number; srv: { key: string; r: ScenarioPreview } | null; saved: Scenario | null; newMission?: () => void; robots: Robot[]; user: User }) {
  const pts = value.waypoints, finish = value.finish ?? { mode: 'STAY', target: null }, target = finish.target ?? null;
  const [cur, setCur] = useState(() => pts[0]?.floor_id ?? places.find((p) => p.floor.approved_version_id)?.floor.id ?? '');
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
  const block = !set ? null : making ? '지점 임무를 만드는 중입니다.' : missing ?? (!now ? '경로를 확인하는 중입니다.' : pe ? (pe.code === 'STALE' ? STALE : pe.status === 422 ? '고른 임무 판을 쓸 수 없습니다(보관됐을 수 있음). 표시한 지점의 임무를 다시 고르세요.' : `경로를 확인하지 못했습니다. ${pe.message}`)
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
  const last = pts[pts.length - 1], dflt = last?.mission_id ? { mission_id: last.mission_id, mission_version: last.mission_version } : active[0] ? { mission_id: active[0].id, mission_version: active[0].latest_version } : { mission_id: '', mission_version: 1 };
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
  /** 사진·대기 바로 고르기: 같은 내용의 보관 안 된 임무(최신 판)가 있으면 그것을, 없으면 한 단계 임무를 만들어(POST /missions) 이 지점에 잇는다.
   *  만드는 동안 단계 창·지도 편집·저장을 막는다(지점 번호가 바뀌지 않게). 응답이 끊기면 임무 목록을 다시 받는다 — 다시 고르면 만들어진 것을 찾아 쓴다 */
  const quick = (i: number, steps: MissionStep[]) => {
    const link = (m: Mission) => { const { value: b, set: s, lock: l } = cur$.current; if (s && !l) s({ ...b, waypoints: b.waypoints.map((o, j) => (j === i ? { ...o, mission_id: m.id, mission_version: m.latest_version } : o)) }); };
    if (unsure) return;
    const hit = active.find((m) => canon(m.steps) === canon(steps));
    setQMsg('');
    if (hit) return link(hit);
    setMaking(true);
    api.createPlan('missions', { name: quickName(steps[0]), steps }, cancel).then(fit(isPlan)).then((m) => { setMissions((l) => [...(l ?? []), m as Mission]); setMaking(false); link(m as Mission); },
      (e: ApiFail) => { if (e.code === 'CANCELED') return; setMaking(false);
        if (e.status === 0) { setUnsure('checking'); setMN((x) => x + 1); setQMsg('임무를 만들었는지 확인하지 못했습니다. 임무 목록을 다시 받습니다 — 다시 고르면 같은 내용의 임무가 있으면 그것을 씁니다.'); }
        else setQMsg(`사진·대기 임무를 만들지 못했습니다. ${e.message}`); });
  };
  /** 지금 실행할 수 없는 이유(카탈로그 그대로, 로봇 미선택도 이유). null = 막는 것 없음 또는 확인 중 */
  const cannot = (m: Mission) => {
    if (!robot) return '실행 확인할 로봇을 고르지 않았습니다.';
    if (!cat.acts) return null;
    const l = m.steps.map((s) => { const a = cat.acts!.find((x) => x.key === s.action), o = a?.options.find((x) => x.value === s.params?.[x.param]);
      return !a ? '지원 전 작업입니다.' : (o ? o.available : a.available) ? null : plain(o ? o.why_unavailable : a.why_unavailable) || '이유를 받지 못했습니다.'; });
    return [...new Set(l.filter(Boolean))].join(' · ') || null;
  };
  const choose = (i: number, val: string) => { if (val.startsWith('do:')) return quick(i, quickSteps(val.slice(3))); const [mission_id, ver] = val.split(':'); put(pts.map((o, j) => (j === i ? { ...o, mission_id: mission_id ?? '', mission_version: Number(ver) || 1 } : o))); };
  const go = (i: number | 'T') => { const p = ptAt(i); setSel(i); if (p) setCur(p.floor_id); };

  const approved = places.filter((p) => p.floor.approved_version_id);
  const rr = v ? Math.max(v.width, v.height) / 60 : 1;
  const on = pts.map((p, i) => [p, i] as const).filter(([p]) => p.floor_id === cur);
  return <>
    {set && missions && !active.length && <div className="fh-row" role="status" data-no-mission><span className="lv-note fh-grow">임무가 아직 없습니다. 지점마다 임무를 골라야 저장할 수 있으니 먼저 임무를 만드세요. 지금 편집은 남겨 둡니다.</span>
      {newMission && <button type="button" className="btn" onClick={newMission}>새 임무</button>}</div>}
    <h3>① 지도</h3>
    {/* 장소 › 건물 › 층 하나 고르기(앱 공용 .fh-user .fh-sel 모양). 승인 판 없는 층은 편집 때 고를 수 없다 — 읽기 전용은 지점이 있으면 그 판으로 */}
    {!approved.length && (set || !pts.length) ? <p className="lv-note">승인된 지도가 있는 층이 없습니다. 지도 탭에서 지도를 먼저 올리세요.</p>
      : <label className="fh-row"><span className="lbl">지도</span><select className="fh-user fh-sel" aria-label="지도" value={cur} onChange={(e) => setCur(e.target.value)}>
          {places.map((p) => { const c = pts.filter((w) => w.floor_id === p.floor.id).length;
            return <option key={p.floor.id} value={p.floor.id} disabled={!p.floor.approved_version_id && (!!set || !c)}>
              {`${p.site.name} › ${p.building.name} › ${p.floor.name}${c ? ` (지점 ${c})` : ''}${p.floor.approved_version_id ? '' : ' — 승인된 지도 없음'}`}</option>; })}</select></label>}
    {/* ② 지도 + 오른쪽 단계 창(파워포인트 애니메이션 창처럼 접고 펼침). 좁은 칸이면 지도 아래 접는 막대 — 지도를 가리지 않는다(missions.css) */}
    <div className="ms-box"><div className="ms-edit" data-open={open ? '' : undefined}>
      <div className="ms-map">
        {mapErr && <div className="fh-row"><p className="fh-msg" role="alert">지도를 받지 못했습니다. {mapErr}</p><button type="button" className="btn" onClick={() => { setMapErr(''); setMapN((x) => x + 1); }}>다시 받기</button></div>}
        {v && <MapFrame ref={svg} {...look} photo={v} edit={!!set} role="img" aria-label={`${floorName(cur)} 지도`} data-map data-scenario-map onPointerDown={down} onPointerMove={move} onPointerUp={end} onPointerCancel={end}
          style={{ display: 'block', width: '100%', maxHeight: '60vh', borderRadius: 8, ...(set && { cursor: 'crosshair' }) }}>
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
        </MapFrame>}
        {set && v && <p className="lv-note" role="status">{placing === 'target' ? '지도를 누르면 끝나고 갈 지점을 놓습니다(이름 붙은 지도 지점을 누르면 그 지점).'
          : '지도를 누르면 지점을 추가합니다. 이름 붙은 지도 지점을 누르면 그 지점을 씁니다. 찍힌 지점을 누르면 고르고, 끌면 옮깁니다. 고른 지점 오른쪽 위 X 로 지웁니다. 빨간 구역은 진입 금지입니다.'}</p>}
        {back && <div className="fh-row" role="status" data-undo><span>{back.text}</span>
          <button type="button" className="btn" onClick={() => { put(back.w, back.f); setUndo(null); }}>되돌리기</button></div>}
        {msg && <p className="fh-msg" role="alert">{msg}</p>}
      </div>
      <aside className="ms-steps" aria-label="단계 창">
        <button type="button" className="btn ms-fold" aria-expanded={open} aria-controls="ms-steps" onClick={() => { pane.open = !open; setOpen(!open); }}>{open ? `단계 ${pts.length} ▸` : `◂ 단계 ${pts.length}`}</button>
        {open && <div id="ms-steps" className="fh-form">
          {set && mErr && <div className="fh-row"><p className="fh-msg" role="alert">임무 목록을 받지 못했습니다. {mErr}</p><button type="button" className="btn" onClick={() => setMN((x) => x + 1)}>다시 받기</button></div>}
          {set && <label className="fh-field"><span>실행 확인할 로봇</span><select className="inp" value={robot} onChange={(ev) => { pane.robot = ev.target.value; setRobot(ev.target.value); }}>
            <option value="">고르지 않음</option>{mineRobots.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>}
          {set && cat.err && <div className="fh-row"><p className="fh-msg" role="alert">실행할 수 있는지 확인하지 못했습니다. {cat.err}</p><button type="button" className="btn" onClick={cat.again}>다시 받기</button></div>}
          {qMsg && <p className="fh-msg" role="alert">{qMsg}</p>}
          {making && <p className="lv-note" role="status">임무를 만드는 중…</p>}
          {set && unsure && <div className="fh-row" role="status" data-unsure><span className="lv-note fh-grow">{unsure === 'failed' ? '임무를 만들었는지 아직 확인하지 못했습니다' : '임무를 만들었는지 확인하는 중…'} — 확인될 때까지 사진·대기 임무를 새로 만들지 않습니다.</span>
            {unsure === 'failed' && <button type="button" className="btn" onClick={() => { setUnsure('checking'); setMN((x) => x + 1); }}>다시 확인</button>}</div>}
          {!pts.length && <p className="lv-note">아직 단계가 없습니다. 지도를 눌러 지점을 찍으세요.</p>}
          <fieldset disabled={making} style={{ display: 'contents' }}>
          <ol className="fh-form" style={LIST} aria-label="지점 순서">{pts.map((p, i) => {
            const e = `waypoints.${i}`, pr = res[e], b = marks.has(e), m = missions?.find((x) => x.id === p.mission_id), val = p.mission_id ? `${p.mission_id}:${p.mission_version}` : '';
            const listed = active.some((x) => `${x.id}:${x.latest_version}` === val), fresh = m && m.latest_version === p.mission_version ? m : undefined;   // 고른 판 = 최신 판일 때만 내용을 안다
            const sec = set ? waitOf(fresh) : null, no = set && fresh ? cannot(fresh) : null;
            return <li key={i} data-wp={i} data-bad={b ? '' : undefined} className="ms-step" style={b ? { outline: '2px solid var(--bad)' } : undefined}>
              <div className="fh-row">
                <button type="button" className="btn fh-grow ms-name" aria-pressed={sel === i} onClick={() => go(i)}>{i + 1}. {p.floor_id === cur ? '' : `${floorName(p.floor_id)} · `}{p.waypoint_ref ? `«${refName(p)}»` : `(${p.x.toFixed(1)}, ${p.y.toFixed(1)}) m`}</button>
                {set && <><button type="button" className="btn" aria-label={`${i + 1}번 지점 위로`} disabled={!i} onClick={() => shift(i, -1)}>↑</button>
                  <button type="button" className="btn" aria-label={`${i + 1}번 지점 아래로`} disabled={i === pts.length - 1} onClick={() => shift(i, 1)}>↓</button>
                  <button type="button" className="btn" aria-label={`${i + 1}번 지점 지우기`} onClick={() => drop(i)}>✕</button></>}
              </div>
              {/* 이 지점에서 할 일 = 임무 판. 사진·대기는 여기서 바로 고르면 한 단계 임무를 찾거나 만들어 잇는다(임무 목록을 받기 전에는 못 고름 — 같은 임무를 또 만들지 않게) */}
              {set ? <select className="inp" aria-label={`${i + 1}번 지점 임무`} value={val} onChange={(ev) => choose(i, ev.target.value)}>
                  <option value="">임무 고르기</option>
                  <optgroup label="바로 고르기"><option value="do:PHOTO" disabled={!missions || !!unsure}>사진 찍기(RGB)</option><option value="do:WAIT" disabled={!missions || !!unsure}>대기 30초 — 초는 고른 뒤 바꿈</option></optgroup>
                  <optgroup label="임무">{val && !listed && <option value={val}>{`${m?.name ?? '알 수 없는 임무'} · 판 ${p.mission_version}${m?.archived_at ? ' (보관됨)' : ' (옛 판)'}`}</option>}
                  {active.map((x) => <option key={x.id} value={`${x.id}:${x.latest_version}`}>{`${x.name} · 판 ${x.latest_version}`}</option>)}</optgroup></select>
                : <span className="lbl">{m ? `${m.name} · 판 ${p.mission_version}` : `임무 판 ${p.mission_version}`}</span>}
              {fresh && <span className="lbl" data-do>할 일: {doText(fresh)}</span>}
              {sec != null && <WaitSecs i={i} sec={sec} apply={(n) => quick(i, quickSteps('WAIT', n))} />}
              {no && <p className="fh-why" data-cannot>저장은 되지만 지금은 실행 불가 — {no}</p>}
              {pr && !pr.reachable && <p className="fh-msg" role="alert">갈 수 없음: {pr.reasons.join(' ')}</p>}
              {bad.filter((x) => x.at === e).map((x, j) => <p key={j} className="fh-msg" role="alert">{x.text}</p>)}
            </li>; })}</ol>
          </fieldset>
          <label className="fh-field"><span>끝나면</span><select className="inp" value={finish.mode ?? 'STAY'} disabled={!set} onChange={(ev) => { const mode = ev.target.value as keyof typeof FINISH; put(pts, { mode, target: mode === 'GO_TO' ? target : null }); if (mode === 'GO_TO' && !target) setPlacing('target'); else setPlacing('point'); }}>
            {(Object.keys(FINISH) as (keyof typeof FINISH)[]).map((m) => <option key={m} value={m}>{FINISH[m]}</option>)}</select></label>
          {finish.mode === 'GO_TO' && <div className="fh-row" data-finish data-bad={marks.has('finish.target') ? '' : undefined}>
            {target ? <button type="button" className="btn" aria-pressed={sel === 'T'} onClick={() => go('T')}>끝 지점: {floorName(target.floor_id)} · {target.waypoint_ref ? `«${refName(target)}»` : `(${target.x.toFixed(1)}, ${target.y.toFixed(1)}) m`}</button>
              : <span className="lv-note">끝나고 갈 지점을 아직 찍지 않았습니다.</span>}
            {set && <button type="button" className="btn" aria-pressed={placing === 'target'} onClick={() => setPlacing(placing === 'target' ? 'point' : 'target')}>{placing === 'target' ? '지점 찍기로 돌아가기' : '끝 지점 찍기'}</button>}
            {res['finish.target'] && !res['finish.target'].reachable && <p className="fh-msg" role="alert">끝 지점에 갈 수 없음: {res['finish.target'].reasons.join(' ')}</p>}
          </div>}
        </div>}
      </aside>
    </div></div>
    <h3>③ 확인</h3>
    {!set ? (saved ? <p className="lv-note">예상 거리 약 {Math.round(saved.est_distance_m)} m · 필요 장치: {devices(saved.required_devices)}</p> : null) : <div className="fh-form" aria-label="경로 확인" data-preview>
      {missing && <p className="lv-note">{missing}</p>}
      {!missing && checking && <p className="lv-note" role="status">경로를 확인하는 중…</p>}
      {r && <>
        <p className={r.reachable ? 'fh-msg ok' : 'fh-msg'} role={r.reachable ? 'status' : 'alert'}>{r.reachable ? '모든 지점에 갈 수 있습니다.' : '갈 수 없는 지점이 있습니다. 빨간 지점을 옮기거나 지우세요.'}</p>
        <p>예상 거리 약 {Math.round(r.est_distance_m)} m <span className="lbl">— 지점 사이 직선과 층 연결점까지 거리로 잰 대략 값입니다. 실제로 걷는 길은 실행할 때 로봇이 정합니다.</span></p>
        <p>필요 장치: {devices(r.required_devices)}</p>
        {r.segments.some((s) => !s.reachable || s.via.length) && <ul className="fh-list" aria-label="구간">{r.segments.filter((s) => !s.reachable || s.via.length).map((s, j) =>
          <li key={j} className="fh-row"><span>{elName(s.start)} → {elName(s.end)}</span><span className={s.reachable ? 'lbl' : 'fh-why'}>{s.reachable ? `${floorName(s.via[0]?.floor_id ?? '')} → ${floorName(s.via[1]?.floor_id ?? '')} 층 연결점을 거칩니다` : s.reason}</span></li>)}</ul>}
      </>}
      {pe && <div className="fh-row"><p className="fh-msg" role="alert">{pe.code === 'STALE' ? STALE : pe.status === 422 ? '고른 임무 판을 쓸 수 없습니다(보관됐을 수 있음). 표시한 지점의 임무를 다시 고르세요.' : `경로를 확인하지 못했습니다. ${pe.message}`}</p>
        {pe.code === 'STALE' ? <button type="button" className="btn" disabled={lock} onClick={() => { setRemap(true); treeAgain(); }}>새 지도로 다시 확인</button>
          : pe.status !== 422 && <button type="button" className="btn" disabled={lock} onClick={() => setN((x) => x + 1)}>다시 확인</button>}</div>}
    </div>}
  </>;
}
