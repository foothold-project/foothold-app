// 조직 설정 혼잡 시간(busy_hours) · 중복 점검 기준(dup_inspect_min)을 쓰는 화면(설정 u9_8 · 임무 지도 칩 · 모의 실행 점검 줄)이 함께 쓰는 값과 식.
import { useEffect, useState } from 'react';
import type { BusyHour, OrgSettings } from '../../contracts/ts';
import { api } from './api';

export const DAY_KEYS: BusyHour['day'][] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];   // Date.getDay() 차례
/** 분 → 「4 시간」 · 「4 시간 30 분」 · 「30 분」 */
export const durText = (min: number) => { const h = Math.floor(min / 60), m = min % 60; return h && m ? `${h} 시간 ${m} 분` : h ? `${h} 시간` : `${m} 분`; };
/** 그 날(요일) 혼잡 시간 가운데 start ~ end(HH:MM) 와 겹치는 것 */
export const busyOverlap = (list: BusyHour[], day: BusyHour['day'], start: string, end: string) => list.filter((b) => b.day === day && b.start < end && start < b.end);
export const busyText = (b: BusyHour) => `${b.label} ${b.start}~${b.end}`;
const two = (n: number) => String(n).padStart(2, '0');
export const hmOf = (d: Date) => `${two(d.getHours())}:${two(d.getMinutes())}`;
/** 조직 설정을 한 번 받음(GET /org/settings). 못 받거나 옛 서버면 그 칸이 undefined = 「서버에 값 없음」 */
export function useOrgBusy(cancel?: AbortSignal) {
  const [o, setO] = useState<OrgSettings | null>(null);
  useEffect(() => { let live = true; api.settings(cancel).then((x) => live && setO(x), () => {}); return () => { live = false; }; }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  return { busy: o?.busy_hours, dup: o?.dup_inspect_min };
}
/** 실행한 시각(ISO) 사이에 걸린 혼잡 시간. 같은 날 안만 본다(자정을 넘는 실행은 시작 날 끝까지) */
export function busyDuring(list: BusyHour[], startIso: string, endIso: string | null) {
  const a = new Date(startIso), b = endIso ? new Date(endIso) : a;
  const end = b.toDateString() === a.toDateString() ? hmOf(b) : '24:00';
  return busyOverlap(list, DAY_KEYS[a.getDay()], hmOf(a), end === hmOf(a) ? `${hmOf(a)}:59` : end);
}
