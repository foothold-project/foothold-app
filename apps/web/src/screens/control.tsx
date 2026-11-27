// 관제 탭(W1 · U5 · 시안 u5_1_tiles · u5_3_map · u5_4_flipped · u5_5_alarm · u5_6_operator). 화면만: 새 API 0, 명령·STOP·조종권 경로 0.
// 모든 로봇을 같은 크기 타일로(U5-05) · 경고 타일이 맨 앞 + 테두리 색(U5-09). 한 번 누름 = 작은 지도에서 강조(U5-08), 두 번 = 로봇 탭(U5-07). 타일 ↔ 지도 보기(U5-02).
// 타일 영상 칸: 로봇별 영상 흐름이 화면에 없어 3D Go2 를 지금 상태대로 그린다(팀장 규칙 · 로봇 보고 자세가 있으면 그대로, 없으면 상태로: 임무·조종 중 = 걷기, 잠금·오류·끊김 = 엎드림, 그 밖 = 서 있음).
// 뒤집기 = Go2 정면 상태(관절 온도·자세 값, U5-11), 시뮬 로봇은 정면 상태만(U5-12). 값이 없는 칸은 접는다 · 지어낸 숫자 0.
// 총괄·운영 관리자 같은 틀, 운영 관리자는 «내 로봇» 거르기가 기본(U5-16). 경보 한 장(U5-19)은 받은 로봇 상태·주의 코드에서.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Location, MapVersion } from '../../../contracts/ts';
import { api, type ApiFail } from '../api';
import { lost, ownerName, robotStatus, type Robot, type Tone } from '../fake';
import { rt, useRt } from '../rt';
import { Guard } from '../App';
import { Go2Figure, JOINTS, REPORT_STALE_MS, go2Pose, type Pose } from '../go2model';
import { FallChip } from '../go2status';
import { MapFrame, MapImage } from '../mapframe';
import { Shapes, floorName, floorsOf, isVersion, shape, toPixel, useFit, useTree, type Place } from './maps';
import { Chip, attn, pct, type Ctx } from '../screens';
import '../pcdrive.css';
import './control.css';

const RANK: Record<Tone, number> = { bad: 0, warn: 1, ok: 2, off: 3 };
/** 서버 주의 코드 중 상태 칩이 이미 말하지 않는 것(끊김·잠금·오류·칩과 같은 글은 뺌). 한 번도 연결된 적 없는 로봇의 OFFLINE 은 칩 «연결 전»이 말한다 */
const rest = (x: Robot) => attn(x, ['OFFLINE', 'STOP_LATCHED', 'ERROR']).split(' · ').filter((a) => a && a !== robotStatus(x).text);
/** 주의가 필요한 로봇 = 상태가 빨강·주황이거나, 칩이 말하지 않는 서버 주의 코드가 남음. 연결 전(칩 회색)만이면 경고 아님 */
export const needs = (x: Robot) => { const t = robotStatus(x).tone; return t === 'bad' || t === 'warn' || rest(x).length > 0; };
/** 경고 타일 맨 앞(빨강 → 주황 → 주의 코드만), 그 밖은 받은 순서 그대로 */
export function order(list: Robot[]) {
  const k = (x: Robot) => (needs(x) ? Math.min(RANK[robotStatus(x).tone], 1.5) : 9);
  return list.map((x, i) => [x, i] as const).sort((a, b) => k(a[0]) - k(b[0]) || a[1] - b[1]).map(([x]) => x);
}
/** 경고 한 줄: 칩이 말하지 않는 주의 코드 글, 없으면 상태 글(needs 인 로봇에만 쓴다) */
const why = (x: Robot) => rest(x).join(' · ') || robotStatus(x).text;
/** 타일 머리표 덧말: 남은 주의 코드만. 한 타일에서 같은 낱말은 한 번 */
export const flagNote = (x: Robot) => rest(x).join(' · ');
/** 끊긴 로봇(서버 실시간 끊김 또는 한 번 받은 로봇의 연결 끊김): 값은 마지막 값 */
export const isLost = (x: Robot) => x.unknown === 'link' || lost(x);
/** 마지막 값 표시: 끊긴 로봇이면 «마지막 값 · HH:MM»(시각을 모르면 null = 미확인), 아니면 값 그대로 */
export function lastly(x: Robot, v: string | null, at?: string | null): string | null {
  if (v == null || !isLost(x)) return v;
  const hm = at ? /(\d\d:\d\d)/.exec(at.includes('T') ? new Date(at).toTimeString() : at)?.[1] : null;
  return hm ? `마지막 ${v} · ${hm}` : null;
}
/** 화면이 아는 위치(구독 로봇 = 실시간 state, 아니면 목록 요약. 남의 로봇 요약은 서버가 감춤) */
const where = (x: Robot): Location | null => (x.unknown === 'summary' ? null : rt.get(x.id).state?.location ?? x.location ?? null);
/** 관절 온도 12개(JOINTS 순서) · 연결 중인 실기의 robot_info.temperature 만. 없으면 null */
export function temps(x: Robot): (number | null)[] | null {
  const t = x.online && !x.unknown ? x.robotInfo?.temperature?.joints : null;
  return t && t.length === 12 ? t.map((c) => (c != null && Number.isFinite(c) ? c : null)) : null;
}
export const hottest = (x: Robot) => { const t = temps(x)?.filter((c): c is number => c != null); return t?.length ? Math.max(...t) : null; };
/** 임무 글 «이름 n/m» → 이름 · 진행 */
const missionOf = (m?: string) => { const g = m ? /^(.*) (\d+)\/(\d+)$/.exec(m) : null; return g ? { name: g[1], done: +g[2], total: +g[3] } : m ? { name: m, done: 0, total: 0 } : null; };

/** 3D 로 그릴 동작(로봇 보고 자세가 없을 때만 씀) */
type Act = 'report' | 'walk' | 'lie' | 'stand' | 'lost' | 'unknown';
export function actOf(x: Robot, reported: boolean): Act {
  if (reported) return 'report';
  if (isLost(x)) return 'lost';   // 끊김: 지금 자세를 단정하지 않는다(흐리게 · 기본 자세 고정)
  if (x.unknown || !x.online) return 'unknown';
  if (x.status === 'STOP_LATCHED' || x.status === 'ERROR') return 'lie';
  if (x.status === 'RUNNING' || x.status === 'TELEOP') return 'walk';
  return 'stand';
}
const ACT_TEXT: Record<Act, string> = { report: '로봇 보고 자세', walk: '상태 그림 · 걷는 중', lie: '상태 그림 · 엎드림', stand: '상태 그림 · 서 있음', lost: '마지막 자세 모름', unknown: '상태 모름' };
/** 상태 그림 자세(보고 자세가 아님 · 관절 값 글자·온도 점을 띄우지 않는다). 걷기 = 대각 다리 한 쌍씩(트롯) */
const LIE = JOINTS.map((n) => (n.includes('hip') ? 0 : n.includes('thigh') ? 1.25 : -2.6));
function walkPose(ph: number): Pose {
  return { wxyz: [1, 0, 0, 0], q: JOINTS.map((n) => {
    const leg = n.slice(0, 2), s = Math.sin(ph + (leg === 'FR' || leg === 'RL' ? 0 : Math.PI));
    return n.includes('hip') ? (n[1] === 'R' ? -0.1 : 0.1) : n.includes('thigh') ? (n.startsWith('F') ? 0.8 : 1) + 0.25 * s : -1.5 - 0.35 * Math.max(0, s);
  }) };
}

/** 화면에 보일 때만 3D 를 그린다(WebGL 칸 수 제한 · 20대여도 보이는 타일만 그리개를 연다). 관찰기가 없는 환경이면 늘 보임 */
function useShown<T extends Element>() {
  const ref = useRef<T>(null), [on, setOn] = useState(typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined' || !ref.current) return;
    const io = new IntersectionObserver((es) => setOn(es[es.length - 1].isIntersecting), { rootMargin: '120px' });
    io.observe(ref.current); return () => io.disconnect();
  }, []);
  return [ref, on] as const;
}

/** 타일 그림 칸: front = 정면 상태(관절 온도·보고 자세 값), 아니면 지금 동작 그림 */
function Figure({ x, front }: { x: Robot; front: boolean }) {
  useRt();
  const l = rt.get(x.id), pose = go2Pose(l.state, rt.now() - l.stateAt <= REPORT_STALE_MS), act = actOf(x, !!pose);
  const [ph, setPh] = useState(0);
  useEffect(() => { if (act !== 'walk') return; const i = setInterval(() => setPh((p) => p + 0.7), 120); return () => clearInterval(i); }, [act]);
  const shown = pose ?? (act === 'walk' ? walkPose(ph) : act === 'lie' ? { q: LIE, wxyz: [1, 0, 0, 0] } : null);
  const t = front ? temps(x) : null;
  // 상태 그림은 보고 값이 아니라 그림 안 설명을 덮어 쓴다(aria-hidden + 글 한 줄)
  return <div className="ct-fig" data-act={act} data-dim={act === 'unknown' || act === 'lost' || undefined} data-dots={t ? '' : undefined}>
    <div aria-hidden={!pose && !t ? true : undefined}><Go2Figure pose={shown} showJoints={front && !!pose} temps={t} /></div>
    <span className="ct-badge ct-act" data-act-text>{ACT_TEXT[act]}</span>
  </div>;
}

function Tile({ x, sel, front, sim, pick, open, flip }: { x: Robot; sel: boolean; front: boolean; sim: boolean; pick: () => void; open: () => void; flip: () => void }) {
  const st = robotStatus(x), warn = needs(x), m = missionOf(x.mission), hot = hottest(x), loc = where(x), [ref, on] = useShown<HTMLDivElement>();
  const tone = warn ? (st.tone === 'bad' ? 'bad' : 'warn') : undefined, note = flagNote(x);
  const place = loc && loc.x != null && loc.y != null ? lastly(x, `위치 ${loc.x.toFixed(1)}, ${loc.y.toFixed(1)} m`, loc.updated_at || x.seenAt) : null;
  // Enter = 로봇 탭(두 번 누름과 같음). Space 는 전역 STOP 이라 여기서 받지 않는다. 안쪽 단추의 Enter 는 그 단추 몫
  return <article className="ct-tile" aria-label={`${x.name} 타일`} data-robot={x.id} data-tone={tone} data-sel={sel || undefined} data-sim={sim || undefined}
    tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) { e.preventDefault(); open(); } }}
    onClick={pick} onDoubleClick={open}>
    {warn && <span className="ct-flag" data-warn-flag>{st.tone === 'bad' ? '경고' : '주의'}{note ? ` · ${note}` : ''}</span>}
    <div ref={ref} className="ct-video" data-face={front ? 'front' : 'live'}>
      {on && <Guard quiet><Figure x={x} front={front} /></Guard>}
      {sim ? <span className="ct-badge ct-face">시뮬 · 정면 상태만</span>
        : <button type="button" className="ct-badge ct-face ct-flip" aria-pressed={front} data-flip onClick={(e) => { e.stopPropagation(); flip(); }} onDoubleClick={(e) => e.stopPropagation()}>
          {front ? '동작 보기' : '정면 상태'}</button>}
      {front && hot != null && <span className="ct-badge ct-temp" data-temp-badge>최고 관절 온도 {Math.round(hot)}°C</span>}   {/* 관절 온도는 값이 있을 때만 */}
    </div>
    <div className="ct-head">
      <button type="button" className="ct-name" aria-pressed={sel} onClick={(e) => { e.stopPropagation(); pick(); }}><b>{x.name}</b></button>
      {sim && <span className="ct-tag" data-sim-tag>시뮬</span>}
      <FallChip x={x} />
      <span className="fh-grow" /><Chip {...st} />
    </div>
    <div className="ct-line" data-mission>
      <span className="ct-ico" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 21V4h11l-2 4 2 4H5" /></svg></span>
      <span className="fh-grow">{m ? m.name : '임무 없음'}</span>{m && m.total > 0 && <span className="lbl mono">할 일 {m.done}/{m.total}</span>}
    </div>
    <div className="ct-bar" aria-hidden="true"><i style={{ width: m && m.total ? `${Math.min(100, (m.done / m.total) * 100)}%` : 0 }} /></div>
    {place && <div className="ct-line" data-place>
      <span className="ct-ico" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11z" /><circle cx="12" cy="10" r="2" /></svg></span>
      <span>{place}</span>
    </div>}
    <div className="ct-facts">
      {/* 연결은 위 상태 칩이 말한다(같은 낱말 한 번). 값이 없는 칸은 칸째 접는다(«미확인» 반복이 진짜 끊김을 묻지 않게). 끊긴 로봇 값은 «마지막 값 · HH:MM», 시각을 모르면 접음 */}
      <Fact k="배터리" v={lastly(x, x.battery != null ? pct(x.battery) : null, x.seenAt)} />
      <Fact k="관절 최고" v={hot != null ? `${Math.round(hot)}°C` : null} />
      <Fact k="담당" v={ownerName(x)} />
    </div>
  </article>;
}
const Fact = ({ k, v, tone }: { k: string; v: string | null; tone?: Tone }) => (v == null ? null : <div className="ct-fact" data-fact={k} data-tone={tone} data-last={v.startsWith('마지막') || undefined}>
  <b className="mono">{v}</b><span className="lbl">{k}</span></div>);

/** 작은 지도(같은 GET /sites · /map-versions/{id}) · 판이 같은 위치만 점으로, 고른 로봇은 고리. 층은 고른 로봇이 있는 층 */
function SmallMap({ robots, sel, places, cancel, big }: { robots: Robot[]; sel: string; places: Place[]; cancel?: AbortSignal; big?: boolean }) {
  const at = robots.find((x) => x.id === sel), prefer = (at && where(at)?.floor_id) || robots.map(where).find((l) => l?.floor_id)?.floor_id;
  const cur = places.find((p) => p.floor.id === prefer && p.floor.approved_version_id) ?? places.find((p) => p.floor.approved_version_id);
  if (!cur?.floor.approved_version_id) return <p className="lv-note">{places.length ? '아직 지도가 없습니다. 지도 탭에서 지도를 만들어 주세요.' : '등록된 층이 없습니다.'}</p>;
  return <Marked key={cur.floor.approved_version_id} id={cur.floor.approved_version_id} title={`${cur.building.name} ${floorName(cur.floor.name)}`} robots={robots} sel={sel} cancel={cancel} big={big} />;
}
const TONE_COLOR: Record<Tone, string> = { ok: 'var(--accent)', warn: 'var(--warn)', bad: 'var(--bad)', off: 'var(--muted)' };
function Marked({ id, title, robots, sel, cancel, big }: { id: string; title: string; robots: Robot[]; sel: string; cancel?: AbortSignal; big?: boolean }) {
  useRt();
  const [v, setV] = useState<MapVersion | null>(null), [err, setErr] = useState(''), [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    api.version(id, cancel).then(shape(isVersion)).then((x) => { if (alive) { setV(x); setErr(''); } }, (e: ApiFail) => { if (alive && e.code !== 'CANCELED') setErr(e.message); });
    return () => { alive = false; };
  }, [n]);
  const fit = useFit(v ?? undefined);
  if (!v) return err ? <div className="fh-row"><p className="fh-msg" role="alert">지도를 받지 못했습니다. {err}</p><button type="button" className="btn" onClick={() => setN(n + 1)}>다시 시도</button></div>
    : <p className="lv-note" role="status">지도를 불러오는 중…</p>;
  const on = robots.flatMap((x) => { const l = where(x); return l && l.map_version_id === v.id && l.x != null && l.y != null ? [{ x, l: l as Location & { x: number; y: number } }] : []; });
  const r = Math.max(v.width, v.height) / (big ? 90 : 60);
  return <div className="ct-mapbox">
    <MapFrame {...fit} photo={v} role="img" aria-label={`${title} 지도 · 로봇 ${on.length}대 표시`} data-map data-small-map style={{ display: 'block', width: '100%', height: big ? '68vh' : 240, borderRadius: 8 }}>
      {/* 벽 = 중간 회색 토큰(두 테마 모두 덩어리가 무겁지 않게 · 지도 탭 지우개·벽 색과 같은 결) */}
      <MapImage id={v.id} width={v.width} height={v.height} tint="var(--muted)" />
      <Shapes v={v} f={v.features} />
      {on.map(({ x, l }) => {
        const [px, py] = toPixel(v, l.x, l.y), c = x.online ? TONE_COLOR[robotStatus(x).tone] : TONE_COLOR.off, me = x.id === sel;
        return <g key={x.id} data-robot-dot={x.id} data-sel={me || undefined}>
          {me && <circle cx={px} cy={py} r={r * 2.2} style={{ fill: 'none', stroke: 'var(--text)' }} strokeWidth={r * 0.35} />}
          <circle cx={px} cy={py} r={r} style={{ fill: c, stroke: 'var(--bg)' }} strokeWidth={r * 0.3} />
          {(me || big) && <text x={px} y={py - r * 2.6} fontSize={r * 2.2} textAnchor="middle" style={{ fill: 'var(--text)', stroke: 'var(--bg)', strokeWidth: r * 0.5, paintOrder: 'stroke' }}>{x.name}</text>}
        </g>;
      })}
    </MapFrame>
    {on.length < robots.length && <p className="lv-note" data-map-off>이 지도에 없는 로봇 {robots.length - on.length}대(위치 없음·다른 층).</p>}
  </div>;
}

const Icon = ({ d }: { d: ReactNode }) => <svg className="ct-i" viewBox="0 0 24 24" aria-hidden="true">{d}</svg>;

/** 관제 탭 본문 */
export function Control(c: Ctx) {
  useRt();
  const me = c.user.id, admin = c.user.role === 'ORG_ADMIN';
  const [view, setView] = useState<'tiles' | 'map'>('tiles'), [scope, setScope] = useState<'all' | 'mine'>(admin ? 'all' : 'mine');
  const [sel, setSel] = useState(''), [allFront, setAllFront] = useState(false), [flipped, setFlipped] = useState<Set<string>>(new Set());
  const t = useTree(c.cancel), places = useMemo(() => floorsOf(t.tree), [t.tree]);
  const list = scope === 'mine' ? c.robots.filter((x) => x.owner === me) : c.robots;
  const tiles = order(list), alerts = tiles.filter(needs);
  const open = (id: string) => { c.pick(id); c.go('fleet'); };   // 로봇 탭이 그 로봇을 고른 채 열린다(U5-07)
  const front = (x: Robot) => !!x.sim || allFront !== flipped.has(x.id);
  const flip = (id: string) => setFlipped((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const picked = list.find((x) => x.id === sel);
  const count = (f: (x: Robot) => boolean) => list.filter(f).length;
  const sums: [string, number, ReactNode, Tone?][] = [
    ['임무 중', count((x) => x.online && !!x.mission && x.status !== 'PAUSED'), <path d="M5 21V4h11l-2 4 2 4H5" />],
    ['연결', count((x) => x.online), <><path d="M2 9a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0" /><circle cx="12" cy="19" r="1" /></>],
    ['끊김', count(lost), <path d="M2 9a15 15 0 0 1 20 0M8.5 16a5 5 0 0 1 7 0M3 3l18 18" />],
    ['시뮬', count((x) => !!x.sim), <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5" />],
    ['경고', alerts.length, <path d="M12 4l9 16H3zM12 10v4M12 17v.5" />, alerts.length ? 'bad' : undefined],
  ];
  const top = alerts[0];
  return <div className="ct" data-view={view}>
    <div className="ct-bar-top">
      <div className="ct-seg" role="group" aria-label="보기">
        <button type="button" aria-pressed={view === 'tiles'} onClick={() => setView('tiles')}><Icon d={<><rect x="4" y="4" width="7" height="7" /><rect x="13" y="4" width="7" height="7" /><rect x="4" y="13" width="7" height="7" /><rect x="13" y="13" width="7" height="7" /></>} />타일 보기</button>
        <button type="button" aria-pressed={view === 'map'} onClick={() => setView('map')}><Icon d={<path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2zM9 4v14M15 6v14" />} />지도 보기</button>
      </div>
      <ul className="ct-sums" aria-label="요약">{sums.map(([k, n, d, tone]) => <li key={k} data-sum={k} data-tone={tone}><Icon d={d} />{k} <b className="mono">{n}</b></li>)}</ul>
      <span className="fh-grow" />
      {view === 'tiles' && <button type="button" className="btn ct-flipall" aria-pressed={allFront} onClick={() => { setAllFront(!allFront); setFlipped(new Set()); }}>
        <Icon d={<path d="M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3M18 3v4h-4M6 21v-4h4" />} />{allFront ? '동작 보기로 뒤집기' : '정면 상태로 뒤집기'}</button>}
      <div className="ct-seg" role="group" aria-label="범위">
        <button type="button" aria-pressed={scope === 'all'} onClick={() => setScope('all')}>모두</button>
        <button type="button" aria-pressed={scope === 'mine'} onClick={() => setScope('mine')}>내 로봇</button>
      </div>
    </div>
    <div className="ct-body">
      {view === 'tiles' ? <section className="ct-grid" aria-label="로봇 타일" data-count={tiles.length}>
        {!tiles.length && <p className="lv-note">{scope === 'mine' ? '내 로봇이 없습니다. «모두»를 누르면 보이는 모든 로봇을 봅니다.' : '보이는 로봇이 없습니다.'}</p>}
        {tiles.map((x) => <Tile key={x.id} x={x} sel={x.id === sel} front={front(x)} sim={!!x.sim} pick={() => setSel(x.id)} open={() => open(x.id)} flip={() => flip(x.id)} />)}
      </section>
        : <section className="lv-card ct-bigmap" aria-label="지도 보기"><Guard><SmallMap robots={tiles} sel={sel} places={places} cancel={c.cancel} big /></Guard></section>}
      <aside className="ct-side">
        {view === 'tiles' ? <section className="lv-card ct-small" aria-label="작은 지도">
          <div className="fh-row"><h2 className="fh-grow">작은 지도</h2><span className="lbl">점 = 로봇 · 고리 = 고른 로봇</span></div>
          <Guard>{t.tree ? <SmallMap robots={tiles} sel={sel} places={places} cancel={c.cancel} />
            : t.err ? <div className="fh-row"><p className="fh-msg" role="alert">층 목록을 받지 못했습니다. {t.err}</p><button type="button" className="btn" onClick={t.again}>다시 시도</button></div>
            : <p className="lv-note" role="status">층 목록을 불러오는 중…</p>}</Guard>
          {picked ? <div className="fh-row" data-picked><b className="fh-grow">{picked.name}</b><button type="button" className="btn" onClick={() => open(picked.id)}>로봇 탭에서 보기</button></div>
            : <p className="lv-note">타일을 한 번 누르면 지도에서 강조, 두 번 누르면 로봇 탭이 열립니다.</p>}
        </section>
          : <section className="lv-card ct-list" aria-label="로봇 목록(지도 보기)"><ul className="fh-list">{tiles.map((x) => <li key={x.id}>
            <button type="button" aria-pressed={x.id === sel} onClick={() => setSel(x.id)} onDoubleClick={() => open(x.id)}>
              <Chip {...robotStatus(x)} /><b>{x.name}</b><span className="fh-grow lbl">{x.mission ?? '임무 없음'}</span><span className="mono">{pct(x.battery)}</span></button></li>)}</ul></section>}
        {top && <section className="lv-card ct-alarm" aria-label="경보" data-tone={robotStatus(top).tone === 'bad' ? 'bad' : 'warn'}>
          <h2><Icon d={<path d="M12 4l9 16H3zM12 10v4M12 17v.5" />} />{robotStatus(top).tone === 'bad' ? '경고' : '주의'} · {top.name} {why(top)}</h2>
          <p className="lv-note">담당 {ownerName(top)}{alerts.length > 1 ? ` · 다른 경고 ${alerts.length - 1}건` : ''}</p>
          <div className="fh-row"><button type="button" className="btn" onClick={() => open(top.id)}>로봇 탭에서 보기</button></div>
        </section>}
        <section className="lv-card ct-recent" aria-label="최근 경고">
          <div className="fh-row"><h2 className="fh-grow">최근 경고</h2><a className="lbl" href="#/history">기록 탭에서 모두 보기</a></div>
          {/* 경보 카드에 나온 맨 앞 경고는 빼고. 발생 시각 필드가 없어 받은 시각(seenAt) */}
          {!alerts.length ? <p className="lv-note">주의가 필요한 로봇이 없습니다.</p>
            : alerts.length === 1 ? <p className="lv-note">다른 경고가 없습니다.</p>
            : <ul className="fh-list">{alerts.slice(1).map((x) => <li key={x.id} data-alert={x.id}><button type="button" onClick={() => setSel(x.id)} onDoubleClick={() => open(x.id)}>
              <Chip {...robotStatus(x)} /><b>{x.name}</b><span className="fh-grow lbl">{why(x)}</span>{x.seenAt && <span className="lbl mono" data-alert-at>받은 시각 {x.seenAt}</span>}</button></li>)}</ul>}
        </section>
      </aside>
    </div>
  </div>;
}

/** 로봇 0대의 관제(App 이 로봇 없을 때 그릴 자리): 한 줄 + 로봇 탭 링크 */
export const EmptyControl = () => <section className="lv-card" style={{ flexBasis: '100%' }} aria-label="로봇 없음" data-empty-control>
  <p className="lv-note">관제할 로봇이 없습니다. 로봇을 등록하거나 담당을 받으면 여기에 타일로 보입니다.</p>
  <div className="fh-row"><a className="btn" href="#/fleet">로봇 탭 열기</a></div></section>;
