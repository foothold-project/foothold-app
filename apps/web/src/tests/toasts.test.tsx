// PC 알림 카드(proto/toasts): 로봇마다 한 장 · 겹쳐 쌓기(새것 맨 앞) · 누르면 펼침 / 다시 · 바깥 누르면 접힘
// · 몇 초 뒤 사라짐(펼침 · 마우스 올림 동안 멈춤) · 닫기 · 안전 알림은 그대로
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import css from '../proto/frame.pv.css?raw';
import { TOAST_FROM, TOAST_MS, Toasts } from '../proto/toasts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root, host: HTMLDivElement;
const draw = (items: ReactNode[], pc = true) => act(() => root.render(<Toasts pc={pc}>{items}</Toasts>));
const stack = () => host.querySelector<HTMLElement>('[data-band] > .ap-stack');
const cards = () => [...host.querySelectorAll<HTMLElement>('[data-band] .ap-stack > .ap-toast')];
const toggle = () => host.querySelector<HTMLButtonElement>('.ap-stack-t');
const lostOne = (i: number) => <span key={`r${i}`} data-tone="warn">▲ Go2-{i} 연결 끊김. 현장에서 로봇 전원과 통신을 확인하세요.</span>;
const lost = (n: number) => Array.from({ length: n }, (_, i) => lostOne(i));
const info = (k: string) => <span key={k} data-tone="info">{k} 안내</span>;
const stops = (n: number) => Array.from({ length: n }, (_, i) => <span key={`stop-${i}`} data-stop-band>Go2-{i} 정지 요청됨</span>);
const tick = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
const tap = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

beforeEach(() => { vi.useFakeTimers(); host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ''; vi.useRealTimers(); });

describe('알림 카드', () => {
  it('끊김 8 건 → 합치지 않고 로봇마다 카드 8 장, 겹쳐 쌓임(접힘)', () => {
    draw(lost(8));
    expect(cards()).toHaveLength(8);
    expect(cards().map((c) => c.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('Go2-0 연결 끊김'), expect.stringContaining('Go2-7 연결 끊김')]));
    expect(stack()!.hasAttribute('data-open')).toBe(false);
    expect(cards().map((c) => c.dataset.depth)).toEqual(['0', '1', '2', '3', '4', '5', '6', '7']);
    expect(toggle()!.getAttribute('aria-expanded')).toBe('false');
    expect(toggle()!.textContent).toBe('8 건 모두 보기');
  });

  it('가장 새것이 맨 앞', () => {
    draw([lostOne(1)]);
    tick(1000);
    draw([lostOne(1), lostOne(2)]);
    expect(cards()[0].textContent).toContain('Go2-2');
    expect(cards()[0].dataset.depth).toBe('0');
  });

  it('누르면 펼침 · 다시 누르면 접힘 · 펼친 뒤 바깥을 누르면 접힘 · Esc 도 접힘', () => {
    draw(lost(3));
    tap(cards()[0]);
    expect(stack()!.hasAttribute('data-open')).toBe(true);
    expect(toggle()!.getAttribute('aria-expanded')).toBe('true');
    tap(cards()[1]);
    expect(stack()!.hasAttribute('data-open')).toBe(false);
    act(() => toggle()!.click());
    expect(stack()!.hasAttribute('data-open')).toBe(true);
    act(() => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    expect(stack()!.hasAttribute('data-open')).toBe(false);
    act(() => toggle()!.click());
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(stack()!.hasAttribute('data-open')).toBe(false);
  });

  it(`정보 · 경고 모두 ${TOAST_MS / 1000} 초 뒤 사라짐`, () => {
    draw([info('a'), lostOne(1)]);
    tick(TOAST_MS - 1);
    expect(cards()).toHaveLength(2);
    tick(1);
    expect(cards()).toHaveLength(0);
    expect(stack()).toBeNull();
  });

  it('펼쳐 둔 동안은 사라지지 않고, 접으면 남은 시간만큼 더 있다가 사라짐', () => {
    draw(lost(2));
    tick(2000);
    act(() => toggle()!.click());
    tick(60_000);
    expect(cards()).toHaveLength(2);
    act(() => toggle()!.click());
    tick(TOAST_MS - 2000 - 1);
    expect(cards()).toHaveLength(2);
    tick(1);
    expect(cards()).toHaveLength(0);
  });

  it('마우스를 올려 둔 동안은 사라지지 않음', () => {
    draw(lost(1));
    act(() => { stack()!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body })); });
    tick(60_000);
    expect(cards()).toHaveLength(1);
    act(() => { stack()!.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })); });
    tick(TOAST_MS);
    expect(cards()).toHaveLength(0);
  });

  it('닫기: button · aria-label · 누르면 그 카드만 사라짐(펼침은 안 바뀜)', () => {
    draw(lost(3));
    const x = cards()[0].querySelector<HTMLButtonElement>('button[aria-label="알림 닫기"]')!;
    expect(x.type).toBe('button');
    act(() => x.click());
    expect(cards()).toHaveLength(2);
    expect(stack()!.hasAttribute('data-open')).toBe(false);
  });

  it('풀렸다가 다시 끊기면 새 카드로 다시 나옴', () => {
    draw(lost(1));
    tick(TOAST_MS);
    expect(cards()).toHaveLength(0);
    draw([]);
    draw(lost(1));
    expect(cards()).toHaveLength(1);
  });

  it('안전 알림(표 없는 카드: 정지 결과 등)은 쌓지 않고 늘 보임 · 사라지지 않음 · 닫기를 더하지 않음', () => {
    draw([...stops(4), lostOne(1)]);
    const safe = [...host.querySelectorAll<HTMLElement>('[data-band] > .ap-toast')];
    expect(safe).toHaveLength(4);
    expect(safe.every((c) => c.dataset.toast === 'safe' && !c.querySelector('[aria-label="알림 닫기"]'))).toBe(true);
    tick(60_000);
    expect(host.querySelectorAll('[data-band] > .ap-toast [data-stop-band]')).toHaveLength(4);
    expect(cards()).toHaveLength(0);
  });

  it('폰은 예전 띠 그대로(카드 틀 없음)', () => {
    draw(lost(3), false);
    expect(host.querySelector('.ap-toast')).toBeNull();
    expect(host.querySelectorAll('[data-band] > span')).toHaveLength(3);
    tick(60_000);
    expect(host.querySelectorAll('[data-band] > span')).toHaveLength(3);
  });

  it('방향은 상수 하나 · reduced-motion 이면 미끄러짐 없음', () => {
    draw([lostOne(1)]);
    expect(host.querySelector('[data-band]')!.getAttribute('data-from')).toBe(TOAST_FROM);
    expect(css).toMatch(/\.fh-band\[data-from="bottom"\]\{[^}]*bottom:24px/);
    expect(css).toMatch(/@media \(prefers-reduced-motion:reduce\)\{\.proto>\.fh\.ap-in>\.fh-band \.ap-toast\{animation:none;transition:none\}\}/);
  });
});
