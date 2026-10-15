// 상태 칩·도움말(UI-SIMPLIFY v3 §2-3, R3·R5) — U1-a 기반. 화면별 적용은 U1-b~U5.
// 칩 = [모양 아이콘][짧은 글] + 톤(off 확인된 꺼짐·미지원 / ok / warn 오래됨·미확인·제약 / bad STOP 잠금·위험·연결 손실).
// 색만으로 구분하지 않게 톤마다 모양이 다르다. 이유 전문은 별도 «?» 단추(터치·키보드로 열림) — title 에만 두지 않는다.
import { useEffect, useId, useRef, useState } from 'react';
import { dropAll } from '../data/link';
import { useDev } from '../data/dev';
import { InFs } from './shell';

export type Tone = 'off' | 'ok' | 'warn' | 'bad';
export const TONE_ICON: Record<Tone, string> = { off: '○', ok: '●', warn: '▲', bad: '■' };

export function Chip({ tone, text, why, whyLabel }: { tone: Tone; text: string; why?: React.ReactNode; whyLabel?: string }) {
  return <span className={`lv-chip ${tone}`} data-tone={tone}>
    <span aria-hidden="true">{TONE_ICON[tone]}</span><span>{text}</span>
    {why != null && <Help label={whyLabel || `${text} · 설명`}>{why}</Help>}
  </span>;
}

/** «?» 도움말: 열 때 누르던 입력 폐기(dropAll, 송신 0). Escape·바깥 누름으로 닫고 Escape 면 단추로 초점 복귀.
 *  바깥 누름은 막지 않는다(기본 동작 취소 0) — 열린 채 STOP 을 눌러도 첫 누름이 STOP 으로 간다.
 *  전문은 닫혀 있어도 DOM(hidden)에 남아 aria-controls 로 이어진다(지워서 금지어 검사를 통과시키지 않음). */
export function Help({ label, children }: { label: string; children: React.ReactNode }) {
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);
  const b = useRef<HTMLButtonElement>(null), p = useRef<HTMLSpanElement>(null), id = useId();
  const open = () => {
    dropAll();
    const r = b.current!.getBoundingClientRect(), width = Math.min(320, innerWidth - 32);
    setPos({ left: Math.max(16, Math.min(r.left, innerWidth - 16 - width)), top: r.bottom + 6, width });   // 화면 안으로(가로 넘침 0)
  };
  useEffect(() => {
    if (!pos) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { setPos(null); b.current?.focus(); } };
    const out = (e: PointerEvent) => { const t = e.target as Node; if (!p.current?.contains(t) && !b.current?.contains(t)) setPos(null); };
    const shut = () => setPos(null);
    addEventListener('keydown', k); addEventListener('pointerdown', out, true); addEventListener('resize', shut);
    return () => { removeEventListener('keydown', k); removeEventListener('pointerdown', out, true); removeEventListener('resize', shut); };
  }, [pos]);
  return <span className="lv-help">
    <button ref={b} type="button" className="lv-q" aria-label={label} aria-expanded={!!pos} aria-controls={id} onClick={() => (pos ? setPos(null) : open())}>?</button>
    <span id={id} ref={p} role="note" className="lv-pop" hidden={!pos} style={pos ? { left: pos.left, top: pos.top, width: pos.width } : undefined}>{children}</span>
  </span>;
}

/** 개발자 모드가 켜진 걸 공용 폰에서도 알아보게 — 누름을 가로채지 않음(pointer-events 0). U1-b 에서 공통 머리줄로 옮김 */
export function DevBadge() {
  return useDev((s) => s.on) ? <InFs><span className="lv-devbadge" role="status">개발자</span></InFs> : null;
}
