// 보조 관제 뷰(시뮬) — RL VIEW-CONTRACT §1·§2 를 link 가 검증해 최신 1개만 들고 있고, 여기서 view_get 으로 끌어온다(≤2 Hz, 한 번에 하나).
// 점군 누적: 결속 키(world·건물·층·모드·출처·버전·epoch) + 연결/대상 세대가 같을 때만 0.1 m 칸 하나에 점 하나, 상한 30만(넘으면 오래된 칸부터 버림).
// 키·세대가 바뀌거나 지도 상태가 ok 아니면 비우고 쌓지 않는다. SLAM 3D 지도가 아니라 측정점 누적 시각화다(루프 폐합 0).
import { useEffect, useState } from 'react';
import { ask, useLink } from './link';

export const VOX = 0.1, CAP = 300_000, POLL_MS = 500, MAX_ABS = 3000, SRC_AGE = 3;   // MAX_ABS: vkey 는 ±3276.7 m 까지 충돌 없음 → 그보다 작게 고정, 넘는 점이 하나라도 있으면 그 메시지 거부
const KEYS = ['world_id', 'building_id', 'floor_id', 'mode', 'map_source', 'map_version', 'epoch'] as const;
export type Pose = { x: number; y: number; z: number; yaw: number };
type Snap = ReturnType<typeof useLink.getState>;
const keyOf = (o: any) => KEYS.map((k) => JSON.stringify(o?.[k] ?? null)).join('|');

/** 지금 이 뷰를 보이거나 쌓아도 되나 → 결속 문자열(지도 키 + 연결/대상 세대) | ''(안 됨).
 *  시뮬 대상 · WS 열림 · 마지막 메시지 ≤1 s(linkOk 와 같음) · live_map ok · 그 뷰 st ok·age ≤3 s·seq 정수 — 하나라도 아니면 '' */
export function viewKey(s: Snap, what: 'points' | 'follow', now = performance.now()): string {
  const st: any = s.st, lm = st?.live_map, src = st?.views?.[what];
  if (s.provider !== 'simulation_gate' || !s.open || !s.lastMsg || now - s.lastMsg > 1000) return '';
  if (!lm || lm.st !== 'ok' || !src || src.st !== 'ok' || !(Number.isFinite(src.age_s) && src.age_s >= 0 && src.age_s <= SRC_AGE) || !(Number.isInteger(src.seq) && src.seq > 0)) return '';
  return `${keyOf(lm)}#${s.gen}`;
}
const sameKey = (v: any, bind: string) => !!bind && `${keyOf(v)}#${bind.split('#').pop()}` === bind;

/** 누적 저장소(전역 하나 — 여러 칸이 같은 것을 그린다). bind 가 지금 viewKey 와 다르면 그리지 않는다 */
export const CLOUD = {
  xyz: new Float32Array(CAP * 3), keys: new Float64Array(CAP), n: 0, head: 0, idx: new Map<number, number>(),
  bind: '', seq: -1, stamp: -Infinity, pose: null as Pose | null, ver: 0,
};
export function clearCloud() {
  const c = CLOUD; if (!c.n && !c.bind && !c.pose) return;
  c.idx.clear(); c.n = c.head = 0; c.seq = -1; c.stamp = -Infinity; c.pose = null; c.bind = ''; c.ver++;
}
// 0.1 m 정수 칸 → 한 숫자(각 축 16비트, 48비트 < 2^53 — |좌표| ≤ MAX_ABS 일 때 정확·충돌 0)
const vkey = (x: number, y: number, z: number) => ((Math.round(x / VOX) + 32768) * 65536 + (Math.round(y / VOX) + 32768)) * 65536 + (Math.round(z / VOX) + 32768);

/** view_get 응답 v 를 결속 bind(요청 때·응답 때 둘 다 viewKey 와 같아야 — 호출자가 확인) 아래 누적. 반환 = 쌓았나(거부면 아무것도 안 바꿈, 키 바뀜이면 비움) */
export function addCloud(v: any, bind: string): boolean {
  const c = CLOUD;
  if (!v || !sameKey(v, bind)) { clearCloud(); return false; }
  if (bind !== c.bind) { clearCloud(); c.bind = bind; }
  const n = v.n, p = v.base_pose_map;
  if (!(Number.isInteger(v.seq) && v.seq > c.seq && Number.isFinite(v.stamp_sim) && v.stamp_sim >= c.stamp)) return false;   // 옛것·중복
  if (!Number.isInteger(n) || n < 1 || n > 4000 || typeof v.xyz !== 'string' || v.xyz.length !== Math.ceil(n * 12 / 3) * 4) return false;
  if (!p || ![p.x, p.y, p.z, p.yaw].every((a) => typeof a === 'number' && Number.isFinite(a)) || ![p.x, p.y, p.z].every((a) => Math.abs(a) <= MAX_ABS)) return false;
  let raw: Uint8Array;
  try { raw = Uint8Array.from(atob(v.xyz), (ch) => ch.charCodeAt(0)); } catch { return false; }
  if (raw.length !== n * 12) return false;
  const f = new Float32Array(raw.buffer);                     // 리틀 엔디언(웹 플랫폼 전부) = 계약 xyz_f32le
  for (let i = 0; i < f.length; i++) if (!Number.isFinite(f[i]) || Math.abs(f[i]) > MAX_ABS) return false;
  for (let i = 0; i < n; i++) {
    const x = f[i * 3], y = f[i * 3 + 1], z = f[i * 3 + 2], k = vkey(x, y, z);
    if (c.idx.has(k)) continue;
    const s = c.head;
    if (c.n === CAP) c.idx.delete(c.keys[s]); else c.n++;   // 가득 차면 가장 오래된 칸 자리를 씀(FIFO)
    c.xyz[s * 3] = x; c.xyz[s * 3 + 1] = y; c.xyz[s * 3 + 2] = z; c.keys[s] = k; c.idx.set(k, s); c.head = (s + 1) % CAP;
  }
  c.seq = v.seq; c.stamp = v.stamp_sim; c.pose = { x: p.x, y: p.y, z: p.z, yaw: p.yaw }; c.ver++;
  return true;
}

/** 3인칭 JPEG 응답 검사(키·seq·base64·JPEG 머리) → 보일 dict | null. 그림 해독은 호출자가 */
export function followOf(v: any, bind: string, reqSeq: number): { seq: number; url: string; bind: string } | null {
  if (!v || !sameKey(v, bind) || !Number.isInteger(v.seq) || v.seq < reqSeq || !Number.isFinite(v.stamp_sim) || typeof v.jpeg !== 'string' || v.jpeg.length > 600_000 || !v.jpeg.startsWith('/9j/')) return null;
  return { seq: v.seq, url: `data:image/jpeg;base64,${v.jpeg}`, bind };
}

/** 한 종류를 viewKey 가 유효하고 seq 가 바뀔 때만 끌어옴(한 번에 하나). 무효가 되는 즉시 누적·마지막 3인칭 버림.
 *  on=false(실기·화면 떠남) 면 아무것도 안 보내고 비움. 반환 = 3인칭 {seq,url,bind} | null (점군은 CLOUD) */
export function usePull(what: 'points' | 'follow', on: boolean) {
  const [last, setLast] = useState<ReturnType<typeof followOf>>(null);
  useEffect(() => {
    setLast(null); if (what === 'points') clearCloud();
    if (!on) return;
    let busy = false, alive = true, lastSeq = -1;
    const t = setInterval(async () => {
      const s = useLink.getState(), b0 = viewKey(s, what), src = (s.st as any)?.views?.[what];
      if (!b0) { if (what === 'points') clearCloud(); else setLast(null); return; }
      const have = what === 'points' ? (CLOUD.bind === b0 ? CLOUD.seq : -1) : -1;
      if (busy || src.seq === have || (what === 'follow' && src.seq === lastSeq)) return;
      busy = true; const req = src.seq;
      const r = await ask('view_get', { what }, 3000); busy = false;
      const b1 = viewKey(useLink.getState(), what);
      if (!alive || !r.ok || b1 !== b0) return;                  // 요청 뒤 결속이 바뀜(끊김·대상·epoch) → 버림
      const v = (r as any).view;
      if (what === 'points') { addCloud(v, b0); return; }
      const f = followOf(v, b0, req); if (!f) return;
      try { (await createImageBitmap(new Blob([Uint8Array.from(atob(v.jpeg), (ch) => ch.charCodeAt(0))], { type: 'image/jpeg' }))).close(); } catch { return; }   // 해독 안 되는 JPEG 는 안 보임
      if (alive && viewKey(useLink.getState(), what) === b0) { lastSeq = f.seq; setLast(f); }
    }, POLL_MS);
    return () => { alive = false; clearInterval(t); if (what === 'points') clearCloud(); };
  }, [what, on]);
  return last;
}

// ── 빈칸 이유(사실만 — 센서 고장·출력 보장 단정 0, 자동 기동·옵션 변경 0). 순서: 실행 상태(미확인·꺼짐·평지·시작 중) → 외부카메라 켬/끔 → 지도 상태 → 발행 쪽(producer) 자기 진단 → link 수신 검사
const PROD_KO: Record<string, string> = {
  no_cloud: '라이다 점군 아직 안 옴 — 계속되면 기록 확인', no_frame: '렌더 영상 아직 안 옴 — 계속되면 기록 확인', reset: '리셋 중',
  stale_epoch: '이전 회차 것이라 버림', not_localized: '위치 결속 미확인 — 기록 확인',
  tf_stale: '좌표 변환(TF)이 늦음 — 계속되면 기록 확인', tf_lookup_failed: '좌표 변환(TF) 실패 — 계속되면 기록 확인',
  sim_t_unknown: '발행 쪽이 시뮬 시각을 못 읽음 — 계속되면 기록 확인', no_stamp: '영상 시각 없음 — 계속되면 기록 확인',
  future_stamp: '시각이 시뮬보다 앞서 버림 — 계속되면 기록 확인', out_of_order: '순서 뒤바뀐 영상 버림 — 계속되면 기록 확인',
  empty: '유효한 점 0 — 계속되면 기록 확인', bad_cloud: '점군 형식 틀림 — 기록 확인', bad_image: '영상 형식 틀림 — 기록 확인',
  too_large: '영상이 크기 상한 넘음 — 기록 확인', encode_error: '점군 압축 실패 — 기록 확인', unknown: '발행 쪽 이유 코드 모름 — 기록 확인',
};
const NEXT = '«지도 열기»에서 지도 시뮬(라이다 포함) 선택';
/** 보조 뷰(points·follow) 빈칸 문구. st = link status. 영상이 지금 보이면 호출하지 않는다 */
export function viewWhy(st: any, what: 'points' | 'follow'): string {
  const ss = st?.map_start?.session, lv = st?.live_map, v = st?.views?.[what], p = v?.prod, r = ss?.result, run = ss?.runner;
  const fc = what === 'follow' ? ' · «외부카메라» 체크' : '';
  if (!['idle', 'starting', 'running'].includes(r)) return '시뮬 실행 상태 미확인 — 메뉴의 상태 원값 확인';
  if (r === 'idle') return `시뮬 꺼짐 — ${NEXT}${fc}`;
  if (run === 'ux_flat' || run === 'live_v2') return `평지 시뮬에는 이 센서가 없음 — ${NEXT}${fc}`;
  if (run !== 'live_map') return '실행 중인 시뮬 종류 미확인 — 메뉴의 상태 원값 확인';
  if (r === 'starting') return '지도 시뮬 시작 중';
  if (what === 'follow' && p?.enabled === false) return '이번 지도 시뮬은 외부카메라 끔 — 다음 «지도 열기»에서 «외부카메라» 체크';
  if (!lv || lv.st !== 'ok') return `지도 상태 기다림${lv?.why ? ` — ${lv.why}` : ''}`;
  if (p?.reason === 'not_localized' && lv.mode === 'static' && lv.map_source === 'slam') return '저장 SLAM 지도는 위치추정 미연결 — 점군 위치 표시 불가';
  if (p?.reason && p.reason !== 'ok') return `${PROD_KO[p.reason] ?? PROD_KO.unknown}${p.n_pub === 0 ? ' (이번 기동 발행 0)' : ''}`;
  return v?.why ? `받는 쪽 검사: ${v.why}` : '받은 것 없음';
}
