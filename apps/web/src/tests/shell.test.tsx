import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../App';
import { USERS } from '../fake';
import { PC_BOTTOM, PC_TABS, PHONE_TABS, labelOf, tabFromHash, tabsFor } from '../menu';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null, box: HTMLDivElement;
function mount(phone: boolean, user = 'u-kim', hash = '') {
  window.matchMedia = ((q: string) => ({ matches: phone, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  location.hash = hash;
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<App initialUser={user} />); });
}
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); });

const $ = <T extends Element = HTMLElement>(s: string) => box.querySelector<T>(s)!;
const $$ = (s: string) => [...box.querySelectorAll<HTMLElement>(s)];
const navLabels = () => $$('nav[aria-label="주 메뉴"] a').map((a) => a.childNodes[1].textContent);
const click = (el: Element) => act(() => { (el as HTMLElement).click(); });
const robotRow = (name: string) => $$('[aria-label="로봇 목록"] button').find((b) => b.textContent!.includes(name))!;
function pickUser(id: string) {
  const s = $<HTMLSelectElement>('select[aria-label="사용자"]');
  act(() => { s.value = id; s.dispatchEvent(new Event('change', { bubbles: true })); });
}

describe('메뉴 정의(한 곳)', () => {
  it('PC 6탭 + 설정, 폰 3탭', () => {
    expect([...PC_TABS, PC_BOTTOM].map((t) => labelOf(t, 'ORG_ADMIN'))).toEqual(['관제', '조종', '임무', '결재', '기록', '지도', '설정']);
    expect(PHONE_TABS.map((t) => labelOf(t, 'OPERATOR'))).toEqual(['조종', '시나리오', '기록']);
  });
  it('운영자는 결재 탭 이름이 «내 요청»', () => {
    expect(labelOf(PC_TABS[3], 'OPERATOR')).toBe('내 요청');
  });
  it('주소의 탭이 이 틀에 없으면 첫 탭', () => {
    expect(tabFromHash('#/map', false)).toBe('map');
    expect(tabFromHash('#/map', true)).toBe('drive');
    expect(tabFromHash('', false)).toBe('fleet');
  });
});

describe('탭 전환', () => {
  it('PC: 메뉴를 누르면 제목·본문·현재 표시가 그 탭으로', () => {
    mount(false);
    expect(navLabels()).toEqual(['관제', '조종', '임무', '결재', '기록', '지도', '설정']);
    for (const t of tabsFor(false)) {
      click($(`nav a[href="#/${t.id}"]`));
      const l = labelOf(t, 'ORG_ADMIN');
      expect($('h1').textContent).toBe(l);
      expect($('main').getAttribute('aria-label')).toBe(l);
      expect($$('nav a[aria-current="page"]').map((a) => a.getAttribute('href'))).toEqual([`#/${t.id}`]);
    }
  });
  it('폰: 하단 탭 3개만, 누르면 본문이 바뀜', () => {
    mount(true, 'u-lee');
    expect(navLabels()).toEqual(['조종', '시나리오', '기록']);
    click($('nav a[href="#/scenario"]'));
    expect($('main').getAttribute('aria-label')).toBe('시나리오');
    expect($('main').textContent).toContain('2층 순찰');
  });
});

describe('역할 전환', () => {
  it('운영자로 바꾸면 «내 요청»이 보이고 남의 로봇 조종 단추는 비활성 + 이유', () => {
    mount(false);
    click(robotRow('Go2-7'));
    expect($<HTMLButtonElement>('[aria-label="로봇 상세"] .btn.pri').disabled).toBe(false);   // 총괄은 남의 로봇도 조종

    pickUser('u-lee');
    expect(navLabels()).toContain('내 요청');
    expect(navLabels()).not.toContain('결재');
    expect($$('[aria-label="로봇 목록"] b').map((b) => b.textContent)).toEqual(['Go2-3', 'Go2-1', 'Go2-7']);   // 내 로봇 먼저

    click(robotRow('Go2-7'));
    const btn = $<HTMLButtonElement>('[aria-label="로봇 상세"] .btn.pri');
    expect(btn.disabled).toBe(true);
    expect(document.getElementById(btn.getAttribute('aria-describedby')!)!.textContent).toContain('박OO님의 로봇입니다');

    click(robotRow('Go2-3'));
    expect($<HTMLButtonElement>('[aria-label="로봇 상세"] .btn.pri').disabled).toBe(false);

    click(robotRow('Go2-7'));
    click($('nav a[href="#/drive"]'));
    expect($<HTMLButtonElement>('[aria-label="조종"] .btn.pri').disabled).toBe(true);
    expect($('[aria-label="조종"] [data-why]').textContent).toContain('내 로봇만 조종할 수 있습니다');
  });
  it('운영자 «내 요청»에는 내가 낸 요청만', () => {
    mount(false, 'u-lee', '#/approval');
    expect($('h1').textContent).toBe('내 요청');
    expect($('main').textContent).toContain('2층 순찰 → Go2-3');
    expect($('main').textContent).not.toContain('본관 2층');
  });
});

describe('STOP 상시 표시', () => {
  for (const phone of [false, true]) for (const u of USERS) it(`${phone ? '폰' : 'PC'} · ${u.name}: 모든 탭에 STOP 1개 + 상태 띠 자리`, () => {
    mount(phone, u.id);
    for (const t of tabsFor(phone)) {
      click($(`nav a[href="#/${t.id}"]`));
      const s = $$('[aria-label="비상 정지"]');
      expect(s).toHaveLength(1);
      expect(s[0].closest('header')).not.toBeNull();
      expect(parseInt(s[0].style.minHeight)).toBeGreaterThanOrEqual(phone ? 64 : 44);
      expect($('[data-band][role="status"]')).not.toBeNull();
    }
  });
  it('STOP 을 누르면 띠에 «정지 요청됨»', () => {
    mount(false);
    click($('[aria-label="비상 정지"]'));
    expect($('[data-band]').textContent).toContain('정지 요청됨');
  });
});

// 03 UX §2 운영 화면 금지어
const BANNED = [/관문/, /링크/, /명령 0/, /deadman/i, /Gazebo/i, /GT/, /v2/, /rad\/s/, /HTTP\s*\d/, /\b[0-9a-f]{7,}\b/i, /미제공/, /원값/, /리허설/, /배치안/, /SLAM/, /Nav2/];
describe('금지어 0', () => {
  for (const phone of [false, true]) for (const u of USERS) it(`${phone ? '폰' : 'PC'} · ${u.name}`, () => {
    mount(phone, u.id);
    for (const t of tabsFor(phone)) {
      click($(`nav a[href="#/${t.id}"]`));
      const text = box.textContent + ' ' + $$('[aria-label]').map((e) => e.getAttribute('aria-label')).join(' ');
      for (const b of BANNED) expect(text, `${t.id}: ${b}`).not.toMatch(b);
    }
  });
});

// 디자인 원본을 값 그대로 옮겼는지: apps/web/public/brand 가 ui/public/brand 와 바이트 단위로 같음
describe('브랜드 원본 사본', () => {
  it('토큰·로고·정책 파일이 원본과 같다', () => {
    const mine = import.meta.glob('../../public/brand/**/*', { query: '?raw', import: 'default', eager: true });
    const orig = import.meta.glob('../../../../ui/public/brand/**/*', { query: '?raw', import: 'default', eager: true });
    const key = (p: string) => p.slice(p.indexOf('public/brand/'));
    const a = Object.fromEntries(Object.entries(mine).map(([p, v]) => [key(p), v]));
    const b = Object.fromEntries(Object.entries(orig).map(([p, v]) => [key(p), v]));
    expect(Object.keys(a).length).toBeGreaterThan(5);
    expect(a).toEqual(b);
  });
});
