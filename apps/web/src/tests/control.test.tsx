// 관제 탭(W1 · U5): 타일 20대 · 경고 먼저 · 한 번 = 작은 지도 강조 · 두 번 = 로봇 탭 · 뒤집기 · 시뮬 정면만 · 운영 관리자 거르기 · 지어낸 숫자 0
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { USERS, type Robot } from './fixtures';
import { FakeWS, state } from './fakeWs';
import { actOf, order } from '../screens/control';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null, box: HTMLDivElement;
function mount(user: string, robots: Robot[], hash = '') {
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  location.hash = hash;
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<App user={USERS.find((u) => u.id === user)} robots={robots} />); });
}
/** 목록 값과 같은 첫 state(끊긴 로봇은 OFFLINE). extra = 로봇별 덧붙일 state 값 */
const feed = (robots: Robot[], extra: Record<string, object> = {}) => act(() => {
  FakeWS.last.open();
  for (const r of robots) FakeWS.last.recv(r.online ? state(r.id, { status: r.status, battery: r.battery == null ? null : { soc: r.battery, updated_at: '' }, ...extra[r.id] })
    : state(r.id, { connection: 'OFFLINE', status: null, battery: null, latched: null, stop_gen: null, applied: null }));
});
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); vi.restoreAllMocks(); localStorage.clear(); });
const $ = <T extends Element = HTMLElement>(s: string) => box.querySelector<T>(s)!;
const $$ = (s: string) => [...box.querySelectorAll<HTMLElement>(s)];
const tiles = () => $$('[aria-label="로봇 타일"] article');
const tile = (id: string) => $(`article[data-robot="${id}"]`);
const fact = (id: string, k: string) => tile(id).querySelector(`[data-fact="${k}"] b`)!.textContent;

/** 20대: 15번 = 정지 잠금(끊김 · 빨강), 9번 = 배터리 낮음(주황) · 받은 순서로는 뒤쪽, 2번 = 시뮬, 나머지 = 이OO·박OO 번갈아 임무 중·대기 */
const TWENTY: Robot[] = Array.from({ length: 20 }, (_, i) => ({
  id: `g${i}`, name: `K-${String(i + 1).padStart(2, '0')}`, owner: i % 2 ? 'u-park' : 'u-lee', ownerName: i % 2 ? '박OO' : '이OO',
  battery: i === 9 ? 12 : i === 4 ? null : 70, online: i !== 15, seenAt: '14:05:20', status: i === 15 ? 'STOP_LATCHED' : i % 3 ? 'RUNNING' : 'IDLE',
  mission: i % 3 && i !== 15 ? `순찰 ${i % 4}/4` : undefined, sim: i === 2,
}));

describe('관제 탭', () => {
  it('PC 첫 화면 = 관제(메뉴 첫 탭), 20대여도 같은 크기 타일 20개 · 경고 타일이 맨 앞(빨강 → 주황) + 테두리 표시', () => {
    mount('u-kim', TWENTY); feed(TWENTY);
    expect($('h1').textContent).toBe('관제');
    expect($('nav a[aria-current="page"]').getAttribute('href')).toBe('#/control');
    expect(tiles()).toHaveLength(20);
    expect($('[aria-label="로봇 타일"]').dataset.count).toBe('20');
    expect(tiles().slice(0, 2).map((t) => t.dataset.robot)).toEqual(['g15', 'g9']);
    expect(tile('g15').dataset.tone).toBe('bad'); expect(tile('g9').dataset.tone).toBe('warn'); expect(tile('g3').dataset.tone).toBeUndefined();
    expect(tile('g15').querySelector('[data-warn-flag]')!.textContent).toContain('경고');
    expect($('[aria-label="요약"] [data-sum="경고"] b').textContent).toBe('2');
    expect($('[aria-label="경보"] h2').textContent).toContain('K-16');   // 경보 한 장 = 맨 앞 경고(U5-19)
    expect($$('[aria-label="최근 경고"] [data-alert]').map((e) => e.dataset.alert)).toEqual(['g15', 'g9']);
  });

  it('값이 없으면 «미확인» · 온도·배터리·위치를 지어내지 않는다', () => {
    mount('u-kim', TWENTY); feed(TWENTY);
    expect(fact('g3', '관절 최고')).toBe('미확인');
    expect(fact('g3', '배터리')).toBe('70%');
    expect(fact('g4', '배터리')).toBe('미확인');
    expect(tile('g3').querySelector('[data-place]')!.textContent).toBe('위치 미확인');
    expect(tile('g3').querySelector('[data-mission]')!.textContent).toBe('임무 없음');
    expect(tile('g5').querySelector('[data-mission]')!.textContent).toContain('할 일 1/4');
  });

  it('관절 온도는 로봇이 보낸 robot_info.temperature 의 최고값, 위치는 state 값', () => {
    const joints = [40, 41, 42, 43, 61, 44, 45, 46, 47, 48, 49, null];
    mount('u-kim', TWENTY);
    feed(TWENTY, { g3: { robot_info: { source: 'GO2_DDS', attitude: { roll: 0, pitch: 0 }, error_code: 0, fallen: false, fallen_source: 'imu_tilt_estimate',
      temperature: { joints, battery: [], imu: null, body: [], age_s: 0.1 } }, location: { floor_id: 'f1', map_version_id: 'v1', x: 1.25, y: 2, yaw: 0, confidence: 1, updated_at: '' } } });
    expect(fact('g3', '관절 최고')).toBe('61°C');
    expect(tile('g3').querySelector('[data-place]')!.textContent).toBe('위치 1.3, 2.0 m');
  });

  it('한 번 누름 = 고름(작은 지도 강조 · «로봇 탭에서 보기»), 두 번 누름 = 그 로봇의 로봇 탭', () => {
    mount('u-kim', TWENTY); feed(TWENTY);
    act(() => { tile('g7').click(); });
    expect(tile('g7').dataset.sel).toBe('true');
    expect(tile('g7').querySelector('.ct-name')!.getAttribute('aria-pressed')).toBe('true');
    expect($('[data-picked]').textContent).toContain('K-08');
    act(() => { tile('g7').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    expect($('h1').textContent).toBe('로봇');
    expect(location.hash).toBe('#/fleet');
    expect($('[aria-label="로봇 목록"] button[aria-pressed="true"]')!.textContent).toContain('K-08');   // 로봇 탭이 그 로봇을 고른 채
  });

  it('뒤집기 = 정면 상태(관절 온도), 시뮬 로봇은 뒤집기 없이 정면 상태만', () => {
    mount('u-kim', TWENTY); feed(TWENTY);
    expect(tile('g3').querySelector('.ct-video')!.getAttribute('data-face')).toBe('live');
    act(() => { tile('g3').querySelector<HTMLElement>('[data-flip]')!.click(); });
    expect(tile('g3').querySelector('.ct-video')!.getAttribute('data-face')).toBe('front');
    expect(tile('g3').querySelector('[data-temp-badge]')!.textContent).toBe('관절 온도 미확인');
    expect(tile('g3').dataset.sel).toBeUndefined();   // 뒤집기 단추는 고르기가 아님
    expect(tile('g2').querySelector('[data-flip]')).toBeNull();
    expect(tile('g2').querySelector('.ct-video')!.getAttribute('data-face')).toBe('front');
    expect(tile('g2').querySelector('[data-sim-tag]')).not.toBeNull();
    act(() => { $('.ct-flipall').click(); });   // 모두 뒤집기
    expect(tiles().every((t) => t.querySelector('.ct-video')!.getAttribute('data-face') === 'front')).toBe(true);
  });

  it('3D 는 지금 동작대로: 임무 중 = 걷기, 잠금·끊김 = 엎드림, 대기 = 서 있음(보고 자세가 오면 그 자세)', () => {
    mount('u-kim', TWENTY); feed(TWENTY);
    expect(tile('g5').querySelector('.ct-fig')!.getAttribute('data-act')).toBe('walk');
    expect(tile('g15').querySelector('.ct-fig')!.getAttribute('data-act')).toBe('lie');
    expect(tile('g3').querySelector('.ct-fig')!.getAttribute('data-act')).toBe('stand');
    const r = TWENTY[3];
    expect(actOf(r, true)).toBe('report');
    expect(actOf({ ...r, unknown: 'wait' }, false)).toBe('unknown');
  });

  it('타일 ↔ 지도 보기', () => {
    mount('u-kim', TWENTY); feed(TWENTY);
    act(() => { $$('[aria-label="보기"] button')[1].click(); });
    expect($('[aria-label="로봇 타일"]')).toBeNull();
    expect($('[aria-label="지도 보기"]')).not.toBeNull();
    expect($$('[aria-label="로봇 목록(지도 보기)"] li')).toHaveLength(20);
    act(() => { $$('[aria-label="보기"] button')[0].click(); });
    expect(tiles()).toHaveLength(20);
  });

  it('운영 관리자도 같은 틀 · 처음은 «내 로봇»만, «모두»로 받은 목록 전부', () => {
    mount('u-lee', TWENTY); feed(TWENTY.filter((r) => r.owner === 'u-lee'));
    expect($('h1').textContent).toBe('관제');
    expect(tiles()).toHaveLength(10);
    expect(tiles().every((t) => TWENTY.find((r) => r.id === t.dataset.robot)!.owner === 'u-lee')).toBe(true);
    act(() => { $$('[aria-label="범위"] button')[0].click(); });
    expect(tiles()).toHaveLength(20);
    expect(fact('g1', '연결')).toBe('연결 확인 중');   // 남의 로봇은 요약만 · 상태를 단정하지 않음
  });

  it('order: 경고 먼저, 나머지는 받은 순서', () => {
    const a = TWENTY[3], b = TWENTY[15], c = TWENTY[5], d = TWENTY[9];
    expect(order([a, d, c, b]).map((x) => x.id)).toEqual(['g15', 'g9', 'g3', 'g5']);
  });
});
