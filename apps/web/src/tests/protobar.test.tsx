// PC 시안 공통 머리줄(proto/bar · 시안 u5_1 등 모든 PC 화면의 .bar): 글 · 칸 순서 · 메뉴 이동 · STOP 늘 보임
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../App';
import { USERS, type Robot } from './fixtures';
import { FakeWS, lease, state } from './fakeWs';
import { api } from '../api';
import { rt } from '../rt';
import { vi } from 'vitest';
import { linkText, serverText, whoFace } from '../proto/bar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null, box: HTMLDivElement;
const $ = <T extends Element = HTMLElement>(s: string) => box.querySelector<T>(s)!;
const $$ = (s: string) => [...box.querySelectorAll<HTMLElement>(s)];
const R = (id: string, name: string, owner: string, online = true, sim = false): Robot => ({ id, name, owner, ownerName: owner, battery: 70, online, seenAt: '', status: 'IDLE', sim });
// 시안 이름 그대로: K-01 ~ K-08 (K-08 은 시뮬)
const EIGHT = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => R(`k${i}`, `K-0${i}`, i <= 4 ? 'u-lee' : 'u-park', i !== 8, i === 8));
function mount(user = 'u-kim', robots = EIGHT, hash = '#/control') {
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  location.hash = hash;
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<App user={USERS.find((u) => u.id === user)} robots={robots} />); });
}
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); localStorage.clear(); });

describe('PC 시안 머리줄', () => {
  it('시안 칸 순서 그대로: FOOTHOLD · 메뉴 6 · 연결 수 · 서버 · 종 · 나 · 모두 정지', () => {
    mount('u-lee');
    const bar = $('.proto > .bar');
    expect([...bar.children].map((e) => e.className)).toEqual(['logo', 'tabs', 'rt']);
    expect($('.bar .logo').textContent).toBe('FOOTHOLD');
    expect($$('.bar .tabs > span').map((e) => e.textContent)).toEqual(['관제', '로봇', '지도', '임무', '기록', '설정']);
    expect($$('.bar .tabs > span').map((e) => e.className)).toEqual(['on', '', '', '', '', '']);
    const rt = [...$('.bar .rt').children];
    expect(rt[0].classList.contains('row')).toBe(true);
    expect(rt[1].className).toBe('mu2');
    expect(rt[2].matches('[data-bell]')).toBe(true);
    expect(rt[3].querySelector('.who')).not.toBeNull();
    expect(rt[4].className).toBe('allstop');
    expect(rt[4].textContent).toBe('모두 정지');
    expect(rt).toHaveLength(5);
  });
  it('시안 글: «로봇 8 대 연결» · «서버 정상» · 나 칸 «나 총괄» / 운영자 «A 운영자 A»', () => {
    expect(linkText('ORG_ADMIN', 8)).toBe('로봇 8 대 연결');
    expect(linkText('OPERATOR', 4)).toBe('내 로봇 4 대 연결');
    expect(linkText('ORG_ADMIN', 0)).toBe('연결된 로봇 없음');
    expect(serverText('open')).toBe('서버 정상');
    expect(whoFace('ORG_ADMIN', '김총괄')).toEqual(['나', '총괄']);
    expect(whoFace('OPERATOR', '운영자 A')).toEqual(['A', '운영자 A']);
    mount('u-kim');
    expect($('.bar .rt > .row').textContent).toBe('연결된 로봇 없음');   // 실시간 상태 전에는 연결로 세지 않음
    expect($('.bar .who').textContent).toBe('나총괄');
    expect($('.bar .mu2').textContent).toBe('서버 연결 중');
    act(() => { FakeWS.last.open(); for (const r of EIGHT) if (r.online) FakeWS.last.recv(state(r.id, {})); });
    expect($('.bar .rt > .row').textContent).toBe('로봇 7 대 연결');   // 연결된 것만 (K-08 시뮬 대기)
    expect($('.bar .mu2').textContent).toBe('서버 정상');
  });
  it('메뉴를 누르면 그 탭으로 (주소 · 현재 표시 · 제목), Enter 도 같음', () => {
    mount('u-lee');
    for (const [id, label] of [['fleet', '로봇'], ['map', '지도'], ['history', '기록'], ['settings', '설정'], ['control', '관제']]) {
      act(() => { $(`.bar .tabs [data-href="#/${id}"]`).click(); window.dispatchEvent(new HashChangeEvent('hashchange')); });
      expect(location.hash).toBe(`#/${id}`);
      expect($$('.bar .tabs .on').map((e) => e.textContent)).toEqual([label]);
      expect($('h1').textContent).toBe(label);
    }
    act(() => { $('.bar .tabs [data-href="#/history"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); window.dispatchEvent(new HashChangeEvent('hashchange')); });
    expect(location.hash).toBe('#/history');
  });
  it('STOP 은 모든 탭에서 머리줄 끝에 늘 보이고 44px 이상, 누르면 정지 고르기 · Space 도 같은 길', () => {
    mount('u-lee');
    for (const id of ['control', 'fleet', 'map', 'missions', 'history', 'settings']) {
      act(() => { location.hash = `#/${id}`; window.dispatchEvent(new HashChangeEvent('hashchange')); });
      const s = $$('[aria-label="비상 정지"]');
      expect(s, id).toHaveLength(1);
      expect($('.bar .rt').lastElementChild, id).toBe(s[0]);
      expect(parseInt(s[0].style.minHeight), id).toBeGreaterThanOrEqual(44);
    }
    act(() => { location.hash = '#/control'; window.dispatchEvent(new HashChangeEvent('hashchange')); });
    act(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true })); });
    expect($('[aria-label="정지할 로봇 고르기"]')).not.toBeNull();
  });
  it('나 칸을 누르면 차림: 이름(역할) · 화면 밝기, 밝기를 바꾸면 같은 DOM 위 .proto.light', () => {
    mount('u-kim');
    expect($('[role="menu"]')).toBeNull();
    act(() => { $('.bar .who').click(); });
    expect($('[role="menu"] .fh-me').textContent).toBe('김OO(총괄)');
    while (!$('.proto').classList.contains('light')) act(() => { $<HTMLButtonElement>('[role="menu"] [data-theme-pick]').click(); });
    expect($('.proto > .bar')).not.toBeNull();
  });
  it('«K-01 조종 중» 칩 = 이 연결이 가진 조종권(rt lease · 서버 lease_id) 로봇 · 없으면 칩 없음 · STOP 은 늘 맨 끝', () => {
    mount('u-lee');
    act(() => { FakeWS.last.open(); for (const r of EIGHT) if (r.online) FakeWS.last.recv(state(r.id, {})); });
    expect($('.bar .livechip')).toBeNull();
    act(() => { FakeWS.last.recv(lease('k2', { id: 'u-park', name: '박OO' })); });   // 남의 조종권: 이 연결에 lease_id 없음
    expect($('.bar .livechip')).toBeNull();
    // 조종 화면이 열린 동안만 lease 가 남는다(rt: 떠난 화면은 반납). 머리줄은 rt 의 lease 값만 읽는다
    const real = rt.get.bind(rt), mine = new Set(['k1']);
    const spy = vi.spyOn(rt, 'get').mockImplementation((id: string) => (mine.has(id) ? { ...real(id), lease: `L-${id}` } : real(id)));
    act(() => { FakeWS.last.recv(state('k1', { speed: 0.1 })); });
    expect($('.bar .livechip').textContent).toBe('K-01 조종 중');
    expect($('.bar .rt').lastElementChild!.className).toBe('allstop');
    mine.add('k3'); act(() => { FakeWS.last.recv(state('k3', { speed: 0.1 })); });
    expect($('.bar .livechip').textContent).toBe('K-01 외 1 대 조종 중');
    mine.clear(); act(() => { FakeWS.last.recv(state('k1', { speed: 0 })); });
    expect($('.bar .livechip')).toBeNull();
    spy.mockRestore();
  });
  it('총괄: 결재 대기 수(GET /dashboard) = 메뉴 끝 작은 표 · 0 이면 숨김 · 누르면 결재 · 운영 관리자는 없음', async () => {
    const d = vi.spyOn(api, 'dashboard').mockResolvedValue({ robots_total: 8, robots_online: 7, robots_attention: 0, robots_running: 0, approvals_pending: 3, operators: [] } as never);
    mount('u-kim');
    await act(async () => {});
    const ap = $('.bar .tabs [data-approvals]');
    expect([ap.dataset.approvals, ap.hidden, ap.textContent]).toEqual(['3', false, '결재 3']);
    act(() => { ap.click(); window.dispatchEvent(new HashChangeEvent('hashchange')); });
    expect(location.hash).toBe('#/approval');
    act(() => root?.unmount()); root = null; box.remove();
    d.mockResolvedValue({ robots_total: 8, robots_online: 7, robots_attention: 0, robots_running: 0, approvals_pending: 0, operators: [] } as never);
    mount('u-kim');
    await act(async () => {});
    expect($('.bar [data-approvals]').hidden).toBe(true);
    act(() => root?.unmount()); root = null; box.remove();
    mount('u-lee');
    expect($('.bar [data-approvals]')).toBeNull();
    d.mockRestore();
  });
});
