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
import { LiveStatus } from '../app/status';
import { stopProps, toast, useRoute, whyProps } from '../app/shell';

const areaOf = (p: number[][]) => Math.abs(p.reduce((a, q, i) => { const n = p[(i + 1) % p.length]; return a + q[0] * n[1] - n[0] * q[1]; }, 0)) / 2;
const why = (t: string, cls: string) => ({ ...whyProps(t), className: `${cls} lv-why` });
const BUSY = '구역 저장 중 — 끝난 뒤 다시', DIRTY = '저장 안 한 수정이 있습니다. 버릴까요?';
type Draw = { type: Zone['type']; pts: number[][]; name: string } | null;

export default function PcMap() {
  const D = useDocs(), lk = linkView(useLink()), s = lk.s, E = useEditor<Zone>('zone'), { q } = useRoute();
  const Z = useRef<Draw>(null), zn = useRef<HTMLInputElement>(null), dr = Z.current;
  const zs = D.err ? [] : docsOf(D, 'zone');

  useEffect(() => { const sc = E.stale(D); if (sc && !E.dirty) E.load(sc); });   // 다른 기기가 고친 새 판(내 수정 없을 때만)
  const lost = () => !!(E.dirty || Z.current?.pts.length) && !confirm(DIRTY);
  const startDraw = (type: Zone['type']) => { if (E.busy) return toast(BUSY); if (lost()) return; E.load(null); Z.current = { type, pts: [], name: '' }; E.touch(); };
  const pickZone = (id: string | null) => { if (E.busy) return toast(BUSY); if (lost()) return; Z.current = null; E.load(id ? docById(D, id) : null); };
  const qd = q.get('draw');
  useEffect(() => { if (qd === '금지' || qd === '감속') startDraw(qd); }, [qd]);   // PcPlan «구역 그리기» → #/PcMap?draw=금지|감속

  const onTap = (x: number, y: number) => {
    if (E.busy) return toast(BUSY);
    const d = Z.current;
    if (d) { if (d.pts.length >= 40) return toast('꼭짓점은 40개까지'); d.pts.push([r2(x), r2(y)]); return E.touch(); }
    pickZone(zonesAt(D, x, y)[0]?.id ?? null);
  };
  const save = async () => {
    if (E.busy) return toast(BUSY);   // 두 번째 누름이 load 로 gen 을 올려 첫 성공 응답을 버리지 않게
    const d = Z.current;
    if (d) {
      if (d.pts.length < 3) return toast('꼭짓점을 3개 이상 찍으세요');
      if (!d.name.trim()) { zn.current?.focus(); return toast('구역 이름을 넣으세요'); }
      const n = d.pts.length;
      E.load(null, { name: d.name.trim(), type: d.type, pts: d.pts.slice() }); E.dirty = true; const g = E.gen;
      const r = await E.save();
      if (r && r.ok && Z.current === d && E.gen === g && d.pts.length === n) { Z.current = null; E.touch(); toast('구역 저장됨 · 모든 기기 공유'); }   // 저장 누른 그 초안·그 판일 때만 지움
      return;
    }
    if (!E.id || !E.d) return toast('저장할 구역이 없습니다 — 도구줄에서 구역을 그리세요');
    if (!E.d.name.trim()) return toast('구역 이름을 넣으세요');
    E.save();
  };
  const del = async () => {
    if (E.busy) return toast(BUSY);
    const d = Z.current;
    if (d) { if (d.pts.length) d.pts.pop(); else Z.current = null; return E.touch(); }
    const g = E.gen, r = await E.del();
    if (r && r.ok) { if (E.gen === g) E.load(null); toast('구역 지움'); }   // 그사이 다른 구역을 열었으면 그대로 둠
  };
  const edit = (f: (z: Zone) => void) => { if (E.d) { f(E.d); E.dirty = true; } E.touch(); };

  const ty = dr ? dr.type : E.d?.type, on = !!(dr || E.id);
  const lbl = (t: Zone['type']) => (t === '금지' ? '진입 금지' : '감속');
  const vals = {
    themeClass: themeClass(true), stopProps, status: <LiveStatus D={D} />,
    hdrA: '지도', hdrB: '시뮬 바닥 도면 ±10 m · Gazebo GT 위치(SLAM 지도 아님)', pill: '시뮬 바닥 도면',
    posDot: s ? '●' : '▲', posDotS: { color: `var(--${s ? 'ok' : 'warn'})` },
    posTxt: s ? `GT ${posTxt(s.x, s.y)} · ${deg(s.yaw)}` : TRAIL.last ? 'GT 오래됨' : 'GT 미수신',
    newP: why(`새 지도 만들기 — ${WHY['SLAM 지도·위치 맞추기']}`, 'btn pri'),
    lbl0: 'SLAM 지도 만들기·저장은 미연결입니다. 지금 지도는 시뮬 바닥 도면 하나입니다.', lbl1: 'Gazebo · foothold-v2',
    mpName: '시뮬 바닥 ±10 m', mpSub: '1 m 격자 · 사용 중 · 구역은 표시·공유만', oldHide: true,
    floorNote: '층·지도 바꾸기 미연결 — 층 사이 이동·위치 맞추기 없음',
    tools: [{ ...why(`위치 맞추기 — ${WHY['SLAM 지도·위치 맞추기']}`, 'tool'), 'aria-pressed': false },   // 시안의 «눌림» 표시 제거(미연결 도구)
      { 'aria-pressed': dr?.type === '금지', onClick: () => startDraw('금지') },
      { 'aria-pressed': dr?.type === '감속', onClick: () => startDraw('감속') },
      { 'aria-pressed': !!E.id && !dr, onClick: () => (E.id ? zn.current?.focus() : toast('먼저 지도나 목록에서 구역을 고르세요')) },
      why('지우개(잡음 정리) — SLAM 지도 미연결', 'tool')],
    v3P: whyProps(`3D 점군 — ${WHY['뎁스 영상·3D 점군']}`),
    map: <MapCanvas name="pcmap" btns zones={zs} robot={lk.robot} trail={TRAIL.pts} draft={dr} hiZone={E.id} onTap={onTap} />,
    gT: dr ? `${dr.type} 구역 그리는 중` : E.id ? '구역 고름' : '구역',
    gL: dr ? `지도를 눌러 꼭짓점 추가(3개 이상 · ${dr.pts.length}개) → 오른쪽에서 이름 넣고 저장. «구역 삭제»는 마지막 점 지우기. 끌면 지도 이동.`
      : '도구줄에서 진입 금지·감속 구역을 고른 뒤 지도를 눌러 그립니다. 지도의 구역을 누르면 고칠 수 있습니다.',
    gS: <><span style={{ color: 'var(--warn)' }}>▲</span>{' 구역은 표시·공유만 · 주행 제한 미연결'}</>,
    zColor: { background: `var(--${ty === '감속' ? 'warn' : 'bad'})`, borderColor: `var(--${ty === '감속' ? 'warn' : 'bad'})` },
    zHead: dr ? `새 ${dr.type} 구역` : E.id && E.d ? `${lbl(E.d.type)} 구역 · 판 ${E.rev}` : '구역을 고르세요',
    zaLbl: '종류',
    zn: <input id="zn" ref={zn} className="inp" maxLength={40} placeholder="구역 이름(예: 계단 앞)" disabled={!on} value={dr ? dr.name : E.d?.name ?? ''}
      onChange={(e) => { if (dr) { dr.name = e.target.value; E.touch(); } else edit((z) => { z.name = e.target.value; }); }} />,
    za: <select id="za" className="inp" disabled={!on} value={ty || '금지'}
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
    kv: [['도면', 'Gazebo 바닥(world_live.sdf)'], ['만든 사람', '시뮬 설정(앱 아님)'], ['크기', '20 × 20 m'], ['격자', '1 m'], ['방법', '시뮬 정답 위치(GT) · SLAM 미연결'],
      ['위치 추정', 'Gazebo GT(추정 아님)'], ['구역', D.err ? '미확인' : `${zs.length}개 · 표시·공유만`]].flatMap(([a, b]) => [<span key={a} className="lbl">{a}</span>, <span key={`${a}v`}>{b}</span>]),
    exT: '구역 내보내기 (JSON)',
    exP: { onClick: () => toast(D.err ? '구역 목록 미확인 — 내보내지 않음' : saveBlob(`foothold-v2-zones-${Date.now()}.json`, new Blob([JSON.stringify(zs.map((z) => ({ id: z.id, rev: z.rev, by: z.by, at: z.at, ...z.doc })), null, 1)], { type: 'application/json' }))) },
    reP: why(`다시 만들기 — ${WHY['SLAM 지도·위치 맞추기']}`, 'btn'),
  };
  return <><style>{CSS}</style><div id="dc-root"><View v={vals} /></div></>;
}
