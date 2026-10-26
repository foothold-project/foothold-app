// 관측 media/1 수신(media.ts) — WebSocket 은 FakeWS(진짜 연결 0). 메시지 검사·points 짝 순서·토큰 일회·해지·capability 불가 이유.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhoneMediaWelcome } from '../../../contracts/ts';
import { MAX_POINTS, NO_MEDIA, TOKEN_MS, feedText, media, pointsBody, pointsHeader } from '../media';
import { FakeWS } from './fakeWs';

const R = '11111111-1111-4111-8111-111111111111', EP = '33333333-3333-4333-8333-333333333333', ADDR = 'ws://127.0.0.1:9433/phone/ws';
const tok = (c: string) => c.repeat(43);
const welcome = (p: Partial<PhoneMediaWelcome> = {}): PhoneMediaWelcome => ({ version: 'media/1', path: '/phone/media/ws', robot: R, epoch: 4, episode_id: EP,
  rgb: { available: true, reason: 'Ready', token: tok('r') }, external: { available: false, reason: 'External camera source is not connected', token: null },
  lidar: { available: true, reason: 'Ready', token: tok('l') }, ...p });
const bind = { robot: R, epoch: 4, episode_id: EP, version: 'media/1' };
const video = (seq: number, p = {}) => ({ t: 'media.video', ...bind, channel: 'rgb', source: 'd435i_rgb', seq, captured_at: '2026-10-26T00:00:00Z', frame: 'camera', mime: 'image/jpeg', width: 2, height: 2, jpeg: 'AAAA', ...p });
const head = (seq: number, count: number, p = {}) => ({ t: 'media.points', ...bind, channel: 'lidar', source: 'l1', seq, captured_at: '2026-10-26T00:00:00Z', frame: 'lidar_link',
  map_version_id: null, pose: null, count, truncated: false, encoding: 'xyz_f32le', byte_length: count * 12, ...p });
const xyz = (...v: number[]) => { const b = new ArrayBuffer(v.length * 4), d = new DataView(b); v.forEach((x, i) => d.setFloat32(i * 4, x, true)); return b; };
const sock = (ch: string) => FakeWS.all.filter((w) => w.url.endsWith('/phone/media/ws') && (w.sent[0] as { channel?: string } | undefined)?.channel === ch).pop()!;
const bin = (w: FakeWS, b: ArrayBuffer) => (w.onmessage as (e: { data: unknown }) => void)({ data: b });
const F = () => media.get();
let off: (() => void)[] = [];
const want = (ch: 'rgb' | 'external' | 'lidar') => { media.want(ch, 1); off.push(() => media.want(ch, -1)); };
const openAll = () => FakeWS.all.forEach((w) => { w.auto = null; w.open(); });   // 미디어 서버는 hello 에 답하지 않는다

beforeEach(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); });
afterEach(() => { off.forEach((f) => f()); off = []; media.reset(); vi.restoreAllMocks(); });

describe('media/1 수신', () => {
  it('보는 칸이 있는 채널만 열고, hello 에 결속·채널·토큰 — 불가 채널은 열지 않고 reason 을 그대로(한국어)', () => {
    want('rgb'); want('external'); want('lidar');
    media.offer(welcome(), ADDR);
    expect(FakeWS.all.map((w) => w.url)).toEqual(['ws://127.0.0.1:9433/phone/media/ws', 'ws://127.0.0.1:9433/phone/media/ws']);
    openAll();
    expect(FakeWS.all[0].sent[0]).toEqual({ t: 'media.hello', version: 'media/1', robot: R, epoch: 4, episode_id: EP, channel: 'rgb', token: tok('r') });
    expect(FakeWS.all[1].sent[0]).toMatchObject({ channel: 'lidar', token: tok('l') });
    expect(F().external.state).toBe('none');
    expect(feedText(F().external, 'external')).toBe('외부 카메라 연결 전 — 시뮬 외부 카메라 소스가 아직 연결되지 않았습니다');
    media.offer(undefined, ADDR);
    expect(feedText(F().rgb, 'rgb')).toBe(NO_MEDIA);
  });

  it('media.video → 그림, status → 비우고 이유, 다른 결속·채널·줄지 않는 seq 는 닫고 비움', () => {
    want('rgb'); media.offer(welcome(), ADDR); openAll();
    const w = sock('rgb');
    w.recv(video(1));
    expect(F().rgb).toMatchObject({ state: 'live', img: 'data:image/jpeg;base64,AAAA' });
    expect(feedText(F().rgb, 'rgb')).toBe('');
    expect(feedText(F().rgb, 'rgb', performance.now() + 2500)).toContain('멈춤');
    w.recv({ t: 'media.status', ...bind, channel: 'rgb', state: 'NO_VIDEO', reason: 'No fresh source sample within 1 second' });
    expect(F().rgb).toMatchObject({ state: 'none', img: '' });
    w.recv(video(2));
    for (const bad of [video(1), video(9, { epoch: 5 }), video(9, { robot: '22222222-2222-4222-8222-222222222222' }), video(9, { channel: 'external' }), video(9, { mime: 'image/png' })]) {
      media.offer(welcome(), ADDR); openAll();
      const x = sock('rgb'); x.recv(video(5)); x.recv(bad);
      expect(F().rgb).toMatchObject({ state: 'bad', img: '' });
      expect(x.readyState).toBe(3);
    }
  });

  it('points: 머리 다음 바이너리 한 개만 짝 — 순서·길이·유한·범위가 어긋나면 그 연결을 닫고 비움', () => {
    want('lidar'); media.offer(welcome(), ADDR); openAll();
    let w = sock('lidar');
    w.recv(head(1, 2)); bin(w, xyz(1, 2, 3, 4, 5, 6));
    expect(F().lidar).toMatchObject({ state: 'live', n: 2, frame: 'lidar_link' });
    expect([...F().lidar.xyz]).toEqual([1, 2, 3, 4, 5, 6]);
    w.recv(head(2, 1)); bin(w, xyz(7, 8, 9));
    expect(F().lidar.n).toBe(1);   // 센서 기준은 한 스캔만(누적 아님)
    const cases: ((w: FakeWS) => void)[] = [
      (x) => bin(x, xyz(1, 2, 3)),                                  // 머리 없는 바이너리
      (x) => { x.recv(head(9, 1)); x.recv(head(10, 1)); },         // 머리 뒤 글 프레임(짝 깨짐)
      (x) => { x.recv(head(9, 2)); bin(x, xyz(1, 2, 3)); },        // 길이 다름
      (x) => { x.recv(head(9, 1)); bin(x, xyz(1, NaN, 3)); },      // 유한 아님
      (x) => { x.recv(head(9, 1)); bin(x, xyz(1, 2, 20000)); },    // 범위 밖
      (x) => x.recv(head(9, 2, { byte_length: 12 })),               // 머리 길이 불일치
      (x) => x.recv(head(9, 4001)),                                 // 점 상한 초과
    ];
    for (const c of cases) {
      media.offer(welcome(), ADDR); openAll(); w = sock('lidar');
      w.recv(head(1, 1)); bin(w, xyz(1, 1, 1));
      c(w);
      expect(F().lidar).toMatchObject({ state: 'bad', n: 0 });
      expect(w.readyState).toBe(3);
    }
  });

  it('점군 머리와 바이너리 사이에 다른 채널(영상) 프레임이 끼어도 둘 다 받음 — 짝은 점군 연결 안에서만', () => {
    want('rgb'); want('lidar'); media.offer(welcome(), ADDR); openAll();
    const l = sock('lidar'), r = sock('rgb');
    l.recv(head(1, 1));
    r.recv(video(1));
    bin(r, xyz(0, 0, 0));          // 영상 연결의 바이너리는 그 연결만 닫고 점군 짝은 그대로
    bin(l, xyz(1, 2, 3));
    expect(F().rgb.state).toBe('bad');
    expect(F().lidar).toMatchObject({ state: 'live', n: 1 });
  });

  it('지도 기준(map)만 같은 판 안에서 쌓고 상한(5만)을 넘지 않으며, 판이 바뀌면 새로', () => {
    expect(pointsHeader(head(1, 4000))).not.toBeNull();
    want('lidar'); media.offer(welcome(), ADDR); openAll();
    const w = sock('lidar'), many = new Array(4000 * 3).fill(1);
    for (let i = 1; i <= 14; i++) { w.recv(head(i, 4000, { frame: 'map', map_version_id: 'v1' })); bin(w, xyz(...many)); }
    expect(F().lidar.n).toBe(MAX_POINTS);
    w.recv(head(15, 1, { frame: 'map', map_version_id: 'v2' })); bin(w, xyz(1, 2, 3));
    expect(F().lidar.n).toBe(1);
    expect(pointsBody(xyz(1, 2), head(1, 1) as never)).toBeNull();
  });

  it('토큰은 일회·10초: 칸을 내렸다 다시 올리거나 10초 뒤 처음 올리면 열지 않고 «다시 받기»', () => {
    let t = 1000; vi.spyOn(performance, 'now').mockImplementation(() => t);
    media.offer(welcome(), ADDR);
    media.want('rgb', 1); openAll();
    expect(FakeWS.all).toHaveLength(1);
    media.want('rgb', -1);
    expect(FakeWS.all[0].readyState).toBe(3);
    expect(F().rgb).toMatchObject({ state: 'expired', img: '' });
    media.want('rgb', 1);
    expect(FakeWS.all).toHaveLength(1);   // 같은 토큰으로 다시 열지 않음
    media.want('rgb', -1);
    t += TOKEN_MS;
    media.want('lidar', 1);
    expect(FakeWS.all).toHaveLength(1);
    expect(F().lidar.state).toBe('expired');
    media.want('lidar', -1);
  });

  it('화면 숨김·부모 끊김·새 결속이면 닫고 지난 그림을 비운다', () => {
    want('rgb'); media.offer(welcome(), ADDR); openAll();
    sock('rgb').recv(video(1));
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(F().rgb).toMatchObject({ state: 'expired', img: '' });
    expect(FakeWS.all[0].readyState).toBe(3);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(FakeWS.all).toHaveLength(1);
    media.offer(welcome({ epoch: 5 }), ADDR); openAll();
    sock('rgb').recv(video(1, { epoch: 5 }));
    expect(F().rgb.state).toBe('live');
    media.offer(welcome({ epoch: 6 }), ADDR);
    expect(F().rgb.img).toBe('');                       // 새 결속 — 옛 그림 0
    media.reset();
    expect(FakeWS.all.every((w) => w.readyState === 3)).toBe(true);
    expect(F().rgb.state).toBe('off');
  });

  it('부모 주소가 /phone/ws 가 아니면(임의 경로 중계 0) 열지 않고 끊김 — 원격·포트 거부는 phoneTransport 시험', () => {
    want('rgb');
    media.offer(welcome(), 'ws://127.0.0.1:9433/api/v1/ws');
    expect(FakeWS.all).toHaveLength(0);
    expect(F().rgb.state).toBe('lost');
  });
});
