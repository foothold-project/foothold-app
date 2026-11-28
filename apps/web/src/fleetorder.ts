// 로봇 목록 순서 공용 규칙 (팀장 11-28 17:34): 긴급 먼저 → 실기 → 데모 → 사용자 시뮬, 같은 칸 안은 받은 순서.
// 관제(타일 · 지도 보기 줄)와 로봇 탭이 같은 함수를 쓴다. 무엇이 긴급인지 · 어느 종류인지는 부르는 쪽이 이미 가진 값으로 넘긴다.

/** 긴급 단계: 위험 · 경고 · 주의(시안이 칸을 빨강 · 주황으로 칠하는 것) · 연결 끊김. null = 긴급 아님 */
export type Urgent = 'crit' | 'bad' | 'warn' | 'lost' | null;
/** 실기 = 실제 로봇(Go2 X 등) · 데모 = 데모 현장 로봇(가용 demo) · 시뮬 = 사용자가 띄운 시뮬 */
export type FleetKind = 'real' | 'demo' | 'sim';

const URGENT: Record<Exclude<Urgent, null>, number> = { crit: 0, bad: 1, warn: 2, lost: 3 };
const KIND: Record<FleetKind, number> = { real: 0, demo: 1, sim: 2 };

/** 데모 표시(가용 demo)와 시뮬 여부로 종류를 정한다. 데모가 시뮬로 돌아도 데모로 센다 */
export const fleetKind = (sim: boolean | undefined, demo: boolean | undefined): FleetKind => (demo ? 'demo' : sim ? 'sim' : 'real');

/** 정렬한 새 배열(원본 그대로). 긴급 단계 → 종류 → 받은 순서 */
export function fleetOrder<T>(list: readonly T[], urgent: (t: T) => Urgent, kind: (t: T) => FleetKind): T[] {
  return list.map((t, i) => ({ t, i, u: urgent(t), k: KIND[kind(t)] }))
    .sort((a, b) => (a.u ? URGENT[a.u] : 9) - (b.u ? URGENT[b.u] : 9) || a.k - b.k || a.i - b.i)
    .map((x) => x.t);
}
