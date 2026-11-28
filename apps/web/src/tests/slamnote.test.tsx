// 3D 상자 까닭 띠는 지도 칸 밖 (11-28 폰 스캔 사진: 띠가 작은 지도 윗벽 125 px · 방 윗부분 18 px 를 가림).
// PC 지도 탭 · 폰 스캔이 같은 SlamView 를 쓰므로 한 규칙: 단추 묶음은 지도 칸 오른쪽 위 그대로, 까닭 글은 지도 칸 아래 한 줄.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SlamView, type SlamPic } from '../screens/slammap';
import './fakeWs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null, box: HTMLDivElement;
const render = async (el: JSX.Element) => { box = document.createElement('div'); document.body.append(box); await act(async () => { root = createRoot(box); root.render(el); }); };
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); vi.restoreAllMocks(); });

const pic: SlamPic = { xyz: new Float32Array(), n: 0, ver: 1, patches: [{ key: 'tile', seq: 1, x0: 0, y0: 0, w: 1, h: 1, cells: new Uint8Array([1]) }], tver: 1, pose: null, gap: false };
const $ = (s: string) => box.querySelector<HTMLElement>(s);
/** 지도 그림이 놓인 칸 (캔버스 · 단추 묶음이 겹쳐 뜨는 자리) */
const pane = () => $('canvas[data-slam-tiles]')!.closest<HTMLElement>('[data-slam-pane]');

describe('3D 상자 까닭 띠 자리', () => {
  it('3D 칸이 없으면 까닭 글은 남되, 지도 칸 밖 아래 한 줄 (지도 그림 · 단추 묶음 위에 겹치지 않음)', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    await render(<SlamView pic={pic} empty="비어 있음" />);
    const why = $('[data-slam-3d-why]')!, p = pane();
    expect(why.textContent).toBe('3D 칸을 아직 받지 못했습니다');
    expect(p).not.toBeNull();
    expect(p!.contains(why)).toBe(false);
    expect(why.closest('[role="group"]')).toBeNull();
    expect(p!.contains($('[role="group"][aria-label="지도 보기 고르기"]'))).toBe(true);   // 단추 묶음 자리는 그대로 지도 칸 오른쪽 위
    const line = why.closest<HTMLElement>('[data-slam-note]')!;
    expect(line.style.position).not.toBe('absolute');
    expect(line.compareDocumentPosition(p!) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();   // 지도 칸 다음 (아래)
    expect(document.getElementById($('[data-slam-pick="3d"]')!.getAttribute('aria-describedby')!)).toBe(why);   // 회색 단추 설명은 그대로
  });

  it('3D 를 그릴 수 있으면 까닭 줄 자체가 없어 지도 칸이 다 씀', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    await render(<SlamView pic={{ ...pic, n: 1, xyz: new Float32Array([0, 0, 0]) }} empty="비어 있음" />);
    expect($('[data-slam-note]')).toBeNull();
    expect($('[data-slam-3d-why]')).toBeNull();
    expect(pane()).not.toBeNull();
  });

  it('받은 것이 없으면 안내만 (단추 · 까닭 줄 없음)', async () => {
    await render(<SlamView pic={{ ...pic, patches: [] }} empty="비어 있음" />);
    expect($('[data-slam-view]')!.textContent).toBe('비어 있음');
    expect($('[data-slam-note]')).toBeNull();
    expect($('[role="group"]')).toBeNull();
  });
});
