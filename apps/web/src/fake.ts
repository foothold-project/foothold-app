// 가짜 데이터(서버 호출 0). 로봇 3대·층 2개·가짜 로그인 사용자. 계약(apps/contracts) TS 타입이 나오면 그 타입으로 바꾼다.
export type Role = 'ORG_ADMIN' | 'OPERATOR';
export type User = { id: string; name: string; role: Role };
export type Floor = { id: string; site: string; name: string };
export type Robot = { id: string; name: string; owner: string; floor: string; battery: number | null; state: 'mission' | 'idle' | 'offline'; mission?: string };
export type Approval = { id: string; kind: string; target: string; by: string; at: string };
export type Tone = 'off' | 'ok' | 'warn' | 'bad';

export const ROLE_NAME: Record<Role, string> = { ORG_ADMIN: '총괄', OPERATOR: '운영 관리자' };

export const USERS: User[] = [
  { id: 'u-kim', name: '김OO', role: 'ORG_ADMIN' },
  { id: 'u-lee', name: '이OO', role: 'OPERATOR' },
  { id: 'u-park', name: '박OO', role: 'OPERATOR' },
];

export const FLOORS: Floor[] = [
  { id: 'f1', site: '본관', name: '1층' },
  { id: 'f2', site: '본관', name: '2층' },
];

export const ROBOTS: Robot[] = [
  { id: 'r3', name: 'Go2-3', owner: 'u-lee', floor: 'f2', battery: 82, state: 'mission', mission: '2층 순찰 3/5' },
  { id: 'r7', name: 'Go2-7', owner: 'u-park', floor: 'f1', battery: 15, state: 'idle' },
  { id: 'r1', name: 'Go2-1', owner: 'u-lee', floor: 'f1', battery: null, state: 'offline' },
];

export const APPROVALS: Approval[] = [
  { id: 'a1', kind: '지도 수정', target: '본관 2층', by: 'u-park', at: '10:42' },
  { id: 'a2', kind: '배정', target: '2층 순찰 → Go2-3', by: 'u-lee', at: '11:05' },
];

export const SCENARIOS = [
  { id: 's1', name: '2층 순찰', floor: 'f2', points: 5, meters: 84, robot: 'r3', last: '어제 완료' },
  { id: 's2', name: '1층 점검', floor: 'f1', points: 3, meters: 40, robot: 'r1', last: '' },
];

export const EVENTS = [
  { at: '14:02', tone: 'warn' as Tone, robot: 'r3', text: 'Go2-3이 계획 경로에서 1.8 m 벗어났습니다.' },
  { at: '13:55', tone: 'ok' as Tone, robot: 'r3', text: '이OO님이 Go2-3 조종을 끝냈습니다.' },
  { at: '13:40', tone: 'bad' as Tone, robot: 'r1', text: 'Go2-1 연결이 끊겼습니다. 로봇은 정지·잠금 상태입니다.' },
];

export const userName =(id: string) => USERS.find((u) => u.id === id)?.name ?? '알 수 없음';
export const floorName = (id: string) => { const f = FLOORS.find((x) => x.id === id); return f ? `${f.site} ${f.name}` : ''; };

/** 상태 표시 하나(03 UX §4): 회색 = 꺼짐, 주황 = 나빠짐, 빨강 = 끊김 */
export function robotStatus(r: Robot): { tone: Tone; text: string } {
  if (r.state === 'offline') return { tone: 'bad', text: '끊김' };
  if (r.battery != null && r.battery < 20) return { tone: 'warn', text: '배터리 낮음' };
  return r.state === 'mission' ? { tone: 'ok', text: '임무 중' } : { tone: 'off', text: '대기' };
}

/** 조종할 수 없으면 이유(02 기능 §10: 운영자는 남의 로봇 조종 ×). 할 수 있으면 null */
export function driveBlock(u: User, r: Robot): string | null {
  if (u.role !== 'ORG_ADMIN' && r.owner !== u.id) return `${userName(r.owner)}님의 로봇입니다. 내 로봇만 조종할 수 있습니다.`;
  if (r.state === 'offline') return '연결이 끊겨 조종할 수 없습니다. 현장에서 로봇 전원을 확인하세요.';
  return null;
}

/** 운영자는 내 로봇을 먼저(02 기능 §1.1) */
export const robotsFor = (u: User) => (u.role === 'ORG_ADMIN' ? ROBOTS : [...ROBOTS.filter((r) => r.owner === u.id), ...ROBOTS.filter((r) => r.owner !== u.id)]);
