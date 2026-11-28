// 관제 탭 = 시안 u5_1 타일 · u5_2 고름 · u5_3 지도 보기 · u5_4 뒤집기 · u5_5 경보 · u5_6 운영자. 여섯 장의 body 를 JSX 로 옮기고(태그 · 클래스 · 순서 · 글 그대로)
// 고정 글 자리만 서버 값으로 바꿨다. 서버에 없는 값은 칸을 두고 «—». 명령은 기존 모듈(STOP = App 의 정지 처리, 고름 = controlPick)만 부른다.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { RobotSummary, ScreenState } from '../../../contracts/ts';
import { api, type ApiFail } from '../api';
import { RUN } from '../screens';
import { realDash } from '../screens/fleet';
import { ownerName, robotStatus, type Robot } from '../fake';
import { GAITS } from '../gait';
import { JOINTS } from '../go2model';
import { rt, useRt } from '../rt';
import type { Ctx } from '../screens';
import { actOf, controlPick, flagNote, isLost, lastly, needs, useControlPick } from '../screens/control';
import { floorName, floorsOf, useTree } from '../screens/maps';
import { sitePose, toMapPx } from './site';
import { tiles as tileGl, type TileLook } from './tileview';
import { SiteView } from './u5map';
import './u5.css';

// 시안 아이콘(lucide 선) 그대로
const I = (w: number, d: ReactNode, color?: string) => <svg className="ic" viewBox="0 0 24 24" style={{ width: `${w}px`, height: `${w}px`, ...(color ? { color } : {}) }}>{d}</svg>;
export const IC = {
  tiles: <><rect width="7" height="7" x="3" y="3" rx="1" /><rect width="7" height="7" x="14" y="3" rx="1" /><rect width="7" height="7" x="14" y="14" rx="1" /><rect width="7" height="7" x="3" y="14" rx="1" /></>,
  map: <><path d="M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z" /><path d="M15 5.764v15" /><path d="M9 3.236v15" /></>,
  flag: <path d="M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528" />,
  bolt: <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" />,
  wrench: <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z" />,
  wifi: <><path d="M12 20h.01" /><path d="M2 8.82a15 15 0 0 1 20 0" /><path d="M5 12.859a10 10 0 0 1 14 0" /><path d="M8.5 16.429a5 5 0 0 1 7 0" /></>,
  box: <><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" /><path d="m3.3 7 8.7 5 8.7-5" /><path d="M12 22V12" /></>,
  warn: <><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" /><path d="M12 9v4" /><path d="M12 17h.01" /></>,
  flip: <><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" /></>,
  cam: <><path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5" /><rect x="2" y="6" width="14" height="12" rx="2" /></>,
  mode: <path d="m8 3 4 8 5-5 5 15H2L8 3z" />,
  pin: <><path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0" /><circle cx="12" cy="10" r="3" /></>,
  bat: <><path d="M10 14v-4" /><path d="M22 14v-4" /><path d="M6 14v-4" /><rect x="2" y="6" width="16" height="12" rx="2" /></>,
  temp: <path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z" />,
  user: <><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></>,
  home: <><path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" /><path d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></>,
  dog: <><path d="M4 13h11l3-3h2v4l-2 1H5z" /><path d="M6 15l-1 4M10 15v4M14 15v4M17 15l1 4" /></>,
  stop: <><path d="M8 3h8l5 5v8l-5 5H8l-5-5V8z" /><rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" stroke="none" /></>,
};
export const ic = I;

// ── 서버 값 → 시안 글 ─────────────────────────────────────────
const SIDE: Record<string, string> = { FL: '왼쪽 앞다리', FR: '오른쪽 앞다리', RL: '왼쪽 뒷다리', RR: '오른쪽 뒷다리' };
const PART: Record<string, string> = { hip: '엉덩이', thigh: '허벅지', calf: '무릎' };
/** 관절 이름(JOINTS 순서 · FL_calf_joint) → «왼쪽 앞다리 무릎» */
export const jointName = (j: string) => { const [s, p] = j.split('_'); return `${SIDE[s] ?? s} ${PART[p] ?? p}`; };
export type Level = 'crit' | 'bad' | 'warn' | null;
/** 관절 온도 단계(시안 글: 보통 48 · 주의 51 · 경고 61 · 위험 72 °C) */
export const tempLevel = (t: number | null): Level => (t == null ? null : t >= 70 ? 'crit' : t >= 60 ? 'bad' : t >= 50 ? 'warn' : null);
const LEVEL_TEXT: Record<Exclude<Level, null>, string> = { crit: '위험', bad: '경고', warn: '주의' };
/** 연결 중인 실기의 관절 온도 최고값과 그 관절(robot_info.temperature.joints · JOINTS 순서). 없으면 null */
export function hotJoint(x: Robot): { t: number; j: string } | null {
  const q = x.online && !x.unknown ? x.robotInfo?.temperature?.joints : null;
  if (!q || q.length !== 12) return null;
  let best: { t: number; j: string } | null = null;
  q.forEach((c, i) => { if (c != null && Number.isFinite(c) && (!best || c > best.t)) best = { t: c, j: JOINTS[i] }; });
  return best;
}
const hm = (iso?: string | null) => { if (!iso) return null; const m = /(\d\d:\d\d)/.exec(iso.includes('T') ? new Date(iso).toTimeString() : iso); return m?.[1] ?? null; };
const missionOf = (m?: string) => { const g = m ? /^(.*) (\d+)\/(\d+)$/.exec(m) : null; return g ? { name: g[1], done: +g[2], total: +g[3] } : m ? { name: m, done: 0, total: 0 } : null; };
const GAIT_NAME = Object.fromEntries(GAITS.map((g) => [g.g, g.name])) as Record<string, string>;
const stateOf = (x: Robot): ScreenState | null => (x.unknown === 'summary' ? null : rt.get(x.id).state);
/** 시안 «대기 중 · 임무 중» 상태 글(그 밖은 기존 상태 글 robotStatus) */
const stText = (x: Robot) => (x.online && !x.unknown && x.status === 'IDLE' ? '대기 중' : robotStatus(x).text);

/** 타일 한 장의 글 · 칸(서버 값만 · 없으면 «—») */
export type TileFacts = {
  x: Robot; level: Level; flag: string | null; why: string; alert: boolean; sim: boolean; lostAt: string | null; lostNow: boolean;
  act: ReturnType<typeof actOf>; walk: boolean; paused: string | null;
  mode: string; mission: { name: string; done: number; total: number } | null; place: string;
  bat: [string, string]; temp: [string, string, '' | ' w' | ' r']; link: [string, string, '' | ' w']; who: [string, string]; hot: { t: number; j: string } | null;
};
export function facts(x: Robot, me: string, places: Map<string, string>): TileFacts {
  const s = stateOf(x), h = hotJoint(x), lvTemp = tempLevel(h?.t ?? null), gone = isLost(x), sim = !!x.sim, st = robotStatus(x);
  // 테두리 · 머리표: 관절 온도 단계, 아니면 연결 중인 로봇의 기존 경고(잠금 · 오류 = 빨강, 배터리 낮음 · 일시정지 · 남은 주의 코드 = 주황). 끊김은 칸 위 «다시 연결 중»(시안 K-07)
  const level: Level = lvTemp ?? (gone || !needs(x) ? null : st.tone === 'bad' ? 'bad' : 'warn');
  const why = lvTemp && h ? `${jointName(h.j)} ${Math.round(h.t)} °C` : flagNote(x) || st.text;
  const run = s?.run ?? null, paused = run?.status === 'PAUSED' ? (run.wait_reason === 'LINK_LOST' ? '일시정지 · 연결 끊김' : '일시정지') : null;
  const m = missionOf(x.mission) ?? (run && run.progress.total ? { name: '—', done: run.progress.done, total: run.progress.total } : null);
  const loc = s?.location ?? (x.unknown === 'summary' ? null : x.location ?? null);
  const fl = loc?.floor_id ? places.get(loc.floor_id) : undefined;
  const at = loc ? fl ?? (loc.x != null && loc.y != null ? `위치 ${loc.x.toFixed(1)}, ${loc.y.toFixed(1)} m` : null) : null;
  const place = at ? `${at}${gone ? ' (마지막 위치)' : ''}` : '—';
  const lat = s?.latency_ms, act = actOf(x, false);
  const holder = x.holder ?? rt.get(x.id).holder;
  const who: [string, string] = holder ? [holder.id === me ? '나' : holder.name || '—', holder.type === 'RUN' ? '임무' : '조종'] : [x.owner ? (x.owner === me ? '나' : ownerName(x)) : '없음', '담당자'];
  const bat = x.battery != null ? lastly(x, `${Math.round(x.battery)} %`, x.seenAt) : null, tv = h ? lastly(x, `${Math.round(h.t)} °C`, x.seenAt) : null;
  return {
    x, level, why, alert: needs(x) || !!lvTemp, flag: level ? `${LEVEL_TEXT[level]} · ${why}` : null, sim, lostNow: gone, lostAt: gone ? hm(x.seenAt) ?? '—' : null, paused,
    act, walk: act === 'walk' && !paused, mode: s?.gait?.gait ? GAIT_NAME[s.gait.gait] ?? s.gait.gait : '—', mission: m, place, hot: h,
    bat: sim ? ['시뮬', '배터리 해당 없음'] : [bat ?? '—', '—'],
    temp: sim ? ['없음', stText(x), ''] : tv ? [tv, lvTemp ? LEVEL_TEXT[lvTemp] : '보통', lvTemp === 'bad' || lvTemp === 'crit' ? ' r' : lvTemp === 'warn' ? ' w' : ''] : ['—', '—', ''],
    link: sim ? ['서버', '시뮬 계산', ''] : gone ? ['연결 중', `${hm(x.seenAt) ?? '—'} 끊김`, ' w'] : x.online ? ['연결', lat != null ? `${Math.round(lat)} ms` : '—', ''] : [st.text, '—', ''],
    who,
  };
}
const RANK = { crit: 0, bad: 1, warn: 2 } as const;
/** 경고 타일 맨 앞(위험 → 경고 → 주의), 그 밖은 받은 순서 그대로(기존 관제 order 와 같음) */
export const order = (l: TileFacts[]) => l.map((f, i) => [f, i] as const).sort((a, b) => (a[0].level ? RANK[a[0].level] : 9) - (b[0].level ? RANK[b[0].level] : 9) || a[1] - b[1]).map(([f]) => f);
/** 타일 배치: 4 대 이하 2×2(u5_6), 8 대 이하 4×2(u5_1), 그보다 많으면 칸이 가장 크게 남는 열 수 · 타일을 그만큼 줄임(zoom) */
export function wallGrid(n: number): { cols: number; rows: number; zoom: number } {
  if (n <= 4) return { cols: 2, rows: 2, zoom: 1 };
  if (n <= 8) return { cols: 4, rows: 2, zoom: 1 };
  const W = 1472, H = 900, TW = 357.5, TH = 440;   // 시안 4×2 한 칸
  let best = { cols: 4, rows: Math.ceil(n / 4), zoom: 0 };
  for (let c = 4; c <= n; c++) {
    const r = Math.ceil(n / c), z = Math.min(1, (W - 14 * (c - 1)) / c / TW, (H - 20 * (r - 1)) / r / TH);
    if (z > best.zoom + 1e-6) best = { cols: c, rows: r, zoom: z };
  }
  return best;
}

// ── 타일 ──────────────────────────────────────────────────
function Cv({ f, front, hotMap }: { f: TileFacts; front: boolean; hotMap: Record<string, string> }) {
  const ref = useRef<HTMLCanvasElement>(null), look = useRef<TileLook>({ pose: null, front, cyber: f.sim, walk: false, down: false, hot: {} });
  look.current = { pose: sitePose(stateOf(f.x)?.location ?? (f.x.unknown === 'summary' ? null : f.x.location)), front: front || f.sim, cyber: f.sim, walk: f.walk, down: f.act === 'lie', hot: hotMap };
  useEffect(() => (ref.current ? tileGl().add(ref.current, () => look.current) : undefined), []);
  const go2 = JSON.stringify({ walk: f.walk, glow: !f.sim, pin: !f.sim, hot: hotMap, cyber: f.sim, yaw: front || f.sim ? 0 : 'back', dist: front || f.sim ? 1.25 : 2.1, floor: 0.5 });
  const showFront = front || f.sim;
  return <div style={{ height: '222px' }} className={showFront ? 'cv st' : 'cv'} data-face={showFront ? 'front' : 'live'}>
    <canvas ref={ref} className={showFront ? 'front' : 'rear'} data-go2={go2}></canvas>
    {f.sim ? <span className="g dk ov" style={{ left: '8px', top: '8px' }}>{I(14, IC.cam)}{stText(f.x)} · 정면 보기</span>
      : front ? <span className="g dk ov" style={{ left: '8px', bottom: '8px', ...(f.level === 'bad' || f.level === 'crit' ? { color: '#ff4d4f' } : {}) }}>{I(14, IC.temp)}{f.hot ? (f.level === 'bad' || f.level === 'crit' ? `${jointName(f.hot.j)} ${Math.round(f.hot.t)} °C` : `최고 관절 온도 ${Math.round(f.hot.t)} °C`) : '최고 관절 온도 —'}</span>
      : f.lostNow ? <div className="lk">{I(24, IC.wifi, '#f2b705')}다시 연결 중<small>마지막 화면 {f.lostAt}</small></div>
      : <span className="g dk ov" style={{ left: '8px', top: '8px' }}>{I(14, IC.cam)}뒤 1 m</span>}
    {!front && f.paused && <span className="stb chk" style={{ color: '#f2b705' }} data-paused>{I(14, IC.warn)}{f.paused}<i></i></span>}
  </div>;
}

function Tile({ f, sel, front, pick, open }: { f: TileFacts; sel: boolean; front: boolean; pick: () => void; open: () => void }) {
  const hotMap = useMemo(() => (f.hot && f.level ? { [f.hot.j.replace(/_joint$/, '')]: f.level === 'warn' ? 'warn' : 'hot' } : {}), [f.hot?.j, f.level]);
  const cls = `tile${f.level ? ` lv-${f.level}` : ''}${f.sim ? ' sim' : ''}${sel ? ' sel' : ''}${f.level ? ' warncell' : ''}${f.sim ? ' rehearse' : ''}`;
  const red = f.level === 'bad' || f.level === 'crit';
  return <div className={cls} data-t={f.x.name} data-robot={f.x.id} data-tone={f.level ?? undefined} data-act={f.act} data-sel={sel || undefined} data-live={f.walk ? '1' : undefined} role="button" tabIndex={0} aria-pressed={sel} aria-label={`${f.x.name} 타일`}
    onClick={() => (sel ? open() : pick())} onDoubleClick={open} onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) { e.preventDefault(); open(); } }}>
    {f.flag && <span className="flag warntag" style={{ background: red ? '#ff4d4f' : '#f2b705' }} data-warn-flag>{I(13, IC.warn)}{f.flag}</span>}
    <Cv f={f} front={front} hotMap={hotMap} />
    <div className="inf"><div className="nm"><b style={red ? { color: '#ff4d4f' } : undefined}>{f.x.name}</b>{f.sim && <span className="chip sim">시뮬</span>}<span className="md">{I(15, IC.mode)}{f.mode}</span></div>
      <div className="ln">{I(16, f.sim && !f.mission ? IC.home : IC.flag)}<span>{f.mission ? f.mission.name : f.sim ? `임무 전 · ${stText(f.x)}` : '—'}</span>{f.mission && f.mission.total > 0 && <em>할 일 {f.mission.done} / {f.mission.total}</em>}</div>
      {f.mission && f.mission.total > 0 && <div className="pg"><i style={{ width: `${Math.round((f.mission.done / f.mission.total) * 100)}%` }}></i></div>}
      <div className="ln">{I(16, IC.pin)}<span>{f.place}</span></div>
      <div className="sts"><div className="s" data-fact="battery">{I(16, IC.bat)}{f.bat[0]}<small>{f.bat[1]}</small></div><div className={`s${f.temp[2]}`} data-fact="temp">{I(16, IC.temp)}{f.temp[0]}<small>{f.temp[1]}</small></div><div className={`s${f.link[2]}`} data-fact="link">{I(16, IC.wifi)}{f.link[0]}<small>{f.link[1]}</small></div><div className="s" data-fact="who">{I(16, IC.user)}{f.who[0]}<small>{f.who[1]}</small></div></div></div>
  </div>;
}

// ── 오른쪽 칸 ─────────────────────────────────────────────
function Mini({ all, sel }: { all: TileFacts[]; sel: string }) {
  const dots = [...all].sort((a, b) => a.x.name.localeCompare(b.x.name, 'ko', { numeric: true })).flatMap((f) => {
    const p = sitePose(stateOf(f.x)?.location ?? (f.x.unknown === 'summary' ? null : f.x.location));
    if (!p) return [];   // 위치가 오면 그린다(지어내지 않음)
    const [px, py] = toMapPx(p.x, p.z), left = `calc(50% + ${Math.round(px * 0.125 - 200)}px)`, top = `${Math.round(py * 0.125)}px`;
    const kind = f.sim ? 'sim' : f.level === 'bad' || f.level === 'crit' ? 'r' : f.level === 'warn' || f.lostNow ? 'o' : '';
    const me = f.x.id === sel, label = sel ? me : kind === 'r' || (kind === 'o' && !f.lostNow);
    return [<i key={f.x.id} className={`dotm ${kind}${sel ? (me ? ' sel' : ' dim') : ''}`} style={{ left, top }} data-walk={f.walk ? '1' : undefined} data-dot={f.x.id}></i>,
      label && <span key={`${f.x.id}-l`} className={`dotl${me ? ' sel' : ''}`} style={{ left, top }}>{f.x.name}</span>];
  });
  return <div className="pane" style={{ padding: '10px' }}><div className="row" style={{ justifyContent: 'space-between', padding: '4px 6px 10px' }}><span className="ttl" style={{ fontSize: '17px' }}>작은 지도</span><span className="mu2" style={{ fontSize: '12.5px' }}>{sel ? '선택한 로봇 강조' : '점 = 로봇 · 점선 = 시뮬'}</span></div><div className="mini">{dots}</div></div>;
}

/** 최근 경고 = 주의가 필요한 로봇(기존 관제 needs · 관절 온도 · 끊김)에서 경보 칸에 나온 로봇을 뺀 것. 시각 = 받은 시각(발생 시각 필드 없음) · 모르면 칸을 접음 */
function Recent({ list, pick, open }: { list: TileFacts[]; pick: (id: string) => void; open: (id: string) => void }) {
  return <div className="pane" style={{ padding: '16px 18px 6px', flex: '1', overflow: 'hidden' }} aria-label="최근 경고"><div className="row" style={{ justifyContent: 'space-between', marginBottom: '4px' }}><span className="ttl" style={{ fontSize: '17px' }}>최근 경고</span><a href="#/history" style={{ color: 'inherit', textDecoration: 'none' }}><span className="mu2" style={{ fontSize: '12.5px' }}>기록 탭에서 모두 보기</span></a></div>
    {list.map((f) => { const red = f.level === 'bad' || f.level === 'crit', t = hm(f.x.seenAt);
      const head = f.hot && f.level ? `관절 ${LEVEL_TEXT[f.level]}` : f.lostNow ? '연결 끊김' : f.why;
      const sub = f.hot && f.level ? f.why : f.lostNow ? `${f.place === '—' ? '위치 —' : f.place.replace(' (마지막 위치)', '')} · 다시 연결 중` : f.mission?.name ?? stText(f.x);
      return <div className="al" key={f.x.id} data-alert={f.x.id} role="button" tabIndex={0} onClick={() => pick(f.x.id)} onDoubleClick={() => open(f.x.id)}><span style={{ color: red ? '#ff4d4f' : '#f2b705' }}>{I(18, f.hot && f.level ? IC.temp : f.lostNow ? IC.wifi : IC.warn)}</span><div>{f.x.name} {head}<small>{sub}</small></div>{t && <time data-alert-at title={`받은 시각 ${t}`}>{t}</time>}</div>; })}
  </div>;
}
const m1 = (v: number | null) => (v == null ? '—' : v.toFixed(1));
const hms = (at: string) => new Date(at).toTimeString().slice(0, 8);
/** 고른 로봇 상세 = GET /robots/{id}(옛 로봇 탭 서랍과 같은 요청). 담당이 바뀌면 다시 받고, 늦게 온 옛 답은 버린다. 404 = 목록을 다시 받음 */
function useDetail(id: string, owner: string, cancel: AbortSignal | undefined, refresh: () => void) {
  const [got, setGot] = useState<RobotSummary | null>(null), [err, setErr] = useState(''), gen = useRef(0);
  useEffect(() => {
    const g = ++gen.current; setErr('');
    api.robot(id, cancel).then((r) => { if (g === gen.current) setGot(r); }, (e: ApiFail) => {
      if (g !== gen.current || e.code === 'CANCELED') return;
      if (e.status !== 404) return setErr(`상세를 받지 못했습니다. ${e.message}`);
      setErr('이 로봇을 찾을 수 없습니다. 지워졌을 수 있어 목록을 다시 받습니다.'); refresh();
    });
  }, [id, owner]);
  return { got: got?.id === id ? got : null, err };
}
/** 선택 칸(u5_2): 임무 · 위치 · 모드 · 조종. 상세(GET /robots/{id}) 값, 실시간 state 가 있으면 그것이 앞선다 */
function Picked({ f, open, me, cancel, refresh }: { f: TileFacts; open: () => void; me: string; cancel?: AbortSignal; refresh: () => void }) {
  useRt();
  const { got, err } = useDetail(f.x.id, f.x.owner, cancel, refresh), hidden = f.x.unknown === 'summary';
  const s = hidden ? null : rt.get(f.x.id).state, loc = s ? s.location : got?.location ?? null;
  const run = got?.current_run, runText = run ? `${run.scenario_name} · ${RUN[run.status] ?? run.status} · 할 일 ${run.progress.done} / ${run.progress.total}` : f.mission ? `${f.mission.name}${f.mission.total ? ` · 할 일 ${f.mission.done} / ${f.mission.total}` : ''}` : '진행 중인 임무가 없습니다';
  const lease = got?.lease, held = rt.get(f.x.id).holder;
  const who = held ? (held.id === me ? '나' : held.name || '—') : lease ? (lease.holder_type === 'RUN' ? '임무' : lease.user ? (lease.user.id === me ? '나' : lease.user.display_name) : '—') : '없음';
  return <div className="pane" style={{ padding: '18px 18px 18px' }} data-picked><div className="row" style={{ justifyContent: 'space-between' }}><span className="ttl">{f.x.name}</span></div>
    <div className="kv"><span>임무</span><b data-k="임무" style={{ fontWeight: 'inherit' }}>{hidden ? '확인 안 됨' : runText}</b><span>위치</span><b data-k="위치" style={{ fontWeight: 'inherit' }}>{hidden ? '확인 안 됨' : loc && loc.x != null && loc.y != null ? `x ${m1(loc.x)} m · y ${m1(loc.y)} m (${hms(loc.updated_at)})` : '위치 없음'}</b><span>모드</span><b data-k="모드" style={{ fontWeight: 'inherit' }}>{f.mode}</b><span>조종</span><b data-k="조종" style={{ fontWeight: 'inherit' }}>{hidden ? '확인 안 됨' : who}</b></div>
    {err ? <p className="mu2" role="alert" style={{ fontSize: '12.5px', marginTop: '14px', lineHeight: '1.5' }} data-detail-err>{err}</p>
      : <p className="mu2" style={{ fontSize: '12.5px', marginTop: '14px', lineHeight: '1.5' }}>한 번 더 누르면 로봇 탭에서 열립니다.</p>}
    <div className="btns openb" style={{ height: '46px', marginTop: '12px', fontSize: '14px' }} role="button" tabIndex={0} onClick={open} onKeyDown={(e) => { if (e.key === 'Enter') open(); }}>{I(17, IC.dog)}로봇 탭에서 열기</div></div>;
}
function Alarm({ f, stop, open }: { f: TileFacts; stop?: (id: string) => void; open: () => void }) {
  const press = stop ? { 'data-stop-press': '', onPointerDown: (e: { button: number }) => { if (e.button === 0) stop(f.x.id); }, onClick: (e: { detail: number }) => { if (!e.detail) stop(f.x.id); } } : {};
  return <div className="pane abox" style={{ padding: '18px' }} data-alarm={f.x.id}><div className="row" style={{ gap: '10px', color: '#ff4d4f' }}>{I(22, IC.warn)}<span className="ttl" style={{ fontSize: '18px', color: '#ff4d4f' }}>경보 · {f.x.name} 관절 위험</span></div>
    <p style={{ fontSize: '14px', lineHeight: '1.55', marginTop: '10px', color: '#ffffff' }}>{f.hot ? `${jointName(f.hot.j)}이 ${Math.round(f.hot.t)} °C 입니다.` : ''} 로봇은 스스로 멈추지 않습니다.</p>
    <div style={{ display: 'flex', gap: '8px', marginTop: '14px' }}>{stop && <div className="rstop" style={{ flex: '1' }} role="button" tabIndex={0} aria-label={`${f.x.name} 정지`} {...press}>{I(18, IC.stop)}{f.x.name} 정지</div>}<div className="btns k5open" style={{ flex: '1', height: '52px', fontSize: '14px' }} role="button" tabIndex={0} onClick={open}>{I(17, IC.dog)}로봇 탭에서 보기</div></div></div>;
}

// ── 화면 ──────────────────────────────────────────────────
export function Control5(c: Ctx & { stop?: (id: string) => void; mayStop?: (id: string) => boolean }) {
  useRt();
  const me = c.user.id, admin = c.user.role === 'ORG_ADMIN';
  const [view, setView] = useState<'tiles' | 'map'>('tiles'), [scope, setScope] = useState<'all' | 'mine'>(admin ? 'all' : 'mine'), [front, setFront] = useState(false), [demo, setDemo] = useState(true);
  const sel = useControlPick();
  useEffect(() => () => controlPick.set(''), []);
  const t = useTree(c.cancel);
  const places = useMemo(() => new Map(floorsOf(t.tree).map((p) => [p.floor.id, `${p.building.name} ${floorName(p.floor.name)}`])), [t.tree]);
  const list = scope === 'mine' ? c.robots.filter((x) => x.owner === me) : c.robots;
  const all = order(list.map((x) => facts(x, me, places)));
  useEffect(() => { if (sel && !list.some((x) => x.id === sel)) controlPick.set(''); });
  const see = (s: 'all' | 'mine') => { if (s !== scope) controlPick.set(''); setScope(s); };
  const open = (id: string) => { c.pick(id); c.go('fleet'); };
  const n = (f: (x: TileFacts) => boolean) => all.filter(f).length;
  const g = wallGrid(all.length), picked = all.find((f) => f.x.id === sel), crit = all.find((f) => f.level === 'crit');
  const seg = (on: boolean, v: string, icon: ReactNode, go: () => void) => <span className={on ? 'on' : ''} data-v={v} role="button" tabIndex={0} aria-pressed={on} onClick={go} onKeyDown={(e) => { if (e.key === 'Enter') go(); }}>{I(16, icon)}{v}</span>;
  // 총괄: 수 칸 = 서버 요약(GET /dashboard · 시뮬 몫은 뺌 · realDash)의 임무 중 · 주의 필요(=경고). 받지 못하면 «—» + 까닭(title · 화면 읽기 한 줄). 운영 관리자 = 받은 로봇 상태로 셈
  const d = admin ? realDash(c.dash?.d ?? null, c.robots) : null, dErr = admin ? c.dash?.err ?? '' : '';
  const why = dErr ? `요약을 받지 못했습니다. ${dErr}` : undefined;
  const cnt = (k: string, icon: ReactNode, v: number | null, red = false, src?: 'dashboard') => <span className="cnt" style={red ? { color: '#ff4d4f' } : undefined} data-sum={k} data-src={src} title={src ? why : undefined}>{I(16, icon, red ? '#ff4d4f' : undefined)}{`${k} `}<b style={red ? { color: '#ff4d4f' } : undefined}>{v ?? '—'}</b></span>;
  return <main className="u5" data-view={view} aria-label="관제">
    <div className="tb"><div className="seg2" role="group" aria-label="보기">{seg(view === 'tiles', '타일 보기', IC.tiles, () => setView('tiles'))}{seg(view === 'map', '지도 보기', IC.map, () => setView('map'))}</div>
      <span className="pinf"><i></i>첫 화면으로</span><span className="sep"></span>
      {admin ? cnt('임무 중', IC.flag, d ? d.robots_running : null, false, 'dashboard') : cnt('임무 중', IC.flag, n((f) => f.x.online && !!f.mission && f.x.status !== 'PAUSED'))}
      {cnt('충전', IC.bolt, null)}
      {cnt('점검', IC.wrench, null)}
      {cnt('연결 중', IC.wifi, n((f) => !f.sim && (f.lostNow || (!f.x.online && f.x.unknown === 'wait'))))}
      {cnt('시뮬 대기', IC.box, n((f) => f.sim && f.x.status !== 'RUNNING'))}
      {admin ? cnt('경고', IC.warn, d ? d.robots_attention : null, true, 'dashboard') : cnt('경고', IC.warn, n((f) => !!f.level), true)}
      {why && <span className="ap-sr" role="alert" data-dash-err>{why}</span>}
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '14px' }}>
        {view === 'tiles' && <span className="btns flipb" style={{ height: '42px', padding: '0 14px', fontSize: '13.5px', ...(front ? { background: 'rgba(0,195,137,.16)', borderColor: 'rgba(0,195,137,.45)', color: '#00c389' } : {}) }} role="button" tabIndex={0} aria-pressed={front}
          onClick={() => setFront(!front)} onKeyDown={(e) => { if (e.key === 'Enter') setFront(!front); }}>{I(16, IC.flip)}{front ? '뒤 1 m 시점으로' : '정면 상태로 뒤집기'}</span>}
        <span className={demo ? 'tgl on' : 'tgl'} role="switch" aria-checked={demo} tabIndex={0} onClick={() => setDemo(!demo)}>데모 표시<i></i></span>
        <div className="seg2 flt" role="group" aria-label="범위"><span className={scope === 'all' ? 'on' : ''} data-f="모두" role="button" tabIndex={0} aria-pressed={scope === 'all'} onClick={() => see('all')}>모두</span><span className={scope === 'mine' ? 'on' : ''} data-f="내 로봇" role="button" tabIndex={0} aria-pressed={scope === 'mine'} onClick={() => see('mine')}>내 로봇</span></div></div></div>
    {view === 'tiles' ? <div className="wall" style={{ gridTemplateColumns: `repeat(${g.cols},1fr)`, gridTemplateRows: `repeat(${g.rows},1fr)` }} aria-label="로봇 타일" data-count={all.length}>
      {all.map((f) => <ZoomBox key={f.x.id} zoom={g.zoom}><Tile f={f} sel={f.x.id === sel} front={front} pick={() => controlPick.set(f.x.id)} open={() => open(f.x.id)} /></ZoomBox>)}</div>
      : <SiteView all={all} sel={sel} pick={(id) => controlPick.set(id)} open={open} />}
    <div className="side">
      {view === 'tiles' ? <>
        <Mini all={all} sel={sel} />
        {picked && <Picked key={picked.x.id} f={picked} open={() => open(picked.x.id)} me={me} cancel={c.cancel} refresh={c.refresh} />}
        {crit && !picked && <Alarm f={crit} stop={c.mayStop?.(crit.x.id) ? c.stop : undefined} open={() => open(crit.x.id)} />}
        <Recent list={all.filter((f) => (f.alert || f.lostNow) && f.x.id !== crit?.x.id)} pick={(id) => controlPick.set(id)} open={open} /></>
        : <MapSide all={all} sel={sel} pick={(id) => controlPick.set(id)} open={open} />}
    </div>
  </main>;
}
/** 대수가 많을 때만 타일을 줄인다(8 대 이하는 시안 그대로 zoom 1 · 감싸지 않음) */
const ZoomBox = ({ zoom, children }: { zoom: number; children: ReactNode }) => (zoom >= 1 ? children : <div style={{ zoom, display: 'grid', minWidth: 0, minHeight: 0 }}>{children}</div>);

function MapSide({ all, sel, pick, open }: { all: TileFacts[]; sel: string; pick: (id: string) => void; open: (id: string) => void }) {
  const moving = all.filter((f) => f.walk).length;
  return <><div className="pane" style={{ padding: '16px 18px' }}><div className="row" style={{ justifyContent: 'space-between' }}><span className="ttl" style={{ fontSize: '17px' }}>동선 겹쳐 보기</span><span className="tgl on"><i></i></span></div>
    <div className="lg" style={{ marginTop: '6px' }}><svg width="40" height="8"><line x1="2" y1="4" x2="38" y2="4" stroke="#00c389" strokeWidth="2" strokeLinecap="round" /></svg>기존 동선<span className="mu2" style={{ marginLeft: 'auto', fontSize: '12.5px' }}>임무 중 {moving} 대</span></div>
    <div className="lg"><svg width="40" height="8"><line x1="2" y1="4" x2="38" y2="4" stroke="#ffffff" strokeWidth="2" strokeDasharray="6 4" strokeLinecap="round" /></svg>새 동선<span className="mu2" style={{ marginLeft: 'auto', fontSize: '12.5px' }}>—</span></div>
    <div className="lg" style={{ color: '#f2b705' }}><svg width="40" height="18"><circle cx="20" cy="9" r="7" fill="none" stroke="#f2b705" strokeWidth="1.5" /></svg>겹치는 곳 —<span className="mu2" style={{ marginLeft: 'auto', fontSize: '12.5px' }}>—</span></div></div>
    <div className="pane" style={{ padding: '8px 14px', flex: '1' }}>{[...all].sort((a, b) => a.x.name.localeCompare(b.x.name, 'ko', { numeric: true })).map((f) => <div key={f.x.id} className="rrow" data-r={f.x.name} role="button" tabIndex={0} aria-pressed={f.x.id === sel} onClick={() => (f.x.id === sel ? open(f.x.id) : pick(f.x.id))}>
      <span style={{ color: f.level === 'bad' || f.level === 'crit' ? '#ff4d4f' : '#9aa19d' }}>{I(18, IC.dog)}</span><div style={{ minWidth: '0' }}>{f.x.name}<small style={{ display: 'block', marginTop: '2px' }}>{f.place}</small></div>
      <small style={{ marginLeft: 'auto', width: '92px', textAlign: 'right', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.mission?.name ?? (f.lostNow ? '연결 중' : f.sim ? '시뮬 대기' : stText(f.x))}</small><em>{f.sim ? '없음' : f.bat[0]}</em></div>)}</div></>;
}
