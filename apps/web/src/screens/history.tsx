// 기록 탭·서랍 «최근 사건»·알림 종(01 LG-01·02·04·05, 02 F-LG·F-COM-03, 03 UX §5.5, 05 §8 — S2 /events·/notifications).
// 목록·범위·문장은 서버 값 그대로: 화면은 필터를 요청 매개변수로 넘길 뿐 다시 거르거나 문장을 짓지 않는다(운영 관리자 범위도 서버가 정함).
// 이 요청들이 실패·지연돼도 머리줄·STOP·조종 화면은 그대로다 — 오류는 이 칸 안에만 쓴다.
import { useEffect, useRef, useState } from 'react';
import type { Event as Ev, EventList, NotificationList, Notification, NotificationsRead } from '../../../contracts/ts';
import { ApiFail, api } from '../api';
import { idleSim, myRobots, simName, type Robot, type Tone } from '../fake';
import { Chip, Line, inApp, type Ctx } from '../screens';
import './history.css';

/** 분류 7종(02 F-LG-01) — '' = 전체 */
const KINDS: [Ev['category'] | '', string][] = [['', '전체'], ['RUN', '임무'], ['ROUTE', '이탈'], ['LINK', '연결'], ['LEASE', '조종권'], ['APPROVAL', '결재'], ['SAFETY', '안전'], ['ACCOUNT', '계정']];
const KIND_NAME = Object.fromEntries(KINDS) as Record<string, string>;
const TONE: Record<string, Tone> = { INFO: 'ok', WARN: 'warn', ERROR: 'bad' };
/** 현지 날짜·시각 10/20 14:02(브라우저 시간대) */
export function when(at: string) {
  const d = new Date(at);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.toTimeString().slice(0, 5)}`;
}
/** ISO 시각 → 마이크로초(서버는 µs 까지 보냄 — 24시간 경계를 서버와 같은 정밀도로 비교) */
const micros = (iso: string) => Date.parse(iso) * 1000 + Number((/\.(\d+)/.exec(iso)?.[1] ?? '').padEnd(6, '0').slice(3, 6));
/** 표시 시각 = 서버 문장 접두와 같은 규칙(event_messages.py): robot_at 이 있고 0 ≤ at − robot_at ≤ 24시간(양 끝 포함)이면 로봇 발생 시각, 아니면 서버가 받은 at.
 *  끊긴 동안 쌓였다가 늦게 온 사건도 CSV 문장과 같은 시각으로 보인다(10-20 조정 결정 A) */
export function stamp(e: Pick<Ev, 'at' | 'robot_at'>) {
  if (!e.robot_at) return e.at;
  const d = micros(e.at) - micros(e.robot_at);
  return d >= 0 && d <= 86_400_000_000 ? e.robot_at : e.at;
}
/** 서버 문장 맨 앞 «HH:MM » 시각 접두를 뗀다 — 시각은 stamp 의 현지 날짜·시각으로 따로 보인다(서버 접두는 시간대·날짜가 화면과 다를 수 있음, 10-20 조정 결정 B).
 *  그 밖에는 화면 말만 바꾼다(U5·U9): 시뮬 로봇 기본 이름의 16진 id → «시뮬 로봇 N», 빈 이유(서버 «확인되지 않음») → «이유 없음». CSV 는 서버 문장 그대로 */
export const sentence = (m: string) => m.replace(/^\d\d:\d\d /, '').replace(/시뮬 ([0-9a-f]{8})(?![0-9a-f])/g, (_, h: string) => simName(h)).replace(/이유: 확인되지 않음/g, '이유 없음');
/** 서버가 문장을 모르는 로봇 사건 코드(event_messages.py AGENT_EVENT «{robot}에서 사건 {code}이(가) 기록되었습니다.») → 한국어. 표에 없으면 «기타 사건» */
const AGENT_EVENT: Record<string, string> = {
  PHONE_LEASE_TAKEN: '폰에서 조종권을 받았습니다.', PHONE_LEASE_RELEASED: '폰 조종권을 반납했습니다.', PHONE_LEASE_REQUESTED: '폰에서 조종권을 요청했습니다.',
  PHONE_LEASE_ACCEPTED: '폰 조종권 요청이 받아들여졌습니다.', PHONE_LEASE_DECLINED: '폰 조종권 요청이 거절되었습니다.', PHONE_LEASE_TIMEOUT: '폰 조종권 요청 시간이 지났습니다.',
  PHONE_LEASE_CANCELED: '폰 조종권 요청이 취소되었습니다.', PHONE_LEASE_ACQUIRE_LIMIT: '폰 조종권 요청이 너무 잦아 거절했습니다.',
};
/** 그 문장이면 바꾼 글과 코드, 아니면 null */
export function told(m: string) {
  const x = /^(.*)에서 사건 (\S+)이\(가\) 기록되었습니다\.$/.exec(sentence(m));
  return x ? { text: `${x[1]}: ${AGENT_EVENT[x[2]] ?? '기타 사건'}`, code: x[2] } : null;
}
const WRAP = { minWidth: 0, overflowWrap: 'anywhere' } as const;
/** 심각도 = 모양 + 글(색만으로 구분 0) — 분류 배지와 따로 보인다 */
const SEV: Record<string, [Tone, string]> = { INFO: ['ok', '정상'], WARN: ['warn', '주의'], ERROR: ['bad', '오류'] };
const Sev = ({ e }: { e: Ev }) => { const [tone, text] = SEV[e.severity] ?? ['off', '알 수 없음']; return <Chip tone={tone} text={text} />; };
/** 분류 배지: 분류마다 다른 토큰 색(history.css)·글자 같이 */
const Kind = ({ e }: { e: Ev }) => <span className="hs-kind" data-kind={e.category}>{KIND_NAME[e.category] ?? '기타'}</span>;
/** 서버가 저장한 문장. 서버가 모르는 로봇 사건이면 코드 원문은 접힌 상세에만 */
const Said = ({ e }: { e: Ev }) => { const t = told(e.message);
  return <><span className="fh-wide">{t ? t.text : sentence(e.message)}</span>{t && <details className="lbl"><summary>상세</summary><span className="mono">{e.code || t.code}</span></details>}</>; };
/** 한 줄 = 한 사건(서랍 «최근 사건»): 시각 · 분류 · 심각도 · 문장 */
const Row = ({ e }: { e: Ev }) => <li className="fh-row"><span className="mono">{when(stamp(e))}</span><Kind e={e} /><Sev e={e} /><Said e={e} /></li>;
/** 기록 표: 시각 · 종류 · 상태 · 내용 · 로봇·사람. 좁으면(history.css 컨테이너 질의) 줄마다 카드로 — 가로로 넘치지 않게 */
const Table = ({ items, who, label }: { items: Ev[]; who: (e: Ev) => string; label?: string }) => <div className="hs-wrap">
  <table className="hs-table" aria-label={label} hidden={!items.length}>
    <thead><tr><th scope="col">시각</th><th scope="col">종류</th><th scope="col">상태</th><th scope="col">내용</th><th scope="col">로봇·사람</th></tr></thead>
    <tbody>{items.map((e) => { const w = who(e);
      return <tr key={e.id}><td className="mono">{when(stamp(e))}</td><td><Kind e={e} /></td><td><Sev e={e} /></td><td><Said e={e} /></td><td className="lbl" data-none={!w || undefined}>{w || '—'}</td></tr>; })}</tbody>
  </table></div>;
/** 사건의 로봇·사람 이름 — 화면이 아는 것만(로봇 목록·나·담당자). 모르면 빈 글 */
const whoOf = (c: Pick<Ctx, 'user' | 'robots'>) => (e: Ev) => {
  const r = c.robots.find((x) => x.id === e.robot_id)?.name;
  const u = !e.user_id ? '' : e.user_id === c.user.id ? c.user.name : c.robots.find((x) => x.owner === e.user_id)?.ownerName;
  return [r, u].filter(Boolean).join(' · ');
};

/** 필터(기간은 날짜 칸 값 yyyy-mm-dd — 그날 0시부터 끝까지, 브라우저 시간대) */
type Filter = { category: string; robot: string; from: string; to: string };
const NONE: Filter = { category: '', robot: '', from: '', to: '' };
/** 날짜 칸 값 + 시각 → ISO. 서버가 못 읽는 날짜(날짜 칸이 받는 다섯 자리 연도 등)는 null — toISOString 의 RangeError 를 렌더까지 올리지 않는다 */
function iso(day: string, time: string) {
  const d = /^\d{4}-\d\d-\d\d$/.test(day) ? new Date(`${day}T${time}`) : null;
  const s = d && !isNaN(d.getTime()) ? d.toISOString() : '';
  return /^\d{4}-/.test(s) ? s : null;   // UTC 로 옮기며 연도가 네 자리를 벗어나는 경계(0000·9999년 끝)도 거른다
}
/** 필터 → 요청 매개변수. 기간 날짜를 읽을 수 없으면 null(요청하지 않고 칸 안에 안내) */
function params(f: Filter) {
  const q = new URLSearchParams(), from = f.from && iso(f.from, '00:00:00'), to = f.to && iso(f.to, '23:59:59.999');
  if (from === null || to === null) return null;
  if (f.category) q.set('category', f.category);
  if (f.robot) q.set('robot_id', f.robot);
  if (from) q.set('from', from);
  if (to) q.set('to', to);
  return q;
}
const BAD_DAY = new ApiFail(0, 'BAD_DATE', '기간 날짜를 읽을 수 없습니다. 연도 네 자리 날짜(예: 2026-10-20)로 다시 고르세요.');
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
  const seq = useRef(0), key = params(f)?.toString() ?? 'bad';
  const load = (cursor?: string) => {
    const n = ++seq.current, q = params(f);
    if (!cursor) { setItems([]); setNext(null); }   // 다른 필터의 목록을 이 필터 결과처럼 보이지 않게
    if (!q) { setErr(BAD_DAY); setBusy(false); return; }
    q.set('limit', String(limit));
    if (cursor) q.set('cursor', cursor);
    setBusy(true); setErr(null);
    api.events(q, cancel).then(shape(isEvents)).then((r) => {
      if (n !== seq.current) return;
      setItems((old) => (cursor ? [...old, ...r.items] : r.items)); setNext(r.next_cursor); setBusy(false);
    }, (e: ApiFail) => { if (n !== seq.current || e.code === 'CANCELED') return; setErr(e); setBusy(false); });   // 더 받기 실패면 받은 목록·cursor 그대로(다시 시도)
  };
  useEffect(() => { load(); }, [key]);
  return { items, next, busy, err, more: () => load(next ?? undefined) };
}

/** 기록 탭에 필요한 것만 — 로봇이 0대여도 계정·내 행동 기록과 알림 링크는 연다(LG-01·05) */
type HistoryCtx = Pick<Ctx, 'user' | 'robots' | 'go' | 'phone' | 'cancel' | 'focus'> & { robot?: Robot };
/** 기록 탭(03 §5.5). PC = 분류·로봇·기간 + 내보내기, 폰 = 머리줄에서 고른 로봇의 기록만(담당 로봇 0대면 서버가 주는 내 기록) */
export function History(c: HistoryCtx) {
  const [f, setF] = useState(NONE), filter = c.phone ? { ...NONE, robot: c.robot?.id ?? '' } : f;
  const ev = useEvents(filter, c.cancel, 50), set = (p: Partial<Filter>) => { setF((o) => ({ ...o, ...p })); setOut(null); };   // 내보내기 안내는 그때 필터의 것
  const [out, setOut] = useState<{ text: string; ok?: boolean } | null>(null), [saving, setSaving] = useState(false);
  // 지금 필터 그대로 CSV(F-LG-05). 10,000행 넘으면 서버가 거절(400 EXPORT_LIMIT) — 잘린 파일을 받지 않는다. 동시 내보내기는 429 RATE_LIMITED.
  // 받기·파일 만들기 어디서 실패해도 안내를 쓰고 단추를 되살리며 만든 URL 은 정리한다
  const save = async () => {
    const q = params(f);
    if (!q) { setOut({ text: `내보내지 못했습니다. ${BAD_DAY.message}` }); return; }
    if (inApp()) { setOut({ text: '앱에서는 파일을 내려받을 수 없습니다. PC 브라우저에서 내보내세요.' }); return; }   // WebView 는 blob <a download> 를 받지 않는다
    setSaving(true); setOut(null);
    let url = '';
    try {
      const b = await api.exportEvents(q, c.cancel), a = document.createElement('a');
      url = URL.createObjectURL(b);
      a.href = url; a.download = `기록-${new Date().toLocaleDateString('sv')}.csv`; a.click();   // 현지 날짜 yyyy-mm-dd
      setOut({ text: '지금 필터의 기록을 CSV 파일로 내려받았습니다.', ok: true });
    } catch (e) {
      const x = e instanceof ApiFail ? e : null;
      if (x?.code !== 'CANCELED') setOut({ text: x?.code === 'EXPORT_LIMIT' ? '내보낼 기록이 너무 많습니다(10,000개 넘음). 기간을 줄이거나 분류·로봇을 골라 다시 내보내세요.'
        : x?.code === 'RATE_LIMITED' ? '다른 기록 내보내기가 아직 끝나지 않았습니다. 잠시 뒤 다시 내보내세요.'
        : `내보내지 못했습니다. ${x?.message ?? '파일을 만들지 못했습니다. 다시 시도하세요.'}` });
    } finally {
      setSaving(false);
      if (url) setTimeout(() => URL.revokeObjectURL(url), 0);   // 내려받기가 시작된 뒤 정리
    }
  };
  const filtered = !c.phone && params(f)?.toString() !== '', who = whoOf(c);
  return <section className="lv-card" style={{ flexBasis: '100%' }} aria-label="기록">
    {c.focus && <Focus key={c.focus} id={c.focus} cancel={c.cancel} who={who} close={() => c.go('history')} />}
    {!c.phone && <>
      <div className="fh-row" role="group" aria-label="분류">{KINDS.map(([k, name]) => <button key={name} type="button" className="btn" aria-pressed={f.category === k} onClick={() => set({ category: k })}>{name}</button>)}</div>
      <div className="fh-row">
        {/* 로봇 거르기: 내 로봇 + 끝낸 시뮬 슬롯(지난 시뮬 기록 — 운영 관리자는 그 슬롯에서 한 내 행동만 서버가 보여 줌) */}
        <label className="fh-row"><span className="lbl">로봇</span><select className="fh-user" value={f.robot} onChange={(e) => set({ robot: e.target.value })}>
          <option value="">전체</option>{[...myRobots(c.user, c.robots), ...(c.user.role === 'ORG_ADMIN' ? [] : c.robots.filter(idleSim))].map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
        <label className="fh-row"><span className="lbl">기간</span><input type="date" className="fh-user" aria-label="기간 시작" value={f.from} max={f.to || undefined} onChange={(e) => set({ from: e.target.value })} /></label>
        <span aria-hidden="true">~</span>
        <input type="date" className="fh-user" aria-label="기간 끝" value={f.to} min={f.from || undefined} onChange={(e) => set({ to: e.target.value })} />
        <span className="fh-grow" />
        <button type="button" className="btn" disabled={saving} onClick={save}>{saving ? '내보내는 중…' : '내보내기'}</button>
      </div>
      {out && <p className={`fh-msg${out.ok ? ' ok' : ''}`} role={out.ok ? 'status' : 'alert'}>{out.text}</p>}
    </>}
    <Table items={ev.items} who={who} label="사건" />
    {ev.err && <p className="fh-msg" role="alert">기록을 받지 못했습니다. {why(ev.err)}</p>}
    {ev.busy && <p className="lv-note" role="status">기록을 불러오는 중…</p>}
    {!ev.busy && !ev.err && !ev.items.length && <p className="lv-note">{c.phone && c.robot ? '이 로봇의 기록이 아직 없습니다.' : filtered ? '조건에 맞는 기록이 없습니다.' : '아직 기록이 없습니다.'}</p>}
    {!ev.busy && (ev.next || (ev.err && ev.err !== BAD_DAY)) && <div className="fh-row"><button type="button" className="btn" onClick={ev.more}>{ev.err ? '다시 시도' : '더 보기'}</button></div>}
  </section>;
}

/** 알림에서 연 사건 하나(#/history?event_id=…). 범위 밖·없음이면 그렇게 쓴다 */
function Focus({ id, cancel, who, close }: { id: string; cancel?: AbortSignal; who: (e: Ev) => string; close: () => void }) {
  const [e, setE] = useState<Ev | null>(null), [err, setErr] = useState('');
  useEffect(() => {
    api.event(id, cancel).then(shape(isEvent)).then(setE, (x: ApiFail) => {
      if (x.code !== 'CANCELED') setErr(x.status === 404 ? '이 기록을 볼 수 없습니다. 담당이 바뀌었거나 지워진 로봇의 기록일 수 있습니다.' : `기록을 받지 못했습니다. ${x.message}`);
    });
  }, []);
  return <div className="card" style={{ padding: 10 }} aria-label="알림에서 연 기록">
    <div className="fh-row"><b className="fh-grow">알림에서 연 기록</b><button type="button" className="btn" onClick={close}>닫기</button></div>
    {e && <Table items={[e]} who={who} />}
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
  const box = useRef<HTMLDetailsElement>(null), get = useRef(() => {});
  // 한 번에 한 요청: 앞 요청이 끝나야(제한시간은 api) 다음을 BELL_MS 뒤에 예약 — 느린 정상 답도 버리지 않고, 요청이 쌓여 STOP 과 연결을 다투지 않게.
  // 진행 중에 읽음이 끝나면 그 요청 뒤 한 번 더 받는다. 화면을 떠나거나 로그인 세션이 끝나면 진행 중 요청을 거둔다
  useEffect(() => {
    const stop = new AbortController(), off = () => stop.abort();
    let timer: ReturnType<typeof setTimeout> | undefined, busy = false, again = false;
    get.current = () => {
      clearTimeout(timer);
      if (busy) { again = true; return; }
      busy = true;
      api.notifications(stop.signal).then(shape(isNotes)).then((x) => { setList(x); setErr(''); },
        (e: ApiFail) => { if (e.code !== 'CANCELED') setErr(`알림을 받지 못했습니다. ${e.message}`); })
        .finally(() => {
          busy = false;
          if (stop.signal.aborted) return;
          if (again) { again = false; get.current(); } else timer = setTimeout(get.current, BELL_MS);
        });
    };
    cancel?.addEventListener('abort', off);
    if (cancel?.aborted) stop.abort();
    get.current();
    return () => { stop.abort(); clearTimeout(timer); cancel?.removeEventListener('abort', off); };
  }, []);
  const read = (p: NotificationsRead) => api.readNotifications(p, cancel).then(() => get.current(), (e: ApiFail) => { if (e.code !== 'CANCELED') setErr(`읽음으로 바꾸지 못했습니다. ${e.message}`); });
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
