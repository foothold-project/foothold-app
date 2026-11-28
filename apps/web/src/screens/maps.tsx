// 지도 탭(01 MP-01·02·04·06, 02 F-MP-01·02·04, 03 §5.6, 05 §5 — S3a /sites·/map-versions·/uploads)과 관제 지도 칸의 층 고르기(FL-03).
// 나무·판·그림·요소는 서버 값 그대로 그린다. 편집 도구는 screens/mapedit.tsx(W4b), 판 비교·되돌리기는 screens/mapdiff.tsx(W4c), 로봇 점은 위치-판 묶기(D5) 뒤.
// 편집 저장·되돌리기·올리기는 누구나 바로 새 승인 판(10-27 결재 없음). 옛 PENDING 판은 «저장 기록»에 «적용 안 됨»으로 보인다. 화면 글에는 «판»을 쓰지 않는다(11-04 — 저장 시각·만든 사람으로 부름).
// 큰 그림은 <image> 가 쿠키로 따로 받는다 — 불러오기·실패는 이 칸 안 글로만, 머리줄·STOP 은 경계(App Guard) 밖.
import { Map3D, modelOf } from './map3d';
import { Empty } from '../empty';
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { MapBuilding, MapFeatures, MapFloor, MapSite, MapUpload, MapVersion, MapZone, Scenario, SiteTree } from '../../../contracts/ts';
import { ApiFail, api } from '../api';
import type { Robot, Tone, User } from '../fake';
import { FactoryImage, MapFrame, MapImage, around, useWalls, type Box } from '../mapframe';
import { leaving } from '../menu';
import { Chip, inApp, type Ctx, type Dash } from '../screens';
import { Compare, Rollback } from './mapdiff';
import { History } from './u7/history';
import { Editor, Glyph, featKeys, featName, featSub, kept } from './mapedit';
import { Hint, Locked, Menu, Pane, Pop, SideTitle, shut } from './mapscen';
import { MissionAdmin, ScenList, ScenarioEdit, SimOpen, keptPlan, useScenarios } from './missions';
import { simAt, twinOf } from '../simstart';
import { TrashLink, trashFail, type TrashKind } from './trash';
import { TerrainLink, VoxelUpload, VoxelView, voxelOf } from './voxelmap';
import { makers } from './mapmake';
import { ScanScreen } from './u7/scan';
import { UploadScreen } from './u7/upload';
import { SlamSavedView } from './slammap';

export type Place = { site: MapSite; building: MapBuilding; floor: MapFloor };
/** 시뮬 층 이름이 ROS 층 ID 그대로(서버가 floor_name 없이 넣은 창고 «f1» 등)면 사람이 읽는 이름으로 */
const FLOOR = new Map([['l1', '1층'], ['l2', '2층'], ['f1', '1층']]);   // Map — «__proto__»·«constructor» 같은 상속 키는 이름 그대로(검토 PR #85 B1)
export const floorName = (n: string) => FLOOR.get(n) ?? n;
const named = (t: SiteTree): SiteTree => ({ ...t, items: t.items.map((s) => ({ ...s, buildings: s.buildings.map((b) => ({ ...b,
  floors: b.floors.map((f) => (f.provenance === 'SIMULATION' ? { ...f, name: floorName(f.name) } : f)) })) })) });
/** 장소 쓰임(SIM-REAL-SPLIT 11-09): 지도 탭 = REAL(실기 SLAM 지도), 시뮬 탭 = SIM. 서버가 purpose 를 아직 안 주면 SIM — 이관 뒤 옛 장소는 모두 SIM */
export type Purpose = 'SIM' | 'REAL';
export const purposeOf = (s: MapSite): Purpose => ((s as { purpose?: string }).purpose === 'REAL' ? 'REAL' : 'SIM');
/** 데모 현장(11-28): SIM 현장에 데모 로봇이 배정돼 있으면 서버가 sites[].demo = true. 값이 아직 없으면 false. 로봇 위치나 이름으로 가리지 않는다 */
export const demoOf = (s: MapSite) => (s as { demo?: boolean }).demo === true;
/** 지도 탭에 보이는 현장 = purpose REAL 이거나 데모 현장. 다른 SIM 현장은 시뮬 탭에만 */
export const inMapTab = (s: MapSite) => purposeOf(s) === 'REAL' || demoOf(s);
/** 지도 탭에 보일 현장: 실기(REAL)는 그대로, 시뮬 현장은 site.demo 일 때만이고 그 안에서도 building.demo === true 인 건물만.
 *  서버가 건물 칸(demo)을 아직 주지 않으면(그 현장 어느 건물에도 boolean 이 없으면) 현장 기준으로 다 둔다 */
export const mapTabSite = (s: MapSite): MapSite | null => {
  if (purposeOf(s) === 'REAL') return s;
  if (!demoOf(s)) return null;
  const has = s.buildings.some((b) => typeof (b as { demo?: unknown }).demo === 'boolean');
  if (!has) return s;
  const bs = s.buildings.filter((b) => (b as { demo?: boolean }).demo === true);
  return bs.length ? { ...s, buildings: bs } : null;
};
/** 지도 탭 데모 판(시안 공장 그림을 깐다): 데모 SIM 현장 안의 데모 건물(mapTabSite 와 같은 규칙). 실제 현장(REAL)은 서버 판 그대로 */
export const demoBoard = (s: MapSite, b: MapBuilding) => purposeOf(s) !== 'REAL' && !!mapTabSite(s)?.buildings.some((x) => x.id === b.id);
/** 시뮬 탭 «짝 없는 층»(SIM-PAIR 11-09): 지도가 없거나 시뮬 세계·지형과 이어지지 않은 층(simAt 실패). v = 승인 판(못 받았으면 undefined → 모름 = false) */
const lone = (f: MapFloor, v?: MapVersion) => !f.approved_version_id || (!!v && typeof simAt(f, v) === 'string');
/** 짝 없는 층 안내 — 시뮬 지도는 지도 탭 «지형 만들기» 저장으로만 만든다(11-19 입구를 지도 탭으로) */
const LONE = <p className="fh-msg" role="status" data-lone>지형이 없는 층입니다 — 삭제하거나 지도 탭의 <a href="#/terrain" style={{ color: 'inherit', fontWeight: 700 }}>«지형 만들기»</a>로 다시 만드세요.</p>;
/** 어디서 도는지(RB-SCEN-SIMTAB 11-11) — 서버 값만: 장소 종류(purpose) + 승인 판 voxel_map(3D 지도 파일로 만든 실기 지도 = 시뮬 지형 있음). 판을 아직 못 받았으면 null(표시 안 함) */
export type Run = 'both' | 'real' | 'sim';
export const RUN: Record<Run, string> = { both: '실기·시뮬', real: '실기만', sim: '시뮬만' };
export const runOf = (p?: Place, vers: Record<string, MapVersion> = {}): Run | null => { const id = p?.floor.approved_version_id;
  return !p ? null : purposeOf(p.site) === 'SIM' ? 'sim' : !id ? 'real' : !vers[id] ? null : twinOf(vers[id]) ? 'both' : 'real'; };
/** 시나리오 = 그 층들로(시뮬은 한 층만 돈다 — 여러 층 실기 시나리오는 «실기만»). 실기·시뮬 장소를 섞은 시나리오는 서버가 막는다(SCENARIO_MIXED_PURPOSE) */
const scenRun = (x: Scenario, places: Place[], vers: Record<string, MapVersion>): Run | null => {
  const l = x.floor_ids.map((id) => runOf(places.find((p) => p.floor.id === id), vers));
  return !l.length || l.includes(null) ? null : l.includes('sim') ? 'sim' : l.length === 1 && l[0] === 'both' ? 'both' : 'real';
};
export const floorsOf = (t: SiteTree | null): Place[] => (t ? t.items.flatMap((site) => site.buildings.flatMap((building) => building.floors.map((floor) => ({ site, building, floor })))) : []);

// 받은 값 모양 검사 — 어긋난 응답이 화면을 깨뜨리지 않게 오류 한 줄로만(screens/history.tsx 와 같은 방식)
const str = (v: unknown) => typeof v === 'string', num = (v: unknown) => typeof v === 'number' && Number.isFinite(v), arr = Array.isArray;
const isTree = (t: SiteTree) => !!t && arr(t.items) && t.items.every((s) => !!s && str(s.id) && str(s.name) && arr(s.buildings)
  && s.buildings.every((b) => !!b && str(b.id) && str(b.name) && arr(b.floors) && b.floors.every((f) => !!f && str(f.id) && str(f.name) && (f.approved_version_id === null || str(f.approved_version_id)))));
const isPoint = (p: { x: unknown; y: unknown }) => !!p && num(p.x) && num(p.y);
export const isVersion = (v: MapVersion) => !!v && str(v.id) && Number.isInteger(v.number) && num(v.width) && v.width > 0 && num(v.height) && v.height > 0
  && num(v.resolution) && v.resolution > 0 && arr(v.origin) && v.origin.length === 3 && v.origin.every(num) && !!v.features
  && arr(v.features.zones) && v.features.zones.every((z) => !!z && arr(z.polygon) && z.polygon.every((p) => arr(p) && num(p[0]) && num(p[1])))
  && arr(v.features.waypoints) && v.features.waypoints.every(isPoint) && arr(v.features.connectors) && v.features.connectors.every(isPoint)
  && arr(v.features.edits) && v.features.edits.every((e) => !!e && num(e.width) && arr(e.polyline) && e.polyline.every((p) => arr(p) && num(p[0]) && num(p[1])));
const isUpload = (u: MapUpload) => !!u && str(u.upload_id);
export const shape = <T,>(ok: (x: T) => boolean) => (x: T) => { if (!ok(x)) throw new ApiFail(0, 'BAD_SHAPE', '받은 지도 형식이 맞지 않습니다. 잠시 뒤 다시 시도하세요.'); return x; };

/** 지도 좌표(m) → 그림 픽셀. ROS 지도는 origin 이 그림 왼쪽 아래 칸의 위치·방향이고 그림 행은 위에서 아래라 y 를 뒤집는다.
 *  회전은 서버 검사(maps.validate_features)와 같다 */
export function toPixel(v: Pick<MapVersion, 'origin' | 'resolution' | 'height'>, x: number, y: number): [number, number] {
  const [ox, oy, yaw] = v.origin, dx = x - ox, dy = y - oy, c = Math.cos(yaw), s = Math.sin(yaw);
  return [(c * dx + s * dy) / v.resolution, v.height - (-s * dx + c * dy) / v.resolution];
}
/** 판 a 그림 픽셀 → 판 b 그림 픽셀(지도 좌표를 거쳐, toPixel 의 역 + toPixel). svg matrix(a b c d e f) */
export function pixelTo(a: Pick<MapVersion, 'origin' | 'resolution' | 'height'>, b: Pick<MapVersion, 'origin' | 'resolution' | 'height'>) {
  const [ox, oy, yaw] = a.origin, c = Math.cos(yaw), s = Math.sin(yaw);
  const at = (px: number, py: number) => { const u = px * a.resolution, w = (a.height - py) * a.resolution; return toPixel(b, ox + c * u - s * w, oy + s * u + c * w); };
  const [e, f] = at(0, 0), [x1, y1] = at(1, 0), [x2, y2] = at(0, 1);
  return [x1 - e, y1 - f, x2 - e, y2 - f, e, f] as const;
}

/** 구역 종류는 테두리로(접근 금지 = 굵은 실선, 감속 = 둥근 점선)와 이름표로 가른다 — 색에만 기대지 않게 */
/** 구역 종류 표. AREA = 서버 시드로만 만드는 이름 구역(움직임 표시 · 선 강조 없음, 그리기 도구에 없음). 계약 타입에 AREA 가 들어오기 전에도 받게 넓혀 둔다 */
type ZoneLine = { strokeWidth: number; strokeDasharray?: string; strokeLinecap?: 'round' };
export const ZONE: Record<MapZone['type'] | 'AREA', { text: string; line: ZoneLine }> = { NO_GO: { text: '접근 금지', line: { strokeWidth: 3.5 } }, SLOW: { text: '감속', line: { strokeWidth: 2.5, strokeDasharray: '1 5', strokeLinecap: 'round' } },
  AREA: { text: '', line: { strokeWidth: 1 } } };
/** 구역 채우기색 — 기존 토큰을 구역 순서대로 돌려 쓰는 화면 표시값(저장 안 함). 지도 그림은 테마 색(mapframe MapImage)이라 두 테마 바탕 모두에서 보이는 토큰만 */
const FILL = ['var(--accent)', 'var(--warn)', 'var(--bad)', 'var(--ink-3)'];
export const fillOf = (i: number) => FILL[i % FILL.length];
export const KIND = { STAIRS: '계단', ELEVATOR: '엘리베이터' } as const;
export const EDIT = { ERASE: { text: '지우개', color: 'var(--muted)' }, WALL: { text: '벽', color: 'var(--ink-3)' } } as const;   // 지도 그림은 테마 색 바탕(빈 곳 --panel·벽 --text)이라 두 테마 모두 중간 회색인 토큰
/** 바꾼·되돌리는 이유 검사 — 서버(MapVersionCreate·MapRollback reason)와 같게: 보이는 글자 하나 이상, 제어·서식 문자(Cc·Cf: 탭·폭 없는 공백·이모지 잇개 등) 없음.
 *  what = «바꾼 이유» 처럼 칸 이름. 통과면 null */
export const reasonBad = (s: string, what: string) => (!s.replace(/[\p{Cc}\p{Cf}\s]/gu, '') ? `${what}를 입력하세요.`
  : /[\p{Cc}\p{Cf}]/u.test(s) ? `${what}에 탭 같은 보이지 않는 글자는 쓸 수 없습니다(이모지 일부도 이런 글자를 품습니다). 지우고 다시 입력하세요.` : null);

/** 방향 선 끝(그림 픽셀) — 점 크기 r 의 2.2배 길이로 yaw 쪽 */
export const aim = (v: Pick<MapVersion, 'origin' | 'resolution' | 'height'>, w: { x: number; y: number; yaw: number }, r: number) =>
  toPixel(v, w.x + Math.cos(w.yaw) * r * 2.2 * v.resolution, w.y + Math.sin(w.yaw) * r * 2.2 * v.resolution);

const SEL = { stroke: 'var(--accent)', strokeWidth: 4 }, BAD = { stroke: 'var(--bad)', strokeWidth: 4, strokeDasharray: '6 4' };

/** 요소 그리기(보기·편집 같이). 선 굵기는 지도 m 그대로(그림 픽셀), 지점은 방향 선 하나.
 *  data-key = «무리.번호»(편집에서 고르기), sel = 고른 요소, bad = 검사에 걸린 요소, red = 접근 금지 구역을 위험 색 줄로(시나리오 편집 — 감속 구역은 그대로) */
export function Shapes({ v, f, sel, bad, red }: { v: Pick<MapVersion, 'origin' | 'resolution' | 'height' | 'width'>; f: MapFeatures; sel?: string; bad?: string; red?: boolean }) {
  const p = (x: number, y: number) => toPixel(v, x, y), r = Math.max(v.width, v.height) / 100;
  const mark = (k: string): { stroke?: string; strokeWidth?: number; strokeDasharray?: string } => (k === bad ? BAD : k === sel ? SEL : {});
  return <>
    {f.edits.map((e, i) => <polyline key={`e${i}`} data-key={`edits.${i}`} data-edit={e.op} points={e.polyline.map(([x, y]) => p(x, y).join(',')).join(' ')}
      style={{ fill: 'none', stroke: EDIT[e.op]?.color, strokeWidth: e.width / v.resolution, strokeLinecap: 'round', strokeLinejoin: 'round', opacity: 0.85, ...(mark(`edits.${i}`).stroke && { stroke: mark(`edits.${i}`).stroke, strokeDasharray: mark(`edits.${i}`).strokeDasharray }) }}><title>{`${EDIT[e.op]?.text ?? ''} 선`}</title></polyline>)}
    {f.zones.map((z, i) => <polygon key={`z${i}`} data-key={`zones.${i}`} data-zone={z.type} points={z.polygon.map(([x, y]) => p(x, y).join(',')).join(' ')}
      style={{ fill: red && z.type === 'NO_GO' ? 'var(--bad)' : fillOf(i), fillOpacity: 0.3, stroke: red && z.type === 'NO_GO' ? 'var(--bad)' : fillOf(i), ...ZONE[z.type]?.line, ...mark(`zones.${i}`) }} vectorEffect="non-scaling-stroke"><title>{`${ZONE[z.type]?.text ?? ''} 구역 ${z.name}`.trim()}</title></polygon>)}
    {f.zones.map((z, i) => { const q = z.polygon.map(([x, y]) => p(x, y)), lx = Math.min(...q.map(([x]) => x)), ly = Math.min(...q.map(([, y]) => y));   // 이름표 = 시안 u7_3 구역 이름 꼴: 구역 왼쪽 위 안쪽 · 작은 흐린 글 · 테두리 없음(누름은 구역이 받음)
      return <text key={`zt${i}`} data-zone-name x={lx + r * 0.4} y={ly + r * 0.4} fontSize={r * 0.7} dominantBaseline="hanging" style={{ fill: 'var(--muted)', pointerEvents: 'none' }}>{z.name}</text>; })}
    {f.waypoints.map((w, i) => { const [x, y] = p(w.x, w.y), [hx, hy] = aim(v, w, r);
      return <g key={`w${i}`} data-key={`waypoints.${i}`} data-waypoint={w.name}>
        <line x1={x} y1={y} x2={hx} y2={hy} style={{ stroke: 'var(--accent)', strokeWidth: 2 }} vectorEffect="non-scaling-stroke" />
        <circle cx={x} cy={y} r={r} style={{ fill: 'var(--accent)', ...mark(`waypoints.${i}`) }} vectorEffect="non-scaling-stroke" /><text x={x} y={y - r * 1.6} fontSize={r * 2.4} textAnchor="middle" style={{ fill: 'var(--text)', stroke: 'var(--bg)', strokeWidth: r * 0.6, paintOrder: 'stroke' }}>{w.name}</text></g>; })}
    {f.connectors.map((k, i) => { const [x, y] = p(k.x, k.y); return <rect key={`c${i}`} data-key={`connectors.${i}`} data-connector={k.kind} x={x - r} y={y - r} width={r * 2} height={r * 2}
      style={{ fill: 'var(--warn)', ...mark(`connectors.${i}`) }} vectorEffect="non-scaling-stroke"><title>{`${KIND[k.kind] ?? ''} 연결점`}</title></rect>; })}
  </>;
}

/** 요소 자리(그림 픽셀) — 처음 화면(자르기)이 요소를 잘라 내지 않게 */
export const featPx = (v: Pick<MapVersion, 'origin' | 'resolution' | 'height'>, f: MapFeatures): [number, number][] =>
  [...f.zones.flatMap((z) => z.polygon), ...f.edits.flatMap((e) => e.polyline), ...[...f.waypoints, ...f.connectors].map((w) => [w.x, w.y])].map(([x, y]) => toPixel(v, x, y));
/** 판 그림 전체·처음 화면(벽 범위 + 판 요소 + 여백, 못 재면 전체). 판이 아직 없으면(받는 중) 빈 틀 */
export function useFit(v?: MapVersion) {
  const walls = useWalls(v?.id), full: Box = v ? [0, 0, v.width, v.height] : [0, 0, 1, 1];
  return { full, fit: useMemo(() => (v ? around(walls, featPx(v, v.features), full, v.resolution) : full), [walls, v]), res: v?.resolution ?? 1 };
}

/** 판 그림 + 저장된 요소(구역·지점·연결점·지우개·벽 선). 그림을 못 받으면 칸 안 글 + 다시 불러오기 */
export type Layers = Record<'zones' | 'waypoints' | 'connectors' | 'edits', boolean>;
export function MapView({ v, fill, terrain, show, demo, children }: { v: MapVersion; fill?: boolean; terrain?: boolean; show?: Layers; demo?: boolean; children?: ReactNode }) {
  const framing = useFit(v), f = show ? { zones: show.zones ? v.features.zones : [], waypoints: show.waypoints ? v.features.waypoints : [], connectors: show.connectors ? v.features.connectors : [], edits: show.edits ? v.features.edits : [] } : v.features;
  // 지형은 바닥 전체가 작업 공간이다. 물체 하나의 벽 범위로 잘라 시작하지 않는다.
  if (terrain) framing.fit = framing.full;
  const [at, setAt] = useState<'wait' | 'ok' | 'bad'>('wait'), [n, setN] = useState(0);
  // fill = 지도·시나리오 틀(.mx-map)을 꽉 채움 — 확대 단추는 지도 오른쪽 아래 겹침, 불러오기·실패 글은 지도 아래쪽 띠
  if (fill) return <>
    <MapFrame {...framing} photo={demo ? null : v} at={{ right: 8, bottom: 8, alignItems: 'flex-end' }} role="img" aria-label="지도" data-map style={{ display: 'block', width: '100%', height: '100%' }}>
      <MapImage key={n} id={v.id} width={v.width} height={v.height} onLoad={() => setAt('ok')} onError={() => setAt('bad')} />{demo && <FactoryImage v={v} />}
      <Shapes v={v} f={f} />{children}
    </MapFrame>
    {at !== 'ok' && <div className="mx-over" style={{ top: 'auto', bottom: 48 }}>
      {at === 'wait' && <p className="lv-note" role="status">지도 그림을 불러오는 중…</p>}
      {at === 'bad' && <div className="fh-row"><p className="fh-msg" role="alert">지도 그림을 불러오지 못했습니다. 네트워크를 확인한 뒤 다시 불러오세요.</p>
        <button type="button" className="btn" onClick={() => { setAt('wait'); setN(n + 1); }}>다시 불러오기</button></div>}</div>}
  </>;
  return <div>
      <MapFrame {...framing} photo={demo ? null : v} role="img" aria-label="지도" data-map style={{ display: 'block', width: '100%', maxHeight: '60vh', borderRadius: 8 }}>
        <MapImage key={n} id={v.id} width={v.width} height={v.height} onLoad={() => setAt('ok')} onError={() => setAt('bad')} />{demo && <FactoryImage v={v} />}
        <Shapes v={v} f={v.features} />
      </MapFrame>
    {at === 'wait' && <p className="lv-note" role="status">지도 그림을 불러오는 중…</p>}
    {at === 'bad' && <div className="fh-row"><p className="fh-msg" role="alert">지도 그림을 불러오지 못했습니다. 네트워크를 확인한 뒤 다시 불러오세요.</p>
      <button type="button" className="btn" onClick={() => { setAt('wait'); setN(n + 1); }}>다시 불러오기</button></div>}
  </div>;
}

/** 장소 나무(GET /sites). again = 다시 받기 */
export function useTree(cancel?: AbortSignal) {
  const [tree, setTree] = useState<SiteTree | null>(null), [err, setErr] = useState(''), [n, setN] = useState(0);
  useEffect(() => {
    let live = true;   // 다시 받기가 겹치면 지난 요청의 늦은 답은 버린다
    api.sites(cancel).then(shape(isTree)).then((t) => { if (live) { setTree(named(t)); setErr(''); } }, (e: ApiFail) => { if (live && e.code !== 'CANCELED') setErr(e.message); });
    return () => { live = false; };
  }, [n]);
  return { tree, err, again: () => setN((x) => x + 1) };
}

const day = (at: string) => new Date(at).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });
/** 저장 기록 상태 이름. 옛 PENDING 판이 기준 판 이후 승인 판이 바뀌었으면 적용할 수 없다(서버 판정과 같은 규칙 — DB 에는 PENDING 으로 남음) */
export const stateOf = (v: MapVersion, approved: string | null): { tone: Tone; text: string } => v.id === approved ? { tone: 'ok', text: '지금 지도' }
  : v.status === 'PENDING' ? (v.base_version_id === approved ? { tone: 'warn', text: '적용 안 됨' } : { tone: 'bad', text: '적용 불가(지도가 바뀜)' })
  : v.status === 'REJECTED' ? { tone: 'bad', text: '반려됨' } : v.status === 'CANCELED' ? { tone: 'off', text: '취소됨' } : { tone: 'off', text: '지난 저장' };
/** 서버가 아직 PENDING(201)으로 받은 경우(결재 없는 서버 전) — 승인 판을 그대로 보인다 */
const asked: Msg = { text: '저장했지만 서버가 아직 적용하지 않았습니다. 적용되기 전에는 지금 지도를 그대로 씁니다.', ok: true };
const SAVED: Msg = { text: '저장했습니다. 다음 실행부터 이 지도를 씁니다.', ok: true };
/** 건물을 열 때 층: 층 번호 1, 없으면 가장 낮은 층 */
const byLevel = (l: MapFloor[]) => [...l].sort((a, b) => a.level - b.level);
const firstFloor = (b: MapBuilding) => b.floors.find((f) => f.level === 1) ?? byLevel(b.floors)[0];

type Kind = 'sites' | 'buildings' | 'floors';
/** 층을 열 때 바로 띄울 창: robot = 로봇으로 지도 만들기, file = 새 지도 올리기 */
export type Intent = 'robot' | 'file' | 'history' | null;
type Make = '' | 'robot' | 'file' | 'fix';
const WHAT: Record<Kind, string> = { sites: '장소', buildings: '건물', floors: '층' };
const OBJ: Record<Kind, string> = { sites: '장소를', buildings: '건물을', floors: '층을' };
const TRASH: Record<Kind, TrashKind> = { sites: 'site', buildings: 'building', floors: 'floor' };
/** 휴지통으로 옮기기 409(§5.1) — 장소·건물은 휴지통 밖 하위가 남음, 층은 로봇·시뮬·실행·배정이 씀(서버 문구로 무엇인지) */
const IN_USE: Partial<Record<Kind, string>> = {
  sites: '안에 건물이 남은 장소는 삭제할 수 없습니다. 안의 건물을 먼저 삭제하세요.',
  buildings: '안에 층이 남은 건물은 삭제할 수 없습니다. 안의 층을 먼저 삭제하세요.',
};
/** 장소 바꾸기 실패 = 무엇이 + 어떻게(U8). 403 은 서버 문구 그대로 */
/** 데모(SIM) 현장의 지도 · 장소 저장은 서버가 409 SIM_PLACE_BY_TERRAIN 로 막는다 · 날것 대신 이 한 줄 */
export const SIM_SAVE = '데모 현장 지도는 보기만 합니다. 지형은 시뮬 탭 «지형 만들기» 에서 바꿉니다.';
const placeFail = (e: ApiFail, k: Kind) => (e.code === 'SIM_PLACE_BY_TERRAIN' ? SIM_SAVE : e.code === 'RESOURCE_IN_USE' && IN_USE[k] ? IN_USE[k] : e.status === 404 ? `이 ${OBJ[k]} 찾을 수 없습니다. 지워졌을 수 있어 목록을 다시 받습니다.` : trashFail(e));

/** 고치기 칸: 새로 만들기(parent) 또는 이름 바꾸기(id). 층은 층 번호(지하 1층 = -1)도 */
type Form = { kind: Kind; id?: string; parent?: string; title: string; name: string; level: string };
/** act = 안내 옆 단추 하나(휴지통으로 옮긴 뒤 «되돌리기») */
export type Msg = { text: string; ok?: boolean; act?: { label: string; run: () => void } } | null;
export const Note = ({ m }: { m: Msg }) => (m ? <p className={`fh-msg${m.ok ? ' ok' : ''}`} role={m.ok ? 'status' : 'alert'}>{m.text}
  {m.act && <> <button type="button" className="btn" onClick={m.act.run}>{m.act.label}</button></>}</p> : null);

/** 내용 비교용: null 칸을 빼고 열쇠 순서를 맞춘 JSON(서버는 None 칸을 저장하지 않는다) */
export const canon = (x: unknown) => JSON.stringify(x, (_, v) => (v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).filter(([, y]) => y != null).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v));

/** 지도 탭(03 §5.6): ① 지도 고르기(건물 카드) → ② 그 건물 1층(가운데 지도 + 오른쪽 지도 요소, 위 줄 층 단추) → ⑤ 지도 편집. 시나리오는 없다(RB-MAP-NO-SCEN 11-18 — 시뮬 탭만).
 *  시뮬 탭(purpose SIM)은 같은 화면에 오른쪽 창 = ③ 시나리오 목록 → ④ 시나리오 열림(MAP-TAB-MERGE 11-03, 지도 요소 창은 지도 탭만 — RB-SIM-NO-MAPEL 11-18).
 *  장소 고치기는 총괄·운영 관리자 모두(서버 'O', PLACE-EDIT-OPEN 11-02) — ① 화면의 창에서. dash = PENDING 으로 받힌 뒤 배지 다시 받기 */
export function Maps(c: Pick<Ctx, 'user' | 'cancel'> & { robots?: Robot[]; dash?: Dash; purpose?: Purpose }) {
  const purpose = c.purpose ?? 'REAL', sim = purpose === 'SIM', t0 = useTree(c.cancel);
  // 지도 탭 = 실기 장소만, 시뮬 탭 = 시뮬 + 실기 장소(RB-SCEN-SIMTAB 11-11 — 시나리오는 실기·시뮬 같은 것을 시뮬 탭에서 고친다). 이름으로 거르지 않음 — 서버 purpose.
  // 장소 고치기(이름·삭제·만들기)는 그 탭 쓰임의 장소만(own)
  const own = (s: MapSite) => purposeOf(s) === purpose;
  const t = useMemo(() => ({ ...t0, tree: t0.tree && { ...t0.tree, items: sim ? t0.tree.items : t0.tree.items.flatMap((s) => { const x = mapTabSite(s); return x ? [x] : []; }) } }), [t0.tree, t0.err]);
  const admin = c.user.role === 'ORG_ADMIN', places = useMemo(() => floorsOf(t.tree), [t.tree]), robots = c.robots ?? [];
  const [pick, setPick] = useState(() => kept.d?.floor ?? keptPlan.floor), cur = places.find((p) => p.floor.id === pick);
  const [sel, setSel0] = useState<string | null>(() => (keptPlan.kind === 'scenarios' && !kept.d ? keptPlan.sel : null)), setSel = (x: string | null) => { keptPlan.sel = x; setSel0(x); };
  const [madmin, setMadmin] = useState(() => keptPlan.kind === 'missions');
  const [manage, setManage] = useState(false);   // 지도 탭 첫 화면 «고르기 · 관리»(시안 u7_1 · u7_2)
  const [all, setAll] = useState(false), multi = !!cur && cur.building.floors.length >= 2, whole = all && multi;   // 전체 = 건물 층 겹쳐 보기(보기만)
  const [form, setForm] = useState<Form | null>(null), [ask, setAsk] = useState<{ kind: Kind; id: string; name: string } | null>(null);
  // make = 열린 장소 창('' = 닫힘): robot·file = «어느 층에?»(지도 만들기·파일 올리기 — 층을 고르거나 새로 만들면 그 층에서 그 창을 연다), fix = 고치기(지도 탭은 고른 층의 장소·건물·층, 시뮬 탭은 옛 «장소 고치기»)
  const [msg, setMsg] = useState<Msg>(null), [busy, setBusy] = useState(false), [make, setMake] = useState<Make>(''), [found, setFound] = useState<Msg>(null);
  const [intent, setIntent] = useState<Intent>(null), maker = !sim && makers(c.user, robots).length > 0;   // intent = 층을 열 때 바로 띄울 창
  const names = useNames(c.user, admin, c.cancel), vers = useVers(places, c.cancel);
  const run = async (k: Kind, f: () => Promise<unknown>, ok: string, act?: NonNullable<Msg>['act']) => {
    setBusy(true); setMsg(null);
    try { await f(); setForm(null); setAsk(null); setMsg({ text: ok, ok: true, act }); t.again(); return true; }
    catch (e) { const x = e as ApiFail; if (x.code === 'CANCELED') return false; setMsg({ text: placeFail(x, k) }); if (x.status === 404) t.again(); return false; }
    finally { setBusy(false); }
  };
  /** 층 고르기 — 시나리오가 열려 있으면 위 줄이 잠겨 여기로 오지 않는다. 저장 안 한 지도 편집은 leaving.ask 가 먼저 묻는다. '' = 지도 고르기 화면, null = 전체 층 */
  const choose = (id: string | null, then: Intent = null) => {
    const go = () => { if (id !== null) { setPick(id); keptPlan.floor = id; setSel(null); } setAll(id === null); setMsg(null); setFound(null); setMake(''); setIntent(then); };
    if (id === null && whole) return;
    if (leaving.ask && id !== cur?.floor.id) leaving.ask(go); else go();
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!form) return;
    const name = form.name.trim(), level = Number(form.level), k = form.kind;
    if (!name) return setMsg({ text: '이름을 입력하세요.' });
    if (/[\p{Cc}\p{Cf}]/u.test(form.name)) return setMsg({ text: '이름에 줄바꿈·탭 같은 보이지 않는 글자는 쓸 수 없습니다.' });   // 서버도 422
    if (k === 'floors' && !(/^\s*-?\d+\s*$/.test(form.level) && Math.abs(level) <= 1000)) return setMsg({ text: '층 번호는 -1000~1000 사이 정수로 입력하세요(지하 1층 = -1).' });
    const p = k === 'floors' ? { name, level } : { name };
    run(k, async () => {
      if (form.id) return api.savePlace(k, form.id, p, c.cancel);
      if (k === 'sites') return api.createSite(name, purpose, c.cancel);
      if (k === 'buildings') return api.createBuilding(form.parent!, name, c.cancel);
      choose((await api.createFloor(form.parent!, { name, level }, c.cancel)).id, make === 'robot' || make === 'file' ? make : null);
    },form.id ? '이름을 바꿨습니다.' : `${OBJ[k]} 만들었습니다.`);
  };
  const open = (f: Omit<Form, 'name' | 'level'> & { name?: string; level?: number }) => { setForm({ ...f, name: f.name ?? '', level: String(f.level ?? 1) }); setAsk(null); setMsg(null); };
  // 휴지통으로(DELETE, §5.1) + 안내의 «되돌리기» = 복원
  // 지금 연 층(또는 그 건물·장소)을 지우면 고르기 화면으로 — 안내·«되돌리기»가 남게 창은 열어 둔다
  const remove = async ({ kind, id, name }: { kind: Kind; id: string; name: string }) => {
    const ok = await run(kind, () => api.deletePlace(kind, id, c.cancel), `«${name}» ${OBJ[kind]} 휴지통으로 옮겼습니다.`,
      { label: '되돌리기', run: () => run(kind, () => api.restore(TRASH[kind], id, c.cancel), `«${name}» ${OBJ[kind]} 되돌렸습니다.`) });
    if (ok && cur && [cur.floor.id, cur.building.id, cur.site.id].includes(id)) { setPick(''); keptPlan.floor = ''; setSel(null); setAll(false); setIntent(null); }
  };
  // 장소 창(총괄·운영 관리자): 이름 바꾸기·삭제(휴지통으로)
  const tools = (kind: Kind, x: { id: string; name: string; level?: number }) => <span className="fh-row mx-acts">
    <button type="button" className="btn" disabled={busy} onClick={() => open({ kind, id: x.id, title: `${WHAT[kind]} 이름 바꾸기 — ${x.name}`, name: x.name, level: x.level })}>이름 바꾸기</button>
    <button type="button" className="btn" disabled={busy} onClick={() => { setAsk({ kind, id: x.id, name: x.name }); setForm(null); setMsg(null); }}>삭제</button></span>;

  const [q, setQ] = useState(''), hit = (...s: string[]) => s.join(' ').toLowerCase().includes(q.trim().toLowerCase());
  const label = cur ? `${cur.site.name} › ${cur.building.name} › ${cur.floor.name}` : '';
  // 장소 창 — 지도 탭 «어느 층에?»는 층 고르기 + 장소·건물·층 만들기, 시뮬 탭 «장소 고치기»는 이름 바꾸기·삭제만(SIM-PAIR 11-09 — 시뮬 지도는 지도 탭 «+ 지형 만들기» 하나로만 생긴다)
  // 장소 창 아래칸(만들기·이름 바꾸기 칸, 삭제 확인, 안내) — 장소 창(placeBody)과 층 고치기 창(fixBody)이 같이 쓴다
  const edits = <div className="mx-dlg-foot">
    {form && <form className="fh-form" onSubmit={submit} noValidate aria-label={form.title}>
      <b>{form.title}</b>
      <label className="fh-field"><span>이름</span><input className="inp" maxLength={128} value={form.name} autoFocus onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
      {form.kind === 'floors' && <label className="fh-field"><span>층 번호(지하 1층 = -1)</span><input className="inp" inputMode="numeric" value={form.level} onChange={(e) => setForm({ ...form, level: e.target.value })} /></label>}
      <div className="fh-row"><button type="submit" className="btn pri" disabled={busy}>저장</button><button type="button" className="btn" onClick={() => setForm(null)}>취소</button></div>
    </form>}
    {ask && <div className="mx-ask" role="group" aria-label="확인">
      <p><b>«{ask.name}» {OBJ[ask.kind]} 휴지통으로 옮길까요?</b> 휴지통에서 복원하거나 완전 삭제할 수 있습니다.</p>
      <div className="fh-row"><button type="button" className="btn" onClick={() => setAsk(null)}>취소</button>
        <button type="button" className="btn bad" disabled={busy} onClick={() => remove(ask)}>삭제</button></div>
    </div>}
    <Note m={msg} />
    {t.err && <div className="fh-row"><p className="fh-msg" role="alert">장소 목록을 받지 못했습니다. {t.err}</p><button type="button" className="btn" onClick={t.again}>다시 시도</button></div>}
    {!t.tree && !t.err && <p className="lv-note" role="status">장소 목록을 불러오는 중…</p>}
  </div>;
  // where(지도 탭 «어느 층에?»)는 층 고르기·만들기만 — 고치기는 층 화면 «이름 바꾸기·삭제…»(fixBody).
  // 단, 층이 하나도 없는 장소·건물은 들어갈 층 화면이 없으니 그 줄에 이름 바꾸기·삭제를 둔다(REVIEW-341)
  const where = make === 'robot' || make === 'file', fixing = (k: Kind, x: { id: string; name: string; level?: number }, empty = false) => (where && !empty ? null : tools(k, x));
  const placeBody = <div role="group" aria-label="장소" className="fh-form">
    {places.length > 4 && <input className="inp" type="search" aria-label="장소 거르기" placeholder="장소·건물·층 이름으로 거르기" value={q} onChange={(e) => setQ(e.target.value)} />}
    <div className="mx-tree">{t.tree?.items.filter((s) => own(s) && (!q.trim() || s.buildings.some((b) => hit(s.name, b.name) || b.floors.some((f) => hit(s.name, b.name, f.name))) || hit(s.name))).map((s) => <div key={s.id} aria-label={`장소 ${s.name}`} className="mx-tsite">
      <div className="fh-row"><b className="fh-grow">{s.name}</b>{fixing('sites', s, s.buildings.every((b) => !b.floors.length))}
        {!sim && <button type="button" className="btn mx-add" disabled={busy} onClick={() => open({ kind: 'buildings', parent: s.id, title: `${s.name} 에 새 건물` })}>+ 건물</button>}</div>
      {s.buildings.filter((b) => !q.trim() || hit(s.name) || hit(s.name, b.name) || b.floors.some((f) => hit(s.name, b.name, f.name))).map((b) => <div key={b.id} className="mx-tbld">
        <div className="fh-row"><span className="fh-grow">{b.name}</span>{fixing('buildings', b, !b.floors.length)}
          {!sim && <button type="button" className="btn mx-add" disabled={busy} onClick={() => open({ kind: 'floors', parent: b.id, title: `${s.name} ${b.name} 에 새 층` })}>+ 층</button>}</div>
        <ul className="fh-list" aria-label={`${b.name} 층`}>{b.floors.filter((f) => !q.trim() || hit(s.name, b.name, f.name)).map((f) => <li key={f.id} className="fh-row">
          <button type="button" onClick={() => choose(f.id, where ? make as Intent : null)}><span className="fh-grow">{f.name}</span>
            {f.approved_version_id ? <span className="lv-chip ok">지도 있음</span> : <span className="lv-chip">지도 없음</span>}</button>{fixing('floors', f)}</li>)}</ul>
        {!b.floors.length && <p className="lv-note">아직 층이 없습니다.</p>}
      </div>)}
      {!s.buildings.length && <p className="lv-note">아직 건물이 없습니다.</p>}
    </div>)}</div>
    {t.tree && !t.tree.items.some(own) && <p className="lv-note">{sim ? '등록된 시뮬 장소가 없습니다. 시뮬 지도는 지도 탭의 «+ 지형 만들기»로 만듭니다.' : '등록된 장소가 없습니다. «+ 장소»로 만드세요.'}</p>}
    {!sim && <button type="button" className="btn mx-new" disabled={busy} onClick={() => open({ kind: 'sites', title: '새 장소' })}>+ 장소</button>}
    <div className="fh-row mx-dlg-util"><span className="lv-note fh-grow">지운 장소·건물·층은 휴지통에서 되돌립니다.</span><TrashLink /></div>
    {edits}
  </div>;
  // 고른 층 화면의 고치기 창(지도 탭): 이 장소·건물·층의 이름 바꾸기·삭제(휴지통) — 권한은 서버 'O'(총괄·운영 관리자 모두)
  const fixBody = <div role="group" aria-label="고치기" className="fh-form">
    {cur && <div aria-label="이 지도의 장소" className="mx-fix">{([['sites', cur.site], ['buildings', cur.building], ['floors', cur.floor]] as const).map(([k, x]) =>
      <div key={k} className="fh-row" aria-label={`${WHAT[k]} ${x.name}`} data-fix={k}><span className="lbl">{WHAT[k]}</span><b className="fh-grow">{x.name}</b>{tools(k, x)}</div>)}</div>}
    <div className="fh-row mx-dlg-util"><span className="lv-note fh-grow">지운 장소·건물·층은 휴지통에서 되돌립니다.</span><TrashLink /></div>
    {edits}
  </div>;
  // 왼쪽 위 = «‹ 모든 지도 보기» + 2층 이상 건물은 층 단추·«전체 층 겹쳐 보기»(보기만, 층 레이어 10-30)
  const back = cur && <button type="button" className="btn" data-to-chooser onClick={() => choose('')}>‹ 모든 지도 보기</button>;
  const side = cur && multi && <><span className="mx-seg" role="group" aria-label="층" data-floors>{byLevel(cur.building.floors).map((f) =>
      <button key={f.id} type="button" className="btn" aria-pressed={!whole && f.id === cur.floor.id} data-floor={f.id} onClick={() => choose(f.id)}>{f.name}</button>)}</span>
      <button type="button" className="btn" aria-pressed={whole} data-layers onClick={() => choose(null)}>전체 층 겹쳐 보기</button></>;
  const top = cur && <>{back}{side}</>;

  if (madmin && sim) return <MissionAdmin user={c.user} robots={robots} cancel={c.cancel} back={() => setMadmin(false)} />;
  if (whole && cur) return <AllFloors key={cur.building.id} b={cur.building} top={top} cancel={c.cancel} />;
  const shut0 = () => { setMake(''); setForm(null); setAsk(null); };
  const title = make === 'file' ? '파일 올리기 — 어느 층에?' : sim ? '장소 고치기' : '이름 바꾸기·삭제';
  const pop = <Pop open={!!make} close={shut0} label={make ? title : '장소'}>
    {make === 'fix' && !sim ? <><p className="lv-note mx-lead">이 지도의 장소·건물·층 이름을 바꾸거나 휴지통으로 옮깁니다.</p>{fixBody}</>
      : make && <><p className="lv-note mx-lead">{sim ? '시뮬 장소의 이름을 바꾸거나 지웁니다. 새 시뮬 지도는 지도 탭의 «+ 지형 만들기»로 만듭니다.'
        : `지도 파일을 올릴 층을 고르세요. 없으면 «+ 장소»·«+ 건물»·«+ 층»으로 만듭니다.`}</p>{placeBody}</>}
  </Pop>;
  // 층 화면 «··· › 이름 바꾸기·삭제…» = 시안 u7 틀 화면 안 칸(옛 창 없음) · 지운 것은 휴지통 · 확인은 같은 칸 안
  if (!sim && cur && make === 'fix') return <UploadScreen label="고치기" place={cur} back={() => { shut0(); setMsg(null); setIntent(null); }} lock={busy} head={`이름 바꾸기 · 삭제 · ${cur.building.name} ${cur.floor.name}`}
    side={{ ttl: '이름 바꾸기 · 삭제', text: '이 지도의 장소 · 건물 · 층 이름을 바꾸거나 휴지통으로 옮깁니다.', foot: '지운 장소 · 건물 · 층은 휴지통에서 되돌립니다.' }}>
    {fixBody}
  </UploadScreen>;
  if (cur) return <>{sim ? <Floor key={cur.floor.id} p={cur} admin={admin} names={names} cancel={c.cancel} again={t.again} told={() => c.dash?.again()} top={top} name={label} user={c.user} robots={robots} open0={intent}
      places={places} sel={sel} setSel={setSel} toAdmin={() => setMadmin(true)} run={(x) => scenRun(x, places, vers)} />
    : <FloorView key={cur.floor.id} p={cur} admin={admin} names={names} cancel={c.cancel} again={t.again} told={() => c.dash?.again()} top={back} toPick={() => choose('')} side={side} name={label} user={c.user} robots={robots} places={places} open0={intent}
      fix={() => { setForm(null); setAsk(null); setMsg(null); setMake('fix'); }} toScen={(id) => { keptPlan.floor = cur.floor.id; location.hash = id ? `#/mission/${encodeURIComponent(id)}` : '#/missions'; }} />}   {/* 겹침 «예» = 임무 탭에서 그 임무 · u7_3 «이 지도로 모의 실행» = 시안 u6_6 (임무 탭, 그 층) */}
    {pop}</>;
  const mk = (k: Make) => { setForm(null); setAsk(null); setMsg(null); setMake(k); };
  // u7_1 「+ 지도 만들기」 = 바로 시안 u7_6 (옛 «어느 층에?» 창 없음) · 층은 u7_6 머리줄 칩에서 고르면 그 층 화면의 u7_6 으로 이어진다
  // u7_1 「+ 파일 올리기」 = 시안 u7 틀 화면(옛 «어느 층에?» 창 없음) · 머리줄 층 칩이나 칸 안 목록으로 고르면 그 층의 올리기 화면 · 층이 없으면 칸 안에서 만든다
  if (!sim && make === 'file') return <UploadScreen label={title} place={null} back={shut0} pick={(id) => choose(id, 'file')}
    floors={places.filter((x) => purposeOf(x.site) === 'REAL' && x.floor.provenance !== 'SIMULATION')}>
    <p className="lv-note mx-lead">지도 파일을 올릴 층을 고르세요. 없으면 «+ 장소»·«+ 건물»·«+ 층»으로 만듭니다.</p>{placeBody}
  </UploadScreen>;
  if (!sim && make === 'robot') return <ScanScreen place={null} back={shut0} toList={shut0} pick={(id) => choose(id, 'robot')}
    floors={places.filter((x) => purposeOf(x.site) === 'REAL' && x.floor.provenance !== 'SIMULATION')}
    a={{ floor: '', approved: null, list: null, user: c.user, robots, places, cancel: c.cancel, made: () => {} }} />;
  if (!sim) return <Pick maker={maker} t={t} places={places} vers={vers} choose={choose} make={mk} note={found} manage={manage} setManage={setManage} edit={!make && placeBody}>
    {pop}
  </Pick>;
  return <Chooser sim={sim} maker={maker} t={t} places={places} vers={vers} choose={choose} make={mk} note={found} cancel={c.cancel}>
    {pop}
  </Chooser>;
}

/** 시뮬 탭 아래 칸(SIM-REAL-SPLIT 11-09): SIM 장소의 지도·시나리오 — 지도 탭과 같은 화면(Maps purpose SIM), 배정·결재 대신 «시뮬에서 실행». 앱 안(폰)은 숨김 */
export function SimPlaces({ user, robots }: { user: User; robots: Robot[] }) {
  if (inApp()) return null;
  return <section className="lv-card" aria-label="시뮬 지도·시나리오" data-sim-places style={{ flexBasis: '100%', height: '80vh', minHeight: 480, padding: 0, overflow: 'hidden', display: 'flex' }}>
    <Maps user={user} robots={robots} purpose="SIM" /></section>;
}

/** 카드 위 작은 지도(SIM-CARDS-WIDE 11-09): 승인 판 그림(MapImage, 벽 범위로 자른 처음 화면) — 카드가 화면 가까이 올 때만 받는다.
 *  판이 없거나 그림이 실패하면 같은 높이 회색 칸 «지도 없음»(판 받는 중은 빈 회색 칸) — 카드 높이는 CSS(.mx-thumb) 고정 */
function Thumb({ id, v, demo }: { id?: string | null; v?: MapVersion; demo?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null), [near, setNear] = useState(typeof IntersectionObserver === 'undefined'), [bad, setBad] = useState(false), { fit } = useFit(near ? v : undefined);
  useEffect(() => {
    if (near || !ref.current) return;
    const o = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { setNear(true); o.disconnect(); } }, { rootMargin: '200px' });
    o.observe(ref.current); return () => o.disconnect();
  }, [near]);
  return <span ref={ref} className="mx-thumb" data-thumb={id && !bad ? id : ''} aria-hidden="true">{!id || bad ? <small>지도 없음</small> : v && near && <svg viewBox={fit.join(' ')} preserveAspectRatio="xMidYMid meet">
    <MapImage id={v.id} width={v.width} height={v.height} onError={() => setBad(true)} />{demo && <FactoryImage v={v} />}</svg>}</span>;
}
/** 카드 그림 층: 1층, 그 층에 지도가 없으면 지도 있는 가장 낮은 층 */
const picFloor = (b: MapBuilding) => [firstFloor(b), ...byLevel(b.floors)].find((x) => x?.approved_version_id);

/** 판 크기(m) · 넓이(m²) · 날짜 · 판 번호 — 시안 u7 의 「50 만 m² (900 × 560 m) · 11/20 · v3」 를 받은 값으로만 */
const meters = (v: MapVersion) => { const w = v.width * v.resolution, h = v.height * v.resolution, r = (x: number) => (x >= 10 ? Math.round(x) : Math.round(x * 10) / 10);
  return { wh: `${r(w)} × ${r(h)} m`, area: areaText(w * h) }; };
/** 넓이 글(시안 u7 꼴): 1 만 m² 부터 「50 만 m²」 「4.2 만 m²」(10 만 이상은 정수, 그 아래는 소수 한 자리), 그 아래는 「8,400 m²」 */
export const areaText = (a: number) => { if (a < 10000) return `${(a >= 10 ? Math.round(a) : Math.round(a * 10) / 10).toLocaleString('ko-KR')} m²`;
  const m = a / 10000; return `${m >= 10 ? Math.round(m) : Math.round(m * 10) / 10} 만 m²`; };
const md = (at: string) => { const d = new Date(at); return Number.isNaN(d.getTime()) ? '' : `${d.getMonth() + 1}/${d.getDate()}`; };
/** 만든 방법(판 source · 3D 파일 · 시뮬 지형) */
const howMade = (v: MapVersion) => (v.provenance === 'SIMULATION' ? '시뮬 지형' : voxelOf(v) ? '3D 지도 파일' : v.source === 'SLAM' ? '로봇으로 그림' : v.source === 'EDIT' ? '지도 고침' : v.source === 'ROLLBACK' ? '되돌림' : '파일 올림');
const NOGO = (v: MapVersion) => v.features.zones.filter((z) => z.type === 'NO_GO').length;

/** 층 겹친 그림(시안 u7_1 가운데 아래): 받은 층 순서 그대로, 고른 층만 칠함. 장식이 아니라 층 고르기(누르면 그 층) */
function Stack({ floors, sel, pick }: { floors: MapFloor[]; sel?: string; pick: (id: string) => void }) {
  const l = [...floors].reverse(), H = 40 + l.length * 56;
  return <svg className="mp-stack" viewBox={`0 0 520 ${H}`} role="group" aria-label="층 겹친 그림">{l.map((f, i) => { const y = 30 + i * 56, on = f.id === sel;
    return <g key={f.id} data-stack={f.id} onClick={() => pick(f.id)} style={{ cursor: 'pointer' }}>
      <path d={`M40 ${y + 28} L220 ${y} L400 ${y + 28} L220 ${y + 56} Z`} className={on ? 'on' : ''} />
      <text x={420} y={y + 33} className={on ? 'on' : ''}>{f.name}</text></g>; })}</svg>;
}

/** ① 지도 고르기 · 관리(지도 탭 · 시안 u7_1 · u7_2). 왼쪽 = 장소별 건물, 가운데 = 고른 건물의 층(고르기) 또는 장소 편집(관리), 오른쪽 = 미리 보기(고르기) 또는 지형 · 올리기 · 휴지통(관리) */
function Pick({ maker, t, places, vers, choose, make, note, manage, setManage, edit, children }: { maker: boolean; t: ReturnType<typeof useTree>; places: Place[]; vers: Record<string, MapVersion>;
  choose: (id: string, then?: Intent) => void; make: (k: Make) => void; note: Msg; manage: boolean; setManage: (m: boolean) => void; edit: ReactNode; children: ReactNode }) {
  const blds = places.reduce<{ site: MapSite; building: MapBuilding }[]>((a, p) => (a.some((x) => x.building.id === p.building.id) ? a : [...a, { site: p.site, building: p.building }]), []);
  const [bid, setBid] = useState(() => places.find((p) => p.floor.id === keptPlan.floor)?.building.id ?? blds[0]?.building.id ?? '');
  const cur = blds.find((x) => x.building.id === bid) ?? blds[0];
  const [fid, setFid] = useState(''), floors = cur ? byLevel(cur.building.floors) : [];
  const fl = floors.find((f) => f.id === fid) ?? (cur && (picFloor(cur.building) ?? firstFloor(cur.building))), v = fl?.approved_version_id ? vers[fl.approved_version_id] : undefined;
  const maps = places.filter((p) => p.floor.approved_version_id).length;
  const none = !!t.tree && !places.length;
  const newMap = <Menu label={<>＋ 새 지도 만들기</>} title="새 지도 만들기" end className="mp-new">
    {/* 지도 0 개면 빈 칸(아래)의 단추와 같은 것은 숨긴다(U11-04 검수 · 칠한 단추 하나) */}
    {maker && !none && <button type="button" className="btn" data-make-robot onClick={(e) => { shut(e); make('robot'); }}>+ 지도 만들기</button>}
    {(maker || !none) && <button type="button" className="btn" data-make-file onClick={(e) => { shut(e); make('file'); }}>+ 파일 올리기</button>}
    {!inApp() && <a className="btn" href="#/terrain" style={{ textDecoration: 'none' }} data-terrain-enter>+ 지형 만들기</a>}
  </Menu>;
  return <section className="mx mp" aria-label="지도 고르기">
    <aside className="lv-card mp-sites" aria-label="현장">
      <div className="fh-row"><h2 className="fh-grow">현장</h2>{t.tree && <span className="lbl">지도 {maps} 개</span>}</div>
      {t.tree?.items.filter((s) => blds.some((x) => x.site.id === s.id)).map((s) => <div key={s.id} className="mp-group mx-site" aria-label={`장소 ${s.name}`}><p className="lbl">{s.name}</p>
        {blds.filter((x) => x.site.id === s.id).map(({ building: b }) => { const n = b.floors.filter((f) => f.approved_version_id).length;
          return <button key={b.id} type="button" className="mp-site" data-building={b.id} aria-pressed={b.id === cur?.building.id} onClick={() => { setBid(b.id); setFid(''); }}>
            <span className="mp-pin" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z" /><circle cx="12" cy="10" r="2.5" /></svg></span>
            <span className="mp-sn"><b>{b.name}</b><small>{s.name} · {b.floors.length}층{n ? '' : ' · 지도 없음'}</small></span><span className="mp-cnt">{n}</span></button>; })}</div>)}
      {t.tree && !blds.length && <p className="lv-note">아직 층이 있는 건물이 없습니다. «관리»에서 장소 · 건물 · 층을 만듭니다.</p>}
      <p className="lv-note mp-foot">층마다 지도 하나입니다. 로봇으로 그리거나 지도 파일을 올려 만듭니다.</p>
    </aside>
    <div className="mp-main">
      <div className="mp-head"><h2>지도 {cur && <small>{cur.building.name} · {cur.site.name}</small>}</h2><span className="fh-grow" />
        <span className="mx-seg mp-seg" role="group" aria-label="고르기 · 관리"><button type="button" className="btn" aria-pressed={!manage} onClick={() => setManage(false)}>고르기</button>
          <button type="button" className="btn" aria-pressed={manage} onClick={() => setManage(true)}>관리</button></span>
        {newMap}</div>
      <Note m={note} />
      {t.err && <div className="fh-row"><p className="fh-msg" role="alert">장소 목록을 받지 못했습니다. {t.err}</p><button type="button" className="btn" onClick={t.again}>다시 시도</button></div>}
      {!t.tree && !t.err && <p className="lv-note" role="status">장소 목록을 불러오는 중…</p>}
      {none && !manage && <Empty kind="map" title="아직 지도가 없습니다" card={false}
        why={maker ? '담당 실기 로봇이 돌아다니며 그리거나 지도 파일을 올리면 여기에 보입니다.' : '지도 파일(그림 · yaml)을 올리면 여기에 보입니다.'}>
        {maker ? <button type="button" className="btn pri" onClick={() => make('robot')}>+ 지도 만들기</button>
          : <button type="button" className="btn pri" onClick={() => make('file')}>+ 파일 올리기</button>}</Empty>}
      {manage ? <div className="mp-cols mp-manage">
        <section className="lv-card mp-edit" aria-label="장소 · 건물 · 층 편집"><div className="fh-row"><h2 className="fh-grow">장소 · 건물 · 층 편집</h2></div>
          <p className="lv-note">이름 바꾸기 · 삭제는 바로 서버에 저장됩니다. 지운 것은 휴지통에서 되돌립니다.</p>{edit}</section>
        <div className="mp-right">
          <section className="lv-card" data-manage-terrain><h2>시뮬 지형 만들기</h2><p className="lv-note">실측 지도 없이 시험할 지형을 시뮬 지도로 만듭니다.</p>
            {!inApp() && <a className="btn" href="#/terrain" style={{ textDecoration: 'none' }} data-terrain-enter>+ 새 시뮬 지형</a>}</section>
          <section className="lv-card" data-manage-up><h2>지도 올리기</h2><p className="lv-note">지도 그림 · yaml 또는 3D 지도 파일(.pcd · .ply, 총괄)을 층에 올립니다. 층을 고르는 창이 열립니다.</p>
            <div className="fh-row"><button type="button" className="btn" data-make-file onClick={() => make('file')}>지도 파일 올리기</button>
              {maker && <button type="button" className="btn" data-make-robot onClick={() => make('robot')}>로봇으로 그리기</button>}</div></section>
          <section className="lv-card" data-manage-trash><h2>휴지통</h2><p className="lv-note">지운 장소 · 건물 · 층 · 지도는 휴지통에서 되돌립니다.</p><TrashLink /></section>
        </div></div>
      : cur && <div className="mp-cols">
        <section className="lv-card mp-floors" aria-label="층 목록"><div className="fh-row"><h2 className="fh-grow">{cur.building.name} · 층</h2><span className="lbl">층마다 지도 하나</span></div>
          <div className="mp-rows">{floors.map((f) => { const x = f.approved_version_id ? vers[f.approved_version_id] : undefined;
            return <button key={f.id} type="button" className="mp-row" data-floor-row={f.id} aria-pressed={f.id === fl?.id} onClick={() => setFid(f.id)}>
              <Thumb id={f.approved_version_id} v={x} demo={demoBoard(cur.site, cur.building)} />
              <span className="mp-rt"><span className="fh-row"><b>{f.name}</b>{x ? <span className="lv-chip ok">{howMade(x)}</span> : f.approved_version_id ? null : <span className="lv-chip off">지도 없음</span>}
                {x && voxelOf(x) && <span className="lv-chip" data-voxel-chip title="3D 지도 파일에서 만든 지도 · 시뮬 지형 연결됨">3D</span>}</span>
                {x && <small>{meters(x).area} ({meters(x).wh}) · {md(x.created_at)} · v{x.number}</small>}</span><span className="mp-chev" aria-hidden="true">›</span></button>; })}</div>
          {floors.length >= 2 && <Stack floors={floors} sel={fl?.id} pick={setFid} />}
        </section>
        {fl && <section className="lv-card mp-prev" aria-label="미리 보기">
          <div className="mp-pv">{v ? <MapView key={v.id} v={v} fill demo={demoBoard(cur.site, cur.building)} />
            : <div className="mx-center"><p className="lv-note">{fl.approved_version_id ? '지도를 불러오는 중…' : '이 층에 아직 지도가 없습니다. 지도를 열어 올리거나 로봇으로 그립니다.'}</p></div>}
            {v && <span className="mp-tag">위에서 본 지도 · {meters(v).wh}{modelOf(v) ? ' · 3D 모형 있음' : ''}</span>}</div>
          <div className="mp-pf"><div className="fh-row"><b className="mp-pt" data-prev-title>{cur.building.name} · {fl.name}</b>{v && <span className="lv-chip ok">{howMade(v)}</span>}</div>
            {v && <p className="mp-facts"><span>{meters(v).area}</span><span>{meters(v).wh}</span><span>{md(v.created_at)} · v{v.number}</span><span>금지 구역 {NOGO(v)}</span></p>}
            <div className="fh-row"><button type="button" className="btn pri fh-grow" data-open-map onClick={() => choose(fl.id)}>지도 열기</button>
              {fl.approved_version_id && <button type="button" className="btn" data-open-history onClick={() => choose(fl.id, 'history')}>버전 기록</button>}</div></div>
        </section>}
      </div>}
    </div>
    {children}
  </section>;
}

/** ① 지도 고르기(첫 화면): «어느 지도에서 일할까요?» + 장소별 건물 카드(11-11 «마지막에 본 지도» 카드 뺌·그림 크게)(카드 전체가 단추 — 그 건물 1층을 연다) + 찾기·휴지통.
 *  지도 탭 = «+ 지도 만들기»(로봇, 담당 운영자만)·«+ 파일 올리기» — 둘 다 «어느 층에?»(11-12 현민님), 장소 고치기는 층 화면 + «+ 지형 만들기»(11-19 시뮬 탭에서 옮김). 시뮬 탭 = «장소 고치기» */
function Chooser({ sim, maker, t, places, vers, choose, make, note, cancel, children }: { sim: boolean; maker: boolean; t: ReturnType<typeof useTree>; places: Place[]; vers: Record<string, MapVersion>; choose: (id: string) => void; make: (k: Make) => void; note: Msg; cancel?: AbortSignal;
  children: ReactNode }) {
  const [q, setQ] = useState(''), counts = useCounts(sim, cancel);
  const hit = (p: Place) => `${p.site.name} ${p.building.name} ${p.floor.name}`.toLowerCase().includes(q.trim().toLowerCase());
  /** 카드 아래 줄: 층 수(2층 이상만)·시나리오 수(시뮬 탭만, 여러 층 시나리오는 한 번만)·지도 없음(시뮬 탭은 모든 층이 짝 없으면 «지형 없음» — 서버 정리 전 옛 층) */
  // + 어디서 도는지(RB-SCEN-SIMTAB 11-11 — 카드 그림 층 기준, 판을 받기 전엔 없음)
  const facts = (s: MapSite, b: MapBuilding) => { const r = runOf({ site: s, building: b, floor: picFloor(b) ?? firstFloor(b) }, vers);
    return <small className="fh-row">{b.floors.length >= 2 && <span>층 {b.floors.length}</span>}
    {sim && <span>{counts ? `시나리오 ${new Set(b.floors.flatMap((f) => counts[f.id] ?? [])).size}` : counts === null ? '시나리오 ?' : ''}</span>}
    {r && <span className={`lv-chip ${r === 'both' ? 'ok' : 'off'}`} data-run={r}>{RUN[r]}</span>}
    {sim && purposeOf(s) === 'SIM' ? b.floors.every((f) => lone(f, f.approved_version_id ? vers[f.approved_version_id] : undefined)) && <span className="lv-chip off" data-lone>지형 없음</span>
      : !b.floors.some((f) => f.approved_version_id) && <span className="lv-chip off">지도 없음</span>}
    {!sim && b.floors.some((f) => f.approved_version_id && voxelOf(vers[f.approved_version_id])) && <span className="lv-chip" data-voxel-chip title="3D 지도 파일에서 만든 지도 · 시뮬 지형 연결됨">3D</span>}</small>; };
  const thumb = (b: MapBuilding) => { const id = picFloor(b)?.approved_version_id; return <Thumb key={id ?? ''} id={id} v={id ? vers[id] : undefined} />; };
  const shown = places.filter(hit), sites = t.tree?.items.filter((s) => shown.some((p) => p.site.id === s.id)) ?? [];
  const none = !!t.tree && !sim && !places.length;   // 지도 0 개(U11-04 빈 화면)
  return <section className="mx" aria-label="지도 고르기">
    <div className="mx-scroll"><div className="mx-choose">
      <h2>{sim ? '어느 지도로 시뮬할까요?' : '어느 지도에서 일할까요?'}</h2>
      <p className="lv-note">{sim ? '지도를 고르면 위쪽 «시뮬 열기»로 시뮬을 열고, 그 지도의 시나리오를 만들고 고쳐 «시뮬에서 실행»합니다. 실기 지도의 시나리오도 여기서 고칩니다(실기 로봇은 조종 화면에서 시나리오를 고릅니다).'
        : <>지도를 고르면 그 지도의 구역·벽을 보고 고칩니다. <a href="#/missions" data-mission-link>임무(경로·할 일)는 «임무» 탭에서 만들고 고칩니다</a></>}</p>
      <Note m={note} />
      <div className="fh-row"><input className="inp fh-grow" type="search" aria-label="지도 찾기" placeholder="장소·건물·층 이름으로 찾기" value={q} onChange={(e) => setQ(e.target.value)} />
        {sim ? <button type="button" className="btn" onClick={() => make('fix')}>장소 고치기</button>
          // 지도 0 개면 빈 칸(아래)의 단추와 같은 위 단추는 숨긴다. 칠한 단추는 STOP 말고 하나(U11-04 검수)
          : <>{maker && !none && <button type="button" className="btn pri" data-make-robot onClick={() => make('robot')}>+ 지도 만들기</button>}
            {(maker || !none) && <button type="button" className={`btn${maker ? '' : ' pri'}`} data-make-file onClick={() => make('file')}>+ 파일 올리기</button>}
            {!inApp() && <a className="btn" href="#/terrain" style={{ textDecoration: 'none' }} data-terrain-enter>+ 지형 만들기</a>}</>}</div>
      {sites.map((s) => <section key={s.id} className="mx-site" aria-label={`장소 ${s.name}`}><h3 className="lbl">{s.name}</h3>
        <div className="mx-cards">{s.buildings.filter((b) => shown.some((p) => p.building.id === b.id)).map((b) =>
          <button key={b.id} type="button" className="card mx-bld" data-building={b.id} onClick={() => choose(firstFloor(b).id)}>{thumb(b)}<b>{b.name}</b>{facts(s, b)}</button>)}</div></section>)}
      {/* 시뮬 탭: 실기 카드는 보이되 시뮬로 쓸 지도(시뮬 장소·3D 실기)가 하나도 없으면 안내 — 판을 아직 못 받은 층(null)은 모름이라 안내 안 함 */}
      {t.tree && sim && places.every((p) => runOf(p, vers) === 'real') && <p className="lv-note" data-empty>서버 시뮬 지도가 없습니다. 지도 탭의 «+ 지형 만들기»로 지형을 저장하면 여기에 보입니다.</p>}
      {/* 지도 0 개(U11-04 빈 화면 · u11_7): 아이콘 · 한 줄 까닭 · 다음 할 일 하나(담당 실기가 있으면 로봇으로 그리기, 없으면 파일 올리기) */}
      {none && <Empty kind="map" title="아직 지도가 없습니다" card={false}
        why={maker ? '담당 실기 로봇이 돌아다니며 그리거나 지도 파일을 올리면 여기에 보입니다.' : '지도 파일(그림 · yaml)을 올리면 여기에 보입니다.'}>
        {maker ? <button type="button" className="btn pri" onClick={() => make('robot')}>+ 지도 만들기</button>
          : <button type="button" className="btn pri" onClick={() => make('file')}>+ 파일 올리기</button>}</Empty>}
      {t.tree && !!places.length && !shown.length && <p className="lv-note">«{q.trim()}»에 맞는 지도가 없습니다.</p>}
      {t.err && <div className="fh-row"><p className="fh-msg" role="alert">장소 목록을 받지 못했습니다. {t.err}</p><button type="button" className="btn" onClick={t.again}>다시 시도</button></div>}
      {!t.tree && !t.err && <p className="lv-note" role="status">장소 목록을 불러오는 중…</p>}
      <div className="fh-row"><TrashLink /><span className="lv-note">{sim ? '지운 장소·층·시나리오는 휴지통에서 되돌립니다.' : '지운 장소·층은 휴지통에서 되돌립니다.'}</span></div>
    </div></div>
    {children}
  </section>;
}

/** 층마다 시나리오 id(휴지통 제외) — 시뮬 탭 지도 고르기 카드의 시나리오 수(지도 탭은 받지 않음). 받는 중 undefined, 못 받으면 null */
function useCounts(on: boolean, cancel?: AbortSignal) {
  const [m, setM] = useState<Record<string, string[]> | null>();
  useEffect(() => {
    if (!on) return;
    let live = true;
    api.allPlans('scenarios', cancel).then((l) => { const o: Record<string, string[]> = {};
      for (const x of l as Scenario[]) if (x && !x.archived_at && Array.isArray(x.floor_ids)) for (const f of x.floor_ids) (o[f] ??= []).push(x.id);
      if (live) setM(o); }, (e: ApiFail) => { if (live && e.code !== 'CANCELED') setM(null); });
    return () => { live = false; };
  }, []);
  return m;
}

/** 시뮬 탭의 고른 층 하나: 이 층 시나리오 목록·마우스 올린 시나리오(지도에 경로)를 들고 ② 지도 보기(FloorView) ↔ ④ 시나리오 열림을 가른다 */
function Floor({ p, sel, setSel, toAdmin, run, user, robots, places, cancel, top, name, ...v }: { p: Place; admin: boolean; open0: Intent; names: (id: string) => string | undefined; cancel?: AbortSignal; again: () => void; told: () => void;
  top: ReactNode; name: string; user: User; robots: Robot[]; places: Place[]; sel: string | null; setSel: (x: string | null) => void; toAdmin: () => void; run: (x: Scenario) => Run | null }) {
  const [mine, setMine] = useState(false), l = useScenarios(p.floor.id, mine, cancel), [hov, setHov] = useState<Scenario | null>(null), [n, setN] = useState(0), [msg, setMsg] = useState<Msg>(null), [slot, setSlot] = useState<HTMLElement | null>(null);
  const scenN = l.busy && !l.items.length ? '…' : `${l.items.length}${l.next ? '+' : ''}`, title = <SideTitle scen n={scenN} />;   // 오른쪽 창 = 시나리오만(RB-SIM-NO-MAPEL 11-18)
  const openScen = (id: string) => { setMsg(null); if (!id) setN((x) => x + 1); setSel(id); };
  if (sel != null) return <section className="mx" aria-label="시나리오 편집">
    <div className="mx-bar"><Locked text={name} why="시나리오를 닫으면 지도를 바꿀 수 있습니다" /><span className="mx-tag mx-why">시나리오를 닫으면 지도를 바꿀 수 있습니다</span><span ref={setSlot} style={{ display: 'contents' }} /></div>
    <ScenarioEdit id={sel} n={n} user={user} robots={robots} cancel={cancel} places={places} treeAgain={v.again} floor={p.floor.id} slot={slot} side={title}
      close={() => setSel(null)} top={msg && <Note m={msg} />} done={(x, m) => { l.again(); setMsg(m); if (x && x.id !== sel) setSel(x.id); }} />
  </section>;
  return <FloorView {...v} p={p} sim user={user} robots={robots} places={places} toScen={openScen} cancel={cancel} top={top} name={name} scenN={scenN} head={title} hov={hov}
    scenList={<ScenList run={run} l={l} mine={mine} setMine={setMine} floor={p.floor.id} approved={p.floor.approved_version_id} open={openScen} hover={setHov} admin={toAdmin} top={msg && <Note m={msg} />} />} />;
}

/** 지도 위 시나리오 경로 미리보기(목록에서 마우스를 올린 시나리오 — 이 층 지점만, 번호 + 점선) */
function Route({ v, x, floor }: { v: Pick<MapVersion, 'origin' | 'resolution' | 'height' | 'width'>; x: Scenario; floor: string }) {
  const on = x.waypoints.filter((w) => w.floor_id === floor), rr = Math.max(v.width, v.height) / 60;
  return <g data-route={x.id} style={{ pointerEvents: 'none' }}>
    {on.length > 1 && <polyline points={on.map((w) => toPixel(v, w.x, w.y).join(',')).join(' ')} style={{ fill: 'none', stroke: 'var(--accent)', strokeWidth: 3, strokeDasharray: '6 4' }} vectorEffect="non-scaling-stroke" />}
    {on.map((w, i) => { const [a, b] = toPixel(v, w.x, w.y); return <g key={i}><circle cx={a} cy={b} r={rr} style={{ fill: 'var(--accent)', stroke: 'var(--on-accent)', strokeWidth: 2 }} vectorEffect="non-scaling-stroke" />
      <text x={a} y={b + rr * 0.45} fontSize={rr * 1.3} textAnchor="middle" style={{ fill: 'var(--on-accent)' }}>{i + 1}</text></g>; })}
  </g>;
}

/** 층마다 승인 판(요소 수·시뮬 짝 판정) — /sites 층에는 판 id 만 있어 판 정보(GET /map-versions/{id})를 한 번씩 받는다. 못 받으면 없음 */
function useVers(places: Place[], cancel?: AbortSignal) {
  const [feats, setFeats] = useState<Record<string, MapVersion>>({}), ids = places.map((p) => p.floor.approved_version_id).filter((x): x is string => !!x);
  useEffect(() => {
    for (const id of ids) if (feats[id] == null) api.version(id, cancel).then(shape(isVersion)).then((v) => setFeats((o) => ({ ...o, [id]: v })), () => {});
  }, [ids.join()]);
  return feats;
}

/** 만든 사람: 나는 내 이름, 총괄은 계정 목록(GET /users)에서. 모르면 줄을 숨긴다(U9) — 판 응답에는 사람 id 만 있다 */
function useNames(me: User, admin: boolean, cancel?: AbortSignal) {
  const [all, setAll] = useState<Record<string, string>>({});
  useEffect(() => { if (admin) api.users(cancel).then((l) => setAll(Object.fromEntries(l.map((u) => [u.id, u.display_name]))), () => {}); }, []);
  return (id: string) => all[id] ?? (id === me.id ? me.name : undefined);
}

/** 고른 층: 판 목록(GET /floors/{id}/map-versions) → 승인 판(또는 고른 옛 판) 그림, 보기/편집 토글(승인 판이 있을 때), 아래 접힌 «저장 기록»(옛 판 보기·비교·한때 승인된 판 되돌리기), 새 지도 올리기.
 *  저장·되돌리기는 누구나 바로 새 승인 판 — 서버가 아직 PENDING 으로 받으면 고르지 않고 승인 판을 그대로 보인다. told = 그때 배지 다시 받기 */
function FloorView({ p, sim, admin, names, cancel, again, told, top, toPick, side, name, scenN, head, hov, scenList, toScen, user, robots, places, open0, fix }: { p: Place; sim?: boolean; side?: ReactNode; user: User; robots: Robot[]; places: Place[]; open0: Intent; fix?: () => void; toPick?: () => void; toScen?: (scenario: string) => void; admin: boolean; names: (id: string) => string | undefined; cancel?: AbortSignal; again: () => void; told: () => void; top?: ReactNode; name: string;
  /** 시뮬 탭만 — 오른쪽 창 = 시나리오(지도 탭은 지도 요소만) */ scenN?: string; head?: ReactNode; hov?: Scenario | null; scenList?: ReactNode }) {
  const approved = p.floor.approved_version_id;
  const [got, setGot] = useState<{ key: string; list: MapVersion[] } | null>(null), [err, setErr] = useState(''), [n, setN] = useState(0), [sel, setSel] = useState('');
  const [back] = useState(() => (kept.d?.floor === p.floor.id ? kept.d.base : null));   // 폰 틀에서 돌아와 이어 쓰는 편집의 기준 판
  const [editing, setEditing] = useState<MapVersion | null>(back), [done, setDone] = useState<Msg>(null);   // editing = 편집 시작 때 승인 판(저장 기준)
  // 비교 보기, 되돌리기 칸(연 때의 옛 판·승인 판 — 답이 끊겨 목록을 다시 받는 동안에도 칸과 안내가 남게 목록 밖에 둔다)
  const [cmp, setCmp] = useState(false), [undo, setUndo] = useState<{ v: MapVersion; now: MapVersion } | null>(null);
  const [h9, setH9] = useState(open0 === 'history');   // 시안 u7_9 버전 기록 화면(지도 탭)
  // 목록은 받을 때의 기준(몇 번째 받기 + 승인 판 id)과 묶어 둔다 — 기준이 바뀌면 새 목록이 올 때까지 없음으로(늦게 온 옛 목록이 덮지 않게)
  const key = `${n}:${approved}`;
  useEffect(() => {
    let live = true;
    setErr('');
    api.versions(p.floor.id, cancel).then(shape((l: MapVersion[]) => l.every(isVersion))).then((l) => { if (live) setGot({ key, list: l }); }, (e: ApiFail) => {
      if (!live || e.code === 'CANCELED') return;
      setErr(e.status === 404 ? '이 층을 찾을 수 없습니다. 지워졌을 수 있어 장소 목록을 다시 받습니다.' : `저장 기록을 받지 못했습니다. ${e.message}`);
      if (e.status === 404) again();
    });
    return () => { live = false; };
  }, [key]);
  const list = got?.key === key ? got.list : null;
  const lastList = useRef<MapVersion[] | null>(null); if (list) lastList.current = list;   // u7_9 는 목록을 다시 받는 동안에도 그대로(되돌리기 칸 · 안내가 사라지지 않게)
  const hlist = list ?? lastList.current;
  const now = list?.find((v) => v.id === approved) ?? null, v = list?.find((x) => x.id === sel) ?? now;
  const lastNow = useRef<MapVersion | null>(null); if (now) lastNow.current = now;
  const hnow = now ?? lastNow.current;   // 다시 받는 동안(또는 승인 판이 아직 목록에 없을 때) u7_9 의 지금 판은 받은 마지막 값
  const title = `${p.site.name} ${p.building.name} ${p.floor.name}`;
  const reload = () => { setN(n + 1); again(); };
  /** 판 번호 대신 부르는 이름: 저장 시각 · 만든 사람(모르면 시각만, U9) */
  const savedAs = ({ id }: { id: string }) => { const x = list?.find((y) => y.id === id), who = x && names(x.created_by); return x ? `${day(x.created_at)}${who ? ` · ${who}` : ''}` : '이전 저장'; };
  const [up, setUp] = useState(open0 === 'file'), [pane, setPane] = useState(true), [slot, setSlot] = useState<HTMLElement | null>(null);   // 올리기 창·오른쪽 창·편집 저장 단추 자리
  const canUp = !!list && (!approved || !!now);   // 승인 판이 있으면 그 판의 요소를 받은 뒤에만 올리기(못 받은 채 올리면 접근 금지·감속 구역이 빈 채로 새 승인 판이 된다)
  const upBtn = (e?: { currentTarget: Element }) => { if (e) shut(e as never); setUp(true); };
  const keys = v ? featKeys(v.features) : [];
  // 다른 층에 남겨 둔 저장 안 한 편집(kept.d)이 있으면 새 편집이 그것을 비우기 전에 묻는다 — 취소하면 그 층을 열어 이어 쓸 수 있다
  const [drop, setDrop] = useState(false);
  const begin = () => { if (now && !vbusy) { setEditing(now); setSel(''); setDone(null); setCmp(false); setUndo(null); setUp(false); } };
  const start = () => { if (editing || !now) return; if (kept.d && kept.d.floor !== p.floor.id) setDrop(true); else begin(); };
  const fz = v?.features;
  // 3D 지도(RB-VOXEL-VIEW): 3D 파일에서 만든 판이면 «3D 로 보기»·«시뮬 지형 수정하기». vu = 올리기 창에서 3D 파일 고름(총괄만 — 서버 권한)
  // 로봇으로 만든 지도(RB-SLAM-WEB2): 저장 묶음(slam_bundle)이 있고 내가 그 로봇의 담당 운영자면 «3D 로 보기» = 저장된 3D 칸·2D 격자(서버 묶음 — 담당 운영자만 받음)
  const sb = v?.slam_bundle && makers(user, robots).some((r) => r.id === v.slam_bundle!.robot_id) ? v.slam_bundle : null;
  // 실내 3D 모형(W3 MAP3D): 판에 model_sha256 이 있으면 «2D / 3D»(null = 없음 · 거절 → 2D 만). 404 면 2D 로 + 서버 까닭 한 줄
  const model = modelOf(v), [m3, setM3] = useState(false), show3 = m3 && !!model && !editing && !cmp;
  const vox = voxelOf(v), [d3, setD3] = useState(false), [vu, setVu] = useState(false), [vbusy, setVbusy] = useState(false), on3d = d3 && (!!vox || !!sb) && !editing && !cmp;
  // 시뮬 탭(SIM-PAIR 11-09): 편집·새 지도 올리기·되돌리기 없음(지형 판은 «지형 만들기» 저장만 바꾼다), 짝 없는 시뮬 층은 안내.
  // 실기 장소 층(RB-SCEN-SIMTAB 11-11)은 지도 편집·올리기가 지도 탭 — 짝 없음 안내 대신 «시뮬 열기» 이유(«실기만»)
  const real = purposeOf(p.site) === 'REAL', bad = sim && !real && !!list && !err && lone(p.floor, now ?? undefined);
  // 로봇으로 지도 만들기(RB-SLAM-WEB): 실기 장소·사람 층, 내가 담당 운영자인 실기 로봇이 있을 때만(지도 탭만 — 시뮬 탭에 넣지 않음)
  const [mk, setMk] = useState(open0 === 'robot'), canMake = !sim && real && p.floor.provenance !== 'SIMULATION' && makers(user, robots).length > 0;
  const mkBtn = (e?: { currentTarget: Element }) => { if (e) shut(e as never); setMk(true); };
  // 지도 탭 층 화면 왼쪽 칸(시안 u7_3 · u7_4): 층 단추 · 보이기 · 이 지도 · 저장 기록. 받은 값만(점 수 · 보정 · 실사 표면 · 카메라 · 충전소 · 지나온 경로는 값 없음)
  const [lay, setLay] = useState<Layers>({ zones: true, waypoints: true, connectors: true, edits: true }), left = !sim && !editing;
  const bar = <div className="mx-bar">
      {top}{editing && side}
      {left && <b className="mp-ftitle">{p.building.name} · {p.floor.name}{now && <span className="lv-chip ok">{howMade(now)} · v{now.number}</span>}</b>}{/* 편집 중 층 바꾸기·나가기는 기존 «저장 안 한 편집» 확인으로(잠그지 않음) */}
      {sim && !editing && <SimOpen key={p.floor.id} f={p.floor} v={now} wait={!list && !err} real={real} cancel={cancel} />}
      {!sim && !real && !editing && <span className="lv-note" data-demo-ro>{SIM_SAVE}</span>}{/* 데모 현장(SIM): 편집 · 올리기 · 고치기 · 되돌리기 단추 없음 = 서버 409 를 부르지 않음 */}
      {now && !sim && real && <span className="mx-seg" role="group" aria-label="보기·편집">
        <button type="button" className="btn" aria-pressed={!editing} onClick={() => { if (!editing) return; if (leaving.ask) leaving.ask(() => setEditing(null)); else setEditing(null); }}>보기</button>
        <button type="button" className="btn" aria-pressed={!!editing} onClick={start}>편집</button></span>}
      {drop && !editing && <div className="fh-row" role="group" aria-label="확인" data-drop><span>다른 층에 저장하지 않은 지도 편집이 남아 있습니다. 이 지도를 편집하면 그 편집을 잃습니다(그 층을 열면 이어 씁니다).</span>
        <button type="button" className="btn pri" onClick={() => { kept.d = null; setDrop(false); begin(); }}>버리고 편집</button>
        <button type="button" className="btn" onClick={() => setDrop(false)}>취소</button></div>}
      {model && !editing && !on3d && <span className="mx-seg" role="group" aria-label="2D·3D">
        <button type="button" className="btn" aria-pressed={!show3} data-model-toggle="2D" onClick={() => setM3(false)}>2D</button>
        <button type="button" className="btn" aria-pressed={show3} data-model-toggle="3D" onClick={() => { setM3(true); setCmp(false); setDone(null); }}>3D</button></span>}
      {(vox || sb) && !editing && <button type="button" className="btn" aria-pressed={on3d} data-voxel-toggle onClick={() => { setD3(!on3d); setCmp(false); setM3(false); }}>{on3d ? '지도 보기' : '3D 로 보기'}</button>}
      {editing && <span className="mx-tag mx-edit" data-editing>▲ 편집 중</span>}
      <span className="fh-grow" />
      {left && toScen && !inApp() && <button type="button" className="btn pri" data-to-sim onClick={() => toScen('')}>이 지도로 모의 실행</button>}
      {!editing && <Menu label={<span aria-hidden="true">···</span>} title="더 보기" end className="more">
        {!sim && real && <button type="button" className="btn" onClick={upBtn}>새 지도 올리기…</button>}
        {canMake && <button type="button" className="btn" data-make-open onClick={mkBtn}>지도 만들기</button>}
        {fix && (sim || real) && <button type="button" className="btn" data-fix-open onClick={(e) => { shut(e); fix(); }}>이름 바꾸기·삭제…</button>}
        <TrashLink />
      </Menu>}
      <span ref={setSlot} style={{ display: 'contents' }} />
    </div>;
  const main = editing ? <Editor v={editing} p={p} cancel={cancel} slot={slot} pick={(m) => <SideTitle n={m} />} name={name} toScen={toScen} quit={() => setEditing(null)} recheck={reload} moved={!!back && editing === back && !!list && now?.id !== back.id}
        saved={(x) => { setEditing(null); if (x.status === 'PENDING') { setSel(''); setDone(asked); told(); }
          else { setSel(x.id); setDone({ ...SAVED, text: `v${x.number} 로 저장됨 · ${SAVED!.text}` }); } reload(); }} />
    : <div className="mx-body">
      <div className="mx-map">
        {v && cmp ? <div className="mx-scroll"><Compare key={v.id} v={v} list={list!} name={savedAs} cancel={cancel} gone={() => { setCmp(false); setDone({ text: '비교할 기록을 찾을 수 없습니다. 지워졌을 수 있어 저장 기록을 다시 받았습니다.' }); reload(); }} />
            <div className="fh-row"><button type="button" className="btn" onClick={() => setCmp(false)}>비교 닫기</button></div></div>
          : v && show3 && !on3d ? <Map3D key={v.id} v={v} robots={robots} missing={(why) => { setM3(false); setDone({ text: `${why || '이 층은 3D 모형이 없습니다.'} 2D 지도로 봅니다.` }); }} />
          : v && on3d ? (vox ? <VoxelView key={v.id} v={v} cancel={cancel} /> : <SlamSavedView key={v.id} robot={sb!.robot_id} session={sb!.session_id} cancel={cancel} />)
          : v ? <MapView key={v.id} v={v} fill terrain={!!p.floor.terrain_id} show={left ? lay : undefined} demo={!sim && demoBoard(p.site, p.building)}>{hov && <Route v={v} x={hov} floor={p.floor.id} />}</MapView>
          : list && !err && (sim ? <div className="mx-center">{real ? <p className="lv-note">아직 지도가 없습니다. 실기 지도는 «지도» 탭에서 올립니다.</p> : LONE}</div> : <div className="mx-center">
            {/* 층에 지도 0 개(U11-04 빈 화면): 다음 할 일 하나 = 올리기. «지도 만들기»는 ··· 메뉴에 그대로 */}
            <Empty kind="floor" title="이 층에 아직 지도가 없습니다" why="지도 파일(그림 · yaml)을 올리면 이 층 지도가 됩니다." card={false}>
              <button type="button" className="btn pri" disabled={!canUp} onClick={() => upBtn()}>새 지도 올리기…</button></Empty></div>)}
        <div className="mx-over">
          {done && <Note m={done} />}
          {bad && v && LONE}
          {v && v.id !== approved && <div className="fh-row" data-old-save><p className="lv-note fh-grow" role="status">{v.status === 'PENDING' ? '적용되지 않은 저장 기록을 보는 중입니다. 실행에는 이 기록을 쓰지 않습니다.' : '지난 저장 기록을 보는 중입니다.'}</p>
            {now && <button type="button" className="btn" onClick={() => { setSel(''); setUndo(null); }}>지금 지도 보기</button>}</div>}
          {err && <div className="fh-row"><p className="fh-msg" role="alert">{err}</p><button type="button" className="btn" onClick={() => setN(n + 1)}>다시 시도</button></div>}
          {!list && !err && <p className="lv-note" role="status">지도를 불러오는 중…</p>}
        </div>
        {v && !cmp && !on3d && !show3 && <Hint text={now && !sim && real ? '보기만. «편집»을 누르면 도구가 나옵니다' : '보기만'} more={`휠·두 손가락으로 확대, 끌어서 옮깁니다.${sim ? (real ? ' 구역·벽은 «지도» 탭에서 고칩니다.' : '') : real ? ' 구역·벽은 «편집»에서 고칩니다.' : ''}`} />}
      </div>
      {/* 오른쪽 창: 지도 탭 = 지도 요소 N, 시뮬 탭 = 시나리오 N(RB-SIM-NO-MAPEL 11-18 — 지도 요소는 지도 탭) */}
      {!cmp && <Pane open={pane} setOpen={setPane} bar={sim ? `시나리오 ${scenN}` : `요소 ${keys.length}`} label={sim ? '시나리오 창' : '요소 창'} pick={sim ? head : <SideTitle n={keys.length} />} name={name}>
        {sim ? scenList : <>
          {!v ? <p className="lv-note mx-in">{list ? '이 층에는 아직 지도가 없습니다.' : '지도를 불러오는 중…'}</p> : <>
            <div className="mx-in" aria-label="지도 요약" data-summary><b>지도 요약</b>
              <div className="mx-sum"><span><b>{fz!.zones.length}</b>구역</span><span><b>{fz!.waypoints.length}</b>지점</span><span><b>{fz!.connectors.length}</b>연결점</span><span><b>{fz!.edits.length}</b>고친 선</span></div></div>
            {keys.length ? <ul className="mx-list" aria-label="요소 목록">{keys.map((k) => <li key={k} className="mx-row" data-el={k}><span className="mx-name"><Glyph f={v.features} k={k} /><b>{featName(v.features, k)}</b><small>{featSub(v.features, k, p.building.floors)}</small></span></li>)}</ul>
              : <div className="mx-in"><div className="mx-empty"><p className="lv-note">이 지도에는 구역·벽이 없습니다.</p>{now && v.id === now.id && <button type="button" className="btn pri" onClick={start}>편집 시작</button>}</div></div>}
            {now && real && !!keys.length && <p className="lv-note mx-in">구역·벽은 «편집»에서 고칩니다.</p>}
            {vox && <div className="mx-in" data-voxel-summary><b>3D 지도 <span className="lv-chip">3D</span></b>
              <p className="lv-note">3D 지도 파일에서 만든 지도입니다. 연결된 시뮬 지형이 함께 만들어졌습니다.</p>
              <div className="fh-row">{!editing && <button type="button" className="btn" onClick={() => { setD3(!on3d); setCmp(false); }}>{on3d ? '지도 보기' : '3D 로 보기'}</button>}<TerrainLink id={vox.terrain_id} /></div></div>}</>}
        </>}
      </Pane>}
    </div>;
  // 저장 기록(11-04, 기본 닫힘 · 고르기 화면 «버전 기록»으로 열면 펼침): 줄을 누르면 그 기록을 지도에 — 판 번호 대신 저장 시각·만든 사람
  // 되돌리기 확인 = 시안 u7_9 안 칸(옛 «이 기록으로 되돌리기» 창 없음)
  const rollForm = undo && <Rollback key={undo.v.id} v={undo.v} name={savedAs(undo.v)} cancel={cancel} now={undo.now} close={() => setUndo(null)} reload={reload}
        done={(x) => { setUndo(null); setCmp(false); setH9(false); if (x.status === 'PENDING') { setSel(''); setDone(asked); told(); }
          else { setSel(x.id); setDone({ text: `${savedAs(undo.v)} 기록으로 되돌렸습니다. 다음 실행부터 이 지도를 씁니다.`, ok: true }); } reload(); }} />;
  // 새 지도 올리기 = 시안 u7 틀 안 칸(옛 «새 지도 올리기» 창 없음)
  const upScreen = <UploadScreen label="새 지도 올리기" place={p} back={() => setUp(false)} lock={vbusy}>
      {admin && <span className="mx-seg" role="group" aria-label="올릴 파일" data-up-kind><button type="button" className="btn" aria-pressed={!vu} disabled={vbusy} onClick={() => setVu(false)}>그림·yaml</button>
        <button type="button" className="btn" aria-pressed={vu} disabled={vbusy} onClick={() => setVu(true)}>3D 지도 파일(.pcd·.ply)</button></span>}
      {admin && vu ? up && <VoxelUpload floor={p.floor.id} base={approved} had={!!approved} title={`${p.building.name} ${p.floor.name}`} ready={canUp} cancel={cancel}
          made={() => { setSel(''); setDone({ text: '3D 지도로 지도와 시뮬 지형을 만들었습니다.', ok: true }); setN(n + 1); again(); }}
          go={(how) => { setUp(false); setD3(how === '3d'); }} again={() => { setN(n + 1); again(); }} onBusy={setVbusy} />
      : <Upload floor={p.floor.id} base={approved} keep={now?.features ?? null} ready={canUp} cancel={cancel}
        saved={(x) => { setUp(false); if (x.status === 'PENDING') { setDone(asked); told(); } else { setSel(x.id); setDone(SAVED); } setN(n + 1); again(); }} again={() => { setN(n + 1); again(); }} />}
  </UploadScreen>;
  const hist = !editing && !!list?.length && <details className="fh-fold mx-hist" data-history open={open0 === 'history' || undefined}><summary>저장 기록 {list.length}</summary>
      <ul className="mx-list" aria-label="저장 기록 목록">{list.map((x) => <li key={x.id} className="mx-row" data-save={x.id}>
        <button type="button" className="mx-name" aria-pressed={x.id === v?.id} onClick={() => { setSel(x.id); setUndo(null); }}><b>{savedAs(x)}</b><small>{x.reason}</small>{voxelOf(x) && <span className="lv-chip">3D</span>}{x.source === 'SLAM' && <span className="lv-chip" data-slam-chip>로봇으로 만든 지도</span>}<Chip {...stateOf(x, approved)} /></button></li>)}</ul>
      {v && <div className="fh-row" role="group" aria-label="저장 기록 관리">
        <button type="button" className="btn" aria-pressed={cmp} onClick={() => setCmp(!cmp)}>비교</button>
        {/* 한때 승인된 판(SUPERSEDED)만. 저장하지 않은 편집이 남아 있으면 그 확인부터 */}
        {now && !sim && real && v.status === 'SUPERSEDED' && <button type="button" className="btn" aria-pressed={!!undo} onClick={() => { const go = () => { setUndo({ v, now }); setDone(null); setCmp(false); setH9(true); }; if (leaving.ask) leaving.ask(go); else go(); }}>이 기록으로 되돌리기</button>}
      </div>}
    </details>;
  const LAY: [keyof Layers, string, string][] = [['zones', '구역 (접근 금지 · 감속)', 'var(--bad)'], ['waypoints', '지점', 'var(--accent)'], ['connectors', '연결점 (계단 · 엘리베이터)', 'var(--warn)'], ['edits', '벽 · 지운 선', 'var(--muted)']];
  const who = now && names(now.created_by);
  const panel = left && <aside className="lv-card mp-fside" aria-label="지도 정보" data-map-side>
    {side && <div className="mp-fseg">{side}</div>}
    {v && !show3 && !on3d && !cmp && <div role="group" aria-label="보이기" className="mp-lay"><p className="lbl">보이기</p>
      {LAY.map(([k, t, c]) => <label key={k} className="mp-tog" data-map-layer={k}><i style={{ background: c }} aria-hidden="true" /><span className="fh-grow">{t}</span>
        <input type="checkbox" role="switch" checked={lay[k]} onChange={() => setLay({ ...lay, [k]: !lay[k] })} /></label>)}</div>}
    {v && <div aria-label="이 지도" className="mp-kv"><p className="lbl">이 지도</p><dl>
      <dt>저장</dt><dd>{md(v.created_at)} · v{v.number}</dd>
      <dt>만든 방법</dt><dd>{howMade(v)}</dd>
      <dt>넓이</dt><dd>{meters(v).area} · {meters(v).wh}</dd>
      <dt>해상도</dt><dd>{v.resolution} m / 칸</dd>
      <dt>3D 모형</dt><dd>{model ? '있음' : '없음'}</dd>
      {who && <><dt>만든 사람</dt><dd>{who}</dd></>}</dl></div>}
    <span className="fh-grow" />
    {!!list?.length && now && <button type="button" className="btn" data-open-u79 onClick={() => { setCmp(false); setH9(true); }}>버전 기록 · 비교 · 되돌리기</button>}
  </aside>;
  return <section className="mx" aria-label="지도 보기">
    <h2 className="mx-sr">{title}{editing ? ' · 편집 중' : ''}</h2>
    {/* 지도 만들기 = 시안 u7_6 · u7_7 · u7_8 (옛 창 없음) */}
    {left && up && real ? upScreen
      : left && canMake && mk ? <ScanScreen place={p} back={() => setMk(false)} toList={() => { setMk(false); toPick?.(); }}
      a={{ floor: p.floor.id, approved, list, user, robots, places, cancel, made: (id, text) => { setMk(false); setSel(id); setCmp(false); setD3(false); setDone({ text, ok: true }); setN(n + 1); again(); } }} />
      : left && h9 && hlist && hnow ? <History p={p} list={hlist} now={hnow} names={names} real={real} cancel={cancel} back={() => { setH9(false); setUndo(null); }} gone={reload} form={rollForm}
        restore={(x) => { const go = () => { setUndo({ v: x, now: hnow! }); setDone(null); setH9(true); }; if (leaving.ask) leaving.ask(go); else go(); }} />
      : editing ? main   /* 편집 = 시안 u7_5 화면(머리줄 · 저장은 Editor 안) */
      : left ? <div className="mp-fl">{panel}<div className="mp-fr">{bar}{main}</div></div> : <>{bar}{main}{hist}</>}
  </section>;
}

const IMAGE_MAX = 8 * 1024 * 1024, YAML_MAX = 16 * 1024;   // 서버 상한(apps/server README S3a) — 넘으면 보내기 전에 알린다
const TOO_BIG = '파일이 너무 큽니다. 지도 그림은 8 MB, 지도 설정(yaml)은 16 KB 까지 올릴 수 있습니다.';
const STALE = '다른 사람이 먼저 이 층의 지도를 바꿨습니다. 새로 불러온 뒤 다시 올리세요.';
const imageType = (f: File) => (/\.pgm$/i.test(f.name) ? 'image/x-portable-graymap' : /\.png$/i.test(f.name) ? 'image/png' : '');
/** 올리기 실패 = 어느 단계에서 + 어떻게. 서버의 형식 오류 문구(파일 내부 용어)는 쉬운 말로 바꾸고, 403 등은 서버 문구 그대로 */
function upFail(e: ApiFail, step: number) {
  if (e.code === 'UPLOAD_TOO_LARGE') return TOO_BIG;
  if (e.code === 'STALE') return STALE;
  if (e.code === 'INVALID_FEATURES') return '지금 지도의 구역·지점·연결점 중 새 지도 범위 밖에 있는 것이 있습니다. «지금 지도의 구역·지점·연결점 그대로 두기»를 끄고 다시 올리세요.';
  if (e.code === 'INVALID_UPLOAD') return step === 0 ? '지도 그림 파일을 읽을 수 없습니다. 지도를 만들 때 저장한 pgm·png 파일인지, 가로·세로 4096 픽셀 이하인지 확인하세요.'
    : step === 1 ? '지도 설정 파일을 읽을 수 없습니다. 그림과 함께 저장된 yaml 파일인지 확인하세요.' : '올린 파일을 지도로 쓸 수 없습니다. 두 파일을 다시 골라 올리세요.';
  if (e.status === 404) return '이 층을 찾을 수 없습니다. 지워졌을 수 있어 새로 불러오세요.';
  if (e.status === 408 || e.code === 'TIMEOUT') return '파일을 보내는 데 시간이 너무 오래 걸렸습니다. 네트워크를 확인한 뒤 다시 올리세요.';
  if (e.code === 'SERVER_BUSY') return '서버가 지금 다른 지도를 처리하고 있습니다. 잠시 뒤 다시 올리세요.';   // 변환 칸이 차면 대기 없이 503(05 §1.4)
  return e.message;   // 다른 503(FILE_STORAGE_FULL·FILE_STORAGE_ERROR 등)은 서버의 원인 문구 그대로
}

/** 새 지도 올리기(MP-02 의 파일 올리기): 그림 → 그 ID 로 yaml → 판 저장. 앞 단계가 실패하면 다음 단계를 보내지 않는다.
 *  base = 지금 승인 판(다르면 서버가 409 STALE). keep = 지금 판의 구역·지점·연결점(벽 고침 선은 옛 그림 것이라 빼고) */
function Upload({ floor, base, keep, ready, cancel, saved, again }: { floor: string; base: string | null; keep: MapFeatures | null; ready: boolean; cancel?: AbortSignal; saved: (v: MapVersion) => void; again: () => void }) {
  const [img, setImg] = useState<File | null>(null), [yml, setYml] = useState<File | null>(null), [reason, setReason] = useState(''), [hold, setHold] = useState(true);
  const [step, setStep] = useState(''), [msg, setMsg] = useState<Msg>(null), [stale, setStale] = useState(false), [fresh, setFresh] = useState(0);   // fresh = 저장 뒤 파일 칸 비우기
  const go = async (e: FormEvent) => {
    e.preventDefault();
    if (step || !ready) return;
    setStale(false);
    const type = img && imageType(img);
    if (!img || !yml) return setMsg({ text: '지도 그림(pgm·png)과 지도 설정(yaml) 파일을 모두 고르세요.' });
    if (!type) return setMsg({ text: '지도 그림은 pgm 또는 png 파일이어야 합니다.' });
    if (!/\.ya?ml$/i.test(yml.name)) return setMsg({ text: '지도 설정은 yaml 파일이어야 합니다.' });
    if (img.size > IMAGE_MAX || yml.size > YAML_MAX) return setMsg({ text: TOO_BIG });
    const why = reasonBad(reason, '바꾼 이유');
    if (why) return setMsg({ text: why });
    setMsg(null);
    let at = 0;
    try {
      setStep('지도 그림을 올리는 중…');
      const a = await api.upload(img, type, undefined, cancel).then(shape(isUpload));
      at = 1; setStep('지도 설정을 올리는 중…');
      const b = await api.upload(yml, 'text/yaml', a.upload_id, cancel).then(shape(isUpload));
      at = 2; setStep('저장하는 중…');
      const features: MapFeatures = hold && keep ? { zones: keep.zones, waypoints: keep.waypoints, connectors: keep.connectors, edits: [] } : { zones: [], waypoints: [], connectors: [], edits: [] };
      const v = await api.saveVersion(floor, { base_version_id: base, image: b.upload_id, features, reason: reason.trim() }, cancel).then(shape(isVersion));   // 빈·어긋난 201 = 저장 불확실(status 0)
      setMsg(v.status === 'PENDING' ? asked : SAVED); setImg(null); setYml(null); setReason(''); setFresh(fresh + 1);
      saved(v);
    } catch (x) {
      const f = x as ApiFail;
      if (f.code === 'CANCELED') return;
      // 저장 요청을 보낸 뒤 답이 끊기면(헤더 전·본문 중·마감·깨진 본문) 저장됐을 수도 있다 — 목록을 다시 받아 보여 주고 같은 파일을 두 번 올리지 않게 알린다
      if (at === 2 && f.status === 0) { setMsg({ text: '저장 응답을 받지 못했습니다. 저장됐을 수 있어 저장 기록을 다시 받습니다. 새 기록이 보이면 다시 올리지 마세요.' }); again(); return; }
      setMsg({ text: `올리지 못했습니다. ${upFail(f, at)}` }); setStale(f.code === 'STALE' || f.status === 404);
    } finally { setStep(''); }
  };
  return <form className="fh-form" onSubmit={go} noValidate aria-label="새 지도 올리기" key={fresh}>
    <label className="fh-field"><span>지도 그림(pgm·png)</span><input type="file" className="inp" accept=".pgm,.png" onChange={(e) => setImg(e.target.files?.[0] ?? null)} /></label>
    <label className="fh-field"><span>지도 설정(yaml)</span><input type="file" className="inp" accept=".yaml,.yml" onChange={(e) => setYml(e.target.files?.[0] ?? null)} /></label>
    <label className="fh-field"><span>바꾼 이유</span><input className="inp" maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
    {keep && <label className="fh-row"><input type="checkbox" checked={hold} onChange={(e) => setHold(e.target.checked)} /><span>지금 지도의 구역·지점·연결점 그대로 두기</span></label>}
    {keep && !hold && <p className="fh-msg" role="alert">끄면 접근 금지·감속 구역, 지점, 연결점이 모두 빠진 새 지도가 됩니다.</p>}
    {!ready && !step && <p className="lv-note" role="status">지금 지도의 구역·지점·연결점을 받은 뒤에 올릴 수 있습니다.</p>}
    <div className="fh-row"><button type="submit" className="btn pri" disabled={!!step || !ready}>올리기</button>{stale && <button type="button" className="btn" onClick={() => { setStale(false); setMsg(null); again(); }}>새로 불러오기</button>}</div>
    {step && <p className="lv-note" role="status">{step}</p>}
    <Note m={msg} />
  </form>;
}

/** 전체(층 겹쳐 보기): 건물 각 층 승인 판의 벽만 층 색으로 첫 판 위에 겹친다 — 판마다 origin·해상도가 달라도 지도 좌표로 맞춤. 보기만(편집은 한 층을 골랐을 때) */
function AllFloors({ b, top, cancel }: { b: MapBuilding; top: ReactNode; cancel?: AbortSignal }) {
  const [got, setGot] = useState<Record<string, MapVersion | 'bad'>>({}), ids = b.floors.map((f) => f.approved_version_id ?? '');
  useEffect(() => {
    let live = true;
    for (const id of ids) if (id) api.version(id, cancel).then(shape(isVersion)).then((v) => { if (live) setGot((o) => ({ ...o, [id]: v })); },
      (e: ApiFail) => { if (live && e.code !== 'CANCELED') setGot((o) => ({ ...o, [id]: 'bad' })); });
    return () => { live = false; };
  }, [ids.join()]);
  const rows = b.floors.map((f, i) => ({ f, i, v: got[ids[i]] })), shown = rows.flatMap((r) => (r.v && r.v !== 'bad' ? [{ ...r, v: r.v }] : []));
  const base = shown[0]?.v, look = useMemo(() => {
    if (!base) return null;
    const xs: number[] = [], ys: number[] = [];
    for (const { v } of shown) { const [a, bb, c, d, e, f] = pixelTo(v, base); for (const [x, y] of [[0, 0], [v.width, 0], [0, v.height], [v.width, v.height]]) { xs.push(a * x + c * y + e); ys.push(bb * x + d * y + f); } }
    const full: Box = [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
    return { full, res: base.resolution };
  }, [shown.map((r) => r.v.id).join()]);
  return <section className="mx" aria-label="지도 보기" data-all-floors>
    <h2 className="mx-sr">{b.name} · 전체 층 겹쳐 보기</h2>
    <div className="mx-bar">{top}<span className="mx-tag">보기만</span></div>
    <div className="mx-body"><div className="mx-map">
      {look && base ? <MapFrame {...look} at={{ right: 8, bottom: 8, alignItems: 'flex-end' }} role="img" aria-label={`${b.name} 전체 층 지도`} data-map style={{ display: 'block', width: '100%', height: '100%' }}>
        {shown.map(({ v, i }) => <MapImage key={v.id} id={v.id} width={v.width} height={v.height} tint={fillOf(i)} transform={`matrix(${pixelTo(v, base).join(' ')})`} data-layer={i} />)}
      </MapFrame> : <div className="mx-center"><p className="lv-note" role="status">{rows.some((r) => ids[r.i] && !r.v) ? '지도를 불러오는 중…' : '겹쳐 볼 승인 지도가 없습니다.'}</p></div>}
      <ul className="mx-legend" aria-label="범례" data-legend>{rows.map(({ f, i, v }) => <li key={f.id} className="fh-row">
        <span aria-hidden="true" style={{ width: 14, height: 14, borderRadius: 3, background: fillOf(i) }} /><span>{f.name}</span>
        {!ids[i] ? <span className="lbl">지도 없음</span> : v === 'bad' ? <span className="fh-why">받지 못함</span> : null}</li>)}</ul>
      <Hint text="보기만 합니다. 편집은 위에서 한 층을 고르세요." more="건물 각 층 지도의 벽만 층 색으로 겹칩니다." />
    </div></div>
  </section>;
}

/** 관제 지도 칸(FL-03): 층 단추 + 그 층 승인 판 그림. 로봇 점은 위치에 판이 묶이면(D5) — 지금은 그리지 않는다(지어내지 않음) */
export function FloorMap({ cancel }: { cancel?: AbortSignal }) {
  const t = useTree(cancel), places = floorsOf(t.tree), [pick, setPick] = useState('');
  const cur = places.find((p) => p.floor.id === pick) ?? places.find((p) => p.floor.approved_version_id) ?? places[0];
  const many = new Set(places.map((p) => p.building.id)).size > 1;
  return <>
    {places.length > 0 && <div className="fh-row" role="group" aria-label="층">{places.map((p) => <button key={p.floor.id} type="button" className="btn" aria-pressed={p === cur} onClick={() => setPick(p.floor.id)}>
      {many ? `${p.building.name} ${p.floor.name}` : p.floor.name}</button>)}</div>}
    {cur?.floor.approved_version_id ? <Approved key={cur.floor.approved_version_id} id={cur.floor.approved_version_id} cancel={cancel} />
      : cur ? <p className="lv-note">아직 지도가 없습니다.</p>
      : t.tree && <p className="lv-note">등록된 층이 없습니다. 지도 탭에서 장소·층을 만들면 여기에 보입니다.</p>}
    {t.err && <div className="fh-row"><p className="fh-msg" role="alert">층 목록을 받지 못했습니다. {t.err}</p><button type="button" className="btn" onClick={t.again}>다시 시도</button></div>}
    {!t.tree && !t.err && <p className="lv-note" role="status">층 목록을 불러오는 중…</p>}
  </>;
}

function Approved({ id, cancel }: { id: string; cancel?: AbortSignal }) {
  const [v, setV] = useState<MapVersion | null>(null), [err, setErr] = useState(''), [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    api.version(id, cancel).then(shape(isVersion)).then((x) => { if (live) { setV(x); setErr(''); } }, (e: ApiFail) => { if (live && e.code !== 'CANCELED') setErr(e.message); });
    return () => { live = false; };
  }, [n]);
  if (v) return <MapView v={v} />;
  return err ? <div className="fh-row"><p className="fh-msg" role="alert">지도를 받지 못했습니다. {err}</p><button type="button" className="btn" onClick={() => setN(n + 1)}>다시 시도</button></div>
    : <p className="lv-note" role="status">지도를 불러오는 중…</p>;
}
