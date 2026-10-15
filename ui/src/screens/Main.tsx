// PC 조종(원본 틀): 지도·임무 단계·영상·조작줄·이 지점에서 할 일·사건 기록 — web/live.js setupMain/paintMain/paintRun 과 같은 규칙.
// 입력·폐기·발행은 data/link.ts 하나(20 Hz). 처음·복귀·재연결은 보기 전용. 시안의 가스·탐지·예시 경로·예시 숫자는 남기지 않는다.
import { Photo } from '../app/Photo';
import { useEffect, useRef, useState } from 'react';
import { CSS, View } from './Main.view';
import { deg, durTxt, fmtT, num, sgn, themeClass, wpName } from '../data/fmt';
import { STOP_TIP, TERMS, TRIAL, WHY } from '../data/facts';
import { camChip, HeadChips } from '../app/status';
import { Chip, DirTag, Help, SafeLine } from '../app/chip';
import { camURL, driveBlock, dropAll, linkView, press, lift, sendOp, startBlock, startDrive, stateRows, TRAIL, useLink, type Axes } from '../data/link';
import { activeRun, docsOf, useDocs } from '../data/shared';
import { pickWp, modDone, modTxt, shoot, runHere } from '../data/run';
import { href } from '../data/hist';
import { MapCanvas } from '../map/MapCanvas';
import { useMapPick } from '../map/MapPick';
import { MULTI, useDirWhy, useDriveScreen, useGateRtt, useHold } from '../app/drive';
import { STEPS, stageOf } from '../data/drive_stage';
import { EndRow, WpActs } from '../app/runui';
import { useSel } from '../data/scratch';
import { stopOn, stopProps, toast, whyProps } from '../app/shell';
import { autoProvider, ModePick, OpsQuad } from '../app/OpsQuad';

const MARK: Record<string, string> = { ok: '●', warn: '▲', bad: '■' };
const KEYS: Record<string, Partial<Axes>> = { ArrowUp: { fx: 1 }, ArrowDown: { fx: -1 }, ArrowLeft: { fw: 1 }, ArrowRight: { fw: -1 } };
const typing = (e: KeyboardEvent) => { const t = e.target as HTMLElement | null; return !!t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)); };
const layer = (_t: string) => ({ style: { display: 'none' }, 'aria-hidden': true, tabIndex: -1 });   // B2 R11: 미연결 레이어 숨김(설명은 «상태 상세»)

// 누르는 동안만 이동하는 버튼(live.js pad/holdBtn). 막혀 있으면 흐리게 + 이유를 title 로(누르면 이유 안내·조종권 받기)
function Hold({ id, label, p, base, no }: { id: string; label: string; p: Partial<Axes>; base: string; no: string | null }) {
  const h = useHold(id, { fx: 0, fy: 0, fw: 0, ...p });
  return <button type="button" className="btn" title={no || base} style={{ opacity: no ? 0.5 : undefined }} {...h}>{label}</button>;
}
const Pad = ({ k, no }: { k: string; no: string | null }) => (
  <div className="lv-pad" role="group" aria-label="누르는 동안 이동">
    <Hold id={`${k}L`} label="◀ 왼쪽 아크" p={{ fx: 1, fw: 1 }} base="누르는 동안 앞 + 왼쪽 회전 · 떼면 0" no={no} />
    <Hold id={`${k}F`} label="▲ 앞 0.6" p={{ fx: 1 }} base="누르는 동안 앞 · 떼면 0" no={no} />
    <Hold id={`${k}R`} label="오른쪽 아크 ▶" p={{ fx: 1, fw: -1 }} base="누르는 동안 앞 + 오른쪽 회전 · 떼면 0" no={no} />
    <DirTag />   {/* U2: 막힌 방향 = 꼬리표 + ? NOMOVE(허용 범위 변경 0) · 막힌 방향 입력은 useDirWhy 토스트 1회 */}
  </div>);

export default function Main() {
  const D = useDocs(), L = useLink(), v = linkView(L), st = L.st, s = v.s;
  const box = useRef<HTMLDivElement>(null);
  const [trail, setTrail] = useState(true), [zon, setZon] = useState(true);
  const [big, setBig] = useState<null | 'fs' | 'page'>(null);
  const { raster, pickEl, pose, on, blank, flat } = useMapPick();   // 지도 보기 선택(저장 지도) — 화면만, 실제 world·조종 변경 0
  useDriveScreen();   // 화면을 떠나면 폐기 + hidden + 보기 전용
  useEffect(autoProvider, []);   // 실기 우선: Go2Direct 플러그인 있는 판에서만 처음 한 번(연결·명령 0)
  const rtt = useGateRtt();   // ⑥ 앱↔관문 왕복(보일 때만 5 s)
  useDirWhy();   // U2: 막힌 방향 입력 → 서버 이유 토스트 1회

  const role = st?.role, ctl = v.linkOk && role === 'control' && !L.viewOnly;
  const no = driveBlock(L);
  // N1: «조종 시작» 하나(확인 1회 → 조종권 + STOP 해제) — 조종 가능이면 상태 글만, 진행 중이면 단계 글. 반납은 따로
  const sb = startBlock(L), goT = L.starting ?? (sb === '이미 조종 가능' ? '조종 가능' : '조종 시작');
  const goP = { onClick: async () => { const t = await startDrive(); if (t) toast(t); }, disabled: !!sb, title: sb || '확인 1회 → 조종권 받기 + STOP 해제 · 그 뒤 손 떼고 새로 눌러야 움직임' };

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

  const photo = async () => { const p = await shoot(); if (p) toast(`사진 서버 저장 · 프레임 수신 ${p.frame_at.slice(11, 19)} · ${p.x == null ? '위치 미확인' : `x ${sgn(p.x)} y ${sgn(p.y)} m · 방향 ${deg(p.yaw)}`} · «사진 검토»에서 분류`); };

  // 수동 임무(운영자 기록 · 로봇 자동 완료 아님)
  const sel = useSel((x) => { const r = activeRun(D); return r ? x[r.id] : undefined; });
  const run = activeRun(D), R = run?.doc, ci = R ? pickWp(R, sel).i : -1, w = R && ci >= 0 ? R.wps[ci] : null;
  const vis = R ? R.wps.filter((x) => x.st === '방문').length : 0;
  const here = runHere(R, L);   // 거리·지점 겹치기는 기록 출처가 지금 지도와 같을 때만(10-15 프리셋 1단계)
  const dist = w && here.ok && v.robot?.fresh ? Math.hypot(v.robot.x - w.x, v.robot.y - w.y) : null;
  const ph = R ? R.wps.flatMap((x, i) => x.photos.map((u) => [u, i] as const)).slice(-3) : [];
  const rows: [boolean, string, string][] = w ? [[w.st !== '대기', '방문 기록 · 운영자 «방문 확인»(자동 도착 판정 미연결)', w.at ? fmtT(w.at).slice(6) : ''], ...w.mods.map((ty): [boolean, string, string] => [modDone(w, ty), modTxt(w, ty), ''])]
    : [[false, R ? '대기 지점 없음 — 아래에서 임무를 끝내세요' : '수동 진행을 시작하면 지금 지점에서 할 일이 여기에 나옵니다', '']];

  // U2(§3): 알약 = 잠금 사실 — 이 연결에서 유효 status 를 받았을 때만 잠김/풀림을 말함(머리줄 잠금 칩과 같은 «known»)
  const known = v.linkOk && !L.bad && !!st;
  const mode = !known ? '잠금 확인 안 됨' : st!.reset_pending ? '리셋 중' : st!.resume_pending ? 'STOP 해제 대기' : v.latch ? 'STOP 잠금' : ctl ? '직접 조종' : '보기 전용';
  const modeTone = !known ? 'warn' : v.latch ? 'bad' : ctl && !st!.reset_pending && !st!.resume_pending ? 'acc' : 'warn';
  // U2(670 P2): 시뮬 미수신·끊김을 «시뮬 꺼짐»으로 단정하던 본문 글(ex)·시뮬 시작/지도/끄기 버튼은 지움 → 머리줄 칩(시뮬 확인 안 됨/끊김)과 «시뮬 ▾» 메뉴 한 곳
  // U2(§4): 운영 = 막힌 이유(R9)·넘어짐(항상 보존 경고)만 · 보낸 명령 수치·몸·기울기·서버 이유 원문은 개발자 모드 · 주의 문장은 안전 한 줄(SafeLine)로
  const motionNode = <>{no ? `이동하려면: ${no}` : ctl ? '누르는 동안 이동 · 키 ↑ 앞, ↑ 누른 채 ←/→ 아크' : ''}
    {s?.fallen === true && <b style={{ color: 'var(--bad)' }}>{`${no || ctl ? ' · ' : ''}넘어짐`}</b>}
    <span data-dev>{` · 보낸 명령 ${v.sent} · 시뮬 ${v.body}${s ? ` · 기울기 ${num(s.tilt_deg, 0, '°')}` : ''}${v.linkOk && st?.reason ? ` · 서버 이유 ${st.reason}` : ''}`}</span></>;
  const stg = stageOf({ linkOk: v.linkOk, linkTxt: v.linkTxt, st, viewOnly: L.viewOnly, fallen: s?.fallen === true, newVer: !!v.newVer, block: no });   // ② 작은 단계 표시(모드·motion 은 그대로)
  const tog = (b: boolean, f: (x: boolean) => void, t: string) => ({ className: 'layer', 'aria-pressed': b, title: t, onClick: () => f(!b) });

  const vals = {
    themeClass: themeClass(true), stopProps,
    // U2: 제목 위 진단 줄 전부 개발자 모드 — 안전 부분(TRIAL_SAFE)은 안전 한 줄(SafeLine)의 ? 로 옮김
    siteNode: <span data-dev>{`${TRIAL} · 판 ${L.firstVer || '—'}`}</span>,
    stepTitle: R ? `수동 임무 «${R.name}» · 방문 ${vis}/${R.wps.length}` : ctl && !v.latch ? '직접 조종' : '대기 중',
    modeLabel: mode, modeBg: `var(--${modeTone === 'acc' ? 'acc-bg' : `${modeTone}-bg`})`, modeFg: `var(--${modeTone === 'acc' ? 'accent' : modeTone})`,
    stopSub: '스페이스 · 입력 차단·잠금', stopHelp: <Help label="STOP 설명">{STOP_TIP}</Help>,
    // B2 R16: 같은 사실은 한 곳 — 링크 끊김은 모드 칸, 위치는 지도 제목, 영상은 RGB 칸, 배터리·온도(늘 미연결)와 앱↔관문 원값은 «상태 상세»
    // U1-b: 링크 칩은 공통 머리줄 칩(시뮬·연결·역할·잠금)으로 — 앱↔관문·단계는 그대로(U2)
    // U2(670 P3): 단계는 짧은 칩 + ?(막힌 이유·다음 행동 전문) — 390 폭에서 글이 잘리지 않게
    head: <>{v.linkOk && !rtt.ok && <Chip tone="warn" text="관문 응답 느림" why={rtt.why || rtt.txt} />}
      <Chip tone={stg.stop ? 'warn' : stg.i === 3 ? 'ok' : 'off'} text={`단계 ${STEPS[stg.i]}`} why={`${stg.stop ? `막힘: ${stg.stop} · ` : ''}다음: ${stg.next}`} /><HeadChips /></>,
    chips: [],
    isGas: false, isDetAlarm: false, isAsk: false, isLost: false, panelDet: false, panelGas: false,
    opInit: (st?.me || '?').slice(0, 1).toUpperCase(), opName: st?.me ? `이 기기 · ${st.me}` : '이 기기 · 미확인', opRole: v.roleTxt,
    // 지도: 시뮬 바닥 도면 + GT 위치(SLAM 아님)
    mapTitle: on ? `지도 보기 · ${raster ? raster.label : blank} · 실제 실행 world 와 별개 · ${pose ? '위치 = 현재 열린 지도 상태' : '위치 미표시'}` : s ? `시뮬 도면 · 선은 ${s.source === 'gz_gt' ? '시뮬 위치' : s.source || '미확인'} · x ${sgn(s.x)} y ${sgn(s.y)} m` : '시뮬 도면 · 위치 미연결',
    // B2 R11: 미연결 레이어(측정값·발견물·통신 품질·3D 점군)는 버튼 모양 0 — 숨기고 «상태 상세»의 지원 범위로(3D 점군은 관제 보조 뷰에 있음)
    layerP: [tog(trail, setTrail, '지나온 길(시뮬 위치) 보이기/숨기기'), layer(''), layer(''), layer(''), tog(zon, setZon, '구역 표시 켜기/끄기(표시만 · 주행 제한 미연결)'), layer('')],
    findCnt: '—', legendHide: true,
    // 10-15 ④: 머리줄 아이콘(◎·+·−) 대신 지도 칸 안 글 버튼(«전체 고정 / 로봇 중심» + 확대·축소) — 2×2·큰 칸·전체화면에서 같은 자리
    folP: layer(''), zinP: layer(''), zoutP: layer(''),
    // 관제 4분할(실기 Go2 | 시뮬 보조) — 지도 칸도 누름 = 확대 토글(끌기 6 px·버튼·고르기는 제외). 이 지도는 onTap 없음(점 찍기 0)
    cardTitle: '관제', modePick: <ModePick />,
    map: <OpsQuad camOk={v.camOk} camTxt={v.camTxt}
      rgbExtra={<button type="button" className="lv-btn" style={{ position: 'absolute', left: 8, bottom: 8 }} title="지금 영상 프레임을 사진으로(촬영 시각·시뮬 위치 기록)" onClick={photo}>사진 찍기</button>}
      map={(q) => <>
        <MapCanvas name="main" small={q === 'thumb'} btns={q !== 'thumb'} zones={D.err ? [] : docsOf(D, 'zone')} robot={on ? pose : v.robot} trail={TRAIL.pts}
          raster={raster} blank={blank} flat={flat} noRobot={on && !pose} showTrail={trail && !on} showZones={zon && !on} wps={R && !on && here.ok ? R.wps : null} />
        {q !== 'thumb' && pickEl}</>} />,
    stepHead: R ? `경과 ${durTxt(R.started)} · 방문 ${vis}/${R.wps.length} · ${ci < 0 ? '모든 지점 기록됨' : `다음 지점 직선 ${dist != null ? `${dist.toFixed(1)} m` : here.ok ? '미확인' : `표시 안 함(${here.why})`}`} · 자동 이동 미연결` : '진행 중 수동 임무 없음',
    steps: R ? R.wps.map((x, i) => ({ n: i + 1, title: x.name || `지점 ${i + 1}`, cls: x.st === '방문' ? 'done' : x.st === '미방문' ? 'hold' : i === ci ? 'now' : '',
      sub: x.st === '방문' ? `방문 ${fmtT(x.at).slice(6)} · 사진 ${x.photos.length}${x.chk ? ` · ${x.chk}` : ''}` : x.st === '미방문' ? `미방문 · ${x.why}`
        : i === ci ? `기록 차례${x.photos.length ? ` · 사진 ${x.photos.length}` : ''}${x.chk ? ` · ${x.chk}` : ''} · 직접 조종` : '대기' })) : [],
    afterSteps: <>
      {R ? <a href={href('PcPlan', R.mission ? { mission: R.mission } : {})} style={{ color: 'var(--accent)', fontSize: '13px', padding: '4px 2px' }}>{`계획 보기 · «${R.name}»(임무 계획)`}</a>
        : <a className="btn" href={href('PcPlan')} title="임무 계획에서 계획을 고르고 «수동 진행 시작»" style={{ alignSelf: 'flex-start', textDecoration: 'none' }}>임무 시작</a>}
      <details data-dev style={{ padding: '4px 2px', fontSize: '13px' }}><summary style={{ cursor: 'pointer', minHeight: '32px', color: 'var(--accent)' }}>상태 상세 · 서버 원값 펼치기</summary>
        <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 14px', margin: '8px 0 0' }}>
          {[...stateRows(L), ['배터리·온도', '미연결'], ['앱↔관문', rtt.txt], ['지도 레이어 미연결', `측정값·통신 품질 — ${WHY['가스·측정값·통신 품질']} · 발견물 — ${WHY['AI 탐지·발견물 판독']}`]].map(([a, b]) => [<dt key={a} style={{ color: 'var(--muted)' }}>{a}</dt>, <dd key={`${a}v`} style={{ margin: 0 }}>{b}</dd>])}</dl>
        <p style={{ fontSize: '12px', color: 'var(--muted)', margin: '6px 0 0' }}>{TERMS}</p></details></>,
    // 영상: Gazebo 렌더 카메라 하나(실카메라·뎁스 아님)
    boxRef: box, boxCls: big === 'page' ? 'lv-big' : undefined, camHide: true,   // 영상은 4분할 RGB 칸으로 옮김(같은 img[data-live-cam])
    cam: <><img data-live-cam="" alt="시뮬 카메라 영상" src={camURL || undefined} style={{ position: 'absolute', inset: '0', width: '100%', height: '100%', objectFit: 'cover', visibility: v.camOk ? 'visible' : 'hidden' }} />
      <div style={{ position: 'absolute', inset: '0', display: 'grid', placeItems: 'center', color: '#9AA7B2', fontSize: '14px', pointerEvents: 'none' }}>{v.camOk ? '' : camChip(v).text}</div></>,
    vlabel: v.camOk ? '시뮬 카메라' : camChip(v).text, recHide: true,
    frontP: { 'aria-pressed': true, title: '전방 시뮬 카메라 — 유일한 영상', onClick: () => toast('전방 시뮬 카메라가 유일한 영상입니다') },
    depthP: whyProps(`뎁스 — ${WHY['뎁스 영상·3D 점군']}`),
    shotP: { title: '지금 영상 프레임을 사진으로(촬영 시각·시뮬 위치 기록)', onClick: photo },
    bigP: { title: '영상 크게 보기(STOP·조작 포함) · Esc 로 닫기', onClick: () => (big ? bigClose() : bigOpen()) },
    bigbar: big ? <div className="lv-bigbar" data-live-bigbar="1" style={{ display: 'flex' }}>
      <button type="button" className="btn lv-stop" aria-label="비상 정지(확대 화면)" {...stopOn}>STOP</button>
      <button type="button" className="btn" {...goP}>{goT}</button>
      {ctl && <Pad k="big" no={no} />}<span>{`${mode} · ${v.roleTxt}`}<span data-dev>{` · 보낸 명령 ${v.sent} · ${v.body}`}</span></span><SafeLine />
      <button type="button" className="btn" onClick={bigClose}>닫기 (Esc)</button></div> : null,
    // 조작줄: 조종 시작(N1, startBlock 그대로 — 조종권+STOP 잠금이면 다시 «조종 시작») · 조종 반납(조종권 있을 때만) · 시뮬 리셋은 «시뮬 ▾» 메뉴로
    b1T: goT, b1P: goP,
    b2T: '조종 반납', b2P: { onClick: () => sendOp('release'), hidden: role !== 'control', disabled: !v.linkOk || role !== 'control', title: !v.linkOk ? '연결 확인 안 됨' : '조종 반납(입력 차단·잠금)' },
    b2Help: role === 'control' ? <Help label="조종 반납 · 설명">반납하면 다른 기기가 «조종 시작»으로 조종할 수 있습니다 · 반납하면 입력 차단·잠금</Help> : null,
    b3T: '', b3P: { hidden: true },
    motionNode,
    // U2: 안전 한 줄(조종 영역에 늘) · 조작 버튼은 조종 중일 때만 · 새 판 차단(R9)과 문서 실패 이유는 운영에 · 판 해시는 개발자 모드
    drive: <><SafeLine />
      {ctl && <Pad k="pc" no={no} />}
      {(v.newVer || D.err) && <div className="lv-row" data-live-extra="1">
        {v.newVer && <><span style={{ fontSize: '12px', color: 'var(--warn)' }}>새 화면 판 반영됨 — 새로고침 필요<span data-dev>{` (서버 ${st!.ver} · 이 화면 ${L.firstVer})`}</span></span>
          <button type="button" className="btn" onClick={() => (ctl ? toast('조종 중에는 새로고침하지 않습니다 — 조종 반납 뒤') : location.reload())}>새로고침(새 판)</button></>}
        {D.err && <span style={{ fontSize: '12px', color: 'var(--bad)' }}>{`공유 문서: ${D.err}`}</span>}</div>}</>,
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
    panelAsk: !!run,   // U2: 진행 중 임무가 없으면 «이 지점에서 할 일» 카드 숨김
    evLink: '전체 기록 ›', evHref: href('PcHistory'),
    events: (st ? st.events : []).slice(0, 5).map((e) => ({ t: e.t, st: e.st, mark: MARK[e.st] || '·', text: e.text })),
  };
  useEffect(() => {   // 말줄임된 머리줄 문구 전체를 title 로
    const sp = document.querySelectorAll<HTMLElement>('[data-main] header>div:has(>span+span)>span'); sp.forEach((e) => { e.title = e.textContent || ''; });
  });
  return <><style>{CSS}</style><div id="dc-root" data-main=""><View v={vals} /></div></>;
}
