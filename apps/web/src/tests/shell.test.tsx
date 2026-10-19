import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { ROBOTS, USERS, type Robot } from '../fake';
import { PC_BOTTOM, PC_TABS, PHONE_TABS, labelOf, tabFromHash, tabsFor } from '../menu';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null, box: HTMLDivElement;
// matchMedia 모의: 폭 변경 이벤트까지 흉내(resize(true/false) 로 768px 경계를 넘김)
let isPhone = false, listeners = new Set<() => void>();
/** robots = 서버 /robots 응답(기본 = 가짜 3대 전부). 운영 관리자 scope=mine 응답은 mine(id) */
function mount(phone: boolean, user = 'u-kim', hash = '', robots: Robot[] = ROBOTS) {
  isPhone = phone; listeners = new Set();
  window.matchMedia = ((q: string) => ({ get matches() { return isPhone; }, media: q,
    addEventListener(_e: string, f: () => void) { listeners.add(f); }, removeEventListener(_e: string, f: () => void) { listeners.delete(f); } })) as unknown as typeof window.matchMedia;
  location.hash = hash;
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<App user={USERS.find((u) => u.id === user)} robots={robots} />); });
}
const resize = (phone: boolean) => act(() => { isPhone = phone; listeners.forEach((f) => f()); });
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); vi.restoreAllMocks(); });

const $ = <T extends Element = HTMLElement>(s: string) => box.querySelector<T>(s)!;
const $$ = (s: string) => [...box.querySelectorAll<HTMLElement>(s)];
const navLabels = () => $$('nav[aria-label="주 메뉴"] a').map((a) => a.childNodes[1].textContent);
const click = (el: Element) => act(() => { (el as HTMLElement).click(); });
const robotRow = (name: string) => $$('[aria-label="로봇 목록"] button').find((b) => b.textContent!.includes(name))!;
const mine = (id: string) => ROBOTS.filter((r) => r.owner === id);
/** 다른 사람으로 로그인한 것처럼 같은 틀을 다시 그림(가짜 역할 전환 고르개는 없앰 — 역할은 서버 /me) */
const pickUser = (id: string) => act(() => { root!.render(<App user={USERS.find((u) => u.id === id)} robots={ROBOTS} />); });

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
    expect($$('[aria-label="로봇 목록"] b').map((b) => b.textContent)).toEqual(['Go2-3', 'Go2-7', 'Go2-1']);   // 서버 응답 순서 그대로

    click(robotRow('Go2-7'));
    const btn = $<HTMLButtonElement>('[aria-label="로봇 상세"] .btn.pri');
    expect(btn.disabled).toBe(true);
    expect(document.getElementById(btn.getAttribute('aria-describedby')!)!.textContent).toContain('박OO님의 로봇입니다');

    click(robotRow('Go2-3'));
    expect($<HTMLButtonElement>('[aria-label="로봇 상세"] .btn.pri').disabled).toBe(false);

    click($('nav a[href="#/drive"]'));   // 조종 탭: 로봇 고르기(F-TO-01) → 남의 로봇은 «보기» + 이유
    const card = $$('.dv-card').find((li) => li.textContent!.includes('Go2-7'))!;
    expect(card.querySelector('[data-why]')!.textContent).toContain('내 로봇만 조종할 수 있습니다');
    click(card.querySelector('button')!);
    const start = $$('[aria-label="조종"] button').find((b) => b.textContent === '조종 시작') as HTMLButtonElement;
    expect(start.disabled).toBe(true);
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
const BANNED = [/정지·잠금 상태입니다/, /관문/, /링크/, /명령 0/, /deadman/i, /Gazebo/i, /GT/, /v2/, /rad\/s/, /HTTP\s*\d/, /\b[0-9a-f]{7,}\b/i, /미제공/, /원값/, /리허설/, /배치안/, /SLAM/, /Nav2/];
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

// ── PR #5 검토(Codex) 막는 것 B1~B4 회귀. 검토자 재현 5개(runs/review-pr5-probe.test.tsx)를 옮기고 범위를 넓힘
describe('B1 폭 전환', () => {
  it('[재현] PC 관제에서 폰 폭으로 바뀌어도 STOP을 유지한다', () => {
    mount(false, 'u-lee', '#/fleet');
    expect(() => resize(true)).not.toThrow();
    expect($('[data-stop]')).not.toBeNull();
  });
  it('[재현] 폰 시나리오에서 PC 폭으로 바뀌어도 STOP을 유지한다', () => {
    mount(true, 'u-lee', '#/scenario');
    expect(() => resize(false)).not.toThrow();
    expect($('[data-stop]')).not.toBeNull();
  });
  it('양방향 전환: 본문·제목·현재 표시·주소가 지금 틀의 유효한 탭', () => {
    mount(false, 'u-lee', '#/map');
    resize(true);
    expect($('main').getAttribute('aria-label')).toBe('조종');
    expect($('nav a[aria-current="page"]').getAttribute('href')).toBe('#/drive');
    expect(location.hash).toBe('#/drive');
    resize(false);
    expect($('h1').textContent).toBe('조종');
    expect($('main').textContent).toContain('조종할 로봇');
  });
});

describe('B2 연결 끊김 문구', () => {
  it('[재현] 연결 끊김 띠는 마지막 확인과 현재 미확인을 표시한다', () => {
    mount(false, 'u-lee', '#/fleet');
    const text = $('[data-band]').textContent!;
    expect(text).toContain('마지막 확인: 정지 잠금(13:40:05)');
    expect(text).toContain('지금 상태는 알 수 없습니다');
    expect(text).not.toContain('로봇은 정지·잠금 상태입니다');
  });
  it('기록의 끊김 사건도 마지막 확인 + 미확인(02 F-LG-02)', () => {
    mount(false, 'u-kim', '#/history');
    expect($('main').textContent).toContain('마지막 확인 상태: 정지 잠금. 이후 상태는 확인되지 않았습니다.');
  });
});

describe('B3 기록 범위', () => {
  const hist = (u: string) => { mount(false, u, '#/history'); return $('main').textContent!; };
  it('[재현] 박OO의 PC 기록에는 이OO 로봇의 사건이 없다', () => {
    expect(hist('u-park')).not.toContain('Go2-3이 계획 경로에서');
  });
  it('운영자: 내 로봇 사건 + 남의 로봇에서 한 내 행동만', () => {
    const park = hist('u-park');
    expect(park).toContain('Go2-7 배터리');
    expect(park).toContain('박OO님이 Go2-3 STOP');   // 내 행동
    expect(park).not.toContain('이OO님이 Go2-3 조종을 끝냈습니다');
    expect(park).not.toContain('Go2-1과 연결이 끊겼습니다');
    act(() => root?.unmount()); box.remove();
    const lee = hist('u-lee');
    expect(lee).toContain('Go2-3이 계획 경로에서');
    expect(lee).toContain('Go2-1과 연결이 끊겼습니다');
    expect(lee).not.toContain('Go2-7 배터리');
  });
  it('총괄은 전체', () => {
    const kim = hist('u-kim');
    for (const t of ['Go2-3이 계획 경로에서', 'Go2-7 배터리', 'Go2-1과 연결이 끊겼습니다']) expect(kim).toContain(t);
  });
});

// 로봇 범위는 서버가 정한다(운영 관리자 GET /robots?scope=mine). 화면은 받은 목록 그대로 — 아래는 담당만 받은 운영자
describe('B4 폰 로봇 범위', () => {
  const options = () => [...box.querySelectorAll('select[aria-label="로봇 고르기"] option')].map((o) => o.textContent);
  it('[재현] 폰 운영자 로봇 선택에는 담당 로봇만 나온다', () => {
    mount(true, 'u-park', '#/history', mine('u-park'));
    expect(options()).toEqual(['Go2-7']);
  });
  it('PC 에서 폰으로 바뀌어도 받은 로봇만, 남의 시나리오·기록 0', () => {
    mount(false, 'u-park', '#/fleet', mine('u-park'));
    expect($$('[aria-label="로봇 목록"] b').map((b) => b.textContent)).toEqual(['Go2-7']);
    resize(true);
    expect($<HTMLSelectElement>('select[aria-label="로봇 고르기"]').value).toBe('r7');
    click($('nav a[href="#/scenario"]'));
    expect($('main').textContent).not.toContain('2층 순찰');
    click($('nav a[href="#/history"]'));
    expect($('main').textContent).not.toContain('Go2-3');
  });
  it('끊김 띠도 받은 로봇만', () => {
    mount(true, 'u-park', '#/drive', mine('u-park'));
    expect($('[data-band]').textContent).not.toContain('Go2-1');
  });
});

describe('R2·R3 보강', () => {
  it('STOP 은 머리줄 맨 오른쪽(마지막) 요소 — PC·폰', () => {
    for (const phone of [false, true]) {
      mount(phone, 'u-lee', '#/history');
      expect($('header').lastElementChild).toBe($('[data-stop]'));
      act(() => root?.unmount()); box.remove();
    }
    mount(false);
  });
  it('탭마다 그 탭 본문 고유 내용이 보인다', () => {
    const MARK: Record<string, string> = { fleet: '주의 필요', drive: '조종할 로봇', mission: '새 시나리오', approval: '결재함', history: '계획 경로에서', map: '편집', settings: '화면 밝기' };
    mount(false);
    for (const [id, m] of Object.entries(MARK)) {
      click($(`nav a[href="#/${id}"]`));
      const text = $('main').textContent!;
      expect(text, id).toContain(m);
      for (const [o, om] of Object.entries(MARK)) if (o !== id) expect(text, `${id} 에 ${o} 내용`).not.toContain(om);
    }
  });
  it('미구현 단추는 비활성 + «준비 중» 글에 이어짐', () => {
    mount(false, 'u-kim', '#/approval');
    const b = $$('main button').find((x) => x.textContent === '승인') as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    expect(document.getElementById(b.getAttribute('aria-describedby')!)!.textContent).toContain('준비 중');
  });
});
