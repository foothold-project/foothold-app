// 브라우저 시뮬 창(simwin.tsx, RB-WEBSIM-PIP 11-11): PC 웹 «시뮬 열기» = 앱 안에 가득 → 시뮬 집 단추(창이 보내는 말) = 작은 창 → 탭을 옮겨도 그대로 → 크게 보기 → 닫기.
// 폰 틀·앱 안은 창이 없어 옛 그대로 페이지 이동. 시뮬 쪽 규칙(작은 창 = background(), 앱 밖 집 단추 = 옛 동작)은 main.js 글자로 본다.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../App';
import { simNav } from '../screens/missions';
import { simWin } from '../simwin';
import { ROBOTS, USERS } from './fixtures';
import MAIN from '../../../../mobile/sim/main.js?raw';
import CSS from '../frame.css?raw';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null, box: HTMLDivElement;
function mount(phone = false, hash = '#/sim') {
  window.matchMedia = ((q: string) => ({ matches: phone, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  location.hash = hash;
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<App user={USERS[0]} robots={ROBOTS} />); });
}
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });
const $ = <T extends HTMLElement = HTMLElement>(s: string) => box.querySelector<T>(s);
const frame = () => $<HTMLIFrameElement>('[data-sim-win-frame]')!;
const URL_ = '/sim/index.html?from=web&map=warehouse';
/** 시뮬이 뜬 것처럼: 집 단추가 준비됨(#home[data-small]) + load */
const ready = () => act(() => {
  const doc = document.implementation.createHTMLDocument(); doc.body.innerHTML = '<button id="home" data-small></button>';
  Object.defineProperty(frame(), 'contentDocument', { value: doc, configurable: true });
  frame().dispatchEvent(new Event('load'));
});
/** 시뮬 칸의 창 대역(jsdom 은 칸 안 문서를 읽지 않는다) */
const win = () => { const w = { postMessage: vi.fn() }; Object.defineProperty(frame(), 'contentWindow', { value: w, configurable: true }); return w; };
/** 시뮬 칸이 보낸 말(집 단추) */
const say = (source: unknown, origin = location.origin) => act(() => { dispatchEvent(new MessageEvent('message', { data: { fhSim: 'small' }, origin, source: source as Window })); });

it('PC 웹: 시뮬 열기 = 페이지를 떠나지 않고 앱 안에 가득, 집 = 작은 창(같은 시뮬 칸), 탭을 옮겨도 유지, 크게 보기, 닫기', () => {
  const leave = vi.spyOn(simWin, 'leave').mockImplementation(() => {});
  mount();
  expect($('[data-sim-win]')).toBeNull();
  act(() => simNav.go(URL_));
  expect(leave).not.toHaveBeenCalled();
  expect($('[data-sim-win]')!.dataset.simWin).toBe('full');
  expect(frame().getAttribute('src')).toBe(URL_);
  expect($('[data-sim-win-big]')).toBeNull();
  const f = frame(), w = win(), post = w.postMessage; ready();
  expect($('[data-sim-win]')!.dataset.simWin).toBe('full');
  expect(f.inert).toBe(false);

  say({}); say(w, 'https://other.example');   // 다른 창·다른 출처의 말은 무시
  expect($('[data-sim-win]')!.dataset.simWin).toBe('full');
  say(w);
  expect($('[data-sim-win]')!.dataset.simWin).toBe('small');
  expect(frame()).toBe(f);   // 시뮬 칸을 새로 만들지 않는다(= 시뮬이 끝나지 않음)
  expect(f.inert).toBe(true);   // 작은 창 = 누름·키가 시뮬로 가지 않음
  expect(document.activeElement).toBe($('[data-sim-win-big]'));   // 초점도 시뮬 칸 밖으로
  expect(post).toHaveBeenCalledWith({ fhSim: 'small' }, location.origin);   // 시뮬에 알림 → 손 조종 입력 놓기
  expect($('[data-sim-win-bar]')!.textContent).toContain('작은 창');
  expect(box.textContent).not.toMatch(/iframe|PIP/i);

  for (const tab of ['fleet', 'map', 'history']) {   // 탭을 옮겨도 같은 칸
    act(() => { box.querySelector<HTMLElement>(`nav[aria-label="주 메뉴"] a[href="#/${tab}"]`)!.click(); });
    expect(frame()).toBe(f);
    expect($('[data-sim-win]')!.dataset.simWin).toBe('small');
  }
  act(() => { $('[data-sim-win-big]')!.click(); });
  expect($('[data-sim-win]')!.dataset.simWin).toBe('full');
  expect(frame()).toBe(f);
  expect(f.inert).toBe(false);

  say(w);
  act(() => { $('[data-sim-win-close]')!.click(); });
  expect($('[data-sim-win]')).toBeNull();
  expect(simWin.get()).toBeNull();
});

it('가득일 때 브라우저 «뒤로» = 작은 창, 시뮬이 뜨지 못하면 가득에 갇히지 않고 작은 창 + 닫기만', () => {
  mount();
  act(() => simNav.go(URL_)); ready();
  act(() => { dispatchEvent(new PopStateEvent('popstate')); });
  expect($('[data-sim-win]')!.dataset.simWin).toBe('small');
  act(() => { $('[data-sim-win-close]')!.click(); });

  act(() => simNav.go(URL_));
  act(() => { frame().dispatchEvent(new Event('load')); });   // 집 단추 준비 표시 없음 = 시뮬이 못 뜸
  expect($('[data-sim-win]')!.dataset.simWin).toBe('small');
  expect($('[data-sim-win-bar]')!.textContent).toContain('열지 못했습니다');
  expect($<HTMLButtonElement>('[data-sim-win-big]')!.disabled).toBe(true);
  act(() => { $('[data-sim-win-close]')!.click(); });
  expect($('[data-sim-win]')).toBeNull();
});

it('로그아웃(앱 내림) 뒤 죽은 창이 남지 않는다', () => {
  mount();
  act(() => simNav.go(URL_));
  expect(simWin.get()).toBeTruthy();
  act(() => root!.unmount()); root = null;
  expect(simWin.get()).toBeNull();
});

it('폰 틀·앱 안은 그대로: 창 없이 페이지 이동', () => {
  const leave = vi.spyOn(simWin, 'leave').mockImplementation(() => {});
  mount(true, '#/drive');
  act(() => simNav.go(URL_));
  expect(leave).toHaveBeenCalledWith(URL_);
  expect($('[data-sim-win]')).toBeNull();
  act(() => root!.unmount()); root = null; box.remove();

  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 FootholdApp/1.2.0');
  mount(false);
  act(() => simNav.go(URL_));
  expect(leave).toHaveBeenCalledTimes(2);
  expect($('[data-sim-win]')).toBeNull();
});

it('시뮬 쪽: 앱 안 시뮬 칸일 때만 집 = 작은 창(손 조종 입력 놓기), 그 밖의 집 단추는 옛 동작 그대로', () => {
  expect(MAIN).toContain("inWeb = from === 'web' && frameElement?.dataset.simWinFrame != null");
  expect(MAIN).toContain("if (inWeb) { handsOff(); parent.postMessage({ fhSim: 'small' }, location.origin); return; }");
  expect(MAIN).toContain("lock(); if (fromServer) history.back(); else location.href = from === 'web' ? '../#/sim' : '../index.html';");
  expect(MAIN).toContain("e.source === parent && e.data?.fhSim === 'small') handsOff();");
  // 작은 창·초점 잃음: 손 조종·실기 보기 = 잠금, 시나리오·임무 실행 중 = 계속(손 조종 입력만 놓음). 앱 밖 시뮬의 초점 잃음·숨김은 옛 background 그대로
  expect(MAIN).toContain("const handsOff = () => { if (readonly || !(runningTree?.active || runningScenario?.active)) return lock(); sticks.forEach((s) => s.release()); };");
  expect(MAIN).toContain("addEventListener('blur', inWeb ? handsOff : background);");
  expect(MAIN).toContain("document.addEventListener('visibilitychange', () => { if (document.hidden) background(); });");
  expect(MAIN).toContain('embedded: inWeb });');
  expect(MAIN).toContain("addEventListener('pagehide', lock);");   // 닫기(칸이 사라짐) = 잠금 후 끝
});

it('작은 창은 머리줄(STOP)·띄운 확인 칸보다 아래 층', () => {
  const z = (sel: string) => +(CSS.match(new RegExp(`${sel.replace(/[.[\]"=]/g, '\\$&')}\\{[^}]*z-index:(\\d+)`))?.[1] ?? NaN);
  expect(z('.sw[data-sim-win="small"]')).toBeLessThan(z('.fl-sheet'));
  expect(z('.fl-sheet')).toBeLessThan(z('.fh-head'));
});

it('«지형 만들기»의 «시뮬로 열기»도 PC 웹에서는 같은 시뮬 창(링크로 떠나지 않음), 새 탭 열기(Ctrl)는 링크 그대로', () => {
  mount(false, '#/terrain');
  const a = $<HTMLAnchorElement>('a[data-terrain-open]')!, url = a.getAttribute('href')!;
  expect(url).toContain('/sim/index.html?from=web&map=custom&terrain=');
  const ctrl = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });
  let kept = false; const seen = (e: Event) => { kept = !e.defaultPrevented; e.preventDefault(); };   // 앱이 안 막았는지 본 뒤 jsdom 이 떠나지 않게 막음
  document.addEventListener('click', seen);
  try { act(() => { a.dispatchEvent(ctrl); }); } finally { document.removeEventListener('click', seen); }
  expect(kept).toBe(true);
  expect($('[data-sim-win]')).toBeNull();
  const e = new MouseEvent('click', { bubbles: true, cancelable: true });
  act(() => { a.dispatchEvent(e); });
  expect(e.defaultPrevented).toBe(true);
  expect($('[data-sim-win]')!.dataset.simWin).toBe('full');
  expect(frame().getAttribute('src')).toBe(url);
});
