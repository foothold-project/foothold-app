// 조종 탭(02 기능 F-TO-01~05, 03 UX §5.2·§5.7). 조종권·잠금·STOP 은 실시간 연결(rt.ts)만 부른다 — 판정은 서버 중재기.
// 영상·지도·시나리오 제어는 자리만(가짜). 키보드: W·↑ 전진, A·← / D·→ 회전, S·↓ 후진 막음. Space = STOP 은 App 공통 층(모든 화면).
import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react';
import { ROLE_NAME, driveBlock, robotStatus, type Robot, type Role, type Tone } from './fake';
import { CMD_MS, rt, useLive, useRt, type Live } from './rt';
import { Chip, DriveButton, soon, type Ctx } from './screens';
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

function holderText(l: Live, me: string) {
  if (l.lease) return '조종 중(나)';
  if (l.busy) return '조종권 넘기는 중';
  if (!l.holder) return '조종하는 사람 없음';
  if (l.holder.type === 'RUN') return '시나리오 실행 중';
  return l.holder.id === me ? '다른 창에서 조종 중(나)' : `${l.holder.name}님 조종 중`;
}
function lockChip(l: Live): { tone: Tone; text: string } {
  if (l.failed) return { tone: 'bad', text: '정지 확인 실패' };
  if (l.busy) return { tone: 'warn', text: '정지 확인 중' };
  if (!l.state || l.state.connection !== 'ONLINE') return { tone: 'off', text: '상태 모름' };
  if (l.state.latched !== false) return { tone: 'bad', text: '정지 잠금' };
  if (!l.lease) return { tone: 'off', text: '보는 중' };
  return l.neutral ? { tone: 'ok', text: '움직일 수 있음' } : { tone: 'warn', text: '중립 확인 중' };
}
const BUSY_TEXT = { take: '로봇 정지를 확인한 뒤 조종권을 받습니다.', give: '조종권을 넘기는 중입니다. 로봇 정지를 확인하고 있습니다.' };

export function Drive(c: Ctx) {
  return c.phone || c.open ? <Screen {...c} /> : <Picker {...c} />;
}

/** F-TO-01: 탭에 그냥 들어오면 로봇 카드 목록 */
function Picker(c: Ctx) {
  useRt();
  return <section className="lv-card" style={{ flexBasis: '100%' }} aria-label="로봇 고르기">
    <h2>조종할 로봇</h2>
    <ul className="dv-cards">{c.robots.map((r) => <Card key={r.id} c={c} r={r} />)}</ul>
  </section>;
}
function Card({ c, r }: { c: Ctx; r: Robot }) {
  const why = driveBlock(c.user, r), id = `why-${r.id}`;
  return <li className="card dv-card">
    <div className="fh-row"><b>{r.name}</b><Chip {...robotStatus(r)} /><span className="mono">{pct(r.battery)}</span></div>
    <span className="lbl">{holderText(rt.get(r.id), c.user.id)}</span>
    <button type="button" className={`btn${why ? '' : ' pri'}`} aria-describedby={why ? id : undefined} onClick={() => c.go('drive', r.id)}>{why ? '보기' : '직접 조종'}</button>
    {why && <span id={id} className="fh-why" data-why>{why}</span>}
  </li>;
}

/** F-TO-02~05: 조종 화면 */
function Screen(c: Ctx) {
  const r = c.robot, me = c.user.id, l = useLive(r.id), mine = !!l.lease, link = rt.link().at;
  const [view, setView] = useState<'rgb' | 'depth' | 'map'>('rgb');
  const [ask, setAsk] = useState(false);   // 시나리오 일시정지 확인창(F-TO-03, 03 §2 U10)
  const [back, setBack] = useState(false);
  const input = useRef({ keys: new Set<string>(), pad: [0, 0] as Axes, stick: [0, 0] as Axes });
  const now = useNow(!!l.incoming || !!l.outgoing || l.cooldown > rt.now());
  const axes = (): Axes => {
    const { keys: k, pad, stick } = input.current;
    return [Math.max(0, clamp(+k.has('f') + pad[0] + stick[0])), clamp(+k.has('l') - +k.has('r') + pad[1] + stick[1])];   // 후진은 막음(PRD Q1)
  };

  // 키보드(F-TO-05). 요청 창이 떠 있어도 방향키는 조종
  useEffect(() => {
    const KEY: Record<string, string> = { KeyW: 'f', ArrowUp: 'f', KeyS: 'b', ArrowDown: 'b', KeyA: 'l', ArrowLeft: 'l', KeyD: 'r', ArrowRight: 'r' };
    const keys = input.current.keys;
    const down = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = KEY[e.code]; if (!k) return;
      e.preventDefault(); keys.add(k); if (k === 'b') setBack(true);
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
  // 입력은 50 ms 마다(0 포함) — 조종권 심장 박동 겸. 손을 떼면 0(입력이 끊기면 로봇도 0.3 s 뒤 멈춘다)
  useEffect(() => {
    if (!mine) return;
    const i = setInterval(() => rt.cmd(r.id, axes()), CMD_MS);
    return () => clearInterval(i);
  }, [mine, r.id]);

  const start = (pauseRun = false) => {
    setAsk(false);
    if (l.holder?.type === 'RUN' && !pauseRun) return setAsk(true);
    if (l.holder?.type === 'USER') rt.request(r.id);
    else rt.take(r.id);
  };
  const wait = link !== 'open' ? '서버 연결이 끊겨 조종할 수 없습니다. 다시 연결되면 누르세요.'
    : l.busy ? BUSY_TEXT[l.busy]
    : l.outgoing ? `${l.holder?.name || '조종하는 사람'}님에게 요청했습니다. (${secs(l.outgoing.until, now)}초)`
    : l.cooldown > now ? `${secs(l.cooldown, now)}초 뒤 다시 요청할 수 있습니다.` : '';
  const q = mine && l.incoming && l.incoming.until > now ? l.incoming : null;
  const lock = lockChip(l), ready = mine && lock.text === '움직일 수 있음', speed = l.state?.speed;

  const actions = mine
    ? <div className="fh-row">{l.state?.latched !== false && <button type="button" className="btn pri" onClick={() => rt.unlock(r.id)}>잠금 해제</button>}
        <button type="button" className="btn" onClick={() => rt.release(r.id)}>조종 끝내기</button></div>
    : <DriveButton c={c} r={r} label="조종 시작" onClick={() => start()} wait={wait} />;
  const line = <div className="fh-row dv-line" aria-label="상태">
    {!c.phone && <h2>{r.name}</h2>}
    <span>{holderText(l, me)}</span>
    {r.online && speed != null && <span className="mono">{speed.toFixed(1)} m/s</span>}
    {r.online && !c.phone && l.state?.latency_ms != null && <span className="mono">지연 {l.state.latency_ms} ms</span>}
    <span className="mono">{pct(r.battery)}</span>
    <Chip {...lock} />
    <span className="fh-grow" />
    {actions}
  </div>;
  const note = l.notice && <p className="dv-note" role="status">{l.notice}</p>;
  const views = <div className="dv-views" aria-label="보기">
    {([['rgb', 'RGB'], ['depth', '뎁스'], ['map', c.phone ? '지도' : '지도 크게']] as const).map(([v, t]) =>
      <button key={v} type="button" className="btn" aria-pressed={view === v} onClick={() => setView(v)}>{t}</button>)}
  </div>;

  return <section className={`dv${c.phone ? ' ph' : ''}`} style={{ flexBasis: '100%' }} aria-label="조종">
    {!c.phone && <>{line}{note}</>}
    <div className="dv-body">
      <div className={`dv-stage ${view}`}>
        {view === 'map' ? <MapView big /> : <Video depth={view === 'depth'} />}
        <button type="button" className="dv-mini" aria-label={view === 'map' ? '영상 크게' : '지도 크게'} onClick={() => setView(view === 'map' ? 'rgb' : 'map')}>
          {view === 'map' ? <Video small /> : <MapView />}</button>
        {c.phone && <div className="dv-hud">{line}{views}{note}</div>}
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
        {mine && (c.phone
          ? <><Stick label="전후" vertical on={ready} set={(v) => { input.current.stick[0] = v; setBack(v < -0.3); }} />
              <Stick label="회전" on={ready} set={(v) => { input.current.stick[1] = v; }} /></>
          : <MouseBar on={ready} set={(a) => { input.current.pad = a; }} />)}
        {back && mine && <span className="dv-back" role="status">후진은 아직 지원하지 않습니다</span>}
      </div>
      {!c.phone && views}
    </div>
    {r.mission && <div className="fh-row dv-run">
      <span>시나리오: {r.mission}</span>
      <span className="fh-grow" />
      <button type="button" className="btn" {...soon}>일시정지</button>
      <button type="button" className="btn" {...soon}>중단</button>
    </div>}
  </section>;
}

function Video({ depth, small }: { depth?: boolean; small?: boolean }) {
  return <div className={`dv-video${depth ? ' depth' : ''}`} role="img" aria-label={depth ? '뎁스 영상' : 'RGB 영상'}>
    {!small && <span>{depth ? '뎁스 영상 자리 · 가까울수록 붉게' : 'RGB 영상 자리'}</span>}</div>;
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

/** PC 마우스 막대(F-TO-05): 누르고 있는 동안만 움직임, 놓으면 0 */
function MouseBar({ on, set }: { on: boolean; set: (a: Axes) => void }) {
  const hold = (a: Axes) => ({
    onPointerDown: (e: PointerEvent<HTMLButtonElement>) => { e.currentTarget.setPointerCapture?.(e.pointerId); set(a); },
    onPointerUp: () => set([0, 0]), onPointerCancel: () => set([0, 0]), onLostPointerCapture: () => set([0, 0]),
  });
  return <div className="dv-pad" aria-label="화면 조종 막대">
    <button type="button" className="btn" disabled={!on} aria-label="왼쪽 회전" {...hold([0, 1])}>◀</button>
    <button type="button" className="btn" disabled={!on} aria-label="전진" {...hold([1, 0])}>▲</button>
    <button type="button" className="btn" disabled aria-label="후진 미지원">▼</button>
    <button type="button" className="btn" disabled={!on} aria-label="오른쪽 회전" {...hold([0, -1])}>▶</button>
  </div>;
}

/** 폰 엄지 조이스틱(03 §5.7): 왼쪽 전후(세로), 오른쪽 회전(가로). 손을 떼면 0 */
function Stick({ label, vertical, on, set }: { label: string; vertical?: boolean; on: boolean; set: (v: number) => void }) {
  const [k, setK] = useState(0);
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const b = e.currentTarget.getBoundingClientRect();
    const v = clamp(vertical ? (b.top + b.height / 2 - e.clientY) / (b.height / 2) : (b.left + b.width / 2 - e.clientX) / (b.width / 2));
    setK(v); set(v);
  };
  const end = () => { setK(0); set(0); };
  return <div className={`dv-stick ${vertical ? 'v' : 'h'}`} aria-label={`${label} 조이스틱`} aria-disabled={!on}
    onPointerDown={(e) => { if (!on) return; e.currentTarget.setPointerCapture?.(e.pointerId); move(e); }}
    onPointerMove={(e) => { if (e.currentTarget.hasPointerCapture?.(e.pointerId)) move(e); }}
    onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}>
    <i style={{ transform: vertical ? `translateY(${-k * 36}px)` : `translateX(${-k * 36}px)` }} />
    <span>{label}</span>
  </div>;
}
