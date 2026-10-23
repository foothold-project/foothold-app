// 시뮬 로봇 띄우기 → 지도(월드) 고르기 → 직결 조종 → 끝내기(09 ADR-002 §3.2·§6). 상태·요청은 phone.ts, 이 파일은 그림만.
import { useEffect, useRef, useState } from 'react';
import type { SimRobot } from '../../contracts/ts';
import { sim, useSim, velocity, type Sim } from './phone';
import { Sheet, Stick } from './drive';
import { Chip } from './screens';
import { simName, type Tone } from './fake';

/** on 인 동안 1 s 마다 다시 그림(경과·남은 시간) */
function useTick(on: boolean) {
  const [, t] = useState(0);
  useEffect(() => { if (!on) return; const i = setInterval(() => t((n) => n + 1), 1000); return () => clearInterval(i); }, [on]);
}
function useDeadline(on: boolean) {
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(() => { void sim.load(); }, 2000);
    return () => clearInterval(timer);
  }, [on]);
}
export function remainingTime(until: number | null, at = performance.now()) {
  return until === null ? null : Math.max(0, Math.ceil((until - at) / 1000));
}
const minutes = (s: number) => `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;
export function timeNotice(left: number | null) {
  return left === null || left > 300 ? '' : left === 0 ? '시간이 다 되었습니다 — 정리를 확인하고 있습니다.'
    : left <= 60 ? '1분 안에 시뮬을 끝냅니다.' : '5분 안에 시뮬을 끝냅니다.';
}
const short = (id: string) => simName(id, [id]);   // 16진 id 는 본문에 쓰지 않는다(U5)
/** 월드 이름(목록에 없으면 «월드») — 월드 내부 id 는 본문에 쓰지 않는다 */
const worldName = (s: Sim, id: string) => s.catalog?.worlds.find((w) => w.id === id)?.name ?? '월드';
const STATE: Record<SimRobot['state'], string> = { STARTING: '띄우는 중', PREPARED: '가짜 기동(연결할 로봇 없음)', RUNNING: '실행 중', STOPPING: '정리 중', ERROR: '오류' };

/** STOP 결과 한 줄 — 보냈다는 것과 로봇이 알린 잠금을 나눠 쓴다(확인 안 된 «정지됨» 없음, F-COM-01) */
export function stopText({ stop: p, link: l, step, slotBusy }: Sim) {
  if (!p) return '';
  if (p.via === 'cleanup') return step === 'pick' ? '' : slotBusy ? '■ 로봇에 연결 전 — 명령 없음. 내 시뮬 로봇으로 확인되면 정리합니다.'
    : step === 'checking' ? '■ 로봇에 연결 전 — 명령 없음. 정리를 확인하지 못했습니다 — 다시 끝내기를 누르세요.' : '■ 로봇에 연결 전 — 명령 없음, 정리 중입니다.';
  const st = l?.st;
  if (!st || l!.stAt <= p.at) return '■ 정지 요청을 로봇에 보냈습니다. 로봇 확인을 기다립니다.';
  if (!st.latched) return '■ 정지 요청을 보냈지만 로봇이 아직 잠금을 알리지 않았습니다.';
  return st.applied.every((v) => v === 0) ? '■ 정지 잠금 — 로봇이 잠금과 멈춤 출력을 알렸습니다.' : '▲ 정지 잠금 — 출력이 아직 멈추지 않았습니다. 현장을 확인하세요.';
}

/** 로봇 연결 화면 아래 칸: 월드 고르기·띄우기·진행·확인 중 */
export function SimLaunch({ me }: { me: string }) {
  const s = useSim(), [pick, setPick] = useState('');
  useDeadline(!!s.robot?.expires_at);
  useEffect(() => { if (s.step === 'pick') sim.load(); }, []);
  useTick(s.step === 'starting');
  const worlds = s.catalog?.worlds ?? [], world = worlds.some((w) => w.id === pick) ? pick : worlds[0]?.id ?? '';
  const l = s.link, wait = Math.max(0, Math.ceil((s.retryAt - performance.now()) / 1000));
  useTick(!!wait);
  const msg = s.err && <p className="fh-why" role="status" data-sim-msg>{s.err}</p>;
  const stop = stopText(s);
  const cleanup = s.cleanup.filter((r) => r.owner_id === me);
  // 새로고침·나가기 뒤 다시 들어가기 — 새 연결이라 조종권·잠금 해제는 처음부터(자동 재개 없음)
  const resume = s.mine.find((r) => r.state === 'RUNNING' && r.owner_id === me);
  let body;
  if (s.step === 'starting') body = <p className="lv-note" role="status" data-sim="starting">시뮬 로봇을 띄우는 중입니다 — {worldName(s, s.robot?.world_id ?? world)} ({Math.floor((performance.now() - s.since) / 1000)}초). 실제 시뮬은 2분 넘게 걸릴 수 있습니다.</p>;
  else if (s.step === 'unsure') body = <><p className="fh-why" role="status" data-sim="unsure">확인 중 — {s.err} {s.slotBusy ? '남의 로봇일 수 있어 내 것으로 확인되기 전에는 정리하지 않습니다.' : '서버에는 «띄우는 중»으로 남았을 수 있습니다. 목록을 다시 확인하거나 정리하세요.'}</p>
    <div className="fh-row"><button type="button" className="btn" onClick={() => sim.recheck()}>다시 확인</button>{!s.slotBusy && <button type="button" className="btn" onClick={() => sim.end()}>정리</button>}</div></>;
  else if (s.step === 'linking') body = l?.at === 'closed'
    ? <><p className="fh-why" role="status" data-sim="link-fail">{l.why}</p>
        <div className="fh-row"><button type="button" className="btn pri" disabled={!!wait} onClick={() => sim.connect()}>{wait ? `다시 연결(${wait}초 뒤)` : '다시 연결'}</button><button type="button" className="btn" onClick={() => sim.end()}>끝내기</button></div></>
    : <p className="lv-note" role="status" data-sim="linking">출입증을 받아 {s.robot && short(s.robot.robot_id)} 에 직접 연결하는 중입니다…</p>;
  else if (s.step === 'ending') body = <p className="lv-note" role="status" data-sim="ending">조종권을 반납하고 시뮬 로봇을 정리하는 중입니다…</p>;
  else if (s.step === 'checking') body = <><p className="fh-why" role="status" data-sim="checking">확인 중 — {s.err} {s.listed && s.robot && (s.mine.some((r) => r.robot_id === s.robot!.robot_id) ? '목록에 아직 있습니다.' : '목록에는 없지만 정리됐다고 단정할 수 없습니다.')}</p>
    <div className="fh-row"><button type="button" className="btn pri" onClick={() => sim.end()}>다시 끝내기</button><button type="button" className="btn" onClick={() => sim.load()}>다시 확인</button><button type="button" className="btn" onClick={() => sim.reset()}>처음으로</button></div></>;
  else body = <>
    {resume && <button type="button" className="btn pri dv-resume" data-sim-resume onClick={() => sim.attach(resume)}>조종 화면 띄우기</button>}
    {cleanup.length > 0 && <ul className="dv-cards" aria-label="정리할 내 시뮬 자리">{cleanup.map((r) => <li key={r.robot_id} className="card dv-card">
      <b>{short(r.robot_id)}</b><p className="fh-why">{s.managerError ? '관리자가 내 시뮬 자리를 확인하지 못했습니다.' : '이전 시뮬이 정리되지 않았습니다.'}</p>
      {!r.can_recover && <p className="fh-why">이 시뮬 자리는 자동 정리할 수 없습니다 — 관리자에게 문의하세요.</p>}
      <button type="button" className="btn" onClick={() => sim.cleanupSlot(r)}>정리</button></li>)}</ul>}
    {s.mine.length > 0 && <ul className="dv-cards" aria-label="내 시뮬 로봇">{s.mine.map((r) => <li key={r.robot_id} className="card dv-card">
      <div className="fh-row"><b>{short(r.robot_id)}</b><Chip tone="off" text="시뮬" /><span className="lbl">{worldName(s, r.world_id)} · {STATE[r.state]}</span></div>
      <div className="fh-row">{r !== resume && <button type="button" className="btn pri" onClick={() => sim.attach(r)}>직접 연결</button>}<button type="button" className="btn" onClick={() => sim.end(r)}>{r.state === 'ERROR' ? '정리' : '끝내기'}</button></div></li>)}</ul>}
    {s.catalog && (worlds.length ? <fieldset className="fh-field" style={{ border: 0, padding: 0, margin: 0 }}><legend>지도(월드)</legend>
      <ul className="fh-list" aria-label="월드 목록">{worlds.map((w) => <li key={w.id}><label className="fh-row">
        <input type="radio" name="sim-world" value={w.id} checked={w.id === world} onChange={() => setPick(w.id)} />
        <span><b>{w.name}</b>{w.description && <><br /><small className="lbl">{w.description}</small></>}</span></label></li>)}</ul></fieldset>
      : <p className="lv-note">고를 수 있는 월드가 없습니다.</p>)}
    <button type="button" className="btn pri" disabled={!world || s.mine.length > 0 || cleanup.length > 0} aria-describedby={s.mine.length ? 'sim-one' : undefined} onClick={() => sim.start(world, me)}>띄우기</button>
    {s.mine.length > 0 && <span id="sim-one" className="fh-why">시뮬 로봇은 한 사람에 한 대입니다. 위 로봇에 연결하거나 끝낸 뒤 띄우세요.</span>}</>;
  return <section className="lv-card" style={{ flexBasis: '100%' }} aria-label="시뮬 로봇 띄우기">
    <h2>시뮬 로봇 띄우기</h2>
    {body}
    {s.step !== 'unsure' && s.step !== 'checking' && msg}
    {stop && <p className="fh-why" role="status" data-sim-stop>{stop}</p>}
  </section>;
}

const CAM = { wait: '영상 기다리는 중', none: '영상 없음 — 로봇이 영상을 보내지 않습니다', lost: '영상 연결이 끊겼습니다. 조종·STOP 에는 영향이 없습니다', off: '이 로봇은 영상을 보내지 않습니다', frame: '' };

const I = (d: JSX.Element) => <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">{d}</svg>;
const ICON = {
  gear: I(<><path strokeLinejoin="round" d="M19.1 9.8L21.9 10.4L21.9 13.6L19.1 14.2L18.5 15.5L20.1 17.9L17.9 20.1L15.5 18.5L14.2 19.1L13.6 21.9L10.4 21.9L9.8 19.1L8.5 18.5L6.1 20.1L3.9 17.9L5.5 15.5L4.9 14.2L2.1 13.6L2.1 10.4L4.9 9.8L5.5 8.5L3.9 6.1L6.1 3.9L8.5 5.5L9.8 4.9L10.4 2.1L13.6 2.1L14.2 4.9L15.5 5.5L17.9 3.9L20.1 6.1L18.5 8.5Z" /><circle cx="12" cy="12" r="3" /></>),
  set: I(<path d="M4 7h10M18 7h2M4 17h4M12 17h8M16 5v4M10 15v4" />),
  info: I(<><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7v1" /></>),
  exit: I(<path d="M14 4h5v16h-5M10 8l-4 4 4 4M6 12h10" />),
};

/** 직결 조종 화면: 카메라 전체. 영상 위에는 왼쪽 위 «시뮬·속도», 오른쪽 위 설정 메뉴(설정·정보·나가기), 아래 지금 눌러야 할 단추·안내,
 *  두 조이스틱만. STOP 은 App 머리줄(영상 칸 밖이라 메뉴·시트가 덮지 못함). 메뉴가 열려 있거나 나가는 중이면 입력 0 */
export function SimDrive() {
  const s = useSim(), l = s.link!, r = s.robot!, st = l.st, w = l.welcome;
  useDeadline(!!r.expires_at);
  const open = l.at === 'open', mine = !!l.lease, ready = open && mine && st?.latched === false;
  const input = useRef<[number, number]>([0, 0]), gen = useRef(0);
  const [unsupported, setUnsupported] = useState(''), [vx, setVx] = useState(0);
  const [menu, setMenu] = useState<'' | 'menu' | 'set' | 'info'>(''), [leaving, setLeaving] = useState<'' | 'wait' | 'fail'>('');
  const live = ready && !menu && !leaving;
  const smooth = w?.limits.vx_mode === 'continuous';
  useTick(true);
  useEffect(() => () => sim.axes([0, 0]), []);
  useEffect(() => { input.current = [0, 0]; sim.axes([0, 0]); setUnsupported(''); setVx(0); }, [live]);
  const put = (i: 0 | 1, v: number) => {
    input.current[i] = v;
    const [f, t] = input.current;
    setUnsupported(f < 0 ? '후진은 아직 지원하지 않습니다 — 시뮬에서 아직 확인 안 됨'
      : f === 0 && t !== 0 ? '제자리 회전 — 시뮬에서 아직 확인 안 됨. 앞으로 밀면서 돌리세요.' : '');
    if (w) setVx(velocity([f, t], w).vx);
    sim.axes([f, t]);
  };
  /** 나가기: 0 → 조종권 반납(답 2 s 까지) → 확인된 반납만 연결 닫고 띄우기 카드로. 시뮬은 켠 채(«조종 화면 띄우기»로 다시 들어옴).
   *  거절·무응답이면 조종 화면에 남는다(연결·STOP 대상 보존, 입력 0, «다시 반납») */
  const leave = async () => {
    setMenu(''); setLeaving('wait');
    const k = sim.get().link;
    const ok = k?.lease ? await Promise.race([sim.release(), new Promise<boolean>((f) => setTimeout(() => f(false), 2000))])
      : !k?.st?.lease_id && k?.busy !== 'release';   // 조종권 없음 = 반납할 것 없음. 서버가 아직 내 것이라 알리거나 반납 답을 기다리는 중이면 확인 못 함
    if (sim.get().robot?.robot_id !== r.robot_id || sim.get().step !== 'drive') return;
    if (ok) sim.reset(); else setLeaving('fail');
  };
  const left = l.exp ? Math.floor(l.exp - Date.now() / 1000) : Infinity;
  const runtimeLeft = remainingTime(s.runtimeUntil);
  const lock: { tone: Tone; text: string } = !open ? { tone: 'bad', text: l.at === 'connecting' ? '연결 중' : '연결 끊김' } : !st ? { tone: 'off', text: '상태 확인 중' }
    : st.latched ? { tone: 'bad', text: '정지 잠금' } : !mine ? { tone: 'off', text: '보는 중' } : { tone: 'ok', text: '움직일 수 있음' };
  const who = !st || !open ? '' : st.lease_id ? '조종 중(나)' : !st.controller ? '조종하는 사람 없음' : st.controller_connected ? '다른 사람이 조종 중' : '조종자 연결 끊김(자리 예약 중)';
  const soc = st?.battery?.soc, wait = Math.max(0, Math.ceil((s.retryAt - performance.now()) / 1000)), stop = stopText(s);
  const notes = [
    r.state === 'STOPPING' && '시뮬을 정리하는 중…',
    r.state === 'STARTING' && '시뮬을 띄우는 중…',
    timeNotice(runtimeLeft),
    l.at === 'closed' && l.why,
    l.notice,
    leaving === 'wait' && '조종권을 반납하고 나가는 중입니다…',
    leaving === 'fail' && '조종권 반납을 확인하지 못했습니다 — 입력은 0 입니다. 다시 반납하거나 STOP 을 누르세요.',
    unsupported,
    !unsupported && mine && l.clipped && w && `명령 범위 조정 — 로봇 허용 범위(앞 ${w.limits.vx_max.toFixed(2)} m/s, 회전 ±${w.limits.wz_max} rad/s)로 잘랐습니다. ${smooth ? '회전은 끝까지 밀어야 돕니다.' : '끝까지 밀어야 움직입니다.'}`,
    open && left < 60 && `출입증 ${Math.max(0, left)}초 남음 — 만료되면 로봇이 멈추고 조종권이 비워집니다. 새 출입증으로 다시 연결하세요.`,
    stop,
  ].filter(Boolean) as string[];
  const acts = leaving ? leaving === 'fail' && [
    <button key="rel" type="button" className="btn pri" onClick={leave}>다시 반납</button>,
    l.at === 'closed' && <button key="re" type="button" className="btn" disabled={!!wait} onClick={() => sim.connect()}>{wait ? `다시 연결(${wait}초 뒤)` : '다시 연결'}</button>,
  ].filter(Boolean) : [
    open && !mine && <button key="take" type="button" className="btn pri" disabled={l.busy === 'take'} onClick={() => sim.take()}>조종 시작</button>,
    open && mine && st?.latched !== false && <button key="unlock" type="button" className="btn pri" disabled={l.busy === 'unlock'} onClick={() => sim.unlock()}>잠금 해제</button>,
    l.at === 'closed' && <button key="re" type="button" className="btn pri" disabled={!!wait} onClick={() => sim.connect()}>{wait ? `다시 연결(${wait}초 뒤)` : '다시 연결'}</button>,
    open && left < 60 && <button key="pass" type="button" className="btn" onClick={() => sim.connect()}>새 출입증으로 다시 연결</button>,
  ].filter(Boolean);
  return <section className="dv ph" style={{ flexBasis: '100%' }} aria-label="조종" data-sim-drive>
    <div className="dv-body"><div className="dv-stage rgb">
      {l.cam === 'frame' ? <img className="dv-video" src={l.img} alt="RGB 영상" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
        : <div className="dv-video" role="img" aria-label="RGB 영상"><span>{CAM[l.cam]}</span></div>}
      <div className="dv-top" aria-label="상태">
        <Chip tone="off" text="시뮬" />
        <span className="mono" data-sim-vx>속도 : {(live ? vx : 0).toFixed(2)}m/s</span>
        {lock.tone !== 'ok' && <Chip {...lock} />}
      </div>
      <button type="button" className="dv-gear" aria-label="설정 메뉴" aria-expanded={!!menu} data-sim-menu onClick={() => setMenu(menu ? '' : 'menu')}>{ICON.gear}</button>
      {menu === 'menu' && <div className="dv-menu" role="group" aria-label="설정 메뉴 항목">
        <button type="button" className="btn" onClick={() => setMenu('set')}>{ICON.set}<span>설정</span></button>
        <button type="button" className="btn" onClick={() => setMenu('info')}>{ICON.info}<span>정보</span></button>
        <button type="button" className="btn" onClick={leave}>{ICON.exit}<span>나가기</span></button>
      </div>}
      {menu === 'set' && <Sheet title="설정" close={() => setMenu('')}>
        {smooth ? <p className="dv-note">시뮬 전용 · 멈출 때 가끔 넘어질 수 있음(측정 34회 중 3회) · 후진·제자리 회전은 아직 지원하지 않습니다</p> : <>
        <div className="fh-row" role="group" aria-label="속도 단계" aria-describedby="sim-speed-note">
          <button type="button" className="btn" disabled aria-pressed={false}>느림</button>
          <button type="button" className="btn pri" aria-pressed={true}>보통 · 0.6 m/s</button>
          <button type="button" className="btn" disabled aria-pressed={false}>빠름</button>
        </div>
        <p id="sim-speed-note" className="dv-note">느림·빠름·후진·제자리 회전: 시뮬에서 아직 확인 안 됨</p></>}
        {open && mine && <div className="fh-row"><button type="button" className="btn" disabled={l.busy === 'release'} onClick={() => sim.release()}>조종권 반납</button><span className="lbl">보기 연결은 남습니다.</span></div>}
      </Sheet>}
      {menu === 'info' && <Sheet title="정보" close={() => setMenu('')}>
        <div className="fh-row dv-line" style={{ flexWrap: 'wrap' }} data-sim-info>
          <h2>{short(r.robot_id)}</h2><Chip tone="off" text="시뮬" /><span className="lbl">{worldName(s, r.world_id)}</span>
          {runtimeLeft !== null && <span className="mono">남은 시간 {minutes(runtimeLeft)}</span>}
          {who && <span>{who}</span>}
          {soc != null && <span className="mono">{Math.round(soc)}%</span>}
          {l.rtt != null && open && <span className="mono">지연 {l.rtt} ms</span>}
          {w && <span className="lbl">정책 {w.policy.name} {w.policy.version}</span>}
          {st?.sim_wall_delta_s != null && <span className="lbl" title="참고용">시뮬 시계 차 {st.sim_wall_delta_s.toFixed(1)} s</span>}
          <Chip {...lock} />
        </div>
      </Sheet>}
      {(notes.length > 0 || !!acts && acts.length > 0) && <div className="dv-act">
        {notes.map((t) => <p key={t} className="dv-note" role="status">{t}</p>)}
        {acts && acts.length > 0 && <div className="fh-row">{acts}</div>}
      </div>}
      {l.ask && mine && <div className="dv-ask" role="dialog" aria-labelledby="sim-ask-t" aria-live="assertive">
        <b id="sim-ask-t">조종권 요청</b><p>다른 사람이 이 시뮬 로봇의 조종권을 요청했습니다. 넘겨주시겠습니까?</p>
        <div className="fh-row"><button type="button" className="btn" onClick={() => sim.respond(true)}>넘기기</button><button type="button" className="btn" onClick={() => sim.respond(false)}>계속 조종</button></div></div>}
      {mine && open && <><Stick label="전후" vertical on={live} epoch={+live} gen={gen} set={(v) => put(0, v)} />
        <Stick label="회전" on={live} epoch={+live} gen={gen} set={(v) => put(1, v)} /></>}
    </div></div>
  </section>;
}
