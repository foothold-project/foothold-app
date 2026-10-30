// 실기 Go2 서버 경유 시험 조종(10-30 SERVER-DRIVE-WEB — ADR-002 예외: 서버가 켠 시험 로봇만, PC 웹만). 로봇 탭 상세 서랍에 붙는다.
// 허용 여부는 서버 목록의 server_drive 만 본다(웹은 추측하지 않음). 조종권·잠금 해제·STOP·명령은 rt.ts(화면 WS) 그대로 — 새 경로 없음.
// 명령은 넷만(정지·앞·앞+왼쪽·앞+오른쪽), 누르는 동안만. 뗌·초점 잃음·가려짐·연결 끊김·STOP = 바로 0 + 안내, 다시 누를 때까지 재개 없음
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { CMD_MS, rt, useLive } from './rt';
import { typing } from './App';
import { Chip, DriveButton, type Ctx } from './screens';
import { STALLED } from './simdrive';
import type { Robot } from './fake';

export type Move = 'fwd' | 'left' | 'right';
/** rt.cmd 의 [전후, 회전] — 에이전트(Go2Sink)가 0.6 m/s·±0.5 rad/s 로 바꾼다. 이 셋과 0 밖은 보내지 않는다 */
export const MOVES: Record<Move, [number, number]> = { fwd: [1, 0], left: [1, 1], right: [1, -1] };
const KEY: Record<string, Move> = { KeyW: 'fwd', KeyA: 'left', KeyD: 'right' };
const LABEL: Record<Move, [string, string]> = { fwd: ['앞으로', 'W'], left: ['앞+왼쪽', 'A'], right: ['앞+오른쪽', 'D'] };
export const TRIAL = '실기 · 서버 경유 시험 · 미검증';
export const SD_NOTE = {
  blur: '창 초점을 잃어 멈췄습니다(0). 다시 누르세요.',
  hidden: '창이 가려져 멈추고 조종권을 반납했습니다(0). [조종 시작]부터 다시 하세요.',
  link: '서버 연결이 끊겨 멈췄습니다(0). 다시 연결되면 [조종 시작]부터 하세요.',
  stop: 'STOP — 멈췄습니다(0). 잠금 해제 뒤 다시 누르세요.',
};
const STOP_PHASE = { sending: '정지 요청 보내는 중', sent: '서버 정지 접수', fallback: '서버 정지 접수(대체 경로)', unsure: '정지 접수 확인 못함 — 현장 확인', failed: '정지 요청 실패 — 현장 확인' };

export function ServerDrive({ c, r }: { c: Ctx; r: Robot }) {
  const l = useLive(r.id), link = rt.link().at, mine = !!l.lease, s = l.state;
  const [move, setMove] = useState<Move | null>(null), [why, setWhy] = useState('');
  const [, tick] = useState(0);
  const held = useRef<Move | null>(null);
  const ready = mine && link === 'open' && s?.connection === 'ONLINE' && s.latched === false && !l.busy;
  const readyRef = useRef(ready); readyRef.current = ready;
  /** 0 으로: 바로 한 번 보내고(조종권이 있으면) 안내를 남긴다. 다시 움직이려면 새로 눌러야 한다 */
  const zero = useRef((note = '') => {
    held.current = null; setMove(null);
    if (rt.get(r.id).lease) rt.cmd(r.id, [0, 0]);
    if (note) setWhy(note);
  }).current;
  const press = (m: Move) => { if (!readyRef.current) return; setWhy(''); held.current = m; setMove(m); };

  useEffect(() => rt.watch(r.id), [r.id]);   // 이 패널이 열린 동안만 조종권을 쥔다(닫으면 반납 — rt)
  useEffect(() => { const i = setInterval(() => tick((n) => n + 1), 250); return () => clearInterval(i); }, []);   // 마지막 응답 ms
  // 50 ms 마다(0 포함 — 조종권 심장 박동 겸). 잠금·넘김 중 0 과 새 중립은 rt.cmd 가 지킨다
  useEffect(() => {
    if (!mine) return;
    const i = setInterval(() => rt.cmd(r.id, held.current ? MOVES[held.current] : [0, 0]), CMD_MS);
    return () => clearInterval(i);
  }, [mine, r.id]);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (typing(e.target)) return;
      if (e.code === 'Space') return zero(SD_NOTE.stop);   // STOP 은 App 머리줄이 보낸다 — 여기는 입력만 먼저 0
      const m = KEY[e.code];
      if (!m || e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      if (!e.repeat) press(m);
    };
    const up = (e: KeyboardEvent) => { if (KEY[e.code] && KEY[e.code] === held.current) zero(); };
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

  const btn = (m: Move) => <button key={m} type="button" className="btn" data-sd-move={m} aria-pressed={move === m} disabled={!ready} style={{ flex: 1, minHeight: 56 }}
    onPointerDown={(e: PointerEvent<HTMLButtonElement>) => { e.currentTarget.setPointerCapture?.(e.pointerId); press(m); }}
    onPointerUp={() => zero()} onPointerCancel={() => zero()} onLostPointerCapture={() => { if (held.current === m) zero(); }}
    onContextMenu={(e) => e.preventDefault()}>{LABEL[m][0]} <b className="mono">{LABEL[m][1]}</b></button>;
  const wait = link !== 'open' ? '서버 연결이 끊겨 조종할 수 없습니다. 다시 연결되면 누르세요.'
    : l.releasing ? '조종권 반납을 확인하는 중입니다.'
    : l.busy ? '로봇 정지를 확인한 뒤 조종권을 받습니다.'
    : l.outgoing ? `${l.holder?.name || '조종하는 사람'}님에게 조종권을 요청했습니다.`
    : l.cooldown > rt.now() ? '잠시 뒤 다시 요청할 수 있습니다.'
    : l.holder?.type === 'RUN' ? '시나리오 실행 중에는 이 시험 화면에서 조종을 시작하지 않습니다.' : '';
  const age = s ? Math.round(rt.now() - l.stateAt) : null, stalled = !!s?.latched && s.safety_reason === 'OUTPUT_STALLED';
  const lock = !s || s.connection !== 'ONLINE' ? { tone: 'off' as const, text: '상태 모름' } : s.latched !== false ? { tone: 'bad' as const, text: '정지 잠금' }
    : !mine ? { tone: 'off' as const, text: '보는 중' } : l.neutral ? { tone: 'ok' as const, text: '움직일 수 있음' } : { tone: 'warn' as const, text: '중립 확인 중' };

  return <section className="card" aria-label="서버 경유 시험 조종" data-server-drive style={{ display: 'flex', flexDirection: 'column', gap: 8, borderColor: 'var(--warn)' }}>
    <div className="fh-row" style={{ flexWrap: 'wrap' }}><Chip tone="warn" text={TRIAL} /><Chip {...lock} /></div>
    <button type="button" className="fh-stop" aria-label="비상 정지 — 이 로봇" data-sd-stop style={{ minHeight: 88, width: '100%' }} onClick={() => { zero(SD_NOTE.stop); rt.stop(r.id); }}>
      <svg width="30" height="30" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 2h8l6 6v8l-6 6H8l-6-6V8z" fill="none" stroke="#FFFFFF" strokeWidth="2" /><rect x="8" y="8" width="8" height="8" fill="#FFFFFF" /></svg>
      <span className="fh-stop-t"><span>STOP</span><small>정지 요청</small></span>
    </button>
    {l.stop && <span className="lbl" role="status" data-sd-stop-phase>{STOP_PHASE[l.stop.phase]}{l.stop.why ? ` — ${l.stop.why}` : ''}</span>}
    <div className="fh-row lbl mono" style={{ flexWrap: 'wrap', gap: 10 }} data-sd-status>
      <span>배터리 {s?.battery?.soc != null ? `${s.battery.soc}%` : '—'}</span>
      <span>속도 {s?.speed != null ? `${s.speed.toFixed(1)} m/s` : '—'}</span>
      <span>잠금 {s?.latched == null ? '모름' : s.latched ? '잠김' : '풀림'}</span>
      <span>지연 {s?.latency_ms != null ? `${s.latency_ms} ms` : '—'}</span>
      <span>마지막 응답 {age != null ? `${age} ms 전` : '없음'}</span>
    </div>
    {mine && s?.latched && <div className="fh-row" style={{ flexWrap: 'wrap' }} data-sd-lock>
      <span>① 정지 확인 — 서버 보고 속도 {s.speed != null ? `${s.speed.toFixed(1)} m/s` : '모름'}</span>
      <span aria-hidden="true">→</span>
      <button type="button" className="btn pri" onClick={() => rt.unlock(r.id)}>② 잠금 해제</button>
    </div>}
    {mine ? <>
      <div className="fh-row" aria-label="조종(누르는 동안만)">{(['left', 'fwd', 'right'] as const).map(btn)}</div>
      <div className="fh-row"><span className="lbl fh-grow">누르는 동안만 0.6 m/s · 회전 ±0.5 rad/s. 떼면 0. 후진·옆걸음 없음</span>
        <button type="button" className="btn" onClick={() => { zero(); rt.release(r.id); }}>조종 끝내기</button></div>
    </> : <DriveButton c={c} r={r} label="조종 시작" wait={wait} onClick={() => { setWhy(''); if (l.holder?.type === 'USER') rt.request(r.id); else rt.take(r.id); }} />}
    {l.releasing?.why && <div className="fh-row" role="status"><span className="fh-why">조종권 반납을 확인하지 못했습니다. {l.releasing.why}</span>
      <button type="button" className="btn" onClick={() => rt.release(r.id)}>다시 시도</button></div>}
    {why && <p className="dv-note" role="status" data-sd-why>{why}</p>}
    {l.notice && <p className="dv-note" role="status">{l.notice}</p>}
    {stalled && <p className="dv-note" role="status">{STALLED}</p>}
  </section>;
}
