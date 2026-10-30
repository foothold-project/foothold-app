// 화면 자료 모양 + 아직 가짜인 묶음. USERS·ROBOTS 는 처음 비어 있고 로그인하면 서버 값(/me·/robots)으로 채운다(setServerData).
// 로봇 상태·조종권은 실시간 연결(rt.ts)이 얹는다. 폰 시나리오 카드는 아직 가짜(임무 탭 목록·편집은 /missions·/scenarios — screens/missions.tsx, 사건은 서버 /events — screens/history.tsx, 장소·지도는 /sites — screens/maps.tsx, 결재는 /approvals — screens/approvals.tsx).
import type { Device, Location, PhoneRelayState, RobotSummary } from '../../contracts/ts';
export type Role = 'ORG_ADMIN' | 'OPERATOR';
export type User = { id: string; name: string; role: Role };
/** 로봇 요약 상태(02 §4 «로봇 요약 상태와 실행 상태»). 끊긴 로봇이면 마지막 확인 값 */
export type Status = 'STOP_LATCHED' | 'ERROR' | 'TELEOP' | 'PAUSED' | 'RUNNING' | 'IDLE';
/** online = connection ONLINE. status null = 아직 상태를 받은 적 없음(연결 전). seenAt = 마지막 확인 시각. mission = current_run(끝나지 않은 실행) 이름.
 *  location·devices = 서버 요약값(구독 로봇은 실시간 state 가 덮음). null·빈 목록 = 받은 값 없음 — 화면은 지어내지 않는다.
 *  unknown = 지금 상태를 단정할 수 없음(rt.withLive): link 실시간 끊김, wait 첫 state 전, summary 구독 안 하는 로봇(목록 요약 값뿐).
 *  holder·listedAt = 목록 요약의 조종권자와 그 목록을 받은 시각(구독 안 하는 로봇의 조종권자 표시용).
 *  sim = 시뮬 로봇(서버 RobotSummary.simulation — «시뮬» 표시는 이 값만 쓴다, 05 §13.9) */
export type Holder = { type: 'USER' | 'RUN'; id: string | null; name: string };
export type Robot = { id: string; name: string; owner: string; ownerName?: string; battery: number | null; online: boolean; seenAt: string; status: Status | null; mission?: string;
  unknown?: 'link' | 'wait' | 'summary'; holder?: Holder | null; listedAt?: string; location?: Location | null; devices?: Device[]; sim?: boolean;
  phoneRelay?: PhoneRelayState | null; phoneRelayAt?: number;
  /** 서버가 이 실기 로봇의 웹 서버 경유 시험 조종을 켰음(10-30 SERVER-DRIVE — serverdrive.tsx). 서버가 true 로 줄 때만 */
  serverDrive?: boolean };
export type Tone = 'off' | 'ok' | 'warn' | 'bad';

export const ROLE_NAME: Record<Role, string> = { ORG_ADMIN: '총괄', OPERATOR: '운영 관리자' };
export const STATUS_NAME: Record<Status, string> = { STOP_LATCHED: '정지 잠금', ERROR: '오류', TELEOP: '사람 조종', PAUSED: '일시정지', RUNNING: '임무 중', IDLE: '대기' };

export const USERS: User[] = [];

export const ROBOTS: Robot[] = [];

export const userName = (id: string) => USERS.find((u) => u.id === id)?.name ?? ROBOTS.find((r) => r.owner === id)?.ownerName ?? '알 수 없음';
/** 담당자 이름(담당 없음이면 그렇게) */
export const ownerName = (r: Robot) => (r.owner ? r.ownerName ?? userName(r.owner) : '담당 없음');

/** 연결 끊김 문구: 끊긴 동안 상태를 단정하지 않고 «마지막 확인 + 미확인»(02 F-COM-02) */
export const lostText = (r: Robot) => `${r.name} 연결이 끊겼습니다. 마지막 확인: ${r.status ? STATUS_NAME[r.status] : '없음'}(${r.seenAt}). 지금 상태는 알 수 없습니다.`;
/** 띠에 올릴 끊김: 한 번이라도 상태를 받은 로봇만(받은 적 없으면 «연결 전» — 끊김 경보가 아님) */
export const lost = (r: Robot) => !r.online && !r.unknown && r.status != null;

/** 상태 표시 하나(03 UX §4): 회색 = 꺼짐, 주황 = 나빠짐, 빨강 = 잠금·끊김 */
export function robotStatus(r: Robot): { tone: Tone; text: string } {
  if (r.unknown === 'summary') return { tone: 'off', text: '확인 안 됨' };
  if (r.unknown === 'wait') return { tone: 'off', text: '상태 확인 중' };
  if (r.unknown) return { tone: 'bad', text: '상태 모름' };
  if (!r.online) return r.status ? { tone: 'bad', text: '끊김' } : { tone: 'off', text: '연결 전' };
  if (!r.status) return { tone: 'off', text: '상태 확인 중' };
  if (r.status === 'STOP_LATCHED' || r.status === 'ERROR') return { tone: 'bad', text: STATUS_NAME[r.status] };
  if (r.battery != null && r.battery < 20) return { tone: 'warn', text: '배터리 낮음' };
  if (r.status === 'PAUSED') return { tone: 'warn', text: STATUS_NAME[r.status] };
  return { tone: r.status === 'IDLE' ? 'off' : 'ok', text: STATUS_NAME[r.status] };
}

/** 총괄은 실기 로봇을 조종·STOP 하지 않는다(10-25 결정 — 실기는 운영자 폰, 서버도 403 ADMIN_NO_REAL_CONTROL). 시뮬 로봇은 총괄도 */
export const ADMIN_REAL = '총괄 계정은 실기 로봇을 조종하지 않습니다.';
export const adminReal = (u: Pick<User, 'role'>, r: Pick<Robot, 'sim'>) => u.role === 'ORG_ADMIN' && !r.sim;
/** 쉬는 시뮬 슬롯: 서버는 끝낸(IDLE) 슬롯을 담당을 비운 채 /robots 에 남긴다(설계). 화면의 로봇(PC·폰 목록, 그래서 STOP 후보도)에서 뺀다. 담당 없는 실기는 그대로(총괄이 봐야 함) */
export const idleSim = (r: Pick<Robot, 'sim' | 'owner'>) => !!r.sim && !r.owner;

/** 조종할 수 없으면 이유(02 기능 §10: 운영자는 남의 로봇 조종 ×, 총괄은 실기 ×). 할 수 있으면 null */
export function driveBlock(u: User, r: Robot): string | null {
  if (adminReal(u, r)) return ADMIN_REAL;
  if (u.role !== 'ORG_ADMIN' && r.owner !== u.id) return `${r.owner ? `${ownerName(r)}님의 로봇입니다` : '담당자가 없는 로봇입니다'}. 내 로봇만 조종할 수 있습니다.`;
  if (r.unknown === 'link') return '서버 연결이 끊겨 조종할 수 없습니다. 네트워크를 확인하세요.';
  if (r.unknown) return '로봇 상태를 확인하는 중입니다. 잠시 뒤 다시 누르세요.';
  if (!r.online) return r.status ? '연결이 끊겨 조종할 수 없습니다. 현장에서 로봇 전원을 확인하세요.' : '로봇이 아직 연결되지 않아 조종할 수 없습니다. 현장에서 로봇 전원을 확인하세요.';
  return null;
}

/** 로봇 목록 범위(ADR-003 결정 2, 확정 10-25): 운영자는 내게 배정된 로봇만(scope=mine), 총괄은 전체(scope=all). 로그인·새로고침·목록 다시 받기 모두 이 값 */
export const listScope = (u: Pick<User, 'role'>): 'mine' | 'all' => (u.role === 'ORG_ADMIN' ? 'all' : 'mine');
/** PC 관제 고르기(02 기능 §1.1): 받은 목록 그대로. 운영자 목록은 서버가 내 로봇만 주지만, 담당이 바뀌는 사이 남은 남의 로봇은 뒤로(보는 중) */
export const robotsFor = (u: User, list = ROBOTS) => (u.role === 'ORG_ADMIN' ? list : [...myRobots(u, list), ...list.filter((r) => r.owner !== u.id)]);
/** 폰·내 로봇 범위(02 기능 §1.2): 운영자는 담당 로봇만, 총괄은 전체(폰 조종 고르기는 App 이 실기를 뺀다 — adminReal) */
export const myRobots = (u: User, list = ROBOTS) => (u.role === 'ORG_ADMIN' ? list : list.filter((r) => r.owner === u.id));
const clock = (at?: string) => (at ? new Date(at).toTimeString().slice(0, 8) : '');   // 13:40:05(브라우저마다 같은 꼴)
/** 시뮬 로봇 화면 이름 «시뮬 로봇 N» — 서버 기본 이름 «시뮬 <id 앞 8자리>»의 16진 id 는 본문에 쓰지 않는다(U5). id = 로봇 id 또는 그 앞 8자리.
 *  N = 아는 시뮬 로봇(목록 ROBOTS + extra) id 순번. ponytail: 서버 요약에 슬롯 번호·월드가 없어 id 순 — 쓴 적 없는 슬롯이 앞이면 폰·PC 번호가 어긋날 수 있다, 서버가 슬롯 번호를 주면 그 값으로 */
export function simName(id: string, extra: string[] = []) {
  const ids = [...new Set([...ROBOTS.filter((r) => r.sim).map((r) => r.id), ...extra])].sort(), i = ids.findIndex((x) => x.startsWith(id.slice(0, 8)));
  return i < 0 ? '시뮬 로봇' : `시뮬 로봇 ${i + 1}`;
}
/** 화면에 쓸 로봇 이름: 기본 이름 그대로인 시뮬 로봇만 simName, 사람이 붙인 이름은 그대로 */
export const robotName = (r: Pick<RobotSummary, 'id' | 'name' | 'simulation'>, sims: string[] = []) => (r.simulation && r.name === `시뮬 ${r.id.slice(0, 8)}` ? simName(r.id, sims) : r.name);
/** 서버 로봇 요약(05 §3) → 화면 값. 층은 이름을 줄 서버 자료가 아직 없어 쓰지 않는다. sims = 같은 목록의 시뮬 로봇 id(번호 매김) */
export const toRobot = (r: RobotSummary, sims: string[] = []): Robot => ({
  id: r.id, name: robotName(r, sims), owner: r.owner?.id ?? '', ownerName: r.owner?.display_name,
  battery: r.battery?.soc ?? null, online: r.connection === 'ONLINE', seenAt: clock(r.location?.updated_at ?? r.battery?.updated_at), status: r.status,
  mission: r.current_run ? `${r.current_run.scenario_name} ${r.current_run.progress.done}/${r.current_run.progress.total}` : undefined,
  holder: r.lease && { type: r.lease.holder_type === 'RUN' ? 'RUN' : 'USER', id: r.lease.user?.id ?? null, name: r.lease.user?.display_name ?? '' },
  listedAt: clock(new Date().toISOString()), location: r.location, devices: r.devices, sim: r.simulation,
  phoneRelay: r.phone_relay ?? null, phoneRelayAt: performance.now(),
  serverDrive: (r as { server_drive?: unknown }).server_drive === true,   // 계약 필드는 SERVER-DRIVE-AGENT 몫 — 그 전엔 없으면 꺼짐
});
export const toRobots = (l: RobotSummary[]) => { const sims = l.filter((r) => r.simulation).map((r) => r.id); return l.map((r) => toRobot(r, sims)); };

/** 로그인 뒤 서버 값으로 바꿔 끼움 */
export function setServerData(me: User, robots: Robot[]) {
  USERS.splice(0, USERS.length, me);
  ROBOTS.splice(0, ROBOTS.length, ...robots);
}
/** 세션이 끝나면(로그아웃·401) 이전 사용자·로봇을 메모리에서 지움 — 다음 사람에게 남지 않게 */
export const clearServerData = () => { USERS.length = 0; ROBOTS.length = 0; };
