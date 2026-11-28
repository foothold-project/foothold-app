// 로봇 탭 타일 (u5_4 · u12_1). 총괄 로봇 목록 위에 로봇마다 타일 하나.
// 경고 타일(끊김 · 잠금 · 오류 = 빨강, 배터리 낮음 · 일시정지 · 넘어짐 의심 · 서버 주의 = 주황)이 앞으로 오고 테두리 · 머리 글로 강조한다.
// 타일을 누르거나 Enter · Space 로 뒤집으면 Go2 정면 상태(자세 그림 · 기울기 · 가장 뜨거운 관절). 보기 전용: 로봇 명령 · STOP 없음.
// 값은 목록 요약과 실시간 state 에 있는 것만 쓴다. 없으면 «서버에 값 없음» 이고 짓지 않는다(서 있는 그림 · 영상 자리 포함).
// 움직임(경고 타일이 앞으로 옮겨 가기 · 뒤집기)은 prefers-reduced-motion 이면 끈다.
import { useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ownerName, robotStatus, type Robot } from '../fake';
import { rt, useRt } from '../rt';
import { pickInfo, sdeg } from '../go2status';
import { REPORT_STALE_MS, go2Pose, go2Temps } from '../pcdrive';
import { Go2Figure, JOINTS, jointName } from '../go2model';
import { Chip, attn, linkText } from '../screens';
import './robottiles.css';

const NONE = '서버에 값 없음';
type Warn = { level: 'bad' | 'warn'; text: string } | null;

/** 경고 단계와 까닭. 빨강 = robotStatus 빨강, 주황 = robotStatus 주황 · 넘어짐 의심 · 서버 주의 코드 */
export function tileWarn(x: Robot): Warn {
  const s = robotStatus(x);
  if (s.tone === 'bad') return { level: 'bad', text: s.text };
  if (s.tone === 'warn') return { level: 'warn', text: s.text };
  if (pickInfo(x)?.v?.fallen) return { level: 'warn', text: '넘어짐 의심' };
  const a = attn(x);
  return a ? { level: 'warn', text: a } : null;
}
const rank = (x: Robot) => { const l = tileWarn(x)?.level; return l === 'bad' ? 0 : l === 'warn' ? 1 : 2; };
/** 경고 타일 먼저(빨강 → 주황 → 나머지), 같은 단계 안에서는 받은 순서 그대로 */
export const tileOrder = (robots: Robot[]) => robots.map((x, i) => ({ x, i, k: rank(x) })).sort((a, b) => a.k - b.k || a.i - b.i).map((v) => v.x);

const REDUCE = '(prefers-reduced-motion: reduce)';
const reduced = () => typeof matchMedia === 'function' && matchMedia(REDUCE).matches;
function useReduced() {
  return useSyncExternalStore((f) => {
    if (typeof matchMedia !== 'function') return () => {};
    const m = matchMedia(REDUCE); m.addEventListener?.('change', f);
    return () => m.removeEventListener?.('change', f);
  }, reduced, () => false);
}

/** 실시간 state(구독 로봇)에서만: 신선할 때의 자세 · 관절 온도 · 지연. 목록 요약의 옛 값으로 지금 자세를 그리지 않는다 */
function live(id: string) {
  const l = rt.get(id), s = l.state, fresh = !!s && rt.now() - l.stateAt < REPORT_STALE_MS, ago = s ? (rt.now() - l.stateAt) / 1000 : 0;
  return { pose: go2Pose(s, fresh), temps: go2Temps(s, fresh, ago), ms: fresh && s?.connection === 'ONLINE' ? s.latency_ms ?? null : null };
}
const hotText = (t: ReturnType<typeof go2Temps>) => (t && t.hot >= 0 ? `${Math.round(t.joints[t.hot]!)}°C · ${jointName(JOINTS[t.hot])}` : NONE);

const Fact = ({ k, label, children }: { k: string; label: string; children: ReactNode }) =>
  <div className="rt-fact" data-tile-fact={k}><span className="lbl">{label}</span><strong>{children}</strong></div>;

function Tile({ x, flipped, flip, open }: { x: Robot; flipped: boolean; flip: () => void; open: () => void }) {
  const w = tileWarn(x), s = robotStatus(x), v = pickInfo(x)?.v ?? null, { pose, temps, ms } = live(x.id);
  const hide = (h: boolean) => (h ? { 'aria-hidden': true as const, inert: '' } : {});
  const pos = !v ? NONE : v.fallen ? '넘어짐 의심' : v.fallen === false ? '넘어지지 않음' : NONE;
  const tilt = v && (v.roll != null || v.pitch != null) ? `roll ${sdeg(v.roll) ?? '모름'} · pitch ${sdeg(v.pitch) ?? '모름'}` : NONE;
  return <>
    {w && <p className="rt-warn" data-tile-warn>경고 · {w.text}</p>}
    <div className="rt-card" data-tile-card role="button" tabIndex={0} aria-pressed={flipped} aria-label={`${x.name} ${flipped ? '앞면 보기' : '정면 상태 보기'}`}
      onClick={flip} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } }}>
      <div className="rt-face rt-front" data-face="front" {...hide(flipped)}>
        <div className="rt-media" data-tile-media><span className="lbl">뒤 1 m 영상 · {NONE}</span></div>
        <div className="rt-head"><strong className="rt-name">{x.name}</strong><Chip {...s} /></div>
        <div className="rt-facts">
          <Fact k="mission" label="임무">{x.mission ?? '임무 없음'}</Fact>
          <Fact k="battery" label="배터리">{x.battery == null ? NONE : `${x.battery}%`}</Fact>
          <Fact k="temp" label="최고 관절 온도">{hotText(temps)}</Fact>
          <Fact k="link" label="연결">{linkText(x)}{ms != null && <small className="lbl"> {ms} ms</small>}</Fact>
          <Fact k="owner" label="담당">{ownerName(x)}</Fact>
        </div>
      </div>
      <div className="rt-face rt-back" data-face="back" {...hide(!flipped)}>
        <div className="rt-head"><strong className="rt-name">{x.name}</strong><span className="lbl">정면 상태</span></div>
        <div className={pose ? 'rt-stage pd-stage' : 'rt-stage'}>{pose
          ? <div className="rt-figure" data-tile-figure>{flipped && <Go2Figure pose={pose} showJoints={false} temps={temps?.joints} />}</div>
          : <p className="rt-nopose lbl" data-tile-nopose>정면 자세 · {NONE}</p>}</div>
        <div className="rt-facts">
          <Fact k="pose" label="자세">{pos}</Fact>
          <Fact k="tilt" label="기울기">{tilt}</Fact>
          <Fact k="hot" label="최고 관절 온도">{hotText(temps)}</Fact>
        </div>
      </div>
    </div>
    <button type="button" className="btn rt-open" data-tile-open onClick={open}>자세히</button>
  </>;
}

/** 총괄 로봇 탭 타일 묶음. open = 기존 서랍 상세 열기(fleet.tsx Admin 의 open) */
export function RobotTiles({ robots, open }: { robots: Robot[]; open: (id: string) => void }) {
  useRt();
  const list = tileOrder(robots), warns = list.filter((x) => tileWarn(x)).length, reduce = useReduced();
  const [flip, setFlip] = useState<Record<string, boolean>>({}), [all, setAll] = useState(false);
  const ul = useRef<HTMLUListElement>(null), last = useRef(new Map<string, { left: number; top: number }>()), lastKey = useRef('');
  const key = list.map((x) => x.id).join();
  // FLIP: 순서가 바뀐 그림에서만, 지난 자리 → 새 자리 차이만큼 옮겨 둔 뒤 다음 틀에서 풀어 미끄러지게(움직임 줄이기면 바로 새 자리).
  // 자리는 묶음(ul) 기준이라 쪽 넘김 · 실시간 갱신으로는 움직이지 않는다
  useLayoutEffect(() => {
    if (!ul.current) return;
    const base = ul.current.getBoundingClientRect(), moved = lastKey.current !== key, now = new Map<string, { left: number; top: number }>();
    for (const li of ul.current.querySelectorAll<HTMLElement>('[data-robot-tile]')) {
      const id = li.dataset.robotTile!, b = li.getBoundingClientRect(), r = { left: b.left - base.left, top: b.top - base.top }, p = last.current.get(id);
      now.set(id, r);
      if (!moved) continue;
      li.style.transition = ''; li.style.transform = '';
      if (reduce || !p) continue;
      const dx = p.left - r.left, dy = p.top - r.top;
      if (!dx && !dy) continue;
      li.style.transform = `translate(${dx}px, ${dy}px)`;
      requestAnimationFrame(() => { li.style.transition = 'transform .32s ease'; li.style.transform = ''; });
    }
    last.current = now; lastKey.current = key;
  });
  const flipAll = () => { const to = !all; setAll(to); setFlip(Object.fromEntries(list.map((x) => [x.id, to]))); };
  return <section className="rt-wrap" aria-label="로봇 타일">
    <div className="fh-row rt-bar"><h3 className="rt-title">타일</h3>{warns > 0 && <span className="rt-count" data-tiles-count>경고 {warns}</span>}<span className="fh-grow" />
      <button type="button" className="btn" data-tiles-flip aria-pressed={all} onClick={flipAll}>{all ? '앞면으로' : '정면 상태로 뒤집기'}</button></div>
    <ul className="rt-tiles" data-tiles data-motion={reduce ? 'reduce' : 'on'} ref={ul}>
      {list.map((x) => { const w = tileWarn(x), f = flip[x.id] ?? false;
        return <li key={x.id} className="rt-tile" data-robot-tile={x.id} data-warn={w?.level} data-flipped={f || undefined}>
          <Tile x={x} flipped={f} flip={() => setFlip((m) => ({ ...m, [x.id]: !f }))} open={() => open(x.id)} />
        </li>; })}
    </ul>
    <p className="lv-note">보기 전용입니다. 타일을 누르거나 Enter · Space 로 Go2 정면 상태를 봅니다. 상세는 «자세히».</p>
  </section>;
}
