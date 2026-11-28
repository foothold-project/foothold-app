// 폰 지도 스캔 본체(u14_2): 입구는 아직 없다(폰 조종 화면 PR 들 뒤). 이 시험에서만 그린다. 가짜 서버(fetch 가짜)로만 · 8810 · 실기 없음.
// 진행은 서버 MappingProgress 그대로(스캔 시간 elapsed_s · 걸은 거리 distance_m · 모은 점 point_count), 이상한 값은 칸째 뺀다.
// 시작 · 끝내기 · 취소 = api.slamDo start · save · cancel(시작은 고른 층 + source=point_lio). 서버에 멈춤(pause) 길이 없어 멈춤 단추 없음.
// 위치 인식은 서버 location.confidence 수 그대로(좋음 · 나쁨 같은 말 기준이 아직 없음). 담당 운영자만(서버도 403 MAPPING_OWNER_ONLY).
import { act } from 'react';
import { createRoot, type Root as ReactRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MapBuilding, MapFloor, MapSite, MappingProgress } from '../../../contracts/ts';
import type { Robot, User } from '../fake';
import { PhoneScan } from '../screens/phonescan';
import type { Place } from '../screens/maps';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LEE = { id: 'o1', name: '이운영', role: 'OPERATOR' } as unknown as User;
const KIM = { id: 'a1', name: '김총괄', role: 'ORG_ADMIN' } as unknown as User;
const K01 = (p: Partial<Robot> = {}): Robot => ({ id: 'r-a', name: 'K-01', owner: 'o1', battery: 71, online: true, seenAt: '', status: 'IDLE',
  location: { floor_id: 'f1', map_version_id: null, x: 1, y: 2, yaw: 0, confidence: 0.82, updated_at: '2026-11-28T01:00:00Z' }, ...p } as Robot);
const site = { id: 's1', name: '인공지능사관학교', purpose: 'REAL' } as unknown as MapSite, b = { id: 'b1', site_id: 's1', name: '본관' } as unknown as MapBuilding;
const PLACES: Place[] = [{ site, building: b, floor: { id: 'f1', building_id: 'b1', name: '1층' } as MapFloor }, { site, building: b, floor: { id: 'f2', building_id: 'b1', name: '2층' } as MapFloor }];
const SID = '11111111-1111-4111-8111-111111111111';
const prog = (status: MappingProgress['status'], p: Partial<MappingProgress> = {}): MappingProgress => ({ session_id: SID, floor_id: 'f2', status, revision: 1, update_seq: 1, ...p } as MappingProgress);
const tile = { revision: 1, tile_seq: 1, x: 0, y: 0, frame_id: 'map', floor_z: 0, resolution: 0.05, size: 64, cells: Array.from({ length: 4096 }, (_, i) => (i % 9 === 0 ? 2 : 1)) };

type Call = { method: string; path: string; body?: unknown };
let calls: Call[] = [], slam: () => MappingProgress | null = () => null, reply: Record<string, () => { status: number; body: unknown }> = {};
function serve() {
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET', path = url.replace(/^\/api\/v1/, '').split('?')[0], body = init.body ? JSON.parse(String(init.body)) : undefined;
    if (!url.startsWith('/api/v1/')) throw new Error(`밖으로 나가는 요청: ${url}`);   // 8810 · 실기 주소로 나가지 않음
    calls.push({ method, path, body });
    const r = path === '/robots/r-a/slam' ? { status: 200, body: slam() }
      : path === `/robots/r-a/slam/${SID}/tiles` ? { status: 200, body: { session_id: SID, revision: 1, update_seq: 1, tiles: [tile], next_cursor: null } }
      : reply[`${method} ${path}`]?.() ?? { status: 404, body: { error: { code: 'NOT_FOUND', message: '없음', detail: {} } } };
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
  });
}
let root: ReactRoot | null = null, box: HTMLDivElement;
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); });
async function open(user = LEE, r = K01()) {
  serve();
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<PhoneScan user={user} robot={r} places={PLACES} />); });
  await flush();
}
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); vi.unstubAllGlobals(); slam = () => null; reply = {}; });
const $ = <T extends Element = HTMLElement>(s: string) => box.querySelector<T>(s);
const btn = (t: string) => [...box.querySelectorAll('button')].find((x) => x.textContent?.trim() === t) ?? null;
const click = async (el: HTMLElement | null) => { act(() => { el!.click(); }); await flush(); };
const slamDo = () => calls.filter((c) => c.method === 'POST');

describe('폰 지도 스캔 (u14_2 본체)', () => {
  it('담당이 아니면 안내만 · 요청 없음', async () => {
    await open(KIM);
    expect($('[data-scan]')!.textContent).toContain('지도 스캔은 로봇의 담당 운영자만 할 수 있습니다.');
    expect(calls).toEqual([]);
    expect(btn('스캔 시작')).toBeNull();
  });

  it('시작 전: 층 고르기 · 고른 층 + point_lio 로 시작 · 연결 안 되면 시작 막힘', async () => {
    await open();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /robots/r-a/slam']);
    const sel = $<HTMLSelectElement>('select[data-scan-floor]')!;
    expect([...sel.options].map((o) => o.textContent)).toEqual(['인공지능사관학교 본관 1층', '인공지능사관학교 본관 2층']);
    expect(sel.value).toBe('f1');   // 로봇이 지금 있는 층부터
    act(() => { sel.value = 'f2'; sel.dispatchEvent(new Event('change', { bubbles: true })); });
    reply['POST /robots/r-a/slam/start'] = () => ({ status: 202, body: prog('STARTING') });
    await click(btn('스캔 시작'));
    expect(slamDo()).toEqual([{ method: 'POST', path: '/robots/r-a/slam/start', body: { floor_id: 'f2', source: 'point_lio' } }]);
    act(() => root?.unmount()); root = null; box.remove();
    await open(LEE, K01({ online: false }));
    expect(btn('스캔 시작')!.disabled).toBe(true);
    expect($('[data-scan]')!.textContent).toContain('로봇이 연결되어 있지 않습니다.');
  });

  it('층 고르기는 로봇이 지금 있는 층부터(목록 첫 층이 아니어도)', async () => {
    await open(LEE, K01({ location: { ...K01().location!, floor_id: 'f2' } }));
    expect($<HTMLSelectElement>('select[data-scan-floor]')!.value).toBe('f2');
  });

  it('스캔 중: 시간 · 거리 · 점 수는 서버 값 그대로 · 작은 지도 · 위치 인식 수 · 멈춤 단추 없음', async () => {
    slam = () => prog('RUNNING', { elapsed_s: 252, distance_m: 86.4, point_count: 12_400_000 });
    await open();
    expect($('[data-walk="time"]')!.textContent).toBe('04:12스캔 시간');
    expect($('[data-walk="dist"]')!.textContent).toBe('86 m걸은 거리');
    expect($('[data-walk="points"]')!.textContent).toBe('1,240 만모은 점');
    expect($('[data-scan-floor-name]')!.textContent).toBe('인공지능사관학교 본관 2층');   // 진행 중인 세션의 층
    expect($('[data-slam-view]')).not.toBeNull();
    expect($('[data-scan-conf]')!.textContent).toBe('위치 인식 0.82');
    expect([...box.querySelectorAll('button')].some((x) => /멈춤|일시정지/.test(x.textContent ?? ''))).toBe(false);
    expect($('select[data-scan-floor]')).toBeNull();
    // 시안 u14_2 꼴: 왼쪽 위 로봇 칩 · 작은 지도 .sm · 아래 진행 줄 .sp · 스캔 끝내기 .p2, 옛 칸(lv-card · fh-msg · mx-sum · .btn 단추) 없음
    expect($('[data-scan]')!.className).toBe('proto pv u142');
    expect($('.tl .chipnum')!.textContent).toBe('K-01');
    expect($('.tl .bat')!.textContent).toBe('71 %');
    expect($('.sm [data-slam-view]')).not.toBeNull();
    expect([...box.querySelectorAll('.sp .k')].map((x) => x.textContent)).toEqual(['04:12스캔 시간', '86 m걸은 거리', '1,240 만모은 점']);
    expect($('.sp .bb button.p2')!.textContent).toBe('스캔 끝내기');
    expect(box.querySelector('.lv-card, .fh-msg, .mx-sum, button.btn:not(.g)')).toBeNull();
  });

  it('이상한 진행 값(음수 · 수 아님)은 칸째 빼고 · 위치 인식 값이 없으면 줄째 뺀다', async () => {
    slam = () => prog('RUNNING', { elapsed_s: -1, distance_m: Number.NaN as unknown as number, point_count: 5 });
    await open(LEE, K01({ location: null }));
    expect($('[data-walk="time"]')).toBeNull();
    expect($('[data-walk="dist"]')).toBeNull();
    expect($('[data-walk="points"]')!.textContent).toBe('5모은 점');
    expect($('[data-scan-conf]')).toBeNull();
  });

  it('스캔 끝내기 = save · 취소는 한 번 더 묻고 cancel (세션 id 그대로)', async () => {
    slam = () => prog('RUNNING', { elapsed_s: 10 });
    await open();
    reply['POST /robots/r-a/slam/save'] = () => ({ status: 202, body: prog('SAVING') });
    await click(btn('스캔 끝내기'));
    expect(slamDo()[slamDo().length - 1]).toEqual({ method: 'POST', path: '/robots/r-a/slam/save', body: { session_id: SID } });
    act(() => root?.unmount()); root = null; box.remove();
    await open();
    await click(btn('취소'));
    expect(slamDo()).toEqual([]);
    expect($('[data-scan-ask]')!.textContent).toContain('지금까지 모은 것을 버리고 스캔을 취소할까요?');
    reply['POST /robots/r-a/slam/cancel'] = () => ({ status: 200, body: prog('CANCELLED') });
    await click(btn('취소하기'));
    expect(slamDo()).toEqual([{ method: 'POST', path: '/robots/r-a/slam/cancel', body: { session_id: SID } }]);
  });

  it('저장 중 · 실패 · 저장됨 · 요청 실패는 글로', async () => {
    slam = () => prog('SAVING');
    await open();
    expect($('[data-scan-state]')!.textContent).toBe('지도를 저장하는 중… 마무리까지 시간이 걸릴 수 있습니다.');
    expect(btn('스캔 끝내기')).toBeNull();
    act(() => root?.unmount()); root = null; box.remove();
    slam = () => prog('FAILED', { reason: '라이다 자료가 끊겼습니다.' });
    await open();
    expect($('[data-scan-state]')!.textContent).toBe('라이다 자료가 끊겼습니다.');
    act(() => root?.unmount()); root = null; box.remove();
    slam = () => prog('SAVED', { map_version_id: 'v9' });
    await open();
    expect($('[data-scan-state]')!.textContent).toBe('스캔한 지도를 저장했습니다. PC 지도 탭에서 확인하세요.');
    expect(btn('스캔 시작')).not.toBeNull();   // 끝난 세션 뒤엔 다시 시작할 수 있음
    act(() => root?.unmount()); root = null; box.remove();
    slam = () => null;
    await open();
    reply['POST /robots/r-a/slam/start'] = () => ({ status: 409, body: { error: { code: 'ROBOT_OFFLINE', message: '로봇 연결 없음', detail: {} } } });
    await click(btn('스캔 시작'));
    expect($('[data-scan]')!.textContent).toContain('로봇이 연결되어 있지 않습니다.');
  });
});
