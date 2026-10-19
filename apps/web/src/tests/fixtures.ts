// 화면 시험용 고정 자료(예전 fake.ts 의 로봇 3대·사용자 3명). 앱은 서버 값만 쓰므로 시험이 직접 fake 배열에 넣는다(userName 등이 찾도록).
import { ROBOTS as MEM_ROBOTS, USERS as MEM_USERS, type Robot, type User } from '../fake';
export type { Robot };

export const USERS: User[] = [
  { id: 'u-kim', name: '김OO', role: 'ORG_ADMIN' },
  { id: 'u-lee', name: '이OO', role: 'OPERATOR' },
  { id: 'u-park', name: '박OO', role: 'OPERATOR' },
];

export const ROBOTS: Robot[] = [
  { id: 'r3', name: 'Go2-3', owner: 'u-lee', ownerName: '이OO', battery: 82, online: true, seenAt: '14:05:20', status: 'RUNNING', mission: '2층 순찰 3/5' },
  { id: 'r7', name: 'Go2-7', owner: 'u-park', ownerName: '박OO', battery: 15, online: true, seenAt: '14:05:20', status: 'IDLE' },
  { id: 'r1', name: 'Go2-1', owner: 'u-lee', ownerName: '이OO', battery: null, online: false, seenAt: '13:40:05', status: 'STOP_LATCHED' },
];

MEM_USERS.splice(0, MEM_USERS.length, ...USERS);
MEM_ROBOTS.splice(0, MEM_ROBOTS.length, ...ROBOTS);
