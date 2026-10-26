// 외부 카메라 시점 끌기(extview.ts) — 서버 중계(apps/server/fh_server/EXTERNAL-CAMERA.md). ≤10 Hz·진행 중 하나·손 떼면 cancel·오류표·범위 자르기·주행 입력과 분리.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiFail, api } from '../api';
import { VIEW0, VIEW_MS, clampView, orbit, useOrbit, viewBlock, viewFail } from '../extview';
import { media, useFeed, type Feed } from '../media';
import { sim } from '../phone';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const R = '11111111-1111-4111-8111-111111111111', EP = '33333333-3333-4333-8333-333333333333';
const live = { state: 'live' } as Feed, wait = { state: 'wait' } as Feed;
const fail = (status: number, code: string) => new ApiFail(status, code, 'x', true);
const OK = { accepted: true, shared: true, seq: 1, operation: 'view' };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); media.reset(); });

/** 손으로 끝내는 가짜 보내기: sent = [op, yaw], go(i, e?) = i 번째 요청 끝(e 면 실패) */
function rig() {
  vi.useFakeTimers();
  let t = 0;
  const sent: [string, number][] = [], ends: ((e?: unknown) => void)[] = [], notes: [string, boolean][] = [];
  const o = orbit((op, v) => { sent.push([op, Math.round(v.yaw * 100) / 100]); return new Promise((ok, no) => ends.push((e) => (e ? no(e) : ok(OK)))); },
    (why, stop) => notes.push([why, stop]), () => t);
  const go = async (i: number, e?: unknown) => { ends[i](e); await vi.advanceTimersByTimeAsync(0); };
  const tick = async (ms: number) => { t += ms; await vi.advanceTimersByTimeAsync(ms); };
  return { o, sent, notes, go, tick };
}

describe('시점 보내기', () => {
  it('범위: yaw ±π 로 감기, pitch ±1.2, 거리 0.5–10', () => {
    const v = clampView({ yaw: 4, pitch: 2, radius: 0.1 });
    expect(v.yaw).toBeCloseTo(4 - 2 * Math.PI); expect([v.pitch, v.radius]).toEqual([1.2, 0.5]);
    expect(clampView({ yaw: -1, pitch: -3, radius: 40 })).toEqual({ yaw: -1, pitch: -1.2, radius: 10 });
  });

  it('첫 값 바로, 그 뒤 100 ms·앞 요청 끝난 뒤에만 최신 하나(≤10 Hz·진행 1개), end = 남은 값 버리고 cancel', async () => {
    const { o, sent, go, tick } = rig();
    o.set({ ...VIEW0, yaw: 0.1 });
    for (let i = 2; i <= 9; i++) { await tick(10); o.set({ ...VIEW0, yaw: i / 10 }); }
    expect(sent).toEqual([['view', 0.1]]);
    await tick(300);   // 100 ms 지나도 앞 요청이 안 끝났으면 보내지 않음
    expect(sent).toEqual([['view', 0.1]]);
    await go(0);
    expect(sent).toEqual([['view', 0.1], ['view', 0.9]]);
    await go(1);
    await tick(30); o.set({ ...VIEW0, yaw: 1 });
    o.end();
    expect(sent).toHaveLength(2);   // 앞 보냄에서 100 ms 전 — 기다림
    await tick(VIEW_MS);
    expect(sent).toEqual([['view', 0.1], ['view', 0.9], ['cancel', 1]]);
  });

  it('제한(409 SIM_OBSERVER_RATE_LIMIT): view 는 버리고 다음 값, 손 뗀 뒤 cancel 은 100 ms 뒤 마지막 한 번만', async () => {
    const { o, sent, notes, go, tick } = rig();
    o.set({ ...VIEW0, yaw: 0.1 });
    await go(0, fail(409, 'SIM_OBSERVER_RATE_LIMIT'));
    await tick(500);
    expect(sent).toEqual([['view', 0.1]]);   // 다시 보내지 않음
    o.set({ ...VIEW0, yaw: 0.2 });
    expect(sent).toEqual([['view', 0.1], ['view', 0.2]]);
    await go(1);
    o.end(); await tick(VIEW_MS);
    expect(sent[sent.length - 1]).toEqual(['cancel', 0.2]);
    await go(2, fail(409, 'SIM_OBSERVER_RATE_LIMIT'));
    expect(sent).toHaveLength(3);
    await tick(VIEW_MS);
    expect(sent).toHaveLength(4); expect(sent[sent.length - 1][0]).toBe('cancel');
    await go(3, fail(409, 'SIM_OBSERVER_RATE_LIMIT'));
    await tick(1000);
    expect(sent).toHaveLength(4);   // 한 번만
    expect(notes).toEqual([]);   // 제한은 조용히
  });

  it('멈춤(404 등): 안내 + 그 뒤 view·cancel 모두 안 보냄, revive 로 풀림', async () => {
    const { o, sent, notes, go, tick } = rig();
    o.set({ ...VIEW0, yaw: 0.1 });
    await tick(50); o.set({ ...VIEW0, yaw: 0.2 });   // 진행 중 새 값
    await go(0, fail(404, 'NOT_FOUND'));
    await tick(500); o.set({ ...VIEW0, yaw: 0.3 }); o.end(); await tick(500);
    expect(sent).toEqual([['view', 0.1]]);
    expect(notes).toEqual([['이 로봇을 더 볼 수 없어(담당 해제·보관 등) 시점 이동을 멈췄습니다', true]]);
    o.revive(); o.set({ ...VIEW0, yaw: 0.4 });
    expect(sent[sent.length - 1]).toEqual(['view', 0.4]);
  });

  it('503·SIM_OBSERVER_UNAVAILABLE: 안내, 이번 끌기는 더 안 보내되 손 떼면 cancel, 다음 끌기(begin)에서 다시', async () => {
    const { o, sent, notes, go, tick } = rig();
    o.set({ ...VIEW0, yaw: 0.1 });
    await go(0, fail(409, 'SIM_OBSERVER_UNAVAILABLE'));
    expect(notes).toEqual([['시뮬 외부 카메라가 지금 시점 요청을 받지 못합니다 — 다시 끌면 다시 보냅니다', false]]);
    await tick(200); o.set({ ...VIEW0, yaw: 0.2 }); await tick(200);
    expect(sent).toEqual([['view', 0.1]]);   // 자동 재시도 없음
    o.end();
    expect(sent[sent.length - 1][0]).toBe('cancel');
    await go(1);
    o.begin(); o.set({ ...VIEW0, yaw: 0.3 }); await tick(VIEW_MS);   // cancel 에서 100 ms 뒤
    expect(sent[sent.length - 1]).toEqual(['view', 0.3]);
  });

  it('오류표: 멈춤 = 401·403·404·409 UNAVAILABLE·SIM_OBSERVER_BINDING·400·413, 안내만 = 503·연결 실패, 제한 = 조용히', () => {
    const stop = (e: unknown) => viewFail(e)?.[1];
    expect([fail(401, 'AUTH_REQUIRED'), fail(403, 'FORBIDDEN'), fail(404, 'NOT_FOUND'), fail(409, 'UNAVAILABLE'), fail(409, 'SIM_OBSERVER_BINDING'), fail(400, 'VALIDATION'), fail(413, 'BODY_TOO_LARGE'), fail(403, 'INTERNAL_ERROR')].map(stop))
      .toEqual([true, true, true, true, true, true, true, true]);
    expect([fail(503, 'SIM_UNAVAILABLE'), fail(503, 'SIM_DISABLED'), fail(409, 'SIM_OBSERVER_UNAVAILABLE'), new ApiFail(0, 'TIMEOUT', 'x'), new Error('x')].map(stop))
      .toEqual([false, false, false, false, false]);
    expect(viewFail(fail(409, 'SIM_OBSERVER_RATE_LIMIT'))).toBeNull();
    expect(viewFail(fail(409, 'UNAVAILABLE'))![0]).toBe('실기에는 외부 카메라 시점 이동이 없습니다');
    // 성공 표시 문구 없음(«접수됨»일 뿐) — 안내 어디에도 반영·적용 없음
    expect([401, 403, 404, 503].map((s) => viewFail(fail(s, 'X'))![0]).join()).not.toMatch(/반영|적용/);
  });

  it('못 옮기는 이유: 중계 없음 → 외부 카메라 안 받는 중 → 회차 없음 순서, 중계는 켜짐', () => {
    expect(viewBlock(live, false)).toBe('시점 이동 준비 중 — 서버 시점 중계가 아직 없습니다');
    expect(viewBlock(wait)).toBe('외부 카메라를 받는 중일 때만 시점을 옮길 수 있습니다');
    expect(viewBlock(live)).toBe('시뮬 회차 정보가 없어 시점을 옮길 수 없습니다');
  });
});

describe('useOrbit — 그림 끌기', () => {
  let root: Root | null = null, box: HTMLDivElement;
  afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); });
  function Pad({ off }: { off: boolean }) { useFeed('external', false); const { pad, note } = useOrbit(R, off);   // 화면처럼 media 가 바뀌면 다시 그림
    return <div data-pad data-note={note} style={{ touchAction: 'none' }} {...pad} />; }
  const mount = (off = false) => { box = document.createElement('div'); document.body.append(box); act(() => { root = createRoot(box); root.render(<Pad off={off} />); }); return box.querySelector('[data-pad]')!; };
  const ev = (el: Element, type: string, id: number, x: number, y: number) =>
    act(() => { el.dispatchEvent(Object.assign(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }), { pointerId: id })); });
  const offer = (epoch = 7) => media.offer({ version: 'media/1', path: '/phone/media/ws', robot: R, epoch, episode_id: EP,
    rgb: { available: false, reason: 'RGB source is disabled', token: null }, external: { available: false, reason: 'External camera source is not connected', token: null },
    lidar: { available: false, reason: 'x', token: null } }, 'ws://127.0.0.1:9433/phone/ws');
  const later = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

  it('끌기 = 계약 ExternalCameraViewRequest 그대로(추가 필드 0, seq 0), 손 떼면 cancel — 주행 축(sim.axes) 0', async () => {
    offer();
    const send = vi.spyOn(api, 'externalView').mockResolvedValue(OK), axes = vi.spyOn(sim, 'axes');
    const el = mount();
    ev(el, 'pointerdown', 1, 100, 100);
    ev(el, 'pointermove', 1, 150, 110);
    expect(send).toHaveBeenCalledTimes(1);
    const [robot, op, b] = send.mock.calls[0];
    expect([robot, op]).toEqual([R, 'view']);
    expect(Object.keys(b).sort()).toEqual(['episode_id', 'epoch', 'pitch', 'radius', 'robot', 'seq', 't', 'version', 'yaw']);
    expect({ ...b, yaw: 0, pitch: 0 }).toEqual({ t: 'external.view', version: 'observer/1', robot: R, episode_id: EP, epoch: 7, seq: 0, yaw: 0, pitch: 0, radius: 3 });
    expect(b.yaw).toBeCloseTo(Math.PI - 0.5);   // 오른쪽으로 50 px → yaw −0.5
    expect(b.pitch).toBeCloseTo(0.55);
    await later(VIEW_MS + 10);
    ev(el, 'pointerup', 1, 150, 110);
    expect(send.mock.lastCall![1]).toBe('cancel');
    expect(Object.keys(send.mock.lastCall![2]).length).toBe(9);
    // 두 손가락 벌림 = 거리 줄임(가까이)
    await later(VIEW_MS + 10);
    ev(el, 'pointerdown', 1, 100, 100); ev(el, 'pointerdown', 2, 200, 100);
    await later(VIEW_MS + 10);
    ev(el, 'pointermove', 2, 300, 100);
    await later(VIEW_MS + 10);
    expect(send.mock.lastCall![2].radius).toBeCloseTo(1.5);
    act(() => { dispatchEvent(new Event('blur')); });   // 창을 떠나면 끝 — cancel
    await later(VIEW_MS + 10);
    expect(send.mock.lastCall![1]).toBe('cancel');
    expect(axes).not.toHaveBeenCalled();
  });

  it('멈춤 오류면 안내 + 누름 처리를 떼고(cancel 도 없음), 결속(epoch)이 바뀌면 다시 받음', async () => {
    offer();
    const send = vi.spyOn(api, 'externalView').mockRejectedValue(fail(409, 'SIM_OBSERVER_BINDING'));
    const el = mount();
    ev(el, 'pointerdown', 1, 100, 100); ev(el, 'pointermove', 1, 150, 110);
    await later(0);
    expect(el.getAttribute('data-note')).toBe('담당자·회차가 바뀌어 시점 이동을 멈췄습니다 — 다시 연결하세요');
    ev(el, 'pointerup', 1, 150, 110); ev(el, 'pointerdown', 1, 100, 100); ev(el, 'pointermove', 1, 190, 110);
    await later(VIEW_MS + 10);
    expect(send).toHaveBeenCalledTimes(1);
    send.mockResolvedValue(OK);
    act(() => offer(8));
    await later(0);
    expect(el.getAttribute('data-note')).toBe('');
    ev(el, 'pointerdown', 3, 100, 100); ev(el, 'pointermove', 3, 120, 100);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.lastCall![2].epoch).toBe(8);
  });

  it('안내만 오류(503)는 다음 누름에서 지워지고 다시 보냄', async () => {
    offer();
    const send = vi.spyOn(api, 'externalView').mockRejectedValueOnce(fail(503, 'SIM_UNAVAILABLE')).mockResolvedValue(OK);
    const el = mount();
    ev(el, 'pointerdown', 1, 100, 100); ev(el, 'pointermove', 1, 150, 110);
    await later(0);
    expect(el.getAttribute('data-note')).toBe('시뮬 외부 카메라가 지금 시점 요청을 받지 못합니다 — 다시 끌면 다시 보냅니다');
    ev(el, 'pointerup', 1, 150, 110);
    await later(VIEW_MS + 10);
    ev(el, 'pointerdown', 1, 100, 100);
    expect(el.getAttribute('data-note')).toBe('');
    await later(VIEW_MS + 10);
    ev(el, 'pointermove', 1, 170, 110);
    expect(send.mock.lastCall![1]).toBe('view');
  });

  it('off(외부 카메라 아님 등) 면 누름을 받지 않아 아무것도 보내지 않음', () => {
    const send = vi.spyOn(api, 'externalView');
    const el = mount(true);
    ev(el, 'pointerdown', 1, 0, 0); ev(el, 'pointermove', 1, 90, 90); ev(el, 'pointerup', 1, 90, 90);
    expect(send).not.toHaveBeenCalled();
  });
});
