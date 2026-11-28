// 설정 › 조작의 「키보드」 · 「모바일 (폰 터치)」 설명 칸(u9_7 · U9-05). 읽기 전용: 스위치 · 입력 칸 없이 지금 배치만, 바꾸지 못하는 까닭 한 줄.
// 적힌 키 · 스틱 자리가 실제 조종 코드(simdrive KEYS · drive.css 스틱 자리)와 어긋나면 실패한다.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import driveCss from '../drive.css?raw';
import type { User } from '../fake';
import { KEYS } from '../simdrive';
import { KEY_GUIDE, NO_SAVE, PHONE_BASIS } from '../screens/controls';
import driveSrc from '../drive.tsx?raw';
import { Settings, simOut } from '../screens/settings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LEE: User = { id: 'o1', name: '이운영', role: 'OPERATOR' };   // 앱 User(이름 · 역할)
let root: Root | null = null, box: HTMLDivElement | null = null;
afterEach(() => { act(() => root?.unmount()); box?.remove(); root = null; box = null; vi.unstubAllGlobals(); });

async function open(more: object = {}, who: User = LEE) {
  vi.stubGlobal('fetch', async (url: string) => new Response(JSON.stringify(String(url).includes('/org/settings')
    ? { battery_low_pct: 20, run_min_battery_pct: 30, deviation_m: 1.5, lease_request_timeout_s: 10, link_loss_wait_s: 30, ...more }
    : { error: { code: 'NOT_FOUND', message: '없음', detail: {} } }), { status: String(url).includes('/org/settings') ? 200 : 404, headers: { 'Content-Type': 'application/json' } }));
  box = document.createElement('div'); document.body.append(box);
  await act(async () => { root = createRoot(box!); root.render(<Settings user={who} setMe={() => {}} refresh={() => {}} />); });
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

  it('폰 칸도 기준을 밝힘: 시뮬 기준 · 실기는 뒤로 가지 않음 (REVIEW-PR573 P1)', async () => {
    const ph = (await open()).querySelector<HTMLElement>('[aria-label="모바일 (폰 터치)"]')!;
    expect(ph.querySelector('[data-ctl-basis]')!.textContent).toBe(PHONE_BASIS);
    expect(PHONE_BASIS).toContain('시뮬 조종 기준');
    expect(PHONE_BASIS).toContain('뒤로 가지 않');
    expect(PHONE_BASIS).not.toContain('—');
    // 실기 폰 조종(drive.tsx)이 전후를 0 아래로 내리지 않는 동안만 참
    expect(driveSrc).toContain("Math.max(0, clamp(+held(k, 'f') + stick[0]))");
  });

  it('시뮬 속도 값이 비면 0.00 이 아니라 「값을 받지 못했습니다」 (REVIEW-PR573 P2)', async () => {
    const outs = [...(await open()).querySelectorAll('output')].map((o) => o.textContent);
    expect(outs.length).toBeGreaterThan(0);
    expect(outs.every((t) => t === '값을 받지 못했습니다')).toBe(true);
    act(() => root?.unmount()); box?.remove(); root = null;
    const p = await open({ sim_max_vx: 0.5 });
    const vx = p.querySelector<HTMLInputElement>('input[name="sim_max_vx"]')!.closest('label')!.querySelector('output')!;
    expect(vx.textContent).toBe('0.50 m/s');
  });

  it('#573 후속: 총괄이라도 값이 빈 시뮬 속도 슬라이더는 잠김, 값이 오면 풀림', async () => {
    const KIM = { ...LEE, id: 'a1', role: 'ORG_ADMIN' } as unknown as User;
    const slider = (p: HTMLElement) => p.querySelector<HTMLInputElement>('input[type="range"][name="sim_max_vx"]')!;
    expect(slider(await open({}, KIM)).disabled).toBe(true);
    act(() => root?.unmount()); box?.remove(); root = null;
    expect(slider(await open({ sim_max_vx: 0.5 }, KIM)).disabled).toBe(false);
  });

  it('#573 후속: simOut 은 숫자가 아닌 값(NaN · 무한 · 글 · 빈 값 · null)을 0.00 으로 그리지 않음', () => {
    for (const v of ['', null, undefined, 'abc', NaN, Infinity, '1e999']) expect(simOut(v, 'm/s')).toBe('값을 받지 못했습니다');
    expect(simOut('0', 'm/s')).toBe('0.00 m/s');
    expect(simOut(1.2, '라디안/초')).toBe('1.20 라디안/초');
  });

  it('스틱 자리: 앞뒤 스틱(.dv-stick.v) 은 왼쪽, 돌기 스틱(.dv-stick.h) 은 오른쪽', () => {
    expect(driveCss).toMatch(/\.dv-stick\.v\{left:/);
    expect(driveCss).toMatch(/\.dv-stick\.h\{right:/);
  });
});
