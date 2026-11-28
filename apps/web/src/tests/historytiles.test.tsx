// 폰 기록 탭 = 시안 u3_3 알림 목록 타일(U3-04): 등급 색으로 옅게 물든 칸 + 1 px 테 · 분류 아이콘 · 문장 · 로봇·사람 · 분류 · 오른쪽 시각, 고른 타일은 오른쪽 칸. PC 는 시안 u8_1 줄(historyframe 시험).
import { act } from 'react';
import { createRoot, type Root as ReactRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Event as Ev, RobotSummary, User } from '../../../contracts/ts';
import { Root } from '../session';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LEE: User = { id: 'o1', username: 'lee', display_name: '이운영', role: 'OPERATOR', locked: false, robot_ids: ['r-a'], created_at: '2026-10-19T00:00:00Z' };
const RA: RobotSummary = { id: 'r-a', name: 'Go2-A', model: 'unitree_go2', owner: { id: LEE.id, display_name: LEE.display_name }, simulation: false, server_drive_allowed: false,
  connection: 'OFFLINE', status: null, battery: null, location: null, lease: null, current_run: null, devices: [], attention: [] };
const AT = new Date(2026, 10, 28, 14, 20).toISOString();
const ev = (id: string, p: Partial<Ev> = {}): Ev => ({ id, at: AT, robot_at: null, category: 'SAFETY', code: 'FALL', severity: 'ERROR',
  message: `사건 ${id} 문장`, robot_id: 'r-a', user_id: null, run_id: null, data: {}, ...p });
const ITEMS = [
  ev('1'),
  ev('2', { category: 'ROUTE', code: 'ROUTE_LOST', severity: 'WARN', message: '14:12 길을 못 찾았습니다.' }),
  ev('3', { category: 'LINK', code: 'STOP_CONFIRM_FAILED', severity: 'INFO', user_id: 'o1', robot_at: new Date(2026, 10, 28, 13, 5).toISOString() }),
  ev('4', { category: 'RUN', code: 'RUN_DONE', severity: 'INFO', run_id: 'run-1' }),
];
const HIST = { id: 'run-1', scenario_version_id: 'sv1', floor_id: 'f1', map_version_id: 'm1', scenario_name: '공정 순찰 A', floor_name: '1층', scenario_name_snapshot: null, floor_name_snapshot: null,
  status: 'COMPLETED', started_at: AT, ended_at: AT };

function serve() {
  const routes: Record<string, unknown> = {
    'GET /auth/session': { client: 'web', csrf_token: 'csrf-1' }, 'GET /me': LEE, 'GET /robots': { items: [RA], next_cursor: null }, 'GET /robots/r-a': RA,
    'GET /notifications': { items: [], next_cursor: null, unread_count: 0 }, 'GET /runs/run-1/history': HIST,
  };
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const [path, qs = ''] = url.replace(/^\/api\/v1/, '').split('?'), key = `${init.method ?? 'GET'} ${path}`;
    const body = path === '/events' ? { items: new URLSearchParams(qs).get('run_id') ? [] : ITEMS, next_cursor: null } : routes[key];
    return new Response(JSON.stringify(body ?? { error: { code: 'NOT_FOUND', message: '없음', detail: {} } }), { status: body ? 200 : 404, headers: { 'Content-Type': 'application/json' } });
  });
}
let root: ReactRoot | null = null, box: HTMLDivElement;
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); });
async function open(phone: boolean) {
  window.matchMedia = ((q: string) => ({ matches: phone, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  location.hash = '#/history';
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<Root />); });
  await flush();
}
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); vi.unstubAllGlobals(); });
const tiles = () => [...box.querySelectorAll<HTMLElement>('[aria-label="사건"] [data-tile]')];
const btn = (t: string, from: ParentNode = box) => [...from.querySelectorAll('button')].find((b) => b.textContent === t) as HTMLButtonElement | undefined;

describe('폰 기록 = 타일', () => {
  it('표 대신 사건 하나에 타일 하나(서버 순서 그대로), 표는 없음', async () => {
    serve();
    await open(true);
    expect(tiles()).toHaveLength(4);
    expect(box.querySelector('[aria-label="기록"] table')).toBeNull();
    expect(box.querySelector('[aria-label="사건"]')!.className).toBe('g list');   // 시안 .g.list
  });
  it('등급 색: 위험 · 주의 · 정보, 정보로 저장된 실패 코드는 주의 (줄 알약과 같은 기준)', async () => {
    serve();
    await open(true);
    expect(tiles().map((t) => t.dataset.tone)).toEqual(['bad', 'warn', 'warn', 'info']);
  });
  it('분류 아이콘 · 제목 = 서버 문장(시각 접두 뗌) · 아래 줄 = 등급 · 분류 · 로봇·사람 · 오른쪽 시각', async () => {
    serve();
    await open(true);
    const [a, b, c] = tiles();
    expect(tiles().map((t) => t.querySelector('[data-tile-icon]')!.getAttribute('data-tile-icon'))).toEqual(['SAFETY', 'ROUTE', 'LINK', 'RUN']);
    expect(tiles().every((t) => t.querySelector('[data-tile-icon] svg')?.getAttribute('aria-hidden') === 'true')).toBe(true);
    expect(a.querySelector('[data-tile-title]')!.textContent).toBe('사건 1 문장');
    expect(a.querySelector('[data-tile-title]')!.tagName).toBe('B');   // 시안 .tile b · 문장은 글만(코드 원문 접힌 상세는 표에만)
    expect(b.querySelector('[data-tile-title]')!.textContent).toBe('길을 못 찾았습니다.');
    expect(a.querySelector('[data-tile-sub]')!.textContent).toBe('Go2-A · 안전');   // 시안 아래 줄: 로봇 · 내용(등급은 타일 색 · 오른쪽 칸 표지)
    expect(c.querySelector('[data-tile-sub]')!.textContent).toBe('Go2-A · 이운영 · 연결');
    const hm = (iso: string) => (new Date(iso).toDateString() === new Date().toDateString() ? new Date(iso).toTimeString().slice(0, 5) : `${new Date(iso).getMonth() + 1}/${new Date(iso).getDate()}`);
    expect(a.querySelector('[data-tile-time]')!.textContent).toBe(hm(ITEMS[0].at));   // 오늘이면 시안처럼 HH:MM, 아니면 M/D
    expect(c.querySelector('[data-tile-time]')!.textContent).toBe(hm(ITEMS[2].robot_at!));   // 늦게 온 로봇 사건은 로봇 발생 시각(표와 같은 stamp)
    const icon = (t: HTMLElement) => t.querySelector('[data-tile-icon]')!.innerHTML;
    expect(new Set(tiles().map(icon)).size).toBe(4);   // 분류마다 다른 아이콘
  });
  it('run_id 있는 알림을 고르면 오른쪽 칸에만 「실행 기록 보기」 → 보고서, 닫으면 초점은 그 단추로', async () => {
    serve();
    await open(true);
    const det = () => box.querySelector<HTMLElement>('.u33 .g.det')!;
    const has = [];
    for (const t of tiles()) { act(() => t.click()); await flush(); has.push(!!btn('실행 기록 보기', det())); }
    expect(has).toEqual([false, false, false, true]);
    expect(tiles().some((t) => btn('실행 기록 보기', t))).toBe(false);
    act(() => btn('실행 기록 보기', det())!.click());
    await flush();
    const rep = box.querySelector('[role="region"][aria-label="실행 기록"]')!;
    expect(rep.textContent).toContain('공정 순찰 A');
    act(() => btn('닫기', rep)!.click());
    await flush();
    expect(document.activeElement).toBe(btn('실행 기록 보기', det()));
  });
  it('PC 는 시안 u8_1 줄(타일 없음)', async () => {
    serve();
    await open(false);
    expect(tiles()).toHaveLength(0);
    expect(box.querySelectorAll('[aria-label="사건"] .ev')).toHaveLength(4);
  });
});
