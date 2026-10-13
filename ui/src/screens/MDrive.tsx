// 휴대폰 가로 조종(원본 틀): 카메라·작은 지도·상태 표시·막대 둘·STOP — web/live.js setupDrive/paintDrive 와 같은 규칙.
// 입력·폐기·발행은 data/link.ts 하나. 처음·복귀·재연결은 보기 전용 — 막대 첫 누름은 «조종권 받기»만.
import { useState } from 'react';
import { CSS, View } from './MDrive.view';
import { deg, num, sgn, store } from '../data/fmt';
import { LAYOUTS, NOMOVE, RELURCH, TRIAL, UNSUP, WHY } from '../data/facts';
import { ask, camURL, dropAll, linkView, sendOp, stateRows, TRAIL, useLink } from '../data/link';
import { docsOf, useDocs } from '../data/shared';
import { shoot } from '../data/run';
import { MapCanvas } from '../map/MapCanvas';
import { useDriveScreen, useFitPhone, useStick } from '../app/drive';
import { Drawer, stopProps, toast, whyProps } from '../app/shell';
import { auth, logoutNow } from '../data/auth';

const MOVE = '이동 막대: 앞뒤와 옆걸음', ROT = '회전 막대: 왼쪽 오른쪽', FB = '앞뒤 막대';
const SIM_OFF = ['시뮬 상태 미수신', '시뮬 상태 끊김'];
const big = (t: string, f: () => void) => <button key={t} type="button" onClick={f} style={{ height: '44px', minWidth: '88px', padding: '0 14px', border: '0', borderRadius: '22px', background: '#1A1206', color: '#FFB547', fontSize: '13px', fontWeight: '700' }}>{t}</button>;
const hud = (good: boolean, label: string, val: string, mono = true) => <span className="hud"><span style={{ color: good ? '#5AA9FF' : '#FFB547' }}>●</span>{label}<span className={mono ? 'mono' : undefined}>{val}</span></span>;

export default function MDrive() {
  const D = useDocs(), L = useLink(), v = linkView(L), st = L.st, s = v.s, root = useFitPhone();
  const ctl = st?.role === 'control' && !L.viewOnly;
  const [lay, setLay] = useState(() => { const x = store.get('fh.live.layout', LAYOUTS[0]); return LAYOUTS.includes(x) ? x : LAYOUTS[0]; });
  const [menu, setMenu] = useState(false);
  useDriveScreen();   // 화면을 떠나면 폐기 + hidden + 보기 전용
  const sm = useStick(MOVE, ['fx', 'fy']), sr = useStick(ROT, [null, 'fw']), sf = useStick(FB, ['fx', null]);

  const startSim = async () => {
    const ss = st?.sim_start; if (!ss || !ss.ok) return toast(`시뮬 시작 안 됨 · ${ss?.why || '서버 응답 없음'}`);
    dropAll(); if (!confirm('Gazebo 시뮬을 30분 동안 시작할까요?\n· RL 쪽 기동 횟수를 1회 씁니다\n· STOP 상태로 시작합니다(«STOP 해제» 뒤 조종)\n· 30분 뒤 자동 종료, 연장 없음')) return;
    toast((await ask('sim_start')).text || '응답 없음');
  };
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

  // 가운데 알림: 끊김·형식 이상·STOP·리셋·넘어짐·조종권 — 없으면 숨김 (live.js paintDrive)
  const msgs: string[] = [], btns: JSX.Element[] = [];
  if (v.newVer) { msgs.push(`새 화면 판(${st!.ver})이 반영됨 · 이 화면은 ${L.firstVer} — 조종 없을 때 새로고침`); btns.push(big('새로고침', () => (ctl ? toast('조종 중에는 새로고침하지 않습니다 — 조종권 반납 뒤') : location.reload()))); }
  if (!v.linkOk || !st) msgs.push(`링크 ${v.linkTxt} · 명령 0`);
  else {
    if (st.sim_block) msgs.push(`${st.sim_block} · 명령 0`);
    if (st.reset_pending) msgs.push('시뮬 리셋 처리 중 · STOP 유지');
    else if (st.resume_pending) msgs.push('STOP 해제 확인 대기 · 명령 0');
    else if (v.latch) msgs.push(`STOP 요청 · 명령 0 잠금 · ${v.body} · ${RELURCH}`);
    if (s?.fallen === true) msgs.push('넘어짐 · 시뮬 리셋 필요');
    if (st.reason && !v.latch && !st.sim_block && st.reason !== '조종권 없음') msgs.push(st.reason);
    if (!ctl) msgs.push(st.role === 'view_other' ? '다른 기기가 조종 중 · 보기 전용' : '«조종권 받기»(또는 막대 한 번) 뒤 STOP 해제 → 다시 누르면 움직임');
    if (SIM_OFF.includes(st.sim_block) && st.sim_start) btns.push(<span key="ss" title={st.sim_start.why || '30분 시뮬 시작(STOP 상태로)'} style={{ opacity: st.sim_start.ok ? undefined : 0.55 }}>{big('시뮬 시작(30분)', startSim)}</span>);
    if (!ctl && st.role !== 'view_other' && !st.sim_block) btns.push(big('조종권 받기', () => sendOp('take')));
    const can = ctl && !st.reset_pending && !st.resume_pending;
    if (can && v.latch) btns.push(big('STOP 해제', () => sendOp('resume')));
    if (can && (v.latch || s?.fallen === true)) btns.push(big('시뮬 리셋', () => sendOp('reset')));
  }
  const sq = (t: string, label: string, f: () => void) => <button type="button" className="pill" title={label} aria-label={label} onClick={f} style={{ width: '44px', padding: '0', justifyContent: 'center', fontSize: '18px' }}>{t}</button>;
  const fsOn = !!document.fullscreenElement;
  const why = (t: string) => ({ ...whyProps(t), className: 'pill lv-why' });

  const vals = {
    rootRef: root, stopProps, moveLeft: lay === LAYOUTS[1], rotLeft: lay !== LAYOUTS[1],
    cam: <><img data-live-cam="" alt="Gazebo 렌더 카메라" src={camURL || undefined} style={{ position: 'absolute', inset: '0', width: '100%', height: '100%', objectFit: 'cover', visibility: v.camOk ? 'visible' : 'hidden' }} />
      <div style={{ position: 'absolute', inset: '0', display: 'grid', placeItems: 'center', color: '#9AA7B2', fontSize: '14px', pointerEvents: 'none' }}>{v.camOk ? '' : `카메라 ${v.camTxt}`}</div></>,
    mini: <><MapCanvas name="drive" small zones={D.err ? [] : docsOf(D, 'zone')} robot={v.robot} trail={TRAIL.pts} />
      <div style={{ position: 'absolute', left: '0', right: '0', bottom: '0', padding: '2px 6px', fontSize: '10px', lineHeight: '1.4', color: '#E6EBEF', background: 'rgba(14,19,23,.78)', pointerEvents: 'none' }}>
        {s ? `GT x ${sgn(s.x, 1)} y ${sgn(s.y, 1)} · ${deg(s.yaw)}` : TRAIL.last ? 'GT 위치 오래됨' : 'GT 위치 없음'}</div></>,
    huds: <><span className="hud" style={{ background: 'rgba(56,198,217,.9)', color: '#061014', fontWeight: '700' }}>{ctl ? '직접 조종 · 시뮬 시험' : v.roleTxt}</span>
      {hud(v.linkOk && !st?.sim_block, '링크 ', v.linkTxt)}{hud(v.camOk, '영상 ', v.camTxt)}{hud(false, '', '배터리 미연결', false)}
      <span className="hud" title={RELURCH}>{TRIAL}</span><span className="hud">{s ? `${v.body} · 기울기 ${num(s.tilt_deg, 0, '°')}` : v.body}</span></>,
    side: <div style={{ position: 'absolute', right: '44px', top: '86px', display: 'flex', gap: '8px', zIndex: 3 }}>
      {sq('⛶', fsOn ? '전체화면 닫기' : '전체화면', fsToggle)}{sq('📷', '사진 찍기', photo)}{sq('ⓘ', '안내·설정', () => setMenu(true))}</div>,
    banner: msgs.length || btns.length ? <>{msgs.join(' · ')}{btns}</> : '',
    bannerS: { display: msgs.length || btns.length ? 'flex' : 'none', height: 'auto', minHeight: '30px', flexWrap: 'wrap', justifyContent: 'center', maxWidth: '420px', padding: '4px 12px' },
    stickP: { [MOVE]: sm.props, [ROT]: sr.props, [FB]: sf.props }, knobR: { [MOVE]: sm.knob, [ROT]: sr.knob, [FB]: sf.knob },
    lbl: { '이동 · 앞뒤 · 옆': '이동 · 앞뒤 · 옆 · 뒤✕', 앞뒤: '앞뒤 · 뒤✕' },
    // 속도: 시험한 값은 0.6(보통)뿐 — 시안의 «느리게» 선택 표시를 «보통»으로 옮김
    r0: { ...whyProps('저속 미검증 — 시험한 속도는 0.6 m/s 뿐'), 'aria-checked': false, style: { padding: '0 14px', border: '0', background: 'transparent', color: '#FFFFFF', fontSize: '13px', fontWeight: '600', opacity: 0.5 } },
    r1: { 'aria-checked': true, title: '앞 0.6 m/s (시험한 값)', style: { padding: '0 14px', border: '0', background: 'rgba(230,235,239,.92)', color: '#0B0E11', fontSize: '13px', fontWeight: '700' } },
    poseP: why(`자세 — ${WHY['후진·제자리 회전·옆걸음·저속·자세']}`), backT: '현황',
    give: ctl ? <button type="button" className="pill" onClick={() => sendOp('release')}>조종권 반납</button> : null,
  };
  const drawer = menu && <Drawer title="안내 · 설정" onClose={() => setMenu(false)}>
    <p>가로 조종 화면은 영상 위 표시라 어두운 테마 고정입니다.</p>
    <button type="button" onClick={() => { if (ctl) return toast('조종 중에는 바꾸지 않습니다 — 조종권 반납 뒤'); const nx = LAYOUTS[(LAYOUTS.indexOf(lay) + 1) % LAYOUTS.length]; if (!store.set('fh.live.layout', nx)) toast('저장 실패 — 이번만 적용'); setLay(nx); }}>{`막대 배치: ${lay} (눌러 바꾸기)`}</button>
    <p>{`앞뒤 막대: 앞만 움직입니다. 뒤로 당기면 후진 미검증이라 서버가 0으로 막습니다(이유 표시). ${NOMOVE}`}</p>
    <button type="button" onClick={() => { location.hash = '#/MHistory'; }}>기록 보기(사진·조종 기록)</button>
    {auth.gated && <button type="button" onClick={() => logoutNow().then((e) => e && toast(e))}>{`로그아웃 · ${st?.me || ''}`}</button>}
    <p>{`화면 판 ${L.firstVer || '미확인'} · 서버 판 ${st?.ver || '미확인'}`}</p>
    <h3>상태 원값</h3><dl>{stateRows(L).slice(0, 13).map(([a, b]) => [<dt key={a}>{a}</dt>, <dd key={`${a}v`}>{b}</dd>])}</dl>
    <h3>현재 v2 연결에서 안 되는 것(미제공·미연결·미검증)</h3><dl>{UNSUP.map(([a, b]) => [<dt key={a}>{a}</dt>, <dd key={`${a}v`}>{b}</dd>])}</dl>
    <p>{`주의: ${RELURCH} · 원인 미확인`}</p>
  </Drawer>;
  return <><style>{CSS}</style><div id="dc-root" className="fh"><View v={vals} />{drawer}</div></>;
}
