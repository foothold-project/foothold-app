// PC 알림 카드(proto/toasts): 같은 원인 합침 · 정보 6 초 · 경고 남음 · 최대 3 장 + «n 건 더» · 닫기 · 안전 알림은 그대로
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import css from '../proto/frame.pv.css?raw';
import { TOAST_FROM, TOAST_INFO_MS, TOAST_MAX, Toasts } from '../proto/toasts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root, host: HTMLDivElement;
const draw = (items: ReactNode[], pc = true) => act(() => root.render(<Toasts pc={pc}>{items}</Toasts>));
const cards = () => [...host.querySelectorAll<HTMLElement>('[data-band] > .ap-toast')];
const more = () => host.querySelector<HTMLButtonElement>('[data-toast-more]');
const lost = (n: number) => Array.from({ length: n }, (_, i) => <span key={`r${i}`} data-tone="warn" data-cause="lost">▲ Go2-{i} 연결 끊김. 현장에서 로봇 전원과 통신을 확인하세요.</span>);
const info = (k: string) => <span key={k} data-tone="info">{k} 안내</span>;
const warn = (k: string) => <span key={k} data-tone="warn">{k} 경고</span>;

beforeEach(() => { vi.useFakeTimers(); host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ''; vi.useRealTimers(); });

describe('알림 카드', () => {
  it('같은 원인 8 건 → 카드 1 장 · 숫자 8 · 로봇별 글은 자세히 안에', () => {
    draw(lost(8));
    expect(cards()).toHaveLength(1);
    expect(cards()[0].dataset.count).toBe('8');
    expect(cards()[0].querySelector('.ap-toast-n')!.textContent).toBe('8');
    expect(cards()[0].querySelector('.ap-toast-t')!.textContent).toContain('8 대 연결 끊김');
    expect(cards()[0].querySelectorAll('details span')).toHaveLength(8);
  });

  it('한 건이면 원래 글 그대로(합침 표시 없음)', () => {
    draw(lost(1));
    expect(cards()).toHaveLength(1);
    expect(cards()[0].dataset.count).toBeUndefined();
    expect(cards()[0].textContent).toContain('Go2-0 연결 끊김');
  });

  it(`정보는 ${TOAST_INFO_MS / 1000} 초 뒤 사라지고 경고는 남는다`, () => {
    draw([info('a'), warn('b')]);
    expect(cards().map((c) => c.dataset.toast)).toEqual(['info', 'warn']);
    act(() => { vi.advanceTimersByTime(TOAST_INFO_MS - 1); });
    expect(cards()).toHaveLength(2);
    act(() => { vi.advanceTimersByTime(1); });
    expect(cards().map((c) => c.dataset.toast)).toEqual(['warn']);
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(cards()).toHaveLength(1);
  });

  it(`최대 ${TOAST_MAX} 장 · 넘치면 «n 건 더»`, () => {
    draw([warn('a'), warn('b'), warn('c'), warn('d'), warn('e')]);
    expect(cards()).toHaveLength(3);
    expect(more()!.textContent).toBe('2 건 더');
  });

  it('«n 건 더» 를 누르면 알림 종을 펼침', () => {
    const bell = document.createElement('details'); bell.className = 'ap-bell'; bell.innerHTML = '<summary>종</summary>'; document.body.appendChild(bell);
    draw([warn('a'), warn('b'), warn('c'), warn('d')]);
    act(() => more()!.click());
    expect(bell.open).toBe(true);
  });

  it('닫기: 키보드로 닿는 단추 · aria-label · 누르면 사라지고 다음 카드가 올라옴 · 새 건이 더해지면 다시', () => {
    draw([...lost(8), warn('b'), warn('c'), warn('d')]);
    expect(more()!.textContent).toBe('1 건 더');
    const x = cards()[0].querySelector<HTMLButtonElement>('button[aria-label="알림 닫기"]')!;
    expect(x.type).toBe('button');
    act(() => x.click());
    expect(cards().map((c) => c.textContent)).toEqual(['b 경고닫기', 'c 경고닫기', 'd 경고닫기']);
    expect(more()).toBeNull();
    draw([...lost(9), warn('b'), warn('c'), warn('d')]);
    expect(cards()[0].dataset.count).toBe('9');
  });

  it('안전 알림(표 없는 카드: 정지 결과 등)은 합치거나 숨기거나 닫기를 더하지 않는다', () => {
    const stops = [1, 2, 3, 4].map((i) => <span key={`stop-${i}`} data-stop-band>Go2-{i} 정지 요청됨</span>);
    draw([...stops, warn('w')]);
    expect(cards()).toHaveLength(4);
    expect(cards().every((c) => c.dataset.toast === 'safe' && !c.querySelector('[aria-label="알림 닫기"]'))).toBe(true);
    expect(host.querySelectorAll('[data-stop-band]')).toHaveLength(4);
    expect(more()!.textContent).toBe('1 건 더');
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(cards()).toHaveLength(4);
  });

  it('폰은 예전 띠 그대로(카드 틀 없음)', () => {
    draw(lost(3), false);
    expect(cards()).toHaveLength(0);
    expect(host.querySelectorAll('[data-band] > span')).toHaveLength(3);
  });

  it('방향은 상수 하나 · reduced-motion 이면 미끄러짐 없음', () => {
    draw([warn('a')]);
    expect(host.querySelector('[data-band]')!.getAttribute('data-from')).toBe(TOAST_FROM);
    expect(css).toMatch(/\.fh-band\[data-from="bottom"\]\{[^}]*bottom:24px/);
    expect(css).toMatch(/@media \(prefers-reduced-motion:reduce\)\{\.proto>\.fh\.ap-in>\.fh-band>\.ap-toast\{animation:none\}\}/);
  });
});
