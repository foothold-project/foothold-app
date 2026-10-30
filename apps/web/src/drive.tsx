// 폰 조종(09 ADR-002 §3 — 02 기능 F-TO-01~05, 03 UX §5.7): 로봇 연결 → 조종(가로, 카메라 전체·양쪽 조이스틱·아래 줄 시트).
// 조종권·잠금·STOP 은 실시간 연결(rt.ts → 관제 서버)만 부른다 — 판정은 서버 중재기. 시뮬 로봇은 폰 ↔ 에이전트 직결(phone.ts·simdrive.tsx).
// 영상·지도·시나리오 제어는 자리만(가짜). 키보드: W·↑ 전진, A·← / D·→ 회전, S·↓ 후진 막음. Space = STOP 은 App 공통 층(모든 화면).
import { useEffect, useRef, useState, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import { ADMIN_REAL, ROLE_NAME, driveBlock, robotStatus, type Holder, type Robot, type Role, type Tone } from './fake';
import { CMD_MS, rt, useLive, useRt, type Live } from './rt';
import { PHONE_SHEETS, type SheetId } from './menu';
import { Chip, DriveButton, Scenario, inApp, soon, type Ctx } from './screens';
import { Nearby } from './nearby';
import { useSim } from './phone';
import { STALLED, SimLaunch } from './simdrive';
import './drive.css';

type Axes = [number, number];   // [전후, 회전] 각 -1..1. 회전 + = 왼쪽
/** 남은 시간을 그리려고 on 인 동안 0.2 s 마다 다시 그림. 시각은 단조 시계 */
function useNow(on: boolean) {
  const [, tick] = useState(0);
  useEffect(() => { if (!on) return; const i = setInterval(() => tick((n) => n + 1), 200); return () => clearInterval(i); }, [on]);
  return rt.now();
}
const secs = (until: number, now: number) => Math.max(0, Math.ceil((until - now) / 1000));
const pct = (b: number | null) => (b == null ? '' : `${b}%`);
const clamp = (v: number) => Math.max(-1, Math.min(1, v));
/** 조종권 요청 창 단추는 마우스·터치로만(F-TO-04 규칙 4): 키보드로 생긴 click 은 detail 0 */
const pointerOnly = (f: () => void) => (e: MouseEvent) => { if (e.detail > 0) f(); };

function who(h: Holder | null, me: string) {
  if (!h) return '조종하는 사람 없음';
  if (h.type === 'RUN') return '시나리오 실행 중';
  return h.id === me ? '다른 창에서 조종 중(나)' : `${h.name}님 조종 중`;
}
/** 구독 안 하는 로봇은 목록 요약의 조종권자 + 받은 시각. 목록의 null 은 «없음»으로 단정하지 않는다(서버 목록 lease 가 아직 늘 null) */
export function holderText(l: Live, me: string, r: Robot) {
  if (r.unknown === 'summary') return r.holder ? `${who(r.holder, me)}(목록 ${r.listedAt})` : '조종권자 확인 안 됨';
  if (l.lease) return '조종 중(나)';
  if (l.releasing) return '이 창 — 반납 확인 중';
  if (l.busy) return '조종권 넘기는 중';
  if (r.unknown && !l.holder) return '조종권자 확인 안 됨';   // 연결 끊김(4403 포함)·첫 state 전: 비어 있는지 모름
  return who(l.holder, me);
}
function lockChip(l: Live, r: Robot): { tone: Tone; text: string } {
  if (r.unknown === 'summary') return { tone: 'off', text: '확인 안 됨' };
  if (l.failed) return { tone: 'bad', text: '정지 확인 실패' };
  if (l.busy) return { tone: 'warn', text: '정지 확인 중' };
  if (!l.state || l.state.connection !== 'ONLINE') return { tone: 'off', text: '상태 모름' };
  if (l.state.latched !== false) return { tone: 'bad', text: '정지 잠금' };
  if (!l.lease) return { tone: 'off', text: '보는 중' };
  return l.neutral ? { tone: 'ok', text: '움직일 수 있음' } : { tone: 'warn', text: '중립 확인 중' };
}
const BUSY_TEXT = { take: '로봇 정지를 확인한 뒤 조종권을 받습니다.', give: '조종권을 넘기는 중입니다. 로봇 정지를 확인하고 있습니다.' };

/** 끝내기(머리줄·조종 판 같은 길): 입력 0 → 조종권 반납(확인은 rt releasing, 확인되면 App 이 로봇 연결로). 조종권이 없으면 바로 로봇 연결 */
export function endDrive(id: string, go: Ctx['go']) {
  const l = rt.get(id);
  if (l.releasing) return;
  rt.cmd(id, [0, 0]);
  if (l.lease) rt.release(id); else go('drive');
}
const RELEASING = '조종권 반납을 확인하는 중입니다. 확인되면 다시 누르세요.';

export function Drive(c: Ctx) {
  return c.open ? <Screen {...c} /> : <Connect {...c} />;
}

/** 로봇 연결(ADR-002 §3.2): 위 = 내 로봇 목록 → [연결](조종 화면), 못 하면 [보기만] + 이유. 아래 = 시뮬 로봇 띄우기(simdrive.tsx — 직결)
 *  «+ 로봇 연결하기»(10-28): 앱 안에서 연결된 실기가 없으면 목록 위에 크게(목록·오프라인 이유·반납 실패 줄은 그대로), 있으면 목록 아래 작게 → 주변 로봇 찾기(nearby.tsx). 앱 밖은 못 하는 이유만 */
export function Connect(c: Pick<Ctx, 'user' | 'robots' | 'go'>) {
  useRt();
  const s = useSim(), [find, setFind] = useState(false), app = inApp(), live = c.robots.some((r) => !r.sim && (r.online || !!r.unknown));   // 상태 모름(실시간 끊김·첫 상태 전)은 «연결 없음»으로 단정하지 않는다 — 깜빡임 방지
  const add = (pri: boolean) => <button type="button" className={`btn${pri ? ' pri' : ''}`} onClick={() => setFind(true)} data-robot-connect>+ 로봇 연결하기</button>;
  return <>
    {find || (s.real && s.step !== 'drive') ? <Nearby robots={c.robots} close={() => setFind(false)} /> : <section className="lv-card" style={{ flexBasis: '100%' }} aria-label="내 로봇">
      <h2>내 로봇</h2>
      {app && !live && add(true)}
      {c.robots.length ? <ul className="dv-cards">{c.robots.map((r) => <Card key={r.id} c={c} r={r} />)}</ul>
        : <p className="lv-note">{c.user.role === 'ORG_ADMIN' ? `${ADMIN_REAL} 시뮬 로봇은 아래 «시뮬 로봇 띄우기»에서 조종합니다.` : '담당 로봇이 없습니다. 총괄 운영 관리자에게 로봇 배정을 요청하세요.'}</p>}
      {app ? live && add(false) : <p className="lv-note" data-robot-connect-note>주변 로봇 찾기(Wi-Fi·블루투스)는 FOOTHOLD Android 앱에서만 됩니다 — 브라우저는 블루투스·같은 망 기기를 찾을 수 없습니다.</p>}
    </section>}
    <SimLaunch me={c.user.id} />
  </>;
}
function Card({ c, r }: { c: Pick<Ctx, 'user' | 'go'>; r: Robot }) {
  const why = driveBlock(c.user, r), id = `why-${r.id}`, l = rt.get(r.id), rel = l.releasing;
  return <li className="card dv-card">
    <div className="fh-row"><b>{r.name}</b>{r.sim && <Chip tone="off" text="시뮬" />}<Chip {...robotStatus(r)} /><span className="mono">{pct(r.battery)}</span></div>
    <span className="lbl">{holderText(l, c.user.id, r)}</span>
    {rel && <div className="fh-row" role="status" data-releasing><span className="fh-why">{rel.why ? `조종권 반납을 확인하지 못했습니다. ${rel.why}` : RELEASING}</span>
      {rel.why && <button type="button" className="btn" onClick={() => rt.release(r.id)}>다시 시도</button>}</div>}
    {r.sim ? <span className="lbl" data-sim-card>시뮬 로봇은 아래 «시뮬 로봇 띄우기»에서 로봇에 직접 연결합니다.</span>   // 서버 경유 조종 화면으로 보내지 않는다
      : <><button type="button" className={`btn${why ? '' : ' pri'}`} aria-describedby={why ? id : undefined} onClick={() => c.go('drive', r.id)}>{why ? '보기만' : '연결'}</button>
        {why && <span id={id} className="fh-why" data-why>{why}</span>}</>}
  </li>;
}

/** 아래 줄 시트(조종 화면 위에 열림 — 화면은 그대로, STOP 이 있는 머리줄은 덮지 않음) */
export function Sheet({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  return <section className="fh-sheet" role="dialog" aria-label={title} data-sheet>
    <div className="fh-row"><h2 className="fh-grow">{title}</h2><button type="button" className="btn" onClick={close}>닫기</button></div>
    {children}
  </section>;
}
const Later = ({ text, buttons = [] }: { text: string; buttons?: string[] }) => <>
  {!!buttons.length && <div className="fh-row">{buttons.map((b) => <button key={b} type="button" className="btn" {...soon}>{b}</button>)}</div>}
  <p className="lv-note">준비 중입니다. {text}</p></>;
const SHEET: Record<SheetId, (c: Ctx) => JSX.Element> = {
  pose: () => <Later text="서기·앉기·넘어진 뒤 일으키기는 다음 단계에서 열립니다." buttons={['서기', '앉기', '일으키기']} />,
  scenario: (c) => <Scenario {...c} />,
  goal: () => <Later text="지도 위에 목표를 찍어 보내는 기능은 다음 단계에서 열립니다." />,
  policy: () => <Later text="지금 보행 정책 표시와 바꾸기는 다음 단계에서 열립니다." />,
};

/** F-TO-02~05: 조종 화면 */
function Screen(c: Ctx) {
  const r = c.robot, me = c.user.id, l = useLive(r.id), mine = !!l.lease, link = rt.link().at;
  const [view, setView] = useState<'rgb' | 'depth' | 'map'>('rgb');
  const [ask, setAsk] = useState(false);   // 시나리오 일시정지 확인창(F-TO-03, 03 §2 U10)
  const [back, setBack] = useState(false);
  const [sheet, setSheet] = useState<SheetId | null>(null);   // 아래 줄 시트(조종권은 그대로, 입력은 0으로)
  const [epoch, setEpoch] = useState(0);   // 바뀌면 조이스틱이 쥔 포인터를 놓는다(gen 은 그리기 전에도 바로 보는 같은 수)
  const gen = useRef(0);
  const input = useRef({ keys: new Set<string>(), stick: [0, 0] as Axes });
  /** 시트·⋯ 가 조이스틱을 가리면 입력을 0으로: 바로 0을 보내고, 누르던 포인터·키는 새로 누를 때까지 되살리지 않는다 */
  const neutral = () => {
    const i = input.current;
    i.keys.clear(); i.stick = [0, 0]; setBack(false); setEpoch(++gen.current);
    rt.cmd(r.id, [0, 0]);
  };
  const pick = (s: SheetId | null) => { neutral(); setSheet(s); };
  const now = useNow(!!l.incoming || !!l.outgoing || l.cooldown > rt.now());
  const axes = (): Axes => {
    const { keys: k, stick } = input.current;
    return [Math.max(0, clamp(+k.has('f') + stick[0])), clamp(+k.has('l') - +k.has('r') + stick[1])];   // 후진은 막음(PRD Q1)
  };

  // 키보드(F-TO-05). 요청 창이 떠 있어도 방향키는 조종
  useEffect(() => {
    const KEY: Record<string, string> = { KeyW: 'f', ArrowUp: 'f', KeyS: 'b', ArrowDown: 'b', KeyA: 'l', ArrowLeft: 'l', KeyD: 'r', ArrowRight: 'r' };
    const keys = input.current.keys;
    const down = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = KEY[e.code]; if (!k) return;
      e.preventDefault();
      if (e.repeat && !keys.has(k)) return;   // 시트를 열며 비운 키는 다시 눌러야 한다
      keys.add(k); if (k === 'b') setBack(true);
    };
    const up = (e: KeyboardEvent) => {
      const k = KEY[e.code]; if (k) { keys.delete(k); if (k === 'b') setBack(false); }
    };
    const blur = () => keys.clear();
    addEventListener('keydown', down, true); addEventListener('keyup', up, true); addEventListener('blur', blur);
    return () => { removeEventListener('keydown', down, true); removeEventListener('keyup', up, true); removeEventListener('blur', blur); };
  }, []);
  // 이 화면이 이 로봇을 연 동안만 조종권을 쥔다: 떠나면 반납, 숨기면 정지·잠금·반납(F-TO-03) — rt 가 처리
  useEffect(() => rt.watch(r.id), [r.id]);
  // 머리줄 ⋯ 메뉴(App 의 details)가 열려도 입력 0 — toggle 은 거품이 없어 잡기 단계로 받는다
  const neutralRef = useRef(neutral); neutralRef.current = neutral;
  useEffect(() => {
    const f = (e: Event) => { if ((e.target as HTMLDetailsElement).open) neutralRef.current(); };
    document.addEventListener('toggle', f, true); return () => document.removeEventListener('toggle', f, true);
  }, []);
  // 입력은 50 ms 마다(0 포함) — 조종권 심장 박동 겸. 손을 떼면 0(입력이 끊기면 로봇도 0.3 s 뒤 멈춘다)
  useEffect(() => {
    if (!mine) return;
    const i = setInterval(() => rt.cmd(r.id, axes()), CMD_MS);
    return () => clearInterval(i);
  }, [mine, r.id]);

  const start = (pauseRun = false) => {
    setAsk(false);
    if (rt.get(r.id).releasing) return;   // 반납 확인 전에는 요청·받기를 보내지 않는다(내게 요청하게 됨)
    if (l.holder?.type === 'RUN' && !pauseRun) return setAsk(true);
    if (l.holder?.type === 'USER') rt.request(r.id);
    else rt.take(r.id);
  };
  const wait = link !== 'open' ? '서버 연결이 끊겨 조종할 수 없습니다. 다시 연결되면 누르세요.'
    : l.releasing ? (l.releasing.why ? '반납 확인 못함 — [다시 시도]' : '반납 확인 중')   // 자세한 이유는 머리줄 아래 한 곳(320 에서 보기 단추를 밀지 않게 짧게)
    : l.outgoing?.canceling ? '요청을 취소하는 중입니다.'
    : l.busy ? BUSY_TEXT[l.busy]
    : l.outgoing ? `${l.holder?.name || '조종하는 사람'}님에게 요청했습니다. (${secs(l.outgoing.until, now)}초)`
    : l.cooldown > now ? `${secs(l.cooldown, now)}초 뒤 다시 요청할 수 있습니다.` : '';
  const q = mine && l.incoming && l.incoming.until > now ? l.incoming : null;
  const lock = lockChip(l, r), ready = mine && lock.text === '움직일 수 있음', speed = l.state?.speed;

  const actions = mine
    ? <div className="fh-row">{l.state?.latched !== false && <button type="button" className="btn pri" onClick={() => rt.unlock(r.id)}>잠금 해제</button>}
        <button type="button" className="btn" onClick={() => endDrive(r.id, c.go)}>조종 끝내기</button></div>
    : <><DriveButton c={c} r={r} label="조종 시작" onClick={() => start()} wait={wait} />
        {l.outgoing && <button type="button" className="btn" disabled={l.outgoing.canceling} onClick={() => rt.cancel(r.id)}>요청 취소</button>}</>;
  const line = <div className="fh-row dv-line" aria-label="상태">
    <h2>{r.name}</h2>
    {r.sim && <Chip tone="off" text="시뮬" />}
    <span>{holderText(l, me, r)}</span>
    {r.online && speed != null && <span className="mono">{speed.toFixed(1)} m/s</span>}
    {r.online && l.state?.latency_ms != null && <span className="mono">지연 {l.state.latency_ms} ms</span>}
    <span className="mono">{pct(r.battery)}</span>
    <Chip {...lock} />
    <span className="fh-grow" />
    {actions}
  </div>;
  // 잠금 사유 OUTPUT_STALLED(에이전트 출력 지연 → 0·STOP·잠금) — 폰 시뮬 조종(simdrive.tsx)과 같은 문구. 잠금 해제·STOP 동작은 그대로
  const stalled = l.state?.connection === 'ONLINE' && !!l.state.latched && l.state.safety_reason === 'OUTPUT_STALLED';
  const note = <>{l.notice && <p className="dv-note" role="status">{l.notice}</p>}{stalled && <p className="dv-note" role="status" data-stalled>{STALLED}</p>}</>;
  const views = <div className="dv-views" aria-label="보기">
    {([['rgb', 'RGB'], ['depth', '뎁스'], ['map', '지도']] as const).map(([v, t]) =>
      <button key={v} type="button" className="btn" aria-pressed={view === v} onClick={() => setView(v)}>{t}</button>)}
  </div>;

  return <section className="dv ph" style={{ flexBasis: '100%' }} aria-label="조종" onContextMenu={(e) => e.preventDefault()}>
    <div className="dv-body">
      <div className={`dv-stage ${view}`}>
        {view === 'map' ? <MapView big /> : <Video depth={view === 'depth'} />}
        {!l.releasing && <button type="button" className="dv-mini" aria-label={view === 'map' ? '영상 크게' : '지도 크게'} onClick={() => setView(view === 'map' ? 'rgb' : 'map')}>
          {view === 'map' ? <Video small /> : <MapView />}</button>}{/* 반납 중에는 안내가 상태 판을 키워 보기 단추와 겹치므로 숨김(보기 단추로 같은 일) */}
        <div className="dv-hud">{line}{views}{note}</div>
        {q && <div className="dv-ask" role="dialog" aria-labelledby="dv-ask-t" aria-live="assertive">
          <b id="dv-ask-t">조종권 요청</b>
          <p>{ROLE_NAME[q.role as Role] ?? ''} {q.name}님이 {r.name} 조종권을 요청했습니다. 넘겨주시겠습니까?</p>
          <div className="dv-bar" aria-label={`남은 시간 ${secs(q.until, now)}초`}><i style={{ width: `${(Math.max(0, q.until - now) / q.ms) * 100}%` }} /></div>
          <div className="fh-row">
            <button type="button" className="btn" data-ask="give" onClick={pointerOnly(() => rt.respond(r.id, true))}>넘기기</button>
            <button type="button" className="btn" data-ask="keep" onClick={pointerOnly(() => rt.respond(r.id, false))}>계속 조종</button>
            <span className="lbl">마우스나 터치로 누르세요</span>
          </div>
        </div>}
        {ask && l.holder?.type === 'RUN' && <div className="dv-ask" role="dialog" aria-labelledby="dv-run-t">
          <b id="dv-run-t">조종 시작</b>
          <p>{r.name}이 시나리오를 실행 중입니다. 조종을 시작하면 시나리오가 일시정지됩니다.</p>
          <div className="fh-row"><button type="button" className="btn pri" onClick={() => start(true)}>일시정지하고 조종</button><button type="button" className="btn" onClick={() => setAsk(false)}>취소</button></div>
        </div>}
        {mine && <><Stick label="전후" vertical on={ready} epoch={epoch} gen={gen} set={(v) => { input.current.stick[0] = v; setBack(v < -0.3); }} />
          <Stick label="회전" on={ready} epoch={epoch} gen={gen} set={(v) => { input.current.stick[1] = v; }} /></>}
        {back && mine && <span className="dv-back" role="status">후진은 아직 지원하지 않습니다</span>}
        <div className="dv-sheets" aria-label="조종 메뉴">{PHONE_SHEETS.map((x) =>
          <button key={x.id} type="button" className="btn" aria-expanded={sheet === x.id} onClick={() => pick(sheet === x.id ? null : x.id)}>{x.label}</button>)}</div>
        {sheet && <Sheet title={PHONE_SHEETS.find((x) => x.id === sheet)!.label} close={() => pick(null)}>{SHEET[sheet](c)}</Sheet>}
      </div>
    </div>
    {r.mission && <div className="fh-row dv-run">
      <span>시나리오: {r.mission}</span>
      <span className="fh-grow" />
      <button type="button" className="btn" {...soon}>일시정지</button>
      <button type="button" className="btn" {...soon}>중단</button>
    </div>}
  </section>;
}

/** 실기 RGB: 실기 영상 어댑터·media capability 가 아직 없다 — 연결·명령 시도 없이 이유만(가짜 그림 0) */
export const REAL_RGB = '실기 영상 준비 중(미연결)';
function Video({ depth, small }: { depth?: boolean; small?: boolean }) {
  return <div className={`dv-video${depth ? ' depth' : ''}`} role="img" aria-label={depth ? '뎁스 영상' : 'RGB 영상'}>
    {!small && <span>{depth ? '뎁스 영상 자리 · 가까울수록 붉게' : REAL_RGB}</span>}</div>;
}
/** 지도 + 로봇 위치 + 라이다 점(겹쳐 그림) — 가짜 그림 */
function MapView({ big }: { big?: boolean }) {
  const dots = Array.from({ length: 24 }, (_, i) => { const a = (i / 24) * Math.PI * 2, d = 38 + ((i * 7) % 11); return [100 + Math.cos(a) * d * 1.6, 70 + Math.sin(a) * d]; });
  return <svg className={`dv-map${big ? ' big' : ''}`} viewBox="0 0 200 140" role="img" aria-label="지도와 라이다">
    <rect width="200" height="140" fill="var(--map)" />
    <path d="M10 10h180v120H10zM70 10v50M130 80v50" fill="none" stroke="var(--wall)" strokeWidth="3" />
    {dots.map(([x, y], i) => <circle key={i} cx={x} cy={y} r="1.6" fill="var(--warn)" />)}
    <path d="M100 62l7 14h-14z" fill="var(--accent)" />
  </svg>;
}

/** 폰 엄지 조이스틱(03 §5.7): 왼쪽 전후(세로), 오른쪽 회전(가로). both = 세로·가로 두 축(시뮬 왼쪽 상하좌우, set 둘째 값 = 가로, 왼쪽 +).
 *  손을 떼면 0. epoch 가 바뀌면 쥔 포인터를 놓고 새 누름까지 무시. children = 판 위 그림(화살표) */
export function Stick({ label, vertical, both, on, epoch, gen, set, children }: { label: string; vertical?: boolean; both?: boolean; on: boolean; epoch: number; gen: { current: number }; set: (v: number, side: number) => void; children?: ReactNode }) {
  const [k, setK] = useState<[number, number]>([0, 0]);   // [세로, 가로]
  const held = useRef<{ el: HTMLDivElement; id: number; g: number } | null>(null);
  useEffect(() => {
    const h = held.current; held.current = null; setK([0, 0]);
    if (h?.el.hasPointerCapture?.(h.id)) h.el.releasePointerCapture(h.id);
  }, [epoch]);
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const b = e.currentTarget.getBoundingClientRect();
    const y = clamp((b.top + b.height / 2 - e.clientY) / (b.height / 2)), x = clamp((b.left + b.width / 2 - e.clientX) / (b.width / 2));
    setK(both ? [y, x] : vertical ? [y, 0] : [0, x]); set(both || vertical ? y : x, both ? x : 0);
  };
  const end = () => { held.current = null; setK([0, 0]); set(0, 0); };
  return <div className={`dv-stick ${vertical || both ? 'v' : 'h'}`} aria-label={`${label} 조이스틱`} aria-disabled={!on}
    onPointerDown={(e) => { if (!on) return; held.current = { el: e.currentTarget, id: e.pointerId, g: gen.current }; e.currentTarget.setPointerCapture?.(e.pointerId); move(e); }}
    onPointerMove={(e) => { const h = held.current; if (h?.id === e.pointerId && h.g === gen.current) move(e); }}
    onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}>
    {children}
    <i style={{ transform: `translate(${-k[1] * 36}px, ${-k[0] * 36}px)` }} />
    <span>{label}</span>
  </div>;
}
