// 브라우저 시뮬 창(RB-WEBSIM-PIP 11-11 현민님): PC 웹 «시뮬 열기»·«시뮬에서 실행»은 페이지를 떠나지 않고 시뮬(/sim/, 같은 출처)을 앱 안에 띄운다.
// 처음엔 화면 가득 → 시뮬의 집 단추 = 끝내지 않고 작은 창(구석, 머리줄을 끌어 옮김) → «크게 보기»·«닫기»(= 시뮬 끝 — 시뮬 쪽 pagehide 가 잠근다).
// 작은 창 동안 시뮬 칸은 inert(누름·키 0) + 시뮬에 알려 손 조종 입력을 놓는다(mobile/sim/main.js handsOff(): 손 조종 = 잠금, 시나리오 실행 = 계속).
// 작은 창 크기(RB-SIMWIN-RESIZE 11-12 현민님): 모서리 손잡이를 끌어(또는 화살표 키) 폭을 바꾸고 높이는 16:9 그대로. 손잡이는 화면에 여유가 많은 쪽 모서리에 놓이고 반대쪽 모서리는 제자리,
// 최소 240px·최대 화면 안. 시뮬 그림은 창에 맞춰 커지고 줄어든다(폭 700 화면을 줄여 그림 — 그보다 큰 창은 제 크기). 크게 보기 → 다시 작은 창이면 마지막 크기·자리 그대로.
// 창 상태는 메모리뿐 — 새로고침·로그아웃(App 내림)·폰 틀로 바뀜이면 사라진다. 폰 틀·앱 안은 이 창을 안 올려 옛 그대로 페이지 이동.
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';

type Win = { url: string; small: boolean; dead?: boolean };
/** 크기 끌기 한 번: 처음 폭·누른 자리, 창 테두리 몫(pad)·시뮬 칸 밖 높이(extra), 제자리에 둘 모서리(ax, ay), 손잡이가 오른쪽(r)·아래(d)인가 */
type Pull = { w: number; x: number; y: number; pad: number; extra: number; ax: number; ay: number; r: boolean; d: boolean };
const MIN_W = 240, VIEW_W = 700;   // 시뮬 칸 폭이 VIEW_W 보다 좁으면 그 폭의 화면을 줄여 그린다(기본 창 = 옛 그대로 반)
let win: Win | null = null, hosts = 0;
const subs = new Set<() => void>();
const set = (w: Win | null) => { win = w; subs.forEach((f) => f()); };
export const simWin = {
  get: () => win,
  /** 시뮬 창이 올라와 있나(PC 웹) — 링크는 이때만 가로채 창으로 연다 */
  hosted: () => hosts > 0,
  /** 시뮬 열기: 창이 올라와 있으면(PC 웹) 그 안에, 아니면(폰 틀·앱 안) 옛 그대로 페이지 이동 */
  go: (url: string) => { if (hosts) set({ url, small: false }); else simWin.leave(url); },
  leave: (url: string) => location.assign(url),   // 시험이 바꿔 끼움
  close: () => set(null),
};

export function SimWindow() {
  const w = useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => win);
  const frame = useRef<HTMLIFrameElement>(null), [at, setAt] = useState<[number, number] | null>(null), grab = useRef<[number, number] | null>(null);
  const [size, setSize] = useState<[number, number] | null>(null), [corner, setCorner] = useState('tr'), pull = useRef<Pull | null>(null);   // size = [창 폭, 시뮬 그림 배율], corner = 손잡이 모서리(기본 자리 = 왼쪽 아래 → 오른쪽 위)
  useEffect(() => { hosts++; return () => { hosts--; set(null); }; }, []);
  const up = !!w, small = !!w?.small;
  const shrink = (dead?: boolean) => { if (win) set({ ...win, small: true, dead: dead || win.dead }); };
  useEffect(() => {
    if (!up) return;
    // 시뮬 집 단추 → 작은 창(그 시뮬 칸이 보낸 것만). 가득일 때 브라우저 «뒤로» = 아래 탭만 바뀌어 안 보이므로 작은 창으로
    const msg = (e: MessageEvent) => { if (e.origin === location.origin && e.source === frame.current?.contentWindow && e.data?.fhSim === 'small') shrink(); };
    const back = () => { if (win && !win.small) shrink(); };
    addEventListener('message', msg); addEventListener('popstate', back);
    return () => { removeEventListener('message', msg); removeEventListener('popstate', back); };
  }, [up]);
  useEffect(() => {
    const f = frame.current; if (!f) return;
    f.inert = small;
    // 작은 창 = 초점을 시뮬 칸 밖(작은 창 단추)으로 옮겨 키가 시뮬로 가지 않게 + 시뮬에 알림. 가득 = 키 조종이 시뮬로
    if (small) { f.closest('aside')?.querySelector<HTMLElement>('button:not(:disabled)')?.focus(); f.contentWindow?.postMessage({ fhSim: 'small' }, location.origin); } else f.focus();
  }, [up, small]);
  if (!w) return null;
  // 시뮬이 뜨지 못했으면(집 단추가 준비 안 됨 — 파일 없음·읽기 실패) 가득 화면에 갇히지 않게 작은 창 + 닫기만
  const loaded = () => { const f = frame.current; let ok = false;
    try { ok = !!f?.contentDocument?.querySelector('#home[data-small]'); } catch { /* 다른 출처로 나감 */ }
    if (!ok) shrink(true); else if (!win?.small) f!.focus(); };
  const down = (e: PointerEvent<HTMLElement>) => { const b = e.currentTarget.parentElement!.getBoundingClientRect(); grab.current = [e.clientX - b.left, e.clientY - b.top]; e.currentTarget.setPointerCapture?.(e.pointerId); };
  const move = (e: PointerEvent<HTMLElement>) => {
    const g = grab.current, b = e.currentTarget.parentElement!; if (!g) return;
    setAt([Math.max(0, Math.min(innerWidth - b.offsetWidth, e.clientX - g[0])), Math.max(0, Math.min(innerHeight - b.offsetHeight, e.clientY - g[1]))]);
  };
  /** 손잡이는 화면에 여유가 많은 쪽 모서리로(오른쪽 끝에 붙은 창 = 왼쪽 손잡이, 아래 끝 = 위 손잡이) */
  const place = (el: HTMLElement) => { const b = el.parentElement!.getBoundingClientRect(); setCorner((b.top + b.height / 2 < innerHeight / 2 ? 'b' : 't') + (b.left + b.width / 2 < innerWidth / 2 ? 'r' : 'l')); };
  const drop = (e: PointerEvent<HTMLElement>) => { grab.current = null; place(e.currentTarget); };
  const begin = (el: HTMLElement, x = 0, y = 0): Pull => {
    const b = el.parentElement!.getBoundingClientRect(), v = frame.current!.parentElement!, r = corner[1] === 'r', d = corner[0] === 'b';
    return { w: b.width, x, y, pad: b.width - v.offsetWidth, extra: b.height - v.offsetHeight, ax: r ? b.left : b.right, ay: d ? b.top : b.bottom, r, d };
  };
  /** 폭을 정한다: 최소 MIN_W, 최대 = 제자리 모서리에서 화면 끝까지(높이 16:9 포함) — 화면 밖 막기가 최소보다 먼저 */
  const fit = (p: Pull, want: number) => {
    const max = Math.min(p.r ? innerWidth - p.ax : p.ax, ((p.d ? innerHeight - p.ay : p.ay) - p.extra) * 16 / 9 + p.pad);
    const wd = Math.round(Math.min(max, Math.max(MIN_W, want))), h = p.extra + (wd - p.pad) * 9 / 16;
    setAt([p.r ? p.ax : p.ax - wd, p.d ? p.ay : p.ay - h]); setSize([wd, Math.min(1, (wd - p.pad) / VIEW_W)]);
  };
  // 끄는 동안 포인터는 손잡이가 잡고(capture) 시뮬 칸은 작은 창 내내 inert 라 시뮬이 포인터를 먹지 않는다
  const zDown = (e: PointerEvent<HTMLElement>) => { pull.current = begin(e.currentTarget, e.clientX, e.clientY); e.currentTarget.setPointerCapture?.(e.pointerId); };
  const zMove = (e: PointerEvent<HTMLElement>) => { const p = pull.current; if (!p) return;
    const dx = (e.clientX - p.x) * (p.r ? 1 : -1), dy = (e.clientY - p.y) * (p.d ? 1 : -1) * 16 / 9; fit(p, p.w + (Math.abs(dx) > Math.abs(dy) ? dx : dy)); };   // 가로·세로 중 더 많이 끈 쪽
  const zDrop = (e: PointerEvent<HTMLElement>) => { if (pull.current) { pull.current = null; place(e.currentTarget); } };
  const zKey = (e: KeyboardEvent<HTMLElement>) => { const d = ({ ArrowRight: 24, ArrowUp: 24, ArrowLeft: -24, ArrowDown: -24 } as Record<string, number>)[e.key];
    if (d) { e.preventDefault(); const p = begin(e.currentTarget); fit(p, p.w + d); } };
  return <aside className="sw" aria-label={small ? '시뮬 작은 창' : '시뮬'} data-sim-win={small ? 'small' : 'full'}
    style={small ? { ...(at && { left: at[0], top: at[1], bottom: 'auto' }), ...(size && { width: size[0], '--sw-k': size[1] }) } as CSSProperties : undefined}>
    {small && <p className="sw-t" role="status" title="끌어서 옮기기" data-sim-win-bar onPointerDown={down} onPointerMove={move} onPointerUp={drop} onPointerCancel={drop}>
      {w.dead ? '시뮬을 열지 못했습니다 — 닫고 다시 열어 주세요' : '시뮬 · 작은 창에서는 조종하지 않습니다'}</p>}
    <div className="sw-v"><iframe ref={frame} src={w.url} title="시뮬" data-sim-win-frame onLoad={loaded} /></div>
    {small && <div className="sw-row">
      <button type="button" className="btn" disabled={w.dead} data-sim-win-big onClick={() => set({ ...w, small: false })}>크게 보기</button>
      <button type="button" className="btn" data-sim-win-close onClick={simWin.close}>닫기</button>
    </div>}
    {small && <button type="button" className="sw-z" aria-label="크기 조절" title="끌어서 크기 조절" data-sim-win-size={corner}
      onPointerDown={zDown} onPointerMove={zMove} onPointerUp={zDrop} onPointerCancel={zDrop} onKeyDown={zKey} />}
  </aside>;
}
