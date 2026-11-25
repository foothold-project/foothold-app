// 서버 경유 실기 시험의 카메라·라이다·뎁스(10-30 SERVER-DRIVE-ADD1 B · 11-12 RB-DEPTH): 서버 WS /api/v1/robots/{id}/drive-media/{rgb|lidar|depth} — 로그인 쿠키·Origin, 받기만(hello·토큰 없음).
// 내용은 media/1 그대로(media.video · media.points 머리 + 바로 뒤 binary xyz_f32le · media.status). robot·channel 이 다르거나 순서가 어긋나면 그 연결을 닫는다.
// 라이다는 받은 한 판만 그린다(frame 'odom' 이면 그 판의 pose 도) — 11-25 RB-SLAM-WEB3: 브라우저에서 판을 쌓거나 격자 지도를 계산하지 않음(지도 만들기는 지도 탭, Jetson 계산).
// epoch 가 바뀌면 그림을 비우고 순번을 새로 센다(서버가 붙자마자 보내는 epoch 0 «최근 자료 없음» 상태는 새 시작이 아님).
// 11-20 RB-FEED-HOLD-LAST: 한 번 받은 그림은 잠깐 끊겨도(오래됨·연결 끊김·로봇이 못 보냄·탭 숨김) 남겨 두고 «마지막 그림 · N초 전» 을 띄운다 —
// 로봇 바뀜·화면 나감·epoch 바뀜·약속 위반(남의 로봇 자료 등)·기체 확인 영구 오류(RV-435 ①)면 버린다. 관측 전용 — 조종·STOP·조종권과 무관. 끊기면 2 s 뒤 다시(화면이 보이고 칸이 떠 있는 동안만)
import { useEffect, useRef, useState } from 'react';
import { STALE_MS, pointsBody, pointsEdge, pointsHeader, reasonText, type Feed } from './media';
import type { Device, MediaPointCloudHeader } from '../../contracts/ts';
import { useLive } from './rt';
import { ROBOTS } from './fake';

export type DriveCh = 'rgb' | 'lidar' | 'depth';
/** 뎁스: 색 범위(m) — 가까움 빨강 min · 멀리 파랑 max. 다른 채널은 null */
export type Pose = { x: number; y: number; z: number; yaw: number };
/** pose = frame 'odom' 판의 로봇 위치(그 밖은 null) */
export type DriveFeed = Feed & { range: [number, number] | null; pose: Pose | null };
type Raw = DriveFeed;
/** 5 cm 칸(3D «상자» 한 변 — lidar3d.tsx) · 로봇보다 이만큼 높은 점(천장)은 위에서 본 그림(lidarmap.tsx)에서만 숨긴다 */
export const CELL_M = 0.05, CEIL_M = 1.2;
const poseOf = (p: unknown): Pose | null => {
  const q = p as Pose | null;
  return q && [q.x, q.y, q.z, q.yaw].every((v) => typeof v === 'number' && Number.isFinite(v)) ? { x: q.x, y: q.y, z: q.z, yaw: q.yaw } : null;
};
export const RETRY_MS = 2000;
export const DEPTH_HINT = '뎁스 카메라 영상이 아직 오지 않습니다. 로봇 컴퓨터의 뎁스 카메라 프로그램이 켜져 있는지 확인하세요';
export const NO_SIGNAL: Record<DriveCh, string> = { rgb: '카메라 신호 없음', lidar: '라이다 신호 없음', depth: '뎁스 카메라 신호 없음' };
const blank = (state: Feed['state'] = 'wait', why = ''): Raw => ({ state, why, at: 0, seq: -1, img: '', xyz: new Float32Array(0), n: 0, frame: '', truncated: false, ver: 0, range: null, pose: null });
/** 계약 depth_min_m·depth_max_m: 유한·0≤min<max≤10000 — 아니면 null(RGB 를 뎁스로 보여 주지 않음) */
const depthRange = (m: Record<string, unknown>): [number, number] | null => {
  const a = m.depth_min_m, b = m.depth_max_m;
  return m.source === 'go2_depth' && typeof a === 'number' && typeof b === 'number' && Number.isFinite(a) && Number.isFinite(b) && a >= 0 && a < b && b <= 10_000 ? [a, b] : null;
};
/** 에이전트 장치 go2-identity 의 영구 오류 문구(setup/runtime.py identity.fault — 랜선이 바뀌어 다른 몸일 수 있음, 프로그램을 다시 켜야 풀림).
 *  장치 표에 오는 낱말은 key·kind·label·state 뿐이라 «로봇 확인 잠시 안 됨»(잠깐 — 그림 남김)과는 label 로만 가른다 */
export const IDENTITY_FAULT_LABEL = '로봇 연결 정보 변경 · 이동 잠김';
export const BODY_FAULT = '로봇 연결 정보가 바뀌어 받지 않습니다. 랜선을 확인한 뒤 로봇 프로그램을 다시 실행하세요';
export const bodyFault = (devices: readonly Device[] | null | undefined) =>
  !!devices?.some((d) => d.key === 'go2-identity' && d.state !== 'OK' && d.label === IDENTITY_FAULT_LABEL);   // MISSING 이어도 문구가 남으면 영구 오류(link/session.py — 오래되면 state 만 MISSING)
/** 기체번호가 MAC 자리표시 범위(앞 수 0xFFFF0000~0xFFFFFFFF, agent setup/storage.py mac_serial · server pairing.py)인 실기 = MAC 으로 몸을 확인하는 로봇일 수 있음 —
 *  그런 에이전트는 비어 있지 않은 장치 표마다 go2-identity 를 넣는다(setup/runtime.py: mac_identity 가 있을 때만). 같은 범위의 DDS 기체번호(4294967295-17 등, contracts 허용)·시뮬은 go2-identity 가 원래 없다(RV-448 ②).
 *  ponytail: 목록(ROBOTS)에 없는 로봇은 확인할 수 없어 예전처럼 ONLINE 표면 연다 — 조종 화면은 목록에서 고른 로봇만 띄운다 */
export const macBody = (robot: string) => {
  const r = ROBOTS.find((x) => x.id === robot), hi = Number(r?.serial?.split('-')[0]);
  return !!r && !r.sim && hi >= 0xffff0000 && hi <= 0xffffffff;
};
/** 그 로봇의 장치 표를 이번 상태 연결에서 받기 전(새로고침·상태 소켓 다시 붙음 = rt state 비어 있음)·로봇 끊김(OFFLINE 의 장치 표는 빈 것) 동안의 까닭 —
 *  에이전트는 영구 오류를 다시 켤 때까지 장치 표로 계속 보내므로(setup/runtime.py), 화면이 따로 기억하지 않고 표를 다시 받아 본다(RV-442) */
export const BODY_CHECK = '로봇 상태를 확인하는 중입니다';
type Gate = 'ok' | 'wait' | 'fault';
/** 자리표시 범위 실기(mac)는 빈 표(에이전트 첫 상태 전·3 s 넘게 상태 없음, server robots.py live_state)·go2-identity MISSING 이면 «아직 모름»(RV-445 ①).
 *  비어 있지 않은 표에 go2-identity 가 아예 없으면 MAC 에이전트가 아님(DDS 기체) — ok(RV-448 ②). «로봇 확인 잠시 안 됨»(ERROR, 영구 오류 문구 아님)은 ok — 그림·소켓을 남긴다 */
const gateOf = (s: { connection?: string; devices?: readonly Device[] } | null | undefined, mac: boolean): Gate =>
  !s || s.connection !== 'ONLINE' ? 'wait' : bodyFault(s.devices) ? 'fault'
    : mac && (!s.devices?.length || s.devices.some((d) => d.key === 'go2-identity' && d.state === 'MISSING')) ? 'wait' : 'ok';
export const driveMediaUrl = (robot: string, ch: DriveCh) =>
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v1/robots/${encodeURIComponent(robot)}/drive-media/${ch}`;

/** 로봇·채널별 지금·지난 epoch 기록 — 칸을 숨겼다 열어도(on, 카메라·뎁스 칸은 내려갔다 다시 붙음) 이어간다: 다시 구독할 때 늦은 지난 epoch 판을 새 시작으로 받지 않게(RV-450 ② · RV-452).
 *  그 로봇을 받는 훅이 하나도 없으면(화면 나감) 버린다 */
type Eps = { epoch: number | null; gone: Set<number> };
const EPS = new Map<string, { users: number; ch: Partial<Record<DriveCh, Eps>> }>();
const epsRobot = (robot: string) => { let r = EPS.get(robot); if (!r) EPS.set(robot, (r = { users: 0, ch: {} })); return r; };

/** 이 칸이 떠 있는 동안(on) 그 채널을 받는다 — on=false 면 열지 않고, 꺼지면 닫고 비운다.
 *  그 로봇의 장치 표를 이번 상태 연결에서 받고 go2-identity 가 영구 오류가 아닐 때만 연다. 영구 오류면 구독을 놓고 남은 그림을 버린 채 «신호 없음 — 까닭» */
export function useDriveFeed(robot: string, ch: DriveCh, on = true): DriveFeed {
  const [feed, setFeed] = useState<Raw>(blank), hold = useRef((_g: Gate) => {});
  useEffect(() => {
    const r = epsRobot(robot);
    r.users++;
    return () => { if (!--r.users && EPS.get(robot) === r) EPS.delete(robot); };
  }, [robot]);
  const gate = gateOf(useLive(robot).state, macBody(robot)), now = useRef(gate);
  now.current = gate;
  useEffect(() => {
    if (!on) return;
    let ws: WebSocket | null = null, retry: ReturnType<typeof setTimeout> | undefined, alive = true;
    const ep = (epsRobot(robot).ch[ch] ??= { epoch: null, gone: new Set() });
    let top = -1, pending: MediaPointCloudHeader | null = null, skip = false, ver = 0;   // skip = pending 의 본문은 읽기만 하고 쓰지 않음 — 이미 본 판·지난 epoch 판(RV-443 ④)
    const gone = ep.gone;   // 지난 epoch(에이전트가 켤 때마다 52비트 무작위라 다시 쓰지 않음)
    const put = (p: Partial<Raw>) => setFeed((f) => ({ ...f, ...p }));
    /** drop = 그림까지 버림, 아니면 받은 그림이 있으면 남기고 상태·까닭만 바꾼다 */
    const clear = (state: Feed['state'], why = '', drop = false) => { pending = null; setFeed((f) => (drop || !hasPicture(f) ? { ...blank(state, why), ver: ++ver } : { ...f, state, why })); };
    const close = () => { if (ws) { ws.onmessage = ws.onclose = null; ws.close(1000); ws = null; } clearTimeout(retry); };
    const again = (state: Feed['state'], why = '') => { close(); clear(state, why, state === 'bad'); if (alive && document.visibilityState !== 'hidden') retry = setTimeout(open, RETRY_MS); };
    const frame = (data: unknown) => {
      if (typeof data !== 'string') {   // 점군 바이너리: 바로 앞 media.points 머리와 짝일 때만
        const h = pending, dup = skip; pending = null; skip = false;
        const xyz = ch === 'lidar' && h && data instanceof ArrayBuffer ? pointsBody(data, h) : null;
        // 재전송이어도 모양 검사가 먼저 — odom 판에 필수 pose 가 없으면 약속 위반(RV-448 ③)
        if (!xyz || !h || ((h.frame as string) === 'odom' && !poseOf(h.pose))) return again('bad', '받은 자료가 media/1 약속과 다릅니다');
        if (h.epoch === ep.epoch) top = h.seq;   // 본문까지 받아야 그 순번을 본 것(RV-448 ①) — 지난 epoch 판은 지금 순번을 바꾸지 않음
        if (dup) return;   // 이미 그린 판·버린 판
        return put({ state: 'live', why: '', at: performance.now(), seq: h.seq, frame: h.frame, truncated: h.truncated, xyz, n: h.count, edge: pointsEdge(h), pose: (h.frame as string) === 'odom' ? poseOf(h.pose) : null, ver: ++ver });   // 받은 한 판
      }
      let m: Record<string, unknown>;
      try { m = JSON.parse(data); } catch { return again('bad', '받은 자료를 읽지 못했습니다'); }
      if (pending || m.version !== 'media/1' || m.channel !== ch || m.robot !== robot || !Number.isInteger(m.epoch)) return again('bad', '받은 자료가 media/1 약속과 다릅니다');
      const now0 = m.t === 'media.status' && m.epoch === 0;   // 서버가 붙자마자 보내는 «최근 자료 없음» — 새 시작 아님
      if (!now0 && gone.has(m.epoch as number)) {   // 늦게 온 지난 epoch 판 — 버린다(점군이면 뒤따르는 본문까지, 연결은 그대로 · RV-443 ④)
        if (m.t !== 'media.points' || ch !== 'lidar') return;
        if (!(pending = pointsHeader(m, true))) return again('bad', '받은 자료가 media/1 약속과 다릅니다');
        skip = true; return;
      }
      if (m.epoch !== ep.epoch && !now0) { if (ep.epoch !== null) gone.add(ep.epoch); ep.epoch = m.epoch as number; top = -1; clear('wait', '', true); }   // 로봇 쪽이 새로 시작함 — 지난 그림을 버린다
      if (m.t === 'media.status') return clear('none', reasonText(String(m.reason ?? '')));
      // 같은 epoch 의 같은 순번 = 이미 본 판: 새 소켓이 붙으면 서버가 1초 안의 마지막 판을 다시 보낸다(server drive_media.py viewer — 짧은 OFFLINE 뒤 등).
      // 모양은 그대로 따지고 그림만 바꾸지 않는다(RV-445 ②). 순번이 되돌아감은 약속 위반 — 서버의 마지막 판은 늘 본 것 중 가장 새것이다
      if (!Number.isInteger(m.seq) || (m.seq as number) < Math.max(top, 0)) return again('bad', '순번이 어긋났습니다');
      const seen = m.seq === top;
      // 라이다 머리는 순번을 아직 확정하지 않는다 — 머리만 받고 끊긴 판을 다시 붙어 같은 순번으로 받으면 그린다(RV-448 ①, 중계기는 머리·본문을 따로 보냄)
      if (m.t === 'media.points' && ch === 'lidar' && (pending = pointsHeader(m, true))) { skip = seen; return; }
      top = m.seq as number;
      if (m.t === 'media.video' && ch === 'rgb' && m.mime === 'image/jpeg' && typeof m.jpeg === 'string' && m.jpeg)
        return seen ? undefined : put({ state: 'live', why: '', at: performance.now(), seq: top, img: `data:image/jpeg;base64,${m.jpeg}` });
      const range = m.t === 'media.video' && ch === 'depth' ? depthRange(m) : null;
      if (range && m.mime === 'image/jpeg' && typeof m.jpeg === 'string' && m.jpeg)
        return seen ? undefined : put({ state: 'live', why: '', at: performance.now(), seq: top, img: `data:image/jpeg;base64,${m.jpeg}`, range });
      again('bad', '받은 자료가 media/1 약속과 다릅니다');
    };
    function open() {
      clearTimeout(retry);
      if (!alive || ws || now.current !== 'ok' || document.visibilityState === 'hidden') return;
      const w = ws = new WebSocket(driveMediaUrl(robot, ch));
      w.binaryType = 'arraybuffer';
      w.onmessage = (e: { data?: unknown }) => { if (ws === w) frame(e.data); };
      w.onclose = () => { if (ws === w) { ws = null; again('lost', '연결이 끊겼습니다'); } };
    }
    const vis = () => { if (document.visibilityState === 'hidden') { close(); clear('off'); } else open(); };
    // 장치 표 확인 전·로봇 끊김이면 닫고 받은 그림은 남긴다(«마지막 그림»), 영구 오류면 닫고 그림을 버린다
    hold.current = (g) => { if (g === 'ok') { if (!ws) clear('wait'); return open(); } close(); if (g === 'fault') clear('none', BODY_FAULT, true); else clear('wait', BODY_CHECK); };
    document.addEventListener('visibilitychange', vis);
    hold.current(now.current);
    return () => { alive = false; hold.current = () => {}; close(); document.removeEventListener('visibilitychange', vis); setFeed(blank()); };
  }, [robot, ch, on]);
  useEffect(() => hold.current(gate), [gate]);
  return gate === 'fault' ? blank('none', BODY_FAULT) : feed;
}

/** 지금 그림이 아닌 까닭 — 받는 중이고 새것이면 null */
const whyNot = (f: Feed, at: number) => (f.state !== 'live' ? f.why : at - f.at <= STALE_MS ? null : '2초 넘게 새 자료가 없습니다');
/** 받아 둔 그림(카메라·뎁스 사진 또는 라이다 점)이 있다 */
export const hasPicture = (f: Feed) => f.img !== '' || f.n > 0;

/** 칸에 쓸 한 줄 — 받는 중이고 새것이면 '', 아니면 «카메라/라이다/뎁스 카메라 신호 없음» + 까닭 */
export function driveFeedText(f: Feed, ch: DriveCh, at = performance.now()) {
  const why = whyNot(f, at);
  return why == null ? '' : why ? `${NO_SIGNAL[ch]} — ${why}` : NO_SIGNAL[ch];
}

/** 남겨 둔 마지막 그림 위 표시 «마지막 그림 · N초 전»(+ 까닭 한 줄) — 지금 그림이거나 받은 그림이 없으면 '' */
export function driveFeedHeld(f: Feed, at = performance.now()) {
  const why = whyNot(f, at);
  return why == null || !hasPicture(f) ? '' : `마지막 그림 · ${Math.max(0, Math.floor((at - f.at) / 1000))}초 전${why ? `\n${why}` : ''}`;
}
