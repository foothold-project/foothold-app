// 관제 탭 안 = 시안 u5_1 (CONTROL-DIFF-1128.md). 칸 넷(배터리 · 관절 최고 · 연결 ms · 조종/담당), 다시 연결 중 그림, 위 띠 수.
// 값이 없는 칸(보행 모드 · 충전 · 점검 · 남은 분 · 데모 표시 · 첫 화면으로)은 지어내지 않는다. STOP · 타일 고르기는 control.test 그대로.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { USERS, type Robot } from './fixtures';
import { FakeWS, lease, state } from './fakeWs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null, box: HTMLDivElement;
function mount(user: string, robots: Robot[]) {
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  location.hash = '#/control';
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<App user={USERS.find((u) => u.id === user)} robots={robots} />); });
}
const OFF = { connection: 'OFFLINE', status: null, battery: null, latched: null, stop_gen: null, applied: null } as const;
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); vi.restoreAllMocks(); localStorage.clear(); });
const $ = <T extends Element = HTMLElement>(s: string) => box.querySelector<T>(s)!;
const tile = (id: string) => $(`article[data-robot="${id}"]`);
const fact = (id: string, k: string) => tile(id).querySelector(`[data-fact="${k}"]`);

const R: Robot[] = [
  { id: 'a1', name: 'K-01', owner: 'u-lee', ownerName: '이OO', battery: 66, online: true, seenAt: '14:05:20', status: 'RUNNING', mission: '공정 순찰 A 2/4', serverDrive: true },
  { id: 'a2', name: 'K-02', owner: 'u-lee', ownerName: '이OO', battery: 64, online: true, seenAt: '14:05:20', status: 'IDLE', serverDrive: true },
  { id: 'a3', name: 'K-07', owner: 'u-lee', ownerName: '이OO', battery: 49, online: true, seenAt: '14:02:10', status: 'IDLE', serverDrive: true },
];

describe('관제 타일 · 시안 u5_1', () => {
  it('칸 넷: 배터리 · 연결 ms(받은 latency_ms 그대로) · 조종(조종권자) 또는 담당 · 값 없는 연결 칸은 접음', () => {
    mount('u-lee', R);
    act(() => {
      FakeWS.last.open();
      FakeWS.last.recv(state('a1', { latency_ms: 40, battery: { soc: 66, updated_at: '' } }));
      FakeWS.last.recv(state('a2', { latency_ms: null, battery: { soc: 64, updated_at: '' } }));
      FakeWS.last.recv(state('a3', { latency_ms: 41 }));
      FakeWS.last.recv(lease('a1', { id: 'u-park', name: '박OO' }));
    });
    expect(fact('a1', '배터리')!.querySelector('b')!.textContent).toBe('66%');
    expect(fact('a1', '연결')!.querySelector('b')!.textContent).toBe('40 ms');
    expect(fact('a2', '연결')).toBeNull();
    expect(fact('a1', '조종')!.querySelector('b')!.textContent).toBe('박OO');
    expect(fact('a1', '담당')).toBeNull();
    expect(fact('a2', '조종')).toBeNull();
    expect(fact('a2', '담당')!.querySelector('b')!.textContent).toBe('이OO');
    expect([...tile('a1').querySelectorAll('[data-fact]')].map((e) => (e as HTMLElement).dataset.fact)).toEqual(['배터리', '연결', '조종']);   // 관절 온도는 값이 있을 때만
  });

  it('끊긴 로봇 = 그림 위 「다시 연결 중 · 마지막 수신 HH:MM」 (시각을 모르면 시각 줄 없음)', () => {
    mount('u-lee', R);
    act(() => { FakeWS.last.open(); for (const r of R) FakeWS.last.recv(state(r.id)); });
    expect(tile('a3').querySelector('[data-relink]')).toBeNull();
    act(() => { FakeWS.last.recv(state('a3', { ...OFF, latency_ms: 41 })); });
    expect(fact('a3', '연결')).toBeNull();   // 끊긴 로봇의 남은 latency_ms 는 지금 값이 아님
    const k = tile('a3').querySelector('[data-relink]')!;
    expect(k.querySelector('b')!.textContent).toBe('다시 연결 중');
    expect(k.querySelector('small')!.textContent).toMatch(/^마지막 수신 \d\d:\d\d$/);
  });

  it('위 띠 수: 임무 중 · 연결 · 연결 중(끊겨 다시 잇는 중) · 시뮬 · 경고, 값이 없는 칸 · 모드는 지어내지 않음', () => {
    mount('u-lee', R);
    act(() => { FakeWS.last.open(); for (const r of R) FakeWS.last.recv(state(r.id, { status: r.status })); FakeWS.last.recv(state('a3', OFF)); });
    const sums = [...box.querySelectorAll<HTMLElement>('[aria-label="요약"] [data-sum]')];
    expect(sums.map((e) => e.dataset.sum)).toEqual(['임무 중', '연결', '연결 중', '시뮬', '경고']);
    expect(sums.find((e) => e.dataset.sum === '연결 중')!.querySelector('b')!.textContent).toBe('1');
    const text = $('.ct').textContent!;
    for (const w of ['충전', '점검', '데모 표시', '첫 화면으로', 'START', 'Classic', 'AME-2', '약 ']) expect(text, w).not.toContain(w);
  });
});
