// 시뮬 조종 화면 작은 지도(floor-auto 1B — contracts README «연결 건물 정적 지도 관측»): state.pose.floor_context 의 승인 판 + 로봇 위치·방향.
// 층이 바뀌면(map_version_id·floor_rev) 새 판으로 자동 교체. 옛 epoch/floor_rev·다른 로봇·세대·run_id 문맥은 버리고, 문맥이 null 이면 «층을 확인하는 중», 판 응답은 받은 때 문맥과 맞을 때만 그린다.
// transit·unknown·판 오류에서는 위치를 숨긴다(확인 안 된 층을 확정처럼 그리지 않음). 지도는 입력·STOP 경로와 무관 — 그림만.
import { useEffect, useRef, useState } from 'react';
import type { FloorContext, MapVersion, PhoneState, SimRobot, SimWorldFloor } from '../../contracts/ts';
import { api } from './api';
import { aim, floorName, isVersion, shape, toPixel } from './screens/maps';

type Me = Pick<SimRobot, 'robot_id' | 'generation'>;
const mine = (x: FloorContext | null, r: Me): x is FloorContext => !!x && x.robot_id === r.robot_id && x.generation === r.generation;
/** 같은 로봇·세대 안에서 run_id 가 같고 epoch·floor_rev 가 각각 줄지 않는 문맥만(서버 realtime.accept_state·에이전트 telemetry 와 같은 규칙) */
export function newer(c: FloorContext, last: FloorContext | null, r: Me) {
  if (!mine(c, r)) return false;
  return !mine(last, r) || (c.run_id === last.run_id && c.epoch >= last.epoch && c.floor_rev >= last.floor_rev);
}
type Ver = { id: string; v?: MapVersion; bad?: boolean };
export type FloorMap = ReturnType<typeof useFloorMap>;

export function useFloorMap(st: PhoneState | null, r: SimRobot, floors: SimWorldFloor[]) {
  const last = useRef<FloorContext | null>(null), cache = useRef(new Map<string, MapVersion>());
  const fc = st?.pose?.floor_context ?? null;
  if (fc && newer(fc, last.current, r)) last.current = fc;
  // 현재 문맥: 이번 상태에 문맥이 없으면(RESET·만료) 없음. last 는 단조 비교용으로만 남긴다
  const c = fc && mine(last.current, r) ? last.current : null, id = c?.floor_state === 'on_floor' ? c.map_version_id : null;
  const [ver, setVer] = useState<Ver | null>(null), [img, setImg] = useState(''), [again, setAgain] = useState(0), [notice, setNotice] = useState('');
  useEffect(() => {
    if (!id) return;
    const hit = cache.current.get(id);
    if (hit) return setVer({ id, v: hit });
    const stop = new AbortController();
    api.version(id, stop.signal).then(shape(isVersion)).then((v) => {
      if (v.id !== id) throw new Error('other');
      cache.current.set(id, v);
      if (last.current?.map_version_id === id) setVer({ id, v });   // 응답 때 문맥이 이미 바뀌었으면 버림
    }).catch(() => { if (!stop.signal.aborted && last.current?.map_version_id === id) setVer({ id, bad: true }); });
    return () => stop.abort();
  }, [id, again]);
  const name = (x: string | null) => floorName(floors.find((f) => f.map_version_id === x)?.name ?? c?.current_floor_id ?? '');
  // 그릴 판: 확정 층이면 그 판(받았을 때), 아니면 마지막으로 그린 판을 흐리게(위치 없음)
  const sameSha = !!ver?.v && (!c?.sha256 || ver.v.image_sha256 === c.sha256);
  const live = !!id && ver?.id === id && sameSha;
  const shown = useRef<MapVersion | null>(null);
  if (live) shown.current = ver!.v!;
  const v = shown.current, loaded = live && img === id;
  const p = st?.pose, dot = loaded && fc === c && p && p.map_version_id === id && p.x != null && p.y != null && p.yaw != null ? { x: p.x, y: p.y, yaw: p.yaw } : null;
  const label = !c ? '층을 확인하는 중' : c.floor_state === 'transit' ? '층 이동 중' : !id ? '층을 확인하는 중'
    : ver?.id === id && ver.bad ? '지도를 받지 못했습니다' : ver?.id === id && !sameSha ? '지도 판이 맞지 않습니다' : !loaded ? '지도를 불러오는 중' : '';
  // 확정 층 판을 다 그린 뒤 그 판이 바뀌었으면 짧게 알림(첫 판은 알림 없음)
  const prev = useRef('');
  const at = loaded ? id : '';
  useEffect(() => {
    if (!at) return;
    const was = prev.current; prev.current = at;
    if (!was || was === at) return;
    setNotice(`${name(at) || '새 층'} 지도로 바꿨습니다`);
    const t = setTimeout(() => setNotice(''), 4000);
    return () => { clearTimeout(t); setNotice(''); };   // 4 s 안에 다시 이동이 시작돼도 남지 않게
  }, [at]);
  return { v, dot, label, notice, n: again, bad: label === '지도를 받지 못했습니다', floor: live ? name(id) : '', dim: !loaded, ctx: c,
    load: (x: string) => setImg(x), fail: (x: string) => { if (x === id) { cache.current.delete(x); setVer({ id: x, bad: true }); } }, retry: () => { setImg(''); setAgain((n) => n + 1); } };
}

/** 지도 그림 + 위치 점·방향 선 + 층·상태 이름표. big = 영상 칸 전체, 아니면 작은 지도 단추 안 */
export function SimMap({ m, big }: { m: FloorMap; big?: boolean }) {
  const { v, dot } = m, r = v ? Math.max(v.width, v.height) / (big ? 70 : 28) : 0;
  const at = dot && v ? toPixel(v, dot.x, dot.y) : null, tip = dot && v ? aim(v, dot, r) : null;
  return <>
    {v ? <svg className="dv-map" viewBox={`0 0 ${v.width} ${v.height}`} role="img" aria-label={m.label || `${m.floor} 지도`} data-sim-map={v.id} data-dim={m.dim || undefined}>
      <image key={`${v.id}-${m.n}`} href={api.imageUrl(v.id)} width={v.width} height={v.height} style={{ imageRendering: 'pixelated' }} onLoad={() => m.load(v.id)} onError={() => m.fail(v.id)} />
      {at && tip && <g data-sim-dot><line x1={at[0]} y1={at[1]} x2={tip[0]} y2={tip[1]} style={{ stroke: 'var(--accent)' }} strokeWidth={r * 0.6} strokeLinecap="round" />
        <circle cx={at[0]} cy={at[1]} r={r} style={{ fill: 'var(--accent)' }} stroke="#FFFFFF" strokeWidth={r * 0.3} /></g>}
    </svg> : <div className="dv-map" role="img" aria-label={m.label} />}
    {(m.label || m.floor) && <span className="dv-floor" data-sim-floor>{m.label || m.floor}</span>}
    {big && m.bad && <button type="button" className="btn dv-map-again" onClick={m.retry}>다시 불러오기</button>}
  </>;
}
