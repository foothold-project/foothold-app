// 기록 탭·서랍 «최근 사건»·알림 종(01 LG-01·02·04·05, 02 F-LG·F-COM-03, 03 UX §5.5, 05 §8 — S2 /events·/notifications).
// 목록·범위·문장은 서버 값 그대로: 화면은 필터를 요청 매개변수로 넘길 뿐 다시 거르거나 문장을 짓지 않는다(운영 관리자 범위도 서버가 정함).
// 이 요청들이 실패·지연돼도 머리줄·STOP·조종 화면은 그대로다 — 오류는 이 칸 안에만 쓴다.
import { useEffect, useRef, useState } from 'react';
import type { Event as Ev, EventList, NotificationList, Notification, NotificationsRead } from '../../../contracts/ts';
import { ApiFail, api } from '../api';
import { myRobots, type Tone } from '../fake';
import { Chip, Line, type Ctx } from '../screens';

/** 분류 7종(02 F-LG-01) — '' = 전체 */
const KINDS: [Ev['category'] | '', string][] = [['', '전체'], ['RUN', '임무'], ['ROUTE', '이탈'], ['LINK', '연결'], ['LEASE', '조종권'], ['APPROVAL', '결재'], ['SAFETY', '안전'], ['ACCOUNT', '계정']];
const KIND_NAME = Object.fromEntries(KINDS) as Record<string, string>;
const TONE: Record<string, Tone> = { INFO: 'ok', WARN: 'warn', ERROR: 'bad' };
/** 현지 날짜·시각 10/20 14:02(브라우저 시간대) */
function when(at: string) {
  const d = new Date(at);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.toTimeString().slice(0, 5)}`;
}
/** 서버 문장 맨 앞 «HH:MM » 시각 접두만 뗀다 — 시각은 at 의 현지 날짜·시각으로 따로 보인다(서버 접두는 시간대·날짜가 화면과 다를 수 있음, 10-20 조정 결정 B).
 *  접두가 없으면 그대로, 나머지 문장은 한 글자도 바꾸지 않는다. CSV 는 서버 문장 그대로 */
export const sentence = (m: string) => m.replace(/^\d\d:\d\d /, '');
const WRAP = { minWidth: 0, overflowWrap: 'anywhere' } as const;
/** 한 줄 = 한 사건: 시각 · 분류(심각도 색) · 서버가 저장한 문장 */
const Row = ({ e }: { e: Ev }) => <li className="fh-row"><span className="mono">{when(e.at)}</span><Chip tone={TONE[e.severity] ?? 'off'} text={KIND_NAME[e.category] ?? '기타'} /><span className="fh-grow" style={WRAP}>{sentence(e.message)}</span></li>;

/** 필터(기간은 날짜 칸 값 yyyy-mm-dd — 그날 0시부터 끝까지, 브라우저 시간대) */
type Filter = { category: string; robot: string; from: string; to: string };
const NONE: Filter = { category: '', robot: '', from: '', to: '' };
function params(f: Filter) {
  const q = new URLSearchParams();
  if (f.category) q.set('category', f.category);
  if (f.robot) q.set('robot_id', f.robot);
  if (f.from) q.set('from', new Date(`${f.from}T00:00:00`).toISOString());
  if (f.to) q.set('to', new Date(`${f.to}T23:59:59.999`).toISOString());
  return q;
}
// 받은 값 모양 검사 — 어긋난 응답이 화면(머리줄·STOP 포함)을 깨뜨리지 않게, 오류 한 줄로만 남긴다
const str = (v: unknown) => typeof v === 'string';
const isEvent = (e: Ev) => !!e && str(e.id) && str(e.at) && str(e.message);
const isEvents = (r: EventList) => !!r && Array.isArray(r.items) && r.items.every(isEvent) && (r.next_cursor === null || str(r.next_cursor));
const isNotes = (x: NotificationList) => !!x && Array.isArray(x.items) && Number.isInteger(x.unread_count)
  && x.items.every((n) => !!n && str(n.id) && str(n.title) && str(n.body) && str(n.link) && str(n.created_at));
const shape = <T,>(ok: (x: T) => boolean) => (x: T) => { if (!ok(x)) throw new ApiFail(0, 'BAD_SHAPE', '받은 기록 형식이 맞지 않습니다. 잠시 뒤 다시 시도하세요.'); return x; };
/** 오류 = 무엇이 + 어떻게(U8). 404 = 범위 밖·없음(담당이 바뀐 로봇 등). 401 은 api 가 로그인 화면으로 보낸다 */
const why = (e: ApiFail) => (e.status === 404 ? `${e.message} 로봇 담당이 바뀌었거나 지워졌을 수 있습니다. 필터를 바꿔 다시 보세요.` : e.message);

/** 서버 목록(최신순) + cursor 로 더 받기. 필터가 바뀌면 처음부터 — 앞 요청의 늦은 답은 버린다 */
function useEvents(f: Filter, cancel: AbortSignal | undefined, limit: number) {
  const [items, setItems] = useState<Ev[]>([]), [next, setNext] = useState<string | null>(null), [busy, setBusy] = useState(true), [err, setErr] = useState<ApiFail | null>(null);
  const seq = useRef(0), key = params(f).toString();
  const load = (cursor?: string) => {
    const n = ++seq.current, q = params(f);
    q.set('limit', String(limit));
    if (cursor) q.set('cursor', cursor);
    setBusy(true); setErr(null);
    if (!cursor) { setItems([]); setNext(null); }   // 다른 필터의 목록을 이 필터 결과처럼 보이지 않게
    api.events(q, cancel).then(shape(isEvents)).then((r) => {
      if (n !== seq.current) return;
      setItems((old) => (cursor ? [...old, ...r.items] : r.items)); setNext(r.next_cursor); setBusy(false);
    }, (e: ApiFail) => { if (n !== seq.current || e.code === 'CANCELED') return; setErr(e); setBusy(false); });   // 더 받기 실패면 받은 목록·cursor 그대로(다시 시도)
  };
  useEffect(() => { load(); }, [key]);
  return { items, next, busy, err, more: () => load(next ?? undefined) };
}

/** 기록 탭(03 §5.5). PC = 분류·로봇·기간 + 내보내기, 폰 = 머리줄에서 고른 로봇의 기록만 */
export function History(c: Ctx) {
  const [f, setF] = useState(NONE), filter = c.phone ? { ...NONE, robot: c.robot.id } : f;
  const ev = useEvents(filter, c.cancel, 50), set = (p: Partial<Filter>) => setF((o) => ({ ...o, ...p }));
  const [out, setOut] = useState<{ text: string; ok?: boolean } | null>(null), [saving, setSaving] = useState(false);
  // 지금 필터 그대로 CSV(F-LG-05). 10,000행 넘으면 서버가 거절(400 EXPORT_LIMIT) — 잘린 파일을 받지 않는다
  const save = () => {
    setSaving(true); setOut(null);
    api.exportEvents(params(f), c.cancel).then((b) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(b); a.download = `기록-${new Date().toLocaleDateString('sv')}.csv`; a.click();   // 현지 날짜 yyyy-mm-dd
      setTimeout(() => URL.revokeObjectURL(a.href), 0);
      setOut({ text: '지금 필터의 기록을 CSV 파일로 내려받았습니다.', ok: true }); setSaving(false);
    }, (e: ApiFail) => {
      if (e.code === 'CANCELED') return;
      setOut({ text: e.code === 'EXPORT_LIMIT' ? '내보낼 기록이 너무 많습니다(10,000개 넘음). 기간을 줄이거나 분류·로봇을 골라 다시 내보내세요.' : `내보내지 못했습니다. ${e.message}` });
      setSaving(false);
    });
  };
  const filtered = !c.phone && params(f).toString() !== '';
  return <section className="lv-card" style={{ flexBasis: '100%' }} aria-label="기록">
    {c.focus && <Focus key={c.focus} id={c.focus} cancel={c.cancel} close={() => c.go('history')} />}
    {!c.phone && <>
      <div className="fh-row" role="group" aria-label="분류">{KINDS.map(([k, name]) => <button key={name} type="button" className="btn" aria-pressed={f.category === k} onClick={() => set({ category: k })}>{name}</button>)}</div>
      <div className="fh-row">
        <label className="fh-row"><span className="lbl">로봇</span><select className="fh-user" value={f.robot} onChange={(e) => set({ robot: e.target.value })}>
          <option value="">전체</option>{myRobots(c.user, c.robots).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
        <label className="fh-row"><span className="lbl">기간</span><input type="date" className="fh-user" aria-label="기간 시작" value={f.from} max={f.to || undefined} onChange={(e) => set({ from: e.target.value })} /></label>
        <span aria-hidden="true">~</span>
        <input type="date" className="fh-user" aria-label="기간 끝" value={f.to} min={f.from || undefined} onChange={(e) => set({ to: e.target.value })} />
        <span className="fh-grow" />
        <button type="button" className="btn" disabled={saving} onClick={save}>{saving ? '내보내는 중…' : '내보내기'}</button>
      </div>
      {out && <p className={`fh-msg${out.ok ? ' ok' : ''}`} role={out.ok ? 'status' : 'alert'}>{out.text}</p>}
    </>}
    <ul className="fh-list" aria-label="사건">{ev.items.map((e) => <Row key={e.id} e={e} />)}</ul>
    {ev.err && <p className="fh-msg" role="alert">기록을 받지 못했습니다. {why(ev.err)}</p>}
    {ev.busy && <p className="lv-note" role="status">기록을 불러오는 중…</p>}
    {!ev.busy && !ev.err && !ev.items.length && <p className="lv-note">{c.phone ? '이 로봇의 기록이 아직 없습니다.' : filtered ? '조건에 맞는 기록이 없습니다.' : '아직 기록이 없습니다.'}</p>}
    {!ev.busy && (ev.next || ev.err) && <div className="fh-row"><button type="button" className="btn" onClick={ev.more}>{ev.err ? '다시 시도' : '더 보기'}</button></div>}
  </section>;
}

/** 알림에서 연 사건 하나(#/history?event_id=…). 범위 밖·없음이면 그렇게 쓴다 */
function Focus({ id, cancel, close }: { id: string; cancel?: AbortSignal; close: () => void }) {
  const [e, setE] = useState<Ev | null>(null), [err, setErr] = useState('');
  useEffect(() => {
    api.event(id, cancel).then(shape(isEvent)).then(setE, (x: ApiFail) => {
      if (x.code !== 'CANCELED') setErr(x.status === 404 ? '이 기록을 볼 수 없습니다. 담당이 바뀌었거나 지워진 로봇의 기록일 수 있습니다.' : `기록을 받지 못했습니다. ${x.message}`);
    });
  }, []);
  return <div className="card" style={{ padding: 10 }} aria-label="알림에서 연 기록">
    <div className="fh-row"><b className="fh-grow">알림에서 연 기록</b><button type="button" className="btn" onClick={close}>닫기</button></div>
    {e && <ul className="fh-list"><Row e={e} /></ul>}
    {err && <p className="fh-msg" role="alert">{err}</p>}
  </div>;
}

/** 서랍 «최근 사건»(03 §5.1) — 그 로봇의 최근 5개. 없거나 범위 밖(404)이면 칸을 숨긴다(U9 — 지어내지 않음) */
export function RecentEvents({ robot, cancel }: { robot: string; cancel?: AbortSignal }) {
  const ev = useEvents({ ...NONE, robot }, cancel, 5);
  if (ev.err && ev.err.status !== 404) return <Line k="최근 사건"><span className="fh-msg" role="alert">최근 사건을 받지 못했습니다. {ev.err.message}</span></Line>;
  if (!ev.items.length) return null;
  return <Line k="최근 사건"><ul className="fh-list" style={{ flex: 1 }} aria-label="최근 사건">{ev.items.map((e) => <Row key={e.id} e={e} />)}</ul></Line>;
}

/** 알림을 다시 받는 간격 — 푸시·실시간 알림 배송은 아직 없다(S2 범위 밖) */
export const BELL_MS = 15_000;
/** 알림 종(F-COM-03, PC 머리줄): 안 읽은 수 배지 + 펼치면 최근 20개. 누르면 읽음 처리하고 그 기록으로 간다.
 *  못 받으면 이전 값 그대로 — 실패 글은 펼친 칸 안에만 */
export function Bell({ cancel }: { cancel?: AbortSignal }) {
  const [list, setList] = useState<NotificationList | null>(null), [err, setErr] = useState('');
  const seq = useRef(0), box = useRef<HTMLDetailsElement>(null);
  const get = () => {
    const n = ++seq.current;
    api.notifications(cancel).then(shape(isNotes)).then((x) => { if (n === seq.current) { setList(x); setErr(''); } },
      (e: ApiFail) => { if (n === seq.current && e.code !== 'CANCELED') setErr(`알림을 받지 못했습니다. ${e.message}`); });
  };
  useEffect(() => { get(); const i = setInterval(get, BELL_MS); return () => clearInterval(i); }, []);
  const read = (p: NotificationsRead) => api.readNotifications(p, cancel).then(get, (e: ApiFail) => { if (e.code !== 'CANCELED') setErr(`읽음으로 바꾸지 못했습니다. ${e.message}`); });
  const open = (x: Notification) => {
    if (!x.read_at) read({ ids: [x.id] });
    if (box.current) box.current.open = false;
    if (x.link.startsWith('#/')) location.hash = x.link;
  };
  const unread = list?.unread_count ?? 0;
  return <details ref={box} className="fh-more" data-bell>
    <summary aria-label={list ? `알림 안 읽음 ${unread}건` : '알림'}><span aria-hidden="true">🔔</span>{unread > 0 && <span className="fh-badge" aria-hidden="true">{unread > 99 ? '99+' : unread}</span>}</summary>
    <div className="card" style={{ whiteSpace: 'normal', width: 'min(360px, 80vw)', maxHeight: '60vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }} aria-label="알림 목록">
      <div className="fh-row"><b className="fh-grow">알림</b><button type="button" className="btn" disabled={!unread} onClick={() => read({ all: true })}>모두 읽음</button></div>
      {err && <p className="fh-msg" role="alert">{err}</p>}
      {list && !list.items.length && <p className="lv-note">알림이 없습니다.</p>}
      {!list && !err && <p className="lv-note" role="status">알림을 불러오는 중…</p>}
      {!!list?.items.length && <ul className="fh-list">{list.items.map((x) => <li key={x.id}><button type="button" onClick={() => open(x)} data-unread={!x.read_at || undefined}>
        {!x.read_at && <Chip tone="ok" text="새 알림" />}<span className="fh-grow" style={WRAP}><b>{x.title}</b> {sentence(x.body)}</span><span className="lbl">{when(x.created_at)}</span></button></li>)}</ul>}
    </div>
  </details>;
}
