// 관제 탭 안 = 시안 u5_1 (proto/u5). 칸 넷(배터리 · 관절 최고 · 연결 ms · 조종/담당) 은 시안처럼 늘 넷, 값이 없으면 글을 비움. 다시 연결 중 그림, 위 띠 수 여섯.
// 값이 없는 칸(보행 모드 · 남은 분 · 데모 표시)은 지어내지 않는다. 충전 · 점검 수는 가용(GET /robots/availability)을 못 받으면 비움. STOP · 타일 고르기는 control.test.
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
const tile = (id: string) => $(`.tile[data-robot="${id}"]`);
/** 시안 .sts 칸(배터리 · 관절 · 연결 · 조종/담당): [큰 글, 작은 글] */
const fact = (id: string, k: string) => { const e = tile(id).querySelector(`[data-fact="${k}"]`)!; return [[...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(''), e.querySelector('small')?.textContent ?? '']; };

const R: Robot[] = [
  { id: 'a1', name: 'K-01', owner: 'u-lee', ownerName: '이OO', battery: 66, online: true, seenAt: '14:05:20', status: 'RUNNING', mission: '공정 순찰 A 2/4', serverDrive: true },
  { id: 'a2', name: 'K-02', owner: 'u-lee', ownerName: '이OO', battery: 64, online: true, seenAt: '14:05:20', status: 'IDLE', serverDrive: true },
  { id: 'a3', name: 'K-07', owner: 'u-lee', ownerName: '이OO', battery: 49, online: true, seenAt: '14:02:10', status: 'IDLE', serverDrive: true },
];

describe('관제 타일 · 시안 u5_1', () => {
  it('칸 넷: 배터리 · 연결 ms(받은 latency_ms 그대로) · 조종 · 조종권 또는 담당 · 값 없는 연결 ms 는 비움', () => {
    mount('u-lee', R);
    act(() => {
      FakeWS.last.open();
      FakeWS.last.recv(state('a1', { latency_ms: 40, battery: { soc: 66, updated_at: '' } }));
      FakeWS.last.recv(state('a2', { latency_ms: null, battery: { soc: 64, updated_at: '' } }));
      FakeWS.last.recv(state('a3', { latency_ms: 41 }));
      FakeWS.last.recv(lease('a1', { id: 'u-park', name: '박OO' }));
    });
    expect(fact('a1', 'battery')[0]).toBe('66 %');   // 시안 「66 %」
    expect(fact('a1', 'link')).toEqual(['연결', '40 ms']);
    expect(fact('a2', 'link')).toEqual(['연결', '']);   // 받은 ms 가 없으면 지어내지 않음
    expect(fact('a1', 'who')).toEqual(['박OO', '조종권']);   // WS lease 알림에는 driving 이 없음 = 조종권(조정 02:38 · 「조종」 은 목록 lease.driving 일 때만)
    expect(fact('a2', 'who')).toEqual(['나', '담당자']);   // 보는 사람(이OO)이 담당이면 「나」
    expect(fact('a1', 'temp')[0]).toBe('');   // 관절 온도는 값이 있을 때만
    expect([...tile('a1').querySelectorAll('[data-fact]')].map((e) => (e as HTMLElement).dataset.fact)).toEqual(['battery', 'temp', 'link', 'who']);   // 시안 칸 넷 순서
  });

  it('끊긴 로봇 = 그림 위 「다시 연결 중 · 마지막 화면 HH:MM」 (시안 u5_1 K-07)', () => {
    mount('u-lee', R);
    act(() => { FakeWS.last.open(); for (const r of R) FakeWS.last.recv(state(r.id)); });
    expect(tile('a3').querySelector('.lk')).toBeNull();
    act(() => { FakeWS.last.recv(state('a3', { ...OFF, latency_ms: 41 })); });
    expect(fact('a3', 'link')[0]).toBe('연결 중');   // 끊긴 로봇의 남은 latency_ms 는 지금 값이 아님
    expect(fact('a3', 'link')[1]).not.toContain('ms');
    const k = tile('a3').querySelector('.lk')!;   // 시안 u5_1 K-07: 「다시 연결 중 · 마지막 화면 HH:MM」
    expect([...k.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('')).toBe('다시 연결 중');
    expect(k.querySelector('small')!.textContent).toMatch(/^마지막 화면 \d\d:\d\d$/);
  });

  it('위 띠 수: 일곱 칸(임무 중 · 충전 · 점검 · 연결 중 · 시뮬 · 경고 · 주의), 가용을 못 받은 충전 · 점검은 수를 비움, 모드는 지어내지 않음', () => {
    mount('u-lee', R);
    const RUN = { run: { run_id: 'r1', status: 'MOVING', step: 0, wait_reason: null, fail_code: null, progress: { done: 1, total: 4 } } };   // 임무 중 배지 = 진행 중인 임무
    act(() => { FakeWS.last.open(); for (const r of R) FakeWS.last.recv(state(r.id, { status: r.status, ...(r.status === 'RUNNING' ? RUN : {}) } as never)); FakeWS.last.recv(state('a3', OFF)); });
    const sums = [...box.querySelectorAll<HTMLElement>('.u5 .tb [data-sum]')];
    expect(sums.map((e) => e.dataset.sum)).toEqual(['임무 중', '충전', '점검', '연결 중', '시뮬', '경고', '주의']);
    const num = (k: string) => sums.find((e) => e.dataset.sum === k)!.querySelector('b')!.textContent;
    expect([num('임무 중'), num('연결 중'), num('시뮬')]).toEqual(['1', '1', '0']);
    expect([num('충전'), num('점검')]).toEqual(['', '']);   // 가용 없음 = 비움(0 을 지어내지 않음)
    const text = $('.u5 .wall').textContent!;
    for (const w of ['데모', 'START', 'Classic', 'AME-2', '약 ']) expect(text, w).not.toContain(w);
  });
});
