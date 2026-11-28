/** 기록 탭 PC = 시안 u8 (proto/screens/u8_1 ~ u8_8 · u11_8). 화면 마크업은 시안 body 를 기계적으로 옮긴 것(태그 · class · 순서 · 글 그대로),
 *  시안 머리줄(.bar)은 앱 머리줄 몫이라 뺐다. 고정 글 자리만 서버 값(GET /events · export.csv · records 클립 · 관절 기록 · mark-now)으로 바꾸고,
 *  서버에 값이 없는 자리는 비우거나 잠그고 까닭 한 줄(시안 결 · historyu8.app.css 의 .u8-why).
 *  화면: 목록 u8_1 · 거르기 칩 u8_3 · 사건 자세히 u8_2(클립) · u8_5(모의 실행 클립) · u8_4(기록만) · 내보내기 창 u8_6 → 내려받은 줄 u8_7 · 지금 장면 저장 창 u8_8 · 빈 기록 u11_8 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import '../proto/ui.pv.css';
import '../proto/pc.pv.css';
import '../proto/dark.pv.css';
import '../proto/light.pv.css';
import './historyu8.css';
import './historyu8.app.css';
import type { Event as Ev, EventClip, JointLogReplay } from '../../../contracts/ts';
import { ApiFail, api, records } from '../api';
import { idleSim, myRobots, robotStatus } from '../fake';
import { inApp } from '../screens';
import { useTheme } from '../theme';
import { RunReportU15 } from './runreport';
import { fail, reason } from './records';
import { BAD_DAY, NONE, QUICK, back, full, isEvent, namesOf, params, sentence, sevOf, shape, stamp, told, useEvents, why, type Filter, type HistoryCtx, type Names } from './history';

/** 시안 아이콘(lucide 그대로 · 시안 html 에서 뽑음). key · fileCheck 는 시안에 없는 묶음(조종권 · 결재)이라 앱 기록 타일 아이콘(lucide key-round · file-check) */
const IC = {
  bell: <><path d="M10.268 21a2 2 0 0 0 3.464 0" /><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326" /></>,
  grid: <><rect width="7" height="7" x="3" y="3" rx="1" /><rect width="7" height="7" x="14" y="3" rx="1" /><rect width="7" height="7" x="14" y="14" rx="1" /><rect width="7" height="7" x="3" y="14" rx="1" /></>,
  shield: <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />,
  task: <><rect width="8" height="4" x="8" y="2" rx="1" ry="1" /><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><path d="M12 11h4" /><path d="M12 16h4" /><path d="M8 11h.01" /><path d="M8 16h.01" /></>,
  mount: <path d="m8 3 4 8 5-5 5 15H2L8 3z" />,
  link: <><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></>,
  map: <><path d="M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z" /><path d="M15 5.764v15" /><path d="M9 3.236v15" /></>,
  user: <><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></>,
  warn: <><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" /><path d="M12 9v4" /><path d="M12 17h.01" /></>,
  alert: <><circle cx="12" cy="12" r="10" /><line x1="12" x2="12" y1="8" y2="12" /><line x1="12" x2="12.01" y1="16" y2="16" /></>,
  info: <><circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" /></>,
  robot: <><path d="M4 13h11l3-3h2v4l-2 1H5z" /><path d="M6 15l-1 4M10 15v4M14 15v4M17 15l1 4" /></>,
  down: <path d="m6 9 6 6 6-6" />,
  server: <><rect width="20" height="8" x="2" y="2" rx="2" ry="2" /><rect width="20" height="8" x="2" y="14" rx="2" ry="2" /><line x1="6" x2="6.01" y1="6" y2="6" /><line x1="6" x2="6.01" y1="18" y2="18" /></>,
  search: <><path d="m21 21-4.34-4.34" /><circle cx="11" cy="11" r="8" /></>,
  flag: <path d="M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528" />,
  dl: <><path d="M12 15V3" /><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5" /></>,
  play: <path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z" />,
  film: <><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M7 3v18" /><path d="M3 7.5h4" /><path d="M3 12h18" /><path d="M3 16.5h4" /><path d="M17 3v18" /><path d="M17 7.5h4" /><path d="M17 16.5h4" /></>,
  back: <path d="m15 18-6-6 6-6" />,
  cal: <><path d="M8 2v4" /><path d="M16 2v4" /><rect width="18" height="18" x="3" y="4" rx="2" /><path d="M3 10h18" /></>,
  video: <><path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5" /><rect x="2" y="6" width="14" height="12" rx="2" /></>,
  cube: <><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" /><path d="m3.3 7 8.7 5 8.7-5" /><path d="M12 22V12" /></>,
  pause: <><rect x="14" y="3" width="5" height="18" rx="1" /><rect x="5" y="3" width="5" height="18" rx="1" /></>,
  repeat: <><path d="m17 2 4 4-4 4" /><path d="M3 11v-1a4 4 0 0 1 4-4h14" /><path d="m7 22-4-4 4-4" /><path d="M21 13v1a4 4 0 0 1-4 4H3" /></>,
  pin: <><path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0" /><circle cx="12" cy="10" r="3" /></>,
  angle: <><path d="M4 20h16" /><path d="M6 20 16 6" /><path d="M6 20a8 8 0 0 1 3.5-6.6" /></>,
  gauge: <><path d="m12 14 4-4" /><path d="M3.34 19a10 10 0 1 1 17.32 0" /></>,
  x: <><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>,
  check: <path d="M20 6 9 17l-5-5" />,
  key: <><path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z" /><circle cx="16.5" cy="7.5" r=".5" fill="currentColor" /></>,
  fileCheck: <><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4M9 15l2 2 4-4" /></>,
};
const Ic = ({ d, s = 16, style }: { d: ReactNode; s?: number; style?: CSSProperties }) => <svg className="ic" viewBox="0 0 24 24" style={{ width: `${s}px`, height: `${s}px`, ...style }} aria-hidden="true">{d}</svg>;

/** 시안 묶음(u8_1 왼쪽) ↔ 서버 분류(category 한 값). null = 서버에 그 묶음이 없음(모드 전환). 조종권 · 결재는 시안에 없는 서버 분류라 같은 꼴로 더함 */
export const GROUPS: { k: Ev['category'] | '' | null; name: string; ic: ReactNode }[] = [
  { k: '', name: '전체', ic: IC.grid }, { k: 'SAFETY', name: '안전', ic: IC.shield }, { k: 'RUN', name: '임무', ic: IC.task }, { k: null, name: '모드 전환', ic: IC.mount },
  { k: 'LINK', name: '연결 · 시스템', ic: IC.link }, { k: 'ROUTE', name: '지도', ic: IC.map }, { k: 'ACCOUNT', name: '사용자 작업', ic: IC.user },
  { k: 'LEASE', name: '조종권', ic: IC.key }, { k: 'APPROVAL', name: '결재', ic: IC.fileCheck },
];
const groupOf = (c: string) => GROUPS.find((g) => g.k === c);
/** 등급 칸(.lv r · w · i · m): 서버 severity(INFO 로 저장된 실패 코드는 주의 · history sevOf), 「지금 장면 저장」(RECORD_MARKED)은 시안 「남김」 */
type Lv = 'r' | 'w' | 'i' | 'm';
const LV: Record<Lv, [string, ReactNode]> = { r: ['위험', IC.warn], w: ['주의', IC.alert], i: ['정보', IC.info], m: ['남김', IC.flag] };
const LV_COLOR: Record<Lv, string> = { r: '#ff4d4f', w: '#f2b705', i: '#c3cad5', m: 'var(--pr3)' };
const lvOf = (e: Ev): Lv => (e.code === 'RECORD_MARKED' ? 'm' : ({ bad: 'r', warn: 'w' } as Record<string, Lv>)[sevOf(e)[0]] ?? 'i');
/** 등급 거르기 = 서버 severity 한 값 */
const SEVS: [string, Lv][] = [['ERROR', 'r'], ['WARN', 'w'], ['INFO', 'i']];
const SEV_NAME: Record<string, string> = { ERROR: '위험', WARN: '주의', INFO: '정보' };

/** 사건 제목: 서버 문장(시각 접두 뗌 · 모르는 로봇 사건 코드는 한국어) */
const title = (e: Ev) => told(e.message)?.text ?? sentence(e.message);
/** 날짜 묶음 머리(u8_1 「오늘 · 11월 26일」): 현지 날짜 */
function dayOf(iso: string) {
  const d = new Date(iso), t = new Date(), y = new Date(); y.setDate(t.getDate() - 1);
  const k = d.toLocaleDateString('sv'), md = `${d.getFullYear() !== t.getFullYear() ? `${d.getFullYear()}년 ` : ''}${d.getMonth() + 1}월 ${d.getDate()}일`;
  return { key: k, label: k === t.toLocaleDateString('sv') ? `오늘 · ${md}` : k === y.toLocaleDateString('sv') ? `어제 · ${md}` : md, md };
}
const clock = (iso: string) => new Date(iso).toTimeString().slice(0, 8);
const hm = (iso: string) => new Date(iso).toTimeString().slice(0, 5);
/** 실제 · 모의 실행 표지(로봇 목록의 sim 값, 모르면 없음) */
const simName = (sim: boolean | undefined) => (sim === undefined ? '' : sim ? '모의 실행' : '실제');
const photoOf = (e: Ev) => (e.code === 'PHOTO_STORED' && typeof e.data?.photo_id === 'string' && e.data.photo_id ? e.data.photo_id : '');
/** 클립 자리 글(u8_1 .noclip · .cl.no): 클립을 원한 사건(data.clip 참)만 클립 칸. 영상 썸네일 · 길이는 목록 응답에 없다 */
function noClip(e: Ev): [string, string] {
  if (e.code === 'PHOTO_STORE_FAILED') return ['사진 저장 실패', '기록만'];
  if (e.data?.clip === false) return e.severity === 'INFO' ? ['정보 단계', '기록만'] : e.severity === 'WARN' ? ['골라서 · 안 남김', '안 남김'] : ['안 남김', '안 남김'];
  return e.severity === 'INFO' ? ['정보 단계', '기록만'] : ['클립 없음', '기록만'];
}
const NONE_TEXT = '서버에 값 없음';
const DISABLED = { 'aria-disabled': true, tabIndex: -1 } as const;

/** 내려받기(F-LG-05): 서버 CSV 그대로 파일로. 10,000 행 넘으면 서버가 거절(EXPORT_LIMIT) · 동시 내보내기 429 RATE_LIMITED. 만든 URL 은 정리 */
async function download(q: URLSearchParams, name: string, cancel?: AbortSignal) {
  if (inApp()) throw new Error('앱에서는 파일을 내려받을 수 없습니다. PC 브라우저에서 내보내세요.');   // WebView 는 blob <a download> 를 받지 않는다
  let url = '';
  try {
    const b = await api.exportEvents(q, cancel), a = document.createElement('a');
    url = URL.createObjectURL(b);
    a.href = url; a.download = name; a.click();
    return { name, size: b.size };
  } catch (e) {
    const x = e instanceof ApiFail ? e : null;
    if (x?.code === 'CANCELED') throw x;
    throw new Error(x?.code === 'EXPORT_LIMIT' ? '내보낼 기록이 너무 많습니다(10,000개 넘음). 기간을 줄이거나 묶음 · 등급을 골라 다시 내보내세요.'
      : x?.code === 'RATE_LIMITED' ? '다른 기록 내보내기가 아직 끝나지 않았습니다. 잠시 뒤 다시 내보내세요.'
        : `내보내지 못했습니다. ${x?.message ?? '파일을 만들지 못했습니다. 다시 시도하세요.'}`);
  } finally {
    if (url) setTimeout(() => URL.revokeObjectURL(url), 0);   // 내려받기가 시작된 뒤 정리
  }
}
const bytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const mmdd = (d: string) => d.slice(5).replace('-', '');
/** 파일 이름(시안 u8_7 「foothold-기록-1120-1126」 꼴) */
const fileName = (from: string, to: string) => `foothold-기록-${from || to ? `${from ? mmdd(from) : '처음'}-${to ? mmdd(to) : '지금'}` : new Date().toLocaleDateString('sv')}.csv`;
type Got = { name: string; size: number };

type View = { at: 'list' } | { at: 'event'; e: Ev };
export function HistoryU8(c: HistoryCtx) {
  const light = useTheme()[1], n = namesOf(c);
  const [f, setF] = useState<Filter>(NONE), [quick, setQuick] = useState(-1);
  const ev = useEvents(f, c.cancel, 50);
  const [view, setView] = useState<View>({ at: 'list' }), [modal, setModal] = useState<'' | 'export' | 'mark'>(''), [got, setGot] = useState<Got | null>(null);
  const [toast, setToast] = useState<{ text: string; sub: string } | null>(null), [focusErr, setFocusErr] = useState('');
  // 1920x1080 스크롤 0: 표는 쪽으로 나눈다(시안 줄 96 px · 한 쪽 PAGE 줄). 마지막 쪽에서 서버에 더 있으면 「더 보기」 가 다음 묶음을 받는다
  const [pg, setPg] = useState(0), pages = Math.max(1, Math.ceil(ev.items.length / PAGE));
  useEffect(() => { if (pg >= pages) setPg(pages - 1); }, [pg, pages]);
  const set = (p: Partial<Filter>) => { setF((o) => ({ ...o, ...p })); setGot(null); };
  const period = (i: number) => { if (i === quick || i < 0) { setQuick(-1); set({ from: '', to: '' }); } else { setQuick(i); set({ from: back(QUICK[i][1]), to: back(0) }); } };
  const clear = () => { setQuick(-1); setF(NONE); setGot(null); };
  // 알림에서 연 사건 하나(#/history?event_id=…) = 그 사건 자세히. 범위 밖 · 없음이면 목록 위에 한 줄
  useEffect(() => {
    if (!c.focus) return;
    setFocusErr('');
    api.event(c.focus, c.cancel).then(shape(isEvent)).then((e) => setView({ at: 'event', e }), (x: ApiFail) => {
      if (x.code !== 'CANCELED') setFocusErr(x.status === 404 ? '이 기록을 볼 수 없습니다. 담당이 바뀌었거나 지워진 로봇의 기록일 수 있습니다.' : `기록을 받지 못했습니다. ${x.message}`);
    });
  }, [c.focus]);
  const filtered = params(f)?.toString() !== '';
  const empty = !ev.busy && !ev.err && !ev.items.length && !filtered && !focusErr;
  const leave = () => { setView({ at: 'list' }); if (c.focus) c.go('history'); };
  return <div className={`proto pv u8${light ? ' light' : ''}`} aria-label="기록" data-hs-frame data-u8={empty ? 'empty' : view.at}>
    {empty && view.at === 'list' ? <EmptyLog />
      : view.at === 'event' ? <EventView key={view.e.id} e={view.e} list={ev.items} n={n} c={c} f={f} quick={quick} back={leave} pick={(e) => setView({ at: 'event', e })} fromBell={view.e.id === c.focus} />
        : <>
          <Filters c={c} f={f} set={set} />
          <div className="pane lst" data-hs-main>
            <div className="tool">
              <label className="srch" aria-disabled="true" data-missing="search"><Ic d={IC.search} s={18} />
                <input disabled placeholder="사건 · 로봇 · 메모 찾기" aria-label="찾기" aria-describedby="u8-why-search" /><span id="u8-why-search" className="u8-why u8-tag">서버에 찾기 없음</span></label>
              <div className="seg2" role="group" aria-label="기간">{QUICK.map(([name], i) => <button key={name} type="button" className={quick === i ? 'on' : undefined} aria-pressed={quick === i} onClick={() => period(i)}>{name}</button>)}</div>
              <MarkButton c={c} open={() => setModal('mark')} />
              {got ? <>
                <span className="row" style={{ gap: '8px', fontSize: '12.5px', fontWeight: '700', color: 'var(--mu2)', whiteSpace: 'nowrap' }} role="status" data-got><span style={{ color: 'var(--pr3)', display: 'flex' }}><Ic d={IC.check} s={18} /></span>내려받음 · {got.name} · {bytes(got.size)}</span>
                <button type="button" className="btns" id="n-folder" style={{ borderColor: 'rgba(0,195,137,.45)' }} onClick={() => setGot(null)}><Ic d={IC.x} s={16} />닫기</button>
              </> : <button type="button" className="btns" id="n-export" onClick={() => setModal('export')}><Ic d={IC.dl} s={17} />내보내기</button>}
            </div>
            <Chips c={c} f={f} quick={quick} set={set} period={period} clear={clear} filtered={filtered} count={ev.busy || ev.err ? null : ev.items.length} more={!!ev.next} />
            <div className="thd" style={{ marginTop: '6px' }}><span>등급</span><span>클립</span><span>사건</span><span>묶음</span><span>로봇</span><span>시각</span><span>클립 길이</span></div>
            <div className="u8-rows" role="region" aria-label="사건" data-rows>
              {focusErr && <div className="u8-msg u8-focus" role="alert" aria-label="알림에서 연 기록" data-focus-err>{focusErr}
                <button type="button" className="btns" onClick={() => { setFocusErr(''); c.go('history'); }}>닫기</button></div>}
              <Rows items={ev.items.slice(pg * PAGE, pg * PAGE + PAGE)} n={n} open={(e) => setView({ at: 'event', e })} />
              {ev.err && <p className="u8-msg" role="alert">기록을 받지 못했습니다. {why(ev.err)}</p>}
              {ev.busy && <p className="u8-msg mu2" role="status">기록을 불러오는 중…</p>}
              {!ev.busy && !ev.err && !ev.items.length && filtered && <p className="u8-msg mu2">조건에 맞는 기록이 없습니다.</p>}
              {/* 시안 밖 · 새로 그림: 쪽 넘김 · 더 보기(시안은 8 줄만) */}
              {(pages > 1 || (!ev.busy && (ev.next || (ev.err && ev.err !== BAD_DAY)))) && <div className="u8-more" data-pager>
                {pages > 1 && <span className="row lab num" style={{ gap: '8px' }}><button type="button" className="btns" disabled={pg === 0} aria-label="앞 쪽" onClick={() => setPg(pg - 1)}>‹</button>
                  <span data-page>{pg + 1} / {pages}</span><button type="button" className="btns" disabled={pg >= pages - 1} aria-label="다음 쪽" onClick={() => setPg(pg + 1)}>›</button></span>}
                {!ev.busy && pg >= pages - 1 && (ev.next || (ev.err && ev.err !== BAD_DAY)) && <button type="button" className="btns" onClick={ev.more}>{ev.err ? '다시 시도' : '더 보기'}</button>}</div>}
            </div>
          </div>
        </>}
    {modal === 'export' && <ExportModal c={c} f={f} close={() => setModal('')} done={(g) => { setModal(''); setGot(g); }} />}
    {modal === 'mark' && <MarkModal c={c} close={() => setModal('')} done={(t) => { setModal(''); setToast(t); ev.again(); }} />}
    {toast && <div className="g dk toast" role="status" data-mark-out><span style={{ color: 'var(--pr3)', display: 'flex' }}><Ic d={IC.check} s={20} /></span>{toast.text}{toast.sub && <small>{toast.sub}</small>}
      <button type="button" className="btns" onClick={() => setToast(null)}>닫기</button></div>}
  </div>;
}

/** 왼쪽 거르기 판(u8_1 .pane.flt): 묶음 · 등급 · 실제/모의 실행 · 로봇 · 클립 있는 것만 · 보관 안내. 서버 거르기가 없는 칸은 잠금 + 까닭 한 줄 */
function Filters({ c, f, set }: { c: HistoryCtx; f: Filter; set: (p: Partial<Filter>) => void }) {
  // 로봇 거르기: 내 로봇 + 끝낸 시뮬 슬롯(지난 시뮬 기록 · 운영 관리자는 그 슬롯에서 한 내 행동만 서버가 보여 줌)
  const robots = [...myRobots(c.user, c.robots), ...(c.user.role === 'ORG_ADMIN' ? [] : c.robots.filter(idleSim))];
  return <aside className="pane flt" aria-label="기록 거르기" data-hs-side><div className="ttl" style={{ padding: '0 8px' }}>기록</div>
    <h4>묶음</h4>
    <div role="group" aria-label="묶음">{GROUPS.map((g) => g.k === null
      ? <div key={g.name} className="cat" {...DISABLED} data-missing="mode" title="서버에 모드 전환 기록이 없습니다"><Ic d={g.ic} s={19} />{g.name}<b>서버에 없음</b></div>
      : <button key={g.name} type="button" className={`cat${f.category === g.k ? ' on' : ''}`} aria-pressed={f.category === g.k} onClick={() => set({ category: g.k! })}><Ic d={g.ic} s={19} />{g.name}<b /></button>)}</div>
    <p className="u8-why">묶음별 건수는 서버가 주지 않습니다.</p>
    <h4>등급</h4>
    {/* 아무것도 안 고르면 셋 다 켜짐 = 전체. 서버 severity 는 한 값이라 고른 칸 하나만, 다시 누르면 전체 */}
    <div className="lvrow" role="group" aria-label="등급">{SEVS.map(([k, l]) => <button key={k} type="button" className={`lvt ${l}${!f.severity || f.severity === k ? ' on' : ''}`} aria-pressed={f.severity === k}
      onClick={() => set({ severity: f.severity === k ? '' : k })}><Ic d={LV[l][1]} s={16} />{LV[l][0]}</button>)}</div>
    {f.severity === 'WARN' && <p className="u8-why" data-grade-note>정보로 저장된 실패 기록(주의로 보임)은 「정보」 에서 보입니다.</p>}
    <h4>실제 · 모의 실행</h4>
    <div className="seg2" role="group" aria-label="실제 · 모의 실행" aria-disabled="true" data-missing="sim-filter"><span className="on">모두</span><span>실제</span><span>모의 실행</span></div>
    <p className="u8-why">서버에 실제 · 모의 실행 거르기가 없어 모두 보입니다.</p>
    <h4>로봇</h4>
    <label className="cat u8-pick"><Ic d={IC.robot} s={19} />
      <select aria-label="로봇" value={f.robot} onChange={(e) => set({ robot: e.target.value })}><option value="">모든 로봇</option>{robots.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
      <Ic d={IC.down} s={17} style={{ marginLeft: 'auto', color: '#9aa19d' }} /></label>
    <div className="tg" style={{ marginTop: '6px' }} aria-disabled="true" data-missing="clip-filter">클립 있는 것만<span className="sw" /></div>
    <p className="u8-why">서버에 클립 거르기가 없습니다.</p>
    <div style={{ position: 'absolute', left: '24px', right: '24px', bottom: '22px', paddingTop: '16px', borderTop: '1px solid var(--line)', fontSize: '12.5px', fontWeight: '600', color: 'var(--mu2)', lineHeight: '1.6' }} data-keep>
      <div className="row" style={{ gap: '8px', color: '#cfd5de', fontWeight: '700', fontSize: '13px' }}><Ic d={IC.server} s={16} />클립 보관 기간 · {NONE_TEXT}</div>서버가 보관 일수를 주지 않아 비워 둡니다.</div>
  </aside>;
}

/** 「지금 장면 저장」 단추(u8_1 #n-markbtn). 남길 내 로봇이 없으면 잠금 + 까닭 */
function MarkButton({ c, open }: { c: HistoryCtx; open: () => void }) {
  const none = !myRobots(c.user, c.robots).length;
  return <button type="button" className="btns" id="n-markbtn" style={{ marginLeft: 'auto' }} disabled={none} title={none ? '남길 로봇이 없습니다' : undefined} onClick={open}><Ic d={IC.flag} s={17} />지금 장면 저장</button>;
}

/** 필터 줄(u8_1 「필터 없음 · 사건 n 건」 · u8_3 칩 + 「필터 모두 풀기」 · 「맞는 사건 n 건」). 전체 수는 서버가 주지 않아 받은 수, 더 있으면 «이상» */
function Chips({ c, f, quick, set, period, clear, filtered, count, more }: { c: HistoryCtx; f: Filter; quick: number; set: (p: Partial<Filter>) => void; period: (i: number) => void;
  clear: () => void; filtered: boolean; count: number | null; more: boolean }) {
  const g = groupOf(f.category), lv = SEVS.find(([k]) => k === f.severity)?.[1], r = f.robot ? c.robots.find((x) => x.id === f.robot)?.name ?? '이름 모름' : '';
  const chips: [string, ReactNode, () => void][] = [];
  if (f.category && g) chips.push([g.name, g.ic, () => set({ category: '' })]);
  if (lv) chips.push([LV[lv][0], LV[lv][1], () => set({ severity: '' })]);
  if (r) chips.push([r, IC.robot, () => set({ robot: '' })]);
  if (f.from || f.to) chips.push([quick >= 0 ? QUICK[quick][0] : `${f.from || '처음'} ~ ${f.to || '지금'}`, IC.cal, () => period(-1)]);
  const num = count === null ? '' : `${filtered ? '맞는 사건' : '사건'} ${count} 건${more ? ' 이상' : ''}`;
  return <div className="chips" data-hs-sum>{chips.length ? <>
    <span className="mu2" style={{ fontWeight: '600' }}>필터</span>
    {chips.map(([name, ic, off]) => <button key={name} type="button" className="chip" aria-label={`${name} 거르기 풀기`} onClick={off}><Ic d={ic} s={14} />{name}<Ic d={IC.x} s={13} /></button>)}
    <button type="button" id="n-clear" style={{ marginLeft: '6px', color: 'var(--mu2)', fontWeight: '700' }} onClick={clear}>필터 모두 풀기</button>
  </> : <span className="mu2" style={{ fontWeight: '600' }}>필터 없음</span>}
    <span className="mu2" style={{ marginLeft: 'auto', fontWeight: '600' }} data-count>{num}</span></div>;
}

/** 표(u8_1): 날짜 머리(.day) + 96 px 줄(.ev). 줄을 누르면 그 사건 자세히(u8_2 · u8_4 · u8_5) */
const PAGE = 7;
function Rows({ items, n, open }: { items: Ev[]; n: Names; open: (e: Ev) => void }) {
  const out: ReactNode[] = [];
  let last = '';
  for (const e of items) {
    const d = dayOf(stamp(e));
    if (d.key !== last) { out.push(<div key={`d-${d.key}`} className="day" data-day={d.label}>{d.label}</div>); last = d.key; }
    out.push(<Row key={e.id} e={e} n={n} open={() => open(e)} />);
  }
  return <>{out}</>;
}
function Row({ e, n, open }: { e: Ev; n: Names; open: () => void }) {
  const l = lvOf(e), g = groupOf(e.category), r = n.robot(e), sim = n.sim(e), who = n.user(e), photo = photoOf(e), [cell, len] = noClip(e);
  return <div className="ev" role="button" tabIndex={0} data-ev={e.id} aria-label={`${clock(stamp(e))} ${title(e)} 자세히`} onClick={open}
    onKeyDown={(x) => { if (x.key === 'Enter' || x.key === ' ') { x.preventDefault(); open(); } }}>
    <span className={`lv ${l}`} data-lv={l}><Ic d={LV[l][1]} s={16} />{LV[l][0]}</span>
    {photo ? <div className="th" data-clip-cell="photo" style={{ backgroundImage: `url(${api.photoUrl(photo, true)})` }}><span className="du">사진</span></div>
      : e.data?.clip === true ? <div className={`th${sim ? ' sim' : ''}`} data-clip-cell="yes"><span className="pl"><Ic d={IC.play} s={14} style={{ color: '#fff' }} /></span></div>
        : <div className="noclip" data-clip-cell="no"><Ic d={IC.info} s={18} />{cell}</div>}
    <div className="t2">{title(e)}{who && <small data-who>{who}</small>}</div>
    <span className="catx"><Ic d={g?.ic ?? IC.info} s={16} />{g?.name ?? '기타'}</span>
    <div className="rb">{r || '없음'}{r && simName(sim) && <span className={`rt2${sim ? ' sim' : ''}`}>{simName(sim)}</span>}</div>
    <div className="tm">{clock(stamp(e))}</div>
    {e.data?.clip === true ? <span className="cl no" data-len>{NONE_TEXT}</span> : <span className="cl no" data-len>{len}</span>}
  </div>;
}

/** 사건 자세히(u8_2 · u8_5 = 클립 있는 사건, u8_4 = 기록만). 왼쪽 = 지금 목록, 위 = 등급 · 로봇 · 시각 · 모드 · 묶음 · 로봇 보기 · 이 사건 내보내기 */
function EventView({ e, list, n, c, f, quick, back: leave, pick, fromBell }: { e: Ev; list: Ev[]; n: Names; c: HistoryCtx; f: Filter; quick: number; back: () => void; pick: (e: Ev) => void; fromBell: boolean }) {
  const l = lvOf(e), g = groupOf(e.category), r = n.robot(e), sim = n.sim(e), robot = c.robots.find((x) => x.id === e.robot_id);
  const items = list.some((x) => x.id === e.id) ? list : [e, ...list];
  const [run, setRun] = useState(false), [got, setGot] = useState<Got | null>(null), [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  const scope = `${quick >= 0 ? QUICK[quick][0] : f.from || f.to ? '고른 기간' : '모든 기간'} · ${f.category ? groupOf(f.category)?.name ?? '고른 묶음' : '모든 묶음'}`;
  // 이 사건 하나 = 같은 시각(from = to = 서버 시각) · 로봇 · 묶음 · 등급으로 서버 CSV
  const one = async () => {
    const q = new URLSearchParams({ from: e.at, to: e.at, category: e.category, severity: e.severity });
    if (e.robot_id) q.set('robot_id', e.robot_id);
    setBusy(true); setErr('');
    try { setGot(await download(q, `foothold-기록-사건-${e.id}.csv`, c.cancel)); } catch (x) { if (!(x instanceof ApiFail && x.code === 'CANCELED')) setErr((x as Error).message); } finally { setBusy(false); }
  };
  // u15_3 「내보내기」: 이 실행의 사건 CSV(GET /events/export.csv?run_id)
  const [runBusy, setRunBusy] = useState(false), [runNote, setRunNote] = useState('');
  const runCsv = async () => {
    if (!e.run_id) return;
    setRunBusy(true); setRunNote('');
    try { const g = await download(new URLSearchParams({ run_id: e.run_id }), `foothold-기록-실행-${e.run_id}.csv`, c.cancel); setRunNote(`내려받음 · ${g.name} · ${bytes(g.size)}`); }
    catch (x) { if (!(x instanceof ApiFail && x.code === 'CANCELED')) setRunNote(`내보내지 못했습니다. ${(x as Error).message}`); } finally { setRunBusy(false); }
  };
  const d = dayOf(stamp(e)), runBtn = useRef<HTMLButtonElement>(null);
  const shut = () => { setRun(false); runBtn.current?.focus(); };   // 닫으면 초점은 누른 단추로
  return <>
    <div className="pane side" aria-label="사건 목록"><div className="row" style={{ gap: '10px', padding: '0 8px 12px' }}>
      <button type="button" className="btns" id="n-back" aria-label="목록으로" style={{ height: '38px', width: '38px', borderRadius: '12px' }} onClick={leave}><Ic d={IC.back} s={18} /></button><span className="ttl">기록</span>
      <span className="mu2" style={{ marginLeft: 'auto', fontSize: '13px', fontWeight: '600' }}>{scope}</span></div>
      <div className="u8-sevs">{items.map((x) => <SevRow key={x.id} e={x} n={n} on={x.id === e.id} pick={() => pick(x)} />)}</div>
    </div>
    <div className="eh" aria-label={fromBell ? '알림에서 연 기록' : '사건'} data-eh><span className="ttl" style={{ fontSize: '26px' }} title={title(e)} data-title>{title(e)}</span><span className={`lv ${l}`}><Ic d={LV[l][1]} s={16} />{LV[l][0]}</span>
      {r && <span className="g dk st" style={sim ? { borderStyle: 'dashed' } : undefined}><Ic d={IC.robot} s={17} />{r}{simName(sim) && <small>{simName(sim)}</small>}</span>}
      <span className="g dk st"><Ic d={IC.cal} s={17} />{clock(stamp(e))}<small>{d.md}</small></span>
      <span className="g dk st" data-missing="mode" title="서버에 당시 모드 값이 없습니다"><Ic d={IC.mount} s={17} />모드<small>{NONE_TEXT}</small></span>
      <span className="g dk st"><Ic d={g?.ic ?? IC.info} s={17} />{g?.name ?? '기타'}<small>묶음</small></span>
      {e.run_id && <button type="button" className="btns" style={{ marginLeft: 'auto' }} aria-expanded={run} onClick={() => setRun(!run)} ref={runBtn} data-run><Ic d={IC.task} s={17} />실행 기록 보기</button>}
      {robot && <button type="button" className="btns" id="n-robot" style={e.run_id ? undefined : { marginLeft: 'auto' }} onClick={() => { c.pick?.(robot.id); c.go('fleet'); }}><Ic d={IC.robot} s={17} />{r} 로봇 보기</button>}
      {got ? <span className="row" style={{ gap: '8px', fontSize: '12.5px', fontWeight: '700', color: 'var(--mu2)', whiteSpace: 'nowrap', ...(robot || e.run_id ? {} : { marginLeft: 'auto' }) }} role="status" data-got>
        <span style={{ color: 'var(--pr3)', display: 'flex' }}><Ic d={IC.check} s={18} /></span>내려받음 · {got.name} · {bytes(got.size)}</span>
        : <button type="button" className="btns" id="n-export1" style={robot || e.run_id ? undefined : { marginLeft: 'auto' }} disabled={busy} onClick={one}><Ic d={IC.dl} s={17} />{busy ? '내보내는 중…' : '이 사건 내보내기'}</button>}
    </div>
    {err && <p className="u8-msg u8-ehmsg" role="alert">{err}</p>}
    {e.data?.clip === true ? <ClipView e={e} n={n} c={c} /> : <InfoView e={e} n={n} c={c} pick={pick} />}
    {run && e.run_id && <div className="dim" onClick={shut} />}
    {run && e.run_id && <RunReportU15 id={e.run_id} cancel={c.cancel} close={shut} robot={n.robot(e) || undefined} exp={{ busy: runBusy, note: runNote, go: runCsv }} />}
  </>;
}
/** 왼쪽 사건 줄(u8_2 .sev) */
function SevRow({ e, n, on, pick }: { e: Ev; n: Names; on: boolean; pick: () => void }) {
  const l = lvOf(e), r = n.robot(e), sim = simName(n.sim(e));
  return <button type="button" className={`sev${on ? ' sel' : ''}`} aria-current={on || undefined} data-sev={e.id} onClick={pick}><span className={`dt ${l}`}><Ic d={LV[l][1]} s={18} /></span>
    <div style={{ minWidth: '0', flex: '1' }}>{title(e)}<small>{[r || '서버', sim, hm(stamp(e))].filter(Boolean).join(' · ')}</small></div>
    {e.data?.clip === true && <Ic d={IC.film} s={16} style={{ color: '#9aa19d' }} />}</button>;
}

type Load<T> = { ok: T } | { why: string } | null;
/** 클립 있는 사건(u8_2 · 모의 실행이면 u8_5): 영상 = 이 사건 EventClip(READY 만 재생), 3D 관절 재현 = joint-log. 서버가 501 이면 그 까닭 한 줄, 받지 않은 영상 · 재현을 그리지 않는다 */
function ClipView({ e, n, c }: { e: Ev; n: Names; c: HistoryCtx }) {
  const sim = !!n.sim(e), l = lvOf(e), robot = e.robot_id;
  const [clip, setClip] = useState<Load<EventClip | undefined>>(null), [joint, setJoint] = useState<Load<JointLogReplay>>(null);
  useEffect(() => {
    if (!robot) { setClip({ why: '로봇이 없는 사건이라 클립을 찾을 수 없습니다.' }); setJoint({ why: '로봇이 없는 사건입니다.' }); return; }
    records.clips(robot, c.cancel).then((r) => setClip({ ok: r.items.find((x) => x.event_id === e.id) }), (x) => setClip({ why: fail(x) }));
    records.jointLog(robot, e.id, c.cancel).then((r) => setJoint({ ok: r }), (x) => setJoint({ why: fail(x) }));
  }, []);
  const got = clip && 'ok' in clip ? clip.ok : undefined, ready = got?.status === 'READY' && !!got.url ? got : null;
  const again = (id: string) => robot && records.clip(robot, id, c.cancel).then((r) => setClip({ ok: r }), (x) => setClip({ why: fail(x) }));
  // 시간 막대: 사건(0 초) 기준. 계약 창 = 10 초 전 ~ 5 초 뒤(넘어짐은 일어설 때까지 · end_at null)
  const rel = (iso: string) => (Date.parse(iso) - Date.parse(e.at)) / 1000;
  const S = got ? rel(got.start_at) : -10, end = got?.end_at ? rel(got.end_at) : null;
  const v = useRef<HTMLVideoElement>(null), [t, setT] = useState(S), [dur, setDur] = useState<number | null>(null), [play, setPlay] = useState(false), [rate, setRate] = useState(1), [loop, setLoop] = useState(true);
  const E = end ?? (dur !== null ? S + dur : 5);
  useEffect(() => { if (v.current) { v.current.playbackRate = rate; v.current.loop = loop; } }, [rate, loop, ready]);
  const p = (x: number) => `${(Math.min(Math.max((x - S) / (E - S || 1), 0), 1) * 100).toFixed(2)}%`;
  const ticks = [] as number[]; for (let x = Math.ceil(S / 5) * 5; x <= E + 1e-9; x += 5) ticks.push(x);
  const sign = (x: number) => `${x < 0 ? '−' : x > 0 ? '+' : ''}${Math.abs(x).toFixed(1)} 초`;
  const tick = (x: number) => `${x < 0 ? '−' : x > 0 ? '+' : ''}${Math.abs(x)} 초`;
  const why = !clip ? '클립을 확인하는 중…' : 'why' in clip ? `영상을 볼 수 없습니다. ${clip.why}` : ready ? '' : got ? reason(got) : '이 사건의 클립이 아직 없습니다.';
  const toggle = () => { const x = v.current; if (!x) return; if (x.paused) { void x.play(); } else x.pause(); };
  const at = e.robot_at ?? e.at, sub = e.robot_at ? (sim ? '시뮬 시각' : '로봇 시각') : '서버가 받은 시각';
  const off = !ready;
  return <>
    <div className={`vid c${sim ? ' sim' : ''}`} data-clip-pane>
      {ready && <video ref={v} src={ready.url!} playsInline preload="metadata" onTimeUpdate={(x) => setT(S + x.currentTarget.currentTime)} onLoadedMetadata={(x) => setDur(x.currentTarget.duration || null)}
        onPlay={() => setPlay(true)} onPause={() => setPlay(false)} onEnded={() => setPlay(false)} />}
      {ready && <span className="g dk ov" style={{ left: '18px', top: '18px' }}><Ic d={IC.video} s={16} />{sim ? '시뮬 화면 녹화' : '앞 카메라'}<small>서버가 만든 클립 · {(E - S).toFixed(1)} 초</small></span>}
      {sim && <span className="g dk ov" style={{ right: '18px', top: '18px', borderStyle: 'dashed' }}>모의 실행</span>}
      {why && <p className="u8-vwhy" data-clip-why role="status">{why}{got?.status === 'PENDING' && got.clip_id && <> <button type="button" className="btns" onClick={() => again(got.clip_id!)}>다시 확인</button></>}</p>}
      <div className="tc"><small>{sub}</small>{full(at).slice(11)}.{String(new Date(at).getMilliseconds()).padStart(3, '0').slice(0, 1)}</div>
    </div>
    <div className={`vid d${sim ? ' sim' : ''}`} data-joint-pane>
      <span className="g dk ov" style={{ left: '18px', top: '18px' }}><Ic d={IC.cube} s={16} />3D 관절 재현<small>관절 · 몸 기울기 기록 50 Hz</small></span>
      {!joint ? <p className="u8-vwhy" role="status">관절 기록을 확인하는 중…</p>
        : 'why' in joint ? <p className="u8-vwhy" data-joint-why>관절 재현을 볼 수 없습니다. {joint.why}</p>
          : <p className="u8-vwhy" data-joint>받은 관절 기록: 관절 {joint.ok.joint_names.length} 개 · {joint.ok.frames.length} 프레임 · {joint.ok.rate_hz} Hz</p>}
    </div>
    <div className="pane trp" aria-disabled={off || undefined} data-trp>
      <button type="button" className="pp" id="pp" aria-label={play ? '멈춤' : '재생'} disabled={off} onClick={toggle}><Ic d={play ? IC.pause : IC.play} s={22} /></button>
      <div className="now"><small>사건 기준</small><span id="now">{sign(t)}</span></div>
      <div className="tl" id="tl"><div className="tr" /><div className="seg done" style={{ left: '0', width: p(t) }} />
        {E > 5 && <div className="seg ex" style={{ left: p(5), width: `calc(100.00% - ${p(5)})` }} />}
        <span className="mk" style={{ left: p(0), color: LV_COLOR[l] }}>사건<i style={{ background: LV_COLOR[l] }} /></span>
        {E > 5 ? <><span className="mk" style={{ left: p(5), color: 'var(--mu2)' }}>5 초 뒤<i style={{ background: 'rgba(255,255,255,.35)' }} /></span>
          <span className="mk" style={{ left: '100.00%', color: '#ffffff', transform: 'translateX(-100%)', alignItems: 'flex-end' }}>{end === null ? '일어섬' : '끝'} +{E.toFixed(1)} 초<i style={{ background: '#ffffff' }} /></span></>
          : <span className="mk" style={{ left: '100.00%', color: 'var(--mu2)', transform: 'translateX(-100%)', alignItems: 'flex-end' }}>{end === null && !ready ? '일어설 때까지' : '5 초 뒤'}<i style={{ background: 'rgba(255,255,255,.35)' }} /></span>}
        {ticks.map((x) => <span key={x} className="tk" style={{ left: p(x) }} data-tick>{tick(x)}</span>)}
        <span className="hd" id="hd" style={{ left: p(t) }} /></div>
      <div className="spd" id="spd" role="group" aria-label="재생 속도">{[0.25, 0.5, 1, 2].map((s) => <button key={s} type="button" className={rate === s ? 'on' : undefined} aria-pressed={rate === s} disabled={off} onClick={() => setRate(s)}>{s} 배</button>)}</div>
      <button type="button" className={`rp${loop ? ' on' : ''}`} id="rp" aria-pressed={loop} disabled={off} onClick={() => setLoop(!loop)}><Ic d={IC.repeat} s={18} />반복</button>
    </div>
    <div className="pane inf">
      <div className="mm"><div className="im" /><div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}><span><Ic d={IC.pin} s={15} /> 일어난 곳</span><b className="u8-none" style={{ fontSize: '17px' }}>{NONE_TEXT}</b><span>위치 기록 없음</span></div></div>
      <div style={{ flex: '1.1' }}><span>몸 기울기 최대</span><b className="u8-none"><Ic d={IC.angle} s={20} />{NONE_TEXT}</b><span>관절 기록 재생이 서버에 없음</span></div>
      <div style={{ flex: '1' }}><span>사건 전 속도</span><b className="u8-none"><Ic d={IC.gauge} s={20} />{NONE_TEXT}</b><span>속도 기록 없음</span></div>
      <div style={{ flex: '1.3' }}><span>클립 범위</span>{ready ? <b><Ic d={IC.film} s={20} />{(E - S).toFixed(1)} 초</b> : <b className="u8-none"><Ic d={IC.film} s={20} />{NONE_TEXT}</b>}<span>10 초 전부터 {end === null && got ? '일어설 때까지' : '5 초 뒤까지'}</span></div>
      <div style={{ flex: '1.2' }}><span>만든 곳</span><b><Ic d={IC.server} s={20} />서버</b><span>{sim ? '시뮬 기록으로 만듦' : '로봇은 기록만 보냄'}</span></div>
      <div style={{ flex: '1.2' }}><span>알림</span><b className="u8-none"><Ic d={IC.bell} s={20} />{NONE_TEXT}</b><span>사건별 알림 기록 없음</span></div>
    </div>
  </>;
}

/** 기록만 남은 사건(u8_4): 무엇이 있었나(서버 문장) · 진행 순서(서버에 없음) · 사람 · 시각, 오른쪽 = 같은 로봇의 그날 사건(GET /events robot_id · 그날) */
function InfoView({ e, n, c, pick }: { e: Ev; n: Names; c: HistoryCtx; pick: (e: Ev) => void }) {
  const g = groupOf(e.category), r = n.robot(e), day = new Date(stamp(e)).toLocaleDateString('sv'), photo = photoOf(e);
  const near = useEvents({ ...NONE, robot: e.robot_id ?? '', from: day, to: day }, c.cancel, 20), [bad, setBad] = useState(false);
  return <>
    <div className="pane" style={{ left: '388px', top: '160px', width: '1000px', bottom: '24px', padding: '28px 30px' }} data-info-pane>
      <div className="row" style={{ justifyContent: 'space-between' }}><span className="ttl">무엇이 있었나</span>
        <span className="row mu2" style={{ gap: '8px', fontSize: '13.5px', fontWeight: '600' }}><Ic d={IC.info} s={17} />{e.severity === 'INFO' ? '정보 단계 사건은 영상 없이 기록만 남깁니다' : '이 사건은 영상 없이 기록만 남았습니다'}</span></div>
      <div className="row" style={{ gap: '26px', marginTop: '30px', justifyContent: 'center' }}>
        {photo && !bad && <img className="u8-photo" src={api.photoUrl(photo)} alt="찍은 사진" loading="lazy" decoding="async" onError={() => setBad(true)} />}
        {(e.code === 'PHOTO_STORED' && (!photo || bad)) && <span className="u8-photo u8-nophoto" data-photo="bad">사진을 불러오지 못함</span>}
        {e.code === 'PHOTO_STORE_FAILED' && <span className="u8-photo u8-nophoto" data-photo="failed">사진 저장 실패 · 사진 없음</span>}
        <div className="u8-said" style={{ minHeight: '200px', borderRadius: '20px', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '10px', background: 'rgba(0,195,137,.12)', boxShadow: 'inset 0 0 0 1px rgba(0,195,137,.45)', color: '#fff' }}>
          <Ic d={g?.ic ?? IC.info} s={30} style={{ color: '#00c389' }} />
          <span style={{ fontSize: '22px', fontWeight: '800' }} data-said>{title(e)}</span>
          <span className="mu2" style={{ fontSize: '13px', fontWeight: '600' }} data-code>기록 코드 {e.code || NONE_TEXT}</span>
        </div>
      </div>
      <div style={{ marginTop: '52px', fontSize: '15px', fontWeight: '800', marginBottom: '8px' }}>진행 순서</div>
      <div className="row mu2" style={{ height: '64px', gap: '14px', borderBottom: '1px solid var(--line)', fontSize: '14.5px', fontWeight: '700' }} data-missing="steps">
        <span className="mu2" style={{ width: '80px', fontSize: '13.5px' }}>{clock(stamp(e))}</span><Ic d={IC.info} s={19} />진행 순서는 서버에 값 없음</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '0', position: 'absolute', left: '30px', right: '30px', bottom: '28px', borderTop: '1px solid var(--line)', paddingTop: '24px' }}>
        <div><div className="mu2" style={{ fontSize: '13px', fontWeight: '600' }}>사람</div><div style={{ fontSize: '18px', fontWeight: '800', marginTop: '6px' }} data-fact="who">{n.user(e) || '없음'}</div></div>
        <div><div className="mu2" style={{ fontSize: '13px', fontWeight: '600' }}>로봇 시각</div><div style={{ fontSize: '18px', fontWeight: '800', marginTop: '6px' }} data-fact="robot-at">{e.robot_at ? full(e.robot_at) : NONE_TEXT}</div></div>
        <div><div className="mu2" style={{ fontSize: '13px', fontWeight: '600' }}>서버가 받은 시각</div><div style={{ fontSize: '18px', fontWeight: '800', marginTop: '6px' }} data-fact="at">{full(e.at)}</div></div>
      </div>
    </div>
    <div className="pane" style={{ left: '1412px', top: '160px', right: '24px', bottom: '24px', padding: '28px 24px' }} data-near>
      <div className="ttl">같은 시간대{r ? ` ${r}` : ''}</div>
      <div className="mu2" style={{ fontSize: '13px', fontWeight: '600', marginTop: '6px' }}>그날 사건</div>
      <div className="u8-near" style={{ marginTop: '16px' }}>
        {near.items.map((x) => { const xl = lvOf(x);
          return <button type="button" key={x.id} className={`sev${x.id === e.id ? ' sel' : ''}`} style={{ height: '64px' }} onClick={() => pick(x)}><span className={`dt ${xl}`}><Ic d={LV[xl][1]} s={17} /></span>
            <div style={{ flex: '1', minWidth: '0' }}>{title(x)}<small>{clock(stamp(x))}</small></div>{x.data?.clip === true && <Ic d={IC.film} s={16} style={{ color: '#9aa19d' }} />}</button>; })}
        {near.err && <p className="u8-msg" role="alert">그날 사건을 받지 못했습니다. {why(near.err)}</p>}
        {near.busy && <p className="u8-msg mu2" role="status">불러오는 중…</p>}
      </div>
      <div style={{ position: 'absolute', left: '24px', right: '24px', bottom: '24px', fontSize: '12.5px', fontWeight: '600', color: 'var(--mu2)', lineHeight: '1.6', borderTop: '1px solid var(--line)', paddingTop: '16px' }}>영상이 있는 사건만 <Ic d={IC.film} s={14} style={{ verticalAlign: '-2px' }} /> 표시가 붙습니다.</div>
    </div>
  </>;
}

/** 창 틀(u8_6 · u8_8 .dim + .g.mdl): Esc · 바깥 누름 · × 로 닫음, 열면 첫 칸에 초점 */
function Modal({ name, close, children }: { name: string; close: () => void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const from = document.activeElement as HTMLElement | null;   // 닫으면 연 단추로 초점을 돌림
    box.current?.querySelector<HTMLElement>('button:not([disabled]):not([data-x]),input:not([disabled])')?.focus();
    return () => { if (from?.isConnected) from.focus(); };
  }, []);
  return <>
    <div className="dim" onClick={close} />
    <div ref={box} className="g mdl" role="dialog" aria-modal="true" aria-label={name} onKeyDown={(x) => { if (x.key === 'Escape') close(); }}>
      <div className="row" style={{ justifyContent: 'space-between' }}><span className="ttl">{name}</span><button type="button" id="n-x" data-x aria-label="닫기" onClick={close}><Ic d={IC.x} s={22} /></button></div>
      {children}
    </div>
  </>;
}
/** 고르기 칩(.ck): 서버 거르기는 한 값이라 «전부 켜짐 = 전체» 또는 «하나만». 전부 켜졌을 때 누르면 그것만, 하나뿐인 것을 누르면 다시 전부 */
const pickOne = (cur: string, k: string) => (cur === '' ? k : cur === k ? '' : k);

/** 내보내기 창(u8_6): 기간 · 묶음 · 등급 → 서버 CSV(export.csv). 형식 JSON · 클립 묶음은 서버에 없어 잠금 + 까닭. 내려받으면 목록 머리에 u8_7 줄 */
/** 오늘에서 n 일 뒤(음수 = 앞) 현지 날짜 YYYY-MM-DD */
const ymd = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString('sv'); };
/** 날짜 칸: 브라우저 언어 날짜 고르개 대신 시안 꼴 YYYY-MM-DD 글 칸. 다 쓴 값(있는 날짜)이나 빈 값만 넘긴다 */
function DayBox({ label, value, set }: { label: string; value: string; set: (v: string) => void }) {
  const [d, setD] = useState(value);
  useEffect(() => setD(value), [value]);
  const ok = (v: string) => v === '' || (/^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00`).toLocaleDateString('sv') === v);
  return <input className="num u8-day" type="text" inputMode="numeric" maxLength={10} placeholder="YYYY-MM-DD" aria-label={label} value={d}
    onChange={(x) => { const v = x.target.value; setD(v); if (ok(v)) set(v); }} onBlur={() => setD(value)} />;
}
function ExportModal({ c, f, close, done }: { c: HistoryCtx; f: Filter; close: () => void; done: (g: Got) => void }) {
  // 시안 u8_6: 지금 필터에 기간이 있으면 그 기간, 없으면 최근 7 일(오늘 포함)을 채워 둔다
  const [from, setFrom] = useState(() => (f.from || f.to ? f.from : ymd(-6))), [to, setTo] = useState(() => (f.from || f.to ? f.to : ymd(0))), [cat, setCat] = useState(f.category), [sev, setSev] = useState(f.severity);
  const [busy, setBusy] = useState(false), [err, setErr] = useState('');
  const late = !!from && !!to && from > to, days = from && to && !late ? Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1 : 0;
  const go = async () => {
    const q = params({ ...NONE, robot: f.robot, category: cat, severity: sev, from, to });
    if (late) { setErr('기간 시작이 끝보다 늦습니다.'); return; }
    if (!q) { setErr(`내보내지 못했습니다. ${BAD_DAY.message}`); return; }
    setBusy(true); setErr('');
    try { done(await download(q, fileName(from, to), c.cancel)); } catch (x) { if (!(x instanceof ApiFail && x.code === 'CANCELED')) setErr((x as Error).message); setBusy(false); }
  };
  const md = (d: string) => (d ? `${Number(d.slice(5, 7))}월 ${Number(d.slice(8))}일` : '');
  return <Modal name="기록 내보내기" close={close}>
    <div className="fm">
      <span>기간</span>
      <div className="inp u8-days" style={{ justifyContent: 'space-between' }} aria-invalid={late || undefined}>
        <span className="row" style={{ gap: '6px' }}><DayBox label="내보낼 기간 시작" value={from} set={setFrom} />~<DayBox label="내보낼 기간 끝" value={to} set={setTo} />
          <span data-span>{days ? `· ${days} 일` : !from && !to ? '· 처음부터 지금까지' : ''}</span></span><Ic d={IC.cal} s={18} /></div>
      <span>묶음</span>
      <div className="ck" role="group" aria-label="내보낼 묶음">{GROUPS.filter((g) => g.k).map((g) => <button key={g.name} type="button" className={!cat || cat === g.k ? 'on' : undefined} aria-pressed={cat === g.k} onClick={() => setCat(pickOne(cat, g.k!))}>
        {(!cat || cat === g.k) && <Ic d={IC.check} s={14} />}{g.name}</button>)}<span {...DISABLED} data-missing="mode">모드 전환 · 서버에 없음</span></div>
      <span>등급</span>
      <div className="ck" role="group" aria-label="내보낼 등급">{SEVS.map(([k, l]) => <button key={k} type="button" className={!sev || sev === k ? 'on' : undefined} aria-pressed={sev === k} onClick={() => setSev(pickOne(sev, k))}>
        {(!sev || sev === k) && <Ic d={IC.check} s={14} />}{LV[l][0]}</button>)}</div>
      <span>형식</span>
      <div className="lseg"><span className="on">CSV · 표</span><span {...DISABLED} data-missing="json">JSON · 서버에 없음</span></div>
      <span>클립</span>
      <div className="row" style={{ justifyContent: 'space-between', fontWeight: '700' }} aria-disabled="true" data-missing="clip-zip">영상 (MP4) 과 관절 재현 기록 묶기 · 서버에 없음<span className="sw" /></div>
    </div>
    <p className="note">서버는 묶음 · 등급을 하나씩 또는 전부로만 거릅니다. CSV 는 서버가 만들고 10,000 건까지 받습니다. 건수 · 크기는 미리 알 수 없습니다.{md(from) && md(to) ? ` ${md(from)} ~ ${md(to)}.` : ''}</p>
    {err && <p className="u8-msg" role="alert">{err}</p>}
    <div className="mb"><button type="button" className="cn" id="n-cancel" onClick={close}>취소</button>
      <button type="button" className="btnp" id="n-go" disabled={busy || late} onClick={go}><Ic d={IC.dl} s={18} />{busy ? '내보내는 중…' : '내보내기'}</button></div>
  </Modal>;
}

/** 지금 장면 저장 창(u8_8 · POST robots/{id}/records/mark-now): 내 로봇 하나 · 메모(200 자) → 주의 등급 · 클립 원함으로 남김.
 *  서버가 돌려준 클립 상태는 그대로 알림 줄에(지금은 NOT_BUILT = 서버 까닭 문장) */
export function MarkModal({ c, close, done }: { c: HistoryCtx; close: () => void; done: (t: { text: string; sub: string }) => void }) {
  const mine = myRobots(c.user, c.robots), here = c.robot && mine.some((r) => r.id === c.robot!.id) ? c.robot.id : mine[0]?.id ?? '';
  const [robot, setRobot] = useState(here), [note, setNote] = useState(''), [busy, setBusy] = useState(false), [err, setErr] = useState('');
  const [now] = useState(() => clock(new Date().toISOString())), sending = useRef(false);
  const send = async () => {
    if (sending.current || !robot) return;   // 두 번 눌러도 한 번만
    sending.current = true; setBusy(true); setErr('');
    try {
      const r = await records.markNow(robot, { severity: 'WARN', note: note.trim() || null, clip: true }, c.cancel);
      done({ text: '지금 장면을 남겼습니다', sub: r.clip ? (r.clip.status === 'READY' ? '클립이 준비됐습니다.' : reason(r.clip)) : '영상 없이 기록만 남겼습니다.' });
    } catch (x) {
      if (!(x instanceof ApiFail && x.code === 'CANCELED')) setErr(`남기지 못했습니다. ${fail(x)}`);
    } finally { sending.current = false; setBusy(false); }
  };
  return <Modal name="지금 장면 저장" close={close}>
    <div className="fm">
      <span>로봇</span>
      <div className="ck" role="group" aria-label="로봇">{mine.map((r) => <button key={r.id} type="button" className={robot === r.id ? 'on' : undefined} aria-pressed={robot === r.id} onClick={() => setRobot(r.id)}>
        {robot === r.id && <Ic d={IC.check} s={14} />}{r.name} · {robotStatus(r).text}</button>)}</div>
      <span>메모</span>
      <label className="inp"><input aria-label="메모" maxLength={200} placeholder="메모(200 자까지)" value={note} onChange={(x) => setNote(x.target.value)} /></label>
      <span>남는 것</span>
      <div style={{ fontWeight: '700', lineHeight: '1.5' }}>{now} 의 10 초 전부터 5 초 뒤까지<br /><span className="mu" style={{ fontWeight: '600', fontSize: '13.5px' }}>영상 클립 · 메모 · 남긴 사람</span></div>
    </div>
    <p className="note">클립은 서버가 만듭니다. 묶음은 「임무」 로 들어갑니다.</p>
    {err && <p className="u8-msg" role="alert">{err}</p>}
    <div className="mb"><button type="button" className="cn" id="n-cancel" onClick={close}>취소</button>
      <button type="button" className="btnp" id="n-go" disabled={busy || !robot} onClick={send}><Ic d={IC.flag} s={18} />{busy ? '남기는 중…' : '남기기'}</button></div>
  </Modal>;
}

/** u11_8 빈 기록(.pane.empty · 그림은 시안 svg 그대로) */
const LOG_ART = '<g stroke="rgba(255,255,255,.07)" stroke-width="1"><path d="M160 310 l-200 100" /><path d="M200 290 l-200 100" /><path d="M240 270 l-200 100" /><path d="M280 250 l-200 100" /><path d="M320 230 l-200 100" /><path d="M360 210 l-200 100" /><path d="M400 190 l-200 100" /><path d="M400 310 l200 100" /><path d="M360 290 l200 100" /><path d="M320 270 l200 100" /><path d="M280 250 l200 100" /><path d="M240 230 l200 100" /><path d="M200 210 l200 100" /><path d="M160 190 l200 100" /></g><ellipse cx="280" cy="300" rx="200" ry="26" fill="rgba(0,195,137,.08)"/><g fill="none" stroke-linecap="round"><rect x="170" y="110" width="220" height="180" rx="18" fill="rgba(255,255,255,.04)" stroke="rgba(255,255,255,.25)" stroke-width="1.6"/><path d="M200 150h120M200 190h160M200 230h90" stroke="rgba(255,255,255,.16)" stroke-width="10"/><circle cx="380" cy="270" r="34" fill="rgba(0,195,137,.10)" stroke="#00c389" stroke-width="2"/><path d="M380 254v16l10 8" stroke="#00c389" stroke-width="2.2"/></g>';
export const EmptyLog = () => <div className="pane empty" data-empty="log" aria-label="아직 기록이 없습니다"><svg className="art" viewBox="0 0 560 340" aria-hidden="true" dangerouslySetInnerHTML={{ __html: LOG_ART }} />
  <h2>아직 기록이 없습니다</h2><p>임무를 실행하거나 알림이 생기면 여기에 시간 순서로 남습니다.</p></div>;
