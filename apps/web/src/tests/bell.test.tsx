// 머리줄 알림 창(Bell): 바깥 누름 · Esc(초점은 종으로) · 주소(탭) 바뀜에 닫힌다. 알림 항목 누름은 그 주소로 가며 닫힘(그대로)
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { Bell } from '../screens/history';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null, box: HTMLDivElement, out: HTMLButtonElement;
const NOTE = { id: 'n1', title: '경로 이탈', body: 'Go2-7 이 경로를 벗어났습니다', link: '#/history', read_at: null, created_at: '2026-11-28T09:00:00Z' };
beforeEach(async () => {
  vi.spyOn(api, 'notifications').mockResolvedValue({ items: [NOTE], unread_count: 1, next_cursor: null } as never);
  vi.spyOn(api, 'readNotifications').mockResolvedValue(undefined as never);
  location.hash = '#/fleet';
  out = document.createElement('button'); out.textContent = '바깥'; document.body.append(out);
  box = document.createElement('div'); document.body.append(box);
  await act(async () => { root = createRoot(box); root.render(<Bell />); });
});
afterEach(() => { act(() => root?.unmount()); root = null; box.remove(); out.remove(); vi.restoreAllMocks(); });

const bell = () => box.querySelector<HTMLDetailsElement>('[data-bell]')!;
const summary = () => bell().querySelector('summary')!;
const openIt = () => act(() => { bell().open = true; bell().dispatchEvent(new Event('toggle')); });

describe('알림 창 닫힘', () => {
  it('바깥을 누르면 닫힌다', () => {
    openIt();
    act(() => { out.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); });
    expect(bell().open).toBe(false);
  });
  it('창 안을 누르면 열린 채', () => {
    openIt();
    act(() => { bell().querySelector('[aria-label="알림 목록"]')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); });
    expect(bell().open).toBe(true);
  });
  it('Esc 면 닫히고 초점은 종 단추로', () => {
    openIt();
    act(() => { bell().querySelector<HTMLButtonElement>('[aria-label="알림 목록"] button')!.focus(); });
    act(() => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(bell().open).toBe(false);
    expect(document.activeElement).toBe(summary());
  });
  it('주소(탭)가 바뀌면 닫힌다', async () => {
    openIt();
    await act(async () => { location.hash = '#/settings'; window.dispatchEvent(new HashChangeEvent('hashchange')); });
    expect(bell().open).toBe(false);
  });
  it('알림 항목을 누르면 그 주소로 가며 닫힌다(그대로)', () => {
    openIt();
    act(() => { bell().querySelector<HTMLButtonElement>('[data-unread]')!.click(); });
    expect(bell().open).toBe(false);
    expect(location.hash).toBe('#/history');
  });
});
