// 화면 테마 고르기(10-28): 어두움(기본)·밝음·기기 설정 따름, 이 기기 localStorage fh.theme 에만 기억
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let light = false;
const subs = new Set<() => void>();
beforeEach(() => {
  vi.resetModules();   // 탭 안에 기억한 값(picked) 비우기
  window.matchMedia = ((q: string) => ({ get matches() { return light; }, media: q,
    addEventListener(_e: string, f: () => void) { subs.add(f); }, removeEventListener(_e: string, f: () => void) { subs.delete(f); } })) as unknown as typeof window.matchMedia;
});
afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); light = false; subs.clear(); document.body.innerHTML = ''; });
const load = () => import('../theme');

describe('저장값', () => {
  it('없으면·모르는 값이면 어두움', async () => {
    const t = await load();
    expect([t.themePref(), t.isLight()]).toEqual(['dark', false]);
    localStorage.setItem('fh.theme', 'blue');
    expect(t.themePref()).toBe('dark');
  });
  it('dark·light·system 세 가지', async () => {
    const t = await load();
    localStorage.setItem('fh.theme', 'dark'); expect([t.themePref(), t.isLight()]).toEqual(['dark', false]);
    localStorage.setItem('fh.theme', 'light'); expect([t.themePref(), t.isLight()]).toEqual(['light', true]);
    localStorage.setItem('fh.theme', 'system'); expect([t.themePref(), t.isLight()]).toEqual(['system', false]);
    light = true; expect(t.isLight()).toBe(true);   // 기기가 밝음이면 밝음
  });
  it('못 읽으면 기본값 어두움', async () => {
    const t = await load();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    expect([t.themePref(), t.isLight()]).toEqual(['dark', false]);
  });
  it('못 쓰면 이 탭에만 반영', async () => {
    const t = await load();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full'); });
    t.setThemePref('light');
    expect([t.themePref(), localStorage.getItem('fh.theme')]).toEqual(['light', null]);
  });
});

describe('.fh 에 반영', () => {
  it('고르면 새로고침 없이 .fh.light·<html data-theme>, 기기 설정 바뀜도 따라감', async () => {
    const t = await load();
    const { useTheme, ThemePick } = t;
    const Box = () => <div className={useTheme()[1] ? 'fh light' : 'fh'}><ThemePick /></div>;
    const el = document.body.appendChild(document.createElement('div')), root = createRoot(el);
    t.syncTheme();
    act(() => root.render(<Box />));
    const fh = () => el.querySelector('.fh')!, pick = el.querySelector<HTMLSelectElement>('[data-theme-pick]')!;
    const choose = async (v: string) => { act(() => { pick.value = v; pick.dispatchEvent(new Event('change', { bubbles: true })); }); await Promise.resolve(); };
    expect(fh().classList.contains('light')).toBe(false);
    expect([...pick.options].map((o) => o.text)).toEqual(['어두움', '밝음', '기기 설정 따름']);
    await choose('light');
    expect([fh().classList.contains('light'), document.documentElement.dataset.theme, localStorage.getItem('fh.theme')]).toEqual([true, 'light', 'light']);
    await choose('system');
    expect(fh().classList.contains('light')).toBe(false);
    act(() => { light = true; subs.forEach((f) => f()); });
    expect(fh().classList.contains('light')).toBe(true);
    await choose('dark');
    expect([fh().classList.contains('light'), document.documentElement.dataset.theme]).toEqual([false, 'dark']);
    act(() => root.unmount());
  });
});
