// 로봇 탭(PC) = 시안 proto/screens/u4_1_robot.html 의 body 를 그대로 옮긴 것(scripts/proto2jsx.py 로 뽑은 뒤 고정 글 자리만 서버 값으로).
// 태그 · 클래스 · 순서 · 글 · 인라인 style 은 시안 그대로. 머리줄 .bar 는 앱 껍데기(W1)가 그리므로 뺐다.
// 값: 목록 = 서버 로봇 목록 · 머리 칩 = 실시간 state(연결 왕복 ms · 제어 모드 · 배터리 · 관절 최고 온도 · 조종하는 사람) · 3D = 실제 관절값 ·
// 보기 = 지도(승인 지도 + 로봇 위치) · 카메라 · 라이다 · 깊이. 값이 없으면 시안 틀은 그대로 두고 그 자리만 「—」.
// 조종 · STOP 은 serverdrive.tsx useServerDrive 하나(이 파일은 자리만): 키는 시안 글대로 ↑ 앞으로 · ← → 돌기 · ↓ 막힘 · Space 정지.
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as PEv, type ReactNode } from 'react';
import type { MapVersion, ScreenAction } from '../../../../contracts/ts';
import { api } from '../../api';
import { rt, useRt } from '../../rt';
import type { Robot } from '../../fake';
import { useDriveFeed } from '../../drivemedia';
import { DriveView, useServerDrive, type DriveKeys, type Tok } from '../../serverdrive';
import { LidarMap } from '../../lidarmap';
import { go2Temps } from '../../pcdrive';
import { REPORT_STALE_MS, go2Pose, JOINTS, jointName } from '../../go2model';
import { ACTION_NAMES, FACTORY_OFF, LOWLEVEL, actionResultText } from '../actiontrial';
import { floorsOf, isVersion, shape, toPixel, useTree } from '../maps';
import type { Ctx } from '../../screens';
import { AddRobot } from '../../pairing';
import { mount, type Go2Api } from './go2view';
import '../../proto/ui.pv.css';
import '../../proto/pc.pv.css';
import './u4.css';

/** 시안 키 안내 줄과 같게: ↑(W) 앞으로 · ← →(A D) 돌기 · ↓(S) 후진 막음. Space 정지는 앱 머리줄 STOP 그대로 */
export const U4_KEYS: DriveKeys = {
  map: { ArrowUp: 'up', KeyW: 'up', ArrowLeft: 'rotl', KeyA: 'rotl', ArrowRight: 'rotr', KeyD: 'rotr' },
  block: { ArrowDown: '후진은 아직 지원하지 않습니다', KeyS: '후진은 아직 지원하지 않습니다' },
};
const NA = '—';
const DOG = <svg className="ic" viewBox="0 0 24 24" style={{ width: '19px', height: '19px' }}><path d="M4 13h11l3-3h2v4l-2 1H5z" /><path d="M6 15l-1 4M10 15v4M14 15v4M17 15l1 4" /></svg>;
const CUBE = <svg className="ic" viewBox="0 0 24 24" style={{ width: '19px', height: '19px' }}><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" /><path d="m3.3 7 8.7 5 8.7-5" /><path d="M12 22V12" /></svg>;
const IC17: CSSProperties = { width: '17px', height: '17px' }, IC24: CSSProperties = { width: '24px', height: '24px' };

/** 자세 · 동작 단추 일곱(시안 순서 · 글 · 리모컨 조합 글 그대로) → 계약 ScreenAction 이름 */
const ACTS: [ScreenAction['action'], string, string, ReactNode][] = [
  ['Sit', '앉기', 'R1+B', <><path d="M8 20v-6l-2-4 4-2 4 2v4h4v6" /><circle cx="10" cy="5" r="2" /></>],
  ['StandUp', '일어서기', 'START 중 안 됨', <><circle cx="12" cy="4.5" r="2" /><path d="M12 7v7M8 10h8M9 21l3-7 3 7" /></>],
  ['StandDown', '엎드리기', 'L2+A', <><path d="M3 18h18M6 14h12l-2-4H8z" /><path d="M12 3v5M9.5 6L12 8.5 14.5 6" /></>],
  ['Stretch', '기지개', 'R2+A', <><path d="M3 16c3-6 6-6 9-3s6 3 9-3" /><path d="M4 20h4M16 20h4" /></>],
  ['Hello', '악수', 'R2+B', <><path d="M7 11l3-3 4 1 3-2 3 3-6 6-3-2-2 1z" /><path d="M4 13l3-2" /></>],
  ['Heart', '하트', 'R2+Y', <path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.5-7 10-7 10z" />],
  ['Greet', '인사', 'L1+A', <path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V11M11 10V4.5a1.5 1.5 0 0 1 3 0V11M14 10.5V6a1.5 1.5 0 0 1 3 0v8a6 6 0 0 1-6 6h-1a5 5 0 0 1-4-2l-2.5-3.5a1.5 1.5 0 0 1 2.4-1.8L8 14" />],
];
/** 시안 일어서기 「START 중 안 됨」 까닭 글 그대로 */
const STANDUP_WHY = 'START 에서는 일어서기를 보낼 수 없습니다 · 앉은 뒤 「앉기」 를 다시 누르면 일어납니다';

/** 목록 한 줄의 작은 글: 실제/시뮬 · 지금 하는 일 · 조종하는 사람 */
export function railLine(x: Robot, me: string) {
  const live = rt.get(x.id), h = live.holder ?? x.holder ?? null, s = live.state;
  const kind = x.sim ? '시뮬' : '실제';
  if (!x.online && !x.sim) return `${kind} · 연결 끊김`;
  const who = h?.type === 'USER' ? (h.id === me ? '나' : h.name || '') : '';
  const doing = h?.type === 'USER' ? '조종 중' : x.status === 'RUNNING' ? (x.mission ? `${x.mission} 중` : '임무 중')
    : x.status === 'STOP_LATCHED' ? '정지 잠금' : x.status === 'ERROR' ? '오류' : '대기';
  return [kind, doing, who].filter(Boolean).join(' · ');
}
const bat = (x: Robot) => { const v = rt.get(x.id).state?.battery?.soc ?? x.battery; return v == null ? NA : `${Math.round(v)} %`; };

function Rail({ c, sel, add }: { c: Ctx; sel: string; add: () => void }) {
  useRt();
  return <div className="pane rail"><div className="row" style={{ justifyContent: 'space-between', padding: '0 6px 12px' }}><span className="ttl">로봇</span>
    <span data-go="u4_6_add" className="btns addbtn" style={{ height: '34px', padding: '0 11px', fontSize: '12.5px' }} role="button" tabIndex={0} onClick={add} data-u4-add>
      <svg className="ic" viewBox="0 0 24 24" style={{ width: '14px', height: '14px' }}><path d="M5 12h14" /><path d="M12 5v14" /></svg>로봇 추가</span></div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
      {c.robots.map((x) => <div key={x.id} className={`rcard ${x.id === sel ? 'on' : ''}`} data-r={x.name} data-robot-row={x.id} role="button" tabIndex={0}
        aria-current={x.id === sel || undefined} onClick={() => c.pick(x.id)}>
        <span className="av">{x.sim ? CUBE : DOG}</span>
        <div style={{ flex: '1' }}>{x.name}<small>{railLine(x, c.user.id)}</small></div>
        <span className="mu2" style={{ fontSize: '13px', whiteSpace: 'nowrap' }}>{x.sim ? '시뮬' : bat(x)}</span></div>)}
    </div></div>;
}

/** 지도 칸: 로봇이 있는 승인 지도 + 내 위치(가운데) + 같은 판의 다른 로봇. 시안처럼 3200 px 폭 그림 위에 그린다 */
function MapView({ c, r }: { c: Ctx; r: Robot }) {
  useRt();
  const loc = rt.get(r.id).state?.location ?? r.location ?? null, vid = loc?.map_version_id ?? null;
  const [v, setV] = useState<MapVersion | null>(null), view = useRef<HTMLDivElement>(null), [box, setBox] = useState({ w: 816, h: 600 });
  useEffect(() => {
    setV(null); if (!vid) return;
    let alive = true;
    api.version(vid, c.cancel).then(shape(isVersion)).then((x) => { if (alive) setV(x); }, () => {});
    return () => { alive = false; };
  }, [vid]);
  useEffect(() => { const el = view.current; if (el?.clientWidth) setBox({ w: el.clientWidth, h: el.clientHeight }); }, []);
  const k = v ? 3200 / v.width : 1, W = 3200, H = v ? Math.round(v.height * k) : 2000;
  const at = (x: number, y: number) => { const [px, py] = toPixel(v!, x, y); return [px * k, py * k] as const; };
  const me = v && loc?.x != null && loc?.y != null ? at(loc.x, loc.y) : null;
  const others = v ? c.robots.filter((x) => x.id !== r.id).flatMap((x) => {
    const l = rt.get(x.id).state?.location ?? x.location;
    return l && l.map_version_id === v.id && l.x != null && l.y != null ? [{ x, p: at(l.x, l.y) }] : [];
  }) : [];
  const shift = me ? `translate(${(box.w / 2 - me[0]).toFixed(1)}px,${(box.h * 0.55 - me[1]).toFixed(1)}px)` : 'translate(0px,0px)';
  const yaw = loc?.yaw ?? null;
  return <div className="mapv" ref={view} data-u4-map={v?.id ?? ''}><div className="mapin" style={{ transform: shift }}>
    {v && <img src={api.imageUrl(v.id)} alt="" style={{ width: `${W}px`, height: `${H}px` }} />}
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ position: 'absolute', left: '0', top: '0' }}>
      {others.map(({ x, p }) => <g key={x.id} transform={`translate(${p[0].toFixed(0)},${p[1].toFixed(0)})`}>
        <circle r="9" fill={x.online ? '#9aa4ae' : '#5e6662'} stroke="#0b0e12" strokeWidth="3" />
        <text x="16" y="5" fontSize="15" fontWeight="700" fill="#cfd6dc">{`${x.name} · ${railLine(x, c.user.id).split(' · ')[1] ?? ''}`}</text></g>)}
      {me && <g id="me" transform={`translate(${me[0].toFixed(1)},${me[1].toFixed(1)}) rotate(${yaw == null ? 0 : (-yaw * 180 / Math.PI).toFixed(1)})`}>
        <circle r="46" fill="rgba(0,195,137,.10)" />
        {yaw != null && <path id="cone" d="M0 0 L60 -26 A66 66 0 0 1 60 26 Z" fill="rgba(0,195,137,.30)" />}
        <circle r="13" fill="#fff" stroke="#00c389" strokeWidth="5" /></g>}
    </svg></div></div>;
}
function MapName({ c, r }: { c: Ctx; r: Robot }) {
  const t = useTree(c.cancel), loc = rt.get(r.id).state?.location ?? r.location ?? null;
  const p = floorsOf(t.tree).find((x) => x.floor.id === loc?.floor_id);
  return <span className="g dk mapname" data-u4-mapname>{p ? `${p.building.name} ${p.floor.name}` : NA}</span>;
}

function Feed({ id, ch, big }: { id: string; ch: 'rgb' | 'depth'; big: boolean }) {
  return <DriveView f={useDriveFeed(id, ch)} ch={ch} big={big} />;
}
function Lidar({ id }: { id: string }) {
  const f = useDriveFeed(id, 'lidar');
  return <LidarMap feed={f} empty="라이다 신호 없음" tag={false} pick />;
}

/** 가운데 3D: 시안 go2view 를 그대로 띄우고 실제 관절값 · 나간 명령으로 움직인다 */
function Stage({ r, q, drive, hot }: { r: Robot; q: number[] | null; drive: Go2Api['drive']; hot: Record<string, string> }) {
  const cv = useRef<HTMLCanvasElement>(null), g = useRef<Go2Api | null>(null);
  useEffect(() => {
    if (typeof WebGLRenderingContext === 'undefined' || !cv.current) return;
    const a = mount(cv.current, { pin: true, orbit: true, glow: true, cyber: !!r.sim }); g.current = a;
    return () => { a.dispose(); g.current = null; };
  }, [r.id, r.sim]);
  useEffect(() => { if (g.current) { g.current.q = q; g.current.drive = drive; } });
  const key = JSON.stringify(hot);
  useEffect(() => { g.current?.setHot(hot); }, [key]);
  return <canvas id="go2" ref={cv} data-robot-3d={r.id} />;
}

/** 손잡이 하나(시안 .stick): 왼쪽 = 앞(세로만 · 뒤로는 막음) · 오른쪽 = 돌기(가로만). 처음 잡은 손가락 하나만 */
function Stick({ side, put, blocked }: { side: 'L' | 'R'; put: (p: number, el: HTMLElement, t: Tok[]) => void; blocked: (m: string) => void }) {
  const own = useRef<number | null>(null), [xy, setXy] = useState([0, 0]);
  const move = (e: PEv<HTMLDivElement>) => {
    const el = e.currentTarget, b = el.getBoundingClientRect(), m = (el.clientWidth || b.width) * 0.3 || 1;
    let x = (e.clientX - b.left - b.width / 2) / m, y = (e.clientY - b.top - b.height / 2) / m; const n = Math.hypot(x, y); if (n > 1) { x /= n; y /= n; }
    if (side === 'L') { if (y > 0.3) blocked('후진은 아직 지원하지 않습니다'); const v = Math.max(0, -y); setXy([0, -v * m]); put(e.pointerId, el, v > 0.3 ? ['up'] : []); }
    else { setXy([x * m, 0]); put(e.pointerId, el, x < -0.3 ? ['rotl'] : x > 0.3 ? ['rotr'] : []); }
  };
  const end = (e: PEv<HTMLDivElement>) => { if (e.pointerId !== own.current) return; own.current = null; setXy([0, 0]); put(e.pointerId, e.currentTarget, []); };
  return <div className={`stick${xy[0] || xy[1] ? ' on' : ''}`} style={side === 'L' ? { left: '26px' } : { right: '26px' }} data-u4-stick={side}
    onPointerDown={(e) => { if (own.current !== null) return; own.current = e.pointerId; e.currentTarget.setPointerCapture?.(e.pointerId); move(e); }}
    onPointerMove={(e) => { if (e.pointerId === own.current) move(e); }} onPointerUp={end} onPointerCancel={end}>
    <i style={{ transform: `translate(${xy[0]}px,${xy[1]}px)` }} /></div>;
}

type Tab = 'drive' | 'check' | 'settings';
type View = 'map' | 'rgb' | 'lidar' | 'depth';
const VIEWS: [View, string][] = [['map', '지도'], ['rgb', '카메라'], ['lidar', '라이다'], ['depth', '깊이']];

function Robot1({ c, r }: { c: Ctx; r: Robot }) {
  const d = useServerDrive(c, r, undefined, U4_KEYS), { l, s, mine } = d;
  const [tab, setTab] = useState<Tab>('drive'), [view, setView] = useState<View>('map');
  const [msg, setMsg] = useState(''), [pending, setPending] = useState<string | null>(null), tm = useRef(0);
  const say = (m: string) => { setMsg(m); clearTimeout(tm.current); tm.current = window.setTimeout(() => setMsg(''), 2600); };
  useEffect(() => { if (d.why) say(d.why); }, [d.why]);
  const res = s?.action_result;
  useEffect(() => { if (pending && res?.request_id === pending && res.status !== 'RUNNING') { say(actionResultText(res)); setPending(null); } }, [res?.request_id, res?.status]);
  useEffect(() => () => clearTimeout(tm.current), []);
  const now = rt.now(), fresh = !!s && now - l.stateAt < REPORT_STALE_MS;
  const pose = go2Pose(s, fresh), temps = go2Temps(s, fresh, s ? (now - l.stateAt) / 1000 : 0);
  const link = rt.link(), ms = link.at === 'open' && link.latencyMs != null ? `${Math.round(link.latencyMs)} ms` : NA;
  const online = s?.connection === 'ONLINE';
  const lowlevel = s?.control === 'LOWLEVEL', mode = !online ? NA : lowlevel ? 'START' : 'Sport';
  const soc = s?.battery?.soc ?? (r.sim ? null : r.battery);
  const hotJ = temps && temps.hot >= 0 ? temps.joints[temps.hot] : null;
  const holder = l.holder ?? r.holder ?? null, who = holder?.type === 'USER' ? (holder.id === c.user.id ? '나' : holder.name || NA) : NA;
  const a = s?.applied ?? null, sp = s?.speed;
  const walk = !online || sp == null ? NA : sp < 0.05 ? (s?.posture?.state === 'LYING' ? '엎드림' : '서 있음')
    : `걷는 중 · ${sp.toFixed(1)} m/s ${a && a[0] < 0 ? '뒤로' : a && Math.abs(a[1] ?? 0) > Math.abs(a[0] ?? 0) ? '옆으로' : '앞으로'}`;
  const located = online && s?.location?.x != null;
  const drive = a && online ? { v: a[0] ?? 0, side: a[1] ?? 0, turn: a[2] ?? 0 } : null;
  const hot: Record<string, string> = temps && temps.hot >= 0 && hotJ != null && hotJ >= 60 ? { [JOINTS[temps.hot].replace(/_joint$/, '')]: 'hot' } : {};
  const ready = d.ready;
  const act = (name: ScreenAction['action']) => {
    if (!mine) return say('조종 시작 후 사용할 수 있습니다.');
    if (name === 'StandUp' && lowlevel) return say(STANDUP_WHY);
    if (lowlevel ? !LOWLEVEL.has(name) : FACTORY_OFF.has(name)) return say(`${ACTION_NAMES[name]}: ${lowlevel ? '저수준 제어 중에는 쓸 수 없음' : '순정 번호 확인 전'}`);
    if (!online) return say('로봇과 서버 연결을 확인하세요.');
    d.zero(); say('서버 접수를 기다리고 있습니다.');
    rt.action(r.id, name, {}, false, (why, id) => { if (why) say(`거부 · ${why}`); else { setPending(id ?? null); say('서버 접수 · 로봇의 결과를 기다리고 있습니다.'); } });
  };
  const offAct = (name: ScreenAction['action']) => name === 'StandUp' ? lowlevel : lowlevel ? !LOWLEVEL.has(name) : FACTORY_OFF.has(name);
  const small = view === 'map' ? <Feed id={r.id} ch="rgb" big={false} /> : <MapView c={c} r={r} />;
  return <>
    <div className="hdr" data-robot-head={r.id}><span className="ttl" style={{ fontSize: '26px', marginRight: '6px' }}>{r.name}</span>
      <span className="g dk st" data-cell="link"><svg className="ic" viewBox="0 0 24 24" style={IC17}><path d="M12 20h.01" /><path d="M2 8.82a15 15 0 0 1 20 0" /><path d="M5 12.859a10 10 0 0 1 14 0" /><path d="M8.5 16.429a5 5 0 0 1 7 0" /></svg>{online ? '연결' : r.online ? '연결 중' : '끊김'}<small>{ms}</small></span>
      <span data-go="u4_7_mode" className="g dk st" data-cell="mode"><svg className="ic" viewBox="0 0 24 24" style={IC17}><path d="m8 3 4 8 5-5 5 15H2L8 3z" /></svg>{mode}<small>Shift + 1 ~ 4</small></span>
      <span className="g dk st" data-cell="battery"><svg className="ic" viewBox="0 0 24 24" style={IC17}><path d="M10 14v-4" /><path d="M22 14v-4" /><path d="M6 14v-4" /><rect x="2" y="6" width="16" height="12" rx="2" /></svg>{soc == null ? NA : `${Math.round(soc)} %`}<small>{NA}</small></span>
      <span className="g dk st" data-cell="temp"><svg className="ic" viewBox="0 0 24 24" style={IC17}><path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z" /></svg>{hotJ == null ? NA : `${Math.round(hotJ)} °C`}<small>{hotJ != null && hotJ >= 60 ? jointName(JOINTS[temps!.hot]) : '최고 관절 온도'}</small></span>
      <span className="g dk st" data-cell="holder"><svg className="ic" viewBox="0 0 24 24" style={IC17}><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>{who}<small>조종자</small></span>
      <div className="seg2" style={{ marginLeft: 'auto' }} role="tablist">
        {([['drive', '조종', ''], ['check', '점검', 'u4_4_check'], ['settings', '로봇 설정', 'u4_5_settings']] as const).map(([k, t, go]) =>
          <span key={k} {...(go ? { 'data-go': go } : {})} className={tab === k ? 'on' : ''} data-seg={t} role="tab" aria-selected={tab === k} tabIndex={0} onClick={() => setTab(k)}>{t}</span>)}
      </div></div>
    <div className="stage3d"><Stage r={r} q={pose?.q ?? null} drive={drive} hot={hot} />
      <span className="g dk tag hint"><svg className="ic" viewBox="0 0 24 24" style={{ width: '14px', height: '14px' }}><path d="M16.466 7.5C15.643 4.237 13.952 2 12 2 9.239 2 7 6.477 7 12s2.239 10 5 10c.342 0 .677-.069 1-.2" /><path d="m15.194 13.707 3.814 1.86-1.86 3.814" /><path d="M19 15.57c-1.804.885-4.274 1.43-7 1.43-5.523 0-10-2.239-10-5s4.477-5 10-5c4.838 0 8.873 1.718 9.8 4" /></svg>끌어서 돌려 보기</span>
      <div className="foot"><span className="g dk tag" style={{ position: 'static', color: '#00c389', minWidth: '178px', justifyContent: 'center' }} data-u4-walk>{walk}</span>
        <span className="g dk tag" style={{ position: 'static', color: '#ffffff' }} data-u4-loc>{located ? '위치 추정 켜짐' : `위치 추정 ${NA}`}</span>
        <span className="mu2" style={{ marginLeft: 'auto', fontSize: '12.5px' }}>실제 관절값으로 제자리에서 움직임 · 바닥 점이 뒤로 흐르면 앞으로 걷는 중</span></div></div>
    <div className="right"><div className="views" aria-label="로봇 보기">
      {view === 'map' ? <MapView c={c} r={r} /> : <div className="mapv" data-u4-big={view}>{view === 'lidar' ? <Lidar id={r.id} /> : <Feed id={r.id} ch={view} big />}</div>}
      <div className="g dk vsel">{VIEWS.map(([k, t]) => <span key={k} className={view === k ? 'on' : undefined} data-view={k} role="button" tabIndex={0} aria-pressed={view === k} onClick={() => setView(k)}>{t}</span>)}</div>
      <div className="small" data-swap="1" data-cam-inset role="button" tabIndex={0} onClick={() => setView(view === 'map' ? 'rgb' : 'map')}>{small}<span className="cl">{view === 'map' ? '앞 카메라' : '지도'}</span></div>
      <div className="g dk job" data-u4-job><b>{r.mission ?? NA}</b><span>{NA}</span><i><em style={{ width: '0%' }} /></i></div>
      <MapName c={c} r={r} />
      <div data-go="u4_9_stopped" className="vstop stop" role="button" tabIndex={0} aria-label="비상 정지 — 이 로봇" data-sd-stop="u4" {...d.stopPress}>
        <svg className="ic" viewBox="0 0 24 24" style={{ width: '26px', height: '26px' }}><path d="M8 3h8l5 5v8l-5 5H8l-5-5V8z" /><rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" stroke="none" /></svg>정지<small>Space</small></div>
    </div>
      <div className="ctl">
        <div className={`g dk btn${mine ? ' drv' : ''}`} role="button" tabIndex={0} data-u4-drive={mine ? 'mine' : 'take'}
          onClick={() => { if (mine) { d.zero(); rt.release(r.id); } else if (!d.off) { if (l.holder?.type === 'USER') rt.request(r.id); else rt.take(r.id); } else say('로봇 연결이 끊겼습니다 · 다시 연결되면 누르세요'); }}>
          <svg className="ic" viewBox="0 0 24 24" style={{ width: '18px', height: '18px' }}><line x1="6" x2="10" y1="11" y2="11" /><line x1="8" x2="8" y1="9" y2="13" /><line x1="15" x2="15.01" y1="12" y2="12" /><line x1="18" x2="18.01" y1="10" y2="10" /><path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z" /></svg>{mine ? '조종 중' : '조종 시작'}</div>
        <div data-go="u4_3_voice" className="g dk btn talk" role="button" tabIndex={0} onClick={() => say('말하기는 아직 서버에 없습니다')}>
          <svg className="ic" viewBox="0 0 24 24" style={{ width: '18px', height: '18px' }}><path d="M12 19v3" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><rect x="9" y="2" width="6" height="13" rx="3" /></svg>말하기</div>
        <div className="g dk keys" data-u4-keys><span><kbd>↑</kbd>앞으로</span><span><kbd>←</kbd><kbd>→</kbd>돌기</span><span className="mu2"><kbd>↓</kbd>뒤로는 막힘</span><span><kbd>Space</kbd>정지</span><span><kbd>Shift</kbd><kbd>1</kbd>~<kbd>4</kbd>모드</span></div>
      </div>
      <div className="deck joybig" data-u4-deck data-ready={ready || undefined}>
        <Stick side="L" put={d.stick} blocked={say} /><Stick side="R" put={d.stick} blocked={say} />
        <div className="act">{ACTS.map(([name, t, em, ic]) => {
          const off = offAct(name);
          return <div key={name} className={off ? 'no' : undefined} {...(off && name === 'StandUp' ? { 'data-why': STANDUP_WHY } : {})} role="button" tabIndex={0} data-u4-act={name} onClick={() => act(name)}>
            <span><svg className="ic" viewBox="0 0 24 24" style={IC24}>{ic}</svg></span>{t}<em>{name === 'StandUp' && !lowlevel ? 'L2+A' : name === 'StandUp' ? em : off && !lowlevel ? '순정 확인 전' : em}</em></div>;
        })}</div>
        <div className={`why${msg ? ' on' : ''}`} role="status" data-u4-why>{msg}</div>
      </div>
    </div>
    {tab !== 'drive' && <span hidden data-u4-tab={tab} />}
  </>;
}

/** 로봇 0대: 시안 틀(목록 제목 · 추가 단추 · 머리 칩 · 칸)은 그대로, 값만 「—」 */
function Empty({ add }: { add: () => void }) {
  return <>
    <div className="pane rail"><div className="row" style={{ justifyContent: 'space-between', padding: '0 6px 12px' }}><span className="ttl">로봇</span>
      <span data-go="u4_6_add" className="btns addbtn" style={{ height: '34px', padding: '0 11px', fontSize: '12.5px' }} role="button" tabIndex={0} onClick={add} data-u4-add>
        <svg className="ic" viewBox="0 0 24 24" style={{ width: '14px', height: '14px' }}><path d="M5 12h14" /><path d="M12 5v14" /></svg>로봇 추가</span></div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }} /></div>
    <div className="hdr" data-robot-head=""><span className="ttl" style={{ fontSize: '26px', marginRight: '6px' }}>{NA}</span>
      {['연결', '모드', '배터리', '최고 관절 온도', '조종자'].map((k) => <span key={k} className="g dk st">{NA}<small>{k}</small></span>)}</div>
    <div className="stage3d" />
    <div className="right"><div className="views" aria-label="로봇 보기" /></div>
  </>;
}

const light = () => typeof document !== 'undefined' && document.documentElement.dataset.theme === 'light';

/** 로봇 탭 PC 화면(App 의 로봇 탭 본문). c 가 null 이면 로봇 0대 */
export function RobotTab({ c, user, refresh, cancel }: { c: Ctx | null; user: Ctx['user']; refresh: () => void; cancel?: AbortSignal }) {
  const [adding, setAdding] = useState(false), [note, setNote] = useState('');
  const add = () => { if (user.role === 'ORG_ADMIN') { setNote('로봇 추가는 운영 관리자가 자기 계정에서 합니다.'); return; } setAdding(true); };
  return <div className={`pv u4${light() ? ' light' : ''}`} data-u4 aria-label="로봇">
    {c ? <><Rail c={c} sel={c.robot.id} add={add} /><Robot1 key={c.robot.id} c={c} r={c.robot} /></> : <Empty add={add} />}
    {note && <div className="g dk" role="status" data-u4-note style={{ left: '24px', bottom: '24px', padding: '10px 14px' }} onClick={() => setNote('')}>{note}</div>}
    {adding && <><div className="veil" onClick={() => setAdding(false)} /><div className="g modal" role="dialog" aria-label="로봇 추가">
      <AddRobot mine={(c?.robots ?? []).filter((x) => x.owner === user.id).map((x) => x.id)} close={() => setAdding(false)} refresh={refresh} cancel={cancel} /></div></>}
  </div>;
}
