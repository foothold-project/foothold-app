// 서버 경유 실기 시험의 카메라·라이다(10-30 SERVER-DRIVE-ADD1 B): 서버 WS /api/v1/robots/{id}/drive-media/{rgb|lidar} — 로그인 쿠키·Origin, 받기만(hello·토큰 없음).
// 내용은 media/1 그대로(media.video · media.points 머리 + 바로 뒤 binary xyz_f32le · media.status). robot·channel 이 다르거나 순서가 어긋나면 그 연결을 닫는다.
// epoch 가 바뀌면 그림을 비우고 순번을 새로 센다. 관측 전용 — 조종·STOP·조종권과 무관. 끊기면 2 s 뒤 다시(화면이 보이고 칸이 떠 있는 동안만)
import { useEffect, useState } from 'react';
import { STALE_MS, pointsBody, pointsHeader, reasonText, type Feed } from './media';
import type { MediaPointCloudHeader } from '../../contracts/ts';

export type DriveCh = 'rgb' | 'lidar';
export const RETRY_MS = 2000;
export const NO_SIGNAL: Record<DriveCh, string> = { rgb: '카메라 신호 없음', lidar: '라이다 신호 없음' };
const blank = (state: Feed['state'] = 'wait', why = ''): Feed => ({ state, why, at: 0, seq: -1, img: '', xyz: new Float32Array(0), n: 0, frame: '', truncated: false, ver: 0 });
export const driveMediaUrl = (robot: string, ch: DriveCh) =>
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v1/robots/${encodeURIComponent(robot)}/drive-media/${ch}`;

/** 이 칸이 떠 있는 동안 그 채널을 받는다 */
export function useDriveFeed(robot: string, ch: DriveCh): Feed {
  const [feed, setFeed] = useState<Feed>(blank);
  useEffect(() => {
    let ws: WebSocket | null = null, retry: ReturnType<typeof setTimeout> | undefined, alive = true;
    let epoch: number | null = null, top = -1, pending: MediaPointCloudHeader | null = null, ver = 0;
    const put = (p: Partial<Feed>) => setFeed((f) => ({ ...f, ...p }));
    const clear = (state: Feed['state'], why = '') => { pending = null; setFeed({ ...blank(state, why), ver: ++ver }); };
    const close = () => { if (ws) { ws.onmessage = ws.onclose = null; ws.close(1000); ws = null; } clearTimeout(retry); };
    const again = (state: Feed['state'], why = '') => { close(); clear(state, why); if (alive && document.visibilityState !== 'hidden') retry = setTimeout(open, RETRY_MS); };
    const frame = (data: unknown) => {
      if (typeof data !== 'string') {   // 점군 바이너리: 바로 앞 media.points 머리와 짝일 때만
        const h = pending; pending = null;
        const xyz = ch === 'lidar' && h && data instanceof ArrayBuffer ? pointsBody(data, h) : null;
        if (!xyz || !h) return again('bad', '받은 자료가 media/1 약속과 다릅니다');
        return put({ state: 'live', why: '', at: performance.now(), seq: h.seq, xyz, n: h.count, frame: h.frame, truncated: h.truncated, ver: ++ver });   // ponytail: 한 스캔만(지도 누적 없음)
      }
      let m: Record<string, unknown>;
      try { m = JSON.parse(data); } catch { return again('bad', '받은 자료를 읽지 못했습니다'); }
      if (pending || m.version !== 'media/1' || m.channel !== ch || m.robot !== robot || !Number.isInteger(m.epoch)) return again('bad', '받은 자료가 media/1 약속과 다릅니다');
      if (m.epoch !== epoch) { epoch = m.epoch as number; top = -1; clear('wait'); }   // 로봇 쪽이 새로 시작함 — 지난 그림을 버린다
      if (m.t === 'media.status') return clear('none', reasonText(String(m.reason ?? '')));
      if (!Number.isInteger(m.seq) || (m.seq as number) <= top) return again('bad', '순번이 어긋났습니다');
      top = m.seq as number;
      if (m.t === 'media.video' && ch === 'rgb' && m.mime === 'image/jpeg' && typeof m.jpeg === 'string' && m.jpeg)
        return put({ state: 'live', why: '', at: performance.now(), seq: top, img: `data:image/jpeg;base64,${m.jpeg}` });
      if (m.t === 'media.points' && ch === 'lidar' && (pending = pointsHeader(m))) return;
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
    return () => { alive = false; close(); document.removeEventListener('visibilitychange', vis); };
  }, [robot, ch]);
  return feed;
}

/** 칸에 쓸 한 줄 — 받는 중이고 새것이면 '', 아니면 «카메라/라이다 신호 없음» + 까닭 */
export function driveFeedText(f: Feed, ch: DriveCh, at = performance.now()) {
  if (f.state === 'live' && at - f.at <= STALE_MS) return '';
  const why = f.state === 'live' ? '2초 넘게 새 자료가 없습니다' : f.why;
  return why ? `${NO_SIGNAL[ch]} — ${why}` : NO_SIGNAL[ch];
}
