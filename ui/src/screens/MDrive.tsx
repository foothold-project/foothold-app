// 휴대폰 가로 조종(원본 틀): 카메라·작은 지도·상태 표시·막대 둘·STOP — web/live.js setupDrive/paintDrive 와 같은 규칙.
// 입력·폐기·발행은 data/link.ts 하나. 처음·복귀·재연결은 보기 전용 — 막대 첫 누름은 «조종 시작» 확인 흐름(그 누름은 움직이지 않음).
import { useNote } from '../data/transport';
import { useEffect, useState } from 'react';
import { CSS, View } from './MDrive.view';
import { deg, num, sgn, store } from '../data/fmt';
import { LAYOUTS, NOMOVE, RELURCH, TRIAL_DEV, TRIAL_SAFE, UNSUP, WHY } from '../data/facts';
import { camURL, driveBlock, dropAll, linkView, sendOp, startBlock, startDrive, startTxt, stateRows, TRAIL, useLink } from '../data/link';
import { docsOf, useDocs, useMedia } from '../data/shared';
import { MARK, stageOf, stepLabel, warnsOf } from '../data/drive_stage';
import { href } from '../data/hist';
import { Photo } from '../app/Photo';
import { shoot } from '../data/run';
import { MapCanvas } from '../map/MapCanvas';
import { useMapPick } from '../map/MapPick';
import { PORTRAIT, useDirWhy, useDriveScreen, useFitPhone, useGateRtt, useStick } from '../app/drive';
import { Drawer, SimOff, stopProps, toast, whyProps } from '../app/shell';
import { Chip, DevMark, DevSwitch, DirTag, SafeLine } from '../app/chip';
import { camChip, useHeadChips } from '../app/status';
import { auth, logoutNow } from '../data/auth';

// R03 세로: 조종 틀(0.56 배 축소) 밖 아래 띠에 STOP(전폭·64 px)·현황·사진·메뉴(48 px)를 원래 크기로. 틀 안 STOP 은 세로에서만 숨김 —
// 선택자는 축소 틀([data-live-drive]) 안으로 한정(띠 STOP 은 틀 밖이라 영향 0). 같은 stopProps(누르는 순간 STOP·래치 그대로). 가로 배치는 바뀌지 않음
const BAND_CSS = `.drv-band{display:none}
@media ${PORTRAIT}{.drv-band{display:flex;flex-direction:column;gap:8px;position:fixed;left:0;right:0;bottom:0;z-index:40;box-sizing:border-box;padding:8px 8px calc(8px + env(safe-area-inset-bottom));background:#05080A;box-shadow:0 -1px 0 rgba(230,235,239,.25)}
.drv-band>*{flex-shrink:0}.drv-band>div{display:flex;gap:8px}.drv-band>div>*{flex:1;justify-content:center;height:48px;text-decoration:none}
[data-live-drive] button[aria-label="비상 정지"],[data-live-drive] .drv-safe{visibility:hidden}}
.drv-safe{flex:1 1 100%;max-width:calc(100% - 12px);padding:4px 6px;border-radius:8px;background:rgba(5,8,10,.82);color:#FFB547;font-size:11px;line-height:1.3;box-sizing:border-box}
.drv-band .lv-safe{font-size:12px;color:#FFB547}
[data-live-drive] [role=radiogroup][aria-label="속도"],[data-live-drive] a.pill[href="#/MHome"]{display:none!important}`;   /* 원본 틀 인라인 display 를 이기려면 !important */
// B1 가로 영상 우선: 원본 틀 아래 줄의 속도(고를 수 없음)·현황 링크는 숨기고 서랍으로(문구 그대로). 원본 틀은 재생성 0
const MOVE = '이동 막대: 앞뒤와 옆걸음', ROT = '회전 막대: 왼쪽 오른쪽', FB = '앞뒤 막대';
const SIM_OFF = ['시뮬 상태 미수신', '시뮬 상태 끊김'];
// ④ 화면 나누기(화면 배치만 저장): 영상 크게 → 반반 → 지도 크게. 작은 칸을 누르면 다음으로(전환 전 입력 폐기)
const SPLITS = ['cam', 'half', 'map'] as const; type Split = (typeof SPLITS)[number];
const SPLIT_TXT: Record<Split, string> = { cam: '영상 크게', half: '반반', map: '지도 크게' };
const big = (t: string, f: (e: React.MouseEvent<HTMLButtonElement>) => void, off = false) => <button key={t} type="button" onClick={f} disabled={off} style={{ opacity: off ? 0.6 : undefined, height: '44px', minWidth: '88px', padding: '0 14px', border: '0', borderRadius: '22px', background: '#1A1206', color: '#FFB547', fontSize: '13px', fontWeight: '700' }}>{t}</button>;
const hud = (good: boolean, label: string, val: string, mono = true) => <span className="hud"><span style={{ color: good ? '#5AA9FF' : '#FFB547' }}>●</span>{label}<span className={mono ? 'mono' : undefined}>{val}</span></span>;

export default function MDrive() {
  const note = useNote((s) => s.note);
  const D = useDocs(), L = useLink(), v = linkView(L), st = L.st, s = v.s, root = useFitPhone();
  const ctl = st?.role === 'control' && !L.viewOnly;
  const [lay, setLay] = useState(() => { const x = store.get('fh.live.layout', LAYOUTS[0]); return LAYOUTS.includes(x) ? x : LAYOUTS[0]; });
  const [menu, setMenu] = useState(false), [list, setList] = useState(false);
  // B1: 작은 지도 기본 접힘(들어올 때마다) — 🗺 버튼으로만 펼침. 접혀 있으면 큰 칸은 항상 영상(나누기 설정은 보관)
  const [miniOn, setMiniOn] = useState(false), [shotAt, setShotAt] = useState(0), [, tick] = useState(0);
  useEffect(() => { if (!shotAt) return; const t = setTimeout(() => tick((x) => x + 1), 8000); return () => clearTimeout(t); }, [shotAt]);
  const [split, setSplit] = useState<Split>(() => { const x = store.get<string>('fh.live.split', 'cam'); return (SPLITS as readonly string[]).includes(x) ? (x as Split) : 'cam'; });
  const M = useMedia(), rtt = useGateRtt();
  useDriveScreen();   // 화면을 떠나면 폐기 + hidden + 보기 전용
  useDirWhy();   // U2: 막힌 방향(뒤로 당김·옆·제자리 회전) → 서버 이유 토스트 1회(Main 과 같음)
  const HC = useHeadChips(), cc = camChip(v);
  const sm = useStick(MOVE, ['fx', 'fy']), sr = useStick(ROT, [null, 'fw']), sf = useStick(FB, ['fx', null]);

  const photo = async () => { const p = await shoot(); if (p) setShotAt(Date.now()); if (p) toast(`사진 서버 저장 · 프레임 수신 ${p.frame_at.slice(11, 19)} · ${p.x == null ? '위치 미확인' : `x ${sgn(p.x)} y ${sgn(p.y)} m · 방향 ${deg(p.yaw)}`} · «관찰»에서 분류`); };
  const fsToggle = async () => {
    dropAll();   // 전체화면 진입·나옴 전 폐기(fullscreenchange 도 link.ts 에서 폐기)
    const de = document.documentElement as any, d = document as any;
    try {
      if (d.fullscreenElement || d.webkitFullscreenElement) await (d.exitFullscreen || d.webkitExitFullscreen).call(d);
      else if ((de.requestFullscreen || de.webkitRequestFullscreen) && (d.fullscreenEnabled || d.webkitFullscreenEnabled)) {
        await (de.requestFullscreen || de.webkitRequestFullscreen).call(de);
        try { await (screen.orientation as any).lock('landscape'); } catch { /* 방향 고정 미지원 */ }
      } else toast('이 브라우저는 화면 전체화면을 지원하지 않습니다 · 홈 화면에 추가하면 주소창 없이 열립니다');
    } catch (e) { toast(`전체화면이 막힘(${(e as Error).message || e}) · 홈 화면에 추가하면 주소창 없이 열립니다`); }
  };

  // ②③ 단계·경고 목록(data/drive_stage — 서버 원값만, 자동 take/resume 0). 가운데 알림 = 가장 중요한 경고 1개 + «목록 N» + 기존 큰 버튼
  const sIn = { linkOk: v.linkOk, linkTxt: v.linkTxt, st, viewOnly: L.viewOnly, fallen: s?.fallen === true, newVer: !!v.newVer, block: driveBlock(L) };
  const W = warnsOf(sIn), stg = stageOf(sIn), top = W[0];
  useEffect(() => { if (!W.length) setList(false); }, [W.length]);   // 경고가 없어지면 목록 자동 닫힘
  const btns: JSX.Element[] = [];
  if (v.newVer) btns.push(big('새로고침', () => (ctl ? toast('조종 중에는 새로고침하지 않습니다 — 조종 반납 뒤') : location.reload())));
  if (v.linkOk && st) {
    // SLAM-1: 평지 «시뮬 시작(30분)» 큰 단추 삭제 — 시작은 지도 화면 «지도 열기»(SLAM) 하나. 이 단추는 화면 이동만(기동·지형 고르기 0 — 숨은 rooms_a 빠른 시작 0)
    if (SIM_OFF.includes(st.sim_block) && st.map_start) btns.push(big('시뮬 시작 — 지도 화면에서', () => { location.hash = '#/MMap'; }));
    // N1: 조종권 받기 + STOP 해제 → «조종 시작» 하나(확인 1회). 진행 중이면 단계 글(누를 수 없음)
    const sb = startBlock(L);
    if (L.starting) btns.push(big(L.starting, () => {}, true));
    else if (!sb) btns.push(big('조종 시작', async (e) => { const t = await startDrive(undefined, e.currentTarget); if (t) toast(t); }));   // P2-B: 연 단추
    const can = ctl && !st.reset_pending && !st.resume_pending;
    if (can && (v.latch || s?.fallen === true)) btns.push(big('시뮬 리셋', () => sendOp('reset')));
  }
  const sq = (t: string, label: string, f: () => void) => <button type="button" className="pill" title={label} aria-label={label} onClick={f} style={{ width: '44px', padding: '0', justifyContent: 'center', fontSize: '18px' }}>{t}</button>;
  const fsOn = !!document.fullscreenElement;
  const why = (t: string) => ({ ...whyProps(t), className: 'pill lv-why' });
  const openList = () => { dropAll(); setList(true); };
  const cycle = () => {   // R27: 화면 나누기 = 서랍의 별도 버튼(이름 그대로). 작은 칸은 보기 전용 미리보기라 누르면 바깥 링크(큰 지도 열기)
    dropAll(); setMiniOn(true);
    const nx = SPLITS[(SPLITS.indexOf(split) + 1) % SPLITS.length]; if (!store.set('fh.live.split', nx)) toast('저장 실패 — 이번만 적용'); setSplit(nx);
  };
  // B1: 가운데 amber 배너 제거 — 이유 1줄은 위 띠(단계 알약 옆), 다음 행동은 아래 가운데 행동 칸에 btns[0] 1개만(같은 우선순위),
  // 나머지 행동·경고는 «목록 N»(기존 목록 — 같은 버튼 전부)
  const act = btns[0] || null, more = W.length > 1 || btns.length > 1 || (!!top && !act);   // 행동이 없으면 해결 글은 목록에서
  const sp: Split = miniOn ? split : 'cam';
  const toggleMini = () => { dropAll(); setMiniOn((x) => !x); };   // 배치 바뀜 = 입력 폐기(화면 나누기와 같음)
  const thumbOn = !!shotAt && Date.now() - shotAt < 8000;   // 마지막 사진 썸네일은 찍은 뒤 8 s 만(이후 서랍 «기록 보기»)
  const camEl = <><img data-live-cam="" alt="시뮬 카메라 영상" src={camURL || undefined} style={{ position: 'absolute', inset: '0', width: '100%', height: '100%', objectFit: 'cover', visibility: v.camOk ? 'visible' : 'hidden' }} />
    <div style={{ position: 'absolute', inset: '0', display: 'grid', placeItems: 'center', color: '#9AA7B2', fontSize: sp === 'map' ? '11px' : '14px', pointerEvents: 'none' }}>{v.camOk ? '' : cc.text}</div></>;   // 영상 없을 때만 가운데 이유(가운데 배너는 없앰)
  // 작은 지도도 관제·지도 화면과 같은 선택·결속(실시간 지도면 같은 epoch·seq·신선도 경계, 끊기면 빈 칸 + 이유)
  const mp = useMapPick(false), mOn = mp.on;
  const mapEl = (cap: boolean) => <><MapCanvas name="drive" small zones={D.err || mOn ? [] : docsOf(D, 'zone')} robot={mOn ? mp.pose : v.robot} trail={TRAIL.pts}
    raster={mp.raster} blank={mp.blank} noRobot={mOn && !mp.pose} showTrail={!mOn} flat={mp.flat} />
    {cap && <div style={{ position: 'absolute', left: '0', right: '0', bottom: '0', padding: '2px 6px', fontSize: '10px', lineHeight: '1.4', color: '#E6EBEF', background: 'rgba(14,19,23,.78)', pointerEvents: 'none' }}>
      {mOn ? (mp.raster ? `${mp.live ? '현재 열린 지도' : '저장 지도'} · ${mp.pose ? '위치 표시' : '위치 미표시'}` : '지도 없음 · 지도 화면에서 이유 확인')
        : s ? `시뮬 위치 x ${sgn(s.x, 1)} y ${sgn(s.y, 1)} · ${deg(s.yaw)}` : TRAIL.last ? '시뮬 위치 오래됨' : '시뮬 위치 없음'}</div>}</>;
  const half = (left: boolean, el: JSX.Element) => <div style={{ position: 'absolute', top: 0, bottom: 0, width: '50%', [left ? 'left' : 'right']: 0, overflow: 'hidden', background: '#05080A', ...(left ? { borderRight: '1px solid rgba(230,235,239,.35)' } : {}) }}>{el}</div>;
  const ph = [...M.photos].sort((a, b) => (a.saved_at < b.saved_at ? 1 : -1))[0];   // ⑤ 서버에 저장된 마지막 사진

  const vals = {
    rootRef: root, stopProps, moveLeft: lay === LAYOUTS[1], rotLeft: lay !== LAYOUTS[1],
    cam: sp === 'cam' ? camEl : sp === 'half' ? <>{half(true, camEl)}{half(false, <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>{mapEl(true)}</div>)}</> : <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', background: '#05080A' }}>{mapEl(true)}</div>,
    mini: <div aria-hidden="true" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', background: '#05080A' }}>
      {sp === 'cam' ? mapEl(true) : sp === 'map' ? camEl : <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', textAlign: 'center', fontSize: '12px', color: '#E6EBEF', lineHeight: 1.5 }}>반반 보기<br />누르면 큰 지도</div>}</div>,
    huds: <><span className="hud" role="status" title={`다음: ${stg.next}`} aria-label={`조종 단계 ${stepLabel(stg)}${stg.stop ? ` · 막힘 ${stg.stop}` : ''} · 다음 ${stg.next}`} style={{ background: stg.stop ? 'rgba(255,181,71,.92)' : 'rgba(56,198,217,.9)', color: '#061014', fontWeight: '700' }}>
        {stepLabel(stg)}</span>
      {top && <span className="hud" role="status" data-reason="1" title={`해결: ${top.fix}`} style={{ background: 'rgba(255,181,71,.92)', color: '#061014', fontWeight: '700' }}>{`${MARK[top.lvl]} ${top.text}`}</span>}
      {more && !list && <button type="button" className="hud" onClick={openList} style={{ border: 0, cursor: 'pointer', minHeight: '28px' }}>{`목록 ${Math.max(W.length, btns.length)}`}</button>}
      {HC.filter((c) => (c.k === 'link' || c.k === 'sim') && c.tone !== 'ok').map((c) => <Chip key={c.k} tone={c.tone} text={c.text} why={c.why} />)}
      {!v.camOk && <Chip tone={cc.tone} text={cc.text} why={cc.why} />}   {/* U2 R3·R5: 12자 이하 칩 + ? · 확인된 꺼짐만 off */}
      {!rtt.ok && <span className="hud" title={rtt.why}><span style={{ color: '#FFB547' }}>●</span>{rtt.txt}</span>}
      {s?.fallen !== false && <span className="hud">{v.body}</span>}
      <SafeLine className="drv-safe" /></>,   // U2 보완 B3: 가로 안전 한 줄은 HUD 흐름의 마지막 줄(폭 100%) — 줄바꿈 높이만큼 자연히 아래로, 오른쪽 열(STOP·옆 버튼·막대)과 분리 · 짧은 실제 막힘/미연결만 영상 위 — 정상 RTT·몸·기울기·시험 설명은 서랍
    side: <><div style={{ position: 'absolute', right: '44px', top: '86px', display: 'flex', gap: '8px', zIndex: 3 }}>
      {sq('🗺', miniOn ? '작은 지도 접기' : '작은 지도 펼치기', toggleMini)}{sq('📷', '사진 찍기', photo)}{sq('ⓘ', '안내·설정', () => setMenu(true))}</div>
      {ph && thumbOn && <a href={href('MFinding', { url: ph.url })} aria-label={`마지막 저장 사진 ${ph.saved_at.slice(11, 19)} — 기록 열기`} style={{ position: 'absolute', right: '44px', top: '138px', width: '72px', height: '48px', borderRadius: '8px', overflow: 'hidden', border: '1.5px solid rgba(230,235,239,.45)', zIndex: 3, background: '#05080A' }}>
        <Photo src={ph.url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} /></a>}
      {list && W.length > 0 && <div role="dialog" aria-label="경고 목록" style={{ position: 'absolute', left: '50%', top: '150px', transform: 'translateX(-50%)', boxSizing: 'border-box', width: '420px', maxHeight: '200px', overflowY: 'auto', zIndex: 5, padding: '8px 12px', borderRadius: '10px', background: 'rgba(14,19,23,.95)', color: '#E6EBEF', fontSize: '12px', lineHeight: 1.45 }}>
        {W.map((w, k) => <div key={k} style={{ padding: '4px 0', borderTop: k ? '1px solid rgba(230,235,239,.15)' : 0 }}><b style={{ color: w.lvl === 'info' ? '#5AA9FF' : '#FFB547' }}>{`${MARK[w.lvl]} ${w.text}`}</b><br />{`해결: ${w.fix}`}</div>)}
        {btns.length > 0 && <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', justifyContent: 'center', paddingTop: '6px' }}>{btns}</div>}
        <button type="button" onClick={() => setList(false)} style={{ height: '44px', width: '100%', marginTop: '4px', border: 0, borderRadius: '8px', background: 'rgba(230,235,239,.12)', color: '#E6EBEF', fontSize: '13px', fontWeight: 700 }}>목록 닫기</button></div>}</>,
    // 목록이 열리면 가운데 알림은 숨기고 같은 큰 버튼을 목록 안에(가림 0)
    banner: '', bannerS: { display: 'none' },
    stickP: { [MOVE]: sm.props, [ROT]: sr.props, [FB]: sf.props }, knobR: { [MOVE]: sm.knob, [ROT]: sr.knob, [FB]: sf.knob },
    lbl: { '이동 · 앞뒤 · 옆': '이동 · 앞만(뒤·옆✕)', 앞뒤: '앞뒤 · 앞만(뒤✕)', 회전: '회전 · 앞과 함께' },   // U2: 막힌 방향 안내(허용 범위 변경 0)
    // 속도: 시험한 값은 0.6(보통)뿐 — 시안의 «느리게» 선택 표시를 «보통»으로 옮김
    r0: { ...whyProps('저속 미검증 — 시험한 속도는 0.6 m/s 뿐'), 'aria-checked': false, style: { padding: '0 14px', border: '0', background: 'transparent', color: '#FFFFFF', fontSize: '13px', fontWeight: '600', opacity: 0.5 } },
    r1: { 'aria-checked': true, title: '앞 0.6 m/s (시험한 값)', style: { padding: '0 14px', border: '0', background: 'rgba(230,235,239,.92)', color: '#0B0E11', fontSize: '13px', fontWeight: '700' } },
    poseP: { ...why(`자세 — ${WHY['후진·제자리 회전·옆걸음·저속·자세']}`), style: { display: 'none' } }, backT: '현황',   // 자세(미지원)·속도·현황은 서랍
    // 아래 가운데 행동 칸: 다음 행동 1개 + (조종 중) 조종 반납 — take/resume 은 «조종 시작» 하나(확인 1회, N1)
    give: <>{act && !list && <span data-act="1" style={{ display: 'contents' }}>{act}</span>}{ctl && <button type="button" className="pill" onClick={() => sendOp('release')}>조종 반납</button>}<span className="pill"><DirTag /></span></>,
    simOff: <DevMark />,   // Gazebo 끄기는 서랍(로봇 STOP 아님 문구 그대로) · U1-b: 이 칸엔 개발자 모드 켜짐 표시(누르면 끔)만
  };
  const drawer = menu && <Drawer title="안내 · 설정" onClose={() => setMenu(false)}>
    <a className="pill" href={href('MHome')}>현황으로</a>
    <p>가로 조종 화면은 영상 위 표시라 어두운 테마 고정입니다.</p>
    <p>{`속도: 앞 0.6 m/s 고정(시험한 값만) · 저속(느리게) 미검증 · 자세 미지원 — ${WHY['후진·제자리 회전·옆걸음·저속·자세']}`}</p>
    <p>{TRIAL_SAFE}<span data-dev>{` · ${TRIAL_DEV} · 배터리·온도 미연결 · 링크 왕복 ${rtt.txt} · ${s ? `${v.body} · 기울기 ${num(s.tilt_deg, 0, '°')}` : v.body}`}</span></p>
    <button type="button" onClick={fsToggle}>{fsOn ? '전체화면 닫기' : '전체화면(웹 · 앱은 원래 전체 화면)'}</button>
    <SimOff />
    <DevSwitch text />
    <button type="button" onClick={() => { if (ctl) return toast('조종 중에는 바꾸지 않습니다 — 조종 반납 뒤'); const nx = LAYOUTS[(LAYOUTS.indexOf(lay) + 1) % LAYOUTS.length]; if (!store.set('fh.live.layout', nx)) toast('저장 실패 — 이번만 적용'); setLay(nx); }}>{`막대 배치: ${lay} (눌러 바꾸기)`}</button>
    <p>{`앞뒤 막대: 앞만 움직입니다. 뒤로 당기면 후진 미검증이라 서버가 0으로 막습니다(이유 표시). ${NOMOVE}`}</p>
    <button type="button" onClick={cycle}>{`화면 나누기: ${miniOn ? SPLIT_TXT[split] : '작은 지도 접힘(영상 크게)'} (눌러 바꾸기)`}</button>
    <button type="button" onClick={() => { location.hash = '#/MMap'; }}>큰 지도 열기(지도 화면)</button>
    {st?.map_start && <button type="button" onClick={() => { location.hash = '#/MMap'; }}>{`시뮬 시작(지도 열기 · SLAM)은 지도 화면에서 · ${startTxt(st).map}`}</button>}
    <button type="button" onClick={() => { location.hash = '#/MHistory'; }}>기록 보기(사진·조종 기록)</button>
    {auth.gated && <button type="button" onClick={() => logoutNow().then((e) => e && toast(e))}>{`로그아웃 · ${st?.me || ''}`}{note && <small style={{ display: 'block' }}>{note}</small>}</button>}
    <p data-dev>{`화면 판 ${L.firstVer || '미확인'} · 서버 판 ${st?.ver || '미확인'}`}</p>
    <h3 data-dev>상태 원값</h3><dl data-dev>{stateRows(L).slice(0, 13).map(([a, b]) => [<dt key={a}>{a}</dt>, <dd key={`${a}v`}>{b}</dd>])}</dl>
    <h3>지원 범위와 한계(미제공·미연결·미검증 · 서버가 허용할 때만)</h3><dl>{UNSUP.map(([a, b]) => [<dt key={a}>{a}</dt>, <dd key={`${a}v`}>{b}</dd>])}</dl>
    <p>{`주의: ${RELURCH} · 원인 미확인`}</p>
  </Drawer>;
  const band = <div className="drv-band" role="group" aria-label="세로 조종 줄">
    <div><a className="pill" href={href('MHome')}>현황</a><button type="button" className="pill" onClick={photo}>📷 사진</button><button type="button" className="pill" onClick={() => setMenu(true)}>ⓘ 메뉴</button></div>
    <SafeLine />
    <button type="button" {...stopProps} style={{ height: '64px', minHeight: '64px', flexShrink: 0, border: 0, borderRadius: '12px', background: '#a3342a', color: '#FFFFFF', fontSize: '20px', fontWeight: 700, letterSpacing: '.08em', boxShadow: '0 0 0 3px rgba(255,255,255,.18)' }}>STOP</button></div>;
  return <><style>{CSS + BAND_CSS + (miniOn ? '' : '[data-live-drive] a[aria-label="큰 지도 열기"]{display:none!important}')}</style><div id="dc-root" className="fh"><View v={vals} />{band}{drawer}</div></>;
}
