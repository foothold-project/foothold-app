// PC 조종(원본 틀): 지도·임무 단계·영상·조작줄·이 지점에서 할 일·사건 기록 — web/live.js setupMain/paintMain/paintRun 과 같은 규칙.
// 입력·폐기·발행은 data/link.ts 하나(20 Hz). 처음·복귀·재연결은 보기 전용. 시안의 가스·탐지·예시 경로·예시 숫자는 남기지 않는다.
import { Photo } from '../app/Photo';
import { useEffect, useRef, useState } from 'react';
import { CSS, View } from './Main.view';
import { deg, durTxt, fmtT, num, sgn, themeClass, wpName } from '../data/fmt';
import { NOMOVE, RELURCH, TRIAL, WHY } from '../data/facts';
import { ask, camURL, startSimAsk, driveBlock, dropAll, linkView, press, lift, sendOp, sessTxt, showSimStop, startTxt, stateRows, TRAIL, useLink, type Axes } from '../data/link';
import { activeRun, docsOf, useDocs } from '../data/shared';
import { pickWp, modDone, modTxt, shoot } from '../data/run';
import { href } from '../data/hist';
import { MapCanvas, type MapApi } from '../map/MapCanvas';
import { useMapPick } from '../map/MapPick';
import { MULTI, useDriveScreen, useGateRtt, useHold } from '../app/drive';
import { STEPS, stageOf } from '../data/drive_stage';
import { EndRow, WpActs } from '../app/runui';
import { useSel } from '../data/scratch';
import { SimOff, stopOn, stopProps, toast, whyProps } from '../app/shell';
import { autoProvider, ModePick, OpsQuad } from '../app/OpsQuad';

const MARK: Record<string, string> = { ok: '●', warn: '▲', bad: '■' };
const KEYS: Record<string, Partial<Axes>> = { ArrowUp: { fx: 1 }, ArrowDown: { fx: -1 }, ArrowLeft: { fw: 1 }, ArrowRight: { fw: -1 } };
const typing = (e: KeyboardEvent) => { const t = e.target as HTMLElement | null; return !!t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)); };
const layer = (t: string) => ({ ...whyProps(t), className: 'layer lv-why', 'aria-pressed': false });

// 누르는 동안만 이동하는 버튼(live.js pad/holdBtn). 막혀 있으면 흐리게 + 이유를 title 로(누르면 이유 안내·조종권 받기)
function Hold({ id, label, p, base, no }: { id: string; label: string; p: Partial<Axes>; base: string; no: string | null }) {
  const h = useHold(id, { fx: 0, fy: 0, fw: 0, ...p });
  return <button type="button" className="btn" title={no || base} style={{ opacity: no ? 0.5 : undefined }} {...h}>{label}</button>;
}
const Pad = ({ k, no }: { k: string; no: string | null }) => (
  <div className="lv-pad" role="group" aria-label="누르는 동안 이동">
    <Hold id={`${k}L`} label="◀ 왼쪽 아크" p={{ fx: 1, fw: 1 }} base="누르는 동안 앞 0.6 m/s + 왼쪽 회전 0.5 rad/s" no={no} />
    <Hold id={`${k}F`} label="▲ 앞 0.6" p={{ fx: 1 }} base="누르는 동안 앞 0.6 m/s · 떼면 0" no={no} />
    <Hold id={`${k}R`} label="오른쪽 아크 ▶" p={{ fx: 1, fw: -1 }} base="누르는 동안 앞 0.6 m/s + 오른쪽 회전 0.5 rad/s" no={no} />
    <button type="button" {...whyProps(NOMOVE)} className="btn lv-why">후진·제자리 회전 ⓘ</button>
  </div>);

export default function Main() {
  const D = useDocs(), L = useLink(), v = linkView(L), st = L.st, s = v.s;
  const api = useRef<MapApi | null>(null), box = useRef<HTMLDivElement>(null);
  const [trail, setTrail] = useState(true), [zon, setZon] = useState(true), [, redraw] = useState(0);
  const [big, setBig] = useState<null | 'fs' | 'page'>(null);
  const { raster, pickEl, pose, on, blank, flat } = useMapPick();   // 지도 보기 선택(저장 지도) — 화면만, 실제 world·조종 변경 0
  useDriveScreen();   // 화면을 떠나면 폐기 + hidden + 보기 전용
  useEffect(autoProvider, []);   // 실기 우선: Go2Direct 플러그인 있는 판에서만 처음 한 번(연결·명령 0)
  const rtt = useGateRtt();   // ⑥ 앱↔관문 왕복(보일 때만 5 s)

  const role = st?.role, ctl = v.linkOk && role === 'control' && !L.viewOnly, busy = v.linkOk && !!(st?.reset_pending || st?.resume_pending);
  const no = driveBlock(L);

  // 화살표 키: 조종권 있을 때 새로 누른 키만(반복·입력칸 제외), 떼면 0
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const k = KEYS[e.key]; if (!k || typing(e)) return; e.preventDefault();
      if (e.repeat || useLink.getState().st?.role !== 'control') return;
      if (!press(`key${e.key}`, -1, { fx: 0, fy: 0, fw: 0, ...k })) toast(MULTI);
    };
    const up = (e: KeyboardEvent) => { if (KEYS[e.key]) lift(`key${e.key}`, -1); };
    addEventListener('keydown', down); addEventListener('keyup', up);
    return () => { removeEventListener('keydown', down); removeEventListener('keyup', up); };
  }, []);

  // 영상 크게 보기: 열고 닫을 때 입력 폐기. 브라우저 전체화면이 막히면 화면 안 확대
  const bigOpen = async () => {
    dropAll(); setBig('page');
    try { if (!box.current?.requestFullscreen) throw new Error('지원 안 함'); await box.current.requestFullscreen(); setBig('fs'); }
    catch (e) { toast(`브라우저 전체화면이 막혀 화면 안에서 크게 봅니다(${(e as Error).message || e}) · Esc 로 닫기`); }
  };
  const bigClose = () => { dropAll(); setBig(null); if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); };
  useEffect(() => {
    if (!big) return;
    const fs = () => { if (!document.fullscreenElement && big === 'fs') setBig(null); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') bigClose(); };
    document.addEventListener('fullscreenchange', fs); addEventListener('keydown', esc);
    return () => { document.removeEventListener('fullscreenchange', fs); removeEventListener('keydown', esc); };
  }, [big]);

  const startSim = async () => toast(await startSimAsk(st));
  const photo = async () => { const p = await shoot(); if (p) toast(`사진 서버 저장 · 프레임 수신 ${p.frame_at.slice(11, 19)} · ${p.x == null ? '위치 미확인' : `x ${sgn(p.x)} y ${sgn(p.y)} m · 방향 ${deg(p.yaw)}`} · «사진 검토»에서 분류`); };

  // 수동 임무(운영자 기록 · 로봇 자동 완료 아님)
  const sel = useSel((x) => { const r = activeRun(D); return r ? x[r.id] : undefined; });
  const run = activeRun(D), R = run?.doc, ci = R ? pickWp(R, sel).i : -1, w = R && ci >= 0 ? R.wps[ci] : null;
  const vis = R ? R.wps.filter((x) => x.st === '방문').length : 0;
  const dist = w && v.robot?.fresh ? Math.hypot(v.robot.x - w.x, v.robot.y - w.y) : null;
  const ph = R ? R.wps.flatMap((x, i) => x.photos.map((u) => [u, i] as const)).slice(-3) : [];
  const rows: [boolean, string, string][] = w ? [[w.st !== '대기', '방문 기록 · 운영자 «방문 확인»(자동 도착 판정 미연결)', w.at ? fmtT(w.at).slice(6) : ''], ...w.mods.map((ty): [boolean, string, string] => [modDone(w, ty), modTxt(w, ty), ''])]
    : [[false, R ? '대기 지점 없음 — 아래에서 임무를 끝내세요' : '수동 진행을 시작하면 지금 지점에서 할 일이 여기에 나옵니다', '']];

  const mode = !v.linkOk ? '링크 끊김' : st?.reset_pending ? '리셋 중' : st?.resume_pending ? 'STOP 해제 대기' : v.latch ? 'STOP 요청' : ctl ? '직접 조종' : '보기 전용';
  const showStart = v.linkOk && !!st?.sim_start && ['시뮬 상태 미수신', '시뮬 상태 끊김'].includes(st.sim_block);
  const showStop = v.linkOk && showSimStop(st);
  const sx = startTxt(st);
  const ex = [showStart ? [`시뮬 꺼짐${st!.sim_start.why ? ` · ${st!.sim_start.why}` : ''}`, sx.left, sx.last].filter(Boolean).join(' · ') : sessTxt(st) ? `시뮬 세션 ${sessTxt(st)}` : '', v.newVer ? `새 화면 판 ${st!.ver} 반영됨(이 화면 ${L.firstVer})` : ''].filter(Boolean).join(' · ');
  const motion = `보낸 명령 ${v.sent} · 시뮬 ${v.body}` + (s ? ` · 기울기 ${num(s.tilt_deg, 0, '°')}` : '')
    + (v.linkOk && st?.reason && st.reason !== '조종권 없음' ? ` · ${st.reason}` : '') + (no ? ` · 이동하려면: ${no}` : ' · 버튼을 누르는 동안 이동 · 키: ↑ 앞, ↑ 누른 채 ←/→ 아크(←/→ 단독·↓ 는 서버가 0으로 막음)') + ` · 주의: ${RELURCH}`;
  const chip = (k: string, val: string, good: boolean) => ({ k, v: val, st: good ? 'ok' : 'warn', mark: good ? '●' : '▲' });
  const stg = stageOf({ linkOk: v.linkOk, linkTxt: v.linkTxt, st, viewOnly: L.viewOnly, fallen: s?.fallen === true, newVer: !!v.newVer, block: no });   // ② 작은 단계 표시(모드·motion 은 그대로)
  const mApi = api.current, robotMode = (mApi?.mode() || 'robot') === 'robot';
  const tog = (b: boolean, f: (x: boolean) => void, t: string) => ({ className: 'layer', 'aria-pressed': b, title: t, onClick: () => f(!b) });

  const vals = {
    themeClass: themeClass(true), stopProps,
    siteLine: `${TRIAL} · 판 ${L.firstVer || '—'}`,
    stepTitle: R ? `수동 임무 «${R.name}» · 방문 ${vis}/${R.wps.length}` : '직접 조종 · 진행 중 수동 임무 없음',
    modeLabel: mode, modeBg: `var(--${ctl && !v.latch ? 'acc-bg' : v.linkOk ? 'warn-bg' : 'bad-bg'})`, modeFg: `var(--${ctl && !v.latch ? 'accent' : v.linkOk ? 'warn' : 'bad'})`,
    chips: [chip('링크', v.linkTxt, v.linkOk && !st?.sim_block), chip('위치', s ? (s.source === 'gz_gt' ? 'Gazebo GT' : s.source || '미확인') : '미연결', !!s), chip('영상', v.camTxt, v.camOk), chip('배터리·온도', '미연결', false), chip('앱↔관문', rtt.txt.replace('앱↔관문 ', ''), rtt.ok),
      chip('단계', stg.stop ? `${STEPS[stg.i]} · ${stg.stop}` : `${STEPS[stg.i]} · 다음 ${stg.next}`, !stg.stop && stg.i === 3)],
    isGas: false, isDetAlarm: false, isAsk: false, isLost: false, panelAsk: true, panelDet: false, panelGas: false,
    opInit: (st?.me || '?').slice(0, 1).toUpperCase(), opName: st?.me ? `이 기기 · ${st.me}` : '이 기기 · 미확인', opRole: v.roleTxt,
    // 지도: 시뮬 바닥 도면 + GT 위치(SLAM 아님)
    mapTitle: on ? `지도 보기 · ${raster ? raster.label : blank} · 실제 실행 world 와 별개 · ${pose ? '위치 = 현재 열린 지도 상태' : '위치 미표시'}` : s ? `지도·SLAM 아님 · 선은 ${s.source === 'gz_gt' ? 'Gazebo GT' : s.source || '미확인'} 위치 · x ${sgn(s.x)} y ${sgn(s.y)} m` : '지도·SLAM 아님 · 위치 미연결',
    layerP: [tog(trail, setTrail, 'Gazebo GT 지나온 길 보이기/숨기기'), layer(`측정값 — ${WHY['가스·측정값·통신 품질']}`), layer(`발견물 — ${WHY['AI 탐지·발견물 판독']}`),
      layer(`통신 품질 — ${WHY['가스·측정값·통신 품질']}`), tog(zon, setZon, '구역 표시 켜기/끄기(표시만 · 주행 제한 미연결)'), layer(`3D 점군 — ${WHY['뎁스 영상·3D 점군']}`)],
    findCnt: '—', legendHide: true,
    folP: { 'aria-pressed': robotMode, title: '로봇 중심(지도가 따라 움직임) ↔ 전체 보기', onClick: () => { mApi?.setMode(robotMode ? 'all' : 'robot'); redraw((n) => n + 1); } },
    zinP: { title: '확대', onClick: () => mApi?.zoomBy(1.5) }, zoutP: { title: '축소', onClick: () => mApi?.zoomBy(1 / 1.5) },
    // 관제 4분할(실기 Go2 | 시뮬 보조) — 지도 칸도 누름 = 확대 토글(끌기 6 px·버튼·고르기는 제외). 이 지도는 onTap 없음(점 찍기 0)
    cardTitle: '관제', modePick: <ModePick />,
    map: <OpsQuad camOk={v.camOk} camTxt={v.camTxt}
      rgbExtra={<button type="button" className="lv-btn" style={{ position: 'absolute', left: 8, bottom: 8 }} title="지금 영상 프레임을 사진으로(촬영 시각·GT 위치 기록)" onClick={photo}>사진 찍기</button>}
      map={(q) => <>
        <MapCanvas name="main" api={api} small={q === 'thumb'} zones={D.err ? [] : docsOf(D, 'zone')} robot={on ? pose : v.robot} trail={TRAIL.pts}
          raster={raster} blank={blank} flat={flat} noRobot={on && !pose} showTrail={trail && !on} showZones={zon && !on} wps={R && !on ? R.wps : null} />
        {q !== 'thumb' && pickEl}</>} />,
    stepHead: R ? `경과 ${durTxt(R.started)} · 방문 ${vis}/${R.wps.length} · ${ci < 0 ? '모든 지점 기록됨' : `다음 지점 직선 ${dist == null ? '미확인' : `${dist.toFixed(1)} m`}`} · 자동 이동 미연결` : '진행 중 수동 임무 없음',
    steps: R ? R.wps.map((x, i) => ({ n: i + 1, title: x.name || `지점 ${i + 1}`, cls: x.st === '방문' ? 'done' : x.st === '미방문' ? 'hold' : i === ci ? 'now' : '',
      sub: x.st === '방문' ? `방문 ${fmtT(x.at).slice(6)} · 사진 ${x.photos.length}${x.chk ? ` · ${x.chk}` : ''}` : x.st === '미방문' ? `미방문 · ${x.why}`
        : i === ci ? `기록 차례${x.photos.length ? ` · 사진 ${x.photos.length}` : ''}${x.chk ? ` · ${x.chk}` : ''} · 직접 조종` : '대기' })) : [],
    afterSteps: <>
      {!R && <span style={{ fontSize: '12px', color: 'var(--muted)' }}>진행 중 수동 임무 없음 — 아래 링크의 임무 계획에서 계획을 고르고 «수동 진행 시작»</span>}
      <a href={href('PcPlan', R?.mission ? { mission: R.mission } : {})} style={{ color: 'var(--accent)', fontSize: '13px', padding: '4px 2px' }}>
        {R ? `계획 보기 · «${R.name}»(임무 계획)` : '임무 계획 열기 — 계획을 고르고 «수동 진행 시작»'}</a>
      <details style={{ padding: '4px 2px', fontSize: '13px' }}><summary style={{ cursor: 'pointer', minHeight: '32px', color: 'var(--accent)' }}>상태 상세 · 서버 원값 펼치기</summary>
        <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 14px', margin: '8px 0 0' }}>
          {stateRows(L).map(([a, b]) => [<dt key={a} style={{ color: 'var(--muted)' }}>{a}</dt>, <dd key={`${a}v`} style={{ margin: 0 }}>{b}</dd>])}</dl></details></>,
    // 영상: Gazebo 렌더 카메라 하나(실카메라·뎁스 아님)
    boxRef: box, boxCls: big === 'page' ? 'lv-big' : undefined, camHide: true,   // 영상은 4분할 RGB 칸으로 옮김(같은 img[data-live-cam])
    cam: <><img data-live-cam="" alt="Gazebo 렌더 카메라" src={camURL || undefined} style={{ position: 'absolute', inset: '0', width: '100%', height: '100%', objectFit: 'cover', visibility: v.camOk ? 'visible' : 'hidden' }} />
      <div style={{ position: 'absolute', inset: '0', display: 'grid', placeItems: 'center', color: '#9AA7B2', fontSize: '14px', pointerEvents: 'none' }}>{v.camOk ? '' : `카메라 ${v.camTxt}`}</div></>,
    vlabel: v.camOk ? `Gazebo 렌더 카메라(실카메라 아님) · ${v.camTxt}` : `카메라 ${v.camTxt}`, recHide: true,
    frontP: { 'aria-pressed': true, title: '전방 카메라(Gazebo 렌더) — 유일한 영상', onClick: () => toast('전방 카메라(Gazebo 렌더, 실카메라 아님)가 유일한 영상입니다') },
    depthP: whyProps(`뎁스 — ${WHY['뎁스 영상·3D 점군']}`),
    shotP: { title: '지금 영상 프레임을 사진으로(촬영 시각·GT 위치 기록)', onClick: photo },
    bigP: { title: '영상 크게 보기(STOP·조작 포함) · Esc 로 닫기', onClick: () => (big ? bigClose() : bigOpen()) },
    bigbar: big ? <div className="lv-bigbar" data-live-bigbar="1" style={{ display: 'flex' }}>
      <button type="button" className="btn lv-stop" aria-label="비상 정지(확대 화면)" {...stopOn}>STOP</button>
      <button type="button" className="btn" disabled={!(ctl && v.latch && !busy)} onClick={() => sendOp('resume')}>STOP 해제</button>
      <Pad k="big" no={no} /><span>{`${mode} · ${v.roleTxt} · 보낸 명령 ${v.sent} · ${v.body}`}</span>
      <button type="button" className="btn" onClick={bigClose}>닫기 (Esc)</button></div> : null,
    // 조작줄: STOP 해제 · 조종권 · 시뮬 리셋
    b1T: 'STOP 해제', b1P: { onClick: () => sendOp('resume'), disabled: !(ctl && v.latch && !busy) },
    b2T: role === 'control' ? '조종권 반납' : '조종권 받기', b2P: { onClick: () => sendOp(role === 'control' && !L.viewOnly ? 'release' : 'take'), disabled: !v.linkOk || role === 'view_other', title: role === 'view_other' ? '다른 기기가 조종 중' : undefined },
    b3T: '시뮬 리셋', b3P: { onClick: () => sendOp('reset'), disabled: !(ctl && !busy) },
    motion,
    drive: <><Pad k="pc" no={no} />
      {(showStart || showStop || v.newVer || ex) && <div className="lv-row" data-live-extra="1">
        {showStart && <button type="button" className="btn" title={st!.sim_start.why || '30분 시뮬 시작(STOP 상태로)'} style={{ opacity: st!.sim_start.ok ? undefined : 0.55 }} onClick={startSim}>시뮬 시작(30분)</button>}
        {showStart && st!.map_start && <button type="button" className="btn" title="기동은 지도 화면에서 직접 고르고 확인" onClick={() => { location.hash = '#/PcMap'; }}>{`지도 화면 · ${sx.map}`}</button>}
        {showStop && <SimOff />}
        {v.newVer && <button type="button" className="btn" onClick={() => (ctl ? toast('조종 중에는 새로고침하지 않습니다 — 조종권 반납 뒤') : location.reload())}>새로고침(새 판)</button>}
        <span style={{ fontSize: '12px', color: 'var(--muted)' }}>{ex}</span></div>}</>,
    // 이 지점에서 할 일 = 지금 지점의 수동 기록. 시안의 도착 판정·예시 사진은 넣지 않는다
    askSub: !R ? '진행 중 임무 없음' : w ? `${wpName(w, ci)} · 모듈 ${w.mods.length}개 · 운영자 기록` : '모든 지점 기록됨',
    askGrid: <div style={{ display: 'grid', gridTemplateColumns: '22px 1fr auto', gap: '8px 10px', alignItems: 'center', fontSize: '13px' }}>
      {rows.map(([done, t, at], i) => [done ? <span key={`a${i}`} style={{ color: 'var(--ok)', fontWeight: '700' }}>✓</span>
        : <span key={`a${i}`} style={{ width: '12px', height: '12px', borderRadius: '50%', border: '2.5px solid var(--accent)', justifySelf: 'center' }} />,
        <span key={`b${i}`}>{t}</span>, <span key={`c${i}`} className="mono" style={{ fontSize: '12px', color: 'var(--muted)' }}>{at}</span>])}</div>,
    askTiles: ph.length ? <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: '6px' }}>
      {ph.map(([u, i]) => <div key={u} title={`WP${i + 1} 사진`} style={{ aspectRatio: '4/3', borderRadius: '6px', overflow: 'hidden', border: '1px solid var(--line)' }}>
        <a href={href('PcReview', { url: u })}><Photo src={u} alt={`WP${i + 1} 사진`} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} /></a></div>)}</div> : <></>,
    askLbl: ph.length ? `이 임무의 사진 · ${[...new Set(ph.map(([, i]) => `WP${i + 1}`))].join(' · ')}` : R ? '이 임무에 붙인 사진 없음 — «📷 사진»으로 지금 지점에 붙입니다' : '',
    askActs: run ? <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>{R && <WpActs id={run.id} R={R} i={ci} />}<EndRow id={run.id} /></div> : null,
    // 사건 기록: 서버 원값 최근 5건
    evLink: '조종·사진 기록', evHref: href('PcHistory'),
    events: (st ? st.events : []).slice(0, 5).map((e) => ({ t: e.t, st: e.st, mark: MARK[e.st] || '·', text: e.text })),
  };
  useEffect(() => {   // 말줄임된 머리줄 문구 전체를 title 로
    const sp = document.querySelectorAll<HTMLElement>('[data-main] header>div:has(>span+span)>span'); sp.forEach((e) => { e.title = e.textContent || ''; });
  });
  return <><style>{CSS}</style><div id="dc-root" data-main=""><View v={vals} /></div></>;
}
