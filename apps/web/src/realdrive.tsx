// 실기 직결 조종 화면(10-30 PHONE-REAL-CONNECT, 09 ADR-002 §3·§5): 주변 찾기에서 고른 로봇 에이전트에 폰이 직접(앱 중계 Go2Link) 붙은 뒤.
// 상태·요청은 phone.ts(시뮬과 같은 fh-phone/1 — 출입증·조종권·잠금·STOP·deadman 판정은 에이전트), 이 파일은 그림만. 틀은 시뮬 조종 화면(dv) 그대로.
// 실기는 아직 실제 기체에서 확인하지 않았다 — 알약·안내에 «미검증»을 늘 보인다. 명령은 조직 설정과 로봇이 알린 limits 중 작은 값으로 자른다(실기 = 정지·전진·전진하며 좌우 회전).
// STOP 은 App 머리줄(늘 보임). 끊기면 로봇이 스스로 0·잠금, 자동 다시 연결·자동 재개 없음.
// 11-20 RB-PHONE-DIRECT-LOOK(참고 = Unitree 앱 «느낌»만): 큰 화면 = 라이다 3D(lidar3d.tsx) 또는 카메라, 왼쪽 위 작은 창 = 다른 쪽(눌러 바꿈).
// 위 얇은 줄(나가기·상태 알약) · 오른쪽 접히는 안내 카드 · 아래 가운데 반투명 띠(조종 시작·잠금 해제·다시 연결) · 아래 양 끝 조이스틱. 모양·자리만 — 명령·조종권 흐름 그대로
import { useEffect, useRef, useState } from 'react';
import { UNVERIFIED, allowed, sim, tuned, useSim, useTuneSettings } from './phone';
import { Stick } from './drive';
import { inputGen } from './rt';
import { Video, stopText, useTick } from './simdrive';
import { feedText, media, reasonText, useFeed, type Feed, type MediaChannel } from './media';
import { Lidar3D, type Look } from './lidar3d';
import { Cloud3D, QEmpty } from './quad';
import { REPORT_STALE_MS, go2Pose } from './go2model';
import type { Tone } from './fake';
import './realdrive.css';

/** 화면 글에서 내부 규약명(media/1)·영문 원문 괄호를 뺀다(RV-449 ⑤) — media.ts 문구는 그대로 두고 이 화면에서만 */
export const plain = (t: string) => t.replace(/\s*\([A-Za-z][^)]*\)/g, '').replace(/media\/1\s*/g, '');
/** 에이전트가 알린 사유 한 줄(RV-454 3·RV-455 3·RV-456 2). 알려진 사유(media reasonText «한국어 (원문)»)는 한국어 쪽만,
 *  나머지는 plain 뒤 한글이 있고 영문·숫자·괄호(오류 코드 E_TIMEOUT·504·원문 괄호 등)가 하나도 없을 때만, 아니면 쉬운 말 한 줄. 빈 글만 빈 글(원문만인 사유를 빈 글로 넘기면 Video 가 원문을 낸다) */
export const say = (t: string) => {
  t = t.normalize('NFKC');   // 전각 숫자·괄호·영문(«（５０４）»)도 같은 검사로(RV-457 4)
  const k = /^(.+?) \((.+)\)$/.exec(t);
  if (k && reasonText(k[2]) === t) return k[1];
  const p = plain(t);
  return !t ? '' : /[가-힣]/.test(p) && !/[A-Za-z0-9()[\]]/.test(p) ? p : '로봇에서 영상을 받지 못하고 있습니다';
};
/** 이 화면의 영상·라이다 사유는 모두 여기를 지난다. 에이전트 글이 실리는 곳은 none(알림·사유)뿐 — 그 밖(끊김·만료·멈춤 «2초»·«10초·1회»)은 media.ts 의 앱 자체 글이라 plain 만 */
export const why = (f: Feed, ch: MediaChannel, at?: number) => { const t = feedText(f, ch, at); return f.state === 'none' ? say(t) : plain(t); };
/** 이보다 적은 점의 판은 빈 판 — 라이다 대기로 본다(RV-454 2). ponytail: 고정값, 실기 점 수를 보고 맞출 것 */
const FEW = 10;

export function RealDrive() {
  useTuneSettings();
  const s = useSim(), l = s.link!, st = l.st, w = l.welcome, real = s.real!;
  const open = l.at === 'open', mine = !!l.lease, ready = open && mine && st?.latched === false;
  const input = useRef<[number, number]>([0, 0]);   // [전후, 회전]
  // 입력 세대(rt inputGen — 실기 drive.tsx·직결 시뮬 simdrive.tsx 와 같은 규칙): 스틱 손가락마다 잡은 순간의 세대. 잠김·해제·조종권·stop_gen·연결·STOP·숨김·live 가 바뀌거나 blur 면 +1.
  // 앞 세대 손가락이 아직 눌려 있으면 명령 전체 0 — 떼었다가 다시 눌러야 한다. sg = 스틱마다 잡은 손가락의 세대(없으면 null)
  const [gen] = useState(inputGen), sg = useRef<(number | null)[]>([null, null]);
  const [leaving, setLeaving] = useState<'' | 'wait' | 'fail'>('');
  const live = ready && !leaving;
  useTick(true);
  // 라이다(RV-449 ③④, 11-20 RB-PHONE-LOOK-FIX): media 주소가 없으면(지금 실기 경로는 robot_id 만 — 길 만들기는 다른 작업) 받지 않고 «카메라만» 안내, 교환 단추 없음.
  // 큰 화면 = 라이다는 새 점(2초 안)을 받는 동안만. 대기·멈춤·끊김이면 큰 화면 = 카메라 — 한 번 받다가 멈추면 다시 와도 저절로 돌아가지 않는다(깜빡임 0, 작은 창을 눌러 돌아감)
  // 두 칸·3D 그림은 늘 같은 자리에 두고 class(크기·자리)만 바꾼다 — 다시 만들면 WebGL 생성으로 명령 주기가 끊기고(RV-449 ②) 1회 토큰이 닫힌다
  const hasMedia = !!s.robot?.agent_address, lf = useFeed('lidar', hasMedia), rf = useFeed('rgb', false);
  // 새 판이 와도 그 판의 점이 0개(또는 FEW 미만)면 빈 라이다 — «라이다 기다리는 중», 큰 화면 = 카메라(2초 규칙과 같은 길, RV-454 2). n = 받은 한 판(쌓지 않음)
  const fresh = hasMedia && lf.state === 'live' && !feedText(lf, 'lidar'), lidarOk = fresh && lf.n >= FEW, lidarOn = hasMedia && (lf.state === 'live' || lf.state === 'wait');
  const [pick, setPick] = useState<'lidar' | 'rgb'>('lidar'), main = lidarOk && pick === 'lidar' ? 'lidar' : 'rgb', [no3d, setNo3d] = useState(false), [info, setInfo] = useState(false), [look, setLook] = useState<Look>('points');
  const had = useRef(false);
  useEffect(() => { if (lidarOk) had.current = true; else if (had.current) setPick('rgb'); }, [lidarOk]);
  // 교환은 pointerup(RV-454 1): 스틱을 쥔 채 누른 두 번째 손가락엔 click 이 생기지 않는다. 이 단추에서 누르고 단추 안에서 뗀 손가락만(스틱 손가락은 스틱이 잡고 있어 여기 오지 않음),
  // click 은 키보드(detail 0)만 — 손가락·마우스는 pointerup 이 이미 바꿨다. 기억한 손가락은 밖에서 뗌(창 pointerup)·cancel·lostpointercapture 에서 지운다(RV-455 4)
  const tap = useRef<number | null>(null), untap = () => { tap.current = null; };
  const swap = (ch: 'lidar' | 'rgb') => main !== ch && lidarOk && <button type="button" className="rd-swap" aria-label="큰 화면과 바꾸기" data-real-swap={ch}
    onPointerDown={(e) => { tap.current = e.pointerId; }} onPointerCancel={untap} onLostPointerCapture={untap}
    onPointerUp={(e) => {   // 터치는 누른 단추가 잡고 있어 밖에서 떼도 여기로 온다 — 단추 안에서 뗀 것만
      const r = e.currentTarget.getBoundingClientRect(), inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (tap.current === e.pointerId && inside) setPick(ch);
      untap();
    }} onClick={(e) => { if (!e.detail) setPick(ch); }} />;
  // 3D 속 Go2 관절각·기울기(RV-466 1): 서버 경유·PC 와 같은 go2Pose — 직결 state 엔 connection 이 없어 «열린 연결 = ONLINE», 1초 넘게 보고가 없으면 선 자세(null)
  const go2 = go2Pose(open && st ? { connection: 'ONLINE', robot_info: st.robot_info } as Parameters<typeof go2Pose>[0] : null, performance.now() - l.stAt < REPORT_STALE_MS);
  const lidarBig = main === 'lidar', lidarFeed = { ...lf, range: null, pose: null };
  const lidarText = !hasMedia ? '라이다 화면 없음 · 이 연결은 카메라만 보입니다' : lidarOk ? '' : fresh || lf.state === 'wait' || lf.state === 'off' ? '라이다 기다리는 중'
    : lf.state === 'live' ? '라이다 신호 없음 · 2초 넘게 새 점이 오지 않습니다' : `라이다 신호 없음 · ${why(lf, 'lidar')}`;
  const rgbText = media.has('rgb') ? why(rf, 'rgb') : '';   // 옛 카메라 경로 글은 Video 그대로
  useEffect(() => () => sim.axes([0, 0]), []);
  useEffect(() => { input.current = [0, 0]; sim.axes([0, 0]); }, [live]);   // 움직일 수 없게 되면 입력 0(다시 눌러야)
  /** 지금 세대 — 값은 저장소에서 바로(rt 로봇이 아니므로 id '' = 빈 항목, 숨김은 inputGen 이 본다) */
  const sync = () => { const g = sim.get(), k = g.link; return gen.sync('', [ref.current.live, k?.at, k?.lease, k?.st?.latched, k?.st?.stop_gen, k?.welcome, g.stop]); };
  /** 지금 세대 입력만 보낸다. 앞 세대 손가락이 남아 있으면 0 */
  const push = () => { const n = sync(), old = sg.current.some((x) => x != null && x !== n); sim.axes(old ? [0, 0] : [input.current[0], input.current[1]]); };
  const put = (i: 0 | 1, v: number) => { input.current[i] = v; push(); };
  const ref = useRef({ live, push }); ref.current = { live, push };
  useEffect(() => {
    const zero = () => { gen.bump(); ref.current.push(); };   // 창 밖에서 뗀 손가락은 알 수 없다 — 세대 +1, 누르던 스틱도 다시 눌러야
    const hide = () => { if (document.visibilityState === 'hidden') zero(); };
    const lift = (e: PointerEvent) => { if (e.pointerId === tap.current) tap.current = null; };   // 교환 단추 밖에서 뗀 손가락(단추엔 오지 않음)
    addEventListener('blur', zero); document.addEventListener('visibilitychange', hide); addEventListener('pointerup', lift); addEventListener('pointercancel', lift);
    const off = sim.subscribe(() => ref.current.push());   // 잠김·해제·stop_gen·STOP 이 오면 손을 대지 않아도 그 자리에서 세대를 맞춰 0
    return () => { removeEventListener('blur', zero); document.removeEventListener('visibilitychange', hide); removeEventListener('pointerup', lift); removeEventListener('pointercancel', lift); off(); };
  }, []);
  /** 나가기: 0 → 조종권 반납(답 2 s 까지) → 확인된 반납만 연결·중계를 닫고 로봇 연결 화면으로. 못 하면 남는다(입력 0, «다시 반납») */
  const leave = async () => {
    setLeaving('wait');
    const k = sim.get().link;
    const ok = k?.lease ? await Promise.race([sim.release(), new Promise<boolean>((f) => setTimeout(() => f(false), 2000))])
      : k?.at === 'closed' || !k?.st?.lease_id && k?.busy !== 'release';   // 끊긴 연결 = 로봇이 이미 0·잠금·조종권 비움
    if (sim.get().real !== real) return;
    if (ok) sim.reset(); else setLeaving('fail');
  };
  const left = l.exp ? Math.floor(l.exp - Date.now() / 1000) : Infinity, can = allowed(w);
  const soc = st?.battery?.soc;
  const lock: { tone: Tone; text: string } = !open ? { tone: 'bad', text: l.at === 'connecting' ? '연결 중' : '연결 끊김' } : !st ? { tone: 'off', text: '상태 확인 중' }
    : st.latched ? { tone: 'bad', text: '정지 잠금' } : !mine ? { tone: 'off', text: '보는 중' } : { tone: 'ok', text: '움직일 수 있음' };
  const notes = [
    stopText(s),
    leaving === 'wait' && '조종권을 반납하고 나가는 중입니다…',
    leaving === 'fail' && '조종권 반납을 확인하지 못했습니다 — 입력은 0 입니다. 다시 반납하거나 STOP 을 누르세요.',
    l.at === 'closed' && l.why,
    l.notice,
    mine && l.clipped && '명령 범위 조정 — 로봇이 허용한 명령으로 잘랐습니다.',
    open && left < 60 && `출입증 ${Math.max(0, left)}초 남음 — 만료되면 로봇이 멈추고 조종권이 비워집니다. 새 출입증으로 다시 연결하세요.`,
  ].filter(Boolean) as string[];
  const acts = [
    leaving === 'fail' && <button key="rel" type="button" className="btn pri" onClick={leave}>다시 반납</button>,
    !leaving && open && !mine && <button key="take" type="button" className="btn pri" disabled={l.busy === 'take'} onClick={() => sim.take()}>조종 시작</button>,
    !leaving && open && mine && st?.latched !== false && <button key="unlock" type="button" className="btn pri" disabled={l.busy === 'unlock'} onClick={() => sim.unlock()}>잠금 해제</button>,
    l.at === 'closed' && <button key="re" type="button" className="btn pri" onClick={() => sim.connect()}>다시 연결</button>,
    !leaving && open && left < 60 && <button key="pass" type="button" className="btn" onClick={() => sim.connect()}>새 출입증으로 다시 연결</button>,
  ].filter(Boolean);
  const L = w && tuned(w).L;
  const range = L && `실효 상한: 앞 ${L.vx_max.toFixed(2)} · ${L.vx_min < 0 ? `뒤 ${Math.abs(L.vx_min).toFixed(2)}` : '후진 없음'} · 옆 ${Math.max(L.vy_max, -L.vy_min).toFixed(2)} m/s · 회전 ${L.wz_min}~${L.wz_max} rad/s${can.spin ? '' : '(앞으로 밀면서만)'}`;
  return <section className="dv ph" style={{ flexBasis: '100%' }} aria-label="실기 조종" data-real-drive data-main={main} onContextMenu={(e) => e.preventDefault()}>
    <div className="dv-body"><div className="dv-stage rgb">
      <div className={`rd-view ${main === 'rgb' ? 'big' : 'pip'}`} data-real-view="rgb"><Video ch="rgb" fit="cover" quiet={!!rgbText} />{rgbText && <QEmpty text={rgbText} />}{swap('rgb')}</div>
      <div className={`rd-view ${lidarBig ? 'big' : 'pip'}`} data-real-view="lidar" data-off={!hasMedia || undefined}>
        {lidarOn && (no3d ? <Cloud3D small={false} big={false} feed={lf} /> : <Lidar3D feed={lidarFeed} small={false} ratio={1} look={look} go2={go2} onFail={() => setNo3d(true)} />)}
        {lidarText && <QEmpty text={lidarText} />}
        {/* 큰 화면 고르기 «점 ↔ 상자»(11-20 RB-UNITREE-LOOK-FIX) — 같은 3D 그림에서 모양만 바꿈(WebGL 다시 만들지 않음). 작은 창 아래 */}
        {lidarBig && !no3d && <button type="button" className="btn" aria-pressed={look === 'boxes'} data-real-look={look} onClick={() => setLook(look === 'boxes' ? 'points' : 'boxes')}
          style={{ position: 'absolute', zIndex: 2, left: 8, top: 'calc(68px + clamp(120px, 24vw, 220px) * 0.75)' }}>{look === 'boxes' ? '점으로 보기' : '상자로 보기'}</button>}
        {swap('lidar')}
      </div>
      <div className="dv-safe">
        <button type="button" className="dv-gear dv-leave" aria-label="나가기" disabled={leaving === 'wait'} data-real-leave onClick={leave}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M15 5l-7 7 7 7" /></svg></button>
        <div className="dv-top" aria-label="상태" data-tone={lock.tone} data-real-pill>실기 · 미검증 · {lock.text} · {real.name}{typeof soc === 'number' && ` · 배터리 ${Math.round(soc)}%`}</div>
        {/* 안전 글(반납 실패·출입증·끊김 이유·미검증·현장 비상 정지 수단)은 접어도 늘 위에 — 넘치면 카드 안 스크롤(접히는 실효 상한이 맨 아래) */}
        <div className="rd-card" data-real-card>
          {notes.map((t) => <p key={t} className="dv-note" role="status">{t}</p>)}
          <p className="dv-note" role="note" data-real-unverified>{UNVERIFIED}</p>
          {range && <>
            <button type="button" className="rd-card-h" aria-expanded={info} data-real-info onClick={() => setInfo(!info)}>
              <span>실효 상한</span><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d={info ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6'} /></svg></button>
            <div className="rd-card-t" hidden={!info}><p className="dv-note" data-real-range>{range}</p></div>
          </>}
        </div>
        {acts.length > 0 && <div className="rd-band" role="group" aria-label="조종 단추" data-real-band>{acts}</div>}
        {l.ask && mine && <div className="dv-ask" role="dialog" aria-labelledby="real-ask-t" aria-live="assertive">
          <b id="real-ask-t">조종권 요청</b><p>다른 사람이 이 로봇의 조종권을 요청했습니다. 넘겨주시겠습니까?</p>
          <div className="fh-row"><button type="button" className="btn" onClick={() => sim.respond(true)}>넘기기</button><button type="button" className="btn" onClick={() => sim.respond(false)}>계속 조종</button></div></div>}
        {mine && open && <>
          <Stick label="전후" vertical on={live} epoch={+live} gen={gen} press={sync} grip={(o) => { sg.current[0] = o; }} lift={push} set={(v) => put(0, v)} />
          <Stick label="회전" on={live} epoch={+live} gen={gen} press={sync} grip={(o) => { sg.current[1] = o; }} lift={push} set={(v) => put(1, v)} />
        </>}
      </div>
    </div></div>
  </section>;
}
