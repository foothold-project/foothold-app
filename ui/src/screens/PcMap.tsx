// PC 지도(원본 틀): 시뮬 바닥 도면 위 구역(진입 금지·감속) 그리기·고치기·공유 — web/live.js pagePcMap 과 같은 규칙.
// 구역은 표시·공유만(로봇 주행 제한 미연결). SLAM 지도·위치 맞추기·지우개·3D 점군은 미연결 안내만. 예시 지도·예시 구역은 남기지 않는다.
import { useEffect, useRef } from 'react';
import type { Zone } from '@contracts';
import { CSS, View } from './PcMap.view';
import { deg, posTxt, saveBlob, themeClass } from '../data/fmt';
import { WHY, ZONE_NOTE } from '../data/facts';
import { docById, docsOf, useDocs } from '../data/shared';
import { useEditor } from '../data/editor';
import { TRAIL, linkView, useLink } from '../data/link';
import { r2, zonesAt } from '../data/run';
import { MapCanvas } from '../map/MapCanvas';
import { MapStartBox } from '../map/MapStartBox';
import { useMapPick } from '../map/MapPick';
import { LiveStatus } from '../app/status';
import { stopProps, toast, useRoute, whyProps } from '../app/shell';

const areaOf = (p: number[][]) => Math.abs(p.reduce((a, q, i) => { const n = p[(i + 1) % p.length]; return a + q[0] * n[1] - n[0] * q[1]; }, 0)) / 2;
const why = (t: string, cls: string) => ({ ...whyProps(t), className: `${cls} lv-why` });
const LOCK = '저장 지도 보기 중 — 구역은 «실행 중 시뮬 바닥»에서', BUSY = '구역 저장 중 — 끝난 뒤 다시', DIRTY = '저장 안 한 수정이 있습니다. 버릴까요?';
type Draw = { type: Zone['type']; pts: number[][]; name: string } | null;

export default function PcMap() {
  const D = useDocs(), lk = linkView(useLink()), s = lk.s, E = useEditor<Zone>('zone'), { q } = useRoute();
  const Z = useRef<Draw>(null), zn = useRef<HTMLInputElement>(null), dr = Z.current;
  const zs = D.err ? [] : docsOf(D, 'zone');
  const { raster, pickEl, pose, live, on: mv, blank, showLive, reload, flat, view, v3d } = useMapPick(false, true);   // mv = 지도 보기 중(그림 없어도 잠금)   // 저장 지도 보기: 화면만. 보는 동안 로봇·길·구역·초안 숨김, 구역 편집 잠금(초안은 그대로 보존)

  useEffect(() => { const sc = E.stale(D); if (sc && !E.dirty) E.load(sc); });   // 다른 기기가 고친 새 판(내 수정 없을 때만)
  const lost = () => !!(E.dirty || Z.current?.pts.length) && !confirm(DIRTY);
  const startDraw = (type: Zone['type']) => { if (mv) return toast(LOCK); if (E.busy) return toast(BUSY); if (lost()) return; E.load(null); Z.current = { type, pts: [], name: '' }; E.touch(); };
  const pickZone = (id: string | null) => { if (mv) return toast(LOCK); if (E.busy) return toast(BUSY); if (lost()) return; Z.current = null; E.load(id ? docById(D, id) : null); };
  const qd = q.get('draw');
  useEffect(() => { if (qd === '금지' || qd === '감속') startDraw(qd); }, [qd]);   // PcPlan «구역 그리기» → #/PcMap?draw=금지|감속

  const onTap = (x: number, y: number) => {
    if (E.busy) return toast(BUSY);
    const d = Z.current;
    if (d) { if (d.pts.length >= 40) return toast('꼭짓점은 40개까지'); d.pts.push([r2(x), r2(y)]); return E.touch(); }
    pickZone(zonesAt(D, x, y)[0]?.id ?? null);
  };
  const save = async () => {
    if (mv) return toast(LOCK);
    if (E.busy) return toast(BUSY);   // 두 번째 누름이 load 로 gen 을 올려 첫 성공 응답을 버리지 않게
    const d = Z.current;
    if (d) {
      if (d.pts.length < 3) return toast('꼭짓점을 3개 이상 찍으세요');
      if (!d.name.trim()) { zn.current?.focus(); return toast('구역 이름을 넣으세요'); }
      const snap = JSON.stringify(d);   // 저장 누른 그 초안 전체(꼭짓점·종류·이름)
      E.load(null, { name: d.name.trim(), type: d.type, pts: d.pts.slice() }); E.dirty = true; const g = E.gen;
      const r = await E.save();
      if (r && r.ok && Z.current === d && E.gen === g && JSON.stringify(d) === snap) { Z.current = null; E.touch(); toast('구역 저장됨 · 모든 기기 공유'); }   // 저장 누른 그 초안·그 판일 때만 지움
      return;
    }
    if (!E.id || !E.d) return toast('저장할 구역이 없습니다 — 도구줄에서 구역을 그리세요');
    if (!E.d.name.trim()) return toast('구역 이름을 넣으세요');
    E.save();
  };
  const del = async () => {
    if (mv) return toast(LOCK);
    if (E.busy) return toast(BUSY);
    const d = Z.current;
    if (d) { if (d.pts.length) d.pts.pop(); else Z.current = null; return E.touch(); }
    const r = await E.del();
    if (r && r.ok && r.same) { E.load(null); toast('구역 지움'); }   // 응답 때 같은 구역·같은 초안일 때만 정리(아니면 del 이 결과만 알림)
  };
  const edit = (f: (z: Zone) => void) => { if (E.d) { f(E.d); E.dirty = true; } E.touch(); };

  const ty = dr ? dr.type : E.d?.type, on = !mv && !!(dr || E.id);
  const lbl = (t: Zone['type']) => (t === '금지' ? '진입 금지' : '감속');
  const vals = {
    themeClass: themeClass(true), stopProps, status: <LiveStatus D={D} />,
    hdrA: '지도', hdrB: v3d ? '건물 전체 3D · GT 간략 기하(센서 아님)' : mv ? `${raster ? raster.label : live ? '현재 열린 지도' : '저장 지도'} · ${!raster ? '지도 없음' : pose ? '위치 표시' : '위치 미표시'}` : `${flat ? '시뮬 바닥 도면 ±10 m' : '지형 도면 없음'} · Gazebo GT 위치(SLAM 지도 아님)`, pill: mv ? (live ? '현재 열린 지도(보기만)' : '저장 지도(보기만)') : '시뮬 바닥 도면',
    posDot: s ? '●' : '▲', posDotS: { color: `var(--${s ? 'ok' : 'warn'})` },
    posTxt: s ? `GT ${posTxt(s.x, s.y)} · ${deg(s.yaw)}` : TRAIL.last ? 'GT 오래됨' : 'GT 미수신',
    newP: { className: 'btn pri', title: '«지도 열기»로 이동 — SLAM 지도 만들기·저장', onClick: () => { const el = document.getElementById('fh-mapopen'); el?.scrollIntoView({ block: 'start' }); (el?.querySelector('button[aria-pressed="true"]') as HTMLElement | null)?.focus(); } },   // 10-14: 미연결 안내만 하던 버튼 → 실제 «지도 열기» 상자로 이동(시작은 그 상자에서 확인 뒤)
    lbl0: '지도 만들기·저장은 아래 «지도 열기»(SLAM 지도 만들기)와 «SLAM 지도 저장»으로 합니다. 위치 맞추기는 미연결.', lbl1: 'Gazebo · foothold-v2',
    mpName: '시뮬 바닥 ±10 m', mpSub: '1 m 격자 · 사용 중 · 구역은 표시·공유만', oldHide: true,
    floorNote: <span style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{pickEl}<MapStartBox pc onSaved={reload} onShowLive={live ? undefined : showLive} onView={view} /><span>지도 보기는 화면만 바뀝니다 — 실제 world·층 전환·위치 맞추기 없음</span></span>,
    tools: [{ ...why(`위치 맞추기 — ${WHY['SLAM 지도·위치 맞추기']}`, 'tool'), 'aria-pressed': false },   // 시안의 «눌림» 표시 제거(미연결 도구)
      { 'aria-pressed': !mv && dr?.type === '금지', disabled: mv, onClick: () => startDraw('금지') },
      { 'aria-pressed': !mv && dr?.type === '감속', disabled: mv, onClick: () => startDraw('감속') },
      { 'aria-pressed': !mv && !!E.id && !dr, disabled: mv, onClick: () => mv ? toast(LOCK) : E.id ? (zn.current?.focus(), zn.current?.select()) : toast('먼저 지도나 목록에서 구역을 고르세요') },   // R28: 함수 반환만 하던 분기 → 즉시 실행
      why('지우개(잡음 정리) — SLAM 지도 미연결', 'tool')],
    v3P: whyProps(`3D 점군 — ${WHY['뎁스 영상·3D 점군']}`),
    map: v3d || <MapCanvas name="pcmap" btns zones={zs} robot={mv ? pose : lk.robot} trail={TRAIL.pts} draft={mv ? null : dr} hiZone={mv ? null : E.id} onTap={mv ? undefined : onTap}
      raster={raster} blank={blank} flat={flat} noRobot={mv && !pose} showTrail={!mv} showZones={!mv} />,
    gL: mv ? '로봇·지나온 길·구역·그리던 초안은 숨김(초안은 보존). 구역 편집은 «실행 중 시뮬 바닥»으로 돌아가면 그대로 이어집니다.' : dr ? `지도를 눌러 꼭짓점 추가(3개 이상 · ${dr.pts.length}개) → 오른쪽에서 이름 넣고 저장. «구역 삭제»는 마지막 점 지우기. 끌면 지도 이동.`
      : '도구줄에서 진입 금지·감속 구역을 고른 뒤 지도를 눌러 그립니다. 지도의 구역을 누르면 고칠 수 있습니다.',
    zColor: { background: `var(--${ty === '감속' ? 'warn' : 'bad'})`, borderColor: `var(--${ty === '감속' ? 'warn' : 'bad'})` },
    zHead: dr ? `새 ${dr.type} 구역` : E.id && E.d ? `${lbl(E.d.type)} 구역 · 판 ${E.rev}` : '구역을 고르세요',
    zaLbl: '종류',
    zn: <input id="zn" ref={zn} className="inp" maxLength={40} placeholder="구역 이름(예: 계단 앞)" disabled={!on || E.busy} value={dr ? dr.name : E.d?.name ?? ''}
      onChange={(e) => { if (dr) { dr.name = e.target.value; E.touch(); } else edit((z) => { z.name = e.target.value; }); }} />,
    za: <select id="za" className="inp" disabled={!on || E.busy} value={ty || '금지'}
      onChange={(e) => { const t = e.target.value as Zone['type']; if (E.busy) return toast(BUSY); if (dr) { dr.type = t; E.touch(); } else edit((z) => { z.type = t; }); }}>
      <option value="금지">진입 금지</option><option value="감속">감속</option></select>,
    zNote: ZONE_NOTE,
    delP: { onClick: del, disabled: !on }, delT: dr ? '마지막 점 지우기' : '구역 삭제',
    saveP: { onClick: save, disabled: !on }, msg: E.msg,
    zListH: `이 도면의 구역 ${zs.length}개`,
    zRows: zs.length ? zs.map((z) => (
      <span key={z.id} role="button" tabIndex={0} onClick={() => pickZone(z.id)} onKeyDown={(e) => { if (e.key === 'Enter') pickZone(z.id); }}
        style={{ display: 'flex', justifyContent: 'space-between', cursor: 'pointer', outline: z.id === E.id ? '1px solid var(--accent)' : undefined }}>
        <span><span style={{ color: `var(--${z.doc.type === '금지' ? 'bad' : 'warn'})` }}>{z.doc.type === '금지' ? '■' : '▲'}</span>{` ${z.doc.name} · ${lbl(z.doc.type)}`}</span>
        <span className="lbl">{`${areaOf(z.doc.pts).toFixed(1)} m² · ${z.by}`}</span></span>))
      : <span className="lbl">{D.err ? `구역 목록 미확인 · ${D.err}` : D.rev == null ? '읽는 중…' : '저장된 구역 없음'}</span>,
    kv: (mv && !raster ? [['도면', v3d ? '건물 전체 3D · GT 간략 기하' : blank || '지도 없음'], ['위치', '미표시'], ['구역', '숨김 · 편집 잠금']] : raster ? [['도면', raster.label], ['크기', `${(raster.w * raster.res).toFixed(1)} × ${(raster.h * raster.res).toFixed(1)} m`], ['격자', '1 m'], ['위치', pose ? '실시간 status pose(같은 epoch·1 s 안)' : '미표시(지도와 결속 안 됨)'], ['구역', '숨김 · 편집 잠금']]
      : [['도면', 'Gazebo 바닥(world_live.sdf)'], ['만든 사람', '시뮬 설정(앱 아님)'], ['크기', '20 × 20 m'], ['격자', '1 m'], ['방법', '시뮬 정답 위치(GT) · SLAM 미연결'],
      ['위치 추정', 'Gazebo GT(추정 아님)'], ['구역', D.err ? '미확인' : `${zs.length}개 · 표시·공유만`]]).flatMap(([a, b]) => [<span key={a} className="lbl">{a}</span>, <span key={`${a}v`}>{b}</span>]),
    exT: '구역 내보내기 (JSON)',
    exP: { onClick: () => toast(D.err ? '구역 목록 미확인 — 내보내지 않음' : saveBlob(`foothold-v2-zones-${Date.now()}.json`, new Blob([JSON.stringify(zs.map((z) => ({ id: z.id, rev: z.rev, by: z.by, at: z.at, ...z.doc })), null, 1)], { type: 'application/json' }))) },
    reP: why(`다시 만들기 — ${WHY['SLAM 지도·위치 맞추기']}`, 'btn'),
  };
  return <><style>{CSS}</style><div id="dc-root"><View v={vals} /></div></>;
}
