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
async function mount(uid: string, robots = ROBOTS, hash = '#/fleet') {
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;   // PC 틀
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ items: [], next_cursor: null }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  location.hash = hash;
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<App user={USERS.find((u) => u.id === uid)} robots={robots} />); });
  await flush();
}
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); vi.unstubAllGlobals(); sim.clear(); });
const href = (id: string) => `/sim/index.html?from=web&policy=go2-demo&robot=${encodeURIComponent(id)}`;
const SIM = { ...ROBOTS[0], id: 'sim-1', name: '시뮬-1', sim: true };

describe('실기 보기 열기(로봇 탭 실기 상세)', () => {
  it('운영자 집중 화면: 고른 실기의 실기 보기 단추, 시뮬 탭에는 Go2 실기 보기 없음', async () => {
    await mount('u-lee', [...ROBOTS, { ...SIM, owner: 'u-lee' }]);
    const real = ROBOTS.find((r) => r.owner === 'u-lee' && !r.sim)!;
    expect(box.querySelector('[aria-label="로봇 상태"] h2')!.textContent).toBe(real.name);
    expect(box.querySelector('[data-go2-open]')!.getAttribute('href')).toBe(href(real.id));
    expect(box.querySelector('[data-go2-open]')!.textContent).toBe('실기 보기 열기');
    act(() => { location.hash = '#/sim'; }); await flush();
    expect(box.querySelector('[data-go2-replay], [data-go2-open]')).toBeNull();
    expect(box.textContent).not.toContain('Go2 실기 보기');
  });
  it('총괄 서랍: 실기 행을 열면 실기 보기 단추(서랍을 닫으면 없음)', async () => {
    await mount('u-kim');
    expect(box.querySelector('[data-go2-open]')).toBeNull();
    const real = ROBOTS.find((r) => !r.sim)!;
    act(() => { fleetRow(box, real.name).click(); }); await flush();
    expect(box.querySelector('[aria-label="로봇 상세"]')!.closest('.fl-side')!.querySelector('[data-go2-open]')!.getAttribute('href')).toBe(href(real.id));
  });
  it('폰 앱(FootholdApp UA) 안에서는 없음', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 FootholdApp/1');
    await mount('u-lee');
    expect(box.querySelector('[data-go2-open]')).toBeNull();
    vi.restoreAllMocks();
  });
});
