// U11-02 회색 단추 아래 까닭 한 줄 · U11-03 오류 한 줄 + 고칠 단추 하나 (열린 PR 이 건드리지 않는 화면만)
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiFail } from '../api';
import type { TrashItem } from '../../../contracts/ts';
import { Bell, RecentEvents } from '../screens/history';
import { SlamSavedView } from '../screens/slammap';
import { Terrain } from '../screens/terrain';
import { Trash } from '../screens/trash';
import './fakeWs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null, box: HTMLDivElement;
const render = async (el: JSX.Element) => { box = document.createElement('div'); document.body.append(box); await act(async () => { root = createRoot(box); root.render(el); }); };
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
const btn = (text: string) => [...box.querySelectorAll('button')].find((b) => b.textContent === text);
const fail = () => Promise.reject(new ApiFail(500, 'INTERNAL', '서버 오류'));
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); vi.restoreAllMocks(); localStorage.clear(); });

describe('U11-03 오류 한 줄 + 다시 시도', () => {
  it('로봇 서랍 «최근 사건»을 못 받으면 다시 시도 단추가 있고, 누르면 다시 받는다', async () => {
    const ev = vi.spyOn(api, 'events').mockImplementationOnce(fail).mockResolvedValue({ items: [], next_cursor: null });
    await render(<RecentEvents robot="r-a" />); await flush();
    expect(box.querySelector('[role="alert"]')?.textContent).toContain('최근 사건을 받지 못했습니다');
    await act(async () => { btn('다시 시도')!.click(); }); await flush();
    expect(ev).toHaveBeenCalledTimes(2);
    expect(box.querySelector('[role="alert"]')).toBeNull();
  });
  it('알림을 못 받으면 알림 칸에 다시 시도 단추, 누르면 곧바로 다시 받는다', async () => {
    const n = vi.spyOn(api, 'notifications').mockImplementationOnce(fail).mockResolvedValue({ items: [], unread_count: 0, next_cursor: null } as never);
    await render(<Bell />); await flush();
    expect(box.querySelector('[role="alert"]')?.textContent).toContain('알림을 받지 못했습니다');
    await act(async () => { btn('다시 시도')!.click(); }); await flush();
    expect(n).toHaveBeenCalledTimes(2);
    expect(box.querySelector('[role="alert"]')).toBeNull();
  });
  it('저장된 «로봇으로 만든 지도»를 못 받으면 다시 시도 단추, 누르면 다시 받는다', async () => {
    const b = vi.spyOn(api, 'slamBundle').mockImplementation(fail);
    vi.spyOn(api, 'slamBundleFile').mockImplementation(fail);
    await render(<SlamSavedView robot="r-a" session="s1" />); await flush();
    expect(box.querySelector('[role="alert"]')?.textContent).toContain('지도 자료를 받지 못했습니다');
    await act(async () => { btn('다시 시도')!.click(); }); await flush();
    expect(b).toHaveBeenCalledTimes(2);
  });
});

describe('U11-02 회색 단추 까닭 한 줄', () => {
  const item: TrashItem = { kind: 'floor', id: 'm1', name: '1층', archived_at: '2026-11-02T03:00:00Z', deleted_by: null, parent_name: null } as TrashItem;
  it('휴지통: 복원·완전 삭제가 처리 중으로 회색일 때 «처리하는 중» 한 줄, 끝나면 사라짐', async () => {
    vi.spyOn(api, 'trash').mockResolvedValue({ items: [item] } as never);
    let done: () => void = () => {};
    vi.spyOn(api, 'restore').mockReturnValue(new Promise<void>((r) => { done = r; }));
    await render(<Trash />); await flush();
    expect(box.querySelector('[data-trash-busy]')).toBeNull();
    await act(async () => { btn('복원')!.click(); });
    expect(btn('복원')!.disabled).toBe(true);
    expect(box.querySelector('[data-trash-busy]')?.textContent).toBe('처리하는 중… 끝나면 단추가 다시 켜집니다.');
    await act(async () => { done(); }); await flush();
    expect(box.querySelector('[data-trash-busy]')).toBeNull();
  });
  const me = (role: 'ORG_ADMIN' | 'OPERATOR') => ({ id: 'u', username: 'u', display_name: '시험', role, locked: false, robot_ids: [], created_at: '2026-10-19T00:00:00Z' });
  it('지형: 운영자는 저장이 회색이고, 까닭은 이미 보이는 «총괄 계정만» 안내 한 줄로만 (같은 말 두 번 없음)', async () => {
    vi.spyOn(api, 'terrains').mockResolvedValue([]);
    vi.spyOn(api, 'me').mockResolvedValue(me('OPERATOR') as never);
    await render(<Terrain />); await flush();
    const save = box.querySelector<HTMLButtonElement>('[data-terrain-save]')!;
    expect(save.disabled).toBe(true);
    expect(box.querySelector('[data-terrain-save-why]')).toBeNull();
    const note = document.getElementById(save.getAttribute('aria-describedby') ?? '');
    expect(note?.textContent).toContain('서버 저장과 휴지통은 총괄 계정만 사용할 수 있습니다');
    expect(box.textContent!.split('총괄 계정만').length - 1).toBe(1);
  });
  it('지형: 운영자도 서버 목록을 받기 전에는 «서버 목록을 받는 중»이 단추 옆에', async () => {
    vi.spyOn(api, 'terrains').mockReturnValue(new Promise(() => {}));
    vi.spyOn(api, 'me').mockResolvedValue(me('OPERATOR') as never);
    await render(<Terrain />); await flush();
    const why = box.querySelector('[data-terrain-save-why]');
    expect(why?.textContent).toBe('서버 목록을 받는 중입니다');
    expect(box.querySelector('[data-terrain-save]')!.getAttribute('aria-describedby')).toBe(why?.id);
  });
  it('지형: 총괄이 오류 있는 지형을 고르면 «오류를 고친 뒤» 까닭은 단추 옆에 그대로', async () => {
    vi.spyOn(api, 'terrains').mockResolvedValue([]);
    vi.spyOn(api, 'me').mockResolvedValue(me('ORG_ADMIN') as never);
    await render(<Terrain />); await flush();
    const name = box.querySelector<HTMLInputElement>('input.inp')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, ''); name.dispatchEvent(new Event('input', { bubbles: true })); });
    const save = box.querySelector<HTMLButtonElement>('[data-terrain-save]')!;
    expect(save.disabled).toBe(true);
    const why = box.querySelector('[data-terrain-save-why]');
    expect(why?.textContent).toBe('오류를 고친 뒤 저장할 수 있습니다');
    expect(save.getAttribute('aria-describedby')).toBe(why?.id);
  });
  it('지형: 서버 목록을 받기 전에는 «서버 목록을 받는 중», 총괄이 받은 뒤에는 까닭 줄 없음', async () => {
    let give: (x: never[]) => void = () => {};
    vi.spyOn(api, 'terrains').mockReturnValue(new Promise((r) => { give = r; }));
    vi.spyOn(api, 'me').mockResolvedValue(me('ORG_ADMIN') as never);
    await render(<Terrain />); await flush();
    expect(box.querySelector('[data-terrain-save-why]')?.textContent).toBe('서버 목록을 받는 중입니다');
    await act(async () => { give([]); }); await flush();
    expect(box.querySelector<HTMLButtonElement>('[data-terrain-save]')!.disabled).toBe(false);
    expect(box.querySelector('[data-terrain-save-why]')).toBeNull();
  });
});
