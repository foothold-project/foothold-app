// 관제 탭(W1 · 시안 u5_1 ~ u5_6 을 그대로 옮긴 proto/u5): 시안 글 · 칸 순서 · 경고 먼저 · 한 번 = 고름 · 한 번 더 = 로봇 탭 · 뒤집기 · 시뮬 정면만 · 운영 관리자 거르기 · 지어낸 숫자 0 · 스크롤 없음
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { pcBoard } from '../pcboard';
import { App } from '../App';
import { USERS, type Robot } from './fixtures';
import { FakeWS, state } from './fakeWs';
import { EmptyControl, UNPICK_MS, actOf, controlPick, lastly } from '../screens/control';
import { WALK_MIN_SPEED, badgeDot, facts, jointsNow, lying, order, resetSiteBoards, labelsBelow, tempLevel, tileBadge, tileView, wallGrid, wallPick, walking } from '../proto/u5';
import { JOINTS } from '../go2model';
import { api } from '../api';
import { sim } from '../phone';
import { rt } from '../rt';
import { oldScenario } from '../menu';
import { stopLine } from '../serverdrive';
import { eunNeun, idleSim, toRobot } from '../fake';
import u5Css from '../proto/u5.css?raw';
import { fleetRow } from './fleetRow';
import { en } from '../lang';
// 옛 PC 관제 부품(관제 요약 · 상세 서랍 · 연결 상태 · 조종 준비) 시험: PC 로봇 탭은 시안 u4 라 부품을 앱 맥락 안에 직접 그린다 → W1 u5
beforeEach(() => { pcBoard.on = true; });
afterEach(() => { pcBoard.on = false; });

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
const tiles = () => $$('[aria-label="로봇 타일"] .tile');
const tile = (id: string) => $(`.tile[data-robot="${id}"]`);
/** 시안 .sts 칸의 큰 글(작은 글 빼고) */
const fact = (id: string, k: string) => { const e = tile(id).querySelector(`[data-fact="${k}"]`); return e ? [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('') : null; };
const small = (id: string, k: string) => tile(id).querySelector(`[data-fact="${k}"] small`)?.textContent ?? null;
/** 서버 요약(GET /dashboard) 답을 정해 둠 */
const DASH = { robots_total: 8, robots_online: 7, robots_attention: 1, robots_running: 6, approvals_pending: 3, operators: [] };
const dashOk = (d: object = {}) => vi.spyOn(api, 'dashboard').mockResolvedValue({ ...DASH, ...d } as never);
const seg = (label: string, i: number) => $$(`[aria-label="${label}"] [role="button"]`)[i];

/** 20대: 15번 = 정지 잠금(끊김), 9번 = 배터리 낮음(주황) · 받은 순서로는 뒤쪽, 2번 = 시뮬, 나머지 = 이OO·박OO 번갈아 임무 중·대기 */
const TWENTY: Robot[] = Array.from({ length: 20 }, (_, i) => ({
  id: `g${i}`, name: `K-${String(i + 1).padStart(2, '0')}`, owner: i % 2 ? 'u-park' : 'u-lee', ownerName: i % 2 ? '박OO' : '이OO',
  battery: i === 9 ? 12 : i === 4 ? null : 70, online: i !== 15, seenAt: '14:05:20', status: i === 15 ? 'STOP_LATCHED' : i % 3 ? 'RUNNING' : 'IDLE',
  mission: i % 3 && i !== 15 ? `순찰 ${i % 4}/4` : undefined, sim: i === 2,
  serverDrive: i !== 2,   // 실기는 서버 경유 정지가 켜진 로봇(H1: 꺼진 실기는 따로 시험)
}));
/** 시안 이름 그대로 8 대(K-01 ~ K-08 · K-07 = 끊김 · K-08 = 시뮬) */
const EIGHT: Robot[] = Array.from({ length: 8 }, (_, i) => ({ id: `k${i + 1}`, name: `K-0${i + 1}`, owner: i < 4 ? 'u-lee' : 'u-park', ownerName: i < 4 ? '이OO' : '박OO',
  battery: 70, online: i !== 7 && i !== 6, seenAt: '14:02:00', status: i === 7 ? null : 'RUNNING', mission: i === 7 ? undefined : '공정 순찰 A 2/4', sim: i === 7, serverDrive: i !== 7 }));
/** 타일 벽은 8 칸까지(wallPick) · 특정 로봇 타일을 보는 시험은 그 로봇들만 */
const SOME = (...ids: string[]) => TWENTY.filter((r) => ids.includes(r.id));
const temp = (joints: (number | null)[]) => ({ robot_info: { source: 'GO2_DDS', attitude: { roll: 0, pitch: 0 }, error_code: 0, fallen: false, fallen_source: 'imu_tilt_estimate',
  temperature: { joints, battery: [], imu: null, body: [], age_s: 0.1 } } });

/** 진행 중인 임무(state.run) 한 건. 팀장 21:16: 임무 중 타일만 뒤 1 m 따라가기 + 현장 */
const RUN = (status = 'MOVING') => ({ run: { run_id: 'r1', status, step: 0, wait_reason: null, fail_code: null, progress: { done: 2, total: 4 } } });
const runs = (ids: string[], status = 'MOVING') => Object.fromEntries(ids.map((id) => [id, RUN(status)]));

describe('관제 탭', () => {
  it('시안 칸 순서: 보기 · 첫 화면으로 · 수 여섯(임무 중 · 충전 · 점검 · 연결 중 · 시뮬 대기 · 경고) · 뒤집기 · 데모 표시 · 범위, 그 아래 타일 벽 · 오른쪽 칸', async () => {
    dashOk({ robots_running: 7 });
    mount('u-kim', EIGHT); feed(EIGHT);
    await act(async () => {});
    const u5 = $('.proto > main.u5');
    expect([...u5.children].map((e) => e.className)).toEqual(['tb', 'wall', 'side']);
    expect($$('.u5 .tb .seg2 [data-v]').map((e) => e.textContent)).toEqual(['타일 보기', '지도 보기']);
    expect($('.u5 .tb .pinf').textContent).toBe('첫 화면으로');
    expect($$('.u5 .tb .cnt').map((e) => e.dataset.sum)).toEqual(['임무 중', '충전', '점검', '연결 중', '시뮬 대기', '경고']);
    expect($('[data-sum="임무 중"] b').textContent).toBe('6');   // 타일이 «임무 중» 인 로봇 = RUNNING · 끊기지 않음(K-07 끊김 · K-08 시뮬 대기 빼고)
    expect($('[data-sum="충전"] b').textContent).toBe('');   // 가용(GET /robots/availability)을 받지 못함 = 수를 비움(em dash 없음)
    expect($('[data-sum="충전"]').dataset.none).toBe('true');
    expect($('[data-sum="점검"] b').textContent).toBe('');   // 가용을 받지 못함 = 수를 비움
    expect($('[data-sum="점검"]').title).toBe('가용(GET /robots/availability)을 받지 못했습니다');
    expect($('[data-sum="시뮬 대기"] b').textContent).toBe('1');
    expect($('.u5 .tb .flipb').textContent).toBe('정면 상태로 뒤집기');
    expect($$('.u5 .tb .flt [data-f]').map((e) => e.textContent)).toEqual(['모두', '내 로봇']);
    expect(tiles().map((t) => t.dataset.t)).toEqual(['K-01', 'K-02', 'K-03', 'K-04', 'K-05', 'K-06', 'K-07', 'K-08']);
    expect($('.u5 .wall').style.gridTemplateColumns).toBe('repeat(4,1fr)');
    expect($$('.u5 .side > .pane').map((e) => e.querySelector('.ttl')!.textContent)).toEqual(['작은 지도', '최근 경고']);
  });

  it('타일 한 장 = 시안 칸 그대로: 칸(뒤 1 m) · 이름 · 모드 · 임무 + 할 일 · 진행 막대 · 위치 · 배터리 · 온도 · 연결 · 조종', () => {
    mount('u-kim', EIGHT); feed(EIGHT, { k1: { latency_ms: 38, gait: { gait: 'start' }, ...RUN() } });
    const t = tile('k1');
    expect([...t.children].map((e) => e.className)).toEqual(['cv', 'inf']);
    expect(t.querySelector('.cv .ov')!.textContent).toBe('뒤 2 m');
    expect(t.querySelector('.nm b')!.textContent).toBe('K-01');
    expect(t.querySelector('.nm .md')!.textContent).toBe('START');
    expect(t.querySelector('.ln span')!.textContent).toBe('공정 순찰 A');
    expect(t.querySelector('.ln em')!.textContent).toBe('할 일 2 / 4');
    expect(t.querySelector<HTMLElement>('.pg i')!.style.width).toBe('50%');
    expect([...t.querySelectorAll('.sts .s')].map((e) => e.getAttribute('data-fact'))).toEqual(['battery', 'temp', 'link', 'who']);
    expect([fact('k1', 'battery'), fact('k1', 'link'), small('k1', 'link')]).toEqual(['70 %', '연결', '38 ms']);
    expect(tile('k2').querySelector('.nm .md')!.textContent).toBe('');   // 걷기 모드를 받기 전
  });

  it('PC 첫 화면 = 관제(메뉴 첫 탭), 20대: 타일은 8 칸(wallPick · 팀장 23:53) · 나머지 수 한 줄 · 경고 타일이 맨 앞 + 테두리 · 머리표', async () => {
    dashOk({ robots_attention: 1 });
    mount('u-kim', TWENTY); feed(TWENTY);
    await act(async () => {});
    expect($('h1').textContent).toBe('관제');
    expect($('[aria-label="주 메뉴"] [aria-current="page"]').getAttribute('data-href')).toBe('#/control');
    expect(tiles()).toHaveLength(8);
    expect($('[aria-label="로봇 타일"]').dataset.count).toBe('8'); expect($('[aria-label="로봇 타일"]').dataset.all).toBe('20');
    expect($('[data-wall-rest]').textContent).toBe('타일 8 대 · 나머지 12 대는 지도 보기 · 로봇 탭');
    expect(tiles()[0].dataset.robot).toBe('g9');
    expect(tile('g9').dataset.tone).toBe('warn'); expect(tile('g9').classList.contains('lv-warn')).toBe(true); expect(tile('g9').classList.contains('warncell')).toBe(true);
    expect(tile('g9').querySelector('[data-warn-flag]')!.textContent).toBe('주의 · 배터리 낮음');
    expect(tile('g3').dataset.tone).toBeUndefined();
    expect($('[data-sum="경고"] b').textContent).toBe('1');
    expect(wallGrid(8).zoom).toBe(1);   // 8 칸 = 시안 4×2 그대로(줄이지 않음)
  });

  it('타일 8 칸 고르기(wallPick · 팀장 23:53): 위험 · 경고 → 실기(Go2 X) → 점검 · 충전 · 시뮬 · 끊김/주의 한 대씩 → 임무 중 → 나머지, 차례는 줄 차례 그대로', () => {
    const base = { owner: 'u-kim', ownerName: '김OO', battery: 70, online: true, seenAt: '14:05:20' };
    const av = (demo: boolean, x: Partial<{ charging: boolean; job: { kind: 'maint' | 'swap'; text: string } }> = {}) => ({ demo, label: null, charging: false, job: null, ...x });
    const F = (r: Robot, a?: ReturnType<typeof av>) => facts({ ...base, ...r } as Robot, 'u-kim', new Map(), a);
    const go2 = F({ id: 'go2', name: 'Go2 X', status: 'IDLE' } as Robot, av(false));
    const demo = (i: number, x: Partial<Robot> = {}, a: Parameters<typeof av>[1] = {}) => F({ id: `d${i}`, name: `K-0${i}`, sim: true, status: 'RUNNING', ...x } as Robot, av(true, a));
    const list = order([go2,
      demo(1), demo(2), demo(3), demo(4), demo(5),
      demo(6, { status: 'IDLE' }, { job: { kind: 'maint', text: '점검 중' } }), demo(7, { status: 'IDLE' }, { charging: true }),
      demo(8, { online: false }), F({ id: 's1', name: 'S-1', sim: true, status: 'IDLE' } as Robot, av(false)), F({ id: 's2', name: 'S-2', sim: true, status: 'IDLE' } as Robot, av(false)),
      demo(9, { status: 'ERROR' })]);
    const got = wallPick(list).map((f) => f.x.id);
    expect(got).toHaveLength(8);
    for (const id of ['d9', 'go2', 'd6', 'd7', 'd8']) expect(got, id).toContain(id);   // 위험 · 실기 · 점검 · 충전 · 끊김
    expect(got).not.toContain('s1'); expect(got).not.toContain('s2');   // 데모가 8 칸을 채우면 대기 시뮬은 밖(팀장 01:08: 데모는 대기여도 시뮬보다 먼저)
    expect(got).toEqual(list.map((f) => f.x.id).filter((id) => got.includes(id)));   // 줄 차례 그대로
    expect(wallPick(list.slice(0, 5)).map((f) => f.x.id)).toEqual(list.slice(0, 5).map((f) => f.x.id));   // 8 대 이하면 전부
  });
  it('서버 구성(팀장 01:08 · K-01 대기 시뮬 · K-02~07 데모 · Go2 X 실기 · K-08 임무 시뮬): 8 칸 = Go2 X · 02~07 · K-08 · 시뮬은 하나(임무 중 먼저)', () => {
    const base = { owner: 'u-kim', ownerName: '김OO', battery: 70, online: true, seenAt: '14:05:20' };
    const av = (demo: boolean, x: object = {}) => ({ demo, label: null, charging: false, job: null, ...x });
    const F = (r: Partial<Robot>, a: ReturnType<typeof av>, run = false) => facts({ ...base, ...r, mission: run ? '공정 순찰 A 2/4' : undefined, run: run ? { run_id: `r-${r.id}`, scenario_name: '공정 순찰 A', status: 'MOVING', progress: { done: 2, total: 4 } } as unknown as Robot['run'] : null } as Robot, 'u-kim', new Map(), a);
    const go2 = F({ id: 'go2', name: 'Go2 X', status: 'IDLE' }, av(false));
    const D = (n: number, x: Partial<Robot> = {}, a: object = {}, run = false) => F({ id: `k0${n}`, name: `K-0${n}`, sim: true, status: run ? 'RUNNING' : 'IDLE', ...x }, av(true, a), run);
    const demos = [D(2, {}, {}, true), D(3, {}, {}, true), D(4, {}, { charging: true }), D(5, {}, {}, true), D(6, {}, { job: { kind: 'maint', text: '점검 중' } }), D(7)];
    const k01 = F({ id: 'k01', name: 'K-01', sim: true, status: 'IDLE' }, av(false)), k08 = F({ id: 'k08', name: 'K-08', sim: true, status: 'RUNNING' }, av(false), true);
    expect(wallPick(order([k01, ...demos, k08, go2])).map((f) => f.x.name)).toEqual(['Go2 X', 'K-02', 'K-03', 'K-04', 'K-05', 'K-06', 'K-07', 'K-08']);
    // 시뮬이 대기 하나뿐이면 그 대기 시뮬, 임무 중 시뮬이 둘이면 앞의 하나만
    const k09 = F({ id: 'k09', name: 'K-09', sim: true, status: 'RUNNING' }, av(false), true);
    expect(wallPick(order([k01, ...demos.slice(0, 5), go2, k08, k09])).map((f) => f.x.name).filter((n) => ['K-01', 'K-08', 'K-09'].includes(n))).toEqual(['K-08']);
    const k10 = F({ id: 'k10', name: 'K-10', sim: true, status: 'IDLE' }, av(false));
    expect(wallPick(order([k01, ...demos, go2, k10])).map((f) => f.x.name).filter((n) => ['K-01', 'K-10'].includes(n))).toEqual(['K-01']);
  });
  it('상태 배지 tileBadge(팀장 01:17 · 01:19): 갈래마다 하나 · 같은 사실이면 실기 · 데모 · 시뮬 종류가 달라도 같은 배지(시뮬 임무만 «시뮬 중»)', () => {
    const base = { owner: 'u-kim', ownerName: '김OO', battery: 70, online: true, seenAt: '14:05:20', status: 'IDLE' };
    const RUNX = (status: string) => ({ id: 'r1', run_id: 'r1', scenario_name: '순찰', status, step: 0, wait_reason: null, fail_code: null, progress: { done: 1, total: 4 } }) as unknown as Robot['run'];
    const kinds = { real: { sim: false, demo: false }, demo: { sim: true, demo: true }, sim: { sim: true, demo: false } } as const;
    const B = (k: keyof typeof kinds, r: Partial<Robot> = {}, a: object = {}) => tileBadge(facts({ id: `b-${k}`, name: 'B', ...base, sim: kinds[k].sim, ...r } as Robot, 'u-kim', new Map(),
      { demo: kinds[k].demo, label: null, charging: false, job: null, ...a }))?.text;
    const all = (r: Partial<Robot> = {}, a: object = {}) => (['real', 'demo', 'sim'] as const).map((k) => B(k, r, a));
    expect(all({ online: false, status: null })).toEqual(['연결 끊김', '연결 끊김', '연결 끊김']);
    expect(all({ status: 'STOP_LATCHED' })).toEqual(['정지 잠금', '정지 잠금', '정지 잠금']);
    expect(B('real', { robotInfo: { fallen: true } as Robot['robotInfo'] })).toBe('넘어짐');
    expect(all({}, { job: { kind: 'maint', text: '정기 점검' } })).toEqual(['점검 중', '점검 중', '점검 중']);
    expect(all({}, { charging: true })).toEqual(['충전 중', '충전 중', '충전 중']);
    expect(all({ status: 'RUNNING', run: RUNX('MOVING') })).toEqual(['임무 중', '임무 중', '시뮬 중']);
    expect(all({ status: 'RUNNING', run: RUNX('PAUSED') })).toEqual(['임무 멈춤', '임무 멈춤', '임무 멈춤']);
    expect(all()).toEqual(['대기 · 임무 전', '대기 · 임무 전', '대기 · 임무 전']);
    expect(all({ status: 'STOP_LATCHED' }, { charging: true })).toEqual(['정지 잠금', '정지 잠금', '정지 잠금']);   // 위에서 먼저 맞는 하나
    expect(all({}, { charging: true, job: { kind: 'swap', text: '배터리 교체' } })).toEqual(['충전 중', '충전 중', '충전 중']);   // 지금 상태가 일정 칸보다 먼저(01:31 K-04)
    expect(all({}, { job: { kind: 'swap', text: '배터리 교체' } })).toEqual(['배터리 교체', '배터리 교체', '배터리 교체']);
  });
  it('배지 통일(팀장 02:14): 종류마다 글 색 · 점 색 · 펄스 · 같은 틀(아이콘 · 글 · 점)', () => {
    const base = { owner: 'u-kim', ownerName: '김OO', battery: 70, online: true, seenAt: '14:05:20', status: 'IDLE' };
    const RUNX = (status: string) => ({ id: 'r1', run_id: 'r1', scenario_name: '순찰', status, step: 0, wait_reason: null, fail_code: null, progress: { done: 1, total: 4 } }) as unknown as Robot['run'];
    const B = (r: Partial<Robot>, a: object = {}, demo = false) => tileBadge(facts({ id: 'b1', name: 'B', ...base, ...r } as Robot, 'u-kim', new Map(), { demo, label: null, charging: false, job: null, ...a }))!;
    const look = (b: ReturnType<typeof B>) => [b.key, b.col, badgeDot(b), b.pulse];
    expect(look(B({ status: 'RUNNING', run: RUNX('MOVING') }))).toEqual(['run', 'var(--u5-ok)', 'var(--u5-dot-red)', true]);   // 임무 중: 글 그대로 · 점 빨강
    expect(look(B({ status: 'RUNNING', run: RUNX('MOVING') }, {}, true))).toEqual(['run', 'var(--u5-ok)', 'var(--u5-dot-red)', true]);   // 데모도 같음
    expect(look(B({}, { charging: true }))).toEqual(['charging', 'var(--u5-on)', 'var(--u5-ok)', true]);   // 충전 중: 글 하양 · 점 초록
    expect(look(B({ sim: true, status: 'RUNNING', run: RUNX('MOVING') }))).toEqual(['simrun', 'var(--u5-sim)', 'var(--u5-sim)', true]);   // 시뮬 중: 파랑 · 파랑
    expect(look(B({}, { job: { kind: 'maint', text: '점검' } }))).toEqual(['maint', '#a9b8c6', '#a9b8c6', true]);   // 점검 중: 색 그대로
    expect(look(B({ status: 'RUNNING', run: RUNX('PAUSED') }))).toEqual(['paused', 'var(--u5-amb)', 'var(--u5-amb)', true]);
    expect(look(B({ online: false, status: null }))).toEqual(['lost', 'var(--u5-amb)', 'var(--u5-amb)', false]);
    expect(look(B({ status: 'STOP_LATCHED' }))).toEqual(['latched', 'var(--u5-red)', 'var(--u5-red)', false]);
    expect(look(B({}))).toEqual(['idle', '#a9b8c6', '#a9b8c6', false]);
    const pre = B({ online: false, seenAt: '', status: null });   // 연결 전: 기본 B 안 = 하얀 점 멈춤 · 흐리게
    expect([...look(pre), pre.dim]).toEqual(['pre', '#a9b8c6', 'var(--u5-on)', false, true]);
    // 같은 틀: 모든 배지가 점(i) 하나를 갖고, 펄스는 .chk 로만 · 움직임 줄이기면 멈춤
    mount('u-kim', EIGHT); feed(EIGHT);
    for (const t of tiles()) { const b = t.querySelector<HTMLElement>('[data-badge]'); if (!b) continue; expect(b.querySelectorAll(':scope > i').length, b.dataset.badge).toBe(1); expect(b.classList.contains('chk')).toBe(b.dataset.pulse === '1'); }
    expect(u5Css).toContain('.u5 .stb.chk i{animation:blink'); expect(u5Css).toMatch(/prefers-reduced-motion:reduce\)\{[^\n]*\.u5 \.stb\.chk i\{animation:none\}/);
    expect(u5Css).toMatch(/\.u5\{[^}]*--u5-on:#FFFFFF;--u5-dot-red:#FF4D4F/); expect(u5Css).toMatch(/\.proto\.light \.u5\{[^}]*--u5-on:#1F2421;--u5-dot-red:#E04A2F/);
  });
  it('작은 지도 이름표: 가까운 두 점(r0118 K-02 · K-04)은 아래쪽 점 이름표를 점 아래로 · 먼 점은 둘 다 위', () => {
    expect([...labelsBelow([{ id: 'k2', x: 100, y: 120, w: 40 }, { id: 'k4', x: 102, y: 108, w: 40 }])]).toEqual(['k2']);   // 위쪽 K-04 는 위 · 아래쪽 K-02 는 아래
    expect(labelsBelow([{ id: 'a', x: 0, y: 100, w: 40 }, { id: 'b', x: 80, y: 100, w: 40 }]).size).toBe(0);
  });
  it('시뮬 파랑(팀장 02:07): 임무 중 시뮬 배지 글 · 점 = --u5-sim, 이름 옆 «시뮬» 태그도 --u5-sim(어둠 #4C9BFF · 밝음 #2F6FE0 = foothold-brand sim 토큰)', () => {
    const L: Robot[] = EIGHT.map((r) => (r.id === 'k8' ? { ...r, online: true, status: 'RUNNING' as const } : r));   // EIGHT 의 k8 은 꺼진 시뮬 · 붙은 임무 중 시뮬로
    mount('u-kim', L); feed(L, { k8: RUN() });
    const b = tile('k8').querySelector<HTMLElement>('[data-badge="simrun"]')!;
    expect(b.textContent).toBe('시뮬 중'); expect(b.style.color).toBe('var(--u5-sim)');
    expect(b.querySelector<HTMLElement>(':scope > i')!.style.background).toBe('var(--u5-sim)');
    expect(u5Css).toContain('.u5 .chip.sim{border-style:dashed;border-color:var(--u5-sim);color:var(--u5-sim)}');
    expect(u5Css).toMatch(/\.u5\{[^}]*--u5-sim:#4C9BFF/); expect(u5Css).toMatch(/\.proto\.light \.u5\{[^}]*--u5-sim:#2F6FE0/);
  });
  it('배치: 4 대 이하 2×2 (u5_6), 8 대 이하 4×2 (u5_1), 22 대 = 줄인 칸이 1472×900 안에 다 들어감', () => {
    expect(wallGrid(3)).toEqual({ cols: 2, rows: 2, zoom: 1 });
    expect(wallGrid(8)).toEqual({ cols: 4, rows: 2, zoom: 1 });
    // 9 대(실서버 Go2 X + 시뮬 8): 5 × 2 칸에 한 칸이 비지 않게 줄마다 5 · 4 대로 나눠 꽉 채움(열 20 · 윗줄 4 칸씩 · 아랫줄 5 칸씩)
    expect(wallGrid(9)).toMatchObject({ cols: 5, rows: 2, units: 20, span: [4, 4, 4, 4, 4, 5, 5, 5, 5] });
    for (let n = 9; n <= 22; n++) { const g = wallGrid(n); if (g.span) { expect(g.span.length, `${n}`).toBe(n); let row = 0, rows = 0; for (const s of g.span) { row += s; if (row === g.units) { rows++; row = 0; } } expect([row, rows], `${n}`).toEqual([0, g.rows]); } }
    for (const n of [9, 12, 16, 22, 40]) {
      const g = wallGrid(n);
      expect(g.cols * g.rows, `${n}`).toBeGreaterThanOrEqual(n);
      expect(g.cols * 357.5 * g.zoom + 14 * (g.cols - 1), `${n}`).toBeLessThanOrEqual(1472 + 0.01);
      expect(g.rows * 440 * g.zoom + 20 * (g.rows - 1), `${n}`).toBeLessThanOrEqual(900 + 0.01);
    }
  });

  it('값이 없는 칸은 시안 칸을 두고 글을 비움(em dash 없음) · 온도 · 배터리 · 위치를 지어내지 않는다 · «미확인» 글자 없음', () => {
    mount('u-kim', TWENTY); feed(TWENTY);
    expect(fact('g3', 'temp')).toBe('');
    expect(small('g3', 'temp')).toBe('');
    expect(fact('g3', 'battery')).toBe('70 %');
    expect(small('g3', 'battery')).toBe('');   // 남은 시간은 서버 값이 없음
    expect(fact('g4', 'battery')).toBe('');
    expect(tiles().some((t) => t.textContent!.includes('—'))).toBe(false);
    expect(tile('g3').querySelectorAll('.ln')[1].textContent).toBe('');   // 위치 없음
    expect(tiles().some((t) => t.textContent!.includes('미확인'))).toBe(false);
    expect(tile('g3').querySelector('.ln span')!.textContent).toBe('임무 전 · 대기');   // 임무 없음 = 서버 대기 상태 그대로(팀장 01:08)
    expect(tile('g5').querySelector('.ln em')!.textContent).toBe('할 일 1 / 4');
  });

  it('관절 온도는 로봇이 보낸 robot_info.temperature 의 최고값 · 단계(보통 · 주의 · 경고 · 위험), 위치는 state 값', () => {
    mount('u-kim', TWENTY);
    feed(TWENTY, { g3: { ...temp([40, 41, 42, 43, 61, 44, 45, 46, 47, 48, 49, null]), location: { floor_id: 'f1', map_version_id: 'v1', x: 1.25, y: 2, yaw: 0, confidence: 1, updated_at: '' } } });
    expect(fact('g3', 'temp')).toBe('61 °C');
    expect(small('g3', 'temp')).toBe('경고');
    expect(tile('g3').querySelector('[data-fact="temp"]')!.className).toBe('s r');
    expect(tile('g3').dataset.tone).toBe('bad');
    expect(tile('g3').querySelector('[data-warn-flag]')!.textContent).toBe('경고 · 왼쪽 앞다리 허벅지 61 °C');   // JOINTS 순서 FR · FL · RR · RL × hip · thigh · calf → 5 번째 = FL_thigh
    expect(tile('g3').querySelectorAll('.ln')[1].textContent).toBe('위치 1.3, 2.0 m');
    expect(JSON.parse(tile('g3').querySelector('canvas')!.dataset.go2!).hot).toEqual({ FL_thigh: 'hot' });   // 타일 카메라: 그 관절만 칠함(관절마다 자기 단계)
    expect([tempLevel(48), tempLevel(51), tempLevel(61), tempLevel(72), tempLevel(null)]).toEqual([null, 'warn', 'bad', 'crit', null]);
  });

  // 팀장 21:26: Go2 X 처럼 정지 잠금과 높지 않은 관절 온도(41 °C)가 붙어 온도가 잠금 원인처럼 읽혔다 → 머리표 = 잠금 까닭(서버 값만), 온도 칩은 온도 문턱(tempLevel)을 넘을 때만 경고색
  it('정지 잠금 + 보통 온도: 머리표 «경고 · 정지 잠금 · 까닭»(서버 latch_reason · 없으면 까닭 미상), 정면 온도 칩은 회색 «최고 관절 온도 41 °C», 최근 경고 제목도 잠금', () => {
    mount('u-kim', TWENTY); feed(TWENTY, { g3: { status: 'STOP_LATCHED', ...temp([40, 41, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]) } });
    const flag = () => tile('g3').querySelector('[data-warn-flag]')!.textContent;
    expect(flag()).toBe('경고 · 정지 잠금 · 까닭 미상');   // 칸 없음
    expect(tile('g3').dataset.tone).toBe('bad');
    act(() => { $('.u5 .flipb').click(); });
    const ov = tile('g3').querySelector<HTMLElement>('.cv .ov')!;
    expect(ov.textContent).toBe('최고 관절 온도 41 °C'); expect(ov.style.color).toBe('');
    expect(small('g3', 'temp')).toBe('보통');
    const row = $('[aria-label="최근 경고"] [data-alert="g3"]');
    expect([...row.querySelector('div')!.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('')).toBe('K-04 정지 잠금 · 까닭 미상');
    const T = temp([40, 41, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]);
    const W = { BOOT: '기동 잠금', USER_STOP: '사람 정지', FALL: '넘어짐', LINK_LOST: '연결 끊김', DEVICE_FAULT: '장치 고장', POLICY: '권한 확인 늦음', LEASE_END: '조종권 끝남', OTHER: '기타' };
    const E = { BOOT: 'boot latch', USER_STOP: 'stopped by a person', FALL: 'fall', LINK_LOST: 'link lost', DEVICE_FAULT: 'device fault', POLICY: 'permission check late', LEASE_END: 'control ended', OTHER: 'other' };
    for (const [k, v] of Object.entries(W)) {
      act(() => { FakeWS.last.recv(state('g3', { status: 'STOP_LATCHED', ...T, latch_reason: k, robot_info: { ...T.robot_info, fallen: k !== 'FALL' }, stop_applied: true } as never)); });
      expect(flag()).toBe(`경고 · 정지 잠금 · ${v}`);   // latch_reason 하나만 · fallen · stop_applied 로 짐작해 붙이지 않음
      expect(en(flag()!)).toBe(`Warning · Stop latched · ${E[k as keyof typeof E]}`);
    }
    act(() => { FakeWS.last.recv(state('g3', { status: 'STOP_LATCHED', ...T, latch_reason: null, safety_reason: 'OUTPUT_STALLED' } as never)); });
    expect(flag()).toBe('경고 · 정지 잠금 · 까닭 미상');   // null
    act(() => { FakeWS.last.recv(state('g3', { status: 'STOP_LATCHED', ...T, latch_reason: 'NEW_CODE' } as never)); });
    expect(flag()).toBe('경고 · 정지 잠금 · 까닭 미상');   // 모르는 값
    expect(en('정지 잠금 · 까닭 미상')).toBe('Stop latched · reason unknown');
    // 로봇 목록(RobotSummary) 값: 소켓 state 가 칸을 주지 않을 때만
    const S = (o: object) => toRobot({ id: 'x', name: 'X', model: 'Go2', owner: null, connection: 'ONLINE', status: 'STOP_LATCHED', battery: null, location: null, lease: null, current_run: null, devices: [], attention: [], simulation: false, server_drive_allowed: true, ...o } as never);
    expect([S({ latch_reason: 'BOOT' }).latchReason, S({ latch_reason: null }).latchReason, S({}).latchReason]).toEqual(['BOOT', null, null]);
  });
  // 팀장 21:45: 제목과 덧말이 둘 다 «정지 잠금» 으로 겹치지 않게 · 21:56: 덧말은 비우고 시각은 오른쪽 칸만 · reviewer L1: 잠금(bad) + 온도 주의(warn) = bad
  it('최근 경고 덧말: 임무 없는 잠금 로봇은 덧말을 비우고 시각은 오른쪽 칸 하나만, 잠금 + 온도 주의 = 테두리 빨강', () => {
    const R: Robot[] = [
      { ...TWENTY[3], id: 'a1', name: 'A-1', status: 'STOP_LATCHED', mission: undefined, statusSince: { status: 'STOP_LATCHED', at: '2026-11-28T20:53:54' } },
      { ...TWENTY[3], id: 'a2', name: 'A-2', status: 'STOP_LATCHED', mission: undefined },
      { ...TWENTY[3], id: 'a3', name: 'A-3', status: 'STOP_LATCHED', mission: '공정 순찰 A 2/4' },
    ];
    mount('u-kim', R); feed(R, { a2: temp([40, 41, 42, 43, 52, 44, 45, 46, 47, 48, 49, null]) });
    const sub = (id: string) => $(`[aria-label="최근 경고"] [data-alert="${id}"] small`).textContent;
    const row = (id: string) => $(`[aria-label="최근 경고"] [data-alert="${id}"]`).textContent!;
    expect(sub('a1')).toBe(''); expect(sub('a2')).toBe('');
    expect(row('a1').split('20:53').length - 1).toBe(1);   // 시각은 오른쪽 칸 한 번만
    expect(row('a2').split('이어진 상태').length - 1).toBe(1);
    expect(sub('a3')).toBe('공정 순찰 A');   // 임무가 있으면 임무 이름 그대로
    expect(tile('a2').dataset.tone).toBe('bad');
    expect(tile('a2').querySelector('[data-warn-flag]')!.textContent).toBe('경고 · 정지 잠금 · 까닭 미상');
    expect(tile('a2').querySelector('[data-fact="temp"]')!.className).toBe('s w');
  });
  it('정지 잠금 + 문턱 넘은 온도(61 °C): 머리표는 잠금(위험 70 °C 전까지), 온도 칩만 경고색 · 관절 이름, 잠금 없으면 전처럼 온도가 머리표', () => {
    mount('u-kim', TWENTY); feed(TWENTY, { g3: { status: 'STOP_LATCHED', ...temp([40, 41, 42, 43, 61, 44, 45, 46, 47, 48, 49, null]) }, g5: temp([40, 41, 42, 43, 52, 44, 45, 46, 47, 48, 49, null]) });
    expect(tile('g3').querySelector('[data-warn-flag]')!.textContent).toBe('경고 · 정지 잠금 · 까닭 미상');
    expect(tile('g3').querySelector('[data-fact="temp"]')!.className).toBe('s r');
    expect(tile('g5').querySelector('[data-warn-flag]')!.textContent).toBe('주의 · 왼쪽 앞다리 허벅지 52 °C');
    act(() => { $('.u5 .flipb').click(); });
    const ov = tile('g3').querySelector<HTMLElement>('.cv .ov')!;
    expect(ov.textContent).toBe('왼쪽 앞다리 허벅지 61 °C'); expect(ov.style.color).toBe('var(--u5-red)');
    expect(tile('g5').querySelector<HTMLElement>('.cv .ov')!.style.color).toBe('var(--u5-amb)');   // 주의(50 °C ~) = 주황
  });

  it('관절 위험(70 °C 이상) = 경보 칸(u5_5): 제목 · 그 로봇 정지 · 로봇 탭에서 보기, 정지는 기존 정지 길(rt.stop)로 그 로봇만', () => {
    mount('u-lee', TWENTY); feed(TWENTY, { g4: temp([40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 72]) });
    expect(tiles()[0].dataset.robot).toBe('g4');
    expect(tile('g4').dataset.tone).toBe('crit');
    const a = $('[data-alarm="g4"]');
    expect(a.querySelector('.ttl')!.textContent).toBe('경보 · K-05 관절 위험');
    expect(a.textContent).toContain('왼쪽 뒷다리 무릎이 72 °C 입니다.');
    act(() => { a.querySelector<HTMLElement>('.rstop')!.click(); });
    expect(FakeWS.last.of('stop').map((m) => m.robot)).toEqual(['g4']);
    expect($$('[aria-label="최근 경고"] [data-alert]').some((e) => e.dataset.alert === 'g4')).toBe(false);   // 경보 칸에 나온 로봇은 최근 경고에서 뺌
  });

  it('경고 칸을 골라도 고른 표시가 남음: 경고 테두리 위에 바깥 초록 고리(어둠 · 밝음 · 경고 규칙보다 뒤)', () => {
    mount('u-kim', TWENTY); feed(TWENTY, { g3: { status: 'STOP_LATCHED' } });
    act(() => { tile('g3').click(); });
    expect(tile('g3').className.split(' ')).toEqual(expect.arrayContaining(['sel', 'lv-bad', 'warncell']));
    const at = (r: string) => u5Css.indexOf(r);
    expect(at('.u5 .tile.sel.warncell{box-shadow:0 0 0 3px #00c389')).toBeGreaterThan(at('.u5 .tile.lv-crit{box-shadow'));
    expect(at('.proto.light .u5 .tile.sel.warncell{box-shadow:0 0 0 3px #18A07E')).toBeGreaterThan(at('.proto.light .u5 .tile.lv-bad'));
  });
  // 팀장 00:19 누름 규칙: 한 번 = 고름 · 고른 것 다시 한 번 = 풂 · 두 번(더블클릭) = 로봇 탭. 타일 · 지도 보기 3D 표식 · 오른쪽 줄 같음
  const click = (el: Element, detail = 1) => act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, detail })); });
  const dbl = (el: Element) => { click(el, 1); click(el, 2); act(() => { el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 })); }); };
  const later = () => act(() => { vi.advanceTimersByTime(UNPICK_MS + 10); });
  it('한 번 누름 = 고름(선택 칸 · 작은 지도 강조), 고른 로봇을 한 번 더 = 고르기 풂(로봇 탭으로 가지 않음)', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mount('u-kim', TWENTY.slice(0, 8)); feed(TWENTY.slice(0, 8));
    click(tile('g7'));
    expect(tile('g7').dataset.sel).toBe('true');
    expect(tile('g7').getAttribute('aria-pressed')).toBe('true');
    expect(tile('g7').classList.contains('sel')).toBe(true);
    expect($('[data-picked] .ttl').textContent).toBe('K-08');
    expect($('[data-picked]').textContent).toContain('두 번 누르면 로봇 탭에서 열립니다. 한 번 더 누르면 고르기를 풉니다.');
    click(tile('g7')); later();
    expect(tile('g7').dataset.sel).toBeUndefined(); expect(controlPick.get()).toBe('');
    expect(location.hash).toBe('#/control');
    vi.useRealTimers();
  });
  it('다른 로봇을 누르면 그 로봇으로 바로 옮겨 고름', () => {
    mount('u-kim', TWENTY.slice(0, 8)); feed(TWENTY.slice(0, 8));
    click(tile('g7')); click(tile('g6'));
    expect(tile('g6').dataset.sel).toBe('true'); expect(tile('g7').dataset.sel).toBeUndefined(); expect(controlPick.get()).toBe('g6');
  });
  it('더블클릭 = 로봇 탭 · 넘어가기 전 고르기가 흔들리지 않음(안 고른 로봇 · 이미 고른 로봇 둘 다)', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    for (const already of [false, true]) {
      mount('u-kim', TWENTY.slice(0, 8), '#/control'); feed(TWENTY.slice(0, 8));
      if (already) click(tile('g7'));
      const seen: string[] = []; const off = controlPick.sub(() => seen.push(controlPick.get()));
      click(tile('g7'), 1); click(tile('g7'), 2);
      expect(tile('g7').dataset.sel).toBe('true');   // dblclick 직전: 고른 채
      act(() => { tile('g7').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 })); });
      later(); off();
      expect(location.hash).toBe('#/fleet');
      expect(seen.slice(0, seen.indexOf('') < 0 ? seen.length : seen.indexOf(''))).toEqual(already ? [] : ['g7']);   // 넘어가기 전 «골랐다 → 풀렸다» 없음
      expect(seen.filter((x) => x === '').length).toBeLessThanOrEqual(1);   // 비움은 탭을 떠날 때 한 번뿐
      act(() => root?.unmount()); box.remove();
    }
    vi.useRealTimers();
  });
  it('지도 보기 3D 표식 · 오른쪽 줄도 같은 규칙(고름 · 풂 · 더블클릭 로봇 탭)', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    for (const sel of ['.u5 .mks .mk3[data-r3="g7"]', '.u5 .side .rrow[data-r="K-08"]']) {
      mount('u-kim', TWENTY.slice(0, 8), '#/control'); feed(TWENTY.slice(0, 8));
      act(() => { seg('보기', 1).click(); });
      const el = () => $(sel) as HTMLElement;
      click(el()); expect(controlPick.get()).toBe('g7'); expect(el().getAttribute('aria-pressed')).toBe('true');
      click(el()); later(); expect(controlPick.get()).toBe('');
      dbl(el()); expect(location.hash).toBe('#/fleet');
      act(() => root?.unmount()); box.remove();
    }
    vi.useRealTimers();
  });

  it('두 번 누름(dblclick)도 로봇 탭 · 선택 칸 «로봇 탭에서 열기» 도 같음', () => {
    mount('u-kim', TWENTY.slice(0, 8)); feed(TWENTY.slice(0, 8));
    act(() => { tile('g7').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    expect(location.hash).toBe('#/fleet');
    act(() => root?.unmount()); box.remove();
    mount('u-kim', TWENTY.slice(0, 8), '#/control'); feed(TWENTY.slice(0, 8));
    act(() => { tile('g6').click(); });
    act(() => { $('[data-picked] .openb').click(); });
    expect(location.hash).toBe('#/fleet');
  });

  // 팀장 20:49: 시뮬도 실기 · 데모와 같은 따라가기 카메라(뒤 1 m) · 같은 현장. 정면은 뒤집기일 때만(시안 K-08 «정면 보기» 글도 그때만)
  it('뒤집기 = 정면 상태(관절 온도), 임무 중인 시뮬 로봇도 실기와 같은 뒤 1 m 시점 · 뒤집기는 고르기가 아님', () => {
    const R = SOME('g1', 'g2', 'g3'); mount('u-kim', R); feed(R, runs(['g2', 'g3']));
    expect(tile('g3').querySelector('.cv')!.getAttribute('data-face')).toBe('live');
    expect(tile('g2').querySelector('.cv')!.getAttribute('data-face')).toBe('live');
    expect(tile('g2').querySelector('.cv .ov')!.textContent).toBe('뒤 2 m');
    expect(tile('g2').querySelector('.chip.sim')!.textContent).toBe('시뮬');
    expect(tile('g2').classList.contains('rehearse')).toBe(true);
    act(() => { $('.u5 .flipb').click(); });
    expect(tiles().every((t) => t.querySelector('.cv')!.getAttribute('data-face') === 'front')).toBe(true);
    expect(tile('g3').querySelector('.cv .ov')!.textContent).toBe('최고 관절 온도');
    expect(tile('g2').querySelector('.cv .ov')!.textContent).toBe('임무 중 · 정면 보기');
    expect($('.u5 .flipb').textContent).toBe('뒤 2 m 시점으로');
    expect(tile('g3').dataset.sel).toBeUndefined();
  });

  // 팀장 21:16: 임무 중(그 로봇에 진행 중인 run) = 뒤 1 m 따라가기 + 현장 glb · 임무 전(대기 · 정지 · 충전 · 임무 없음) = 초록 점 바닥 + 로봇을 정면에서 · 현장 없음. 시뮬 · Go2 X 도 같은 규칙
  it('임무 있음 → 뒤 카메라 + 현장, 임무 없음 · 끝난 임무 → 정면 + 초록 바닥(현장 없음), 시뮬 · Go2 X 도 같음', () => {
    const R = SOME('g1', 'g2', 'g3', 'g4', 'g6', 'g7'); mount('u-kim', R); feed(R, { ...runs(['g1', 'g2']), g4: RUN('COMPLETED'), g6: RUN('CANCELED'), g7: RUN('PAUSED') });
    const face = (id: string) => tile(id).querySelector('.cv')!.getAttribute('data-face');
    const cam = (id: string) => JSON.parse(tile(id).querySelector('canvas')!.getAttribute('data-go2')!) as { yaw: number | string; dist: number };
    expect(face('g1')).toBe('live'); expect(cam('g1')).toMatchObject({ yaw: 'back', dist: 2.0 });   // 임무 중 뒤 2.0 m(팀장 01:47) · 칸 글은 REAR_LABEL 그대로
    expect(face('g7')).toBe('live');   // 일시정지도 아직 그 임무 안
    expect(face('g2')).toBe('live'); expect(tile('g2').querySelector('.cv .ov')!.textContent).toBe('뒤 2 m');
    for (const id of ['g3', 'g4', 'g6']) { expect(face(id)).toBe('front'); expect(cam(id)).toMatchObject({ yaw: 0, dist: 1.25 }); }
    expect(tile('g3').querySelector('.cv .ov')!.textContent).toBe('대기 중 · 정면 보기');   // 대기 = 시안 K-08 꼬리표(팀장 01:08)
    expect(tile('g3').querySelector('[data-cam]')).toBeNull();   // 임무 전 실기는 카메라 칸 대신 모형 정면
    act(() => { FakeWS.last.recv(state('g2', { status: 'IDLE', run: null })); });
    expect(face('g2')).toBe('front'); expect(tile('g2').querySelector('.cv .ov')!.textContent).toBe('대기 중 · 정면 보기');
    // 현장 판: 임무 중이면 서버 위치 그대로 현장 좌표, 임무 전이면 null(현장 glb · 가림 당김 없이 초록 바닥)
    const loc = { floor_id: 'f1', map_version_id: 'v1', x: 1, y: 2, yaw: 0, confidence: 1, updated_at: '' }, boards = new Set(['v1']);
    const on = { ...facts(TWENTY[1], 'u-kim', new Map()), onRun: true }, off = { ...on, onRun: false };
    expect(tileView(on, false, loc, boards)).toEqual({ front: false, pose: { x: 1, z: -2, rot: Math.PI / 2 } });
    expect(tileView(on, true, loc, boards)).toEqual({ front: true, pose: null });   // 뒤집기 = 임무 중이어도 정면 · 현장 없음(시안 u5_4 · 조정 22:03)
    expect(tileView(off, false, loc, boards)).toEqual({ front: true, pose: null });
    // Go2 X(관절 · 자세를 보내는 실기) 도 임무가 없으면 정면 · 서 있음 / 앉음은 관절 그대로
    expect(facts(TWENTY[3], 'u-kim', new Map()).onRun).toBe(false);
  });

  // 팀장 20:51: K-04 · 06 · 08 은 조종권을 쥔 채 0 축(속도 0)인데 다리가 걸었다 → 걷는 다리는 서버 속도(state.speed) 가 WALK_MIN_SPEED 이상일 때만
  it('3D 는 지금 동작대로: 임무 중이고 실제로 움직이면(speed ≥ 0.05) 걷기, 속도 0 이면 선 자세, 잠금 · 오류 = 엎드림, 대기 = 서 있음, 끊김 = 마지막 자세 모름', () => {
    const R = SOME('g3', 'g5', 'g15'); mount('u-kim', R); feed(R, { g5: { speed: 0.4 } });
    expect(tile('g5').dataset.act).toBe('walk');
    expect(tile('g5').dataset.live).toBe('1');
    act(() => { FakeWS.last.recv(state('g5', { status: 'RUNNING', speed: 0 })); });
    expect(tile('g5').dataset.live).toBeUndefined();   // 임무 중이어도 서 있으면 걷지 않음
    act(() => { FakeWS.last.recv(state('g5', { status: 'RUNNING', speed: null })); });
    expect(tile('g5').dataset.live).toBeUndefined();   // 속도 모름 = 걷지 않음(지어내지 않음)
    expect(tile('g15').dataset.act).toBe('lost');
    expect(tile('g3').dataset.act).toBe('stand');
    expect(actOf({ ...TWENTY[3], status: 'STOP_LATCHED' }, false)).toBe('lie');
    expect(actOf({ ...TWENTY[3], status: 'ERROR' }, false)).toBe('lie');
    expect(actOf({ ...TWENTY[3], unknown: 'wait' }, false)).toBe('unknown');
  });

  // D1(조정 21:27): 요약만 받는 로봇(state 없음 = speed 칸 자체가 없음, 0 이 아님)은 임무 중 + 움직이는 상태(RUNNING)면 걷기. speed 가 있으면 speed 가 이김(0 = 서 있음)
  it('speed 칸 없음 + 임무 중 → 걷기, speed 칸 없음 + 일시정지 → 서기, speed 0 + 임무 중 → 서기', () => {
    const run = (status: string) => ({ run_id: 'r', status, scenario_name: '순찰', progress: { done: 1, total: 4 } }) as never;
    const R: Robot[] = [
      { ...TWENTY[1], id: 's1', name: 'S-1', owner: 'u-park', status: 'RUNNING', run: run('MOVING'), unknown: 'summary' },
      { ...TWENTY[1], id: 's2', name: 'S-2', owner: 'u-park', status: 'PAUSED', run: run('PAUSED'), unknown: 'summary' },
      { ...TWENTY[1], id: 's3', name: 'S-3', owner: 'u-park', status: 'RUNNING', run: null, unknown: 'summary' },
      { ...TWENTY[0], id: 'm1', name: 'M-1', owner: 'u-lee', status: 'RUNNING' },
    ];
    mount('u-lee', R); feed(R.filter((r) => r.owner === 'u-lee'), { m1: { speed: 0, ...RUN() } });
    act(() => { seg('범위', 0).click(); });
    expect(tile('s1').dataset.live).toBe('1');
    expect(tile('s2').dataset.live).toBeUndefined();
    expect(tile('s3').dataset.live).toBeUndefined();   // 임무 없음 = 걷지 않음
    expect(tile('m1').dataset.live).toBeUndefined();   // speed 0 = 서 있음
  });
  // reviewer 21:53: 조건 하나씩 — 하나만 빠져도 서기
  it('speed 칸 없음: 로봇 잠금 + 임무 MOVING → 서기, 로봇 RUNNING + 임무 PAUSED → 서기, 목록에서 끊긴(OFFLINE) 요약 로봇 + 임무 중 → 서기', () => {
    const run = (status: string) => ({ id: 'r', status, scenario_name: '순찰', progress: { done: 1, total: 4 } }) as never;
    const R: Robot[] = [
      { ...TWENTY[1], id: 'c1', name: 'C-1', owner: 'u-park', status: 'STOP_LATCHED', run: run('MOVING'), unknown: 'summary' },
      { ...TWENTY[1], id: 'c2', name: 'C-2', owner: 'u-park', status: 'RUNNING', run: run('PAUSED'), unknown: 'summary' },
      { ...TWENTY[1], id: 'c3', name: 'C-3', owner: 'u-park', status: 'RUNNING', run: run('MOVING'), unknown: 'summary', attention: ['OFFLINE'] },
      { ...TWENTY[1], id: 'c4', name: 'C-4', owner: 'u-park', status: 'RUNNING', run: run('MOVING'), unknown: 'summary', attention: [] },
      { ...TWENTY[0], id: 'm1', name: 'M-1', owner: 'u-lee' },
    ];
    mount('u-lee', R); feed(R.filter((r) => r.owner === 'u-lee'));
    act(() => { seg('범위', 0).click(); });
    expect(['c1', 'c2', 'c3', 'c4'].map((id) => tile(id).dataset.live ?? '-')).toEqual(['-', '-', '-', '1']);   // c4 = 세 조건 모두 맞는 대조군
  });

  it('걷기 판정 문턱 0.05 m/s(rt 가 속도를 0.1 자리까지만 견주므로 그 반 · 가장 느린 시뮬 이동 0.2 보다 아래 · 로봇 탭 robotu4 «서 있음» 0.05 와 같음)', () => {
    expect(WALK_MIN_SPEED).toBe(0.05);
    expect(walking('walk', null, 0)).toBe(false);       // 조종권 쥔 채 0 축(K-04 · 06 · 08)
    expect(walking('walk', null, 0.049)).toBe(false);
    expect(walking('walk', null, 0.05)).toBe(true);
    expect(walking('stand', null, 0.3)).toBe(true);     // 상태가 대기여도 실제로 움직이면(리모컨 등) 걷기
    expect(walking('walk', null, null)).toBe(false);     // 속도 모름
    expect(walking('walk', '일시정지', 0.4)).toBe(false);
    expect(walking('lie', null, 0.4)).toBe(false);
    expect(walking('lost', null, 0.4)).toBe(false);
  });
  // 팀장 20:55: Go2 X 가 일어섰는데 앉아 있게 그려졌다(잠금 상태 = 엎드림이 관절 · 자세 보고보다 앞섬) → 관절 > 자세 보고 > 상태 > 선 자세
  it('자세 순서: 서버 관절이 오면 관절 · 없으면 자세 보고(STANDING 이면 잠금이어도 서 있음) · 보고도 없을 때만 상태(잠금 = 엎드림)', () => {
    mount('u-kim', TWENTY); feed(TWENTY);
    const x = TWENTY.find((r) => r.id === 'g3')!;
    const pos = JOINTS.map((_, i) => (i % 3 === 0 ? 0.1 : i % 3 === 1 ? 0.8 : -1.5));
    act(() => { FakeWS.last.recv(state('g3', { status: 'STOP_LATCHED', latched: true, posture: { state: 'STANDING', mode: null },
      robot_info: { joints: { received_at: '', age_s: 0.08, names: JOINTS, positions: pos } } } as never)); });
    expect(jointsNow('g3')).toEqual(pos);
    expect(lying({ x, act: 'lie', charging: false })).toBe(false);   // 자세 보고 STANDING 이 잠금보다 앞
    act(() => { FakeWS.last.recv(state('g3', { status: 'STOP_LATCHED', latched: true, posture: { state: 'LYING', mode: null },
      robot_info: { joints: { received_at: '', age_s: 1.5, names: JOINTS, positions: pos } } } as never)); });
    expect(jointsNow('g3')).toBeNull();                               // 1 초 넘게 묵은 관절은 버림
    expect(lying({ x, act: 'stand', charging: false })).toBe(true);    // 자세 보고 LYING
    act(() => { FakeWS.last.recv(state('g3', { status: 'STOP_LATCHED', latched: true, posture: null } as never)); });
    expect(lying({ x, act: 'lie', charging: false })).toBe(true);     // 보고 없음 → 상태(잠금)
    expect(lying({ x, act: 'stand', charging: false })).toBe(false);
    expect(lying({ x, act: 'stand', charging: true })).toBe(true);    // 충전 중
  });
  it('타일 ↔ 지도 보기(u5_3): 3D 현장 · 오른쪽 로봇 줄 전부', () => {
    mount('u-kim', TWENTY); feed(TWENTY);
    act(() => { seg('보기', 1).click(); });
    expect($('[aria-label="로봇 타일"]')).toBeNull();
    expect($('.u5 .big canvas#site')).not.toBeNull();
    expect($$('.u5 .side .rrow')).toHaveLength(20);
    expect($$('.u5 .mks .mk3')).toHaveLength(20);
    expect($$('.u5 .mks .mk3').every((e) => e.style.display === 'none')).toBe(true);   // 위치가 오기 전에는 표지를 그리지 않음
    act(() => { seg('보기', 0).click(); });
    expect(tiles()).toHaveLength(8);   // 타일은 8 칸, 지도 보기는 20 대 전부
  });

  it('지도 보기 이름표: 시뮬 로봇은 경고가 있어도 시안 K-08 꼴(파란 점선 · 상자 아이콘)', () => {
    const R: Robot[] = [
      { id: 'a1', name: 'K-21', owner: 'u-kim', ownerName: '김OO', battery: 70, online: true, seenAt: '14:05:20', status: 'ERROR' },
      { id: 's1', name: 'S-01', owner: 'u-kim', ownerName: '김OO', battery: 70, online: true, seenAt: '14:05:20', status: 'ERROR', sim: true },
    ];
    mount('u-kim', R); feed(R);
    act(() => { seg('보기', 1).click(); });
    const mk = (id: string) => $(`.u5 .mks .mk3[data-r3="${id}"]`) as HTMLElement;
    expect(mk('a1').classList.contains('r')).toBe(true);
    expect(mk('s1').classList.contains('sim')).toBe(true);
    expect(mk('s1').classList.contains('r')).toBe(false);
  });
  it('작은 지도를 두 번 누르면 지도 보기로(팀장 00:22 · 시안 밖): 한 번 누름으로는 넘어가지 않음 · 작은 지도 자리에서 자라 넘어감 · 위 단추로 가면 자라지 않음 · 고른 로봇 없으면 다가갈 대상 없음', () => {
    mount('u-kim', TWENTY); feed(TWENTY);
    const mini = $('.u5 .mini[data-to-map]') as HTMLElement;
    expect(mini.getAttribute('role')).toBe('button');
    act(() => { mini.click(); });
    expect($('[aria-label="로봇 타일"]')).not.toBeNull();
    act(() => { mini.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 })); });
    expect($('[aria-label="로봇 타일"]')).toBeNull();
    expect($('.u5 .big canvas#site')).not.toBeNull();
    expect($('.u5 .big')!.hasAttribute('data-from-mini')).toBe(true);
    expect($('.u5 .big')!.hasAttribute('data-focus')).toBe(false);
    act(() => { seg('보기', 0).click(); });
    act(() => { seg('보기', 1).click(); });
    expect($('.u5 .big')!.hasAttribute('data-from-mini')).toBe(false);
  });
  it('고른 로봇: 작은 지도에서 그 점만 강조(나머지 흐림 · 이름표) · 작은 지도 더블클릭 = 지도 보기에서 그 로봇으로 다가감(data-focus)', async () => {
    const floor = (id: string, v: string | null) => ({ id, building_id: 'b', name: '1층', level: 1, approved_version_id: v });
    const sites = vi.spyOn(api, 'sites').mockResolvedValue({ next_cursor: null, items: [
      { id: 'demo', name: '공장 터', purpose: 'SIM', demo: true, buildings: [{ id: 'b', site_id: 'demo', name: '공장', floors: [floor('f1', 'fac')] }] }] } as never);
    try {
      const at = (x: number) => ({ location: { floor_id: 'f1', map_version_id: 'fac', x, y: -50, yaw: 0, confidence: 1, updated_at: '' } } as never);
      mount('u-kim', EIGHT); feed(EIGHT, { k3: at(100), k4: at(120) });
      await act(async () => {});
      act(() => { tile('k3').click(); });
      const dot = (id: string) => $(`.u5 .mini .dotm[data-dot="${id}"]`);
      expect(dot('k3').classList.contains('sel')).toBe(true); expect(dot('k4').classList.contains('dim')).toBe(true);
      expect($('.u5 .mini .dotl.sel')!.textContent).toBe(EIGHT.find((r) => r.id === 'k3')!.name);
      // 고를 때도 확대 · 이동 없음(팀장 02:03): k4(20 m 동쪽 = 그림 70 px = 작은 지도 8.75 px) 는 k3 에서 1 배 그대로 9 px · 바탕 그림 크기 · 자리 그대로
      expect($('.u5 .mini')!.dataset.zoom).toBeUndefined();
      const px = (id: string) => { const m = /calc\(50% ([+-]) (-?\d+)px\)/.exec(dot(id).style.left)!; return (m[1] === '-' ? -1 : 1) * Number(m[2]); };
      expect(Math.abs(px('k4') - px('k3') - 8.75)).toBeLessThanOrEqual(1);
      expect(($('.u5 .mini') as HTMLElement).style.backgroundSize).toBe('');
      act(() => { $('.u5 .mini[data-to-map]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 })); });
      expect($('.u5 .big')!.getAttribute('data-focus')).toBe('k3');
    } finally { sites.mockRestore(); }
  });

  it('운영 관리자도 같은 틀(u5_6) · 처음은 «내 로봇»만, «모두»로 받은 목록 전부', () => {
    const S8 = TWENTY.slice(0, 8);
    mount('u-lee', S8); feed(S8.filter((r) => r.owner === 'u-lee'));
    expect($('h1').textContent).toBe('관제');
    expect(tiles()).toHaveLength(4);
    expect(tiles().every((t) => TWENTY.find((r) => r.id === t.dataset.robot)!.owner === 'u-lee')).toBe(true);
    expect($('.u5 .flt .on').textContent).toBe('내 로봇');
    act(() => { seg('범위', 0).click(); });
    expect(tiles()).toHaveLength(8);
    expect(fact('g1', 'link')).toBe('확인 안 됨');   // 남의 로봇은 요약만 · 상태를 단정하지 않음
  });

  it('order: 경고 먼저(위험 → 경고 → 주의), 나머지는 받은 순서', () => {
    const F = (r: Robot) => facts(r, 'u-kim', new Map());
    const a = TWENTY[3], c = TWENTY[5], d = TWENTY[9], e = { ...TWENTY[7], status: 'ERROR' as const };
    expect(order([a, d, c, e].map(F)).map((f) => f.x.id)).toEqual(['g7', 'g9', 'g3', 'g5']);
  });

  it('order (팀장 11-28 17:34): 긴급이 아니면 실기 → 데모 → 사용자 시뮬', () => {
    const real = { ...TWENTY[3], id: 'x', sim: false }, sim = { ...TWENTY[5], id: 's', sim: true }, demo = { ...TWENTY[3], id: 'd', sim: true };
    const G = (r: Robot, dm = false) => facts(r, 'u-kim', new Map(), { demo: dm, label: null, charging: false, job: null });
    expect(order([G(sim), G(demo, true), G(real)]).map((f) => f.x.id)).toEqual(['x', 'd', 's']);
    expect(order([G(sim), G(demo, true), G({ ...real, status: 'ERROR' as const }), G({ ...sim, id: 's2', status: 'ERROR' as const })]).map((f) => f.x.id)).toEqual(['x', 's2', 'd', 's']);
  });

  it('끊긴 로봇(u5_1 K-07): 칸 위 «다시 연결 중 · 마지막 화면 HH:MM» · 배터리는 값만(시안 «49 %») · 끊긴 시각은 연결 칸 «연결 중 HH:MM 끊김»', () => {
    const R = SOME('g0', 'g3', 'g15'); mount('u-kim', R); feed(R);
    expect(tile('g15').querySelector('.lk')!.textContent).toBe('다시 연결 중마지막 화면 14:05');
    expect(fact('g15', 'battery')).toBe('70 %');
    expect([fact('g15', 'link'), small('g15', 'link')]).toEqual(['연결 중', '14:05 끊김']);
    expect(tile('g15').querySelector('[data-fact="link"]')!.className).toBe('s w');
    expect(tile('g15').dataset.tone).toBeUndefined();   // 시안: 끊김은 테두리 없이 칸 위 덮개
    expect(fact('g3', 'battery')).toBe('70 %');
    const gone = { ...TWENTY[15], unknown: 'link' as const };
    expect(lastly(gone, '70%', '')).toBeNull();
    expect(lastly(gone, '위치 1.0, 2.0 m', '2026-11-28T05:06:07')).toMatch(/^마지막 위치 1\.0, 2\.0 m · \d\d:\d\d$/);
  });

  it('최근 경고(시안 .al): 이름 + 무엇 · 덧말 · 받은 시각 HH:MM, 경고 먼저', () => {
    mount('u-kim', TWENTY); feed(TWENTY);
    const al = $$('[aria-label="최근 경고"] [data-alert]');
    expect(al.map((e) => e.dataset.alert)).toEqual(['g9', 'g15']);
    expect([...al[1].querySelector('div')!.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('')).toBe('K-16 연결 끊김');
    expect(al[1].querySelector('small')!.textContent).toBe('다시 연결 중');
    const at = al[0].querySelector('[data-alert-at]')!;   // 화면을 열 때 이미 경고였던 로봇 = 받은 시각이 아니라 «이어진 상태»(로그인 시각을 경고 시각처럼 보이지 않게)
    expect(at.textContent).toBe('이어진 상태');
    expect(al[1].querySelector('[data-alert-at]')!.textContent).toBe('14:05');   // 끊긴 로봇 = 끊기기 전 마지막 받은 시각
  });

  // 팀장 21:24: 20:53:54 부터 이어진 Go2 X 잠금이 로그인 뒤 «21:22» 로 보였다 → 서버 잠금 시작 시각(status_since) > 열 때 이미 경고면 «이어진 상태» > 받는 동안 새로 생긴 경고만 그때 시각
  it('최근 경고 시각: 정지 잠금은 서버 status_since(있음 = 그 시각 · null · 칸 없음 = 이어진 상태), 받는 동안 새로 잠긴 것은 그때 시각', () => {
    const base = TWENTY[3];
    const R: Robot[] = [
      { ...base, id: 'a1', name: 'A-1', status: 'STOP_LATCHED', statusSince: { status: 'STOP_LATCHED', at: '2026-11-28T20:53:54' } },
      { ...base, id: 'a2', name: 'A-2', status: 'STOP_LATCHED', statusSince: null },
      { ...base, id: 'a3', name: 'A-3', status: 'STOP_LATCHED' },
      { ...base, id: 'a4', name: 'A-4', status: 'IDLE' },
    ];
    mount('u-kim', R); feed(R);
    const at = (id: string) => $(`[aria-label="최근 경고"] [data-alert="${id}"] [data-alert-at]`);
    expect(at('a1').textContent).toBe('20:53'); expect(at('a1').getAttribute('title')).toBe('잠금 시작 20:53');
    expect(at('a2').textContent).toBe('이어진 상태'); expect(at('a3').textContent).toBe('이어진 상태');
    act(() => { FakeWS.last.recv(state('a4', { status: 'STOP_LATCHED' })); });   // 보는 동안 새로 잠김
    expect(at('a4').textContent).toMatch(/^\d\d:\d\d$/); expect(at('a4').getAttribute('title')).toBe(`받은 시각 ${at('a4').textContent}`);
    const t4 = at('a4').textContent;
    act(() => { FakeWS.last.recv(state('a4', { status: 'STOP_LATCHED', battery: { soc: 50, updated_at: '' } })); });
    expect(at('a4').textContent).toBe(t4);   // 같은 잠금이 이어지면 시각을 다시 쓰지 않음
    // status_since 는 그 값이 붙은 status 에만(다른 상태로 바뀐 뒤엔 쓰지 않음)
    act(() => { FakeWS.last.recv(state('a1', { status: 'ERROR' })); });
    expect(at('a1').textContent).toBe('이어진 상태');
  });
  it('로봇 목록 status_since: 있음 = 그 status 와 함께 · null · 칸 없음 = null', () => {
    const S = (o: object) => toRobot({ id: 'x', name: 'X', model: 'Go2', owner: null, connection: 'ONLINE', status: 'STOP_LATCHED', battery: null, location: null, lease: null, current_run: null, devices: [], attention: [], simulation: false, server_drive_allowed: true, ...o } as never);
    expect(S({ status_since: '2026-11-28T20:53:54Z' }).statusSince).toEqual({ status: 'STOP_LATCHED', at: '2026-11-28T20:53:54Z' });
    expect(S({ status_since: null }).statusSince).toBeNull();
    expect(S({}).statusSince).toBeNull();
  });

  it('App: 로봇 0대면 관제 탭은 로봇 탭 빈 화면이 아니라 관제 빈 화면', () => {
    mount('u-kim', []);
    expect($('h1').textContent).toBe('관제');
    expect($('[data-empty-control]')).not.toBeNull();
    expect($('.u5')).toBeNull();
  });

  it('로봇 0대 관제 빈 화면: 한 줄 + 로봇 탭 링크', () => {
    box = document.createElement('div'); document.body.append(box);
    act(() => { root = createRoot(box); root.render(<EmptyControl />); });
    expect($('[data-empty-control] p').textContent).toContain('관제할 로봇이 없습니다');
    expect($('[data-empty-control] a').getAttribute('href')).toBe('#/fleet');
  });

  it('타일 키보드: Enter = 고르기 · 다시 Enter = 풀기(바로), Shift+Enter = 로봇 탭(시안 밖)', () => {
    mount('u-kim', TWENTY.slice(0, 8)); feed(TWENTY.slice(0, 8));
    expect(tile('g7').tabIndex).toBe(0);
    const key = (shiftKey = false) => act(() => { tile('g7').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey, bubbles: true })); });
    key(); expect(controlPick.get()).toBe('g7');
    key(); expect(controlPick.get()).toBe('');
    key(true);
    expect($('h1').textContent).toBe('로봇');
    expect(location.hash).toBe('#/fleet');
  });

  it('한 번도 연결된 적 없는 로봇(연결 전)은 경고가 아니다: 테두리 · 머리표 · 경고 수 · 경보 칸 · 최근 경고 없음, «연결 끊김» 글자 없음', () => {
    const pre: Robot[] = ['p1', 'p2'].map((id, i) => ({ id, name: `Go2-${i + 7}`, owner: 'u-park', ownerName: '박OO', battery: null, online: false, seenAt: '', status: null, attention: ['OFFLINE'] }));
    mount('u-park', pre); feed(pre);   // 운영 관리자 = 받은 로봇 상태로 센 경고 수(총괄은 서버 요약 값 · 아래 시험)
    expect(tiles()).toHaveLength(2);
    expect(tiles().every((t) => t.dataset.tone === undefined && !t.querySelector('[data-warn-flag]'))).toBe(true);
    expect($('[data-sum="경고"] b').textContent).toBe('0');
    expect($$('.u5 .tb .cnt').map((e) => e.dataset.sum)).toEqual(['임무 중', '충전', '점검', '연결 중', '시뮬 대기', '경고']);   // 시안 칸 줄 그대로 · 0 이면 0
    expect(['연결 중', '시뮬 대기'].map((k) => $(`[data-sum="${k}"] b`).textContent)).toEqual(['0', '0']);
    expect($('[data-alarm]')).toBeNull();
    expect($$('[aria-label="최근 경고"] [data-alert]')).toHaveLength(0);
    expect($('main').textContent).not.toContain('연결 끊김');
    expect($('main').textContent).not.toContain('미확인');
    expect(fact('p1', 'link')).toBe('연결 전');
  });

  it('받은 시각이 없으면 최근 경고의 시각 칸을 접는다', () => {
    const gone: Robot[] = ['q1', 'q2'].map((id, i) => ({ id, name: `Q-${i}`, owner: 'u-park', ownerName: '박OO', battery: 40, online: false, seenAt: '', status: 'RUNNING' }));
    mount('u-kim', gone); feed(gone);
    expect($$('[aria-label="최근 경고"] [data-alert]')).toHaveLength(2);
    expect($('[aria-label="최근 경고"] [data-alert-at]')).toBeNull();
    expect($('[aria-label="최근 경고"]').textContent).not.toContain('미확인');
  });

  it('끝난 임무(state.run COMPLETED · 목록 current_run 없음)는 진행 막대 · «할 일» 을 남기지 않고 임무 전 꼴(01:02 K-07)', () => {
    const L: Robot[] = EIGHT.map((r) => (r.id === 'k7' ? { ...r, online: true, status: 'IDLE' as const, mission: undefined } : r));
    mount('u-kim', L); feed(L, { k7: { run: { run_id: 'r9', status: 'COMPLETED', step: 0, wait_reason: null, fail_code: null, progress: { done: 34, total: 36 } } }, k2: RUN() });
    expect(tile('k7').textContent).not.toContain('할 일'); expect(tile('k7').dataset.live).toBeUndefined();
    expect(tile('k7').querySelector('[data-face]')!.getAttribute('data-face')).toBe('front');
    expect(tile('k2').textContent).toContain('할 일 2 / 4');   // 도는 임무는 그대로
  });
  it('서버가 임무를 PAUSED(LINK_LOST)로 두면 타일 칸에 시안 상태 표지 «일시정지 · 연결 끊김»', () => {
    mount('u-kim', EIGHT); feed(EIGHT, { k2: { run: { run_id: 'r1', status: 'PAUSED', wait_reason: 'LINK_LOST', progress: { done: 1, total: 4 } } } });
    expect(tile('k2').querySelector('.stb[data-paused]')!.textContent).toBe('임무 멈춤');   // 배지 글(팀장 01:17) · 까닭은 title
    expect(tile('k2').querySelector<HTMLElement>('.stb[data-paused]')!.title).toBe('일시정지 · 연결 끊김');
    expect(tile('k2').dataset.live).toBeUndefined();   // 멈춘 임무는 걷지 않음
    expect(tile('k1').querySelector('[data-paused]')).toBeNull();
  });

  it('작은 지도 점(팀장 00:36 · 층 대조): demo 플래그가 없어도 위치 판이 작은 지도 그림의 층 꼴(1800 × 1120 · 0.5 m/px · 원점 (0, -560))이면 시뮬 · 데모 · 실기 모두 점 · 다른 꼴 판 · 판 못 받음은 뺌', async () => {
    resetSiteBoards();
    const ver = vi.spyOn(api, 'version').mockImplementation(async (id: string) => {
      if (id === 'other') return { id, width: 3200, height: 2000, resolution: 0.2857, origin: [-7.1, -565.7, 0] } as never;
      if (id === 'gone') throw new Error('404');
      return { id, width: 1800, height: 1120, resolution: 0.5, origin: [0, -560, 0] } as never;
    });
    try {
      const at = (v: string) => ({ location: { floor_id: 'f1', map_version_id: v, x: 100, y: -50, yaw: 0, confidence: 1, updated_at: '' } } as never);
      const R = EIGHT.map((r, i) => (i === 1 ? { ...r, sim: true } : r));
      mount('u-kim', R); feed(R, { k1: at('fac'), k2: at('fac'), k3: at('fac'), k4: at('other'), k5: at('gone') });
      await act(async () => {}); await act(async () => {});
      expect($$('.u5 .mini .dotm').map((e) => e.dataset.dot).sort()).toEqual(['k1', 'k2', 'k3']);
      expect(ver.mock.calls.map((c) => c[0]).sort()).toEqual(['fac', 'gone', 'other']);   // 판마다 한 번
    } finally { ver.mockRestore(); resetSiteBoards(); }
  });
  it('작은 지도 점: /sites 의 demo 현장 층 승인 판(approved_version_id)과 위치 판 id 가 같을 때만, 서버 m → 시안 그림 px(25 + u·3.5, 20 + v·3.5)', async () => {
    // app-lx 공장 판: 1800 × 1120 · 0.5 m/px · origin (0, -560) — 크기는 보지 않고 판 id 로만 가름
    const floor = (id: string, v: string | null) => ({ id, building_id: 'b', name: '1층', level: 1, approved_version_id: v });
    const sites = vi.spyOn(api, 'sites').mockResolvedValue({ next_cursor: null, items: [
      { id: 'demo', name: '공장 터', purpose: 'SIM', demo: true, buildings: [{ id: 'b', site_id: 'demo', name: '공장', floors: [floor('f1', 'fac-1800x1120')] }] },
      { id: 'other', name: '다른 시뮬', purpose: 'SIM', demo: false, buildings: [{ id: 'b2', site_id: 'other', name: '창고', floors: [floor('f2', 'sim-760x440')] }] },
    ] } as never);
    try {
      const at = (v: string | null, x = 100, y = -50) => ({ location: { floor_id: 'f1', map_version_id: v, x, y, yaw: 0, confidence: 1, updated_at: '' } } as never);
      mount('u-kim', EIGHT); feed(EIGHT, { k3: at('fac-1800x1120'), k4: at('sim-760x440'), k5: at(null) });
      await act(async () => {});
      const d = $$('.u5 .mini .dotm');
      expect(d.map((e) => e.dataset.dot)).toEqual(['k3']);
      // x 100 m → 25 + 350 = 375 px, y -50 m(v = 50) → 20 + 175 = 195 px. 작은 지도 = 그림 1/8, 가운데 기준 -200
      expect([d[0].style.left, d[0].style.top]).toEqual(['calc(50% - 153px)', '24px']);
    } finally { sites.mockRestore(); }
  });



  it('총괄 요약 = 수 칸: 임무 중 = 타일 실행 상태로 셈(시뮬 포함 · 서버 요약은 실기만이라 안 씀) · 경고 = 타일 테두리 경고 수(서버 요약은 실기만이라 안 씀), 결재 대기 = 서버 GET /dashboard = 머리줄 메뉴 끝 작은 표', async () => {
    dashOk({ robots_running: 5, robots_attention: 2, approvals_pending: 4 });
    mount('u-kim', TWENTY); feed(TWENTY);
    await act(async () => {});
    expect([$('[data-sum="임무 중"]').dataset.src, $('[data-sum="임무 중"] b').textContent]).toEqual([undefined, String(TWENTY.filter((r) => r.status === 'RUNNING' && r.online).length)]);
    expect($('[data-sum="경고"]').dataset.src).toBeUndefined();
    expect($('[data-sum="경고"] b').textContent).toBe(String(document.querySelectorAll('.u5 .tile[class*="lv-"]').length));
    const ap = $('.bar .tabs [data-approvals]');
    expect([ap.dataset.approvals, ap.hidden, ap.textContent]).toEqual(['4', false, '결재 4']);
    act(() => { ap.click(); window.dispatchEvent(new HashChangeEvent('hashchange')); });
    expect(location.hash).toBe('#/approval');
  });
  it('요약을 10 s 마다 다시 받아 결재 표를 바꾼다', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const d = dashOk({ approvals_pending: 1 });
      mount('u-kim', EIGHT); feed(EIGHT);
      await act(async () => {});
      expect($('.bar [data-approvals]').dataset.approvals).toBe('1');
      d.mockResolvedValue({ ...DASH, approvals_pending: 3 } as never);
      const n = d.mock.calls.length;
      await act(async () => { vi.advanceTimersByTime(10_000); });
      expect(d.mock.calls.length).toBe(n + 1);
      expect($('.bar [data-approvals]').dataset.approvals).toBe('3');
    } finally { vi.useRealTimers(); }
  });
  it('요약 실패(403 · 500 · 형식 틀림) → 결재 수를 지어내지 않고 결재 표는 숨김 + 까닭(화면 읽기 한 줄), 수 칸은 타일로 셈', async () => {
    for (const [rep, says] of [[{ code: 'FORBIDDEN', status: 403, message: '권한이 없습니다.' }, '권한이 없습니다.'], [{ code: 'INTERNAL', status: 500, message: '서버 오류' }, '서버 오류'], [{}, '요약 형식이 맞지 않습니다']] as const) {
      const d = vi.spyOn(api, 'dashboard');
      if ('code' in rep) d.mockRejectedValue(rep); else d.mockResolvedValue(rep as never);
      mount('u-kim', EIGHT); feed(EIGHT);
      await act(async () => {});
      expect(['임무 중', '경고'].map((k) => $(`[data-sum="${k}"] b`).textContent)).toEqual(['6', String(document.querySelectorAll('.u5 .tile[class*="lv-"]').length)]);   // 수 칸은 타일로 셈 · 요약 실패와 무관
      expect($('[data-dash-err]').textContent).toContain(says);
      expect($('.bar [data-approvals]').dataset.approvals).toBe('');
      expect($('.bar [data-approvals]').hidden).toBe(true);
      act(() => root!.unmount()); root = null; box.remove(); d.mockRestore();
    }
  });
  it('운영 관리자: 수 칸은 받은 로봇 상태로 셈 · 서버 요약 칸 표시 없음 · 결재 표 없음', () => {
    mount('u-lee', TWENTY); feed(TWENTY);
    expect($('[data-sum="임무 중"]').dataset.src).toBeUndefined();
    expect($('[data-sum="경고"] b').textContent).toBe('0');   // 내 로봇 10 대 중 테두리 경고 없음
    expect($('.bar [data-approvals]')).toBeNull();
  });

  // u5_2 선택 칸 = 옛 로봇 탭 상세 서랍 자리(GET /robots/{id}): 임무 · 위치 · 모드 · 조종
  const ROBOT = (o: object = {}) => ({ id: 'g6', name: 'K-07', model: 'Go2', owner: { id: 'u-lee', display_name: '이OO' }, connection: 'ONLINE', status: 'RUNNING', battery: { soc: 64, updated_at: '' },
    location: { floor_id: null, map_version_id: null, x: 1.25, y: -3, yaw: 0, confidence: 1, updated_at: '2026-11-28T05:06:07Z' }, lease: { holder_type: 'USER', user: { id: 'u-park', display_name: '박OO' }, since: '' },
    current_run: { run_id: 'r1', status: 'MOVING', scenario_name: '공정 순찰 A', progress: { done: 2, total: 4 } }, devices: [], attention: [], simulation: false, server_drive_allowed: true, ...o });
  const kv = (k: string) => $(`[data-picked] [data-k="${k}"]`).textContent;
  it('선택 칸: 고르면 GET /robots/{id} 한 번 · 임무(이름 · 단계 · 할 일) · 위치 x · y (받은 시각) · 조종(lease)', async () => {
    const got = vi.spyOn(api, 'robot').mockResolvedValue(ROBOT() as never);
    mount('u-kim', TWENTY);   // 실시간 state 전: 상세 값
    await act(async () => { tile('g6').click(); });
    expect(got.mock.calls.map((c) => c[0])).toEqual(['g6']);
    expect(kv('임무')).toBe('공정 순찰 A · 이동 중 · 할 일 2 / 4');
    expect(kv('위치')).toMatch(/^x 1\.3 m · y -3\.0 m \(\d\d:\d\d:\d\d\)$/);
    expect(kv('조종')).toBe('박OO');
    expect(kv('모드')).toBe('');
  });
  it('선택 칸 위치(시안 u5_2): 가용 location_label(타일과 같은 자리 이름)이 있으면 좌표 대신 그 이름', async () => {
    vi.spyOn(api, 'availability').mockResolvedValue({ items: [{ robot_id: 'g6', robot_name: 'K-07', state: 'FREE', busy_until: null, busy_slot_id: null, busy_label: null, battery_pct: 70, demo: false, sim: false, location_label: '제어실 앞 주도로' }] } as never);
    vi.spyOn(api, 'robot').mockResolvedValue(ROBOT() as never);
    mount('u-kim', TWENTY);
    await act(async () => {});
    await act(async () => { tile('g6').click(); });
    expect(kv('위치')).toBe('제어실 앞 주도로');
  });
  it('선택 칸: 위치 null = «위치 없음», 임무 없음 = «진행 중인 임무가 없습니다», 조종권 없음 = «없음»', async () => {
    vi.spyOn(api, 'robot').mockResolvedValue(ROBOT({ id: 'g3', location: null, current_run: null, lease: null }) as never);
    mount('u-kim', TWENTY);
    await act(async () => { tile('g3').click(); });
    expect([kv('임무'), kv('위치'), kv('조종')]).toEqual(['진행 중인 임무가 없습니다', '위치 없음', '없음']);
  });
  it('선택 칸: 운영 관리자가 남의 로봇(요약만) = «확인 안 됨» · 상세 실패 = 까닭 한 줄 · 404 = 목록 다시 받기', async () => {
    vi.spyOn(api, 'robot').mockRejectedValue({ code: 'INTERNAL', status: 500, message: '서버 오류' });
    const hid = TWENTY.slice(0, 8).map((r) => (r.owner === 'u-park' ? { ...r, unknown: 'summary' as const } : r));
    mount('u-lee', hid); feed(hid.filter((r) => r.owner === 'u-lee'));
    act(() => { seg('범위', 0).click(); });
    await act(async () => { tile('g7').click(); });
    expect([kv('임무'), kv('위치'), kv('조종')]).toEqual(['확인 안 됨', '확인 안 됨', '확인 안 됨']);
    expect($('[data-detail-err]').textContent).toBe('상세를 받지 못했습니다. 서버 오류');
  });
  it('선택 칸: 상세 404 = «찾을 수 없음» + 목록 다시 받기(refresh 한 번), 그 밖 실패는 까닭 · 다시 받지 않음', async () => {
    for (const [rep, says, n] of [[{ code: 'NOT_FOUND', status: 404, message: '로봇을 찾을 수 없습니다.' }, '이 로봇을 찾을 수 없습니다', 1], [{ code: 'NETWORK', message: '서버에 연결하지 못했습니다.' }, '상세를 받지 못했습니다. 서버에 연결하지 못했습니다', 0]] as const) {
      vi.spyOn(api, 'robot').mockRejectedValue(rep);
      const refresh = vi.fn();
      window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
      location.hash = '';
      box = document.createElement('div'); document.body.append(box);
      act(() => { root = createRoot(box); root.render(<App user={USERS.find((u) => u.id === 'u-kim')} robots={TWENTY} refresh={refresh} />); });
      await act(async () => { tile('g6').click(); });
      expect($('[data-detail-err]').textContent).toContain(says);
      expect(refresh).toHaveBeenCalledTimes(n);
      act(() => root!.unmount()); root = null; box.remove(); vi.restoreAllMocks();
    }
  });
  it('선택 칸: 위치만 바뀐 state 도 다시 그린다(실시간 state 가 상세보다 앞섬)', async () => {
    vi.spyOn(api, 'robot').mockResolvedValue(ROBOT() as never);
    mount('u-kim', TWENTY.slice(0, 8)); feed(TWENTY.slice(0, 8));
    await act(async () => { tile('g6').click(); });
    act(() => { FakeWS.last.recv(state('g6', { location: { floor_id: null, map_version_id: null, x: 9, y: 1, yaw: 0, confidence: 1, updated_at: '2026-11-28T05:06:07Z' } })); });
    expect(kv('위치')).toContain('x 9.0 m');
  });
  it('선택 칸: 담당이 바뀌면 다시 받고, 옛 요청의 늦은 답은 버린다', async () => {
    let late!: (v: unknown) => void;
    const got = vi.spyOn(api, 'robot').mockImplementationOnce(() => new Promise((ok) => { late = ok; }) as never).mockResolvedValue(ROBOT({ current_run: { run_id: 'r2', status: 'MOVING', scenario_name: '새 임무', progress: { done: 0, total: 1 } } }) as never);
    mount('u-kim', TWENTY.slice(0, 8)); feed(TWENTY.slice(0, 8));
    await act(async () => { tile('g6').click(); });
    root!.render(<App user={USERS.find((u) => u.id === 'u-kim')} robots={TWENTY.map((r) => (r.id === 'g6' ? { ...r, owner: 'u-park', ownerName: '박OO' } : r))} />);
    await act(async () => {});
    expect(got).toHaveBeenCalledTimes(2);
    expect(kv('임무')).toBe('새 임무 · 이동 중 · 할 일 0 / 1');
    await act(async () => { late(ROBOT()); });
    expect(kv('임무')).toBe('새 임무 · 이동 중 · 할 일 0 / 1');   // 늦게 온 옛 답은 버림
  });

  // C2 · D1(app-design-lx 05:12 결정): 관제 탭 STOP 은 고른 타일 로봇을 한 번에 · 고른 것이 없으면 첫 누름 = 고르기, 맨 위 «모두 정지 (N 대)»
  const stopBtn = () => $('[aria-label="비상 정지"]');
  const press = (b: HTMLElement) => act(() => { b.click(); });
  it('관제 STOP: 타일에서 고른 로봇이 있으면 한 번 누름으로 그 로봇만 정지(로봇 탭의 ctx.robot 이 다른 로봇이어도)', () => {
    mount('u-lee', TWENTY); feed(TWENTY);
    expect(stopBtn().textContent).toBe('모두 정지');
    act(() => { tile('g6').click(); });   // 관제에서 고름(이OO 로봇) · ctx.robot 은 목록 첫 로봇(g0) 그대로
    expect(stopBtn().textContent).toBe(`${TWENTY.find((r) => r.id === 'g6')!.name} 정지`);   // 시안 u5_2 «K-01 정지»
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
    expect(pick.querySelector('[data-stop-lost="g4"]')!.textContent).toContain('K-05 연결 끊김 · 정지를 보낼 수 없습니다. 다시 연결되면 로봇은 잠긴 상태로 시작합니다. 지금 멈춰야 하면 리모컨이나 현장에서 멈추세요.');
    press(stopBtn());
    const sent = FakeWS.last.of('stop').map((m) => m.robot);
    expect(new Set(sent)).toEqual(new Set(T.filter((r) => r.owner === 'u-lee').map((r) => r.id)));
    expect(sent).toHaveLength(10);
    const bands = $$('[data-stop-band]');
    expect(bands).toHaveLength(10);
    const lostBand = bands.find((b) => b.textContent!.includes('K-05'))!;   // 끊긴 로봇은 붙은 로봇과 같은 성공 표시가 아님
    expect(lostBand.dataset.stopLost).toBe('g4');
    expect(lostBand.textContent).toContain('K-05 연결이 끊겨 정지를 보내지 못했습니다. 다시 연결되면 로봇은 잠긴 상태로 시작합니다. 지금 멈춰야 하면 리모컨이나 현장에서 멈추세요.');
    expect(lostBand.textContent).not.toMatch(/다시 연결되면 멈춤|닿습니다|전달됩니다/);
  });
  // Codex #535 H2 (11-28): 끊긴 로봇에 «다시 연결되면 멈춤» 을 약속하지 않는다 · 다시 붙어도 잠금(새 세대) 확인 전에는 경고를 지우지 않는다
  const NOT_SENT = '연결이 끊겨 정지를 보내지 못했습니다. 다시 연결되면 로봇은 잠긴 상태로 시작합니다. 지금 멈춰야 하면 리모컨이나 현장에서 멈추세요.';
  it('H2: 끊긴 로봇 모두 정지 · 약속 없는 문구, 다시 ONLINE 만으로는 경고가 남고, latched + 세대가 오른 뒤에만 지움', () => {
    const T = TWENTY.map((r) => (r.id === 'g4' ? { ...r, online: false } : r));
    mount('u-lee', T); feed(TWENTY);   // 끊기기 전: g4 는 세대 1 을 알렸다
    act(() => { FakeWS.last.recv(state('g4', { connection: 'OFFLINE', status: null, battery: null, latched: null, stop_gen: null, applied: null })); });
    root!.render(<App user={USERS.find((u) => u.id === 'u-lee')} robots={T} />);
    press(stopBtn());
    expect($('[aria-label="정지할 로봇 고르기"] [data-stop-lost="g4"]')!.textContent).toBe('▲ K-05 연결 끊김 · 정지를 보낼 수 없습니다. 다시 연결되면 로봇은 잠긴 상태로 시작합니다. 지금 멈춰야 하면 리모컨이나 현장에서 멈추세요.');   // 보내기 전 줄(#529 H2 글)
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
  it('이 계정이 못 세우는 타일(총괄이 남의 시뮬)을 고르면 정지 단추 글은 «모두 정지» 그대로(reviewer G1)', () => {
    const T = TWENTY.slice(0, 8).map((r) => (r.id === 'g6' ? { ...r, sim: true, owner: 'u-lee', demo: false } : r));   // 사용자 시뮬(데모 아님 · 22:04)
    mount('u-kim', T); feed(T);
    act(() => { tile('g6').click(); });
    expect(stopBtn().textContent).toBe('모두 정지');
    expect(stopBtn().textContent).not.toContain(T.find((r) => r.id === 'g6')!.name);
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
  // reviewer 20:30 (SWITCH_OFF 한 대 고름): 글은 「K-07 정지」 그대로(누르면 가는 대상이 그 한 대) · 누르기 전에 현장 폰 안내 한 줄 · 거절은 실패 줄
  const OFF = () => TWENTY.map((r) => (r.id === 'g6' ? { ...r, serverDrive: false, serverDriveBlocked: ['SWITCH_OFF'] as Robot['serverDriveBlocked'] } : r));
  it('SWITCH_OFF 실기 한 대를 고르면 단추 글 «K-07 정지» · 현장 폰에서만 멈출 수 있다는 안내 한 줄(누르기 전)', () => {
    const T = OFF();
    mount('u-lee', T); feed(T);
    expect($('[data-phone-only-pick]')).toBeNull();
    act(() => { tile('g6').click(); });
    expect(stopBtn().textContent).toBe('K-07 정지');
    expect($('[data-phone-only-pick]')!.textContent).toBe('K-07 은 현장 폰에서만 멈출 수 있습니다');
    // 조사는 이름 끝 소리 받침대로(조정 22:34 · 「Go2 X 은」 이 틀렸던 것)
    expect(['Go2 X', 'K-01', 'K-02', 'K-05', 'K-10', '데모', '현장', 'Go2-L', 'Robot A'].map(eunNeun)).toEqual(['는', '은', '는', '는', '은', '는', '은', '은', '는']);
    expect(en('Go2 X 는 현장 폰에서만 멈출 수 있습니다')).toBe('Go2 X can only be stopped from the field phone');
    act(() => { tile('g4').click(); });   // 다른 로봇으로 바꾸면 안내가 사라짐
    expect($('[data-phone-only-pick]')).toBeNull();
  });
  it('SWITCH_OFF 실기 한 대 고름 → 누름 → 서버 PHONE_DIRECT_REQUIRED 거절이면 띠는 실패 줄 · 잠금 · 멈춤 같은 성공 줄 아님', () => {
    const T = OFF();
    mount('u-lee', T); feed(T);
    FakeWS.last.auto = (m) => (m.t === 'stop' ? { ok: false, error: { code: 'PHONE_DIRECT_REQUIRED', message: '실기 조종·STOP은 현장 폰에서 직접 하세요.', detail: {} } } as never : { ok: true });
    act(() => { tile('g6').click(); });
    press(stopBtn());
    expect(FakeWS.last.of('stop').map((m) => m.robot)).toEqual(['g6']);
    const b = $$('[data-stop-band]').find((x) => x.textContent!.includes('K-07'))!;
    expect(b.textContent).toMatch(/^▲ K-07 정지 요청을 보내지 못했습니다\. .*현장에서 로봇을 직접 멈추세요\.$/);
    expect(b.textContent).not.toMatch(/정지 잠금|멈춤 출력|잠김|멈췄습니다/);
  });
  // 조정 12:01 · reviewer: SWITCH_OFF 실기(#535 M4)는 서버 경유 조종도 꺼져 있다(serverDrive false). #529 H1 «보내고 안내» 줄이 같이 뜨면 「보낸다」 와 「못 멈춘다」 가 겹친다
  it('M4 + H1: SWITCH_OFF 실기(serverDrive false)는 현장 폰 줄만 · 다른 serverDrive false 실기는 보내고 안내 줄', () => {
    const T = TWENTY.map((r) => (r.id === 'g6' ? { ...r, serverDrive: false, serverDriveBlocked: ['SWITCH_OFF'] as Robot['serverDriveBlocked'] } : r.id === 'g8' ? { ...r, serverDrive: false } : r));
    mount('u-lee', T); feed(T);
    press(stopBtn());
    const pick = $('[aria-label="정지할 로봇 고르기"]');
    expect(pick.querySelector('[data-phone-only]')!.textContent).toContain('K-07');
    expect(pick.querySelector('[data-stop-noserver="g6"]')).toBeNull();
    expect(pick.querySelector('[data-stop-noserver="g8"]')).not.toBeNull();
    press(stopBtn());
    const sent = FakeWS.last.of('stop').map((m) => m.robot);
    expect(sent).not.toContain('g6');
    expect(sent).toContain('g8');
  });
  it('정지 한 줄: 타일 상태 표지 · 선택 칸에 serverdrive stopLine 과 같은 판정 · 정지 전에는 없음', () => {
    mount('u-lee', TWENTY); feed(TWENTY);
    expect(tile('g6').querySelector('[data-stop-line]')).toBeNull();
    act(() => { tile('g6').click(); });
    press(stopBtn());
    const want = stopLine(rt.get('g6'))!;
    expect(want).not.toBeNull();
    expect(tile('g6').querySelector('.stb[data-stop-line]')!.textContent).toBe(want.text);
    expect(tile('g6').querySelector<HTMLElement>('.stb[data-stop-line]')!.dataset.stopLine).toBe(want.tone);
    expect($('[data-picked] [data-stop-line]').textContent).toBe(want.text);
    act(() => { FakeWS.last.recv(state('g6', { status: 'STOP_LATCHED', latched: true, stop_gen: 2, applied: [0, 0, 0], speed: 0 })); });
    expect(tile('g6').querySelector('.stb[data-stop-line]')!.textContent).toBe(stopLine(rt.get('g6'))!.text);
  });
  it('R3: «모두»에서 남의 로봇을 고른 뒤 «내 로봇»으로 되돌리면 고름이 비고, STOP 한 번은 숨은 로봇이 아니라 고르기', () => {
    mount('u-lee', TWENTY.slice(0, 8)); feed(TWENTY.slice(0, 8));
    act(() => { seg('범위', 0).click(); });   // 모두
    act(() => { tile('g7').click(); });                           // 박OO 로봇
    act(() => { seg('범위', 1).click(); });   // 내 로봇 → g7 은 보이지 않음
    press(stopBtn());
    expect(FakeWS.last.of('stop')).toHaveLength(0);
    expect($('[aria-label="정지할 로봇 고르기"]')).not.toBeNull();
  });
  it('R2 · M5 (11/28 총괄 = 모든 권한 · #547): 총괄이 실기 타일을 고르면 그 실기가 대상 · 한 번 누름으로 보냄, 못 세움 줄 없음', () => {
    const R: Robot[] = [
      { id: 'a1', name: 'K-21', owner: 'u-lee', ownerName: '이OO', battery: 70, online: true, seenAt: '14:05:20', status: 'RUNNING' },   // 남 담당 실기 = 총괄도 세움
      { id: 's1', name: 'S-01', owner: 'u-kim', ownerName: '김OO', battery: 70, online: true, seenAt: '14:05:20', status: 'RUNNING', sim: true },
    ];
    mount('u-kim', R); feed(R);
    act(() => { tile('a1').click(); });
    press(stopBtn());
    expect(FakeWS.last.of('stop').map((m) => m.robot)).toEqual(['a1']);
    expect($('[data-cant-stop]')).toBeNull();
    expect($('[data-cant-real]')).toBeNull();
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
  const NOSRV = '실기 K-05 는 서버 경유 조종이 꺼져 있을 수 있습니다 · 정지는 보내고 결과는 아래 띠에 보입니다. 닿지 않으면 현장 폰이나 현장에서 멈추세요';
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
  it('후속 1 (11/28 총괄 = 모든 권한 · #547): 총괄 · 실기(붙음 · 끊김) 가 섞여도 라벨 = 모두 정지(끊김 수), 못 세움 줄 없음', () => {
    const R: Robot[] = [
      { id: 'a1', name: 'K-21', owner: 'u-lee', ownerName: '이OO', battery: 70, online: true, seenAt: '14:05:20', status: 'RUNNING' },
      { id: 'a2', name: 'K-22', owner: 'u-lee', ownerName: '이OO', battery: 70, online: false, seenAt: '14:05:20', status: 'RUNNING' },
      { id: 's1', name: 'S-01', owner: 'u-kim', ownerName: '김OO', battery: 70, online: true, seenAt: '14:05:20', status: 'RUNNING', sim: true },
      { id: 's2', name: 'S-02', owner: 'u-kim', ownerName: '김OO', battery: 70, online: true, seenAt: '14:05:20', status: 'RUNNING', sim: true },
    ];
    mount('u-kim', R); feed(R);
    press(stopBtn());
    const pick = $('[aria-label="정지할 로봇 고르기"]');
    expect(pick.querySelector('select')!.options[0].textContent).toBe('모두 정지 (4 대 · 끊김 1)');
    expect(pick.querySelector('[data-cant-real]')).toBeNull();
    press(stopBtn());
    expect(FakeWS.last.of('stop').map((m) => m.robot).sort()).toEqual(['a1', 'a2', 's1', 's2']);
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
    expect(box.querySelector('.tile[data-robot="g6"]')).toBeNull();
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
    act(() => { seg('범위', 0).click(); });   // 모두
    act(() => { tile('g6').click(); });                           // 이OO 로봇 = «내 로봇»에서도 보임
    act(() => { seg('범위', 1).click(); });
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
    act(() => { seg('범위', 0).click(); });
    press(stopBtn());
    expect(simStop).not.toHaveBeenCalled();
    expect($('[aria-label="정지할 로봇 고르기"] select').querySelector('option')!.textContent).toBe('모두 정지 (1 대)');
    press(stopBtn());
    expect(simStop).toHaveBeenCalledTimes(1);
    expect(FakeWS.last.of('stop')).toHaveLength(0);
  });

  // t21 (#529 재검 낮음 셋)
  // N4 → #529 H2(11:09): 다시 붙음만으로는 확인이 아니다. 서버는 끊긴 동안의 STOP 을 받아 두지 않는다. 확인 = 다시 붙은 뒤 latched=true · stop_gen 이 끊기기 전 값보다 오름
  // (서버가 hello 뒤 revoke(agent_connected) 로 연결 STOP 을 보내 stop_gen 을 올림 · leases.py 134~137, 에이전트도 잠긴 채 시작 · SF-02)
  it('t21-1: 끊긴 채 보낸 정지가 다시 붙어 확인된 뒤 또 끊기면 «아직 닿지 않음» 줄을 다시 띄우지 않는다(다음 STOP 전까지)', () => {
    mount('u-lee', TWENTY); feed(TWENTY);   // 끊기기 전 세대 1(기준 있음 · r2 M2)
    act(() => { FakeWS.last.recv(state('g4', { connection: 'OFFLINE', status: null, battery: null, latched: null, stop_gen: null, applied: null })); });
    act(() => { tile('g4').click(); });
    press(stopBtn());
    expect($('[data-stop-band][data-stop-lost="g4"]')).not.toBeNull();
    act(() => { FakeWS.last.recv(state('g4', { stop_gen: 2 })); });   // 다시 붙음 · 잠김(latched) + 세대 오름 = 확인
    expect($('[data-stop-band][data-stop-lost="g4"]')).toBeNull();
    expect($('[data-stop-band][data-stop-relatched="g4"]')!.textContent).toBe('■ K-05 다시 연결 · 잠긴 채 시작');
    act(() => { FakeWS.last.recv(state('g4', { connection: 'OFFLINE', status: null, battery: null, latched: null, stop_gen: null, applied: null })); });   // 두 번째 끊김
    expect($('[data-stop-band][data-stop-lost="g4"]')).toBeNull();
    expect($('[data-stop-band][data-stop-unsure="g4"]')).toBeNull();
    const b = $$('[data-stop-band]').find((x) => x.textContent!.includes('K-05'))!;
    expect(b.textContent).not.toContain(LOST);
    press(stopBtn());   // 다음 STOP(끊긴 채) = 다시 «아직 닿지 않음»
    expect($('[data-stop-band][data-stop-lost="g4"]')).not.toBeNull();
  });
  it('R2: 끊긴 두 대를 모두 정지 · 한 대만 다시 붙으면 다른 한 대는 «아직 닿지 않음» 그대로', () => {
    mount('u-lee', TWENTY); feed(TWENTY);   // 끊기기 전 세대 1(기준 있음 · r2 M2)
    const off = { connection: 'OFFLINE', status: null, battery: null, latched: null, stop_gen: null, applied: null } as const;
    act(() => { FakeWS.last.recv(state('g4', off)); FakeWS.last.recv(state('g6', off)); });   // 이OO 로봇 K-05 · K-07 끊김
    press(stopBtn());
    press(stopBtn());   // 모두 정지
    expect($('[data-stop-band][data-stop-lost="g4"]')).not.toBeNull();
    expect($('[data-stop-band][data-stop-lost="g6"]')).not.toBeNull();
    act(() => { FakeWS.last.recv(state('g4', { stop_gen: 2 })); });   // K-05 만 다시 붙음
    expect($('[data-stop-band][data-stop-lost="g4"]')).toBeNull();
    expect($('[data-stop-band][data-stop-lost="g6"]')!.textContent).toContain(`K-07 ${LOST}`);
  });
  it('t21-2: 모두 정지 라벨 전체 · 총괄(실기 + 내 시뮬 · 11/28 모든 권한) = 일반과 같이 «모두 정지» · 셋째 라벨 «멈출 수 있는 로봇 모두 정지»는 두 계정 어느 쪽에서도 나오지 않음', () => {
    const R: Robot[] = [
      { id: 'a1', name: 'K-21', owner: 'u-lee', ownerName: '이OO', battery: 70, online: true, seenAt: '14:05:20', status: 'RUNNING', serverDrive: true },
      { id: 'a2', name: 'K-22', owner: 'u-park', ownerName: '박OO', battery: 70, online: true, seenAt: '14:05:20', status: 'RUNNING', serverDrive: true },
      { id: 's1', name: 'S-01', owner: 'u-kim', ownerName: '김OO', battery: 70, online: true, seenAt: '14:05:20', status: 'RUNNING', sim: true },
      { id: 'a3', name: 'K-23', owner: 'u-park', ownerName: '박OO', battery: null, online: false, seenAt: '', status: null as never },   // 연결 전 실기 = 못 세우는 수에도 안 듦(t21-3 과 같음)
    ];
    mount('u-kim', R); feed(R);
    press(stopBtn());
    expect($<HTMLSelectElement>('[aria-label="정지할 로봇 고르기"] select').options[0].textContent).toBe('모두 정지 (3 대)');
    expect($('[data-cant-real]')).toBeNull();
    expect($('[data-stop-pre]').textContent).toBe('연결 전 로봇 1 대 · 정지를 보낼 수 없음');   // 총괄도 같은 줄(연결 전 실기 K-23)
    act(() => root?.unmount()); root = null;
    mount('u-lee', R); feed(R);
    act(() => { seg('범위', 0).click(); });   // 모두(남의 실기 K-22 도 보임)
    press(stopBtn());
    expect($<HTMLSelectElement>('[aria-label="정지할 로봇 고르기"] select').options[0].textContent).toBe('모두 정지 (1 대)');   // 남의 실기 K-22 는 구독 밖 요약 로봇이라 수에서 빠짐(세울 수는 있는 계정)
    expect($('[data-cant-real]')).toBeNull();
    expect($('[data-stop-pre]')).toBeNull();   // 이OO 에게 K-23 은 구독 밖 요약 로봇(연결 전으로 세지 않음)
  });
  it('t21-4: 연결 전 로봇이 0 대면 줄 없음(끊긴 로봇은 연결 전으로 세지 않음) · 모두 정지가 아닌 한 대를 고르면 줄 없음', () => {
    const L = TWENTY.map((r) => (r.id === 'g4' ? { ...r, online: false } : r));   // 끊김이 확인된(lost) 내 로봇 g4 = 연결 전이 아님
    mount('u-lee', L); feed(L);
    press(stopBtn());
    expect($('[aria-label="정지할 로봇 고르기"] [data-stop-lost="g4"]')).not.toBeNull();
    expect($('[aria-label="정지할 로봇 고르기"] [data-stop-pre]')).toBeNull();
    act(() => root?.unmount()); root = null;
    const T = TWENTY.map((r) => (r.id === 'g4' ? { ...r, online: false, status: null as never, mission: undefined } : r));
    mount('u-lee', T); feed(T);
    press(stopBtn());
    expect($('[data-stop-pre]')).not.toBeNull();
    const sel = $<HTMLSelectElement>('[aria-label="정지할 로봇 고르기"] select');
    act(() => { sel.value = sel.options[1].value; sel.dispatchEvent(new Event('change', { bubbles: true })); });
    expect($('[data-stop-pre]')).toBeNull();
  });
  it('t21-3: 아직 연결 전인 로봇(상태 보고 0 · 마지막 상태 없음)은 모두 정지 수에서 빠지고 끊김 · 상태 모름 줄도 없다', () => {
    const T = TWENTY.map((r) => (r.id === 'g4' ? { ...r, online: false, status: null as never, mission: undefined } : r));   // 이OO 로봇 g4 = 연결 전
    mount('u-lee', T); feed(T);
    press(stopBtn());
    const pick = $('[aria-label="정지할 로봇 고르기"]');
    expect(pick.querySelector('select')!.options[0].textContent).toBe('모두 정지 (9 대)');
    expect(pick.querySelector('[data-stop-lost="g4"]')).toBeNull();
    expect(pick.querySelector('[data-stop-unsure="g4"]')).toBeNull();
    expect(pick.querySelector('[data-stop-pre]')!.textContent).toBe('연결 전 로봇 1 대 · 정지를 보낼 수 없음');
    press(stopBtn());
    expect(FakeWS.last.of('stop').map((m) => m.robot)).not.toContain('g4');
    expect(FakeWS.last.of('stop')).toHaveLength(9);
  });

  // Codex d9 검토(pr529.md 11:01): H1 · H2 · M3
  it('H1(r2): server_drive_allowed=false 실기도 정지 대상에서 빼지 않음 · 모두 정지 · 타일 고름 모두 그 로봇으로 보냄 · 「꺼져 있을 수 있음」 은 안내 한 줄', () => {
    const T = TWENTY.map((r) => (r.id === 'g4' ? { ...r, serverDrive: false } : r));   // 이OO 실기 K-05 · 인증 갱신 지연 등으로 조종 허용만 false(서버는 STOP 을 전달)
    mount('u-lee', T); feed(T);
    press(stopBtn());
    const pick = $('[aria-label="정지할 로봇 고르기"]');
    expect(pick.querySelector('select')!.options[0].textContent).toBe('모두 정지 (10 대)');
    expect([...pick.querySelectorAll('option')].map((o) => o.textContent)).toContain('K-05');
    expect(pick.querySelector('[data-stop-noserver="g4"]')!.textContent).toBe(NOSRV);
    press(stopBtn());
    expect(FakeWS.last.of('stop').map((m) => m.robot)).toContain('g4');
    expect(FakeWS.last.of('stop')).toHaveLength(10);
    act(() => root?.unmount()); root = null;
    mount('u-lee', T); feed(T);
    act(() => { tile('g4').click(); });
    press(stopBtn());
    expect(FakeWS.last.of('stop').map((m) => m.robot)).toEqual(['g4']);
    expect($('[data-cant-stop]')).toBeNull();
    expect($('[data-stop-band]').textContent).toContain('K-05 정지 요청됨');   // 결과는 서버 회신 그대로
  });
  it('H2: 끊긴 채 보낸 정지는 다시 붙음(ONLINE)만으로 경고를 지우지 않음 · 잠김 + stop_gen 이 끊기기 전 값보다 오른 뒤에만 「다시 연결 · 잠긴 채 시작」', () => {
    mount('u-lee', TWENTY); feed(TWENTY, { g4: { stop_gen: 5 } });   // 끊기기 전 세대 5
    act(() => { FakeWS.last.recv(state('g4', { connection: 'OFFLINE', status: null, battery: null, latched: null, stop_gen: null, applied: null })); });
    act(() => { tile('g4').click(); });
    press(stopBtn());
    expect($('[data-stop-band][data-stop-lost="g4"]')!.textContent).toBe(`▲ K-05 ${LOST}`);
    act(() => { FakeWS.last.recv(state('g4', { stop_gen: 5 })); });   // 다시 붙음 · 잠김이지만 세대가 그대로
    expect($('[data-stop-band][data-stop-lost="g4"]')).not.toBeNull();
    expect($('[data-stop-relatched="g4"]')).toBeNull();
    act(() => { FakeWS.last.recv(state('g4', { stop_gen: 6, latched: false })); });   // 세대는 올랐지만 잠김 아님
    expect($('[data-stop-band][data-stop-lost="g4"]')).not.toBeNull();
    act(() => { FakeWS.last.recv(state('g4', { stop_gen: 7, latched: true })); });   // 잠김 + 세대 오름 = 연결 STOP 확인
    expect($('[data-stop-band][data-stop-lost="g4"]')).toBeNull();
    expect($('[data-stop-band][data-stop-relatched="g4"]')!.textContent).toBe('■ K-05 다시 연결 · 잠긴 채 시작');
    expect(box.textContent).not.toContain('멈춤 출력');
  });
  it('M2(r2): 기준 세대가 없으면(첫 상태 보고 전 · 끊긴 채 시작) 잠김 보고가 와도 「다시 연결 · 잠긴 채 시작」 을 쓰지 않고 끊김 경고 유지', () => {
    const T = TWENTY.map((r) => (r.id === 'g4' ? { ...r, online: false } : r));   // 처음부터 끊김 · stop_gen 받은 적 없음
    mount('u-lee', T); feed(T);
    act(() => { tile('g4').click(); });
    press(stopBtn());
    expect($('[data-stop-band][data-stop-lost="g4"]')).not.toBeNull();
    act(() => { FakeWS.last.recv(state('g4', { stop_gen: 3, latched: true })); });   // 원래 잠겨 있던 로봇의 첫 보고
    expect($('[data-stop-relatched="g4"]')).toBeNull();
    expect($('[data-stop-band][data-stop-lost="g4"]')).not.toBeNull();
  });
  it('M2(r2): 서버가 정지를 거절하면 다시 붙어 잠김 + 세대가 올라도 거절 안내가 앞섬', () => {
    mount('u-lee', TWENTY); feed(TWENTY, { g4: { stop_gen: 5 } });
    act(() => { FakeWS.last.recv(state('g4', { connection: 'OFFLINE', status: null, battery: null, latched: null, stop_gen: null, applied: null })); });
    FakeWS.last.auto = (m) => (m.t === 'stop' ? { ok: false, error: { code: 'FORBIDDEN', message: '정지 권한이 없습니다.', detail: {} } } as never : { ok: true });
    act(() => { tile('g4').click(); });
    press(stopBtn());
    act(() => { FakeWS.last.recv(state('g4', { stop_gen: 7, latched: true })); });
    expect($('[data-stop-relatched="g4"]')).toBeNull();
    expect($$('[data-stop-band]').find((b) => b.textContent!.includes('K-05'))!.textContent).toMatch(/^▲ K-05 정지 요청을 보내지 못했습니다\. .* 현장에서 로봇을 직접 멈추세요\.$/);   // 서버 거절 글(say)
  });
  it('M3(r2): /missions 주소의 잘못된 퍼센트 인코딩이 첫 그리기를 깨지 않음 · STOP 단추가 있음', () => {
    expect(oldScenario('#/missions/%E0%A4%A')).toBe('');
    expect(oldScenario('#/missions?scenario_id=%ZZ')).toBe('');
    expect(oldScenario('#/missions/abc')).toBe('abc');
    mount('u-lee', TWENTY, '#/missions/%E0%A4%A'); feed(TWENTY);
    expect(stopBtn()).toBeTruthy();
  });
  it('M3: Enter 반복 중이어도 Space(전역 정지 · 초점 단추 click)는 버리지 않음', () => {
    mount('u-lee', TWENTY); feed(TWENTY);
    press(stopBtn());
    const go = $('[aria-label="정지할 로봇 고르기"] button.fh-stop');
    expect(document.activeElement).toBe(go);
    act(() => { go.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', repeat: true, bubbles: true, cancelable: true })); });
    act(() => { go.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 })); });   // Enter 반복의 click 은 여전히 버림
    expect(FakeWS.last.of('stop')).toHaveLength(0);
    act(() => { go.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true })); });   // 새 Space 누름
    expect(FakeWS.last.of('stop')).toHaveLength(10);
  });
  it('데모 표시 스위치(대조표 u5_1): 끄면 데모 로봇을 타일 · 지도 보기 · 수에서 숨기고, 이 브라우저에 기억(저장 API 없음) · 고른 데모 로봇은 풂', async () => {
    const item = (id: string, demo: boolean) => ({ robot_id: id, robot_name: id, state: 'FREE', busy_until: null, busy_slot_id: null, busy_label: null, battery_pct: 70, demo, sim: false, location_label: null });
    const av = vi.spyOn(api, 'availability').mockResolvedValue({ items: [item('k1', true), item('k2', true), item('k3', false)] } as never);
    try {
      localStorage.setItem('fh-control-demo', '1');
      mount('u-kim', EIGHT); feed(EIGHT);
      await act(async () => {});
      const sw = () => $('[data-demo-show]') as HTMLElement;
      expect(sw().getAttribute('aria-checked')).toBe('true'); expect(tile('k1')).not.toBeNull();
      act(() => { tile('k1').click(); }); expect(controlPick.get()).toBe('k1');
      act(() => { sw().click(); });
      expect(sw().getAttribute('aria-checked')).toBe('false');
      expect(tile('k1')).toBeNull(); expect(tile('k2')).toBeNull(); expect(tile('k3')).not.toBeNull();
      expect(controlPick.get()).toBe('');
      expect(localStorage.getItem('fh-control-demo')).toBe('0');
      act(() => { seg('보기', 1).click(); });
      expect($$('.u5 .mks .mk3').map((e) => e.dataset.r3)).not.toContain('k1');
      act(() => root?.unmount()); box.parentNode?.removeChild(box);
      mount('u-kim', EIGHT); feed(EIGHT); await act(async () => {});   // 다시 열어도 꺼진 채
      expect(sw().getAttribute('aria-checked')).toBe('false'); expect(tile('k1')).toBeNull();
      act(() => { sw().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
      expect(tile('k1')).not.toBeNull(); expect(localStorage.getItem('fh-control-demo')).toBe('1');
    } finally { av.mockRestore(); localStorage.setItem('fh-control-demo', '1'); }
  });
  it('데모 표시 = 조직 설정 show_demo_label(서버 값이 이 브라우저 기억보다 먼저) · 총괄이 바꾸면 PATCH show_demo_label', async () => {
    const item = (id: string, demo: boolean) => ({ robot_id: id, robot_name: id, state: 'FREE', busy_until: null, busy_slot_id: null, busy_label: null, battery_pct: 70, demo, sim: false, location_label: null });
    const av = vi.spyOn(api, 'availability').mockResolvedValue({ items: [item('k1', true), item('k3', false)] } as never);
    const get = vi.spyOn(api, 'settings').mockResolvedValue({ battery_low_pct: 20, show_demo_label: false } as never);
    const put = vi.spyOn(api, 'saveSettings').mockImplementation((p) => Promise.resolve({ battery_low_pct: 20, ...p }) as never);
    try {
      localStorage.setItem('fh-control-demo', '1');
      mount('u-kim', EIGHT); feed(EIGHT);
      await act(async () => {}); await act(async () => {});
      const sw = () => $('[data-demo-show]') as HTMLElement;
      expect(sw().getAttribute('aria-checked')).toBe('false'); expect(tile('k1')).toBeNull();
      await act(async () => { sw().click(); });
      expect(put.mock.calls.map((c) => c[0])).toEqual([{ show_demo_label: true }]);
      expect(sw().getAttribute('aria-checked')).toBe('true'); expect(tile('k1')).not.toBeNull();
    } finally { av.mockRestore(); get.mockRestore(); put.mockRestore(); localStorage.setItem('fh-control-demo', '1'); }
  });
  it('첫 화면으로(대조표 u5_1): 지도 보기 첫 시점으로 새로 엶(다가가기 없음 · 작은 지도에서 자라기 없음)', () => {
    mount('u-kim', TWENTY); feed(TWENTY);
    const home = $('[data-home]') as HTMLElement;
    expect(home.getAttribute('role')).toBe('button');
    act(() => { home.click(); });
    const big = () => $('.u5 .big') as HTMLElement;
    expect(big()).not.toBeNull(); expect(big().hasAttribute('data-focus')).toBe(false); expect(big().hasAttribute('data-from-mini')).toBe(false);
    const cv = big().querySelector('canvas');
    act(() => { home.click(); });
    expect(big().querySelector('canvas')).not.toBe(cv);   // 카메라를 새로(첫 시점) 잡도록 다시 그림
  });
  it('가용(GET /robots/availability) · 오늘 일정(GET /schedule): 구역 이름 = location_label · 데모 칩 · 충전 = state CHARGING 만 · 지금 걸친 BATTERY_SWAP 칸 = «배터리 교체» · MAINTENANCE = «점검 중» 칩 + busy_label 줄 · 실패면 수를 비움', async () => {
    const item = (id: string, o: object = {}) => ({ robot_id: id, robot_name: id, state: 'FREE', busy_until: null, busy_slot_id: null, busy_label: null, battery_pct: 70, demo: false, sim: false, location_label: null, ...o });
    const av = vi.spyOn(api, 'availability').mockResolvedValue({ items: [
      item('k1', { demo: true, location_label: '정비동 · 1 층' }),   // demo 플래그 PR 전: 시험 자료는 demo=true 고정
      item('k2', { state: 'BUSY', busy_slot_id: 's-swap', busy_label: '배터리 교체' }),
      item('k3', { state: 'CHARGING' }),
      item('k4', { state: 'BUSY', busy_slot_id: 's-run', busy_label: '배터리 교체' }),   // 이름만 같은 임무 칸은 교체가 아님
      item('k8', { state: 'MAINTENANCE', busy_label: '정기 점검 · 다리 관절' }),
    ] } as never);
    const sc = vi.spyOn(api, 'schedule').mockResolvedValue({ day: '2026-11-28', tz: 'Asia/Seoul', slots: [{ id: 's-swap', kind: 'BATTERY_SWAP' }, { id: 's-run', kind: 'CONFIRMED' }] } as never);
    const L: Robot[] = EIGHT.map((r) => (r.id === 'k8' ? { ...r, online: true, status: 'IDLE' as const } : r));   // 점검 배지는 연결된 로봇(끊김 배지가 먼저)
    mount('u-kim', L); feed(L);
    await act(async () => {});
    expect(tile('k1').querySelector('.nm [data-demo]')!.textContent).toBe('데모');
    expect(tile('k2').querySelector('[data-demo]')).toBeNull();
    expect(tile('k1').querySelectorAll('.ln')[1].textContent).toBe('정비동 · 1 층');
    expect($('[data-sum="충전"] b').textContent).toBe('1');   // CHARGING 인 k3 만(서버가 CHARGING 을 보내지 않으면 충전으로 그리지 않음)
    expect($('[data-sum="충전"]').dataset.none).toBeUndefined();
    expect(small('k2', 'battery')).toBe('배터리 교체');
    expect(tile('k2').querySelector('[data-charging]')).toBeNull();
    expect(tile('k2').querySelector('[data-swap]')!.textContent).toBe('배터리 교체');
    expect(small('k4', 'battery')).toBe('');
    expect(tile('k4').querySelector('[data-swap]')).toBeNull();
    // 점검(시안 u5_1 K-06): 카메라 칸 «점검 중» 칩 · 일 줄 = busy_label · 배터리 칸 «점검 중» · 점검 수
    expect(tile('k8').querySelector('[data-maint]')!.textContent).toBe('점검 중');
    expect(tile('k8').querySelector('.ln span')!.textContent).toBe('정기 점검 · 다리 관절');
    expect($('[data-sum="점검"] b').textContent).toBe('1');
    expect(tile('k3').querySelector('[data-charging]')!.textContent).toBe('충전 중');
    expect((tile('k3').querySelector('[data-charging]') as HTMLElement).style.color).toBe('var(--u5-on)');   // 글 하양(밝은 판 그라파이트) · 점 초록(팀장 02:14)
    // 충전 배지 = 배터리 아이콘 없이 점검 중과 같은 점 펄스(.stb.chk i) · 초록(팀장 01:51)
    const ch = tile('k3').querySelector<HTMLElement>('[data-charging]')!;
    expect(ch.classList.contains('chk')).toBe(true); expect(ch.querySelector('.bt')).toBeNull();
    expect(ch.querySelector<HTMLElement>(':scope > i')!.style.background).toBe('var(--u5-ok)');   // 시안 민트(어둠 #00c389 · 밝음 #0E7F63, u5.css)
    av.mockRestore(); sc.mockRestore();
  });
  it('글이 없는 줄 · 칸은 아이콘을 보이지 않게(줄 높이는 지킴) · 걸음 이름이 없으면 아이콘 없음', () => {
    mount('u-kim', TWENTY); feed(TWENTY);
    const ln = tile('g15').querySelector('.ln')!;   // 정지 잠금 · 꺼짐 = 임무 줄 글 없음(머리표가 상태)
    expect(ln.querySelector('span')!.textContent).toBe('');
    expect((ln.querySelector('svg') as SVGElement).style.visibility).toBe('hidden');
    expect((tile('g3').querySelector('[data-fact="temp"] svg') as SVGElement).style.visibility).toBe('hidden');
    expect((tile('g5').querySelector('.ln svg') as SVGElement).style.visibility).toBe('');
    expect(tile('g3').querySelector('.nm .md svg')).toBeNull();
  });
  it('임무 없는 데모 · 실기 대기 타일 = 상태 줄 «임무 전 · 대기» · 바닥 꼬리표 «대기 중 · 정면 보기», 충전 · 점검은 그 글(팀장 01:08)', () => {
    const L: Robot[] = EIGHT.map((r) => (r.id === 'k4' ? { ...r, online: true, status: 'IDLE' as const, mission: undefined } : r));
    mount('u-kim', L); feed(L);
    expect(tile('k4').querySelector('.ln span')!.textContent).toBe('임무 전 · 대기');
    expect(tile('k4').querySelector('.cv .ov')!.textContent).toBe('대기 중 · 정면 보기');
    expect(tile('k2').querySelector('.ln span')!.textContent).toBe('공정 순찰 A');
  });
  it('시뮬 임무 전 = 시안 고정 글 «임무 전 · 시뮬 등록» · 배터리 칸 «시뮬 · 배터리 해당 없음»', () => {
    mount('u-kim', EIGHT); feed(EIGHT);
    expect(tile('k8').querySelector('.ln span')!.textContent).toBe('임무 전 · 시뮬 등록');
    expect([fact('k8', 'battery'), small('k8', 'battery')]).toEqual(['시뮬', '배터리 해당 없음']);
  });
  it('데모 = 실기 꼴: 가용 demo = true 인 시뮬 로봇은 시뮬 점선 · 칩 · «배터리 해당 없음» 없이 실기 타일과 같고 «데모» 칩만 더함', async () => {
    const av = vi.spyOn(api, 'availability').mockResolvedValue({ items: [{ robot_id: 'k8', robot_name: 'K-08', state: 'FREE', busy_until: null, busy_slot_id: null, busy_label: null, battery_pct: 70, demo: true, sim: true, location_label: null }] } as never);
    const sc = vi.spyOn(api, 'schedule').mockResolvedValue({ day: '2026-11-28', tz: 'Asia/Seoul', slots: [] } as never);
    try {
      mount('u-kim', EIGHT); feed(EIGHT);
      await act(async () => {});
      const t = tile('k8');
      expect(t.classList.contains('sim')).toBe(false);
      expect(t.querySelector('.chip.sim')).toBeNull();
      expect(t.querySelector('.nm [data-demo]')!.textContent).toBe('데모');
      expect(fact('k8', 'battery')).toBe('70 %');
      expect(t.textContent).not.toContain('시뮬 등록');
    } finally { av.mockRestore(); sc.mockRestore(); }
  });
  it('실기 타일 카메라: 받은 영상(drive-media rgb)이 있으면 그 그림, 없으면 «카메라 신호 없음 · 까닭» · 시뮬 · 데모는 열지 않음', () => {
    mount('u-kim', EIGHT); feed(EIGHT, runs(['k1', 'k8']));
    const sock = (id: string) => FakeWS.all.filter((w) => w.url.endsWith(`/api/v1/robots/${id}/drive-media/rgb`)).pop();
    expect(sock('k8')).toBeUndefined();   // 시뮬은 모형 그대로
    const k1 = sock('k1')!;
    expect(k1).toBeTruthy();
    expect(tile('k1').querySelector('[data-cam="none"]')!.textContent).toContain('카메라 신호 없음');
    act(() => { k1.open(); k1.recv({ t: 'media.status', version: 'media/1', channel: 'rgb', robot: 'k1', epoch: 0, reason: 'No fresh source sample within 1 second' }); });
    expect(tile('k1').querySelector('[data-cam="none"]')!.textContent).toMatch(/^카메라 신호 없음 · ./);   // 까닭이 붙음
    act(() => { k1.recv({ t: 'media.video', version: 'media/1', channel: 'rgb', robot: 'k1', epoch: 1, episode_id: null, seq: 1, mime: 'image/jpeg', jpeg: 'AAAA' }); });
    expect(tile('k1').querySelector<HTMLImageElement>('img[data-cam="live"]')!.getAttribute('src')).toBe('data:image/jpeg;base64,AAAA');
    expect(tile('k1').querySelector('[data-cam="none"]')).toBeNull();
  });
  it('배터리 칸 남은 시간: battery.minutes_left 가 있으면 «약 N 분», null · 없음이면 % 만(지어내지 않음)', () => {
    mount('u-kim', EIGHT); feed(EIGHT, { k1: { battery: { soc: 66, updated_at: '', minutes_left: 47 } } as never, k2: { battery: { soc: 64, updated_at: '', minutes_left: null } } as never });
    expect([fact('k1', 'battery'), small('k1', 'battery')]).toEqual(['66 %', '약 47 분']);
    expect([fact('k2', 'battery'), small('k2', 'battery')]).toEqual(['64 %', '']);
  });
  it('최근 경고 제목은 경고 종류대로: 정지 잠금(관절 온도는 보통)이면 «정지 잠금», 관절 이름 · 온도 아이콘을 붙이지 않음', () => {
    mount('u-kim', EIGHT); feed(EIGHT, { k2: { ...temp([30, 31, 32, 30, 31, 32, 30, 31, 32, 30, 31, 32]), latched: true, status: 'STOP_LATCHED' } as never });
    const al = $('[data-alert="k2"]');
    expect(al).not.toBeNull();
    expect(al.querySelector('div')!.firstChild!.textContent).not.toContain('관절');
    expect(al.textContent).not.toContain('관절');
  });
});

// reviewer 22:04 정지 안 (가) · app-lx 22:06 · reviewer 22:06: 데모는 실기처럼 총괄 정지 대상. 빼는 것은 남이 띄운 사용자 시뮬(demo false 로 확실)이고 임무 중이 아닐 때만.
// demo 모름(undefined) = 정지 쪽. 임무 중 = 관제 걷기(D1)와 같은 판정(state run 이 있으면 그것, 없으면 목록 current_run · PAUSED 도 임무 중).
// 세 자리(경보 칸 「K-0N 정지」 · 로봇 탭 머리줄 정지 · 관제 고르기)와 모두 정지 수를 같이 본다. 운영자는 그대로
describe('총괄 정지 대상: 데모 sim · 사용자 sim · demo 모름 · 임무 중', () => {
  const CR = (status: string) => ({ run_id: 'r1', status, scenario_id: 's', scenario_name: '공정 순찰 A', progress: { done: 2, total: 4 } }) as never;
  const S = (id: string, name: string, demo: boolean | undefined, owner = 'u-park', run?: string): Robot => ({ id, name, owner, ownerName: owner ? '박OO' : undefined, battery: 70, online: true, seenAt: '14:02:00',
    status: 'RUNNING', sim: true, serverDrive: true, ...(demo === undefined ? {} : { demo }), ...(run ? { run: CR(run), mission: '공정 순찰 A 2/4' } : {}) });
  const D = S('d1', 'K-05', true), U = S('u1', 'K-06', false), X = S('x1', 'K-07', undefined);
  const UR = S('ur', 'K-08', false, 'u-park', 'MOVING'), UP = S('up', 'K-09', false, 'u-park', 'PAUSED'), D0 = S('d0', 'K-10', true, '');
  const M = S('m1', 'K-11', false, 'u-kim');   // 내가 띄운 사용자 시뮬 = 임무 없어도 정지
  const LIST = [D, U, X, UR, UP, D0, M];
  /** state 도 목록과 같은 run(임무 판정은 state run 이 먼저) */
  const runState = { ur: RUN('MOVING'), up: RUN('PAUSED') };
  const hot = temp([40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 72]);
  const space = () => act(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true })); });
  const opts = () => [...box.querySelectorAll<HTMLOptionElement>('[aria-label="정지할 로봇 고르기"] option')];
  const allOpt = () => opts().map((o) => o.textContent).find((t) => t!.includes('모두 정지'));
  const pickIds = () => opts().map((o) => o.value).filter((v) => LIST.some((r) => r.id === v)).sort();
  const CAN: [Robot, boolean][] = [[D, true], [X, true], [U, false], [UR, true], [UP, true], [D0, true], [M, true]];
  const close = () => { act(() => root?.unmount()); box.remove(); };

  it('총괄 관제: 데모 · demo 모름 · 임무 중(PAUSED 포함) 사용자 시뮬 · 담당 없는 데모 · 내 사용자 시뮬은 고르기 · 모두 정지 수에, 임무 없는 남의 사용자 시뮬만 빠짐', () => {
    mount('u-kim', LIST, '#/control'); feed(LIST, runState);
    space();
    expect(pickIds()).toEqual(['d0', 'd1', 'm1', 'up', 'ur', 'x1']);
    expect(allOpt()).toBe('모두 정지 (6 대)');
    close();
  });
  it('총괄 관제: 경보 칸 「정지」 와 고른 타일의 머리줄 이름이 같은 판정', () => {
    for (const [r, can] of CAN) {
      mount('u-kim', LIST, '#/control'); feed(LIST, { ...runState, [r.id]: { ...(runState as Record<string, object>)[r.id], ...hot } });
      expect(!!$(`[data-alarm="${r.id}"]`).querySelector('.rstop'), r.name).toBe(can);
      act(() => { tile(r.id).click(); });   // 관제 고르기 = 머리줄 단추가 그 로봇 이름(못 세우면 «모두 정지» 그대로)
      expect($('[data-stop]').textContent!.includes(`${r.name} 정지`), r.name).toBe(can);
      close();
    }
  });
  it('총괄 로봇 탭: 고른 로봇을 세울 수 있으면 머리줄 정지가 그 로봇으로, 임무 없는 남의 사용자 시뮬은 머리줄 정지 없음', () => {
    pcBoard.on = false;
    for (const [r, can] of CAN.filter(([x]) => x.owner)) {   // 담당 없는 시뮬은 로봇 탭 목록(robotu4 · W2)이 따로 빼서 여기서는 보지 않음
      mount('u-kim', LIST, '#/fleet'); feed(LIST, runState);
      act(() => { fleetRow(box, r.name).click(); });
      const b = box.querySelector<HTMLElement>('[data-stop]');
      expect(!!b, r.name).toBe(can);
      if (b) { act(() => { b.click(); }); expect(FakeWS.last.of('stop').map((m) => m.robot), r.name).toEqual([r.id]); }
      close();
    }
  });
  it('운영자는 그대로: 남이 띄운 사용자 시뮬도 정지 고르기에 듦 · 담당 없는 데모 · 임무 중 사용자 시뮬은 끝낸 슬롯(idleSim)이 아님', () => {
    mount('u-lee', LIST, '#/control'); feed(LIST, runState);
    space();
    expect(pickIds()).toEqual(['d0', 'd1', 'm1', 'u1', 'up', 'ur', 'x1']);
    close();
    expect([idleSim({ sim: true, owner: '', demo: true }), idleSim({ sim: true, owner: '', demo: false }), idleSim({ sim: true, owner: '' }),
      idleSim({ sim: true, owner: '', demo: false, run: CR('MOVING') }), idleSim({ sim: true, owner: '', demo: false, run: CR('COMPLETED') }),
      idleSim({ sim: true, owner: '', demo: false, run: CR('MOVING') }, { run: null })]).toEqual([false, true, true, false, true, true]);
  });
});
