// 시나리오 → 시뮬 BT 나무(SIM-REAL-SPLIT 11-09): 시뮬 탭 시나리오의 «시뮬에서 실행»이 서버 시나리오를 mobile/sim/bt.js 나무로 바꾸고
// validateTree 로 검사한 뒤 이 브라우저 fh.btMission.<id> 에 둔다 — 시뮬 main.js 가 ?bt=<id> 로 같은 키를 읽어 다시 검사한다(시뮬 쪽 그대로).
// 옛 «임무 편집»(BT-NODE-EDITOR, 이 브라우저에만 저장한 나무)은 시나리오 편집기의 노드 보기로 합쳐 지웠다. 옛 저장본은 지우지 않고 수만 센다.
import type { Mission, ScenarioWrite } from '../../../contracts/ts';
import * as BT from '../../../../mobile/sim/bt.js';
import type { BtNode, BtPoint as Pt, BtTree as Tree } from '../../../../mobile/sim/bt.js';

export type { BtNode, Pt, Tree };
/** fh.btMission.<id> 저장본(main.js ?bt= 가 id·map·name·floor·tree 를 읽는다). scenario_id = 서버 시나리오에서 만든 것 */
export type SimMission = { id: string; name: string; map: string; floor: string; tree: Tree; scenario_id?: string };

const kids = (n: BtNode) => n.children ?? (n.child ? [n.child] : []);
/** 시뮬이 시나리오 points 로 쓰는 지점(main.js ?bt= 와 같은 순서): 지점마다의 points 다음 이동의 좌표 */
export const treePoints = (t: Tree) => {
  const out: Pt[] = [], walk = (n: BtNode) => { if (n.points) out.push(...n.points); if (n.point && n.point !== 'current') out.push(n.point); kids(n).forEach(walk); };
  walk(t.root); return out;
};
/** validateTree 결과: '' = 통과. 시뮬은 지점 0개 시나리오를 받지 않으므로(scenario.js validateScenarios) 그 이유도 함께 */
export function check(t: Tree) {
  try { BT.validateTree(t); } catch (e) { return (e as Error).message; }
  return treePoints(t).length ? '' : '순찰 지점이 하나도 없습니다 — 시뮬은 지점 없는 임무를 받지 않습니다.';
}

const NO_SIM: Record<string, string> = { OPERATOR_CONFIRM: '운영자 확인', SENSOR_LOG: '센서 값 기록' };
/** 서버 시나리오 → 나무. 지점마다 goto(좌표 그대로 — 층 지도 좌표 = 시뮬 좌표일 때만 부른다) + 그 지점 임무(사진 → photo, 대기 → wait), 끝 = return_home·goto.
 *  시뮬이 못 하는 일(운영자 확인·센서 기록·120초 넘는 대기)·내용을 모르는 임무(옛 판·목록에 없음)면 이유 문자열. yaw 는 버린다(bt.js goto 는 x·y 만) */
export function scenarioTree(s: ScenarioWrite, missions: Mission[]): Tree | string {
  const nodes: BtNode[] = [];
  for (const [i, w] of s.waypoints.entries()) {
    nodes.push({ type: 'goto', point: { x: w.x, y: w.y } });
    if (!w.mission_id) continue;
    const m = missions.find((x) => x.id === w.mission_id);
    if (!m || m.latest_version !== w.mission_version) return `${i + 1}번 지점: 옛 판 임무 — 할 일을 다시 고른 뒤 저장하세요.`;
    for (const st of m.steps) {
      if (NO_SIM[st.action]) return `${i + 1}번 지점: «${NO_SIM[st.action]}»은 시뮬에서 실행할 수 없습니다.`;
      if (st.action === 'PHOTO') nodes.push({ type: 'photo' });
      if (st.action === 'WAIT') {
        const raw = w.wait_s ?? st.params?.seconds, sec = Number(raw);   // 지점 대기(wait_s)가 임무 판 값을 덮는다(서버 실행과 같게)
        if (!(sec > 0 && sec <= BT.ACTION_SECONDS.wait)) return `${i + 1}번 지점: 대기 ${raw}초 — 시뮬은 한 번에 ${BT.ACTION_SECONDS.wait}초까지 기다립니다.`;
        nodes.push({ type: 'wait', seconds: sec });
      }
    }
  }
  const f = s.finish;
  if (f?.mode === 'RETURN_TO_START') nodes.push({ type: 'return_home' });
  if (f?.mode === 'GO_TO' && f.target) nodes.push({ type: 'goto', point: { x: f.target.x, y: f.target.y } });
  const tree: Tree = { format: BT.TREE_FORMAT, max_seconds: 3600, root: { type: 'sequence', children: nodes } };
  return check(tree) || tree;
}

const PREFIX = 'fh.btMission.';
/** 시나리오 id → 저장 키 id(main.js 형식 [a-z0-9-] 32자 이내). 같은 시나리오는 같은 키(다시 누르면 덮음) */
export const simId = (scenario: string) => `s${scenario.toLowerCase().replace(/[^a-z0-9]/g, '')}`.slice(0, 32);
export const saveSim = (m: SimMission) => { try { localStorage.setItem(PREFIX + m.id, JSON.stringify(m)); return true; } catch { return false; } };
/** 옛 «임무 편집» 저장본 수(scenario_id 없는 fh.btMission.*) — 옮기지도 지우지도 않는다 */
export function oldMissions() {
  try {
    return Object.keys(localStorage).filter((k) => {
      if (!k.startsWith(PREFIX)) return false;
      try { return !(JSON.parse(localStorage.getItem(k) ?? '') as SimMission | null)?.scenario_id; } catch { return true; }
    }).length;
  } catch { return 0; }
}
