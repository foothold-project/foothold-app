// 「지금 남기기」 창 자리: 좁은 PC 틀(마우스 총괄 412 등)에서 단추 오른쪽 끝에 맞춘 창이 화면 왼쪽 밖으로 나가지 않게 (11-28 사진 left -89).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarkNow } from '../screens/records';
import type { Robot } from '../fake';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null, box: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); document.body.innerHTML = ''; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const A = { id: 'r-a', name: 'Go2-A', owner: 'o1', battery: null, online: true, seenAt: '', status: null } as unknown as Robot;
const me = { id: 'o1', name: '이운영', role: 'OPERATOR' } as unknown as Parameters<typeof MarkNow>[0]['c']['user'];
const shift = (el: Element) => Number(/translateX\((-?[\d.]+)px\)/.exec((el as HTMLElement).style.transform)?.[1] ?? 0);
/** 창은 단추 오른쪽 끝(anchorRight)에 오른쪽을 맞춰 놓인다고 치고(폭 = min(w, maxWidth)), translateX 만큼 옮긴 자리를 돌려줌.
 *  clip = 넘침을 자르는 본문 칸(fh-main 처럼)의 [left, right] */
function layout(vw: number, anchorRight: number, w: number, clip?: [number, number]) {
  vi.stubGlobal('innerWidth', vw);
  vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(vw);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const el = this as HTMLElement, mark = el.classList.contains('rc-mark'), main = el.dataset.clip !== undefined && clip;
    const width = mark ? Math.min(w, parseFloat(el.style.maxWidth) || Infinity) : main ? clip[1] - clip[0] : 0;
    const left = mark ? anchorRight - width + shift(el) : main ? clip[0] : 0;
    return { left, right: left + width, width, top: 0, bottom: 0, height: 0, x: left, y: 0, toJSON() {} } as DOMRect;
  });
}
const open = (clip = false) => {
  const host = document.createElement('div'); document.body.append(host); box = host;
  if (clip) { box = document.createElement('div'); box.dataset.clip = ''; box.style.overflowX = 'auto'; host.append(box); }
  act(() => { root = createRoot(box); root.render(<MarkNow c={{ user: me, robots: [A] }} done={() => {}} />); });
  act(() => [...box.querySelectorAll('button')].find((b) => b.textContent === '지금 남기기')!.click());
  return box.querySelector<HTMLElement>('[role="dialog"][aria-label="지금 남기기"]')!;
};

describe('지금 남기기 창 자리', () => {
  it('412 폭 · 단추 오른쪽 끝 291: 창(380)이 왼쪽 밖(-89)으로 나가지 않고 8 px 안쪽에서 시작, 오른쪽도 화면 안', () => {
    layout(412, 291, 380);
    const d = open().getBoundingClientRect();
    expect(d.left).toBeGreaterThanOrEqual(0);
    expect(d.left).toBe(8);
    expect(d.right).toBeLessThanOrEqual(412);
  });

  it('본문 칸(넘침 자름, 76~412)에 안 들어가면 폭을 줄여 칸 안 8 px 안쪽에 (마우스 총괄 412: 옆 메뉴 밑에 숨지 않게)', () => {
    layout(412, 291, 380, [76, 412]);
    const dlg = open(true), d = dlg.getBoundingClientRect();
    expect(dlg.style.maxWidth).toBe('320px');
    expect([d.left, d.right]).toEqual([84, 404]);
  });

  it('오른쪽 밖으로 나가면 왼쪽으로 옮겨 오른쪽 8 px 안쪽에 맞춤', () => {
    layout(412, 430, 380);
    const d = open().getBoundingClientRect();
    expect(d.right).toBe(404);
    expect(d.left).toBe(24);
  });

  it('1920 폭: 이미 화면 안이면 옮기지 않음 (단추 오른쪽 끝에 맞춤 그대로)', () => {
    layout(1920, 1798, 440);
    const dlg = open();
    expect(dlg.style.transform).toBe('');
    expect(dlg.getBoundingClientRect().left).toBe(1358);
  });

  it('창을 닫았다 다시 열어도 같은 자리 (앞의 옮김이 쌓이지 않음)', () => {
    layout(412, 291, 380);
    open();
    const b = [...box.querySelectorAll('button')].find((x) => x.textContent === '지금 남기기')!;
    act(() => b.click()); act(() => b.click());
    expect(box.querySelector('[role="dialog"]')!.getBoundingClientRect().left).toBe(8);
  });

  it('창을 연 채 창 폭이 넓어지면 다시 맞춤 (앞의 옮김을 지우고 단추 끝 자리로)', () => {
    layout(412, 291, 380, [76, 412]);
    const dlg = open(true);
    expect(dlg.style.maxWidth).toBe('320px');
    vi.restoreAllMocks();
    layout(1920, 1798, 440, [76, 1920]);
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(dlg.style.transform).toBe('');
    expect(dlg.style.maxWidth).toBe('');
    expect(dlg.getBoundingClientRect().left).toBe(1358);
  });
});
