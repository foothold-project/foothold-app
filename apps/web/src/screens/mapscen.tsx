// 지도·시나리오 탭 공용 틀(MAPSCEN-UI 11-02, 방향 = runs/mapscen-diag/preview): 위 단추 줄 하나 + 몸통(왼쪽 도구줄 | 지도 | 오른쪽 작업 창).
// 배치만 — API·권한·저장 규칙은 각 화면(maps·mapedit·missions) 그대로. 폰 틀에는 이 두 탭이 없다(menu.tsx PHONE_TABS).
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode, type SyntheticEvent } from 'react';
import './mapscen.css';

/** [지도 | 시나리오] — 주소 링크라 App 의 나가기 확인(leaving.ask)을 그대로 탄다 */
export const ScreenTabs = ({ cur }: { cur: 'map' | 'mission' }) => <nav className="mx-seg" aria-label="지도·시나리오">
  {([['map', '지도'], ['mission', '시나리오']] as const).map(([id, t]) => <a key={id} className="btn" href={`#/${id}`} aria-current={cur === id ? 'true' : undefined}>{t}</a>)}</nav>;

/** 단추 줄 드롭다운(details) — 안 내용은 닫혀도 문서에 있다(시험·화면 읽기). end = 오른쪽 끝에 붙여 펼침 */
export function Menu({ label, title, end, children, className }: { label: ReactNode; title?: string; end?: boolean; children: ReactNode; className?: string }) {
  return <details className={`mx-menu${end ? ' end' : ''}${className ? ` ${className}` : ''}`}>
    <summary className="btn" title={title} aria-label={title}><span className="mx-cut">{label}</span></summary>
    <div className="card mx-pop">{children}</div></details>;
}
/** 메뉴를 닫고 포커스가 그 안에 있었으면 열기 단추(summary)로 — 닫힌 메뉴 안에 포커스가 남지 않게 */
const fold = (d: Element) => { const back = d.contains(document.activeElement); d.removeAttribute('open'); if (back) d.querySelector<HTMLElement>('summary')?.focus(); };
/** 메뉴 항목을 누른 뒤 그 메뉴를 닫는다 */
export const shut = (e: SyntheticEvent) => { const d = (e.currentTarget as Element).closest('details.mx-menu'); if (d) fold(d); };
// 바깥을 누르거나 Esc 면 열린 메뉴를 닫는다(한 번만 거는 창 처리 — 지도 svg 포인터는 그대로 지나감)
if (typeof window !== 'undefined') {
  addEventListener('pointerdown', (e) => { for (const d of document.querySelectorAll('details.mx-menu[open]')) if (!(e.target instanceof Node && d.contains(e.target))) d.removeAttribute('open'); }, true);
  addEventListener('keydown', (e) => { if (e.key === 'Escape') for (const d of document.querySelectorAll('details.mx-menu[open]')) fold(d); });
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

/** 오른쪽 작업 창 — 접으면 세로 막대(«요소 N»). head = 펼친 창 머리(목록 제목 또는 «‹» + 고른 항목) */
export function Pane({ open, setOpen, bar, head, label, children }: { open: boolean; setOpen: (o: boolean) => void; bar: string; head: ReactNode; label: string; children: ReactNode }) {
  return <aside className="mx-pane" aria-label={label} data-fold={open ? undefined : ''}>
    {open ? <><div className="mx-head">{head}<button type="button" className="btn mx-fold" aria-expanded aria-label={`${bar} 창 접기`} title="창 접기" onClick={() => setOpen(false)}>▸</button></div>{children}</>
      : <button type="button" className="btn mx-fold" aria-expanded={false} onClick={() => setOpen(true)}>◂ {bar}</button>}
  </aside>;
}

/** 지도 왼쪽 아래 한 줄 안내 + ⓘ(긴 설명은 툴팁) */
export const Hint = ({ text, more }: { text: string; more?: string }) => <p className="mx-hint" role="status" title={more ?? text}>{text}{more && <span aria-hidden="true"> ⓘ</span>}{more && <span className="mx-sr"> {more}</span>}</p>;
