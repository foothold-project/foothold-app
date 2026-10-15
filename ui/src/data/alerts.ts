// R14 경보 읽음(이 기기 localStorage) — 개별 읽음 ≠ 보이는 것 모두 읽음 ≠ 위험 해소.
// 판정은 «읽은 사건 키 집합»만. 시간 기준선으로 새로 읽음 처리하지 않는다(보이지 않던·늦게 온 옛 경보가 읽음이 되면 안 됨).
// 옛 단일 시각(LEGACY)은 이전 판에서 이미 읽음으로 보였던 것이 되살아나지 않게 하는 migration 전용 — 새로 쓰지 않는다.
import type { MediaEvent } from '@contracts';
import { store, tms } from './fmt';

const LEGACY = 'fh.live.alerts.read', ONE = 'fh.live.alerts.read.keys';
// 서버 안정 ID 없음(MediaEvent = t·st·text·at) → 실존 필드 전부로 키(배열 위치는 쓰지 않음)
export const alertKey = (e: MediaEvent) => `${e.at}|${e.t}|${e.st}|${e.text}`;
const keys = () => new Set(store.get<string[]>(ONE, []));
export function isUnread(e: MediaEvent, one = keys(), legacy = store.get<string>(LEGACY, '')) {
  return !one.has(alertKey(e)) && (!legacy || tms(e.at) > tms(legacy));
}
export const unreadOf = (al: MediaEvent[]) => { const one = keys(), lg = store.get<string>(LEGACY, ''); return al.filter((e) => isUnread(e, one, lg)); };
// 표시 대상 배열의 키만 더한다. 보관은 지금 서버 목록(all)에 남은 키만(크기 상한 = 서버 최근 300건).
export function markRead(targets: MediaEvent[], all: MediaEvent[]) {
  const live = new Set(all.map(alertKey)), one = [...keys(), ...targets.map(alertKey)].filter((k) => live.has(k));
  store.set(ONE, [...new Set(one)]);
}
export const READ_NOTE = '읽음 = 이 기기에서 봤다는 표시 · 위험 해소·조치 완료 아님';
