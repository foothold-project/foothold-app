// 임무 탭(W2 · U6-01 · U6-03 · U6-05): 탭 열림 · 옛 주소 → 임무 탭에서 그 임무 고름 · 계약 없는 칸은 «준비 중»(숫자 없음) · 금지 구역 겹침 · 미리 확인 · 편집(목록 ↔ 노드) · 편집 중 떠날 때 확인
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MapVersion, Mission, Scenario } from '../../../contracts/ts';
import { App } from '../App';
import { leaving, oldScenario, tabFromHash } from '../menu';
import { clearPlans } from '../screens/missions';
import { WAIT, keptMission } from '../screens/missiontab';
import { USERS, type Robot } from './fixtures';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 지도 100×80 칸, 0.05 m, origin (-1, -2) → x -1~4 m, y -2~2 m. 접근 금지 x 2~3
const V1: MapVersion = { upload_id: 'up-v1', id: 'v1', floor_id: 'f1', number: 1, base_version_id: null, copied_from_id: null, status: 'APPROVED', image_sha256: 'ab'.repeat(32),
  width: 100, height: 80, resolution: 0.05, origin: [-1, -2, 0], reason: '처음', source: 'IMPORT', created_by: 'u-kim', created_at: '2026-11-28T00:00:00Z',
  features: { zones: [{ id: 'z1', type: 'NO_GO', name: '탱크', polygon: [[2, -2], [3, -2], [3, 2], [2, 2]] }], waypoints: [], connectors: [], edits: [] } } as MapVersion;
const head = { number: 1, latest_version: 1, version: 1, created_by: 'u-kim', created_at: '2026-11-28T00:00:00Z', version_created_by: 'u-kim', version_created_at: '2026-11-28T00:00:00Z', archived_at: null };
const M1: Mission = { ...head, id: 'm1', name: '게이지 읽기', steps: [{ action: 'PHOTO', params: { camera: 'rgb' } }], required_devices: ['CAMERA_RGB'] };
const wp = (x: number, y: number, name?: string) => ({ floor_id: 'f1', map_version_id: 'v1', x, y, mission_id: 'm1', mission_version: 1, name: name ?? null });
const scen = (id: string, name: string, waypoints: ReturnType<typeof wp>[], extra: Partial<Scenario> = {}): Scenario => ({ ...head, id, name, waypoints, finish: { mode: 'RETURN_TO_START', target: null }, notes: '',
  floor_ids: ['f1'], map_version_ids: ['v1'], required_devices: [], est_distance_m: 1280, ...extra });
// s1 = 1→2 구간이 금지 구역(x 2~3)을 지남, s2 = 금지 구역 밖, s3 = 휴지통(목록 밖 · 옛 주소로만)
const S1 = scen('s1', '공정 순찰 A', [wp(0, 0, '펌프'), wp(3.5, 0, '게이지')]);
const S2 = scen('s2', '가스 점검', [wp(0, 1), wp(1, 1)], { finish: { mode: 'STAY', target: null }, est_distance_m: 30 });
const S3 = scen('s3', '지난 임무', [wp(0, 0)], { archived_at: '2026-11-27T00:00:00Z' });
const ALL = [S1, S2, S3];

let calls: { method: string; path: string }[] = [];
function serve() {
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET', path = url.replace(/^\/api\/v1/, '').split('?')[0];
    calls.push({ method, path });
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (path === '/sites') return ok({ items: [{ id: 'st', name: '공장', purpose: 'REAL', buildings: [{ id: 'b1', site_id: 'st', name: '본동', floors: [{ id: 'f1', building_id: 'b1', name: '1층', level: 1, approved_version_id: 'v1', pending_count: 0 }] }] }], next_cursor: null });
    if (path === '/map-versions/v1') return ok(V1);
    if (path === '/map-versions/v1/zone-grid') {
      const cells = [];
      for (let r = 0; r < 80; r++) for (let c = 0; c < 100; c++) { const x = -1 + (c + 0.5) * 0.05; if (x >= 2 && x <= 3) cells.push({ index: r * 100 + c, no_go: true, slow: false, max_speed_mps: null }); }
      return ok({ format_version: 1, map_version_id: 'v1', origin: V1.origin, resolution: 0.05, width: 100, height: 80, row_order: 'TOP_TO_BOTTOM', cursor: 0, cells, next_cursor: null });
    }
    if (path === '/scenarios') return ok({ items: ALL, next_cursor: null });
    if (path === '/missions') return ok({ items: [M1], next_cursor: null });
    const m = path.match(/^\/scenarios\/(s\d)$/);
    if (m) { const x = ALL.find((s) => s.id === m[1]); return x ? ok(x) : new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: '없음', detail: {} } }), { status: 404 }); }
    if (method === 'POST' && path === '/scenarios/preview') return ok({ reachable: true, points: [], segments: [], floor_ids: ['f1'], map_version_ids: ['v1'], required_devices: [], est_distance_m: 3, distance_note: '' });
    if (path === '/actions') return ok([]);
    return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: '없음', detail: {} } }), { status: 404 });
  });
}

const ROBOTS: Robot[] = [
  { id: 'r1', name: 'K-01', owner: 'u-lee', ownerName: '이OO', battery: 86, online: true, seenAt: '14:00:00', status: 'IDLE' },
  { id: 'r2', name: '시뮬 Go2', owner: 'u-lee', ownerName: '이OO', battery: null, online: true, seenAt: '14:00:00', status: 'IDLE', sim: true },
];
let root: Root | null = null, box: HTMLDivElement;
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); });
async function mount(hash: string) {
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  serve();
  location.hash = hash;
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<App user={USERS.find((u) => u.id === 'u-kim')} robots={ROBOTS} />); });
  await flush(); await flush();
}
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); clearPlans(); keptMission.sel = ''; leaving.ask = null; vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });
const $ = <T extends Element = HTMLElement>(s: string) => box.querySelector<T>(s);
const $$ = (s: string) => [...box.querySelectorAll<HTMLElement>(s)];
const picked = () => $$('[data-mission][aria-pressed="true"]').map((b) => b.dataset.mission);
const click = async (e: Element | null) => { expect(e).toBeTruthy(); act(() => (e as HTMLElement).click()); await flush(); };

describe('임무 탭(W2)', () => {
  it('주소 · 메뉴: #/missions 와 옛 #/mission 은 임무 탭, oldScenario 는 고를 id', () => {
    expect(tabFromHash('#/missions', false)).toBe('missions');
    expect(tabFromHash('#/mission', false)).toBe('missions');
    expect(tabFromHash('#/mission/s2', false)).toBe('missions');
    expect(oldScenario('#/mission/s2')).toBe('s2');
    expect(oldScenario('#/mission?scenario_id=s2')).toBe('s2');
    expect(oldScenario('#/map')).toBeNull();
  });

  it('탭 열림: 세 칸(목록 · 지도 · 일정 칸) + 오늘 일정, 첫 임무를 펼쳐 할 일 번호와 끝 동작', async () => {
    await mount('#/missions');
    expect($('h1')!.textContent).toBe('임무');
    expect($('nav a[aria-current="page"]')!.getAttribute('href')).toBe('#/missions');
    expect($('[aria-label="임무 목록"]')).toBeTruthy(); expect($('[aria-label="임무 지도"]')).toBeTruthy();
    expect($('[aria-label="일정에 추가"]')).toBeTruthy(); expect($('[aria-label="오늘 일정"]')).toBeTruthy();
    expect($$('[data-mission]').map((b) => b.dataset.mission)).toEqual(['s1', 's2']);   // 휴지통 것은 목록 밖
    expect(picked()).toEqual(['s1']);
    expect($$('[data-step-no]').map((l) => l.textContent)).toEqual(['1게이지 읽기펌프', '2게이지 읽기게이지']);
    expect($('[data-finish-mode]')!.textContent).toBe('시작 지점으로 복귀');
    // 임무 이름은 왼쪽 목록과 오른쪽 칸 제목 두 곳만
    expect($('[data-side-name]')!.textContent).toBe('공정 순찰 A');
    expect(box.textContent!.split('공정 순찰 A').length - 1).toBe(2);
    // 로봇 목록 · 배터리 · 실기/시뮬 = 지금 자료
    const rb = $$('[data-robot]');
    expect(rb.map((b) => b.dataset.robot)).toEqual(['r1', 'r2']);
    expect(rb[0].textContent).toContain('실기'); expect(rb[0].textContent).toContain('86%');
    expect(rb[1].textContent).toContain('시뮬');
    await click($('[data-mission="s2"]'));
    expect(picked()).toEqual(['s2']); expect($('[data-side-name]')!.textContent).toBe('가스 점검');
  });

  it.each(['#/mission/s2', '#/mission?scenario_id=s2', '#/missions/s2'])('옛 주소 %s → 임무 탭에서 그 임무를 고름', async (h) => {
    await mount(h);
    expect($('h1')!.textContent).toBe('임무');
    expect(location.hash).toBe('#/missions');
    expect(picked()).toEqual(['s2']);
  });

  it('옛 주소가 휴지통 임무를 가리키면 목록 맨 위에 «휴지통»으로 따로 보이고, 없는 id 면 한 줄 알림', async () => {
    await mount('#/mission/s3');
    expect(picked()).toEqual(['s3']);
    expect($('[data-mission="s3"] [data-trash]')).toBeTruthy();
    act(() => root?.unmount()); root = null; box.remove();
    await mount('#/mission/s404');
    expect($('[data-lost]')!.textContent).toContain('찾을 수 없습니다');
  });

  it('탭이 열린 채 옛 주소로 바뀌어도 그 임무를 고른다(hashchange)', async () => {
    await mount('#/missions');
    expect(picked()).toEqual(['s1']);
    act(() => { location.hash = '#/mission/s2'; window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL: 'http://x/#/missions', newURL: 'http://x/#/mission/s2' })); });
    await flush(); await flush();
    expect(picked()).toEqual(['s2']);
  });

  it('계약 없는 칸(일정 · 가용 · 예상 · 걷기+할 일)은 숫자를 지어내지 않고 «준비 중», 단추는 회색 + 까닭', async () => {
    await mount('#/missions');
    for (const e of $$('[data-wait]')) expect(e.textContent).toBe('—');
    expect($$('[data-wait]').length).toBe(5);   // 시작 · 마감 · 예상 끝 · 여유 · 종료 시 배터리
    for (const e of $$('[data-wait-line]')) { expect(e.textContent).toContain(WAIT); expect(e.textContent).not.toMatch(/\d/); }
    expect($('[data-walk-task]')!.textContent).toBe(WAIT);
    for (const e of $$('[data-dur]')) expect(e.textContent).toBe('—');
    expect($<HTMLButtonElement>('[data-rehearse]')!.disabled).toBe(true);
    expect($<HTMLButtonElement>('[data-schedule-add]')!.disabled).toBe(true);
    expect($('#mt-why')!.textContent).toContain('준비되면');
    // 오늘 일정: 로봇 줄 + 지금 선만, 막대 없음
    expect($$('[data-day-robot]').map((e) => e.dataset.dayRobot)).toEqual(['r1', 'r2']);
    expect($('[aria-label="오늘 일정"] [data-slot]')).toBeNull();
    // 걷기 모드 넷은 고르기만 · 아무 요청도 나가지 않는다
    const n = calls.length;
    await click($('[data-mode="START"]'));
    expect($('[data-mode="START"]')!.getAttribute('aria-pressed')).toBe('true');
    expect($$('[data-mode]').map((b) => b.dataset.mode)).toEqual(['Classic', 'Sport', 'START', 'AME-2']);
    expect(calls.slice(n)).toEqual([]);
    expect(calls.filter((c) => c.method !== 'GET' && c.path !== '/scenarios/preview')).toEqual([]);
  });

  it('지도: 경로 · 지점 번호 · 금지 구역 겹침(같은 구역 칸 판정) · 길이 · 미리 확인 한 줄, 지도 위 글자 둘까지', async () => {
    await mount('#/missions');
    expect($$('[data-pt]').map((g) => g.dataset.pt)).toEqual(['1', '2']);
    expect($('[data-seg="0"]')!.dataset.hit).toBe('true');
    expect($('[data-pt="2"]')!.dataset.hit).toBeUndefined();   // 3.5 m 지점 자체는 구역 밖, 가는 길만 겹침
    expect($('[data-overlap]')!.textContent).toContain('접근 금지 구역과 겹침');
    expect($$('.mt-tags > *').length).toBeLessThanOrEqual(2);
    expect($('[data-length]')!.textContent).toBe('1.28km');
    expect($('[data-check]')!.textContent).toBe('✓ 모두 갈 수 있음');
    await click($('[data-mission="s2"]'));
    expect($('[data-overlap]')).toBeNull();
    expect($$('[data-seg][data-hit]')).toEqual([]);
    expect($('[data-length]')!.textContent).toBe('30m');
  });

  it('짜기: «편집» = 그 임무를 탭 안 편집 칸(이름 · 목록 ↔ 노드)으로, «‹ 임무 목록»으로 돌아옴 · «새 임무» = 빈 편집 칸', async () => {
    await mount('#/missions');
    await click($('[data-edit-mission]'));
    expect($('h1')!.textContent).toBe('임무');
    expect($('[aria-label="임무 편집"]')).toBeTruthy();
    expect($<HTMLInputElement>('[data-name]')!.value).toBe('공정 순찰 A');
    await click($('[data-back-list]'));
    expect(picked()).toEqual(['s1']);
    await click($('[data-new-mission]'));
    expect($<HTMLInputElement>('[data-name]')!.value).toBe('');
  });

  it('편집 중 탭 떠날 때 확인창 그대로: 저장 안 한 지도 편집이 있으면 임무 탭 · 옛 주소로 가기 전에 묻는다', async () => {
    await mount('#/map');
    const ask = vi.fn();
    leaving.ask = ask;
    for (const h of ['#/missions', '#/mission/s2']) {
      act(() => { location.hash = h; window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL: 'http://x/#/map', newURL: `http://x/${h}` })); });
      await flush();
      expect(location.hash).toBe('#/map');
    }
    expect(ask).toHaveBeenCalledTimes(2);
    expect($('h1')!.textContent).toBe('지도');
  });
});
