import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { ROBOTS, USERS, type Robot } from './fixtures';
import { PC_BOTTOM, PC_TABS, PHONE_SHEETS, PHONE_TABS, labelOf, tabFromHash, tabsFor } from '../menu';
import { FakeWS, state } from './fakeWs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null, box: HTMLDivElement;
// matchMedia 모의: 폭 변경 이벤트까지 흉내(resize(true/false) 로 768px 경계를 넘김)
let isPhone = false, listeners = new Set<() => void>();
/** robots = 서버 /robots?scope=all 응답(기본 = 가짜 3대 전부) */
function mount(phone: boolean, user = 'u-kim', hash = '', robots: Robot[] = ROBOTS) {
  isPhone = phone; listeners = new Set();
  window.matchMedia = ((q: string) => ({ get matches() { return isPhone; }, media: q,
    addEventListener(_e: string, f: () => void) { listeners.add(f); }, removeEventListener(_e: string, f: () => void) { listeners.delete(f); } })) as unknown as typeof window.matchMedia;
  location.hash = hash;
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<App user={USERS.find((u) => u.id === user)} robots={robots} />); });
}
/** 실시간 연결을 열고 목록 값과 같은 첫 state 를 보냄(서버는 에이전트 없는 로봇도 OFFLINE state 를 보낸다) */
const feed = (robots: Robot[] = ROBOTS) => act(() => {
  FakeWS.last.open();
  for (const r of robots) FakeWS.last.recv(r.online ? state(r.id, { status: r.status, battery: r.battery == null ? null : { soc: r.battery, updated_at: '' } })
    : state(r.id, { connection: 'OFFLINE', status: null, battery: null, latched: null, stop_gen: null, applied: null }));
});
const resize = (phone: boolean) => act(() => { isPhone = phone; listeners.forEach((f) => f()); });
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); vi.restoreAllMocks(); });

const $ = <T extends Element = HTMLElement>(s: string) => box.querySelector<T>(s)!;
const $$ = (s: string) => [...box.querySelectorAll<HTMLElement>(s)];
const navLabels = () => $$('nav[aria-label="주 메뉴"] a').map((a) => a.childNodes[1].textContent);
const click = (el: Element) => act(() => { (el as HTMLElement).click(); });
const robotRow = (name: string) => $$('[aria-label="로봇 목록"] button').find((b) => b.textContent!.includes(name))!;
/** 다른 사람으로 로그인한 것처럼 같은 틀을 다시 그림(가짜 역할 전환 고르개는 없앰 — 역할은 서버 /me) */
const pickUser = (id: string) => act(() => { root!.render(<App user={USERS.find((u) => u.id === id)} robots={ROBOTS} />); });
const remount = (phone: boolean, user: string, hash: string) => { act(() => root?.unmount()); box.remove(); mount(phone, user, hash); };
/** 폰 화면 전부: 로봇 연결, 내 첫 로봇 조종 화면, 그 화면의 시트 4개, 기록 */
const PHONE_FIRST: Record<string, string> = { 'u-kim': 'r3', 'u-lee': 'r3', 'u-park': 'r7' };
function eachPhoneScreen(user: string, f: (where: string) => void) {
  for (const h of ['#/drive', `#/drive/${PHONE_FIRST[user]}`, '#/history']) {
    remount(true, user, h); f(h);
    if (h === '#/drive') continue;
    if (h === '#/history') continue;
    for (const s of PHONE_SHEETS) { click($$('[aria-label="조종 메뉴"] button').find((b) => b.textContent === s.label)!); f(`${h} 시트 ${s.label}`); }
  }
}
const cardNames = () => $$('.dv-card b').map((b) => b.textContent);

describe('메뉴 정의(한 곳)', () => {
  it('PC 메뉴 6개(조종 탭 없음), 폰은 조종·기록 화면 + 아래 줄 시트 4개', () => {
    expect([...PC_TABS, PC_BOTTOM].map((t) => labelOf(t, 'ORG_ADMIN'))).toEqual(['로봇', '결재', '시나리오', '지도', '기록', '설정']);
    expect(PHONE_TABS.map((t) => labelOf(t, 'OPERATOR'))).toEqual(['조종', '기록']);
    expect(PHONE_SHEETS.map((t) => t.label)).toEqual(['자세', '시나리오', '지도·목표', '정책']);
  });
  it('운영자는 결재 탭 이름이 «내 요청»', () => {
    expect(labelOf(PC_TABS[1], 'OPERATOR')).toBe('내 요청');
  });
  it('주소의 탭이 이 틀에 없으면 첫 탭(PC 옛 #/drive → 로봇)', () => {
    expect(tabFromHash('#/map', false)).toBe('map');
    expect(tabFromHash('#/map', true)).toBe('drive');
    expect(tabFromHash('', false)).toBe('fleet');
    expect(tabFromHash('#/drive', false)).toBe('fleet');
    expect(tabFromHash('#/drive/r7', false)).toBe('fleet');
  });
});

describe('탭 전환', () => {
  it('PC: 메뉴를 누르면 제목·본문·현재 표시가 그 탭으로', () => {
    mount(false);
    expect(navLabels()).toEqual(['로봇', '결재', '시나리오', '지도', '기록', '설정']);
    expect($('nav a[href="#/drive"]')).toBeNull();
    for (const t of tabsFor(false)) {
      click($(`nav a[href="#/${t.id}"]`));
      const l = labelOf(t, 'ORG_ADMIN');
      expect($('h1').textContent).toBe(l);
      expect($('main').getAttribute('aria-label')).toBe(l);
      expect($$('nav a[aria-current="page"]').map((a) => a.getAttribute('href'))).toEqual([`#/${t.id}`]);
    }
  });
  for (const h of ['#/drive', '#/drive/r7']) it(`PC 옛 주소 ${h} → 로봇 탭(조종 화면 없음)`, () => {
    mount(false, 'u-kim', h);
    expect($('h1').textContent).toBe('로봇');
    expect(location.hash).toBe('#/fleet');
    expect($('[aria-label="조종"]')).toBeNull();
    expect($('nav a[aria-current="page"]').getAttribute('href')).toBe('#/fleet');
  });
  it('PC 로봇 목록: 행마다 «마지막 수신» 시각, 상세에 조종 단추 없음', () => {
    mount(false); feed();
    expect($$('[aria-label="로봇 목록"] [data-seen]').map((e) => e.textContent)).toEqual(expect.arrayContaining(['마지막 수신 13:40:05']));
    expect($$('[aria-label="로봇 목록"] [data-seen]')).toHaveLength(3);
    expect($$('main button').filter((b) => /조종/.test(b.textContent!))).toEqual([]);
  });
  it('폰: 아래 탭 줄 없음, 처음은 «로봇 연결»(내 로봇 + 시뮬 로봇 띄우기)', () => {
    mount(true, 'u-lee');
    expect($('nav')).toBeNull();
    expect($('main').getAttribute('aria-label')).toBe('로봇 연결');
    expect(cardNames()).toEqual(['Go2-3', 'Go2-1']);
    // 월드 목록을 받기 전에는 띄우기를 못 누름(흐름 전체는 phone.test.tsx)
    const go = [...$('[aria-label="시뮬 로봇 띄우기"]').querySelectorAll('button')].find((b) => b.textContent === '띄우기')!;
    expect(go.disabled).toBe(true);
  });
});

describe('역할 전환', () => {
  it('운영자로 바꾸면 «내 요청»이 보이고 남의 로봇은 보기 전용, 폰에는 내 로봇만', () => {
    mount(false); feed();
    pickUser('u-lee');
    expect(navLabels()).toContain('내 요청');
    expect(navLabels()).not.toContain('결재');
    expect($$('[aria-label="로봇 목록"] b').map((b) => b.textContent)).toEqual(['Go2-3', 'Go2-1', 'Go2-7']);   // 내 로봇 먼저, 남의 로봇은 보기 전용
    expect(robotRow('Go2-7').textContent).toContain('보기 전용');
    resize(true);
    expect(cardNames()).toEqual(['Go2-3', 'Go2-1']);
  });
  it('운영자 결재 탭 = «내 요청»(목록은 서버가 본인 것만 — tests/approvals.test.tsx)', () => {
    mount(false, 'u-lee', '#/approval');
    expect($('h1').textContent).toBe('내 요청');
    expect($('main section[aria-label="내 요청"]')).not.toBeNull();
  });
});

describe('STOP 상시 표시', () => {
  const one = (phone: boolean, where: string) => {
    const s = $$('[aria-label="비상 정지"]');
    expect(s, where).toHaveLength(1);
    expect(s[0].closest('header'), where).not.toBeNull();
    expect($('header').lastElementChild, where).toBe(s[0]);
    expect(s[0].closest('[data-sheet]'), where).toBeNull();
    expect(parseInt(s[0].style.minHeight), where).toBeGreaterThanOrEqual(phone ? 64 : 44);
    expect($('[data-band][role="status"]'), where).not.toBeNull();
  };
  for (const u of USERS) it(`PC · ${u.name}: 모든 탭에 STOP 1개 + 상태 띠 자리`, () => {
    mount(false, u.id);
    for (const t of tabsFor(false)) { click($(`nav a[href="#/${t.id}"]`)); one(false, t.id); }
  });
  for (const u of USERS) it(`폰 · ${u.name}: 로봇 연결·조종·시트 4개·기록에 STOP 1개(64px) + 상태 띠 자리`, () => {
    mount(true, u.id);
    eachPhoneScreen(u.id, (where) => one(true, where));
  });
  it('STOP 을 누르면 실시간 연결로 보내고, 서버가 받으면 띠에 «정지 요청됨»', () => {
    mount(false);
    act(() => FakeWS.last.open());
    click($('[aria-label="비상 정지"]'));
    expect(FakeWS.last.of('stop')).toMatchObject([{ robot: 'r3' }]);
    expect($('[data-band]').textContent).toContain('Go2-3 정지 요청됨');
  });
});

// 03 UX §2 운영 화면 금지어
const BANNED = [/정지·잠금 상태입니다/, /관문/, /링크/, /명령 0/, /deadman/i, /Gazebo/i, /GT/, /v2/, /rad\/s/, /HTTP\s*\d/, /\b[0-9a-f]{7,}\b/i, /미제공/, /원값/, /리허설/, /배치안/, /SLAM/, /Nav2/];
describe('금지어 0', () => {
  const none = (where: string) => {
    const text = box.textContent + ' ' + $$('[aria-label]').map((e) => e.getAttribute('aria-label')).join(' ');
    for (const b of BANNED) expect(text, `${where}: ${b}`).not.toMatch(b);
  };
  for (const u of USERS) it(`PC · ${u.name}`, () => {
    mount(false, u.id);
    for (const t of tabsFor(false)) { click($(`nav a[href="#/${t.id}"]`)); none(t.id); }
  });
  for (const u of USERS) it(`폰 · ${u.name}`, () => {
    mount(true, u.id);
    eachPhoneScreen(u.id, none);
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
  it('[재현] 폰 조종 화면에서 PC 폭으로 바뀌어도 STOP을 유지한다', () => {
    mount(true, 'u-lee', '#/drive/r3');
    expect(() => resize(false)).not.toThrow();
    expect($('[data-stop]')).not.toBeNull();
  });
  it('양방향 전환: 본문·제목·현재 표시·주소가 지금 틀의 유효한 탭', () => {
    mount(false, 'u-lee', '#/map');
    resize(true);
    expect($('main').getAttribute('aria-label')).toBe('로봇 연결');
    expect($('nav')).toBeNull();
    expect(location.hash).toBe('#/drive');
    resize(false);
    expect($('h1').textContent).toBe('로봇');
    expect(location.hash).toBe('#/fleet');
    expect($('nav a[aria-current="page"]').getAttribute('href')).toBe('#/fleet');
    expect($('main').textContent).toContain('주의 필요');
  });
});

describe('B2 연결 끊김 문구', () => {
  it('[재현] 연결 끊김 띠는 마지막 확인과 현재 미확인을 표시한다', () => {
    mount(false, 'u-lee', '#/fleet'); feed();
    const text = $('[data-band]').textContent!;
    expect(text).toContain('마지막 확인: 정지 잠금(13:40:05)');
    expect(text).toContain('지금 상태는 알 수 없습니다');
    expect(text).not.toContain('로봇은 정지·잠금 상태입니다');
  });
});

// 기록 범위·문장(B3·F-LG-02)은 이제 서버가 정한다 — events.test.tsx 가 가짜 서버로 본다(화면은 받은 것만 그린다)

// 서버는 전체(scope=all)를 주고, 폰은 내 로봇만(02 §1.2)
describe('B4 폰 로봇 범위', () => {
  it('[재현] 폰 운영자 로봇 연결에는 담당 로봇만 나온다', () => {
    mount(true, 'u-park', '#/drive');
    expect(cardNames()).toEqual(['Go2-7']);
  });
  it('PC 에서 남의 로봇을 고른 채 폰으로 바뀌면 내 로봇만, 남의 시나리오·기록 0', () => {
    mount(false, 'u-park', '#/fleet');
    click(robotRow('Go2-3'));
    resize(true);
    expect(cardNames()).toEqual(['Go2-7']);
    click($$('.dv-card button')[0]);
    expect(location.hash).toBe('#/drive/r7');
    click($$('[aria-label="조종 메뉴"] button').find((b) => b.textContent === '시나리오')!);
    expect($('[data-sheet]').textContent).toContain('배정된 시나리오');   // 이 로봇(r7) 것만 서버에 묻는다 — assign.test
    expect($('main').textContent).not.toContain('2층 순찰');
    click($$('header details button').find((b) => b.textContent === '기록')!);
    expect(location.hash).toBe('#/history');
    expect($('main').textContent).not.toContain('Go2-3');
  });
  it('끊김 띠도 폰에서는 내 로봇만', () => {
    mount(true, 'u-park', '#/drive');
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
    const MARK: Record<string, string> = { fleet: '주의 필요', mission: '새 시나리오', approval: '결재함', history: '내보내기', map: '장소 목록', settings: '화면 밝기' };
    mount(false);
    for (const [id, m] of Object.entries(MARK)) {
      click($(`nav a[href="#/${id}"]`));
      const text = $('main').textContent!;
      expect(text, id).toContain(m);
      for (const [o, om] of Object.entries(MARK)) if (o !== id) expect(text, `${id} 에 ${o} 내용`).not.toContain(om);
    }
  });
  it('미구현 단추는 비활성 + «준비 중» 글에 이어짐', () => {
    mount(true, 'u-lee', '#/drive/r3');   // 폰 «시뮬 로봇 띄우기»·PC 임무 탭은 이제 서버 값 — 자세 시트 «서기»는 아직 준비 중
    click($$('main button').find((x) => x.textContent === '자세')!);
    const b = $$('main button').find((x) => x.textContent === '서기') as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    expect(document.getElementById(b.getAttribute('aria-describedby')!)!.textContent).toContain('준비 중');
  });
});
