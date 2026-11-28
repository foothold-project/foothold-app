/** 폰 기록 탭 = 시안 u3_3 알림 목록 (proto/screens/u3_3_list.html). 마크업은 시안 body 를 옮긴 것(태그 · class · 순서 · 인라인 style 그대로), 단추 div · span 은 button.
 *  자료는 PC 기록 탭과 같은 서버 /events(머리줄에서 고른 로봇 · 담당 로봇 0대면 서버가 주는 내 기록). 등급 칸(전체 · 위험 · 주의 · 정보)은 서버 severity 매개변수로 거른다.
 *  칸의 수는 받은 첫 쪽(최대 50건)의 서버 등급 수, 더 있으면 «+». 타일 색은 기록 표의 등급 알약과 같은 기준(sevOf: 정보로 저장된 실패 코드는 주의).
 *  오른쪽 칸(고른 알림)은 서버에 있는 값만: 등급 · 문장 · 로봇 · 시각 · 분류 · 사람, 클립(records.clips) · 사진. 시안의 자리 · 받은 사람 줄은 서버에 값이 없어 뺐다.
 *  시안 「지도에서 보기」는 폰에 지도 탭이 없어 뺐고, 그 자리에 run_id 가 있으면 «실행 기록 보기»(기록 표와 같은 RunReport).
 *  시안 밖(같은 결로 새로 그림): 불러오는 중 · 오류 · 빈 목록 한 줄, 기록 0 건 칸, «더 보기» · «다시 시도»(시안 .sbtn), 클립 없는 상태 글 */
import { useEffect, useRef, useState } from 'react';
import type { Event as Ev, EventClip } from '../../../contracts/ts';
import '../proto/ui.pv.css';
import '../proto/light.pv.css';
import './u33.css';
import './u33.app.css';
import { api, records, type ApiFail } from '../api';
import { useTheme } from '../theme';
import { KIND_NAME, NONE, isEvent, namesOf, sentence, sevOf, shape, stamp, told, useEvents, why, type HistoryCtx } from './history';
import { fail, reason } from './records';
import { RunReport } from './runreport';

type Grade = '' | 'ERROR' | 'WARN' | 'INFO';
/** 시안 seg 칸: 이름 · 점 색 (전체는 점 없음) */
const SEG: [Grade, string, string?][] = [['', '전체'], ['ERROR', '위험', '#e04a2f'], ['WARN', '주의', '#d9a21f'], ['INFO', '정보', '#5e6662']];
/** 시안 타일 · 아이콘 칸 · 오른쪽 칸 표지 색(위험 = r-fall · r-temp, 주의 = r-route · r-bat, 정보 = r-mode) */
const TONE = {
  bad: { tile: { background: 'rgba(224,74,47,.07)', borderColor: 'rgba(224,74,47,.38)' }, ico: { background: 'rgba(224,74,47,.12)', color: '#b8361f' }, tag: '#e04a2f' },
  warn: { tile: { background: 'rgba(217,162,31,.09)', borderColor: 'rgba(217,162,31,.50)' }, ico: { background: 'rgba(217,162,31,.16)', color: '#d9a21f' }, tag: '#d9a21f' },
  info: { tile: { background: 'rgba(93,101,115,.05)', borderColor: 'rgba(93,101,115,.22)' }, ico: { background: 'rgba(93,101,115,.12)', color: '#5e6662' }, tag: '#5e6662' },
};
const toneOf = (e: Ev) => { const t = sevOf(e)[0]; return t === 'bad' || t === 'warn' ? t : 'info'; };
/** 고른 타일 테(시안 첫 타일) */
const PICKED = '0 0 0 2px rgba(22,25,31,.75),0 6px 16px rgba(20,30,50,.12)';
/** 분류 아이콘(lucide ISC 선, 시안 .ic 17 px 꼴): 임무 = 시안 r-route 의 route · 이탈 triangle-alert · 연결 wifi · 조종권 key-round · 결재 file-check · 안전 shield · 계정 user · 기타 info */
const PATH: Record<string, JSX.Element> = {
  RUN: <><circle cx="6" cy="19" r="3" /><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15" /><circle cx="18" cy="5" r="3" /></>,
  ROUTE: <><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" /><path d="M12 9v4M12 17h.01" /></>,
  LINK: <path d="M12 20h.01M2 8.82a15 15 0 0 1 20 0M5 12.859a10 10 0 0 1 14 0M8.5 16.429a5 5 0 0 1 7 0" />,
  LEASE: <><path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z" /><circle cx="16.5" cy="7.5" r=".5" fill="currentColor" /></>,
  APPROVAL: <><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4M9 15l2 2 4-4" /></>,
  SAFETY: <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />,
  ACCOUNT: <><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></>,
};
const OTHER = <><circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" /></>;
const Ic = ({ s, children }: { s: number; children: JSX.Element }) => <svg className="ic" viewBox="0 0 24 24" style={{ width: `${s}px`, height: `${s}px` }} aria-hidden="true">{children}</svg>;

/** 서버 문장(시각 접두 뗌 · 모르는 로봇 사건 코드는 한국어) */
const said = (e: Ev) => told(e.message)?.text ?? sentence(e.message);
/** 타일 오른쪽 시각: 오늘이면 시안처럼 HH:MM, 아니면 M/D */
function clock(e: Ev) {
  const d = new Date(stamp(e)), now = new Date();
  return d.toDateString() === now.toDateString() ? d.toTimeString().slice(0, 5) : `${d.getMonth() + 1}/${d.getDate()}`;
}
const full = (e: Ev) => { const d = new Date(stamp(e)); return `${d.getMonth() + 1}/${d.getDate()} ${d.toTimeString().slice(0, 5)}`; };

export function PhoneHistory(c: HistoryCtx) {
  const light = useTheme()[1], robot = c.robot?.id ?? '', n = namesOf(c);
  const [g, setG] = useState<Grade>('');
  const all = useEvents({ ...NONE, robot }, c.cancel, 50), one = useEvents({ ...NONE, robot, severity: g }, c.cancel, 50, !g), ev = g ? one : all;
  // 알림에서 연 사건(#/history?event_id=…): 목록에 없어도 오른쪽 칸에. 범위 밖 · 없음이면 그렇게 쓴다
  const [focused, setFocused] = useState<Ev | null>(null), [focusErr, setFocusErr] = useState('');
  useEffect(() => {
    if (!c.focus) return;
    api.event(c.focus, c.cancel).then(shape(isEvent)).then(setFocused, (x: ApiFail) => {
      if (x.code !== 'CANCELED') setFocusErr(x.status === 404 ? '이 기록을 볼 수 없습니다. 담당이 바뀌었거나 지워진 로봇의 기록일 수 있습니다.' : `기록을 받지 못했습니다. ${x.message}`);
    });
  }, [c.focus]);   // eslint-disable-line react-hooks/exhaustive-deps
  const [pick, setPick] = useState<string | null>(c.focus ?? null);
  const shown = ev.items.find((e) => e.id === pick) ?? (focused && focused.id === pick ? focused : undefined) ?? ev.items[0];
  const [runOf, setRunOf] = useState<{ id: string; from: HTMLElement } | null>(null);
  const count = (k: Grade) => `${k ? all.items.filter((e) => e.severity === k).length : all.items.length}${all.next ? '+' : ''}`;
  return <div className={`proto pv u33${light ? ' light' : ''}`} aria-label="기록" data-u33>
    <div className="bg" />
    <div className="g top"><button type="button" className="bk" aria-label="조종 화면으로" onClick={() => c.go('drive')}><Ic s={18}><path d="M15 6l-6 6 6 6" /></Ic></button><b style={{ fontSize: '15px', fontWeight: 800 }}>알림</b></div>
    <div className="g seg" role="group" aria-label="등급">{SEG.map(([k, name, dot]) =>
      <button key={name} type="button" className={g === k ? 'on' : undefined} aria-pressed={g === k} onClick={() => setG(k)}>{dot && <i style={{ background: dot }} />}{name}<small>{all.busy ? '' : count(k)}</small></button>)}</div>
    <div className="g list" aria-label="사건">
      {ev.items.map((e) => { const t = toneOf(e), on = e.id === shown?.id, sub = [n.who(e), KIND_NAME[e.category] ?? '기타'].filter(Boolean).join(' · ');
        return <button key={e.id} type="button" className="tile" aria-pressed={on} data-tile data-tone={t} onClick={() => setPick(e.id)} style={{ ...TONE[t].tile, ...(on ? { boxShadow: PICKED } : {}) }}>
          <span className="ico" style={TONE[t].ico} data-tile-icon={e.category}><Ic s={17}>{PATH[e.category] ?? OTHER}</Ic></span>
          <div style={{ flex: 1, minWidth: 0 }}><b data-tile-title>{said(e)}</b><p data-tile-sub>{sub}</p></div><span className="t" data-tile-time>{clock(e)}</span></button>; })}
      {ev.busy && <p className="u33-say" role="status">기록을 불러오는 중…</p>}
      {ev.err && <p className="u33-say" role="alert">기록을 받지 못했습니다. {why(ev.err)}</p>}
      {!ev.busy && !ev.err && !ev.items.length && (robot || g ? <p className="u33-say">{g ? '이 등급의 기록이 없습니다.' : '이 로봇의 기록이 아직 없습니다.'}</p>
        : <div className="u33-empty" data-empty="records">
          <svg className="ic" viewBox="0 0 24 24" style={{ width: '22px', height: '22px' }} aria-hidden="true" data-empty-icon><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5M12 7v5l4 2" /></svg>
          <h2>아직 기록이 없습니다</h2><p>임무를 실행하거나 알림이 생기면 여기에 시간 순서로 남습니다.</p>
          <a className="pbtn" href="#/drive">조종 화면으로</a></div>)}
      {!ev.busy && (ev.next || ev.err) && <button type="button" className="sbtn u33-more" onClick={ev.more}>{ev.err ? '다시 시도' : '더 보기'}</button>}
    </div>
    {(shown || focusErr) && <div className="g det" aria-label={shown && shown.id === focused?.id ? '알림에서 연 기록' : '고른 알림'}>
      {shown ? <Picked key={shown.id} e={shown} who={n.robot(shown)} by={n.user(shown)} cancel={c.cancel} run={(id, from) => setRunOf({ id, from })} />
        : <div className="ln" role="alert">{focusErr}</div>}
    </div>}
    {runOf && <RunReport key={runOf.id} id={runOf.id} cancel={c.cancel} close={() => { runOf.from.focus(); setRunOf(null); }} />}
  </div>;
}

type Got = { ok?: EventClip } | { why: string } | null;
/** 오른쪽 칸 = 시안 .det. 클립은 사건이 클립을 원했고(data.clip) 로봇이 있을 때만, 누르면 서버 클립을 받아 그 칸에서 튼다 */
function Picked({ e, who, by, cancel, run }: { e: Ev; who: string; by: string; cancel?: AbortSignal; run: (id: string, from: HTMLElement) => void }) {
  const t = toneOf(e), [clip, setClip] = useState<Got>(null), [asked, setAsked] = useState(false), live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);
  const load = () => {
    if (!e.robot_id) return;
    setAsked(true); setClip(null);
    records.clips(e.robot_id, cancel).then((r) => live.current && setClip({ ok: r.items.find((x) => x.event_id === e.id) }), (x) => live.current && setClip({ why: fail(x) }));
  };
  const got = clip && 'ok' in clip ? clip.ok : undefined, ready = got?.status === 'READY' && got.url;
  const secs = got?.end_at ? Math.round((Date.parse(got.end_at) - Date.parse(got.start_at)) / 1000) : null;
  const note = !asked ? '클립 · 눌러서 보기' : !clip ? '클립을 확인하는 중…' : 'why' in clip ? `영상을 볼 수 없습니다. ${clip.why}` : ready ? `클립${secs !== null ? ` · ${secs} 초` : ''}` : got ? reason(got) : '이 사건의 클립이 아직 없습니다.';
  const photo = e.code === 'PHOTO_STORED' && typeof e.data?.photo_id === 'string' && e.data.photo_id ? e.data.photo_id : '', [bad, setBad] = useState(false);
  return <>
    <div className="row" style={{ gap: '7px' }}><span style={{ fontSize: '9.5px', fontWeight: 800, padding: '2px 6px', borderRadius: '5px', background: TONE[t].tag, color: '#fff' }}>{sevOf(e)[2]}</span><b style={{ fontSize: '14px', fontWeight: 800 }}>{said(e)}</b></div>
    <div className="ln" style={{ marginTop: '5px' }}>{[who, full(e), KIND_NAME[e.category] ?? '기타'].filter(Boolean).join(' · ')}</div>
    {e.data?.clip === true && e.robot_id && <div className="clip" style={{ marginTop: '10px' }} data-clip-box>
      {ready ? <video src={got!.url!} controls autoPlay playsInline preload="metadata" />
        : <button type="button" className="pl" aria-label="클립 보기" data-clip onClick={load}><Ic s={16}><path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z" /></Ic></button>}
      <small data-clip-note>{note}</small></div>}
    {photo && !bad ? <div className="clip u33-photo" style={{ marginTop: '10px' }} data-photo="thumb">
      <img src={api.photoUrl(photo, true)} alt="찍은 사진" loading="lazy" decoding="async" onError={() => setBad(true)} /><small>찍은 사진</small></div>
      : e.code === 'PHOTO_STORED' && <div className="ln" data-photo="bad">사진을 불러오지 못함</div>}
    {e.code === 'PHOTO_STORE_FAILED' && <div className="ln" data-photo="failed">사진 저장 실패 · 사진 없음</div>}
    {by && <div className="ln"><Ic s={14}><><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></></Ic><b>{by}</b>· 이 기록의 사람</div>}
    {e.run_id && <button type="button" className="act2" onClick={(x) => run(e.run_id!, x.currentTarget)}><Ic s={15}>{PATH.RUN}</Ic>실행 기록 보기</button>}
  </>;
}
