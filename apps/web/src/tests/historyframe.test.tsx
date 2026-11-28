// PC 기록 탭 틀(u8_1 시안 그대로 옮김): 왼쪽 거르기 판(묶음 · 등급 세 칸 · 실제/모의 실행 · 로봇 · 클립 있는 것만 · 보관 안내) + 오른쪽 사건 판(찾기 · 오늘/7 일/30 일 · 지금 장면 저장 · 내보내기 · 필터 줄 · 날짜별 96 px 줄). 폰은 타일 그대로.
// 지어내지 않음: 묶음별 개수 · 클립 길이 · 보관 기간은 서버 값이 없어 비워 두고, 서버에 없는 거르기 · 찾기는 자리만(잠금 + 까닭 한 줄).
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
  ev('1', { data: { clip: true } }),
  ev('2', { category: 'ROUTE', code: 'ROUTE_LOST', severity: 'WARN', message: '14:12 길을 못 찾았습니다.', data: { clip: false } }),
  ev('3', { category: 'LINK', code: 'STOP_CONFIRM_FAILED', severity: 'INFO', user_id: 'o1', robot_at: new Date(2026, 10, 28, 13, 5).toISOString() }),
  ev('4', { category: 'RUN', code: 'RUN_DONE', severity: 'INFO', run_id: 'run-1' }),
  ev('5', { at: new Date(2026, 10, 27, 9, 0).toISOString(), category: 'ACCOUNT', code: 'LOGIN', severity: 'INFO', robot_id: null }),
];
const HIST = { id: 'run-1', scenario_version_id: 'sv1', floor_id: 'f1', map_version_id: 'm1', scenario_name: '공정 순찰 A', floor_name: '1층', scenario_name_snapshot: null, floor_name_snapshot: null,
  status: 'COMPLETED', started_at: AT, ended_at: AT };

let asked: URLSearchParams[] = [], more = false, ITEMS_OFF = false;
function serve(next = false) {
  asked = []; more = next;
  const routes: Record<string, unknown> = {
    'GET /auth/session': { client: 'web', csrf_token: 'csrf-1' }, 'GET /me': LEE, 'GET /robots': { items: [RA], next_cursor: null }, 'GET /robots/r-a': RA,
    'GET /notifications': { items: [], next_cursor: null, unread_count: 0 }, 'GET /runs/run-1/history': HIST,
  };
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const [path, qs = ''] = url.replace(/^\/api\/v1/, '').split('?'), key = `${init.method ?? 'GET'} ${path}`;
    if (path === '/events') asked.push(new URLSearchParams(qs));
    const body = path === '/events' ? { items: new URLSearchParams(qs).get('run_id') || ITEMS_OFF ? [] : ITEMS, next_cursor: more ? 'c2' : null } : routes[key];
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
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); vi.unstubAllGlobals(); ITEMS_OFF = false; });
const $ = (s: string) => box.querySelector<HTMLElement>(s);
const tiles = () => [...box.querySelectorAll<HTMLElement>('[aria-label="사건"] [data-tile]')];
const btn = (t: string, from: ParentNode = box) => [...from.querySelectorAll('button')].find((b) => b.textContent === t) as HTMLButtonElement | undefined;

describe('PC 기록 틀 = 왼쪽 거르기 판 + 오른쪽 사건 판 (u8_1)', () => {
  it('맨 위 = .proto.pv.u8, 왼쪽 판에 묶음 · 등급 · 실제/모의 실행 · 로봇, 오른쪽 판에 찾기 · 기간 · 지금 장면 저장 · 내보내기 · 표 머리 (판이 먼저)', async () => {
    serve(); await open(false);
    const frame = $('[data-hs-frame]')!;
    expect([...frame.classList]).toEqual(expect.arrayContaining(['proto', 'pv', 'u8']));
    const side = $('[aria-label="기록"] [data-hs-side]')!, main = $('[aria-label="기록"] [data-hs-main]')!;
    expect(side.tagName).toBe('ASIDE'); expect(side.getAttribute('aria-label')).toBe('기록 거르기');
    expect([...side.querySelectorAll('h4')].map((h) => h.textContent)).toEqual(['묶음', '등급', '실제 · 모의 실행', '로봇']);
    for (const g of ['묶음', '등급', '실제 · 모의 실행']) expect(side.querySelector(`[role="group"][aria-label="${g}"]`)).not.toBeNull();
    expect(side.querySelector('select[aria-label="로봇"]')).not.toBeNull();
    expect([...main.querySelectorAll('[aria-label="기간"] button')].map((b) => b.textContent)).toEqual(['오늘', '7 일', '30 일']);
    expect([...main.querySelector('.thd')!.children].map((x) => x.textContent)).toEqual(['등급', '클립', '사건', '묶음', '로봇', '시각', '클립 길이']);
    expect(main.querySelector('table')).toBeNull();   // 옛 표 모양 없음
    expect(btn('내보내기', main)).toBeDefined(); expect(btn('지금 장면 저장', main)).toBeDefined();
    expect(btn('내보내기', side)).toBeUndefined();
    expect(side.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(box.querySelector('.lv-card, .fh-wide')).toBeNull();   // 옛 앱 카드 없음
  });
  it('묶음은 세로 목록(시안 6 + 서버에만 있는 조종권 · 결재), 지어낸 개수 없음 · 모드 전환은 서버에 없어 잠금 · 등급은 안 고르면 셋 다 켜짐 · 고른 칸만 · 다시 누르면 풀림', async () => {
    serve(); await open(false);
    const side = $('[data-hs-side]')!, kinds = [...side.querySelectorAll<HTMLElement>('[aria-label="묶음"] .cat')];
    expect(kinds.map((b) => b.textContent)).toEqual(['전체', '안전', '임무', '모드 전환서버에 없음', '연결 · 시스템', '지도', '사용자 작업', '조종권', '결재']);
    expect(kinds.some((b) => /\d/.test(b.textContent!))).toBe(false);
    expect(kinds[0].getAttribute('aria-pressed')).toBe('true');
    expect(kinds[3].tagName).toBe('DIV');
    const lv = () => [...side.querySelectorAll<HTMLButtonElement>('[aria-label="등급"] button')];
    expect(lv().map((b) => [b.className.replace(' on', ''), b.textContent, b.classList.contains('on')])).toEqual([['lvt r', '위험', true], ['lvt w', '주의', true], ['lvt i', '정보', true]]);
    act(() => { lv()[0].click(); }); await flush();
    expect(asked[asked.length - 1].get('severity')).toBe('ERROR');
    expect(lv().map((b) => b.classList.contains('on'))).toEqual([true, false, false]);
    act(() => { lv()[0].click(); }); await flush();
    expect(asked[asked.length - 1].has('severity')).toBe(false);
    expect(lv().every((b) => b.classList.contains('on') && b.getAttribute('aria-pressed') === 'false')).toBe(true);
  });
  it('서버에 없는 칸은 자리만: 찾기 · 실제/모의 실행 · 클립 있는 것만은 못 누르고 까닭 한 줄, 보관 기간은 «서버에 값 없음»', async () => {
    serve(); await open(false);
    const side = $('[data-hs-side]')!, main = $('[data-hs-main]')!;
    const search = main.querySelector<HTMLInputElement>('[data-missing="search"] input')!;
    expect(search.disabled).toBe(true); expect(main.querySelector('[data-missing="search"]')!.textContent).toContain('서버에 찾기 없음');
    expect(side.querySelector('[data-missing="sim-filter"]')!.getAttribute('aria-disabled')).toBe('true');
    expect(side.querySelector('[data-missing="sim-filter"] button')).toBeNull();
    expect(side.querySelector('[data-missing="clip-filter"]')!.getAttribute('aria-disabled')).toBe('true');
    expect(side.textContent).toContain('서버에 실제 · 모의 실행 거르기가 없어');
    expect(side.textContent).toContain('서버에 클립 거르기가 없습니다');
    expect(side.textContent).toContain('묶음별 건수는 서버가 주지 않습니다.');
    expect(side.querySelector('[data-keep]')!.textContent).toContain('서버에 값 없음');
    const before = asked.length;
    act(() => { side.querySelector<HTMLElement>('[data-missing="sim-filter"] span:last-child')!.click(); }); await flush();
    act(() => { side.querySelector<HTMLElement>('[data-missing="mode"]')!.click(); }); await flush();
    expect(asked.length).toBe(before);   // 눌러도 요청 없음
  });
  it('날짜마다 머리 한 줄(.day data-day) 뒤에 그날 줄 · 줄 = 등급 · 클립 · 사건 · 묶음 · 로봇 · 시각 · 클립 길이', async () => {
    serve(); await open(false);
    const list = $('[data-rows]')!;
    expect([...list.querySelectorAll('.day')].map((b) => b.getAttribute('data-day'))).toEqual([expect.stringMatching(/11월 28일$/), expect.stringMatching(/11월 27일$/)]);
    const kids = [...list.children].filter((x) => x.matches('.day, .ev')).map((x) => (x.classList.contains('day') ? 'D' : 'E')).join('');
    expect(kids).toBe('DEEEEDE');
    const [one, two, , , five] = [...list.querySelectorAll<HTMLElement>('.ev')];
    expect(one.querySelector('[data-clip-cell]')!.getAttribute('data-clip-cell')).toBe('yes');
    expect(one.querySelector('[data-len]')!.textContent).toBe('서버에 값 없음');   // 클립 길이는 서버가 주지 않음
    expect(two.querySelector('[data-clip-cell]')!.textContent).toBe('골라서 · 안 남김');   // 주의 + clip false = 사람이 끈 것
    expect(five.querySelector('[data-clip-cell]')!.textContent).toBe('정보 단계');
    expect(one.querySelector('.tm')!.textContent).toBe('14:20:00');
    expect(one.querySelector('.rt2')!.textContent).toBe('실제');
    expect(five.querySelector('.rb')!.textContent).toBe('없음');
  });
  it('표 위 한 줄: 필터 없음 · 받은 사건 n 건 → 고르면 고른 필터 칩 (요청은 서버 매개변수 그대로)', async () => {
    serve(); await open(false);
    const line = () => $('[data-hs-main] [data-hs-sum]')!.textContent;
    expect(line()).toContain('필터 없음'); expect(line()).toContain('사건 5 건');
    act(() => { btn('안전', $('[data-hs-side]')!)!.click(); }); await flush();
    act(() => { btn('주의', $('[data-hs-side] [aria-label="등급"]')!)!.click(); }); await flush();
    expect(asked[asked.length - 1].get('category')).toBe('SAFETY');
    expect(asked[asked.length - 1].get('severity')).toBe('WARN');
    expect(line()).not.toContain('필터 없음');
    expect(line()).toContain('안전'); expect(line()).toContain('주의'); expect(line()).toContain('필터 모두 풀기');
  });
  it('서버가 더 있다고 하면(next_cursor) 받은 수 뒤에 «이상» · 지어낸 전체 수 없음', async () => {
    serve(true); await open(false);
    expect($('[data-hs-sum]')!.textContent).toContain('사건 5 건 이상');
  });
  it('필터 없이 0 건이면 u11_8 빈 기록 하나만(거르기 판 · 표 없음)', async () => {
    serve(); ITEMS_OFF = true; await open(false);
    expect($('[data-empty="log"]')!.textContent).toBe('아직 기록이 없습니다임무를 실행하거나 알림이 생기면 여기에 시간 순서로 남습니다.');
    expect($('[data-u8]')!.getAttribute('data-u8')).toBe('empty');
    expect($('[data-hs-side]')).toBeNull();
    expect($('[data-rows]')).toBeNull();
    ITEMS_OFF = false;
  });
  it('폰은 거르기 칸 없이 타일 그대로', async () => {
    serve(); await open(true);
    expect($('[data-hs-side]')).toBeNull();
    expect(tiles()).toHaveLength(5);
  });
});
