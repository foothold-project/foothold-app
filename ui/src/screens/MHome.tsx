// 휴대폰 현황(원본 틀): 진행 중 수동 임무 · 미니맵 · 지점에서 할 일 · 기록 버튼 — web/live.js pageMHome 과 같은 규칙.
// 로봇은 자동으로 움직이지 않는다(자동 이동·도착 판정 미연결). 가스·발견물 칸은 실데이터가 없어 숨긴다(예시값 금지).
import { Photo } from '../app/Photo';
import { useEffect, useRef, useState } from 'react';
import type { Mission } from '@contracts';
import { CSS, View } from './MHome.view';
import { durTxt, themeClass, wpName } from '../data/fmt';
import { unreadOf } from '../data/alerts';
import { activeRun, alertsOf, docsOf, useDocs, useMedia } from '../data/shared';
import { TRAIL, dropAsk, linkView, useLink } from '../data/link';
import { attachPhoto, finishText, startText, pickWp, modDone, modTxt, runEnd, runHere, startRun } from '../data/run';
import { useEditor } from '../data/editor';
import { useSel } from '../data/scratch';
import { href } from '../data/hist';
import { MapCanvas } from '../map/MapCanvas';
import { LiveStatus } from '../app/status';
import { toast } from '../app/shell';
import { Btn, WpActs } from '../app/runui';
import { SafeLine } from '../app/chip';

// R04 가로(높이 ≤ 500): 본문 안 «조종 화면»이 스크롤 아래로 밀리므로 STOP 줄 왼쪽에도 같은 링크(STOP 크기·위치 규칙은 그대로, 줄 왼쪽만 비움)
const DRIVE_CSS = `.mh-drive{display:none}
@media (orientation: landscape) and (max-height: 500px){
.mh-drive{display:flex;align-items:center;justify-content:center;position:fixed;left:16px;bottom:18px;width:160px;height:64px;z-index:5;border-radius:12px;background:var(--accent);color:var(--on-accent);font-weight:700;text-decoration:none;box-sizing:border-box}}`;   /* 10-19: STOP 줄 왼쪽 비움 규칙 삭제 — STOP 은 공통 GlobalStop(오른쪽 위) */
export default function MHome() {
  const D = useDocs(), M = useMedia(), L = useLink(), lk = linkView(L), E = useEditor<Mission>('mission');
  const [endOpen, setEndOpen] = useState(false), [pick, setPick] = useState('');
  const sel = useSel((x) => { const r = activeRun(D); return r ? x[r.id] : undefined; });
  const run = activeRun(D), R = run?.doc, ci = R ? pickWp(R, sel).i : -1, w = R && ci >= 0 ? R.wps[ci] : null;
  const ms = docsOf(D, 'mission'), mid = ms.some((m) => m.id === pick) ? pick : ms[0]?.id || '';
  const here = runHere(R, L);   // 거리·지점 겹치기는 기록 출처가 지금 지도와 같을 때만
  const d = w && here.ok && lk.robot?.fresh ? Math.hypot(lk.robot.x - w.x, lk.robot.y - w.y) : null;
  const vis = R ? R.wps.filter((x) => x.st !== '대기').length : 0;
  const unread = unreadOf(alertsOf(M)).length;
  const rows: [boolean, string][] = w ? [[w.st !== '대기', '방문 기록 · 운영자가 «방문 확인»(자동 도착 판정 미연결)'], ...w.mods.map((ty): [boolean, string] => [modDone(w, ty), modTxt(w, ty)])]
    : [[false, R ? '대기 지점 없음' : '계획을 고르고 «수동 진행 시작»을 누르면 지점마다 할 일이 여기에 나옵니다']];
  const tile: React.CSSProperties = { aspectRatio: '4/3', borderRadius: '6px', background: '#0D1317', overflow: 'hidden' };
  // E1: 확인창 주인 = 이 화면의 그 계획 선택. 다른 계획 고르기·화면 떠남 = 창 닫힘 + 확인 뒤 쓰기 0
  const own = useRef({ mid, on: true }); own.current.mid = mid;
  const [tag] = useState(() => ({}));
  useEffect(() => { own.current.on = true; return () => { own.current.on = false; dropAsk(tag); }; }, [tag, mid]);
  const pb = async (e?: React.MouseEvent<HTMLElement>) => { if (run) return setEndOpen(!endOpen); const m0 = mid;   // P2-B: e.currentTarget = 연 단추(동기로 넘김)
    await startRun(D, mid, (m) => E.write(m).then((x) => x && x.r), { owner: tag, alive: () => own.current.on && own.current.mid === m0, anchor: e?.currentTarget }); };
  const cam = () => { if (!run || ci < 0) return toast('기록 중인 지점이 없습니다'); attachPhoto(run.id, ci); };

  const v = {
    themeClass: themeClass(false), safe: <p style={{ margin: '6px 0 0' }}><SafeLine /></p>,   // U2: STOP 바로 아래 안전 한 줄 + ?
    isBase: true, isGas: false, hasFind: false, bodyOverflow: 'auto',
    name: 'Go2 시뮬',
    linkLine: <span style={{ fontSize: '13px', color: 'var(--muted)' }}>배터리 정보 없음</span>,   // B2 R16: 링크는 바로 아래 상태 줄(LiveStatus) 한 곳만
    status: <LiveStatus D={D} />,
    alertP: { href: href('MAlerts'), 'aria-label': `알림 ${unread}건(읽지 않음)` }, alertN: String(unread),
    missionLine: R ? `수동 진행 · ${R.tmpl || '양식 없음'} · ${finishText(R)} · ${startText(R)} · ${durTxt(R.started)}` : '진행 중 수동 임무 없음', mtagHide: !R,
    big: R ? `${vis}/${R.wps.length} · ${w ? `${wpName(w, ci)} 기록 차례` : '모든 지점 기록됨'}` : '시작할 계획을 고르세요',
    segsP: { style: { display: 'grid', gap: '4px', gridTemplateColumns: `repeat(${Math.max(1, R ? R.wps.length : 1)},minmax(0,1fr))` }, 'aria-label': R ? `${R.wps.length}지점 중 ${vis}지점 기록` : '진행 중 임무 없음' },
    segs: (R ? R.wps : []).map((x, i) => <span key={i} style={{ height: '6px', borderRadius: '3px', background: `var(--${x.st === '방문' ? 'ok' : x.st === '미방문' ? 'warn' : i === ci ? 'accent' : 'line'})` }} />),
    rest: <span className="lbl">{!R ? '계획을 고르고 «수동 진행 시작» — 로봇은 자동으로 움직이지 않습니다' : w ? `다음 지점까지 ${d != null ? `${d.toFixed(1)} m 직선` : here.ok ? '거리 미확인' : `거리 표시 안 함 · ${here.why}`} · 자동 이동 미연결 · 직접 조종` : '모든 지점 기록됨 · «임무 끝내기»로 완료'}</span>,
    pick: R ? null : <select className="lv-inp" aria-label="시작할 계획" value={mid} onChange={(e) => setPick(e.target.value)}>
      {ms.length ? ms.map((m) => <option key={m.id} value={m.id}>{`${m.doc.name} · 지점 ${m.doc.wps.length}`}</option>) : <option value="">저장된 계획 없음 — PC «임무 계획»에서 만들기</option>}</select>,
    map: <a href={href('MMap')} aria-label="지도 크게 보기" style={{ display: 'block', position: 'relative', width: '100%', height: '132px', borderTop: '1px solid var(--line)' }}>
      <MapCanvas name="mhome" small wps={R && here.ok ? R.wps : null} trail={TRAIL.pts} robot={lk.robot} zones={D.err ? [] : docsOf(D, 'zone')} /></a>,
    tTitle: w ? `${wpName(w, ci)}에서 할 일` : '지점에서 할 일', tSub: R ? `${R.tmpl || '양식'} 모듈 · 운영자 기록` : '진행 중 임무 없음',
    grid: rows.map(([done, t], i) => [
      <span key={`a${i}`} style={{ width: '12px', height: '12px', borderRadius: '50%', border: `2px solid var(--${done ? 'ok' : 'line2'})`, background: done ? 'var(--ok)' : undefined, justifySelf: 'center' }} />,
      <span key={`b${i}`}>{t}</span>]),
    tilesHide: !w,
    tiles: w && <>{w.photos.slice(-2).map((u) => <div key={u} style={tile}><a href={href('MFinding', { url: u })}><Photo src={u} alt="붙인 사진" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} /></a></div>)}
      <div role="button" tabIndex={0} className="lbl" onClick={cam} onKeyDown={(e) => { if (e.key === 'Enter') cam(); }}
        style={{ aspectRatio: '4/3', borderRadius: '6px', border: '1.5px dashed var(--line2)', display: 'grid', placeItems: 'center', cursor: 'pointer' }}>{`📷 ${wpName(w, ci).split(' ')[0]} 사진`}</div></>,
    acts: run && R ? <WpActs id={run.id} R={R} i={ci} /> : null,
    pbP: { onClick: pb, disabled: !R && !ms.length }, pbT: R ? (endOpen ? '임무 끝내기 닫기' : '임무 끝내기…') : '수동 진행 시작',
    ends: run && endOpen ? <div style={{ padding: '0 14px' }}><div className="lv-row">{(['완료', '실패', '중단'] as const).map((s) =>
      <Btn key={s} pri={s === '완료'} t={`임무 ${s}`} on={() => runEnd(run.id, s)} />)}</div></div> : null,
  };
  return <><style>{CSS + DRIVE_CSS}</style><div id="dc-root"><View v={v} /><a className="mh-drive" href={href('MDrive')}>조종 화면</a></div></>;
}
