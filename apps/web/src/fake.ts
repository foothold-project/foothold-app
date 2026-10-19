// 가짜 데이터(서버 호출 0). 로봇 3대·층 2개·사용자 3명. 로그인하면 USERS·ROBOTS 는 서버 값(/me·/robots)으로 바뀐다(setServerData).
// 층·결재·시나리오·사건과 로봇 상태(조종 중재기 fakeDrive)는 아직 가짜.
export type Role = 'ORG_ADMIN' | 'OPERATOR';
export type User = { id: string; name: string; role: Role };
export type Floor = { id: string; site: string; name: string };
/** 로봇 요약 상태(02 §4 «로봇 요약 상태와 실행 상태»). 끊긴 로봇이면 마지막 확인 값 */
export type Status = 'STOP_LATCHED' | 'ERROR' | 'TELEOP' | 'PAUSED' | 'RUNNING' | 'IDLE';
/** online = connection ONLINE. status null = 아직 상태를 받은 적 없음(연결 전). seenAt = 마지막 확인 시각. mission = current_run(끝나지 않은 실행) 이름 */
export type Robot = { id: string; name: string; owner: string; ownerName?: string; floor: string; battery: number | null; online: boolean; seenAt: string; status: Status | null; mission?: string };
export type Approval = { id: string; kind: string; target: string; by: string; at: string };
export type Tone = 'off' | 'ok' | 'warn' | 'bad';
/** actor = 행동한 사람(없으면 로봇·시스템 사건) */
export type Event = { id: string; at: string; tone: Tone; robot: string; actor?: string; text: string };

export const ROLE_NAME: Record<Role, string> = { ORG_ADMIN: '총괄', OPERATOR: '운영 관리자' };
export const STATUS_NAME: Record<Status, string> = { STOP_LATCHED: '정지 잠금', ERROR: '오류', TELEOP: '사람 조종', PAUSED: '일시정지', RUNNING: '임무 중', IDLE: '대기' };

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
  { id: 'r3', name: 'Go2-3', owner: 'u-lee', floor: 'f2', battery: 82, online: true, seenAt: '14:05:20', status: 'RUNNING', mission: '2층 순찰 3/5' },
  { id: 'r7', name: 'Go2-7', owner: 'u-park', floor: 'f1', battery: 15, online: true, seenAt: '14:05:20', status: 'IDLE' },
  { id: 'r1', name: 'Go2-1', owner: 'u-lee', floor: 'f1', battery: null, online: false, seenAt: '13:40:05', status: 'STOP_LATCHED' },
];

export const APPROVALS: Approval[] = [
  { id: 'a1', kind: '지도 수정', target: '본관 2층', by: 'u-park', at: '10:42' },
  { id: 'a2', kind: '배정', target: '2층 순찰 → Go2-3', by: 'u-lee', at: '11:05' },
];

export const SCENARIOS = [
  { id: 's1', name: '2층 순찰', floor: 'f2', points: 5, meters: 84, robot: 'r3', last: '어제 완료' },
  { id: 's2', name: '1층 점검', floor: 'f1', points: 3, meters: 40, robot: 'r1', last: '' },
];

export const userName = (id: string) => USERS.find((u) => u.id === id)?.name ?? ROBOTS.find((r) => r.owner === id)?.ownerName ?? '알 수 없음';
export const floorName = (id: string) => { const f = FLOORS.find((x) => x.id === id); return f ? `${f.site} ${f.name}` : ''; };

/** 연결 끊김 문구: 끊긴 동안 상태를 단정하지 않고 «마지막 확인 + 미확인»(02 F-COM-02) */
export const lostText = (r: Robot) => `${r.name} 연결이 끊겼습니다. 마지막 확인: ${r.status ? STATUS_NAME[r.status] : '없음'}(${r.seenAt}). 지금 상태는 알 수 없습니다.`;
/** 띠에 올릴 끊김: 한 번이라도 상태를 받은 로봇만(받은 적 없으면 «연결 전» — 끊김 경보가 아님) */
export const lost = (r: Robot) => !r.online && r.status != null;

export const EVENTS: Event[] = [
  { id: 'e5', at: '14:02', tone: 'warn', robot: 'r3', text: 'Go2-3이 계획 경로에서 1.8 m 벗어났습니다.' },
  { id: 'e4', at: '13:58', tone: 'bad', robot: 'r3', actor: 'u-park', text: '박OO님이 Go2-3 STOP 을 눌렀습니다.' },
  { id: 'e3', at: '13:55', tone: 'ok', robot: 'r3', actor: 'u-lee', text: '이OO님이 Go2-3 조종을 끝냈습니다.' },
  // 02 F-LG-02 LINK_LOST 문장 틀
  { id: 'e2', at: '13:40', tone: 'bad', robot: 'r1', text: 'Go2-1과 연결이 끊겼습니다. 마지막 확인 상태: 정지 잠금. 이후 상태는 확인되지 않았습니다.' },
  { id: 'e1', at: '13:20', tone: 'warn', robot: 'r7', text: 'Go2-7 배터리가 15%로 낮습니다.' },
];

/** 상태 표시 하나(03 UX §4): 회색 = 꺼짐, 주황 = 나빠짐, 빨강 = 잠금·끊김 */
export function robotStatus(r: Robot): { tone: Tone; text: string } {
  if (!r.online) return r.status ? { tone: 'bad', text: '끊김' } : { tone: 'off', text: '연결 전' };
  if (!r.status) return { tone: 'off', text: '상태 확인 중' };
  if (r.status === 'STOP_LATCHED' || r.status === 'ERROR') return { tone: 'bad', text: STATUS_NAME[r.status] };
  if (r.battery != null && r.battery < 20) return { tone: 'warn', text: '배터리 낮음' };
  if (r.status === 'PAUSED') return { tone: 'warn', text: STATUS_NAME[r.status] };
  return { tone: r.status === 'IDLE' ? 'off' : 'ok', text: STATUS_NAME[r.status] };
}

/** 조종할 수 없으면 이유(02 기능 §10: 운영자는 남의 로봇 조종 ×). 할 수 있으면 null */
export function driveBlock(u: User, r: Robot): string | null {
  if (u.role !== 'ORG_ADMIN' && r.owner !== u.id) return `${userName(r.owner)}님의 로봇입니다. 내 로봇만 조종할 수 있습니다.`;
  if (!r.online) return r.status ? '연결이 끊겨 조종할 수 없습니다. 현장에서 로봇 전원을 확인하세요.' : '로봇이 아직 연결되지 않아 조종할 수 없습니다. 현장에서 로봇 전원을 확인하세요.';
  return null;
}

/** PC 관제·조종 고르기(02 기능 §1.1): 서버가 준 전체(scope=all), 운영자는 내 로봇을 먼저 */
export const robotsFor = (u: User, list = ROBOTS) => (u.role === 'ORG_ADMIN' ? list : [...myRobots(u, list), ...list.filter((r) => r.owner !== u.id)]);
/** 폰·내 로봇 범위(02 기능 §1.2): 운영자는 담당 로봇만, 총괄은 전체 */
export const myRobots = (u: User, list = ROBOTS) => (u.role === 'ORG_ADMIN' ? list : list.filter((r) => r.owner === u.id));
/** 기록 범위(02 기능 §10): 총괄 전체, 운영자는 내 로봇 사건 + 내 행동 */
export function eventsFor(u: User) {
  const known = EVENTS.filter((e) => ROBOTS.some((r) => r.id === e.robot));   // 서버 로봇으로 바뀌면 가짜 사건은 0건
  return u.role === 'ORG_ADMIN' ? known : known.filter((e) => e.actor === u.id || myRobots(u).some((r) => r.id === e.robot));
}

/** 로그인 뒤 서버 값으로 바꿔 끼움. 가짜 조종 중재기(fakeDrive)가 이 목록을 읽으므로 끼운 뒤 resetDrive() */
export function setServerData(me: User, robots: Robot[]) {
  USERS.splice(0, USERS.length, me);
  ROBOTS.splice(0, ROBOTS.length, ...robots);
}
