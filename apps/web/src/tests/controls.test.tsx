// 설정 › 조작의 「키보드」 · 「모바일 (폰 터치)」 설명 칸(u9_7 · U9-05). 읽기 전용: 스위치 · 입력 칸 없이 지금 배치만, 바꾸지 못하는 까닭 한 줄.
// 적힌 키 · 스틱 자리가 실제 조종 코드(simdrive KEYS · drive.css 스틱 자리)와 어긋나면 실패한다.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import driveCss from '../drive.css?raw';
import type { User } from '../fake';
import { KEYS } from '../simdrive';
import { KEY_GUIDE, NO_SAVE } from '../screens/controls';
import { Settings } from '../screens/settings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LEE = { id: 'o1', username: 'lee', display_name: '이운영', role: 'OPERATOR', locked: false, robot_ids: [], created_at: '2026-10-19T00:00:00Z' } as unknown as User;
let root: Root | null = null, box: HTMLDivElement | null = null;
afterEach(() => { act(() => root?.unmount()); box?.remove(); root = null; box = null; vi.unstubAllGlobals(); });

async function open() {
  vi.stubGlobal('fetch', async (url: string) => new Response(JSON.stringify(String(url).includes('/org/settings')
    ? { battery_low_pct: 20, run_min_battery_pct: 30, deviation_m: 1.5, lease_request_timeout_s: 10, link_loss_wait_s: 30 }
    : { error: { code: 'NOT_FOUND', message: '없음', detail: {} } }), { status: String(url).includes('/org/settings') ? 200 : 404, headers: { 'Content-Type': 'application/json' } }));
  box = document.createElement('div'); document.body.append(box);
  await act(async () => { root = createRoot(box!); root.render(<Settings user={LEE} setMe={() => {}} refresh={() => {}} />); });
  const tab = [...box.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent?.trim() === '조작')!;
  await act(async () => { tab.click(); });
  return box.querySelector<HTMLElement>('#st-p-ctl')!;
}

describe('설정 › 조작 설명 칸 (u9_7)', () => {
  it('키보드 · 모바일 (폰 터치) 칸이 보이고, 스위치 · 입력 칸 없이 까닭 한 줄', async () => {
    const p = await open();
    expect(p.hidden).toBe(false);
    const kb = p.querySelector<HTMLElement>('[aria-label="키보드"]'), ph = p.querySelector<HTMLElement>('[aria-label="모바일 (폰 터치)"]');
    expect(kb).not.toBeNull(); expect(ph).not.toBeNull();
    for (const c of [kb!, ph!]) expect(c.querySelectorAll('input, button, select, [role="switch"]').length).toBe(0);
    expect(ph!.textContent).toContain('왼쪽 스틱');
    expect(ph!.textContent).toContain('오른쪽 스틱');
    expect(p.querySelectorAll('[data-ctl-why]').length).toBe(1);
    expect(p.querySelector('[data-ctl-why]')!.textContent).toBe(NO_SAVE);
    expect(NO_SAVE).toContain('서버 값');
  });

  it('키 표는 dev 조종 코드에 있는 키만 · 뜻이 KEYS 축과 같다 (앞뒤 0 · 돌기 1 · 옆걸음 2)', () => {
    const AXIS: Record<string, number> = { '앞 · 뒤': 0, 돌기: 1, 옆걸음: 2 };
    for (const [, what, codes] of KEY_GUIDE) {
      if (what.startsWith('정지')) { expect(codes).toEqual(['Space']); continue; }
      expect(AXIS[what]).toBeDefined();
      for (const c of codes) expect(KEYS[c]?.[0]).toBe(AXIS[what]);
    }
    // KEYS 에 있는 키는 하나도 빠지지 않는다
    expect(KEY_GUIDE.flatMap(([, , c]) => c).filter((c) => c !== 'Space').sort()).toEqual(Object.keys(KEYS).sort());
  });

  it('스틱 자리: 앞뒤 스틱(.dv-stick.v) 은 왼쪽, 돌기 스틱(.dv-stick.h) 은 오른쪽', () => {
    expect(driveCss).toMatch(/\.dv-stick\.v\{left:/);
    expect(driveCss).toMatch(/\.dv-stick\.h\{right:/);
  });
});
