// 첫 확인 화면(세션 · 로봇 목록 받는 중): 옛 한 줄(.lv-note 왼쪽 위)이 아니라 로그인과 같은 무대 · 카드 자리 · 진행 줄
import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root as R } from 'react-dom/client';
import { Root } from '../session';
import { api } from '../api';

let root: R, box: HTMLDivElement;
afterEach(() => { act(() => root.unmount()); box.remove(); vi.restoreAllMocks(); });
it('받는 중 = 로그인 무대(.fh.lg · .lg-bg) 위 카드에 「불러오는 중…」 · 진행 줄 · 옛 .lv-note 없음', () => {
  vi.spyOn(api, 'me').mockReturnValue(new Promise(() => {}) as never);   // 끝나지 않는 확인 = 받는 중 그대로
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<Root />); });
  const card = box.querySelector('.fh.lg .lg-card[data-wait]')!;
  expect(box.querySelector('.fh.lg .lg-bg')).not.toBeNull();
  expect(card.querySelector('[role="status"]')!.textContent).toBe('불러오는 중…');
  expect(card.querySelector('.lg-wait i')).not.toBeNull();
  expect(box.querySelector('.lv-note')).toBeNull();
  expect(box.querySelector('main')!.getAttribute('aria-label')).toBe('불러오는 중');
});
