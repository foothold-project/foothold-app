// 상태 칩·도움말·떠 있는 패널(UI-SIMPLIFY v3 §2-2·§2-3, R3·R5).
// 칩 = [모양 아이콘][짧은 글] + 톤(off 확인된 꺼짐·미지원 / ok / warn 오래됨·미확인·제약 / bad STOP 잠금·위험·연결 손실).
// 색만으로 구분하지 않게 톤마다 모양이 다르다. 이유 전문은 별도 «?» 단추(터치·키보드로 열림) — title 에만 두지 않는다.
import { useEffect, useId, useRef, useState } from 'react';
import { dropAll } from '../data/link';
import { setDev, useDev } from '../data/dev';
import { toast } from './shell';

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
type Pos = { left: number; top: number; width: number; maxHeight: number };
/** 단추 아래 떠 있는 패널 공용: 열 때 누르던 입력 폐기(dropAll, 송신 0) · Escape·바깥 누름·크기 바뀜이면 닫힘.
 *  바깥 누름은 막지 않는다(기본 동작 취소 0) — 열린 채 STOP 을 눌러도 첫 누름이 STOP 으로 간다.
 *  Escape 로 닫으면 연 단추로 초점 — 단추가 문서에서 빠졌거나 안 보이면 초점을 옮기지 않는다.
 *  위치는 화면 안(가로 넘침 0)·아래쪽 STOP 위에서 끝남(Drawer 와 같은 기준). */
export function usePop(maxW: number) {
  const [pos, setPos] = useState<Pos | null>(null);
  const b = useRef<HTMLButtonElement>(null), p = useRef<HTMLElement>(null);
  const open = () => {
    dropAll();
    const r = b.current!.getBoundingClientRect(), width = Math.min(maxW, innerWidth - 32), top = r.bottom + 6;
    const stops = [...document.querySelectorAll('[aria-label="비상 정지"]')].map((e) => e.getBoundingClientRect()).filter((s) => s.width && s.top > top).map((s) => s.top);
    setPos({ left: Math.max(16, Math.min(r.left, innerWidth - 16 - width)), top, width, maxHeight: Math.max(120, (stops.length ? Math.min(...stops) - 8 : innerHeight - 12) - top) });
  };
  const close = (focus: boolean) => { setPos(null); if (focus) focusBack(b.current); };
  useEffect(() => {
    if (!pos) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') close(true); };
    const out = (e: PointerEvent) => { const t = e.target as Node; if (!p.current?.contains(t) && !b.current?.contains(t)) close(false); };
    const shut = () => close(false);
    addEventListener('keydown', k); addEventListener('pointerdown', out, true); addEventListener('resize', shut);
    return () => { removeEventListener('keydown', k); removeEventListener('pointerdown', out, true); removeEventListener('resize', shut); };
  }, [pos]);
  return { pos, b, p, toggle: () => (pos ? close(false) : open()), close, style: pos ? { left: pos.left, top: pos.top, width: pos.width, maxHeight: pos.maxHeight } : undefined };
}

/** «?» 도움말 — 전문은 닫혀 있어도 DOM(hidden)에 남아 aria-controls 로 이어진다(지워서 금지어 검사를 통과시키지 않음). */
export function Help({ label, children }: { label: string; children: React.ReactNode }) {
  const P = usePop(320), id = useId();
  return <span className="lv-help">
    <button ref={P.b} type="button" className="lv-q" aria-label={label} aria-expanded={!!P.pos} aria-controls={id} onClick={P.toggle}>?</button>
    <span id={id} ref={P.p as React.RefObject<HTMLSpanElement>} role="note" className="lv-pop" hidden={!P.pos} style={P.style}>{children}</span>
  </span>;
}

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
