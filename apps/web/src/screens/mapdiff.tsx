// 판 비교·되돌리기(01 AP-08·MP-04, 02 F-MP-04, 03 §5.6·U10, 05 §5 — S3b /map-versions/{id}/diff·/rollback).
// 서버는 비교 그림을 만들지 않는다 — 두 판 그림(<image>, 쿠키로 따로 받음)을 같은 지도 좌표로 겹치고, 요소 차이를 추가·삭제·바뀜 색으로 얹는다.
// 되돌리기는 총괄만(운영 관리자는 결재 S4 전이라 단추 없음). 이 칸은 창 전체 키·포인터를 잡지 않는다 — STOP 단추·Space = STOP 은 App 그대로.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { MapConnector, MapDiff, MapEdit, MapFeatureChange, MapFeatures, MapVersion, MapWaypoint, MapZone } from '../../../contracts/ts';
import { ApiFail, api } from '../api';
import { EDIT, KIND, Note, Shapes, ZONE, isVersion, shape, toPixel, type Msg } from './maps';
import { toMap } from './mapedit';

type P = [number, number];
type Geo = Pick<MapVersion, 'origin' | 'resolution' | 'width' | 'height'>;
type Item = MapZone | MapWaypoint | MapConnector | MapEdit;
type Change = MapFeatureChange;

/** 차이 요소를 무리별로 모아 판 요소 검사(isVersion)에 그대로 태운다 */
const gather = (l: Change[]) => { const f: MapFeatures = { zones: [], waypoints: [], connectors: [], edits: [] }; for (const c of l) for (const x of [c.before, c.after]) if (x) (f[c.kind] as Item[]).push(x); return f; };
const KINDS = ['zones', 'waypoints', 'connectors', 'edits'];
/** 응답 모양: 두 판 + 차이마다 있어야 할 쪽(추가 = 뒤, 삭제 = 앞, 바뀜 = 둘 다). 어긋나면 그리지 않고 오류 한 줄 */
const isDiff = (d: MapDiff) => !!d && isVersion(d.version) && (d.against === null || isVersion(d.against)) && typeof d.image_changed === 'boolean' && Array.isArray(d.changes)
  && d.changes.every((c) => !!c && KINDS.includes(c.kind) && ['added', 'removed', 'changed'].includes(c.change) && (c.change === 'added') === !c.before && (c.change === 'removed') === !c.after)
  && isVersion({ ...d.version, features: gather(d.changes) });

export const CH = { added: { text: '추가', color: 'var(--ok)' }, removed: { text: '삭제', color: 'var(--bad)' }, changed: { text: '바뀜', color: 'var(--warn)' } } as const;
/** 내용은 같고 자리만 달라짐(편집선은 칠하는 순서가 뜻이 있어 서버가 changed 로 알림) */
const moved = (c: Change) => c.change === 'changed' && JSON.stringify(c.before) === JSON.stringify(c.after);
const nameOf = (k: Change['kind'], x: Item) => (k === 'zones' ? `${ZONE[(x as MapZone).type]?.text ?? ''} 구역 «${(x as MapZone).name}»` : k === 'waypoints' ? `지점 «${(x as MapWaypoint).name}»`
  : k === 'connectors' ? `${KIND[(x as MapConnector).kind] ?? ''} 연결점` : `${EDIT[(x as MapEdit).op]?.text ?? ''} 선`);
/** 차이 한 줄. 편집선 자리(before_index·after_index, 0부터)가 바뀌면 «순서 바뀜» */
export function says(c: Change) {
  const x = (c.after ?? c.before)!;
  if (c.change !== 'changed') return `${CH[c.change].text} · ${nameOf(c.kind, x)}`;
  const at = c.before_index != null && c.after_index != null && c.before_index !== c.after_index ? ` (${c.before_index + 1}번째 → ${c.after_index + 1}번째)` : '';
  if (moved(c)) return `순서 바뀜 · ${nameOf(c.kind, x)}${at}`;
  const was = nameOf(c.kind, c.before!), now = nameOf(c.kind, x);
  return `바뀜 · ${was === now ? now : `${was} → ${now}`}${at && ` · 순서도 바뀜${at}`}`;
}

/** 요소 하나를 한 색으로(비교 그림). 선 굵기는 화면 픽셀 고정 — 작게 줄인 큰 지도에서도 보이게 */
function Mark({ g, k, x, color, dash, hi }: { g: Geo; k: Change['kind']; x: Item; color: string; dash?: boolean; hi?: boolean }) {
  const p = ([a, b]: number[]) => toPixel(g, a, b).join(','), r = Math.max(g.width, g.height) / 100;
  const st = { stroke: hi ? 'var(--accent)' : color, strokeWidth: hi ? 5 : 3, strokeDasharray: dash ? '6 4' : undefined };
  if ('polygon' in x) return <polygon points={x.polygon.map(p).join(' ')} style={{ fill: color, fillOpacity: dash ? 0.1 : 0.3, ...st }} vectorEffect="non-scaling-stroke" />;
  if ('polyline' in x) return <polyline points={x.polyline.map(p).join(' ')} style={{ fill: 'none', strokeLinecap: 'round', strokeLinejoin: 'round', ...st }} vectorEffect="non-scaling-stroke" />;
  const [cx, cy] = toPixel(g, x.x, x.y);
  return k === 'connectors' ? <rect x={cx - r} y={cy - r} width={r * 2} height={r * 2} style={{ fill: color, fillOpacity: dash ? 0.2 : 0.8, ...st }} vectorEffect="non-scaling-stroke" />
    : <circle cx={cx} cy={cy} r={r} style={{ fill: color, fillOpacity: dash ? 0.2 : 0.8, ...st }} vectorEffect="non-scaling-stroke" />;
}

/** 앞 판 그림 픽셀 → 뒤 판 그림 픽셀(지도 m 를 거침, 둘 다 1차 변환이라 세 점으로 SVG matrix) */
const via = (a: Geo, b: Geo) => (x: number, y: number) => { const [mx, my] = toMap(a, x, y); return toPixel(b, mx, my); };
export function onto(a: Geo, b: Geo) {
  const f = via(a, b), [e, g] = f(0, 0), [p, q] = f(1, 0), [s, t] = f(0, 1), r = (x: number) => Math.round(x * 1e9) / 1e9;
  return `matrix(${[p - e, q - g, s - e, t - g, e, g].map(r).join(' ')})`;
}
/** 두 그림을 모두 담는 viewBox(뒤 판 픽셀 기준) */
function frame(b: Geo, a: Geo | null) {
  const pts: P[] = [[0, 0], [b.width, b.height]];
  if (a) { const f = via(a, b); pts.push(f(0, 0), f(a.width, 0), f(0, a.height), f(a.width, a.height)); }
  const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]), x0 = Math.min(...xs), y0 = Math.min(...ys);
  return `${x0} ${y0} ${Math.max(...xs) - x0} ${Math.max(...ys) - y0}`;
}

/** 비교 실패 = 무엇이 + 어떻게. 그 밖(네트워크·시간 초과 등)은 원인 문구 + 다시 시도 */
function diffFail(e: ApiFail) {
  if (e.code === 'DIFF_TOO_LARGE') return '두 판의 차이가 너무 커서 비교할 수 없습니다. 더 가까운 판을 골라 비교하세요.';
  if (e.code === 'INVALID_FEATURES') return '지도 요소가 너무 많은 판이 있어 비교할 수 없습니다. 다른 판을 골라 비교하세요.';
  return `비교하지 못했습니다. ${e.message}`;
}

const PAGE = 200;   // 차이 목록은 이만큼씩 그린다(큰 차이에서 화면이 멈추지 않게) — 지도 위 표시는 모두
type Img = 'both' | 'before' | 'after';

/** 두 판 비교(모두 볼 수 있음). v = 고른 판(뒤), list = 같은 층 판 목록. 기본 비교 대상 = v 의 기준 판(첫 판이면 빈 지도).
 *  gone = 판·층을 찾을 수 없음(부른 쪽이 비교를 닫고 알린 뒤 목록·나무 다시 받기 — 다시 받는 동안 이 칸은 내려간다) */
export function Compare({ v, list, cancel, gone }: { v: MapVersion; list: MapVersion[]; cancel?: AbortSignal; gone: () => void }) {
  const [against, setAgainst] = useState(''), [n, setN] = useState(0), [d, setD] = useState<MapDiff | null>(null), [err, setErr] = useState('');
  const [hi, setHi] = useState(-1), [show, setShow] = useState(PAGE), [img, setImg] = useState<Img>('both'), [bad, setBad] = useState(false), [k, setK] = useState(0);
  useEffect(() => {
    let live = true;   // 비교 대상을 바꾸면 지난 요청의 늦은 답은 버린다
    setD(null); setErr(''); setHi(-1); setShow(PAGE); setImg('both'); setBad(false);
    api.diff(v.id, against || null, cancel).then(shape(isDiff)).then((x) => { if (live) setD(x); }, (e: ApiFail) => {
      if (!live || e.code === 'CANCELED') return;
      if (e.status === 404) gone(); else setErr(diffFail(e));
    });
    return () => { live = false; };
  }, [against, n]);
  const base = list.find((x) => x.id === v.base_version_id);
  const a = d?.against ?? null, b = d?.version, two = !!a && !!d?.image_changed;
  const count = (f: (c: Change) => boolean) => d?.changes.filter(f).length ?? 0;
  const tally = [['추가', count((c) => c.change === 'added'), CH.added.color], ['삭제', count((c) => c.change === 'removed'), CH.removed.color],
    ['바뀜', count((c) => c.change === 'changed' && !moved(c)), CH.changed.color], ['순서 바뀜', count(moved), CH.changed.color]] as const;
  const onErr = () => setBad(true);
  return <div className="fh-form" aria-label="판 비교">
    <label className="fh-row"><span className="lbl">비교할 판</span><select className="fh-user" aria-label="비교할 판" value={against} onChange={(e) => setAgainst(e.target.value)}>
      <option value="">{v.base_version_id ? `판 ${base?.number ?? ''} (기준 판)` : '빈 지도 (첫 판)'}</option>
      {list.filter((x) => x.id !== v.id && x.id !== v.base_version_id).map((x) => <option key={x.id} value={x.id}>판 {x.number}</option>)}</select></label>
    {d && b && <>
      <b>{a ? `판 ${a.number} → 판 ${b.number}` : `빈 지도 → 판 ${b.number}`}</b>
      {!a ? <p className="lv-note">첫 판이라 빈 지도와 비교합니다. 모든 요소가 추가로 보입니다.</p>
        : two ? <div className="fh-row" role="group" aria-label="지도 그림"><span className="fh-grow">지도 그림이 바뀌었습니다.</span>
          {([['both', '겹쳐 보기'], ['before', `판 ${a.number}`], ['after', `판 ${b.number}`]] as [Img, string][]).map(([m, t]) =>
            <button key={m} type="button" className="btn" aria-pressed={img === m} onClick={() => setImg(m)}>{t}</button>)}</div>
        : <p className="lv-note">지도 그림은 같습니다.</p>}
      <svg viewBox={frame(b, two ? a : null)} role="img" aria-label={`${a ? `판 ${a.number}` : '빈 지도'}와 판 ${b.number} 비교`} data-diff style={{ display: 'block', width: '100%', maxHeight: '60vh', background: 'var(--panel2)', borderRadius: 8 }}>
        {two && img !== 'after' && <image key={`a${k}`} data-image="before" href={api.imageUrl(a!.id)} width={a!.width} height={a!.height} transform={onto(a!, b)} style={{ imageRendering: 'pixelated' }} onError={onErr} />}
        {(!two || img !== 'before') && <image key={`b${k}`} data-image="after" href={api.imageUrl(b.id)} width={b.width} height={b.height} style={{ imageRendering: 'pixelated', opacity: two && img === 'both' ? 0.5 : 1 }} onError={onErr} />}
        <g opacity={0.3} aria-hidden="true"><Shapes v={b} f={b.features} /></g>
        {d.changes.map((c, i) => { const col = CH[c.change].color, mark = { g: b, k: c.kind, hi: hi === i };
          return <g key={i} data-change={moved(c) ? 'moved' : c.change} data-hi={hi === i || undefined} opacity={hi >= 0 && hi !== i ? 0.35 : 1}>
            {c.change === 'removed' && <Mark {...mark} x={c.before!} color={col} />}
            {c.change === 'changed' && !moved(c) && <Mark {...mark} hi={false} x={c.before!} color={col} dash />}
            {c.after && <Mark {...mark} x={c.after} color={col} />}
          </g>; })}
      </svg>
      {bad && <div className="fh-row"><p className="fh-msg" role="alert">지도 그림을 불러오지 못했습니다. 네트워크를 확인한 뒤 다시 불러오세요.</p>
        <button type="button" className="btn" onClick={() => { setBad(false); setK(k + 1); }}>다시 불러오기</button></div>}
      <div className="fh-row" aria-label="차이 수">{tally.filter(([, c]) => c).map(([t, c, col]) => <span key={t}><span aria-hidden="true" style={{ color: col }}>■</span> {t} {c}</span>)}</div>
      {d.changes.length ? <ul className="fh-list" aria-label="차이 목록">{d.changes.slice(0, show).map((c, i) => <li key={i} className="fh-row">
          <button type="button" aria-pressed={hi === i} style={{ flex: 1, textAlign: 'left' }} onClick={() => setHi(hi === i ? -1 : i)}>
            <span aria-hidden="true" style={{ color: CH[c.change].color }}>■</span> {says(c)}</button></li>)}</ul>
        : <p className="lv-note">구역·지점·연결점·지우개·벽 선은 바뀐 것이 없습니다.</p>}
      {d.changes.length > show && <button type="button" className="btn" onClick={() => setShow(show + PAGE)}>더 보기 (남은 {d.changes.length - show}개)</button>}
    </>}
    {err && <div className="fh-row"><p className="fh-msg" role="alert">{err}</p><button type="button" className="btn" onClick={() => setN(n + 1)}>다시 시도</button></div>}
    {!d && !err && <p className="lv-note" role="status">두 판을 비교하는 중…</p>}
  </div>;
}

/** 되돌리기 실패 = 무엇이 + 어떻게. 403·503 등은 서버 문구 그대로 */
function backFail(e: ApiFail) {
  if (e.code === 'STALE') return '다른 사람이 먼저 이 층의 지도를 바꿨습니다. 새로 불러온 뒤 다시 되돌리세요.';
  if (e.code === 'ALREADY_APPROVED') return '이 판은 이미 지금 승인 판입니다. 새로 불러와 판 목록을 확인하세요.';
  if (e.code === 'ROLLBACK_NOT_APPROVED') return '승인된 적이 있는 판만 되돌릴 수 있습니다. 새로 불러와 판 목록을 확인하세요.';
  if (e.code === 'INVALID_FEATURES') return /\.pair_floor_id$/.test(String(e.detail?.element ?? '')) ? '이 판에는 지금 없는 층과의 연결점이 있어 되돌릴 수 없습니다. 지금 판을 편집해 필요한 요소를 다시 그리세요.'
    : '이 판의 지도 요소를 지금 그대로 쓸 수 없어 되돌릴 수 없습니다. 지금 판을 편집해 필요한 요소를 다시 그리세요.';
  if (e.status === 404) return '이 판을 찾을 수 없습니다. 지워졌을 수 있어 새로 불러오세요.';
  return e.message;
}
const AGAIN = ['STALE', 'ALREADY_APPROVED', 'ROLLBACK_NOT_APPROVED'];

/** 이 판으로 되돌리기(총괄, U10 확인 = 이유 칸). v = 한때 승인된 옛 판, now = 지금 승인 판.
 *  now 는 칸을 연 때의 승인 판(부른 쪽이 고정) — 답이 끊겨 목록을 다시 받은 뒤 또 눌러도 새 기준으로 한 번 더 복사되지 않고 서버가 STALE 로 막는다.
 *  done = 새 승인 판, reload = 판 목록·나무 다시 받기, close = 닫기 */
export function Rollback({ v, now, cancel, done, reload, close }: { v: MapVersion; now: MapVersion; cancel?: AbortSignal; done: (x: MapVersion) => void; reload: () => void; close: () => void }) {
  const base = now, [reason, setReason] = useState(''), [busy, setBusy] = useState(false), [msg, setMsg] = useState<Msg>(null), [again, setAgain] = useState(false), sending = useRef(false);
  const go = async (e: FormEvent) => {
    e.preventDefault();
    if (sending.current) return;   // 두 번 누름 — 화면이 잠기기 전 두 번째 누름도
    if (!reason.trim()) return setMsg({ text: '되돌리는 이유를 입력하세요.' });
    sending.current = true; setBusy(true); setMsg(null); setAgain(false);
    try {
      done(await api.rollback(v.id, { base_version_id: base.id, reason: reason.trim() }, cancel).then(shape(isVersion)));   // 빈·어긋난 201 = 불확실(status 0)
    } catch (x) {
      const f = x as ApiFail;
      if (f.code === 'CANCELED') return;
      // 요청을 보낸 뒤 답이 끊기면(헤더 전·본문 중·마감·깨진 본문) 되돌려졌을 수도 있다 — 목록을 다시 받아 보여 준다
      if (f.status === 0) { setMsg({ text: '되돌리기 응답을 받지 못했습니다. 되돌려졌을 수 있어 판 목록을 다시 받습니다. 새 승인 판이 보이면 다시 되돌리지 마세요.' }); reload(); return; }
      setMsg({ text: `되돌리지 못했습니다. ${backFail(f)}` }); setAgain(AGAIN.includes(f.code) || f.status === 404);
    } finally { sending.current = false; setBusy(false); }
  };
  return <form className="fh-form" onSubmit={go} noValidate aria-label="이 판으로 되돌리기">
    <b>판 {v.number}의 지도로 되돌리기</b>
    <p className="lv-note">판 {v.number}의 지도 그림과 구역·지점·연결점으로 새 승인 판을 만듭니다. 지금 승인 판(판 {base.number})은 지난 판으로 남고, 다음 실행부터 새 판을 씁니다.</p>
    <label className="fh-field"><span>되돌리는 이유</span><input className="inp" maxLength={2000} value={reason} autoFocus onChange={(e) => busy || setReason(e.target.value)} /></label>
    <div className="fh-row"><button type="submit" className="btn pri" disabled={busy}>되돌리기</button><button type="button" className="btn" disabled={busy} onClick={close}>취소</button>
      {again && <button type="button" className="btn" onClick={() => { close(); reload(); }}>새로 불러오기</button>}</div>
    {busy && <p className="lv-note" role="status">되돌리는 중…</p>}
    <Note m={msg} />
  </form>;
}
