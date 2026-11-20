// RB-USLAM-WEB: «로봇 지도»(slamview.tsx) — PR #459 예시 형식의 slam·slam_pose 를 가짜 서버 WS 로 흘려: 점·로봇·길, 2.5초 멈춤·NO_SLAM 이면 안내, 형식 이상 판 무시,
// epoch 바뀜·재연결 비움, 숨은 탭 소켓 닫힘, 받기만(보내는 것 0). jsdom 엔 WebGL 이 없어 three 의 WebGLRenderer 만 가짜(그림은 headless Chrome 캡처 runs/qa-rb-uslam-web).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeWS, state } from './fakeWs';
import { rt } from '../rt';
import { RETRY_MS } from '../drivemedia';
import { GONE_MS, MapPick, SLAM_HINT, slamHeader, slamPose } from '../slamview';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('three', async (orig) => {
  const T = await orig<typeof import('three')>();
  class FakeRenderer {
    domElement = document.createElement('canvas');
    setPixelRatio() {} setSize() {} dispose() {} forceContextLoss() {} render() {}
  }
  return { ...T, WebGLRenderer: FakeRenderer };
});

const R = '00000000-0000-0000-0000-000000000001';
let root: Root | null = null, box: HTMLDivElement;
const $ = (s: string) => box.querySelector<HTMLElement>(s);
const tick = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
const sock = (ch: string) => FakeWS.all.filter((x) => x.url.endsWith(`/api/v1/robots/${R}/drive-media/${ch}`)).pop()!;
const head = (p: object = {}) => ({ t: 'media.slam_points', version: 'media/1', robot: R, epoch: 8, episode_id: null, channel: 'slam', seq: 1, captured_at: '2026-11-20T00:00:00Z',
  source: 'rt/uslam/frontend/cloud_world_ds', frame: 'world', count: 2, encoding: 'xyz_f32le', byte_length: 24, truncated: false, ...p });
const pose = (p: object = {}) => ({ t: 'media.slam_pose', version: 'media/1', robot: R, epoch: 8, episode_id: null, channel: 'slam_pose', seq: 1, captured_at: '2026-11-20T00:00:00Z',
  source: 'rt/uslam/frontend/odom', frame: 'world', child_frame: 'base_link', pose: { x: 1, y: 2, z: 0.3, yaw: 0.5 }, ...p });
const body = (n = 2, v = 1) => new Float32Array(n * 3).fill(v).buffer;
const bin = (w: FakeWS, b: ArrayBuffer) => act(() => { (w.onmessage as (e: { data: unknown }) => void)?.({ data: b }); });
/** 점군 한 판(머리 + 본문) */
const scan = (p: object = {}, b = body()) => { const w = sock('slam'); act(() => { w.recv(head(p)); }); bin(w, b); };
const n = () => Number($('[data-slam-view]')?.getAttribute('data-slam-view') ?? 0);
const pick = (k: 'ours' | 'robot') => $(`[data-pick="${k}"]`) as HTMLButtonElement;

function mount(ours = true) {
  box = document.createElement('div'); document.body.append(box); root = createRoot(box);
  rt.connect([R]);
  const w = FakeWS.all.filter((x) => x.url.endsWith('/api/v1/ws')).pop()!;
  act(() => { w.open(); w.recv(state(R)); });
  act(() => { root!.render(<MapPick robot={R} ours={ours ? <div data-ours>우리</div> : null} />); });
  act(() => { sock('slam').open(); sock('slam_pose').open(); });
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(500);
});
afterEach(() => {
  act(() => root?.unmount()); root = null; box?.remove(); rt.disconnect(); vi.useRealTimers(); vi.restoreAllMocks();
  delete (document as { visibilityState?: string }).visibilityState;
});

describe('로봇 지도', () => {
  it('계약 형식 검사: 예시 머리·위치는 받고, 틀린 것은 null', () => {
    expect(slamHeader(head())).not.toBeNull();
    expect(slamHeader(head({ byte_length: 12 }))).toBeNull();
    expect(slamHeader(head({ count: 4001, byte_length: 4001 * 12 }))).toBeNull();
    expect(slamHeader(head({ encoding: 'xyz_f64le' }))).toBeNull();
    expect(slamPose(pose())).toEqual([{ x: 1, y: 2, z: 0.3, yaw: 0.5 }, true]);
    expect(slamPose(pose({ source: 'rt/uslam/localization/odom' }))![1]).toBe(false);
    expect(slamPose(pose({ pose: { x: 1, y: 2, z: NaN, yaw: 0 } }))).toBeNull();
  });

  it('처음엔 «우리 지도», 로봇 지도 단추는 점이 오기 전엔 꺼짐 — 오면 켜지고 점·로봇·길이 보인다, 받기만', () => {
    mount();
    expect($('[data-map-pick]')!.dataset.mapPick).toBe('ours'); expect($('[data-ours]')).not.toBeNull();
    expect(pick('robot').disabled).toBe(true); expect(pick('robot').title).toBe(SLAM_HINT);
    act(() => { sock('slam_pose').recv(pose()); });
    expect(pick('robot').disabled).toBe(true);   // 위치만으로는 지도가 없다
    scan();
    expect(pick('robot').disabled).toBe(false);
    act(() => { pick('robot').click(); });
    expect($('[data-ours]')).toBeNull(); expect(n()).toBe(2); expect($('[data-slam-view]')!.hasAttribute('data-slam-robot')).toBe(true);
    act(() => { sock('slam_pose').recv(pose({ seq: 2, pose: { x: 2, y: 2, z: 0.3, yaw: 0 } })); });
    expect($('[data-slam-view]')!.dataset.slamPath).toBe('2');
    act(() => { sock('slam_pose').recv(pose({ seq: 3, source: 'rt/uslam/localization/odom' })); });   // 저장 지도 위 위치 찾기 — 길 없음
    expect($('[data-slam-view]')!.dataset.slamPath).toBe('0');
    expect(sock('slam').sent.length + sock('slam_pose').sent.length).toBe(0);
  });

  it('판마다 교체(기본): 다음 판이 오면 그 판의 점만', () => {
    mount(); scan(); act(() => { pick('robot').click(); });
    scan({ seq: 2, count: 3, byte_length: 36 }, body(3));
    expect(n()).toBe(3);
  });

  it('2.5초 새 판이 없거나 NO_SLAM 이면 비우고 안내만(남겨 두지 않음)', () => {
    mount(); scan(); act(() => { pick('robot').click(); });
    tick(GONE_MS - 600); expect(n()).toBe(2);
    tick(600);   // 마지막 판 뒤 2.5초
    expect($('[data-slam-view]')).toBeNull(); expect($('[data-slam-empty]')!.textContent).toBe(SLAM_HINT); expect(pick('robot').disabled).toBe(true);
    scan({ seq: 2 }); expect(n()).toBe(2);
    act(() => { sock('slam').recv({ t: 'media.status', version: 'media/1', robot: R, epoch: 8, episode_id: null, channel: 'slam', state: 'NO_SLAM', reason: 'SLAM 자료 없음' }); });
    expect($('[data-slam-empty]')!.textContent).toBe(SLAM_HINT);
  });

  it('형식 이상 판·남의 로봇·되돌아간 순번·이미 본 판은 무시(연결 그대로)', () => {
    mount(); scan({ seq: 5 }); act(() => { pick('robot').click(); });
    const w = sock('slam');
    scan({ seq: 6, count: 3, byte_length: 24 }, body(3));   // 머리 길이 어긋남 → 본문도 버림
    scan({ seq: 7, count: 3, byte_length: 36 }, body(2));   // 본문 길이 어긋남
    scan({ seq: 8, count: 3, byte_length: 36 }, new Float32Array(9).fill(NaN).buffer);
    scan({ seq: 9, count: 3, byte_length: 36, robot: 'ffffffff-0000-0000-0000-000000000000' }, body(3));
    scan({ seq: 4, count: 3, byte_length: 36 }, body(3));
    scan({ seq: 5, count: 3, byte_length: 36 }, body(3));   // 같은 순번 = 서버가 다시 보낸 마지막 판
    bin(w, body(3));   // 머리 없는 본문
    act(() => { w.onmessage?.({ data: '{' }); });
    expect(n()).toBe(2); expect(sock('slam')).toBe(w); expect(w.readyState).toBe(1);
    scan({ seq: 10, count: 3, byte_length: 36 }, body(3));
    expect(n()).toBe(3);
  });

  it('epoch 바뀜·재연결이면 비우고, 지난 epoch 판은 버린다', () => {
    mount(); scan(); act(() => { pick('robot').click(); });
    act(() => { sock('slam').recv({ t: 'media.status', version: 'media/1', robot: R, epoch: 0, episode_id: null, channel: 'slam', state: 'NO_SLAM', reason: 'SLAM 자료 없음' }); });
    expect($('[data-slam-empty]')).not.toBeNull();   // epoch 0 상태도 NO_SLAM 이면 비움(새 시작으로 보지는 않음)
    scan({ seq: 2 }); expect(n()).toBe(2);
    act(() => { sock('slam_pose').recv(pose({ epoch: 9 })); });   // 새 epoch → 지난 점 비움
    expect($('[data-slam-empty]')).not.toBeNull();
    scan({ seq: 3 }); expect($('[data-slam-empty]')).not.toBeNull();   // 지난 epoch 8 판은 버림
    scan({ epoch: 9, seq: 1 }); expect(n()).toBe(2);
    const old = sock('slam');
    act(() => { old.drop(1006); });
    expect($('[data-slam-empty]')).not.toBeNull(); expect(sock('slam_pose').readyState).toBe(3);   // 둘 다 닫고 비움
    tick(RETRY_MS);
    expect(sock('slam')).not.toBe(old); expect(sock('slam').readyState).toBe(0);
  });

  it('숨은 탭이면 두 소켓을 닫고 비우며, 다시 보이면 연다 · 화면 나가면 닫힌다', () => {
    mount(); scan();
    const a = sock('slam'), b = sock('slam_pose');
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(a.readyState).toBe(3); expect(b.readyState).toBe(3); expect(pick('robot').disabled).toBe(true);
    tick(RETRY_MS * 3); expect(sock('slam')).toBe(a);   // 숨은 동안 다시 열지 않음
    delete (document as { visibilityState?: string }).visibilityState;
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(sock('slam')).not.toBe(a);
    const c = sock('slam'); act(() => { c.open(); });
    act(() => { root!.render(<div />); });
    expect(c.readyState).toBe(3);
  });

  it('우리 지도가 없으면(지도 만들기 전) 고르기 단추 없이 로봇 지도 칸 — 자료 전엔 안내', () => {
    mount(false);
    expect($('[data-pick="robot"]')).toBeNull(); expect($('[data-slam-empty]')!.textContent).toBe(SLAM_HINT);
    scan(); expect(n()).toBe(2);
  });

  // RV-461 2: 검증을 통과한 판만 epoch 를 바꾼다 — 상한 넘은 epoch 9 판 하나로 지도가 지워지거나 그 뒤 epoch 8 판을 버리면 안 됨
  it('틀린 새 epoch 판은 버리고 이전 지도·epoch 유지', () => {
    mount(); scan(); act(() => { pick('robot').click(); });
    scan({ epoch: 9, seq: 1, count: 4001, byte_length: 4001 * 12 }, body(4001));
    expect(n()).toBe(2);
    act(() => { sock('slam_pose').recv(pose({ epoch: 9, pose: { x: NaN, y: 0, z: 0, yaw: 0 } })); });   // 틀린 위치도 epoch 를 못 바꿈
    expect(n()).toBe(2);
    scan({ seq: 2, count: 3, byte_length: 36 }, body(3));
    expect(n()).toBe(3);
  });

  // RV-463: 계약 밖 순번·epoch(음수·비정수·비유한·상한 넘음) 판은 epoch·순번을 바꾸지 못함 — 그 뒤 정상 epoch 8 판이 그대로 보여야 함
  it('계약 밖 순번·epoch 판은 버리고 이전 epoch 유지', () => {
    mount(); scan(); act(() => { pick('robot').click(); });
    for (const bad of [{ seq: -1 }, { seq: 1.5 }, { seq: Infinity }, { seq: 2 ** 53 }, { epoch: -1 }, { epoch: 2 ** 53 }]) {
      scan({ epoch: 9, count: 1, byte_length: 12, ...bad }, body(1)); expect(n()).toBe(2);
      act(() => { sock('slam_pose').recv(pose({ epoch: 9, ...bad })); }); expect(n()).toBe(2);
    }
    for (const bad of [{ seq: -1 }, { seq: 2 ** 53 }]) { expect(slamHeader(head(bad))).toBeNull(); expect(slamPose(pose(bad))).toBeNull(); }
    scan({ seq: 2, count: 3, byte_length: 36 }, body(3));
    expect(n()).toBe(3);
  });

  // RV-461 3: 계약(count ≥ 1, frame 비지 않음)
  it('0점·빈 frame 판은 거절', () => {
    expect(slamHeader(head({ count: 0, byte_length: 0 }))).toBeNull();
    expect(slamHeader(head({ frame: '' }))).toBeNull();
    expect(slamPose(pose({ frame: '' }))).toBeNull();
  });

  // RV-461 4: 위치가 NO_SLAM·무자료가 되면 지나온 길도 비움
  it('위치 NO_SLAM·무자료면 지나온 길도 비운다', () => {
    mount(); scan(); act(() => { pick('robot').click(); });
    const walk = (seq: number) => act(() => { sock('slam_pose').recv(pose({ seq, pose: { x: seq, y: 0, z: 0.3, yaw: 0 } })); });
    walk(1); walk(2); walk(3);
    expect($('[data-slam-view]')!.dataset.slamPath).toBe('3');
    act(() => { sock('slam_pose').recv({ t: 'media.status', version: 'media/1', robot: R, epoch: 8, episode_id: null, channel: 'slam_pose', state: 'NO_SLAM', reason: 'SLAM 자료 없음' }); });
    expect($('[data-slam-view]')!.dataset.slamPath).toBe('0');
    walk(4); walk(5); scan({ seq: 2 });
    expect($('[data-slam-view]')!.dataset.slamPath).toBe('2');
    tick(GONE_MS); scan({ seq: 3 });   // 위치만 끊김 → 길도 비움
    expect($('[data-slam-view]')!.dataset.slamPath).toBe('0');
  });

  // RV-461 5: 무자료 안내는 마지막 수신 뒤 정확히 2.5초
  it('무자료 안내는 2.5초에', () => {
    mount(); scan(); act(() => { pick('robot').click(); });
    tick(300); scan({ seq: 2 });
    tick(GONE_MS - 1); expect(n()).toBe(2);
    tick(1); expect($('[data-slam-empty]')).not.toBeNull();
  });

  it('로봇이 연결 안 됨이면 열지 않는다', () => {
    box = document.createElement('div'); document.body.append(box); root = createRoot(box);
    rt.connect([R]);
    const w = FakeWS.all.filter((x) => x.url.endsWith('/api/v1/ws')).pop()!;
    act(() => { w.open(); w.recv(state(R, { connection: 'OFFLINE' })); });
    const k = FakeWS.all.length;
    act(() => { root!.render(<MapPick robot={R} ours={null} />); });
    expect(FakeWS.all.slice(k).some((x) => x.url.includes('drive-media'))).toBe(false);
    expect($('[data-slam-empty]')).not.toBeNull();
  });
});
