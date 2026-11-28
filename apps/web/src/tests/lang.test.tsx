// 화면 언어(시안 u9_6): 사전으로 그려진 글을 바꿈 · React 가 글을 바꿔도 따라감 · 한국어로 되돌림 · translate="no" 는 그대로 · 이 기기에 기억
// 1 차 범위(머리줄 · 설정): 영어로 고르면 설정 모든 묶음 · 머리줄에 한글이 남지 않음(서버 값 · 이름 빼고)
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { applyLang, en, langPref, setLang, syncLang } from '../lang';
import { App } from '../App';
import { USERS, type Robot } from './fixtures';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null, box: HTMLDivElement, stop: (() => void) | null = null;
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); stop?.(); stop = null; act(() => setLang('ko')); localStorage.clear(); });
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); });
const hangul = (el: Element) => {
  const out: string[] = [], w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) if (/[가-힣]/.test(n.nodeValue!) && !n.parentElement!.closest('[translate="no"]')) out.push(n.nodeValue!.trim());
  el.querySelectorAll('[aria-label],[title],[placeholder]').forEach((e) => { if (e.closest('[translate="no"]')) return; for (const a of ['aria-label', 'title', 'placeholder']) { const v = e.getAttribute(a); if (v && /[가-힣]/.test(v)) out.push('@' + v); } });
  return out;
};

describe('사전 · 규칙', () => {
  it('글 그대로 · 앞뒤 빈칸 유지 · 값이 섞인 글은 규칙 · 모르는 글과 한글 없는 글은 null', () => {
    expect(en('설정')).toBe('Settings');
    expect(en(' 모두 정지 ')).toBe(' Stop all ');
    expect(en('로봇 8 대 연결')).toBe('8 robots connected');
    expect(en('K-01 정지')).toBe('Stop K-01');
    expect(en('오늘 19:35')).toBe('Today 19:35');
    expect(en('11/20 에 바꿈')).toBe('Changed 11/20');
    expect(en('김OO(총괄)')).toBe('김OO (Admin)');
    expect(en('운영자 A')).toBeNull();
    expect(en('K-01')).toBeNull();
  });
  it('관제 · 로봇 탭 값 글: 관절 이름 두 꼴 · 단계 · 타일 · 분 · 건수', () => {
    expect(en('위험 · 오른쪽 앞다리 고관절 71 °C')).toBe('Danger · Front-right hip 71 °C');
    expect(en('앞 오른 고관절 71 °C · 경고')).toBe('Front-right hip 71 °C · Warning');
    expect(en('왼쪽 뒷다리 무릎')).toBe('Rear-left knee');
    expect(en('오른쪽 앞다리 고관절이 71 °C 입니다.')).toBe('Front-right hip is 71 °C.');
    expect(en('K-01 타일')).toBe('K-01 tile');
    expect(en('K-02 · 정지 잠금')).toBe('K-02 · stop latched');
    expect(en('약 108 분')).toBe('about 108 min');
    expect(en('알림 안 읽음 77건')).toBe('77 unread alerts');
    expect(en('50 만 m²')).toBe('500,000 m²');
    expect(en('연결 · 시스템')).toBe('Link · system');
    expect(en('공정 C 배관 밑')).toBeNull();   // 서버가 준 자리 이름은 그대로
  });
});

describe('그려진 글 바꾸기', () => {
  function Demo() {
    const [n, setN] = useState(0);
    return <div><b data-a>설정</b><button type="button" aria-label="비상 정지" onClick={() => setN(n + 1)}>{n ? '모두 정지' : '정지'}</button>
      <span translate="no" data-keep>정지됨</span><i data-name>운영자 A</i></div>;
  }
  it('영어 → 바뀜, React 가 글을 바꾸면 다시 바뀜, 한국어 → 원래 글, 고른 값은 이 기기에 기억', async () => {
    box = document.createElement('div'); document.body.append(box);
    stop = syncLang(box);
    act(() => { root = createRoot(box); root.render(<Demo />); });
    expect(box.querySelector('[data-a]')!.textContent).toBe('설정');
    act(() => setLang('en')); await flush();
    expect(langPref()).toBe('en'); expect(localStorage.getItem('fh.lang')).toBe('en'); expect(document.documentElement.lang).toBe('en');
    expect(box.querySelector('[data-a]')!.textContent).toBe('Settings');
    expect(box.querySelector('button')!.textContent).toBe('Stop');
    expect(box.querySelector('button')!.getAttribute('aria-label')).toBe('Emergency stop');
    expect(box.querySelector('[data-keep]')!.textContent).toBe('정지됨');
    expect(box.querySelector('[data-name]')!.textContent).toBe('운영자 A');
    await act(async () => { box.querySelector('button')!.click(); }); await flush();
    expect(box.querySelector('button')!.textContent).toBe('Stop all');
    act(() => setLang('ko')); await flush();
    expect(box.querySelector('[data-a]')!.textContent).toBe('설정');
    expect(box.querySelector('button')!.textContent).toBe('모두 정지');
    expect(box.querySelector('button')!.getAttribute('aria-label')).toBe('비상 정지');
  });
  it('저장을 못 읽으면 한국어', () => {
    const get = Storage.prototype.getItem;
    Storage.prototype.getItem = () => { throw new Error('x'); };
    try { expect(langPref()).toBe('ko'); } finally { Storage.prototype.getItem = get; }
  });
  it('applyLang 은 ko 에서 처음 보는 글을 건드리지 않음', () => {
    const d = document.createElement('div'); d.textContent = '설정'; applyLang(d, 'ko'); expect(d.textContent).toBe('설정');
  });
});

describe('1 차 범위: 머리줄 · 설정(시안 u9)', () => {
  const R = (id: string, name: string): Robot => ({ id, name, owner: 'u-lee', ownerName: 'x', battery: 70, online: true, seenAt: '', status: 'IDLE', sim: false });
  it('표시 › 언어에서 English 를 누르면 지금 표가 옮겨 가고, 설정 묶음 일곱 · 머리줄에 한글이 남지 않음(이름 빼고)', async () => {
    window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    location.hash = '#/settings';
    box = document.createElement('div'); document.body.append(box);
    stop = syncLang(box);
    const admin = USERS.find((u) => u.role === 'ORG_ADMIN')!;
    act(() => { root = createRoot(box); root.render(<App user={admin} robots={[R('k1', 'K-01')]} />); });
    await flush();
    await act(async () => { document.getElementById('nav-display')!.click(); }); await flush();
    const eng = box.querySelector<HTMLElement>('[role=radio][aria-label="English"]')!;
    expect(eng.getAttribute('aria-checked')).toBe('false');
    await act(async () => { eng.click(); }); await flush();
    expect(eng.getAttribute('aria-checked')).toBe('true');
    expect(localStorage.getItem('fh.lang')).toBe('en');
    const names = new Set([admin.name, admin.name.slice(-1), admin.name[0], '한국어', `@${admin.name} (Admin)`, '@한국어']);
    for (const p of ['display', 'account', 'users', 'network', 'crowd', 'alerts', 'controls']) {
      await act(async () => { document.getElementById(`nav-${p}`)!.click(); }); await flush();
      expect([p, hangul(box).filter((t) => !names.has(t))]).toEqual([p, []]);
    }
    expect([...box.querySelectorAll('.bar .tabs > span')].map((e) => e.textContent)).toEqual(['Control', 'Robots', 'Maps', 'Missions', 'History', 'Settings']);
    // 정지 글 보기 칸은 일부러 두 언어 그대로
    await act(async () => { document.getElementById('nav-display')!.click(); }); await flush();
    expect(box.textContent).toContain('정지됨'); expect(box.textContent).toContain('The robot has stopped');
  });
});
