// 임시
import type { Robot } from '../fake';
import type { User } from '../fake';
import type { Place } from './maps';
import type { Plan } from './missiontab';
export function MissionPlan(_: { id: string; floor: string; robot: string; gait: string; user: User; robots: Robot[]; cancel?: AbortSignal; places: Place[]; treeAgain: () => void; p: Plan; close: () => void; saved: (id: string) => void; rehearse: () => void }) { return null; }
