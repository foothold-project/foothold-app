// 서버 경유 실기 시험의 카메라·라이다·뎁스(10-30 SERVER-DRIVE-ADD1 B · 11-12 RB-DEPTH): 서버 WS /api/v1/robots/{id}/drive-media/{rgb|lidar|depth} — 로그인 쿠키·Origin, 받기만(hello·토큰 없음).
// 내용은 media/1 그대로(media.video · media.points 머리 + 바로 뒤 binary xyz_f32le · media.status). robot·channel 이 다르거나 순서가 어긋나면 그 연결을 닫는다.
// 라이다 frame 'odom'(11-13 RB-MAP-VIEW-WEB: 점이 이미 로봇이 처음 켜진 곳 기준 + pose)이면 버리지 않고 쌓는다(stack) — lidar_link 는 지금처럼 한 장씩.
// epoch 가 바뀌면 그림(쌓은 것 포함)을 비우고 순번을 새로 센다. 관측 전용 — 조종·STOP·조종권과 무관. 끊기면 2 s 뒤 다시(화면이 보이고 칸이 떠 있는 동안만)
import { useEffect, useRef, useState } from 'react';
import { STALE_MS, pointsBody, pointsHeader, reasonText, type Feed } from './media';
import type { MediaPointCloudHeader } from '../../contracts/ts';

export type DriveCh = 'rgb' | 'lidar' | 'depth';
/** 뎁스: 색 범위(m) — 가까움 빨강 min · 멀리 파랑 max. 다른 채널은 null */
export type Pose = { x: number; y: number; z: number; yaw: number };
/** pose·path = 쌓는 지도일 때 로봇 위치·지나온 길(x,y 를 이어 붙인 것), wipe = «처음부터 다시»(화면에 쌓은 것만 지움) */
export type DriveFeed = Feed & { range: [number, number] | null; pose: Pose | null; path: number[]; wipe: () => void };
type Raw = Omit<DriveFeed, 'wipe'>;
/** 쌓는 칸 크기(m) · 쌓는 점 상한 · 길 꼭짓점 상한 · 로봇보다 이만큼 높은 점(천장)은 위에서 본 그림을 덮으므로 쌓지 않음 */
export const CELL_M = 0.05, STACK_MAX = 200_000, PATH_MAX = 5000, CEIL_M = 1.2;
/** 쌓는 지도: 5 cm 칸(x·y·z)에 점 하나만, cap 을 넘으면 가장 오래된 점부터 덮어쓴다. xyz 는 한 버퍼를 계속 씀(앞 n 개가 유효) */
export function stack(cap = STACK_MAX) {
  const xyz = new Float32Array(cap * 3), keys = new Float64Array(cap), seen = new Set<number>(), path: number[] = [];
  let total = 0;
  return {
    xyz, path,
    get n() { return Math.min(total, cap); },
    add(pts: Float32Array, pose: Pose) {
      for (let i = 0; i + 2 < pts.length; i += 3) {
        const x = pts[i], y = pts[i + 1], z = pts[i + 2], iz = Math.floor(z / CELL_M) + 1024;
        if (z > pose.z + CEIL_M || iz < 0 || iz > 2047) continue;
        const k = ((Math.floor(x / CELL_M) + 2 ** 20) * 2 ** 21 + Math.floor(y / CELL_M) + 2 ** 20) * 2048 + iz;   // |x|,|y| ≤ 10 km(pointsBody) → 53비트 안
        if (seen.has(k)) continue;
        const w = total++ % cap;
        if (total > cap) seen.delete(keys[w]);
        seen.add(k); keys[w] = k; xyz[w * 3] = x; xyz[w * 3 + 1] = y; xyz[w * 3 + 2] = z;
      }
      const m = path.length;
      if (!m || Math.hypot(pose.x - path[m - 2], pose.y - path[m - 1]) >= CELL_M) { path.push(pose.x, pose.y); if (path.length > PATH_MAX * 2) path.splice(0, 2); }
    },
  };
}
const poseOf = (p: unknown): Pose | null => {
  const q = p as Pose | null;
  return q && [q.x, q.y, q.z, q.yaw].every((v) => typeof v === 'number' && Number.isFinite(v)) ? { x: q.x, y: q.y, z: q.z, yaw: q.yaw } : null;
};
export const RETRY_MS = 2000;
export const DEPTH_HINT = '뎁스 카메라 영상이 아직 오지 않습니다. 노트북 화면의 «보이는 영상 목록»을 확인하세요';
export const NO_SIGNAL: Record<DriveCh, string> = { rgb: '카메라 신호 없음', lidar: '라이다 신호 없음', depth: '뎁스 카메라 신호 없음' };
const blank = (state: Feed['state'] = 'wait', why = ''): Raw => ({ state, why, at: 0, seq: -1, img: '', xyz: new Float32Array(0), n: 0, frame: '', truncated: false, ver: 0, range: null, pose: null, path: [] });
/** 계약 depth_min_m·depth_max_m: 유한·0≤min<max≤10000 — 아니면 null(RGB 를 뎁스로 보여 주지 않음) */
const depthRange = (m: Record<string, unknown>): [number, number] | null => {
  const a = m.depth_min_m, b = m.depth_max_m;
  return m.source === 'go2_depth' && typeof a === 'number' && typeof b === 'number' && Number.isFinite(a) && Number.isFinite(b) && a >= 0 && a < b && b <= 10_000 ? [a, b] : null;
};
export const driveMediaUrl = (robot: string, ch: DriveCh) =>
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v1/robots/${encodeURIComponent(robot)}/drive-media/${ch}`;

/** 이 칸이 떠 있는 동안(on) 그 채널을 받는다 — on=false 면 열지 않고, 꺼지면 닫고 비운다 */
export function useDriveFeed(robot: string, ch: DriveCh, on = true): DriveFeed {
  const [feed, setFeed] = useState<Raw>(blank), wipe = useRef(() => {});
  useEffect(() => {
    if (!on) return;
    let st: ReturnType<typeof stack> | null = null;   // 쌓는 지도 — 끊겼다 다시 붙어도 남고, epoch 바뀜·«처음부터 다시»·lidar_link 로 돌아가면 버린다
    wipe.current = () => { st = null; setFeed((f) => ({ ...f, xyz: new Float32Array(0), n: 0, pose: null, path: [], ver: ++ver })); };
    let ws: WebSocket | null = null, retry: ReturnType<typeof setTimeout> | undefined, alive = true;
    let epoch: number | null = null, top = -1, pending: MediaPointCloudHeader | null = null, ver = 0;
    const put = (p: Partial<Raw>) => setFeed((f) => ({ ...f, ...p }));
    const clear = (state: Feed['state'], why = '') => { pending = null; setFeed({ ...blank(state, why), ver: ++ver }); };
    const close = () => { if (ws) { ws.onmessage = ws.onclose = null; ws.close(1000); ws = null; } clearTimeout(retry); };
    const again = (state: Feed['state'], why = '') => { close(); clear(state, why); if (alive && document.visibilityState !== 'hidden') retry = setTimeout(open, RETRY_MS); };
    const frame = (data: unknown) => {
      if (typeof data !== 'string') {   // 점군 바이너리: 바로 앞 media.points 머리와 짝일 때만
        const h = pending; pending = null;
        const xyz = ch === 'lidar' && h && data instanceof ArrayBuffer ? pointsBody(data, h) : null;
        if (!xyz || !h) return again('bad', '받은 자료가 media/1 약속과 다릅니다');
        const live = { state: 'live' as const, why: '', at: performance.now(), seq: h.seq, frame: h.frame, truncated: h.truncated };
        if ((h.frame as string) !== 'odom') { st = null; return put({ ...live, xyz, n: h.count, pose: null, path: [], ver: ++ver }); }   // 로봇 중심 한 장
        const pose = poseOf(h.pose);
        if (!pose) return again('bad', '받은 자료가 media/1 약속과 다릅니다');
        (st ??= stack()).add(xyz, pose);
        return put({ ...live, xyz: st.xyz, n: st.n, pose, path: st.path, ver: ++ver });
      }
      let m: Record<string, unknown>;
      try { m = JSON.parse(data); } catch { return again('bad', '받은 자료를 읽지 못했습니다'); }
      if (pending || m.version !== 'media/1' || m.channel !== ch || m.robot !== robot || !Number.isInteger(m.epoch)) return again('bad', '받은 자료가 media/1 약속과 다릅니다');
      if (m.epoch !== epoch) { epoch = m.epoch as number; top = -1; st = null; clear('wait'); }   // 로봇 쪽이 새로 시작함 — 지난 그림을 버린다
      if (m.t === 'media.status') return clear('none', reasonText(String(m.reason ?? '')));
      if (!Number.isInteger(m.seq) || (m.seq as number) <= top) return again('bad', '순번이 어긋났습니다');
      top = m.seq as number;
      if (m.t === 'media.video' && ch === 'rgb' && m.mime === 'image/jpeg' && typeof m.jpeg === 'string' && m.jpeg)
        return put({ state: 'live', why: '', at: performance.now(), seq: top, img: `data:image/jpeg;base64,${m.jpeg}` });
      const range = m.t === 'media.video' && ch === 'depth' ? depthRange(m) : null;
      if (range && m.mime === 'image/jpeg' && typeof m.jpeg === 'string' && m.jpeg)
        return put({ state: 'live', why: '', at: performance.now(), seq: top, img: `data:image/jpeg;base64,${m.jpeg}`, range });
      if (m.t === 'media.points' && ch === 'lidar' && (pending = pointsHeader(m, true))) return;
      again('bad', '받은 자료가 media/1 약속과 다릅니다');
    };
    function open() {
      clearTimeout(retry);
      if (!alive || ws || document.visibilityState === 'hidden') return;
      const w = ws = new WebSocket(driveMediaUrl(robot, ch));
      w.binaryType = 'arraybuffer';
      w.onmessage = (e: { data?: unknown }) => { if (ws === w) frame(e.data); };
      w.onclose = () => { if (ws === w) { ws = null; again('lost', '연결이 끊겼습니다'); } };
    }
    const vis = () => { if (document.visibilityState === 'hidden') { close(); clear('off'); } else open(); };
    document.addEventListener('visibilitychange', vis);
    open();
    return () => { alive = false; close(); document.removeEventListener('visibilitychange', vis); setFeed(blank()); };
  }, [robot, ch, on]);
  return { ...feed, wipe: () => wipe.current() };
}

/** 칸에 쓸 한 줄 — 받는 중이고 새것이면 '', 아니면 «카메라/라이다/뎁스 카메라 신호 없음» + 까닭 */
export function driveFeedText(f: Feed, ch: DriveCh, at = performance.now()) {
  if (f.state === 'live' && at - f.at <= STALE_MS) return '';
  const why = f.state === 'live' ? '2초 넘게 새 자료가 없습니다' : f.why;
  return why ? `${NO_SIGNAL[ch]} — ${why}` : NO_SIGNAL[ch];
}
