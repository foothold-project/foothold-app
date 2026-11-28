// 영어판 관제(u5) 글(11/29): 타일 배지(tileBadge) · 덮개 · 작은 지도 · 오른쪽 칸 · 시험용 가짜 자료 · 알림 카드가 사전(lang.en.ts)을 탄다.
// 관제 화면을 영어로 그렸을 때 남는 한글은 서버 값 · 이름뿐
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../App';
import { en, setLang, syncLang } from '../lang';
import { USERS, type Robot } from './fixtures';
import { FakeWS, state } from './fakeWs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null, box: HTMLDivElement | null = null, stop: (() => void) | null = null;
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); box = null; stop?.(); stop = null; act(() => setLang('ko')); localStorage.clear(); });
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); });

describe('관제 글 사전', () => {
  it('타일 배지 · 상태 글', () => {
    const want: Record<string, string> = { '대기 · 임무 전': 'Idle · no mission', '다시 연결 중': 'Reconnecting', '점검 중': 'Inspecting', '충전 중': 'Charging', '넘어짐': 'Fallen',
      '임무 멈춤': 'Mission paused', '시뮬 중': 'Sim', '조종 중': 'Driving', '임무 중': 'On mission', '연결 끊김': 'Disconnected', '연결 전': 'Not connected', '정지 잠금': 'Stop latched', '배터리 교체': 'Battery swap' };
    for (const [k, v] of Object.entries(want)) expect(en(k), k).toBe(v);
  });
  it('머리 칩 일곱 · 작은 지도 · 오른쪽 칸', () => {
    expect(['임무 중', '충전', '점검', '연결 중', '시뮬', '경고', '주의'].map((k) => en(k))).toEqual(['On mission', 'Charging', 'Maintenance', 'Connecting', 'Sim', 'Warning', 'Caution']);
    expect(en('작은 지도 · 두 번 누르면 지도 보기')).toBe('Mini map · double-click for map');
    expect(en('선택한 로봇 강조')).toBe('Selected robot highlighted');
    expect(en('진행 중인 임무가 없습니다')).toBe('No mission running');
    expect(en('위치 12.5, -3.0 m (마지막 위치)')).toBe('Location 12.5, -3.0 m (last known)');
    expect(en('로봇 탭에서 열기')).toBe('Open in Robots');
  });
  it('값이 섞인 타일 글 · 시험용 가짜 자료 · 알림 카드', () => {
    expect(en('14:05 끊김')).toBe('Lost 14:05');
    expect(en('마지막 화면 14:05')).toBe('Last frame 14:05');
    expect(en('주의 · 일시정지')).toBe('Caution · Paused');
    expect(en('뒤 2 m 시점으로')).toBe('2 m behind view');
    expect(en('화면 검토용 가짜 자료 · 로봇 20 대')).toBe('Review-only test data · 20 robots');
    expect(en('가짜 7')).toBe('Test 7');
    expect(en('가짜 순찰 3/6')).toBe('Test patrol 3/6');
    expect(en('K-04 연결이 끊겼습니다. 마지막 확인: 대기(14:05:20). 지금 상태는 알 수 없습니다.')).toBe('K-04 disconnected. Last seen: Idle (14:05:20). Current status unknown.');
    expect(en('현장에서 로봇 전원과 통신을 확인하세요.')).toBe('Check the robot’s power and network on site.');
    expect([en('알림 닫기'), en('접기'), en('8 건 모두 보기')]).toEqual(['Dismiss alert', 'Collapse', 'Show all 8']);
  });
});

describe('영어판 관제 화면', () => {
  const R = (id: string, name: string, p: Partial<Robot> = {}): Robot => ({ id, name, owner: 'u-lee', ownerName: '이OO', battery: 70, online: true, seenAt: '14:00:00', status: 'IDLE', sim: false, ...p } as Robot);
  it('배지 · 덮개 · 작은 지도 · 오른쪽 칸 · 알림 카드에 한글이 남지 않음(서버 값 · 이름 빼고)', async () => {
    window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    location.hash = '#/control';
    box = document.createElement('div'); document.body.append(box);
    stop = syncLang(box);
    act(() => setLang('en'));
    const robots = [R('a1', 'K-01', { status: 'RUNNING', mission: '순찰 A 2/4' }), R('a2', 'K-02'), R('a3', 'K-03', { status: 'STOP_LATCHED' }), R('a4', 'K-04'),
      R('a5', 'K-05', { sim: true }), R('a6', 'K-06', { demo: true }), R('a7', 'K-07', { seenAt: '', online: false }), R('a8', 'K-08', { status: 'PAUSED' })];
    act(() => { root = createRoot(box!); root.render(<App user={USERS.find((u) => u.role === 'ORG_ADMIN')} robots={robots} />); });
    act(() => {
      FakeWS.last.open();
      FakeWS.last.recv(state('a1', { status: 'RUNNING', run: { run_id: 'r', status: 'MOVING', step: 0, wait_reason: null, fail_code: null, progress: { done: 1, total: 4 } } } as never));
      for (const id of ['a2', 'a4', 'a5', 'a6']) FakeWS.last.recv(state(id));
      FakeWS.last.recv(state('a3', { status: 'STOP_LATCHED' })); FakeWS.last.recv(state('a8', { status: 'PAUSED' }));
      FakeWS.last.recv(state('a4', { connection: 'OFFLINE', status: null, battery: null } as never));
    });
    await flush();
    const t = box.querySelector<HTMLElement>('.tile')!;
    await act(async () => { t.click(); }); await flush();
    const left: string[] = [], w = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) if (/[가-힣]/.test(n.nodeValue!) && !n.parentElement!.closest('[translate="no"]')) left.push(n.nodeValue!.trim());
    box.querySelectorAll('[aria-label],[title]').forEach((e) => { for (const a of ['aria-label', 'title']) { const v = e.getAttribute(a); if (v && /[가-힣]/.test(v)) left.push('@' + v); } });
    const names = new Set(['순찰 A', '이OO', '@김OO (Admin)']);
    expect(left.filter((x) => !names.has(x))).toEqual([]);
    expect(box.querySelector('[data-badge="lost"], [data-badge="relink"]')!.textContent).toMatch(/Disconnected|Reconnecting/);
    expect(box.querySelector('[data-band]')!.textContent).toContain('K-04 disconnected.');
  });
});
