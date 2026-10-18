// 임무 계획 «지형 → 2D 도면 → 위치별 임무»(SPEC mission-flow-2d 59dbad0e · ROOT 경계 fed508f6) — PcPlan 지역 helper·읽기 hook.
// 공용 run.ts(rekey/planMap/startPolicy/startRun/addPlan)·계약·서버는 바꾸지 않고 import 만 한다. 읽기 op 만(map_list·map_get·geom_get).
// 도면 = 참고 그림(GT 래스터 개정은 계획 기준과 대조하지 않음). 로봇 마커·실측 겹치기 0.
import { useEffect, useRef, useState } from 'react';
import type { MapInfo, MapSrc, Mission, Waypoint } from '@contracts';
import { WF, getMap, listMaps, tsOf } from '../data/maps';
import type { Raster } from '../data/maps';
import { getGeom } from '../data/geom';
import type { Geom } from '../data/geom';
import { useLink } from '../data/link';
import { planMap, rekey, wkey } from '../data/run';
import type { Here } from '../data/run';

type Mod = Waypoint['mods'][number];
export type Terr = { w: string; f: string };

// ---- 프리셋(SPEC §1) — 기존 mods 조합일 뿐(새 kind·필드·자동 단계 0). 저장 순서는 LIVE_MODS 순(기존 체크박스와 같음) ----
export const PRESETS: readonly { name: string; mods: readonly Mod[]; sub: string }[] = [
  { name: '지점 확인', mods: ['운영자 확인'], sub: '운영자가 보고 확인·보류·제외 기록' },
  { name: '사진 기록', mods: ['사진'], sub: '운영자가 사진 1장 찍음' },
  { name: '현장 확인 후 대기', mods: ['운영자 확인', '대기'], sub: '확인 뒤 운영자가 지키며 멈춤' },
];
/** mods 집합이 정확히 같은 프리셋만(순서 무관). 아니면 undefined → «기존 조합 · …»(정규화 0) */
export const presetOf = (mods: readonly string[]) => PRESETS.find((p) => p.mods.length === new Set(mods).size && mods.length === p.mods.length && p.mods.every((m) => mods.includes(m)));
export const modsTxt = (mods: readonly string[]) => presetOf(mods)?.name ?? `기존 조합 · ${mods.length ? mods.join('·') : '이동만'}`;

/** 도면(래스터) 범위 안 + 유한 좌표만. clamp 0 */
export const inRaster = (r: Raster, x: number, y: number) => Number.isFinite(x) && Number.isFinite(y)
  && x >= r.ox && x <= r.ox + r.w * r.res && y >= r.oy && y <= r.oy + r.h * r.res;
/** 계획 map 이 이 앱이 아는 지형·층(WF)일 때만 지형 선택으로 씀. 아니면 «목록만» */
export const okT = (m: MapSrc | undefined): m is MapSrc => !!m && !!WF[m.world_id]?.includes(m.floor_id);

export type Geo = { g: Geom; sha: string } | { why: string } | null;   // null = 단층(기하 안 읽음)
export const geoOk = (g: Geo): g is { g: Geom; sha: string } => !!g && 'sha' in g;

/** 첫 점의 map(경계 4): 연결 건물 = 선택 층이 든 검증 기하 g:sha · 단층 = 지금 gtHere 가 같은 world·층의 유효 w: · 그 밖 = rid 키 생략(연관만).
 *  부르는 쪽: 임시 고리 때 후보를 잡고, 확정 때 다시 계산해 같을 때만 rid(나중 응답으로 보충 0 — pinRid) */
export function firstSrc(t: Terr, h: Here, geo: Geo): MapSrc {
  const base: MapSrc = { src: 'gt', world_id: t.w, floor_id: t.f, key: '' };
  if (t.w === 'v5_building') return geoOk(geo) && geo.g.floors.some((x) => x.floor_id === t.f) ? { ...base, rid: `g:${geo.sha}` } : base;
  if (WF[t.w]?.length === 1 && h.map && h.map.world_id === t.w && h.map.floor_id === t.f && /^w:[0-9a-f]{64}$/.test(h.map.rid || '')) return { ...base, rid: h.map.rid };
  return base;
}
/** 고리 때 후보(cand)와 확정 때 값(now)이 같을 때만 rid — 다르면 낮은 쪽(rid 생략). 승격 0 */
export const pinRid = (cand: MapSrc, now: MapSrc): MapSrc => {
  const { rid, ...b } = cand;
  return rid && rid === now.rid ? { ...b, rid } : b;
};

/** 추가·옮기기 전 관문(root ①): rid 있는 계획의 근거가 지금 선택과 맞지 않으면 이유(막음 — 기존 rid 지우기·새 rid 덮기 0). null = 진행 */
export function srcGate(d: Mission, t: Terr, h: Here, geo: Geo): string | null {
  const m = d.map;
  if (!m?.rid) return null;   // map 없음·rid 없는 연관 → keepSrc 가 처리
  if (m.world_id !== t.w || m.floor_id !== t.f) return '계획 지형·층과 선택이 다름';
  if (!planMap(d).map) return '출처 기록 뒤 좌표가 바뀐 계획 — 추가·옮기기 안 됨';
  if (m.rid[0] === 'g') {
    if (!geoOk(geo)) return `기하 파일 확인 안 됨${geo && 'why' in geo ? ` · ${geo.why}` : ''} — «다시 읽기»`;
    if (m.rid !== `g:${geo.sha}` || !geo.g.floors.some((x) => x.floor_id === t.f)) return '계획 기준(기하 파일)과 지금 도면의 기하가 다름';
  } else if (h.map && h.map.world_id === t.w && h.map.floor_id === t.f && h.map.rid && h.map.rid !== m.rid) return '계획 기준(실행 world)과 지금 시뮬 world 가 다름';
  return null;
}

/** 이어 붙이기·순서·삭제·옮기기: rid 있음 = 공용 rekey 그대로 · rid 없는 연관 = 선택과 같은 지형·층이고 수정 전 지문이 맞을 때만 key 갱신(아니면 map 제거) ·
 *  map 없음 = fn 만 · 선택 없음(목록만) = 기존 rekey 그대로 */
export function keepSrc(d: Mission, t: Terr | null, fn: () => void) {
  const m = d.map;
  if (!m) return fn();
  if (m.rid || !t) return rekey(d, fn);
  const ok = m.world_id === t.w && m.floor_id === t.f && m.key === wkey(d.wps);
  fn();
  if (ok) d.map = { ...m, key: wkey(d.wps) }; else delete d.map;
}

// ---- 선택 지형의 도면 읽기(경계 7) ----
export type TerrSt = { k: 'off' } | { k: 'nolink' } | { k: 'loading' } | { k: 'nomap' } | { k: 'fail'; why: string } | { k: 'ok'; ras: Raster; n: number; geo: Geo };
export type TerrDeps = { list: () => Promise<MapInfo[] | string>; get: (m: MapInfo) => Promise<Raster | string>; geom: (b: 'v5') => Promise<{ g: Geom; sha: string } | string> };
export const terrDeps: TerrDeps = { list: listMaps, get: getMap, geom: getGeom };
/** 그 지형·층의 GT 래스터(저장 SLAM 제외). 여럿이면 저장 시각 최신 */
export const gtOf = (ms: MapInfo[], t: Terr) => ms.filter((m) => m.map_source === 'gt_raster' && m.world_id === t.w && m.floor_id === t.f)
  .reduce<MapInfo | null>((a, m) => (!a || tsOf(m.map_version) > tsOf(a.map_version) ? m : a), null);

/** map_list → map_get → (연결 건물) geom_get 을 화면 하나의 슬롯(Promise 체인)에서 순서대로 — A→B→A 에도 이 화면 요청끼리 겹침 0.
 *  세대 키 gen|provider|지형/층|시도 + 요청 순번 n(effect 마다 +1). 결과는 그 순번에만 결속 — 완료된 A 의 옛 결과가 B→A 복귀 때 다시 보이지 않음(715 N1).
 *  늦은 성공·실패는 모두 버림. 자동 재시도 0(retry = 사용자 «다시 읽기»).
 *  목록은 같은 연결에서 재사용(배열일 때만), 기하는 성공만 같은 연결에서 재사용. 기하 실패는 ok 안 geo.why(도면은 보이고 첫 점 rid 생략·명시) */
export function usePlanTerrain(t: Terr | null, deps: TerrDeps = terrDeps): TerrSt & { retry: () => void } {
  const gen = useLink((s) => s.gen), provider = useLink((s) => s.provider), open = useLink((s) => s.open), stOk = useLink((s) => s.stGen === s.gen);
  const [attempt, setAttempt] = useState(0);
  const key = t ? `${gen}|${provider}|${t.w}/${t.f}|${attempt}` : '';
  const [res, setRes] = useState<{ key: string; n: number; v: TerrSt } | null>(null);
  const chain = useRef<Promise<unknown>>(Promise.resolve()), seq = useRef(0);
  const list = useRef<{ c: string; v: MapInfo[] } | null>(null), geom = useRef<{ c: string; v: { g: Geom; sha: string } } | null>(null);
  useEffect(() => {
    if (!t || !open || !stOk) return;
    let gone = false; const n = ++seq.current, conn = `${gen}|${provider}`, tt = t;
    const alive = () => { const s = useLink.getState(); return !gone && s.gen === gen && s.provider === provider; };
    const put = (v: TerrSt) => { if (alive()) setRes({ key, n, v }); };
    chain.current = chain.current.then(async () => {
      if (!alive()) return;
      let ms = list.current?.c === conn ? list.current.v : null;
      if (!ms) { const r = await deps.list(); if (!alive()) return; if (typeof r === 'string') return put({ k: 'fail', why: r }); list.current = { c: conn, v: r }; ms = r; }
      const m = gtOf(ms, tt); if (!m) return put({ k: 'nomap' });
      const ras = await deps.get(m); if (!alive()) return; if (typeof ras === 'string') return put({ k: 'fail', why: ras });
      let geo: Geo = null;
      if (tt.w === 'v5_building') {
        geo = geom.current?.c === conn ? geom.current.v : null;
        if (!geo) { const r = await deps.geom('v5'); if (!alive()) return; if (typeof r === 'string') geo = { why: r }; else { geom.current = { c: conn, v: r }; geo = r; } }
      }
      put({ k: 'ok', ras, n, geo });
    }).catch(() => put({ k: 'fail', why: '도면 읽기 오류' }));
    return () => { gone = true; };
  }, [key, open, stOk]);   // eslint-disable-line react-hooks/exhaustive-deps -- key 가 t·gen·provider·attempt 를 담음
  const retry = () => { list.current = null; setAttempt((a) => a + 1); };
  // seq.current = 마지막으로 시작한 요청 순번(그 effect 전 렌더에서는 직전 요청 순번) — 어느 쪽이든 옛 요청의 res.n 과 다르면 loading
  const v: TerrSt = !t ? { k: 'off' } : !open || !stOk ? { k: 'nolink' } : res && res.key === key && res.n === seq.current ? res.v : { k: 'loading' };
  return { ...v, retry };
}

// ---- R3b 새 임무 만들기(SPEC-CREATE-R3 8299013f · ROOT 결정 cc2755b9) — 종료 방식은 계약 Mission.finish 그대로(기본값·추정 0) ----
export type Finish = NonNullable<Mission['finish']>;
export const FINISH: readonly { v: Finish; sub: string }[] = [
  { v: '출발점 복귀', sub: '진행을 시작한 곳으로 · 직접 조종' },
  { v: '마지막 지점 종료', sub: '마지막 목적지에서 끝' },
];
/** ④ 흐름: 시작 위치 → n 이름 · 할 일 … → 복귀 / 여기서 종료. 이름 비면 «지점 n». 종료 방식 없으면 null(흐름 안 보임) */
export const flowTxt = (wps: readonly Waypoint[], f: Mission['finish']): string[] | null => {
  if (!wps.length || !f) return null;
  const s = wps.map((w, i) => `${i + 1} ${w.name.trim() || `지점 ${i + 1}`} · ${modsTxt(w.mods)}`);
  return ['임무 시작 위치', ...(f === '출발점 복귀' ? [...s, '시작 위치로 복귀'] : [...s.slice(0, -1), `${s[s.length - 1]} · 여기서 종료`])];
};
/** ⑤ 못 누르는 이유 — 맨 앞 빠진 것 하나. ③ 요구는 새 임무(아직 id 없음 · 사본 포함)만 — 원본 id 있는 옛 임무는 키 없음 그대로 저장 */
export const createWhy = (d: Mission, isNew: boolean, terr: boolean) =>
  !d.wps.length ? (terr ? '② 목적지를 하나 이상 찍으세요' : '① 지형을 고르세요')
  : isNew && !d.finish ? '③ 종료 방식을 고르세요'
  : !d.name.trim() ? '이름을 넣으세요' : '';
