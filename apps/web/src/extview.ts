// 시뮬 외부 카메라 시점 끌기(apps/simmgr/EXTERNAL-CAMERA.md observer/1): 한 손가락 끌기 = yaw·pitch, 두 손가락 벌림 = 거리.
// 보내기는 서버 중계(api.externalView)만 — ≤10 Hz·최신 값 하나, 손 떼면 cancel. 중계가 없으면 끌기 자체를 받지 않는다(이유는 화면).
// 조이스틱·키보드 주행과 따로: 이 파일은 phone.ts(sim.axes·cmd)를 부르지 않고, 그림 위 누름만 받는다(조이스틱은 다른 요소라 그 누름이 여기로 오지 않음).
import { useEffect, useRef, type PointerEvent } from 'react';
import { EXT_VIEW_RELAY, api } from './api';
import { media, type Feed } from './media';

export type View = { yaw: number; pitch: number; radius: number };
/** simmgr 공유 기본 시점(yaw π, pitch .45, 3 m) · 보내기 간격(MediaLimits.external_view_max_hz 10) · 끌기 1 px 당 각도 — 방향·감도는 실제 시뮬 확인 전(EXTERNAL-CAMERA.md «drag direction») */
export const VIEW0: View = { yaw: Math.PI, pitch: 0.45, radius: 3 }, VIEW_MS = 100, RAD_PER_PX = 0.01;
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
/** 계약 범위(ExternalCameraViewRequest): yaw ±π, pitch ±1.2, radius 0.5–10 m */
export const clampView = (v: View): View => ({ yaw: wrap(v.yaw), pitch: Math.max(-1.2, Math.min(1.2, v.pitch)), radius: Math.max(0.5, Math.min(10, v.radius)) });

type Send = (op: 'view' | 'cancel', v: View) => void;
/** 첫 값은 바로, 그 뒤로는 앞 보냄에서 VIEW_MS 지나 최신 값 하나. end = 남은 값을 버리고 cancel */
export function orbit(send: Send, clock = () => performance.now()) {
  let v = VIEW0, last = -Infinity, timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => { timer = undefined; last = clock(); send('view', v); };
  return {
    get: () => v,
    set(n: View) {
      v = clampView(n);
      if (timer) return;
      const wait = last + VIEW_MS - clock();
      if (wait <= 0) flush(); else timer = setTimeout(flush, wait);
    },
    end() { clearTimeout(timer); timer = undefined; send('cancel', v); },
  };
}

/** 시점을 못 옮기는 이유('' = 옮길 수 있음) */
export function viewBlock(ext: Feed, relay = EXT_VIEW_RELAY) {
  if (!relay) return '시점 이동 준비 중 — 서버 시점 중계가 아직 없습니다';
  if (ext.state !== 'live') return '외부 카메라를 받는 중일 때만 시점을 옮길 수 있습니다';
  if (!media.binding()?.episode_id) return '시뮬 회차 정보가 없어 시점을 옮길 수 없습니다';
  return '';
}

/** 그림 칸에 붙일 누름 처리. off 면 아무 처리도 붙이지 않는다(누름이 그냥 지나감) */
export function useOrbit(robot: string, off: boolean) {
  const o = useRef<ReturnType<typeof orbit>>(), pts = useRef(new Map<number, [number, number]>()), base = useRef<{ v: View; x: number; y: number; d: number } | null>(null);
  // ponytail: 중계 실패(409 등)는 버림 — 서버 중계가 생기면 안내 줄을 붙인다
  o.current ??= orbit((op, v) => { const b = media.binding(); if (b?.episode_id) api.externalView(robot, op, { epoch: b.epoch, episode_id: b.episode_id, ...v }).catch(() => {}); });
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
  if (off) return {};
  const lift = (e: PointerEvent) => { if (!pts.current.delete(e.pointerId)) return; if (pts.current.size) start(); else end(); };
  return {
    onPointerDown(e: PointerEvent) {
      if (pts.current.size >= 2) return;
      try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch { /* 없음 */ }
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
  };
}
