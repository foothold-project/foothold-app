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
import { rt } from '../rt';

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

  it('3D 는 지금 동작대로: 임무 중 = 걷기, 잠금·오류 = 자세 모름(보고 자세 없을 때), 대기 = 서 있음, 끊김 = 마지막 자세 모름(보고 자세가 오면 그 자세)', () => {
    mount('u-kim', TWENTY); feed(TWENTY);
    expect(tile('g5').querySelector('.ct-fig')!.getAttribute('data-act')).toBe('walk');
    expect(tile('g15').querySelector('.ct-fig')!.getAttribute('data-act')).toBe('lost');
    expect(tile('g15').querySelector('.ct-fig')!.hasAttribute('data-dim')).toBe(true);
    expect(tile('g15').querySelector('[data-act-text]')!.textContent).toBe('마지막 자세 모름');
    // #533 r2 4: 잠금·오류는 서버 잠금 표시일 뿐 자세가 아니다. 보고 자세가 없으면 엎드림을 그리지 않고 «자세 모름»(흐리게)
    expect(actOf({ ...TWENTY[3], status: 'STOP_LATCHED' }, false)).toBe('hold');
    expect(actOf({ ...TWENTY[3], status: 'ERROR' }, false)).toBe('hold');
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
    expect(pick.querySelector('[data-stop-lost="g4"]')!.textContent).toContain('K-05 연결이 끊겨 정지를 보내지 못했습니다. 다시 연결되면 로봇은 잠긴 상태로 시작합니다. 지금 멈춰야 하면 리모컨이나 현장에서 멈추세요.');
    press(stopBtn());
    const sent = FakeWS.last.of('stop').map((m) => m.robot);
    expect(new Set(sent)).toEqual(new Set(T.filter((r) => r.owner === 'u-lee').map((r) => r.id)));
    expect(sent).toHaveLength(10);
    const bands = $$('[data-stop-band]');
    expect(bands).toHaveLength(10);
    const lostBand = bands.find((b) => b.textContent!.includes('K-05'))!;   // 끊긴 로봇은 붙은 로봇과 같은 성공 표시가 아님
    expect(lostBand.dataset.stopLost).toBe('g4');
    expect(lostBand.textContent).toContain('K-05 연결이 끊겨 정지를 보내지 못했습니다. 다시 연결되면 로봇은 잠긴 상태로 시작합니다. 지금 멈춰야 하면 리모컨이나 현장에서 멈추세요.');
  });
  // Codex #535 H2 (11-28): 끊긴 로봇에 «다시 연결되면 멈춤» 을 약속하지 않는다 · 다시 붙어도 잠금(새 세대) 확인 전에는 경고를 지우지 않는다
  const NOT_SENT = '연결이 끊겨 정지를 보내지 못했습니다. 다시 연결되면 로봇은 잠긴 상태로 시작합니다. 지금 멈춰야 하면 리모컨이나 현장에서 멈추세요.';
  it('H2: 끊긴 로봇 모두 정지 · 약속 없는 문구, 다시 ONLINE 만으로는 경고가 남고, latched + 세대가 오른 뒤에만 지움', () => {
    const T = TWENTY.map((r) => (r.id === 'g4' ? { ...r, online: false } : r));
    mount('u-lee', T); feed(TWENTY);   // 끊기기 전: g4 는 세대 1 을 알렸다
    act(() => { FakeWS.last.recv(state('g4', { connection: 'OFFLINE', status: null, battery: null, latched: null, stop_gen: null, applied: null })); });
    root!.render(<App user={USERS.find((u) => u.id === 'u-lee')} robots={T} />);
    press(stopBtn());
    expect($('[aria-label="정지할 로봇 고르기"] [data-stop-lost="g4"]')!.textContent).toBe(`▲ K-05 ${NOT_SENT}`);
    press(stopBtn());
    const band = () => $$('[data-stop-band]').find((b) => b.textContent!.includes('K-05'))!;
    expect(band().textContent).toBe(`▲ K-05 ${NOT_SENT}`);
    expect(box.textContent).not.toContain('다시 연결되면 멈춤');
    act(() => { FakeWS.last.recv(state('g4', { status: 'RUNNING', latched: false, stop_gen: 1 })); });   // 다시 붙음 · 잠금 없음
    expect(band().textContent).toBe(`▲ K-05 ${NOT_SENT}`);
    act(() => { FakeWS.last.recv(state('g4', { status: 'STOP_LATCHED', latched: true, stop_gen: 1 })); });   // 잠금이지만 세대 그대로 = 이 STOP 이 아님
    expect(band().textContent).toBe(`▲ K-05 ${NOT_SENT}`);
    act(() => { FakeWS.last.recv(state('g4', { status: 'STOP_LATCHED', latched: true, stop_gen: 2, applied: [0, 0, 0] })); });   // 새 세대 잠금
    expect(band().textContent).not.toContain(NOT_SENT);
  });
  // Codex #535 M4: 서버 경유가 꺼진(SWITCH_OFF) 실기는 서버가 STOP 을 PHONE_DIRECT_REQUIRED 로 거절한다 → 모두 정지에 세지 않고 «현장 폰» 한 줄
  it('M4: 서버 경유 정지가 꺼진 실기는 «모두 정지» 대수 · 보냄에서 빠지고 현장 폰 안내 한 줄', () => {
    const T = TWENTY.map((r) => (r.id === 'g6' ? { ...r, serverDriveBlocked: ['SWITCH_OFF'] as Robot['serverDriveBlocked'] } : r));
    mount('u-lee', T); feed(T);
    press(stopBtn());
    const pick = $('[aria-label="정지할 로봇 고르기"]');
    expect(pick.querySelector('select')!.options[0].textContent).toBe('멈출 수 있는 로봇 모두 정지 (9 대)');
    expect(pick.querySelector('[data-phone-only]')!.textContent).toBe('K-07 은 서버 경유 정지가 꺼져 있어 여기서 멈출 수 없습니다 · 현장 폰에서 멈추세요');
    press(stopBtn());
    const sent = FakeWS.last.of('stop').map((m) => m.robot);
    expect(sent).toHaveLength(9);
    expect(sent).not.toContain('g6');
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
    expect(pick.querySelector('[data-cant-stop]')!.textContent).toBe('K-21 은 이 계정으로 정지할 수 없어 내 시뮬 정지를 엽니다');
    const first = pick.querySelector('select')!.options[0];
    expect(first.textContent).toBe('내 시뮬 모두 정지 (1 대)');   // 실기 K-21 은 들지 않음(대상대로)
    expect(pick.querySelector('[data-cant-real]')!.textContent).toBe('실기 로봇 1 대는 이 계정으로 멈출 수 없습니다 · 운영자 폰이나 현장에서 멈추세요');
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

  // Sonnet 검토 fb668832 (05:38): A1 링크 끊김 · 첫 state 전 · A2 한 대 끊김 · A3 시뮬 결과 띠 · A4 초점 · A5 거르기
  const UNSURE = '상태 모름 · 정지가 닿지 않을 수 있음 · 현장에서 확인하세요';
  const LOST = '연결이 끊겨 정지를 보내지 못했습니다. 다시 연결되면 로봇은 잠긴 상태로 시작합니다. 지금 멈춰야 하면 리모컨이나 현장에서 멈추세요.';
  const SIM = { robot_id: 'sx', generation: 1, owner_id: 'u-lee', world_id: 'w', simulation: true, state: 'RUNNING', agent_address: '' } as never;
  it('A1: 첫 state 전(wait)이어도 정지 가능 로봇은 모두 정지에 들고, 그 줄은 «상태 모름»으로 따로', () => {
    mount('u-lee', TWENTY); act(() => { FakeWS.last.open(); });   // 구독은 됐지만 state 0
    const halt = vi.spyOn(rt, 'stop');
    press(stopBtn());
    const pick = $('[aria-label="정지할 로봇 고르기"]');
    expect(pick.querySelector('select')!.options[0].textContent).toBe('모두 정지 (10 대 · 상태 모름 10)');
    expect(pick.querySelectorAll('[data-stop-unsure]')).toHaveLength(10);
    expect(pick.querySelector('[data-stop-unsure="g0"]')!.textContent).toContain(`K-01 ${UNSURE}`);
    press(stopBtn());
    expect(halt).toHaveBeenCalledTimes(10);
    const b = $$('[data-stop-band]').find((x) => x.textContent!.includes('K-01'))!;
    expect(b.textContent).toContain(UNSURE);
  });
  it('A1 · A3: 실시간 링크가 거부(denied)되고 내 시뮬이 떠 있어도 첫 누름은 고르기(시뮬 직행 아님) · 모두 정지에 로봇 + 시뮬 · 띠에 시뮬 결과 한 줄', () => {
    vi.spyOn(sim, 'live').mockReturnValue(SIM);
    const simStop = vi.spyOn(sim, 'stop').mockImplementation(() => {});
    mount('u-lee', TWENTY); feed(TWENTY);
    act(() => { FakeWS.last.drop(4403); });
    const halt = vi.spyOn(rt, 'stop').mockImplementation(() => {});
    press(stopBtn());
    expect(simStop).not.toHaveBeenCalled();
    expect($('[aria-label="정지할 로봇 고르기"] select').querySelector('option')!.textContent).toBe('모두 정지 (11 대 · 상태 모름 10)');
    const real = sim.get();
    vi.spyOn(sim, 'get').mockReturnValue({ ...real, step: 'drive', stop: { at: 1, via: 'none' } });
    press(stopBtn());
    expect(simStop).toHaveBeenCalledTimes(1);
    expect(halt).toHaveBeenCalledTimes(10);
    expect($('[data-sim-stop-band]').textContent).toContain('정지 명령을 보낼 길이 없습니다');
  });
  it('A2: 타일에서 끊긴 로봇 한 대를 골라 정지해도 «정지 요청됨»처럼 보이지 않는다', () => {
    const T = TWENTY.map((r) => (r.id === 'g4' ? { ...r, online: false } : r));
    mount('u-lee', T); feed(T);
    act(() => { tile('g4').click(); });
    press(stopBtn());
    expect(FakeWS.last.of('stop').map((m) => m.robot)).toEqual(['g4']);
    const b = $$('[data-stop-band]').find((x) => x.textContent!.includes('K-05'))!;
    expect(b.dataset.stopLost).toBe('g4');
    expect(b.textContent).toContain(`K-05 ${LOST}`);
  });
  it('A4 · 후속 2: 초점은 고르기 창이 처음 열릴 때만 정지 단추로 · 화살표로 «모두 정지»까지 내려도 초점은 고르기 칸에 그대로', () => {
    mount('u-lee', TWENTY); feed(TWENTY);
    press(stopBtn());
    const go = $('[aria-label="정지할 로봇 고르기"] button.fh-stop');
    expect(document.activeElement).toBe(go);   // 처음 열림
    const sel = $<HTMLSelectElement>('[aria-label="정지할 로봇"]');
    const pickVal = (v: string) => act(() => { sel.focus(); sel.value = v; sel.dispatchEvent(new Event('change', { bubbles: true })); });
    pickVal('g0');
    expect(document.activeElement).toBe(sel);
    pickVal(sel.options[0].value);   // 키보드로 다시 모두 정지
    expect(document.activeElement).toBe(sel);
    expect(FakeWS.last.of('stop')).toHaveLength(0);
  });
  it('후속 1: 정지 못 하는 실기가 화면에 없으면(운영 관리자 · 모두 내 로봇) «실기 N 대» 줄 없음 · 라벨 «모두 정지»', () => {
    mount('u-lee', TWENTY); feed(TWENTY);
    press(stopBtn());
    const pick = $('[aria-label="정지할 로봇 고르기"]');
    expect(pick.querySelector('[data-cant-real]')).toBeNull();
    expect(pick.querySelector('select')!.options[0].textContent).toBe('모두 정지 (10 대)');
  });
  it('후속 1: 총괄 · 실기(붙음 · 끊김) 가 섞이면 라벨 = 내 시뮬 모두 정지, 실기 수 한 줄', () => {
    const R: Robot[] = [
      { id: 'a1', name: 'K-21', owner: 'u-lee', ownerName: '이OO', battery: 70, online: true, seenAt: '14:05:20', status: 'RUNNING' },
      { id: 'a2', name: 'K-22', owner: 'u-lee', ownerName: '이OO', battery: 70, online: false, seenAt: '14:05:20', status: 'RUNNING' },
      { id: 's1', name: 'S-01', owner: 'u-kim', ownerName: '김OO', battery: 70, online: true, seenAt: '14:05:20', status: 'RUNNING', sim: true },
      { id: 's2', name: 'S-02', owner: 'u-kim', ownerName: '김OO', battery: 70, online: true, seenAt: '14:05:20', status: 'RUNNING', sim: true },
    ];
    mount('u-kim', R); feed(R);
    press(stopBtn());
    const pick = $('[aria-label="정지할 로봇 고르기"]');
    expect(pick.querySelector('select')!.options[0].textContent).toBe('내 시뮬 모두 정지 (2 대)');
    expect(pick.querySelector('[data-cant-real]')!.textContent).toBe('실기 로봇 2 대는 이 계정으로 멈출 수 없습니다 · 운영자 폰이나 현장에서 멈추세요');
    press(stopBtn());
    expect(FakeWS.last.of('stop').map((m) => m.robot).sort()).toEqual(['s1', 's2']);
  });
  it('후속 3: 서버가 받기 전(sending)과 대체 경로(fallback)는 기존 정지 문구 그대로(«상태 모름»으로 덮지 않음)', () => {
    const T = TWENTY.map((r) => (r.id === 'g4' ? { ...r, online: false } : r));
    mount('u-lee', T); feed(T);
    FakeWS.last.auto = null;   // 서버 답 없음 = sending 에 머묾
    act(() => { tile('g4').click(); });
    press(stopBtn());
    const b = $$('[data-stop-band]').find((x) => x.textContent!.includes('K-05'))!;
    expect(b.textContent).toContain('K-05 정지 요청을 보내는 중입니다');
    expect(b.dataset.stopLost).toBeUndefined();
  });
  it('후속 3: 붙어 있을 때 정지해 서버가 받은 뒤 끊긴 로봇은 기존 «정지 요청 뒤 로봇 연결이 끊겼습니다»', () => {
    mount('u-lee', TWENTY); feed(TWENTY);
    act(() => { tile('g4').click(); });
    press(stopBtn());
    act(() => { FakeWS.last.recv(state('g4', { connection: 'OFFLINE', status: null, battery: null, latched: null, stop_gen: null, applied: null })); });
    const b = $$('[data-stop-band]').find((x) => x.textContent!.includes('K-05'))!;
    expect(b.textContent).toContain('K-05 정지 요청 뒤 로봇 연결이 끊겼습니다');
    expect(b.dataset.stopLost).toBeUndefined();
  });
  it('후속 4: 고른 타일이 화면에서 사라지면(담당 바뀜) 고름을 비워 STOP 한 번은 고르기', () => {
    mount('u-lee', TWENTY); feed(TWENTY);
    act(() => { tile('g6').click(); });
    const moved = TWENTY.map((r) => (r.id === 'g6' ? { ...r, owner: 'u-park', ownerName: '박OO' } : r));   // «내 로봇»에서 빠짐
    act(() => { root!.render(<App user={USERS.find((u) => u.id === 'u-lee')} robots={moved} />); });
    expect(box.querySelector('article[data-robot="g6"]')).toBeNull();
    press(stopBtn());
    expect(FakeWS.last.of('stop')).toHaveLength(0);
    expect($('[aria-label="정지할 로봇 고르기"]')).not.toBeNull();
  });
  it('후속 5: Enter 를 누른 채 초점이 떠났다 돌아오면(keyup 을 못 받음) Space 정지(detail 0 click)는 막히지 않는다', () => {
    mount('u-lee', TWENTY); feed(TWENTY);
    press(stopBtn());
    const go = $('[aria-label="정지할 로봇 고르기"] button.fh-stop');
    act(() => { go.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true, cancelable: true })); });
    act(() => { go.blur(); go.focus(); });   // 다른 곳에서 손을 뗌(keyup 은 이 단추로 오지 않음)
    act(() => { go.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 })); });   // 전역 Space = 초점 단추 click()
    expect(FakeWS.last.of('stop')).toHaveLength(10);
  });
  it('A5: 거르기를 바꾸면 아직 보이는 고름도 비운다(STOP 한 번 = 고르기)', () => {
    mount('u-lee', TWENTY); feed(TWENTY);
    act(() => { $$('[aria-label="범위"] button')[0].click(); });   // 모두
    act(() => { tile('g6').click(); });                           // 이OO 로봇 = «내 로봇»에서도 보임
    act(() => { $$('[aria-label="범위"] button')[1].click(); });
    expect(tile('g6')).not.toBeNull();
    press(stopBtn());
    expect(FakeWS.last.of('stop')).toHaveLength(0);
    expect($('[aria-label="정지할 로봇 고르기"]')).not.toBeNull();
  });

  it('A1: 정지 가능 로봇이 있으면(구독 밖 남의 로봇뿐이어도) 내 시뮬로 바로 가지 않고 고르기 · 모두 정지 = 내 시뮬', () => {
    vi.spyOn(sim, 'live').mockReturnValue(SIM);
    const simStop = vi.spyOn(sim, 'stop').mockImplementation(() => {});
    const P = TWENTY.filter((r) => r.owner === 'u-park').slice(0, 3);   // 이OO 담당 0 대 · 남의 로봇은 요약만(구독 밖)
    mount('u-lee', P); feed(P);
    act(() => { $$('[aria-label="범위"] button')[0].click(); });
    press(stopBtn());
    expect(simStop).not.toHaveBeenCalled();
    expect($('[aria-label="정지할 로봇 고르기"] select').querySelector('option')!.textContent).toBe('모두 정지 (1 대)');
    press(stopBtn());
    expect(simStop).toHaveBeenCalledTimes(1);
    expect(FakeWS.last.of('stop')).toHaveLength(0);
  });
});

/** #533 검토(11-28 Codex) H1 · H2: 운영 관리자(박OO)가 실기 + 시뮬을 함께 가진 PC 관제 */
describe('#533 관제 · 머리줄 STOP 대상', () => {
  const MIX: Robot[] = [
    { id: 'r-a', name: 'Go2-A', owner: 'u-park', ownerName: '박OO', battery: 70, online: true, seenAt: '14:05:20', status: 'RUNNING', mission: '순찰 1/4' },
    { id: 's-1', name: '시뮬-1', owner: 'u-park', ownerName: '박OO', battery: 90, online: true, seenAt: '14:05:20', status: 'IDLE', sim: true },
  ];
  const stops = () => FakeWS.last.of('stop').map((m) => m.robot);
  const press = () => act(() => { $('header .fh-stop').click(); });
  const space = () => act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, cancelable: true })); });
  it('H1: 관제에서 시뮬 타일을 두 번 누르면 실기 로봇 탭으로 가지 않음 · 머리줄 STOP 은 그 시뮬 먼저(11-28 고친 결정: 이어서 실기 한 대도)', () => {
    mount('u-park', MIX, '#/control'); feed(MIX);
    act(() => { tile('s-1').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    expect(location.hash).not.toBe('#/fleet');
    press(); space();
    expect(stops()[0]).toBe('s-1');   // 첫 STOP 은 연 시뮬(실기가 먼저 가지 않음)
  });
  it('H1: 실기 타일은 그대로 로봇 탭 · STOP = 그 실기', () => {
    mount('u-park', MIX, '#/control'); feed(MIX);
    act(() => { tile('r-a').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    expect(location.hash).toBe('#/fleet');
    press();
    expect(stops()).toEqual(['r-a']);
  });
  const TWO: Robot[] = [...MIX, { id: 'r-b', name: 'Go2-B', owner: 'u-park', ownerName: '박OO', battery: 60, online: true, seenAt: '14:05:20', status: 'IDLE' }];
  const pickBox = () => box.querySelector<HTMLElement>('[role="dialog"][aria-label="정지할 로봇 고르기"]');
  // 11-28 조정 결정(「STOP 은 언제나 먹어야」): 시뮬이 떠 있고 대상이 없는 화면이면 어느 탭이든 시뮬 정지는 그대로 + 실기 한 대면 그 실기로 바로, 여럿이면 고르기
  // 관제(#/control)는 #535 W1 «모두 정지» 고르기(D1 · Sonnet 3: 첫 누름은 고르기, 내 시뮬은 모두 정지에 듦)를 따른다 · 그 기대는 위 #535 시험
  for (const hash of ['#/map', '#/history']) {
    it(`H2 ${hash}: 시뮬이 떠 있어도 정지할 실기가 한 대면 시뮬 정지 + 그 실기 STOP 을 바로 보냄 (Space 도)`, () => {
      vi.spyOn(sim, 'live').mockReturnValue(MIX[1] as never); const halt = vi.spyOn(sim, 'stop').mockImplementation(() => {});
      mount('u-park', MIX, hash); feed(MIX);
      press();
      expect(halt).toHaveBeenCalledTimes(1);
      expect(stops()).toEqual(['r-a']);
      expect(pickBox()).toBeNull();
      space();
      expect(halt).toHaveBeenCalledTimes(2);
      expect(stops()).toEqual(['r-a', 'r-a']);
    });
    it(`H2 ${hash}: 정지할 실기가 여럿이면 시뮬 정지 + 실기 고르기 → 고른 실기 STOP`, () => {
      vi.spyOn(sim, 'live').mockReturnValue(MIX[1] as never); const halt = vi.spyOn(sim, 'stop').mockImplementation(() => {});
      mount('u-park', TWO, hash); feed(TWO);
      press();
      expect(halt).toHaveBeenCalledTimes(1);
      expect(stops()).toEqual([]);
      const pick = pickBox()!, sel = pick.querySelector<HTMLSelectElement>('select')!;
      expect([...sel.options].map((o) => o.value)).toEqual(expect.arrayContaining(['r-a', 'r-b']));
      act(() => { sel.value = 'r-b'; sel.dispatchEvent(new Event('change', { bubbles: true })); });
      act(() => { pick.querySelector<HTMLElement>('button.fh-stop')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); pick.querySelector<HTMLElement>('button.fh-stop')!.click(); });
      expect(stops()).toContain('r-b');
      expect(stops()).not.toContain('r-a');
    });
  }
  // 11-28 고친 결정: 시뮬 탭도 시뮬 정지를 먼저 바로 보내고(고르기를 기다리지 않음), 이어서 실기 한 대면 바로 · 여럿이면 고르기 · 없으면 끝
  it('H2 #/sim: 실기 1대 → sim.stop 1 + 그 실기 STOP 1 · 고르기 없음 (Space 도)', () => {
    vi.spyOn(sim, 'live').mockReturnValue({ robot_id: 's-1' } as never); const halt = vi.spyOn(sim, 'stop').mockImplementation(() => {});
    mount('u-park', MIX, '#/sim'); feed(MIX);
    press();
    expect(halt).toHaveBeenCalledTimes(1); expect(stops()).toEqual(['r-a']); expect(pickBox()).toBeNull();
    space();
    expect(halt).toHaveBeenCalledTimes(2); expect(stops()).toEqual(['r-a', 'r-a']);
  });
  it('H2 #/sim: 실기 2대 → 첫 누름에 sim.stop 1 (고르기를 기다리지 않음) + 실기 고르기 → 고른 실기 STOP', () => {
    vi.spyOn(sim, 'live').mockReturnValue({ robot_id: 's-1' } as never); const halt = vi.spyOn(sim, 'stop').mockImplementation(() => {});
    mount('u-park', TWO, '#/sim'); feed(TWO);
    press();
    expect(halt).toHaveBeenCalledTimes(1); expect(stops()).toEqual([]);
    const pick = pickBox()!, sel = pick.querySelector<HTMLSelectElement>('select')!;
    act(() => { sel.value = 'r-b'; sel.dispatchEvent(new Event('change', { bubbles: true })); });
    act(() => { pick.querySelector<HTMLElement>('button.fh-stop')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); pick.querySelector<HTMLElement>('button.fh-stop')!.click(); });
    expect(stops()).toContain('r-b'); expect(stops()).not.toContain('r-a');
  });
  it('H2 #/sim: 실기 0대 → sim.stop 만 · 고르기 없음', () => {
    vi.spyOn(sim, 'live').mockReturnValue({ robot_id: 's-1' } as never); const halt = vi.spyOn(sim, 'stop').mockImplementation(() => {});
    mount('u-park', [MIX[1]], '#/sim'); feed([MIX[1]]);
    press(); space();
    expect(halt).toHaveBeenCalledTimes(2); expect(stops()).toEqual([]); expect(pickBox()).toBeNull();
  });
  it('r2 1: #/sim/<id> 가 이 창에 직결된 그 시뮬이면 sim.stop() 길(에이전트) 먼저 · 서버 경유로 그 시뮬 stop 없음 · 실기 2대면 고르기', () => {
    vi.spyOn(sim, 'live').mockReturnValue({ robot_id: 's-1' } as never); const halt = vi.spyOn(sim, 'stop').mockImplementation(() => {});
    mount('u-park', TWO, '#/control'); feed(TWO);
    act(() => { tile('s-1').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    expect(location.hash).toBe('#/sim/s-1');
    press();
    expect(halt).toHaveBeenCalledTimes(1);
    expect(stops()).toEqual([]);
    expect(pickBox()).not.toBeNull();
  });
  it('#533 검토 낮음: 시뮬 정지 뒤 실기 정지가 이어져도 정지띠에 시뮬 결과 줄과 실기 결과 줄이 둘 다 남음', () => {
    vi.spyOn(sim, 'live').mockReturnValue({ robot_id: 's-1' } as never); vi.spyOn(sim, 'stop').mockImplementation(() => {});
    const real = sim.get(); vi.spyOn(sim, 'get').mockReturnValue({ ...real, step: 'drive', stop: { at: 1, via: 'none' } });
    mount('u-park', MIX, '#/map'); feed(MIX);
    press();
    expect(stops()).toEqual(['r-a']);
    expect(box.querySelector('[data-sim-stop-band]')).not.toBeNull();
    expect([...box.querySelectorAll('[data-stop-band]:not([data-sim-stop-band])')].map((x) => x.textContent).join(' ')).toContain('Go2-A');
  });
  it('#533 검토 낮음: 다른 창 시뮬(#/sim/<id>) + 실기 한 대 → 정지띠에 그 시뮬 줄과 실기 줄 둘 다', () => {
    mount('u-park', MIX, '#/control'); feed(MIX);
    act(() => { tile('s-1').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    press();
    expect(stops()).toEqual(['s-1', 'r-a']);
    const lines = [...box.querySelectorAll('[data-stop-band]')].map((x) => x.textContent).join(' ');
    expect(lines).toContain('시뮬-1'); expect(lines).toContain('Go2-A');
  });
  it('H2: 정지할 실기가 없으면(시뮬뿐) 시뮬 정지만, 고르기 없음 (기존 그대로)', () => {
    vi.spyOn(sim, 'live').mockReturnValue(MIX[1] as never); const halt = vi.spyOn(sim, 'stop').mockImplementation(() => {});
    mount('u-park', [MIX[1]], '#/map'); feed([MIX[1]]);
    press();
    expect(halt).toHaveBeenCalledTimes(1);
    expect(stops()).toEqual([]);
    expect(pickBox()).toBeNull();
  });
});

describe('#533 r2 (11-28 Codex 재검토)', () => {
  const MIX: Robot[] = [
    { id: 'r-a', name: 'Go2-A', owner: 'u-park', ownerName: '박OO', battery: 70, online: true, seenAt: '14:05:20', status: 'RUNNING', mission: '순찰 1/4' },
    { id: 's-1', name: '시뮬-1', owner: 'u-park', ownerName: '박OO', battery: 90, online: true, seenAt: '14:05:20', status: 'IDLE', sim: true },
  ];
  const stops = () => FakeWS.last.of('stop').map((m) => m.robot);
  it('1: 다른 창에서 도는 시뮬 타일을 열면(이 창 직결 시뮬 없음) 머리줄 STOP · Space = 그 시뮬 먼저 + 실기 한 대 · 고르기 없음', () => {
    mount('u-park', MIX, '#/control'); feed(MIX);
    act(() => { tile('s-1').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    expect(location.hash).toBe('#/sim/s-1');
    act(() => { $('header .fh-stop').click(); });
    expect(stops()).toEqual(['s-1', 'r-a']);   // 그 시뮬 먼저, 이어서 실기 한 대(11-28 고친 결정)
    expect(box.querySelector('[role="dialog"][aria-label="정지할 로봇 고르기"]')).toBeNull();
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, cancelable: true })); });
    expect(stops()).toEqual(['s-1', 'r-a', 's-1', 'r-a']);
  });
  it('1: 다른 창 시뮬 타일 + 실기 2대 → 그 시뮬 먼저 STOP · 이어서 실기 고르기 창 → 고른 실기', () => {
    const TWO2: Robot[] = [...MIX, { ...MIX[0], id: 'r-b', name: 'Go2-B', status: 'IDLE', mission: undefined }];
    mount('u-park', TWO2, '#/control'); feed(TWO2);
    act(() => { tile('s-1').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    act(() => { $('header .fh-stop').click(); });
    expect(stops()).toEqual(['s-1']);
    const pick = box.querySelector<HTMLElement>('[role="dialog"][aria-label="정지할 로봇 고르기"]')!;
    expect(pick).not.toBeNull();
    const sel = pick.querySelector<HTMLSelectElement>('select')!;
    act(() => { sel.value = 'r-b'; sel.dispatchEvent(new Event('change', { bubbles: true })); });
    act(() => { pick.querySelector<HTMLElement>('button.fh-stop')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); pick.querySelector<HTMLElement>('button.fh-stop')!.click(); });
    expect(stops()).toContain('r-b'); expect(stops()).not.toContain('r-a');
  });
  it('4: 연결 중 잠금 · 오류 타일은 보고 자세가 없으면 엎드림 그림이 아니라 «자세 모름» 글 + 흐림', () => {
    const R: Robot[] = [{ ...MIX[0], id: 'r-l', status: 'STOP_LATCHED', mission: undefined }, { ...MIX[0], id: 'r-e', status: 'ERROR', mission: undefined }];
    mount('u-park', R, '#/control'); feed(R);
    for (const [id, t] of [['r-l', '자세 모름 · 정지 잠금'], ['r-e', '자세 모름 · 오류']]) {
      const f = tile(id).querySelector('.ct-fig')!;
      expect(f.getAttribute('data-act')).toBe('hold');
      expect(f.hasAttribute('data-dim')).toBe(true);
      expect(tile(id).querySelector('[data-act-text]')!.textContent).toBe(t);
      expect(tile(id).textContent).not.toContain('엎드림');
    }
  });
});
