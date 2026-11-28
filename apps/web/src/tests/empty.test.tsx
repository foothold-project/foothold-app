// 빈 화면(U11-04 · u11_6 로봇 · u11_7 지도 · u11_8 기록): 아이콘 하나 · 한 줄 까닭 · 다음 할 일 단추 하나. 생성 그림 없음(선 아이콘 svg)
import { act } from 'react';
import { createRoot, type Root as ReactRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RobotSummary, SiteTree, User } from '../../../contracts/ts';
import { Root } from '../session';
import { FakeWS } from './fakeWs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KIM: User = { id: 'a1', username: 'kim', display_name: '김총괄', role: 'ORG_ADMIN', locked: false, robot_ids: [], created_at: '2026-10-19T00:00:00Z' };
const LEE: User = { ...KIM, id: 'o1', username: 'lee', display_name: '이운영', role: 'OPERATOR', robot_ids: [] };
const RA: RobotSummary = { id: 'r-a', name: 'Go2-A', model: 'unitree_go2', owner: { id: LEE.id, display_name: LEE.display_name }, simulation: false, server_drive_allowed: false,
  connection: 'OFFLINE', status: null, battery: null, location: null, lease: null, current_run: null, devices: [], attention: [] };
const tree = (floors: boolean) => ({ items: floors ? [{ id: 's1', name: '본관', purpose: 'REAL', buildings: [{ id: 'b1', site_id: 's1', name: '본동',
  floors: [{ id: 'f1', building_id: 'b1', name: '1층', level: 1, approved_version_id: null, pending_count: 0 }] }] }] : [], next_cursor: null }) as unknown as SiteTree;
const ok = (body: unknown) => ({ status: 200, body });
const page = (items: unknown[]) => ok({ items, next_cursor: null });

function serve(me: User, robots: RobotSummary[], more: Record<string, { status: number; body?: unknown }> = {}) {
  const routes: Record<string, { status: number; body?: unknown }> = {
    'GET /auth/session': ok({ client: 'web', csrf_token: 'csrf-1' }), 'GET /me': ok(me), 'GET /robots': page(robots),
    'GET /dashboard': ok({ robots_total: robots.length, robots_online: 0, robots_attention: 0, robots_running: 0, approvals_pending: 0, operators: [] }),
    'GET /notifications': ok({ items: [], next_cursor: null, unread_count: 0 }), 'GET /events': page([]), 'GET /approvals': page([]),
    'GET /users': page([KIM, LEE]), 'GET /sites': ok(tree(true)), 'GET /floors/f1/map-versions': page([]), ...more,
  };
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const [path] = url.replace(/^\/api\/v1/, '').split('?');
    const rep = routes[`${init.method ?? 'GET'} ${path}`] ?? { status: 404, body: { error: { code: 'NOT_FOUND', message: '찾을 수 없습니다.', detail: {} } } };
    return new Response(JSON.stringify(rep.body), { status: rep.status, headers: { 'Content-Type': 'application/json' } });
  });
}

let root: ReactRoot | null = null, box: HTMLDivElement;
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); });
async function open(hash: string, phone = false) {
  if (phone) vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Linux; Android 14; wv) FootholdApp/1.2.5-dev');
  window.matchMedia = ((q: string) => ({ matches: phone, media: q, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia;
  vi.stubGlobal('WebSocket', FakeWS);
  location.hash = hash;
  box = document.createElement('div'); document.body.append(box);
  act(() => { root = createRoot(box); root.render(<Root />); });
  await flush();
}
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const $ = (s: string) => box.querySelector<HTMLElement>(s);
/** 빈 칸 하나: 선 아이콘(svg) · 제목 · 한 줄 까닭(p 하나) · 다음 할 일(단추 · 링크) */
function empty(kind: string) {
  const e = $(`[data-empty="${kind}"]`);
  expect(e, kind).toBeTruthy();
  expect(e!.querySelectorAll('svg[data-empty-icon]')).toHaveLength(1);
  expect(e!.querySelector('img, canvas')).toBeNull();   // 생성 그림 · 그림 파일 없음
  const why = e!.querySelectorAll('p');
  expect(why).toHaveLength(1);
  expect(why[0].textContent).not.toMatch(/—/);
  return { e: e!, title: e!.querySelector('h2')!.textContent, why: why[0].textContent, acts: [...e!.querySelectorAll<HTMLElement>('a, button')].map((x) => x.textContent) };
}

describe('로봇 0대', () => {
  it('총괄: 아이콘 · 한 줄 까닭 · «시뮬 탭 열기» 하나', async () => {
    serve(KIM, []); await open('#/fleet');
    const r = empty('robots');
    expect(r.title).toBe('등록된 로봇이 없습니다');
    expect(r.acts).toEqual(['시뮬 탭 열기']);
    expect(r.why).toBe('운영 관리자가 실기 로봇을 연결하거나 «시뮬 탭 열기»에서 띄우면 여기에 보입니다.');   // 메뉴에 없는 «시뮬» 탭을 가리키지 않음(#542 U0-01 · #559 N2)
    expect(($('[data-empty="robots"] a') as HTMLAnchorElement).getAttribute('href')).toBe('#/sim');
  });
  it('운영자: 아이콘 · 한 줄 까닭 · 칠한 주 행동은 «+ 새 로봇 추가» 하나 + 칠하지 않은 보조 링크 «시뮬 탭 열기»(#542 U0-01 · #559 N2 · 08:27)', async () => {
    serve(LEE, []); await open('#/fleet');
    const r = empty('robots');
    expect(r.title).toBe('담당 로봇이 없습니다');
    expect(r.acts).toEqual(['+ 새 로봇 추가', '시뮬 탭 열기']);
    expect([...r.e.querySelectorAll('.btn.pri')].map((x) => x.textContent)).toEqual(['+ 새 로봇 추가']);   // 칠한 단추 하나
    const sim = r.e.querySelector<HTMLAnchorElement>('a[href="#/sim"]')!;
    expect(sim.textContent).toBe('시뮬 탭 열기');
    expect(sim.className).toBe('btn');
    expect(r.why).toBe('연결 코드로 실기를 등록하거나 총괄에게 담당 지정을 요청하세요. 시뮬 로봇은 «시뮬 탭 열기»에서 띄웁니다.');
    expect($('[data-pair-start]')).toBeTruthy();
  });
});

describe('지도 없음', () => {
  it('지도(장소)가 하나도 없으면: 아이콘 · 한 줄 까닭 · 다음 할 일 하나(담당 실기 없음 = «+ 파일 올리기»)', async () => {
    serve(KIM, [RA], { 'GET /sites': ok(tree(false)) }); await open('#/map');
    const r = empty('map');
    expect(r.title).toBe('아직 지도가 없습니다');
    expect(r.acts).toEqual(['+ 파일 올리기']);
  });
  // 칠한 단추는 STOP 말고 하나(검수 07:47): 지도 0 개면 빈 칸 단추와 같은 위 단추를 숨기고, 1 개 이상이면 위 단추 그대로
  const filled = () => [...box.querySelectorAll<HTMLElement>('main .btn.pri')].map((b) => b.textContent);
  it('지도 0 개(담당 실기 없음): 위 «+ 파일 올리기» 없음 · 칠한 단추는 빈 칸 것 하나 · «+ 지형 만들기» 그대로', async () => {
    serve(KIM, [RA], { 'GET /sites': ok(tree(false)) }); await open('#/map');
    expect($('[data-make-file]')).toBeNull();
    expect(filled()).toEqual(['+ 파일 올리기']);
    expect($('[data-empty="map"] .btn.pri')!.textContent).toBe('+ 파일 올리기');
    expect($('[data-terrain-enter]')).toBeTruthy();
  });
  it('지도 0 개(담당 실기 있음): 위 «+ 지도 만들기» 없음 · 위 «+ 파일 올리기»는 칠하지 않은 채 남음', async () => {
    serve({ ...LEE, robot_ids: ['r-a'] }, [RA], { 'GET /sites': ok(tree(false)) }); await open('#/map');
    expect($('[data-make-robot]')).toBeNull();
    expect($('[data-make-file]')!.classList.contains('pri')).toBe(false);
    expect(filled()).toEqual(['+ 지도 만들기']);
  });
  it('지도 1 개 이상: 위 «+ 파일 올리기» 그대로(칠함) · 빈 칸 없음', async () => {
    serve(KIM, [RA]); await open('#/map');
    expect($('[data-empty="map"]')).toBeNull();
    expect($('[data-make-file]')!.classList.contains('pri')).toBe(true);
  });
  it('고른 층에 지도가 없으면: 아이콘 · 한 줄 까닭 · «새 지도 올리기…» 하나(«지도 만들기»는 ··· 메뉴)', async () => {
    serve(KIM, [RA]); await open('#/map');
    const b = box.querySelector<HTMLButtonElement>('[aria-label="지도 고르기"] [data-building]');
    if (b) { act(() => b.click()); await flush(); }
    const r = empty('floor');
    expect(r.title).toBe('이 층에 아직 지도가 없습니다');
    expect(r.acts).toEqual(['새 지도 올리기…']);
  });
});

describe('기록 없음', () => {
  it('PC 거른 조건 없이 0 건: 시안 u11_8 빈 기록(그림 · 제목 · 한 줄 까닭, 단추 없음 · 옛 Empty 아님)', async () => {
    serve(LEE, [RA]); await open('#/history');
    const e = $('[data-empty="log"]')!;
    expect(e.classList.contains('pane')).toBe(true);
    expect(e.querySelector('h2')!.textContent).toBe('아직 기록이 없습니다');
    expect(e.querySelectorAll('p')).toHaveLength(1);
    expect(e.querySelectorAll('svg.art')).toHaveLength(1);
    expect(e.querySelector('img, canvas, a, button')).toBeNull();
    expect($('[data-empty="records"]')).toBeNull();
  });
  it('폰(담당 로봇 0대): 지도 탭이 없어 다음 할 일은 «조종 화면으로» 하나', async () => {
    serve(LEE, []); await open('#/history', true);
    const r = empty('records');
    expect(r.acts).toEqual(['조종 화면으로']);
    expect(($('[data-empty="records"] a') as HTMLAnchorElement).getAttribute('href')).toBe('#/drive');
  });
});
