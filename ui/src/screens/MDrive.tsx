// 휴대폰 가로 조종(원본 틀): 카메라·작은 지도·상태 표시·막대 둘·STOP — web/live.js setupDrive/paintDrive 와 같은 규칙.
// 입력·폐기·발행은 data/link.ts 하나. 처음·복귀·재연결은 보기 전용 — 막대 첫 누름은 «조종권 받기»만.
import { useNote } from '../data/transport';
import { useEffect, useState } from 'react';
import { CSS, View } from './MDrive.view';
import { deg, num, sgn, store } from '../data/fmt';
import { LAYOUTS, NOMOVE, RELURCH, TRIAL, UNSUP, WHY } from '../data/facts';
import { ask, camURL, startSimAsk, driveBlock, dropAll, linkView, sendOp, startTxt, stateRows, TRAIL, useLink } from '../data/link';
import { docsOf, useDocs, useMedia } from '../data/shared';
import { MARK, STEPS, stageOf, warnsOf } from '../data/drive_stage';
import { href } from '../data/hist';
import { Photo } from '../app/Photo';
import { shoot } from '../data/run';
import { MapCanvas } from '../map/MapCanvas';
import { useMapPick } from '../map/MapPick';
import { useDriveScreen, useFitPhone, useGateRtt, useStick } from '../app/drive';
import { Drawer, SimOff, stopProps, toast, whyProps } from '../app/shell';
import { auth, logoutNow } from '../data/auth';

const MOVE = '이동 막대: 앞뒤와 옆걸음', ROT = '회전 막대: 왼쪽 오른쪽', FB = '앞뒤 막대';
const SIM_OFF = ['시뮬 상태 미수신', '시뮬 상태 끊김'];
// ④ 화면 나누기(화면 배치만 저장): 영상 크게 → 반반 → 지도 크게. 작은 칸을 누르면 다음으로(전환 전 입력 폐기)
const SPLITS = ['cam', 'half', 'map'] as const; type Split = (typeof SPLITS)[number];
const SPLIT_TXT: Record<Split, string> = { cam: '영상 크게', half: '반반', map: '지도 크게' };
const big = (t: string, f: () => void) => <button key={t} type="button" onClick={f} style={{ height: '44px', minWidth: '88px', padding: '0 14px', border: '0', borderRadius: '22px', background: '#1A1206', color: '#FFB547', fontSize: '13px', fontWeight: '700' }}>{t}</button>;
const hud = (good: boolean, label: string, val: string, mono = true) => <span className="hud"><span style={{ color: good ? '#5AA9FF' : '#FFB547' }}>●</span>{label}<span className={mono ? 'mono' : undefined}>{val}</span></span>;

export default function MDrive() {
  const note = useNote((s) => s.note);
  const D = useDocs(), L = useLink(), v = linkView(L), st = L.st, s = v.s, root = useFitPhone();
  const ctl = st?.role === 'control' && !L.viewOnly;
  const [lay, setLay] = useState(() => { const x = store.get('fh.live.layout', LAYOUTS[0]); return LAYOUTS.includes(x) ? x : LAYOUTS[0]; });
  const [menu, setMenu] = useState(false), [list, setList] = useState(false);
  const [split, setSplit] = useState<Split>(() => { const x = store.get<string>('fh.live.split', 'cam'); return (SPLITS as readonly string[]).includes(x) ? (x as Split) : 'cam'; });
  const M = useMedia(), rtt = useGateRtt();
  useDriveScreen();   // 화면을 떠나면 폐기 + hidden + 보기 전용
  const sm = useStick(MOVE, ['fx', 'fy']), sr = useStick(ROT, [null, 'fw']), sf = useStick(FB, ['fx', null]);

  const startSim = async () => toast(await startSimAsk(st));
  const photo = async () => { const p = await shoot(); if (p) toast(`사진 서버 저장 · 프레임 수신 ${p.frame_at.slice(11, 19)} · ${p.x == null ? '위치 미확인' : `x ${sgn(p.x)} y ${sgn(p.y)} m · 방향 ${deg(p.yaw)}`} · «관찰»에서 분류`); };
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
  if (v.newVer) btns.push(big('새로고침', () => (ctl ? toast('조종 중에는 새로고침하지 않습니다 — 조종권 반납 뒤') : location.reload())));
  if (v.linkOk && st) {
    if (SIM_OFF.includes(st.sim_block) && st.sim_start) btns.push(<span key="ss" title={st.sim_start.why || '30분 시뮬 시작(STOP 상태로)'} style={{ opacity: st.sim_start.ok ? undefined : 0.55 }}>{big('시뮬 시작(30분)', startSim)}</span>);
    if (SIM_OFF.includes(st.sim_block) && st.sim_start && !st.sim_start.ok && st.map_start) btns.push(big('지도 화면 (지도 열기)', () => { location.hash = '#/MMap'; }));   // 기존 체험이 막혀도 별도 경로 안내 — 기동은 지도 화면에서 사용자가 직접
    if (!ctl && st.role !== 'view_other' && !st.sim_block) btns.push(big('조종권 받기', () => sendOp('take')));
    const can = ctl && !st.reset_pending && !st.resume_pending;
    if (can && v.latch) btns.push(big('STOP 해제', () => sendOp('resume')));
    if (can && (v.latch || s?.fallen === true)) btns.push(big('시뮬 리셋', () => sendOp('reset')));
  }
  const sq = (t: string, label: string, f: () => void) => <button type="button" className="pill" title={label} aria-label={label} onClick={f} style={{ width: '44px', padding: '0', justifyContent: 'center', fontSize: '18px' }}>{t}</button>;
  const fsOn = !!document.fullscreenElement;
  const why = (t: string) => ({ ...whyProps(t), className: 'pill lv-why' });
  const openList = () => { dropAll(); setList(true); };
  const cycle = (e: React.MouseEvent) => {   // 작은 칸 누름: 큰 지도 링크 대신 화면 나누기 전환(큰 지도는 메뉴에)
    e.preventDefault(); e.stopPropagation(); dropAll();
    const nx = SPLITS[(SPLITS.indexOf(split) + 1) % SPLITS.length]; if (!store.set('fh.live.split', nx)) toast('저장 실패 — 이번만 적용'); setSplit(nx);
  };
  const bannerOn = !list && !!(top || btns.length);   // 가운데 알림 표시 조건(vals.banner·bannerS·카메라 빈칸 문구 공통)
  const camEl = <><img data-live-cam="" alt="Gazebo 렌더 카메라" src={camURL || undefined} style={{ position: 'absolute', inset: '0', width: '100%', height: '100%', objectFit: 'cover', visibility: v.camOk ? 'visible' : 'hidden' }} />
    <div style={{ position: 'absolute', inset: '0', display: 'grid', placeItems: 'center', color: '#9AA7B2', fontSize: split === 'map' ? '11px' : '14px', pointerEvents: 'none' }}>{v.camOk || (bannerOn && split !== 'map') ? '' : `카메라 ${v.camTxt}`}</div></>;   // 가운데 알림이 떠 있으면 그 뒤에 깔려 안 읽힘(실 APK) → 숨김, 같은 값은 위 «영상» 표시에 있음
  // 작은 지도도 관제·지도 화면과 같은 선택·결속(실시간 지도면 같은 epoch·seq·신선도 경계, 끊기면 빈 칸 + 이유)
  const mp = useMapPick(false), mOn = mp.on;
  const mapEl = (cap: boolean) => <><MapCanvas name="drive" small zones={D.err || mOn ? [] : docsOf(D, 'zone')} robot={mOn ? mp.pose : v.robot} trail={TRAIL.pts}
    raster={mp.raster} blank={mp.blank} noRobot={mOn && !mp.pose} showTrail={!mOn} flat={mp.flat} />
    {cap && <div style={{ position: 'absolute', left: '0', right: '0', bottom: '0', padding: '2px 6px', fontSize: '10px', lineHeight: '1.4', color: '#E6EBEF', background: 'rgba(14,19,23,.78)', pointerEvents: 'none' }}>
      {mOn ? (mp.raster ? `${mp.live ? '현재 열린 지도' : '저장 지도'} · ${mp.pose ? '위치 표시' : '위치 미표시'}` : '지도 없음 · 지도 화면에서 이유 확인')
        : s ? `GT x ${sgn(s.x, 1)} y ${sgn(s.y, 1)} · ${deg(s.yaw)}` : TRAIL.last ? 'GT 위치 오래됨' : 'GT 위치 없음'}</div>}</>;
  const half = (left: boolean, el: JSX.Element) => <div style={{ position: 'absolute', top: 0, bottom: 0, width: '50%', [left ? 'left' : 'right']: 0, overflow: 'hidden', background: '#05080A', ...(left ? { borderRight: '1px solid rgba(230,235,239,.35)' } : {}) }}>{el}</div>;
  const ph = [...M.photos].sort((a, b) => (a.saved_at < b.saved_at ? 1 : -1))[0];   // ⑤ 서버에 저장된 마지막 사진

  const vals = {
    rootRef: root, stopProps, moveLeft: lay === LAYOUTS[1], rotLeft: lay !== LAYOUTS[1],
    cam: split === 'cam' ? camEl : split === 'half' ? <>{half(true, camEl)}{half(false, <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>{mapEl(true)}</div>)}</> : <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', background: '#05080A' }}>{mapEl(true)}</div>,
    mini: <div role="button" tabIndex={-1} aria-label={`화면 나누기: ${SPLIT_TXT[split]} — 눌러 바꾸기`} onClick={cycle} style={{ position: 'absolute', inset: 0, cursor: 'pointer', background: '#05080A' }}>
      {split === 'cam' ? mapEl(true) : split === 'map' ? camEl : <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', textAlign: 'center', fontSize: '12px', color: '#E6EBEF', lineHeight: 1.5 }}>반반 보기<br />눌러 바꾸기</div>}</div>,
    huds: <><span className="hud" role="status" title={`다음: ${stg.next}`} aria-label={`조종 단계 ${STEPS[stg.i]}${stg.stop ? ` · 막힘 ${stg.stop}` : ''} · 다음 ${stg.next}`} style={{ background: stg.stop ? 'rgba(255,181,71,.92)' : 'rgba(56,198,217,.9)', color: '#061014', fontWeight: '700' }}>
        {STEPS.map((n, k) => <span key={n} style={{ opacity: k === stg.i ? 1 : 0.45 }}>{k ? ' › ' : ''}{n}</span>)}</span>
      {hud(v.linkOk && !st?.sim_block, '링크 ', v.linkTxt)}{hud(v.camOk, '영상 ', v.camTxt)}{hud(false, '', '배터리·온도 미연결', false)}
      <span className="hud" title={rtt.why}><span style={{ color: rtt.ok ? '#5AA9FF' : '#FFB547' }}>●</span>{rtt.txt}</span>
      <span className="hud" title={RELURCH}>{TRIAL}</span><span className="hud">{s ? `${v.body} · 기울기 ${num(s.tilt_deg, 0, '°')}` : v.body}</span></>,
    side: <><div style={{ position: 'absolute', right: '44px', top: '86px', display: 'flex', gap: '8px', zIndex: 3 }}>
      {sq('⛶', fsOn ? '전체화면 닫기' : '전체화면', fsToggle)}{sq('📷', '사진 찍기', photo)}{sq('ⓘ', '안내·설정', () => setMenu(true))}</div>
      {ph && <a href={href('MFinding', { url: ph.url })} aria-label={`마지막 저장 사진 ${ph.saved_at.slice(11, 19)} — 기록 열기`} style={{ position: 'absolute', right: '44px', top: '138px', width: '72px', height: '48px', borderRadius: '8px', overflow: 'hidden', border: '1.5px solid rgba(230,235,239,.45)', zIndex: 3, background: '#05080A' }}>
        <Photo src={ph.url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} /></a>}
      {list && W.length > 0 && <div role="dialog" aria-label="경고 목록" style={{ position: 'absolute', left: '50%', top: '150px', transform: 'translateX(-50%)', boxSizing: 'border-box', width: '420px', maxHeight: '200px', overflowY: 'auto', zIndex: 5, padding: '8px 12px', borderRadius: '10px', background: 'rgba(14,19,23,.95)', color: '#E6EBEF', fontSize: '12px', lineHeight: 1.45 }}>
        {W.map((w, k) => <div key={k} style={{ padding: '4px 0', borderTop: k ? '1px solid rgba(230,235,239,.15)' : 0 }}><b style={{ color: w.lvl === 'info' ? '#5AA9FF' : '#FFB547' }}>{`${MARK[w.lvl]} ${w.text}`}</b><br />{`해결: ${w.fix}`}</div>)}
        {btns.length > 0 && <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', justifyContent: 'center', paddingTop: '6px' }}>{btns}</div>}
        <button type="button" onClick={() => setList(false)} style={{ height: '44px', width: '100%', marginTop: '4px', border: 0, borderRadius: '8px', background: 'rgba(230,235,239,.12)', color: '#E6EBEF', fontSize: '13px', fontWeight: 700 }}>목록 닫기</button></div>}</>,
    // 목록이 열리면 가운데 알림은 숨기고 같은 큰 버튼을 목록 안에(가림 0)
    banner: bannerOn ? <>{top && <span role="status">{`${MARK[top.lvl]} ${top.text} — ${top.fix}`}</span>}{W.length > 1 && !list && big(`목록 ${W.length}`, openList)}{btns}</> : '',
    bannerS: { display: bannerOn ? 'flex' : 'none', height: 'auto', minHeight: '30px', flexWrap: 'wrap', justifyContent: 'center', maxWidth: '420px', padding: '4px 12px' },
    stickP: { [MOVE]: sm.props, [ROT]: sr.props, [FB]: sf.props }, knobR: { [MOVE]: sm.knob, [ROT]: sr.knob, [FB]: sf.knob },
    lbl: { '이동 · 앞뒤 · 옆': '이동 · 앞뒤 · 옆 · 뒤✕', 앞뒤: '앞뒤 · 뒤✕' },
    // 속도: 시험한 값은 0.6(보통)뿐 — 시안의 «느리게» 선택 표시를 «보통»으로 옮김
    r0: { ...whyProps('저속 미검증 — 시험한 속도는 0.6 m/s 뿐'), 'aria-checked': false, style: { padding: '0 14px', border: '0', background: 'transparent', color: '#FFFFFF', fontSize: '13px', fontWeight: '600', opacity: 0.5 } },
    r1: { 'aria-checked': true, title: '앞 0.6 m/s (시험한 값)', style: { padding: '0 14px', border: '0', background: 'rgba(230,235,239,.92)', color: '#0B0E11', fontSize: '13px', fontWeight: '700' } },
    poseP: why(`자세 — ${WHY['후진·제자리 회전·옆걸음·저속·자세']}`), backT: '현황',
    give: ctl ? <button type="button" className="pill" onClick={() => sendOp('release')}>조종권 반납</button> : null,
    simOff: <SimOff className="pill" />,   // 아래 가운데 줄(STOP 은 오른쪽 위) — 지도 화면·관제와 같은 버튼
  };
  const drawer = menu && <Drawer title="안내 · 설정" onClose={() => setMenu(false)}>
    <p>가로 조종 화면은 영상 위 표시라 어두운 테마 고정입니다.</p>
    <button type="button" onClick={() => { if (ctl) return toast('조종 중에는 바꾸지 않습니다 — 조종권 반납 뒤'); const nx = LAYOUTS[(LAYOUTS.indexOf(lay) + 1) % LAYOUTS.length]; if (!store.set('fh.live.layout', nx)) toast('저장 실패 — 이번만 적용'); setLay(nx); }}>{`막대 배치: ${lay} (눌러 바꾸기)`}</button>
    <p>{`앞뒤 막대: 앞만 움직입니다. 뒤로 당기면 후진 미검증이라 서버가 0으로 막습니다(이유 표시). ${NOMOVE}`}</p>
    <button type="button" onClick={() => { location.hash = '#/MMap'; }}>{`큰 지도 열기 · 지금 화면: ${SPLIT_TXT[split]}(작은 칸을 누르면 바뀜)`}</button>
    {st?.sim_start && <p>{[startTxt(st).left, startTxt(st).last].filter(Boolean).join(' · ')}</p>}
    {st?.map_start && <button type="button" onClick={() => { location.hash = '#/MMap'; }}>{`지도 열기는 지도 화면에서 · ${startTxt(st).map}`}</button>}
    <button type="button" onClick={() => { location.hash = '#/MHistory'; }}>기록 보기(사진·조종 기록)</button>
    {auth.gated && <button type="button" onClick={() => logoutNow().then((e) => e && toast(e))}>{`로그아웃 · ${st?.me || ''}`}{note && <small style={{ display: 'block' }}>{note}</small>}</button>}
    <p>{`화면 판 ${L.firstVer || '미확인'} · 서버 판 ${st?.ver || '미확인'}`}</p>
    <h3>상태 원값</h3><dl>{stateRows(L).slice(0, 13).map(([a, b]) => [<dt key={a}>{a}</dt>, <dd key={`${a}v`}>{b}</dd>])}</dl>
    <h3>현재 v2 연결에서 안 되는 것(미제공·미연결·미검증)</h3><dl>{UNSUP.map(([a, b]) => [<dt key={a}>{a}</dt>, <dd key={`${a}v`}>{b}</dd>])}</dl>
    <p>{`주의: ${RELURCH} · 원인 미확인`}</p>
  </Drawer>;
  return <><style>{CSS}</style><div id="dc-root" className="fh"><View v={vals} />{drawer}</div></>;
}
