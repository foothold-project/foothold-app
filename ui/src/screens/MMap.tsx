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
import { ZONE_NOTE } from '../data/facts';
import { MODE_KO, MapCanvas, type MapApi } from '../map/MapCanvas';
import { LiveStatus } from '../app/status';
import { useMapPick } from '../map/MapPick';
import { MapStartBox } from '../map/MapStartBox';
import { Drawer, SimOff, stopProps, toast, whyProps } from '../app/shell';


export default function MMap() {
  const D = useDocs(), lk = linkView(useLink()), s = lk.s, api = useRef<MapApi | null>(null), busy = useRef(false);
  const { raster, pickEl, pose, live, on, blank, showLive, reload, flat } = useMapPick(false);   // 저장 지도 보기: 화면만. 보는 동안 로봇·길·구역·지점 고르기 끔(좌표 결속 전)
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
    themeClass: themeClass(false), stopProps, status: <LiveStatus D={D} />,
    hdrA: '지도', hdrB: on ? `${live ? '실시간 지도' : '저장 지도'} · ${!raster ? '지도 없음' : pose ? '위치 표시' : '위치 미표시'}` : `${flat ? '시뮬 바닥 ±10 m' : 'GT 위치(지형 도면 없음)'} · ${fresh ? 'GT 위치 수신' : TRAIL.last ? 'GT 오래됨' : 'GT 미수신'}(SLAM 아님)`,
    layerP: { 'aria-label': '지도 보기·레이어', 'aria-expanded': layers, onClick: () => setLayers(!layers) },
    map: <><MapCanvas name="mmap" api={api} zones={D.err ? [] : docsOf(D, 'zone')} robot={on ? pose : lk.robot} trail={TRAIL.pts} showTrail={trail && !on} showZones={zon && !on} sel={sel}
      raster={raster} blank={blank} flat={flat} noRobot={on && !pose} onTap={on ? undefined : (x, y) => setSel([r2(x), r2(y)])} /></>,
    fR: { 'data-m': 'robot', onClick: () => api.current?.setMode('robot') }, fI: { onClick: () => api.current?.zoomBy(1.5) }, fO: { onClick: () => api.current?.zoomBy(1 / 1.5) },
    hint: on ? '지도 보기 중 · 지점 고르기 꺼짐' : sel ? `고른 지점 · ${zoneTxt(D, sel[0], sel[1])}` : '지도를 눌러 지점을 고르세요',
    nb: sel ? '고른 지점' : '고른 지점 없음',
    xy: sel ? `x ${sgn(sel[0])} · y ${sgn(sel[1])} m` : s ? `로봇 GT ${posTxt(s.x, s.y)}` : '로봇 위치 없음(GT 미수신)',
    dist: sel ? (d == null ? '미확인' : `${d.toFixed(1)} m`) : '—',
    eta: '미연결', etaTitle: '자동 이동이 없어 시간 예측 미연결',
    chk: <><span style={{ color: 'var(--warn)' }}>▲</span>{' 경로 검사 미연결 · 직선 거리'}</>,
    cancelP: { disabled: !sel, onClick: () => setSel(null) },
    goP: whyProps(GOTO_WHY),
    addRow: sel ? <div className="lv-row">
      <select className="lv-inp" aria-label="지점을 넣을 계획" value={mid} onChange={(e) => setMid(e.target.value)}>
        <option value="">+ 새 계획으로</option>{ms.map((m) => <option key={m.id} value={m.id}>{`${m.doc.name} · 지점 ${m.doc.wps.length}`}</option>)}</select>
      <button type="button" className="lv-btn pri" onClick={add}>계획에 지점 추가</button></div> : <SimOff className="lv-btn" />,   // 지도 체험 중에도 끄기 입구(STOP 은 위쪽 따로)
  };
  const B = (t: string, f: () => void) => <button type="button" className="lv-btn" onClick={() => { f(); redraw((n) => n + 1); }}>{t}</button>;
  const drawer = layers && <Drawer title="지도 보기" onClose={() => setLayers(false)}>
      {pickEl}
      <MapStartBox pc={false} onSaved={reload} onShowLive={live ? undefined : showLive} />
      {B(`보기: ${MODE_KO[mode]} → ${mode === 'all' ? '로봇 중심' : '전체 보기'}`, () => api.current?.setMode(mode === 'all' ? 'robot' : 'all'))}
      {B(`지나온 길 ${trail ? '숨기기' : '보이기'}`, () => setTrail(!trail))}
      {B(`구역 ${zon ? '숨기기' : '보이기'}`, () => setZon(!zon))}
      <p className="lv-note">{`${flat ? '시뮬 바닥 도면 ±10 m · ' : ''}Gazebo GT 위치(SLAM 지도 아님). ${ZONE_NOTE}`}</p>
    </Drawer>;
  return <><style>{CSS}</style><div id="dc-root"><View v={{ ...v, drawer }} /></div></>;
}
