// 휴대폰 현황(원본 틀): 진행 중 수동 임무 · 미니맵 · 지점에서 할 일 · 기록 버튼 — web/live.js pageMHome 과 같은 규칙.
// 로봇은 자동으로 움직이지 않는다(자동 이동·도착 판정 미연결). 가스·발견물 칸은 실데이터가 없어 숨긴다(예시값 금지).
import { useState } from 'react';
import type { Mission } from '@contracts';
import { CSS, View } from './MHome.view';
import { durTxt, store, themeClass, tms, wpName } from '../data/fmt';
import { activeRun, alertsOf, docsOf, useDocs, useMedia } from '../data/shared';
import { TRAIL, linkView, useLink } from '../data/link';
import { attachPhoto, curWp, modDone, modTxt, runEnd, startRun } from '../data/run';
import { useEditor } from '../data/editor';
import { href } from '../data/hist';
import { MapCanvas } from '../map/MapCanvas';
import { LiveStatus } from '../app/status';
import { stopProps, toast } from '../app/shell';
import { Btn, WpActs } from '../app/runui';

const READ = 'fh.live.alerts.read';
export default function MHome() {
  const D = useDocs(), M = useMedia(), lk = linkView(useLink()), E = useEditor<Mission>('mission');
  const [endOpen, setEndOpen] = useState(false), [pick, setPick] = useState('');
  const run = activeRun(D), R = run?.doc, ci = R ? curWp(R) : -1, w = R && ci >= 0 ? R.wps[ci] : null;
  const ms = docsOf(D, 'mission'), mid = ms.some((m) => m.id === pick) ? pick : ms[0]?.id || '';
  const d = w && lk.robot?.fresh ? Math.hypot(lk.robot.x - w.x, lk.robot.y - w.y) : null;
  const vis = R ? R.wps.filter((x) => x.st !== '대기').length : 0;
  const rd = store.get(READ, ''), unread = alertsOf(M).filter((e) => !rd || tms(e.at) > tms(rd)).length;
  const rows: [boolean, string][] = w ? [[w.st !== '대기', '방문 기록 · 운영자가 «방문 확인»(자동 도착 판정 미연결)'], ...w.mods.map((ty): [boolean, string] => [modDone(w, ty), modTxt(w, ty)])]
    : [[false, R ? '대기 지점 없음' : '계획을 고르고 «수동 진행 시작»을 누르면 지점마다 할 일이 여기에 나옵니다']];
  const tile: React.CSSProperties = { aspectRatio: '4/3', borderRadius: '6px', background: '#0D1317', overflow: 'hidden' };
  const pb = async () => { if (run) return setEndOpen(!endOpen); await startRun(D, mid, (m) => E.write(m).then((x) => x && x.r)); };
  const cam = () => { if (!run || ci < 0) return toast('기록 중인 지점이 없습니다'); attachPhoto(run.id, ci); };

  const v = {
    themeClass: themeClass(false), stopProps, isBase: true, isGas: false, hasFind: false, bodyOverflow: 'auto',
    name: 'Go2 시뮬 · v2',
    linkLine: <span style={{ fontSize: '13px', color: 'var(--muted)' }}><span style={{ color: `var(--${lk.linkOk ? 'ok' : 'warn'})` }}>{lk.linkOk ? '●' : '▲'}</span>{` 링크 ${lk.linkTxt} · 배터리 미제공`}</span>,
    status: <LiveStatus D={D} />,
    alertP: { href: href('MAlerts'), 'aria-label': `알림 ${unread}건(읽지 않음)` }, alertN: String(unread),
    missionLine: R ? `수동 진행 · ${R.tmpl || '양식 없음'} · ${durTxt(R.started)}` : '진행 중 수동 임무 없음', mtagHide: !R,
    big: R ? `${vis}/${R.wps.length} · ${w ? `${wpName(w, ci)} 기록 차례` : '모든 지점 기록됨'}` : '시작할 계획을 고르세요',
    segsP: { style: { display: 'grid', gap: '4px', gridTemplateColumns: `repeat(${Math.max(1, R ? R.wps.length : 1)},minmax(0,1fr))` }, 'aria-label': R ? `${R.wps.length}지점 중 ${vis}지점 기록` : '진행 중 임무 없음' },
    segs: (R ? R.wps : []).map((x, i) => <span key={i} style={{ height: '6px', borderRadius: '3px', background: `var(--${x.st === '방문' ? 'ok' : x.st === '미방문' ? 'warn' : i === ci ? 'accent' : 'line'})` }} />),
    rest: <span className="lbl">{!R ? '계획을 고르고 «수동 진행 시작» — 로봇은 자동으로 움직이지 않습니다' : w ? `다음 지점까지 ${d == null ? '거리 미확인' : `${d.toFixed(1)} m 직선`} · 자동 이동 미연결 · 직접 조종` : '모든 지점 기록됨 · «임무 끝내기»로 완료'}</span>,
    pick: R ? null : <select className="lv-inp" aria-label="시작할 계획" value={mid} onChange={(e) => setPick(e.target.value)}>
      {ms.length ? ms.map((m) => <option key={m.id} value={m.id}>{`${m.doc.name} · 지점 ${m.doc.wps.length}`}</option>) : <option value="">저장된 계획 없음 — PC «임무 계획»에서 만들기</option>}</select>,
    map: <a href={href('MMap')} aria-label="지도 크게 보기" style={{ display: 'block', position: 'relative', width: '100%', height: '132px', borderTop: '1px solid var(--line)' }}>
      <MapCanvas name="mhome" small wps={R ? R.wps : null} trail={TRAIL.pts} robot={lk.robot} zones={D.err ? [] : docsOf(D, 'zone')} /></a>,
    tTitle: w ? `${wpName(w, ci)}에서 할 일` : '지점에서 할 일', tSub: R ? `${R.tmpl || '양식'} 모듈 · 운영자 기록` : '진행 중 임무 없음',
    grid: rows.map(([done, t], i) => [
      <span key={`a${i}`} style={{ width: '12px', height: '12px', borderRadius: '50%', border: `2px solid var(--${done ? 'ok' : 'line2'})`, background: done ? 'var(--ok)' : undefined, justifySelf: 'center' }} />,
      <span key={`b${i}`}>{t}</span>]),
    tilesHide: !w,
    tiles: w && <>{w.photos.slice(-2).map((u) => <div key={u} style={tile}><a href={href('MFinding', { url: u })}><img src={u} alt="붙인 사진" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} /></a></div>)}
      <div role="button" tabIndex={0} className="lbl" onClick={cam} onKeyDown={(e) => { if (e.key === 'Enter') cam(); }}
        style={{ aspectRatio: '4/3', borderRadius: '6px', border: '1.5px dashed var(--line2)', display: 'grid', placeItems: 'center', cursor: 'pointer' }}>{`📷 ${wpName(w, ci).split(' ')[0]} 사진`}</div></>,
    acts: run && w ? <WpActs id={run.id} i={ci} w={w} /> : null,
    pbP: { onClick: pb, disabled: !R && !ms.length }, pbT: R ? (endOpen ? '임무 끝내기 닫기' : '임무 끝내기…') : '수동 진행 시작',
    ends: run && endOpen ? <div style={{ padding: '0 14px' }}><div className="lv-row">{(['완료', '실패', '중단'] as const).map((s) =>
      <Btn key={s} pri={s === '완료'} t={`임무 ${s}`} on={() => runEnd(run.id, s)} />)}</div></div> : null,
  };
  return <><style>{CSS}</style><div id="dc-root"><View v={v} /></div></>;
}
