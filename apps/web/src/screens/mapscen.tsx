// 지도·시나리오 탭 공용 틀(MAPSCEN-UI 11-02, 방향 = runs/mapscen-diag/preview): 위 단추 줄 하나 + 몸통(왼쪽 도구줄 | 지도 | 오른쪽 작업 창).
// 배치만 — API·권한·저장 규칙은 각 화면(maps·mapedit·missions) 그대로. 폰 틀에는 이 두 탭이 없다(menu.tsx PHONE_TABS).
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode, type SyntheticEvent } from 'react';
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

/** 지도 왼쪽 아래 한 줄 안내 + ⓘ(긴 설명은 툴팁) */
export const Hint = ({ text, more }: { text: string; more?: string }) => <p className="mx-hint" role="status" title={more ?? text}>{text}{more && <span aria-hidden="true"> ⓘ</span>}{more && <span className="mx-sr"> {more}</span>}</p>;
