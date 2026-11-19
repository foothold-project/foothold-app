// 관절 온도 · 배터리 경고 판정 (표시만, 로봇 명령 0). 값의 근거: foothold-lab inbox/jay/20261101-app/APP-ROBOT-DIRECTION-1119.md 5b
// (팀장 11/19 03:14) · 배터리 소모는 GO2X-JETSON-SETUP-1119.md 8 절 (11/19 05:00 27 % → 05:07 21 %, 서 있기만).
// 업체의 열 보호 판정이 아직 오지 않아 화면에 «잠정» 을 붙인다. 문턱을 짐작으로 바꾸지 않는다.
import type { Go2MotorTemps } from '../../contracts/ts';
import type { Tone } from './fake';

/** 50 °C 주의 (표시) · 60 °C 경고 (알림) · 70 °C 또는 reserve ≠ 0 위험 (바로 알림 · 앉기 권고) */
export const TEMP_C = { caution: 50, warn: 60, danger: 70 } as const;
/** 배터리 알림 단계 (막지 않음) */
export const BATTERY_ALERT_PCT = [20, 10] as const;
/** 서 있기만 해도 약 0.7 %/분 (11/19 새벽 실측). 걸으면 더 빠르다 (미측정) */
export const STAND_DRAIN_PCT_PER_MIN = 0.7;

export type Heat = 'ok' | 'caution' | 'warn' | 'danger';
const RANK: Record<Heat, number> = { ok: 0, caution: 1, warn: 2, danger: 3 };
export const HEAT_TONE: Record<Heat, Tone> = { ok: 'ok', caution: 'warn', warn: 'warn', danger: 'bad' };
export const HEAT_TEXT: Record<Heat, string> = { ok: '정상', caution: '주의', warn: '경고 · 지켜보기', danger: '위험 · 앉히기 권고' };

export function jointHeat(c: number, reserve: boolean | null | undefined): Heat {
  if (reserve === true || c >= TEMP_C.danger) return 'danger';
  if (c >= TEMP_C.warn) return 'warn';
  return c >= TEMP_C.caution ? 'caution' : 'ok';
}

export type JointHeat = { name: string; c: number; reserve: boolean | null; heat: Heat };
/** 12 관절 판정과 가장 나쁜 것 (같은 단계면 더 뜨거운 관절) */
export function heatOf(t: Go2MotorTemps): { worst: JointHeat; joints: JointHeat[] } {
  const joints = t.names.map((name, i) => {
    const reserve = t.reserve_nonzero ? t.reserve_nonzero[i] : null;
    return { name, c: t.celsius[i], reserve, heat: jointHeat(t.celsius[i], reserve) };
  });
  const worst = joints.reduce((a, b) => (RANK[b.heat] > RANK[a.heat] || (RANK[b.heat] === RANK[a.heat] && b.c > a.c) ? b : a));
  return { worst, joints };
}

export type Battery = 'ok' | 'low20' | 'low10';
export const batteryLevel = (soc: number): Battery => (soc <= BATTERY_ALERT_PCT[1] ? 'low10' : soc <= BATTERY_ALERT_PCT[0] ? 'low20' : 'ok');
/** 서 있기 기준으로 soc 가 to % 까지 내려가는 분 (내림). 이미 그 아래면 0 */
export const minutesTo = (soc: number, to = 0) => Math.max(0, Math.floor((soc - to) / STAND_DRAIN_PCT_PER_MIN));

/** 화면용 관절 이름: FR_hip_joint → FR hip */
export const jointLabel = (name: string) => name.replace(/_joint$/, '').replace('_', ' ');
