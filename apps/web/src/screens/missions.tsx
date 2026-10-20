// 임무 탭(01 MS-01·02·03·09, 02 F-MS-01~04·§10, 03 §5.3, 05 §6.1~6.3 — S5a /actions·/missions·/scenarios·/scenarios/preview).
// 목록 [임무 | 시나리오](보관 제외 기본·보관 보기·더 보기) + 편집 칸. 저장할 때마다 새 판(PUT If-Match = 받은 본체 version), 옛 판은 읽기 전용(덮어쓰기 단추 없음).
// 시나리오 지도 그리기·좌표 변환은 지도 탭 함수(screens/maps·mapedit) 그대로. 배정·실행·폰 카드는 S5b·S7 뒤(W6b) — 자리도 두지 않는다.
// STOP 은 App 머리줄 — 이 화면은 창 키·포인터를 잡지 않는다(지도 svg 포인터만).
import { useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent } from 'react';
import type { Action, MapVersion, Mission, MissionStep, MissionWrite, Scenario, ScenarioPoint, ScenarioPreview, ScenarioWaypoint, ScenarioWrite } from '../../../contracts/ts';
import { ApiFail, api, type Plan } from '../api';
import type { Robot, User } from '../fake';
import { KIND as DEVICE, type Ctx } from '../screens';
import { Note, Shapes, canon, floorsOf, isVersion, reasonBad, shape, toPixel, useTree, type Msg, type Place } from './maps';
import { fromScreen, inside, nameBad } from './mapedit';

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
export const keptPlan: { kind: Plan; sel: string | null; drafts: Record<string, Draft>; now: boolean } = { kind: 'scenarios', sel: null, drafts: {}, now: false };
/** 로그아웃 때 비운다(session.tsx) */
export const clearPlans = () => { keptPlan.kind = 'scenarios'; keptPlan.sel = null; keptPlan.drafts = {}; keptPlan.now = false; };
addEventListener('beforeunload', (e) => { if (keptPlan.now || Object.keys(keptPlan.drafts).length) { e.preventDefault(); e.returnValue = ''; } });

/** 목록(오래된 것 먼저) + cursor 로 더 받기. 종류·보관 보기를 바꾸면 처음부터 — 앞 요청의 늦은 답은 버린다(결재 탭 useList 와 같다) */
function useList(kind: Plan, archived: boolean, cancel?: AbortSignal) {
  const [items, setItems] = useState<AnyPlan[]>([]), [next, setNext] = useState<string | null>(null), [busy, setBusy] = useState(true), [err, setErr] = useState(''), [n, setN] = useState(0), seq = useRef(0);
  const load = (cursor: string | null) => {
    const k = ++seq.current;
    setBusy(true); setErr('');
    if (!cursor) { setItems([]); setNext(null); }
    api.plans(kind, archived, cursor, cancel).then(fit((r: { items: AnyPlan[]; next_cursor: string | null }) => !!r && arr(r.items) && r.items.every(isPlan) && (r.next_cursor === null || str(r.next_cursor)))).then((r) => {
      if (k !== seq.current) return;
      setItems((o) => (cursor ? [...o, ...r.items.filter((x) => !o.some((y) => y.id === x.id))] : r.items)); setNext(r.next_cursor); setBusy(false);
    }, (e: ApiFail) => { if (k !== seq.current || e.code === 'CANCELED') return; setErr(e.message); setBusy(false); });
  };
  useEffect(() => { load(null); }, [kind, archived, n]);
  return { items, next, busy, err, more: () => load(next), again: () => setN((x) => x + 1) };
}

/** 임무 탭(03 §5.3): 왼쪽 [임무 | 시나리오] 목록, 오른쪽 편집. 총괄은 모두, 운영 관리자는 자기 것만 고치고 남의 것은 보는 중(02 §10) */
export function Missions(c: Pick<Ctx, 'user' | 'cancel' | 'robots'>) {
  const [kind, setKind] = useState<Plan>(keptPlan.kind), [archived, setArchived] = useState(false), l = useList(kind, archived, c.cancel);
  const [sel, setSel] = useState<string | null>(keptPlan.sel), [msg, setMsg] = useState<Msg>(null), [n, setN] = useState(0), tree = useTree(c.cancel);
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
      <ul className="fh-list" aria-label={`${WHAT[kind]} 목록`}>{l.items.map((x) => <li key={x.id}>
        <button type="button" aria-pressed={x.id === sel} data-plan={x.id} onClick={() => { setSel(x.id); setMsg(null); }}>
          <b>{x.name}</b>
          {'waypoints' in x && <span className="lbl">{floorText(x.floor_ids)}</span>}
          <span className="fh-grow" /><span className="mono">판 {x.latest_version}</span>
          <span className="lbl">{'steps' in x ? `작업 ${x.steps.length}` : `지점 ${x.waypoints.length}`}</span>
          {x.archived_at && <span className="lbl">보관됨</span>}
          {keptPlan.drafts[`${kind}:${x.id}`] && <span className="lbl">저장 안 한 편집</span>}
        </button></li>)}</ul>
      {!l.busy && !l.err && !l.items.length && <p className="lv-note">{kind === 'missions' ? '임무가 없습니다. «새 임무»로 사진·대기 같은 작업을 묶으세요.' : '시나리오가 없습니다. «새 시나리오»로 지도에 지점을 찍어 만드세요.'}</p>}
      {l.err && <p className="fh-msg" role="alert">{WHAT[kind]} 목록을 받지 못했습니다. {l.err}</p>}
      {l.busy && <p className="lv-note" role="status">목록을 불러오는 중…</p>}
      {!l.busy && (l.next || l.err) && <div className="fh-row"><button type="button" className="btn" onClick={l.err && !l.items.length ? l.again : l.more}>{l.err ? '다시 시도' : '더 보기'}</button></div>}
    </section>
    <section className="lv-card" aria-label={`${WHAT[kind]} 편집`}>
      <Note m={msg} />
      {sel == null ? <p className="lv-note">목록에서 {WHAT[kind]}를 고르거나 «새 {WHAT[kind]}»를 누르세요.</p>
        : <Edit key={`${kind}-${sel}-${sel ? '' : n}`} kind={kind} id={sel} user={c.user} robots={c.robots} cancel={c.cancel} places={places} treeAgain={tree.again}
            done={(x, m) => { l.again(); setMsg(m); if (x && x.id !== sel) setSel(x.id); }} />}
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
function Edit({ kind, id, user, robots, cancel, places, treeAgain, done }: { kind: Plan; id: string; user: User; robots: Robot[]; cancel?: AbortSignal; places: Place[]; treeAgain: () => void; done: (x: AnyPlan | null, m: Msg) => void }) {
  const key = `${kind}:${id}`, [kd] = useState(() => keptPlan.drafts[key] ?? null), admin = user.role === 'ORG_ADMIN';
  const [latest, setLatest] = useState<AnyPlan | null>(null), [base, setBase] = useState<AnyPlan | null>(kd?.base ?? null), [body, setBody] = useState<AnyWrite | null>(kd?.body ?? (id ? null : empty(kind)));
  const [view, setView] = useState<AnyPlan | null>(null), [err, setErr] = useState(''), [msg, setMsg] = useState<Msg>(kd ? { text: '저장하지 않은 편집을 이어서 씁니다.', ok: true } : null);
  const [bad, setBad] = useState<Bad[]>([]), [block, setBlock] = useState<string | null>(null), [recheck, setRecheck] = useState(0), [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false), [unsure, setUnsure] = useState<Unsure | null>(kd?.unsure ?? null), [checking, setChecking] = useState(false), [again, setAgain] = useState(false), live = useRef(true);
  const what = WHAT[kind];

  /** 최신 판 받기. adopt = 받은 판으로 본문까지(처음 열 때), base = 기준 판만(입력 보존 — 409 뒤) */
  const load = (adopt: 'all' | 'base' | 'none') => api.plan(kind, id, null, cancel).then(fit(isPlan)).then((x) => {
    if (!live.current) return;
    setLatest(x); setErr('');
    if (adopt === 'all') { setBase(x); setBody(bodyOf(x)); }
    if (adopt === 'base') { setBase(x); setConflict(false); setMsg({ text: `최신 판(판 ${x.number})을 받았습니다. 입력은 그대로입니다 — 저장하면 다음 판(판 ${x.number + 1})이 됩니다. 최신 판 내용은 «판»에서 고르면 볼 수 있습니다.`, ok: true }); }
    if (adopt === 'none' && kd?.base && kd.base.version !== x.version) { setConflict(true); setMsg({ text: CONFLICT }); }
  }, (e: ApiFail) => { if (live.current && e.code !== 'CANCELED') setErr(e.status === 404 ? `이 ${what}를 찾을 수 없습니다. 목록을 다시 받으세요.` : `${what}를 받지 못했습니다. ${e.message}`); });
  useEffect(() => { live.current = true; if (id) load(kd ? 'none' : 'all'); if (kd?.unsure) check(kd.unsure); return () => { live.current = false; }; }, []);

  const mine = !id || (latest ? admin || latest.created_by === user.id : false), archived = !!latest?.archived_at;
  const editable = mine && !archived && (!id || !!latest), lock = busy || !!unsure;
  const dirty = !!body && (base ? !same(base, body) : canon(body) !== canon(empty(kind)));
  // 내려갈 때 남긴다(저장 안 한 편집·확인 전 저장) — 저장되면 비운다
  const snap = useRef<Draft | null>(null);
  snap.current = body && editable && (dirty || unsure) ? { body, base, unsure } : null;
  keptPlan.now = !!snap.current;
  useEffect(() => () => { keptPlan.now = false; if (snap.current) keptPlan.drafts[key] = snap.current; else delete keptPlan.drafts[key]; }, []);

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
  const failed = (e: ApiFail) => {
    if (e.code === 'VERSION_CONFLICT' || e.status === 428) { setConflict(true); setMsg({ text: CONFLICT }); return; }
    if (e.code === 'STALE') { setBad(elementsOf(e).map((at) => ({ at, text: '이 지점의 지도가 바뀌었습니다.' }))); setRecheck((x) => x + 1); setMsg({ text: STALE }); return; }
    if (e.status === 422) {
      const at = elementsOf(e);
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
      .then(() => (base ? api.savePlan(kind, base.id, base.version, b, cancel) : api.createPlan(kind, b, cancel))).then(fit(isPlan))   // 빈·어긋난 성공 = 불확실(status 0)
      .then((x) => { if (!live.current) { delete keptPlan.drafts[key]; return; } setBusy(false); saved(x, `저장했습니다(판 ${x.number}).`); },
        (e: ApiFail) => {
          if (!live.current) { const d = keptPlan.drafts[key]; if (d && e.status === 0 && (base || u.known)) d.unsure = u; return; }   // 내려간 뒤 끝남 — 다시 열면 확인부터
          setBusy(false);
          if (e.code === 'CANCELED') return;
          if (!base && !u.known) return setMsg({ text: `저장하지 못했습니다. 저장 전에 목록을 확인하지 못해 보내지 않았습니다. ${e.message} 다시 누르세요.` });
          if (e.status === 0) { setUnsure(u); setMsg({ text: '저장 응답을 받지 못했습니다. 저장됐을 수 있어 확인합니다. 입력은 그대로 있습니다.' }); check(u); return; }
          failed(e);
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
  // 보관 — 되돌리는 API 는 없지만 옛 판은 계속 읽히고 배정·기록은 그대로라 확인창을 두지 않는다(U10 확인창 목록 밖)
  const archive = () => {
    setBusy(true); setMsg(null);
    api.archivePlan(kind, id, cancel).then(() => load('all').then(() => { if (!live.current) return; setBusy(false); snap.current = null; delete keptPlan.drafts[key]; done(null, { text: `보관했습니다. «보관된 것도 보기»에서 옛 판을 계속 볼 수 있습니다.`, ok: true }); }),
      (e: ApiFail) => { if (!live.current || e.code === 'CANCELED') return; setBusy(false); setMsg({ text: e.status === 0 ? '보관 응답을 받지 못했습니다. 목록을 다시 받아 확인하세요.' : `보관하지 못했습니다. ${e.message}` }); if (e.status === 0) done(null, null); });
  };
  const pickVersion = (n: number) => {
    if (!latest || n === latest.latest_version) return setView(null);
    api.plan(kind, id, n, cancel).then(fit(isPlan)).then((x) => live.current && setView(x), (e: ApiFail) => { if (live.current && e.code !== 'CANCELED') setMsg({ text: `판 ${n} 내용을 받지 못했습니다. ${e.message}` }); });
  };

  if (err) return <div className="fh-row"><p className="fh-msg" role="alert">{err}</p><button type="button" className="btn" onClick={() => { setErr(''); load('all'); }}>다시 받기</button></div>;
  if (!body) return <p className="lv-note" role="status">불러오는 중…</p>;
  const shown = view ? bodyOf(view) : body, ro = !!view || !editable;
  const put = (b: AnyWrite) => { if (lock || ro) return; setBody(b); setBad([]); setMsg(null); };
  const nameBadNow = bad.find((b) => b.at === 'name');
  return <div className="fh-form" aria-label={`${what} 편집 칸`}>
    <div className="fh-row"><h2 className="fh-grow">{id ? shown.name || what : `새 ${what}`}</h2>
      {latest && <label className="fh-row"><span>판</span><select className="inp" aria-label="판" value={view?.number ?? latest.latest_version} onChange={(e) => pickVersion(Number(e.target.value))}>
        {Array.from({ length: latest.latest_version }, (_, i) => latest.latest_version - i).map((n) => <option key={n} value={n}>{`판 ${n}${n === latest.latest_version ? ' (최신)' : ''}`}</option>)}</select></label>}</div>
    {view && <p className="lv-note" role="status" data-old>옛 판(판 {view.number})을 보는 중입니다(읽기 전용, {day(view.version_created_at)} 저장). 고치려면 «판»에서 최신 판을 고르세요.</p>}
    {!view && latest && !mine && <p className="lv-note" data-readonly>보는 중 — 만든 사람과 총괄 운영 관리자만 고칠 수 있습니다.</p>}
    {!view && archived && <p className="lv-note" data-readonly>보관된 {what}입니다. 고칠 수 없고 옛 판은 볼 수 있습니다.</p>}
    {/* 저장 중·저장 확인 전에는 입력을 모두 막는다(보낸 내용과 초안이 달라지지 않게). STOP 은 App 머리줄 그대로 */}
    <fieldset disabled={lock && !ro} style={{ display: 'contents' }}>
      <label className="fh-field"><span>이름</span><input className="inp" maxLength={128} value={shown.name} readOnly={ro} aria-invalid={!!nameBadNow} onChange={(e) => put({ ...body, name: e.target.value })} /></label>
      {kind === 'missions'
        ? <MissionForm value={shown as MissionWrite} set={ro ? undefined : (b) => put(b)} bad={view ? [] : bad} robots={robots} user={user} cancel={cancel} />
        : <ScenarioForm key={view ? `v${view.number}` : 'draft'} value={shown as ScenarioWrite} set={ro ? undefined : (b) => put(b)} lock={lock} bad={view ? [] : bad} places={places} treeAgain={treeAgain}
            cancel={cancel} setBlock={setBlock} recheck={recheck} saved={(view ?? (id ? latest : null)) as Scenario | null} />}
    </fieldset>
    {!ro && <form className="fh-form" onSubmit={save} noValidate aria-label="저장">
      <div className="fh-row"><button type="submit" className="btn pri" disabled={lock || (kind === 'scenarios' && !!block)} aria-describedby={kind === 'scenarios' && block ? 'plan-block' : undefined}>{id ? '새 판으로 저장' : '저장'}</button>
        {conflict && <button type="button" className="btn" disabled={lock} onClick={() => load('base')}>최신 판 받기</button>}
        {id && <button type="button" className="btn" disabled={lock} onClick={archive}>보관</button>}</div>
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

/** 작업 단계(01 MS-01·09): 카탈로그(GET /actions)에서 고르고 인자를 넣는다. 로봇을 고르면 그 로봇 장치로 할 수 없는 작업·선택지는 회색 + 이유(고를 수 없음) */
function MissionForm({ value, set, bad, robots, user, cancel }: { value: MissionWrite; set?: (v: MissionWrite) => void; bad: Bad[]; robots: Robot[]; user: User; cancel?: AbortSignal }) {
  const [robot, setRobot] = useState(''), [acts, setActs] = useState<Action[] | null>(null), [err, setErr] = useState('');
  const mineRobots = robots.filter((r) => user.role === 'ORG_ADMIN' || r.owner === user.id);   // 담당 밖 로봇은 서버가 404
  useEffect(() => {
    let live = true;
    setErr('');
    api.actions(robot || null, cancel).then(fit(isActs)).then((a) => { if (live) setActs(a); }, (e: ApiFail) => { if (live && e.code !== 'CANCELED') setErr(e.message); });
    return () => { live = false; };
  }, [robot]);
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
    {err && <p className="fh-msg" role="alert">작업 목록을 받지 못했습니다. {err}</p>}
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
              <select className="inp" value={String(p[param] ?? '')} onChange={(e) => swap(i, { ...s, params: { ...p, [param]: e.target.value } })}>
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
      <button type="button" className="btn" disabled={!a.available || steps.length >= 100} aria-describedby={a.available ? undefined : `act-${a.key}`} onClick={() => add(a)}>＋ {a.label}</button>
      {!a.available && <span id={`act-${a.key}`} className="fh-why" data-why>{plain(a.why_unavailable)}</span>}</div>)}</div>}
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
const elName = (e: string) => (e === 'finish.target' ? '끝 지점' : /^waypoints\.(\d+)/.test(e) ? `${Number(/^waypoints\.(\d+)/.exec(e)![1]) + 1}번 지점` : e);

/** 시나리오 편집(02 F-MS-02·03, 03 §5.3): ① 지도(승인 판이 있는 층) ② 지점(지도 눌러 추가·끌어 옮기기·순서·지우기, 이름 붙은 지도 지점은 waypoint_ref) ③ 확인(서버 미리보기).
 *  set 없음 = 읽기 전용(남의 것·옛 판·보관) — 미리보기 대신 저장된 거리·장치. setBlock = 저장을 막는 이유(갈 수 없는 지점·확인 전), recheck = 저장이 STALE 로 막혀 다시 미리보기 */
function ScenarioForm({ value, set, lock, bad, places, treeAgain, cancel, setBlock, recheck, saved }: { value: ScenarioWrite; set?: (v: ScenarioWrite) => void; lock: boolean; bad: Bad[]; places: Place[]; treeAgain: () => void;
  cancel?: AbortSignal; setBlock: (s: string | null) => void; recheck: number; saved: Scenario | null }) {
  const pts = value.waypoints, finish = value.finish ?? { mode: 'STAY', target: null }, target = finish.target ?? null;
  const [cur, setCur] = useState(() => pts[0]?.floor_id ?? places.find((p) => p.floor.approved_version_id)?.floor.id ?? '');
  useEffect(() => { if (!cur) setCur(pts[0]?.floor_id ?? places.find((p) => p.floor.approved_version_id)?.floor.id ?? ''); }, [places.length]);
  const place = places.find((p) => p.floor.id === cur), vid = place?.floor.approved_version_id ?? null;
  const [maps, setMaps] = useState<Record<string, MapVersion>>({}), [mapErr, setMapErr] = useState('');
  useEffect(() => {
    if (!vid || maps[vid]) return;
    setMapErr('');
    api.version(vid, cancel).then(shape(isVersion)).then((x) => setMaps((m) => ({ ...m, [vid]: x })), (e: ApiFail) => { if (e.code !== 'CANCELED') setMapErr(e.message); });
  }, [vid]);
  const v = vid ? maps[vid] : undefined;
  // 임무 고르기: 보관 안 된 임무의 최신 판. 이미 고른 옛 판·보관된 임무는 그 지점에만 그대로 보인다
  const [missions, setMissions] = useState<Mission[] | null>(null), [mErr, setMErr] = useState(''), [mN, setMN] = useState(0);
  useEffect(() => { api.allPlans('missions', cancel).then((l) => { setMissions(l.filter((x) => isPlan(x) && 'steps' in x)); setMErr(''); }, (e: ApiFail) => { if (e.code !== 'CANCELED') setMErr(e.message); }); }, [mN]);
  const active = (missions ?? []).filter((m) => !m.archived_at);
  const [sel, setSel] = useState<number | 'T' | null>(null), [placing, setPlacing] = useState<'point' | 'target'>('point'), [msg, setMsg] = useState('');
  const svg = useRef<SVGSVGElement>(null), drag = useRef<{ i: number | 'T'; from: P; orig: ScenarioPoint } | null>(null);
  useEffect(() => { if (lock) drag.current = null; }, [lock]);
  const floorName = (id: string) => { const p = places.find((x) => x.floor.id === id); return p ? `${p.building.name} ${p.floor.name}` : '모르는 층'; };
  const refName = (p: ScenarioPoint) => { const a = places.find((x) => x.floor.id === p.floor_id)?.floor.approved_version_id; return (a && maps[a]?.features.waypoints.find((w) => w.id === p.waypoint_ref)?.name) || '지도 지점'; };

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
  const now = pre?.key === k && !checking ? pre : null, r = now?.r, pe = now?.e;
  const block = !set ? null : missing ?? (!now ? '경로를 확인하는 중입니다.' : pe ? (pe.code === 'STALE' ? STALE : pe.status === 422 ? '고른 임무 판을 쓸 수 없습니다(보관됐을 수 있음). 표시한 지점의 임무를 다시 고르세요.' : `경로를 확인하지 못했습니다. ${pe.message}`)
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
    if (e.button !== 0 || !set || lock || !v) return;
    const q = fromScreen(svg.current!, v, e.clientX, e.clientY), t = e.target as Element;
    const hit = t.closest('[data-pt]')?.getAttribute('data-pt');
    setMsg('');
    if (hit != null && placing === 'point') {
      const i = hit === 'T' ? 'T' : Number(hit), o = ptAt(i);
      setSel(i);
      if (o) { drag.current = { i, from: q, orig: o }; svg.current!.setPointerCapture?.(e.pointerId); }
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
    const q = fromScreen(svg.current!, v, e.clientX, e.clientY), x = d.orig.x + q[0] - d.from[0], y = d.orig.y + q[1] - d.from[1];
    if (!inside(v, x, y)) return;   // 범위 밖으로는 옮기지 않는다(마지막 자리에 둠)
    // 지도 지점에 붙은 지점은 0.05 m 안 흔들림이면 그대로, 넘으면 참조를 떼고 새 좌표(서버는 0.05 m 넘으면 거절)
    const near = d.orig.waypoint_ref && Math.hypot(x - d.orig.x, y - d.orig.y) <= 0.05;
    const n: ScenarioPoint = near ? d.orig : { ...d.orig, x, y, waypoint_ref: null };
    if (d.i === 'T') put(pts, { mode: 'GO_TO', target: n }); else put(pts.map((o, j) => (j === d.i ? { ...o, ...n } : o)));
  };
  const end = () => { drag.current = null; };
  const shift = (i: number, dd: number) => { const s = [...pts], [x] = s.splice(i, 1); s.splice(i + dd, 0, x); put(s); setSel(i + dd); };
  const choose = (i: number, val: string) => { const [mission_id, ver] = val.split(':'); put(pts.map((o, j) => (j === i ? { ...o, mission_id: mission_id ?? '', mission_version: Number(ver) || 1 } : o))); };
  const go = (i: number | 'T') => { const p = ptAt(i); setSel(i); if (p) setCur(p.floor_id); };

  const approved = places.filter((p) => p.floor.approved_version_id);
  const rr = v ? Math.max(v.width, v.height) / 60 : 1;
  const on = pts.map((p, i) => [p, i] as const).filter(([p]) => p.floor_id === cur);
  return <>
    <h3>① 지도</h3>
    {!approved.length ? <p className="lv-note">승인된 지도가 있는 층이 없습니다. 지도 탭에서 지도를 먼저 올리세요.</p>
      : <div className="fh-row" role="group" aria-label="층" style={{ flexWrap: 'wrap' }}>{places.map((p) => { const c = pts.filter((w) => w.floor_id === p.floor.id).length;
          return <button key={p.floor.id} type="button" className="btn" aria-pressed={p.floor.id === cur} disabled={!p.floor.approved_version_id} onClick={() => setCur(p.floor.id)}>
            {p.site.name} · {p.building.name} · {p.floor.name}{c ? ` (지점 ${c})` : ''}{p.floor.approved_version_id ? '' : ' — 승인된 지도 없음'}</button>; })}</div>}
    <h3>② 지점</h3>
    {mapErr && <div className="fh-row"><p className="fh-msg" role="alert">지도를 받지 못했습니다. {mapErr}</p><button type="button" className="btn" onClick={() => { setMapErr(''); setMaps((m) => ({ ...m })); setCur(cur); }}>다시 받기</button></div>}
    {v && <svg ref={svg} viewBox={`0 0 ${v.width} ${v.height}`} role="img" aria-label={`${floorName(cur)} 지도`} data-map data-scenario-map onPointerDown={down} onPointerMove={move} onPointerUp={end} onPointerCancel={end}
      style={{ display: 'block', width: '100%', maxHeight: '60vh', background: 'var(--panel2)', borderRadius: 8, touchAction: set ? 'none' : undefined, cursor: set ? 'crosshair' : 'default' }}>
      <image href={api.imageUrl(v.id)} width={v.width} height={v.height} style={{ imageRendering: 'pixelated' }} onError={() => setMapErr('지도 그림을 불러오지 못했습니다.')} />
      <Shapes v={v} f={v.features} />
      {on.length > 1 && <polyline points={on.map(([p]) => toPixel(v, p.x, p.y).join(',')).join(' ')} style={{ fill: 'none', stroke: 'var(--accent)', strokeWidth: 2, strokeDasharray: '6 4' }} vectorEffect="non-scaling-stroke" />}
      {on.map(([p, i]) => { const [x, y] = toPixel(v, p.x, p.y), b = marks.has(`waypoints.${i}`);
        return <g key={i} data-pt={i} data-bad={b ? '' : undefined}><circle cx={x} cy={y} r={sel === i ? rr * 1.3 : rr} style={{ fill: b ? 'var(--bad)' : 'var(--accent)', stroke: '#FFFFFF', strokeWidth: 2 }} vectorEffect="non-scaling-stroke" />
          <text x={x} y={y + rr * 0.45} fontSize={rr * 1.3} textAnchor="middle" style={{ fill: '#FFFFFF', pointerEvents: 'none' }}>{i + 1}</text></g>; })}
      {target && target.floor_id === cur && (() => { const [x, y] = toPixel(v, target.x, target.y), b = marks.has('finish.target');
        return <g data-pt="T" data-bad={b ? '' : undefined}><rect x={x - rr} y={y - rr} width={rr * 2} height={rr * 2} style={{ fill: b ? 'var(--bad)' : 'var(--ink-3)', stroke: '#FFFFFF', strokeWidth: 2 }} vectorEffect="non-scaling-stroke" />
          <text x={x} y={y + rr * 0.45} fontSize={rr * 1.1} textAnchor="middle" style={{ fill: '#FFFFFF', pointerEvents: 'none' }}>끝</text></g>; })()}
    </svg>}
    {set && v && <p className="lv-note" role="status">{placing === 'target' ? '지도를 누르면 끝나고 갈 지점을 놓습니다(이름 붙은 지도 지점을 누르면 그 지점).'
      : '지도를 누르면 지점을 추가합니다. 이름 붙은 지도 지점을 누르면 그 지점을 씁니다. 번호 지점은 끌어서 옮깁니다. 빨간 구역은 진입 금지입니다.'}</p>}
    {msg && <p className="fh-msg" role="alert">{msg}</p>}
    {set && mErr && <div className="fh-row"><p className="fh-msg" role="alert">임무 목록을 받지 못했습니다. {mErr}</p><button type="button" className="btn" onClick={() => setMN((x) => x + 1)}>다시 받기</button></div>}
    {set && missions && !active.length && <p className="lv-note">고를 임무가 없습니다. «임무»에서 먼저 임무를 만드세요.</p>}
    <ol className="fh-form" style={LIST} aria-label="지점 순서">{pts.map((p, i) => {
      const e = `waypoints.${i}`, pr = res[e], b = marks.has(e), m = missions?.find((x) => x.id === p.mission_id), val = p.mission_id ? `${p.mission_id}:${p.mission_version}` : '';
      const listed = active.some((x) => `${x.id}:${x.latest_version}` === val);
      return <li key={i} data-wp={i} data-bad={b ? '' : undefined} style={b ? { outline: '2px solid var(--bad)', borderRadius: 8 } : undefined}>
        <div className="fh-row" style={{ flexWrap: 'wrap' }}>
          <button type="button" className="btn" aria-pressed={sel === i} onClick={() => go(i)}>{i + 1}. {floorName(p.floor_id)} · {p.waypoint_ref ? `«${refName(p)}»` : `(${p.x.toFixed(1)}, ${p.y.toFixed(1)}) m`}</button>
          {set ? <select className="inp" aria-label={`${i + 1}번 지점 임무`} value={val} onChange={(ev) => choose(i, ev.target.value)}>
              <option value="">임무 고르기</option>
              {val && !listed && <option value={val}>{`${m?.name ?? '알 수 없는 임무'} · 판 ${p.mission_version}${m?.archived_at ? ' (보관됨)' : ' (옛 판)'}`}</option>}
              {active.map((x) => <option key={x.id} value={`${x.id}:${x.latest_version}`}>{`${x.name} · 판 ${x.latest_version}`}</option>)}</select>
            : <span>{m ? `${m.name} · 판 ${p.mission_version}` : `임무 판 ${p.mission_version}`}</span>}
          <span className="fh-grow" />
          {set && <><button type="button" className="btn" aria-label={`${i + 1}번 지점 위로`} disabled={!i} onClick={() => shift(i, -1)}>↑</button>
            <button type="button" className="btn" aria-label={`${i + 1}번 지점 아래로`} disabled={i === pts.length - 1} onClick={() => shift(i, 1)}>↓</button>
            <button type="button" className="btn" aria-label={`${i + 1}번 지점 지우기`} onClick={() => { put(pts.filter((_, j) => j !== i)); setSel(null); }}>지우기</button></>}
        </div>
        {pr && !pr.reachable && <p className="fh-msg" role="alert">갈 수 없음: {pr.reasons.join(' ')}</p>}
        {bad.filter((x) => x.at === e).map((x, j) => <p key={j} className="fh-msg" role="alert">{x.text}</p>)}
      </li>; })}</ol>
    <label className="fh-field"><span>끝나면</span><select className="inp" value={finish.mode ?? 'STAY'} disabled={!set} onChange={(ev) => { const mode = ev.target.value as keyof typeof FINISH; put(pts, { mode, target: mode === 'GO_TO' ? target : null }); if (mode === 'GO_TO' && !target) setPlacing('target'); else setPlacing('point'); }}>
      {(Object.keys(FINISH) as (keyof typeof FINISH)[]).map((m) => <option key={m} value={m}>{FINISH[m]}</option>)}</select></label>
    {finish.mode === 'GO_TO' && <div className="fh-row" data-bad={marks.has('finish.target') ? '' : undefined}>
      {target ? <button type="button" className="btn" aria-pressed={sel === 'T'} onClick={() => go('T')}>끝 지점: {floorName(target.floor_id)} · {target.waypoint_ref ? `«${refName(target)}»` : `(${target.x.toFixed(1)}, ${target.y.toFixed(1)}) m`}</button>
        : <span className="lv-note">끝나고 갈 지점을 아직 찍지 않았습니다.</span>}
      {set && <button type="button" className="btn" aria-pressed={placing === 'target'} onClick={() => setPlacing(placing === 'target' ? 'point' : 'target')}>{placing === 'target' ? '지점 찍기로 돌아가기' : '끝 지점 찍기'}</button>}
      {res['finish.target'] && !res['finish.target'].reachable && <p className="fh-msg" role="alert">끝 지점에 갈 수 없음: {res['finish.target'].reasons.join(' ')}</p>}
    </div>}
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
