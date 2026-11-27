// 관제 탭(W1 · U5): 타일 20대 · 경고 먼저 · 한 번 = 작은 지도 강조 · 두 번 = 로봇 탭 · 뒤집기 · 시뮬 정면만 · 운영 관리자 거르기 · 지어낸 숫자 0
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { USERS, type Robot } from './fixtures';
import { FakeWS, state } from './fakeWs';
import { EmptyControl, actOf, lastly, order } from '../screens/control';
import { api } from '../api';
import { sim } from '../phone';

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
const fact = (id: string, k: string) => tile(id).querySelector(`[data-fact="${k}"] b`)?.textContent ?? null;   // 값이 없는 칸은 접힘 = null

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

  it('값이 없는 칸은 칸째 접음(«미확인» 글자 반복 없음) · 온도·배터리·위치를 지어내지 않는다', () => {
    mount('u-kim', TWENTY); feed(TWENTY);
    expect(fact('g3', '관절 최고')).toBeNull();
    expect(tile('g3').querySelector('[data-fact="관절 최고"]')).toBeNull();
    expect(fact('g3', '배터리')).toBe('70%');
    expect(fact('g4', '배터리')).toBeNull();
    expect(tile('g3').querySelector('[data-place]')).toBeNull();
    expect(tiles().some((t) => t.textContent!.includes('미확인'))).toBe(false);   // 동작 보기 면에는 «미확인» 글자가 한 번도 없다
    expect(tile('g3').querySelector('[data-mission]')!.textContent).toBe('임무 없음');
    expect(tile('g5').querySelector('[data-mission]')!.textContent).toContain('할 일 1/4');
  });

  it('관절 온도는 로봇이 보낸 robot_info.temperature 의 최고값, 위치는 state 값', () => {
    const joints = [40, 41, 42, 43, 61, 44, 45, 46, 47, 48, 49, null];
    mount('u-kim', TWENTY);
    feed(TWENTY, { g3: { robot_info: { source: 'GO2_DDS', attitude: { roll: 0, pitch: 0 }, error_code: 0, fallen: false, fallen_source: 'imu_tilt_estimate',
      temperature: { joints, battery: [], imu: null, body: [], age_s: 0.1 } }, location: { floor_id: 'f1', map_version_id: 'v1', x: 1.25, y: 2, yaw: 0, confidence: 1, updated_at: '' } } });
    expect(fact('g3', '관절 최고')).toBe('61°C');
    act(() => { tile('g3').querySelector<HTMLElement>('[data-flip]')!.click(); });
    expect(tile('g3').querySelector('[data-temp-badge]')!.textContent).toBe('최고 관절 온도 61°C');
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
    expect(tile('g3').querySelector('[data-temp-badge]')).toBeNull();   // 관절 온도는 값이 있을 때만
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

  it('끊긴 로봇 값은 «마지막 값 · HH:MM», 시각을 모르면 칸을 접음', () => {
    mount('u-kim', TWENTY); feed(TWENTY);
    expect(fact('g15', '배터리')).toBe('마지막 70% · 14:05');
    expect(fact('g15', '관절 최고')).toBeNull();
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

  it('한 번도 연결된 적 없는 로봇(연결 전)은 경고가 아니다: 테두리·머리표·경고 수·경보 카드·최근 경고 없음, «연결 끊김» 글자 없음', () => {
    const pre: Robot[] = ['p1', 'p2'].map((id, i) => ({ id, name: `Go2-${i + 7}`, owner: 'u-park', ownerName: '박OO', battery: null, online: false, seenAt: '', status: null, attention: ['OFFLINE'] }));
    mount('u-kim', pre); feed(pre);
    expect(tiles()).toHaveLength(2);
    expect(tiles().every((t) => t.dataset.tone === undefined && !t.querySelector('[data-warn-flag]'))).toBe(true);
    expect($('[aria-label="요약"] [data-sum="경고"] b').textContent).toBe('0');
    expect($('[aria-label="경보"]')).toBeNull();
    expect($$('[aria-label="최근 경고"] [data-alert]')).toHaveLength(0);
    expect($('main').textContent).not.toContain('연결 끊김');
    expect($('main').textContent).not.toContain('미확인');
  });

  it('받은 시각이 없으면 최근 경고의 시각 칸을 접는다', () => {
    const gone: Robot[] = ['q1', 'q2'].map((id, i) => ({ id, name: `Q-${i}`, owner: 'u-park', ownerName: '박OO', battery: 40, online: false, seenAt: '', status: 'RUNNING' }));
    mount('u-kim', gone); feed(gone);
    expect($$('[aria-label="최근 경고"] [data-alert]')).toHaveLength(1);
    expect($('[aria-label="최근 경고"] [data-alert-at]')).toBeNull();
    expect($('[aria-label="최근 경고"]').textContent).not.toContain('미확인');
  });

  // C1(REVIEW-PR529): 지도 보기도 타일 보기 작은 지도와 같은 세 갈래(받는 중 · 실패 + 다시 시도 · 정말 0 층)
  const mapView = () => { act(() => { $$('[aria-label="보기"] button')[1].click(); }); return $('[aria-label="지도 보기"]'); };
  it('지도 보기: 층 목록을 받는 중이면 «불러오는 중», «등록된 층이 없습니다» 아님', () => {
    vi.spyOn(api, 'sites').mockReturnValue(new Promise(() => {}));
    mount('u-kim', TWENTY); feed(TWENTY);
    const v = mapView();
    expect(v.textContent).toContain('층 목록을 불러오는 중');
    expect(v.textContent).not.toContain('등록된 층이 없습니다');
  });
  it('지도 보기: 층 목록을 받지 못하면 실패 글 + 다시 시도(누르면 다시 받음)', async () => {
    const sites = vi.spyOn(api, 'sites').mockRejectedValue({ code: 'NETWORK', message: '서버에 닿지 못했습니다.' });
    mount('u-kim', TWENTY); feed(TWENTY);
    await act(async () => {});
    const v = mapView();
    expect(v.textContent).toContain('층 목록을 받지 못했습니다');
    expect(v.textContent).not.toContain('등록된 층이 없습니다');
    const n = sites.mock.calls.length;
    await act(async () => { [...v.querySelectorAll('button')].find((b) => b.textContent === '다시 시도')!.click(); });
    expect(sites.mock.calls.length).toBe(n + 1);
  });
  it('지도 보기: 정말 0 층이면 «등록된 층이 없습니다»', async () => {
    vi.spyOn(api, 'sites').mockResolvedValue({ items: [] } as never);
    mount('u-kim', TWENTY); feed(TWENTY);
    await act(async () => {});
    expect(mapView().textContent).toContain('등록된 층이 없습니다');
  });

  // C2 · D1(app-design-lx 05:12 결정): 관제 탭 STOP 은 고른 타일 로봇을 한 번에 · 고른 것이 없으면 첫 누름 = 고르기, 맨 위 «모두 정지 (N 대)»
  const stopBtn = () => $('[aria-label="비상 정지"]');
  const press = (b: HTMLElement) => act(() => { b.click(); });
  it('관제 STOP: 타일에서 고른 로봇이 있으면 한 번 누름으로 그 로봇만 정지(로봇 탭의 ctx.robot 이 다른 로봇이어도)', () => {
    mount('u-lee', TWENTY); feed(TWENTY);
    act(() => { tile('g6').click(); });   // 관제에서 고름(이OO 로봇) · ctx.robot 은 목록 첫 로봇(g0) 그대로
    press(stopBtn());
    expect(FakeWS.last.of('stop').map((m) => m.robot)).toEqual(['g6']);
    expect($('[aria-label="정지할 로봇 고르기"]')).toBeNull();
  });
  it('관제 STOP: 고른 로봇이 없으면 첫 누름은 고르기(보냄 0) · 맨 위 «모두 정지 (N 대 · 끊김 M)» · 같은 자리 두 번째 누름이면 정지 가능 로봇 전부(끊긴 로봇 포함, R1)', () => {
    const T = TWENTY.map((r) => (r.id === 'g4' ? { ...r, online: false } : r));   // 이OO 로봇 10 대 중 g4(K-05 · 임무 중이던) 끊김
    mount('u-lee', T); feed(T);
    press(stopBtn());
    expect(FakeWS.last.of('stop')).toHaveLength(0);
    const pick = $('[aria-label="정지할 로봇 고르기"]');
    const first = pick.querySelector('select')!.options[0];
    expect(first.textContent).toBe('모두 정지 (10 대 · 끊김 1)');
    expect(first.selected).toBe(true);
    expect(pick.querySelector('[data-stop-lost="g4"]')!.textContent).toContain('K-05 연결 끊김 · 정지가 아직 닿지 않음 · 다시 연결되면 멈춤 · 현장에서 멈추세요');
    press(stopBtn());
    const sent = FakeWS.last.of('stop').map((m) => m.robot);
    expect(new Set(sent)).toEqual(new Set(T.filter((r) => r.owner === 'u-lee').map((r) => r.id)));
    expect(sent).toHaveLength(10);
    const bands = $$('[data-stop-band]');
    expect(bands).toHaveLength(10);
    const lostBand = bands.find((b) => b.textContent!.includes('K-05'))!;   // 끊긴 로봇은 붙은 로봇과 같은 성공 표시가 아님
    expect(lostBand.dataset.stopLost).toBe('g4');
    expect(lostBand.textContent).toContain('K-05 연결 끊김 · 정지가 아직 닿지 않음 · 다시 연결되면 멈춤 · 현장에서 멈추세요');
  });
  it('R3: «모두»에서 남의 로봇을 고른 뒤 «내 로봇»으로 되돌리면 고름이 비고, STOP 한 번은 숨은 로봇이 아니라 고르기', () => {
    mount('u-lee', TWENTY); feed(TWENTY);
    act(() => { $$('[aria-label="범위"] button')[0].click(); });   // 모두
    act(() => { tile('g7').click(); });                           // 박OO 로봇
    act(() => { $$('[aria-label="범위"] button')[1].click(); });   // 내 로봇 → g7 은 보이지 않음
    press(stopBtn());
    expect(FakeWS.last.of('stop')).toHaveLength(0);
    expect($('[aria-label="정지할 로봇 고르기"]')).not.toBeNull();
  });
  it('R2 · M5: 이 계정이 못 세우는 타일을 고르면 «고른 로봇 없음» 흐름(고르기 · 모두 정지 기본) + 맨 위 한 줄', () => {
    const R: Robot[] = [
      { id: 'a1', name: 'K-21', owner: 'u-lee', ownerName: '이OO', battery: 70, online: true, seenAt: '14:05:20', status: 'RUNNING' },   // 실기 = 총괄은 못 세움
      { id: 's1', name: 'S-01', owner: 'u-kim', ownerName: '김OO', battery: 70, online: true, seenAt: '14:05:20', status: 'RUNNING', sim: true },
    ];
    mount('u-kim', R); feed(R);
    act(() => { tile('a1').click(); });
    press(stopBtn());
    expect(FakeWS.last.of('stop')).toHaveLength(0);
    const pick = $('[aria-label="정지할 로봇 고르기"]');
    expect(pick.querySelector('[data-cant-stop]')!.textContent).toBe('K-21 은 이 계정으로 정지할 수 없어 전체 정지를 엽니다');
    const first = pick.querySelector('select')!.options[0];
    expect(first.textContent).toBe('모두 정지 (1 대)');
    expect(first.selected).toBe(true);
    press(stopBtn());
    expect(FakeWS.last.of('stop').map((m) => m.robot)).toEqual(['s1']);
  });
  it('관제 · 내 시뮬이 떠 있고 고른 타일 없음: 첫 누름은 sim.stop 이 아니라 고르기 · 모두 정지에 내 시뮬 포함(Sonnet 3)', () => {
    const live = vi.spyOn(sim, 'live').mockReturnValue({ robot_id: 'sx', generation: 1, owner_id: 'u-lee', world_id: 'w', simulation: true, state: 'RUNNING', agent_address: '' } as never);
    const halt = vi.spyOn(sim, 'stop').mockImplementation(() => {});
    mount('u-lee', TWENTY); feed(TWENTY);
    press(stopBtn());
    expect(halt).not.toHaveBeenCalled();
    expect(FakeWS.last.of('stop')).toHaveLength(0);
    expect($('[aria-label="정지할 로봇 고르기"] select').querySelector('option')!.textContent).toBe('모두 정지 (11 대)');   // 이OO 10 대 + 내 시뮬
    press(stopBtn());
    expect(halt).toHaveBeenCalledTimes(1);
    expect(FakeWS.last.of('stop')).toHaveLength(10);
    expect(live).toHaveBeenCalled();
  });
  it('Enter 를 누른 채 두면(키 반복) 고르기를 연 뒤 모두 정지가 곧바로 가지 않는다(Sonnet 5)', () => {
    mount('u-lee', TWENTY); feed(TWENTY);
    press(stopBtn());
    const go = $('[aria-label="정지할 로봇 고르기"] button.fh-stop');
    const key = (type: string, repeat: boolean) => act(() => { go.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', repeat, bubbles: true, cancelable: true })); });
    const enterClick = () => act(() => { go.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 })); });
    key('keydown', true); enterClick();   // 반복 keydown 과 그 click
    key('keydown', true); enterClick();
    expect(FakeWS.last.of('stop')).toHaveLength(0);
    key('keyup', false);
    key('keydown', false); enterClick();  // 손을 뗀 뒤 새 누름
    expect(FakeWS.last.of('stop')).toHaveLength(10);
  });
  it('관제 STOP: 고르기의 정지 단추에 초점 · Enter(키보드 누름)로 모두 정지를 바로 보냄', () => {
    mount('u-lee', TWENTY); feed(TWENTY);
    press(stopBtn());
    const go = $('[aria-label="정지할 로봇 고르기"] button.fh-stop');
    expect(document.activeElement).toBe(go);
    act(() => { go.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 })); });   // Enter 로 누른 단추 = detail 0 click
    expect(FakeWS.last.of('stop')).toHaveLength(10);   // 이OO 로봇 10 대 모두 연결
  });
});
