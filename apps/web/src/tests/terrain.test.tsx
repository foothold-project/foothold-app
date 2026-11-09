// 지형 만들기 화면(TERRAIN-EDITOR 1단계): 놓기 · 고치기 · 오류 표시 · 저장 키 · 열기 주소 · 목록·지우기 · 입구
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiFail } from '../api';
import type { Terrain as ServerTerrain } from '../../../contracts/ts';
import { App } from '../App';
import { ROBOTS, USERS, type Robot } from './fixtures';
import './fakeWs';
import { tabFromHash, tabsFor } from '../menu';
import { SimPick } from '../simstart';
import { Terrain, keyOf, terrainUrl } from '../screens/terrain';
import { buildTerrain, validateTerrain, type TerrainItem as Item, type TerrainSpec as Spec } from '../../../../mobile/sim/terrain/index.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null, box: HTMLDivElement;
const render = (el: JSX.Element) => { box = document.createElement('div'); document.body.append(box); act(() => { root = createRoot(box); root.render(el); }); };
const apiUser = (role: 'ORG_ADMIN' | 'OPERATOR'): Awaited<ReturnType<typeof api.me>> => ({ id: 'u-test', username: 'test', display_name: '시험', role, locked: false, robot_ids: [], created_at: '2026-11-09T00:00:00Z' });
beforeEach(() => {
  localStorage.clear();
  vi.spyOn(api, 'terrains').mockReturnValue(new Promise(() => {}));
  vi.spyOn(api, 'me').mockReturnValue(new Promise(() => {}));
});
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); vi.restoreAllMocks(); localStorage.clear(); });
const $ = <T extends Element = HTMLElement>(s: string) => box.querySelector<T>(s)!;
const click = (s: string) => act(() => { $(s).click(); });

// 판을 1 m = 10 px 로 잡는다: 기본 12×12 m 바닥 + 여백 0.72 m → 134.4 px 정사각, 화면 (px) = (x + 6.72) × 10, (6.72 − y) × 10
const pin = () => vi.spyOn($('[data-terrain-board]'), 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 134.4, height: 134.4 } as DOMRect);
const pt = (x: number, y: number) => ({ bubbles: true, clientX: (x + 6.72) * 10, clientY: (6.72 - y) * 10 });
const fire = (el: Element, type: string, x: number, y: number) => act(() => { el.dispatchEvent(new MouseEvent(type, pt(x, y))); });
const put = (tool: string, x: number, y: number) => { pin(); click(`[data-terrain-tool="${tool}"]`); fire($('[data-terrain-board]'), 'pointerdown', x, y); };
const stored = (): Spec => { const k = Object.keys(localStorage).find((x) => x.startsWith('fh.customTerrain.') && !x.endsWith(':base'))!; return JSON.parse(localStorage.getItem(k)!); };
/** 숫자·글자 칸에 치기(React 가 듣는 네이티브 설정) */
function type(input: HTMLInputElement, v: string) {
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, v); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
const field = (label: string) => [...box.querySelectorAll('label')].find((l) => l.textContent?.startsWith(label))!.querySelector('input')!;

const base = (items: Item[], over: Partial<Spec> = {}): Spec => ({ schema: 'fh_custom_terrain/1', id: 't-a', name: '시험', size: [12, 12], spawn: [-5, 0, 0], items, ...over });
const at = { x: 2, y: 2, yaw: 0 };
const msgs = (s: Spec) => { const r = validateTerrain(s); return { e: r.errors.map((x) => x.msg).join(), w: r.warnings.map((x) => x.msg).join() }; };

describe('지형 약속 판정', () => {
  it('맞는 지형은 오류·경고 0', () => {
    expect(validateTerrain(base([{ ...at, kind: 'box', sx: 1, sy: 1, h: 0.2 }, { ...at, x: -1, kind: 'stairs', width: 1, steps: 3, rise: 0.12, run: 0.3 }, { ...at, y: -2, kind: 'ramp', length: 2, width: 1, h: 0.3 }, { ...at, y: 4, kind: 'gap', length: 0.4, width: 1 }])))
      .toEqual({ errors: [], warnings: [] });
  });
  it('한계: 크기·개수·높이·단·경사·바닥 밖', () => {
    expect(msgs(base([], { size: [3, 12], spawn: [0, 0, 0] })).e).toMatch('4~30');
    expect(msgs(base([], { size: [31, 12] })).e).toMatch('4~30');
    expect(msgs(base(Array.from({ length: 61 }, () => ({ ...at, kind: 'gap' as const, length: 0.1, width: 0.1 })))).e).toMatch('60개 이하');
    expect(msgs(base([{ ...at, kind: 'box', sx: 1, sy: 1, h: 1.1 }])).e).toMatch('높이는');
    expect(msgs(base([{ ...at, kind: 'stairs', width: 1, steps: 2, rise: 0.26, run: 0.3 }])).e).toMatch('단 높이');
    expect(msgs(base([{ ...at, kind: 'stairs', width: 1, steps: 2, rise: 0.01, run: 0.3 }])).e).toMatch('단 높이');
    expect(msgs(base([{ ...at, kind: 'stairs', width: 1, steps: 2, rise: 0.1, run: 0.1 }])).e).toMatch('단 깊이');
    expect(msgs(base([{ ...at, kind: 'stairs', width: 1, steps: 2.5, rise: 0.1, run: 0.3 }])).e).toMatch('계단 수');
    expect(msgs(base([{ ...at, kind: 'ramp', length: 1, width: 1, h: 0.6 }])).e).toMatch('30°');   // atan(.6/1) = 31°
    expect(msgs(base([{ ...at, x: 5.6, kind: 'box', sx: 1, sy: 1, h: 0.2 }])).e).toMatch('바닥 안');
  });
  it('돌린 물체의 바닥 안·면적: 계단 길이 = 단 × 깊이 + 끝 평판 1 m', () => {
    const b = { kind: 'box', x: 5.4, y: 0, sx: 1, sy: 1, h: 0.2 } as const;
    expect(msgs(base([{ ...b, yaw: 0 }])).e).toBe('');                       // 5.4 + 0.5 < 6
    expect(msgs(base([{ ...b, yaw: Math.PI / 4 }])).e).toMatch('바닥 안');   // 5.4 + 0.707 > 6
    const s = { kind: 'stairs', x: 4.5, y: 0, yaw: 0, width: 1, rise: 0.1, run: 0.3 } as const;
    expect(msgs(base([{ ...s, steps: 5 }])).e).toBe('');                     // 길이 2.5: 4.5 + 1.25 < 6
    expect(msgs(base([{ ...s, steps: 8 }])).e).toMatch('바닥 안');           // 길이 3.4: 4.5 + 1.7 > 6
  });
  it('경고: 단 높이 > 0.17 · 경사 > 20° · 틈 > 0.6 m (열 수는 있음 = 오류 0)', () => {
    const w = (it: Item) => { const r = msgs(base([it])); expect(r.e).toBe(''); return r.w; };
    expect(w({ ...at, kind: 'stairs', width: 1, steps: 2, rise: 0.18, run: 0.3 })).toMatch('AME-2');
    expect(w({ ...at, kind: 'ramp', length: 1, width: 1, h: 0.4 })).toMatch('20°');
    expect(w({ ...at, kind: 'gap', length: 0.7, width: 1 })).toMatch('0.6 m');
  });
  it('시작 위치: 물체·틈과 바닥 가장자리에서 0.45 m', () => {
    const b = { kind: 'gap', x: 0, y: 0, yaw: 0, length: 1, width: 1 } as const;
    expect(msgs(base([b], { spawn: [0.9, 0, 0] })).e).toMatch('0.45');   // 면적 끝 0.5 에서 0.4
    expect(msgs(base([b], { spawn: [1, 0, 0] })).e).toBe('');            // 0.5
    expect(msgs(base([], { spawn: [5.7, 0, 0] })).e).toMatch('가장자리');
  });
});

describe('지형 만들기 화면', () => {
  it('놓기: 도구 고르고 판을 누르면 그 자리(5 cm 눈금)에 놓이고 저장, 도구는 고르기로', () => {
    render(<Terrain />);
    put('box', 1.03, -2.02);
    expect(stored().items).toMatchObject([{ kind: 'box', x: 1.05, y: -2 }]);
    expect($('[data-terrain-tool="select"]').getAttribute('aria-pressed')).toBe('true');
    expect($('[data-terrain-item="0"]').dataset.kind).toBe('box');
    put('stairs', 2, 3); put('ramp', 2, -3); put('gap', -1, 3);
    expect(stored().items.map((i) => i.kind)).toEqual(['box', 'stairs', 'ramp', 'gap']);
  });

  it('화면에서 만든 저장본을 공통 모듈이 그대로 변환한다', () => {
    render(<Terrain />);
    put('box', 1, 3); put('stairs', 1, -2); put('ramp', 2, 0.5); put('gap', -2, 3);
    const s = stored();
    expect(validateTerrain(s).errors).toEqual([]);
    const built = buildTerrain(s);
    expect(built.xml).toContain('<mujoco');
    expect(built.map.spawn_xyyaw).toEqual(s.spawn);
    expect(built.scene.models.length).toBeGreaterThan(0);
  });

  it('시작 위치 놓기, 저장본 형식은 약속 그대로', () => {
    render(<Terrain />);
    put('spawn', -3, 2);
    const s = stored();
    expect(s.spawn).toEqual([-3, 2, 0]);
    expect(s.schema).toBe('fh_custom_terrain/1');
    expect(s.id).toMatch(/^[a-z0-9-]{1,32}$/);
    expect(localStorage.getItem(keyOf(s.id))).toBe(JSON.stringify(s));
    expect(keyOf(s.id)).toBe(`fh.customTerrain.${s.id}`);
  });

  it('고치기: 칸으로 크기·높이·단 수, 끌어 옮기기, 손잡이로 돌리기, 방향키, 지우기', () => {
    render(<Terrain />);
    put('stairs', 1, 1);
    type(field('단 수'), '7');
    type(field('단 높이'), '0.1');
    expect(stored().items[0]).toMatchObject({ steps: 7, rise: 0.1 });
    type(field('방향'), '90');
    expect((stored().items[0]).yaw).toBeCloseTo(Math.PI / 2, 3);
    type(field('방향'), '0');

    const board = $('[data-terrain-board]');
    fire($('[data-terrain-item="0"]'), 'pointerdown', 1, 1);
    fire(board, 'pointermove', 2, 3);
    fire(board, 'pointerup', 2, 3);
    expect(stored().items[0]).toMatchObject({ x: 2, y: 3 });

    const turn = box.querySelectorAll('[data-terrain-turn] circle')[1];
    fire(turn, 'pointerdown', 4, 3);
    fire(board, 'pointermove', 2, 5);   // 물체 (2,3) 에서 위쪽 = +90°
    fire(board, 'pointerup', 2, 5);
    expect(stored().items[0].yaw).toBeCloseTo(Math.PI / 2, 3);

    act(() => { board.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); });
    expect(stored().items[0].x).toBe(1.95);
    act(() => { board.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })); });
    expect(stored().items).toEqual([]);
  });

  it('짧게 눌러 고르기만 하면 옮겨지지 않는다', () => {
    render(<Terrain />);
    put('box', 1, 1);
    const board = $('[data-terrain-board]');
    fire(board, 'pointerdown', -5, 5);   // 빈 곳 = 고르기 해제
    expect($('[data-terrain-del]')).toBeNull();
    fire($('[data-terrain-item="0"]'), 'pointerdown', 1.2, 1.2);
    fire(board, 'pointermove', 1.22, 1.2);   // 3 px 안 흔들림
    fire(board, 'pointerup', 1.22, 1.2);
    expect(stored().items[0]).toMatchObject({ x: 1, y: 1 });
    expect($('[data-terrain-del]')).toBeTruthy();
  });

  it('오류: 물체 옆·목록에 표시, 열기 막힘 / 경고: 표시만, 열림', () => {
    render(<Terrain />);
    put('stairs', 0, 0);
    expect($('[data-terrain-open]').tagName).toBe('A');
    type(field('단 수'), '3');
    type(field('단 높이'), '0.3');
    expect($('[data-terrain-item="0"]').dataset.state).toBe('bad');
    expect($('[data-terrain-issue="0"]').textContent).toMatch('단 높이는');
    expect($('[data-terrain-row-issue="0"]').textContent).toMatch('단 높이는');
    expect($('[data-terrain-open]').tagName).toBe('BUTTON');
    expect($<HTMLButtonElement>('[data-terrain-open]').disabled).toBe(true);
    expect($('[data-terrain-count]').textContent).toMatch('오류 1');

    type(field('단 높이'), '0.2');
    expect($('[data-terrain-item="0"]').dataset.state).toBe('warn');
    expect($('[data-terrain-issue="0"]').textContent).toMatch('AME-2');
    expect($('[data-terrain-open]').tagName).toBe('A');
    expect($('[data-terrain-count]').textContent).toMatch('경고 1');
  });

  it('지형 전체 오류(바닥 크기)는 물체가 없어도 보이고 열기를 막는다', () => {
    render(<Terrain />);
    type(field('가로'), '40');
    expect($('[aria-label="지형 전체 오류·경고"]').textContent).toMatch('4~30');
    expect($<HTMLButtonElement>('[data-terrain-open]').disabled).toBe(true);
  });

  it('열기 주소·열 때 저장: 약속의 주소, 빈 지형도 누르는 순간 저장돼 시뮬이 읽을 수 있다', () => {
    render(<Terrain />);
    const id = () => $<HTMLAnchorElement>('[data-terrain-open]').getAttribute('href')!.split('terrain=')[1];
    expect($('[data-terrain-open]').getAttribute('href')).toBe(`/sim/index.html?from=web&map=custom&terrain=${id()}`);
    expect(terrainUrl('t-1')).toBe('/sim/index.html?from=web&map=custom&terrain=t-1');
    expect(localStorage.getItem(keyOf(id()))).toBeNull();   // 처음 연 빈 지형은 아직 안 저장
    const e = new MouseEvent('click', { bubbles: true, cancelable: true });
    const seen: boolean[] = [], after = (ev: Event) => { seen.push(ev.defaultPrevented); ev.preventDefault(); };   // React(root) 다음에 본다 — 화면은 막지 않았고, jsdom 이동만 여기서 막음
    document.addEventListener('click', after);
    act(() => { $('[data-terrain-open]').dispatchEvent(e); });
    document.removeEventListener('click', after);
    expect(seen).toEqual([false]);
    expect(JSON.parse(localStorage.getItem(keyOf(id()))!).id).toBe(id());
  });

  it('저장 실패: 이유를 보이고 이동을 막는다', () => {
    render(<Terrain />);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full'); });
    const e = new MouseEvent('click', { bubbles: true, cancelable: true });
    act(() => { $('[data-terrain-open]').dispatchEvent(e); });
    expect(e.defaultPrevented).toBe(true);
    expect($('[data-terrain-failed]').textContent).toMatch('저장하지 못했습니다');
  });

  it('목록: 다시 들어오면 마지막 지형, 다른 지형 열기, 두 번 눌러 지우기', () => {
    render(<Terrain />);
    type($<HTMLInputElement>('[data-terrain-name]'), '첫째');
    put('box', 1, 1);
    const first = stored().id;
    click('[data-terrain-new]');
    expect($<HTMLInputElement>('[data-terrain-name]').value).toBe('새 지형');
    type($<HTMLInputElement>('[data-terrain-name]'), '둘째');
    expect(box.querySelectorAll('[data-terrain-saved]').length).toBe(2);

    act(() => root!.unmount());
    render(<Terrain />);
    expect($<HTMLInputElement>('[data-terrain-name]').value).toBe('둘째');
    act(() => { $(`[data-terrain-saved="${first}"] .mx-name`).click(); });
    expect($<HTMLInputElement>('[data-terrain-name]').value).toBe('첫째');
    expect($('[data-terrain-item="0"]')).toBeTruthy();

    act(() => { $(`[data-terrain-saved="${first}"] [data-terrain-wipe]`).click(); });
    expect(localStorage.getItem(keyOf(first))).not.toBeNull();   // 한 번 눌렀을 때는 묻기만
    click('[data-terrain-wipe-yes]');
    expect(localStorage.getItem(keyOf(first))).toBeNull();
    expect($<HTMLInputElement>('[data-terrain-name]').value).toBe('새 지형');   // 지운 게 지금 지형이면 새 지형으로
  });

  it('깨진 저장본: 화면이 죽지 않고 목록에서 지울 수 있다', () => {
    localStorage.setItem('fh.customTerrain.bad', '{not json');
    localStorage.setItem('fh.customTerrain.old', JSON.stringify({ schema: 'fh_custom_terrain/1', id: 'old', name: 'x', size: [5, 5], spawn: [0, 0, 0], items: [{ kind: 'box', x: 0 }] }));
    localStorage.setItem('fh.customTerrainLast', 'bad');
    render(<Terrain />);
    expect($<HTMLInputElement>('[data-terrain-name]').value).toBe('새 지형');
    expect($('[data-terrain-saved="bad"]').textContent).toMatch('읽을 수 없는');
    expect($('[data-terrain-saved="old"]').textContent).toMatch('읽을 수 없는');
    expect($<HTMLButtonElement>('[data-terrain-saved="bad"] .mx-name').disabled).toBe(true);
    act(() => { $('[data-terrain-saved="bad"] [data-terrain-wipe]').click(); });
    click('[data-terrain-wipe-yes]');
    expect(localStorage.getItem('fh.customTerrain.bad')).toBeNull();
  });

  it('60개면 더 놓는 도구가 막힌다', () => {
    localStorage.setItem('fh.customTerrain.t-f', JSON.stringify(base(Array.from({ length: 60 }, (_, i) => ({ kind: 'gap' as const, x: 2, y: -5 + i / 10, yaw: 0, length: 0.1, width: 0.1 })), { id: 't-f' })));
    localStorage.setItem('fh.customTerrainLast', 't-f');
    render(<Terrain />);
    expect($<HTMLButtonElement>('[data-terrain-tool="box"]').disabled).toBe(true);
    expect($<HTMLButtonElement>('[data-terrain-tool="spawn"]').disabled).toBe(false);
  });
});

describe('입구', () => {
  it('PC 틀에만 있는 숨은 탭: 메뉴엔 없고 주소로 열림, 폰 틀은 첫 탭', () => {
    expect(tabFromHash('#/terrain', false)).toBe('terrain');
    expect(tabFromHash('#/terrain', true)).toBe('drive');
    expect(tabsFor(false).find((t) => t.id === 'terrain')?.hidden).toBe(true);
  });
  const app = (phone: boolean, hash: string, robots: Robot[] = ROBOTS) => {
    window.matchMedia = ((q: string) => ({ matches: phone, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    location.hash = hash;
    render(<App user={USERS.find((u) => u.id === 'u-kim')} robots={robots} />);
  };
  it('App: PC #/terrain 은 로봇 유무와 상관없이 열리고, 메뉴에 칸은 없다', () => {
    app(false, '#/terrain');
    expect($('[data-terrain]')).toBeTruthy();
    expect($('.fh-nav').textContent).not.toMatch('지형');
    act(() => root!.unmount()); box.remove();
    app(false, '#/terrain', []);
    expect($('[data-terrain]')).toBeTruthy();
  });
  it('App: 폰 틀은 #/terrain 으로 와도 지형 화면을 열지 않는다', () => {
    app(true, '#/terrain');
    expect($('[data-terrain]')).toBeNull();
  });
  it('App: PC «시뮬» 탭에 입구가 있고 폰 로봇 연결 화면에는 없다', () => {
    app(false, '#/sim');
    expect($('[data-terrain-enter]').getAttribute('href')).toBe('#/terrain');
    act(() => root!.unmount()); box.remove();
    app(true, '#/drive', []);
    expect($('[data-sim-app]')).toBeTruthy();
    expect($('[data-terrain-enter]')).toBeNull();
  });
  it('시작 화면: PC 탭(make)만 «지형 만들기», 폰·앱은 없음', () => {
    render(<SimPick make />);
    expect($('[data-terrain-enter]').getAttribute('href')).toBe('#/terrain');
    act(() => root!.unmount()); box.remove();
    render(<SimPick />);
    expect($('[data-terrain-enter]')).toBeNull();
  });
});


const settle = () => act(async () => { await Promise.resolve(); });
const serverTerrain = (spec: Spec, version = 1): ServerTerrain => ({ spec, version, floor_id: 'floor-terrain', map_version_id: 'map-terrain', archived_at: null, updated_at: '2026-11-09T00:00:00Z' });

describe('조직 지형 저장', () => {
  beforeEach(() => {
    vi.mocked(api.terrains).mockResolvedValue([]);
    vi.mocked(api.me).mockResolvedValue(apiUser('ORG_ADMIN'));
  });
  it('로컬 저장본을 한 번에 서버로 올리고 로컬은 남긴다, 다시 저장은 읽은 수정 번호를 쓴다', async () => {
    const spec = base([]);
    localStorage.setItem(keyOf(spec.id), JSON.stringify(spec)); localStorage.setItem('fh.customTerrainLast', spec.id);
    const save = vi.spyOn(api, 'saveTerrain').mockImplementation(async (p) => serverTerrain(p.spec, p.base_version + 1));
    render(<Terrain />); await settle();
    expect($('[data-terrain-saved]').textContent).toContain('이 브라우저에만');
    expect($('[data-terrain-status]').textContent).toBe('서버 저장 안 됨');
    await act(async () => { $('[data-terrain-migrate]').click(); });
    expect(save.mock.calls[0][0]).toEqual({ spec, base_version: 0 });
    expect(JSON.parse(localStorage.getItem(keyOf(spec.id))!)).toEqual(spec);
    expect($('[data-terrain-server]').textContent).toContain('시험');
    expect($('[data-terrain-status]').textContent).toBe('서버 저장됨');
    expect($('[data-terrain-server-notice]').textContent).toContain('지도도 만들었습니다');
    type($<HTMLInputElement>('[data-terrain-name]'), '다시 저장');
    expect($('[data-terrain-status]').textContent).toBe('서버 저장 안 됨');
    await act(async () => { $('[data-terrain-save]').click(); });
    expect(save.mock.calls[1][0].base_version).toBe(1);
    expect($('[data-terrain-status]').textContent).toBe('서버 저장됨');
  });
  it('서버에서 연 지형은 같은 출처 브라우저 사본과 기존 시뮬 주소로 열 수 있다', async () => {
    const t = serverTerrain(base([]), 4);
    vi.mocked(api.terrains).mockResolvedValue([t]);
    const read = vi.spyOn(api, 'terrain').mockResolvedValue(t);
    render(<Terrain />); await settle();
    await act(async () => { $('[data-terrain-server] .mx-name').click(); });
    expect(read).toHaveBeenCalledWith(t.spec.id, expect.any(AbortSignal));
    expect(JSON.parse(localStorage.getItem(keyOf(t.spec.id))!)).toEqual(t.spec);
    expect($('[data-terrain-open]').getAttribute('href')).toBe(terrainUrl(t.spec.id));
    expect($('[data-terrain-status]').textContent).toBe('서버 저장됨');
  });
  it('운영자는 보기만 하고 서버 쓰기와 휴지통은 막힌다', async () => {
    vi.mocked(api.me).mockResolvedValue(apiUser('OPERATOR'));
    vi.mocked(api.terrains).mockResolvedValue([serverTerrain(base([]))]);
    render(<Terrain />); await settle();
    expect($<HTMLButtonElement>('[data-terrain-save]').disabled).toBe(true);
    expect($('[data-terrain-server]').textContent).not.toContain('휴지통');
    expect(box.textContent).toContain('총괄 계정만');
  });
  it('요청 중 편집한 내용은 저장됨으로 표시하지 않는다, 실패 후에도 로컬은 남는다', async () => {
    let done!: (t: ServerTerrain) => void;
    const save = vi.spyOn(api, 'saveTerrain').mockImplementation(() => new Promise((resolve) => { done = resolve; }));
    render(<Terrain />); await settle();
    type($<HTMLInputElement>('[data-terrain-name]'), '보낸 이름');
    click('[data-terrain-save]');
    const sent = save.mock.calls[0][0].spec;
    type($<HTMLInputElement>('[data-terrain-name]'), '나중 편집');
    await act(async () => { done(serverTerrain(sent)); });
    expect($('[data-terrain-status]').textContent).toBe('서버 저장 안 됨');
    expect(stored().name).toBe('나중 편집');
    save.mockRejectedValue(new ApiFail(409, 'VERSION_CONFLICT', '서버 지형이 바뀌었습니다.'));
    await act(async () => { $('[data-terrain-save]').click(); });
    expect($('[data-terrain-server-notice]').textContent).toContain('서버 지형이 바뀌었습니다');
    expect(stored().name).toBe('나중 편집');
  });
  const remount = async () => {
    act(() => root!.unmount()); box.remove();
    render(<Terrain />); await settle();
  };
  it('저장→로컬 수정→시뮬 열기→다시 붙이기 후에도 같은 id와 서버 기준 번호로 저장한다', async () => {
    const spec = base([]), first = serverTerrain(spec);
    localStorage.setItem(keyOf(spec.id), JSON.stringify(spec)); localStorage.setItem('fh.customTerrainLast', spec.id);
    const save = vi.spyOn(api, 'saveTerrain').mockImplementation(async (p) => serverTerrain(p.spec, p.base_version + 1));
    render(<Terrain />); await settle();
    await act(async () => { $('[data-terrain-save]').click(); });
    expect(localStorage.getItem(`${keyOf(spec.id)}:base`)).toBe('1');
    expect(JSON.parse(localStorage.getItem(keyOf(spec.id))!)).toEqual(spec); // 계약 JSON에 base를 섞지 않음
    type($<HTMLInputElement>('[data-terrain-name]'), '시뮬에서 시험할 수정');
    const stopNavigation = (e: Event) => e.preventDefault();
    document.addEventListener('click', stopNavigation);
    try { click('[data-terrain-open]'); } finally { document.removeEventListener('click', stopNavigation); }
    vi.mocked(api.terrains).mockResolvedValue([first]);
    await remount();
    expect($('[data-terrain-saved]').textContent).toContain('시뮬에서 시험할 수정');
    expect(box.querySelectorAll('[data-terrain-saved]')).toHaveLength(1); // :base 키는 지형이 아님
    expect($('[data-terrain-conflict]')).toBeNull();
    await act(async () => { $('[data-terrain-save]').click(); });
    expect(save.mock.calls[1][0]).toEqual({ spec: { ...spec, name: '시뮬에서 시험할 수정' }, base_version: 1 });
    expect(localStorage.getItem(`${keyOf(spec.id)}:base`)).toBe('2');
    expect($('[data-terrain-status]').textContent).toBe('서버 저장됨');
  });
  it('다시 붙일 때 서버가 더 새로우면 이전 기준을 유지해 진짜 409와 내 수정 보존을 안내한다', async () => {
    const spec = base([]);
    localStorage.setItem(keyOf(spec.id), JSON.stringify(spec)); localStorage.setItem('fh.customTerrainLast', spec.id);
    const save = vi.spyOn(api, 'saveTerrain').mockResolvedValue(serverTerrain(spec));
    render(<Terrain />); await settle();
    await act(async () => { $('[data-terrain-save]').click(); });
    type($<HTMLInputElement>('[data-terrain-name]'), '내 수정');
    // 내용이 같아도 서버 번호가 앞서 있으면 기준을 몰래 올리지 않는다.
    vi.mocked(api.terrains).mockResolvedValue([serverTerrain({ ...spec, name: '내 수정' }, 2)]);
    save.mockRejectedValue(new ApiFail(409, 'VERSION_CONFLICT', '서버 지형이 바뀌었습니다.'));
    await remount();
    expect($('[data-terrain-conflict]').textContent).toContain('내 수정은 이 브라우저에 남아');
    expect($('[data-terrain-status]').textContent).toBe('서버 저장 안 됨');
    await act(async () => { $('[data-terrain-save]').click(); });
    expect(save.mock.calls[1][0].base_version).toBe(1);
    expect(stored().name).toBe('내 수정');
    expect(localStorage.getItem(`${keyOf(spec.id)}:base`)).toBe('1');
    expect(box.textContent).toContain('새 지형으로 저장');
  });
  it.each([true, false])('서버 사본 열기는 같은 id 로컬 수정본 덮어쓰기를 확인하고 취소하면 그대로 남긴다 (선택 중=%s)', async (selected) => {
    const spec = base([], { name: '내 수정' }), remote = serverTerrain({ ...spec, name: '서버 이름' }, 2);
    localStorage.setItem(keyOf(spec.id), JSON.stringify(spec)); localStorage.setItem(`${keyOf(spec.id)}:base`, '1');
    if (selected) localStorage.setItem('fh.customTerrainLast', spec.id);
    vi.mocked(api.terrains).mockResolvedValue([remote]); vi.spyOn(api, 'terrain').mockResolvedValue(remote);
    render(<Terrain />); await settle();
    await act(async () => { $('[data-terrain-server] .mx-name').click(); });
    expect($('[data-terrain-replace]').textContent).toContain('덮어쓸까요');
    expect(stored().name).toBe('내 수정');
    click('[data-terrain-replace-no]');
    expect($('[data-terrain-replace]')).toBeNull();
    expect(stored().name).toBe('내 수정');
    expect(localStorage.getItem(`${keyOf(spec.id)}:base`)).toBe('1');
    await act(async () => { $('[data-terrain-server] .mx-name').click(); });
    click('[data-terrain-replace-yes]');
    expect(stored().name).toBe('서버 이름');
    expect(localStorage.getItem(`${keyOf(spec.id)}:base`)).toBe('2');
    expect($('[data-terrain-replace]')).toBeNull();
  });
  it('저장 응답 대기 중 수정한 임시본도 새 기준 번호와 함께 다시 붙인다', async () => {
    let done!: (t: ServerTerrain) => void;
    const save = vi.spyOn(api, 'saveTerrain').mockImplementation(() => new Promise((resolve) => { done = resolve; }));
    render(<Terrain />); await settle();
    type($<HTMLInputElement>('[data-terrain-name]'), '요청 이름'); click('[data-terrain-save]');
    const sent = save.mock.calls[0][0].spec;
    type($<HTMLInputElement>('[data-terrain-name]'), '대기 중 수정');
    await act(async () => { done(serverTerrain(sent)); });
    vi.mocked(api.terrains).mockResolvedValue([serverTerrain(sent)]);
    await remount();
    save.mockImplementation(async (p) => serverTerrain(p.spec, p.base_version + 1));
    await act(async () => { $('[data-terrain-save]').click(); });
    expect(save.mock.calls[1][0].base_version).toBe(1);
    expect(save.mock.calls[1][0].spec.name).toBe('대기 중 수정');
  });
  it.each(['가\u200b나', '👨‍👩‍👧', '가\u0001나'])('서버와 같은 이름 제어·서식 문자 검사: %s', async (name) => {
    render(<Terrain />); await settle();
    type($<HTMLInputElement>('[data-terrain-name]'), name);
    expect($('[aria-label="지형 전체 오류·경고"]').textContent).toContain('제어·서식 문자');
    expect($<HTMLButtonElement>('[data-terrain-save]').disabled).toBe(true);
    expect($<HTMLButtonElement>('[data-terrain-open]').disabled).toBe(true);
  });
  it('서버 지형은 확인 후 휴지통으로 옮기고 되돌릴 수 있다', async () => {
    const t = serverTerrain(base([]));
    vi.mocked(api.terrains).mockResolvedValue([t]);
    const remove = vi.spyOn(api, 'deleteTerrain').mockResolvedValue();
    const restore = vi.spyOn(api, 'restoreTerrain').mockResolvedValue(t);
    render(<Terrain />); await settle();
    click('[data-terrain-server] .btn');
    expect(remove).not.toHaveBeenCalled();
    await act(async () => { const b = [...box.querySelectorAll<HTMLButtonElement>('[data-terrain-server] button')].find((x) => x.textContent === '옮기기')!; b.click(); });
    expect(remove).toHaveBeenCalledWith(t.spec.id, expect.any(AbortSignal));
    expect($('[data-terrain-server]').textContent).toContain('되돌리기');
    await act(async () => { $('[data-terrain-server] .btn').click(); });
    expect(restore).toHaveBeenCalled();
    expect($('[data-terrain-server]').textContent).toContain('서버 저장본');
  });
});
