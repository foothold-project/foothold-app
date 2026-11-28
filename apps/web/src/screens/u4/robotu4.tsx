// 로봇 탭(PC) = 시안 proto/screens/u4_1_robot.html 의 body 를 그대로 옮긴 것(scripts/proto2jsx.py 로 뽑은 뒤 고정 글 자리만 서버 값으로).
// 태그 · 클래스 · 순서 · 글 · 인라인 style 은 시안 그대로. 머리줄 .bar 는 앱 껍데기(W1)가 그리므로 뺐다.
// 값: 목록 = 서버 로봇 목록 · 머리 칩 = 실시간 state(연결 왕복 ms · 제어 모드 · 배터리 · 관절 최고 온도 · 조종하는 사람) · 3D = 실제 관절값 ·
// 보기 = 지도(승인 지도 + 로봇 위치) · 카메라 · 라이다 · 깊이. 값이 없으면 시안 틀은 그대로 두고 그 칸 글을 비우거나 「없음」(시안 u4_8 배터리 칸과 같은 말).
// 조종 · STOP 은 serverdrive.tsx useServerDrive 하나(이 파일은 자리만): 키는 ↑ 앞으로 · ↓ 뒤로 · ← → 옆걸음 · A D 돌기 · Space 정지(팀장 11-28 17:25 · Q · E 없음).
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as PEv, type ReactNode } from 'react';
import type { GaitName, MapVersion, RunSnapshot, ScreenAction } from '../../../../contracts/ts';
import { api } from '../../api';
import { rt, useLive, useRt } from '../../rt';
import { useStopPress } from '../../App';
import { ADMIN_LATER, idleSim, ownerName, robotStatus, type Robot } from '../../fake';
import { fleetKind, fleetOrder, type Urgent } from '../../fleetorder';
import { facts, hotJoint as hotOf, tempLevel, useAvail } from '../../proto/u5';
import { isLost, needs } from '../control';
import type { ApiFail } from '../../api';
import { NO_SIGNAL, driveFeedHeld, driveFeedText, useDriveFeed } from '../../drivemedia';
import { DriveView, canDrive, keepDrive, useServerDrive, type Tok } from '../../serverdrive';
import { GAITS, NO_GAIT } from '../../gait';
import { field } from '../../simdrive';
import { LidarMap } from '../../lidarmap';
import { REPORT_STALE_MS, go2Pose, go2Temps, JOINTS, jointName } from '../../go2model';
import { actionResultText } from '../actiontrial';
import { ACTS, STANDUP_WHY, actOff, actWhy, stickTok, useRestartAsk } from '../../robotact';
import { floorsOf, isVersion, shape, toPixel, useTree } from '../maps';
import type { Ctx } from '../../screens';
import { AssignOwner, TransferOwner } from '../../pairing';
import { PairFlow } from '../u2/pairflow';
import { checks, hotJoint } from '../readycheck';
import { robotFail } from '../settings';
import { Guide, RealView, prepSteps } from '../fleet';
import { Empty as EmptyCard } from '../../empty';
import { legMode, mount, type Go2Api, type PadKind } from './go2view';
import { WALK_MIN_SPEED } from '../../proto/u5';
import { Detail } from './detail';
import { DriveLine, useRobotLine } from '../../proto/u11';
import { stageRect, sx, sy } from '../../stage';
import { SITE_TOP } from '../../proto/site';
import { FACTORY_H, FACTORY_W, attach, factoryFrame, factoryPx, site, siteKey } from './simcam';
import { nextIdx, remaining, ro, runOf, useRoute, type Route, type Run } from './route';
import { STATUS as RUN_STATUS } from '../missionrun';
import '../../proto/ui.pv.css';
import '../../proto/pc.pv.css';
import '../../proto/light.pv.css';
import './u4.css';

/** 값 없음 표시(시안 u4_8 배터리 칸 「없음」) · em dash 는 쓰지 않는다 */
const NONE = '없음';
const DOG = <svg className="ic" viewBox="0 0 24 24" style={{ width: '19px', height: '19px' }}><path d="M4 13h11l3-3h2v4l-2 1H5z" /><path d="M6 15l-1 4M10 15v4M14 15v4M17 15l1 4" /></svg>;
const CUBE = <svg className="ic" viewBox="0 0 24 24" style={{ width: '19px', height: '19px' }}><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" /><path d="m3.3 7 8.7 5 8.7-5" /><path d="M12 22V12" /></svg>;
const IC17: CSSProperties = { width: '17px', height: '17px' }, IC24: CSSProperties = { width: '24px', height: '24px' };

/** 데모 로봇(가용 RobotAvailability.demo = true)은 시뮬이어도 실기와 같은 꼴(개 그림 · 배터리 · 연결 ms · 걷기 · 위치 알약 · 실기 모형), 차이는 「데모」 칩 하나. 시뮬 꼴은 사용자 시뮬만 */
const Demo = createContext<ReadonlySet<string>>(new Set());
const useSimLook = () => { const d = useContext(Demo); return (x: Robot) => !!x.sim && !d.has(x.id); };
/** 10 초마다 GET /robots/availability(지금 ~ 1 분 뒤)의 demo. 받지 못하면 지난 값 그대로(처음엔 빈 묶음 = 시뮬 꼴, 지어내지 않음) */
function useDemo(cancel?: AbortSignal) {
  const [got, setGot] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    let live = true;
    const load = () => { const now = new Date(); api.availability(now.toISOString(), new Date(now.getTime() + 60_000).toISOString(), cancel)
      .then((a) => { if (live) setGot(new Set(a.items.filter((x) => x.demo).map((x) => x.robot_id))); }, () => {}); };
    load(); const h = setInterval(load, 10_000);
    return () => { live = false; clearInterval(h); };
  }, []);
  return got;
}
const DEMO = <span className="tag" style={{ position: 'static', display: 'inline-flex', verticalAlign: 'middle', marginLeft: '10px', fontSize: '12px', color: '#9aa4ae' }} data-demo>데모</span>;
/** 남은 시간 = 서버 battery.minutes_left(정수 0 ~ 1440 · 실기는 null). 계약 타입이 base 에 오기 전이라 선택 칸으로 읽음. 없으면 null(지어내지 않음) */
export const minutesLeft = (b: unknown) => { const m = (b as { minutes_left?: unknown } | null | undefined)?.minutes_left; return typeof m === 'number' && Number.isInteger(m) && m >= 0 && m <= 1440 ? m : null; };


/** 목록 한 줄의 작은 글: 실제/데모/시뮬 · 지금 하는 일 · 조종하는 사람 */
/** 시안 u11_2 ~ u11_4 조종 단추 글: 내 조종권 = 「조종 중」(리모컨 우선이어도 조종권은 내 것) · 내가 보낸 요청을 기다림 = 「요청 보냄」 ·
 *  다른 사람이 조종권을 가짐(넘겨준 뒤 보기 전용 포함) = 「조종권 요청」 · 그 밖 = 「조종 시작」 */
export const driveLabel = (o: { mine: boolean; asking: boolean; otherHolds: boolean }) => (o.mine ? '조종 중' : o.asking ? '요청 보냄' : o.otherHolds ? '조종권 요청' : '조종 시작');
/** 시안 u11_2 ~ u11_4 머리줄 칩: 로봇 탭에서 보는 로봇이 리모컨 우선(내 조종) = 「K-01 리모컨 우선」 · 넘겨준 뒤 = 「K-01 보기 전용」 ·
 *  내 요청을 기다리는 동안 = 「(지금 조종자) 조종 중」. 그 밖 = 내 조종권 로봇들(「K-01 조종 중」 · 「K-01 외 n 대 조종 중」) · 없으면 칩 없음 */
export function barChipText(o: { at: 'link' | 'remote' | 'ask' | 'handed' | null; name: string; holder: string | null; driving: string[] }) {
  if (o.at === 'remote') return `${o.name} 리모컨 우선`;
  if (o.at === 'handed') return `${o.name} 보기 전용`;
  if (o.at === 'ask' && o.holder) return `${o.holder} 조종 중`;
  return !o.driving.length ? null : o.driving.length > 1 ? `${o.driving[0]} 외 ${o.driving.length - 1} 대 조종 중` : `${o.driving[0]} 조종 중`;
}
/** 머리줄 칩(App PcBar 자리): 로봇 탭에서 보는 로봇(robot)의 u11 한 줄 상태 + 내 조종권 로봇들 */
export function BarChip({ robot, me, driving }: { robot: Robot | null; me: string; driving: string[] }) {
  const f = useRobotLine(robot?.id ?? '', me), l = useLive(robot?.id ?? ''), h = l.holder ?? robot?.holder ?? null;
  const t = barChipText({ at: robot ? f?.at ?? null : null, name: robot?.name ?? '', holder: h?.type === 'USER' && h.id !== me ? h.name || null : null, driving });
  return t ? <span className="livechip" role="status" data-driving={driving.join(' ')} data-bar-chip={robot ? f?.at ?? '' : ''}><i></i>{t}</span> : null;
}

const INFO = <svg className="ic" viewBox="0 0 24 24" style={{ width: '15px', height: '15px' }}><circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" /></svg>;
/** 시안 u4_2 경고 말풍선 첫 줄 「(관절)이/가 온도가 높습니다 · 62 °C」 · 조사는 끝 글자 받침대로(시안 「고관절가」 는 틀린 조사라 고침) */
export const hotBub = (joint: string, c: number) => { const k = joint.charCodeAt(joint.length - 1) - 0xac00; return `${joint}${k >= 0 && k <= 11171 && k % 28 ? '이' : '가'} 온도가 높습니다 · ${Math.round(c)} °C`; };
export function railLine(x: Robot, me: string, demo = false) {
  const live = rt.get(x.id), h = live.holder ?? x.holder ?? null, s = live.state;
  const kind = demo ? '데모' : x.sim ? '시뮬' : '실제';
  if (!x.online && (!x.sim || demo) && x.unknown !== 'summary') return `${kind} · 연결 끊김`;   // summary = 구독 안 하는 남의 로봇(목록 요약 값으로 적음)
  const who = h?.type === 'USER' ? (h.id === me ? '나' : h.name || '') : '';
  const doing = h?.type === 'USER' ? '조종 중' : x.status === 'RUNNING' ? (x.mission ? `${x.mission} 중` : '임무 중')
    : x.status === 'STOP_LATCHED' ? '정지 잠금' : x.status === 'ERROR' ? '오류' : '대기';
  return [kind, doing, who].filter(Boolean).join(' · ');
}
const bat = (x: Robot) => { const v = rt.get(x.id).state?.battery?.soc ?? x.battery; return v == null ? NONE : `${Math.round(v)} %`; };

/** 로봇 목록 줄 순서(팀장 11-28 17:33 · 관제 타일과 같은 공용 fleetOrder): 긴급(관절 온도 단계, 아니면 연결 중 로봇의 경고 · 오류 · 정지 잠금) → 실기 → 데모 → 사용자 시뮬 → 받은 순서.
 *  긴급 판정은 관제 타일(proto/u5 facts)과 같다. 끊김은 이 목록도 칠하지 않아 올리지 않음 */
export const railUrgent = (x: Robot): Urgent => tempLevel(hotOf(x)?.t ?? null) ?? (isLost(x) || !needs(x) ? null : robotStatus(x).tone === 'bad' ? 'bad' : 'warn');
export const railOrder = (l: readonly Robot[], demo: ReadonlySet<string>) => fleetOrder(l, railUrgent, (x) => fleetKind(x.sim, demo.has(x.id)));
function Rail({ c, sel, add }: { c: Ctx; sel: string; add: () => void }) {
  useRt();
  const look = useSimLook(), demo = useContext(Demo);
  return <div className="pane rail"><div className="row" style={{ justifyContent: 'space-between', padding: '0 6px 12px' }}><span className="ttl">로봇</span>
    <span data-go="u4_6_add" className="btns addbtn" style={{ height: '34px', padding: '0 11px', fontSize: '12.5px' }} role="button" tabIndex={0} onClick={add} data-u4-add>
      <svg className="ic" viewBox="0 0 24 24" style={{ width: '14px', height: '14px' }}><path d="M5 12h14" /><path d="M12 5v14" /></svg>로봇 추가</span></div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
      {railOrder(c.robots, demo).map((x) => <div key={x.id} className={`rcard ${x.id === sel ? 'on' : ''}${look(x) ? ' rehearse' : ''}`} data-r={x.name} data-robot-row={x.id} role="button" tabIndex={0}
        aria-current={x.id === sel || undefined} onClick={() => c.pick(x.id)}>
        <span className="av">{look(x) ? CUBE : DOG}</span>
        <div style={{ flex: '1' }}>{x.name}<small>{railLine(x, c.user.id, demo.has(x.id))}</small></div>
        <span className="mu2" style={{ fontSize: '13px', whiteSpace: 'nowrap' }}>{look(x) ? '시뮬' : bat(x)}</span></div>)}
    </div></div>;
}

/** 이 로봇의 서버 위치와 그 지도판(받는 중 · 없음 = null). 지도 칸 · 지도 이름 · 시뮬 시점이 같은 값을 쓴다 */
function useBoard(c: Ctx, r: Robot) {
  const loc = rt.get(r.id).state?.location ?? r.location ?? null, vid = loc?.map_version_id ?? null;
  const [v, setV] = useState<MapVersion | null>(null);
  useEffect(() => {
    setV(null); if (!vid) return;
    let alive = true;
    api.version(vid, c.cancel).then(shape(isVersion)).then((x) => { if (alive) setV(x); }, () => {});
    return () => { alive = false; };
  }, [vid]);
  return { loc, v: v && v.id === vid ? v : null };
}
type Board = ReturnType<typeof useBoard>;
const xy = (l: Board['loc']) => (l && l.x != null && l.y != null ? { x: l.x, y: l.y } : null);

/** 지도 칸: 로봇이 있는 승인 지도 + 내 위치(가운데) + 임무 경로(끝낸 길 초록 · 남은 길 점선 · 지점 번호) + 같은 판의 다른 로봇. 시안처럼 3200 px 폭 그림 위에 그린다.
 *  그림 = 서버 판 그림(…/image). 그 그림을 못 받으면 판이 시안 공장 터와 같은 좌표계일 때만 시안 공장 지도, 아니면 그림 없이 점 · 경로만 */
/** 서버 판 그림 어두운 판 색: 회색으로 뺀 밝기 0 (벽) → #464e56 · 1 (빈 곳) → --paper #12161d · 미확인 회색은 그 사이 */
export const PLAN_DARK = <><feColorMatrix type="saturate" values="0" /><feComponentTransfer><feFuncR type="table" tableValues="0.2745 0.0706" /><feFuncG type="table" tableValues="0.3059 0.0863" /><feFuncB type="table" tableValues="0.3373 0.1137" /></feComponentTransfer></>;
function MapView({ c, r, b, run, route, onFactory }: { c: Ctx; r: Robot; b: Board; run: Run | null; route: Route | null; onFactory: boolean }) {
  useRt();
  const { loc, v } = b, view = useRef<HTMLDivElement>(null), [box, setBox] = useState({ w: 816, h: 600 });
  const [miss, setMiss] = useState<string | null>(null);
  useEffect(() => { setMiss(null); }, [v?.id]);
  useEffect(() => { const el = view.current; if (el?.clientWidth) setBox({ w: el.clientWidth, h: el.clientHeight }); }, []);
  // 데모 현장(/sites demo) 판 = 시안처럼 공장 그림(어두운 판) 위에 시안 변환으로. 그 밖은 서버 판 그림 · 판 좌표 그대로
  const k = v ? 3200 / v.width : 1, W = onFactory ? FACTORY_W : 3200, H = onFactory ? FACTORY_H : v ? Math.round(v.height * k) : 2000;
  const at = (x: number, y: number) => { if (onFactory) return factoryPx(x, y); const [px, py] = toPixel(v!, x, y); return [px * k, py * k] as const; };
  const here = xy(loc), me = v && here ? at(here.x, here.y) : null;
  const others = v ? c.robots.filter((x) => x.id !== r.id).flatMap((x) => {
    const l = rt.get(x.id).state?.location ?? x.location;
    return l && l.map_version_id === v.id && l.x != null && l.y != null ? [{ x, p: at(l.x, l.y) }] : [];
  }) : [];
  const shift = me ? `translate(${(box.w / 2 - me[0]).toFixed(1)}px,${(box.h * 0.55 - me[1]).toFixed(1)}px)` : 'translate(0px,0px)';
  const yaw = loc?.yaw ?? null;
  const wps = route && 'wps' in route && v ? route.wps.map((w, i) => ({ w, i })).filter(({ w }) => w.map_version_id === v.id) : [];
  const nx = run && route && 'wps' in route ? nextIdx(run.progress, route.wps.length) : null;
  const pts = (l: (readonly [number, number])[]) => l.map((p) => `${p[0].toFixed(0)},${p[1].toFixed(0)}`).join(' ');
  const done = nx != null && me ? [...wps.filter(({ i }) => i < nx).map(({ w }) => at(w.x, w.y)), me] : [];
  const left = nx != null && me ? [me, ...wps.filter(({ i }) => i >= nx).map(({ w }) => at(w.x, w.y))] : wps.map(({ w }) => at(w.x, w.y));
  const fac = SITE_TOP[light() ? 'light' : 'dark'];   // 공장 질감판 위에서 본 그림(관제 작은 지도와 같은 파일 · 같은 자리)
  const src = !v ? null : onFactory ? (miss ? null : fac) : miss === 'server' ? (factoryFrame(v) ? fac : null) : api.imageUrl(v.id);
  // 어두운 판에서 서버 판 그림(흰 바탕 · 검은 벽)을 그대로 깔면 흰 판이 된다 → 밝기를 어두운 바탕 --paper(#12161d) ~ 벽(관제 공장 그림 어두운 판의 건물 회색 #464e56)으로 옮겨 칠함. 공장 그림은 그대로
  const dark = !light() && !!src && src !== fac;
  return <div className="mapv" ref={view} data-u4-map={v?.id ?? ''}><div className="mapin" style={{ transform: shift }}>
    {dark && <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden><filter id="u4-plan-d" colorInterpolationFilters="sRGB">{PLAN_DARK}</filter></svg>}
    {src && <img src={src} alt="" style={{ width: `${W}px`, height: `${H}px`, filter: dark ? 'url(#u4-plan-d)' : undefined }} data-u4-mapimg={onFactory || miss ? 'factory' : 'server'} data-u4-plan={dark ? 'dark' : undefined}
      onError={() => setMiss((m) => (m ? 'none' : 'server'))} />}
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ position: 'absolute', left: '0', top: '0' }}>
      {left.length > 1 && <polyline points={pts(left)} fill="none" stroke="rgba(255,255,255,.75)" strokeWidth="4" strokeDasharray="2 12" strokeLinecap="round" data-u4-route="left" />}
      {done.length > 1 && <polyline id="done" points={pts(done)} fill="none" stroke="#00c389" strokeWidth="6" strokeLinejoin="round" strokeLinecap="round" data-u4-route="done" />}
      {wps.map(({ w, i }) => { const p = at(w.x, w.y), ok = nx != null && i < nx; return <g key={i} transform={`translate(${p[0].toFixed(0)},${p[1].toFixed(0)})`} data-u4-wp={i + 1} data-done={ok || undefined}>
        <circle r="15" fill="#0b0e12" stroke={ok ? '#00c389' : 'rgba(255,255,255,.55)'} strokeWidth="2.5" />
        <text y="5" textAnchor="middle" fontSize="14" fontWeight="800" fill={ok ? '#00c389' : '#fff'}>{i + 1}</text></g>; })}
      {others.map(({ x, p }) => <g key={x.id} data-u4-other transform={`translate(${p[0].toFixed(0)},${p[1].toFixed(0)})`}>
        <circle r="9" fill={x.online ? '#9aa4ae' : '#5e6662'} stroke="#0b0e12" strokeWidth="3" />
        <text x="16" y="5" fontSize="15" fontWeight="700" fill="#cfd6dc">{`${x.name} · ${railLine(x, c.user.id).split(' · ')[1] ?? ''}`}</text></g>)}
      {me && <g id="me" transform={`translate(${me[0].toFixed(1)},${me[1].toFixed(1)}) rotate(${yaw == null ? 0 : (-yaw * 180 / Math.PI).toFixed(1)})`}>
        <circle r="46" fill="rgba(0,195,137,.10)" />
        {yaw != null && <path id="cone" d="M0 0 L60 -26 A66 66 0 0 1 60 26 Z" fill="rgba(0,195,137,.30)" />}
        <circle r="13" fill="#fff" stroke="#00c389" strokeWidth="5" /></g>}
    </svg></div></div>;
}
/** 지도 이름(시안 「큰 공장 1 층 · 지도 2026-11-25」): 건물 층 · 지도 판 만든 날 */
/** 그리고 이 판이 데모 현장(/sites 의 demo === true) 층의 승인 판인가(관제 작은 지도와 같은 기준 · 크기로 판별하지 않음) */
function usePlace(c: Ctx, b: Board) {
  const t = useTree(c.cancel), p = floorsOf(t.tree).find((x) => x.floor.id === b.loc?.floor_id);
  const demo = !!b.v && (t.tree?.items ?? []).some((s) => (s as { demo?: boolean }).demo === true && s.buildings.some((d) => d.floors.some((f) => f.approved_version_id === b.v!.id)));
  return [p ? `${p.building.name} ${p.floor.name}` : '', demo] as const;
}
function MapName({ place, b }: { place: string; b: Board }) {
  const day = b.v?.created_at.slice(0, 10), text = [place, day ? `지도 ${day}` : ''].filter(Boolean).join(' · ');
  return <span className="g dk mapname" data-u4-mapname>{text || '지도 없음'}</span>;
}
/** 임무 칸(시안 「공정 순찰 A」 · 「할 일 2 / 4 · 게이지 읽기로 가는 중 · 남은 약 330 m」 · 막대). 남은 거리는 지점까지 곧은 줄을 더한 값이라 「직선」 */
export function jobLine(run: Run | null, route: Route | null, b: Board) {
  if (!run) return { name: '임무 없음', line: '', pct: 0 };
  const { done, total } = run.progress, wps = route && 'wps' in route ? route.wps : null, nx = wps ? nextIdx(run.progress, wps.length) : null;
  const to = wps && nx != null ? wps[nx] : null, nm = to ? to.name || `${nx! + 1} 번 지점` : '';
  const go = to && run.status === 'MOVING' ? `${nm}${ro(nm)} 가는 중` : RUN_STATUS[run.status as RunSnapshot['status']] ?? '';
  const here = xy(b.loc), rest = wps && nx != null && here && b.v && b.loc?.map_version_id === b.v.id ? remaining(here, wps, nx, b.v.id) : null;
  const left = rest ? `남은 직선 약 ${Math.round(rest.m)} m${rest.more ? ' · 다른 층 지점 더' : ''}` : '';
  return { name: run.name, line: [`할 일 ${Math.min(done + 1, total)} / ${total}`, go, left].filter(Boolean).join(' · '), pct: total ? Math.round((done / total) * 100) : 0 };
}

/** 카메라 · 깊이 · 라이다 받기. 세 채널 다 이 로봇 화면에 붙여 두고 보이는 칸만 켠다(on). 숨겼다 다시 열어도 epoch 기록이 이어진다(RV-450 ② · RV-452).
 *  can = 서버가 이 화면의 조종을 허용한 로봇만 받는다(허용 안 된 로봇은 보기만 · 카메라 · 라이다 연결도 없음 · 옛 세 칸 화면과 같음) */
function useFeeds(id: string, view: string, can: boolean) {
  return { rgb: useDriveFeed(id, 'rgb', can && (view === 'map' || view === 'rgb')), depth: useDriveFeed(id, 'depth', can && view === 'depth'), lidar: useDriveFeed(id, 'lidar', can && view === 'lidar') };
}
type Feeds = ReturnType<typeof useFeeds>;
/** 보기만 하는 로봇의 빈 칸 까닭(영상 연결을 열지 않음) */
export const VIEW_ONLY = '보기만 하는 로봇이라 영상을 받지 않습니다';
/** 조종권 없이 걷기 모드 칸을 누름: 창을 열지 않고 까닭 한 줄(검토 21:25 · noGait 과 같은 꼴) */
export const MODE_NEED_DRIVE = '조종을 시작해야 걷기 모드를 바꿀 수 있습니다.';
const NoFeed = ({ ch, why }: { ch: 'rgb' | 'depth'; why: string }) => <div className="dv-video" role="img" aria-label={ch === 'rgb' ? '카메라' : '뎁스 카메라'} {...(ch === 'rgb' ? { 'data-sd-cam': '' } : { 'data-sd-depth': '' })}>
  <span style={{ padding: 12, textAlign: 'center' }}>{`${NO_SIGNAL[ch]} · ${why}`}</span></div>;
const Feed = ({ fs, ch, big, can }: { fs: Feeds; ch: 'depth'; big: boolean; can: boolean }) => (can ? <DriveView f={fs[ch]} ch={ch} big={big} /> : <NoFeed ch={ch} why={VIEW_ONLY} />);
const Lidar = ({ fs, can }: { fs: Feeds; can: boolean }) => <LidarMap feed={fs.lidar} empty={can ? driveFeedText(fs.lidar, 'lidar') : `${NO_SIGNAL.lidar} · ${VIEW_ONLY}`} bare />;

/** 시뮬 시점 칸: 렌더러 하나(simcam)에 붙여 서버 위치에서 본 현장을 그린다. 못 그리면 「카메라 신호 없음 · 까닭」 */
function SimCam({ v, pose }: { v: MapVersion; pose: { x: number; y: number; yaw: number } }) {
  const cv = useRef<HTMLCanvasElement>(null), h = useRef<ReturnType<typeof attach>>(null);
  const [s, setS] = useState<Awaited<ReturnType<typeof site>>>(null), [why, setWhy] = useState(''), key = siteKey(v);
  useEffect(() => { const a = cv.current ? attach(cv.current) : null; h.current = a; if (!a) setWhy('이 브라우저는 3D 를 그리지 못합니다'); return () => a?.drop(); }, []);
  useEffect(() => {
    let alive = true; setS(null);
    if (!h.current) return;   // WebGL 없음: 받지도 않음
    site(v)?.then((x) => { if (alive) setS(x); }, () => { if (alive) setWhy('현장 3D 를 받지 못했습니다'); });
    return () => { alive = false; };
  }, [key]);
  useEffect(() => { h.current?.set(s, pose); });
  return <>{why ? <NoFeed ch="rgb" why={why} /> : <canvas ref={cv} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} data-u4-simcam={key ?? ''} aria-label="시뮬 시점" />}
    <span className="g dk tag rehearse simtag" data-u4-simtag>시뮬 시점</span></>;
}
/** 카메라 칸: 받은 영상(지금 · 마지막 그림)이 먼저. 영상이 없으면 서버 위치 · 지도판 3D 로 시뮬 시점, 그것도 없으면 신호 없음 + 까닭 */
function Cam({ fs, big, can, b }: { fs: Feeds; big: boolean; can: boolean; b: Board }) {
  const f = fs.rgb, l = b.loc;
  if (can && (!driveFeedText(f, 'rgb') || driveFeedHeld(f))) return <DriveView f={f} ch="rgb" big={big} />;
  const why = !l || l.x == null || l.y == null ? '서버 위치 없음' : l.yaw == null ? '서버 방향 값 없음' : !b.v ? (l.map_version_id ? '지도판 받는 중' : '지도판 없음')
    : !siteKey(b.v) ? '이 지도판에 3D 현장이 없습니다' : '';
  if (!why) return <SimCam v={b.v!} pose={{ x: l!.x!, y: l!.y!, yaw: l!.yaw! }} />;
  return can ? <DriveView f={f} ch="rgb" big={big} /> : <NoFeed ch="rgb" why={VIEW_ONLY} />;
}

/** 가운데 3D(팀장 23:48): 로봇 정보를 보는 자리 · 늘 정면(현장 장면 없음 · 운행은 오른쪽 칸). 실제 관절값 · 자세 · 서버 applied 로 움직이고,
 *  충전 · 점검이면 시안 u5_1 바닥 표시(padMesh), 시뮬은 파란 로봇 · 파란 점(관제 타일과 같은 cyber 꼴) */
function Stage({ r, q, down, walk, pad, drive, hot, temps }: { r: Robot; q: number[] | null; down: boolean; walk: boolean; pad: PadKind | null; drive: Go2Api['drive']; hot: Record<string, string>;
  /** 점검 탭: 관절 온도(JOINTS 순서) · 주면 마우스를 올린 관절의 이름 · 온도를 띄움(시안 u4_4) */ temps?: (number | null)[] | null }) {
  const cv = useRef<HTMLCanvasElement>(null), g = useRef<Go2Api | null>(null), sim = useSimLook()(r), [tip, setTip] = useState<{ j: string; x: number; y: number } | null>(null);
  useEffect(() => {
    if (typeof WebGLRenderingContext === 'undefined' || !cv.current) return;
    const a = mount(cv.current, { pin: true, orbit: true, glow: true, cyber: sim }); g.current = a;
    if (a.fallback) cv.current.style.visibility = 'hidden';   // WebGL 을 못 만든 캔버스는 숨겨 시안 어두운 바탕 그대로
    return () => { a.dispose(); g.current = null; };
  }, [r.id, sim]);
  useEffect(() => { if (g.current) { g.current.q = q; g.current.down = down; g.current.walk = walk; g.current.pad = pad; g.current.drive = drive; } });
  const key = JSON.stringify(hot);
  useEffect(() => { g.current?.setHot(hot); }, [key]);
  // 로봇 · 꼴(데모가 늦게 와 시뮬 → 실기 꼴)이 바뀌면 새 캔버스: 지난 렌더러가 forceContextLoss 한 캔버스에 다시 붙이면 맥락을 잃어 흰 판이 된다
  const move = (e: { clientX: number; clientY: number }) => {
    const el = cv.current; if (!temps || !el || !g.current) return setTip(null);
    const b = el.getBoundingClientRect(), k = el.clientWidth ? b.width / el.clientWidth : 1, x = (e.clientX - b.left) / k, y = (e.clientY - b.top) / k;   // 무대 배율(scale) 을 걷어 낸 캔버스 px
    const j = g.current.pick(x, y); setTip(j ? { j, x, y } : null);
  };
  const tv = tip && temps ? temps[JOINTS.indexOf(`${tip.j}_joint`)] : null;
  return <><canvas key={`${r.id}:${sim}`} id="go2" ref={cv} data-robot-3d={r.id} onPointerMove={temps ? move : undefined} onPointerLeave={() => setTip(null)} />
    {tip && <span className="g dk tag" style={{ left: `${tip.x + 14}px`, top: `${tip.y - 16}px`, pointerEvents: 'none', color: tv == null ? undefined : tv >= 60 ? '#ff4d4f' : tv >= 50 ? '#f2b705' : '#00c389' }} data-u4-jtip={tip.j}>{jointTip(tip.j, tv)}</span>}</>;
}
/** 시안 u4_4 마우스 온도 꼬리표: 「앞 오른 종아리 48 °C」 · 값이 없으면 「온도 보고 없음」(지어내지 않음) */
export const jointTip = (j: string, c: number | null | undefined) => `${jointName(`${j}_joint`)} ${c == null ? '온도 보고 없음' : `${Math.round(c)} °C`}`;

/** 손잡이 하나(시안 .stick): 왼쪽 = 앞(세로만 · 뒤로는 막음) · 오른쪽 = 돌기(가로만). 처음 잡은 손가락 하나만 */
function Stick({ side, put }: { side: 'L' | 'R'; put: (p: number, el: HTMLElement, t: Tok[]) => void }) {
  const own = useRef<number | null>(null), [xy, setXy] = useState([0, 0]);
  const move = (e: PEv<HTMLDivElement>) => {
    // 화면 맞춤(PC 틀이 1920x1080 무대를 창에 맞춰 scale)에서도 맞게: 포인터 · 판 상자 모두 무대 px(stage.ts) = 손잡이 css px
    const el = e.currentTarget, b = stageRect(el), m = b.width * 0.3 || 1;
    let x = (sx(e) - b.left - b.width / 2) / m, y = (sy(e) - b.top - b.height / 2) / m; const n = Math.hypot(x, y); if (n > 1) { x /= n; y /= n; }
    // 손잡이 그림도 보내는 축 하나 위에(왼쪽은 큰 축, 오른쪽은 가로)
    if (side === 'L') { if (Math.abs(y) >= Math.abs(x)) setXy([0, y * m]); else setXy([x * m, 0]); }
    else setXy([x * m, 0]);
    put(e.pointerId, el, stickTok(side, x, y));
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
/** 숫자 줄 물리 키(e.code) → 메인 칸 */
const VIEW_KEY: Record<string, View> = { Digit1: 'map', Digit2: 'rgb', Digit3: 'lidar', Digit4: 'depth' };

/** 이 화면이 쓰는 조종 조각. 조종할 수 있는 로봇(keepDrive = 지금 canDrive 이면 기록도 남김)만 useServerDrive 를 붙인다(키 · 조종권은 한 화면에 하나 · 옛 세 칸 화면과 같은 규칙) */
type D = Pick<ReturnType<typeof useServerDrive>, 'l' | 's' | 'mine' | 'off' | 'why' | 'ready' | 'zero' | 'stick' | 'stopPress' | 'unlockAsk' | 'unlockState' | 'refused' | 'notes' | 'stopLine' | 'gait' | 'take' | 'takeWhy'> & Partial<Pick<ReturnType<typeof useServerDrive>, 'gaitAsk'>>;
function Driven({ c, r }: { c: Ctx; r: Robot }) { return <Body c={c} r={r} d={useServerDrive(c, r)} can />; }
function Viewed({ c, r }: { c: Ctx; r: Robot }) {
  const l = useLive(r.id), stopPress = useStopPress(() => rt.stop(r.id));
  return <Body c={c} r={r} d={{ l, s: l.state, mine: false, off: true, why: '', ready: false, zero: () => {}, stick: () => {}, stopPress, unlockAsk: () => {}, unlockState: null, refused: '', notes: <></>, stopLine: null, take: () => {}, takeWhy: '', gait: { row: false, press: () => {}, cur: l.state?.gait?.gait ?? null, avail: l.state?.gait?.available ?? null, msg: '' } }} can={false} />;
}
function Robot1({ c, r }: { c: Ctx; r: Robot }) {
  return keepDrive(c, r) ? <Driven c={c} r={r} /> : <Viewed c={c} r={r} />;
}
/** 조종 못 하는 까닭(서버 허용 · 담당 · 총괄 실기) */
const noDrive = (c: Ctx, r: Robot) => r.sim === true ? (r.owner !== c.user.id ? '내 담당 시뮬 로봇만 조종할 수 있습니다.' : '시뮬 로봇이 서버에 연결되어 있지 않습니다.')
  : r.owner !== c.user.id && c.user.role !== 'ORG_ADMIN' ? '내 담당 로봇만 조종할 수 있습니다.'
  : '서버가 이 로봇의 웹 조종을 허용하지 않았습니다.';
const CHEV = <svg className="ic" viewBox="0 0 24 24" style={{ width: '18px', height: '18px' }}><path d="m6 9 6 6 6-6" /></svg>;
const CHECK_IC = { ok: <path d="M20 6 9 17l-5-5" />, blocked: <><path d="M12 8v4" /><path d="M12 16h.01" /><circle cx="12" cy="12" r="10" /></>, none: <path d="M5 12h14" /> };
/** 시안 u4_4 순서 점검 줄 이름(readycheck checks 의 key 순서 그대로) */
/** 시안 u4_4 오른쪽 값은 짧게(「연결 · 38 ms」 꼴). 받은 값만 줄여 쓰고, 긴 까닭(readycheck why)은 마우스를 올리면(title) 보인다 */
export function checkShort(key: string, state: 'ok' | 'blocked' | 'none', why: string, r: Robot): string {
  if (state === 'none' && key !== 'power') return key === 'sensors' && why.startsWith('카메라') ? '목록 없음' : why.startsWith('로봇이 연결') ? '지금 값 없음' : '서버 값 없음';
  switch (key) {
    case 'server': return state === 'ok' ? '연결됨' : '끊김';
    case 'agent': return state === 'ok' ? '켜짐 · 상태 받는 중' : '끊김';
    case 'body': return state === 'ok' ? '넘어지지 않음' : '넘어짐 의심';
    case 'power': { if (why.startsWith('로봇이 연결')) return '지금 값 없음';
      const b = r.battery != null ? `${Math.round(r.battery)} %` : '배터리 값 없음'; return `${b} · ${hotJoint(r).replace(/ \(.*\)$/, '')}`; }
    default: return why;   // 센서 = 장치 이름 · 막힘 까닭(이미 짧음)
  }
}
const CHECK_NAME: Record<string, string> = { wifi: 'Wi-Fi', server: '서버', agent: 'foothold-robot', policy: '걷기 정책', body: '몸통', sensors: '센서', power: '배터리 · 관절' };

/** 로봇 설정 창(시안 u4_5 칸 · 순서 · 글 그대로): 이름 · 기체번호 · 담당 | 연결 끊기 · 로봇 삭제 | 지우면 … 기록은 남습니다.
 *  논리는 pairing ManageRobot 과 같다(이름 PATCH · 연결 끊기 · 지우기 확인 · 담당 넘기기). 시안에 없는 것(확인 줄 · 결과 · 담당 넘기기 목록 · 총괄 담당 지정)은 그 아래 */
function Settings({ c, r }: { c: Ctx; r: Robot }) {
  const own = r.owner === c.user.id, admin = c.user.role === 'ORG_ADMIN';
  const [name, setName] = useState(r.name), [ask, setAsk] = useState<'cut' | 'delete' | null>(null);
  const [msg, setMsg] = useState<{ text: string; ok?: boolean } | null>(null), [busy, setBusy] = useState(false), box = useRef<HTMLDivElement>(null);
  const run = async (f: () => Promise<unknown>, ok: string) => {
    if (busy) return;
    setBusy(true); setAsk(null); setMsg(null);
    try { await f(); setMsg({ text: ok, ok: true }); c.refresh(); }
    catch (e) { if ((e as ApiFail).code !== 'CANCELED') setMsg({ text: robotFail(e) }); }
    finally { setBusy(false); }
  };
  const rename = () => {
    const v = name.trim();
    if (!v) return setMsg({ text: '로봇 이름을 넣으세요.' });
    if (v === r.name) return;
    run(() => api.saveRobot(r.id, { name: v }, c.cancel), '이름을 바꿨습니다.');
  };
  const why = (t: string) => setMsg({ text: t });
  const look = useSimLook()(r);
  const not = admin && !r.sim && r.owner ? ADMIN_LATER : admin && !r.sim ? '담당 없는 실기는 아래에서 담당을 지정합니다.' : '내 담당 로봇만 설정을 바꿀 수 있습니다.';
  const press = (k: 'cut' | 'delete') => (own ? !busy && setAsk(k) : why(not));
  const owner = () => (own && !r.sim ? box.current?.querySelector<HTMLButtonElement>('[data-transfer] button[aria-expanded]')?.click() : why(own ? '시뮬 로봇은 담당을 넘기지 않습니다.' : not));
  return <div ref={box} role="group" aria-label={own ? '내 로봇 관리' : '로봇 설정'} {...(own ? { 'data-manage': '' } : {})} data-u4-settings>
    <div className="mrow">
      <span className="mu" style={{ fontWeight: 600 }}>이름</span>
      {own ? <input className="fld" style={{ fontWeight: 800, font: 'inherit', fontSize: '15px', color: 'inherit', width: '100%', boxSizing: 'border-box' }} name="name" maxLength={128} aria-label="로봇 이름"
        value={name} disabled={busy} onChange={(e) => setName(e.target.value)} onBlur={rename} onKeyDown={(e) => { if (e.key === 'Enter') rename(); }} data-u4-name />
        : <div className="fld" style={{ fontWeight: 800 }}>{r.name}</div>}
      <span className="mu" style={{ fontWeight: 600 }}>기체번호</span>
      <b className={r.serial ? undefined : 'mu2'}>{look ? '시뮬' : r.serial ?? NONE}</b>
      <span className="mu" style={{ fontWeight: 600 }}>담당</span>
      <div className="fld" role="button" tabIndex={0} onClick={owner} data-u4-owner>{own ? '나' : ownerName(r)} · 담당자 바꾸기{CHEV}</div>
    </div>
    <div style={{ marginTop: '26px', borderTop: '1px solid rgba(0,0,0,.08)', paddingTop: '20px', display: 'flex', gap: '10px' }}>
      <div className="fld" style={{ flex: '1', justifyContent: 'center', height: '50px' }} role="button" tabIndex={0} aria-disabled={!own || busy || undefined} onClick={() => press('cut')} data-u4-cut>연결 끊기</div>
      <div className="fld" style={{ flex: '1', justifyContent: 'center', height: '50px', background: 'rgba(255,77,79,.10)', color: '#e04a2f', borderColor: 'transparent' }} role="button" tabIndex={0}
        aria-disabled={!own || busy || undefined} onClick={() => press('delete')} data-u4-delete>로봇 삭제</div>
    </div>
    <p className="mu" style={{ fontSize: '12.5px', marginTop: '14px', lineHeight: '1.5' }}>지우면 다시 연결하기 전까지 이 로봇에 명령을 보낼 수 없습니다. 기록은 남습니다.</p>
    {ask && <div className="fh-row" role="group" aria-label="확인" style={{ marginTop: '12px' }}>
      <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{ask === 'cut'
        ? `${r.name} 연결을 끊을까요? 연결 키가 폐기되고 진행 중인 조종은 정지·잠금됩니다. 다시 쓰려면 «새 로봇 추가»로 다시 연결합니다.`
        : `${r.name} 로봇을 지울까요? 연결 키가 폐기되고 되돌릴 수 없습니다. 기록은 남습니다.`}</span>
      <button type="button" className="btn bad" onClick={() => (ask === 'cut'
        ? run(() => api.disconnectRobot(r.id, c.cancel), '연결을 끊었습니다. 연결 키를 폐기했습니다.')
        : run(() => api.deleteRobot(r.id, c.cancel), `${r.name} 로봇을 지웠습니다.`))}>{ask === 'cut' ? '연결 끊기' : '지우기'}</button>
      <button type="button" className="btn" onClick={() => setAsk(null)}>취소</button></div>}
    {msg && <p className={`fh-msg${msg.ok ? ' ok' : ''}`} role={msg.ok ? 'status' : 'alert'} style={{ marginTop: '10px' }}>{msg.text}</p>}
    {own && !r.sim && <TransferOwner r={r} refresh={c.refresh} cancel={c.cancel} />}
    {!own && admin && !r.sim && !r.owner && <AssignOwner r={r} refresh={c.refresh} cancel={c.cancel} />}
    {!own && admin && !r.sim && !!r.owner && <p className="mu" style={{ fontSize: '12.5px', marginTop: '10px' }} data-admin-later>{ADMIN_LATER}</p>}
  </div>;
}

/** 점검(시안 u4_4): 오른쪽 칸 = 순서 점검 일곱 줄(readycheck checks 그대로 · 보기 전용) + 다시 점검. 시안에 없는 «조종 준비» 세 단계 · 실기 보기는 같은 줄 모양으로 그 아래 */
function Check({ c, r, guide }: { c: Ctx; r: Robot; guide: () => void }) {
  useRt();
  const mineOrAdmin = r.owner === c.user.id || c.user.role === 'ORG_ADMIN';
  const { pill, steps, net } = prepSteps(c, r), list = checks(r, net), bad = list.filter((x) => x.state === 'blocked').length, unknown = list.filter((x) => x.state === 'none').length;
  const t = new Date(), at = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  const tone = { ok: 'var(--pr3)', blocked: '#ff4d4f', none: 'var(--mu2)' } as const;
  const [sub, setSub] = useState<'list' | 'detail'>('list');
  const row = (k: string, state: keyof typeof tone, name: ReactNode, small: ReactNode, attrs: Record<string, unknown> = {}) => <div className="r" key={k} {...attrs}>
    <span style={{ color: tone[state] }}><svg className="ic" viewBox="0 0 24 24" style={{ width: '20px', height: '20px' }}>{CHECK_IC[state]}</svg></span>{name}<small>{small}</small></div>;
  return <div className="pane2 chk" style={{ position: 'absolute', inset: '0', padding: '22px 8px 8px' }} aria-label="점검" data-u4-tab="check">
    <div className="row" style={{ justifyContent: 'space-between', padding: '0 18px 12px' }}><span className="ttl">순서 점검</span>
      <div className="seg2 chksub" role="tablist" aria-label="점검 보기">{([['list', '순서 점검'], ['detail', '상세']] as const).map(([k, t]) =>
        <span key={k} className={sub === k ? 'on' : ''} role="tab" tabIndex={0} aria-selected={sub === k} data-u4-sub={k} onClick={() => setSub(k)}>{t}</span>)}</div>
      <span className="mu2" style={{ fontSize: '13px', marginLeft: 'auto' }} data-u4-check-head>{mineOrAdmin ? `${at} · ${bad ? `${bad} 곳 막힘` : unknown ? `${unknown} 곳 확인 전` : '모두 통과'}` : ''}</span></div>
    {sub === 'detail' ? <Detail c={c} r={r} /> : !mineOrAdmin ? <p className="mu" style={{ padding: '0 18px' }} data-u4-check-none>내 담당 로봇만 점검할 수 있습니다 · 이 로봇은 요약만 보입니다.</p> : <>
      <div data-readycheck-list>{list.map((x) => row(x.key, x.state, CHECK_NAME[x.key] ?? x.name, checkShort(x.key, x.state, x.why, r), { 'data-check': x.key, 'data-state': x.state, title: x.why }))}</div>
      {/* 시안 밖 · 새로 그림: 조종 준비 세 단계(연결 방법 안내 단추가 있는 기능 칸) = 같은 줄 꼴 · 작은 머리로 시안 일곱 줄과 나눔 */}
      <section aria-label="조종 준비" data-u4-prep data-pill={pill.tone} data-off-proto><div className="h3 chkprep">조종 준비</div>
        {steps.map((x) => row(`s${x.n}`, x.done ? 'ok' : x.cur ? 'blocked' : 'none', <>{x.n} · {x.title}</>,
          <span id={x.id}>{x.text}{x.guide && <> · <a href="#guide" onClick={(e) => { e.preventDefault(); guide(); }} data-open-guide>연결 방법</a></>}</span>,
          { 'data-step': x.n, className: `r${x.done ? ' done' : x.cur ? ' cur' : ''}` }))}
        <span hidden data-pill-text>{pill.text}</span>
      </section>
      <RealView r={r} />
    </>}
    <div className="btns" style={{ position: 'absolute', left: '18px', bottom: '18px', height: '50px', width: '200px', fontSize: '14.5px' }} role="button" tabIndex={0} onClick={c.refresh} data-u4-recheck>다시 점검</div>
  </div>;
}
function Body({ c, r, d, can }: { c: Ctx; r: Robot; d: D; can: boolean }) {
  const { l, s, mine } = d;
  const [tab, setTab] = useState<Tab>('drive'), [guide, setGuide] = useState(false), [view, setView] = useState<View>('map'), fs = useFeeds(r.id, view, can);
  // 메인 칸 확대(팀장 11-28 17:33 · 시안 밖 · 새로 그림): 더블클릭 · Esc · 「돌아가기」. 브라우저 전체 화면이 아니라 무대 안에서 제자리 → 무대 전체로(FLIP · transform 만)
  const [zoom, setZoom] = useState(false), viewsEl = useRef<HTMLDivElement>(null), from = useRef<DOMRect | null>(null);
  const flip = (on: boolean) => { if (viewsEl.current) from.current = viewsEl.current.getBoundingClientRect(); setZoom(on); };
  useLayoutEffect(() => {
    const el = viewsEl.current, a = from.current; from.current = null;
    if (!el || !a || typeof el.animate !== 'function' || matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return;
    const b = el.getBoundingClientRect(); if (!b.width || !b.height) return;
    el.animate([{ transformOrigin: '0 0', transform: `translate(${a.left - b.left}px,${a.top - b.top}px) scale(${a.width / b.width},${a.height / b.height})` }, { transformOrigin: '0 0', transform: 'none' }],
      { duration: 280, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }, [zoom]);
  useEffect(() => { if (tab !== 'drive') setZoom(false); }, [tab]);
  useEffect(() => {
    if (!zoom) return;
    const esc = (e: KeyboardEvent) => { if ((e.key === 'Escape' || e.code === 'Escape') && !field(e.target)) flip(false); };
    addEventListener('keydown', esc); return () => removeEventListener('keydown', esc);
  }, [zoom]);
  const zoomDbl = (e: { target: EventTarget | null }) => { if ((e.target as Element | null)?.closest?.('[role="button"], button, a, input, select')) return; flip(!zoom); };
  // 1 · 2 · 3 · 4 = 메인 칸 지도 · 카메라 · 라이다 · 깊이(팀장 11-28 17:33). Shift+1~4 는 걷기 모드라 수정 키 없을 때만 · 글 입력칸이면 무시
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || e.repeat || field(e.target)) return;
      const v = VIEW_KEY[e.code]; if (v) { e.preventDefault(); setView(v); }
    };
    addEventListener('keydown', down); return () => removeEventListener('keydown', down);
  }, []);
  const [msg, setMsg] = useState(''), [pending, setPending] = useState<string | null>(null), tm = useRef(0);
  const [modeAsk, setModeAsk] = useState<GaitName | null>(null);   // 시안 u4_7 「걷기 모드를 X 로 바꿀까요?」 창 · 고른 모드
  /** 시안 u4_10 「K 을 일으킬까요?」 창 · 일어서기만 잠금 풀기(unlockAsk)를 보낸다. 값 = 창을 연 때의 stop_gen(그 STOP 하나에만 · 검토 H1 11/28) */
  const say = (m: string) => { setMsg(m); clearTimeout(tm.current); tm.current = window.setTimeout(() => setMsg(''), 2600); };
  useEffect(() => { if (d.why) say(d.why); }, [d.why]);
  useEffect(() => { if (d.gait.msg) say(d.gait.msg); }, [d.gait.msg]);
  const res = s?.action_result;
  useEffect(() => { if (pending && res?.request_id === pending && res.status !== 'RUNNING') { say(actionResultText(res)); setPending(null); } }, [res?.request_id, res?.status]);
  useEffect(() => () => clearTimeout(tm.current), []);
  const rl = useRobotLine(r.id, c.user.id), line = tab === 'drive' ? rl : null;   // 시안 u11_2 ~ u11_5 한 줄. 뜨면 아래 옛 글은 비켜 섬
  const now = rt.now(), fresh = !!s && now - l.stateAt < REPORT_STALE_MS;
  const pose = go2Pose(s, fresh), temps = go2Temps(s, fresh, s ? (now - l.stateAt) / 1000 : 0);
  // 시안 u11_5: 서버와 실시간이 끊기거나 거절되면 연결 칸 = 「서버 연결 안 됨」(노랑). 덧말 「현장 Wi-Fi」 는 줄 값이 없어 비움(지어내지 않음)
  const link = rt.link(), cut = link.at === 'lost' || link.at === 'denied', ms = link.at === 'open' && link.latencyMs != null ? `${Math.round(link.latencyMs)} ms` : '';
  const online = s?.connection === 'ONLINE';
  const lowlevel = s?.control === 'LOWLEVEL', mode = GAITS.find((x) => x.g === d.gait.cur)?.name ?? NONE;   // 걷기 모드(로봇 보고 state.gait) · Shift+1~4 는 useServerDrive
  const modeTap = () => (noGait ? say(NO_GAIT) : !mine ? say(MODE_NEED_DRIVE) : openMode());
  const noGait = !!d.gait.avail && !d.gait.avail.length;   // 쓸 수 있는 모드 빈 목록 = 바꾸기 꺼짐 · 까닭
  const sim = useSimLook()(r), demo = useContext(Demo).has(r.id), left = minutesLeft(s?.battery);
  const soc = s?.battery?.soc ?? (sim ? null : r.battery);
  const hotJ = temps && temps.hot >= 0 ? temps.joints[temps.hot] : null;
  const holder = l.holder ?? r.holder ?? null, who = holder?.type === 'USER' ? (holder.id === c.user.id ? '나' : holder.name || NONE) : NONE;
  const a = s?.applied ?? null, sp = s?.speed;
  const moving = online && sp != null && sp >= WALK_MIN_SPEED;   // 관제 타일과 같은 문턱(proto/u5 WALK_MIN_SPEED)
  const walk = !online || sp == null ? '걷기 보고 없음' : !moving ? (s?.posture?.state === 'LYING' ? '엎드림' : '서 있음')
    : `걷는 중 · ${sp.toFixed(1)} m/s ${a && a[0] < 0 ? '뒤로' : a && Math.abs(a[1] ?? 0) > Math.abs(a[0] ?? 0) ? '옆으로' : '앞으로'}`;
  const located = online && s?.location?.x != null;
  // 바닥 점 흐름 = 서버 state.applied [0] vx(앞 m/s) · [1] vy(왼 m/s) · [2] wz(왼쪽 돎 rad/s) · 연결(ONLINE)일 때만(측정 속도 칸은 아직 계약에 없음 · 조정 23:56)
  const drive = a && online ? { v: a[0] ?? 0, side: a[1] ?? 0, turn: a[2] ?? 0 } : null;
  // 바닥 표시: 관제 타일과 같은 판정(proto/u5 useAvail · GET /robots/availability state CHARGING / MAINTENANCE). 충전이면 관절값이 없을 때 엎드림
  const av = useAvail(c.cancel)?.get(r.id), pad: PadKind | null = av?.charging ? 'charge' : av?.job?.kind === 'maint' ? 'maint' : null;
  // 3D 관절 색: 조종 = 60 °C 넘은 가장 뜨거운 관절만(u4_2), 점검 = 관절마다 주의 50 · 경고 60(u4_4 범례)
  const hot: Record<string, string> = tab === 'check' ? Object.fromEntries((temps?.joints ?? []).flatMap((v, i) => (v != null && v >= 50 ? [[JOINTS[i].replace(/_joint$/, ''), v >= 60 ? 'hot' : 'warn']] : [])))
    : temps && temps.hot >= 0 && hotJ != null && hotJ >= 60 ? { [JOINTS[temps.hot].replace(/_joint$/, '')]: 'hot' } : {};
  const ready = d.ready;
  // 시안 u4_9 정지됨 · u4_10 다시 시작 확인: 내 조종 중 로봇이 정지 잠김이면 정지 칸 자리에 「다시 시작」(잠금 해제) · Damping, 조종 줄 · 손잡이는 흐리게
  const latched = mine && online && s?.latched === true, lying = s?.posture?.state === 'LYING';
  // 연 창은 그때의 STOP 에만: 잠금이 다른 곳에서 풀리거나 세대(stop_gen)가 바뀌면 창 자체를 닫는다(숨기기만 하면 새 STOP 때 저절로 다시 뜸 · 검토 H1)
  // 「다시 시작」 · 걷기 모드 창은 연 때의 stop_gen · 조종권(lease)에 묶는다(robotact useRestartAsk · 폰 조종과 같은 규칙). 바뀌거나 조종권을 잃으면 창을 닫고,
  // 보내는 단추는 누르는 순간 저장소 값으로 다시 봐서 같을 때만 보낸다. 걷기 모드 창은 잠김과 무관(잠김이면 stop_gen 이 바뀌어 닫힘)
  const askOf = () => { const x = rt.get(r.id); return { mine: !!x.lease, latched: x.state?.latched, gen: x.state?.stop_gen, lease: x.lease }; };
  const restart = useRestartAsk(askOf), modeBind = useRestartAsk(() => ({ ...askOf(), latched: null }));
  const askNow = restart.live && latched, modeNow = !!modeAsk && modeBind.live;
  useEffect(() => { if (modeAsk && !modeBind.live) setModeAsk(null); }, [modeAsk, modeBind.live]);
  const openMode = (g?: GaitName) => { setModeAsk(g ?? d.gait.cur ?? GAITS[0].g); modeBind.open(); }, closeMode = () => { setModeAsk(null); modeBind.close(); };
  // 시안 u4_7: Shift+N 도 칩과 같은 확인 창을 그 모드를 고른 채 연다(창 없이 보내지 않음). 못 여는 때(조종권 없음 · 그 모드를 못 씀)는 원래 길(press)이 까닭을 알림
  if (d.gaitAsk) d.gaitAsk.current = (g) => (mine && !noGait && (!d.gait.avail || d.gait.avail.includes(g)) ? openMode(g) : d.gait.press(g));
  const [arm, setArm] = useState(-Infinity);   // 처음 = 아직 안 누름(0 이면 페이지 연 뒤 3 초 안 첫 누름이 바로 Damp · 폰 drive 와 같게)
  useEffect(() => { setArm(-Infinity); }, [latched, tab]);   // 단추가 사라지면(정지 풀림 · 다른 칸) 한 번 누른 것도 버림 — 다시 나타난 뒤 첫 누름은 안내만(검토 00:41)
  const damp = () => {
    if (rt.now() - arm > 3000) { setArm(rt.now()); return say('한 번 더 누르면 엎드려 힘을 뺍니다'); }
    setArm(-Infinity); d.zero(); rt.action(r.id, 'Damp', {}, true, (why, id) => { if (why) say(`거부 · ${why}`); else setPending(id ?? null); });
  };
  const stopTag = !latched ? null : d.unlockState === 'unconfirmed' ? `미확인 · 로봇이 정지 확인을 못 해 잠금이 그대로입니다. ${d.refused || '현장에서 로봇이 완전히 멈췄는지 확인한 뒤 다시 누르세요.'}`
    : d.unlockState === 'wait' ? `해제 대기 · 로봇이 정지를 확인하면 풀립니다.${d.refused ? ` ${d.refused}` : ''}`
    : lying ? '정지됨 · 엎드린 뒤 다리 힘을 뺐습니다' : '정지됨 · 한 번 더 누르면 엎드려 힘을 뺍니다';
  // 한 번 허용된 로봇이 끊김(keepDrive): 화면은 그대로 두고 조종 시작만 꺼 둔다(누른 것 버림 · 0 · 조종권 반납은 useServerDrive)
  const offTag = can && d.off ? '로봇 연결이 끊겼습니다 · 다시 연결되면 «조종 시작»을 다시 누르세요' : null;
  const hotTag = hotJ != null && hotJ >= 60 ? `${jointName(JOINTS[temps!.hot])} ${Math.round(hotJ)} °C · 경고` : null;
  const act = (name: ScreenAction['action']) => {
    if (!can) return say(noDrive(c, r));
    if (!mine) return say('조종 시작 후 사용할 수 있습니다.');
    const no = actWhy(name, lowlevel); if (no) return say(no);
    if (!online) return say('로봇과 서버 연결을 확인하세요.');
    d.zero(); say('서버 접수를 기다리고 있습니다.');
    rt.action(r.id, name, {}, false, (why, id) => { if (why) say(`거부 · ${why}`); else { setPending(id ?? null); say('서버 접수 · 로봇의 결과를 기다리고 있습니다.'); } });
  };
  const offAct = (name: ScreenAction['action']) => actOff(name, lowlevel);
  const b = useBoard(c, r), [place, onFactory] = usePlace(c, b),
    run = runOf(r, s?.run), route = useRoute(r.id, run?.name ?? null, c.cancel), job = jobLine(run, route, b);
  const map = <MapView c={c} r={r} b={b} run={run} route={route} onFactory={onFactory} />;
  const small = view === 'map' ? <Cam fs={fs} big={false} can={can} b={b} /> : map;
  return <>
    <div className="hdr" data-robot-head={r.id}><span className="ttl" style={{ fontSize: '26px', marginRight: '6px' }}>{r.name}{demo && DEMO}</span>
      <span className="g dk st" data-cell="link"><svg className="ic" viewBox="0 0 24 24" style={IC17}><path d="M12 20h.01" /><path d="M2 8.82a15 15 0 0 1 20 0" /><path d="M5 12.859a10 10 0 0 1 14 0" /><path d="M8.5 16.429a5 5 0 0 1 7 0" /></svg>{cut ? <span style={{ color: '#f2b705' }}>서버 연결 안 됨</span> : sim && online ? '시뮬' : online ? '연결' : r.online ? '연결 중' : '끊김'}<small>{cut ? '' : sim && online ? '서버 계산' : ms}</small></span>
      <span data-go="u4_7_mode" className="g dk st" data-cell="mode" aria-disabled={noGait || undefined} title={noGait ? NO_GAIT : undefined} role="button" tabIndex={0}
        onClick={modeTap} onKeyDown={(e) => { if (e.key === 'Enter') modeTap(); }}><svg className="ic" viewBox="0 0 24 24" style={IC17}><path d="m8 3 4 8 5-5 5 15H2L8 3z" /></svg>{mode}<small {...(noGait ? { 'data-gait-none': '' } : {})}>{noGait ? '바꿀 수 있는 모드 없음' : 'Shift + 1 ~ 4'}</small></span>
      <span className="g dk st" data-cell="battery"><svg className="ic" viewBox="0 0 24 24" style={IC17}><path d="M10 14v-4" /><path d="M22 14v-4" /><path d="M6 14v-4" /><rect x="2" y="6" width="16" height="12" rx="2" /></svg>{r.unknown === 'summary' ? '확인 안 됨' : soc == null ? NONE : `${Math.round(soc)} %`}<small>{sim ? '시뮬' : soc == null ? '배터리' : left != null ? `약 ${left} 분` : ''}</small></span>
      <span className={`g dk st${hotTag ? ' bad warncell' : ''}`} data-cell="temp"><svg className="ic" viewBox="0 0 24 24" style={IC17}><path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z" /></svg>{hotJ == null ? NONE : `${Math.round(hotJ)} °C`}<small>{hotJ != null && hotJ >= 60 ? jointName(JOINTS[temps!.hot]) : '최고 관절 온도'}</small></span>
      <span className="g dk st" data-cell="holder"><svg className="ic" viewBox="0 0 24 24" style={IC17}><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>{who}<small>조종자</small></span>
      <div className="seg2" style={{ marginLeft: 'auto' }} role="tablist">
        {([['drive', '조종', ''], ['check', '점검', 'u4_4_check'], ['settings', '로봇 설정', 'u4_5_settings']] as const).map(([k, t, go]) =>
          <span key={k} {...(go ? { 'data-go': go } : {})} className={tab === k ? 'on' : ''} data-seg={t} role="tab" aria-selected={tab === k} tabIndex={0} onClick={() => { setTab(k); setGuide(false); }}>{t}</span>)}
      </div></div>
    {line && <DriveLine f={line} />}{/* 시안 u11_2 ~ u11_5 조종 화면 위 한 줄 */}
    {/* 시안 u11_4: 리모컨 우선이면 모드 칸 아래 「걷는 중 · 멈춘 뒤 바꾸기」(걷는 동안만) · 조종 단추 위 「리모컨 조종 중」 */}
    {line?.at === 'remote' && moving && <div className="whyb" style={{ left: '495px', top: '140px' }} data-u4-whyb="mode">{INFO}걷는 중 · 멈춘 뒤 바꾸기</div>}
    {line?.at === 'remote' && <div className="whyb" style={{ right: '60px', top: '846px' }} data-u4-whyb="drive">{INFO}리모컨 조종 중</div>}
    <div className="stage3d" data-stale={pose ? undefined : ''} data-line={line?.at} data-u4-legs={legMode(pose?.q ?? null, (online && lying) || pad === 'charge', moving)} data-u4-pad={pad ?? ''} data-u4-sim={sim ? '' : undefined}><Stage r={r} q={pose?.q ?? null} down={(online && lying) || pad === 'charge'} walk={moving} pad={pad} drive={drive} hot={hot} temps={tab === 'check' ? temps?.joints ?? null : null} />
      <span className="g dk tag hint"><svg className="ic" viewBox="0 0 24 24" style={{ width: '14px', height: '14px' }}><path d="M16.466 7.5C15.643 4.237 13.952 2 12 2 9.239 2 7 6.477 7 12s2.239 10 5 10c.342 0 .677-.069 1-.2" /><path d="m15.194 13.707 3.814 1.86-1.86 3.814" /><path d="M19 15.57c-1.804.885-4.274 1.43-7 1.43-5.523 0-10-2.239-10-5s4.477-5 10-5c4.838 0 8.873 1.718 9.8 4" /></svg>끌어서 돌려 보기</span>
      {offTag ? <div className="g dk tag" style={{ left: '24px', top: line ? '92px' : '24px', color: '#ff4d4f', fontSize: '14px', fontWeight: '800' }} role="status" data-u4-offline>{offTag}</div>
        : stopTag ? <div className="g dk tag" style={{ left: '24px', top: line ? '92px' : '24px', color: lying && !d.unlockState ? '#f2b705' : '#ff4d4f', fontSize: '14px', fontWeight: '800' }} role="status" data-u4-stopped>{stopTag}</div>
        : d.stopLine ? <div className="g dk tag" style={{ left: '24px', top: line ? '92px' : '24px', color: d.stopLine.tone === 'bad' ? '#ff4d4f' : d.stopLine.tone === 'ok' ? '#00c389' : '#f2b705', fontSize: '14px', fontWeight: '800' }} role="status" data-sd-stop-phase data-tone={d.stopLine.tone}>{d.stopLine.text}</div> : null}
      {hotTag && <span className="g dk tag warntag" style={{ left: '150px', top: '300px', color: '#ff4d4f' }} data-u4-hot>{hotTag}</span>}
      <div className="g bub" style={{ left: '58%', top: line ? '140px' : '70px' }} data-u4-notes>{hotTag && <span data-u4-hotbub>{hotBub(jointName(JOINTS[temps!.hot]), hotJ!)}<small>경고 60 °C 넘음 · 걷기는 계속합니다 · 쉬게 하려면 「앉아」</small></span>}{d.notes}</div>
      {tab === 'check' ? <div className="foot" data-u4-legend><span className="g dk tag" style={{ position: 'static', color: '#00c389' }}>보통</span><span className="g dk tag" style={{ position: 'static', color: '#f2b705' }}>주의 50 °C</span><span className="g dk tag" style={{ position: 'static', color: '#ff4d4f' }}>경고 60 °C</span><span className="mu2" style={{ marginLeft: 'auto', fontSize: '12.5px' }}>관절 온도는 색으로 표시 · 마우스를 올리면 값이 보입니다</span></div>
      : sim ? <div className="foot" data-u4-simfoot><span className="g dk tag" style={{ position: 'static', color: '#4c9bff' }} data-u4-simplace>{`시뮬 · ${place || '현장 모름'}`}</span>
        <span className="mu2" style={{ marginLeft: 'auto', fontSize: '12.5px' }}>시뮬 로봇</span></div>
      : <div className="foot"><span className="g dk tag" style={{ position: 'static', color: '#00c389', minWidth: '178px', justifyContent: 'center' }} data-u4-walk>{walk}</span>
        <span className="g dk tag" style={{ position: 'static', color: '#ffffff' }} data-u4-loc>{located ? '위치 추정 켜짐' : '위치 추정 없음'}</span>
        <span className="mu2 jnote" data-u4-jointnote={pose ? 'q' : online && lying ? 'posture' : moving ? 'walk' : 'none'}>{pose ? '실제 관절값으로 제자리에서 움직임 · 바닥 점이 뒤로 흐르면 앞으로 걷는 중' : online && lying ? '관절값이 없어 자세 값(엎드림)으로 그림' : moving ? '관절값이 없어 걷는 속도로 걷기 꼴을 그림' : '관절값을 받지 않아 서 있는 모양 그대로'}</span></div>}</div>
    {tab === 'check' ? <div className="right" data-u4-can={can || undefined}><Check c={c} r={r} guide={() => setGuide(true)} /></div>
      : <div className="right" data-u4-can={can || undefined} {...(zoom ? { 'data-u4-zoom': '' } : {})}><div className="views" ref={viewsEl} aria-label="로봇 보기" onDoubleClick={zoomDbl} title={zoom ? undefined : '더블클릭하면 크게 봅니다'}>
      {zoom && <div className="g dk zback" role="button" tabIndex={0} data-u4-zback onClick={() => flip(false)} onKeyDown={(e) => { if (e.key === 'Enter') flip(false); }}><svg className="ic" viewBox="0 0 24 24" style={{ width: '18px', height: '18px' }}><path d="m15 18-6-6 6-6" /></svg>돌아가기<small>Esc</small></div>}
      {view === 'map' ? map : <div className="mapv" data-u4-big={view}>{view === 'lidar' ? <Lidar fs={fs} can={can} /> : view === 'rgb' ? <Cam fs={fs} big can={can} b={b} /> : <Feed fs={fs} ch={view} big can={can} />}</div>}
      <div className="g dk vsel">{VIEWS.map(([k, t]) => <span key={k} className={view === k ? 'on' : undefined} data-view={k} role="button" tabIndex={0} aria-pressed={view === k} onClick={() => setView(k)}>{t}</span>)}</div>
      <div className="small" data-swap="1" data-cam-inset role="button" tabIndex={0} onClick={() => setView(view === 'map' ? 'rgb' : 'map')}>{small}<span className="cl">{view === 'map' ? '앞 카메라' : '지도'}</span></div>
      <div className="g dk job" data-u4-job><b>{job.name}</b><span>{job.line}</span><i><em style={{ width: `${job.pct}%` }} /></i></div>
      <MapName place={place} b={b} />
      {latched ? <div className="vslot" data-u4-restart>
        {lying ? <button type="button" className="vgo big" onClick={restart.open} data-u4-unlock><svg className="ic" viewBox="0 0 24 24" style={{ width: '24px', height: '24px' }}><path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z" /></svg>다시 시작<small>일어섭니다</small></button>
          : <><button type="button" className="vgo" onClick={restart.open} data-u4-unlock><svg className="ic" viewBox="0 0 24 24" style={{ width: '20px', height: '20px' }}><path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z" /></svg>다시 시작</button>
            <button type="button" data-go="u4_10_restart" className="stop damp" onClick={damp} data-u4-damp><svg className="ic" viewBox="0 0 24 24" style={{ width: '22px', height: '22px' }}><path d="M8 3h8l5 5v8l-5 5H8l-5-5V8z" /><rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" stroke="none" /></svg>Damping<small>엎드려 힘 빼기</small></button></>}
      </div>
        : <div data-go="u4_9_stopped" className="vstop stop" role="button" tabIndex={0} aria-label="비상 정지 · 이 로봇" data-sd-stop="u4" {...d.stopPress}>
        <svg className="ic" viewBox="0 0 24 24" style={{ width: '26px', height: '26px' }}><path d="M8 3h8l5 5v8l-5 5H8l-5-5V8z" /><rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" stroke="none" /></svg>정지<small>Space</small></div>}
    </div>
      <div className={`ctl${latched ? ' dim' : ''}`}>
        <div className={`g dk btn${mine ? ' drv' : ''}`} role="button" tabIndex={0} data-u4-drive={mine ? 'mine' : 'take'} aria-disabled={!can || (!mine && (d.off || !!d.takeWhy)) || undefined}
          onClick={() => { if (!can) say(noDrive(c, r)); else if (mine) { d.zero(); rt.release(r.id); } else if (d.off) say('로봇 연결이 끊겼습니다 · 다시 연결되면 누르세요'); else if (d.takeWhy) say(d.takeWhy); else d.take(); }}>
          <svg className="ic" viewBox="0 0 24 24" style={{ width: '18px', height: '18px' }}><line x1="6" x2="10" y1="11" y2="11" /><line x1="8" x2="8" y1="9" y2="13" /><line x1="15" x2="15.01" y1="12" y2="12" /><line x1="18" x2="18.01" y1="10" y2="10" /><path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z" /></svg>{driveLabel({ mine, asking: !!l.outgoing || line?.at === 'ask', otherHolds: holder?.type === 'USER' && holder.id !== c.user.id })}</div>
        <div data-go="u4_3_voice" className="g dk btn talk" role="button" tabIndex={0} onClick={() => say('말하기는 아직 서버에 없습니다')}>
          <svg className="ic" viewBox="0 0 24 24" style={{ width: '18px', height: '18px' }}><path d="M12 19v3" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><rect x="9" y="2" width="6" height="13" rx="3" /></svg>말하기</div>
        {/* 한 줄(시안 u4_1)에 맞게 짧은 말 · 긴 뜻은 title. 1920 폭에서 넘침 0 을 잼(조정 11-28 20:07) */}
        <div className="g dk keys" data-u4-keys><span title="앞으로 걷기"><kbd>↑</kbd>앞</span><span title="뒤로 걷기"><kbd>↓</kbd>뒤</span><span title="옆걸음"><kbd>←</kbd><kbd>→</kbd>옆</span><span title="제자리 돌기"><kbd>A</kbd><kbd>D</kbd>돌기</span><span data-u4-key-combo title="↑ 와 A 또는 D 를 같이 누르면 앞으로 가며 돕니다"><kbd>↑</kbd><kbd>A</kbd><kbd>D</kbd>돌며 앞</span><span title="정지"><kbd>Space</kbd>정지</span><span title="보기 칸 바꾸기"><kbd>1</kbd>~<kbd>4</kbd>화면</span><span title="Shift + 1 ~ 4 걷기 모드"><kbd>⇧</kbd><kbd>1</kbd>~<kbd>4</kbd>모드</span></div>
      </div>
      <div className={`deck joybig${latched ? ' dim' : ''}`} data-u4-deck data-ready={ready || undefined}>
        <Stick side="L" put={d.stick} /><Stick side="R" put={d.stick} />
        <div className="act">{ACTS.map(([name, t, em, ic]) => {
          const off = offAct(name);
          return <div key={name} className={off ? 'no' : undefined} {...(off && name === 'StandUp' ? { 'data-why': STANDUP_WHY } : {})} role="button" tabIndex={0} data-u4-act={name} onClick={() => act(name)}>
            <span><svg className="ic" viewBox="0 0 24 24" style={IC24}>{ic}</svg></span>{t}<em>{name === 'StandUp' && !lowlevel ? 'L2+A' : name === 'StandUp' ? em : off && !lowlevel ? '순정 확인 전' : em}</em></div>;
        })}</div>
        <div className={`why${msg ? ' on' : ''}`} role="status" data-u4-why>{msg}</div>
      </div>
    </div>}
    {modeNow && <><div className="veil" onClick={closeMode} />
      <div className="g modal" style={{ width: '560px' }} role="dialog" aria-label="걷기 모드 바꾸기" data-u4-mode>
        <span className="ttl">걷기 모드를 {GAITS.find((x) => x.g === modeAsk)!.name} 로 바꿀까요?</span>
        <p className="mu" style={{ fontSize: '14px', marginTop: '10px', lineHeight: '1.55' }}>Shift + 1 ~ 4 로도 바꿉니다. 바꾸는 동안 약 1 초 조종할 수 없습니다. 로봇이 멈춘 상태에서만 바뀝니다.</p>
        <div style={{ display: 'flex', gap: '8px', marginTop: '18px' }}>{GAITS.map((x) => {
          const off = !!d.gait.avail && !d.gait.avail.includes(x.g), on = x.g === modeAsk;
          return <div key={x.g} className="fld" role="button" tabIndex={0} aria-pressed={on} aria-disabled={off || undefined} title={off ? '이 로봇에서 지금 쓸 수 없는 모드입니다.' : undefined} data-u4-gait={x.g}
            style={{ flex: '1', justifyContent: 'center', ...(on ? { border: '1.5px solid var(--pr)', color: 'var(--pr3)', fontWeight: 800 } : {}), ...(off ? { opacity: 0.45 } : {}) }}
            onClick={() => { if (!off) setModeAsk(x.g); }}>{x.name}</div>;
        })}</div>
        <div style={{ display: 'flex', gap: '10px', marginTop: '22px' }}>
          <div className="fld xclose" role="button" tabIndex={0} style={{ flex: 'none', width: 'calc(50% - 5px)', boxSizing: 'border-box', justifyContent: 'center', height: '52px' }} data-u4-mode-cancel onClick={closeMode}>취소</div>
          <div className="btnp" role="button" tabIndex={0} style={{ flex: 'none', width: 'calc(50% - 5px)', boxSizing: 'border-box', height: '52px', fontSize: '15px' }} data-u4-mode-go
            onClick={() => { const g = modeAsk!; setModeAsk(null); modeBind.go(() => d.gait.press(g)); }}>{GAITS.find((x) => x.g === modeAsk)!.name} 로 바꾸기</div>
        </div>
      </div></>}
    {askNow && <><div className="veil" onClick={restart.close} />
      <div className="g modal" style={{ width: '560px' }} role="dialog" aria-label="다시 시작 확인" data-u4-restart-ask>
        <span className="ttl">{r.name} 을 일으킬까요?</span>
        <p className="mu" style={{ fontSize: '14px', marginTop: '10px', lineHeight: '1.55' }}>그 자리에서 일어선 뒤 조종과 동작이 다시 켜집니다. 주변에 사람이 없는지 보세요.</p>
        <div style={{ display: 'flex', gap: '10px', marginTop: '22px' }}>
          <button type="button" className="fld xclose" style={{ flex: 'none', width: 'calc(50% - 5px)', boxSizing: 'border-box', justifyContent: 'center', height: '52px', fontFamily: 'inherit', fontSize: 'inherit', color: 'inherit', cursor: 'pointer' }} data-u4-restart-cancel onClick={restart.close}>취소</button>
          <button type="button" className="btnp" style={{ flex: 'none', width: 'calc(50% - 5px)', boxSizing: 'border-box', height: '52px', fontSize: '15px', fontFamily: 'inherit', border: '0', cursor: 'pointer' }} data-u4-restart-go
            onClick={() => { if (askNow) restart.go(d.unlockAsk); else restart.close(); }}>일어서기</button>
        </div>
      </div></>}
    {(tab === 'settings' || guide) && <><div className="veil" onClick={() => { setTab(tab === 'settings' ? 'drive' : tab); setGuide(false); }} />
      <div className="g modal" role="dialog" aria-label={guide ? '로봇 연결 방법' : '로봇 설정'} data-u4-tab={guide ? 'guide' : tab}>
        <div className="row" style={{ justifyContent: 'space-between' }}><span className="ttl">{r.name} {guide ? '연결 방법' : '로봇 설정'}</span>
          <span data-go="u4_1_robot" className="xclose" role="button" tabIndex={0} aria-label="닫기" data-u4-close onClick={() => { if (guide) setGuide(false); else setTab('drive'); }}><svg className="ic" viewBox="0 0 24 24" style={{ width: '22px', height: '22px' }}><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg></span></div>
        {guide ? <Guide r={r} /> : <Settings c={c} r={r} />}
      </div></>}
  </>;
}

/** 로봇 0대: 시안 틀(목록 제목 · 추가 단추 · 머리 칩 · 칸)은 그대로, 값만 「없음」 */
function Empty({ add, none }: { add: () => void; none?: ReactNode }) {
  return <>
    <div className="pane rail"><div className="row" style={{ justifyContent: 'space-between', padding: '0 6px 12px' }}><span className="ttl">로봇</span>
      <span data-go="u4_6_add" className="btns addbtn" style={{ height: '34px', padding: '0 11px', fontSize: '12.5px' }} role="button" tabIndex={0} onClick={add} data-u4-add>
        <svg className="ic" viewBox="0 0 24 24" style={{ width: '14px', height: '14px' }}><path d="M5 12h14" /><path d="M12 5v14" /></svg>로봇 추가</span></div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }} /></div>
    <div className="hdr" data-robot-head=""><span className="ttl" style={{ fontSize: '26px', marginRight: '6px' }}>로봇 없음</span>
      {['연결', '모드', '배터리', '최고 관절 온도', '조종자'].map((k) => <span key={k} className="g dk st">{NONE}<small>{k}</small></span>)}</div>
    <div className="stage3d">{none}</div>
    <div className="right"><div className="views" aria-label="로봇 보기" /></div>
  </>;
}
/** 목록 = 시안 u4 처럼 실기 + 시뮬(시뮬 줄은 rehearse 파란 점선). 끝낸 시뮬 슬롯(fake idleSim: 담당 없음 · 데모 아님 · 임무 없음)만 뺀다.
 *  임무 판정 state 는 App 고르기와 같게(요약만 받는 로봇은 목록 current_run). 고른 로봇이 목록에 없으면 첫 줄로(머리줄 STOP 대상 = 화면) */
function Real({ c, add }: { c: Ctx; add: () => void }) {
  const robots = c.robots.filter((x) => !idleSim(x, x.unknown === 'summary' ? null : rt.get(x.id).state)), robot = robots.find((x) => x.id === c.robot.id) ?? robots[0], demo = useDemo(c.cancel);
  useEffect(() => { if (robot && robot.id !== c.robot.id) c.pick(robot.id); }, [robot?.id, c.robot.id]);
  if (!robot) return <Empty add={add} />;
  const rc = { ...c, robot, robots };
  return <Demo.Provider value={demo}><Rail c={rc} sel={robot.id} add={add} /><Robot1 key={robot.id} c={rc} r={robot} /></Demo.Provider>;
}

const light = () => typeof document !== 'undefined' && document.documentElement.dataset.theme === 'light';

/** 로봇 탭 PC 화면(App 의 로봇 탭 본문). c 가 null 이면 로봇 0대 */
export function RobotTab({ c, user, refresh, cancel }: { c: Ctx | null; user: Ctx['user']; refresh: () => void; cancel?: AbortSignal }) {
  // 로봇 추가(시안 u4_6): 실제 · 시뮬 고르기 → 다음. 실제 = 새 로봇 추가(QR · 6자리 · 단계 막대 · 설치 파일 받기), 시뮬 = 시뮬 탭. 총괄도 붙인다(11/28 · 서버 #544)
  const [adding, setAdding] = useState<null | 'pick' | 'real'>(null), [kind, setKind] = useState<'real' | 'sim'>('real'), add = () => { setKind('real'); setAdding('pick'); };
  // 「내 로봇 보기」(u2_3): 새 로봇이 목록에 들어오면 그 로봇을 고른다(u4_1)
  const want = useRef('');
  useEffect(() => { if (want.current && c?.robots.some((x) => x.id === want.current)) { c.pick(want.current); want.current = ''; } }, [c?.robots]);
  return <div className={`proto${light() ? ' light' : ''} u4`} data-u4 aria-label="로봇">
    {c ? <Real c={c} add={add} /> : <Empty add={add} none={user.role === 'ORG_ADMIN'   // 로봇 0대(U11-04 빈 화면) · 문구는 폰 · 옛 PC 와 같게. 관제 요약 · 운영 관리자 표는 W1 u5
      ? <EmptyCard kind="robots" title="등록된 로봇이 없습니다" why="운영 관리자가 실기 로봇을 연결하거나 «시뮬 탭 열기»에서 띄우면 여기에 보입니다."><a className="btn pri" href="#/sim">시뮬 탭 열기</a></EmptyCard>
      : <EmptyCard kind="robots" title="담당 로봇이 없습니다" why="연결 코드로 실기를 등록하거나 총괄에게 담당 지정을 요청하세요. 시뮬 로봇은 «시뮬 탭 열기»에서 띄웁니다."><button type="button" className="btn pri" onClick={add} data-pair-start>+ 새 로봇 추가</button><a className="btn" href="#/sim">시뮬 탭 열기</a></EmptyCard>} />}
    {adding === 'real' && <PairFlow user={user} mine={(c?.robots ?? []).filter((x) => x.owner === user.id).map((x) => x.id)} close={() => setAdding(null)} cancel={cancel}
      done={(id) => { setAdding(null); refresh(); if (id) want.current = id; }} />}
    {adding === 'pick' && <><div className="veil" onClick={() => setAdding(null)} /><div className="g modal" style={{ width: '680px' }} role="dialog" aria-label="로봇 추가" data-u4-adding={adding}>
      {<>
        <div className="row" style={{ justifyContent: 'space-between' }}><span className="ttl">로봇 추가</span>
          <span data-go="u4_1_robot" className="xclose" role="button" tabIndex={0} aria-label="닫기" data-u4-close onClick={() => setAdding(null)}><svg className="ic" viewBox="0 0 24 24" style={{ width: '22px', height: '22px' }}><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg></span></div>
        <div style={{ display: 'flex', gap: '14px', marginTop: '22px' }} role="radiogroup" aria-label="로봇 종류">
          <div className={`opt${kind === 'real' ? ' on' : ''}`} role="radio" tabIndex={0} aria-checked={kind === 'real'} onClick={() => setKind('real')} data-u4-kind="real"><svg className="ic" viewBox="0 0 24 24" style={{ width: '30px', height: '30px' }}><path d="M4 13h11l3-3h2v4l-2 1H5z" /><path d="M6 15l-1 4M10 15v4M14 15v4M17 15l1 4" /></svg><b>실제</b><p>폰에 뜬 QR 을 로봇 앞 카메라에 보여 주거나 6 자리 코드를 입력합니다.</p></div>
          <div className={`opt${kind === 'sim' ? ' on' : ''}`} role="radio" tabIndex={0} aria-checked={kind === 'sim'} onClick={() => setKind('sim')} data-u4-kind="sim"><svg className="ic" viewBox="0 0 24 24" style={{ width: '30px', height: '30px' }}><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" /><path d="m3.3 7 8.7 5 8.7-5" /><path d="M12 22V12" /></svg><b>시뮬</b><p>도입 전에 동선과 일정을 미리 시험하거나, 우리 지도 · 경기장에서 지형 적응을 시험합니다. 늘 「시뮬」 표시가 붙습니다.</p></div>
        </div>
        <div data-go="u2_1_scan" className="btnp" style={{ height: '52px', marginTop: '22px', fontSize: '15px' }} role="button" tabIndex={0} data-u4-next
          onClick={() => { if (kind === 'sim') { setAdding(null); location.hash = '#/sim'; } else setAdding('real'); }}>다음</div></>}</div></>}
  </div>;
}
