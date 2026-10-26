// 시뮬 외부 카메라 시점 끌기(apps/simmgr/EXTERNAL-CAMERA.md observer/1): 한 손가락 끌기 = yaw·pitch, 두 손가락 벌림 = 거리.
// 보내기는 서버 중계(api.externalView, apps/server/fh_server/EXTERNAL-CAMERA.md)만 — ≤10 Hz·최신 값 하나·진행 중 요청 하나, 손 떼면 cancel. 자동 재시도 루프 없음.
// 성공 200 은 «접수됨»일 뿐이라 화면에 반영·적용됐다고 쓰지 않는다. 실패만 짧은 한 줄.
// 조이스틱·키보드 주행과 따로: 이 파일은 phone.ts(sim.axes·cmd)를 부르지 않고, 그림 위 누름만 받는다(조이스틱은 다른 요소라 그 누름이 여기로 오지 않음).
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { ApiFail, EXT_VIEW_RELAY, api } from './api';
import { media, type Feed } from './media';

export type View = { yaw: number; pitch: number; radius: number };
/** simmgr 공유 기본 시점(yaw π, pitch .45, 3 m) · 보내기 간격(MediaLimits.external_view_max_hz 10, 서버 «세 작업 합계 100ms») · 끌기 1 px 당 각도 — 방향·감도는 실제 시뮬 확인 전(EXTERNAL-CAMERA.md «drag direction») */
export const VIEW0: View = { yaw: Math.PI, pitch: 0.45, radius: 3 }, VIEW_MS = 100, RAD_PER_PX = 0.01;
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
/** 계약 범위(ExternalCameraViewRequest): yaw ±π, pitch ±1.2, radius 0.5–10 m */
export const clampView = (v: View): View => ({ yaw: wrap(v.yaw), pitch: Math.max(-1.2, Math.min(1.2, v.pitch)), radius: Math.max(0.5, Math.min(10, v.radius)) });

/** 서버 오류표 → [안내, 멈춤]. 멈춤 = 이 결속(robot·epoch·episode)에서 끌기를 받지 않음. 제한(SIM_OBSERVER_RATE_LIMIT)은 null — 조용히 버림.
 *  나머지(503·SIM_OBSERVER_UNAVAILABLE·연결 실패)는 안내만 하고 다음 끌기에서 다시 보낸다 */
export function viewFail(e: unknown): [string, boolean] | null {
  const st = e instanceof ApiFail ? e.status : 0, code = e instanceof ApiFail ? e.code : '';
  if (code === 'SIM_OBSERVER_RATE_LIMIT') return null;
  if (st === 401) return ['로그인이 끝나 시점 이동을 멈췄습니다', true];
  if (st === 403) return ['이 로봇의 시점을 옮길 권한이 없어 멈췄습니다', true];
  if (st === 404) return ['이 로봇을 더 볼 수 없어(담당 해제·보관 등) 시점 이동을 멈췄습니다', true];
  if (code === 'UNAVAILABLE') return ['실기에는 외부 카메라 시점 이동이 없습니다', true];
  if (code === 'SIM_OBSERVER_BINDING') return ['담당자·회차가 바뀌어 시점 이동을 멈췄습니다 — 다시 연결하세요', true];
  if (st === 400 || st === 413) return ['시점 요청 형식이 약속과 달라 시점 이동을 멈췄습니다', true];
  return ['시뮬 외부 카메라가 지금 시점 요청을 받지 못합니다 — 다시 끌면 다시 보냅니다', false];
}

type Op = 'view' | 'cancel';
type Send = (op: Op, v: View) => Promise<unknown>;
/** 보내기 줄 하나: 앞 보냄에서 VIEW_MS 지나고 앞 요청이 끝난 뒤에만 다음(그 사이 새 값은 덮어쓰기만).
 *  begin = 새 끌기(멈춤 아닌 안내는 풀림), end = 남은 값을 버리고 cancel(제한되면 VIEW_MS 뒤 한 번 더만), fail = 오류표 안내 */
export function orbit(send: Send, fail: (why: string, stop: boolean) => void, clock = () => performance.now()) {
  let v = VIEW0, last = -Infinity, timer: ReturnType<typeof setTimeout> | undefined, busy = false, want: Op | null = null, again = false, pause = false, halt = false;
  const pump = () => {
    if (busy || timer || !want || halt) return;
    const wait = last + VIEW_MS - clock();
    if (wait > 0) { timer = setTimeout(() => { timer = undefined; pump(); }, wait); return; }
    const op = want; want = null; last = clock(); busy = true;
    send(op, v).then(() => done(op, null), (e) => done(op, e ?? 'fail'));
  };
  const done = (op: Op, e: unknown) => {
    busy = false;
    if (e && !halt) {
      const f = viewFail(e);
      if (!f) { if (op === 'cancel' && !again && !want) { again = true; want = 'cancel'; } }   // 제한: view 는 버리고 다음 값, 손 뗀 뒤 cancel 은 마지막 한 번
      else if (f[1]) { halt = true; want = null; clearTimeout(timer); timer = undefined; fail(...f); }
      else { pause = true; if (want === 'view') want = null; fail(...f); }
    }
    pump();
  };
  return {
    get: () => v,
    begin() { pause = false; },
    set(n: View) { v = clampView(n); if (halt || pause) return; want = 'view'; pump(); },
    end() { if (halt) return; want = 'cancel'; again = false; pump(); },
    /** 결속이 바뀜 — 멈춤을 푼다 */
    revive() { halt = false; pause = false; },
  };
}

/** 시점을 못 옮기는 이유('' = 옮길 수 있음) */
export function viewBlock(ext: Feed, relay = EXT_VIEW_RELAY) {
  if (!relay) return '시점 이동 준비 중 — 서버 시점 중계가 아직 없습니다';
  if (ext.state !== 'live') return '외부 카메라를 받는 중일 때만 시점을 옮길 수 있습니다';
  if (!media.binding()?.episode_id) return '시뮬 회차 정보가 없어 시점을 옮길 수 없습니다';
  return '';
}

/** 그림 칸에 붙일 누름 처리(pad) + 실패 안내 한 줄(note). off 거나 이 결속에서 멈췄으면 아무 처리도 붙이지 않는다(누름이 그냥 지나감) */
export function useOrbit(robot: string, off: boolean) {
  const o = useRef<ReturnType<typeof orbit>>(), pts = useRef(new Map<number, [number, number]>()), base = useRef<{ v: View; x: number; y: number; d: number } | null>(null);
  const bindKey = () => { const b = media.binding(); return b ? `${b.robot} ${b.epoch} ${b.episode_id}` : ''; };
  const [note, setNote] = useState<{ why: string; stop: boolean; key: string } | null>(null), key = bindKey(), stale = !!note && note.key !== key;
  o.current ??= orbit((op, v) => {
    const b = media.binding();
    if (!b?.episode_id) return Promise.resolve();
    return api.externalView(robot, op, { t: 'external.view', version: 'observer/1', robot: b.robot, episode_id: b.episode_id, epoch: b.epoch, seq: 0, yaw: v.yaw, pitch: v.pitch, radius: v.radius });
  }, (why, stop) => setNote({ why, stop, key: bindKey() }));
  useEffect(() => { if (stale) { o.current!.revive(); setNote(null); } }, [stale]);
  off ||= !!note?.stop && !stale;
  const end = () => { pts.current.clear(); if (base.current) { base.current = null; o.current!.end(); } };
  const start = () => {
    const p = [...pts.current.values()], x = p.reduce((s, q) => s + q[0], 0) / p.length, y = p.reduce((s, q) => s + q[1], 0) / p.length;
    base.current = { v: o.current!.get(), x, y, d: p.length > 1 ? Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]) : 0 };
  };
  useEffect(() => {
    const hide = () => { if (document.visibilityState === 'hidden') end(); };
    addEventListener('blur', end); document.addEventListener('visibilitychange', hide);
    return () => { removeEventListener('blur', end); document.removeEventListener('visibilitychange', hide); end(); };
  }, []);
  useEffect(() => { if (off) end(); }, [off]);
  const why = stale ? '' : note?.why ?? '';
  if (off) return { pad: {}, note: why };
  const lift = (e: PointerEvent) => { if (!pts.current.delete(e.pointerId)) return; if (pts.current.size) start(); else end(); };
  return { note: why, pad: {
    onPointerDown(e: PointerEvent) {
      if (pts.current.size >= 2) return;
      try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch { /* 없음 */ }
      if (!pts.current.size) { o.current!.begin(); if (note && !note.stop) setNote(null); }
      pts.current.set(e.pointerId, [e.clientX, e.clientY]); start();
    },
    onPointerMove(e: PointerEvent) {
      const b = base.current; if (!b || !pts.current.has(e.pointerId)) return;
      pts.current.set(e.pointerId, [e.clientX, e.clientY]);
      const p = [...pts.current.values()], x = p.reduce((s, q) => s + q[0], 0) / p.length, y = p.reduce((s, q) => s + q[1], 0) / p.length;
      const d = p.length > 1 ? Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]) : 0;
      o.current!.set({ yaw: b.v.yaw - (x - b.x) * RAD_PER_PX, pitch: b.v.pitch + (y - b.y) * RAD_PER_PX, radius: b.d && d ? b.v.radius * b.d / d : b.v.radius });
    },
    onPointerUp: lift, onPointerCancel: lift, onLostPointerCapture: lift,
  } };
}
