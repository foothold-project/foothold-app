// SCEN-LIFECYCLE-EDITOR 11-09 — 시나리오 «운영 흐름»(React Flow): 단계 띠 5개·개수, 기본 = 임무, 임무 노드 = 지점 수(시뮬 거절 지점 «시뮬에서 실행 못 함»),
// SCEN-ONE-FLOW 11-10 — 한 캔버스에 다섯 묶음·단계 사이 선 3개·예외 점선 2개, 단계 띠 = 그 묶음으로 이동(노드 수 그대로),
// 다른 단계 = 읽기만(끌기·잇기·추가 단추 없음), 시뮬 탭 = websim·지도 탭 = real 배지, 노드 상세, 저장(네트워크) 호출 없음. (jsdom 대역 = setup.ts)
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
    const ex = R[STAGES.indexOf('예외 처리')], mi = R[STAGES.indexOf('임무')];
    expect(ex.x).toBeGreaterThan(mi.r); expect(ex.y).toBe(mi.y);                        // 예외 = 임무 오른쪽 옆
    expect(g.edges.filter((e) => e.className === 'sn-link').map((e) => e.id)).toEqual(['connected>mode', 'ready>start', 'end>return']);
    expect(g.edges.filter((e) => e.className === 'sn-jump').map((e) => [e.source, e.target, e.label])).toEqual([['g:임무', 'g:예외 처리', '임무 중 언제든'], ['g:예외 처리', 'g:복귀·종료', undefined]]);
    const exIds = new Set(ofStage('예외 처리').map((n) => n.id));
    expect(g.edges.filter((e) => exIds.has(e.source) || exIds.has(e.target))).toHaveLength(0);
    const ids = new Set(g.nodes.map((n) => n.id));
    expect(g.edges.length).toBe(5 + 6 + (ITEMS.length + 1) + 8 + 3 + 2);
    for (const e of g.edges.filter((x) => x.className !== 'sn-jump')) expect(ids.has(e.source) && ids.has(e.target), e.id).toBe(true);
    for (const id of ['connected', 'mode', 'ready', 'start', 'end', 'return']) expect(g.nodes.find((n) => n.id === id)!.data.edge, id).toBeUndefined();   // 단계 사이 선 양 끝 = 점 둘 다
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
