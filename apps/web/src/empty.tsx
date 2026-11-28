// 빈 화면(U11-04 · u11_6 로봇 · u11_7 지도 · u11_8 기록): 선 아이콘 하나 · 제목 · 한 줄 까닭 · 다음 할 일 하나. 생성 그림 · 새 의존성 없음
// 아이콘 선은 lucide(ISC) bot · map · map-pin(층) · history 의 path 를 옮겼다(패키지는 넣지 않음).
import type { ReactNode } from 'react';

const I = (d: JSX.Element) => <svg data-empty-icon width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>;
const ICON = {
  robots: I(<><path d="M12 8V4H8" /><rect width="16" height="12" x="4" y="8" rx="2" /><path d="M2 14h2M20 14h2M15 13v2M9 13v2" /></>),
  map: I(<><path d="M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z" /><path d="M15 5.764v15M9 3.236v15" /></>),
  floor: I(<><path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0" /><circle cx="12" cy="10" r="3" /></>),
  records: I(<><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5M12 7v5l4 2" /></>),
};

/** card = 칸 테두리(lv-card). 지도 칸 안처럼 이미 칸이 있으면 false */
export function Empty({ kind, title, why, card = true, children }: { kind: keyof typeof ICON; title: string; why: string; card?: boolean; children?: ReactNode }) {
  return <section className={card ? 'lv-card fh-empty' : 'fh-empty'} aria-label={title} data-empty={kind}>
    <span className="fh-empty-ic">{ICON[kind]}</span>
    <h2>{title}</h2>
    <p className="lv-note">{why}</p>
    {children && <div className="fh-row">{children}</div>}
  </section>;
}
