// 시안 껍데기(proto shared/pc.css · screens/u5_1_tiles.html 머리줄): PC 는 위 가로 메뉴 여섯 · 머리줄 칸(로봇 n 대 연결 · 서버 · 종 · 나 · 정지).
// 왼쪽 세로 메뉴는 없다. STOP 은 어느 탭에서도 머리줄에 늘 보이고 Space 로도 동작한다(기존 STOP 시험은 그대로). 폰은 주 메뉴 없음.
// WebSocket 은 FakeWS · 실기 없음.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { USERS, type Robot } from './fixtures';
import { FakeWS, state } from './fakeWs';
import css from '../shell.css?raw';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null, box: HTMLDivElement;
function mount(user: string, robots: Robot[], hash = '', phone = false) {
  window.matchMedia = ((q: string) => ({ matches: phone, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  location.hash = hash;
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<App user={USERS.find((u) => u.id === user)} robots={robots} />); });
}
const feed = (robots: Robot[]) => act(() => {
  FakeWS.last.open();
  for (const r of robots) FakeWS.last.recv(r.online ? state(r.id) : state(r.id, { connection: 'OFFLINE', status: null, battery: null, latched: null, stop_gen: null, applied: null }));
});
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); vi.restoreAllMocks(); localStorage.clear(); });
const $ = <T extends Element = HTMLElement>(s: string) => box.querySelector<T>(s);
const $$ = (s: string) => [...box.querySelectorAll<HTMLElement>(s)];
const head = () => $('header.fh-head')!;
const stopBtn = () => head().querySelector<HTMLElement>('[aria-label="비상 정지"]');

const R: Robot[] = [
  { id: 'a1', name: 'K-01', owner: 'u-lee', ownerName: '이OO', battery: 80, online: true, seenAt: '14:05:20', status: 'RUNNING', serverDrive: true },
  { id: 'a2', name: 'K-02', owner: 'u-lee', ownerName: '이OO', battery: 70, online: true, seenAt: '14:05:20', status: 'IDLE', serverDrive: true },
  { id: 'a3', name: 'K-03', owner: 'u-lee', ownerName: '이OO', battery: null, online: false, seenAt: '13:40:05', status: 'STOP_LATCHED' as never },
];
const TABS = ['관제', '로봇', '지도', '임무', '기록', '설정'];
const HREF = ['#/control', '#/fleet', '#/map', '#/missions', '#/history', '#/settings'];

describe('시안 껍데기 · PC 머리줄', () => {
  it('위 가로 메뉴 여섯(시안 순서 · 글자만) 이 머리줄 안에 있고 왼쪽 세로 메뉴는 없다', () => {
    mount('u-kim', R); feed(R);
    const nav = head().querySelector('nav[aria-label="주 메뉴"]')!;
    expect(nav).not.toBeNull();
    expect([...nav.querySelectorAll('a')].map((a) => a.textContent)).toEqual(TABS);
    expect([...nav.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(HREF);
    expect(nav.querySelector('svg')).toBeNull();
    expect(nav.querySelector('a[aria-current="page"]')!.textContent).toBe('관제');
    expect($('.fh-body > nav')).toBeNull();
    expect(head().querySelector('[data-shell-logo]')!.textContent).toBe('FOOTHOLD');
  });

  it('머리줄 오른쪽: 로봇 n 대 연결(받은 상태 그대로) · 서버 · 종 · 나 · 정지 순(정지는 멈출 로봇이 있는 계정)', () => {
    mount('u-lee', R); feed(R);
    expect(head().querySelector('[data-live]')!.textContent).toBe('로봇 2 대 연결');
    expect(head().querySelector('[data-server]')!.textContent).toBe('서버 정상');
    const right = head().querySelector('[data-shell-right]')!;
    const order = [...right.children].map((e) => (e as HTMLElement).dataset.slot).filter(Boolean);
    expect(order).toEqual(['live', 'server', 'bell', 'who']);
    expect(head().lastElementChild).toBe(stopBtn());   // 정지는 머리줄 맨 끝
    expect(right.querySelector('[data-slot="who"] [data-av]')!.textContent).toBe('나');
    expect(right.querySelector('.fh-me')!.textContent).toBe('이OO · 운영 관리자');
    act(() => { FakeWS.last.recv(state('a2', { connection: 'OFFLINE', status: null, battery: null, latched: null, stop_gen: null, applied: null })); });
    expect(head().querySelector('[data-live]')!.textContent).toBe('로봇 1 대 연결');
    act(() => { FakeWS.last.drop(4000); });
    expect(head().querySelector('[data-server]')!.textContent).not.toBe('서버 정상');
  });

  it('STOP 은 여섯 탭 모두 머리줄에 보임 · 관제는 「모두 정지」, 고르면 「K-01 정지」, 다른 탭은 「로봇 정지」 · Space 로도 동작', () => {
    for (const [i, h] of HREF.entries()) {
      mount('u-lee', R, h); feed(R);
      expect(stopBtn(), TABS[i]).not.toBeNull();
      act(() => root?.unmount()); root = null; box.remove();
    }
    mount('u-lee', R); feed(R);
    expect(stopBtn()!.textContent).toBe('모두 정지');
    act(() => { $('article[data-robot="a1"]')!.click(); });
    expect(stopBtn()!.textContent).toBe('K-01 정지');
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, cancelable: true })); });
    expect(FakeWS.last.of('stop').map((m) => m.robot)).toEqual(['a1']);
    act(() => root?.unmount()); root = null; box.remove();
    mount('u-lee', R, '#/history'); feed(R);
    expect(stopBtn()!.textContent).toBe('로봇 정지');
  });

  it('화면 밝기 · 로그아웃은 나 메뉴 안(시안 머리줄에 없는 칸은 나 아래로)', () => {
    mount('u-kim', R); feed(R);
    expect($('nav[aria-label="주 메뉴"] [data-theme-pick]')).toBeNull();
    expect(head().querySelector('[data-slot="who"] [data-theme-pick]')).not.toBeNull();
  });
});

describe('시안 껍데기 · 폰', () => {
  it('폰은 주 메뉴가 없고 STOP 은 머리줄에 그대로', () => {
    mount('u-lee', R, '#/drive', true); feed(R);
    expect($('nav[aria-label="주 메뉴"]')).toBeNull();
    expect(stopBtn()).not.toBeNull();
  });
});

// 11-28 결정 4: 초록 단추 글자 대비 4.5 이상(바탕 초록 값은 시안 그대로)
const lum = (hex: string) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
describe('시안 껍데기 · 초록 단추 대비', () => {
  it('어두움: #00c389 위 글자 = 시안 --ink(#1f2421) 4.5:1 이상 · 밝음(DESIGN.md 밝음 1): #18A07E 위 흑연 글자 4.5:1 이상', () => {
    const on = [...css.matchAll(/--sh-on-pr: (#[0-9a-f]{6})/g)].map((m) => m[1]);
    expect(on).toEqual(['#1f2421', '#1f2421']);
    expect(css).toMatch(/\.btn\.pri \{[^}]*color: var\(--sh-on-pr\)/);
    expect(css).toMatch(/--sh-pr3: #00c389;/);
    expect(ratio('#00c389', on[0])).toBeGreaterThanOrEqual(4.5);
    expect(ratio('#18a07e', on[1])).toBeGreaterThanOrEqual(4.5);
    expect(css).toMatch(/html \.fh\.light \{[^}]*--sh-bg: #F6F7F6;[^}]*--sh-pr3: #18A07E;/);
    expect(css).toMatch(/body:has\(\.fh\.light\) \{ background: #F6F7F6; \}/);
  });
});
