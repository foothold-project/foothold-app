// 실기 Go2 서버 경유 시험 조종(10-30 SERVER-DRIVE-WEB·ADD1 — ADR-002 예외: 서버가 켠 시험 로봇만, PC 웹만). 로봇 탭 상세 서랍에 붙는다.
// 허용 여부는 서버 목록의 server_drive_allowed 만 본다(웹은 추측하지 않음). 조종권·잠금 해제·STOP·명령은 rt.ts(화면 WS) 그대로 — 새 경로 없음.
// 명령은 서버·에이전트 표의 SI 값 9개만(그 밖 조합은 0), 누르는 동안만. 뗌·초점 잃음·가려짐·연결 끊김·STOP = 바로 0 + 안내, 다시 누를 때까지 재개 없음.
// 카메라·라이다 작은 칸 둘(drivemedia.ts) — 누르면 화면 전체(다시 누르거나 Esc 로 복귀), 그 안에도 STOP 이 가장 크게. 키 조종은 그대로
import { useEffect, useRef, useState, type KeyboardEvent as KeyEv, type PointerEvent, type ReactNode } from 'react';
import { CMD_MS, rt, useLive, type Live } from './rt';
import { typing } from './App';
import { Chip, DriveButton, type Ctx } from './screens';
import { STALLED } from './simdrive';
import { Cloud3D } from './quad';
import { driveFeedText, useDriveFeed, type DriveCh } from './drivemedia';
import type { Robot, Tone } from './fake';

/** 누름 하나: up·down = 전후, left·right = 옆걸음, rotl·rotr = 제자리 회전(A·D) */
type Tok = 'up' | 'down' | 'left' | 'right' | 'rotl' | 'rotr';
const KEY: Record<string, Tok> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', KeyA: 'rotl', KeyD: 'rotr' };
/** 서버·에이전트 허용 표(SERVER-DRIVE-ADD1 A) — [vx m/s, vy m/s, wz rad/s]. 정확히 이 값만, 표 밖 조합은 0 */
export const TABLE: Record<string, [number, number, number]> = {
  '': [0, 0, 0], up: [1.5, 0, 0], down: [-1.5, 0, 0], left: [0, 1.5, 0], right: [0, -1.5, 0],
  rotl: [0, 0, 0.5], rotr: [0, 0, -0.5], 'rotl+up': [1.5, 0, 0.5], 'rotr+up': [1.5, 0, -0.5],
};
const id = (held: Iterable<Tok>) => [...held].sort().join('+');
export const command = (held: Iterable<Tok>) => TABLE[id(held)] ?? TABLE[''];
/** 화면 단추 8개(+ 손 뗌 = 0) — 키와 같은 표 */
const PAD: [Tok[], string, string][] = [
  [['rotl', 'up'], '↑+A', '앞+왼쪽 회전'], [['up'], '↑', '앞 1.5'], [['rotr', 'up'], '↑+D', '앞+오른쪽 회전'],
  [['left'], '←', '옆 왼쪽 1.5'], [['down'], '↓', '뒤 1.5'], [['right'], '→', '옆 오른쪽 1.5'],
  [['rotl'], 'A', '제자리 왼쪽'], [['rotr'], 'D', '제자리 오른쪽'],
];
export const TRIAL = '실기 · 서버 경유 시험 · 미검증';
/** 입력 0 안내 — 화면이 보낸 0 일 뿐 로봇 정지 확인이 아니다(F-COM-01: 확인 없이 «멈췄습니다» 금지). 정지 확인은 stopLine 만 */
export const SD_NOTE = {
  blur: '창 초점을 잃어 조종 입력을 0으로 보냈습니다(로봇 정지 확인 아님). 다시 누르세요.',
  hidden: '창이 가려져 조종 입력을 0으로 보내고 조종권을 반납했습니다(로봇 정지 확인 아님). [조종 시작]부터 다시 하세요.',
  link: '서버 연결이 끊겨 입력 0이 로봇에 닿았는지 알 수 없습니다 — 현장에서 로봇을 확인하세요. 다시 연결되면 [조종 시작]부터 하세요.',
  stop: '조종 입력을 0으로 보냈습니다. 정지 확인은 STOP 옆 상태를 보세요 — 잠금 해제 뒤 새로 누르세요.',
};
/** STOP 상태 한 줄: 입력 0 보냄(요청 중) / 정지 요청 접수 / 로봇 정지 확인 / 실패. «로봇 정지 확인»은 이 STOP 뒤 이 소켓에서 받은 새 세대 잠금(rt stop.latched)
 *  + 지금 보고가 ONLINE·잠김·출력(applied) 0·수평 속도 0 일 때만 */
export function stopLine({ stop: p, state: s }: Pick<Live, 'stop' | 'state'>): { tone: Tone; text: string } | null {
  if (!p) return null;
  const why = p.why ? ` (${p.why})` : '';
  if (p.phase === 'failed') return { tone: 'bad', text: `정지 요청 실패 — 현장 확인${why}` };
  if (p.phase === 'unsure') return { tone: 'bad', text: `정지 접수 확인 못함 — 현장 확인${why}` };
  if (p.phase === 'sending') return { tone: 'warn', text: '입력 0 보냄 · 정지 요청 보내는 중' };
  if (p.latched && s?.connection === 'ONLINE' && s.latched === true && !!s.applied?.length && s.applied.every((v) => v === 0) && s.speed != null && s.speed < 0.05)
    return { tone: 'ok', text: '로봇 정지 확인 — 잠금·출력 0·수평 속도 0' };
  return { tone: 'warn', text: `정지 요청 접수${p.phase === 'fallback' ? '(대체 경로)' : ''} — 로봇 정지 확인 대기` };
}
/** 잠금 해제 요청 뒤 이 시간 안에 잠금이 안 풀리면 «미확인» */
export const UNLOCK_WAIT_MS = 3000;
/** UIUX-1101-AGENT 가 더할 거절 사유(아직 contracts 전 — optional 로 읽음) */
type Refused = { reason?: string; at?: string; axes?: { axis: string; value: number; limit: number; unit?: string }[] };
export function refusedText(r: Refused | null | undefined) {
  if (!r?.reason) return '';
  const ax = (r.axes ?? []).map((a) => `${a.axis} ${a.value}${a.unit ? ` ${a.unit}` : ''} > 기준 ${a.limit}${a.unit ? ` ${a.unit}` : ''}`).join(', ');
  return `거절 사유: ${r.reason}${ax ? ` — ${ax}` : ''}`;
}
/** 대화상자 밖을 inert(초점·누름 막음) — 대화상자 조상 줄의 형제 모두. 돌려줄 때 원래대로 */
function inertOutside(el: HTMLElement) {
  const done: Element[] = [];
  for (let n: HTMLElement | null = el; n && n !== document.body; n = n.parentElement)
    for (const x of n.parentElement?.children ?? []) if (x !== n && !x.hasAttribute('inert')) { x.setAttribute('inert', ''); done.push(x); }
  return () => done.forEach((x) => x.removeAttribute('inert'));
}
/** Tab·Shift+Tab 을 대화상자 안에서 돌림 */
function trapTab(e: KeyEv<HTMLElement>) {
  if (e.key !== 'Tab') return;
  const f = [...e.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')];
  if (!f.length) return;
  const i = f.indexOf(document.activeElement as HTMLElement);
  e.preventDefault(); f[e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i + 1) % f.length].focus();
}
const CH_NAME: Record<DriveCh, string> = { rgb: '카메라', lidar: '라이다' };

export function ServerDrive({ c, r }: { c: Ctx; r: Robot }) {
  const l = useLive(r.id), link = rt.link().at, mine = !!l.lease, s = l.state;
  const [on, setOn] = useState(''), [why, setWhy] = useState(''), [full, setFull] = useState<DriveCh | null>(null);
  const [, tick] = useState(0), [asked, setAsked] = useState<number | null>(null);   // asked = 잠금 해제 요청을 보낸 때(rt.now)
  const held = useRef(new Set<Tok>()), dlg = useRef<HTMLDivElement>(null), opener = useRef<HTMLElement | null>(null);
  const feeds = { rgb: useDriveFeed(r.id, 'rgb'), lidar: useDriveFeed(r.id, 'lidar') };
  const ready = mine && link === 'open' && s?.connection === 'ONLINE' && s.latched === false && !l.busy;
  const readyRef = useRef(ready); readyRef.current = ready;
  const send = () => { const [vx, vy, wz] = command(held.current); rt.cmd(r.id, [vx, wz], vy); };
  /** 누름이 바뀜: 그리고 바로 한 번 보낸다(뗀 그 자리에서 0) */
  const changed = () => { setOn(id(held.current)); if (rt.get(r.id).lease) send(); };
  /** 0 으로: 누른 것을 모두 버리고 바로 보낸다 + 안내. 다시 움직이려면 새로 눌러야 한다 */
  const zero = useRef((note = '') => { held.current.clear(); changed(); if (note) setWhy(note); }).current;
  const press = (t: Tok[]) => { if (!readyRef.current) return; setWhy(''); held.current = new Set(t); changed(); };

  useEffect(() => rt.watch(r.id), [r.id]);   // 이 패널이 열린 동안만 조종권을 쥔다(닫으면 반납 — rt)
  useEffect(() => { const i = setInterval(() => tick((n) => n + 1), 250); return () => clearInterval(i); }, []);   // 마지막 응답 ms·신호 멈춤
  // 50 ms 마다(0 포함 — 조종권 심장 박동 겸). 잠금·넘김 중 0 과 새 중립은 rt.cmd 가 지킨다
  useEffect(() => {
    if (!mine) return;
    const i = setInterval(send, CMD_MS);
    return () => clearInterval(i);
  }, [mine, r.id]);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Escape') return setFull(null);
      if (typing(e.target)) return;
      if (e.code === 'Space') return zero(SD_NOTE.stop);   // STOP 은 App 머리줄이 보낸다 — 여기는 입력만 먼저 0
      const t = KEY[e.code];
      if (!t || e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      if (e.repeat || !readyRef.current) return;   // 반복은 새 누름이 아니다(초점 잃음 뒤 되살리지 않음)
      setWhy(''); held.current.add(t); changed();
    };
    const up = (e: KeyboardEvent) => { const t = KEY[e.code]; if (t && held.current.delete(t)) changed(); };
    const blur = () => zero(SD_NOTE.blur);
    const hide = () => { if (document.visibilityState === 'hidden') zero(SD_NOTE.hidden); };
    addEventListener('keydown', down, true); addEventListener('keyup', up, true); addEventListener('blur', blur); document.addEventListener('visibilitychange', hide);
    return () => {
      removeEventListener('keydown', down, true); removeEventListener('keyup', up, true); removeEventListener('blur', blur); document.removeEventListener('visibilitychange', hide);
      zero();
    };
  }, []);
  useEffect(() => { if (!ready) zero(); }, [ready]);   // 움직일 수 없게 되면 누른 것을 버린다(자동 재개 없음)
  useEffect(() => { if (link === 'lost' || link === 'denied') zero(SD_NOTE.link); }, [link]);
  useEffect(() => { if (l.stop) zero(SD_NOTE.stop); }, [l.stop?.n]);   // 머리줄 STOP·Space 도
  useEffect(() => { if (s?.latched !== true || !mine) setAsked(null); }, [s?.latched, mine]);   // 풀렸거나 조종권이 없으면 해제 대기 끝
  useEffect(() => { if (l.notice) setAsked(null); }, [l.notice]);   // 서버가 해제 요청을 거절(rt.unlock notice) — 대기 아님
  // 전체화면 = 모달: 열 때 «작게 보기»로 초점, 밖은 inert, 닫을 때 연 칸으로 초점 복귀
  useEffect(() => {
    if (!full || !dlg.current) return;
    const back = opener.current, undo = inertOutside(dlg.current);
    dlg.current.querySelector<HTMLElement>('[data-sd-small]')?.focus();
    return () => { undo(); back?.focus(); };
  }, [!!full]);

  const stop = (big: boolean) => <button type="button" className="fh-stop" aria-label="비상 정지 — 이 로봇" data-sd-stop={big ? 'full' : 'panel'}
    style={big ? { minHeight: 120, minWidth: 320 } : { minHeight: 88, width: '100%' }} onClick={() => { zero(SD_NOTE.stop); rt.stop(r.id); }}>
    <svg width="30" height="30" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 2h8l6 6v8l-6 6H8l-6-6V8z" fill="none" stroke="#FFFFFF" strokeWidth="2" /><rect x="8" y="8" width="8" height="8" fill="#FFFFFF" /></svg>
    <span className="fh-stop-t"><span>STOP</span><small>정지 요청</small></span>
  </button>;
  const pad = mine && <div role="group" aria-label="조종(누르는 동안만)" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
    {PAD.map(([t, k, text]) => <button key={k} type="button" className="btn" data-sd-move={id(t)} aria-pressed={on === id(t)} disabled={!ready} style={{ minHeight: 48 }}
      onPointerDown={(e: PointerEvent<HTMLButtonElement>) => { e.currentTarget.setPointerCapture?.(e.pointerId); press(t); }}
      onPointerUp={() => zero()} onPointerCancel={() => zero()} onLostPointerCapture={() => { if (on === id(t)) zero(); }}
      onContextMenu={(e) => e.preventDefault()}><b className="mono">{k}</b> {text}</button>)}
  </div>;
  const view = (ch: DriveCh, big: boolean) => {
    const f = feeds[ch], text = driveFeedText(f, ch);
    if (ch === 'lidar') return <Cloud3D small={!big} big={big} feed={f} empty={text} />;
    return text ? <div className="dv-video" role="img" aria-label="카메라" data-sd-cam><span>{text}</span></div>
      : <img className="dv-video" src={f.img} alt="카메라" draggable={false} style={{ width: '100%', height: '100%', objectFit: 'contain' }} data-sd-cam />;
  };
  const box = (children: ReactNode, h?: number) => <div style={{ position: 'relative', flex: 1, minHeight: h, background: '#070A0C', borderRadius: 8, overflow: 'hidden' }}>{children}</div>;
  const age = s ? Math.round(rt.now() - l.stateAt) : null, stalled = !!s?.latched && s.safety_reason === 'OUTPUT_STALLED';
  const sl = stopLine(l), stopNote = sl && <span role="status" data-sd-stop-phase data-tone={sl.tone}><Chip {...sl} /></span>;
  const refused = refusedText((s as { unlock_refused?: Refused | null } | null)?.unlock_refused);
  const late = asked != null && rt.now() - asked >= UNLOCK_WAIT_MS;
  const unlock = mine && s?.latched && <div className="fh-row" style={{ flexWrap: 'wrap' }} data-sd-lock>
    <span>① 정지 확인 — 서버 보고 수평 속도 {s.speed != null ? `${s.speed.toFixed(1)} m/s` : '모름'}</span>
    <span aria-hidden="true">→</span>
    <button type="button" className="btn pri" onClick={() => { setAsked(rt.now()); rt.unlock(r.id); }}>{asked != null ? '② 잠금 해제 다시' : '② 잠금 해제'}</button>
    {asked != null && <span role="status" data-sd-unlock={late ? 'unconfirmed' : 'wait'} className={late ? 'fh-msg' : 'lbl'} style={{ flexBasis: '100%' }}>
      {late ? `미확인 — 로봇이 정지 확인을 못 해 잠금이 그대로입니다. ${refused || '로봇이 완전히 멈췄는지(수직 흔들림 포함) 현장에서 확인한 뒤 다시 누르세요.'}`
        : `해제 대기 — 로봇이 정지를 확인하면 풀립니다.${refused ? ` ${refused}` : ''}`}</span>}
  </div>;
  const lock = !s || s.connection !== 'ONLINE' ? { tone: 'off' as const, text: '상태 모름' } : s.latched !== false ? { tone: 'bad' as const, text: '정지 잠금' }
    : !mine ? { tone: 'off' as const, text: '보는 중' } : l.neutral ? { tone: 'ok' as const, text: '움직일 수 있음' } : { tone: 'warn' as const, text: '중립 확인 중' };
  const status = <div className="fh-row lbl mono" style={{ flexWrap: 'wrap', gap: 10 }} data-sd-status>
    <span>배터리 {s?.battery?.soc != null ? `${s.battery.soc}%` : '—'}</span>
    <span>수평 속도 {s?.speed != null ? `${s.speed.toFixed(1)} m/s` : '—'}</span>
    <span>잠금 {s?.latched == null ? '모름' : s.latched ? '잠김' : '풀림'}</span>
    <span>지연 {s?.latency_ms != null ? `${s.latency_ms} ms` : '—'}</span>
    <span>마지막 응답 {age != null ? `${age} ms 전` : '없음'}</span>
  </div>;
  const notes = <>{why && <p className="dv-note" role="status" data-sd-why>{why}</p>}
    {l.notice && <p className="dv-note" role="status">{l.notice}</p>}
    {stalled && <p className="dv-note" role="status">{STALLED}</p>}</>;
  const wait = link !== 'open' ? '서버 연결이 끊겨 조종할 수 없습니다. 다시 연결되면 누르세요.'
    : l.releasing ? '조종권 반납을 확인하는 중입니다.'
    : l.busy ? '로봇 정지를 확인한 뒤 조종권을 받습니다.'
    : l.outgoing ? `${l.holder?.name || '조종하는 사람'}님에게 조종권을 요청했습니다.`
    : l.cooldown > rt.now() ? '잠시 뒤 다시 요청할 수 있습니다.'
    : l.holder?.type === 'RUN' ? '시나리오 실행 중에는 이 시험 화면에서 조종을 시작하지 않습니다.' : '';

  return <section className="card" aria-label="서버 경유 시험 조종" data-server-drive style={{ display: 'flex', flexDirection: 'column', gap: 8, borderColor: 'var(--warn)' }}>
    <div className="fh-row" style={{ flexWrap: 'wrap' }}><Chip tone="warn" text={TRIAL} /><Chip {...lock} /></div>
    {stop(false)}
    {stopNote}
    {status}
    <div className="fh-row" style={{ gap: 6 }} aria-label="카메라·라이다">{(['rgb', 'lidar'] as const).map((ch) =>
      <button key={ch} type="button" aria-label={`${CH_NAME[ch]} 크게 보기`} data-sd-tile={ch} onClick={(e) => { opener.current = e.currentTarget; setFull(ch); }}
        style={{ flex: 1, padding: 0, border: 0, background: 'none', display: 'flex', cursor: 'zoom-in' }}>{box(view(ch, false), 110)}</button>)}</div>
    {unlock}
    {mine ? <>
      {pad}
      <div className="fh-row"><span className="lbl fh-grow">누르는 동안만 — ↑ 1.5 · ↓ 1.5 · ←/→ 옆 1.5 m/s · A/D 제자리 0.5 rad/s · ↑+A/D. 떼면 0, 다른 조합도 0</span>
        <button type="button" className="btn" onClick={() => { zero(); rt.release(r.id); }}>조종 끝내기</button></div>
    </> : <DriveButton c={c} r={r} label="조종 시작" wait={wait} onClick={() => { setWhy(''); if (l.holder?.type === 'USER') rt.request(r.id); else rt.take(r.id); }} />}
    {l.releasing?.why && <div className="fh-row" role="status"><span className="fh-why">조종권 반납을 확인하지 못했습니다. {l.releasing.why}</span>
      <button type="button" className="btn" onClick={() => rt.release(r.id)}>다시 시도</button></div>}
    {notes}
    {full && <div role="dialog" aria-modal="true" aria-label={`${CH_NAME[full]} 전체화면`} data-sd-full ref={dlg} onKeyDown={trapTab}
      style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', flexDirection: 'column', gap: 8, padding: 12, background: 'var(--bg)' }}>
      <div className="fh-row" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
        <Chip tone="warn" text={TRIAL} /><Chip {...lock} />{status}<span className="fh-grow" style={{ flex: 1 }} />
        <button type="button" className="btn" data-sd-small onClick={() => setFull(null)}>작게 보기(Esc)</button>{stop(true)}
      </div>
      {(stopNote || unlock) && <div className="fh-row" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }} data-sd-full-state>{stopNote}{unlock}</div>}
      {full === 'rgb' ? <button type="button" aria-label="카메라 작게 보기" onClick={() => setFull(null)} style={{ flex: 1, display: 'flex', padding: 0, border: 0, background: 'none', cursor: 'zoom-out' }}>{box(view('rgb', true))}</button>
        : box(view('lidar', true))}{/* 라이다 큰 칸은 끌어 돌려 보므로 누름 대신 «작게 보기»·Esc */}
      {notes}
      {pad}
    </div>}
  </section>;
}
