// PC 웹 «시뮬» 탭(10 ADR-003 §1 결정 3·§7 ③④): 월드·시작 층 골라 띄우기 → 보기(«시뮬»·상태·위치·영상)·키보드 조종 → 끝내기.
// 띄우기·정리·직결·영상·조종권·잠금 해제·명령은 폰과 같은 phone.ts(sim)·SimLaunch 그대로 — 키보드는 sim.axes 에 넣기만 하고 속도는 phone.ts velocity 가 만든다.
// 키보드는 이 화면(시뮬 로봇 직결)에만 붙는다 — 실기 로봇 화면에는 없다(ADR-003 §4.2). «시뮬 정지»는 sim.stop()(폰 직결 STOP 과 같은 경로).
// 머리줄 STOP·Space 는 App(PR #94·#96 규칙 그대로) — 이 화면은 STOP 을 덮지 않는다.
import { useEffect, useRef, useState } from 'react';
import { allowed, runMoving, sim, useSim, velocity, type Sim } from '../phone';
import { runView, startBlock, startFloor, useScenarios } from '../run';
import { EXP, KEYS, STATE, SimLaunch, canDrive, field, forward, Video, blockNote, relink, remainingTime, short, stopText, timeNotice, useDeadline, useTick, worldName } from '../simdrive';
import { SimMap, useFloorMap, type FloorMap } from '../simmap';
import { needsRelink, useFeed } from '../media';
import { Cloud3D, QEmpty, Quad, type QTile } from '../quad';
import { Chip } from '../screens';
import type { SimRobot } from '../../../contracts/ts';
import type { Tone, User } from '../fake';

export function SimTab({ user, refresh }: { user: User; refresh: () => void }) {
  const s = useSim(), ids = s.mine.map((r) => r.robot_id).join();
  // 띄우기·끝내기로 내 시뮬 목록이 바뀌거나 다시 확정되면(끝내기는 blank() 로 listed=false → load() 로 true) 로봇 목록도 다시 받는다(머리줄 STOP 후보·로봇 탭에 바로 보이게)
  useEffect(() => { if (s.listed) refresh(); }, [ids, s.listed]);
  useEffect(() => { sim.pc(true); return () => sim.pc(false); }, []);   // 이 탭에서 받는 출입증은 surface: 'pc'
  // «시뮬 정지»는 띄우는 중·연결 중·끝내는 중·정리 확인 중에도(sim.live()) 늘 하나 — 조종 화면에서는 머리 카드 안, 그 밖에는 진행 칸 위
  return s.step === 'drive' && s.link && s.robot ? <SimView admin={user.role === 'ORG_ADMIN'} />
    : <>{sim.live() && <div className="fh-row" style={{ flexBasis: '100%', justifyContent: 'flex-end' }}><SimStop /></div>}<SimLaunch me={user.id} view /></>;
}

/** «시뮬 정지»: 실기 STOP(빨간 팔각·채움)과 다른 모양 — 주황 테두리 네모, 늘 보임. 동작은 STOP 과 같음(0 + 목표 취소 + 잠금, 자동 재개 없음 — 판정은 에이전트) */
function SimStop() {
  return <button type="button" className="btn" data-sim-stop-btn aria-label="시뮬 정지 — 이 시뮬 로봇만 멈춥니다"
    style={{ minWidth: 120, borderColor: 'var(--warn)', color: 'var(--warn)', background: 'var(--warn-bg)', borderWidth: 2, borderRadius: 4 }} onClick={() => sim.stop()}>
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" /><rect x="6" y="6" width="4" height="4" fill="currentColor" /></svg>시뮬 정지</button>;
}

/** 띄운 시뮬 보기 + 키보드 조종: 조종 시작(조종권) → 잠금 해제 → 키를 누르는 동안만 움직임. 키 뗌·창 초점 잃음·탭 숨김·연결 끊김·시뮬 정지 = 0(다시 누를 때까지 재개 없음) */
function SimView({ admin }: { admin: boolean }) {
  const s = useSim(), l = s.link!, r = s.robot!, st = l.st, w = l.welcome, open = l.at === 'open', mine = !!l.lease;
  const keys = w?.simulation === true, live = canDrive(), can = allowed(w);
  useDeadline(!!r.expires_at);
  useTick(true);
  const held = useRef(new Set<string>()), [out, setOut] = useState({ vx: 0, note: '' });
  useEffect(() => {
    const apply = () => {
      if (!canDrive()) held.current.clear();
      const a: [number, number, number] = [0, 0, 0], k = sim.get().link?.welcome;
      held.current.forEach((c) => { const [i, v] = KEYS[c]; a[i] = Math.max(-1, Math.min(1, a[i] + v)); });
      if (a[0] > 0 && k) a[0] = forward(k);
      sim.axes(a);
      const v = k ? velocity(a, k) : null;
      setOut({ vx: v?.vx ?? 0, note: blockNote(a, allowed(k ?? null), v) });
    };
    const down = (e: KeyboardEvent) => {
      if (held.current.size && (e.key === 'Meta' || e.key === 'Control' || e.key === 'Alt')) return zero();   // 단축키 시작 — macOS 는 Cmd 뒤 keyup 이 안 올 수 있음
      if (!(e.code in KEYS) || e.repeat || e.ctrlKey || e.metaKey || e.altKey || field(e.target) || !canDrive()) return;
      e.preventDefault(); held.current.add(e.code); apply();
    };
    const up = (e: KeyboardEvent) => { if (held.current.delete(e.code)) apply(); };
    const zero = () => { held.current.clear(); apply(); };
    const hide = () => { if (document.visibilityState === 'hidden') zero(); };
    addEventListener('keydown', down); addEventListener('keyup', up); addEventListener('blur', zero); document.addEventListener('visibilitychange', hide);
    return () => {
      removeEventListener('keydown', down); removeEventListener('keyup', up); removeEventListener('blur', zero); document.removeEventListener('visibilitychange', hide);
      held.current.clear(); sim.axes([0, 0]);
    };
  }, []);
  useEffect(() => { held.current.clear(); sim.axes([0, 0]); setOut({ vx: 0, note: '' }); }, [live]);   // 움직일 수 없게 되면(반납·잠금·끊김·정지) 누른 키를 버린다
  const floors = s.catalog?.worlds.find((x) => x.id === r.world_id)?.floors ?? [], fm = useFloorMap(st, r, floors), hasMap = floors.length > 0 || !!fm.ctx;
  const p = st?.pose, at = p && p.x != null && p.y != null ? `x ${p.x.toFixed(2)} m · y ${p.y.toFixed(2)} m` : '위치 확인 중';
  const lock: { tone: Tone; text: string } = !open ? { tone: 'bad', text: l.at === 'connecting' ? '연결 중' : '연결 끊김' } : !st ? { tone: 'off', text: '상태 확인 중' }
    : st.latched ? { tone: 'bad', text: '정지 잠금' } : !mine ? { tone: 'off', text: '보는 중' } : { tone: 'ok', text: '움직일 수 있음' };
  const wait = Math.max(0, Math.ceil((s.retryAt - performance.now()) / 1000));
  const run = runView(s, true), running = runMoving(l.run);
  const notes = [timeNotice(remainingTime(s.runtimeUntil)), l.at === 'closed' && l.why, l.notice, live && out.note, fm.notice, stopText(s)].filter(Boolean) as string[];
  const close = async () => { if (sim.get().link?.lease) await Promise.race([sim.release(), new Promise((f) => setTimeout(f, 2000))]); sim.reset(); };
  const key = (k: string, t: string, on = true) => <span className="lbl" data-key-off={on ? undefined : ''} style={on ? undefined : { textDecoration: 'line-through' }}><b className="mono">{k}</b> {t}{on ? '' : '(막힘)'}</span>;
  return <>
    <section className="lv-card" style={{ flexBasis: '100%', position: 'sticky', top: 0, zIndex: 1 }} aria-label="시뮬 로봇" data-sim-view>
      <div className="fh-row" style={{ flexWrap: 'wrap' }}>
        <h2>{short(r.robot_id)}</h2><Chip tone="off" text="시뮬" /><span className="lbl">{worldName(s, r.world_id)}</span>
        <span data-sim-state>{STATE[r.state]}</span><Chip {...lock} /><span className="mono" data-sim-pos>{at}</span>
        <span className="fh-grow" style={{ flex: 1 }} />
        {admin && <span className="lbl" data-sim-stop-same>머리줄 STOP 도 이 시뮬을 멈춥니다</span>}
        <SimStop />
      </div>
      {notes.map((t) => <p key={t} className="fh-why" role="status">{t}</p>)}
      {/* 실행 칸(03 §5.2): 상태·지점 n/m·진행 막대·[일시정지][취소] 한 줄 → 실행 안내 → 시나리오 고르기·실행 → 개발자 정보. 조종권 단추는 그 아래 */}
      <div style={{ border: '1px solid var(--line2)', borderRadius: 8, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }} aria-label="시나리오" data-run-box>
        {run.notes.length > 0 && <div className="fh-row" style={{ flexWrap: 'wrap' }}>
          <b role="status">{run.notes[0]}</b>{run.bar}
          {run.acts.length > 0 && <span className="fh-row" aria-label="시나리오 실행" data-run-acts>{run.acts}</span>}
        </div>}
        {run.notes.slice(1).map((t) => <p key={t} className="fh-why" role="status">{t}</p>)}
        <ScenarioPick s={s} r={r} />
        {run.dev}
      </div>
      <div className="fh-row" style={{ flexWrap: 'wrap' }}>
        {open && keys && !mine && <button type="button" className="btn pri" disabled={l.busy === 'take'} onClick={() => sim.take()}>조종 시작</button>}
        {open && keys && mine && st?.latched !== false && <button type="button" className="btn pri" disabled={l.busy === 'unlock'} onClick={() => sim.unlock()}>잠금 해제</button>}
        {open && mine && <button type="button" className="btn" disabled={l.busy === 'release'} onClick={() => sim.release()}>조종권 반납</button>}
        {l.at === 'closed' && l.code !== 403 && <button type="button" className="btn pri" disabled={!!wait} onClick={() => sim.connect()}>{wait ? `다시 연결(${wait}초 뒤)` : '다시 연결'}</button>}
        <button type="button" className="btn" onClick={() => sim.end()}>끝내기</button>
        <button type="button" className="btn" onClick={close}>보기 닫기</button>
        <span className="lbl">보기 닫기는 조종권을 반납하고 시뮬을 켠 채 둡니다.</span>
      </div>
      {l.ask && mine && <div className="fh-row" role="dialog" aria-label="조종권 요청"><span>다른 사람이 이 시뮬 로봇의 조종권을 요청했습니다.</span>
        <button type="button" className="btn" onClick={() => sim.respond(true)}>넘기기</button><button type="button" className="btn" onClick={() => sim.respond(false)}>계속 조종</button></div>}
      {keys && <div className="fh-row" style={{ flexWrap: 'wrap' }} aria-label="키보드 조종" data-sim-keys>
        <span>{running ? '실행 중 — 키 조종 막힘' : live ? '키를 누르는 동안만 움직입니다' : '조종 시작 → 잠금 해제 뒤 키보드로 움직입니다'}</span>
        {key('W/↑', '전진', !running)}{key('S/↓', '후진', can.back && !running)}{key('A/←·D/→', '회전', !running)}{key('Q/E', '옆걸음', (can.left || can.right) && !running)}{key('Space', '정지')}{/* Space = STOP — 실행 중에도 눌리므로 줄긋지 않는다 */}
        <span className="mono" data-sim-vx>{(live ? out.vx : 0).toFixed(2)} m/s</span>
        {can.experimental && <span className="lbl" data-sim-exp>{EXP}</span>}
        <span className="lbl" data-sim-tapnote>지도 찍어서 이동은 MuJoCo(«시뮬 열기») 만 — 이 시뮬은 키·시나리오로</span>
      </div>}
    </section>
    <SimQuad fm={fm} hasMap={hasMap} mine={mine} />
  </>;
}

/** 보기 4칸(10-26 사용자): RGB · 외부 카메라 · 지도(기존 지도 그림) · L1 3D 점군. 칸은 늘 넷 — 못 받는 칸은 이유만(가짜 그림 0).
 *  전체화면은 머리줄을 가리므로 그 안에 «시뮬 정지»(STOP 과 같은 sim.stop). 3D 끌기·지도 끌기는 그림만 — 키보드 주행(sim.axes)과 무관 */
function SimQuad({ fm, hasMap, mine }: { fm: FloorMap; hasMap: boolean; mine: boolean }) {
  const pts = useFeed('lidar', false), again = relink('rgb') || relink('external') || needsRelink(pts);   // lidar 받기는 Cloud3D 칸이 — 여기선 상태만 읽음(숨긴 칸이면 구독 해지)
  const tiles: QTile[] = [
    { id: 'rgb', label: 'RGB · 시뮬 카메라', body: () => <Video ch="rgb" /> },
    { id: 'external', label: '외부 카메라', body: () => <Video ch="external" /> },
    { id: 'map', label: '지도', body: (z) => hasMap ? <div data-sim-mapbox><SimMap m={fm} big={z === 'big'} /></div> : <QEmpty text="이 월드에는 지도가 없습니다" /> },
    { id: 'lidar', label: '3D 점군 · L1 센서 기준 1스캔', body: (z) => <Cloud3D small={z === 'thumb'} big={z === 'big'} /> },
  ];
  return <section className="dv" style={{ flexBasis: '100%' }} aria-label="보기" data-sim-quad>
    <Quad label="시뮬 보기 4칸" tiles={tiles} fs={<SimStop />}
      top={again && (mine ? <span className="lbl" data-media-again>영상을 다시 받으려면 조종권을 반납한 뒤 «영상 다시 받기»를 누르세요.</span>
        : <button type="button" className="btn" data-media-again onClick={() => sim.connect()}>영상 다시 받기(다시 연결)</button>)} />
  </section>;
}

/** 시나리오 고르기 + «실행»(폰 시나리오 띠와 같은 조건 — run.tsx startBlock). 이 월드 지도를 지나는 시나리오만 */
function ScenarioPick({ s, r }: { s: Sim; r: SimRobot }) {
  const world = s.catalog?.worlds.find((w) => w.id === r.world_id), floors = world?.floors ?? [];
  const { list, retry } = useScenarios(floors, !!world?.map_id), [pick, setPick] = useState('');
  if (!world?.map_id) return <p className="lbl" data-sim-scn>이 월드에 묶인 지도가 없어 시나리오가 없습니다.</p>;
  if (list === 'wait') return <p className="lbl" data-sim-scn>시나리오를 불러오는 중…</p>;
  if (list === 'fail') return <div className="fh-row" data-sim-scn><span className="fh-why">시나리오 목록을 받지 못했습니다.</span><button type="button" className="btn" onClick={retry}>다시</button></div>;
  if (!list.length) return <p className="lbl" data-sim-scn>이 지도에 시나리오가 없습니다.</p>;
  const picked = list.find((x) => x.id === pick), block = startBlock(s, picked, floors);
  return <div className="fh-row" style={{ flexWrap: 'wrap' }} data-sim-scn>
    <label className="fh-row"><span>시나리오</span><select className="fh-user fh-sel" value={pick} onChange={(e) => setPick(e.target.value)}>
      <option value="">고르기</option>{list.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
    <button type="button" className="btn pri" disabled={!picked || !!block || s.link?.busy === 'run'} aria-describedby="sim-scn-why"
      onClick={() => picked && sim.runStart(picked, startFloor(picked, floors))}>실행</button>
    {/* Nav2 없음은 위 안내 줄(l.notice)이 이미 말하면 여기서 다시 쓰지 않는다 */}
    <span id="sim-scn-why" className="lbl" role="status">{s.link?.navOff && s.link.notice ? '' : picked ? block || '«실행»을 누르면 고른 시나리오를 시작합니다.' : '실행할 시나리오를 고르세요.'}</span>
  </div>;
}
