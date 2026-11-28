// 지도 탭 첫 화면 = 시안 u7_1(고르기) · u7_2(관리). 시안 body 를 JSX 로 옮김(태그 · class · 순서 · 글 그대로, 시안 머리줄 .bar 는 앱 머리줄 몫).
// 고정 글 자리는 서버 나무(장소 · 건물 · 층) · 지도 판 값으로만. 서버에 없는 값(점 개수 · 내려받기)은 칸을 비우거나 그 칸을 뺀다.
// 「새 지도 만들기」 = 시안 u7_6(로봇으로 그리기). 파일 · 3D 지도 올리기는 관리(u7_2) 「3D 지도 올리기」 칸 → 올리기 화면.
import { useEffect, useState, type ReactNode } from 'react';
import type { MapFloor, MapSite, MapVersion, TrashItem } from '../../../../contracts/ts';
import { ApiFail, api } from '../../api';
import { inApp } from '../../screens';
import { Map3D, modelOf } from '../map3d';
import { ClayMap } from './clay';
import { Thumb, byLevel, demoBoard, purposeOf, howMade, md, meters, nogo, picFloor, type Msg, type Place, type useTree } from '../maps';
import { voxelOf } from '../voxelmap';
import { ART, DOG } from '../../proto/u11';
import '../../proto/ui.pv.css';
import '../../proto/pc.pv.css';
import '../../proto/light.pv.css';
import './u7.css';

export const light = () => typeof document !== 'undefined' && document.documentElement.dataset.theme === 'light';
export const ic = (w: number, d: ReactNode, style = {}) => <svg className="ic" viewBox="0 0 24 24" style={{ width: `${w}px`, height: `${w}px`, ...style }}>{d}</svg>;
const PIN = <><path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0" /><circle cx="12" cy="10" r="3" /></>;
const PLUS = <><path d="M5 12h14" /><path d="M12 5v14" /></>;
const CHEV = <path d="m6 9 6 6 6-6" />;
export const CUBE = <><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" /><path d="m3.3 7 8.7 5 8.7-5" /><path d="M12 22V12" /></>;
export const LAYERS = <><path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z" /><path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12" /><path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17" /></>;
const CLOCK = <><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></>;
const BAN = <><circle cx="12" cy="12" r="10" /><path d="M4.929 4.929 19.07 19.071" /></>;
export const HIST = <><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l4 2" /></>;
export const EDIT = <><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" /><path d="m15 5 4 4" /></>;
const TRASH = <><path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" /><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" /></>;
const MOUNT = <path d="m8 3 4 8 5-5 5 15H2L8 3z" />;
const UP = <><path d="M12 13v8" /><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" /><path d="m8 17 4-4 4 4" /></>;

/** 시안 꼬리표: 실측 지도(현장 스캔 · 초록) · 가져온 지도(파일) · 시험 지형(점선 · 직접 만든 지형) — 서버 판 출처로 */
export const tagOf = (v: MapVersion): [string, string] => v.provenance === 'SIMULATION' ? ['tag d', '시험 지형'] : v.source === 'SLAM' ? ['tag m', '실측 지도'] : ['tag', '가져온 지도'];

/** 관리 칸 손: 이름 바꾸기 · 휴지통 · 만들기 (Maps 의 같은 함수 — 서버 저장 · 안내 · 확인 칸은 edits) */
export type Ed = { own: (s: Place['site']) => boolean; busy: boolean; edits: ReactNode;
  rename: (kind: 'sites' | 'buildings' | 'floors', x: { id: string; name: string; level?: number }) => void;
  del: (kind: 'sites' | 'buildings' | 'floors', x: { id: string; name: string }) => void;
  add: (kind: 'sites' | 'buildings' | 'floors', parent?: { id: string; name: string }) => void };

/** 층 줄 썸네일 선 그림 거름(u7.css). 판 그림 바탕이 밝으면(점유 격자 · 흰 빈 곳) 어두운 픽셀(밝기 < 0.4)이 선, 바탕이 어두우면(어두운 색 그림) 밝은 픽셀(밝기 > 0.6)이 선.
 *  알파 = ±밝기 로 0.6 넘는 곳만 남김 · 색 = 어둠 흰색 / 밝음 글자색 #1F2421. id 끝 -i = 어두운 바탕 그림용 */
const LINE = (id: string, [r, g, b]: number[], inv: boolean) => `<filter id="${id}" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="0 0 0 0 ${r} 0 0 0 0 ${g} 0 0 0 0 ${b} ${inv ? '0.299 0.587 0.114 0 0' : '-0.299 -0.587 -0.114 1 0'}"/>`
  + '<feComponentTransfer><feFuncA type="discrete" tableValues="0 0 0 0 0 0 1 1 1 1"/></feComponentTransfer></filter>';
const WHITE = [1, 1, 1], INK = [31 / 255, 36 / 255, 33 / 255];
export const LINE_DEFS = LINE('u7-line-d', WHITE, false) + LINE('u7-line-l', INK, false) + LINE('u7-line-d-i', WHITE, true) + LINE('u7-line-l-i', INK, true);
/** 판 그림 바탕 밝기(작게 줄여 평균): 'light' = 밝은 바탕, 'dark' = 어두운 바탕. 그리기가 없거나 못 받으면 'light'(점유 격자 기본) */
export const inkOf = (px: Uint8ClampedArray) => { let s = 0, n = 0; for (let i = 0; i < px.length; i += 4) if (px[i + 3] > 0) { s += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]; n++; } return n && s / n < 128 ? 'dark' : 'light'; };
function useInk(id?: string | null) {
  const [ink, setInk] = useState<'light' | 'dark'>('light');
  useEffect(() => {
    if (!id) return;
    let live = true; const img = new Image(); img.crossOrigin = 'use-credentials';
    img.onload = () => { if (!live) return; const c = document.createElement('canvas'); c.width = c.height = 48; const g = c.getContext('2d'); if (!g) return; try { g.drawImage(img, 0, 0, 48, 48); setInk(inkOf(g.getImageData(0, 0, 48, 48).data)); } catch { /* 읽을 수 없는 그림 = 밝은 바탕 기본 */ } };
    img.src = api.imageUrl(id);
    return () => { live = false; img.onload = null; };
  }, [id]);
  return ink;
}
/** 층 줄 썸네일 칸: 판 그림 바탕 밝기를 data-ink 로(u7.css 가 거름을 고름) */
const Th = ({ children, id }: { children: ReactNode; id?: string | null }) => <div className="th" data-ink={useInk(id)}>{children}</div>;
const LineDefs = () => <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true" data-u7-linedefs dangerouslySetInnerHTML={{ __html: `<defs>${LINE_DEFS}</defs>` }} />;

/** 층 겹친 그림(시안 u7_1 가운데 아래 svg 값 그대로): 위층이 위, 고른 층만 민트. 누르면 그 층 */
function Stack({ floors, sel, pick }: { floors: MapFloor[]; sel?: string; pick: (id: string) => void }) {
  const l = byLevel(floors), top = 250 - (l.length - 1) * 78;
  return <svg viewBox="0 0 760 330" style={{ position: 'absolute', left: '24px', right: '24px', bottom: '66px', width: 'calc(100% - 48px)', height: '300px' }} role="group" aria-label="층 겹친 그림">
    {l.map((f, i) => { const y = 250 - i * 78, on = f.id === sel, line = on ? '#00c389' : 'rgba(255,255,255,.22)';
      if (y < top) return null;
      return <g key={f.id} data-stack={f.id} className={on ? 'sk on' : 'sk'} onClick={() => pick(f.id)} style={{ cursor: 'pointer' }}>
        <polygon points={`60,${y} 300,${y + 60} 300,${y + 72} 60,${y + 12}`} fill="rgba(255,255,255,.05)" stroke={line} strokeWidth="1" className="sk-l" />
        <polygon points={`300,${y + 60} 540,${y} 540,${y + 12} 300,${y + 72}`} fill="rgba(0,0,0,.25)" stroke={line} strokeWidth="1" className="sk-r" />
        <polygon points={`60,${y} 300,${y - 60} 540,${y} 300,${y + 60}`} fill={on ? 'rgba(0,195,137,.28)' : 'rgba(255,255,255,.06)'} stroke={line} strokeWidth={on ? 1.6 : 1} className="sk-t" />
        <path d={`M540 ${y}h30`} stroke={line} strokeWidth="1" className="sk-ln" />
        <text className="sk-tx" x="580" y={y + 7} fontSize="19" fontWeight={on ? 800 : 600} fill={on ? '#00c389' : '#9aa19d'}>{f.name}</text></g>; })}</svg>;
}

/** 관리 칸 휴지통(시안 u7_2 오른쪽 아래): 서버 휴지통 목록 그대로 · 「복원」 = 서버 복원. 「30 일 뒤 지움」 은 서버 값이 없어 뺌 */
function TrashPane({ again }: { again: () => void }) {
  const [l, setL] = useState<TrashItem[] | null>(null), [err, setErr] = useState(''), [busy, setBusy] = useState(''), [n, setN] = useState(0);
  useEffect(() => { const s = new AbortController(); api.trash(s.signal).then((x) => { setL(x.items.filter((i) => i.kind !== 'scenario')); setErr(''); }, (e: ApiFail) => { if (e.code !== 'CANCELED') setErr(e.message); }); return () => s.abort(); }, [n]);
  const back = (i: TrashItem) => { setBusy(i.id); api.restore(i.kind, i.id).then(() => { setN(n + 1); again(); }, (e: ApiFail) => setErr(e.message)).finally(() => setBusy('')); };
  return <div className="pane" style={{ left: '1132px', top: '720px', right: '24px', bottom: '24px', padding: '20px 22px', overflow: 'hidden' }} data-manage-trash>
    <div className="row" style={{ gap: '10px' }}><span style={{ color: 'var(--mu2)', display: 'flex' }}>{ic(18, TRASH)}</span><span className="ttl" style={{ fontSize: '18px' }}>휴지통</span>
      <a className="mu2" style={{ fontSize: '12.5px', marginLeft: 'auto', color: 'var(--mu2)' }} href="#/trash" data-trash-link>모두 보기</a></div>
    {err ? <p className="mu2" role="alert" style={{ fontSize: '13px', marginTop: '12px' }}>휴지통을 받지 못했습니다. {err}</p>
      : !l ? <p className="mu2" role="status" style={{ fontSize: '13px', marginTop: '12px' }}>불러오는 중…</p>
      : !l.length ? <p className="mu2" style={{ fontSize: '13px', marginTop: '12px' }}>지운 장소 · 건물 · 층이 없습니다.</p>
      : l.slice(0, 4).map((i) => <div key={`${i.kind}-${i.id}`} className="row" style={{ height: '44px', gap: '10px', borderBottom: '1px solid var(--line)', fontSize: '13.5px', fontWeight: 600 }} data-trash-row={i.id}>
        {i.parent_name ? `${i.parent_name} · ${i.name}` : i.name}<span className="mu2" style={{ fontSize: '12px' }}>{md(i.archived_at)} 지움</span>
        <span role="button" tabIndex={0} aria-disabled={!!busy || undefined} style={{ marginLeft: 'auto', color: 'var(--pr3)', fontWeight: 700, fontSize: '13px', cursor: 'pointer' }} data-trash-restore
          onClick={() => { if (!busy) back(i); }}>{busy === i.id ? '복원 중…' : '복원'}</span></div>)}
  </div>;
}

/** 왼쪽 현장 두 묶음(시안 u7_1): 지도가 있는(또는 시뮬) 건물 = 머리 빈 자리(시안 「국내 · 해외 · 시험」 = 지역 칸, 서버에 아직 없음), 실제 현장(purpose REAL)인데 지도 0 개 = 「실제 현장 · 아직 스캔 전」. 장소 순서 = 서버 목록 */
export function railGroups(sites: MapSite[], blds: { site: Place['site']; building: Place['building'] }[]) {
  const rows = sites.flatMap((st) => blds.filter((x) => x.site.id === st.id).map((x) => ({ site: st, building: x.building, n: x.building.floors.filter((f) => f.approved_version_id).length })));
  const late = rows.filter((r) => !r.n && purposeOf(r.site) === 'REAL'), maps = rows.filter((r) => !late.includes(r));
  return [...(maps.length ? [{ head: '', rows: maps, late: false }] : []),
    ...(late.length ? [{ head: '실제 현장 · 아직 스캔 전', rows: late, late: true }] : [])];
}

export function PickU7({ maker, t, places, vers, choose, make, note, manage, setManage, ed, children }: { maker: boolean; t: ReturnType<typeof useTree>; places: Place[]; vers: Record<string, MapVersion>;
  choose: (id: string, then?: 'history') => void; make: (k: 'robot' | 'file') => void; note: Msg; manage: boolean; setManage: (m: boolean) => void; ed: Ed; children: ReactNode }) {
  const blds = places.reduce<{ site: Place['site']; building: Place['building'] }[]>((a, p) => (a.some((x) => x.building.id === p.building.id) ? a : [...a, { site: p.site, building: p.building }]), []);
  // 처음 고른 건물 = 왼쪽 목록 첫 줄(지도 있는 현장 먼저 · 시안 u7_1 첫 줄 on). 서버 /sites 는 이름순이라 blds[0] 은 스캔 전 현장일 수 있음
  const rail = railGroups(t.tree?.items ?? [], blds), first = rail[0]?.rows[0]?.building.id;
  const [bid, setBid] = useState('');
  const cur = blds.find((x) => x.building.id === bid) ?? blds.find((x) => x.building.id === first) ?? blds[0];
  const [fid, setFid] = useState(''), floors = cur ? byLevel(cur.building.floors) : [];
  const fl = floors.find((f) => f.id === fid) ?? (cur && picFloor(cur.building)) ?? floors[0], v = fl?.approved_version_id ? vers[fl.approved_version_id] : undefined;
  const maps = places.filter((p) => p.floor.approved_version_id).length;
  const [no3, setNo3] = useState(''), [why, setWhy] = useState('');
  const demo = !!cur && demoBoard(cur.site, cur.building), none = !!t.tree && !places.length;
  const newMap = () => { if (maker) make('robot'); else setWhy('지도 만들기는 담당 실기 로봇이 있어야 합니다. 지도 파일은 「관리」 의 「3D 지도 올리기」 로 올립니다.'); };
  const msg = why || note?.text;
  return <div className={`proto${light() ? ' light' : ''} u7`} aria-label="지도 고르기" data-u7={manage ? 'u7_2_manage' : 'u7_1_pick'}>
    <LineDefs />
    <div className="pane side" aria-label="현장"><div className="row" style={{ justifyContent: 'space-between', padding: '0 6px 4px' }}><span className="ttl">현장</span>{t.tree && <span className="mu2" style={{ fontSize: '12.5px', fontWeight: 600 }} data-map-count>지도 {maps} 개</span>}</div>
      {/* 시안 u7_1 두 묶음: 지도가 있는 건물(머리 = 그 장소 이름들 「국내 · 해외 · 시험」) · 실제 현장인데 지도 0 개(「실제 현장 · 아직 스캔 전」 · 점선 · 층 이름).
          「스캔 예정 월 · 화」 는 서버 값이 없어 뺌 */}
      {t.tree && rail.map((g, k) => <div key={g.late ? 'late' : 'maps'} aria-label={g.head || '현장'} data-rail-group={g.late ? 'late' : 'maps'}><div className="h3" style={k ? { marginTop: '14px' } : undefined}>{g.head}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>{g.rows.map(({ site: st, building: b, n }) =>
          <div key={b.id} className={`site${b.id === cur?.building.id ? ' on' : ''}`} style={n ? undefined : { opacity: 0.72 }} role="button" tabIndex={0} aria-pressed={b.id === cur?.building.id} data-building={b.id} data-site={st.name}
            onClick={() => { setBid(b.id); setFid(''); }}><span className="av" style={n ? undefined : { background: 'transparent', border: '1.5px dashed rgba(255,255,255,.28)' }}>{ic(19, PIN)}</span>
            <div style={{ flex: 1, minWidth: 0 }}>{b.name}<small>{g.late ? byLevel(b.floors).map((f) => f.name).join(' · ') : `${st.name === b.name ? '' : `${st.name} · `}${b.floors.length} 층${n ? '' : ' · 지도 없음'}`}</small></div><span className="mu2" style={{ fontSize: '12.5px' }}>{n}</span></div>)}</div></div>)}
      {t.tree && !blds.length && <p className="mu2" style={{ fontSize: '13px', margin: '14px 6px' }}>아직 층이 있는 건물이 없습니다. 「관리」 에서 장소 · 건물 · 층을 만듭니다.</p>}
      <div style={{ position: 'absolute', left: '20px', right: '20px', bottom: '20px', fontSize: '12.5px', lineHeight: '1.55', color: 'var(--mu2)' }}>로봇이 현장을 걸으며 스캔한 3D 지도입니다. 층마다 따로 만듭니다.</div></div>
    <div className="head"><span className="ttl" style={{ fontSize: '26px' }}>지도</span>{cur && <span className="mu2" style={{ fontSize: '14px', fontWeight: 600 }} data-u7-sub>{cur.site.name === cur.building.name ? cur.building.name : `${cur.building.name} · ${cur.site.name}`}</span>}
      <div className="seg2" style={{ marginLeft: 'auto' }} role="group" aria-label="고르기 · 관리"><span className={manage ? '' : 'on'} role="button" tabIndex={0} aria-pressed={!manage} data-seg="고르기" onClick={() => setManage(false)}>고르기</span>
        <span className={manage ? 'on' : ''} role="button" tabIndex={0} aria-pressed={manage} data-seg="관리" onClick={() => setManage(true)}>관리</span></div>
      <div className="btnp" role="button" tabIndex={0} style={{ height: '46px', padding: '0 20px', fontSize: '14.5px' }} aria-disabled={!maker || undefined} data-make-robot onClick={newMap}>{ic(17, PLUS)}새 지도 만들기</div></div>
    {msg && <p className="g dk" role={note?.ok && !why ? 'status' : 'alert'} style={{ left: '348px', right: '24px', top: '146px', height: 'auto', padding: '4px 14px', fontSize: '12.5px', fontWeight: 600, zIndex: 3 }} data-u7-note>{msg}
      {!why && note?.act && <span role="button" tabIndex={0} style={{ marginLeft: '10px', color: 'var(--pr3)', fontWeight: 800, cursor: 'pointer' }} onClick={note.act.run}>{note.act.label}</span>}</p>}
    {t.err && <div className="pane" style={{ left: '348px', top: '160px', right: '24px', height: '120px', padding: '22px' }} role="alert"><p className="ttl" style={{ fontSize: '16px', marginRight: '150px', lineHeight: '1.5' }}>장소 목록을 받지 못했습니다. {t.err}</p>
      <div className="btns" role="button" tabIndex={0} style={{ position: 'absolute', right: '22px', top: '30px', height: '44px', width: '120px' }} data-retry onClick={t.again}>다시 시도</div></div>}
    {!t.tree && !t.err && <p className="mu2" role="status" style={{ position: 'absolute', left: '372px', top: '176px', fontSize: '14px' }}>장소 목록을 불러오는 중…</p>}
    {/* 지도 0 개 = 시안 u11_7 그림 · 제목 · 글 · 칠한 단추 「로봇 탭으로」 하나(.pane.empty · 자리는 고르기 칸 그대로라 머리줄을 덮지 않음).
        아래 보조 단추(지도 만들기 · 파일 올리기)는 시안 밖 · 새로 그림: 지도 0 개 조직이 지도를 시작할 길(조정 22:27) */}
    {none && !manage && <div className="pane empty" style={{ left: '348px', top: '160px', right: '24px', bottom: '24px' }} aria-label="아직 지도가 없습니다" data-empty="map">
      <svg className="art" data-empty-icon viewBox="0 0 560 340" aria-hidden="true" dangerouslySetInnerHTML={{ __html: ART.map }} />
      <h2>아직 지도가 없습니다</h2><p>로봇을 조종해 한 바퀴 걸으면 지도가 만들어집니다.</p>
      <a className="btnp" href="#/fleet" data-empty-go>{ic(18, DOG)}로봇 탭으로</a>
      <div className="btns" role="button" tabIndex={0} style={{ height: '44px', padding: '0 18px', fontSize: '13.5px', marginTop: '12px' }} data-empty-act data-off-proto
        onClick={() => make(maker ? 'robot' : 'file')} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); make(maker ? 'robot' : 'file'); } }}>{ic(16, PLUS)}{maker ? '지도 만들기' : '파일 올리기'}</div></div>}
    {manage ? <Manage t={t} vers={vers} ed={ed} make={make} />
      : cur && <><div className="pane" style={{ left: '348px', top: '160px', width: '620px', bottom: '24px', padding: '22px 18px' }} aria-label="층 목록">
        <div className="row" style={{ justifyContent: 'space-between', padding: '0 6px 12px' }}><span className="ttl">{cur.building.name} · 층</span><span className="mu2" style={{ fontSize: '12.5px', fontWeight: 600 }}>층마다 지도 하나</span></div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>{floors.map((f) => { const x = f.approved_version_id ? vers[f.approved_version_id] : undefined, [tc, tt] = x ? tagOf(x) : ['', ''];
          return <div key={f.id} className={`frow${f.id === fl?.id ? ' on' : ''}`} role="button" tabIndex={0} aria-pressed={f.id === fl?.id} data-floor-row={f.id} onClick={() => setFid(f.id)}>
            <Th id={f.approved_version_id}><Thumb id={f.approved_version_id} v={x} demo={demo} /></Th>
            <div style={{ flex: 1, minWidth: 0 }}><div className="row" style={{ gap: '10px' }}><b>{f.name}</b>{x ? <span className={tc}>{tt}</span> : !f.approved_version_id && <span className="tag">지도 없음</span>}
              {x && voxelOf(x) && <span className="tag m" style={{ marginLeft: '8px' }} data-voxel-chip>3D</span>}</div>
              {x && <div className="meta"><span>{meters(x).area} ({meters(x).wh})</span><span>{md(x.created_at)} · v{x.number}</span></div>}</div>
            {ic(18, CHEV, { transform: 'rotate(-90deg)', color: '#9aa19d' })}</div>; })}</div>
        {floors.length >= 2 && <Stack floors={floors} sel={fl?.id} pick={setFid} />}
        <div style={{ position: 'absolute', left: '24px', right: '24px', bottom: '22px', display: 'flex', gap: '10px', alignItems: 'center', fontSize: '12.5px', color: 'var(--mu2)', fontWeight: 600 }} data-legend>
          <span className="tag m">실측 지도</span>현장 스캔<span className="tag">가져온 지도</span>외부 3D 파일<span className="tag d">시험 지형</span>직접 만든 지형</div></div>
      {fl && <div className="pane" style={{ left: '992px', top: '160px', right: '24px', bottom: '24px', overflow: 'hidden', padding: 0 }} aria-label="미리 보기">
        {/* 시안 u7_1 「3D 보기 · 미리 보기」: 판에 서버 3D 모형이 있으면 그 모형(Map3D still · 점토 결), 없으면 판의 2D 그림을 점토로 세운 비스듬한 위 시점(ClayMap). 시뮬 월드 · 로봇 실시간은 그리지 않음(팀장 22:37).
            판이 없는 층 = 시안 u11_7 꼴 빈 칸(그림 · 제목 · 글), 숫자 없음 */}
        <div style={{ position: 'absolute', inset: 0 }} data-u7-preview>{v && modelOf(v) && no3 !== v.id ? <Map3D key={v.id} v={v} robots={[]} still missing={() => setNo3(v.id)} />
          : v ? <ClayMap key={v.id} v={v} light={light()} />
          : fl.approved_version_id ? <p className="mu2" role="status" style={{ position: 'absolute', left: '28px', top: '90px', right: '28px', fontSize: '14px' }}>지도를 불러오는 중…</p>
          : <div className="empty" style={{ top: '60px', bottom: '210px' }} data-empty="floor"><svg className="art" viewBox="0 0 560 340" aria-hidden="true" style={{ width: '100%', maxWidth: '460px', height: 'auto' }} dangerouslySetInnerHTML={{ __html: ART.map }} />
            <h2>지도 없음</h2><p>이 층은 아직 스캔하지 않았습니다.</p></div>}</div>
        <div className="pv-fade" data-pv-fade />
        {v && <div className="g dk" style={{ left: '20px', top: '20px', height: '38px', padding: '0 14px', borderRadius: '12px', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', fontWeight: 700 }} data-tag3d>
          {ic(16, CUBE)}3D 보기 · 미리 보기</div>}
        <div style={{ position: 'absolute', left: '28px', right: '28px', bottom: '26px' }}>
          <div className="row" style={{ gap: '10px' }}><span className="pv-ttl" style={{ fontSize: '28px', fontWeight: 800, letterSpacing: '-.03em' }} data-prev-title>{cur.building.name} · {fl.name}</span>{v && <span className={tagOf(v)[0]}>{tagOf(v)[1]}</span>}</div>
          {v && <div className="row pv-meta" style={{ gap: '22px', marginTop: '12px', fontSize: '13.5px', fontWeight: 600 }}>
            <span className="row" style={{ gap: '6px' }}>{ic(16, LAYERS)}{meters(v).area}</span><span className="row" style={{ gap: '6px' }}>{ic(16, CLOCK)}{md(v.created_at)} {howMade(v)} · v{v.number}</span>
            <span className="row" style={{ gap: '6px' }}>{ic(16, BAN)}금지 구역 {nogo(v)}</span></div>}
          <div className="row" style={{ gap: '10px', marginTop: '20px' }}><div className="btnp" role="button" tabIndex={0} style={{ height: '52px', flex: 1, fontSize: '15px' }} data-open-map onClick={() => choose(fl.id)}>지도 열기</div>
            <div className="btns pv-hist" role="button" tabIndex={0} style={{ height: '52px', width: '170px', fontSize: '14px' }} aria-disabled={!fl.approved_version_id || undefined}
              title={fl.approved_version_id ? undefined : '이 층에 저장된 지도가 없습니다.'} data-open-history onClick={() => { if (fl.approved_version_id) choose(fl.id, 'history'); }}>{ic(17, HIST)}버전 기록</div></div></div>
      </div>}</>}
    {children}
  </div>;
}

/** 관리(시안 u7_2): 가운데 = 장소 · 건물 · 층 나무(이름 누르면 고침 · 휴지통), 오른쪽 = 지형 만들기 · 3D 지도 올리기 · 휴지통. 장소 고치기는 지도 탭 쓰임(실기) 장소만(own) */
function Manage({ t, vers, ed, make }: { t: ReturnType<typeof useTree>; vers: Record<string, MapVersion>; ed: Ed; make: (k: 'robot' | 'file') => void }) {
  const sites = t.tree?.items.filter(ed.own) ?? [];
  const row = { display: 'flex', alignItems: 'center' } as const;
  const tool = (k: 'sites' | 'buildings' | 'floors', x: { id: string; name: string; level?: number }) => <span className="row" style={{ marginLeft: 'auto', gap: '12px', color: 'var(--mu2)' }}>
    <span role="button" tabIndex={0} aria-label={`${x.name} 이름 바꾸기`} style={row} data-rename={x.id} onClick={() => !ed.busy && ed.rename(k, x)}>{ic(16, EDIT)}</span>
    <span role="button" tabIndex={0} aria-label={`${x.name} 휴지통으로`} style={row} data-del={x.id} onClick={() => !ed.busy && ed.del(k, x)}>{ic(16, TRASH)}</span></span>;
  const add = (label: string, run: () => void) => <span role="button" tabIndex={0} className="mu2" style={{ fontSize: '12.5px', fontWeight: 700, color: 'var(--pr3)', cursor: 'pointer' }} onClick={() => !ed.busy && run()}>{label}</span>;
  return <>
    <div className="pane" style={{ left: '348px', top: '160px', width: '760px', bottom: '24px', padding: '22px 20px', overflowY: 'auto' }} aria-label="장소 · 건물 · 층 편집" data-manage-edit>
      <div className="row" style={{ justifyContent: 'space-between' }}><span className="ttl">장소 · 건물 · 층 편집</span>{add('＋ 장소', () => ed.add('sites'))}</div>
      <p className="mu2" style={{ fontSize: '13px', margin: '8px 0 4px' }}>이름 바꾸기 · 삭제는 바로 서버에 저장됩니다. 지운 것은 휴지통에서 되돌립니다.</p>
      {sites.map((s) => <div key={s.id} aria-label={`장소 ${s.name}`}>
        <div className="row" style={{ height: '50px', gap: '10px', padding: '0 12px', borderRadius: '12px', background: 'rgba(255,255,255,.04)', marginTop: '14px', fontWeight: 700, fontSize: '14.5px' }}>{ic(18, PIN)}{s.name}
          <span className="mu2" style={{ fontSize: '12.5px', fontWeight: 600 }}>{s.buildings.length} 건물</span>{add('＋ 건물', () => ed.add('buildings', s))}{tool('sites', s)}</div>
        {s.buildings.map((b) => <div key={b.id}>
          <div className="row" style={{ height: '44px', gap: '10px', padding: '0 12px 0 28px', fontSize: '14px', fontWeight: 700, borderBottom: '1px solid var(--line)' }}>{b.name}
            <span className="mu2" style={{ fontSize: '12.5px', fontWeight: 600 }}>{b.floors.length} 층</span>{add('＋ 층', () => ed.add('floors', b))}{tool('buildings', b)}</div>
          {byLevel(b.floors).map((f) => { const x = f.approved_version_id ? vers[f.approved_version_id] : undefined;
            return <div key={f.id} className="row" style={{ height: '46px', gap: '10px', padding: '0 12px 0 44px', fontSize: '13.5px', fontWeight: 600, borderBottom: '1px solid var(--line)' }} data-manage-floor={f.id}>
              <span className="th" style={{ width: '54px', height: '34px', borderRadius: '7px', overflow: 'hidden', flex: 'none', background: '#000', border: '1px solid var(--line)' }}><Thumb id={f.approved_version_id} v={x} /></span>{f.name}
              {x ? <span className={tagOf(x)[0]} style={{ marginLeft: '6px' }}>{tagOf(x)[1]}</span> : <span className="tag" style={{ marginLeft: '6px' }}>지도 없음</span>}
              {x && <span className="mu2" style={{ marginLeft: 'auto', fontSize: '12.5px' }}>{md(x.created_at)} · v{x.number}</span>}{tool('floors', f)}</div>; })}
          {!b.floors.length && <p className="mu2" style={{ fontSize: '12.5px', padding: '10px 0 0 44px' }}>아직 층이 없습니다.</p>}</div>)}
        {!s.buildings.length && <p className="mu2" style={{ fontSize: '12.5px', padding: '10px 0 0 28px' }}>아직 건물이 없습니다.</p>}</div>)}
      {t.tree && !sites.length && <p className="mu2" style={{ fontSize: '13px', marginTop: '14px' }}>등록된 장소가 없습니다. 「＋ 장소」 로 만드세요. 데모 현장은 보기만 합니다.</p>}
      <div style={{ marginTop: '16px' }}>{ed.edits}</div>
    </div>
    <div className="pane" style={{ left: '1132px', top: '160px', right: '24px', height: '220px', padding: '22px 22px' }} data-manage-terrain>
      <div className="row" style={{ gap: '10px' }}><span style={{ color: 'var(--pr3)', display: 'flex' }}>{ic(20, MOUNT)}</span><span className="ttl">지형 만들기</span></div>
      <p className="mu2" style={{ fontSize: '13.5px', marginTop: '10px', lineHeight: '1.55' }}>실측 지도 없이 시험할 지형을 새 지도로 만듭니다. 학습 지형에서 골라 놓습니다.</p>
      {!inApp() && <a className="btns" href="#/terrain" style={{ position: 'absolute', left: '22px', bottom: '20px', height: '44px', width: '190px', fontSize: '13.5px', textDecoration: 'none' }} data-terrain-enter>{ic(16, PLUS)}새 시험 지형</a>}</div>
    <div className="pane" style={{ left: '1132px', top: '400px', right: '24px', height: '300px', padding: '22px 22px' }} data-manage-up>
      <div className="row" style={{ gap: '10px' }}><span style={{ color: 'var(--pr3)', display: 'flex' }}>{ic(20, UP)}</span><span className="ttl">3D 지도 올리기</span></div>
      <div role="button" tabIndex={0} style={{ marginTop: '16px', height: '118px', borderRadius: '16px', border: '1.5px dashed rgba(255,255,255,.22)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '8px', fontSize: '14px', fontWeight: 700, background: 'rgba(255,255,255,.03)', cursor: 'pointer' }}
        data-make-file onClick={() => make('file')}>{ic(22, UP)}지도 파일을 올릴 층 고르기<span className="mu2" style={{ fontSize: '12.5px', fontWeight: 600 }}>.png · .pgm + .yaml · 3D 지도 .pcd · .ply (총괄)</span></div>
      <p className="mu2" style={{ fontSize: '12.5px', marginTop: '14px', lineHeight: '1.5' }}>내려받기는 서버가 아직 주지 않습니다.</p></div>
    <TrashPane again={t.again} />
  </>;
}
