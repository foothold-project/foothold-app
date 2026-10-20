// W5 결재 탭(01 AP-01~04·AP-08, 02 F-AP-02~04, 03 §5.4·U10, 05 §7 — S4a /approvals).
// fetch 는 상태를 가진 가짜 서버(결재 목록·처리·STALE 판정 흉내), WebSocket 은 FakeWS. 총괄 결재함·더 보기·끝난 것, 운영 관리자 내 요청·취소,
// 상세 비교(지도 탭 Compare 재사용), 승인(확인 없음)·반려(이유 필수 + 확인), 본인 요청, 409 STALE·ALREADY_DECIDED·403·404·끊김 재조회·두 번 누름,
// 배지(/dashboard 값), 모르는 종류, 알림 링크, 처리·확인·비교 중에도 STOP 이 보이고 실제로 정지 요청이 나가는지 본다.
import { act } from 'react';
import { createRoot, type Root as ReactRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalDetail, MapVersion, RobotSummary, User } from '../../../contracts/ts';
import { Root } from '../session';
import { when } from '../screens/history';
import { FakeWS } from './fakeWs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KIM: User = { id: 'a1', username: 'kim', display_name: '김총괄', role: 'ORG_ADMIN', locked: false, robot_ids: [], created_at: '2026-10-19T00:00:00Z' };
const LEE: User = { ...KIM, id: 'o1', username: 'lee', display_name: '이운영', role: 'OPERATOR', robot_ids: ['r-a'] };
const RA: RobotSummary = { id: 'r-a', name: 'Go2-A', model: 'unitree_go2', owner: { id: LEE.id, display_name: LEE.display_name },
  connection: 'OFFLINE', status: null, battery: null, location: null, lease: null, current_run: null, devices: [], attention: [] };
const EMPTY = { zones: [], waypoints: [], connectors: [], edits: [] };
const ver = (id: string, number: number, p: Partial<MapVersion> = {}): MapVersion => ({ upload_id: `up-${id}`, id, floor_id: 'f1', number, base_version_id: 'v2', copied_from_id: null, status: 'PENDING', image_sha256: 'ab'.repeat(32),
  width: 100, height: 80, resolution: 0.05, origin: [-1, -2, 0], features: EMPTY, reason: `판 ${number} 이유`, source: 'EDIT', created_by: LEE.id, created_at: '2026-10-20T05:00:00Z', ...p });
const V2 = ver('v2', 2, { status: 'APPROVED', base_version_id: null, source: 'IMPORT' });
const who = (u: User) => ({ id: u.id, display_name: u.display_name });
/** 결재 하나(상세 모양). 기본 = 이운영의 지도 수정 요청, 1층 판 2 → 판 n */
const ap = (id: string, n: number, p: Partial<ApprovalDetail> = {}): ApprovalDetail => ({ id, kind: 'MAP_REVISION', status: 'PENDING', requester: who(LEE), decider: null, reason: `${id} 요청 이유`,
  decision_comment: null, target: { type: 'map_version', id: `t${n}` }, base_ref: { type: 'map_version', id: 'v2' }, emergency: false,
  created_at: `2026-10-20T0${n}:00:00Z`, decided_at: null, preview: { floor_id: 'f1', floor_name: '1층', target_version_number: n, base_version_number: 2 }, ...p });
const err = (status: number, code: string, message: string, detail = {}) => ({ status, body: { error: { code, message, detail } } });

type Reply = { status: number; body?: unknown } | Response;
type Call = { method: string; path: string; q: URLSearchParams; body?: unknown };
let calls: Call[] = [];
/** 가짜 서버. db = 결재(오래된 것 먼저), page = 한 번에 줄 수(cursor = 다음 시작 위치), over = 경로별 덮어쓰기(앞에서부터 하나씩 꺼냄) */
function serve(me: User, db: ApprovalDetail[], o: { page?: number; pending?: number; over?: Record<string, (Reply | (() => Reply | Promise<Reply>))[]> } = {}) {
  calls = [];
  const approved = { f1: 'v2' as string };
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET', [path, qs = ''] = url.replace(/^\/api\/v1/, '').split('?'), q = new URLSearchParams(qs);
    const body = init.body ? JSON.parse(String(init.body)) : undefined, key = `${method} ${path}`;
    calls.push({ method, path, q, body });
    const queued = o.over?.[key]?.shift();
    if (queued) { const r = typeof queued === 'function' ? await queued() : queued; return r instanceof Response ? r : json(r); }
    return json(route(method, path, q, body));
  });
  const json = (r: { status: number; body?: unknown }) => new Response(r.status === 204 ? null : JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
  const seen = (a: ApprovalDetail) => me.role === 'ORG_ADMIN' || a.requester.id === me.id;
  const plain = ({ preview: _, ...a }: ApprovalDetail) => a;
  function route(method: string, path: string, q: URLSearchParams, body?: { comment?: string; reason?: string }): { status: number; body?: unknown } {
    if (path === '/auth/session') return { status: 200, body: { client: 'web', csrf_token: 'csrf-1' } };
    if (path === '/me') return { status: 200, body: me };
    if (path === '/robots') return { status: 200, body: { items: [RA], next_cursor: null } };
    if (path === '/robots/r-a') return { status: 200, body: RA };
    if (path === '/dashboard') return { status: 200, body: { robots_total: 1, robots_online: 0, robots_attention: 0, robots_running: 0, approvals_pending: o.pending ?? db.filter((a) => seen(a) && a.status === 'PENDING').length, operators: [] } };
    if (path === '/notifications') return { status: 200, body: { items: [], next_cursor: null, unread_count: 0 } };
    if (path === '/approvals') {
      const all = db.filter((a) => seen(a) && (!q.get('status') || a.status === q.get('status'))), from = Number(q.get('cursor') ?? 0), n = o.page ?? Number(q.get('limit'));
      return { status: 200, body: { items: all.slice(from, from + n).map(plain), next_cursor: from + n < all.length ? String(from + n) : null } };
    }
    let m = path.match(/^\/approvals\/([^/]+)(?:\/(approve|reject|cancel))?$/);
    if (m) {
      const a = db.find((x) => x.id === m![1]);
      if (!a || !seen(a)) return err(404, 'NOT_FOUND', '결재 요청을 찾을 수 없습니다.');
      if (!m[2]) return { status: 200, body: a };
      if (a.status !== 'PENDING') return err(409, 'ALREADY_DECIDED', '이미 끝난 요청입니다. 결재 목록을 새로 확인하세요.');
      if (m[2] === 'cancel') { if (a.requester.id !== me.id) return err(403, 'FORBIDDEN', '요청한 사람만 취소할 수 있습니다.'); Object.assign(a, { status: 'CANCELED', decider: who(me), decided_at: '2026-10-20T09:00:00Z' }); return { status: 200, body: plain(a) }; }
      if (me.role !== 'ORG_ADMIN') return err(403, 'FORBIDDEN', '권한이 없습니다.');
      if (a.requester.id === me.id) return err(403, 'FORBIDDEN', '본인이 요청한 결재는 취소만 할 수 있습니다. 다른 총괄에게 처리를 요청하세요.');
      if (m[2] === 'approve' && a.base_ref?.id !== approved.f1) {
        Object.assign(a, { status: 'STALE', decider: who(me), decided_at: '2026-10-20T09:00:00Z' });
        return err(409, 'APPROVAL_STALE', '요청 이후 지도가 바뀌었습니다. 새 승인 판에서 다시 요청하세요.', { approved_version_id: approved.f1 });
      }
      if (m[2] === 'approve') approved.f1 = a.target.id;
      Object.assign(a, { status: m[2] === 'approve' ? 'APPROVED' : 'REJECTED', decider: who(me), decided_at: '2026-10-20T09:00:00Z', decision_comment: (m[2] === 'approve' ? body?.comment : body?.reason) ?? null });
      return { status: 200, body: plain(a) };
    }
    if ((m = path.match(/^\/map-versions\/(t\d+)$/))) return { status: 200, body: ver(m[1], Number(m[1].slice(1))) };
    if ((m = path.match(/^\/map-versions\/(t\d+)\/diff$/))) return { status: 200, body: { version: ver(m[1], Number(m[1].slice(1))), against: V2, image_changed: false, changes: [] } };
    return err(404, 'NOT_FOUND', '찾을 수 없습니다.');
  }
}
const sent = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);
const writes = () => calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`);

let root: ReactRoot | null = null, box: HTMLDivElement;
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); });
async function open(hash: string) {
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  location.hash = hash;
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<Root />); });
  await flush();
}
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const $ = <T extends Element = HTMLElement>(s: string, from: ParentNode = box) => from.querySelector<T>(s);
const btns = (from: ParentNode = box) => [...from.querySelectorAll('button')];
const btn = (t: string, from: ParentNode = box) => btns(from).find((b) => b.textContent === t) as HTMLButtonElement | undefined;
const card = (label: string) => $(`[aria-label="${label}"]`)!;
const click = async (b: Element | undefined | null) => { expect(b).toBeTruthy(); act(() => (b as HTMLElement).click()); await flush(); };
const setVal = async (el: HTMLInputElement, v: string) => {
  act(() => { Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); });
  await flush();
};
const field = (label: string, from: ParentNode = box) => [...from.querySelectorAll('label')].find((l) => l.textContent!.startsWith(label))!.querySelector('input') as HTMLInputElement;
const alertText = () => [...box.querySelectorAll('[role="alert"]')].map((a) => a.textContent).join(' ');
const statusText = () => [...box.querySelectorAll('[role="status"]')].map((a) => a.textContent).join(' ');
const rows = () => [...card('결재 목록').querySelectorAll('button')];
const row = (id: string) => $<HTMLButtonElement>(`[data-approval="${id}"]`)!;
const detail = () => card('결재 내용');
const pick = (id: string) => click(row(id));
/** STOP 이 머리줄 맨 끝에 있고 누를 수 있다 + 실제로 눌러 정지 요청이 실시간 연결로 나간다 */
const stopSends = async () => {
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

describe('결재함(총괄)·내 요청(운영 관리자) 목록', () => {
  it('총괄: 대기 보기 = GET /approvals?status=PENDING(오래된 것 먼저) — 종류·요청자·때·층·판 번호·상태, 배지 = /dashboard 값', async () => {
    serve(KIM, [ap('a1', 3), ap('a2', 4, { kind: 'MAP_ROLLBACK' }), ap('a3', 5, { status: 'APPROVED' })], { pending: 7 });
    await open('#/approval');
    expect($('h1')!.textContent).toBe('결재'); expect(card('결재함').querySelector('h2')!.textContent).toBe('결재함');
    const q = sent('GET', '/approvals');
    expect(q).toHaveLength(1); expect(q[0].q.get('status')).toBe('PENDING'); expect(q[0].q.get('limit')).toBe('20');
    expect(rows().map((b) => b.textContent)).toEqual([`▲대기지도 수정1층 · 판 2 → 판 3이운영 · ${when('2026-10-20T03:00:00Z')}`, `▲대기지도 되돌리기1층 · 판 2 → 판 4이운영 · ${when('2026-10-20T04:00:00Z')}`]);
    expect($('nav a[href="#/approval"]')!.getAttribute('aria-label')).toBe('결재 7건');   // 화면에서 세지 않음
    expect($('nav a[href="#/approval"] .fh-badge')!.textContent).toBe('7');
    await stopSends();
  });
  it('«더 보기» = next_cursor 로 이어 받기, «전체» = status 없이(끝난 것 포함) — STALE 은 «적용 불가(지도가 바뀜)»', async () => {
    serve(KIM, [ap('a1', 3), ap('a2', 4), ap('a3', 5, { status: 'STALE' }), ap('a4', 6, { status: 'REJECTED' })], { page: 1 });
    await open('#/approval');
    expect(rows()).toHaveLength(1);
    await click(btn('더 보기'));
    expect(sent('GET', '/approvals')[1].q.get('cursor')).toBe('1');
    expect(rows().map((b) => b.dataset.approval)).toEqual(['a1', 'a2']);
    expect(btn('더 보기')).toBeUndefined();
    await click(btn('전체', card('보기')));
    const q = sent('GET', '/approvals').slice(-1)[0];
    expect(q.q.has('status')).toBe(false); expect(q.q.has('cursor')).toBe(false);
    expect(rows().map((b) => b.dataset.approval)).toEqual(['a1']);
    await click(btn('더 보기')); await click(btn('더 보기')); await click(btn('더 보기'));
    expect(rows().map((b) => b.querySelector('.lv-chip')!.textContent)).toEqual(['▲대기', '▲대기', '■적용 불가(지도가 바뀜)', '■반려']);
  });
  it('운영 관리자: «내 요청» = 같은 API(서버가 본인 것만), 기본은 전체 보기·요청자 이름 없음, 배지 = 내 대기 수', async () => {
    serve(LEE, [ap('a1', 3), ap('k1', 4, { requester: who(KIM) }), ap('a2', 5, { status: 'REJECTED', decider: who(KIM), decision_comment: '구역이 너무 넓음' })]);
    await open('#/approval');
    expect($('h1')!.textContent).toBe('내 요청');
    expect(card('내 요청').querySelector('h2')!.textContent).toBe('내 요청');
    expect(sent('GET', '/approvals')[0].q.has('status')).toBe(false);
    expect(rows().map((b) => b.dataset.approval)).toEqual(['a1', 'a2']);
    expect(rows()[0].textContent).not.toContain('이운영');
    expect($('nav a[href="#/approval"]')!.getAttribute('aria-label')).toBe('내 요청 1건');
    await pick('a2');
    expect(detail().textContent).toContain('반려 이유구역이 너무 넓음');
    expect(detail().textContent).toContain('처리김총괄');
    expect(btns(detail()).map((b) => b.textContent)).not.toContain('요청 취소');   // 끝난 요청엔 단추 없음
  });
  it('목록 실패 → 오류 + 다시 시도, 형식 어긋남도 오류 한 줄(STOP 그대로)', async () => {
    serve(KIM, [ap('a1', 3)], { over: { 'GET /approvals': [err(503, 'SERVER_BUSY', '잠시 뒤 다시 시도하세요.'), { status: 200, body: { items: [{ id: 1 }], next_cursor: null } }] } });
    await open('#/approval');
    expect(alertText()).toContain('결재 목록을 받지 못했습니다. 잠시 뒤 다시 시도하세요.');
    await click(btn('다시 시도'));
    expect(alertText()).toContain('받은 결재 형식이 맞지 않습니다.');
    await click(btn('다시 시도'));
    expect(rows()).toHaveLength(1);
    await stopSends();
  });
});

describe('상세·전후 비교', () => {
  it('항목 = GET /approvals/{id} → 대상 판을 지도 탭 비교(Compare)로: diff 는 against 없이(대상 판의 기준 판 = base_ref), 요청 이유', async () => {
    serve(KIM, [ap('a1', 3)]);
    await open('#/approval');
    await pick('a1');
    expect(sent('GET', '/approvals/a1').length).toBeGreaterThan(0);
    expect(sent('GET', '/map-versions/t3')).toHaveLength(1);
    const d = sent('GET', '/map-versions/t3/diff');
    expect(d).toHaveLength(1); expect(d[0].q.has('against')).toBe(false);
    expect(card('판 비교').textContent).toContain('판 2 → 판 3');
    expect($<HTMLSelectElement>('select[aria-label="비교할 판"]')!.options[0].textContent).toBe('판 2 (기준 판)');
    expect(detail().textContent).toContain('1층 · 판 2 → 판 3 (요청)');
    expect(detail().textContent).toContain('요청 이유a1 요청 이유');
  });
  it('비교 그림을 받는 중에도 STOP 이 보이고 실제로 정지 요청', async () => {
    serve(KIM, [ap('a1', 3)], { over: { 'GET /map-versions/t3/diff': [() => new Promise<Reply>(() => {})] } });
    await open('#/approval');
    await pick('a1');
    expect(card('판 비교').textContent).toContain('두 판을 비교하는 중…');
    await stopSends();
  });
  it('알림 링크 #/approvals?approval_id=… → 그 결재를 연다(대기 목록에 없는 끝난 것도)', async () => {
    serve(KIM, [ap('a1', 3), ap('a9', 4, { status: 'APPROVED', decider: who(KIM), decision_comment: '확인함' })]);
    await open('#/approvals?approval_id=a9');
    expect(sent('GET', '/approvals/a9').length).toBeGreaterThan(0);
    expect(detail().textContent).toContain('의견확인함');
    expect(btn('승인', detail())).toBeUndefined();
  });
  it('404(없거나 볼 수 없는 결재) → 쉬운 말 + 다시 시도', async () => {
    serve(LEE, [ap('k1', 3, { requester: who(KIM) })]);
    await open('#/approvals?approval_id=k1');
    expect(alertText()).toContain('이 결재 요청을 볼 수 없습니다.');
    expect(btn('다시 시도', card('내용'))).toBeTruthy();
  });
  it('모르는 종류 = «지원 전 종류», 처리 단추·비교 없음', async () => {
    serve(KIM, [ap('x1', 3, { kind: 'SCENARIO_ASSIGNMENT' as ApprovalDetail['kind'], preview: undefined as unknown as ApprovalDetail['preview'] })]);
    await open('#/approval');
    expect(rows()[0].textContent).toContain('지원 전 종류');
    await pick('x1');
    expect(detail().textContent).toContain('이 화면에서 아직 처리할 수 없는 종류의 결재입니다.');
    expect(btn('승인', detail())).toBeUndefined(); expect(btn('반려', detail())).toBeUndefined();
    expect(sent('GET', '/map-versions/t3')).toHaveLength(0);
  });
});

describe('처리', () => {
  it('승인: 확인창 없이 바로(의견 선택) → 안내 + 다음 대기 항목으로, 목록·배지 다시 받기', async () => {
    const db = [ap('a1', 3), ap('a2', 4, { base_ref: null, preview: { floor_id: 'f2', floor_name: '2층', target_version_number: 1, base_version_number: null } })];
    serve(KIM, db);
    await open('#/approval');
    await pick('a1');
    const lists = sent('GET', '/approvals').length, dash = sent('GET', '/dashboard').length;
    await setVal(field('의견(선택)', detail()), '  좋습니다 ');
    await click(btn('승인', detail()));
    expect($('[aria-label="확인"]')).toBeNull();
    expect(writes()).toEqual(['POST /approvals/a1/approve']);
    expect(sent('POST', '/approvals/a1/approve')[0].body).toEqual({ comment: '좋습니다' });
    expect(statusText()).toContain('승인했습니다. 이제 1층의 승인 판은 판 3입니다. 다음 실행부터 이 판을 씁니다.');
    expect(sent('GET', '/approvals').length).toBe(lists + 1); expect(sent('GET', '/dashboard').length).toBe(dash + 1);
    expect(row('a2').getAttribute('aria-pressed')).toBe('true');                 // 다음 항목(F-AP-02)
    expect(detail().textContent).toContain('2층 · 빈 지도 → 판 1');
    await click(btn('승인', detail()));
    expect(sent('POST', '/approvals/a2/approve')[0].body).toEqual({});           // 의견 비우면 보내지 않음
  });
  it('반려: 이유 필수(빈칸·공백만·Cc/Cf 막음) → 확인창(U10) → 보냄. 확인창이 떠 있어도 STOP 이 보이고 실제로 정지 요청', async () => {
    serve(KIM, [ap('a1', 3)]);
    await open('#/approval');
    await pick('a1');
    await click(btn('반려', detail()));
    const form = card('반려');
    for (const [v, m] of [['', '반려 이유를 입력하세요.'], ['   ', '반려 이유를 입력하세요.'], ['​', '반려 이유를 입력하세요.'], ['넓음\t다시', '반려 이유에 탭 같은 보이지 않는 글자는 쓸 수 없습니다']]) {
      await setVal(field('반려 이유', form), v); await click(btn('반려하기', form));
      expect(alertText()).toContain(m); expect($('[aria-label="확인"]')).toBeNull();
    }
    await setVal(field('반려 이유', form), ' 구역이 너무 넓음 '); await click(btn('반려하기', form));
    const ask = card('확인');
    expect(ask.textContent).toContain('이 요청을 반려할까요?');
    expect(writes()).toEqual([]);
    expect(btn('승인', detail())!.disabled).toBe(true);
    await stopSends();
    await click(btn('반려', ask));
    expect(writes()).toEqual(['POST /approvals/a1/reject']);
    expect(sent('POST', '/approvals/a1/reject')[0].body).toEqual({ reason: '구역이 너무 넓음' });
    expect(statusText()).toContain('반려했습니다.');
  });
  it('확인창 «취소» = 보내지 않음', async () => {
    serve(KIM, [ap('a1', 3)]);
    await open('#/approval');
    await pick('a1');
    await click(btn('반려', detail()));
    await setVal(field('반려 이유', card('반려')), '다시'); await click(btn('반려하기', card('반려')));
    await click(btn('취소', card('확인')));
    expect($('[aria-label="확인"]')).toBeNull(); expect(writes()).toEqual([]);
  });
  it('총괄 본인 요청: 승인·반려 없이 «요청 취소»만', async () => {
    serve(KIM, [ap('k1', 3, { requester: who(KIM) })]);
    await open('#/approval');
    await pick('k1');
    expect(btn('승인', detail())).toBeUndefined(); expect(btn('반려', detail())).toBeUndefined();
    expect($('[aria-label="의견(선택)"]')).toBeNull();
    await click(btn('요청 취소', detail()));
    expect(writes()).toEqual(['POST /approvals/k1/cancel']);
    expect(statusText()).toContain('요청을 취소했습니다.');
  });
  it('운영 관리자: 내 대기 요청 = «요청 취소»만 → POST cancel, 상태 «취소», 배지 다시 받기', async () => {
    serve(LEE, [ap('a1', 3)]);
    await open('#/approval');
    await pick('a1');
    expect(btns(detail()).map((b) => b.textContent).filter((t) => ['승인', '반려', '요청 취소'].includes(t!))).toEqual(['요청 취소']);
    const dash = sent('GET', '/dashboard').length;
    await click(btn('요청 취소', detail()));
    expect(writes()).toEqual(['POST /approvals/a1/cancel']);
    expect(statusText()).toContain('요청을 취소했습니다.');
    expect(detail().querySelector('.lv-chip')!.textContent).toBe('○취소');
    expect(row('a1').textContent).toContain('취소');
    expect(sent('GET', '/dashboard').length).toBe(dash + 1);
  });
  it('409 APPROVAL_STALE: 서버 문구 + 다시 받아 «적용 불가(지도가 바뀜)», 승인 단추 없음', async () => {
    const db = [ap('a1', 3), ap('a2', 4)];
    serve(KIM, db);
    await open('#/approval');
    await pick('a1');
    await click(btn('승인', detail()));                                    // 판 3 승인 → 승인 판이 바뀜
    expect(row('a2').getAttribute('aria-pressed')).toBe('true');
    await click(btn('승인', detail()));                                    // 같은 기준(판 2)의 두 번째 요청
    expect(alertText()).toContain('승인하지 못했습니다. 요청 이후 지도가 바뀌었습니다. 새 승인 판에서 다시 요청하세요.');
    expect(detail().textContent).toContain('요청 이후 지도가 바뀌어 이 요청은 더 이상 적용할 수 없습니다.');
    expect(detail().querySelector('.lv-chip')!.textContent).toBe('■적용 불가(지도가 바뀜)');
    expect(btn('승인', detail())).toBeUndefined();
    await stopSends();
  });
  it('409 ALREADY_DECIDED: 다시 받아 지금 상태(다른 총괄이 먼저 승인)', async () => {
    const db = [ap('a1', 3)];
    serve(KIM, db, { over: { 'POST /approvals/a1/approve': [() => { Object.assign(db[0], { status: 'APPROVED', decider: { id: 'a2', display_name: '박총괄' } }); return err(409, 'ALREADY_DECIDED', '이미 끝난 요청입니다. 결재 목록을 새로 확인하세요.'); }] } });
    await open('#/approval');
    await pick('a1');
    await click(btn('승인', detail()));
    expect(alertText()).toContain('이미 끝난 요청입니다. 결재 목록을 새로 확인하세요. 지금 상태를 다시 불러왔습니다.');
    expect(detail().querySelector('.lv-chip')!.textContent).toBe('●승인');
    expect(detail().textContent).toContain('처리박총괄');
    expect(btn('승인', detail())).toBeUndefined();
  });
  it('403 은 서버 문구 그대로, 단추는 남김 / 404 는 다시 받기', async () => {
    serve(KIM, [ap('a1', 3)], { over: { 'POST /approvals/a1/approve': [err(403, 'FORBIDDEN', '권한이 없습니다.'), err(404, 'NOT_FOUND', '결재 요청을 찾을 수 없습니다.')] } });
    await open('#/approval');
    await pick('a1');
    await click(btn('승인', detail()));
    expect(alertText()).toContain('처리하지 못했습니다. 권한이 없습니다.');
    expect(btn('승인', detail())!.disabled).toBe(false);
    const got = sent('GET', '/approvals/a1').length;
    await click(btn('승인', detail()));
    expect(alertText()).toContain('이 결재 요청을 찾을 수 없습니다. 목록을 다시 받습니다.');
    expect(sent('GET', '/approvals/a1').length).toBeGreaterThan(got);
  });
  for (const [name, reply] of [['연결 끊김', () => { throw new TypeError('Failed to fetch'); }], ['200 본문 끊김', () => new Response(new ReadableStream({ start(c) { c.error(new TypeError('stream interrupted')); } }), { status: 200 })],
    ['빈 200', () => new Response('', { status: 200 })]] as const) {
    it(`${name} → 처리 불확실: 지금 상태를 다시 받음(처리됐으면 그 상태로)`, async () => {
      const db = [ap('a1', 3)];
      serve(KIM, db, { over: { 'POST /approvals/a1/approve': [() => { Object.assign(db[0], { status: 'APPROVED', decider: who(KIM) }); return (reply as () => Reply)(); }] } });
      await open('#/approval');
      await pick('a1');
      const got = sent('GET', '/approvals/a1').length, lists = sent('GET', '/approvals').length;
      await click(btn('승인', detail()));
      expect(alertText()).toContain('처리 응답을 받지 못했습니다. 처리됐을 수 있어 지금 상태를 다시 불러옵니다.');
      expect(sent('GET', '/approvals/a1').length).toBe(got + 1); expect(sent('GET', '/approvals').length).toBe(lists + 1);
      expect(detail().querySelector('.lv-chip')!.textContent).toBe('●승인');
      expect(btn('승인', detail())).toBeUndefined();
    });
  }
  it('두 번 누름: 처리 중 요청 1번만, 단추 잠김 — 처리 중에도 STOP 이 보이고 실제로 정지 요청', async () => {
    let answer = (_: Reply) => {};
    serve(KIM, [ap('a1', 3)], { over: { 'POST /approvals/a1/approve': [() => new Promise<Reply>((r) => { answer = r; })] } });
    await open('#/approval');
    await pick('a1');
    const b = btn('승인', detail())!;
    act(() => { b.click(); b.click(); }); await flush();
    expect(sent('POST', '/approvals/a1/approve')).toHaveLength(1);
    expect(b.disabled).toBe(true); expect(btn('반려', detail())!.disabled).toBe(true);
    expect(statusText()).toContain('처리하는 중…');
    await stopSends();
    answer({ status: 200, body: { ...ap('a1', 3), status: 'APPROVED', preview: undefined } }); await flush();
    expect(statusText()).toContain('승인했습니다.');
  });
});

describe('PR #36 검토 — 다시 받는 동안 잠금·늦은 응답·목록 미리 받기', () => {
  type Over = Record<string, (Reply | (() => Reply | Promise<Reply>))[]>;
  it('검토 1: 승인 답이 끊겨 다시 받는 동안 승인·반려 잠김(누름도 안 보냄), 받은 뒤 대기면 다시 열림 — STOP 은 그대로', async () => {
    const db = [ap('a1', 3)], o = { over: {} as Over };
    serve(KIM, db, o);
    await open('#/approval');
    await pick('a1');
    let hold = (_: Reply) => {};
    o.over['POST /approvals/a1/approve'] = [() => { throw new TypeError('Failed to fetch'); }];
    o.over['GET /approvals/a1'] = [() => new Promise<Reply>((r) => { hold = r; })];
    await click(btn('승인', detail()));
    expect(btn('승인', detail())!.disabled).toBe(true); expect(btn('반려', detail())!.disabled).toBe(true);
    expect(field('의견(선택)', detail()).disabled).toBe(true);
    expect(statusText()).toContain('지금 상태를 다시 불러오는 중…');
    act(() => btn('승인', detail())!.click()); await flush();
    expect(sent('POST', '/approvals/a1/approve')).toHaveLength(1);
    await stopSends();
    hold({ status: 200, body: db[0] }); await flush();
    expect(btn('승인', detail())!.disabled).toBe(false);
    expect(statusText()).not.toContain('지금 상태를 다시 불러오는 중…');
  });
  it('검토 1: ALREADY_DECIDED → «다시 불러왔습니다»는 받은 뒤에만, 다시 받기 404 면 기존 상세 위에 오류 + 다시 시도·처리 잠김', async () => {
    const db = [ap('a1', 3)], o = { over: {} as Over };
    serve(KIM, db, o);
    await open('#/approval');
    await pick('a1');
    let hold = (_: Reply) => {};
    o.over['POST /approvals/a1/approve'] = [err(409, 'ALREADY_DECIDED', '이미 끝난 요청입니다. 결재 목록을 새로 확인하세요.')];
    o.over['GET /approvals/a1'] = [() => new Promise<Reply>((r) => { hold = r; })];
    await click(btn('승인', detail()));
    expect(alertText()).toContain('이미 끝난 요청입니다. 결재 목록을 새로 확인하세요. 지금 상태를 다시 불러오는 중입니다.');
    expect(alertText()).not.toContain('다시 불러왔습니다');
    hold(err(404, 'NOT_FOUND', '결재 요청을 찾을 수 없습니다.')); await flush();
    expect(alertText()).toContain('이 결재 요청을 볼 수 없습니다.'); expect(alertText()).toContain('상태를 확인하기 전에는 처리할 수 없습니다.');
    expect(alertText()).not.toContain('다시 불러왔습니다');
    expect(btn('승인', detail())!.disabled).toBe(true); expect(btn('반려', detail())!.disabled).toBe(true);
    Object.assign(db[0], { status: 'APPROVED', decider: { id: 'a2', display_name: '박총괄' } });
    await click(btn('다시 시도', detail()));
    expect(detail().querySelector('.lv-chip')!.textContent).toBe('●승인');
    expect(alertText()).not.toContain('상태를 확인하기 전에는');
  });
  for (const view of ['대기', '전체']) it(`검토 2: 앞 항목의 늦은 승인 성공이 그 사이 고른 항목·입력을 지우지 않음(${view} 보기) — 목록·배지만 새로`, async () => {
    const db = [ap('a1', 3), ap('a2', 4), ap('a3', 5)];
    let answer = (_: Reply) => {};
    serve(KIM, db, { over: { 'POST /approvals/a1/approve': [() => new Promise<Reply>((r) => { answer = r; })] } });
    await open('#/approval');
    if (view === '전체') await click(btn('전체', card('보기')));
    await pick('a1');
    await click(btn('승인', detail()));
    await pick('a3');
    await setVal(field('의견(선택)', detail()), '나중 의견');
    const lists = sent('GET', '/approvals').length, dash = sent('GET', '/dashboard').length, got = sent('GET', '/approvals/a3').length;
    Object.assign(db[0], { status: 'APPROVED', decider: who(KIM) });
    answer({ status: 200, body: { ...db[0], preview: undefined } }); await flush();
    expect(row('a3').getAttribute('aria-pressed')).toBe('true');
    expect(field('의견(선택)', detail()).value).toBe('나중 의견');
    expect(sent('GET', '/approvals/a3').length).toBe(got);                     // 상세를 새로 만들지 않음
    expect(sent('GET', '/approvals').length).toBe(lists + 1); expect(sent('GET', '/dashboard').length).toBe(dash + 1);
    expect(statusText()).not.toContain('승인했습니다');
  });
  it('권고: 목록 줄의 상세 미리 받기는 동시에 4개까지, 모두 한 번씩 / 고른 항목은 상세 칸이 받은 것을 씀(중복 GET 없음)', async () => {
    const db = Array.from({ length: 9 }, (_, i) => ap(`a${i + 1}`, i + 1)), held: (() => void)[] = [];
    const over: Over = {};
    for (const a of db) over[`GET /approvals/${a.id}`] = [() => new Promise<Reply>((r) => held.push(() => r({ status: 200, body: a })))];
    serve(KIM, db, { over });
    await open('#/approval');
    const details = () => calls.filter((c) => c.method === 'GET' && /^\/approvals\/a\d$/.test(c.path)).length;
    expect(details()).toBe(4);
    held.shift()!(); await flush();
    expect(details()).toBe(5);
    while (held.length) { held.shift()!(); await flush(); }
    expect(details()).toBe(9);
    expect(rows()[8].textContent).toContain('1층 · 판 2 → 판 9');
    act(() => root?.unmount()); box.remove();
    let mine = (_: Reply) => {};
    const two = [ap('a1', 3), ap('a2', 4)];
    serve(KIM, two, { over: { 'GET /approvals/a1': [() => new Promise<Reply>((r) => { mine = r; })] } });   // 상세 칸 답이 목록보다 늦어도
    await open('#/approvals?approval_id=a1');
    expect(sent('GET', '/approvals/a1')).toHaveLength(1);
    mine({ status: 200, body: two[0] }); await flush();
    expect(sent('GET', '/approvals/a1')).toHaveLength(1); expect(sent('GET', '/approvals/a2')).toHaveLength(1);
    expect(row('a1').textContent).toContain('1층 · 판 2 → 판 3');
  });
  it('권고: 의견·반려 이유 2000자 경계 — 칸이 2000자까지, 2000자는 그대로 보냄', async () => {
    serve(KIM, [ap('a1', 3), ap('a2', 4)]);
    await open('#/approval');
    await pick('a1');
    const long = '가'.repeat(2000);
    expect(field('의견(선택)', detail()).maxLength).toBe(2000);
    await setVal(field('의견(선택)', detail()), long);
    await click(btn('승인', detail()));
    expect((sent('POST', '/approvals/a1/approve')[0].body as { comment: string }).comment).toHaveLength(2000);
    await click(btn('반려', detail()));
    expect(field('반려 이유', card('반려')).maxLength).toBe(2000);
    await setVal(field('반려 이유', card('반려')), long); await click(btn('반려하기', card('반려')));
    await click(btn('반려', card('확인')));
    expect((sent('POST', '/approvals/a2/reject')[0].body as { reason: string }).reason).toHaveLength(2000);
  });
  it('권고: «더 보기» 답을 기다리는 사이 보기를 바꾸면 늦게 온 앞 보기 답은 버림', async () => {
    const o = { page: 1, over: {} as Over };
    serve(KIM, [ap('a1', 3), ap('a2', 4), ap('a3', 5, { status: 'APPROVED' })], o);
    await open('#/approval');
    let late = (_: Reply) => {};
    o.over['GET /approvals'] = [() => new Promise<Reply>((r) => { late = r; })];
    await click(btn('더 보기'));
    await click(btn('전체', card('보기')));
    expect(rows().map((b) => b.dataset.approval)).toEqual(['a1']);
    late({ status: 200, body: { items: [{ ...ap('a2', 4), preview: undefined }], next_cursor: null } }); await flush();
    expect(rows().map((b) => b.dataset.approval)).toEqual(['a1']);
    expect(btn('더 보기')).toBeTruthy();                                        // 전체 보기의 cursor 그대로
    await click(btn('더 보기'));
    expect(sent('GET', '/approvals').slice(-1)[0].q.has('status')).toBe(false);
  });
  it('권고: 배지 — 늦게 온 옛 /dashboard 답이 처리 뒤 새 값을 덮지 않음', async () => {
    let late = (_: Reply) => {};
    serve(KIM, [ap('a1', 3)], { over: { 'GET /dashboard': [() => new Promise<Reply>((r) => { late = r; })] } });
    await open('#/approval');
    await pick('a1');
    await click(btn('승인', detail()));
    expect($('nav a[href="#/approval"] .fh-badge')).toBeNull();               // 처리 뒤 답: 대기 0
    late({ status: 200, body: { robots_total: 1, robots_online: 0, robots_attention: 0, robots_running: 0, approvals_pending: 5, operators: [] } }); await flush();
    expect($('nav a[href="#/approval"] .fh-badge')).toBeNull();
  });
});
