// 외부 카메라 시점 끌기(extview.ts) — 서버 중계가 생긴 뒤를 흉내(EXT_VIEW_RELAY=true 로 바꿔 끼움). ≤10 Hz·손 떼면 cancel·범위 자르기·주행 입력과 분리.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { VIEW0, VIEW_MS, clampView, orbit, useOrbit, viewBlock } from '../extview';
import { media, type Feed } from '../media';
import { sim } from '../phone';

vi.mock('../api', async (orig) => ({ ...(await orig<typeof import('../api')>()), EXT_VIEW_RELAY: true }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const R = '11111111-1111-4111-8111-111111111111', EP = '33333333-3333-4333-8333-333333333333';
const live = { state: 'live' } as Feed, wait = { state: 'wait' } as Feed;
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); media.reset(); });

describe('시점 보내기', () => {
  it('범위: yaw ±π 로 감기, pitch ±1.2, 거리 0.5–10', () => {
    const v = clampView({ yaw: 4, pitch: 2, radius: 0.1 });
    expect(v.yaw).toBeCloseTo(4 - 2 * Math.PI); expect([v.pitch, v.radius]).toEqual([1.2, 0.5]);
    expect(clampView({ yaw: -1, pitch: -3, radius: 40 })).toEqual({ yaw: -1, pitch: -1.2, radius: 10 });
  });

  it('첫 값 바로, 그 뒤 100 ms 에 최신 하나(≤10 Hz), end = 남은 값 버리고 cancel', () => {
    vi.useFakeTimers();
    let t = 0;
    const sent: [string, number][] = [], o = orbit((op, v) => sent.push([op, Math.round(v.yaw * 100) / 100]), () => t);
    o.set({ ...VIEW0, yaw: 0.1 });
    for (let i = 2; i <= 9; i++) { t += 10; o.set({ ...VIEW0, yaw: i / 10 }); }
    expect(sent).toEqual([['view', 0.1]]);
    t = VIEW_MS; vi.advanceTimersByTime(VIEW_MS);
    expect(sent).toEqual([['view', 0.1], ['view', 0.9]]);
    t += 30; o.set({ ...VIEW0, yaw: 1 });
    o.end();
    vi.advanceTimersByTime(500);
    expect(sent).toEqual([['view', 0.1], ['view', 0.9], ['cancel', 1]]);
  });

  it('못 옮기는 이유: 중계 없음 → 외부 카메라 안 받는 중 → 회차 없음 순서', () => {
    expect(viewBlock(live, false)).toBe('시점 이동 준비 중 — 서버 시점 중계가 아직 없습니다');
    expect(viewBlock(wait, true)).toBe('외부 카메라를 받는 중일 때만 시점을 옮길 수 있습니다');
    expect(viewBlock(live, true)).toBe('시뮬 회차 정보가 없어 시점을 옮길 수 없습니다');
  });
});

describe('useOrbit — 그림 끌기', () => {
  let root: Root | null = null, box: HTMLDivElement;
  afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); });
  function Pad({ off }: { off: boolean }) { return <div data-pad style={{ touchAction: 'none' }} {...useOrbit(R, off)} />; }
  const mount = (off = false) => { box = document.createElement('div'); document.body.append(box); act(() => { root = createRoot(box); root.render(<Pad off={off} />); }); return box.querySelector('[data-pad]')!; };
  const ev = (el: Element, type: string, id: number, x: number, y: number) =>
    act(() => { el.dispatchEvent(Object.assign(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }), { pointerId: id })); });

  it('끌기 = 서버 중계(view)로 결속·시점, 손 떼면 cancel — 주행 축(sim.axes) 0', async () => {
    media.offer({ version: 'media/1', path: '/phone/media/ws', robot: R, epoch: 7, episode_id: EP,
      rgb: { available: false, reason: 'RGB source is disabled', token: null }, external: { available: false, reason: 'External camera source is not connected', token: null },
      lidar: { available: false, reason: 'x', token: null } }, 'ws://127.0.0.1:9433/phone/ws');
    const send = vi.spyOn(api, 'externalView').mockResolvedValue({ accepted: true, shared: true, seq: 1, operation: 'view' }), axes = vi.spyOn(sim, 'axes');
    const el = mount();
    ev(el, 'pointerdown', 1, 100, 100);
    ev(el, 'pointermove', 1, 150, 110);
    expect(send).toHaveBeenCalledTimes(1);
    const [robot, op, b] = send.mock.calls[0];
    expect([robot, op, b.epoch, b.episode_id]).toEqual([R, 'view', 7, EP]);
    expect(b.yaw).toBeCloseTo(Math.PI - 0.5);   // 오른쪽으로 50 px → yaw −0.5
    expect(b.pitch).toBeCloseTo(0.55);
    expect(b.radius).toBe(3);
    ev(el, 'pointerup', 1, 150, 110);
    expect(send.mock.lastCall![1]).toBe('cancel');
    // 두 손가락 벌림 = 거리 줄임(가까이)
    ev(el, 'pointerdown', 1, 100, 100); ev(el, 'pointerdown', 2, 200, 100);
    await act(() => new Promise((r) => setTimeout(r, VIEW_MS + 10)));
    ev(el, 'pointermove', 2, 300, 100);
    await act(() => new Promise((r) => setTimeout(r, VIEW_MS + 10)));
    expect(send.mock.lastCall![2].radius).toBeCloseTo(1.5);
    act(() => { dispatchEvent(new Event('blur')); });   // 창을 떠나면 끝 — cancel
    expect(send.mock.lastCall![1]).toBe('cancel');
    expect(axes).not.toHaveBeenCalled();
  });

  it('off(중계 없음·외부 카메라 아님) 면 누름을 받지 않아 아무것도 보내지 않음', () => {
    const send = vi.spyOn(api, 'externalView');
    const el = mount(true);
    ev(el, 'pointerdown', 1, 0, 0); ev(el, 'pointermove', 1, 90, 90); ev(el, 'pointerup', 1, 90, 90);
    expect(send).not.toHaveBeenCalled();
  });
});
