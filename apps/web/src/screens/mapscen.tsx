// 지도·시나리오 탭 공용 틀(MAPSCEN-UI 11-02, 방향 = runs/mapscen-diag/preview): 위 단추 줄 하나 + 몸통(왼쪽 도구줄 | 지도 | 오른쪽 작업 창).
// 배치만 — API·권한·저장 규칙은 각 화면(maps·mapedit·missions) 그대로. 폰 틀에는 이 두 탭이 없다(menu.tsx PHONE_TABS).
import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode, type SyntheticEvent } from 'react';
import './mapscen.css';

/** 자물쇠(잠긴 지도·잠긴 시나리오 탭) */
export const Lock = () => <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" style={{ flex: 'none', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 }}><rect x="3" y="7" width="10" height="7" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></svg>;
export type Side = 'map' | 'scen';
/** 오른쪽 창 맨 위 [지도 요소 N | 시나리오 N](MAP-TAB-MERGE 11-03 — 옛 [지도 | 시나리오] 탭 전환을 대신함). lock = 지도 편집 중(시나리오 탭 잠김) */
export const SideTabs = ({ side, set, map, scen, lock }: { side: Side; set: (s: Side) => void; map: ReactNode; scen: ReactNode; lock?: boolean }) =>
  <span className="mx-seg mx-side" role="group" aria-label="오른쪽 창">
    <button type="button" className="btn" aria-pressed={side === 'map'} data-side="map" onClick={() => set('map')}>지도 요소 <span className="mx-n">{map}</span></button>
    <button type="button" className="btn" aria-pressed={side === 'scen'} data-side="scen" aria-disabled={lock || undefined} title={lock ? '지도 편집 중에는 시나리오 탭이 잠깁니다' : undefined}
      onClick={() => { if (!lock) set('scen'); }}>{lock ? <><Lock /> 시나리오</> : <>시나리오 <span className="mx-n">{scen}</span></>}</button>
  </span>;
/** 잠긴 장소 › 건물 › 층(시나리오가 열렸거나 지도 편집 중 — 바꾸지 못함) */
export const Locked = ({ text, why }: { text: string; why: string }) => <span className="btn mx-lock" title={why} aria-label={`지도: ${text} (잠김 — ${why})`} data-locked><Lock /><span className="mx-cut">{text}</span></span>;

/** 단추 줄 드롭다운(details) — 안 내용은 닫혀도 문서에 있다(시험·화면 읽기). end = 오른쪽 끝에 붙여 펼침 */
export function Menu({ label, title, end, children, className }: { label: ReactNode; title?: string; end?: boolean; children: ReactNode; className?: string }) {
  return <details className={`mx-menu${end ? ' end' : ''}${className ? ` ${className}` : ''}`} onToggle={(e) => fit(e.currentTarget)}>
    <summary className="btn" title={title} aria-label={title}><span className="mx-cut">{label}</span></summary>
    <div className="card mx-pop">{children}</div></details>;
}
/** 열 때 펼침을 여는 단추 바로 아래 ~ 화면 아래끝(8px 남김) 안에 가둔다 — 오른쪽 창 안 메뉴(fixed)가 낮은 화면에서 잘리지 않게(#252 B1).
 *  펼침 위끝 = 단추 아래끝 + 6px(absolute 는 top:calc(100% + 6px), fixed 는 margin-top:6px) */
const fit = (d: Element) => {
  const p = d.querySelector<HTMLElement>(':scope>.mx-pop'), s = d.querySelector('summary');
  if (!d.hasAttribute('open') || !p || !s) return;
  if (s.checkVisibility?.() === false) { d.removeAttribute('open'); return; }   // 접힌 창 안(숨김) — 단추 bottom 0 을 저장하지 않고 닫는다, 펼친 뒤 다시 열면 새로 잼(#252 B2)
  const b = s.getBoundingClientRect().bottom;
  if (getComputedStyle(p).position === 'fixed') p.style.top = `${b}px`;
  p.style.maxHeight = `min(72vh, 600px, ${Math.max(0, innerHeight - b - 14)}px)`;
};
/** 메뉴를 닫고 포커스가 그 안에 있었으면 열기 단추(summary)로 — 닫힌 메뉴 안에 포커스가 남지 않게 */
const fold = (d: Element) => { const back = d.contains(document.activeElement); d.removeAttribute('open'); if (back) d.querySelector<HTMLElement>('summary')?.focus(); };
/** 메뉴 항목을 누른 뒤 그 메뉴를 닫는다 */
export const shut = (e: SyntheticEvent) => { const d = (e.currentTarget as Element).closest('details.mx-menu'); if (d) fold(d); };
// 바깥을 누르거나 Esc 면 열린 메뉴를 닫는다(한 번만 거는 창 처리 — 지도 svg 포인터는 그대로 지나감)
if (typeof window !== 'undefined') {
  addEventListener('pointerdown', (e) => { for (const d of document.querySelectorAll('details.mx-menu[open]')) if (!(e.target instanceof Node && d.contains(e.target))) d.removeAttribute('open'); }, true);
  addEventListener('keydown', (e) => { if (e.key === 'Escape') for (const d of document.querySelectorAll('details.mx-menu[open]')) fold(d); });
  addEventListener('resize', () => { for (const d of document.querySelectorAll('details.mx-menu[open]')) fit(d); });   // 열린 채 창 크기가 바뀌어도
}

/** 작은 창(띄움, 모달 아님 — 머리줄 STOP 이 막히지 않게). 안 내용은 닫혀도 문서에 있다(안 양식의 aria-label 은 그대로 쓰게 창 이름은 제목 글로). Esc = 닫기.
 *  닫을 때 포커스가 창 안이면 연 단추로 돌려준다(숨은 칸에 남지 않게) */
export function Pop({ open, close, label, children }: { open: boolean; close: () => void; label: string; children: ReactNode }) {
  const d = useRef<HTMLDialogElement>(null), id = useId(), opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const x = d.current;
    if (!x) return;
    if (open && !x.hasAttribute('open')) {
      opener.current = document.activeElement instanceof HTMLElement && !x.contains(document.activeElement) ? document.activeElement : null;
      x.setAttribute('open', ''); (x.querySelector<HTMLElement>('input,select,textarea') ?? x.querySelector<HTMLElement>('button'))?.focus?.();
    } else if (!open && x.hasAttribute('open')) {
      const back = x.contains(document.activeElement);
      x.removeAttribute('open');
      const o = opener.current;   // 연 단추가 닫힌 메뉴 안이면 그 메뉴 단추로
      if (back && o?.isConnected) (o.closest('details:not([open])')?.querySelector<HTMLElement>('summary') ?? o).focus();
    }
  }, [open]);
  const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  return <dialog ref={d} className="card mx-dlg" aria-labelledby={id} onKeyDown={key}>
    <div className="mx-dlg-head"><b className="fh-grow" id={id}>{label}</b><button type="button" className="btn" aria-label={`${label} 닫기`} onClick={close}>✕</button></div>
    {children}</dialog>;
}

/** 오른쪽 작업 창 — 접으면 세로 막대(«요소 N» + name 한 줄, 넘치면 말줄임), 안 내용은 숨김(unmount 아님). head = 펼친 창 머리(목록 제목 또는 «‹» + 고른 항목, 없으면 줄 없음).
 *  pick = 창 맨 위 줄([지도 요소 | 시나리오] 탭 — MAP-TAB-MERGE 11-03). 접기 단추는 pick 줄 오른쪽 끝(없으면 head 줄). wide = 지도와 반반(시나리오 노드 보기) */
export function Pane({ open, setOpen, bar, head, label, children, pick, name, wide }: { open: boolean; setOpen: (o: boolean) => void; bar: string; head?: ReactNode; label: string; children: ReactNode; pick?: ReactNode; name?: string; wide?: boolean }) {
  const fold = <button type="button" className="btn mx-fold" aria-expanded aria-label={`${bar} 창 접기`} title="창 접기" onClick={() => setOpen(false)}>▸</button>;
  return <aside className="mx-pane" aria-label={label} data-fold={open ? undefined : ''} data-wide={wide ? '' : undefined}>
    {/* 맨 위 줄은 접어도 숨기기만 */}
    <div className="mx-top" hidden={!open}>{pick && <div className="mx-pick">{pick}<span className="fh-grow" />{open && fold}</div>}
      {open && head && <div className="mx-head">{head}{!pick && fold}</div>}</div>
    {!open && <button type="button" className="btn mx-fold" aria-expanded={false} title={name} onClick={() => setOpen(true)}><span>◂ </span><span className="mx-fold-txt">{bar}{name && <span className="mx-fold-name"> · {name}</span>}</span></button>}
    {/* 접어도 안 내용은 숨기기만 한다 — 배정 창 입력·보내는 중 상태·늦은 응답 처리를 잃지 않게(#235 B2) */}
    <div className="mx-pane-in" hidden={!open}>{children}</div>
  </aside>;
}

/** SCEN-ONE-FLOW-R2 11-10 — 노드 «크게 보기»일 때 지도를 노드 위에 띄우는 작은 창(.mx-win). 그 밖(원래 크기·좁은 창·앱)에는 display:contents 라 틀 그대로(mapscen.css).
 *  x·y = 본문(.mx-body) 안 왼쪽 위(null = 왼쪽 아래 — R3 예시 자리), w·h = 크기, fold = 칩으로 접힘. 이 브라우저에만 기억(fh.scen.mapwin — 못 읽거나 망가졌으면 기본값) */
export type Win = { x: number | null; y: number | null; w: number; h: number; fold: boolean };
export const WIN: Win = { x: null, y: null, w: 360, h: 260, fold: false };
const WKEY = 'fh.scen.mapwin', lim = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
/** 본문(bw×bh) 안에 가둠: 크기 220×160 ~ 본문 90%(본문이 작으면 최소 크기), 자리 = 본문 안(자리 없음 = 왼쪽 아래 12px 띄움) */
export const fitWin = (s: Win, bw: number, bh: number): Win & { x: number; y: number } => {
  const w = lim(s.w, 220, bw * 0.9), h = lim(s.h, 160, bh * 0.9);
  return { ...s, w, h, x: lim(s.x ?? 12, 0, bw - w), y: lim(s.y ?? bh - h - 12, 0, bh - h) };
};
type Grip = 'move' | 'nw' | 'se';
/** 끌기(가둔 창 s 에서 dx·dy): move = 옮김, se = 오른쪽 아래 모서리, nw = 왼쪽 위 모서리(오른쪽 아래 끝은 그 자리) */
export const dragWin = (s: Win & { x: number; y: number }, how: Grip, dx: number, dy: number, bw: number, bh: number) => {
  if (how === 'move') return fitWin({ ...s, x: s.x + dx, y: s.y + dy }, bw, bh);
  if (how === 'se') return fitWin({ ...s, w: s.w + dx, h: s.h + dy }, bw, bh);
  const r = s.x + s.w, b = s.y + s.h, n = fitWin({ ...s, w: Math.min(s.w - dx, r), h: Math.min(s.h - dy, b) }, bw, bh);
  return fitWin({ ...n, x: r - n.w, y: b - n.h }, bw, bh);
};
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
export const readWin = (): Win => {
  try { const o = JSON.parse(localStorage.getItem(WKEY) ?? 'null');
    if (o && num(o.w) && num(o.h) && (o.x === null || num(o.x)) && (o.y === null || num(o.y)) && typeof o.fold === 'boolean') return { x: o.x, y: o.y, w: o.w, h: o.h, fold: o.fold };
  } catch { /* 못 읽음 = 기본값 */ }
  return WIN;
};
/** 지도 창: 윗줄(«지도» + 접기)을 끌어 옮김, 왼쪽 위·오른쪽 아래 모서리로 크기, 접으면 «지도 ▴» 칩(창 오른쪽 아래 자리). 본문 크기가 바뀌면 그리면서 다시 가둔다.
 *  끄는 동안 포인터는 이 창이 잡는다(노드 칸 끌기·휠과 섞이지 않음 — 지도 위 휠은 MapFrame 확대). head = 윗줄 단추(«+ 지점»), foot = 창 아래 한 줄(고른 지점 — 창일 때만 보임) */
export function Float({ children, head, foot }: { children: ReactNode; head?: ReactNode; foot?: ReactNode }) {
  const me = useRef<HTMLDivElement>(null), [s, setS] = useState(readWin), [[bw, bh], setB] = useState([0, 0]);
  const grab = useRef<{ how: Grip; px: number; py: number; s0: Win & { x: number; y: number } } | null>(null);
  useEffect(() => {
    const b = me.current?.closest('.mx-body');
    if (!b) return;
    const m = () => { const r = b.getBoundingClientRect(); setB([r.width, r.height]); };
    m();
    if (typeof ResizeObserver === 'undefined') return;
    const o = new ResizeObserver(m); o.observe(b); return () => o.disconnect();
  }, []);
  const f = fitWin(s, bw, bh);
  const keep = (n: Win) => { setS(n); try { localStorage.setItem(WKEY, JSON.stringify(n)); } catch { /* 기억 못 해도 지금 창은 바뀜 */ } };
  const at = (e: PointerEvent<HTMLElement>, g = grab.current!) => dragWin(g.s0, g.how, e.clientX - g.px, e.clientY - g.py, bw, bh);
  const on = (how: Grip) => ({
    onPointerDown: (e: PointerEvent<HTMLElement>) => { if (e.button !== 0 || (e.target as Element).closest('button')) return;
      e.preventDefault(); e.currentTarget.setPointerCapture?.(e.pointerId); grab.current = { how, px: e.clientX, py: e.clientY, s0: f }; },
    onPointerMove: (e: PointerEvent<HTMLElement>) => { if (grab.current) setS(at(e)); },
    onPointerUp: (e: PointerEvent<HTMLElement>) => { if (grab.current) { keep(at(e)); grab.current = null; } },
    onPointerCancel: () => { if (grab.current) { setS(grab.current.s0); grab.current = null; } },
  });
  const px = (n: number) => `${Math.round(n)}px`;
  const vars = { '--wx': px(f.x), '--wy': px(f.y), '--ww': px(f.w), '--wh': px(f.h), '--wr': px(bw - f.x - f.w), '--wb': px(bh - f.y - f.h) } as CSSProperties;
  return <div ref={me} className="mx-win" data-win data-fold={s.fold ? '' : undefined} style={vars}>
    <div className="mx-win-head" {...on('move')}><b>지도</b><span className="fh-grow" />{head}
      <button type="button" className="btn" aria-expanded aria-label="지도 창 접기" title="지도 접기" onClick={() => keep({ ...s, fold: true })}>접기 ▾</button></div>
    {children}
    {foot != null && <p className="mx-win-foot" data-win-foot>{foot}</p>}
    <span className="mx-win-grip" data-grip="nw" aria-hidden="true" title="끌어 크기 조절" {...on('nw')} />
    <span className="mx-win-grip" data-grip="se" aria-hidden="true" title="끌어 크기 조절" {...on('se')} />
    <button type="button" className="btn mx-win-chip" aria-expanded={false} aria-label="지도 창 펼치기" onClick={() => keep({ ...s, fold: false })}>지도 ▴</button>
  </div>;
}

/** 지도 왼쪽 아래 한 줄 안내 + ⓘ(긴 설명은 툴팁) */
export const Hint = ({ text, more }: { text: string; more?: string }) => <p className="mx-hint" role="status" title={more ?? text}>{text}{more && <span aria-hidden="true"> ⓘ</span>}{more && <span className="mx-sr"> {more}</span>}</p>;
