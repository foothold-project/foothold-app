// 관제 4분할: 상태 하나(f = null 이면 2×2, 아니면 그 칸이 큰 영역 + 나머지 3칸은 큰 영역 «안» 오른쪽 세로 PIP 오버레이).
// 칸 누름 → 그 칸 크게 · PIP(작은 칸) 누름 → 큰 칸 교체 · 큰 칸 본문 다시 누름 → 2×2. 오른쪽 화살표 버튼 = PIP 숨김/다시 보이기.
// 키보드는 칸 머리 버튼(aria-pressed, Enter = click). 큰 칸일 때만 «전체화면»(이 묶음만 Fullscreen API, 안에 STOP). DOM 은 다시 만들지 않음(CSS grid 겹침).
// 누름 판정(10-14 단순화 — 호환 click 에 기대지 않음): 같은 pointerId 의 pointerup 에서 판정.
//   무효 = 칸 안 버튼·select·입력·링크·[data-noquad] 에서 시작 · up 전 누적 최대 이동 > 6 px(지도 끌기·3D 회전 — 원점에 돌아와도 무효)
//         · 두 번째 손가락 · pointercancel · 마우스 왼쪽 아님 · blur/pagehide/숨김.
//   전환 직후 500 ms 의 click 은 이 묶음 안에서 삼킴(바뀐 배치 아래 버튼에 번지지 않게 — 새 pointerdown 이 오면 해제). 전환·접기마다 dropAll(누르던 입력 폐기).
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { dropAll } from '../data/link';
import { toast } from './shell';

export type QSize = 'grid' | 'big' | 'thumb';
export type QTile = { id: string; label: string; body: (s: QSize) => ReactNode };
const SKIP = 'button,a,select,input,textarea,label,[data-noquad]', SLOP = 6, MUTE_MS = 500;
type Down = { id: number; tile: string; x: number; y: number; max: number; bad: boolean };
/** 누름 판정(순수): up 까지 누적 최대 이동·떼는 순간 이동(dx,dy)·남은 손가락 수 */
export const tapOk = (d: { max: number; bad: boolean }, dx: number, dy: number, others: number) => !d.bad && !others && Math.max(d.max, Math.hypot(dx, dy)) <= SLOP;

// 10-15 ① 큰 칸 높이: 고정 min(62vh,620px) 대신 «화면에서 남는 높이 전부» — 큰 칸으로 바꿀 때 카드 머리가 고정 머리줄 바로 아래 오게 스크롤하고,
//   큰 칸 본문 높이 = 창 높이 − (고정 머리줄 + 카드 머리 + 칸 머리) − 여백. 브라우저 전체화면(«전체화면» 버튼) = 이 묶음만 화면 전체, 안에 STOP(fs) 상시.
//   영상·지도는 object-fit contain·캔버스 다시 그림이라 비율 왜곡·임의 자르기 0.
const MIN_H = 120;   // 짧은 창(844×390)에서도 남는 높이보다 크지 않게 — 최소값 때문에 다시 잘리는 일 0(그 이하 창은 미검증)
export function Quad({ tiles, label, fs }: { tiles: QTile[]; label: string; fs?: ReactNode }) {
  const [f, setF] = useState<string | null>(null), [pip, setPip] = useState(true), [full, setFull] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const down = useRef<Down | null>(null), live = useRef(new Set<number>()), mute = useRef(0);
  const ids = tiles.map((t) => t.id).join();
  useEffect(() => { setF((x) => (x && ids.split(',').includes(x) ? x : null)); }, [ids]);   // 칸 구성이 바뀌면(실기↔시뮬) 2×2 로
  const flip = (id: string) => { dropAll(); setF((x) => (x === id ? null : id)); };
  useEffect(() => {   // 전체화면 들어감/나옴(Esc·브라우저 버튼 포함) → 상태 맞춤 + 누르던 입력 폐기
    const ch = () => { dropAll(); setFull(!!root.current && document.fullscreenElement === root.current); };
    document.addEventListener('fullscreenchange', ch); return () => document.removeEventListener('fullscreenchange', ch);
  }, []);
  useEffect(() => { if (!f && document.fullscreenElement && document.fullscreenElement === root.current) document.exitFullscreen().catch(() => {}); }, [f]);   // 2×2 로 돌아가면 전체화면도 끝
  useLayoutEffect(() => {   // 큰 칸 높이 = 남는 화면 높이(전체화면이면 CSS 가 100vh 기준)
    const el = root.current; if (!f || !el) return;
    const card = el.parentElement || el, hd = document.querySelector('header');
    const hh = () => (hd && /sticky|fixed/.test(getComputedStyle(hd).position) ? hd.getBoundingClientRect().height : 0);
    const fit = () => {
      const qb = el.querySelector<HTMLElement>('.qt.on .qb'); if (!qb || full) return;
      const off = hh() + 8 + (qb.getBoundingClientRect().top - card.getBoundingClientRect().top) + 10;   // 머리줄 + 틈 + (카드 머리·칸 머리) + 아래 여백
      el.style.setProperty('--qbh', `${Math.max(MIN_H, Math.floor(innerHeight - off))}px`);
    };
    fit(); card.style.scrollMarginTop = `${hh() + 8}px`; if (!full) card.scrollIntoView({ block: 'start' });
    addEventListener('resize', fit); visualViewport?.addEventListener('resize', fit);
    return () => { removeEventListener('resize', fit); visualViewport?.removeEventListener('resize', fit); };
  }, [f, full]);
  const goFull = async () => {
    dropAll(); const el = root.current;
    try { if (!el?.requestFullscreen) throw new Error('이 브라우저는 지원 안 함'); await el.requestFullscreen(); }
    catch (e) { toast(`전체화면 안 됨(${(e as Error).message || e}) — 큰 칸은 화면 남는 높이로 보입니다`); }
  };
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
  return <div ref={root} className={`qd${f ? ' f' : ''}${f && !pip ? ' nopip' : ''}${tiles.length === 2 ? ' two' : ''}`} role="group" aria-label={label} data-qfull={full ? '1' : undefined}
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
    {f && <button type="button" className="lv-btn qfs" aria-pressed={full} title={full ? '전체화면 끝내기(Esc)' : '이 묶음만 화면 전체로 · STOP 은 안에 그대로'}
      onClick={() => (full ? document.exitFullscreen().catch(() => {}) : goFull())}>{full ? '전체화면 끝' : '전체화면'}</button>}
    {full && fs && <div className="qfs-stop">{fs}</div>}
  </div>;
}

/** 칸 안 빈 상태 한 줄(가짜 값 0 — 이유만) */
export const QEmpty = ({ text }: { text: string }) => <div className="qd-empty">{text}</div>;
