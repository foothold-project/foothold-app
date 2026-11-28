// 시안 u11 겹 · 빈 화면 부품: 조종권 요청 창(u11_1) · 조종 화면 위 한 줄(u11_2 ~ u11_5) · 빈 화면(u11_6 ~ u11_8).
// 값은 rt(조종권 · 연결) · 에이전트 장치 줄에서만 온다. 버튼은 rt.respond 만 부르고, Enter · Space 로는 고르지 않는다(Space = 정지 키).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Live } from '../rt';
import { DriveLine, EmptyLog, EmptyMap, EmptyRobots, RobotLine, TakeoverAsk, askShown, driveLine, remoteWhy } from '../proto/u11';
import { App } from '../App';
import { rt } from '../rt';
import { USERS, type Robot } from './fixtures';
import { FakeWS, lease, state } from './fakeWs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null, box: HTMLDivElement;
const draw = (el: JSX.Element) => { box = document.createElement('div'); box.className = 'proto'; document.body.append(box); act(() => { root = createRoot(box); root.render(el); }); };
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); });
const $ = (s: string) => box.querySelector<HTMLElement>(s)!;
const L = (o: Partial<Live> = {}): Live => ({ state: null, stateAt: 0, holder: null, lease: null, rev: 0, neutral: false, busy: null, failed: false, incoming: null, outgoing: null, cooldown: 0, stop: null, releasing: null, released: 0, runReq: null, ...o });
const OPEN = { at: 'open' as const };
const drive = (label: string) => ({ devices: [{ key: 'go2-drive-input', kind: 'OTHER', label, state: 'OK' }] }) as unknown as Live['state'];

describe('u11 겹 부품', () => {
  it('u11_1 조종권 요청 창: 시안 글 · 남은 초 · 막대 · 계속 조종 = 거절 · 넘기기 = 수락 · Enter/Space 는 고르지 않음', () => {
    const answer = vi.fn();
    draw(<TakeoverAsk robot="K-01" q={{ id: 'q1', name: '운영자 A', role: 'OPERATOR', until: 7_000, ms: 10_000 }} now={0} answer={answer} />);
    expect($('[data-takeover-ask]').textContent).toContain('운영자 A 님이 K-01 조종권을 요청했습니다넘겨주시겠습니까?');
    expect($('[data-takeover-ask]').textContent).toContain('7 초 안에 답하지 않으면 조종권을 넘기지 않습니다');
    expect($('.tbar i').style.width).toBe('70%');
    expect($('.veil')).not.toBeNull();
    for (const key of ['Enter', ' ']) {
      const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      $('[data-give]').dispatchEvent(e);
      expect(e.defaultPrevented).toBe(true);
    }
    act(() => { $('[data-give]').click(); });   // 키보드 · 화면 읽기 click(detail 0)은 고르지 않음
    expect(answer).not.toHaveBeenCalled();
    act(() => { $('[data-keep]').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })); });
    act(() => { $('[data-give]').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })); });
    expect(answer.mock.calls).toEqual([[false], [true]]);
  });

  it('조종 화면 한 줄 고르기: 서버 끊김 → 리모컨(에이전트 글 그대로) → 내 요청 기다림 → 넘겨줌, 없으면 없음', () => {
    const base = { link: OPEN, me: 'u-me', now: 0, handedTo: null, fresh: true };
    expect(driveLine({ ...base, l: L() })).toBeNull();
    expect(driveLine({ ...base, link: { at: 'lost' }, l: L({ state: drive('리모컨 동작 중이라 화면 조종은 멈춰 있습니다') }) })).toMatchObject({ kind: 'err', title: '서버와 연결이 끊겼습니다', at: 'link' });
    expect(driveLine({ ...base, l: L({ state: drive('리모컨 동작 중이라 화면 조종은 멈춰 있습니다') }) })).toEqual({ kind: 'amb', title: '리모컨이 우선입니다', sub: '리모컨 동작 중이라 화면 조종은 멈춰 있습니다', at: 'remote' });
    expect(driveLine({ ...base, fresh: false, l: L({ state: drive('리모컨 동작 중이라 화면 조종은 멈춰 있습니다') }) })).toBeNull();   // 오래된 상태의 글은 안 씀
    expect(remoteWhy(drive('비상정지가 걸려 있습니다')!.devices)).toBeNull();
    expect(driveLine({ ...base, now: 2_100, l: L({ holder: { type: 'USER', id: 'u-a', name: '운영자 A' }, outgoing: { until: 10_000 } }) }))
      .toEqual({ kind: 'amb', title: '운영자 A 님에게 조종권을 요청했습니다', sub: '답을 기다리는 중 · 8 초', at: 'ask' });
    expect(driveLine({ ...base, handedTo: '운영자 A', l: L({ holder: { type: 'USER', id: 'u-a', name: '운영자 A' } }) }))
      .toEqual({ kind: 'ok', title: '조종권을 운영자 A 님에게 넘겼습니다', sub: '보기 전용입니다 · 정지 버튼은 계속 쓸 수 있습니다', at: 'handed' });
    draw(<DriveLine f={driveLine({ ...base, handedTo: '운영자 A', l: L() })!} />);
    expect($('.line1.ok.over[data-drive-line="handed"]').textContent).toBe('조종권을 운영자 A 님에게 넘겼습니다보기 전용입니다 · 정지 버튼은 계속 쓸 수 있습니다');
  });

  it('u11_5 서버 끊김 줄: 제목은 지금 글(까닭을 지어내지 않음) · 오른쪽 «핫스팟으로 바꾸기» 단추 · 누르면 안내 펼침, 다른 줄에는 단추 없음', () => {
    const base = { link: { at: 'lost' as const }, me: 'u-me', now: 0, handedTo: null, fresh: true };
    draw(<DriveLine f={driveLine({ ...base, l: L() })!} />);
    const line = $('[data-drive-line="link"]');
    expect(line.textContent).toContain('서버와 연결이 끊겼습니다');
    expect(line.textContent).not.toContain('로그인이 필요합니다');
    const hot = $('[data-hot]');
    expect(hot.textContent).toBe('핫스팟으로 바꾸기'); expect(hot.getAttribute('aria-expanded')).toBe('false');
    expect(box.querySelector('[data-hotspot-guide]')).toBeNull();
    act(() => { hot.click(); });
    expect(hot.getAttribute('aria-expanded')).toBe('true');
    expect($('[data-hotspot-guide]').textContent).toContain('폰 설정 › Wi-Fi 에서 로봇 핫스팟을 고릅니다');
    act(() => { root?.unmount(); }); box.remove();
    draw(<DriveLine f={driveLine({ ...base, link: OPEN, handedTo: '운영자 A', l: L() })!} />);
    expect(box.querySelector('[data-hot]')).toBeNull();
  });

  it('u11_6 ~ u11_8 빈 화면: 시안 그림 · 제목 · 글 · 단추(기록은 단추 없음)', () => {
    draw(<><EmptyRobots /><EmptyMap /><EmptyLog /></>);
    const t = (k: string) => [$(`[data-empty="${k}"] h2`).textContent, $(`[data-empty="${k}"] p`).textContent, $(`[data-empty="${k}"] .btnp`)?.textContent ?? null];
    expect(t('robots')).toEqual(['등록된 로봇이 없습니다', '폰에 뜬 QR 을 로봇 앞 카메라에 보여 주면 연결됩니다. 연결하면 여기에 보입니다.', '로봇 연결']);
    expect(t('map')).toEqual(['아직 지도가 없습니다', '로봇을 조종해 한 바퀴 걸으면 지도가 만들어집니다.', '로봇 탭으로']);
    expect(t('log')).toEqual(['아직 기록이 없습니다', '임무를 실행하거나 알림이 생기면 여기에 시간 순서로 남습니다.', null]);
    expect($('[data-empty="robots"] svg.art').children.length).toBeGreaterThan(0);
  });
});

describe('u11_1 조종권 요청 창 · PC 시안 틀 어느 탭에서나', () => {
  const R: Robot[] = [{ id: 'r1', name: 'K-01', owner: 'u-lee', ownerName: '이OO', battery: 70, online: true, seenAt: '14:05:20', status: 'IDLE', serverDrive: true }];
  let unwatch: (() => void) | null = null;
  afterEach(() => { act(() => unwatch?.()); unwatch = null; askShown.clear(); });
  /** 조종권은 그 로봇을 보는 조종 화면(rt.watch)이 있을 때만 남는다. 시안 u4 로봇 화면이 보는 것처럼 watch 를 건다 */
  const mount = (hash: string) => {
    window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    location.hash = hash; box = document.createElement('div'); document.body.append(box);
    act(() => { root = createRoot(box); root.render(<App user={USERS.find((u) => u.id === 'u-lee')} robots={R} />); });
    act(() => { unwatch = rt.watch('r1'); FakeWS.last.open(); FakeWS.last.recv(state('r1')); FakeWS.last.recv(lease('r1', { id: 'u-lee', name: '이OO' }, 'L1')); });
  };
  const ask = { t: 'lease.requested', robot: 'r1', request_id: 'q1', requester: { display_name: '운영자 A', role: 'OPERATOR' }, expires_at: new Date(Date.now() + 10_000).toISOString() };
  it('옛 조종 화면이 없는 탭(시안 u4 로봇 화면 자리)에서 내 로봇에 온 요청 = 시안 창, 넘기기 = lease.respond 수락 · 머리줄 STOP 은 그대로', () => {
    mount('#/map');
    expect(rt.get('r1').lease).toBe('L1');
    expect(box.querySelector('[data-takeover-ask]')).toBeNull();
    act(() => { FakeWS.last.recv(ask); });
    const d = box.querySelector<HTMLElement>('[data-takeover-ask]')!;
    expect(d.textContent).toContain('운영자 A 님이 K-01 조종권을 요청했습니다');
    expect(box.querySelector('[data-stop]')).not.toBeNull();
    act(() => { d.querySelector('[data-give]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })); });
    expect(FakeWS.last.sent.filter((m) => m.t === 'lease.respond').map((m) => [m.request_id, m.accept])).toEqual([['q1', true]]);
  });
  it('옛 조종 화면(drive.tsx)이 그 로봇을 그리는 동안은 그 화면 창에 맡김(겹치지 않음)', () => {
    askShown.add('r1');
    mount('#/map');
    act(() => { FakeWS.last.recv(ask); });
    expect(box.querySelector('[data-takeover-ask]')).toBeNull();
  });
});

describe('u11_2 ~ u11_5 조종 화면 위 한 줄(RobotLine) · rt 값으로만', () => {
  const R: Robot[] = [{ id: 'r1', name: 'K-01', owner: 'u-lee', ownerName: '이OO', battery: 70, online: true, seenAt: '14:05:20', status: 'IDLE', serverDrive: true }];
  let unwatch: (() => void) | null = null, line: Root | null = null, lbox: HTMLDivElement;
  afterEach(() => { act(() => { line?.unmount(); unwatch?.(); }); line = null; unwatch = null; lbox?.remove(); });
  const mount = () => {
    window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    location.hash = '#/map'; box = document.createElement('div'); document.body.append(box);
    act(() => { root = createRoot(box); root.render(<App user={USERS.find((u) => u.id === 'u-lee')} robots={R} />); });
    lbox = document.createElement('div'); lbox.className = 'proto'; document.body.append(lbox);
    act(() => { unwatch = rt.watch('r1'); FakeWS.last.open(); line = createRoot(lbox); line.render(<RobotLine id="r1" me="u-lee" />); });
  };
  const at = () => lbox.querySelector<HTMLElement>('[data-drive-line]');
  it('값이 없으면 줄 없음 · 리모컨 우선 = 에이전트 장치 줄 글 그대로(u11_4)', () => {
    mount();
    act(() => { FakeWS.last.recv(state('r1')); });
    expect(at()).toBeNull();
    act(() => { FakeWS.last.recv(state('r1', { devices: [{ key: 'go2-drive-input', kind: 'OTHER', label: '리모컨 동작 중이라 화면 조종은 멈춰 있습니다', state: 'OK' }] as never })); });
    expect([at()!.dataset.driveLine, at()!.className, at()!.textContent]).toEqual(['remote', 'line1 amb over', '리모컨이 우선입니다리모컨 동작 중이라 화면 조종은 멈춰 있습니다']);
  });
  it('남이 조종 중일 때 요청 = 기다림 줄과 남은 초(u11_2) · 받아들여 넘겨준 쪽은 보기 전용 줄(u11_3)', () => {
    mount();
    act(() => { FakeWS.last.recv(state('r1')); FakeWS.last.recv(lease('r1', { id: 'u-park', name: '박OO' })); });
    act(() => { rt.request('r1'); });
    expect(at()!.dataset.driveLine).toBe('ask');
    expect(at()!.textContent).toMatch(/^박OO 님에게 조종권을 요청했습니다답을 기다리는 중 · \d+ 초$/);
    act(() => { FakeWS.last.recv(lease('r1', { id: 'u-lee', name: '이OO' }, 'L1')); });   // 받음 = 줄 없음
    expect(at()).toBeNull();
    act(() => { FakeWS.last.recv({ t: 'lease.requested', robot: 'r1', request_id: 'q9', requester: { display_name: '박OO', role: 'OPERATOR' }, expires_at: new Date(Date.now() + 10_000).toISOString() }); });
    act(() => { rt.respond('r1', true); });
    act(() => { FakeWS.last.recv(lease('r1', { id: 'u-park', name: '박OO' })); });
    expect([at()!.dataset.driveLine, at()!.textContent]).toEqual(['handed', '조종권을 박OO 님에게 넘겼습니다보기 전용입니다 · 정지 버튼은 계속 쓸 수 있습니다']);
  });
  it('서버 연결이 끊기면 빨간 줄(u11_5)이 먼저', () => {
    mount();
    act(() => { FakeWS.last.recv(state('r1', { devices: [{ key: 'go2-drive-input', kind: 'OTHER', label: '리모컨 동작 중', state: 'OK' }] as never })); });
    act(() => { FakeWS.last.drop(1006); });
    expect([at()!.dataset.driveLine, at()!.className]).toEqual(['link', 'line1 err over']);
  });
});
