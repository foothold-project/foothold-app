// 브라우저 시뮬 창(RB-WEBSIM-PIP 11-11 현민님): PC 웹 «시뮬 열기»·«시뮬에서 실행»은 페이지를 떠나지 않고 시뮬(/sim/, 같은 출처)을 앱 안에 띄운다.
// 처음엔 화면 가득 → 시뮬의 집 단추 = 끝내지 않고 작은 창(구석, 머리줄을 끌어 옮김) → «크게 보기»·«닫기»(= 시뮬 끝 — 시뮬 쪽 pagehide 가 잠근다).
// 작은 창 동안 시뮬 칸은 inert(누름·키 0) + 시뮬에 알려 손 조종 입력을 놓는다(mobile/sim/main.js handsOff(): 손 조종 = 잠금, 시나리오 실행 = 계속).
// 창 상태는 메모리뿐 — 새로고침·로그아웃(App 내림)·폰 틀로 바뀜이면 사라진다. 폰 틀·앱 안은 이 창을 안 올려 옛 그대로 페이지 이동.
import { useEffect, useRef, useState, useSyncExternalStore, type PointerEvent } from 'react';

type Win = { url: string; small: boolean; dead?: boolean };
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
  const drop = () => { grab.current = null; };
  return <aside className="sw" aria-label={small ? '시뮬 작은 창' : '시뮬'} data-sim-win={small ? 'small' : 'full'}
    style={small && at ? { left: at[0], top: at[1], bottom: 'auto' } : undefined}>
    {small && <p className="sw-t" role="status" title="끌어서 옮기기" data-sim-win-bar onPointerDown={down} onPointerMove={move} onPointerUp={drop} onPointerCancel={drop}>
      {w.dead ? '시뮬을 열지 못했습니다 — 닫고 다시 열어 주세요' : '시뮬 · 작은 창에서는 조종하지 않습니다'}</p>}
    <div className="sw-v"><iframe ref={frame} src={w.url} title="시뮬" data-sim-win-frame onLoad={loaded} /></div>
    {small && <div className="sw-row">
      <button type="button" className="btn" disabled={w.dead} data-sim-win-big onClick={() => set({ ...w, small: false })}>크게 보기</button>
      <button type="button" className="btn" data-sim-win-close onClick={simWin.close}>닫기</button>
    </div>}
  </aside>;
}
