// 4칸 보기(ui/src/app/Quad.tsx·Cloud3D.tsx 에서 옮김 — 옛 link/dropAll/toast 는 가져오지 않음).
// f = null 이면 2×2, 아니면 그 칸이 크게 + 나머지 3칸은 오른쪽 세로 작은 칸. 칸 머리 단추로만 바꾼다(그림 위 끌기 — 지도 이동·3D 회전 — 와 겹치지 않게).
// 작은 칸을 숨기면(›) 그 칸 내용을 내려 media 구독도 놓는다(display:none 만으로는 받기가 계속됨).
// 큰 칸일 때만 «전체화면»(이 묶음만 Fullscreen API). 전체화면은 머리줄 STOP 을 가리므로 fs(STOP)를 그 안에 늘 둔다.
// first = 처음부터 크게 볼 칸(PC 로봇 탭 세 칸 화면 — 큰 1 + 작은 3). 주면 «4분할 ↔ 큰 화면» 단추가 위 줄에 붙는다.
// onLeave = 전체화면을 벗어나는 순간(단추·4분할·Esc·브라우저) — 조종 입력 0(RV-397 1). onShown = 지금 그려지는 칸 id(안 보이는 칸이 쓰는 구독을 놓게, RV-397 4).
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { feedText, useFeed, type Feed } from './media';
import './quad.css';

export type QSize = 'grid' | 'big' | 'thumb';
/** held = 큰 칸일 때 머리줄에 붙일 «마지막 그림 · N초 전»(큰 칸 오른쪽 위는 작은 칸이 가림 — RV-435 ②).
 *  머리줄 오른쪽은 보통 보기에선 «전체화면» 단추(.qfs-bar), 전체화면에선 첫 작은 칸(--tw)이 덮으므로 그만큼 비워 둔다(RV-440 ③) */
export type QTile = { id: string; label: string; held?: string; body: (s: QSize) => ReactNode };

/** 보통 보기 큰 칸 머리줄에서 «전체화면» 단추(오른쪽 44px + 단추 폭)를 피할 자리 — 12px 글자 기준 */
export const HELD_GAP = '8em';

export function Quad({ tiles, label, fs, top, first, onLeave, onShown }: { tiles: QTile[]; label: string; fs: ReactNode; top?: ReactNode; first?: string; onLeave?: () => void; onShown?: (ids: string[]) => void }) {
  const [f, setF] = useState<string | null>(first ?? null), [pip, setPip] = useState(true), [full, setFull] = useState(false), [err, setErr] = useState('');
  const root = useRef<HTMLDivElement>(null), was = useRef(false), leave = useRef(onLeave); leave.current = onLeave;
  const exit = () => { leave.current?.(); document.exitFullscreen().catch(() => {}); };
  useEffect(() => {   // 전체화면 들어감/나옴(Esc·브라우저 단추 포함)
    const ch = () => { const on = !!root.current && document.fullscreenElement === root.current; if (was.current && !on) leave.current?.(); was.current = on; setFull(on); };
    document.addEventListener('fullscreenchange', ch); return () => document.removeEventListener('fullscreenchange', ch);
  }, []);
  useEffect(() => { if (!f && root.current && document.fullscreenElement === root.current) exit(); }, [f]);   // 2×2 로 돌아가면 전체화면도 끝
  const goFull = async () => {
    setErr('');
    try { if (!root.current?.requestFullscreen) throw new Error('이 브라우저는 지원 안 함'); await root.current.requestFullscreen(); }
    catch (e) { setErr(`전체화면 안 됨(${(e as Error).message || e}) — 큰 칸으로 보입니다`); }
  };
  const others = f ? tiles.filter((t) => t.id !== f).map((t) => t.id) : [];
  const shown = (f && !pip ? [f] : tiles.map((t) => t.id)).join();
  useEffect(() => { onShown?.(shown.split(',')); }, [shown]);
  return <div ref={root} className={`qd${f ? ' f' : ''}${f && !pip ? ' nopip' : ''}`} role="group" aria-label={label} data-qfull={full ? '1' : undefined}>
    {tiles.map((t) => {
      const s: QSize = !f ? 'grid' : f === t.id ? 'big' : 'thumb', pi = others.indexOf(t.id);
      return <div key={t.id} className={`qt${s === 'big' ? ' on' : ''}${s === 'thumb' ? ` pip p${pi}` : ''}`} data-tile={t.id}>
        <button type="button" className="qh" aria-pressed={s === 'big'} title={s === 'big' ? '4칸으로 돌아가기' : '이 칸 크게 보기'} onClick={() => setF((x) => (x === t.id ? null : t.id))}>
          <span>{t.label}</span>{s === 'big' && t.held && <span data-feed-held style={{ marginLeft: 'auto', marginRight: !full ? HELD_GAP : pip ? 'var(--tw)' : 0, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 400, color: 'var(--muted)' }}>{t.held}</span>}<span aria-hidden="true">{s === 'big' ? '⤡' : '⤢'}</span></button>
        <div className="qb">{s === 'thumb' && !pip ? null : t.body(s)}</div>
      </div>;
    })}
    {f && <button type="button" className="qpip" aria-pressed={pip} aria-label={pip ? '작은 칸 숨기기' : '작은 칸 보이기'} onClick={() => setPip(!pip)}><span aria-hidden="true">{pip ? '›' : '‹'}</span></button>}
    {/* 전체화면 단추와 STOP 은 한 줄(flex)에 나란히 — 서로 덮지 않는다(RV-397 3) */}
    {f && <div className="qfs-bar" data-qfs-stop={full ? '' : undefined}>
      <button type="button" className="btn qfs" aria-pressed={full} title={full ? '전체화면 끝내기(Esc)' : '이 묶음만 화면 전체로 · STOP 은 안에 그대로'}
        onClick={() => (full ? exit() : goFull())}>{full ? '전체화면 끝' : '전체화면'}</button>
      {full && fs}</div>}
    {(top || err || first) && <div className="qd-top">{first && <button type="button" className="btn" aria-pressed={!f} data-q-grid onClick={() => setF(f ? null : first)}>{f ? '4분할' : '큰 화면 1 + 작은 3'}</button>}
      {err && <span className="fh-why" role="status">{err}</span>}{top}</div>}
  </div>;
}

/** 칸 안 빈 상태 한 줄(가짜 그림 0 — 이유만) */
export const QEmpty = ({ text }: { text: string }) => <div className="qd-empty" role="status">{text}</div>;

/** 점 높이 색 범위(센서 기준 z, m) — 범례와 같은 식 */
const ZL = -1, ZH = 1;
export const hue = (z: number) => Math.round(200 - Math.max(0, Math.min(1, (z - ZL) / (ZH - ZL))) * 170);
/** 3D 점군(Canvas2D 정사영 — three 없이). 바뀐 때만 2 Hz 로 다시 그림, 끌기는 화면 한 장(requestAnimationFrame)에 한 번만. 큰 칸만 끌어 돌려 봄(작은 칸은 폰 스크롤 그대로). 그림만 — 명령 0.
 *  lidar 는 이 칸이 떠 있는 동안만 받는다 */
export function Cloud3D({ small, big, feed: given, empty: none = '' }: { small: boolean; big: boolean; feed?: Feed; empty?: string }) {
  // given = 다른 곳에서 받은 점군(서버 경유 시험 — drivemedia.ts) + 빈 칸 문구. 없으면 폰 직결 media 를 이 칸이 받는다
  const own = useFeed('lidar', !given), feed = given ?? own, empty = given ? none : feedText(feed, 'lidar');
  const cv = useRef<HTMLCanvasElement>(null), view = useRef({ a: -0.6, b: 0.9, ver: -1, w: 0, h: 0 }), cur = useRef(feed);
  cur.current = feed;
  useEffect(() => {
    const el = cv.current!, v = view.current;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1, W = el.clientWidth, H = el.clientHeight, c = cur.current;
      v.ver = c.ver; v.w = W; v.h = H;
      const g = W && H ? el.getContext('2d') : null;
      if (!g) return;
      if (el.width !== Math.round(W * dpr) || el.height !== Math.round(H * dpr)) { el.width = Math.round(W * dpr); el.height = Math.round(H * dpr); }
      g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
      if (!c.n) return;
      // 센서 원점 중심(pose 없음 — README «L1 sensor frame»). ±11 m 쯤 보임
      const s = Math.min(W, H) / 22, ca = Math.cos(v.a), sa = Math.sin(v.a), cb = Math.cos(v.b), sb = Math.sin(v.b);
      const proj = (x: number, y: number, z: number) => { const X = x * ca - y * sa, Y = x * sa + y * ca; return [W / 2 + X * s, H / 2 - (z * cb + Y * sb) * s]; };
      const step = Math.max(1, Math.ceil(c.n / (small ? 6000 : 60000))), r = small ? 1 : 1.6;
      for (let i = 0; i < c.n; i += step) {
        const z = c.xyz[i * 3 + 2], [u, w] = proj(c.xyz[i * 3], c.xyz[i * 3 + 1], z);
        if (u < 0 || w < 0 || u > W || w > H) continue;
        const e = c.edge?.[i] ? 2.5 : 1;   // 모서리 점(RB-LIDAR-EDGEWEB) = 더 밝고 크게
        g.fillStyle = `hsl(${hue(z)} 80% ${e > 1 ? 82 : 60}%)`; g.fillRect(u - r * e / 2, w - r * e / 2, r * e, r * e);
      }
      const [u, w] = proj(0, 0, 0), [u2, w2] = proj(0.6, 0, 0);   // 센서 원점 + 앞(x) 방향
      g.strokeStyle = '#fff'; g.lineWidth = 2; g.beginPath(); g.arc(u, w, 4, 0, 7); g.moveTo(u, w); g.lineTo(u2, w2); g.stroke();
    };
    const t = setInterval(() => { if (cur.current.ver !== v.ver || el.clientWidth !== v.w || el.clientHeight !== v.h) draw(); }, 500);   // 갱신 2 Hz
    let d: null | { id: number; x: number; y: number; a: number; b: number } = null, raf = 0;
    const down = (e: PointerEvent) => { if (small || d) return; d = { id: e.pointerId, x: e.clientX, y: e.clientY, a: v.a, b: v.b }; try { el.setPointerCapture(e.pointerId); } catch { /* 없음 */ } };
    const move = (e: PointerEvent) => { if (!d || e.pointerId !== d.id) return; v.a = d.a + (e.clientX - d.x) * 0.01; v.b = Math.max(0, Math.min(1.5, d.b + (e.clientY - d.y) * 0.01)); raf ||= requestAnimationFrame(() => { raf = 0; draw(); }); };
    const end = (e?: PointerEvent) => { if (d && (!e || e.pointerId === d.id)) d = null; };
    const vis = () => { if (document.hidden) end(); };
    el.addEventListener('pointerdown', down); el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end); el.addEventListener('lostpointercapture', end); document.addEventListener('visibilitychange', vis);
    draw();
    return () => {
      clearInterval(t); cancelAnimationFrame(raf); el.removeEventListener('pointerdown', down); el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', end); el.removeEventListener('pointercancel', end); el.removeEventListener('lostpointercapture', end); document.removeEventListener('visibilitychange', vis);
    };
  }, [small]);
  const label = feed.frame === 'map' ? '지도 기준 누적' : (feed.frame as string) === 'odom' ? '켠 곳 기준 누적' : 'L1 센서 기준 1스캔 · 지도 누적 아님';
  return <div style={{ position: 'absolute', inset: 0 }} data-cloud={feed.n}>
    <canvas ref={cv} style={{ width: '100%', height: '100%', display: 'block', touchAction: small ? 'auto' : 'none' }} aria-label={`3D 점군 — ${label}${small ? '' : '(끌어서 돌려 보기)'}`} />
    {empty ? <QEmpty text={empty} /> : big && <div className="qd-legend" aria-label="점 높이 범례">
      <div style={{ height: 8, borderRadius: 2, background: `linear-gradient(90deg, ${[0, 0.25, 0.5, 0.75, 1].map((t) => `hsl(${hue(ZL + t * (ZH - ZL))} 80% 60%)`).join(',')})` }} />
      <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>{`${ZL} m`}</span><span>0</span><span>{`+${ZH} m`}</span></div>
      <div>{`색 = 센서 기준 높이 · ${label} · 점 ${feed.n}${feed.truncated ? '(상한으로 일부)' : ''}`}</div></div>}
  </div>;
}
