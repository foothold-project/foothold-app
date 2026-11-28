// TAB-SPLIT(11-10): «실기 보기 열기»는 로봇 탭 실기 상세 안(운영자 집중 화면·총괄 서랍) — 옛 시뮬 탭 «Go2 실기 보기»와 같은 주소·같은 조건(폰 앱 밖·실기만)
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { ROBOTS, USERS } from './fixtures';
import { fleetRow } from './fleetRow';
import { sim } from '../phone';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null, box: HTMLDivElement;
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); });
async function mount(uid: string, robots = ROBOTS, hash = '#/fleet', fetcher: (u: string) => Promise<Response> = async () => new Response(JSON.stringify({ items: [], next_cursor: null }), { status: 200, headers: { 'Content-Type': 'application/json' } })) {
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;   // PC 틀
  vi.stubGlobal('fetch', fetcher);
  location.hash = hash;
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<App user={USERS.find((u) => u.id === uid)} robots={robots} />); });
  await flush();
}
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); vi.unstubAllGlobals(); sim.clear(); });
const href = (id: string) => `/sim/index.html?from=web&policy=go2-demo&robot=${encodeURIComponent(id)}`;
const SIM = { ...ROBOTS[0], id: 'sim-1', name: '시뮬-1', sim: true };
/** PC 로봇 탭(시안 u4) «점검» 창 = 조종 준비 · 실기 보기 */
const check = async () => { act(() => { box.querySelector<HTMLElement>('.u4 .seg2 [data-seg="점검"]')!.click(); }); await flush(); };

describe('실기 보기 열기(로봇 탭 실기 상세)', () => {
  it('운영자 집중 화면: 고른 실기의 실기 보기 단추, 시뮬 탭에는 Go2 실기 보기 없음', async () => {
    await mount('u-lee', [...ROBOTS, { ...SIM, owner: 'u-lee' }]);
    const real = ROBOTS.find((r) => r.owner === 'u-lee' && !r.sim)!;
    expect(box.querySelector('[data-robot-head] .ttl')!.textContent).toBe(real.name);
    expect(box.querySelector('[data-go2-open]')).toBeNull(); await check();
    expect(box.querySelector('[data-go2-open]')!.getAttribute('href')).toBe(href(real.id));
    expect(box.querySelector('[data-go2-open]')!.textContent).toBe('실기 보기 열기');
    const note = box.querySelector('[data-go2-note]')!.textContent!;   // 운영 화면에 개발자 용어 없음(03-UX-SPEC)
    expect(note).toContain('지도와 맞지 않을 수 있습니다');
    expect(note).not.toMatch(/원점|기동|미확인|전용/);
    act(() => { location.hash = '#/sim'; }); await flush();
    expect(box.querySelector('[data-go2-replay], [data-go2-open]')).toBeNull();
    expect(box.textContent).not.toContain('Go2 실기 보기');
  });
  it('총괄: 실기 줄을 고르고 «점검» 창을 열면 실기 보기 단추(창을 닫으면 없음)', async () => {
    await mount('u-kim');
    expect(box.querySelector('[data-go2-open]')).toBeNull();
    const real = ROBOTS.find((r) => !r.sim)!;
    act(() => { fleetRow(box, real.name).click(); }); await flush();
    await check();
    expect(box.querySelector('[aria-label="점검"] [data-go2-open]')!.getAttribute('href')).toBe(href(real.id));
    act(() => { box.querySelector<HTMLElement>('[data-u4-close]')!.click(); }); await flush();
    expect(box.querySelector('[data-go2-open]')).toBeNull();
  });
  it('지도 고르기: 로봇이 있는 층이 기본, 3D 지도 판은 그 시뮬 지형으로 열고(누르는 순간 지형 사본), 지형 없는 판은 꺼짐 + 이유, «지도 없이»는 기본 지형', async () => {
    const TREE = { items: [{ id: 's1', name: '본관', purpose: 'REAL', buildings: [{ id: 'b1', site_id: 's1', name: '본동', floors: [
      { id: 'f1', name: '1층', level: 1, approved_version_id: 'v1' }, { id: 'f2', name: '2층', level: 2, approved_version_id: 'v2' }, { id: 'f3', name: '3층', level: 3, approved_version_id: null }] }] }], next_cursor: null };
    const ver = (id: string, extra: object) => ({ upload_id: `up-${id}`, id, floor_id: 'f1', number: 1, base_version_id: null, copied_from_id: null, status: 'APPROVED', image_sha256: 'cd'.repeat(32),
      width: 50, height: 40, resolution: 0.1, origin: [-2.5, -2, 0], features: { zones: [], waypoints: [], connectors: [], edits: [] }, reason: '처음', source: 'IMPORT', created_by: 'u-kim', created_at: '2026-11-11T00:00:00Z', ...extra });
    const VOX = { map_version_id: 'v1', terrain_id: 'hill', voxel_size: 0.1, point_count: 9, voxel_count: 9, origin: [-2.5, -2, 0], source_translation: [0, 0, 0], estimated_floor_z: 0, source_sha256: 'a', cells_sha256: 'b', warnings: [] };
    const HILL = { schema: 'fh_custom_terrain/1', id: 'hill', name: '언덕', size: [5, 4], spawn: [0, 0, 0], items: [] };
    const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    const real = { ...ROBOTS.find((r) => r.owner === 'u-lee' && !r.sim)!, location: { floor_id: 'f1', map_version_id: 'v1', x: 0, y: 0, yaw: 0 } } as unknown as typeof ROBOTS[number];
    const fetcher = async (u: string) => {
      const path = String(u).replace(/^.*\/api\/v1/, '').split('?')[0];
      if (path === '/sites') return ok(TREE);
      if (path === '/map-versions/v1') return ok(ver('v1', { voxel_map: VOX }));
      if (path === '/map-versions/v2') return ok(ver('v2', { floor_id: 'f2' }));
      if (path === '/terrains/hill') return ok({ spec: HILL, version: 3, floor_id: 'sim-f', map_version_id: 'sim-v', archived_at: null, updated_at: '2026-11-11T00:00:00Z' });
      if (path === '/map-versions/v1/simulation-twin') return ok({ error: { code: 'NOT_FOUND', message: '없음' } }, 404);
      return ok({ items: [], next_cursor: null });
    };
    await mount('u-lee', ROBOTS.map((r) => (r.id === real.id ? real : r)), '#/fleet', fetcher); await flush(); await check();
    const pickEl = () => box.querySelector('[data-go2-map]') as HTMLSelectElement, open = () => box.querySelector('[data-go2-open]') as HTMLAnchorElement;
    expect(Array.from(pickEl().options).map((o) => o.textContent)).toEqual(['지도 없이(기본 지형)', '본관 · 본동 1층', '본관 · 본동 2층']);   // 판 없는 3층은 없음
    expect(pickEl().value).toBe('f1');
    expect(open().getAttribute('href')).toBe(`/sim/index.html?from=web&map=custom&terrain=hill&policy=go2-demo&robot=${encodeURIComponent(real.id)}&mapName=${encodeURIComponent('본관 · 본동 1층')}`);
    localStorage.removeItem('fh.customTerrain.hill');
    const stop = (e: Event) => e.preventDefault(); document.addEventListener('click', stop);   // jsdom 페이지 이동 막기(React 처리 뒤)
    act(() => { open().click(); });
    document.removeEventListener('click', stop);
    expect(JSON.parse(localStorage.getItem('fh.customTerrain.hill')!)).toEqual(HILL);
    act(() => { pickEl().value = 'f2'; pickEl().dispatchEvent(new Event('change', { bubbles: true })); }); await flush();
    expect(open().hasAttribute('href')).toBe(false);
    expect(open().getAttribute('aria-disabled')).toBe('true');
    expect(box.querySelector('[data-go2-why]')!.textContent).toContain('시뮬 세계·지형과 이어져 있지 않아');
    act(() => { pickEl().value = ''; pickEl().dispatchEvent(new Event('change', { bubbles: true })); }); await flush();
    expect(open().getAttribute('href')).toBe(href(real.id));
    expect(box.querySelector('[data-go2-why]')).toBeNull();
    localStorage.removeItem('fh.customTerrain.hill'); localStorage.removeItem('fh.customTerrain.hill:base');
  });
  it('폰 앱(FootholdApp UA) 안에서는 없음', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 FootholdApp/1');
    await mount('u-lee');
    expect(box.querySelector('[data-go2-open]')).toBeNull();
    vi.restoreAllMocks();
  });
});
