// SCEN-LIFECYCLE-EDITOR 11-09 — 시나리오 «운영 흐름»(React Flow): 단계 띠 5개·개수, 기본 = 임무, 임무 노드 = 지점 수(시뮬 거절 지점 «시뮬에서 실행 못 함»),
// SCEN-ONE-FLOW 11-10 — 한 캔버스에 다섯 묶음·단계 사이 선 3개·예외 점선 2개, 단계 띠 = 그 묶음으로 이동(노드 수 그대로),
// 다른 단계 = 읽기만(끌기·잇기·추가 단추 없음), 시뮬 탭 = websim·지도 탭 = real 배지, 노드 상세, 저장(네트워크) 호출 없음. (jsdom 대역 = setup.ts)
// SCEN-ONE-FLOW-R1 11-10 — «크게 보기». R4 11-10 — PC 넓은 창은 늘 크게(켜고 끄는 단추·Esc·기억값 없음), 좁은 창은 나란히 그대로.
// SCEN-ONE-FLOW-R3 11-10 — 접힌 운영 흐름(요약 카드·펼치기·모두 펼치기), 지원 현황 켤 때만 판정 배지, 예외는 시작에서 점선 하나, 지점 편집 창(form)·지도 선택 연동.
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FOLDS, ScenNodes, flowGraph, missionGraph, stageGraph, type NodeIn } from '../screens/scennode';
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
const ALL = 43 + ITEMS.length + 2;   // 모두 펼침 = 다섯 단계 노드(임무 제외 43) + 임무 = 시작 + 지점 + 끝나면
const FOLDED = 4 + ITEMS.length + 2;   // 처음(모두 접힘) = 요약 카드 넷 + 임무
const OPEN = new Set(FOLDS);
const openAll = () => tap($('[data-all-open]'));
const support = () => tap($('[data-support-toggle]'));
/** R6 — 캔버스 화면(viewport transform), 왼쪽 끌기(d3-zoom = mousedown 뒤 window mousemove·mouseup, 이어지는 click 은 끌었으면 먹힘) */
const vp = () => $('.react-flow__viewport').style.transform;
const drag = async (el: Element, dx: number) => {   // jsdom 은 view 에 vitest window 를 못 받아 뒤에 붙임(d3 가 event.view 에 mousemove 를 건다)
  const ev = (t: string, x: number) => Object.defineProperty(new MouseEvent(t, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: 50 }), 'view', { value: window });
  await act(async () => { el.dispatchEvent(ev('mousedown', 100)); window.dispatchEvent(ev('mousemove', 100 + dx));
    window.dispatchEvent(ev('mouseup', 100 + dx)); el.dispatchEvent(ev('click', 100 + dx)); }); };
/** wide(true) = PC 넓은 창(늘 크게 보기), wide(false) = 좁은 창(1023.98px 아래 — 나란히) */
const wide = (on: boolean) => vi.stubGlobal('matchMedia', (q: string) => ({ matches: !on, media: q, addEventListener() {}, removeEventListener() {} }));

beforeEach(() => {
  fetchSpy = vi.fn(); vi.stubGlobal('fetch', fetchSpy); pick = vi.fn(); edit = vi.fn();
  wide(false);   // 아래 옛 시험 = 좁은 창(나란히 모양 — 크게 보기는 R1·R3 시험이 넓은 창으로 따로 본다)
  box = document.createElement('div'); document.body.append(box); root = createRoot(box);
});
afterEach(() => { act(() => root.unmount()); box.remove(); vi.unstubAllGlobals(); });

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
  it('R3 접힌 흐름: 임무만 묶음, 고정 절차 넷 = 요약 카드(«N개 항목»), 기둥 = 연결·운행 준비 | 임무 | 복귀·종료·예외, 선 셋 + 시작 → 예외 점선 하나', () => {
    const g = flowGraph(ITEMS, '대기', 'websim'), A = g.areas;
    expect(g.boxes.map((b) => b.data.stage)).toEqual(['임무']);
    expect(g.nodes).toHaveLength(FOLDED);
    expect(g.nodes.filter((n) => n.data.stage).map((n) => [n.id, n.data.title, n.data.count, n.data.meta])).toEqual([
      ['s:연결', '1. 연결', '8개 항목', undefined], ['s:운행 준비', '2. 운행 준비', '9개 항목', undefined], ['s:복귀·종료', '5. 복귀·종료', '9개 항목', undefined], ['s:예외 처리', '4. 예외 처리', '17개 항목', undefined]]);
    expect([A['연결'].x, A['운행 준비'].x, A['연결'].y, A['임무'].y, A['복귀·종료'].y]).toEqual([0, 0, 0, 0, 0]);
    expect(A['운행 준비'].y).toBeGreaterThanOrEqual(A['연결'].y + A['연결'].h);                       // 왼쪽 기둥 위 → 아래
    expect(A['임무'].x).toBeGreaterThanOrEqual(A['운행 준비'].x + A['운행 준비'].w);
    expect([A['예외 처리'].x, A['복귀·종료'].x >= A['임무'].x + A['임무'].w]).toEqual([A['복귀·종료'].x, true]);   // 오른쪽 기둥: 복귀·종료 위, 예외 아래
    expect(A['예외 처리'].y).toBeGreaterThanOrEqual(A['복귀·종료'].y + A['복귀·종료'].h);
    expect(g.edges.filter((e) => e.className === 'sn-link').map((e) => [e.id, e.sourceHandle, e.targetHandle])).toEqual([['s:연결>s:운행 준비', undefined, undefined], ['s:운행 준비>start', 'r', 'l'], ['end>s:복귀·종료', 'r', 'l']]);
    expect(g.edges.filter((e) => e.className === 'sn-jump').map((e) => [e.source, e.target, e.label, e.style?.strokeDasharray])).toEqual([['start', 's:예외 처리', '발생할 때 확인', '6 4']]);
    expect(g.edges).toHaveLength(ITEMS.length + 1 + 4);
    expect(g.nodes.filter((n) => n.data.badge).map((n) => [n.id, n.data.badge!.text])).toEqual([['w2', '시뮬에서 실행 못 함']]);   // 지원 현황 꺼짐 = 시뮬 거절만
    expect(flowGraph(ITEMS, '대기', 'websim', new Set(), true).nodes.find((n) => n.id === 's:연결')!.data.meta).toBe('됨 0 · 일부 0 · 아직 없음 8');
  });
  it('R3 모두 펼침(두 번째 안) = 묶음 5개, 노드는 자기 묶음 안·묶음끼리 안 겹침, 예외 처리 노드엔 선이 없다(정상 순서로 잇지 않음), 지원 현황 = 배지', () => {
    const g = flowGraph(ITEMS, '대기', 'websim', OPEN, true);
    expect(g.boxes.map((b) => b.data.stage).sort()).toEqual([...STAGES].sort());
    expect(g.boxes.find((b) => b.data.stage === '연결')!.data.sub).toBe('됨 0 · 일부 0 · 아직 없음 8');
    expect(g.nodes).toHaveLength(ALL);
    const R = Object.fromEntries(g.boxes.map((b) => [b.data.stage, { x: b.position.x, y: b.position.y, r: b.position.x + Number(b.style!.width), b: b.position.y + Number(b.style!.height) }]));
    const L = Object.values(R);
    for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) expect(L[i].r <= L[j].x || L[j].r <= L[i].x || L[i].b <= L[j].y || L[j].b <= L[i].y).toBe(true);
    const stageOf = (id: string) => (/^(start|end|w\d+)$/.test(id) ? '임무' : LIFE.find((n) => n.id === id)!.stage);
    for (const n of g.nodes) { const r = R[stageOf(n.id)]; expect(n.position.x >= r.x && n.position.x + 220 <= r.r && n.position.y >= r.y && n.position.y + 88 <= r.b, n.id).toBe(true); }
    expect(g.edges.filter((e) => e.className === 'sn-link').map((e) => [e.id, e.sourceHandle, e.targetHandle])).toEqual([['connected>mode', undefined, undefined], ['ready>start', 'r', 'l'], ['end>return', 'r', 'l']]);
    expect(g.edges.filter((e) => e.className === 'sn-jump').map((e) => [e.source, e.target])).toEqual([['start', 'g:예외 처리']]);
    const exIds = new Set(ofStage('예외 처리').map((n) => n.id));
    expect(g.edges.filter((e) => exIds.has(e.source) || exIds.has(e.target))).toHaveLength(0);
    expect(g.edges.length).toBe(5 + 6 + (ITEMS.length + 1) + 8 + 3 + 1);
    const ids = new Set([...g.nodes, ...g.boxes].map((n) => n.id));
    for (const e of g.edges) expect(ids.has(e.source) && ids.has(e.target), e.id).toBe(true);
    expect(g.nodes.find((n) => n.id === 'robot')!.data.badge!.text).toBe('브라우저 시뮬엔 없음');
    expect(flowGraph(ITEMS, '대기', 'websim', OPEN).nodes.find((n) => n.id === 'robot')!.data.badge).toBeUndefined();
  });
  it('REVIEW-308: 앱 데이터에 소스 경로·줄번호 인용이 없다(근거는 저장소 밖 대조표에만)', () => {
    expect(JSON.stringify(LIFE).match(/[\w./-]+\.(tsx?|py|js|json|mjs):\d+/g)).toBeNull();
  });
});

describe('운영 흐름 화면', () => {
  it('시뮬 탭 처음 = 접힌 흐름: 임무 묶음 하나 + 요약 카드 넷, 배지 없음(시뮬 거절만), 지원 현황 켜면 websim 배지, 지점 누르면 상세·지도 강조·목록 편집 — 저장 없음', async () => {
    await show('websim');
    expect([flow().dataset.groups, flow().dataset.nodes]).toEqual(['1', String(FOLDED)]);
    expect($$('.sn-box').map((b) => b.dataset.group)).toEqual(['임무']);
    expect($$('.sn-card[data-sum]').map((c) => c.dataset.sum)).toEqual([...FOLDS]);
    expect(node('s:예외 처리').textContent).toContain('고정 절차 · 펼쳐보기'); expect(node('s:예외 처리').textContent).toContain('17개 항목');
    expect($$('button[aria-label="화면 맞춤"], button[aria-label="전체 보기"]')).toHaveLength(2);
    expect($$('button[data-stage]').map((b) => b.dataset.stage)).toEqual([...STAGES]);
    expect(stage('임무').getAttribute('aria-pressed')).toBe('true');
    expect([stage('연결').dataset.done, stage('연결').dataset.part, stage('연결').dataset.none]).toEqual(['0', '0', '8']);
    expect(stage('임무').textContent).toContain('됨 9 · 일부 2 · 아직 없음 0');
    expect($$('[data-watch] button').map((b) => b.textContent)).toEqual(['통신', '조종권', '배터리', '장치', 'STOP']);
    expect($('[data-watch]').textContent).toContain('상시 안전 감시');
    expect($$('.react-flow__node .sn-num')).toHaveLength(ITEMS.length);
    expect(node('w0').textContent).toContain('편집 가능한 지점');
    expect($$('.react-flow__node .sn-badge').map((b) => b.textContent)).toEqual(['시뮬에서 실행 못 함']);
    await support();
    expect(flow().hasAttribute('data-support')).toBe(true);
    expect(node('w0').querySelector('.sn-badge')!.textContent).toBe('됨');            // 이동 = 표 gotoA websim
    expect(node('w1').querySelector('.sn-badge')!.textContent).toBe('일부');          // 사진 = capture websim
    expect(node('s:연결').textContent).toContain('됨 0 · 일부 0 · 아직 없음 8');
    await support();
    expect(node('w0').querySelector('.sn-badge')).toBeNull();
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

  it('R3 요약 카드 누르면 그 묶음이 펼쳐지고(읽기만) «접기»로 다시 접힘, «모두 펼치기/모두 접기» = 두 번째 안', async () => {
    await show('websim');
    expect(node('robot')).toBeNull();
    await tap(node('s:연결'));
    expect([flow().dataset.stage, flow().dataset.groups, flow().dataset.nodes]).toEqual(['연결', '2', String(FOLDED - 1 + 8)]);
    expect(ofStage('연결').filter((n) => node(n.id))).toHaveLength(8);
    expect(node('robot').textContent).toContain('고정 절차 · 읽기 전용');
    expect(node('robot').querySelector('.sn-badge')).toBeNull();
    expect($('.sn-box[data-on]').dataset.group).toBe('연결');
    await tap(node('robot')); expect($('[data-detail]').dataset.detail).toBe('robot');
    await tap($('[data-fold-stage="연결"]'));
    expect([flow().dataset.groups, node('robot'), !!node('s:연결')]).toEqual(['1', null, true]);
    await openAll();
    expect([flow().dataset.groups, flow().dataset.nodes, $('[data-all-open]').textContent]).toEqual(['5', String(ALL), '모두 접기']);
    await openAll();
    expect([flow().dataset.groups, flow().dataset.nodes, $('[data-all-open]').textContent]).toEqual(['1', String(FOLDED), '모두 펼치기']);
    expect(pick).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('시뮬 탭 다른 단계 = 읽기만, 띠 = 이동(노드 수 그대로): 연결은 «브라우저 시뮬엔 없음», 예외 처리 17노드, 누르면 처리 주체·실패 시', async () => {
    await show('websim');
    await openAll(); await support();
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

  it('R3 지점 편집 창: 지점 노드를 누르면 form 이 든 창(안내 두 줄·× 닫기), 지도에서 다른 지점을 고르면 그 지점으로 — 고정 절차는 읽기 상세', async () => {
    wide(true);
    let mapPick: (i: number | null) => void = () => {};
    function H() { const [on, setOn] = useState<number | null>(null); mapPick = setOn;
      return <ScenNodes where="websim" items={ITEMS} end="대기" on={on} pick={(i) => { pick(i); setOn(i); }} edit={edit} form={<i data-form>{on}</i>} />; }
    await act(async () => root.render(<H />));
    expect($('[data-point-edit]')).toBeNull();
    await tap(node('w1'));
    const ed = () => $('[data-point-edit]');
    expect([ed().dataset.pointEdit, ed().querySelector('[data-form]')!.textContent, node('w1').querySelector('.sn-card')!.hasAttribute('data-on')]).toEqual(['1', '1', true]);
    expect(ed().textContent).toContain('지점 편집 · 2번 지점 · (1.0, 0.5) m');
    expect(ed().textContent).toContain('이동·할 일만 편집됩니다. 안전 절차는 고정입니다.'); expect(ed().textContent).toContain('위치 변경 뒤에는 실제 경로 검사가 필요합니다.');
    await act(async () => mapPick(2));                                                    // 지도에서 3번 지점
    expect([ed().dataset.pointEdit, $('[data-miss]').textContent, node('w2').querySelector('.sn-card')!.hasAttribute('data-on')]).toEqual(['2', ' «운영자 확인»은 시뮬에서 실행할 수 없습니다.', true]);
    await tap($('[data-detail-close]')); expect(ed()).toBeNull();
    await act(async () => mapPick(0)); expect(ed().dataset.pointEdit).toBe('0');           // 지도에서 다른 지점 = 다시 뜸
    await tap($('[data-edit-point="0"]')); expect(edit).toHaveBeenLastCalledWith(0);
    await tap(node('s:예외 처리')); await tap(node('battery_low'));
    expect([ed(), $('[data-detail]').dataset.detail]).toEqual([null, 'battery_low']);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('R1·R4·R6 크게 보기: 넓은 창은 늘 크게(켜고 끄는 단추·Esc·기억값 없음) — 높이 고정 없음(창 스크롤 없음), 휠 = 확대·축소, 윗줄에 확대·축소, 상세는 누를 때만 카드(× 닫기), 좁은 창은 나란히', async () => {
    wide(true); localStorage.clear();
    await show('websim');
    const big = () => flow().hasAttribute('data-big'), esc = () => act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect([big(), $('[data-big-toggle]'), $('.sn-big'), box.textContent!.includes('원래 크기')]).toEqual([true, null, null, false]);   // 켜고 끄는 단추 없음
    expect($('.sn-canvas').style.height).toBe('');                                          // R6: 그래프 높이로 늘려 창을 굴리지 않음(캔버스 = 남은 높이)
    expect([$('.react-flow__controls'), $$('.sn-top [aria-label="확대·축소"] button').map((b) => b.getAttribute('aria-label'))]).toEqual([null, ['축소', '확대', '화면 맞춤', '전체 보기']]);
    const wheel = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true });
    const was = vp();
    $('.react-flow__pane').dispatchEvent(wheel); expect([wheel.defaultPrevented, vp() !== was]).toEqual([true, true]);   // R6: 휠 = 캔버스 확대·축소(창 스크롤 아님)
    expect([flow().dataset.nodes, $('[data-detail]')]).toEqual([String(FOLDED), null]);     // 상세 = 누를 때만
    expect(stage('연결').title).toBe('됨 0 · 일부 0 · 아직 없음 8');                          // 윗줄 칩: 개수는 title
    await tap(node('s:예외 처리')); expect(flow().dataset.stage).toBe('예외 처리');
    await openAll();
    await tap(node('w1'));
    expect([$('[data-detail]').dataset.detail, pick.mock.lastCall]).toEqual(['w1', [1]]);
    expect($('[data-edit-point="1"]')).not.toBeNull();                                      // form 없으면 지점도 읽기 상세 + 편집 단추
    await tap($('[data-detail-close]')); expect($('[data-detail]')).toBeNull();
    await tap(node('w1')); expect($('[data-detail]').dataset.detail).toBe('w1');            // 같은 노드를 다시 누르면 다시 뜸
    await tap(node('battery_low')); expect([$('[data-detail]').dataset.detail, $('[data-edit-point]')]).toEqual(['battery_low', null]);
    await esc(); expect([big(), $('[data-detail]').dataset.detail, localStorage.length]).toEqual([true, 'battery_low', 0]);   // Esc 로 줄지 않고 아무것도 기억하지 않음
    act(() => root.unmount()); root = createRoot(box);
    wide(false); await show('websim');                                                   // 좁은 창 = 나란히(안쪽 확대·축소 칸, 높이 제한)
    expect([big(), $('[data-big-toggle]'), $('.sn-canvas').style.height, $('.react-flow__controls') != null]).toEqual([false, null, '', true]);
  });

  it('R7 펼치기·접기·모두 펼치기 = 다시 맞추지 않음: 누른 묶음(모두 = 임무)의 제목 자리가 같은 화면 위치·배율 그대로, 단계 칩은 지금처럼 이동', async () => {
    wide(true);
    await show('websim');
    await act(() => new Promise((r) => setTimeout(r, 200)));                                  // 처음 맞춤(150ms 뒤 한 번)이 끝난 뒤
    const num = (t: string) => (t.match(/-?[\d.]+(e-?\d+)?/g) ?? []).map(Number);
    const at = (id: string) => { const [x, y, z] = num(vp()), [nx, ny] = num(node(id).style.transform); return [Math.round(x + nx * z), Math.round(y + ny * z), z]; };
    await drag($('.react-flow__pane'), 70); await act(() => new Promise((r) => setTimeout(r, 5)));   // 끈 뒤 click 막기(d3, 0ms)가 풀릴 때까지
    $('.react-flow__pane').dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }));   // 끌고 줄인 화면에서 시작
    const card = at('s:운행 준비'), mission = at('g:임무');
    expect(card[2]).not.toBe(1);
    await tap(node('s:운행 준비'));
    expect([flow().dataset.stage, at('g:운행 준비')]).toEqual(['운행 준비', card]);                // 펼친 묶음 제목 = 카드 자리
    await tap($('[data-fold-stage="운행 준비"]'));
    expect(at('s:운행 준비')).toEqual(card);                                                    // 접어도 그 자리
    await openAll(); expect(at('g:임무')).toEqual(mission);                                     // 모두 펼치기 = 임무 묶음 고정(왼쪽 기둥이 넓어져도)
    await openAll(); expect(at('g:임무')).toEqual(mission);
    await tap(stage('복귀·종료')); expect(at('s:복귀·종료')[2]).toBe(1);                         // 단계 칩 = 그 묶음으로 이동(1배)
  });

  it('R6 끌기 이동: 카드 위에서 끌면 화면만 옮기고(노드 그대로·고르지 않음) 짧은 누름은 고름, 지점 편집 창 안 끌기·휠은 캔버스로 안 감', async () => {
    wide(true);
    await act(async () => root.render(<ScenNodes where="websim" items={ITEMS} end="대기" on={0} pick={pick} edit={edit} form={<input data-in />} />));
    expect($('[data-point-edit]').dataset.pointEdit).toBe('0');
    const was = vp(), at = node('w1').style.transform;
    await drag(node('w1'), 60);
    expect([vp() !== was, node('w1').style.transform, $('[data-point-edit]').dataset.pointEdit]).toEqual([true, at, '0']);
    expect(pick).not.toHaveBeenCalled();                                                       // 끈 뒤 click = 고르기 아님
    expect(node('w1').classList.contains('nopan')).toBe(false);                                // 노드 끌기 꺼짐 → 카드 위도 이동
    await act(() => new Promise((r) => setTimeout(r, 5)));                                    // 끈 뒤 click 막기(d3, 0ms)가 풀릴 때까지
    await drag(node('w1'), 2); expect([$('[data-detail]').dataset.detail, pick.mock.lastCall]).toEqual(['w1', [1]]);   // 2px 흔들림 = 누름
    await act(async () => root.render(<ScenNodes where="websim" items={ITEMS} end="대기" on={1} pick={pick} edit={edit} form={<input data-in />} />));   // 지도에서 2번 = 편집 창
    const v = vp(), wheel = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true });
    $('[data-in]').dispatchEvent(wheel); await drag($('[data-in]'), 80);
    expect([vp(), wheel.defaultPrevented, $('.react-flow').contains($('[data-point-edit]'))]).toEqual([v, false, false]);   // 편집 창은 캔버스 밖
  });

  it('지도 탭 = real 판정(지원 현황 켤 때): 연결 8개 됨, 실기체 미검증 한 줄, 일부면 빠진 것', async () => {
    await show('real');
    await openAll(); await support();
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
