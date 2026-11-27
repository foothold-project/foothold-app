// 관제 탭(W1 · U5): 타일 20대 · 경고 먼저 · 한 번 = 작은 지도 강조 · 두 번 = 로봇 탭 · 뒤집기 · 시뮬 정면만 · 운영 관리자 거르기 · 지어낸 숫자 0
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { USERS, type Robot } from './fixtures';
import { FakeWS, state } from './fakeWs';
import { EmptyControl, actOf, lastly, order } from '../screens/control';

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
    expect(tile('g15').querySelector('[data-warn-flag]')!.textContent).toBe('경고');
    expect($('[aria-label="요약"] [data-sum="경고"] b').textContent).toBe('2');
    expect($('[aria-label="경보"] h2').textContent).toContain('K-16');   // 경보 한 장 = 맨 앞 경고(U5-19)
    expect($$('[aria-label="최근 경고"] [data-alert]').map((e) => e.dataset.alert)).toEqual(['g9']);   // 경보 카드에 나온 맨 앞 경고는 최근 경고에서 뺀다
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

  it('3D 는 지금 동작대로: 임무 중 = 걷기, 잠금·오류 = 엎드림, 대기 = 서 있음, 끊김 = 마지막 자세 모름(보고 자세가 오면 그 자세)', () => {
    mount('u-kim', TWENTY); feed(TWENTY);
    expect(tile('g5').querySelector('.ct-fig')!.getAttribute('data-act')).toBe('walk');
    expect(tile('g15').querySelector('.ct-fig')!.getAttribute('data-act')).toBe('lost');
    expect(tile('g15').querySelector('.ct-fig')!.hasAttribute('data-dim')).toBe(true);
    expect(tile('g15').querySelector('[data-act-text]')!.textContent).toBe('마지막 자세 모름');
    expect(actOf({ ...TWENTY[3], status: 'STOP_LATCHED' }, false)).toBe('lie');   // 연결 중 잠금은 그대로 엎드림
    expect(actOf({ ...TWENTY[3], status: 'ERROR' }, false)).toBe('lie');
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
    expect(tile('g1').querySelector('.lv-chip')!.textContent).toContain('확인 안 됨');   // 남의 로봇은 요약만 · 상태를 단정하지 않음
  });

  it('order: 경고 먼저, 나머지는 받은 순서', () => {
    const a = TWENTY[3], b = TWENTY[15], c = TWENTY[5], d = TWENTY[9];
    expect(order([a, d, c, b]).map((x) => x.id)).toEqual(['g15', 'g9', 'g3', 'g5']);
  });

  it('끊긴 로봇 값은 «마지막 값 · HH:MM», 시각을 모르면 미확인', () => {
    mount('u-kim', TWENTY); feed(TWENTY);
    expect(fact('g15', '배터리')).toBe('마지막 70% · 14:05');
    expect(fact('g15', '관절 최고')).toBe('미확인');
    expect(fact('g3', '배터리')).toBe('70%');   // 연결 중이면 그대로
    const gone = { ...TWENTY[15], unknown: 'link' as const };
    expect(lastly(gone, '70%', '')).toBeNull();
    expect(lastly(gone, '위치 1.0, 2.0 m', '2026-11-28T05:06:07')).toMatch(/^마지막 위치 1\.0, 2\.0 m · \d\d:\d\d$/);
  });

  it('한 타일에서 같은 낱말은 한 번 · 연결 사실 칸 없음 · 경보 카드와 최근 경고가 겹치지 않음', () => {
    mount('u-kim', TWENTY); feed(TWENTY);
    expect(tile('g15').textContent!.split('끊김').length - 1).toBe(1);
    expect(tile('g15').querySelector('[data-fact="연결"]')).toBeNull();
    expect(tile('g9').textContent!.split('배터리 낮음').length - 1).toBe(1);
    expect($('[aria-label="경보"] p').textContent).not.toContain('끊김');
    expect($$('[aria-label="최근 경고"] [data-alert]').some((e) => e.dataset.alert === 'g15')).toBe(false);
  });

  it('최근 경고 시각 칸 = «받은 시각»(발생 시각 필드 없음)', () => {
    mount('u-kim', TWENTY); feed(TWENTY);
    expect($('[aria-label="최근 경고"] [data-alert-at]').textContent).toMatch(/^받은 시각 /);
  });

  it('App: 로봇 0대면 관제 탭은 로봇 탭 빈 화면이 아니라 관제 빈 화면', () => {
    mount('u-kim', []);
    expect($('h1').textContent).toBe('관제');
    expect($('[data-empty-control]')).not.toBeNull();
    expect($('[aria-label="요약"]')).toBeNull();
  });

  it('로봇 0대 관제 빈 화면: 한 줄 + 로봇 탭 링크', () => {
    box = document.createElement('div'); document.body.append(box);
    act(() => { root = createRoot(box); root.render(<EmptyControl />); });
    expect($('[data-empty-control] p').textContent).toContain('관제할 로봇이 없습니다');
    expect($('[data-empty-control] a').getAttribute('href')).toBe('#/fleet');
  });

  it('타일 키보드: Enter = 로봇 탭(초점 받음), 안쪽 단추의 Enter 는 그 단추 몫', () => {
    mount('u-kim', TWENTY); feed(TWENTY);
    expect(tile('g7').tabIndex).toBe(0);
    act(() => { tile('g7').querySelector<HTMLElement>('[data-flip]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect($('h1').textContent).toBe('관제');
    act(() => { tile('g7').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect($('h1').textContent).toBe('로봇');
    expect(location.hash).toBe('#/fleet');
  });
});
