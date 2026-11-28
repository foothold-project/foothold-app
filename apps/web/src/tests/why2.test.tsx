// U11-02 남은 빈칸: 지형 «내 지형» 메뉴 서버 작업 중 · 3D 상자 까닭 글 · 시뮬 «기본 위치로» 까닭 · 지형 «오류 없음» 글 없앰
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { SlamView, type SlamPic } from '../screens/slammap';
import { Terrain } from '../screens/terrain';
import { SimPick } from '../simstart';
import './fakeWs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null, box: HTMLDivElement;
const render = async (el: JSX.Element) => { box = document.createElement('div'); document.body.append(box); await act(async () => { root = createRoot(box); root.render(el); }); };
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
const btn = (text: string) => [...box.querySelectorAll('button')].find((b) => b.textContent === text);
const said = (el: Element | null | undefined) => document.getElementById(el?.getAttribute('aria-describedby') ?? '')?.textContent;
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); vi.restoreAllMocks(); localStorage.clear(); });
const me = (role: 'ORG_ADMIN' | 'OPERATOR') => ({ id: 'u', username: 'u', display_name: '시험', role, locked: false, robot_ids: [], created_at: '2026-10-19T00:00:00Z' });

describe('지형', () => {
  it('«내 지형» 메뉴: 서버 작업 중에는 회색 단추 위에 «서버와 주고받는 중» 한 줄, 끝나면 사라짐', async () => {
    let give: (x: never[]) => void = () => {};
    vi.spyOn(api, 'terrains').mockResolvedValueOnce([]).mockReturnValueOnce(new Promise((r) => { give = r; }));
    vi.spyOn(api, 'me').mockResolvedValue(me('ORG_ADMIN') as never);
    await render(<Terrain />); await flush();
    expect(box.querySelector('[data-terrain-busy]')).toBeNull();
    await act(async () => { btn('서버 목록 새로고침')!.click(); });
    expect(btn('서버 목록 새로고침')!.disabled).toBe(true);
    const line = box.querySelector('.mx-pop [data-terrain-busy]');
    expect(line?.textContent).toBe('서버와 주고받는 중… 끝나면 단추가 다시 켜집니다.');
    expect(said(btn('서버 목록 새로고침'))).toBe(line?.textContent);
    await act(async () => { give([]); }); await flush();
    expect(box.querySelector('[data-terrain-busy]')).toBeNull();
    expect(btn('서버 목록 새로고침')!.hasAttribute('aria-describedby')).toBe(false);
  });
  it('오류 · 경고가 없으면 위 줄에 «오류 없음» 같은 글이 없다', async () => {
    vi.spyOn(api, 'terrains').mockResolvedValue([]);
    vi.spyOn(api, 'me').mockResolvedValue(me('ORG_ADMIN') as never);
    await render(<Terrain />); await flush();
    expect(box.querySelector('[data-terrain-count]')).toBeNull();
    expect(box.textContent).not.toContain('오류 없음');
  });
});

describe('3D 상자 까닭은 글로 (마우스 올림 title 아님)', () => {
  const base: SlamPic = { xyz: new Float32Array(), n: 0, ver: 1, patches: [{ key: 'tile', seq: 1, x0: 0, y0: 0, w: 1, h: 1, cells: new Uint8Array([1]) }], tver: 1, pose: null, gap: false };
  const pick = () => box.querySelector<HTMLButtonElement>('[data-slam-pick="3d"]')!;
  it('3D 칸이 아직 없으면', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    await render(<SlamView pic={base} empty="비어 있음" />);
    expect(pick().disabled).toBe(true);
    expect(pick().hasAttribute('title')).toBe(false);
    expect(box.querySelector('[data-slam-3d-why]')?.textContent).toBe('3D 칸을 아직 받지 못했습니다');
    expect(said(pick())).toBe('3D 칸을 아직 받지 못했습니다');
  });
  it('이 브라우저가 3D 를 못 그리면', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    await render(<SlamView pic={{ ...base, n: 1, xyz: new Float32Array([0, 0, 0]) }} empty="비어 있음" first3d />); await flush();
    expect(pick().disabled).toBe(true);
    expect(said(pick())).toBe('이 브라우저는 3D 를 그릴 수 없습니다');
  });
  it('3D 를 그릴 수 있고 칸이 있으면 까닭 줄 없음', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    await render(<SlamView pic={{ ...base, n: 1, xyz: new Float32Array([0, 0, 0]) }} empty="비어 있음" />);
    expect(pick().disabled).toBe(false);
    expect(box.querySelector('[data-slam-3d-why]')).toBeNull();
    expect(pick().hasAttribute('aria-describedby')).toBe(false);
  });
});

describe('시뮬 시작 위치', () => {
  it('«기본 위치로»가 회색이면 이미 기본 시작 지점이라는 줄을 가리킨다', async () => {
    await render(<SimPick />);
    const home = box.querySelector<HTMLButtonElement>('[data-sim-home]')!;
    expect(home.disabled).toBe(true);
    expect(said(home)).toContain('기본 시작 지점');
  });
});
