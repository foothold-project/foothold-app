// 시뮬 탭 «임무 편집»(btedit.tsx, BT-NODE-EDITOR 11-09): 나무 고치기 → bt.js validateTree 통과·거절, 이 브라우저 저장·불러오기·이름·지우기, 저장 실패, 운영자 보기만, 사진 눌러 지점
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SimPick, blocked } from '../simstart';
import { check, defaultMission, edit, listMissions, setField, treePoints, type Tree } from '../screens/btedit';
import SCN from '../../../../mobile/sim/assets/factory-inspection/scenarios.json';
import TOP from '../../../../mobile/sim/assets/factory-inspection/top.json';
const FI = Object.values(import.meta.glob<{ origin: number[]; res: number; w: number; h: number; spawn_xyyaw: number[]; px: string }>(
  '../../../../mobile/sim/assets/factory-inspection/map.json', { eager: true, import: 'default' }))[0];

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null, box: HTMLDivElement;
const mount = (admin: boolean) => {
  localStorage.setItem('fh.simMap', 'factory-inspection');
  box = document.createElement('div'); document.body.append(box); act(() => { root = createRoot(box); root.render(<SimPick make admin={admin} />); });
};
afterEach(() => { act(() => root?.unmount()); root = null; box?.remove(); vi.restoreAllMocks(); localStorage.clear(); });
const $ = (s: string) => box.querySelector<HTMLElement>(s);
const click = (s: string) => act(() => { $(s)!.click(); });
const type = (s: string, v: string) => act(() => {
  const el = $(s) as HTMLInputElement | HTMLSelectElement, proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, v); el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
});
const patrol = () => defaultMission(SCN as never)!.tree;
const small: Tree = { format: 'fh_mission_tree/1', max_seconds: 600, root: { type: 'sequence', children: [{ type: 'goto', point: { x: 1, y: 2 } }, { type: 'photo' }, { type: 'fallback', children: [{ type: 'wait', seconds: 3 }] }] } };
const ok = <T,>(r: T | string) => { if (typeof r === 'string') throw new Error(r); return r; };

describe('임무 편집 — 나무 고치기·검사', () => {
  it('기본 임무 = 지도의 BT 시나리오(bt-patrol), validateTree 통과', () => {
    expect(defaultMission(SCN as never)!.name).toBe('모의 BT 공장 순찰 · 운영자 판단');
    expect(check(patrol())).toBe('');
    expect(treePoints(patrol())).toHaveLength(4);
  });

  it('추가·지우기·위아래·안으로·밖으로', () => {
    let r = ok(edit(small, [0], 'add', 'alert'));
    expect(r.path).toEqual([1]); expect(r.tree.root.children!.map((n) => n.type)).toEqual(['goto', 'alert', 'photo', 'fallback']);
    expect(small.root.children).toHaveLength(3);   // 원본은 그대로
    r = ok(edit(r.tree, [1], 'down'));
    expect(r.tree.root.children!.map((n) => n.type)).toEqual(['goto', 'photo', 'alert', 'fallback']); expect(r.path).toEqual([2]);
    r = ok(edit(r.tree, [3], 'up'));
    expect(r.tree.root.children!.map((n) => n.type)).toEqual(['goto', 'photo', 'fallback', 'alert']);
    r = ok(edit(r.tree, [3], 'in'));   // 바로 위 fallback 안 맨 끝으로
    expect(r.path).toEqual([2, 1]); expect(r.tree.root.children![2].children!.map((n) => n.type)).toEqual(['wait', 'alert']);
    r = ok(edit(r.tree, [2, 1], 'out'));
    expect(r.path).toEqual([3]); expect(r.tree.root.children!.map((n) => n.type)).toEqual(['goto', 'photo', 'fallback', 'alert']);
    r = ok(edit(r.tree, [2], 'add', 'report'));   // 묶음을 고르고 추가 = 그 안 맨 끝
    expect(r.path).toEqual([2, 1]);
    r = ok(edit(r.tree, [0], 'remove'));
    expect(r.tree.root.children!.map((n) => n.type)).toEqual(['photo', 'fallback', 'alert']);
    expect(check(r.tree)).toMatch(/순찰 지점이 하나도 없습니다/);   // 나무는 통과, 시뮬이 받는 지점이 없음
    expect(edit(small, [], 'remove')).toMatch(/맨 위/);
    expect(edit(small, [0], 'in')).toMatch(/바로 위 노드/);
    expect(edit(small, [0], 'up')).toMatch(/이미 맨 위/);
    expect(edit(patrol(), [2, 0, 0], 'remove')).toMatch(/안의 노드는/);   // 지점마다 안 하나뿐인 노드
  });

  it('validateTree 거절을 그대로 보인다', () => {
    expect(check(setField(small, [2, 0], 'seconds', 999))).toBe('wait.seconds 필요');
    expect(check({ ...small, max_seconds: 0 })).toMatch(/max_seconds/);
    expect(check(ok(edit(small, [2], 'add', 'retry')).tree)).toBe('');
    expect(check(setField(ok(edit(small, [1], 'add', 'retry')).tree, [2], 'times', 4))).toBe('retry.times 1~3');
    expect(check(ok(edit(small, [1], 'add', 'sequence')).tree)).toBe('children 필요');
    expect(check(setField(small, [1], 'max_seconds', 9))).toBe('행동 시간 상한');   // photo 상한 5초
    expect(check(ok(edit(small, [1], 'add', 'goto')).tree)).toBe('goto.point 필요');   // 지점마다 밖의 «지금 지점»
  });
});

describe('임무 편집 화면', { timeout: 30_000 }, () => {
  it('총괄: 고치기 → 오류면 열기 막힘 → 저장·불러오기·이름 바꾸기·지우기, 열기 주소 ?bt=', () => {
    mount(true);
    expect($('[data-bt-editor]')).toBeTruthy();
    expect($('[data-bt-ok]')!.textContent).toBe('검사 통과 · 지점 4곳');
    expect($('a[data-bt-open]')!.getAttribute('href')).toBe('/sim/index.html?from=web&map=factory-inspection');   // 기본 임무 = 기존 시나리오 그대로
    click('[data-bt-row="2.0"]');   // 지점마다
    expect($('[data-bt-node]')!.dataset.btNode).toBe('for_each_point');
    for (let i = 0; i < 4; i++) click('[aria-label="지점 1 빼기"]');
    expect($('[data-bt-err]')!.textContent).toBe('검사 실패: 순찰 points 필요');
    expect(($('button[data-bt-open]') as HTMLButtonElement).disabled).toBe(true);
    click('[data-bt-reset]');
    expect($('[data-bt-ok]')).toBeTruthy();
    expect(($('button[data-bt-open]') as HTMLButtonElement).disabled).toBe(true);   // 저장 전
    type('[data-bt-name]', '짧은 순찰');
    click('[data-bt-save-new]');
    const [m] = listMissions('factory-inspection', '');
    expect(m.name).toBe('짧은 순찰'); expect(check(m.tree)).toBe('');
    expect(JSON.parse(localStorage.getItem(`fh.btMission.${m.id}`)!).map).toBe('factory-inspection');
    expect($('a[data-bt-open]')!.getAttribute('href')).toBe(`/sim/index.html?from=web&map=factory-inspection&bt=${m.id}`);
    // 문구 고치기 → 저장(같은 id), 이름 바꾸기
    click('[data-bt-row="2.1"]');
    type('[data-bt-message]', '끝');
    type('[data-bt-name]', '새 이름');
    click('[data-bt-save]');
    const [m2] = listMissions('factory-inspection', '');
    expect([m2.id, m2.name, m2.tree.root.children![2].children![1].message]).toEqual([m.id, '새 이름', '끝']);
    // 기본으로 갔다가 다시 불러오기
    type('[data-bt-pick]', '');
    expect($('[data-bt-row="2.1"]')!.textContent).toContain('순찰 완료');
    type('[data-bt-pick]', m.id);
    expect($('[data-bt-row="2.1"]')!.textContent).toContain('«끝»');
    click('[data-bt-delete]');
    expect(listMissions('factory-inspection', '')).toEqual([]);
    expect(($('[data-bt-pick]') as HTMLSelectElement).value).toBe('');
  });

  it('저장 실패(사생활 창)해도 화면은 동작', () => {
    mount(true);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    click('[data-bt-save-new]');
    expect($('[data-bt-note]')!.textContent).toMatch(/저장하지 못했습니다/);
    click('[data-bt-row="2.1"]');
    type('[data-bt-message]', '여전히 고쳐짐');
    expect($('[data-bt-row="2.1"]')!.textContent).toContain('여전히 고쳐짐');
  });

  it('검사 실패면 저장 막힘, 검사 못 넘는 옛 저장본은 열지 않고 안내만(REVIEW-294 B1)', () => {
    // 손댄·옛 저장본: 이동 x 가 null(NaN 이 JSON 에서 null 이 된 꼴)
    const broken = setField(patrol(), [2, 0, 0, 0, 0, 0], 'point', { x: null, y: 21.5 });
    localStorage.setItem('fh.btMission.old1', JSON.stringify({ id: 'old1', name: '옛 임무', map: 'factory-inspection', floor: '', tree: broken }));
    mount(true);
    // 리뷰 재현 순서: 이동 노드 → «지금 순찰 지점» 해제 → x 비우기 → 검사 실패 → «내 임무로 저장» 막힘
    click('[data-bt-row="2.0.0.0.0.0"]');
    click('[data-bt-current]');
    type('.be-points input', '');
    expect($('[data-bt-err]')!.textContent).toBe('검사 실패: goto.point 필요');
    expect(($('[data-bt-save-new]') as HTMLButtonElement).disabled).toBe(true);
    click('[data-bt-save-new]');
    expect(listMissions('factory-inspection', '').map((m) => m.id)).toEqual(['old1']);   // 새로 저장된 것 없음
    // 깨진 저장본 고르기 → 열지 않고 안내, 편집·시뮬 열기 화면은 그대로
    type('[data-bt-pick]', 'old1');
    expect($('[data-bt-note]')!.textContent).toBe('이 저장본은 검사를 통과하지 못해 열지 않았습니다 — goto.point 필요');
    expect(($('[data-bt-pick]') as HTMLSelectElement).value).toBe('');
    expect($('[data-bt-editor]')).toBeTruthy(); expect($('[data-sim-app]')).toBeTruthy();
    click('[data-bt-reset]');
    expect($('[data-bt-ok]')).toBeTruthy();
    expect(($('[data-bt-save-new]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('운영자: 보기만(도구·저장 없음, 칸 읽기 전용), 열기는 됨', () => {
    mount(false);
    expect($('[data-bt-editor]')!.textContent).toContain('보기 전용');
    for (const s of ['[data-bt-save]', '[data-bt-save-new]', '[data-bt-reset]', '[data-bt-op]', '[data-bt-name]', '[aria-label="지점 1 빼기"]']) expect($(s)).toBeNull();
    click('[data-bt-row="2.1"]');
    expect(($('[data-bt-message]') as HTMLInputElement).readOnly).toBe(true);
    click('[data-bt-row="2.0"]');
    expect([...box.querySelectorAll<HTMLInputElement>('.be-points input')].every((i) => i.readOnly)).toBe(true);
    expect($('a[data-bt-open]')).toBeTruthy();
  });

  it('사진을 눌러 지점마다에 지점 추가(벽 자리는 거절)', async () => {
    mount(true);
    for (let i = 0; i < 400 && !$('[data-sim-mark="home"]'); i++) await act(() => new Promise((r) => setTimeout(r, 25)));
    const px = Uint8Array.from(atob(FI.px), (c) => c.charCodeAt(0)), grid = { ...FI, px };
    const [b0, b1, b2, b3] = TOP.bounds, svg = $('[data-bt-top]')!;
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: (b2 - b0) * 10, height: (b3 - b1) * 10 } as DOMRect);
    const press = (x: number, y: number) => act(() => { svg.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: (x - b0) * 10, clientY: (b3 - y) * 10 })); });
    press(24.8, 21.5);
    expect($('[data-bt-why]')!.textContent).toMatch(/«지점마다»나 «이동»/);
    click('[data-bt-row="2.0"]');
    expect(blocked(grid, 24.8, 21.5)).toBe('');
    press(24.8, 21.5);
    expect(box.querySelectorAll('.be-points li')).toHaveLength(5);
    const wall = px.indexOf(0), wx = FI.origin[0] + (wall % FI.w + 0.5) * FI.res, wy = FI.origin[1] + (FI.h - 1 - Math.floor(wall / FI.w) + 0.5) * FI.res;
    press(+wx.toFixed(2), +wy.toFixed(2));
    expect($('[data-bt-why]')).toBeTruthy();
    expect(box.querySelectorAll('.be-points li')).toHaveLength(5);
  });
});
