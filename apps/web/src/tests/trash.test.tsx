// 휴지통 화면(05 §5.1, 11-02). fetch 는 상태를 가진 가짜 서버(목록·복원·완전 삭제·409 흉내), WebSocket 은 FakeWS.
// 목록(종류·이름·상위·지운 사람·지운 때), 복원, 완전 삭제(앱 안 확인 창 — 브라우저 confirm 없음, 되돌릴 수 없음 안내), 409 코드별 쉬운 문구, 빈 상태,
// 운영 관리자도 같은 기능, 확인 창이 떠 있어도 STOP 이 보이고 실제로 정지 요청이 나가는지 본다.
import { act } from 'react';
import { createRoot, type Root as ReactRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RobotSummary, TrashItem, User } from '../../../contracts/ts';
import { Root } from '../session';
import { when } from '../screens/history';
import { FakeWS } from './fakeWs';
import { adminNoStop } from './adminStop';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KIM: User = { id: 'a1', username: 'kim', display_name: '김총괄', role: 'ORG_ADMIN', locked: false, robot_ids: [], created_at: '2026-10-19T00:00:00Z' };
const LEE: User = { ...KIM, id: 'o1', username: 'lee', display_name: '이운영', role: 'OPERATOR', robot_ids: ['r-a'] };
const RA: RobotSummary = { id: 'r-a', name: 'Go2-A', model: 'unitree_go2', owner: { id: LEE.id, display_name: LEE.display_name },
  simulation: false, server_drive_allowed: false,
  connection: 'OFFLINE', status: null, battery: null, location: null, lease: null, current_run: null, devices: [], attention: [] };
const item = (kind: TrashItem['kind'], id: string, name: string, p: Partial<TrashItem> = {}): TrashItem =>
  ({ kind, id, name, archived_at: '2026-11-02T03:00:00Z', deleted_by: { id: KIM.id, display_name: KIM.display_name }, parent_name: null, ...p });
const err = (status: number, code: string, message: string) => ({ status, body: { error: { code, message, detail: {} } } });

type Reply = { status: number; body?: unknown };
type Call = { method: string; path: string };
let calls: Call[] = [], db: TrashItem[] = [];
/** over = «METHOD 경로»별 덮어쓰기(앞에서부터 하나씩) */
function serve(me: User, o: { over?: Record<string, Reply[]> } = {}) {
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET', path = url.replace(/^\/api\/v1/, '').split('?')[0], key = `${method} ${path}`;
    calls.push({ method, path });
    const r = o.over?.[key]?.shift() ?? route(method, path);
    return new Response(r.status === 204 ? null : JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
  });
  function route(method: string, path: string): Reply {
    if (path === '/auth/session') return { status: 200, body: { client: 'web', csrf_token: 'csrf-1' } };
    if (path === '/me') return { status: 200, body: me };
    if (path === '/robots') return { status: 200, body: { items: [RA], next_cursor: null } };
    if (path === '/robots/r-a') return { status: 200, body: RA };
    if (path === '/dashboard') return { status: 200, body: { robots_total: 1, robots_online: 0, robots_attention: 0, robots_running: 0, approvals_pending: 0, operators: [] } };
    if (path === '/notifications') return { status: 200, body: { items: [], next_cursor: null, unread_count: 0 } };
    if (path === '/trash') return { status: 200, body: { items: db } };
    const m = path.match(/^\/trash\/(site|building|floor|scenario)\/([^/]+)(\/restore)?$/);
    if (m && (method === 'DELETE' || (method === 'POST' && m[3]))) {
      const i = db.findIndex((x) => x.kind === m[1] && x.id === m[2]);
      if (i < 0) return err(404, 'NOT_FOUND', '휴지통 항목을 찾을 수 없습니다.');
      db.splice(i, 1); return { status: 204 };
    }
    return err(404, 'NOT_FOUND', '찾을 수 없습니다.');
  }
}
const writes = () => calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`);

let root: ReactRoot | null = null, box: HTMLDivElement;
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); });
async function open(hash = '#/trash') {
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  location.hash = hash;
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<Root />); });
  await flush();
}
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const $ = <T extends Element = HTMLElement>(s: string, from: ParentNode = box) => from.querySelector<T>(s);
const btn = (t: string, from: ParentNode = box) => [...from.querySelectorAll('button')].find((b) => b.textContent === t) as HTMLButtonElement | undefined;
const click = async (b: Element | undefined | null) => { expect(b).toBeTruthy(); act(() => (b as HTMLElement).click()); await flush(); };
const row = (id: string) => $(`[data-trash-item="${id}"]`)!;
const ids = () => [...box.querySelectorAll('[data-trash-item]')].map((x) => x.getAttribute('data-trash-item'));
const alertText = () => [...box.querySelectorAll('[role="alert"]')].map((a) => a.textContent).join(' ');
const statusText = () => [...box.querySelectorAll('[role="status"]')].map((a) => a.textContent).join(' ');
const stopSends = async () => {
  if (adminNoStop(box)) return;
  const s = $<HTMLButtonElement>('[data-stop]')!;
  expect(s.disabled).toBe(false);
  expect($('header')!.lastElementChild).toBe(s);
  act(() => FakeWS.last.open());
  await click(s);
  const sel = $<HTMLSelectElement>('[aria-label="정지할 로봇"]');
  if (sel) {
    act(() => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(sel, 'r-a'); sel.dispatchEvent(new Event('change', { bubbles: true })); });
    await flush();
    await click(btn('정지', $('[aria-label="정지할 로봇 고르기"]')!));
  }
  expect(FakeWS.last.of('stop').map((m) => m.robot)).toEqual(['r-a']);
};

describe('휴지통(05 §5.1)', () => {
  it('목록 = 종류·이름·상위 이름·지운 사람·지운 때, 메뉴에는 숨김, 지도·시나리오로 돌아가는 입구', async () => {
    db = [item('scenario', 'sc1', '옛 순찰'), item('floor', 'f2', '2층', { parent_name: '본동' }), item('building', 'b2', '별관', { parent_name: '본관', deleted_by: null })];
    serve(KIM);
    await open();
    expect($('h1')!.textContent).toBe('휴지통');
    expect($('nav a[href="#/trash"]')).toBeNull();
    expect(ids()).toEqual(['sc1', 'f2', 'b2']);
    expect(row('sc1').textContent).toContain('시나리오'); expect(row('sc1').textContent).toContain('옛 순찰');
    expect(row('f2').textContent).toContain('층'); expect(row('f2').textContent).toContain('본동 안');
    expect(row('f2').textContent).toContain(`김총괄 · ${when('2026-11-02T03:00:00Z')}`);
    expect(row('b2').textContent).toContain('지운 사람 모름');
    expect([...box.querySelectorAll('[data-trash] a')].map((a) => a.getAttribute('href'))).toEqual(['#/map']);
  });
  it('복원 = POST …/restore → 목록 다시, 완전 삭제 = 앱 안 확인 창(이름·되돌릴 수 없음 안내, 취소면 안 보냄) → DELETE, 0개면 빈 상태', async () => {
    db = [item('scenario', 'sc1', '옛 순찰'), item('floor', 'f2', '2층', { parent_name: '본동' })];
    const confirm = vi.spyOn(window, 'confirm');
    serve(LEE);   // 운영 관리자도 같은 기능(10-25)
    await open();
    await click(btn('복원', row('f2')));
    expect(writes()).toEqual(['POST /trash/floor/f2/restore']);
    expect(statusText()).toContain('«2층» 층을 복원했습니다.');
    expect(ids()).toEqual(['sc1']);
    await click(btn('완전 삭제', row('sc1')));
    const ask = $('[data-purge-ask]')!;
    expect(ask.getAttribute('role')).toBe('alertdialog');
    expect(ask.textContent).toContain('«옛 순찰» 시나리오를 완전히 지울까요?');
    expect(ask.textContent).toContain('되돌릴 수 없습니다. 끝난 실행 기록은 이름만 남습니다.');
    await click(btn('취소', ask));
    expect(writes()).toHaveLength(1); expect($('[data-purge-ask]')).toBeNull();
    await click(btn('완전 삭제', row('sc1')));
    await stopSends();                                                     // 확인 창이 떠 있어도 STOP
    await click(btn('완전 삭제', $('[data-purge-ask]')!));
    expect(confirm).not.toHaveBeenCalled();
    expect(writes()).toEqual(['POST /trash/floor/f2/restore', 'DELETE /trash/scenario/sc1']);
    expect(statusText()).toContain('«옛 순찰» 시나리오를 완전히 지웠습니다.');
    expect(ids()).toEqual([]);
    expect($('[data-empty]')!.textContent).toBe('휴지통이 비었습니다.');
  });
  it('409 코드별 쉬운 문구 — HAS_CHILDREN·HAS_REFERENCES·RESOURCE_IN_USE(+ 서버가 알려 준 무엇)·PARENT_ARCHIVED·NOT_IN_TRASH, 목록 실패 → 다시 시도', async () => {
    db = [item('site', 's1', '본관'), item('floor', 'f2', '2층', { parent_name: '본동' })];
    serve(KIM, { over: {
      'DELETE /trash/site/s1': [err(409, 'HAS_CHILDREN', '하위 항목을 먼저 완전 삭제하세요.')],
      'DELETE /trash/floor/f2': [err(409, 'HAS_REFERENCES', '참조'), err(409, 'RESOURCE_IN_USE', '현재 이 층에 있는 로봇이 있어 휴지통 이동 또는 완전 삭제를 할 수 없습니다.'), err(409, 'NOT_IN_TRASH', '휴지통으로 옮긴 뒤')],
      'POST /trash/floor/f2/restore': [err(409, 'PARENT_ARCHIVED', '상위 건물을 먼저 되살리세요.')],
      'GET /trash': [{ status: 200, body: { items: db } }, err(500, 'INTERNAL_ERROR', '서버 오류')] } });
    await open();
    const purge = async (id: string) => { await click(btn('완전 삭제', row(id))); await click(btn('완전 삭제', $('[data-purge-ask]')!)); };
    await purge('s1');
    expect(alertText()).toContain('완전 삭제하지 못했습니다. 안에 있는 건물·층을 먼저 지우세요(휴지통에 있는 것도 포함).');
    expect(ids()).toEqual(['s1', 'f2']);                                   // 둘째 목록 받기 실패(500) — 받아 둔 목록은 그대로 + 다시 시도
    expect(alertText()).toContain('휴지통을 받지 못했습니다. 서버 오류');
    await click(btn('다시 시도'));
    expect(ids()).toEqual(['s1', 'f2']);
    await purge('f2');
    expect(alertText()).toContain('이 층을 쓰는 시나리오를 먼저 완전 삭제하세요.');
    await purge('f2');
    expect(alertText()).toContain('실행 중이거나 배정된 곳에서 쓰는 중입니다. 현재 이 층에 있는 로봇이 있어');
    await purge('f2');
    expect(alertText()).toContain('휴지통에 없는 항목입니다');
    await click(btn('복원', row('f2')));
    expect(alertText()).toContain('복원하지 못했습니다. 상위 장소·건물을 먼저 복원하세요(장소 → 건물 → 층 순서).');
    expect(ids()).toEqual(['s1', 'f2']);
  });
  it('어긋난 응답은 오류 한 줄(화면이 깨지지 않음)', async () => {
    db = [{ ...item('floor', 'f2', '2층'), kind: 'robot' as TrashItem['kind'] }];
    serve(LEE);
    await open();
    expect(alertText()).toContain('받은 휴지통 형식이 맞지 않습니다.');
    await stopSends();
  });
});
