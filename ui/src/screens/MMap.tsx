// 휴대폰 지도(원본 틀): 시뮬 바닥 도면 위 로봇 GT·지나온 길·구역 · 지도를 눌러 지점 고르기 → 계획에 지점 추가 — web/live.js pageMMap 과 같은 규칙.
// «이 목표로 이동»은 미연결(자동 이동 없음). 예상 시간·경로 검사도 미연결 — 직선 거리만.
import { useRef, useState } from 'react';
import type { Mission, Waypoint } from '@contracts';
import { CSS, View } from './MMap.view';
import { posTxt, sgn, themeClass } from '../data/fmt';
import { docById, docsOf, saveDoc, useDocs } from '../data/shared';
import { TRAIL, linkView, useLink } from '../data/link';
import { r2, zoneTxt } from '../data/run';
import { GOTO_WHY, defMods } from '../data/tmpl';
import { TERMS, ZONE_NOTE } from '../data/facts';
import { MODE_KO, MapCanvas, type MapApi } from '../map/MapCanvas';
import { LiveStatus, SimReset } from '../app/status';
import { useMapPick } from '../map/MapPick';
import { MapStartBox } from '../map/MapStartBox';
import { Drawer, SimOff, stopProps, toast } from '../app/shell';


// R04 가로(높이 ≤ 500): 틀 높이 = 화면(100dvh)이어도 «고른 목표» 칸(min-height auto)이 안 줄어 주 메뉴·STOP 이 화면 밖으로 밀림.
// 이 화면이 열려 있을 때만: 그 칸은 줄어들며 안에서 스크롤, 지도 칸은 최소 96 px 유지(실제 3D 도 — 숨은 바탕 svg 가 남음).
// 670 a9db ②(세로 360×640 지도 2 px): 높이 조건 없이 — 남는 높이가 96 px 이상이면 flex 가 줄이지 않으므로 넓은 세로(390×844)는 그대로. STOP·주 메뉴 크기 변경 0
const LAND_CSS = `#dc-root section[aria-label="고른 목표"]{min-height:0!important;overflow-y:auto!important}
#dc-root div:has(>svg[role="img"][preserveAspectRatio]){min-height:96px!important}
@media (max-height: 500px){
#dc-root .mmap-hdr>header{padding-top:6px!important;padding-bottom:4px!important}
#dc-root section[aria-label="고른 목표"]{margin-top:4px!important;padding-top:6px!important;padding-bottom:6px!important}
#dc-root nav[aria-label="주 메뉴"]{margin-top:0!important}
#dc-root div:has(>button[aria-label="비상 정지"]){padding-top:4px!important;padding-bottom:6px!important}}`;
// 높이 예산(root r2 · 4 검수창 STOP 64 전체·주 메뉴 전부 화면 안): 낮은 창(높이 ≤ 500)에서만 바깥 여백·비상호작용 padding 만 줄임 — 단추·메뉴·STOP 크기 0 변경.
// 계산(670 844×390 실측 header 108 · 지도 98 · section 최소 30(padding 28+선 2) · 메뉴 63 · STOP 칸 90 = 399): 줄임 header 14 · section 6+16 · 메뉴 위 10 · STOP 칸 16 = 62
// → 740×360 고정 합 ≈ 94+4+14+53+74 = 239 · 지도 ≈ 121(≥ 96). 실측 0 — 670 이 4창에서 STOP 사각형·메뉴 bottom ≤ 화면 높이 확인
export default function MMap() {
  const D = useDocs(), lk = linkView(useLink()), s = lk.s, api = useRef<MapApi | null>(null), busy = useRef(false);
  const { raster, pickEl, pose, live, on, blank, showLive, reload, flat, view, legend, v3d, bar } = useMapPick(false, false, true);   // fit3d 참: 3D 덧칸을 이 화면 작은 지도 칸에 맞춤(670 a9db ③) · 저장 지도 보기: 화면만. 보는 동안 로봇·길·구역·지점 고르기 끔(좌표 결속 전)
  const [sel0, setSel] = useState<number[] | null>(null), sel = on ? null : sel0, [layers, setLayers] = useState(false), [trail, setTrail] = useState(true), [zon, setZon] = useState(true);
  const [mid0, setMid] = useState(''), ms = docsOf(D, 'mission'), mid = ms.some((m) => m.id === mid0) ? mid0 : '';
  const d = sel && lk.robot?.fresh ? Math.hypot(lk.robot.x - sel[0], lk.robot.y - sel[1]) : null;
  const fresh = !!lk.robot?.fresh, [, redraw] = useState(0);

  const add = async () => {
    if (!sel || busy.current) return;   // 두 번 눌러 계획이 둘 생기지 않게
    const m = docById(D, mid) as { id: string; rev: number; doc: Mission } | null;
    if (m && m.doc.wps.length >= 30) return toast('지점은 30개까지');
    const doc: Mission = m ? structuredClone(m.doc) : { name: `휴대폰 계획 ${new Date().toTimeString().slice(0, 5)}`, tmpl: 'base', memo: '', wps: [] };
    const w = { x: sel[0], y: sel[1], name: `지점 ${doc.wps.length + 1}`, mods: defMods(D, m ? m.doc.tmpl : 'base') } as Waypoint; doc.wps.push(w);
    busy.current = true;
    const r = await saveDoc(m ? { op: 'put', kind: 'mission', id: m.id, rev: m.rev, doc } : { op: 'put', kind: 'mission', id: null, doc }); busy.current = false;
    toast(r.ok ? `«${doc.name}»에 ${w.name} 추가 · 모든 기기 공유` : r.code === 409 ? '다른 기기가 먼저 고침 — 다시 눌러 주세요' : `저장 안 됨 · ${r.error}`);   // 결과 알림만(화면 이동 없음)
  };
  const mode = api.current?.mode() || 'robot';

  const v = {
    themeClass: `${themeClass(false)} mmap-hdr`, stopProps, status: <LiveStatus D={D} />,   // mmap-hdr: 390 머리 반응형(live.css)
    hdrA: '지도', hdrB: v3d ? '건물 전체 3D' : on ? `${live ? '현재 열린 지도' : '저장 지도'} · ${!raster ? '지도 없음' : pose ? '위치 표시' : '위치 미표시'}` : `${flat ? '시뮬 바닥 ±10 m' : '지형 도면 없음'} · ${fresh ? '시뮬 위치 수신' : TRAIL.last ? '시뮬 위치 오래됨' : '시뮬 위치 미수신'}`,
    layerP: { 'aria-label': '지도 보기·레이어', 'aria-expanded': layers, onClick: () => setLayers(!layers) },
    mapBar: bar,   // U2-b 폰: 머리줄 안 «지형 + 2D/3D/SLAM»(세로 = 지도 바로 위 자기 줄 · 가로 = 제목 옆)(보기만 — 지도 보기 중 지점 고르기·구역·길 잠금은 아래 on 그대로)
    map: v3d || <><MapCanvas name="mmap" api={api} btns zones={D.err ? [] : docsOf(D, 'zone')} robot={on ? pose : lk.robot} trail={TRAIL.pts} showTrail={trail && !on} showZones={zon && !on} sel={sel}
      raster={raster} blank={blank} flat={flat} noRobot={on && !pose} onTap={on ? undefined : (x, y) => setSel([r2(x), r2(y)])} />
      {legend && <div style={{ position: 'absolute', left: 8, right: 8, bottom: 30, zIndex: 2, pointerEvents: 'none' }}>{legend}</div>}</>,
    // 10-15 ④: 아이콘 fab(◎·+·−) 대신 지도 안 글 버튼(MapCanvas btns — 같은 자리 오른쪽 위)
    fR: { hidden: true, tabIndex: -1 }, fI: { hidden: true, tabIndex: -1 }, fO: { hidden: true, tabIndex: -1 },
    hint: on ? '지도 보기 중 · 지점 고르기 꺼짐' : sel ? `고른 지점 · ${zoneTxt(D, sel[0], sel[1])}` : '지도를 눌러 지점을 고르세요',
    nb: sel ? '고른 지점' : '고른 지점 없음',
    xy: sel ? `x ${sgn(sel[0])} · y ${sgn(sel[1])} m` : s ? `로봇(시뮬 위치) ${posTxt(s.x, s.y)}` : '로봇 위치 없음(시뮬 위치 미수신)',
    dist: sel ? (d == null ? '미확인' : `${d.toFixed(1)} m`) : '—',
    eta: '미연결', etaTitle: '자동 이동이 없어 시간 예측 미연결',
    chk: <><span style={{ color: 'var(--warn)' }}>▲</span>{` 경로 검사 미연결 · 직선 거리 · ${GOTO_WHY}`}</>,
    cancelP: { disabled: !sel, onClick: () => setSel(null) },
    goP: { hidden: true, 'aria-hidden': true, tabIndex: -1 },   // B2 R11: 미연결 «이 목표로 이동» 큰 주 버튼 숨김 — 이유는 위 줄(chk)에
    addRow: sel ? <div className="lv-row">
      <select className="lv-inp" aria-label="지점을 넣을 계획" value={mid} onChange={(e) => setMid(e.target.value)}>
        <option value="">+ 새 계획으로</option>{ms.map((m) => <option key={m.id} value={m.id}>{`${m.doc.name} · 지점 ${m.doc.wps.length}`}</option>)}</select>
      <button type="button" className="lv-btn pri" onClick={add}>계획에 지점 추가</button></div>
      : <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}><button type="button" className="lv-btn pri" onClick={() => setLayers(true)}>시뮬 실행 · 지도 관리</button><SimReset t="리셋" /><SimOff className="lv-btn" /></span>,   // 지도 열기·저장 입구를 화면에 늘 보이게(서랍) + 리셋(10-18 root D8: 상단 «시뮬 ▾» 제거로 옮김 · 같은 SimReset) + 끄기 입구(STOP 은 위쪽 따로)
  };
  const B = (t: string, f: () => void) => <button type="button" className="lv-btn" onClick={() => { f(); redraw((n) => n + 1); }}>{t}</button>;
  const drawer = layers && <Drawer title="지도 열기 · 보기" onClose={() => setLayers(false)}>
      {pickEl}
      <p className="lv-note">«시뮬 실행»으로 선택한 지형을 시작합니다. 위 «지도 보기»는 화면만 바꿉니다.</p>
      <MapStartBox pc={false} onSaved={reload} onShowLive={live ? undefined : showLive} onView={view} />
      {B(`보기: ${MODE_KO[mode]} → ${mode === 'all' ? '로봇 중심' : '전체 고정'}`, () => api.current?.setMode(mode === 'all' ? 'robot' : 'all'))}
      {B(`지나온 길 ${trail ? '숨기기' : '보이기'}`, () => setTrail(!trail))}
      {B(`구역 ${zon ? '숨기기' : '보이기'}`, () => setZon(!zon))}
      <p className="lv-note">{`${flat ? '시뮬 바닥 도면 ±10 m · ' : ''}위치 = 시뮬 위치. ${ZONE_NOTE}`}</p>
      <details className="lv-note"><summary>용어</summary>{TERMS}</details>
    </Drawer>;
  return <><style>{CSS + LAND_CSS}</style><div id="dc-root"><View v={{ ...v, drawer }} /></div></>;
}
