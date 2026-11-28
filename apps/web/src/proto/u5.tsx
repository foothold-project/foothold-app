// 관제 탭 = 시안 u5_1 타일 · u5_2 고름 · u5_3 지도 보기 · u5_4 뒤집기 · u5_5 경보 · u5_6 운영자. 여섯 장의 body 를 JSX 로 옮기고(태그 · 클래스 · 순서 · 글 그대로)
// 고정 글 자리만 서버 값으로 바꿨다. 서버에 없는 값은 칸을 두고 그 글만 비운다. 명령은 기존 모듈(STOP = App 의 정지 처리, 고름 = controlPick)만 부른다.
import { NO_SIGNAL, driveFeedText, useDriveFeed } from '../drivemedia';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Location, MapSite, RobotAvailability, RobotSummary, ScreenState, SiteTree } from '../../../contracts/ts';
import { api, type ApiFail } from '../api';
import { RUN } from '../screens';
import { realDash } from '../screens/fleet';
import { stopLine } from '../serverdrive';
import { ownerName, robotStatus, runOn, type Robot } from '../fake';
import { GAITS } from '../gait';
import { pickInfo } from '../go2status';
import { JOINTS, REPORT_STALE_MS, go2Pose } from '../go2model';
import { fleetKind, fleetOrder } from '../fleetorder';
import { rt, useRt } from '../rt';
import type { Ctx } from '../screens';
import { actOf, controlPick, pickPress, flagNote, isLost, lastly, needs, useControlPick } from '../screens/control';
import { floorName, floorsOf, useTree } from '../screens/maps';
import { sitePose, toMapPx } from './site';
import { FRONT_DIST, REAR_DIST, REAR_LABEL, tiles as tileGl, type TileLook, type TilePad } from './tileview';
import { SiteView } from './u5map';
import './u5.css';

// 시안 아이콘(lucide 선) 그대로
/** hide = 자리만 두고 보이지 않음(글이 없는 줄 · 칸의 높이를 지킴) */
const I = (w: number, d: ReactNode, color?: string, hide = false) => <svg className="ic" viewBox="0 0 24 24" aria-hidden={hide || undefined} style={{ width: `${w}px`, height: `${w}px`, ...(color ? { color } : {}), ...(hide ? { visibility: 'hidden' as const } : {}) }}>{d}</svg>;
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
const PART: Record<string, string> = { hip: '고관절', thigh: '허벅지', calf: '무릎' };
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
/** 지금 시각의 가용 한 줄: 데모(RobotAvailability.demo) · 구역 이름(location_label) · 충전(state CHARGING 만)
 *  · 하는 일(job): 점검 = state MAINTENANCE, 배터리 교체 = 지금 걸친 일정 칸 kind BATTERY_SWAP. 글은 서버 busy_label 그대로(없으면 «점검 중» · «배터리 교체») */
export type Job = { kind: 'maint' | 'swap'; text: string };
export type Avail = { demo: boolean; label: string | null; charging: boolean; job: Job | null };
const two = (v: number) => String(v).padStart(2, '0');
/** 10 초마다 GET /robots/availability(지금 ~ 1 분 뒤) + GET /schedule(오늘). 받지 못하면 null(충전 수는 빈 칸 · 위치는 층 이름 또는 좌표) */
export function useAvail(cancel?: AbortSignal) {
  const [got, setGot] = useState<Map<string, Avail> | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => {
      const now = new Date(), d = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
      Promise.all([api.availability(now.toISOString(), new Date(now.getTime() + 60_000).toISOString(), cancel),
        api.schedule(d, Intl.DateTimeFormat().resolvedOptions().timeZone, cancel).catch(() => null)]).then(([a, day]) => {
        if (!live) return;
        const kind = new Map((day?.slots ?? []).map((s) => [s.id, s.kind]));
        setGot(new Map(a.items.map((r: RobotAvailability) => [r.robot_id, {
          demo: r.demo, label: r.location_label, charging: r.state === 'CHARGING',
          job: (r.state as string) === 'MAINTENANCE' ? { kind: 'maint', text: r.busy_label || '점검 중' }
            : r.busy_slot_id && kind.get(r.busy_slot_id) === 'BATTERY_SWAP' ? { kind: 'swap', text: r.busy_label || '배터리 교체' } : null } as Avail])));
      }, () => { if (live) setGot(null); });
    };
    load(); const h = setInterval(load, 10_000);
    return () => { live = false; clearInterval(h); };
  }, []);
  return got;
}

/** 시안 «대기 중 · 임무 중» 상태 글(그 밖은 기존 상태 글 robotStatus) */
const idleNow = (x: Robot) => x.online && !x.unknown && x.status === 'IDLE';
const stText = (x: Robot) => (idleNow(x) ? '대기 중' : robotStatus(x).text);

/** 걷는 다리를 틀 실제 속도 문턱(m/s · WS state 최상위 speed). 0.05 = rt 가 state 를 0.1 m/s 자리까지만 견주므로(rt.ts speed toFixed(1)) 그 반,
 *  가장 느린 시뮬 이동(sim_min_vx 기본 0.2)보다 한참 아래. 조종권을 쥔 채 0 축 명령(속도 0)이면 선 자세(팀장 20:51) */
export const WALK_MIN_SPEED = 0.05;
/** 다리를 걷게 그릴지: 서버 속도가 문턱 이상일 때만(없으면 서 있음). 끊김 · 상태 모름 · 엎드림 · 일시정지는 걷지 않음 */
export const walking = (act: string, paused: string | null, speed: number | null | undefined) => (act === 'walk' || act === 'stand') && !paused && typeof speed === 'number' && speed >= WALK_MIN_SPEED;
/** 서버 관절 12 개(로봇 탭 · 옛 관제 3D 와 같은 go2Pose 판정: ONLINE · 받은 지 1 초 안 · age_s ≤ 1). 없으면 null */
export const jointsNow = (id: string) => { const l = rt.get(id); return go2Pose(l.state, rt.now() - l.stateAt <= REPORT_STALE_MS)?.q ?? null; };
/** 관절 보간(서버 최대 10 Hz · 약 0.1 s 떨림): 새 값이 «도착한 화면 시각»을 기준으로 마지막 두 값 사이를 선형으로 잇는다.
 *  지금 그리는 자세에서 새 값까지를 도착 간격(떨림을 줄이려 지수 평균 · 50~300 ms)에 걸쳐 옮기고, 다음 값이 안 오면 마지막 값에 멈춘다(앞질러 짐작하지 않음).
 *  값이 없어지면(1 초 넘게 묵음 · 끊김) null = 기존 규칙대로 걷기 기록 */
export function jointLerp() {
  let from: number[] | null = null, to: number[] | null = null, at = 0, gap = 100;
  const blend = (t: number) => { if (!from || !to) return to; const k = Math.min(1, Math.max(0, (t - at) / gap)); return to.map((v, i) => from![i] + (v - from![i]) * k); };
  return (q: number[] | null, t: number): number[] | null => {
    if (!q) { from = to = null; return null; }
    if (!to) { from = to = q; at = t; return q; }
    if (q !== to && q.some((v, i) => v !== to![i])) {   // 새 값이 왔다(같은 관절값이 다시 온 state 는 새 값이 아님)
      const was = blend(t)!, d = t - at;
      if (d > 0) gap = Math.min(300, Math.max(50, gap * 0.7 + d * 0.3));
      from = was; to = q; at = t;
    }
    return blend(t);
  };
}
/** 관절이 없을 때 엎드림으로 그릴지: 자세 보고(posture) 가 먼저 · 보고가 없을 때만 상태(잠금 · 오류) · 충전 중은 엎드림.
 *  순서 = 관절 > 자세 보고 > 상태 > 선 자세(팀장 20:55 «Go2 X 가 일어섰는데 앉아 있게 그려진다») */
export const lying = (f: Pick<TileFacts, 'x' | 'act' | 'charging'>) => {
  const p = stateOf(f.x)?.posture?.state;
  return f.charging || (p === 'LYING' ? true : p === 'STANDING' || p === 'TRANSITIONING' ? false : f.act === 'lie');
};
/** 정지 잠금 까닭 = 서버 latch_reason(화면 소켓 state 가 칸을 주면 그 값, 아니면 로봇 목록 값) 하나만. 없거나 모르는 값이면 «까닭 미상»(다른 값으로 짐작하지 않음 · 팀장 21:37) */
export const LATCH_WHY: Record<string, string> = { BOOT: '기동 잠금', USER_STOP: '사람 정지', FALL: '넘어짐', LINK_LOST: '연결 끊김', DEVICE_FAULT: '장치 고장', POLICY: '권한 확인 늦음', LEASE_END: '조종권 끝남', OTHER: '기타' };
export const lockWhy = (x: Robot, s: ReturnType<typeof stateOf>) => {
  const st = s as { latch_reason?: string | null } | null | undefined, v = st && 'latch_reason' in st ? st.latch_reason : x.latchReason;
  return (v && LATCH_WHY[v]) || '까닭 미상';
};
/** 타일 한 장의 글 · 칸(서버 값만 · 없으면 그 글을 비움) */
export type TileFacts = {
  x: Robot; demo: boolean; charging: boolean; job: Job | null; level: Level; flag: string | null; why: string; alert: boolean; sim: boolean; lostAt: string | null; lostNow: boolean;
  act: ReturnType<typeof actOf>; walk: boolean; paused: string | null;
  /** 머리표 · 최근 경고 제목이 관절 온도에서 왔음(아니면 잠금 · 상태 · 주의 코드) */ byTemp: boolean;
  /** 조종 중 = 서버 목록 lease.driving === true(사람 조종권 · 입력 2 초 안). 값이 없으면 false */ driving: boolean;
  /** 그 로봇에 진행 중인 임무(state.run · 끝남 · 실패 · 취소 아님)가 있음 = 임무 중 보기(뒤 1 m + 현장). 팀장 21:16 */ onRun: boolean;
  /** 정지 한 줄(serverdrive stopLine 과 같은 판정 · 미전달 · 현장 관문 포함). 정지를 보낸 적 없으면 null */ stop: { tone: string; text: string } | null;
  mode: string; mission: { name: string; done: number; total: number } | null; place: string;
  bat: [string, string]; temp: [string, string, '' | ' w' | ' r']; link: [string, string, '' | ' w']; who: [string, string]; hot: { t: number; j: string } | null;
};
export function facts(x: Robot, me: string, places: Map<string, string>, av?: Avail): TileFacts {
  // 데모 로봇(가용 demo = true)은 시뮬이어도 실기 타일과 똑같이(1 m 뒤 모형 · 배터리 · 온도 · 연결 · 걸음 · 담당), 차이는 «데모» 칩 하나. 시뮬 꼴은 사용자 시뮬만
  const s = stateOf(x), h = hotJoint(x), lvTemp = tempLevel(h?.t ?? null), gone = isLost(x), sim = !!x.sim && !av?.demo, st = robotStatus(x);
  // 테두리 · 머리표: 관절 온도 단계, 아니면 연결 중인 로봇의 기존 경고(잠금 · 오류 = 빨강, 배터리 낮음 · 일시정지 · 남은 주의 코드 = 주황). 끊김은 칸 위 «다시 연결 중»(시안 K-07)
  // 팀장 21:26: 정지 잠금이면 머리표 = 잠금(+ 서버가 준 까닭). 관절 온도는 위험(70 °C ~)일 때만 잠금보다 앞서고, 그 아래 온도는 온도 칩에만 단계 색
  const lk: Level = gone || !needs(x) ? null : st.tone === 'bad' ? 'bad' : 'warn', latched = !gone && x.online && x.status === 'STOP_LATCHED';
  const level: Level = lvTemp === 'crit' ? 'crit' : lvTemp === 'bad' || lk === 'bad' ? 'bad' : lvTemp ?? lk;
  const byTemp = !!lvTemp && !!h && (lvTemp === 'crit' || !latched), lw = latched ? lockWhy(x, s) : '';
  const why = byTemp ? `${jointName(h!.j)} ${Math.round(h!.t)} °C` : latched ? (lw ? `${st.text} · ${lw}` : st.text) : flagNote(x) || st.text;
  const run = s?.run ?? null, pr = s ? run : x.run ?? null, paused = pr?.status === 'PAUSED' ? (('wait_reason' in pr ? pr.wait_reason : null) === 'LINK_LOST' ? '일시정지 · 연결 끊김' : '일시정지') : null;
  // 진행 막대: 목록 current_run(x.mission), 없으면 화면 state.run 이 아직 도는 임무일 때만(01:02 K-07: 끝난 run 이 state 에 남아 «할 일 34/36» 이 남던 것)
  const m = missionOf(x.mission) ?? (run && runOn(x, s) && run.progress.total ? { name: '', done: run.progress.done, total: run.progress.total } : null);
  const loc = s?.location ?? (x.unknown === 'summary' ? null : x.location ?? null);
  const fl = loc?.floor_id ? places.get(loc.floor_id) : undefined;
  const at = av?.label ?? (loc ? fl ?? (loc.x != null && loc.y != null ? `위치 ${loc.x.toFixed(1)}, ${loc.y.toFixed(1)} m` : null) : null);
  const place = at ? `${at}${gone ? ' (마지막 위치)' : ''}` : '', charging = !!av?.charging;
  const lat = s?.latency_ms, act = actOf(x, false);
  // 임무 중 = state.run, state 를 받지 않는 로봇(요약만)은 목록 current_run
  const rs = s ? run : x.run ?? null, onRun = runOn(x, s);
  // 걷기: speed 가 오면 speed(0 = 서 있음). 요약만 받는 로봇은 speed 칸 자체가 없어 임무 중 + RUNNING(일시정지 · 잠금 · 끊김 아님)이면 걷기(D1 · 조정 21:27)
  const noSpeed = s ? s.speed === undefined : x.unknown === 'summary';   // 첫 state 전(wait)은 모름 = 걷지 않음
  // 요약 로봇은 rt 가 online 을 false 로 덮어 끊김을 모름 → 서버 목록 attention OFFLINE 으로 끊김을 봄
  const walk = noSpeed ? onRun && x.status === 'RUNNING' && rs?.status !== 'PAUSED' && !gone && !x.attention?.includes('OFFLINE') : walking(act, paused, s?.speed);
  const holder = x.holder ?? rt.get(x.id).holder;
  const who: [string, string] = holder ? [holder.id === me ? '나' : holder.name, holder.type === 'RUN' ? '임무' : '조종'] : [x.owner ? (x.owner === me ? '나' : ownerName(x)) : '없음', '담당자'];
  // 남은 시간 = 서버 battery.minutes_left(정수 0 ~ 1440 · 실기 모형 없으면 null). 계약 타입이 base 에 오기 전이라 선택 칸으로 읽음. null 이면 % 만(지어내지 않음)
  const ml = (s?.battery as { minutes_left?: number | null } | null | undefined)?.minutes_left, left = typeof ml === 'number' && Number.isInteger(ml) && ml >= 0 && ml <= 1440 ? ml : null;
  const bat = x.battery != null ? `${Math.round(x.battery)} %` : null, tv = h ? lastly(x, `${Math.round(h.t)} °C`, x.seenAt) : null;
  return {
    stop: x.unknown === 'summary' ? null : stopLine(rt.get(x.id)),
    x, byTemp, demo: !!av?.demo, charging, job: av?.job ?? null, level, why, alert: needs(x) || !!lvTemp, flag: level ? `${LEVEL_TEXT[level]} · ${why}` : null, sim, lostNow: gone, lostAt: gone ? hm(x.seenAt) ?? '' : null, paused,
    act, walk, onRun, driving: holder?.type === 'USER' && x.holder?.driving === true, mode: s?.gait?.gait ? GAIT_NAME[s.gait.gait] ?? s.gait.gait : '', mission: m, place, hot: h,
    bat: sim ? ['시뮬', '배터리 해당 없음'] : [bat ?? '', charging ? '충전 중' : av?.job ? (av.job.kind === 'maint' ? '점검 중' : '배터리 교체') : left != null ? `약 ${left} 분` : ''],
    temp: sim ? ['없음', stText(x), ''] : tv ? [tv, lvTemp ? LEVEL_TEXT[lvTemp] : '보통', lvTemp === 'bad' || lvTemp === 'crit' ? ' r' : lvTemp === 'warn' ? ' w' : ''] : ['', '', ''],
    link: sim ? ['서버', '시뮬 계산', ''] : gone ? ['연결 중', hm(x.seenAt) ? `${hm(x.seenAt)} 끊김` : '', ' w'] : x.online ? ['연결', lat != null ? `${Math.round(lat)} ms` : '', ''] : [st.text, '', ''],
    who,
  };
}
/** 경고 타일 맨 앞(위험 → 경고 → 주의), 그 밖은 받은 순서 그대로(기존 관제 order 와 같음) */
/** 타일 · 지도 보기 줄 순서 = 공용 규칙(fleetorder): 긴급(시안이 칸을 칠하는 위험 → 경고 → 주의) → 실기 → 데모 → 사용자 시뮬 → 받은 순서.
 *  끊김은 시안 u5_1 K-07 처럼 칸을 칠하지 않고 덮개만이라 긴급으로 올리지 않음 */
export const order = (l: TileFacts[]) => fleetOrder(l, (f) => f.level, (f) => fleetKind(f.x.sim, f.demo));
/** 타일 벽에 둘 로봇(팀장 23:53 · 01:08 · 시안 u5_1 처럼 섞어 8 칸, 시안 밖 · 새로 그림 = 고르는 규칙). 차례대로 빈 칸이 있을 때만 넣는다:
 *  사용자 시뮬은 8 칸 안에 하나뿐: 위험 · 경고 시뮬 → 임무 중 시뮬 → 대기 시뮬(시뮬이 그것뿐일 때). 데모는 대기여도 시뮬보다 먼저.
 *  1) 위험 · 경고(칸을 빨갛게 칠하는 crit · bad)  2) 실기(사용자 시뮬도 데모도 아님 · Go2 X) · 섞기 셋 자리는 남기고
 *  3) 섞기 한 대씩: 점검 중(가용 MAINTENANCE) → 충전 중(가용 CHARGING) → 연결 끊김 또는 주의(warn)
 *  4) 남은 실기  5) 데모(임무 중 먼저)  6) 시뮬 하나  7) 그 밖은 받은 차례(order).
 *  고른 로봇은 원래 줄 차례(order)대로 둔다. 남은 로봇은 지도 보기 · 작은 지도 · 최근 경고 · 로봇 탭 목록에 그대로 나온다 */
export const WALL_MAX = 8;
export function wallPick(all: TileFacts[], max = WALL_MAX): TileFacts[] {
  if (all.length <= max) return all;
  const red = (f: TileFacts) => f.level === 'crit' || f.level === 'bad', sims = all.filter((f) => f.sim);
  const sim1 = sims.find(red) ?? sims.find((f) => f.onRun) ?? sims[0], ok = (f: TileFacts) => !f.sim || f === sim1;
  const got = new Set<TileFacts>(), add = (f?: TileFacts) => { if (f && ok(f) && got.size < max) got.add(f); };
  const free = (p: (f: TileFacts) => boolean) => all.find((f) => !got.has(f) && !f.sim && p(f));
  const real = (f: TileFacts) => !f.sim && !f.demo, MIX = 3;
  all.filter(red).forEach(add);
  all.filter(real).forEach((f) => { if (got.size < max - MIX) add(f); });
  add(free((f) => f.job?.kind === 'maint')); add(free((f) => f.charging)); add(free((f) => f.lostNow || f.level === 'warn'));
  all.filter(real).forEach(add);
  all.filter((f) => f.demo && f.onRun).forEach(add); all.filter((f) => f.demo).forEach(add);
  add(sim1);
  all.forEach(add);
  return all.filter((f) => got.has(f));
}
/** 타일 칸 배치. 8 대까지는 시안 그대로(2×2 · 4×2). 9 대부터는 시안 한 칸(357.5 × 440)을 줄여 가장 크게 들어가는 열 · 줄을 고르고,
 *  남는 칸이 생기면 줄마다 대수를 고르게 나눠(예: 9 대 = 5 + 4) 빈 칸 없이 한 줄을 꽉 채운다(span = 각 타일이 차지하는 칸 수, 열 = 줄별 대수의 최소공배수) */
export function wallGrid(n: number): { cols: number; rows: number; zoom: number; units?: number; span?: number[] } {
  if (n <= 4) return { cols: 2, rows: 2, zoom: 1 };
  if (n <= 8) return { cols: 4, rows: 2, zoom: 1 };
  const b = fitGrid(n);
  if (b.cols * b.rows === n) return b;
  const base = Math.floor(n / b.rows), extra = n % b.rows, ks = Array.from({ length: b.rows }, (_, r) => base + (r < extra ? 1 : 0));
  const gcd = (x: number, y: number): number => (y ? gcd(y, x % y) : x), units = ks.reduce((l, k) => (l * k) / gcd(l, k), 1);
  return { ...b, units, span: ks.flatMap((k) => Array<number>(k).fill(units / k)) };
}
function fitGrid(n: number): { cols: number; rows: number; zoom: number } {
  const W = 1472, H = 900, TW = 357.5, TH = 440;   // 시안 4×2 한 칸
  let best = { cols: 4, rows: Math.ceil(n / 4), zoom: 0 };
  for (let c = 4; c <= n; c++) {
    const r = Math.ceil(n / c), z = Math.min(1, (W - 14 * (c - 1)) / c / TW, (H - 20 * (r - 1)) / r / TH);
    if (z > best.zoom + 1e-6) best = { cols: c, rows: r, zoom: z };
  }
  return best;
}

// ── 타일 ──────────────────────────────────────────────────
/** 타일 · 작은 지도 공통: 데모 현장 승인 판(boards)의 위치만 현장 좌표로. 판 id 가 다르거나 없으면 null(엉뚱한 자리보다 뺌) */
export const tilePose = (l: Location | null | undefined, boards: Set<string>) => (l?.map_version_id && boards.has(l.map_version_id) ? sitePose(l) : null);
/** 타일 시점(팀장 21:16): 임무 중 = 뒤 1 m 따라가기 + 현장 glb(서버 위치 그대로), 임무 전 = 늘 정면 + 초록 점 바닥(현장 · 가림 당김 없음).
 *  뒤집기(정면)는 임무 중이어도 시안 u5_4 대로 현장 없이 어두운 바탕(조정 22:03) */
export const tileView = (f: TileFacts, front: boolean, l: Location | null | undefined, boards: Set<string>) =>
  ({ front: front || !f.onRun, pose: f.onRun && !front ? tilePose(l, boards) : null });
/** 바닥 표시(시안 pad): 충전 = 가용 state CHARGING(f.charging) · 점검 = 가용 state MAINTENANCE(f.job.kind maint). 시뮬은 없음 */
export const tilePad = (f: Pick<TileFacts, 'charging' | 'job' | 'sim'>): TilePad => (f.sim ? null : f.charging ? 'charge' : f.job?.kind === 'maint' ? 'check' : null);
/** 숨: 임무 전 시뮬 로봇이 서 있을 때만(걷기 · 엎드림 아님). 실기 · 데모는 실제 자세만 */
export const tileBreathe = (f: Pick<TileFacts, 'sim' | 'onRun' | 'walk'>, down: boolean) => f.sim && !f.onRun && !f.walk && !down;
const locOf = (f: TileFacts) => stateOf(f.x)?.location ?? (f.x.unknown === 'summary' ? null : f.x.location);
/** 정면 온도 칩: 관절 온도가 문턱(tempLevel · 50 / 60 / 70 °C)을 넘을 때만 경고색 · 관절 이름, 아니면 회색 «최고 관절 온도 N °C»(잠금 등 다른 경고 색을 빌리지 않음) */
function TempOv({ f }: { f: TileFacts }) {
  const lv = f.hot ? tempLevel(f.hot.t) : null, col = lv === 'warn' ? 'var(--u5-amb)' : lv ? 'var(--u5-red)' : undefined;
  return <span className="g dk ov" style={{ left: '8px', bottom: '8px', ...(col ? { color: col } : {}) }}>{I(14, IC.temp)}{f.hot ? (lv ? `${jointName(f.hot.j)} ${Math.round(f.hot.t)} °C` : `최고 관절 온도 ${Math.round(f.hot.t)} °C`) : '최고 관절 온도'}</span>;
}
function Cv({ f, front, hotMap, boards }: { f: TileFacts; front: boolean; hotMap: Record<string, string>; boards: Set<string> }) {
  const ref = useRef<HTMLCanvasElement>(null), look = useRef<TileLook>({ pose: null, front, cyber: f.sim, walk: false, down: false, hot: {} });
  // 시뮬도 실기 · 데모와 같은 규칙(팀장 20:49 · 21:16). 파란 결은 로봇 재질 · 테두리 · 이름표로만
  const v = tileView(f, front, locOf(f), boards);
  const down = lying(f), pad = tilePad(f);
  look.current = { pose: v.pose, front: v.front, cyber: f.sim, walk: f.walk, down, hot: hotMap, pad, breathe: tileBreathe(f, down) };
  const id = f.x.id;
  // 서버 관절은 그릴 때마다 새로 읽어 보간한다(같은 화면 값이면 다시 그리지 않아도 관절은 바뀜 · 1 초 넘게 묵으면 버림).
  // 구독하지 않는 로봇(unknown 'summary')은 state 가 오지 않아 jointsNow 가 null = 걷기 기록. 관절값이 오면 그 갈래와 상관없이 관절이 먼저
  useEffect(() => { if (!ref.current) return undefined; const lerp = jointLerp(); return tileGl().add(ref.current, () => ({ ...look.current, q: lerp(jointsNow(id), rt.now()) })); }, []);
  const go2 = JSON.stringify({ walk: f.walk, glow: !f.sim, pin: !f.sim, hot: hotMap, cyber: f.sim, scene: v.pose ? 'site' : 'dots', yaw: v.front ? 0 : 'back', dist: v.front ? FRONT_DIST : REAR_DIST, ...(pad && !v.pose ? { pad } : {}), ...(down ? { pose: 'down' } : {}), floor: 0.5 });
  const showFront = v.front;
  return <div style={{ height: '222px' }} className={showFront ? 'cv st' : 'cv'} data-face={showFront ? 'front' : 'live'}>
    <canvas ref={ref} className={showFront ? 'front' : 'rear'} data-go2={go2}></canvas>
    {f.lostNow ? <div className="lk">{I(24, IC.wifi, 'var(--u5-amb)')}다시 연결 중<small>마지막 화면 {f.lostAt}</small></div>   /* 끊김은 시점과 상관없이 먼저(임무 전 정면이어도) */
      : (f.sim || (idleNow(f.x) && !f.onRun && !f.charging && !f.job && !(f.hot && tempLevel(f.hot.t)))) && showFront ? <span className="g dk ov" style={{ left: '8px', bottom: '8px' }}>{I(14, IC.temp)}{stText(f.x)} · 정면 보기</span>
      : showFront ? <TempOv f={f} />
      : f.x.sim ? <span className="g dk ov" style={{ left: '8px', top: '8px' }}>{I(14, IC.cam)}{REAR_LABEL}</span>
      : <RealCam id={f.x.id} />}
    {f.stop ? <span className="stb" style={{ color: TONE_COL[f.stop.tone] ?? 'var(--mu2)' }} data-stop-line={f.stop.tone} title={f.stop.text}>{I(14, IC.stop)}{f.stop.text}</span>
      : (() => { const b = tileBadge(f); return b && <BadgeTag b={b} />; })()}
  </div>;
}

/** 실기 카메라: 받은 영상(drive-media rgb)이 있으면 칸을 덮어 보여 주고, 없으면 1 m 뒤 모형 위에 «카메라 신호 없음 · 까닭» */
function RealCam({ id }: { id: string }) {
  const feed = useDriveFeed(id, 'rgb'), [, tick] = useState(0), text = driveFeedText(feed, 'rgb');
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);   // 2 초 넘게 새 판이 없으면 «신호 없음» 으로 바뀌게
  if (feed.img && !text) return <><img className="cam" src={feed.img} alt={`${id} 카메라`} data-cam="live" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
    <span className="g dk ov" style={{ left: '8px', top: '8px' }}>{I(14, IC.cam)}카메라</span></>;
  return <><span className="g dk ov" style={{ left: '8px', top: '8px' }}>{I(14, IC.cam)}{REAR_LABEL}</span>
    <span className="g dk ov" style={{ left: '8px', top: '40px', maxWidth: 'calc(100% - 16px)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} data-cam="none" title={text}>{I(14, IC.cam)}{text || NO_SIGNAL.rgb}</span></>;
}

/** 타일 오른쪽 위 상태 배지(팀장 01:17 · 01:19 · 시안 K-06 «점검 중» 꼴). 시뮬 · 데모 · 실기 · 새 로봇 모두 이 함수 하나, 위에서 먼저 맞는 하나:
 *  1 끊김(다시 붙는 중 = «다시 연결 중», 꺼짐 = «연결 끊김») 2 정지 잠금 3 넘어짐(robot_info.fallen) 4 점검(가용 MAINTENANCE)
 *  5 충전(가용 CHARGING) · 그 둘이 아닐 때 일정 칸 배터리 교체 6 임무(사용자 시뮬 = «시뮬 중», 데모 · 실기 = «임무 중», 멈춤 = «임무 멈춤») 7 그 밖 «대기 · 임무 전».
 *  «조종 중»은 서버가 조종권 안에 실제 입력 여부를 줄 때까지 내지 않는다(값 없으면 7). 상태를 아직 모르면(요약 · 받는 중) null */
export type Badge = { key: 'relink' | 'lost' | 'pre' | 'latched' | 'fallen' | 'maint' | 'swap' | 'charging' | 'paused' | 'run' | 'simrun' | 'driving' | 'idle'; text: string; icon: keyof typeof IC; col: string; pulse: boolean; dim?: boolean; why?: string };
const GREY = '#a9b8c6';
/** «연결 전» 점(팀장 02:14 두 안): 'still' = B 하얀 점 멈춤 · 흐리게(기본), 'pulse' = A 하얀 점 펄스. 주소 ?preDot=pulse(또는 #… ?preDot=pulse)로 A 를 볼 수 있음 */
export const PRE_DOT: 'still' | 'pulse' = 'still';
export const preDot = (): 'still' | 'pulse' => {
  try { const q = new URLSearchParams(location.search || location.hash.split('?')[1] || ''); const v = q.get('preDot'); return v === 'pulse' || v === 'still' ? v : PRE_DOT; } catch { return PRE_DOT; }
};
/** 모든 배지는 같은 틀(아이콘 · 글 · 점). 글 색 = col, 점 색 = badgeDot, 펄스 = pulse(움직임 줄이기면 멈춤) */
export function tileBadge(f: TileFacts): Badge | null {
  const x = f.x;
  if (f.lostNow) return { key: 'relink', text: '다시 연결 중', icon: 'wifi', col: 'var(--u5-amb)', pulse: true };
  // 한 번도 붙은 적 없는 로봇(seenAt 없음)은 끊김 경고가 아니라 «연결 전»(관제 끊김 규칙과 같음)
  if (!x.unknown && !x.online && !x.seenAt) { const a = preDot() === 'pulse'; return { key: 'pre', text: '연결 전', icon: 'wifi', col: GREY, pulse: a, dim: !a }; }
  if (x.unknown === 'link' || (!x.unknown && !x.online) || x.attention?.includes('OFFLINE')) return { key: 'lost', text: '연결 끊김', icon: 'wifi', col: 'var(--u5-amb)', pulse: false };
  if (x.unknown) return null;
  if (x.status === 'STOP_LATCHED') return { key: 'latched', text: '정지 잠금', icon: 'stop', col: 'var(--u5-red)', pulse: false };
  if (pickInfo(x)?.v?.fallen) return { key: 'fallen', text: '넘어짐', icon: 'warn', col: 'var(--u5-red)', pulse: false };
  // 지금 상태(가용 MAINTENANCE · CHARGING)가 일정 칸(BATTERY_SWAP)보다 먼저(01:31 K-04: 충전 중인데 «배터리 교체»)
  if (f.job?.kind === 'maint') return { key: 'maint', text: '점검 중', icon: 'wrench', col: GREY, pulse: true };
  if (f.charging) return { key: 'charging', text: '충전 중', icon: 'bolt', col: 'var(--u5-on)', pulse: true };   // 글 하양(밝은 판 그라파이트) · 점 초록(팀장 02:14)
  if (f.job) return { key: 'swap', text: '배터리 교체', icon: 'bat', col: GREY, pulse: false };
  if (f.onRun) return f.paused ? { key: 'paused', text: '임무 멈춤', icon: 'warn', col: 'var(--u5-amb)', pulse: true, why: f.paused }
    : f.sim ? { key: 'simrun', text: '시뮬 중', icon: 'box', col: 'var(--u5-sim)', pulse: true } : { key: 'run', text: '임무 중', icon: 'flag', col: 'var(--u5-ok)', pulse: true };
  // 조종 중: 서버 lease.driving === true 일 때만(팀장 01:4x) · 임무 다음 · 대기 앞. 틀은 임무 중과 같게(글 초록 · 점 빨강 · 펄스)
  if (f.driving) return { key: 'driving', text: '조종 중', icon: 'mode', col: 'var(--u5-ok)', pulse: true };
  return { key: 'idle', text: '대기 · 임무 전', icon: 'home', col: GREY, pulse: false };
}
/** 배지 점 색은 여기 한 곳(팀장 02:14): 임무 중 = 빨강(--u5-dot-red) · 충전 = 초록 · 시뮬 = 파랑 · 연결 전 = 하양(--u5-on), 나머지 = 배지 글 색 */
export const badgeDot = (b: Badge): string =>
  b.key === 'run' || b.key === 'driving' ? 'var(--u5-dot-red)' : b.key === 'charging' ? 'var(--u5-ok)' : b.key === 'simrun' ? 'var(--u5-sim)' : b.key === 'pre' ? 'var(--u5-on)' : b.col;
/** 머리 줄 수 칸 = 필터 갈래(팀장 02:21 · 조정 02:29). 수와 필터 모두 tileBadge 의 key 에서 센다(배지와 어긋나지 않음).
 *  임무 중 = 임무 중 · 임무 멈춤 배지(실기 · 데모), 시뮬 = 시뮬 로봇 전체(시뮬 중 + 대기), 경고만 배지가 아닌 경고 테두리 축(겹쳐 셈) */
export type Group = '임무 중' | '충전' | '점검' | '연결 중' | '시뮬' | '경고' | '주의';
const keyIn = (f: TileFacts, ...k: Badge['key'][]) => { const b = tileBadge(f); return !!b && k.includes(b.key); };
export const GROUP: Record<Group, (f: TileFacts) => boolean> = {
  '임무 중': (f) => !f.sim && keyIn(f, 'run', 'paused'),
  '충전': (f) => keyIn(f, 'charging'),
  '점검': (f) => keyIn(f, 'maint'),
  '연결 중': (f) => !f.sim && keyIn(f, 'relink', 'lost'),
  '시뮬': (f) => f.sim,
  '경고': (f) => f.level === 'bad' || f.level === 'crit',   // 경고 테두리 축: 경고 · 위험 = 「경고」, 주의 = 「주의」(조정 02:30)
  '주의': (f) => f.level === 'warn',
};
/** 고른 갈래 중 하나라도 맞으면 보임(여러 개 고름 = 합). 고른 것이 없으면 모두 */
export const inGroups = (f: TileFacts, pick: readonly Group[]) => !pick.length || pick.some((g) => GROUP[g](f));
function BadgeTag({ b }: { b: Badge }) {
  return <span className={`stb${b.pulse ? ' chk' : ''}`} style={{ color: b.col }} title={b.why} data-badge={b.key} data-pulse={b.pulse ? '1' : '0'} {...{ [`data-${b.key}`]: '' }}>{I(14, IC[b.icon])}{b.text}
    <i className={b.dim ? 'dim' : undefined} style={{ background: badgeDot(b) }}></i></span>;
}

function Tile({ f, sel, front, open, boards }: { f: TileFacts; sel: boolean; front: boolean; open: () => void; boards: Set<string> }) {
  const q = f.x.online && !f.x.unknown ? f.x.robotInfo?.temperature?.joints : null, qk = q ? q.join(',') : '';
  const hotMap = useMemo(() => Object.fromEntries((q && q.length === 12 ? q : []).flatMap((c, i) => { const lv = tempLevel(c ?? null); return lv ? [[JOINTS[i].replace(/_joint$/, ''), lv === 'warn' ? 'warn' : 'hot']] : []; })), [qk]);
  const cls = `tile${f.level ? ` lv-${f.level}` : ''}${f.sim ? ' sim' : ''}${sel ? ' sel' : ''}${f.level ? ' warncell' : ''}${f.sim ? ' rehearse' : ''}`;
  const red = f.level === 'bad' || f.level === 'crit';
  return <div className={cls} data-t={f.x.name} data-robot={f.x.id} data-tone={f.level ?? undefined} data-act={f.act} data-sel={sel || undefined} data-live={f.walk ? '1' : undefined} role="button" tabIndex={0} aria-pressed={sel} aria-label={`${f.x.name} 타일`}
    {...pickPress(f.x.id, sel, open)}>
    {f.flag && <span className="flag warntag" style={{ background: red ? 'var(--u5-red)' : 'var(--u5-amb)' }} data-warn-flag>{I(13, IC.warn)}{f.flag}</span>}
    <Cv f={f} front={front} hotMap={hotMap} boards={boards} />
    <div className="inf"><div className="nm"><b style={red ? { color: 'var(--u5-red)' } : undefined}>{f.x.name}</b>{f.sim && <span className="chip sim">시뮬</span>}{f.demo && <span className="chip" data-demo>데모</span>}<span className="md">{f.mode && I(15, IC.mode)}{f.mode}</span></div>
      <div className="ln">{(() => { // 임무 없는 타일도 늘 상태 줄(팀장 01:08 · 시안 K-08): 데모 · 실기 대기 = «임무 전 · 대기», 시뮬 대기 = «임무 전 · 시뮬 등록»
        const txt = f.mission?.name || (f.charging ? '충전 중' : f.job ? f.job.text : f.sim ? '임무 전 · 시뮬 등록' : idleNow(f.x) ? '임무 전 · 대기' : '');
        return <>{I(16, f.mission ? IC.flag : f.charging ? IC.bolt : f.job ? (f.job.kind === 'maint' ? IC.wrench : IC.bat) : f.sim || txt ? IC.home : IC.flag, undefined, !txt)}<span>{txt}</span></>; })()}{f.mission && f.mission.total > 0 && <em>할 일 {f.mission.done} / {f.mission.total}</em>}</div>
      {f.mission && f.mission.total > 0 && <div className="pg"><i style={{ width: `${Math.round((f.mission.done / f.mission.total) * 100)}%` }}></i></div>}
      <div className="ln">{I(16, IC.pin)}<span>{f.place}</span></div>
      <div className="sts"><div className="s" data-fact="battery">{I(16, f.sim ? IC.box : f.charging ? IC.bolt : IC.bat)}{f.bat[0]}<small>{f.bat[1]}</small></div><div className={`s${f.temp[2]}`} data-fact="temp">{I(16, IC.temp, undefined, !f.temp[0])}{f.temp[0]}<small>{f.temp[1]}</small></div><div className={`s${f.link[2]}`} data-fact="link">{I(16, IC.wifi)}{f.link[0]}<small>{f.link[1]}</small></div><div className="s" data-fact="who">{I(16, IC.user)}{f.who[0]}<small>{f.who[1]}</small></div></div></div>
  </div>;
}

// ── 오른쪽 칸 ─────────────────────────────────────────────
/** 데모 현장(/sites 의 demo === true)의 층마다 승인 판 id. 작은 지도(시안 공장 그림)는 이 판의 위치만 그린다 */
/** 작은 지도 · 현장 그림(factory_kr top · 시안 design.json transform 25 + u·3.5)이 그려진 층 판의 꼴(팀장 00:36: demo 플래그가 아니라 층 대조).
 *  로봇 위치 판(map_version_id)을 서버에서 받아(GET /map-versions/{id} · 판마다 한 번) 크기 · 해상도 · 원점이 이 꼴과 같으면 그 층으로 본다 */
export const SITE_BOARD = { width: 1800, height: 1120, resolution: 0.5, origin: [0, -560] } as const;
export const isSiteBoard = (v: { width: number; height: number; resolution: number; origin: number[] }) =>
  v.width === SITE_BOARD.width && v.height === SITE_BOARD.height && Math.abs(v.resolution - SITE_BOARD.resolution) < 1e-9
  && Math.abs((v.origin[0] ?? NaN) - SITE_BOARD.origin[0]) < 1e-6 && Math.abs((v.origin[1] ?? NaN) - SITE_BOARD.origin[1]) < 1e-6;
const boardSeen = new Map<string, boolean | null>();   // 판 id → 현장 층인가(null = 묻는 중)
/** 위치 판 가운데 현장 층인 것. 못 받으면(실패) 그 판은 그리지 않고 다음에 다시 묻는다 */
function useSiteBoards(ids: string[]) {
  const [, bump] = useState(0), key = [...new Set(ids)].sort().join(',');
  useEffect(() => {
    let live = true;
    for (const id of key ? key.split(',') : []) {
      if (boardSeen.has(id)) continue;
      boardSeen.set(id, null);
      api.version(id).then((v) => { boardSeen.set(id, isSiteBoard(v)); if (live) bump((n) => n + 1); }, () => { boardSeen.delete(id); });
    }
    return () => { live = false; };
  }, [key]);
  return key.split(',').filter((id) => boardSeen.get(id) === true);
}
export const resetSiteBoards = () => boardSeen.clear();
export const demoBoards = (tree: SiteTree | null | undefined) => new Set((tree?.items ?? []).filter((s) => (s as MapSite & { demo?: boolean }).demo === true)
  .flatMap((s) => s.buildings.flatMap((b) => b.floors.map((f) => f.approved_version_id))).filter((v): v is string => !!v));
/** 작은 지도 이름표 자리(01:18 r0118: 가까운 K-02 · K-04 이름표가 겹침). 앞에 놓인 이름표와 겹치면 점 아래로 내린다.
 *  위쪽 점부터 놓는다. x · y = 점 자리 px, w = 이름표 폭 추정(글자 7 px + 여백 12). 높이 19 px · 위 = 점 위 28 px 가운데, 아래 = 점 아래 17 px 가운데. 아래로 내린 id 를 돌려준다 */
export function labelsBelow(items: { id: string; x: number; y: number; w: number }[]): Set<string> {
  const H = 19, put: { x: number; y: number; w: number }[] = [], dn = new Set<string>();
  const hit = (b: { x: number; y: number; w: number }) => put.some((o) => Math.abs(o.x - b.x) < (o.w + b.w) / 2 && Math.abs(o.y - b.y) < H);
  for (const it of [...items].sort((a, b) => a.y - b.y)) {   // 위쪽 점부터: 겹치면 아래 점의 이름표가 더 아래로(다른 점을 덮지 않게)
    const up = { x: it.x, y: it.y - 28, w: it.w }, down = { x: it.x, y: it.y + 17, w: it.w };
    if (hit(up) && !hit(down)) { dn.add(it.id); put.push(down); } else put.push(up);
  }
  return dn;
}
function Mini({ all, sel, boards, toMap }: { all: TileFacts[]; sel: string; boards: Set<string>; toMap?: (from: DOMRect, focus: string) => void }) {
  const at = (f: TileFacts) => { const p = tilePose(locOf(f), boards); if (!p) return null; const [px, py] = toMapPx(p.x, p.z); return { dx: px * 0.125 - 200, dy: py * 0.125 - 125 }; };   // 칸 가운데 기준 px
  // 고를 때도 확대 · 이동 없이 그림 한 장 전체 · 고른 점만 강조(팀장 02:03 · 00:33 의 2 배 확대를 뺌)
  const pos = (q: { dx: number; dy: number }) => ({ x: Math.round(q.dx), y: Math.round(125 + q.dy) });
  const kindOf = (f: TileFacts) => (f.sim ? 'sim' : f.level === 'bad' || f.level === 'crit' ? 'r' : f.level === 'warn' || f.lostNow ? 'o' : '');
  const labeled = (f: TileFacts) => { const k = kindOf(f); return sel ? f.x.id === sel : k === 'r' || (k === 'o' && !f.lostNow); };
  const sorted = [...all].sort((a, b) => a.x.name.localeCompare(b.x.name, 'ko', { numeric: true }));
  const below = labelsBelow(sorted.flatMap((f) => { const q = labeled(f) ? at(f) : null; return q ? [{ id: f.x.id, ...pos(q), w: f.x.name.length * 7 + 12 }] : []; }));
  const dots = sorted.flatMap((f) => {
    // 데모 현장 승인 판의 위치만: 판 id 가 다르거나 없으면 그리지 않음(엉뚱한 자리보다 뺌). 서버 판 m → 시안 그림 px = design.json transform(25 + u·3.5, 20 + v·3.5 · v = -y)
    const q = at(f);
    if (!q) return [];
    const p = pos(q), left = `calc(50% + ${p.x}px)`, top = `${p.y}px`;
    const kind = kindOf(f), me = f.x.id === sel;
    return [<i key={f.x.id} className={`dotm ${kind}${sel ? (me ? ' sel' : ' dim') : ''}`} style={{ left, top }} data-walk={f.walk ? '1' : undefined} data-dot={f.x.id}></i>,
      labeled(f) && <span key={`${f.x.id}-l`} className={`dotl${me ? ' sel' : ''}${below.has(f.x.id) ? ' dn' : ''}`} style={{ left, top }}>{f.x.name}</span>];
  });
  return <div className="pane" style={{ padding: '10px' }}><div className="row" style={{ justifyContent: 'space-between', padding: '4px 6px 10px' }}><span className="ttl" style={{ fontSize: '17px' }}>작은 지도</span><span className="mu2" style={{ fontSize: '12.5px' }}>{sel ? '선택한 로봇 강조' : '점 = 로봇 · 점선 = 시뮬'}</span></div><div className="mini" role={toMap ? 'button' : undefined} tabIndex={toMap ? 0 : undefined} aria-label={toMap ? '작은 지도 · 두 번 누르면 지도 보기' : undefined} data-to-map={toMap ? '' : undefined}
    onDoubleClick={toMap && ((e) => toMap(e.currentTarget.getBoundingClientRect(), sel))} onKeyDown={toMap && ((e) => { if (e.key === 'Enter') toMap(e.currentTarget.getBoundingClientRect(), sel); })}>{dots}</div></div>;
}

/** 최근 경고 = 주의가 필요한 로봇(기존 관제 needs · 관절 온도 · 끊김)에서 경보 칸에 나온 로봇을 뺀 것. 시각 = 받은 시각(발생 시각 필드 없음) · 모르면 칸을 접음 */
const TONE_COL: Record<string, string> = { ok: 'var(--u5-ok)', warn: 'var(--u5-amb)', bad: 'var(--u5-red)' };
/** 최근 경고 시각(팀장 21:24): 끊김 = 마지막 받은 시각, 정지 잠금 = 서버 status_since(그 잠금에 붙은 값일 때), 아니면 화면을 열 때 이미 경고면 «이어진 상태», 받는 동안 새로 생긴 경고는 그때 시각 */
type Since = Map<string, { alert: boolean; at: string | null }>;
const CARRY = '이어진 상태';
function trackSince(seen: Since, all: TileFacts[]) {
  for (const f of all) {
    if (f.lostNow || f.x.unknown || !stateOf(f.x)) continue;   // 첫 state 전(목록 값만) · 끊긴 동안은 세지 않음 = 처음 받은 state 가 이미 경고면 «이어진 상태»
    const a = f.alert, p = seen.get(f.x.id);
    seen.set(f.x.id, { alert: a, at: !a ? null : !p ? CARRY : p.alert ? p.at : new Date().toTimeString().slice(0, 5) });
  }
}
function alertAt(f: TileFacts, seen: Since): { t: string; title: string } | null {
  const s = f.x.statusSince;
  if (!f.lostNow && f.x.online && f.x.status === 'STOP_LATCHED' && s?.status === 'STOP_LATCHED') { const t = hm(s.at); if (t) return { t, title: `잠금 시작 ${t}` }; }
  const e = !f.lostNow && f.x.online ? seen.get(f.x.id) : undefined;
  if (e?.at) return { t: e.at, title: e.at === CARRY ? CARRY : `받은 시각 ${e.at}` };
  const t = hm(f.x.seenAt); return t ? { t, title: `받은 시각 ${t}` } : null;
}
function Recent({ list, pick, open, seen }: { list: TileFacts[]; pick: (id: string) => void; open: (id: string) => void; seen: Since }) {
  return <div className="pane" style={{ padding: '16px 18px 6px', flex: '1', overflow: 'hidden', display: 'flex', flexDirection: 'column', minHeight: 0 }} aria-label="최근 경고"><div className="row" style={{ justifyContent: 'space-between', marginBottom: '4px' }}><span className="ttl" style={{ fontSize: '17px' }}>최근 경고</span><a href="#/history" style={{ color: 'inherit', textDecoration: 'none' }}><span className="mu2" style={{ fontSize: '12.5px' }}>기록 탭에서 모두 보기</span></a></div>
    {/* 칸에 다 들어가지 않는 줄은 반쯤 잘려 보이지 않게 옆 칸으로 넘겨 숨김(시안: 온전한 줄만) · 모두는 기록 탭 */}
    <div className="alist">{list.map((f) => { const red = f.level === 'bad' || f.level === 'crit', at = alertAt(f, seen), joint = f.byTemp && !!f.hot;   // 관절 제목은 단계가 온도에서 왔을 때만(정지 잠금 등 다른 경고에 관절 이름을 붙이지 않음)
      const head = joint ? `관절 ${LEVEL_TEXT[tempLevel(f.hot!.t)!]}` : f.lostNow ? '연결 끊김' : f.why;
      const sub = joint ? f.why : f.lostNow ? `${f.place ? `${f.place.replace(' (마지막 위치)', '')} · ` : ''}다시 연결 중` : f.mission?.name ?? (f.why.startsWith(stText(f.x)) ? '' : stText(f.x));   // 제목이 이미 상태 글이면(정지 잠금) 덧말은 비움 · 시각은 오른쪽 칸만(21:56 · 같은 줄에 «이어진 상태» 두 번 나오던 것)
      return <div className="al" key={f.x.id} data-alert={f.x.id} role="button" tabIndex={0} onClick={() => pick(f.x.id)} onDoubleClick={() => open(f.x.id)}><span style={{ color: red ? 'var(--u5-red)' : 'var(--u5-amb)' }}>{I(18, joint ? IC.temp : f.lostNow ? IC.wifi : IC.warn)}</span><div>{f.x.name} {head}<small>{sub}</small></div>{at && <time data-alert-at title={at.title}>{at.t}</time>}</div>; })}</div>
  </div>;
}
const m1 = (v: number | null) => (v == null ? '' : v.toFixed(1));
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
  const who = held ? (held.id === me ? '나' : held.name) : lease ? (lease.holder_type === 'RUN' ? '임무' : lease.user ? (lease.user.id === me ? '나' : lease.user.display_name) : '') : '없음';
  return <div className="pane" style={{ padding: '18px 18px 18px' }} data-picked><div className="row" style={{ justifyContent: 'space-between' }}><span className="ttl">{f.x.name}</span></div>
    <div className="kv"><span>임무</span><b data-k="임무" style={{ fontWeight: 'inherit' }}>{hidden ? '확인 안 됨' : runText}</b><span>위치</span><b data-k="위치" style={{ fontWeight: 'inherit' }}>{hidden ? '확인 안 됨' : f.place && !f.place.startsWith('위치 ') ? f.place /* 시안 u5_2: 자리 이름(타일과 같은 값) · 없으면 좌표 */ : loc && loc.x != null && loc.y != null ? `x ${m1(loc.x)} m · y ${m1(loc.y)} m (${hms(loc.updated_at)})` : '위치 없음'}</b><span>모드</span><b data-k="모드" style={{ fontWeight: 'inherit' }}>{f.mode}</b><span>조종</span><b data-k="조종" style={{ fontWeight: 'inherit' }}>{hidden ? '확인 안 됨' : who}</b></div>
    {f.stop ? <p className="mu2" role="status" style={{ fontSize: '12.5px', marginTop: '14px', lineHeight: '1.5', color: TONE_COL[f.stop.tone] }} data-stop-line={f.stop.tone}>{f.stop.text}</p>
      : err ? <p className="mu2" role="alert" style={{ fontSize: '12.5px', marginTop: '14px', lineHeight: '1.5' }} data-detail-err>{err}</p>
      : <p className="mu2" style={{ fontSize: '12.5px', marginTop: '14px', lineHeight: '1.5' }}>두 번 누르면 로봇 탭에서 열립니다. 한 번 더 누르면 고르기를 풉니다.</p>}
    <div className="btns openb" style={{ height: '46px', marginTop: '12px', fontSize: '14px' }} role="button" tabIndex={0} onClick={open} onKeyDown={(e) => { if (e.key === 'Enter') open(); }}>{I(17, IC.dog)}로봇 탭에서 열기</div></div>;
}
function Alarm({ f, stop, open }: { f: TileFacts; stop?: (id: string) => void; open: () => void }) {
  const press = stop ? { 'data-stop-press': '', onPointerDown: (e: { button: number }) => { if (e.button === 0) stop(f.x.id); }, onClick: (e: { detail: number }) => { if (!e.detail) stop(f.x.id); } } : {};
  return <div className="pane abox" style={{ padding: '18px' }} data-alarm={f.x.id}><div className="row" style={{ gap: '10px', color: 'var(--u5-red)' }}>{I(22, IC.warn)}<span className="ttl" style={{ fontSize: '18px', color: 'var(--u5-red)' }}>경보 · {f.x.name} 관절 위험</span></div>
    <p style={{ fontSize: '14px', lineHeight: '1.55', marginTop: '10px', color: '#ffffff' }}>{f.hot ? `${jointName(f.hot.j)}이 ${Math.round(f.hot.t)} °C 입니다.` : ''} 로봇은 스스로 멈추지 않습니다.</p>
    <div style={{ display: 'flex', gap: '8px', marginTop: '14px' }}>{stop && <div className="rstop" style={{ flex: '1' }} role="button" tabIndex={0} aria-label={`${f.x.name} 정지`} {...press}>{I(18, IC.stop)}{f.x.name} 정지</div>}<div className="btns k5open" style={{ flex: '1', height: '52px', fontSize: '14px' }} role="button" tabIndex={0} onClick={open}>{I(17, IC.dog)}로봇 탭에서 보기</div></div></div>;
}

// ── 화면 ──────────────────────────────────────────────────
/** 데모 표시 스위치 기억(서버 조직 설정을 못 받을 때 · 운영자가 이 화면에서만 끌 때). 못 읽으면 켬 */
const DEMO_KEY = 'fh-control-demo';
const demoShown = () => { try { return localStorage.getItem(DEMO_KEY) !== '0'; } catch { return true; } };
const keepDemo = (on: boolean) => { try { localStorage.setItem(DEMO_KEY, on ? '1' : '0'); } catch { /* 저장 불가 */ } };
export function Control5(c: Ctx & { stop?: (id: string) => void; mayStop?: (id: string) => boolean }) {
  useRt();
  const me = c.user.id, admin = c.user.role === 'ORG_ADMIN';
  // 작은 지도 → 지도 보기(팀장 11-28 17:23 · 시안 밖): 작은 지도 칸 자리에서 큰 지도 자리로 자라며 넘어가고, 3D 첫 시점은 위에서 본 틀에서 시안 시점으로 내려앉음
  const [from, setFrom] = useState<DOMRect | null>(null), [focus, setFocus] = useState(''), [home, setHome] = useState(0);
  const toHome = () => { setFrom(null); setFocus(''); setHome((k) => k + 1); setView('map'); };   // 첫 화면으로 = 지도 보기 첫 시점(무리 가운데)
  const [pick, setPick] = useState<Group[]>([]), flip = (g: Group) => setPick((p) => (p.includes(g) ? p.filter((x) => x !== g) : [...p, g]));
  const [view, setView] = useState<'tiles' | 'map'>('tiles'), [scope, setScope] = useState<'all' | 'mine'>(admin ? 'all' : 'mine'), [front, setFront] = useState(false), [demo, setDemoNow] = useState(demoShown);
  // 데모 표시 = 조직 설정 show_demo_label(서버 값이 앞섬 · 못 받으면 이 브라우저 기억). 총괄이 바꾸면 PATCH, 실패하면 되돌림
  useEffect(() => { let live = true; api.settings(c.cancel).then((o) => { if (live && typeof o.show_demo_label === 'boolean') setDemoNow(o.show_demo_label); }, () => {}); return () => { live = false; }; }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  const setDemo = (on: boolean) => { setDemoNow(on); keepDemo(on); if (admin) api.saveSettings({ show_demo_label: on }, c.cancel).catch(() => { setDemoNow(!on); keepDemo(!on); }); };
  const sel = useControlPick();
  useEffect(() => () => controlPick.set(''), []);
  const t = useTree(c.cancel), av = useAvail(c.cancel);
  const site = useSiteBoards(c.robots.flatMap((x) => { const v = locOf({ x } as TileFacts)?.map_version_id; return v ? [v] : []; }));
  const boards = useMemo(() => new Set([...demoBoards(t.tree), ...site]), [t.tree, site.join(',')]);   // eslint-disable-line react-hooks/exhaustive-deps
  const places = useMemo(() => new Map(floorsOf(t.tree).map((p) => [p.floor.id, `${p.building.name} ${floorName(p.floor.name)}`])), [t.tree]);
  const list = scope === 'mine' ? c.robots.filter((x) => x.owner === me) : c.robots;
  const every = order(list.map((x) => facts(x, me, places, av?.get(x.id)))), all = demo ? every : every.filter((f) => !f.demo);   // 데모 표시 끔 = 데모 로봇을 타일 · 지도 · 수에서 뺌
  const seen = useRef<Since>(new Map()).current; trackSince(seen, all);
  useEffect(() => { if (sel && !all.some((f) => f.x.id === sel)) controlPick.set(''); });
  const see = (s: 'all' | 'mine') => { if (s !== scope) controlPick.set(''); setScope(s); };
  const open = (id: string) => { c.pick(id); c.go('fleet'); };
  const n = (f: (x: TileFacts) => boolean) => all.filter(f).length;
  const shown = all.filter((f) => inGroups(f, pick)), none = pick.length > 0 && !shown.length;   // 필터: 타일 · 작은 지도 · 지도 보기에만(수 · 경고 목록은 전체)
  const wall = wallPick(shown), g = wallGrid(wall.length), picked = all.find((f) => f.x.id === sel), crit = all.find((f) => f.level === 'crit');
  const seg = (on: boolean, v: string, icon: ReactNode, go: () => void) => <span className={on ? 'on' : ''} data-v={v} role="button" tabIndex={0} aria-pressed={on} onClick={go} onKeyDown={(e) => { if (e.key === 'Enter') go(); }}>{I(16, icon)}{v}</span>;
  // 총괄: 수 칸 = 서버 요약(GET /dashboard · 시뮬 몫은 뺌 · realDash)의 임무 중 · 주의 필요(=경고). 받지 못하면 수를 비우고 까닭(title · 화면 읽기 한 줄). 운영 관리자 = 받은 로봇 상태로 셈
  const d = admin ? realDash(c.dash?.d ?? null, c.robots) : null, dErr = admin ? c.dash?.err ?? '' : '';
  const why = dErr ? `요약을 받지 못했습니다. ${dErr}` : undefined;
  const cnt = (k: Group, icon: ReactNode, v: number | null, col?: string, src?: 'dashboard', none?: string) => { const on = pick.includes(k); return <span className={on ? 'cnt on' : 'cnt'} style={col ? { color: col } : undefined} data-sum={k} data-src={src} title={src ? why : none} data-none={v == null || undefined}
    role="button" tabIndex={0} aria-pressed={on} onClick={() => flip(k)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(k); } }}>{I(16, icon, col)}{`${k} `}<b style={col ? { color: col } : undefined}>{v ?? ''}</b></span>; };
  return <main className="u5" data-view={view} aria-label="관제">
    <div className="tb"><div className="seg2" role="group" aria-label="보기">{seg(view === 'tiles', '타일 보기', IC.tiles, () => setView('tiles'))}{seg(view === 'map', '지도 보기', IC.map, () => { setFrom(null); setFocus(''); setView('map'); })}</div>
      <span className="pinf" role="button" tabIndex={0} data-home onClick={toHome} onKeyDown={(e) => { if (e.key === 'Enter') toHome(); }} style={{ cursor: 'pointer' }}><i></i>첫 화면으로</span><span className="sep"></span>
      {/* 임무 중 = 타일이 «임무 중» 인 로봇(실행 상태 RUNNING · 끊기지 않음, 시뮬 포함). 서버 요약의 robots_running 은 실기만이라 타일과 어긋나서 쓰지 않음 */}
      {cnt('임무 중', IC.flag, n(GROUP['임무 중']))}
      {cnt('충전', IC.bolt, av ? n(GROUP['충전']) : null, undefined, undefined, av ? undefined : '가용(GET /robots/availability)을 받지 못했습니다')}
      {cnt('점검', IC.wrench, av ? n(GROUP['점검']) : null, undefined, undefined, av ? undefined : '가용(GET /robots/availability)을 받지 못했습니다')}
      {/* 시안 칸 줄 그대로 여섯 칸 · 0 이면 0. 서버에 없는 값은 수를 비우고 까닭은 title */}
      {cnt('연결 중', IC.wifi, n(GROUP['연결 중']))}
      {cnt('시뮬', IC.box, n(GROUP['시뮬']))}
      {/* 경고 = 타일 테두리가 경고인 로봇(시뮬 포함). 서버 요약 robots_attention 은 실기만이라 타일과 어긋나서 쓰지 않음 */}
      {cnt('경고', IC.warn, n(GROUP['경고']), 'var(--u5-red)')}
      {cnt('주의', IC.warn, n(GROUP['주의']), 'var(--u5-amb)')}
      {why && <span className="ap-sr" role="alert" data-dash-err>{why}</span>}
      {/* 시안 밖 · 새로 그림: 타일은 8 칸까지(wallPick), 남은 로봇이 어디 있는지 한 줄 */}
      {view === 'tiles' && shown.length > wall.length && <span className="mu2" style={{ fontSize: '12.5px' }} data-wall-rest={shown.length - wall.length}>{`타일 ${wall.length} 대 · 나머지 ${shown.length - wall.length} 대는 지도 보기 · 로봇 탭`}</span>}
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '14px' }}>
        {view === 'tiles' && <span className="btns flipb" style={{ height: '42px', padding: '0 14px', fontSize: '13.5px', ...(front ? { background: 'var(--u5-ok-bg)', borderColor: 'var(--u5-ok-line)', color: 'var(--u5-ok)' } : {}) }} role="button" tabIndex={0} aria-pressed={front}
          onClick={() => setFront(!front)} onKeyDown={(e) => { if (e.key === 'Enter') setFront(!front); }}>{I(16, IC.flip)}{front ? `${REAR_LABEL} 시점으로` : '정면 상태로 뒤집기'}</span>}
        <span className={demo ? 'tgl on' : 'tgl'} role="switch" aria-checked={demo} tabIndex={0} data-demo-show onClick={() => setDemo(!demo)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDemo(!demo); } }}>데모 표시<i></i></span>
        <div className="seg2 flt" role="group" aria-label="범위"><span className={scope === 'all' ? 'on' : ''} data-f="모두" role="button" tabIndex={0} aria-pressed={scope === 'all'} onClick={() => see('all')}>모두</span><span className={scope === 'mine' ? 'on' : ''} data-f="내 로봇" role="button" tabIndex={0} aria-pressed={scope === 'mine'} onClick={() => see('mine')}>내 로봇</span></div></div></div>
    {none ? <div className="wall mu2" data-filter-empty style={{ placeItems: 'center', fontSize: '14px' }}>고른 상태의 로봇이 없습니다 · 머리 줄 칸을 다시 누르면 풀립니다</div>
      : view === 'tiles' ? <div className={wall.length > 8 ? 'wall many' : 'wall'} style={{ gridTemplateColumns: `repeat(${g.units ?? g.cols},1fr)`, gridTemplateRows: `repeat(${g.rows},1fr)` }} aria-label="로봇 타일" data-count={wall.length} data-all={all.length}>
      {wall.map((f, i) => <ZoomBox key={f.x.id} zoom={g.zoom} span={g.span?.[i]}><Tile f={f} sel={f.x.id === sel} front={front} open={() => open(f.x.id)} boards={boards} /></ZoomBox>)}</div>
      : <SiteView key={home} all={shown} sel={sel} open={open} from={from} focus={focus} />}
    <div className="side">
      {view === 'tiles' ? <>
        <Mini all={shown} sel={sel} boards={boards} toMap={(r, id) => { setFrom(r); setFocus(id); setView('map'); }} />
        {picked && <Picked key={picked.x.id} f={picked} open={() => open(picked.x.id)} me={me} cancel={c.cancel} refresh={c.refresh} />}
        {crit && !picked && <Alarm f={crit} stop={c.mayStop?.(crit.x.id) ? c.stop : undefined} open={() => open(crit.x.id)} />}
        <Recent list={all.filter((f) => (f.alert || f.lostNow) && f.x.id !== crit?.x.id)} pick={(id) => controlPick.set(id)} open={open} seen={seen} /></>
        : <MapSide all={shown} sel={sel} open={open} />}
    </div>
  </main>;
}
/** 대수가 많을 때만 타일을 줄인다(8 대 이하는 시안 그대로 zoom 1 · 감싸지 않음) */
const ZoomBox = ({ zoom, span, children }: { zoom: number; span?: number; children: ReactNode }) => (zoom >= 1 && !span ? children : <div style={{ ...(zoom < 1 ? { zoom } : {}), ...(span ? { gridColumn: `span ${span}` } : {}), display: 'grid', minWidth: 0, minHeight: 0 }}>{children}</div>);

function MapSide({ all, sel, open }: { all: TileFacts[]; sel: string; open: (id: string) => void }) {
  const moving = all.filter((f) => f.walk).length;
  return <><div className="pane" style={{ padding: '16px 18px' }}><div className="row" style={{ justifyContent: 'space-between' }}><span className="ttl" style={{ fontSize: '17px' }}>동선 겹쳐 보기</span><span className="tgl on"><i></i></span></div>
    <div className="lg" style={{ marginTop: '6px' }}><svg width="40" height="8"><line x1="2" y1="4" x2="38" y2="4" stroke="#00c389" strokeWidth="2" strokeLinecap="round" /></svg>기존 동선<span className="mu2" style={{ marginLeft: 'auto', fontSize: '12.5px' }}>임무 중 {moving} 대</span></div>
    <div className="lg"><svg width="40" height="8"><line x1="2" y1="4" x2="38" y2="4" stroke="#ffffff" strokeWidth="2" strokeDasharray="6 4" strokeLinecap="round" /></svg>새 동선<span className="mu2" style={{ marginLeft: 'auto', fontSize: '12.5px' }}></span></div>
    <div className="lg" style={{ color: 'var(--u5-amb)' }}><svg width="40" height="18"><circle cx="20" cy="9" r="7" fill="none" stroke="#f2b705" strokeWidth="1.5" /></svg>겹치는 곳<span className="mu2" style={{ marginLeft: 'auto', fontSize: '12.5px' }}></span></div></div>
    <div className="pane" style={{ padding: '8px 14px', flex: '1' }}>{all.map((f) => <div key={f.x.id} className="rrow" data-r={f.x.name} role="button" tabIndex={0} aria-pressed={f.x.id === sel} {...pickPress(f.x.id, f.x.id === sel, () => open(f.x.id))}>
      <span style={{ color: f.level === 'bad' || f.level === 'crit' ? 'var(--u5-red)' : 'var(--mu2)' }}>{I(18, IC.dog)}</span><div style={{ minWidth: '0' }}>{f.x.name}<small style={{ display: 'block', marginTop: '2px' }}>{f.place}</small></div>
      <small style={{ marginLeft: 'auto', width: '92px', textAlign: 'right', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.mission?.name ?? (f.lostNow ? '연결 중' : f.sim ? '시뮬 대기' : stText(f.x))}</small><em>{f.sim ? '없음' : f.x.battery != null ? `${Math.round(f.x.battery)} %` : ''}</em></div>)}</div></>;
}
