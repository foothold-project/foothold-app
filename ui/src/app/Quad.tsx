// 관제 4분할: 상태 하나(f = null 이면 2×2, 아니면 그 칸이 큰 영역 + 나머지 3칸은 큰 영역 «안» 오른쪽 세로 PIP 오버레이).
// 칸 누름 → 그 칸 크게 · PIP(작은 칸) 누름 → 큰 칸 교체 · 큰 칸 본문 다시 누름 → 2×2. 오른쪽 화살표 버튼 = PIP 숨김/다시 보이기.
// 키보드는 칸 머리 버튼(aria-pressed, Enter = click). 페이지 배치만 바꿈(전체화면 API 안 씀). DOM 은 다시 만들지 않음(CSS grid 겹침).
// 누름 판정(10-14 단순화 — 호환 click 에 기대지 않음): 같은 pointerId 의 pointerup 에서 판정.
//   무효 = 칸 안 버튼·select·입력·링크·[data-noquad] 에서 시작 · up 전 누적 최대 이동 > 6 px(지도 끌기·3D 회전 — 원점에 돌아와도 무효)
//         · 두 번째 손가락 · pointercancel · 마우스 왼쪽 아님 · blur/pagehide/숨김.
//   전환 직후 500 ms 의 click 은 이 묶음 안에서 삼킴(바뀐 배치 아래 버튼에 번지지 않게 — 새 pointerdown 이 오면 해제). 전환·접기마다 dropAll(누르던 입력 폐기).
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { dropAll } from '../data/link';

export type QSize = 'grid' | 'big' | 'thumb';
export type QTile = { id: string; label: string; body: (s: QSize) => ReactNode };
const SKIP = 'button,a,select,input,textarea,label,[data-noquad]', SLOP = 6, MUTE_MS = 500;
type Down = { id: number; tile: string; x: number; y: number; max: number; bad: boolean };
/** 누름 판정(순수): up 까지 누적 최대 이동·떼는 순간 이동(dx,dy)·남은 손가락 수 */
export const tapOk = (d: { max: number; bad: boolean }, dx: number, dy: number, others: number) => !d.bad && !others && Math.max(d.max, Math.hypot(dx, dy)) <= SLOP;

export function Quad({ tiles, label }: { tiles: QTile[]; label: string }) {
  const [f, setF] = useState<string | null>(null), [pip, setPip] = useState(true);
  const down = useRef<Down | null>(null), live = useRef(new Set<number>()), mute = useRef(0);
  const ids = tiles.map((t) => t.id).join();
  useEffect(() => { setF((x) => (x && ids.split(',').includes(x) ? x : null)); }, [ids]);   // 칸 구성이 바뀌면(실기↔시뮬) 2×2 로
  const flip = (id: string) => { dropAll(); setF((x) => (x === id ? null : id)); };
  useEffect(() => {   // move/up/cancel 은 창 전체에서(지도 canvas 가 pointer capture 해도·칸 밖에서 떼도 셈)
    const move = (e: PointerEvent) => { const d = down.current; if (d && e.pointerId === d.id) d.max = Math.max(d.max, Math.hypot(e.clientX - d.x, e.clientY - d.y)); };
    const up = (e: PointerEvent) => {
      live.current.delete(e.pointerId);
      const d = down.current; if (!d || e.pointerId !== d.id) return;
      down.current = null;
      if (!tapOk(d, e.clientX - d.x, e.clientY - d.y, live.current.size)) return;
      mute.current = performance.now() + MUTE_MS; flip(d.tile);
    };
    const cancel = (e: PointerEvent) => { live.current.delete(e.pointerId); if (down.current) down.current.bad = true; };
    const reset = () => { live.current.clear(); down.current = null; };   // HOME·숨김·창 떠남: up/cancel 이 안 올 수 있음 → 비워 복귀 첫 탭이 막히지 않게
    const vis = () => { if (document.hidden) reset(); };
    window.addEventListener('pointermove', move, true); window.addEventListener('pointerup', up, true); window.addEventListener('pointercancel', cancel, true);
    window.addEventListener('blur', reset); window.addEventListener('pagehide', reset); document.addEventListener('visibilitychange', vis);
    return () => {
      window.removeEventListener('pointermove', move, true); window.removeEventListener('pointerup', up, true); window.removeEventListener('pointercancel', cancel, true);
      window.removeEventListener('blur', reset); window.removeEventListener('pagehide', reset); document.removeEventListener('visibilitychange', vis);
    };
  }, []);
  const others = f ? tiles.filter((t) => t.id !== f).map((t) => t.id) : [];
  return <div className={`qd${f ? ' f' : ''}${f && !pip ? ' nopip' : ''}${tiles.length === 2 ? ' two' : ''}`} role="group" aria-label={label}
    onPointerDownCapture={() => { mute.current = 0; }} onKeyDownCapture={() => { mute.current = 0; }}   // 새 누름 = 그 뒤 click 은 사용자가 의도한 것(삼키는 건 전환한 그 누름의 호환 click 뿐)
    onClickCapture={(e) => { if (performance.now() < mute.current) { e.preventDefault(); e.stopPropagation(); } }}>
    {tiles.map((t) => {
      const s: QSize = !f ? 'grid' : f === t.id ? 'big' : 'thumb', pi = others.indexOf(t.id);
      return <div key={t.id} className={`qt${s === 'big' ? ' on' : ''}${s === 'thumb' ? ` pip p${pi}` : ''}`} title={s === 'thumb' ? `${t.label} — 눌러 크게` : undefined}
        onPointerDown={(e) => {
          if (e.isPrimary) live.current.clear();   // 첫 손가락·마우스 = 새 누름: 놓친 up 으로 남은 옛 id 버림
          live.current.add(e.pointerId);
          if (live.current.size === 1) down.current = { id: e.pointerId, tile: t.id, x: e.clientX, y: e.clientY, max: 0,
            bad: (e.pointerType === 'mouse' && e.button !== 0) || !!(e.target as Element).closest(SKIP) };
          else if (down.current) down.current.bad = true;                                  // 두 번째 손가락 = 이 누름 무효
        }}>
        <button type="button" className="qh" aria-pressed={s === 'big'} title={s === 'big' ? '4분할로 돌아가기' : '이 칸 크게 보기'} onClick={() => flip(t.id)}>
          <span>{t.label}</span><span aria-hidden="true">{s === 'big' ? '⤡' : '⤢'}</span></button>
        <div className="qb">{t.body(s)}</div>
      </div>;
    })}
    {f && <button type="button" className="qpip" aria-pressed={pip} aria-label={pip ? '작은 칸 숨기기' : '작은 칸 보이기'} title={pip ? '작은 칸 숨기기' : '작은 칸 보이기'}
      onClick={() => { dropAll(); setPip(!pip); }}><span aria-hidden="true">{pip ? '›' : '‹'}</span></button>}
  </div>;
}

/** 칸 안 빈 상태 한 줄(가짜 값 0 — 이유만) */
export const QEmpty = ({ text }: { text: string }) => <div className="qd-empty">{text}</div>;
