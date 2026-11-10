// SCEN-LIFECYCLE-EDITOR 11-09 — 시나리오 «운영 흐름»(React Flow): 단계 띠 5개·개수, 기본 = 임무, 임무 노드 = 지점 수(시뮬 거절 지점 «시뮬에서 실행 못 함»),
// SCEN-ONE-FLOW 11-10 — 한 캔버스에 다섯 묶음·단계 사이 선 3개·예외 점선 2개, 단계 띠 = 그 묶음으로 이동(노드 수 그대로),
// 다른 단계 = 읽기만(끌기·잇기·추가 단추 없음), 시뮬 탭 = websim·지도 탭 = real 배지, 노드 상세, 저장(네트워크) 호출 없음. (jsdom 대역 = setup.ts)
// SCEN-ONE-FLOW-R1 11-10 — 묶음 = 왼쪽→오른쪽 기둥(예외 = 임무 아래), «크게 보기» 켜기·끄기·Esc·기억.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScenNodes, flowGraph, missionGraph, stageGraph, type NodeIn } from '../screens/scennode';
import { LIFE, STAGES, type Where } from '../screens/lifecycle';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ITEMS: NodeIn[] = [{ title: '«입구»', sub: '이동', kind: 'MOVE' }, { title: '(1.0, 0.5) m', sub: '사진 찍기(RGB)', kind: 'PHOTO' },
  { title: '(2.0, 1.0) m', sub: '창고 점검', kind: 'OTHER', no: '«운영자 확인»은 시뮬에서 실행할 수 없습니다.' }];
let box: HTMLDivElement, root: Root, fetchSpy: ReturnType<typeof vi.fn>, pick: ReturnType<typeof vi.fn>, edit: ReturnType<typeof vi.fn>;
const $ = (s: string) => box.querySelector<HTMLElement>(s)!;
const $$ = (s: string) => [...box.querySelectorAll<HTMLElement>(s)];
const flow = () => $('[data-scen-nodes]');
const node = (id: string) => $(`.react-flow__node[data-id="${id}"]`);
const tap = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); };
const show = (where: Where) => act(async () => root.render(<ScenNodes where={where} items={ITEMS} end="마지막 지점에서 대기" on={null} pick={pick} edit={edit} />));
const stage = (s: string) => $(`button[data-stage="${s}"]`);
const ofStage = (s: string) => LIFE.filter((n) => n.stage === s);
const badges = (s: string) => ofStage(s).map((n) => node(n.id).querySelector('.sn-badge')!.textContent);
const ALL = 43 + ITEMS.length + 2;   // 다섯 단계 노드(임무 제외 43) + 임무 = 시작 + 지점 + 끝나면

beforeEach(() => {
  fetchSpy = vi.fn(); vi.stubGlobal('fetch', fetchSpy); pick = vi.fn(); edit = vi.fn();
  localStorage.setItem('fh.scen.big', '0');   // 아래 옛 시험 = «원래 크기»(크게 보기는 R1 시험이 기본값부터 따로 본다)
  box = document.createElement('div'); document.body.append(box); root = createRoot(box);
});
afterEach(() => { act(() => root.unmount()); box.remove(); vi.unstubAllGlobals(); localStorage.removeItem('fh.scen.big'); });

describe('운영 흐름 데이터', () => {
  it('54노드 = 다섯 단계, 대조표 요약 개수와 같다', () => {
    expect(LIFE).toHaveLength(54);
    expect(new Set(LIFE.map((n) => n.stage))).toEqual(new Set(STAGES));
    const c = (w: Where) => STAGES.map((s) => ['됨', '일부', '없음'].map((j) => LIFE.filter((n) => n.stage === s && n.status[w] === j).length).join('/'));
    expect(c('websim')).toEqual(['0/0/8', '3/3/3', '9/2/0', '7/8/2', '3/4/2']);
    expect(c('real')).toEqual(['8/0/0', '6/2/1', '1/0/10', '5/5/7', '2/1/6']);
  });
  it('임무 그래프 = 시작 + 지점 + 끝나면 한 줄, 예외 처리는 선 없음', () => {
    const g = missionGraph(ITEMS, '대기', 'websim');
    expect(g.nodes.filter((n) => n.data.wp != null)).toHaveLength(ITEMS.length);
    expect(g.edges.map((e) => `${e.source}>${e.target}`)).toEqual(['start>w0', 'w0>w1', 'w1>w2', 'w2>end']);
    expect(stageGraph('예외 처리', 'websim').edges).toHaveLength(0);
    expect(stageGraph('연결', 'real').nodes).toHaveLength(8);
  });
  it('REVIEW-308: 단계마다 노드 좌표가 겹치지 않는다(갈래가 이어져도) — 모든 노드가 보이고 눌린다', () => {
    for (const s of STAGES) for (const w of ['websim', 'real'] as const) {
      const g = s === '임무' ? missionGraph(ITEMS, '대기', w) : stageGraph(s, w), at = g.nodes.map((n) => `${n.position.x},${n.position.y}`);
      expect(new Set(at).size, `${s} ${w}`).toBe(at.length);
    }
  });
  it('SCEN-ONE-FLOW: 한 캔버스 = 묶음 5개(제목 개수), 노드는 자기 묶음 안·묶음끼리 안 겹침, 단계 사이 선 3개, 예외 점선 2개(예외 노드끼리 새 선 없음)', () => {
    const g = flowGraph(ITEMS, '대기', 'websim');
    expect(g.boxes.map((b) => b.data.title)).toEqual(STAGES.map((s, i) => `${i + 1}. ${s}`));
    expect(g.boxes.find((b) => b.data.stage === '연결')!.data.sub).toBe('됨 0 · 일부 0 · 아직 없음 8');
    expect(g.nodes).toHaveLength(ALL);
    const rect = (b: (typeof g.boxes)[number]) => ({ x: b.position.x, y: b.position.y, r: b.position.x + Number(b.style!.width), b: b.position.y + Number(b.style!.height) });
    const R = g.boxes.map(rect);
    for (let i = 0; i < R.length; i++) for (let j = i + 1; j < R.length; j++)
      expect(R[i].r <= R[j].x || R[j].r <= R[i].x || R[i].b <= R[j].y || R[j].b <= R[i].y, `${STAGES[i]}·${STAGES[j]}`).toBe(true);
    const stageOf = (id: string) => LIFE.find((n) => n.id === id)?.stage ?? '임무';   // 시작(start)·지점·끝나면 = 임무
    for (const n of g.nodes) { const r = R[STAGES.indexOf(stageOf(n.id))];
      expect(n.position.x >= r.x && n.position.x + 200 <= r.r && n.position.y >= r.y && n.position.y + 84 <= r.b, n.id).toBe(true); }
    const ex = R[STAGES.indexOf('예외 처리')], mi = R[STAGES.indexOf('임무')], back = R[STAGES.indexOf('복귀·종료')];
    const cols = (['연결', '운행 준비', '임무', '복귀·종료'] as const).map((s) => R[STAGES.indexOf(s)]);
    expect(cols.map((c) => c.y)).toEqual([0, 0, 0, 0]);                                   // 가로 배치: 기둥 넷이 한 줄
    for (let i = 1; i < cols.length; i++) expect(cols[i].x, `기둥 ${i}`).toBeGreaterThanOrEqual(cols[i - 1].r);   // 왼쪽 → 오른쪽 순서
    expect(ex.x).toBe(mi.x); expect(ex.y).toBeGreaterThanOrEqual(mi.b); expect(back.x).toBeGreaterThanOrEqual(ex.r);   // 예외 = 임무 기둥 바로 아래, 복귀·종료는 그 오른쪽
    expect(g.edges.filter((e) => e.className === 'sn-link').map((e) => [e.id, e.sourceHandle, e.targetHandle])).toEqual([['connected>mode', 'r', 'l'], ['ready>start', 'r', 'l'], ['end>return', 'r', 'l']]);
    expect(g.edges.filter((e) => e.className === 'sn-jump').map((e) => [e.source, e.target, e.label])).toEqual([['g:임무', 'g:예외 처리', '임무 중 언제든'], ['g:예외 처리', 'g:복귀·종료', undefined]]);
    const exIds = new Set(ofStage('예외 처리').map((n) => n.id));
    expect(g.edges.filter((e) => exIds.has(e.source) || exIds.has(e.target))).toHaveLength(0);
    const ids = new Set(g.nodes.map((n) => n.id));
    expect(g.edges.length).toBe(5 + 6 + (ITEMS.length + 1) + 8 + 3 + 2);
    for (const e of g.edges.filter((x) => x.className !== 'sn-jump')) expect(ids.has(e.source) && ids.has(e.target), e.id).toBe(true);
  });
  it('REVIEW-308: 앱 데이터에 소스 경로·줄번호 인용이 없다(근거는 저장소 밖 대조표에만)', () => {
    expect(JSON.stringify(LIFE).match(/[\w./-]+\.(tsx?|py|js|json|mjs):\d+/g)).toBeNull();
  });
});

describe('운영 흐름 화면', () => {
  it('시뮬 탭: 띠 5개·websim 개수, 기본 임무 = 지점 노드, 거절 지점 표시, 누르면 상세·지도 강조·목록 편집 — 저장 없음', async () => {
    await show('websim');
    expect([flow().dataset.groups, flow().dataset.nodes]).toEqual(['5', String(ALL)]);
    expect($$('.sn-box').map((b) => b.dataset.group)).toEqual([...STAGES]);
    expect($('.sn-box[data-on]').dataset.group).toBe('임무');
    expect($$('button[aria-label="화면 맞춤"], button[aria-label="전체 보기"]')).toHaveLength(2);
    expect($$('button[data-stage]').map((b) => b.dataset.stage)).toEqual([...STAGES]);
    expect(stage('임무').getAttribute('aria-pressed')).toBe('true');
    expect([stage('연결').dataset.done, stage('연결').dataset.part, stage('연결').dataset.none]).toEqual(['0', '0', '8']);
    expect(stage('임무').textContent).toContain('됨 9 · 일부 2 · 아직 없음 0');
    expect($$('[data-watch] button').map((b) => b.textContent)).toEqual(['STOP', '통신', '조종권', '배터리', '장치']);
    expect($$('.react-flow__node .sn-num')).toHaveLength(ITEMS.length);
    expect(node('w2').querySelector('[data-st="no"]')!.textContent).toBe('시뮬에서 실행 못 함');
    expect(node('w0').querySelector('.sn-badge')!.textContent).toBe('됨');            // 이동 = 표 gotoA websim
    expect(node('w1').querySelector('.sn-badge')!.textContent).toBe('일부');          // 사진 = capture websim
    expect($$('.react-flow__node.draggable')).toHaveLength(0);
    expect($$('button').some((b) => /빈 노드|잇기|지우기|자동 정렬/.test(b.textContent!))).toBe(false);

    await tap(node('w2'));
    expect(pick).toHaveBeenLastCalledWith(2);
    expect($('[data-detail]').textContent).toContain('3번 지점');
    expect($('[data-miss]').textContent).toContain('운영자 확인');
    await tap($('[data-edit-point="2"]'));
    expect(edit).toHaveBeenCalledWith(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('시뮬 탭 다른 단계 = 읽기만, 띠 = 이동(노드 수 그대로): 연결은 «브라우저 시뮬엔 없음», 예외 처리 17노드, 누르면 처리 주체·실패 시', async () => {
    await show('websim');
    const edges = flow().dataset.edges;
    await tap(stage('연결'));
    expect([flow().dataset.stage, flow().dataset.nodes, flow().dataset.edges]).toEqual(['연결', String(ALL), edges]);
    expect(stage('연결').getAttribute('aria-pressed')).toBe('true');
    expect($('.sn-box[data-on]').dataset.group).toBe('연결');
    expect(badges('연결')).toEqual(Array(8).fill('브라우저 시뮬엔 없음'));
    expect($$('.react-flow__node .sn-num')).toHaveLength(ITEMS.length);              // 임무 지점도 그대로 보임
    await tap(stage('예외 처리'));
    expect(flow().dataset.nodes).toBe(String(ALL));
    expect(ofStage('예외 처리').filter((n) => node(n.id))).toHaveLength(17);
    expect($('.sn-hint').textContent).toContain('편집기로는 만들지 않습니다');
    await tap(node('battery_low'));
    const d = $('[data-detail]').textContent!;
    expect(d).toContain('배터리 부족 감지'); expect(d).toContain('처리 주체'); expect(d).toContain('실패 시'); expect(d).toContain('«모의 배터리 부족» 단추로만');
    expect($('[data-edit-point]')).toBeNull();
    expect(pick).not.toHaveBeenCalled();
  });

  it('R1 크게 보기: 처음부터 크게(기본) — 높이 = 그래프 1배, 휠은 창 스크롤, 윗줄에 확대·축소, 상세는 누를 때만 카드(× 닫기), «원래 크기»·Esc 로 줄이고 그 선택만 기억', async () => {
    localStorage.removeItem('fh.scen.big');
    await show('websim');
    const btn = () => $('[data-big-toggle]'), big = () => flow().hasAttribute('data-big'), esc = () => act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    const g = flowGraph(ITEMS, '대기', 'websim'), gh = Math.max(...g.boxes.map((b) => b.position.y + Number(b.style!.height)));
    expect([big(), btn().textContent, btn().getAttribute('aria-pressed'), localStorage.getItem('fh.scen.big')]).toEqual([true, '↙ 원래 크기', 'true', null]);
    expect($('.sn-canvas').style.height).toBe(`${gh + 32}px`);                                // 세로 제한 없음 — 그래프 높이 그대로
    expect([$('.react-flow__controls'), $$('.sn-top [aria-label="확대·축소"] button').map((b) => b.getAttribute('aria-label'))]).toEqual([null, ['축소', '확대', '화면 맞춤', '전체 보기']]);
    const wheel = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true });
    $('.react-flow__pane').dispatchEvent(wheel); expect(wheel.defaultPrevented).toBe(false);          // 휠 = 창 스크롤(캔버스가 먹지 않음)
    expect([flow().dataset.nodes, $('[data-detail]')]).toEqual([String(ALL), null]);        // 상세 = 누를 때만
    expect(stage('연결').title).toBe('됨 0 · 일부 0 · 아직 없음 8');                          // 윗줄 칩: 개수는 title
    await tap(stage('예외 처리')); expect(flow().dataset.stage).toBe('예외 처리');
    await tap(node('w1'));
    expect([$('[data-detail]').dataset.detail, pick.mock.lastCall]).toEqual(['w1', [1]]);
    expect($('[data-edit-point="1"]')).not.toBeNull();                                      // 지점이면 편집 단추 그대로
    await tap($('[data-detail-close]')); expect($('[data-detail]')).toBeNull();
    await tap(node('w1')); expect($('[data-detail]').dataset.detail).toBe('w1');            // 같은 노드를 다시 누르면 다시 뜸
    await tap(node('battery_low')); expect([$('[data-detail]').dataset.detail, $('[data-edit-point]')]).toEqual(['battery_low', null]);
    await tap(btn());
    expect([big(), btn().textContent, localStorage.getItem('fh.scen.big'), $('.sn-canvas').style.height]).toEqual([false, '⤢ 크게 보기', '0', '']);
    expect([$('[data-detail]').dataset.detail, $('[data-detail-close]'), $('.react-flow__controls') != null]).toEqual(['battery_low', null, true]);   // 원래 크기 = 지금 모습
    await tap(btn()); expect([big(), localStorage.getItem('fh.scen.big')]).toEqual([true, null]);
    const menu = document.createElement('details'); menu.className = 'mx-menu'; menu.open = true; document.body.append(menu);
    await esc(); expect(big()).toBe(true);                                                 // 메뉴가 열려 있으면 Esc 는 메뉴 몫
    menu.remove(); await esc(); expect([big(), localStorage.getItem('fh.scen.big')]).toEqual([false, '0']);
    act(() => root.unmount()); root = createRoot(box);
    await show('websim'); expect(big()).toBe(false);                                       // 줄인 선택은 다시 열어도 그대로
  });

  it('지도 탭 = real 판정: 연결 8개 됨, 실기체 미검증 한 줄, 일부면 빠진 것', async () => {
    await show('real');
    expect([stage('연결').dataset.done, stage('임무').dataset.none]).toEqual(['8', '10']);
    expect(node('w0').querySelector('.sn-badge')!.textContent).toBe('아직 없음');     // 실기는 임무 실행 없음
    expect(node('w2').querySelector('[data-st="no"]')).toBeNull();                   // «시뮬에서 실행 못 함»은 시뮬 탭만
    await tap(stage('연결'));
    expect(badges('연결')).toEqual(Array(8).fill('됨'));
    expect($('.sn-hint').textContent).toContain('실기체 검증과 다름');
    for (const s of ['연결', '운행 준비'] as const) {
      await tap(stage(s));
      for (const n of LIFE.filter((x) => x.stage === s)) { await tap(node(n.id)); expect($('[data-detail]').dataset.detail).toBe(n.id); }
    }
    await tap(stage('운행 준비')); await tap(node('check'));
    expect($('[data-detail]').textContent).toContain('일부');
    expect($('[data-miss]').textContent).toContain('시작 관문 없음');
  });
});
