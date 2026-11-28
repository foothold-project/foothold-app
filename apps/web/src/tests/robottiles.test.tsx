// 로봇 탭 타일(u5_4 뒤집기 → Go2 정면 상태 · u12_1 경고 타일 앞으로 · 강조). 보기 전용: 로봇 명령 · STOP 없음, 값은 목록 · 실시간 state 에 있는 것만.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Go2RobotInfo } from '../../../contracts/ts';
import type { Robot } from '../fake';
import { rt } from '../rt';
import { RobotTiles, tileOrder } from '../screens/robottiles';
import { FakeWS, state } from './fakeWs';
import { App } from '../App';
import { ROBOTS, USERS } from './fixtures';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null, box: HTMLDivElement;
let reduce = false;
beforeEach(() => {
  reduce = false;
  vi.stubGlobal('fetch', () => new Promise(() => {}));
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce') ? reduce : false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
});
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); rt.disconnect(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const R = (p: Partial<Robot> = {}): Robot => ({ id: 'r', name: 'Go2', owner: 'o', ownerName: '이OO', battery: 80, online: true, seenAt: '', status: 'RUNNING', sim: false, ...p });
const OK = R({ id: 'r3', name: 'Go2-3', mission: '2층 순찰 3/5' });
const LOW = R({ id: 'r7', name: 'Go2-7', battery: 15, status: 'IDLE' });
const LOST = R({ id: 'r1', name: 'Go2-1', battery: null, online: false, status: 'STOP_LATCHED' });
const FELL = R({ id: 'r9', name: 'Go2-9', robotInfo: { source: 'GO2_DDS', attitude: { roll: 1.2, pitch: 0 }, error_code: 0, fallen: true, fallen_source: 'imu_tilt_estimate' } as Go2RobotInfo });

const show = (robots: Robot[], open = vi.fn()) => {
  box = document.createElement('div'); document.body.append(box); root = createRoot(box);
  act(() => root!.render(<RobotTiles robots={robots} open={open} />));
  return open;
};
const tiles = () => [...box.querySelectorAll<HTMLElement>('[data-robot-tile]')];
const ids = () => tiles().map((t) => t.dataset.robotTile);
const card = (id: string) => box.querySelector<HTMLElement>(`[data-robot-tile="${id}"] [data-tile-card]`)!;
const face = (id: string, f: 'front' | 'back') => box.querySelector<HTMLElement>(`[data-robot-tile="${id}"] [data-face="${f}"]`)!;
const fact = (id: string, k: string) => box.querySelector(`[data-robot-tile="${id}"] [data-face="front"] [data-tile-fact="${k}"]`)?.textContent;
const key = (el: HTMLElement, k: string) => act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); });
/** 타일마다 하나뿐인 뒤집기 단추(이름은 여기에만) */
const flipBtn = (id: string) => box.querySelector<HTMLButtonElement>(`[data-robot-tile="${id}"] [data-tile-flip]`)!;
const flip = (id: string) => act(() => flipBtn(id).click());

describe('경고 타일 앞으로 · 강조 (u12_1)', () => {
  it('끊김 · 잠금(빨강) → 배터리 낮음 · 넘어짐 의심 · 서버 주의(주황) → 나머지, 같은 단계는 받은 순서 그대로', () => {
    const ATT = R({ id: 'r5', name: 'Go2-5', attention: ['AGENT_OFFLINE'] });
    expect(tileOrder([OK, LOW, LOST, FELL, ATT]).map((x) => x.id)).toEqual(['r1', 'r7', 'r9', 'r5', 'r3']);
    show([OK, LOW, LOST]);
    expect(ids()).toEqual(['r1', 'r7', 'r3']);
    expect(tiles().map((t) => t.dataset.warn ?? '')).toEqual(['bad', 'warn', '']);
  });

  it('경고 타일 머리 글: 「경고 · 까닭」 (색만이 아니라 글로), 경고 없는 타일은 머리 글 없음', () => {
    show([OK, LOW, LOST, FELL]);
    expect(box.querySelector('[data-robot-tile="r1"] [data-tile-warn]')!.textContent).toBe('경고 · 끊김');
    expect(box.querySelector('[data-robot-tile="r7"] [data-tile-warn]')!.textContent).toBe('경고 · 배터리 낮음');
    expect(box.querySelector('[data-robot-tile="r9"] [data-tile-warn]')!.textContent).toBe('경고 · 넘어짐 의심');
    expect(box.querySelector('[data-robot-tile="r3"] [data-tile-warn]')).toBeNull();
    expect(box.querySelector('[data-tiles-count]')!.textContent).toBe('경고 3');
  });

  it('경고가 둘이면 둘 다 글로: 배터리 낮음 + 넘어짐 의심 (#590 reviewer 낮음)', () => {
    const BOTH = R({ id: 'r8', name: 'Go2-8', battery: 12, status: 'IDLE', robotInfo: FELL.robotInfo });
    show([BOTH]);
    expect(box.querySelector('[data-robot-tile="r8"] [data-tile-warn]')!.textContent).toBe('경고 · 배터리 낮음 · 넘어짐 의심');
    expect(tiles()[0].dataset.warn).toBe('warn');
    act(() => root?.unmount()); root = null; box.remove();
    show([R({ id: 'r6', name: 'Go2-6', status: 'ERROR', robotInfo: FELL.robotInfo })]);
    expect(box.querySelector('[data-robot-tile="r6"] [data-tile-warn]')!.textContent).toMatch(/^경고 · .+ · 넘어짐 의심$/);
    expect(tiles()[0].dataset.warn).toBe('bad');   // 빨강이 이김
  });
});

describe('뒤집기 → Go2 정면 상태 (u5_4)', () => {
  it('카드는 보통 글 덩어리: 단추 역할 · 이름이 없어 앞면 사실(임무 · 배터리 · 온도 · 연결 · 담당)이 그대로 읽힘 (#590 reviewer)', () => {
    show([OK]);
    const c = card('r3');
    for (const a of ['role', 'tabindex', 'aria-label', 'aria-pressed']) expect(c.hasAttribute(a)).toBe(false);
    expect(box.querySelector('[data-robot-tile="r3"] [role="button"]')).toBeNull();
    const front = face('r3', 'front');
    expect(front.getAttribute('aria-hidden')).toBeNull();
    for (const k of ['mission', 'battery', 'temp', 'link', 'owner']) expect(c.contains(front.querySelector(`[data-tile-fact="${k}"]`)!.closest('[aria-label],[aria-hidden="true"]'))).toBe(false);   // 카드 안 어느 조상도 이름으로 덮거나 숨기지 않음
    expect(front.textContent).toContain('임무2층 순찰 3/5');
    expect(front.textContent).toContain('담당이OO');
  });

  it('뒤집기는 타일마다 작은 단추 하나 (aria-pressed · 이름은 늘 같음) · 카드 누름도 뒤집음 · 단추 누름은 한 번만', () => {
    show([OK, LOW]);
    expect(box.querySelectorAll('[data-robot-tile="r3"] [data-tile-flip]')).toHaveLength(1);
    const b = flipBtn('r3');
    expect(b.tagName).toBe('BUTTON');
    expect(b.type).toBe('button');
    expect(b.textContent).toBe('정면 상태 보기');
    expect(b.getAttribute('aria-label')).toBe('Go2-3 정면 상태 보기');
    expect(b.getAttribute('aria-pressed')).toBe('false');
    flip('r3');
    expect(b.getAttribute('aria-pressed')).toBe('true');
    expect(b.getAttribute('aria-label')).toBe('Go2-3 정면 상태 보기');   // 눌림 상태는 aria-pressed 가 알리고 이름은 바꾸지 않음
    expect(box.querySelector<HTMLElement>('[data-robot-tile="r7"]')!.dataset.flipped).toBeUndefined();   // 다른 타일은 그대로
    flip('r3');
    expect(b.getAttribute('aria-pressed')).toBe('false');
    act(() => card('r3').click());
    expect(b.getAttribute('aria-pressed')).toBe('true');
    key(card('r3'), 'Enter');   // 카드는 초점을 받지 않으니 키보드는 단추로
    expect(b.getAttribute('aria-pressed')).toBe('true');
  });

  it('안 보이는 면은 읽기 · 초점에서 빠짐 (aria-hidden + inert)', () => {
    show([OK]);
    expect(face('r3', 'back').getAttribute('aria-hidden')).toBe('true');
    expect(face('r3', 'back').hasAttribute('inert')).toBe(true);
    expect(face('r3', 'front').getAttribute('aria-hidden')).toBeNull();
    flip('r3');
    expect(face('r3', 'front').getAttribute('aria-hidden')).toBe('true');
    expect(face('r3', 'front').hasAttribute('inert')).toBe(true);
    expect(face('r3', 'back').getAttribute('aria-hidden')).toBeNull();
  });

  it('「정면 상태로 뒤집기」 는 모든 타일을 한 번에, 다시 누르면 「앞면으로」', () => {
    show([OK, LOW]);
    const all = box.querySelector<HTMLButtonElement>('[data-tiles-flip]')!;
    expect(all.textContent).toBe('정면 상태로 뒤집기');
    expect(all.getAttribute('aria-pressed')).toBe('false');
    act(() => all.click());
    expect(tiles().map((t) => t.querySelector('[data-tile-flip]')!.getAttribute('aria-pressed'))).toEqual(['true', 'true']);
    expect(all.textContent).toBe('앞면으로');
    act(() => all.click());
    expect(tiles().map((t) => t.querySelector('[data-tile-flip]')!.getAttribute('aria-pressed'))).toEqual(['false', 'false']);
  });

  it('실시간 자세 보고가 없으면 정면 그림 대신 「서버에 값 없음」 (서 있는 그림을 짓지 않음)', () => {
    show([OK]);
    flip('r3');
    expect(box.querySelector('[data-robot-tile="r3"] [data-tile-figure]')).toBeNull();
    expect(box.querySelector('[data-robot-tile="r3"] [data-tile-nopose]')!.textContent).toBe('정면 자세 · 서버에 값 없음');
  });

  it('실시간 state 의 관절 12 개 · 온도가 오면 정면 그림 + 가장 뜨거운 관절 (이름 · °C)', () => {
    rt.connect(['r3']);
    const w = FakeWS.last; act(() => w.open());
    const names = ['FR', 'FL', 'RR', 'RL'].flatMap((l) => ['hip', 'thigh', 'calf'].map((p) => `${l}_${p}_joint`));
    const joints = [40, 41, 42, 43, 44, 61, 30, 30, 30, 30, 30, 30];
    act(() => w.recv(state('r3', { robot_info: { source: 'GO2_DDS', fallen: false, fallen_source: 'imu_tilt_estimate',
      joints: { names, positions: names.map(() => 0.1), age_s: 0.1, received_at: '2026-11-28T00:00:00Z' },
      temperature: { age_s: 0.1, joints, battery: [30, 31, null, null], body: [35, null], imu: 33 } } as unknown as Go2RobotInfo })));
    show([OK]);
    expect(fact('r3', 'temp')).toBe('최고 관절 온도61°C · 앞 왼 종아리');
    flip('r3');
    expect(box.querySelector('[data-robot-tile="r3"] [data-tile-figure]')).not.toBeNull();
    expect(box.querySelector('[data-robot-tile="r3"] [data-tile-nopose]')).toBeNull();
  });
});

describe('값 없음은 「서버에 값 없음」 · 보기 전용', () => {
  it('배터리 · 관절 온도 · 뒤 1 m 영상은 값이 없으면 지어내지 않고 「서버에 값 없음」', () => {
    show([LOST]);
    expect(fact('r1', 'battery')).toBe('배터리서버에 값 없음');
    expect(fact('r1', 'temp')).toBe('최고 관절 온도서버에 값 없음');
    expect(box.querySelector('[data-robot-tile="r1"] [data-tile-media]')!.textContent).toBe('뒤 1 m 영상 · 서버에 값 없음');
    expect(fact('r1', 'link')).toBe('연결끊김');
  });

  it('있는 값은 그대로: 임무 · 배터리 · 담당, 임무가 없으면 「임무 없음」', () => {
    show([OK, LOW]);
    expect(fact('r3', 'mission')).toBe('임무2층 순찰 3/5');
    expect(fact('r3', 'battery')).toBe('배터리80%');
    expect(fact('r3', 'owner')).toBe('담당이OO');
    expect(fact('r7', 'mission')).toBe('임무임무 없음');
  });

  it('타일 단추는 「정면 상태 보기」 · 「자세히」 (서랍 열기) 둘이고 뒤집는 판 밖에 둠 · 로봇 명령 · 정지 없음', () => {
    const open = show([OK]);
    const btns = [...box.querySelectorAll<HTMLButtonElement>('[data-robot-tile="r3"] button')];
    expect(btns.map((b) => b.textContent)).toEqual(['정면 상태 보기', '자세히']);
    expect(card('r3').querySelector('button, a, input, select')).toBeNull();
    expect(box.textContent).not.toMatch(/정지|STOP|조종 시작/);
    act(() => btns[1].click());
    expect(open).toHaveBeenCalledWith('r3');
    expect(flipBtn('r3').getAttribute('aria-pressed')).toBe('false');
  });
});

describe('움직임 · prefers-reduced-motion', () => {
  let scroll = 0;
  const rect = () => vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const li = (this as HTMLElement).closest('[data-robot-tile]');
    const i = li ? [...li.parentElement!.children].indexOf(li) : 0, top = i * 100 - scroll;
    return { top, left: 0, width: 100, height: 90, right: 100, bottom: top + 90, x: 0, y: top, toJSON() {} } as DOMRect;
  });
  beforeEach(() => { scroll = 0; });

  it('순서가 그대로면 쪽을 넘기거나 실시간 값이 바뀌어도 타일을 옮기지 않음', () => {
    rect();
    show([OK, LOW]);
    scroll = 500;
    rerender([OK, { ...LOW, battery: 12 }]);
    expect(tiles().map((t) => t.style.transform)).toEqual(['', '']);
  });
  const rerender = (robots: Robot[]) => act(() => root!.render(<RobotTiles robots={robots} open={() => {}} />));

  it('경고가 생겨 순서가 바뀌면 옮겨 간 타일이 옛 자리에서 미끄러져 옴 (FLIP)', () => {
    rect();
    show([OK, { ...LOW, battery: 80 }]);
    expect(ids()).toEqual(['r3', 'r7']);
    rerender([OK, LOW]);
    expect(ids()).toEqual(['r7', 'r3']);
    expect(box.querySelector<HTMLElement>('[data-robot-tile="r7"]')!.style.transform).toBe('translate(0px, 100px)');
    expect(box.querySelector('[data-tiles]')!.getAttribute('data-motion')).toBe('on');
  });

  it('움직임 줄이기를 켠 기기는 옮김 · 뒤집기 움직임 없이 바로 바뀜', () => {
    reduce = true;
    rect();
    show([OK, { ...LOW, battery: 80 }]);
    rerender([OK, LOW]);
    expect(ids()).toEqual(['r7', 'r3']);
    expect(box.querySelector<HTMLElement>('[data-robot-tile="r7"]')!.style.transform).toBe('');
    expect(box.querySelector('[data-tiles]')!.getAttribute('data-motion')).toBe('reduce');
  });
});

describe('총괄 로봇 탭에 붙임', () => {
  it('u4 틀 아래 「로봇 한눈에」 칸에 타일 · 왼쪽 거르기를 따르고, 「자세히」 는 그 로봇의 점검(상세)을 엶', async () => {
    const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); });
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ items: [], next_cursor: null }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    location.hash = '#/fleet';
    box = document.createElement('div'); document.body.append(box);
    act(() => { root = createRoot(box); root.render(<App user={USERS.find((u) => u.role === 'ORG_ADMIN')} robots={ROBOTS} />); });
    await flush();
    const list = box.querySelector('[aria-label="로봇 목록"]')!;
    const real = ROBOTS.filter((r) => !r.sim);
    expect(box.querySelector('[aria-label="로봇 한눈에"] [aria-label="로봇 타일"]')).not.toBeNull();
    expect(ids().sort()).toEqual(real.map((r) => r.id).sort());
    const owner = list.querySelector<HTMLSelectElement>('select[data-filter="owner"]')!;
    act(() => { owner.value = 'u-park'; owner.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(ids()).toEqual(real.filter((r) => r.owner === 'u-park').map((r) => r.id));   // 표와 같은 거르기
    expect(list.querySelectorAll('[data-robot-row]')).toHaveLength(ids().length);
    act(() => { owner.value = ''; owner.dispatchEvent(new Event('change', { bubbles: true })); });
    act(() => tiles()[0].querySelector<HTMLButtonElement>('[data-tile-open]')!.click());
    expect(box.querySelector('[data-robot-frame]')!.getAttribute('data-tab')).toBe('check');
    expect(box.querySelector('[data-robot-head] h2')!.textContent).toBe(ROBOTS.find((r) => r.id === tiles()[0].dataset.robotTile)!.name);
  });
});
