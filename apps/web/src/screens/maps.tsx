// 지도 탭(01 MP-01·02·04·06, 02 F-MP-01·02·04, 03 §5.6, 05 §5 — S3a /sites·/map-versions·/uploads)과 관제 지도 칸의 층 고르기(FL-03).
// 나무·판·그림·요소는 서버 값 그대로 그린다. 편집 도구는 screens/mapedit.tsx(W4b), 비교·되돌리기·결재 대기 수는 다음 작업(S3b·S4), 로봇 점은 위치-판 묶기(D5) 뒤.
// 큰 그림은 <image> 가 쿠키로 따로 받는다 — 불러오기·실패는 이 칸 안 글로만, 머리줄·STOP 은 경계(App Guard) 밖.
import { useEffect, useState, type FormEvent } from 'react';
import type { MapBuilding, MapFeatures, MapFloor, MapSite, MapUpload, MapVersion, SiteTree } from '../../../contracts/ts';
import { ApiFail, api } from '../api';
import type { User } from '../fake';
import { leaving } from '../menu';
import { Chip, Line, type Ctx } from '../screens';
import { Editor, type EditBase } from './mapedit';

export type Place = { site: MapSite; building: MapBuilding; floor: MapFloor };
const floorsOf = (t: SiteTree | null): Place[] => (t ? t.items.flatMap((site) => site.buildings.flatMap((building) => building.floors.map((floor) => ({ site, building, floor })))) : []);

// 받은 값 모양 검사 — 어긋난 응답이 화면을 깨뜨리지 않게 오류 한 줄로만(screens/history.tsx 와 같은 방식)
const str = (v: unknown) => typeof v === 'string', num = (v: unknown) => typeof v === 'number' && Number.isFinite(v), arr = Array.isArray;
const isTree = (t: SiteTree) => !!t && arr(t.items) && t.items.every((s) => !!s && str(s.id) && str(s.name) && arr(s.buildings)
  && s.buildings.every((b) => !!b && str(b.id) && str(b.name) && arr(b.floors) && b.floors.every((f) => !!f && str(f.id) && str(f.name) && (f.approved_version_id === null || str(f.approved_version_id)))));
const isPoint = (p: { x: unknown; y: unknown }) => !!p && num(p.x) && num(p.y);
export const isVersion = (v: MapVersion) => !!v && str(v.id) && Number.isInteger(v.number) && num(v.width) && v.width > 0 && num(v.height) && v.height > 0
  && num(v.resolution) && v.resolution > 0 && arr(v.origin) && v.origin.length === 3 && v.origin.every(num) && !!v.features
  && arr(v.features.zones) && v.features.zones.every((z) => !!z && arr(z.polygon) && z.polygon.every((p) => arr(p) && num(p[0]) && num(p[1])))
  && arr(v.features.waypoints) && v.features.waypoints.every(isPoint) && arr(v.features.connectors) && v.features.connectors.every(isPoint)
  && arr(v.features.edits) && v.features.edits.every((e) => !!e && num(e.width) && arr(e.polyline) && e.polyline.every((p) => arr(p) && num(p[0]) && num(p[1])));
const isUpload = (u: MapUpload) => !!u && str(u.upload_id);
export const shape = <T,>(ok: (x: T) => boolean) => (x: T) => { if (!ok(x)) throw new ApiFail(0, 'BAD_SHAPE', '받은 지도 형식이 맞지 않습니다. 잠시 뒤 다시 시도하세요.'); return x; };

/** 지도 좌표(m) → 그림 픽셀. ROS 지도는 origin 이 그림 왼쪽 아래 칸의 위치·방향이고 그림 행은 위에서 아래라 y 를 뒤집는다.
 *  회전은 서버 검사(maps.validate_features)와 같다 */
export function toPixel(v: Pick<MapVersion, 'origin' | 'resolution' | 'height'>, x: number, y: number): [number, number] {
  const [ox, oy, yaw] = v.origin, dx = x - ox, dy = y - oy, c = Math.cos(yaw), s = Math.sin(yaw);
  return [(c * dx + s * dy) / v.resolution, v.height - (-s * dx + c * dy) / v.resolution];
}

export const ZONE = { NO_GO: { text: '진입 금지', color: 'var(--bad)' }, SLOW: { text: '감속', color: 'var(--warn)' } } as const;
export const KIND = { STAIRS: '계단', ELEVATOR: '엘리베이터' } as const;
export const EDIT = { ERASE: { text: '지우개', color: 'var(--muted)' }, WALL: { text: '벽', color: 'var(--text)' } } as const;
const SEL = { stroke: 'var(--accent)', strokeWidth: 4 }, BAD = { stroke: 'var(--bad)', strokeWidth: 4, strokeDasharray: '6 4' };

/** 요소 그리기(보기·편집 같이). 선 굵기는 지도 m 그대로(그림 픽셀), 지점은 방향 선 하나.
 *  data-key = «무리.번호»(편집에서 고르기), sel = 고른 요소, bad = 검사에 걸린 요소 */
export function Shapes({ v, f, sel, bad }: { v: Pick<MapVersion, 'origin' | 'resolution' | 'height' | 'width'>; f: MapFeatures; sel?: string; bad?: string }) {
  const p = (x: number, y: number) => toPixel(v, x, y), r = Math.max(v.width, v.height) / 100;
  const mark = (k: string): { stroke?: string; strokeWidth?: number; strokeDasharray?: string } => (k === bad ? BAD : k === sel ? SEL : {});
  return <>
    {f.edits.map((e, i) => <polyline key={`e${i}`} data-key={`edits.${i}`} data-edit={e.op} points={e.polyline.map(([x, y]) => p(x, y).join(',')).join(' ')}
      style={{ fill: 'none', stroke: EDIT[e.op]?.color, strokeWidth: e.width / v.resolution, strokeLinecap: 'round', strokeLinejoin: 'round', opacity: 0.85, ...(mark(`edits.${i}`).stroke && { stroke: mark(`edits.${i}`).stroke, strokeDasharray: mark(`edits.${i}`).strokeDasharray }) }}><title>{`${EDIT[e.op]?.text ?? ''} 선`}</title></polyline>)}
    {f.zones.map((z, i) => <polygon key={`z${i}`} data-key={`zones.${i}`} data-zone={z.type} points={z.polygon.map(([x, y]) => p(x, y).join(',')).join(' ')}
      style={{ fill: ZONE[z.type]?.color, fillOpacity: 0.25, stroke: ZONE[z.type]?.color, strokeWidth: 2, ...mark(`zones.${i}`) }} vectorEffect="non-scaling-stroke"><title>{`${ZONE[z.type]?.text ?? ''} 구역 ${z.name}`}</title></polygon>)}
    {f.waypoints.map((w, i) => { const [x, y] = p(w.x, w.y), [hx, hy] = p(w.x + Math.cos(w.yaw) * r * 2.2 * v.resolution, w.y + Math.sin(w.yaw) * r * 2.2 * v.resolution);
      return <g key={`w${i}`} data-key={`waypoints.${i}`} data-waypoint={w.name}>
        <line x1={x} y1={y} x2={hx} y2={hy} style={{ stroke: 'var(--accent)', strokeWidth: 2 }} vectorEffect="non-scaling-stroke" />
        <circle cx={x} cy={y} r={r} style={{ fill: 'var(--accent)', ...mark(`waypoints.${i}`) }} vectorEffect="non-scaling-stroke" /><text x={x} y={y - r * 1.6} fontSize={r * 2.4} textAnchor="middle" style={{ fill: 'var(--text)' }}>{w.name}</text></g>; })}
    {f.connectors.map((k, i) => { const [x, y] = p(k.x, k.y); return <rect key={`c${i}`} data-key={`connectors.${i}`} data-connector={k.kind} x={x - r} y={y - r} width={r * 2} height={r * 2}
      style={{ fill: 'var(--warn)', ...mark(`connectors.${i}`) }} vectorEffect="non-scaling-stroke"><title>{`${KIND[k.kind] ?? ''} 연결점`}</title></rect>; })}
  </>;
}

/** 판 그림 + 저장된 요소(구역·지점·연결점·지우개·벽 선). 그림을 못 받으면 칸 안 글 + 다시 불러오기 */
export function MapView({ v }: { v: MapVersion }) {
  const [at, setAt] = useState<'wait' | 'ok' | 'bad'>('wait'), [n, setN] = useState(0);
  return <div>
    <svg viewBox={`0 0 ${v.width} ${v.height}`} role="img" aria-label={`판 ${v.number} 지도`} data-map style={{ display: 'block', width: '100%', maxHeight: '60vh', background: 'var(--panel2)', borderRadius: 8 }}>
      <image key={n} href={api.imageUrl(v.id)} width={v.width} height={v.height} style={{ imageRendering: 'pixelated' }} onLoad={() => setAt('ok')} onError={() => setAt('bad')} />
      <Shapes v={v} f={v.features} />
    </svg>
    {at === 'wait' && <p className="lv-note" role="status">지도 그림을 불러오는 중…</p>}
    {at === 'bad' && <div className="fh-row"><p className="fh-msg" role="alert">지도 그림을 불러오지 못했습니다. 네트워크를 확인한 뒤 다시 불러오세요.</p>
      <button type="button" className="btn" onClick={() => { setAt('wait'); setN(n + 1); }}>다시 불러오기</button></div>}
  </div>;
}

/** 장소 나무(GET /sites). again = 다시 받기 */
function useTree(cancel?: AbortSignal) {
  const [tree, setTree] = useState<SiteTree | null>(null), [err, setErr] = useState(''), [n, setN] = useState(0);
  useEffect(() => {
    let live = true;   // 다시 받기가 겹치면 지난 요청의 늦은 답은 버린다
    api.sites(cancel).then(shape(isTree)).then((t) => { if (live) { setTree(t); setErr(''); } }, (e: ApiFail) => { if (live && e.code !== 'CANCELED') setErr(e.message); });
    return () => { live = false; };
  }, [n]);
  return { tree, err, again: () => setN((x) => x + 1) };
}

const day = (at: string) => new Date(at).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });
const verName = (v: MapVersion, approved: string | null) => `판 ${v.number}${v.id === approved ? ' · 승인' : ''}`;

type Kind = 'sites' | 'buildings' | 'floors';
const WHAT: Record<Kind, string> = { sites: '장소', buildings: '건물', floors: '층' };
const OBJ: Record<Kind, string> = { sites: '장소를', buildings: '건물을', floors: '층을' };
const IN_USE: Record<Kind, string> = {
  sites: '건물이 있는 장소는 지울 수 없습니다. 안의 건물을 먼저 지우세요.',
  buildings: '층이 있는 건물은 지울 수 없습니다. 안의 층을 먼저 지우세요.',
  floors: '쓰는 지도 판이 있어 지울 수 없습니다(로봇·층 연결점이 쓰는 층 포함).',
};
/** 장소 바꾸기 실패 = 무엇이 + 어떻게(U8). 403 은 서버 문구 그대로 */
const placeFail = (e: ApiFail, k: Kind) => (e.code === 'RESOURCE_IN_USE' ? IN_USE[k] : e.status === 404 ? `이 ${OBJ[k]} 찾을 수 없습니다. 지워졌을 수 있어 목록을 다시 받습니다.` : e.message);

/** 고치기 칸: 새로 만들기(parent) 또는 이름 바꾸기(id). 층은 층 번호(지하 1층 = -1)도 */
type Form = { kind: Kind; id?: string; parent?: string; title: string; name: string; level: string };
export type Msg = { text: string; ok?: boolean } | null;
export const Note = ({ m }: { m: Msg }) => (m ? <p className={`fh-msg${m.ok ? ' ok' : ''}`} role={m.ok ? 'status' : 'alert'}>{m.text}</p> : null);

/** 지도 탭(03 §5.6): 왼쪽 장소 나무, 가운데 고른 층의 판 보기. 총괄만 장소 고치기·지도 올리기 단추(운영 관리자는 단추 없음) */
export function Maps(c: Pick<Ctx, 'user' | 'cancel'>) {
  const admin = c.user.role === 'ORG_ADMIN', t = useTree(c.cancel), places = floorsOf(t.tree);
  const [pick, setPick] = useState(''), cur = places.find((p) => p.floor.id === pick) ?? places[0];
  const [fix, setFix] = useState(false), [form, setForm] = useState<Form | null>(null), [ask, setAsk] = useState<{ kind: Kind; id: string; name: string } | null>(null);
  const [msg, setMsg] = useState<Msg>(null), [busy, setBusy] = useState(false);
  const names = useNames(c.user, admin, c.cancel), nums = useNumbers(places, c.cancel);
  const run = async (k: Kind, f: () => Promise<unknown>, ok: string) => {
    setBusy(true); setMsg(null);
    try { await f(); setForm(null); setAsk(null); setMsg({ text: ok, ok: true }); t.again(); }
    catch (e) { const x = e as ApiFail; if (x.code === 'CANCELED') return; setMsg({ text: placeFail(x, k) }); if (x.status === 404) t.again(); }
    finally { setBusy(false); }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!form) return;
    const name = form.name.trim(), level = Number(form.level), k = form.kind;
    if (!name) return setMsg({ text: '이름을 입력하세요.' });
    if (/[\p{Cc}\p{Cf}]/u.test(form.name)) return setMsg({ text: '이름에 줄바꿈·탭 같은 보이지 않는 글자는 쓸 수 없습니다.' });   // 서버도 422
    if (k === 'floors' && !(/^\s*-?\d+\s*$/.test(form.level) && Math.abs(level) <= 1000)) return setMsg({ text: '층 번호는 -1000~1000 사이 정수로 입력하세요(지하 1층 = -1).' });
    const p = k === 'floors' ? { name, level } : { name };
    run(k, async () => {
      if (form.id) return api.savePlace(k, form.id, p, c.cancel);
      if (k === 'sites') return api.createSite(name, c.cancel);
      if (k === 'buildings') return api.createBuilding(form.parent!, name, c.cancel);
      setPick((await api.createFloor(form.parent!, { name, level }, c.cancel)).id);
    }, form.id ? '이름을 바꿨습니다.' : `${OBJ[k]} 만들었습니다.`);
  };
  const open = (f: Omit<Form, 'name' | 'level'> & { name?: string; level?: number }) => { setForm({ ...f, name: f.name ?? '', level: String(f.level ?? 1) }); setAsk(null); setMsg(null); };
  // 고치기 켠 총괄에게만: 이름 바꾸기·지우기
  const tools = (kind: Kind, x: { id: string; name: string; level?: number }) => fix && <span className="fh-row">
    <button type="button" className="btn" disabled={busy} onClick={() => open({ kind, id: x.id, title: `${WHAT[kind]} 이름 바꾸기 — ${x.name}`, name: x.name, level: x.level })}>이름 바꾸기</button>
    <button type="button" className="btn" disabled={busy} onClick={() => { setAsk({ kind, id: x.id, name: x.name }); setForm(null); setMsg(null); }}>지우기</button></span>;

  return <>
    <section className="lv-card" style={{ flex: '0 1 260px' }} aria-label="장소">
      <div className="fh-row"><h2 className="fh-grow">장소</h2>{admin && <button type="button" className="btn" aria-pressed={fix} onClick={() => { setFix(!fix); setForm(null); setAsk(null); setMsg(null); }}>고치기</button>}</div>
      {t.tree?.items.map((s) => <div key={s.id} aria-label={`장소 ${s.name}`} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div className="fh-row"><b className="fh-grow">{s.name}</b>{tools('sites', s)}</div>
        {s.buildings.map((b) => <div key={b.id} style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 12 }}>
          <div className="fh-row"><span className="fh-grow">{b.name}</span>{tools('buildings', b)}</div>
          <ul className="fh-list" aria-label={`${b.name} 층`}>{b.floors.map((f) => <li key={f.id} className="fh-row">
            <button type="button" aria-pressed={f.id === cur?.floor.id} style={{ flex: 1 }} onClick={() => { const go = () => { setPick(f.id); setMsg(null); }; if (leaving.ask && f.id !== cur?.floor.id) leaving.ask(go); else go(); }}><span className="fh-grow">{f.name}</span>
              <span className="lbl">{!f.approved_version_id ? '지도 없음' : nums[f.approved_version_id] ? `판 ${nums[f.approved_version_id]}` : ''}</span></button>{tools('floors', f)}</li>)}</ul>
          {fix && <button type="button" className="btn" disabled={busy} onClick={() => open({ kind: 'floors', parent: b.id, title: `${s.name} ${b.name} 에 새 층` })}>+ 층</button>}
        </div>)}
        {fix && <button type="button" className="btn" disabled={busy} onClick={() => open({ kind: 'buildings', parent: s.id, title: `${s.name} 에 새 건물` })}>+ 건물</button>}
      </div>)}
      {t.tree && !t.tree.items.length && <p className="lv-note">{admin ? '등록된 장소가 없습니다. «고치기»에서 장소·건물·층을 만드세요.' : '등록된 장소가 없습니다. 총괄 운영 관리자에게 문의하세요.'}</p>}
      {fix && <button type="button" className="btn" disabled={busy} onClick={() => open({ kind: 'sites', title: '새 장소' })}>+ 장소</button>}
      {form && <form className="fh-form" onSubmit={submit} noValidate aria-label={form.title}>
        <b>{form.title}</b>
        <label className="fh-field"><span>이름</span><input className="inp" maxLength={128} value={form.name} autoFocus onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        {form.kind === 'floors' && <label className="fh-field"><span>층 번호(지하 1층 = -1)</span><input className="inp" inputMode="numeric" value={form.level} onChange={(e) => setForm({ ...form, level: e.target.value })} /></label>}
        <div className="fh-row"><button type="submit" className="btn pri" disabled={busy}>저장</button><button type="button" className="btn" onClick={() => setForm(null)}>취소</button></div>
      </form>}
      {ask && <div className="fh-row" role="group" aria-label="확인">
        <span>«{ask.name}» {OBJ[ask.kind]} 지울까요?</span>
        <button type="button" className="btn pri" disabled={busy} onClick={() => run(ask.kind, () => api.deletePlace(ask.kind, ask.id, c.cancel), `«${ask.name}» ${OBJ[ask.kind]} 지웠습니다.`)}>지우기</button>
        <button type="button" className="btn" onClick={() => setAsk(null)}>취소</button>
      </div>}
      <Note m={msg} />
      {t.err && <div className="fh-row"><p className="fh-msg" role="alert">장소 목록을 받지 못했습니다. {t.err}</p><button type="button" className="btn" onClick={t.again}>다시 시도</button></div>}
      {!t.tree && !t.err && <p className="lv-note" role="status">장소 목록을 불러오는 중…</p>}
    </section>
    {cur ? <FloorView key={cur.floor.id} p={cur} admin={admin} names={names} cancel={c.cancel} again={t.again} />
      : <section className="lv-card" aria-label="지도 보기"><p className="lv-note">{t.tree ? '층을 만들면 여기에서 지도를 봅니다.' : ''}</p></section>}
  </>;
}

/** 층마다 승인 판 번호 — /sites 층에는 판 id 만 있어 판 정보(GET /map-versions/{id})를 한 번씩 받는다. 못 받으면 번호 없이 */
function useNumbers(places: Place[], cancel?: AbortSignal) {
  const [nums, setNums] = useState<Record<string, number>>({}), ids = places.map((p) => p.floor.approved_version_id).filter((x): x is string => !!x);
  useEffect(() => {
    for (const id of ids) if (!nums[id]) api.version(id, cancel).then(shape(isVersion)).then((v) => setNums((o) => ({ ...o, [id]: v.number })), () => {});
  }, [ids.join()]);
  return nums;
}

/** 만든 사람: 나는 내 이름, 총괄은 계정 목록(GET /users)에서. 모르면 줄을 숨긴다(U9) — 판 응답에는 사람 id 만 있다 */
function useNames(me: User, admin: boolean, cancel?: AbortSignal) {
  const [all, setAll] = useState<Record<string, string>>({});
  useEffect(() => { if (admin) api.users(cancel).then((l) => setAll(Object.fromEntries(l.map((u) => [u.id, u.display_name]))), () => {}); }, []);
  return (id: string) => all[id] ?? (id === me.id ? me.name : undefined);
}

/** 고른 층: 판 목록(GET /floors/{id}/map-versions) → 승인 판(또는 고른 옛 판) 그림·정보, 총괄은 보기/편집 토글(승인 판이 있을 때)·새 지도 올리기.
 *  운영 관리자는 편집 단추 없음(결재 S4 전) */
function FloorView({ p, admin, names, cancel, again }: { p: Place; admin: boolean; names: (id: string) => string | undefined; cancel?: AbortSignal; again: () => void }) {
  const approved = p.floor.approved_version_id;
  const [got, setGot] = useState<{ key: string; list: MapVersion[] } | null>(null), [err, setErr] = useState(''), [n, setN] = useState(0), [sel, setSel] = useState('');
  const [editing, setEditing] = useState<EditBase | null>(null), [done, setDone] = useState<Msg>(null);   // editing = 편집 시작 때 승인 판(저장 기준)
  // 목록은 받을 때의 기준(몇 번째 받기 + 승인 판 id)과 묶어 둔다 — 기준이 바뀌면 새 목록이 올 때까지 없음으로(늦게 온 옛 목록이 덮지 않게)
  const key = `${n}:${approved}`;
  useEffect(() => {
    let live = true;
    setErr('');
    api.versions(p.floor.id, cancel).then(shape((l: MapVersion[]) => l.every(isVersion))).then((l) => { if (live) setGot({ key, list: l }); }, (e: ApiFail) => {
      if (!live || e.code === 'CANCELED') return;
      setErr(e.status === 404 ? '이 층을 찾을 수 없습니다. 지워졌을 수 있어 장소 목록을 다시 받습니다.' : `판 목록을 받지 못했습니다. ${e.message}`);
      if (e.status === 404) again();
    });
    return () => { live = false; };
  }, [key]);
  const list = got?.key === key ? got.list : null;
  const now = list?.find((v) => v.id === approved) ?? null, v = list?.find((x) => x.id === sel) ?? now, who = v && names(v.created_by);
  const title = `${p.site.name} ${p.building.name} ${p.floor.name}`;
  const reload = () => { setN(n + 1); again(); };
  return <section className="lv-card" aria-label="지도 보기">
    <div className="fh-row">{admin && now && <span className="fh-row" role="group" aria-label="보기·편집">
        <button type="button" className="btn" aria-pressed={!editing} onClick={() => { if (!editing) return; if (leaving.ask) leaving.ask(() => setEditing(null)); else setEditing(null); }}>보기</button>
        <button type="button" className="btn" aria-pressed={!!editing} onClick={() => { if (!editing) { setEditing(now); setSel(''); setDone(null); } }}>편집</button></span>}
      <h2 className="fh-grow">{title}{editing ? ` · 판 ${editing.number} 편집 중` : now ? ` · 승인 판 ${now.number}` : ''}</h2>
      {!editing && !!list?.length && <label className="fh-row"><span className="lbl">판</span><select className="fh-user" aria-label="판" value={v?.id ?? ''} onChange={(e) => setSel(e.target.value)}>
        {!v && <option value="">판 고르기</option>}{list.map((x) => <option key={x.id} value={x.id}>{verName(x, approved)}</option>)}</select></label>}
    </div>
    {editing ? <Editor v={editing} p={p} cancel={cancel} quit={() => setEditing(null)} recheck={reload}
        saved={(x) => { setEditing(null); setSel(x.id); setDone({ text: `새 판을 저장했습니다(판 ${x.number}). 다음 실행부터 이 판을 씁니다.`, ok: true }); reload(); }} />
    : v ? <>
      <Note m={done} />
      {v.id !== approved && <p className="lv-note" role="status">지난 판을 보는 중입니다.{now ? ` 지금 승인 판은 판 ${now.number}입니다.` : ''}</p>}
      <MapView key={v.id} v={v} />
      <Line k="판"><span>판 {v.number}</span><Chip tone={v.id === approved ? 'ok' : 'off'} text={v.id === approved ? '승인' : '지난 판'} /></Line>
      <Line k="이유"><span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{v.reason}</span></Line>
      {who && <Line k="만든 사람"><span>{who}</span></Line>}
      <Line k="만든 때"><span>{day(v.created_at)}</span></Line>
      <Line k="요소"><span>구역 {v.features.zones.length} · 지점 {v.features.waypoints.length} · 연결점 {v.features.connectors.length}</span></Line>
    </> : list && <p className="lv-note">아직 지도가 없습니다.{admin ? ' 아래에서 지도 파일을 올리세요.' : ''}</p>}
    {err && <div className="fh-row"><p className="fh-msg" role="alert">{err}</p><button type="button" className="btn" onClick={() => setN(n + 1)}>다시 시도</button></div>}
    {!list && !err && <p className="lv-note" role="status">판 목록을 불러오는 중…</p>}
    {/* 승인 판이 있으면 그 판의 요소를 받은 뒤에만 올리기(못 받은 채 올리면 진입 금지·감속 구역이 빈 채로 새 승인 판이 된다) */}
    {admin && !editing && <Upload floor={p.floor.id} base={approved} keep={now?.features ?? null} ready={!!list && (!approved || !!now)} cancel={cancel}
      saved={(x) => { setSel(x.id); setN(n + 1); again(); }} again={() => { setN(n + 1); again(); }} />}
  </section>;
}

const IMAGE_MAX = 8 * 1024 * 1024, YAML_MAX = 16 * 1024;   // 서버 상한(apps/server README S3a) — 넘으면 보내기 전에 알린다
const TOO_BIG = '파일이 너무 큽니다. 지도 그림은 8 MB, 지도 설정(yaml)은 16 KB 까지 올릴 수 있습니다.';
const STALE = '다른 사람이 먼저 이 층의 지도를 바꿨습니다. 새로 불러온 뒤 다시 올리세요.';
const imageType = (f: File) => (/\.pgm$/i.test(f.name) ? 'image/x-portable-graymap' : /\.png$/i.test(f.name) ? 'image/png' : '');
/** 올리기 실패 = 어느 단계에서 + 어떻게. 서버의 형식 오류 문구(파일 내부 용어)는 쉬운 말로 바꾸고, 403 등은 서버 문구 그대로 */
function upFail(e: ApiFail, step: number) {
  if (e.code === 'UPLOAD_TOO_LARGE') return TOO_BIG;
  if (e.code === 'STALE') return STALE;
  if (e.code === 'INVALID_FEATURES') return '지금 판의 구역·지점·연결점 중 새 지도 범위 밖에 있는 것이 있습니다. «지금 판의 구역·지점·연결점 그대로 두기»를 끄고 다시 올리세요.';
  if (e.code === 'INVALID_UPLOAD') return step === 0 ? '지도 그림 파일을 읽을 수 없습니다. 지도를 만들 때 저장한 pgm·png 파일인지, 가로·세로 4096 픽셀 이하인지 확인하세요.'
    : step === 1 ? '지도 설정 파일을 읽을 수 없습니다. 그림과 함께 저장된 yaml 파일인지 확인하세요.' : '올린 파일을 지도로 쓸 수 없습니다. 두 파일을 다시 골라 올리세요.';
  if (e.status === 404) return '이 층을 찾을 수 없습니다. 지워졌을 수 있어 새로 불러오세요.';
  if (e.status === 408 || e.code === 'TIMEOUT') return '파일을 보내는 데 시간이 너무 오래 걸렸습니다. 네트워크를 확인한 뒤 다시 올리세요.';
  if (e.code === 'SERVER_BUSY') return '서버가 지금 다른 지도를 처리하고 있습니다. 잠시 뒤 다시 올리세요.';   // 변환 칸이 차면 대기 없이 503(05 §1.4)
  return e.message;   // 다른 503(FILE_STORAGE_FULL·FILE_STORAGE_ERROR 등)은 서버의 원인 문구 그대로
}

/** 새 지도 올리기(총괄, MP-02 의 파일 올리기): 그림 → 그 ID 로 yaml → 판 저장. 앞 단계가 실패하면 다음 단계를 보내지 않는다.
 *  base = 지금 승인 판(다르면 서버가 409 STALE). keep = 지금 판의 구역·지점·연결점(벽 고침 선은 옛 그림 것이라 빼고) */
function Upload({ floor, base, keep, ready, cancel, saved, again }: { floor: string; base: string | null; keep: MapFeatures | null; ready: boolean; cancel?: AbortSignal; saved: (v: MapVersion) => void; again: () => void }) {
  const [img, setImg] = useState<File | null>(null), [yml, setYml] = useState<File | null>(null), [reason, setReason] = useState(''), [hold, setHold] = useState(true);
  const [step, setStep] = useState(''), [msg, setMsg] = useState<Msg>(null), [stale, setStale] = useState(false), [fresh, setFresh] = useState(0);   // fresh = 저장 뒤 파일 칸 비우기
  const go = async (e: FormEvent) => {
    e.preventDefault();
    if (step || !ready) return;
    setStale(false);
    const type = img && imageType(img);
    if (!img || !yml) return setMsg({ text: '지도 그림(pgm·png)과 지도 설정(yaml) 파일을 모두 고르세요.' });
    if (!type) return setMsg({ text: '지도 그림은 pgm 또는 png 파일이어야 합니다.' });
    if (!/\.ya?ml$/i.test(yml.name)) return setMsg({ text: '지도 설정은 yaml 파일이어야 합니다.' });
    if (img.size > IMAGE_MAX || yml.size > YAML_MAX) return setMsg({ text: TOO_BIG });
    if (!reason.trim()) return setMsg({ text: '바꾼 이유를 입력하세요.' });
    setMsg(null);
    let at = 0;
    try {
      setStep('지도 그림을 올리는 중…');
      const a = await api.upload(img, type, undefined, cancel).then(shape(isUpload));
      at = 1; setStep('지도 설정을 올리는 중…');
      const b = await api.upload(yml, 'text/yaml', a.upload_id, cancel).then(shape(isUpload));
      at = 2; setStep('새 판으로 저장하는 중…');
      const features: MapFeatures = hold && keep ? { zones: keep.zones, waypoints: keep.waypoints, connectors: keep.connectors, edits: [] } : { zones: [], waypoints: [], connectors: [], edits: [] };
      const v = await api.saveVersion(floor, { base_version_id: base, image: b.upload_id, features, reason: reason.trim() }, cancel).then(shape(isVersion));   // 빈·어긋난 201 = 저장 불확실(status 0)
      setMsg({ text: `새 판을 저장했습니다(판 ${v.number}). 다음 실행부터 이 판을 씁니다.`, ok: true }); setImg(null); setYml(null); setReason(''); setFresh(fresh + 1);
      saved(v);
    } catch (x) {
      const f = x as ApiFail;
      if (f.code === 'CANCELED') return;
      // 저장 요청을 보낸 뒤 답이 끊기면(헤더 전·본문 중·마감·깨진 본문) 저장됐을 수도 있다 — 목록을 다시 받아 보여 주고 같은 파일을 두 번 올리지 않게 알린다
      if (at === 2 && f.status === 0) { setMsg({ text: '저장 응답을 받지 못했습니다. 저장됐을 수 있어 판 목록을 다시 받습니다. 새 판이 보이면 다시 올리지 마세요.' }); again(); return; }
      setMsg({ text: `올리지 못했습니다. ${upFail(f, at)}` }); setStale(f.code === 'STALE' || f.status === 404);
    } finally { setStep(''); }
  };
  return <form className="fh-form" onSubmit={go} noValidate aria-label="새 지도 올리기" key={fresh}>
    <h2>새 지도 올리기</h2>
    <label className="fh-field"><span>지도 그림(pgm·png)</span><input type="file" className="inp" accept=".pgm,.png" onChange={(e) => setImg(e.target.files?.[0] ?? null)} /></label>
    <label className="fh-field"><span>지도 설정(yaml)</span><input type="file" className="inp" accept=".yaml,.yml" onChange={(e) => setYml(e.target.files?.[0] ?? null)} /></label>
    <label className="fh-field"><span>바꾼 이유</span><input className="inp" maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
    {keep && <label className="fh-row"><input type="checkbox" checked={hold} onChange={(e) => setHold(e.target.checked)} /><span>지금 판의 구역·지점·연결점 그대로 두기</span></label>}
    {keep && !hold && <p className="fh-msg" role="alert">끄면 진입 금지·감속 구역, 지점, 연결점이 모두 빠진 새 판이 됩니다.</p>}
    {!ready && !step && <p className="lv-note" role="status">지금 승인 판의 구역·지점·연결점을 받은 뒤에 올릴 수 있습니다.</p>}
    <div className="fh-row"><button type="submit" className="btn pri" disabled={!!step || !ready}>올리기</button>{stale && <button type="button" className="btn" onClick={() => { setStale(false); setMsg(null); again(); }}>새로 불러오기</button>}</div>
    {step && <p className="lv-note" role="status">{step}</p>}
    <Note m={msg} />
  </form>;
}

/** 관제 지도 칸(FL-03): 층 단추 + 그 층 승인 판 그림. 로봇 점은 위치에 판이 묶이면(D5) — 지금은 그리지 않는다(지어내지 않음) */
export function FloorMap({ cancel }: { cancel?: AbortSignal }) {
  const t = useTree(cancel), places = floorsOf(t.tree), [pick, setPick] = useState('');
  const cur = places.find((p) => p.floor.id === pick) ?? places.find((p) => p.floor.approved_version_id) ?? places[0];
  const many = new Set(places.map((p) => p.building.id)).size > 1;
  return <>
    {places.length > 0 && <div className="fh-row" role="group" aria-label="층">{places.map((p) => <button key={p.floor.id} type="button" className="btn" aria-pressed={p === cur} onClick={() => setPick(p.floor.id)}>
      {many ? `${p.building.name} ${p.floor.name}` : p.floor.name}</button>)}</div>}
    {cur?.floor.approved_version_id ? <Approved key={cur.floor.approved_version_id} id={cur.floor.approved_version_id} cancel={cancel} />
      : cur ? <p className="lv-note">아직 지도가 없습니다.</p>
      : t.tree && <p className="lv-note">등록된 층이 없습니다. 지도 탭에서 장소·층을 만들면 여기에 보입니다.</p>}
    {t.err && <div className="fh-row"><p className="fh-msg" role="alert">층 목록을 받지 못했습니다. {t.err}</p><button type="button" className="btn" onClick={t.again}>다시 시도</button></div>}
    {!t.tree && !t.err && <p className="lv-note" role="status">층 목록을 불러오는 중…</p>}
  </>;
}

function Approved({ id, cancel }: { id: string; cancel?: AbortSignal }) {
  const [v, setV] = useState<MapVersion | null>(null), [err, setErr] = useState(''), [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    api.version(id, cancel).then(shape(isVersion)).then((x) => { if (live) { setV(x); setErr(''); } }, (e: ApiFail) => { if (live && e.code !== 'CANCELED') setErr(e.message); });
    return () => { live = false; };
  }, [n]);
  if (v) return <MapView v={v} />;
  return err ? <div className="fh-row"><p className="fh-msg" role="alert">지도를 받지 못했습니다. {err}</p><button type="button" className="btn" onClick={() => setN(n + 1)}>다시 시도</button></div>
    : <p className="lv-note" role="status">지도를 불러오는 중…</p>;
}
