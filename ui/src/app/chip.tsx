// 상태 칩·도움말·떠 있는 패널(UI-SIMPLIFY v3 §2-2·§2-3, R3·R5).
// 칩 = [모양 아이콘][짧은 글] + 톤(off 확인된 꺼짐·미지원 / ok / warn 오래됨·미확인·제약 / bad STOP 잠금·위험·연결 손실).
// 색만으로 구분하지 않게 톤마다 모양이 다르다. 이유 전문은 별도 «?» 단추(터치·키보드로 열림) — title 에만 두지 않는다.
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { dropAll } from '../data/link';
import { setDev, useDev } from '../data/dev';
import { InTop, toast } from './shell';
import { DIR_TAG, NOMOVE, RELURCH, SAFE_LINE, SAFE_NOTE, STOP_FACT, STOP_OBS, STOP_TIP, TRIAL_SAFE } from '../data/facts';

export type Tone = 'off' | 'ok' | 'warn' | 'bad';
export const TONE_ICON: Record<Tone, string> = { off: '○', ok: '●', warn: '▲', bad: '■' };

export function Chip({ tone, text, why, whyLabel }: { tone: Tone; text: string; why?: React.ReactNode; whyLabel?: string }) {
  return <span className={`lv-chip ${tone}`} data-tone={tone}>
    <span aria-hidden="true">{TONE_ICON[tone]}</span><span>{text}</span>
    {why != null && <Help label={whyLabel || `${text} · 설명`}>{why}</Help>}
  </span>;
}

/** 닫을 때 연 단추로 초점 — 단추가 문서에서 빠졌거나 안 보이면(숨김·해제) 옮기지 않는다(엉뚱한 곳·STOP 첫 누름 소비 0) */
export function focusBack(e: HTMLElement | null) { if (e && e.isConnected && e.getClientRects().length) e.focus(); }

type Box = { left: number; top: number; right: number; bottom: number };
export type Placed = { left: number; top: number; maxHeight: number };
const GAP = 8, MIN = 40;
/** 팝오버 자리(순수 — 시험용): 화면 안(가장자리 GAP), 보이는 STOP 사각형(+GAP)과 겹침 0.
 *  실제 내용 높이 h 가 들어가는 자리를 단추 바로 아래 → 위 순으로(가로는 단추 정렬 → 왼쪽 끝 → 오른쪽 끝),
 *  어디도 다 안 들어가면 가장 넓은 빈 띠에 줄여서(안은 스크롤). 빈 띠가 MIN 보다 좁으면 null(펼치지 않음) */
export function placePop(trig: Box, h: number, width: number, W: number, H: number, stops: Box[]): Placed | null {
  // R1: STOP 은 화면과 겹친 부분만(완전히 밖이면 무시) — 화면 밖 STOP 이 빈 띠를 화면 밖까지 늘리지 않게
  const vis = stops.map((s) => ({ left: Math.max(0, s.left), top: Math.max(0, s.top), right: Math.min(W, s.right), bottom: Math.min(H, s.bottom) })).filter((s) => s.right > s.left && s.bottom > s.top);
  const lefts = [...new Set([Math.max(GAP * 2, Math.min(trig.left, W - GAP * 2 - width)), GAP * 2, W - GAP * 2 - width])];
  const all: (Placed & { fit: boolean; d: number })[] = [];
  for (const left of lefts) {
    // 이 가로 폭에 걸리는 STOP 의 세로 구간을 빼고 남는 빈 띠
    const cut = vis.filter((s) => s.left - GAP < left + width && s.right + GAP > left).map((s) => [s.top - GAP, s.bottom + GAP]).sort((a, b) => a[0] - b[0]);
    const bands: [number, number][] = []; let y = GAP;
    for (const [a, b] of cut) { if (Math.min(a, H - GAP) > y) bands.push([y, Math.min(a, H - GAP)]); y = Math.max(y, b); }   // 띠는 늘 [GAP, H-GAP] 안
    if (H - GAP > y) bands.push([y, H - GAP]);
    const below = trig.bottom + 6, above = trig.top - 6;
    for (const [a, b] of bands) {
      if (b > below) { const top = Math.max(a, below), av = b - top; all.push({ left, top, maxHeight: av, fit: av >= h, d: top - below + Math.abs(left - lefts[0]) }); }
      if (a < above) { const bot = Math.min(b, above), av = bot - a, fit = av >= h; all.push({ left, top: fit ? bot - h : a, maxHeight: fit ? h : av, fit, d: above - bot + Math.abs(left - lefts[0]) }); }
    }
  }
  const fit = all.filter((c) => c.fit).sort((a, b) => a.d - b.d)[0];
  const best = fit || all.sort((a, b) => b.maxHeight - a.maxHeight)[0];
  if (!best || (!fit && best.maxHeight < MIN)) return null;
  const top = Math.max(GAP, best.top);   // 방어: 외곽(top·top+maxHeight)은 늘 [GAP, H-GAP] 안 — 내용이 커져도 안 스크롤
  return { left: best.left, top, maxHeight: Math.min(best.maxHeight, H - GAP - top) };
}
/** 지금 보이는 STOP 사각형 전부 — «비상 정지»로 시작하는 이름(확대·전체화면 STOP 포함), 활성 전체화면이면 그 안의 것만 */
function stopBoxes(): Box[] {
  const fs = document.fullscreenElement;
  return [...document.querySelectorAll<HTMLElement>('[aria-label^="비상 정지"]')]
    .filter((e) => (!fs || fs === document.documentElement || fs.contains(e)) && (e.checkVisibility?.({ opacityProperty: true, visibilityProperty: true }) ?? true))
    .map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
}

type Pos = Placed & { width: number; ready: boolean };
/** 단추 옆에 떠 있는 패널 공용: 열 때 누르던 입력 폐기(dropAll, 송신 0) · Escape·바깥 누름·크기/스크롤/전체화면 바뀜이면 닫힘.
 *  바깥 누름은 막지 않는다(기본 동작 취소 0). 자리는 실제 내용 높이를 잰 뒤(보이지 않게 한 번 그림) placePop 으로 —
 *  보이는 STOP 어느 것과도 겹치지 않게 놓아 STOP 첫 누름이 늘 STOP 에 닿는다. 자리가 없으면 펼치지 않고 알림.
 *  Escape 로 닫으면 연 단추로 초점(focusBack). 활성 전체화면이면 그 안, 아니면 body 에 그린다(Help = InTop — transform 조상 영향 0). */
export function usePop(maxW: number) {
  const [pos, setPos] = useState<Pos | null>(null);
  const b = useRef<HTMLButtonElement>(null), p = useRef<HTMLElement>(null);
  const open = () => {
    dropAll();
    const width = Math.min(maxW, innerWidth - GAP * 4);
    setPos({ left: GAP * 2, top: 0, maxHeight: innerHeight, width, ready: false });
  };
  const close = (focus: boolean) => { setPos(null); if (focus) focusBack(b.current); };
  useLayoutEffect(() => {   // 그리기 전: 실제 높이를 재고 자리 확정
    if (!pos || pos.ready || !p.current || !b.current) return;
    const h = Math.ceil(p.current.getBoundingClientRect().height), at = placePop(b.current.getBoundingClientRect(), h, pos.width, innerWidth, innerHeight, stopBoxes());
    if (!at) { setPos(null); toast('화면에 펼칠 자리가 없습니다 — 화면을 키우거나 돌린 뒤 다시'); return; }
    setPos({ ...at, width: pos.width, ready: true });
  }, [pos]);
  useEffect(() => {
    if (!pos) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') close(true); };
    const out = (e: Event) => { const t = e.target as Node; if (!p.current?.contains(t) && !b.current?.contains(t)) close(false); };
    const shut = () => close(false);
    addEventListener('keydown', k); addEventListener('pointerdown', out, true); addEventListener('resize', shut); addEventListener('scroll', out, true); document.addEventListener('fullscreenchange', shut);
    return () => { removeEventListener('keydown', k); removeEventListener('pointerdown', out, true); removeEventListener('resize', shut); removeEventListener('scroll', out, true); document.removeEventListener('fullscreenchange', shut); };
  }, [pos]);
  return { pos, b, p, toggle: () => (pos ? close(false) : open()), close,
    style: pos ? { left: pos.left, top: pos.top, width: pos.width, maxHeight: pos.ready ? pos.maxHeight : undefined, visibility: pos.ready ? undefined : 'hidden' as const } : undefined };
}

/** «?» 도움말 — 전문은 닫혀 있어도 DOM(hidden)에 남아 aria-controls 로 이어진다(지워서 금지어 검사를 통과시키지 않음). */
export function Help({ label, children }: { label: string; children: React.ReactNode }) {
  const P = usePop(320), id = useId();
  return <span className="lv-help">
    <button ref={P.b} type="button" className="lv-q" aria-label={label} aria-expanded={!!P.pos} aria-controls={id} onClick={P.toggle}>?</button>
    <InTop><span id={id} ref={P.p as React.RefObject<HTMLSpanElement>} role="note" className="lv-pop" hidden={!P.pos} style={P.style}>{children}</span></InTop>
  </span>;
}

/** U2 안전 한 줄(조종 영역마다 늘 보임) + 별도 ? — STOP_TIP·STOP_FACT·RELURCH 상세는 ? 안. STOP 첫 누름과 분리된 단추(설명 팝오버가 STOP 을 대신하지 않음) */
export function SafeLine({ className = '', style }: { className?: string; style?: React.CSSProperties }) {
  return <span className={`lv-safe ${className}`.trim()} role="note" data-safe="1" style={style}><span>{SAFE_LINE}</span>
    <Help label="STOP·정지 특성 설명"><span style={{ display: 'block' }}>{STOP_TIP}</span>
      <span style={{ display: 'block', marginTop: 6 }}>{SAFE_NOTE}</span>
      {[0, 2].map((i) => <span key={i} style={{ display: 'block', marginTop: 4 }}>{`${STOP_FACT[i]} → ${STOP_FACT[i + 1]}`}</span>)}
      <span style={{ display: 'block', marginTop: 4 }}>{`주의: ${RELURCH}`}</span>
      <span style={{ display: 'block', marginTop: 4 }}>{TRIAL_SAFE}</span></Help></span>;
}
/** 통신 끊김 동작 ? — PcPlan·PcSettings 공용(같은 글). SAFE_NOTE·STOP_OBS·STOP_FACT 두 쌍·RELURCH 전문 */
export const LostHelp = () => <Help label="통신 끊김 동작 · 설명"><span style={{ display: 'block' }}>{SAFE_NOTE}</span>{[STOP_OBS, `${STOP_FACT[0]} → ${STOP_FACT[1]}`, `${STOP_FACT[2]} → ${STOP_FACT[3]}`, `주의: ${RELURCH}`].map((t) => <span key={t} style={{ display: 'block', marginTop: 4 }}>{t}</span>)}</Help>;
/** 막힌 방향 꼬리표(앞·앞+회전만) + ? NOMOVE — 허용 범위는 서버가 정한다(표시만) */
export const DirTag = () => <span className="lv-dirtag">{DIR_TAG}<Help label={`${DIR_TAG} · 설명`}>{NOMOVE}</Help></span>;

/** 머리줄 안 «개발자» 표시 — 켜졌을 때만. 누르면 끈다(공용 폰에서 알아보고 바로 끌 수 있게). 켜기는 설정·폰 서랍·주소 ?dev=1 */
export function DevMark() {
  return useDev((s) => s.on) ? <button type="button" className="lv-devmark" aria-label="개발자 모드 켜짐 · 누르면 끔" onClick={() => toast(setDev(false) || '개발자 모드 끔')}>개발자</button> : null;
}
/** 개발자 모드 켜기/끄기 스위치(설정·폰 서랍 공용) */
export function DevSwitch({ text }: { text?: boolean }) {
  const on = useDev((s) => s.on), go = () => toast(setDev(!on));
  return text ? <button type="button" role="switch" aria-checked={on} onClick={go}>{`개발자 모드: ${on ? '켜짐' : '꺼짐'} (눌러 바꾸기 · 진단 표시만)`}</button>
    : <button type="button" className="sw" role="switch" aria-checked={on} aria-label="개발자 모드" onClick={go}><span /></button>;
}
