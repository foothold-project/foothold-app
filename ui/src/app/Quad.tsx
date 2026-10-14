// 관제 4분할: 상태 하나(f = null 이면 2×2, 아니면 그 칸 크게 + 나머지 3칸 작게). 칸을 누르면 그 칸이 커지고,
// 작은 칸을 누르면 그 칸으로 바뀌고, 큰 칸을 다시 누르면 2×2. 키보드는 칸 머리 버튼(aria-pressed).
// 칸 안 버튼·select·입력·링크·[data-noquad]·드래그(6 px 넘음)·두 손가락·취소된 누름은 확대 누름으로 먹지 않는다(같은 pointerId 하나만 판정).
// 지도 칸도 일반 누름 = 확대 토글(관제 지도는 점 찍기 화면이 아님 — 점 찍는 지도를 넣으려면 그 도구 안에서만 받고 이 칸 토글은 끌 것).
// 전환마다 dropAll(누르던 입력 폐기 — 낡은 누름 복원 0). 페이지 배치만 바꿈(전체화면 API 안 씀). DOM 은 다시 만들지 않음(CSS order·grid).
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { dropAll } from '../data/link';

export type QSize = 'grid' | 'big' | 'thumb';
export type QTile = { id: string; label: string; body: (s: QSize) => ReactNode };
const SKIP = 'button,a,select,input,textarea,label,[data-noquad]';

export function Quad({ tiles, label }: { tiles: QTile[]; label: string }) {
  const [f, setF] = useState<string | null>(null), down = useRef<{ id: number; x: number; y: number; bad: boolean } | null>(null), live = useRef(new Set<number>());
  const ids = tiles.map((t) => t.id).join();
  useEffect(() => { setF((x) => (x && ids.split(',').includes(x) ? x : null)); }, [ids]);   // 칸 구성이 바뀌면(실기↔시뮬) 2×2 로
  useEffect(() => {   // 손 뗌·취소는 창 전체에서 셈(칸 밖에서 떼도 남지 않게 — 남으면 이후 탭이 전부 «두 손가락»으로 막힘)
    const up = (e: PointerEvent) => { live.current.delete(e.pointerId); }, cancel = (e: PointerEvent) => { up(e); if (down.current) down.current.bad = true; };
    const reset = () => { live.current.clear(); down.current = null; };   // HOME·숨김·창 떠남: up/cancel 이 안 올 수 있음 → 비워 복귀 첫 탭이 막히지 않게(유령 click 은 down 없음 = 무시)
    const vis = () => { if (document.hidden) reset(); };
    window.addEventListener('pointerup', up, true); window.addEventListener('pointercancel', cancel, true);
    window.addEventListener('blur', reset); window.addEventListener('pagehide', reset); document.addEventListener('visibilitychange', vis);
    return () => {
      window.removeEventListener('pointerup', up, true); window.removeEventListener('pointercancel', cancel, true);
      window.removeEventListener('blur', reset); window.removeEventListener('pagehide', reset); document.removeEventListener('visibilitychange', vis);
    };
  }, []);
  const flip = (id: string) => { dropAll(); setF((x) => (x === id ? null : id)); };
  return <div className={`qd${f ? ' f' : ''}`} role="group" aria-label={label}>
    {tiles.map((t) => {
      const s: QSize = !f ? 'grid' : f === t.id ? 'big' : 'thumb';
      return <div key={t.id} className={`qt${s === 'big' ? ' on' : ''}`}
        onPointerDown={(e) => {
          if (e.isPrimary) live.current.clear();   // 첫 손가락·마우스 = 새 누름: 놓친 up 으로 남은 옛 id 버림(남으면 이후 탭이 «두 손가락»으로 막힘)
          live.current.add(e.pointerId);
          if (live.current.size === 1) down.current = { id: e.pointerId, x: e.clientX, y: e.clientY, bad: false };
          else if (down.current) down.current.bad = true;                                  // 두 번째 손가락 = 이 누름 무효
        }}
        onClick={(e) => {
          const d = down.current; down.current = null;                                    // 누름 기록 없이 온 click(유령)도 무시
          if (!d || d.bad || live.current.size || (e.target as Element).closest(SKIP) || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6) return;
          flip(t.id);
        }}>
        <button type="button" className="qh" aria-pressed={s === 'big'} title={s === 'big' ? '4분할로 돌아가기' : '이 칸 크게 보기'} onClick={() => flip(t.id)}>
          <span>{t.label}</span><span aria-hidden="true">{s === 'big' ? '⤡' : '⤢'}</span></button>
        <div className="qb">{t.body(s)}</div>
      </div>;
    })}
  </div>;
}

/** 칸 안 빈 상태 한 줄(가짜 값 0 — 이유만) */
export const QEmpty = ({ text }: { text: string }) => <div className="qd-empty">{text}</div>;
