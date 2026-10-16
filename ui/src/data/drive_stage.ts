// 조종 단계(②)·경고 목록(③) — 서버 상태 원값(role·latch·resume_pending·reset_pending·sim_block)과 링크 신선도만 본다.
// 화면 표시용 순수 함수: 명령을 보내지 않는다(자동 take/resume 0 — 다음 행동은 사람이 «조종 시작» 확인으로). 계약 docs/CONTRACT-ui-improve-20261014.md ②③
import type { Status } from '@contracts';
import { RELURCH } from './facts';

export const STEPS = ['보기', '조종권', 'STOP 해제', '조종 가능'] as const;
/** i = 지금 칸(0~3). stop = 단계를 막는 이유(있으면 단계 대신 이것을 보여 줌). next = 다음 행동 한 줄. label = 칸 이름 대신 보일 지금 사실(있을 때만) */
export type Stage = { i: number; stop: string | null; next: string; label?: string };
/** 화면에 보이는 단계 글 — label 이 있으면 그것(R1: 서버가 입력을 적용 안 하는 동안 «조종 가능» 표면 글 0), 없으면 칸 이름 */
export const stepLabel = (g: Stage) => g.label ?? STEPS[g.i];
export type Lvl = 'block' | 'warn' | 'info';
export type Warn = { lvl: Lvl; text: string; fix: string };
// block = 실제 발행 판정 data/link driveBlock(L) 결과 그대로 — «조종 가능»은 이것이 null 일 때만(새 판·형식 이상·STOP ACK 전 stopHeld 포함)
export type In = { linkOk: boolean; linkTxt: string; st: Status | null; viewOnly: boolean; fallen: boolean; newVer: boolean; block: string | null };

const SIM_OFF = ['시뮬 상태 미수신', '시뮬 상태 끊김'];
const ctlOf = (x: In) => !!x.st && x.st.role === 'control' && !x.viewOnly;

/** 서버가 지금 명령을 0 으로 둔 이유 중 driveBlock 이 못 보는 것(«손을 한 번 뗀 뒤 다시 누르세요»·방향 미검증 등) — 조종 중·클라이언트 막힘 없을 때만.
 *  표시만: 서버 status.reason 원문 그대로(차단·권한 판단은 서버·driveBlock 그대로). 막힘이 풀리면 서버가 '' 로 비운다 */
export const srvWhy = (x: In): string | null => (x.linkOk && x.st && ctlOf(x) && !x.st.latch && !x.block && x.st.reason) || null;

export function stageOf(x: In): Stage {
  const g = stage0(x);   // U2 보완: 넘어짐이면 «다음»에 넘어짐 대처를 먼저(단계·막힘 판정은 그대로 — 표시 우선순위만)
  return x.fallen && !g.stop ? { ...g, next: `넘어짐 — 필요하면 «STOP» 뒤 «시뮬 리셋»(조종권 필요) · 그 밖: ${g.next}` } : g;
}
function stage0(x: In): Stage {
  const st = x.st;
  if (!x.linkOk || !st) return { i: 0, stop: `링크 ${x.linkTxt}`, next: '연결 회복 대기 · 명령 0 · 다시 붙으면 보기 전용부터' };
  if (st.sim_block) return { i: 0, stop: st.sim_block, next: SIM_OFF.includes(st.sim_block) ? '시뮬 상태 확인 안 됨 — 지도 화면 «지도 열기»(시뮬 시작) 또는 대기'   /* U2(670 P2): 미수신·끊김 ≠ 꺼짐 */ : '서버 이유가 풀릴 때까지 명령 0' };
  if (st.reset_pending) return { i: 2, stop: '시뮬 리셋 처리 중', next: '끝날 때까지 STOP 유지' };
  if (st.resume_pending) return { i: 2, stop: 'STOP 해제 확인 대기', next: '서버 확인 대기 · 명령 0' };
  if (st.role === 'view_other') return { i: 0, stop: '다른 기기가 조종 중', next: '그 기기가 반납하면 «조종 시작»' };
  if (!ctlOf(x)) return { i: 0, stop: null, next: '«조종 시작»(확인 1회 · 또는 막대 한 번)' };
  if (st.latch) return { i: 1, stop: null, next: '«조종 시작»(확인 1회) → 손 떼고 다시 누르면 움직임' };
  if (x.block) return { i: 2, stop: x.block, next: '명령 0 — 이 이유가 풀려야 움직임' };   // 표시만 앞서가지 않게: 실제 차단과 모순 0
  const sw = srvWhy(x);   // U2 보완 A1: 조종 가능 단계여도 서버가 지금 막는 이유가 있으면 «조종 가능»만 말하지 않음
  // R1·R2: 단계 번호(i=3)는 그대로, 보이는 글만 지금 사실. 근거는 서버가 입력을 명령에 적용 안 함(reason)뿐 — 몸의 정지는 말하지 않음(몸은 늦게 멈추거나 다시 움직일 수 있음)
  if (sw) return { i: 3, label: '입력 막힘', stop: `입력 적용 안 됨 · ${sw}`, next: '이유대로 하면 다시 누를 때 입력 적용 · 떼면 명령 0' };
  return { i: 3, stop: null, next: '누르는 동안 이동 · 떼면 0' };
}

const RANK: Record<Lvl, number> = { block: 0, warn: 1, info: 2 };
/** 경고 목록: block = 지금 명령 0(driveBlock 과 같은 사실), warn = 주의(명령은 막지 않음), info = 안내. 중요한 것부터(같은 등급은 넣은 순서) */
export function warnsOf(x: In): Warn[] {
  const st = x.st, ctl = ctlOf(x), w: Warn[] = [];
  const add = (lvl: Lvl, text: string, fix: string) => w.push({ lvl, text, fix });
  if (x.newVer && st) add('block', `새 화면 판(${st.ver}) · 명령 0`, '조종하지 않을 때 새로고침');   // driveBlock 이 실제로 막음
  if (!x.linkOk || !st) add('block', `링크 ${x.linkTxt} · 명령 0`, '휴대폰 네트워크·관문 PC 확인 — 다시 붙으면 보기 전용부터');
  else {
    const off = SIM_OFF.includes(st.sim_block), ss = st.map_start;   // SLAM-1: 시작 = map_start 하나(평지 sim_start 칸으로 판단·안내 0)
    if (st.sim_block) add('block', `${st.sim_block} · 명령 0`, !off ? '서버 이유가 풀릴 때까지 대기' : ss && !ss.ok ? `시뮬 시작 불가 — ${ss.why}` : '시뮬 상태가 안 들어옴(꺼짐 확정 아님) — 지도 화면 «지도 열기»(SLAM · STOP 상태로 시작) 또는 RL 쪽 상태 확인');
    if (off && ss?.last?.st === 'bad') add('warn', `최근 시작 결과 ${ss.last.t} · 실패·결과 미확인`, ss.last.text);   // toast 만으로 숨기지 않음 · r2: 서버 bad 에는 시간 초과도 들어감 → «안 켜짐» 단정 0
    if (st.reset_pending) add('block', '시뮬 리셋 처리 중 · STOP 유지', '끝날 때까지 대기');
    else if (st.resume_pending) add('block', 'STOP 해제 확인 대기 · 명령 0', '서버 확인 대기');
    else if (st.latch) add('block', 'STOP 잠금 · 명령 0', '«조종 시작»(확인 1회) 뒤 손 떼고 다시 누름');
    if (st.latch) add('warn', RELURCH, '정지 직후 주변을 비워 두기 · 원인 미확인');
    if (x.fallen) add('warn', '넘어짐 · 명령은 막지 않음', '필요하면 «STOP» 뒤 «시뮬 리셋»(조종권 필요)');   // 낙상만으로는 Core·driveBlock 이 막지 않음(기존 계약) — 새 차단 0
    if (st.reason && !st.latch && !st.sim_block && st.reason !== '조종권 없음') add('warn', st.reason, '서버가 준 이유 — 메뉴 «상태 원값»에서 확인');
    if (st.role === 'view_other') add('info', `다른 기기가 조종 중${st.holder ? ` · ${st.holder}` : ''} · 보기 전용`, '그 기기가 반납하면 «조종 시작»');
    else if (!ctl) add('info', '보기 전용', '«조종 시작»(확인 1회 · 또는 막대 한 번)');
  }
  return w.map((v, i) => [v, i] as const).sort((a, b) => RANK[a[0].lvl] - RANK[b[0].lvl] || a[1] - b[1]).map(([v]) => v);
}
export const MARK: Record<Lvl, string> = { block: '■', warn: '▲', info: '●' };
export const LVL_TXT: Record<Lvl, string> = { block: '막힘', warn: '주의', info: '안내' };
