// 시뮬 로봇 띄우기 → 지도(월드) 고르기 → 직결 조종 → 끝내기(09 ADR-002 §3.2·§6). 상태·요청은 phone.ts, 이 파일은 그림만.
import { useEffect, useRef, useState } from 'react';
import type { SimRobot } from '../../contracts/ts';
import { DEAD, RUN_END, allowed, runMoving, sim, useSim, velocity, type Sim } from './phone';
import { runView, startBlock, startFloor, useScenarios } from './run';
import { Sheet, Stick } from './drive';
import { Chip } from './screens';
import { simName, type Tone } from './fake';
import { SimMap, useFloorMap } from './simmap';

/** on 인 동안 1 s 마다 다시 그림(경과·남은 시간) */
export function useTick(on: boolean) {
  const [, t] = useState(0);
  useEffect(() => { if (!on) return; const i = setInterval(() => t((n) => n + 1), 1000); return () => clearInterval(i); }, [on]);
}
export function useDeadline(on: boolean) {
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
export const short = (id: string) => simName(id, [id]);   // 16진 id 는 본문에 쓰지 않는다(U5)
/** 월드 이름(목록에 없으면 «월드») — 월드 내부 id 는 본문에 쓰지 않는다 */
export const worldName = (s: Sim, id: string) => s.catalog?.worlds.find((w) => w.id === id)?.name ?? '월드';
/** 화살표(100 판): 허용 안 된 방향은 흐리게(data-off) */
const ARROW = { up: 'M43 13l7-6 7 6', down: 'M43 87l7 6 7-6', left: 'M13 43l-6 7 6 7', right: 'M87 43l6 7-6 7' };
function Arrows({ on }: { on: Partial<Record<keyof typeof ARROW, boolean>> }) {
  return <svg className="dv-arrows" viewBox="0 0 100 100" aria-hidden="true">
    {(Object.keys(on) as (keyof typeof ARROW)[]).map((k) => <path key={k} d={ARROW[k]} data-arrow={k} data-off={on[k] ? undefined : ''} />)}
  </svg>;
}
/** 막힌 동작 이름(«…은 아직 지원하지 않습니다» 앞) */
const blockedNames = (a: ReturnType<typeof allowed>) => [!a.back && '후진', !(a.left || a.right) && '옆걸음', !a.spin && '제자리 회전'].filter(Boolean).join('·');
/** 막힌 방향 입력 안내(limits 가 0 으로 자른 이유 — 자르기는 phone.ts velocity). 폰 조이스틱·PC 키보드가 같이 쓴다 */
export function blockNote([f, t, y]: [number, number, number], can: ReturnType<typeof allowed>, out: { vx: number; vy: number } | null) {
  return f < -DEAD && !can.back ? '후진은 아직 지원하지 않습니다 — 시뮬에서 아직 확인 안 됨'
    : (y > DEAD && !can.left) || (y < -DEAD && !can.right) ? '옆걸음은 아직 지원하지 않습니다 — 시뮬에서 아직 확인 안 됨'
    : t !== 0 && !can.spin && (!out || (out.vx === 0 && out.vy === 0)) ? SPIN : '';
}
export const STATE: Record<SimRobot['state'], string> = { STARTING: '띄우는 중', PREPARED: '가짜 기동(연결할 로봇 없음)', RUNNING: '실행 중', STOPPING: '정리 중', ERROR: '오류' };

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

/** 잠금 사유 OUTPUT_STALLED(에이전트 출력 지연 → 0·STOP·잠금) 안내. 해제 판정은 에이전트 몫이라 단추 동작은 그대로 */
export const STALLED = '출력이 늦어져 로봇을 멈췄습니다 — 다시 잠금 해제하면 이어집니다.';

/** 로봇 연결 화면 아래 칸: 월드 고르기·띄우기·진행·확인 중. view = PC «시뮬» 탭(조종 없이 보기만 — 단추 이름만 다름) */
export function SimLaunch({ me, view }: { me: string; view?: boolean }) {
  const s = useSim(), [pick, setPick] = useState(''), [spawn, setSpawn] = useState<'l1' | 'l2'>('l1');
  useDeadline(!!s.robot?.expires_at);
  useEffect(() => { if (s.step === 'pick') sim.load(); }, []);
  useTick(s.step === 'starting');
  const worlds = s.catalog?.worlds ?? [], world = worlds.some((w) => w.id === pick) ? pick : worlds[0]?.id ?? '';
  // 시작 층: 고른 월드가 두 층 이상에서 띄울 수 있을 때만(하나뿐이면 표시·전송 0)
  const w0 = worlds.find((w) => w.id === world), spawns = w0?.spawn_floor_ids ?? [], from = spawns.length > 1 ? spawns.includes(spawn) ? spawn : spawns[0] : undefined;
  const floorName = (f: 'l1' | 'l2') => w0?.floors?.find((x) => x.ros_floor_id === f)?.name ?? (f === 'l1' ? '1층' : '2층');
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
        <div className="fh-row">{l.code !== 403 && <button type="button" className="btn pri" disabled={!!wait} onClick={() => sim.connect()}>{wait ? `다시 연결(${wait}초 뒤)` : '다시 연결'}</button>}<button type="button" className="btn" onClick={() => sim.end()}>끝내기</button></div></>
    : <p className="lv-note" role="status" data-sim="linking">출입증을 받아 {s.robot && short(s.robot.robot_id)} 에 직접 연결하는 중입니다…</p>;
  else if (s.step === 'ending') body = <p className="lv-note" role="status" data-sim="ending">조종권을 반납하고 시뮬 로봇을 정리하는 중입니다…</p>;
  else if (s.step === 'checking') body = <><p className="fh-why" role="status" data-sim="checking">확인 중 — {s.err} {s.listed && s.robot && (s.mine.some((r) => r.robot_id === s.robot!.robot_id) ? '목록에 아직 있습니다.' : '목록에는 없지만 정리됐다고 단정할 수 없습니다.')}</p>
    <div className="fh-row"><button type="button" className="btn pri" onClick={() => sim.end()}>다시 끝내기</button><button type="button" className="btn" onClick={() => sim.load()}>다시 확인</button><button type="button" className="btn" onClick={() => sim.reset()}>처음으로</button></div></>;
  else body = <>
    {resume && <button type="button" className="btn pri dv-resume" data-sim-resume onClick={() => sim.attach(resume)}>{view ? '보기 화면 띄우기' : '조종 화면 띄우기'}</button>}
    {cleanup.length > 0 && <ul className="dv-cards" aria-label="정리할 내 시뮬 자리">{cleanup.map((r) => <li key={r.robot_id} className="card dv-card">
      <b>{short(r.robot_id)}</b><p className="fh-why">{s.managerError ? '관리자가 내 시뮬 자리를 확인하지 못했습니다.' : '이전 시뮬이 정리되지 않았습니다.'}</p>
      {!r.can_recover && <p className="fh-why">이 시뮬 자리는 자동 정리할 수 없습니다 — 관리자에게 문의하세요.</p>}
      <button type="button" className="btn" onClick={() => sim.cleanupSlot(r)}>정리</button></li>)}</ul>}
    {s.mine.length > 0 && <ul className="dv-cards" aria-label="내 시뮬 로봇">{s.mine.map((r) => <li key={r.robot_id} className="card dv-card">
      <div className="fh-row"><b>{short(r.robot_id)}</b><Chip tone="off" text="시뮬" /><span className="lbl">{worldName(s, r.world_id)} · {STATE[r.state]}</span></div>
      <div className="fh-row">{r !== resume && <button type="button" className="btn pri" onClick={() => sim.attach(r)}>{view ? '보기' : '직접 연결'}</button>}<button type="button" className="btn" onClick={() => sim.end(r)}>{r.state === 'ERROR' ? '정리' : '끝내기'}</button></div></li>)}</ul>}
    {s.catalog && (worlds.length ? <fieldset className="fh-field" style={{ border: 0, padding: 0, margin: 0 }}><legend>지도(월드)</legend>
      <ul className="fh-list" aria-label="월드 목록">{worlds.map((w) => <li key={w.id}><label className="fh-row">
        <input type="radio" name="sim-world" value={w.id} checked={w.id === world} onChange={() => setPick(w.id)} />
        <span><b>{w.name}</b>{w.description && <><br /><small className="lbl">{w.description}</small></>}</span></label></li>)}</ul></fieldset>
      : <p className="lv-note">고를 수 있는 월드가 없습니다.</p>)}
    {from && <fieldset className="fh-field" style={{ border: 0, padding: 0, margin: 0 }} data-sim-spawn><legend>시작 층</legend>
      <div className="fh-row">{spawns.map((f) => <label key={f} className="fh-row dv-spawn">
        <input type="radio" name="sim-spawn" value={f} checked={f === from} onChange={() => setSpawn(f)} /><span>{floorName(f)}</span></label>)}</div></fieldset>}
    <button type="button" className="btn pri" disabled={!world || s.mine.length > 0 || cleanup.length > 0} aria-describedby={s.mine.length ? 'sim-one' : undefined} onClick={() => sim.start(world, me, from)}>띄우기</button>
    {s.mine.length > 0 && <span id="sim-one" className="fh-why">시뮬 로봇은 한 사람에 한 대입니다. 위 로봇에 연결하거나 끝낸 뒤 띄우세요.</span>}</>;
  return <section className="lv-card" style={{ flexBasis: '100%' }} aria-label="시뮬 로봇 띄우기">
    <h2>시뮬 로봇 띄우기</h2>
    {body}
    {s.step !== 'unsure' && s.step !== 'checking' && msg}
    {stop && <p className="fh-why" role="status" data-sim-stop>{stop}</p>}
  </section>;
}

export const CAM = { wait: '영상 기다리는 중', none: '영상 없음 — 로봇이 영상을 보내지 않습니다', lost: '영상 연결이 끊겼습니다. 조종·STOP 에는 영향이 없습니다', off: '이 로봇은 영상을 보내지 않습니다', frame: '' };

const I = (d: JSX.Element) => <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">{d}</svg>;
const ICON = {
  set: I(<path d="M4 7h10M18 7h2M4 17h4M12 17h8M16 5v4M10 15v4" />),
  info: I(<><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7v1" /></>),
  back: I(<path strokeLinecap="round" strokeLinejoin="round" d="M15 5l-7 7 7 7" />),
  route: I(<><circle cx="6" cy="18" r="2" /><circle cx="18" cy="6" r="2" /><path d="M8 18h6a3 3 0 0 0 0-6h-4a3 3 0 0 1 0-6h6" /></>),
  flag: I(<path strokeLinejoin="round" d="M6 21V4M6 4h11l-2.5 4 2.5 4H6" />),
  grid: I(<><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.5" /></>),
  map: I(<path strokeLinejoin="round" d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2zM9 4v14M15 6v14" />),
  close: I(<path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />),
  end: I(<><rect x="5" y="5" width="14" height="14" rx="2" /><path d="M9 9l6 6M15 9l-6 6" /></>),
};

/** 아래 단추 하나 → 가로 띠: 이 시뮬 월드에 묶인 지도(world.map_id 의 층)를 지나는 시나리오. «실행»은 에이전트가 실행 능력을 알리고 시작 조건이 맞을 때만(run.tsx startBlock) */
function ScenarioBar({ s, r, started }: { s: Sim; r: SimRobot; started: () => void }) {
  const world = s.catalog?.worlds.find((w) => w.id === r.world_id), floors = world?.floors ?? [];
  const { list, retry } = useScenarios(floors, !!world?.map_id), [pick, setPick] = useState('');
  const picked = Array.isArray(list) ? list.find((x) => x.id === pick) : undefined, block = startBlock(s, picked, floors);
  const note = !world?.map_id ? '이 월드에 묶인 지도가 없어 시나리오가 없습니다.' : list === 'wait' ? '시나리오를 불러오는 중…'
    : list === 'fail' ? '시나리오 목록을 받지 못했습니다.' : !list.length ? '이 지도에 시나리오가 없습니다.' : picked ? block || '«실행»을 누르면 고른 시나리오를 시작합니다.' : '실행할 시나리오를 고르세요.';
  return <div className="dv-strip" role="group" aria-label="시나리오 목록" data-sim-scn>
    <p className="dv-note" id="sim-scn-note" role="status">{note}</p>
    {(Array.isArray(list) && list.length > 0 || list === 'fail') && <div className="dv-strip-row">
      {list === 'fail' ? <button type="button" className="btn" onClick={retry}>다시</button> : <>
        <ul>{list.map((x) => <li key={x.id}><button type="button" className="btn" aria-pressed={x.id === pick} onClick={() => setPick(x.id)}>
          {ICON.flag}<span>{x.name}</span>{x.id === pick && <b>고름</b>}</button></li>)}</ul>
        {picked && <button type="button" className="btn pri" disabled={!!block || s.link?.busy === 'run'} aria-describedby="sim-scn-note"
          onClick={() => { sim.runStart(picked, startFloor(picked, floors)); started(); }}>실행</button>}</>}
    </div>}
  </div>;
}

export const EXP = '시뮬 시험용 — 후진·옆걸음·제자리 회전은 넘어질 수 있습니다';
const SPIN = '제자리 회전 — 시뮬에서 아직 확인 안 됨. 앞으로 밀면서 돌리세요.';
/** 직결 조종 화면(10-26 사용자 «쓸데없는 거 다 빼줘» — 참고 Unitree 앱 구도): 영상이 화면 전체(cover). 영상 위에는 왼쪽 위 «<»(나가기), 위 가운데 상태 알약 하나,
 *  오른쪽 위 STOP(App 머리줄 — 시뮬 조종 중에는 STOP 만 남아 영상 위에 뜬다, 메뉴·띠·시트가 덮지 못함), 아래 두 구석 조이스틱, 왼쪽 조이스틱 옆 메뉴 단추 하나
 *  (시나리오 띠·작은 지도 켜고 끄기(기본 꺼짐)·설정·정보·시뮬 끝내기·시험용 안내), 안내·단추는 카드 한 장(첫 줄 = 사유, 실행 다음 행동 줄은 그 아래 — 닫으면 글이 사라지고 단추는 남음).
 *  메뉴·띠가 열려 있거나 나가는 중이면 입력 0 */
export function SimDrive() {
  const s = useSim(), l = s.link!, r = s.robot!, st = l.st, w = l.welcome;
  useDeadline(!!r.expires_at);
  const open = l.at === 'open', mine = !!l.lease, ready = open && mine && st?.latched === false;
  const input = useRef<[number, number, number]>([0, 0, 0]), gen = useRef(0);   // [전후, 회전, 옆]
  const [unsupported, setUnsupported] = useState(''), [vx, setVx] = useState(0);
  const [menu, setMenu] = useState<'' | 'menu' | 'set' | 'info'>(''), [bar, setBar] = useState(false), [leaving, setLeaving] = useState<'' | 'wait' | 'fail'>('');
  // 작은 지도(메뉴에서 켬, 기본 꺼짐 — 오른쪽 위 STOP 아래): 누르면 지도 크게 ↔ 영상 크게(실기 화면 dv-mini 와 같음 — 입력·조이스틱은 그대로)
  const floors = s.catalog?.worlds.find((x) => x.id === r.world_id)?.floors ?? [], fm = useFloorMap(st, r, floors);
  const [big, setBig] = useState(false), [mini, setMini] = useState(false), [shut, setShut] = useState<string[]>([]), hasMap = floors.length > 0 || !!fm.ctx;
  const run = runView(s), moving = runMoving(l.run);   // 실행이 움직이는 중이면 조이스틱 입력 0(수동 조종 거부 — 일시정지 뒤 전환)
  const live = ready && !menu && !bar && !leaving && !moving;
  const smooth = w?.limits.vx_mode === 'continuous', can = allowed(w), blocked = blockedNames(can);
  useTick(true);
  // 명령 범위 조정: 새로 잘릴 때 3 s 만 한 줄로(계속 잘려도 영상 가운데를 덮어 두지 않음). 범위 숫자는 설정 시트
  const [clipUntil, setClipUntil] = useState(0), clipNote = l.clipped && performance.now() < clipUntil;
  useEffect(() => { if (l.clipped) setClipUntil(performance.now() + 3000); }, [l.clipped]);
  useEffect(() => () => sim.axes([0, 0]), []);
  useEffect(() => { input.current = [0, 0, 0]; sim.axes([0, 0]); setUnsupported(''); setVx(0); }, [live]);
  /** 왼쪽 = 전후·옆, 오른쪽 = 회전. 막힌 방향은 limits 가 0 으로 자르고(phone.ts) 여기서는 이유만 안내 */
  const put = (i: 0 | 1 | 2, v: number) => {
    input.current[i] = v;
    const [f, t, y] = input.current, out = w && velocity([f, t, y], w);
    setUnsupported(blockNote([f, t, y], can, out));
    if (out) setVx(out.vx);
    sim.axes([f, t, y]);
  };
  /** 나가기: 0 → 조종권 반납(답 2 s 까지) → 확인된 반납만 연결 닫고 띄우기 카드로. 시뮬은 켠 채(«조종 화면 띄우기»로 다시 들어옴).
   *  거절·무응답이면 조종 화면에 남는다(연결·STOP 대상 보존, 입력 0, «다시 반납») */
  const leave = async () => {
    setMenu(''); setBar(false); setLeaving('wait');
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
  // OUTPUT_STALLED·시나리오 실행 안내가 뜰 때는 영상 자리 문구를 숨긴다(아래 안내 칸과 겹침). 실제 영상 장애(lost·none)는 안내 줄 아래로 옮겨 계속 보인다
  const stalled = open && !!st?.latched && st.safety_reason === 'OUTPUT_STALLED', hideCam = stalled || run.notes.length > 0;
  const notes = [   // 카드 첫 줄 = 맨 앞(안전·연결 먼저)
    stop,
    stalled && STALLED,
    leaving === 'wait' && '조종권을 반납하고 나가는 중입니다…',
    leaving === 'fail' && '조종권 반납을 확인하지 못했습니다 — 입력은 0 입니다. 다시 반납하거나 STOP 을 누르세요.',
    l.at === 'closed' && l.why,
    ...run.notes,
    r.state === 'STOPPING' && '시뮬을 정리하는 중…',
    r.state === 'STARTING' && '시뮬을 띄우는 중…',
    timeNotice(runtimeLeft),
    l.notice,
    unsupported,
    fm.notice,
    !unsupported && mine && clipNote && `명령 범위 조정 — 허용 범위로 잘랐습니다.${smooth || !can.spin ? '' : ' 끝까지 밀어야 움직입니다.'}`,
    open && left < 60 && (moving ? `출입증 ${Math.max(0, left)}초 남음 — 만료되면 실행이 일시정지됩니다. 다시 연결한 뒤 이 화면에서 «이어서»를 누르세요.`
      : `출입증 ${Math.max(0, left)}초 남음 — 만료되면 로봇이 멈추고 조종권이 비워집니다. 새 출입증으로 다시 연결하세요.`),
    hideCam && (l.cam === 'lost' || l.cam === 'none') && CAM[l.cam],
  ].filter(Boolean) as string[];
  const said = notes.length > 0 && notes.every((t) => shut.includes(t));   // 닫을 때 보이던 안내뿐이면 숨김(새 안내가 하나라도 생기면 다시 보임)
  const acts = leaving ? leaving === 'fail' && [
    <button key="rel" type="button" className="btn pri" onClick={leave}>다시 반납</button>,
    l.at === 'closed' && <button key="re" type="button" className="btn" disabled={!!wait} onClick={() => sim.connect()}>{wait ? `다시 연결(${wait}초 뒤)` : '다시 연결'}</button>,
  ].filter(Boolean) : [
    open && !mine && <button key="take" type="button" className="btn pri" disabled={l.busy === 'take'} onClick={() => sim.take()}>조종 시작</button>,
    open && mine && st?.latched !== false && <button key="unlock" type="button" className="btn pri" disabled={l.busy === 'unlock'} onClick={() => sim.unlock()}>잠금 해제</button>,
    l.at === 'closed' && <button key="re" type="button" className="btn pri" disabled={!!wait} onClick={() => sim.connect()}>{wait ? `다시 연결(${wait}초 뒤)` : '다시 연결'}</button>,
    open && left < 60 && <button key="pass" type="button" className="btn" onClick={() => sim.connect()}>{moving ? '새 출입증으로 다시 연결(실행 일시정지)' : '새 출입증으로 다시 연결'}</button>,
    ...run.acts,
  ].filter(Boolean);
  const range = w && `로봇 허용 범위(앞 ${w.limits.vx_max.toFixed(2)} m/s${can.back ? `, 뒤 ${(-w.limits.vx_min).toFixed(2)} m/s` : ''}${can.left || can.right ? `, 옆 ±${w.limits.vy_max} m/s` : ''}, 회전 ±${w.limits.wz_max} rad/s) 밖은 잘라 보냅니다.${!can.spin ? ' 제자리 회전은 앞으로 밀면서 돌리세요.' : ''}`;
  // 알약 하나: 정상이면 «시뮬 · 속도», 잠금·연결·보기는 그 말, 시나리오 실행 중이면 «실행 2/3»(잠금·끊김이 먼저)
  const rr = l.run && !RUN_END.includes(l.run.status) ? l.run : null, total = rr?.progress.total ?? 0;
  const state = r.state !== 'RUNNING' ? STATE[r.state] : lock.tone !== 'ok' ? lock.text
    : rr ? rr.status === 'PAUSED' ? '실행 일시정지' : total ? `실행 ${Math.min(rr.step + 1, total)}/${total}` : '실행 준비' : '';
  const toggle = () => { if (menu || bar) { setMenu(''); setBar(false); } else setMenu('menu'); };
  const video = (small: boolean) => l.cam === 'frame' ? <img className="dv-video" draggable={false} src={l.img} alt="RGB 영상" style={{ width: '100%', height: '100%', objectFit: small ? 'contain' : 'cover' }} />
    : <div className="dv-video" role="img" aria-label="RGB 영상">{!small && !hideCam && <span>{CAM[l.cam]}</span>}</div>;
  return <section className="dv ph" style={{ flexBasis: '100%' }} aria-label="조종" data-sim-drive onContextMenu={(e) => e.preventDefault()}>
    <div className="dv-body"><div className="dv-stage rgb">
      {big && hasMap && mini ? <SimMap m={fm} big /> : video(false)}
      <div className="dv-safe">
      {hasMap && mini && <button type="button" className="dv-mini" aria-label={big ? '영상 크게' : '지도 크게'} data-sim-mini onClick={() => setBig(!big)}>{big ? video(true) : <SimMap m={fm} />}</button>}
      <button type="button" className="dv-gear dv-leave" aria-label="나가기" disabled={leaving === 'wait'} data-sim-leave onClick={leave}>{ICON.back}</button>
      <div className="dv-top" aria-label="상태" data-tone={r.state === 'RUNNING' ? lock.tone : 'off'} data-sim-pill>
        시뮬 · {state && <>{state} · </>}<span className="mono" data-sim-vx>{(live ? vx : 0).toFixed(2)} m/s</span>
      </div>
      <button type="button" className="dv-menu-btn" aria-label="메뉴" aria-expanded={!!menu || bar} data-sim-menu onClick={toggle}>{ICON.grid}</button>
      {menu === 'menu' && <div className="dv-menu" role="group" aria-label="메뉴 항목">
        {can.experimental && <p className="dv-exp" role="note" aria-label={EXP} data-sim-exp>시험용 · 넘어질 수 있음</p>}
        <button type="button" className="btn" aria-label="시나리오" data-sim-scn-btn onClick={() => { setMenu(''); setBar(true); }}>{ICON.route}<span>시나리오</span></button>
        {hasMap && <button type="button" className="btn" aria-pressed={mini} data-sim-map-toggle onClick={() => { setMenu(''); setMini(!mini); setBig(false); }}>{ICON.map}<span>{mini ? '지도 끄기' : '지도 보기'}</span></button>}
        <button type="button" className="btn" onClick={() => setMenu('set')}>{ICON.set}<span>설정</span></button>
        <button type="button" className="btn" onClick={() => setMenu('info')}>{ICON.info}<span>정보</span></button>
        <button type="button" className="btn" data-sim-end onClick={() => { setMenu(''); sim.end(); }}>{ICON.end}<span>시뮬 끝내기</span></button>
      </div>}
      {bar && <ScenarioBar s={s} r={r} started={() => setBar(false)} />}
      {menu === 'set' && <Sheet title="설정" close={() => setMenu('')}>
        {smooth ? <p className="dv-note">시뮬 전용 · 멈출 때 가끔 넘어질 수 있음(측정 34회 중 3회){blocked && ` · ${blocked}은 아직 지원하지 않습니다`}</p> : <>
        <div className="fh-row" role="group" aria-label="속도 단계" aria-describedby="sim-speed-note">
          <button type="button" className="btn" disabled aria-pressed={false}>느림</button>
          <button type="button" className="btn pri" aria-pressed={true}>보통 · 0.6 m/s</button>
          <button type="button" className="btn" disabled aria-pressed={false}>빠름</button>
        </div>
        <p id="sim-speed-note" className="dv-note">느림·빠름{blocked && `·${blocked}`}: 시뮬에서 아직 확인 안 됨</p></>}
        {can.experimental && <p className="dv-note">{EXP}</p>}
        {range && <p className="dv-note" data-sim-range>{range}</p>}
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
        {run.dev}
      </Sheet>}
      {(notes.length > 0 && !said || !!acts && acts.length > 0) && <div className="dv-act" data-sim-card data-bare={said || notes.length === 0 || undefined}>
        {notes.length > 0 && !said && <div className="dv-act-head"><div className="dv-act-t">{notes.map((t) => <p key={t} className="dv-note" role="status">{t}</p>)}</div>
          <button type="button" className="dv-x" aria-label="안내 닫기" data-sim-card-close onClick={() => setShut(notes)}>{ICON.close}</button></div>}
        {acts && acts.length > 0 && <div className="fh-row">{acts}</div>}
      </div>}
      {l.ask && mine && <div className="dv-ask" role="dialog" aria-labelledby="sim-ask-t" aria-live="assertive">
        <b id="sim-ask-t">조종권 요청</b><p>다른 사람이 이 시뮬 로봇의 조종권을 요청했습니다. 넘겨주시겠습니까?</p>
        <div className="fh-row"><button type="button" className="btn" onClick={() => sim.respond(true)}>넘기기</button><button type="button" className="btn" onClick={() => sim.respond(false)}>계속 조종</button></div></div>}
      {mine && open && <><Stick label="전후" both on={live} epoch={+live} gen={gen} set={(v, y) => { put(2, y); put(0, v); }}>
          <Arrows on={{ up: true, down: can.back, left: can.left, right: can.right }} /></Stick>
        <Stick label="회전" on={live} epoch={+live} gen={gen} set={(v) => put(1, v)}><Arrows on={{ left: true, right: true }} /></Stick></>}
      </div>
    </div></div>
  </section>;
}
