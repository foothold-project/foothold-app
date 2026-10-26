// 관측 media/1(apps/agent/foothold_agent/media/README.md): 폰 hello 의 welcome.media 로 채널(rgb·external·lidar)마다 /phone/media/ws 하나 — 받기만, 보내는 것은 media.hello 한 번.
// 토큰은 10초·1회·채널별: 그 채널을 보여 주는 칸이 있을 때만 쓴다. 칸이 모두 내려감·화면 숨김·부모 연결 끊김·robot/epoch 바뀜이면 닫고 지난 자료를 비운다.
// 다시 받으려면 부모 연결을 새로 열어야 한다(토큰 갱신 경로 없음, 자동 재연결 없음). 조종·STOP·조종권과 무관 — 명령·축 입력을 만들지 않는다.
import { useEffect, useSyncExternalStore } from 'react';
import type { MediaChannel, MediaPointCloudHeader, PhoneMediaWelcome } from '../../contracts/ts';
import { phoneUrl } from './phoneTransport';

export const CHANNELS: readonly MediaChannel[] = ['rgb', 'external', 'lidar'];
/** 토큰 수명(에이전트 10 s) · 화면에 쌓아 두는 점 상한 · 이보다 오래 새 프레임이 없으면 «멈춤»(에이전트 NO_VIDEO 는 1 s) */
export const TOKEN_MS = 10_000, MAX_POINTS = 50_000, STALE_MS = 2000;
const POINT_MAX = 4000, ABS_M = 10_000;
/** off 안 봄 · wait 기다림 · live 받는 중 · none 로봇이 못 보냄(reason) · lost 끊김 · expired 토큰 끝(다시 연결 필요) · bad 약속 위반으로 닫음 */
export type FeedState = 'off' | 'wait' | 'live' | 'none' | 'lost' | 'expired' | 'bad';
export type Feed = {
  state: FeedState; why: string; at: number; seq: number;
  /** 영상: data URL */
  img: string;
  /** 점군: xyz(LE float32 를 풀어 둔 것) n 개, frame·truncated, ver = 바뀔 때마다 +1 */
  xyz: Float32Array; n: number; frame: MediaPointCloudHeader['frame'] | ''; truncated: boolean; ver: number;
};
type Binding = Pick<PhoneMediaWelcome, 'robot' | 'epoch' | 'episode_id'>;

/** 에이전트 reason(영문 고정 문구) → 화면 문구. 모르는 것은 원문 그대로 */
const WHY: Record<string, string> = {
  'External camera source is not connected': '외부 카메라 연결 전 — 시뮬 외부 카메라 소스가 아직 연결되지 않았습니다',
  'RGB source is disabled': 'RGB 카메라가 꺼져 있습니다',
  'JPEG decoder (Pillow) is unavailable': '로봇 쪽 JPEG 해독기가 없어 영상을 보낼 수 없습니다',
  'Media binding or worker is unavailable': '로봇 영상 처리가 준비되지 않았습니다',
  'No fresh source sample within 1 second': '1초 넘게 새 자료가 없습니다',
};
export const reasonText = (r: string) => WHY[r] ?? r;
export const NO_MEDIA = '이 로봇은 관측 영상(media/1)을 알리지 않습니다';
const LOST = '영상 연결이 끊겼습니다. 조종·STOP 에는 영향이 없습니다';
const EXPIRED = '영상 연결 권한(10초·1회)이 끝났습니다 — «영상 다시 받기»로 다시 연결하세요';
const BAD = '받은 자료가 media/1 약속과 달라 연결을 닫았습니다';
const HIDDEN = '화면을 숨겨 영상 연결을 닫았습니다 — «영상 다시 받기»로 다시 연결하세요';

const blank = (state: FeedState = 'off', why = ''): Feed => ({ state, why, at: 0, seq: -1, img: '', xyz: new Float32Array(0), n: 0, frame: '', truncated: false, ver: 0 });
let feeds: Record<MediaChannel, Feed> = { rgb: blank(), external: blank(), lidar: blank() };
let offer: { w: PhoneMediaWelcome; address: string; at: number; used: Set<MediaChannel> } | null = null;
const socks = new Map<MediaChannel, WebSocket>(), want = new Map<MediaChannel, number>();
let pending: MediaPointCloudHeader | null = null, mapVer: string | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
const put = (ch: MediaChannel, p: Partial<Feed>) => { feeds = { ...feeds, [ch]: { ...feeds[ch], ...p } }; emit(); };
const now = () => performance.now();
const same = (a: Binding, b: Binding) => a.robot === b.robot && a.epoch === b.epoch && a.episode_id === b.episode_id;

/** 자리 비우기(그림·점 0) + 상태 */
function clear(ch: MediaChannel, state: FeedState, why = '') {
  if (ch === 'lidar') { pending = null; mapVer = null; }
  feeds = { ...feeds, [ch]: { ...blank(state, why), ver: feeds[ch].ver + 1 } }; emit();
}
function shut(ch: MediaChannel, state: FeedState, why = '') {
  const w = socks.get(ch); socks.delete(ch);
  if (w) { w.onclose = null; w.onmessage = null; w.close(1000); }
  clear(ch, state, why);
}

/** 점군 머리(JSON) 검사 — 맞으면 그 머리, 아니면 null */
export function pointsHeader(m: Record<string, unknown>): MediaPointCloudHeader | null {
  const n = m.count;
  return m.channel === 'lidar' && m.source === 'l1' && m.encoding === 'xyz_f32le' && (m.frame === 'map' || m.frame === 'lidar_link')
    && typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= POINT_MAX && m.byte_length === n * 12 && typeof m.truncated === 'boolean'
    && Number.isInteger(m.seq) ? m as unknown as MediaPointCloudHeader : null;
}
/** 바이너리 → xyz(LE float32). 길이·유한·좌표 범위가 어긋나면 null(그 스캔을 받지 않음) */
export function pointsBody(buf: ArrayBuffer, h: MediaPointCloudHeader): Float32Array | null {
  if (buf.byteLength !== h.byte_length) return null;
  const v = new DataView(buf), out = new Float32Array(h.count * 3);
  for (let i = 0; i < out.length; i++) {
    const x = v.getFloat32(i * 4, true);
    if (!Number.isFinite(x) || Math.abs(x) > ABS_M) return null;
    out[i] = x;
  }
  return out;
}

function onFrame(ch: MediaChannel, data: unknown) {
  const o = offer; if (!o) return;
  const fail = () => shut(ch, 'bad', BAD);
  if (typeof data !== 'string') {   // 점군 바이너리: 바로 앞 media.points 머리와 짝일 때만
    if (ch !== 'lidar' || !(data instanceof ArrayBuffer)) return fail();
    const h = pending; pending = null;
    if (!h) return fail();
    const xyz = pointsBody(data, h);
    if (!xyz) return fail();
    const f = feeds.lidar;
    // 센서 기준(lidar_link)은 한 스캔만. 지도 기준(map)만 같은 지도 판 안에서 MAX_POINTS 까지 쌓는다(오래된 점부터 버림)
    let all = xyz;
    if (h.frame === 'map' && f.frame === 'map' && mapVer === h.map_version_id) {
      const keep = Math.max(0, Math.min(f.n, MAX_POINTS - h.count));
      all = new Float32Array((keep + h.count) * 3);
      all.set(f.xyz.subarray((f.n - keep) * 3, f.n * 3)); all.set(xyz, keep * 3);
    }
    mapVer = h.frame === 'map' ? h.map_version_id : null;
    return put('lidar', { state: 'live', why: '', at: now(), seq: h.seq, xyz: all, n: all.length / 3, frame: h.frame, truncated: h.truncated, ver: f.ver + 1 });
  }
  let m: Record<string, unknown>;
  try { m = JSON.parse(data); } catch { return fail(); }
  // 점군 연결에서 머리 뒤에는 바이너리 한 개만 — 그 사이 다른 글 프레임은 약속 위반(다른 채널 연결은 따로 와서 끼어들 수 있음). 결속(robot·epoch·episode)·채널·판이 hello 와 다르면 버리고 닫는다
  if ((ch === 'lidar' && pending) || m.version !== 'media/1' || m.channel !== ch || !same(m as unknown as Binding, o.w)) return fail();
  if (m.t === 'media.status') return clear(ch, 'none', reasonText(String(m.reason ?? '')));
  if (typeof m.seq === 'number' && m.seq <= feeds[ch].seq) return fail();   // 채널마다 늘어나는 순번
  if (m.t === 'media.video' && ch !== 'lidar') {
    if (m.mime !== 'image/jpeg' || typeof m.jpeg !== 'string' || !m.jpeg || !Number.isInteger(m.seq)) return fail();
    return put(ch, { state: 'live', why: '', at: now(), seq: m.seq as number, img: `data:image/jpeg;base64,${m.jpeg}` });
  }
  if (m.t === 'media.points' && ch === 'lidar') { pending = pointsHeader(m); if (pending) return; }
  fail();
}

function open(ch: MediaChannel) {
  const o = offer!, cap = o.w[ch], url = phoneUrl(o.address, location, 'media');
  if (!url) return clear(ch, 'lost', LOST);
  o.used.add(ch);   // 열기 시도만으로 토큰을 쓴 것으로 본다(일회)
  const w = new WebSocket(url), b = { robot: o.w.robot, epoch: o.w.epoch, episode_id: o.w.episode_id };
  w.binaryType = 'arraybuffer';
  socks.set(ch, w);
  put(ch, { state: 'wait', why: '' });
  w.onopen = () => { if (socks.get(ch) === w) w.send(JSON.stringify({ t: 'media.hello', version: 'media/1', ...b, channel: ch, token: cap.token })); };
  w.onmessage = (e: { data?: unknown }) => { if (socks.get(ch) === w) onFrame(ch, e.data); };
  w.onclose = () => { if (socks.get(ch) === w) { socks.delete(ch); clear(ch, 'lost', LOST); } };
}

/** 보는 칸이 있고 화면이 보이면 열고, 아니면 닫는다 */
function sync() {
  const shown = document.visibilityState !== 'hidden';
  for (const ch of CHANNELS) {
    const on = shown && (want.get(ch) ?? 0) > 0, w = socks.get(ch);
    if (!on && w) shut(ch, 'expired', shown ? EXPIRED : HIDDEN);
    if (!on || w || !offer) continue;
    const cap = offer.w[ch];
    if (!cap.available || !cap.token) continue;   // none + reason 은 offer 때 이미
    if (offer.used.has(ch) || now() - offer.at >= TOKEN_MS) { if (!needsRelink(feeds[ch])) clear(ch, 'expired', EXPIRED); continue; }
    open(ch);
  }
}
const onVis = () => sync();

export const media = {
  get: () => feeds,
  subscribe(f: () => void) { subs.add(f); return () => { subs.delete(f); }; },
  /** 부모 hello 를 받았을 때(phone.ts). w 가 없으면 이 로봇은 media/1 을 알리지 않음 */
  offer(w: PhoneMediaWelcome | undefined, address: string) {
    for (const ch of CHANNELS) shut(ch, 'off');
    offer = w ? { w, address, at: now(), used: new Set() } : null;
    for (const ch of CHANNELS) clear(ch, !w ? 'none' : w[ch].available ? 'wait' : 'none', !w ? NO_MEDIA : w[ch].available ? '' : reasonText(w[ch].reason));
    document.removeEventListener('visibilitychange', onVis); document.addEventListener('visibilitychange', onVis);
    sync();
  },
  /** 부모 연결이 끝남(phone.ts drop) — 모두 닫고 비움 */
  reset() {
    offer = null; document.removeEventListener('visibilitychange', onVis);
    for (const ch of CHANNELS) shut(ch, 'off');
  },
  /** 이 채널을 로봇이 media/1 로 보낼 수 있다고 알렸나(RGB 를 옛 카메라 경로로 받을지 정할 때) */
  has: (ch: MediaChannel) => !!offer?.w[ch].available,
  /** 지금 결속(시점 중계 요청에 싣는다) */
  binding: (): Binding | null => offer && { robot: offer.w.robot, epoch: offer.w.epoch, episode_id: offer.w.episode_id },
  want(ch: MediaChannel, d: 1 | -1) { want.set(ch, Math.max(0, (want.get(ch) ?? 0) + d)); sync(); },
};

/** 이 칸이 보이는 동안 그 채널을 받는다(on=false 면 안 받음). 내려가면 닫힌다 */
export function useFeed(ch: MediaChannel, on = true) {
  useEffect(() => { if (!on) return; media.want(ch, 1); return () => media.want(ch, -1); }, [ch, on]);
  return useSyncExternalStore(media.subscribe, media.get)[ch];
}
/** 칸에 쓸 한 줄 — 받는 중이고 새것이면 '' */
export function feedText(f: Feed, ch: MediaChannel, at = now()) {
  if (f.state === 'live') return at - f.at > STALE_MS ? '2초 넘게 새 자료가 없습니다(멈춤)' : '';
  return f.state === 'off' || f.state === 'wait' ? (ch === 'lidar' ? '점군 기다리는 중' : '영상 기다리는 중') : f.why || LOST;
}
/** «영상 다시 받기»가 필요한 상태(새 토큰은 부모 연결을 다시 열어야 받음) */
export const needsRelink = (f: Feed) => f.state === 'expired' || f.state === 'lost' || f.state === 'bad';
